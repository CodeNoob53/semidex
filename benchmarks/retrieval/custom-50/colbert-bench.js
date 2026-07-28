// BGE-M3 ColBERT reranker benchmark for custom-50 — benchmark-only.
//
// Reranks hybrid top-N candidates using bge-m3-onnx colbert_vecs (late interaction).
// No production code changes. Scores with MaxSim from benchmarks/retrieval/lib/colbert-math.js.
//
// Modes compared:
//   hybrid-true     hybridSearch(TOP_K) — baseline
//   det-rerank      current deterministic reranker on prefetch pool
//   colbert-top20   ColBERT MaxSim on hybrid top-20 subset, derived from top-40 scoring pass
//   colbert-top40   ColBERT MaxSim on hybrid top-40 pool, final TOP_K  [default gate mode]
//   colbert-guarded blend(ColBERT, hybrid rank) + top-1 protection — same scoring pass
//   colbert-trigger guarded order only when hybrid #1-#2 RRF gap is low; else hybrid order
//
// Gate-evaluated mode selectable via COLBERT_GATE_MODE (see env knobs below).
//
// CE v4 reference: 0.764 MRR@10 (custom-50, 2026-05-16, ce-routed-v4)
// Hybrid baseline: 0.634 MRR@10 (custom-50, 2026-05-10, hybrid ONNX)
//
// Usage:
//   BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 npm run bench:custom50:colbert
//
// Gate (exploratory — no promotion claim):
//   MRR@10 >= hybrid + 0.030  (>= 0.664)
//   chunkRecall@5 >= hybrid
//   chunkRecall@10 >= hybrid
//   negativePass = 100%
//   zero rank<=3 -> >3 regressions
//   no query type MRR drop >= 0.030 vs hybrid
//   ordering-loss count < 2  (CE v4 had 2 CE-caused losses on custom-50)

if (process.argv.includes('--help')) {
  process.stdout.write(`ColBERT reranker benchmark — custom-50

Usage:
  BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 npm run bench:custom50:colbert

Environment:
  COLBERT_TOP_N         Candidate pool for top-40 mode (default: 40)
  COLBERT_MAX_LENGTH    Max token length for doc encoding (default: 512)
  COLBERT_SCORE_MODE    mean (default) | sum
  COLBERT_PROTECT_DELTA Top-1 protection threshold on raw MaxSim (default: 0.05; 0 disables)
  COLBERT_BLEND_ALPHA   ColBERT weight in blend score (default: 0.7; 1=pure ColBERT)
  COLBERT_TRIGGER_GAP   Hybrid #1-#2 relative gap below which trigger mode reranks (default: 0.10)
  COLBERT_GATE_MODE     Gate-evaluated mode: colbert-top40 (default) | colbert-guarded | colbert-trigger
  BENCH_TOP_K           Final result depth (default: 10)
  BENCH_WINDOW          Adjacency window for windowRecall (default: 1)
  BENCH_SKIP_INDEX      1 = reuse existing bench-retrieval-custom-50 collection
  ONNX_EXECUTION_PROVIDER  cpu (default) | dml | cuda

Output:
  benchmarks/retrieval/results/YYYY-MM-DD-custom50-colbert-top{N}-maxlen{L}-{mode}-{policy}.txt
`);
  process.exit(0);
}

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { env as hfEnv } from '@huggingface/transformers';

import { chunkFile } from '../../../src/indexer/phases/chunk.js';
import {
  deleteBySourceFile,
  upsertPoints, hybridSearch, scroll,
} from '../../../src/core/qdrant.js';
import { embedForIndex, embedForSearch } from '../../../src/core/embeddings.js';
import { rerankResults } from '../../../src/core/rerank.js';
import { validateQueryTypes, formatTypeDistribution } from './query-types.js';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { resolveBenchProfile } from '../../lib/resolve-profile.js';

import { today, f3, pct, pad, lpad } from '../lib/ce-routing-format.js';
import {
  buildQrels, tokenise, mrrAt,
  computeRoutingMetrics, buildRoutingAnalysis, computePerClassRows,
  bestExactRank, resultChunkId,
} from '../lib/ce-routing-metrics.js';
import { loadColBERTModel, scoreColBERTAll } from '../lib/colbert-rerank.js';
import { guardedColbertOrder, shouldTriggerColbert } from '../lib/colbert-guard.js';

const __dirname       = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SHARED = resolve(__dirname, '../fixtures/docs');
const FIXTURES_OWN    = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH    = resolve(__dirname, 'queries.json');
const RESULTS_DIR     = resolve(__dirname, '../results');
const COLLECTION      = 'bench-retrieval-custom-50';

hfEnv.cacheDir = resolve(__dirname, '../../../models');

const storageAdapter = createStorageAdapter();
// Resolved once in main() before indexing/search — embedForIndex/embedForSearch
// require a resolved profile object, not a bare collection name (see
// benchmarks/lib/resolve-profile.js's header comment).
let PROFILE = null;

// ── Env knobs ──────────────────────────────────────────────────────────────────

function envInt(name, def, min, max) {
  const v = parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      process.stderr.write(`[colbert] ${name}="${process.env[name]}" invalid — using ${def}\n`);
    return def;
  }
  return v;
}

const TOP_K         = envInt('BENCH_TOP_K', 10, 1, 1000);
const BENCH_WINDOW  = envInt('BENCH_WINDOW', 1, 0, 10);
const COLBERT_TOP_N = envInt('COLBERT_TOP_N', 40, 1, 500);
const SKIP_INDEX    = process.env.BENCH_SKIP_INDEX === '1';

const COLBERT_MAX_LENGTH   = envInt('COLBERT_MAX_LENGTH', 512, 32, 8192);
const COLBERT_SCORE_MODE   = process.env.COLBERT_SCORE_MODE   ?? 'mean';
const COLBERT_TOKEN_POLICY = process.env.COLBERT_TOKEN_POLICY ?? 'official';

function envFloat(name, def, min, max) {
  const v = parseFloat(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      process.stderr.write(`[colbert] ${name}="${process.env[name]}" invalid — using ${def}\n`);
    return def;
  }
  return v;
}

const COLBERT_PROTECT_DELTA = envFloat('COLBERT_PROTECT_DELTA', 0.05, 0, 1);
const COLBERT_BLEND_ALPHA   = envFloat('COLBERT_BLEND_ALPHA',   0.7,  0, 1);
const COLBERT_TRIGGER_GAP   = envFloat('COLBERT_TRIGGER_GAP',   0.10, 0, 1);

const TOP_N_20 = Math.min(20, COLBERT_TOP_N);
const TOP_N_40 = COLBERT_TOP_N;

const MODE_C20   = `colbert-top${TOP_N_20}`;
const MODE_C40   = `colbert-top${TOP_N_40}`;
const MODE_GUARD = 'colbert-guarded';
const MODE_TRIG  = 'colbert-trigger';

const GATE_MODE_RAW = process.env.COLBERT_GATE_MODE ?? MODE_C40;
const GATE_MODE = [MODE_C40, MODE_GUARD, MODE_TRIG].includes(GATE_MODE_RAW)
  ? GATE_MODE_RAW
  : (process.stderr.write(`[colbert] COLBERT_GATE_MODE="${GATE_MODE_RAW}" invalid — using ${MODE_C40}\n`), MODE_C40);

// ── Fixture list (mirrors ce-routing-bench.js) ─────────────────────────────────

const FIXTURE_FILES = [
  { name: 'providers.md',         dir: FIXTURES_SHARED },
  { name: 'qdrant.md',            dir: FIXTURES_SHARED },
  { name: 'chunking.md',          dir: FIXTURES_SHARED },
  { name: 'sync.md',              dir: FIXTURES_SHARED },
  { name: 'mcp-workflow.md',      dir: FIXTURES_OWN },
  { name: 'obsidian.md',          dir: FIXTURES_OWN },
  { name: 'project-structure.md', dir: FIXTURES_OWN },
  { name: 'benchmarking.md',      dir: FIXTURES_OWN },
  { name: 'config-env.md',        dir: FIXTURES_OWN },
  { name: 'multilingual.md',      dir: FIXTURES_OWN },
];

// ── Collection setup ───────────────────────────────────────────────────────────

async function ensureCollection() {
  PROFILE = await resolveBenchProfile(storageAdapter, COLLECTION, { vectorSize: 1024 });
  return { denseProvider: PROFILE.embedding.dense.provider, sparseProvider: PROFILE.embedding.sparse?.provider ?? null };
}

async function fetchStoredProvider() {
  const points = await scroll(COLLECTION, undefined, 1, ['dense_provider', 'sparse_provider']);
  const p = points[0]?.payload;
  return p ? { denseProvider: p.dense_provider ?? null, sparseProvider: p.sparse_provider ?? null } : null;
}

function isEmptyChunkText(text) {
  if (!text || !text.trim()) return true;
  return /^\(empty section:/i.test(text.trim());
}

async function indexFixtures() {
  const indexedIds   = new Set();
  const emptyChunkIds = new Set();
  for (const { name, dir } of FIXTURE_FILES) {
    const filePath = resolve(dir, name);
    const text     = readFileSync(filePath, 'utf8');
    await deleteBySourceFile(COLLECTION, name);
    const chunks = chunkFile(filePath, text, name);
    const points = [];
    for (const chunk of chunks) {
      const cid = `${name}#${chunk.chunkIndex}`;
      indexedIds.add(cid);
      if (isEmptyChunkText(chunk.text)) emptyChunkIds.add(cid);
      const { dense, sparse, meta } = await embedForIndex(PROFILE, chunk.text);
      points.push({
        id: randomUUID(),
        vector: { dense, sparse },
        payload: {
          text: chunk.text, section: chunk.section, source_file: name,
          chunk_index: chunk.chunkIndex, total_chunks: chunk.totalChunks,
          file_hash: 'bench-colbert', vector_size: 1024, ...meta,
        },
      });
    }
    await upsertPoints(COLLECTION, points);
    process.stderr.write(`  indexed ${name} (${points.length} chunks)\n`);
  }
  return { indexedIds, emptyChunkIds };
}

async function fetchIndexedChunkIds() {
  const points = await scroll(COLLECTION, undefined, 2000, ['source_file', 'chunk_index', 'text']);
  const indexedIds   = new Set();
  const emptyChunkIds = new Set();
  for (const p of points) {
    const sf = p.payload?.source_file;
    const ci = p.payload?.chunk_index;
    if (sf != null && ci != null) {
      const cid = `${sf}#${ci}`;
      indexedIds.add(cid);
      if (isEmptyChunkText(p.payload?.text)) emptyChunkIds.add(cid);
    }
  }
  return { indexedIds, emptyChunkIds };
}

function validateQrels(queries, indexedIds) {
  const errors = [];
  for (const q of queries) {
    if (q.shouldHaveNoStrongHit) continue;
    for (const rc of q.relevantChunks) {
      if (!indexedIds.has(rc.chunkId))
        errors.push(`  [${q.id}] "${rc.chunkId}" not found (relevance=${rc.relevance})`);
    }
  }
  if (errors.length) {
    process.stderr.write(`\nError: ${errors.length} qrel chunkId(s) not found:\n${errors.join('\n')}\n`);
    process.exit(1);
  }
}

// ── Per-query runner ───────────────────────────────────────────────────────────

async function runQuery(q) {
  const { dense, sparse } = await embedForSearch(PROFILE, q.query);

  // hybrid-true baseline (TOP_K only)
  const t0 = Date.now();
  const hybridTrue = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
  const hybridTrueMs = Date.now() - t0;

  // prefetch pool for ColBERT top-40 (and det-rerank)
  const t1 = Date.now();
  const pool40 = await hybridSearch(COLLECTION, dense, sparse, TOP_N_40);
  const prefetchMs40 = Date.now() - t1;

  // deterministic reranker on the same pool
  const t2 = Date.now();
  const detResults = rerankResults(pool40, q.query, { finalLimit: TOP_K, collection: COLLECTION });
  const detRerankMs = Date.now() - t2;

  // Score full pool40 once; derive both top40 and top20 from the same pass.
  // top20 semantics: candidates whose hybrid rank was inside pool40.slice(0, TOP_N_20),
  // re-sorted by their already-computed ColBERT score — no additional ONNX calls.
  const { allScored, ms: colbert40Ms } = await scoreColBERTAll(q.query, pool40, {
    docMaxLength: COLBERT_MAX_LENGTH,
    scoreMode:    COLBERT_SCORE_MODE,
  });

  const colbert40Scored = [...allScored].sort((a, b) => b.score - a.score).slice(0, TOP_K);

  // Derive top20: restrict to candidates whose hybrid rank was within TOP_N_20,
  // re-sort by ColBERT score already computed above — no additional ONNX calls.
  const t3 = performance.now();
  const colbert20Scored = allScored.slice(0, TOP_N_20).sort((a, b) => b.score - a.score).slice(0, TOP_K);
  const colbert20Ms = performance.now() - t3; // array ops only; ONNX cost is in colbert40Ms

  // Guarded mode: blend + top-1 protection over the same scoring pass (no extra ONNX calls).
  const guardedScored = guardedColbertOrder(allScored, {
    protectDelta: COLBERT_PROTECT_DELTA,
    blendAlpha:   COLBERT_BLEND_ALPHA,
    topK:         TOP_K,
  });

  // Trigger mode: rerank only when hybrid confidence (#1 vs #2 RRF gap) is low.
  // When not triggered, a real runtime would skip ColBERT inference entirely —
  // the latency model in computeAllMetrics reflects that.
  const triggered = shouldTriggerColbert(pool40, COLBERT_TRIGGER_GAP);
  const triggerScored = triggered ? guardedScored : hybridTrue;

  return {
    hybridTrueMs, prefetchMs40, detRerankMs, colbert40Ms, colbert20Ms, triggered,
    byMode: {
      'hybrid-true':    hybridTrue,
      'det-rerank':     detResults,
      [MODE_C20]:       colbert20Scored,
      [MODE_C40]:       colbert40Scored,
      [MODE_GUARD]:     guardedScored,
      [MODE_TRIG]:      triggerScored,
    },
  };
}

// ── Modes and metrics ──────────────────────────────────────────────────────────

const MODES = ['hybrid-true', 'det-rerank', MODE_C20, MODE_C40, MODE_GUARD, MODE_TRIG];

function computeAllMetrics(queryResults) {
  const latencyFn = (r, mode) => {
    if (mode === 'hybrid-true')   return r.hybridTrueMs;
    if (mode === 'det-rerank')    return r.prefetchMs40 + r.detRerankMs;
    if (mode === MODE_C20) return r.prefetchMs40 + r.colbert20Ms;
    if (mode === MODE_C40) return r.prefetchMs40 + r.colbert40Ms;
    if (mode === MODE_GUARD) return r.prefetchMs40 + r.colbert40Ms; // same scoring pass
    if (mode === MODE_TRIG)  return r.triggered ? r.prefetchMs40 + r.colbert40Ms : r.hybridTrueMs;
    return 0;
  };
  return computeRoutingMetrics(queryResults, MODES, { topK: TOP_K, window: BENCH_WINDOW, latencyFn });
}

const WATCHED_IDS = new Set(['c03', 'c16', 'c23', 'c36', 'c46', 'c29', 'c33']);

function buildQueryAnalysis(queryResults) {
  const rows = buildRoutingAnalysis(queryResults, MODES, { watchedIds: WATCHED_IDS });

  for (const row of rows) {
    row.isRegrC40 = row.isRegrByMode[MODE_C40];
    row.isRegrC20 = row.isRegrByMode[MODE_C20];
    row.isRegrDet = row.isRegrByMode['det-rerank'];
    row.isImprovC40 = row.isImprovByMode[MODE_C40];
  }

  rows.sort((a, b) => {
    if (a.isRegrC40 !== b.isRegrC40) return a.isRegrC40 ? -1 : 1;
    if (a.isRegrC20 !== b.isRegrC20) return a.isRegrC20 ? -1 : 1;
    if (a.isWatched !== b.isWatched) return a.isWatched ? -1 : 1;
    return 0;
  });
  return rows;
}

// ── Ordering-loss diagnostic (adapted for ColBERT — no ce-raw reference) ──────

function computeColBERTOrderingLoss(queryResults, primaryMode = MODE_C40) {
  const rows = [];
  for (const r of queryResults) {
    if (r.query.shouldHaveNoStrongHit) continue;
    const { qrels } = r.query;
    if (!qrels.size || ![...qrels.values()].some(v => v >= 3)) continue;

    const hybridRank   = bestExactRank(r.byMode['hybrid-true'], qrels);
    const primaryRank  = bestExactRank(r.byMode[primaryMode],  qrels);

    if (hybridRank == null || hybridRank > 2) continue;
    if (primaryRank == null || primaryRank <= hybridRank || primaryRank > 3) continue;

    const ranksByMode = {};
    for (const mode of MODES) ranksByMode[mode] = bestExactRank(r.byMode[mode], qrels);

    const mrrLoss = (1 / hybridRank) - (1 / primaryRank);

    const primaryResults = r.byMode[primaryMode] ?? [];
    const top1Id  = primaryResults[0] ? resultChunkId(primaryResults[0]) : null;
    const top1Rel = top1Id ? (qrels.get(top1Id) ?? 0) : 0;

    rows.push({
      queryResult: r,
      type: r.query.type ?? '(missing)',
      hybridRank, primaryRank, ranksByMode,
      mrrLoss, top1Id, top1Rel,
    });
  }
  rows.sort((a, b) => b.mrrLoss - a.mrrLoss);
  return rows;
}

function buildColBERTOrderingLossSection(lossRows, SEP2, primaryMode = MODE_C40) {
  const lines = [];
  const total       = lossRows.length;
  const h1p2        = lossRows.filter(r => r.hybridRank === 1 && r.primaryRank === 2).length;
  const h1p3        = lossRows.filter(r => r.hybridRank === 1 && r.primaryRank === 3).length;
  const h2p3        = lossRows.filter(r => r.hybridRank === 2 && r.primaryRank === 3).length;
  const totalMrrLoss = lossRows.reduce((s, r) => s + r.mrrLoss, 0);

  lines.push(`Rank-1 / top-3 ordering loss diagnostic (${primaryMode} vs hybrid-true):`);
  lines.push(SEP2);
  lines.push(`  Ordering-loss queries  : ${total}  (hybrid rank <=2, ${primaryMode} rank still <=3 but lower)`);
  lines.push(`  hybrid#1 -> colbert#2  : ${h1p2}`);
  lines.push(`  hybrid#1 -> colbert#3  : ${h1p3}`);
  lines.push(`  hybrid#2 -> colbert#3  : ${h2p3}`);
  lines.push(`  Total MRR loss         : ${totalMrrLoss.toFixed(3)}  (sum of 1/hybridRank − 1/colbertRank)`);
  lines.push(`  CE v4 reference        : 2 ordering losses, 1.000 MRR loss (custom-50, 2026-05-16)`);
  lines.push('');

  const byType = new Map();
  for (const row of lossRows) {
    if (!byType.has(row.type)) byType.set(row.type, []);
    byType.get(row.type).push(row);
  }
  if (byType.size) {
    lines.push('  Per-class ordering loss:');
    lines.push(`  ${'type'.padEnd(26)} ${'n'.padStart(4)} ${'MRR_loss'.padStart(9)}`);
    lines.push(`  ${'-'.repeat(42)}`);
    for (const [type, rows] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const loss = rows.reduce((s, r) => s + r.mrrLoss, 0);
      lines.push(`  ${type.padEnd(26)} ${String(rows.length).padStart(4)} ${loss.toFixed(3).padStart(9)}`);
    }
    lines.push('');
  }

  if (lossRows.length) {
    lines.push(`  ${'ID'.padEnd(10)}  ${'type'.padEnd(22)}  ${'hyb'.padStart(4)}  ${'c20'.padStart(4)}  ${'c40'.padStart(4)}  ${'mrrLoss'.padStart(7)}  ${'top1(colbert40)'.padEnd(26)}  query`);
    lines.push(`  ${'-'.repeat(110)}`);
    for (const row of lossRows) {
      const rk = mode => {
        const r = row.ranksByMode[mode];
        return r != null ? `#${r}` : 'miss';
      };
      const top1str = (row.top1Id ?? '-').slice(0, 24).padEnd(24) + ` r${row.top1Rel}`;
      lines.push(
        `  ${row.queryResult.query.id.padEnd(10)}  ${row.type.padEnd(22)}  ${rk('hybrid-true').padStart(4)}  ${rk(MODE_C20).padStart(4)}  ${rk(MODE_C40).padStart(4)}  ${row.mrrLoss.toFixed(3).padStart(7)}  ${top1str.padEnd(28)}  ${row.queryResult.query.query.slice(0, 44).trimEnd()}`
      );
    }
    lines.push('');
  }

  // Worst-3 detail.
  const worst = lossRows.slice(0, 3);
  if (worst.length) {
    lines.push(`  Top-3 ordering-loss detail:`);
    lines.push(SEP2);
    for (const row of worst) {
      const { queryResult: r } = row;
      const qrels = r.query.qrels;
      lines.push(`  [${r.query.id}] ${row.type} — ${r.query.query}`);
      lines.push(`    hybrid=#${row.hybridRank}  ${primaryMode}=#${row.primaryRank}  mrrLoss=${row.mrrLoss.toFixed(3)}`);
      for (const mode of ['hybrid-true', MODE_C40]) {
        const results = r.byMode[mode] ?? [];
        lines.push(`    ${mode}:`);
        for (let i = 0; i < Math.min(results.length, 3); i++) {
          const cid = resultChunkId(results[i]);
          const rel = cid ? (qrels.get(cid) ?? 0) : 0;
          lines.push(`      #${i + 1} ${(cid ?? '-').slice(0, 36).padEnd(36)} rel=${rel}`);
        }
      }
      lines.push('');
    }
    lines.push(SEP2);
    lines.push('');
  }

  return lines;
}

// ── Report ─────────────────────────────────────────────────────────────────────

function buildPerClassSection(queryResults, analysis, SEP2) {
  const lines = [];
  const perClassData = computePerClassRows(queryResults, analysis, MODES, { topK: TOP_K });

  for (const mode of MODES) {
    const showRegr = mode !== 'hybrid-true';
    lines.push(`Per-class metrics (${mode}):`);
    lines.push(SEP2);
    lines.push(
      pad('type', 22) + lpad('n', 4) +
      lpad('MRR@10', 8) + lpad('rank1', 6) + lpad('cR@5', 7) +
      (showRegr ? lpad('regr', 5) : '') +
      lpad('negPass', 8)
    );
    lines.push(SEP2);
    for (const row of perClassData.get(mode)) {
      const mrrStr     = row.mrr10        != null ? row.mrr10.toFixed(3) : 'n/a';
      const cr5Str     = row.chunkRecall5 != null ? pct(row.chunkRecall5) : 'n/a';
      const negPassStr = row.negativePass != null ? `${(row.negativePass * 100).toFixed(0)}%` : 'n/a';
      lines.push(
        pad(row.type, 22) + lpad(row.count, 4) +
        lpad(row.posCount > 0 ? mrrStr   : 'n/a', 8) +
        lpad(row.posCount > 0 ? String(row.rank1) : 'n/a', 6) +
        lpad(row.posCount > 0 ? cr5Str   : 'n/a', 7) +
        (showRegr ? lpad(row.posCount > 0 ? String(row.regressions) : 'n/a', 5) : '') +
        lpad(negPassStr, 8)
      );
    }
    lines.push(SEP2);
    lines.push('');
  }
  return lines;
}

function buildReport(allMetrics, analysis, providerInfo, queryResults) {
  const lines = [];
  const SEP  = '='.repeat(110);
  const SEP2 = '-'.repeat(110);

  const { typeDistribution } = validateQueryTypes(queryResults.map(r => r.query));
  const typeLine = formatTypeDistribution(typeDistribution);

  const base   = allMetrics['hybrid-true'];
  const c40    = allMetrics[MODE_C40];
  const c20    = allMetrics[MODE_C20];
  const mrrBase = base.mrr10 ?? 0;
  const mrrC40  = c40.mrr10 ?? 0;
  const mrrC20  = c20.mrr10 ?? 0;

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('  custom-50 ColBERT reranker benchmark — benchmark-only, no production changes');
  lines.push(`  Date              : ${today()}`);
  lines.push(`  Provider          : ${providerInfo.denseProvider}/${providerInfo.sparseProvider}`);
  lines.push(SEP2);
  lines.push(`  COLBERT_TOP_N      : ${COLBERT_TOP_N}  (pool for colbert-top${TOP_N_40})`);
  lines.push(`  ${MODE_C20} pool    : ${TOP_N_20}  (derived from top-${TOP_N_40} scoring pass — no extra ONNX calls)`);
  lines.push(`  COLBERT_MAX_LENGTH : ${COLBERT_MAX_LENGTH}  (doc token cap)`);
  lines.push(`  COLBERT_SCORE_MODE : ${COLBERT_SCORE_MODE}`);
  lines.push(`  COLBERT_TOKEN_POLICY: ${COLBERT_TOKEN_POLICY}  (official=keep EOS | no-eos=filter EOS)`);
  lines.push(`  COLBERT_PROTECT_DELTA: ${COLBERT_PROTECT_DELTA}  (top-1 protection on raw MaxSim; 0=off)`);
  lines.push(`  COLBERT_BLEND_ALPHA : ${COLBERT_BLEND_ALPHA}  (ColBERT weight in guarded blend)`);
  lines.push(`  COLBERT_TRIGGER_GAP : ${COLBERT_TRIGGER_GAP}  (hybrid #1-#2 rel. gap below which trigger reranks)`);
  lines.push(`  COLBERT_GATE_MODE   : ${GATE_MODE}  (gate-evaluated mode)`);
  lines.push(`  BENCH_TOP_K       : ${TOP_K}  (final result depth)`);
  lines.push(`  BENCH_WINDOW      : ${BENCH_WINDOW}`);
  lines.push(`  BENCH_SKIP_INDEX  : ${SKIP_INDEX ? 'yes' : 'no'}`);
  lines.push(`  Query types       : ${typeLine}`);
  lines.push('');
  lines.push('  References (not rerun; gate baseline = live hybrid-true above):');
  lines.push('    CE v4              : 0.764 MRR@10  (custom-50, ce-routed-v4, 2026-05-16)');
  lines.push('    Hybrid (2026-05-10): 0.634 MRR@10  (custom-50, standalone run, pre-CE-v4)');
  lines.push(SEP);
  lines.push('');

  // ── Aggregate table ──────────────────────────────────────────────────────────
  const COL = 14;
  const LBL = 18;
  lines.push('Aggregate metrics:');
  lines.push(SEP2);
  lines.push(pad('', LBL) + MODES.map(m => lpad(m, COL)).join(''));
  lines.push(SEP2);
  const metricRows = [
    ['MRR@10',           m => f3(allMetrics[m].mrr10)],
    ['rank1 exact',      m => String(allMetrics[m].rank1Exact)],
    ['nDCG@10',          m => f3(allMetrics[m].ndcgK)],
    ['chunkRecall@3',    m => pct(allMetrics[m].chunkRecall3)],
    ['chunkRecall@5',    m => pct(allMetrics[m].chunkRecall5)],
    ['chunkRecall@10',   m => pct(allMetrics[m].chunkRecall10)],
    ['windowRecall@5',   m => pct(allMetrics[m].windowRecall5)],
    ['windowRecall@10',  m => pct(allMetrics[m].windowRecall10)],
    ['supportRecall@10', m => pct(allMetrics[m].supportRecall10)],
    ['negativePass',     m => pct(allMetrics[m].negativePass)],
    ['p50 latency',      m => `${Math.round(allMetrics[m].p50)}ms`],
    ['p95 latency',      m => `${Math.round(allMetrics[m].p95)}ms`],
  ];
  for (const [label, fn] of metricRows) {
    lines.push(pad(label, LBL) + MODES.map(m => lpad(fn(m), COL)).join(''));
  }
  lines.push(SEP2);
  lines.push('');

  // ── MRR deltas ───────────────────────────────────────────────────────────────
  const guard = allMetrics[MODE_GUARD];
  const trig  = allMetrics[MODE_TRIG];
  const mrrGuard = guard.mrr10 ?? 0;
  const mrrTrig  = trig.mrr10 ?? 0;
  const triggeredCount = queryResults.filter(r => r.triggered).length;

  lines.push('MRR@10 vs references:');
  lines.push(SEP2);
  lines.push(`  ${MODE_C40} vs hybrid-true   : ${mrrC40 >= mrrBase ? '+' : ''}${(mrrC40 - mrrBase).toFixed(3)}  (base=${f3(mrrBase).trim()})`);
  lines.push(`  ${MODE_C20} vs hybrid-true   : ${mrrC20 >= mrrBase ? '+' : ''}${(mrrC20 - mrrBase).toFixed(3)}`);
  lines.push(`  ${MODE_GUARD} vs hybrid-true : ${mrrGuard >= mrrBase ? '+' : ''}${(mrrGuard - mrrBase).toFixed(3)}  (delta=${COLBERT_PROTECT_DELTA}, alpha=${COLBERT_BLEND_ALPHA})`);
  lines.push(`  ${MODE_TRIG} vs hybrid-true  : ${mrrTrig >= mrrBase ? '+' : ''}${(mrrTrig - mrrBase).toFixed(3)}  (triggered on ${triggeredCount}/${queryResults.length} queries, gap<${COLBERT_TRIGGER_GAP})`);
  lines.push(`  CE v4 reference                : 0.764  (not rerun; ${GATE_MODE} gap: ${((allMetrics[GATE_MODE].mrr10 ?? 0) - 0.764).toFixed(3)})`);
  lines.push(SEP2);
  lines.push('');

  // ── Gate checklist (GATE_MODE vs hybrid-true) ────────────────────────────────
  const gate      = allMetrics[GATE_MODE];
  const mrrGate   = gate.mrr10 ?? 0;
  const cr5Base   = base.chunkRecall5 ?? 0;
  const cr10Base  = base.chunkRecall10 ?? 0;
  const cr5Gate   = gate.chunkRecall5 ?? 0;
  const cr10Gate  = gate.chunkRecall10 ?? 0;
  const negGate   = gate.negativePass ?? 0;

  const regrGate = analysis.filter(r => r.isRegrByMode[GATE_MODE]).length;

  // Type-level MRR drop for the gate mode.
  const byType = new Map();
  for (const r of queryResults) {
    const t = r.query.type ?? '(missing)';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }
  let worstTypeDrop = 0, worstTypeLabel = '';
  for (const [type, rows] of byType) {
    const pos = rows.filter(r => !r.query.shouldHaveNoStrongHit);
    if (!pos.length) continue;
    let hybSum = 0, gateSum = 0, cnt = 0;
    for (const r of pos) {
      const hv = mrrAt(r.byMode['hybrid-true'], r.query.qrels, 10);
      const gv = mrrAt(r.byMode[GATE_MODE],     r.query.qrels, 10);
      if (hv !== null && gv !== null) { hybSum += hv; gateSum += gv; cnt++; }
    }
    if (cnt > 0) {
      const drop = (hybSum - gateSum) / cnt;
      if (drop > worstTypeDrop) { worstTypeDrop = drop; worstTypeLabel = type; }
    }
  }

  const lossRows = computeColBERTOrderingLoss(queryResults, GATE_MODE);
  const orderingLossCount = lossRows.length;

  const gMRR      = mrrGate >= mrrBase + 0.030;
  const gCR5      = cr5Gate >= cr5Base;
  const gCR10     = cr10Gate >= cr10Base;
  const gNeg      = negGate >= 1.0;
  const gRegr     = regrGate === 0;
  const gTypeMRR  = worstTypeDrop < 0.030;
  const gOrdering = orderingLossCount < 2;
  const gatePass  = gMRR && gCR5 && gCR10 && gNeg && gRegr && gTypeMRR && gOrdering;

  lines.push(`Promotion gate (${GATE_MODE} vs hybrid-true, exploratory):`);
  lines.push(SEP2);
  lines.push(`  [${gMRR ? '✓' : '✗'}] MRR@10 >= hybrid + 0.030  (>= ${(mrrBase + 0.030).toFixed(3)})   (got ${f3(mrrGate).trim()})`);
  lines.push(`  [${gCR5 ? '✓' : '✗'}] chunkRecall@5 >= hybrid   (got ${pct(cr5Gate).trim()}, base=${pct(cr5Base).trim()})`);
  lines.push(`  [${gCR10 ? '✓' : '✗'}] chunkRecall@10 >= hybrid  (got ${pct(cr10Gate).trim()}, base=${pct(cr10Base).trim()})`);
  lines.push(`  [${gNeg ? '✓' : '✗'}] negativePass = 100%        (got ${pct(negGate).trim()})`);
  lines.push(`  [${gRegr ? '✓' : '✗'}] zero rank<=3 regressions  (got ${regrGate})`);
  lines.push(`  [${gTypeMRR ? '✓' : '✗'}] no query type MRR drop >= 0.030  (worst: ${worstTypeLabel || 'none'} drop=${worstTypeDrop.toFixed(3)})`);
  lines.push(`  [${gOrdering ? '✓' : '✗'}] ordering-loss count < 2  (got ${orderingLossCount}; CE v4 had 2)`);
  lines.push('');

  // Verdict with clear proceed/iterate/defer decision.
  let verdict;
  if (gatePass) {
    verdict = mrrGate >= 0.764
      ? `GATE PASSED — ${GATE_MODE} matches/beats CE v4 reference (0.764); proceed to custom-150`
      : `GATE PASSED (vs hybrid) — ${GATE_MODE} below CE v4 reference; proceed to custom-150 if delta acceptable`;
  } else {
    const reason = !gMRR     ? `MRR@10 ${f3(mrrGate).trim()} below hybrid + 0.030 (${(mrrBase + 0.030).toFixed(3)})`
                 : !gRegr    ? `${regrGate} rank<=3 regression(s)`
                 : !gTypeMRR ? `type MRR drop ${worstTypeDrop.toFixed(3)} >= 0.030 (${worstTypeLabel})`
                 : !gNeg     ? 'negativePass < 100%'
                 : !gOrdering ? `${orderingLossCount} ordering losses >= 2`
                 :              'recall criteria not met';
    verdict = `GATE FAILED — ${reason}`;
  }
  lines.push(`  Verdict: ${verdict}`);
  lines.push(SEP2);
  lines.push('');

  // ── Per-query table ──────────────────────────────────────────────────────────
  lines.push(`Per-query results (${GATE_MODE} is the gate-evaluated mode):`);
  lines.push(SEP2);
  lines.push(
    pad('ID', 5) + '  ' +
    pad('type', 20) + '  ' +
    lpad('hyb', 5) + '  ' +
    lpad('det', 5) + '  ' +
    lpad('c20', 5) + '  ' +
    lpad('c40', 5) + '  ' +
    lpad('grd', 5) + '  ' +
    lpad('trg', 5) + '  ' +
    'query'
  );
  lines.push(SEP2);
  for (const row of analysis) {
    const rk = m => row.ranks[m] != null ? `#${row.ranks[m]}` : 'miss';
    const flag = row.isRegrByMode[GATE_MODE]   ? '[REGR!]' :
                 row.isImprovByMode[GATE_MODE] ? '[IMPR]'  : '';
    lines.push(
      pad(row.query.id, 5) + '  ' +
      pad(row.query.type ?? '?', 20) + '  ' +
      lpad(rk('hybrid-true'), 5) + '  ' +
      lpad(rk('det-rerank'), 5) + '  ' +
      lpad(rk(MODE_C20), 5) + '  ' +
      lpad(rk(MODE_C40), 5) + '  ' +
      lpad(rk(MODE_GUARD), 5) + '  ' +
      lpad(rk(MODE_TRIG), 5) + '  ' +
      (flag ? `${flag} ` : '') +
      row.query.query.slice(0, 55).trimEnd()
    );
  }
  lines.push(SEP2);
  lines.push('');

  // ── Regression detail ────────────────────────────────────────────────────────
  const regressions = analysis.filter(r => r.isRegrByMode[GATE_MODE]);
  if (regressions.length) {
    lines.push(`Regressions in ${GATE_MODE} (${regressions.length}):`);
    lines.push(SEP2);
    for (const row of regressions) {
      lines.push(`[${row.query.id}] type=${row.query.type ?? '?'}`);
      lines.push(`  query: ${row.query.query}`);
      for (const mode of MODES) {
        const top1cid = row.top1ByMode[mode];
        const rel = top1cid ? (row.qrels.get(top1cid) ?? 0) : 0;
        lines.push(`  ${pad(mode, 16)} rank=${row.ranks[mode] != null ? `#${row.ranks[mode]}` : 'miss'}  top1=${top1cid ?? '-'}  rel=${rel}`);
      }
      lines.push('');
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Ordering-loss diagnostic ─────────────────────────────────────────────────
  for (const l of buildColBERTOrderingLossSection(lossRows, SEP2, GATE_MODE)) lines.push(l);

  // ── Per-class metrics ────────────────────────────────────────────────────────
  for (const l of buildPerClassSection(queryResults, analysis, SEP2)) lines.push(l);

  // ── Interpretation ───────────────────────────────────────────────────────────
  lines.push('Interpretation:');
  lines.push(SEP2);
  lines.push('  benchmark-only — no production runtime changes.');
  lines.push(`  ColBERT vs hybrid          : ${mrrC40 >= mrrBase ? 'BEATS hybrid' : 'BELOW hybrid'}  (${f3(mrrC40).trim()} vs ${f3(mrrBase).trim()})`);
  lines.push(`  ColBERT vs CE v4 (0.764)   : ${mrrC40 >= 0.764 ? 'BEATS' : 'BELOW'} CE v4  (gap: ${(mrrC40 - 0.764).toFixed(3)})`);
  lines.push(`  ${MODE_GUARD} vs hybrid    : ${mrrGuard >= mrrBase ? '+' : ''}${(mrrGuard - mrrBase).toFixed(3)}  (protect=${COLBERT_PROTECT_DELTA}, alpha=${COLBERT_BLEND_ALPHA})`);
  lines.push(`  ${MODE_TRIG} vs hybrid     : ${mrrTrig >= mrrBase ? '+' : ''}${(mrrTrig - mrrBase).toFixed(3)}  (${triggeredCount}/${queryResults.length} triggered; p50 ${Math.round(trig.p50)}ms - untriggered queries pay only hybrid latency)`);
  const latencyNote = `  Latency (${MODE_C40} p50/p95): ${Math.round(c40.p50)}ms / ${Math.round(c40.p95)}ms vs hybrid ${Math.round(base.p50)}ms / ${Math.round(base.p95)}ms`;
  lines.push(latencyNote);
  lines.push(`  ${MODE_C20} p50/p95        : ${Math.round(c20.p50)}ms / ${Math.round(c20.p95)}ms  (derived from ${MODE_C40} pass — no extra ONNX calls)`);
  lines.push('  Optimization note: top20/top40 ColBERT scores are identical to a separate scoring pass.');
  lines.push('  Gate/ordering-loss counts reflect this run\'s live hybrid-true baseline and are not');
  lines.push('  used as evidence for the optimization — compare colbert-top20/40 quality metrics only.');
  if (gatePass) {
    lines.push('  Next step: proceed to custom-150 ColBERT benchmark to check class-level generalisation.');
  } else if (!gMRR) {
    lines.push('  Next step: iterate formula/top-N (try COLBERT_SCORE_MODE=sum or smaller pool).');
  } else {
    lines.push('  Next step: fix regression(s) before proceeding, or defer if latency exceeds budget.');
  }
  lines.push(SEP2);
  lines.push('');

  lines.push(SEP);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

process.stderr.write('=== semidex custom-50 ColBERT reranker benchmark ===\n');
process.stderr.write(`COLBERT_TOP_N=${COLBERT_TOP_N}  MAX_LENGTH=${COLBERT_MAX_LENGTH}  SCORE_MODE=${COLBERT_SCORE_MODE}  TOP_K=${TOP_K}\n`);

// Force ONNX provider (ColBERT requires bge-m3-onnx).
process.env.ONNX_EMBED = '1';
delete process.env.DENSE_PROVIDER;
delete process.env.SPARSE_PROVIDER;

process.stderr.write('\n[1/4] Setup collection...\n');
let indexedIds;
// Resolves PROFILE from the collection's own native metadata if it already
// exists, or from current env if creating it fresh — never a second,
// independent env read after this point (see benchmarks/retrieval/run.js).
const providerInfo = await ensureCollection();

if (SKIP_INDEX) {
  const stored = await fetchStoredProvider();
  if (stored && (stored.denseProvider !== providerInfo.denseProvider || stored.sparseProvider !== providerInfo.sparseProvider)) {
    process.stderr.write(`Error: BENCH_SKIP_INDEX=1 but stored provider (${stored.denseProvider}/${stored.sparseProvider}) differs from "${COLLECTION}"'s own recorded embedding profile (${providerInfo.denseProvider}/${providerInfo.sparseProvider}).\n`);
    process.exitCode = 1; process.exit();
  }
  process.stderr.write('[2/4] Skipping index (BENCH_SKIP_INDEX=1) — fetching chunk IDs...\n');
  ({ indexedIds } = await fetchIndexedChunkIds());
} else {
  process.stderr.write('[2/4] Indexing fixtures...\n');
  ({ indexedIds } = await indexFixtures());
}

const rawQueries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
const queries = rawQueries.queries.map(q => ({
  ...q,
  qrels: buildQrels(q.relevantChunks),
  expectedTokens: q.expectedTokens ? q.expectedTokens.flatMap(t => tokenise(t)).filter(Boolean) : null,
}));

const { typeDistribution: _typeDist, warnings: _typeWarn } = validateQueryTypes(rawQueries.queries);
if (_typeWarn.length) {
  for (const w of _typeWarn) process.stderr.write(`[colbert] type warning: ${w}\n`);
}
process.stderr.write(`Types: ${formatTypeDistribution(_typeDist)}\n`);

validateQrels(queries, indexedIds);

process.stderr.write('\n[3/4] Loading ColBERT model (bge-m3-onnx)...\n');
await loadColBERTModel({ logPrefix: '[colbert]' });

process.stderr.write('\n[4/4] Running queries...\n');
const queryResults = [];
for (const q of queries) {
  process.stderr.write(`  ${q.id}: ${q.query.slice(0, 50)}...`);
  const res = await runQuery(q);
  queryResults.push({ query: q, ...res });
  const totalMs = res.hybridTrueMs + res.prefetchMs40 + res.colbert40Ms;
  process.stderr.write(` (${totalMs}ms)\n`);
}

const allMetrics = computeAllMetrics(queryResults);
const analysis   = buildQueryAnalysis(queryResults);
const report     = buildReport(allMetrics, analysis, providerInfo, queryResults);

process.stdout.write(report + '\n');

mkdirSync(RESULTS_DIR, { recursive: true });
const gateSlug   = GATE_MODE === MODE_C40 ? '' : `-gate-${GATE_MODE}-d${COLBERT_PROTECT_DELTA}-a${COLBERT_BLEND_ALPHA}`;
const configSlug = `top${COLBERT_TOP_N}-maxlen${COLBERT_MAX_LENGTH}-${COLBERT_SCORE_MODE}-${COLBERT_TOKEN_POLICY}${gateSlug}`;
const outPath    = resolve(RESULTS_DIR, `${today()}-custom50-colbert-${configSlug}.txt`);
writeFileSync(outPath, report + '\n', 'utf8');
process.stderr.write(`\nSaved: ${outPath}\n`);
