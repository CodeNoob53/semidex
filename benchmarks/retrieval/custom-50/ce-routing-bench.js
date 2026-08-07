// CE routing benchmark for custom-50.
//
// Tests whether a deterministic query classifier + lexical guard can preserve
// mmarco text+meta quality gains while eliminating CE regressions on exact-token,
// source-navigation, and provider-activation queries.
//
// Requires: bench-retrieval-custom-50 collection already indexed.
//           Run cross-encoder-bench.js first, or use BENCH_SKIP_INDEX=1.
//
// Modes compared:
//   hybrid-true        hybridSearch(TOP_K) baseline
//   det-rerank         current deterministic reranker
//   ce-raw             CE rerank, no routing (mmarco text+meta default)
//   ce-routed-v1       CE rerank + heuristic-v1 guard (original custom-50 guard)
//   ce-routed-v3       CE rerank + heuristic-v3 guard (provider-activation priority + exact-token single-protect)
//   ce-routed-v4       CE rerank + heuristic-v4 guard (v3 + provider-activation top-2 preservation)
//   ce-oracle-regression  CE rerank + qrel-aware regression guard (pure CE base; not a global upper bound)
//
// Usage:
//   BENCH_SKIP_INDEX=1 CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 CE_INPUT=text+meta \
//     node benchmarks/retrieval/custom-50/ce-routing-bench.js
//
// Guard versions reported:
//   heuristic-v1  uses only query text + candidate payload; no qrel access (original guard)
//   heuristic-v3  adds provider-activation priority before config-env/exact-token; exact-token single-protect
//   heuristic-v4  v3 + if providers.md activation-guide chunk was in hybrid top-2 but CE placed it at index 2, lift to index 1
//   oracle        pure CE order base; promotes rel>=3 hybrid top-3 chunks; not a global upper bound

if (process.argv.includes('--help')) {
  process.stdout.write(`CE routing benchmark — custom-50 (guard v1 vs v3 vs v4)

Usage:
  BENCH_SKIP_INDEX=1 CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 \\
    CE_INPUT=text+meta node benchmarks/retrieval/custom-50/ce-routing-bench.js

Environment:
  CE_MODEL            HF model ID (default: cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)
  CE_INPUT            text | text+section | text+meta  (default: text+meta)
  CE_DTYPE            dtype for from_pretrained (default: fp32)
  CE_BATCH_SIZE       Pairs per batch (default: 16)
  BENCH_TOP_K         Search depth (default: 10)
  RERANK_PREFETCH_MULT  Candidate pool multiplier (default: 4)
  BENCH_SKIP_INDEX    1 = reuse existing bench-retrieval-custom-50 collection

Output:
  benchmarks/retrieval/results/YYYY-MM-DD-custom50-ce-routing-v4-{model_slug}.txt

Gate criteria (ce-routed-v4 vs hybrid-true):
  MRR@10 >= 0.755  (original v1 baseline 0.760 minus 0.005)
  chunkRecall@5 >= hybrid baseline
  chunkRecall@10 >= hybrid baseline
  negativePass = 100%
  zero rank<=3 -> >3 regressions
  watched queries c03, c16, c23, c36, c46 must not regress
  no query type with MRR drop >= 0.030 vs hybrid
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
} from '../../../src/shared/core/qdrant.js';
import { embedForIndex, embedForSearch } from '../../../src/shared/core/embeddings.js';
import { rerankResults } from '../../../src/core/rerank.js';
import { validateQueryTypes, formatTypeDistribution } from './query-types.js';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { resolveBenchProfile } from '../../lib/resolve-profile.js';

import { today, f3, pct, pad, lpad } from '../lib/ce-routing-format.js';
import {
  buildQrels, tokenise, mrrAt,
  computeRoutingMetrics, buildRoutingAnalysis, computePerClassRows,
  computeOrderingLoss, buildOrderingLossSection,
} from '../lib/ce-routing-metrics.js';
import {
  classifyQueryV1, classifyQueryV3C50,
  applyHeuristicGuardV1, applyHeuristicGuardV3C50, applyHeuristicGuardV4C50,
  applyOracleGuard,
} from '../lib/ce-routing-guards.js';
import { loadCEModel, scoreCrossEncoder } from '../lib/ce-model.js';

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
      process.stderr.write(`[ce-routing] ${name}="${process.env[name]}" invalid — using ${def}\n`);
    return def;
  }
  return v;
}

const CE_MODEL             = process.env.CE_MODEL   ?? 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1';
const CE_INPUT             = process.env.CE_INPUT   ?? 'text+meta';
const CE_DTYPE             = process.env.CE_DTYPE   ?? 'fp32';
const CE_BATCH_SIZE        = envInt('CE_BATCH_SIZE', 16, 1, 256);
const TOP_K                = envInt('BENCH_TOP_K', 10, 1, 1000);
const BENCH_WINDOW         = envInt('BENCH_WINDOW', 1, 0, 10);
const SKIP_INDEX           = process.env.BENCH_SKIP_INDEX === '1';
const RERANK_PREFETCH_MULT = envInt('RERANK_PREFETCH_MULT', 4, 1, 100);

const GUARD_V1 = 'heuristic-v1';
const GUARD_V3 = 'heuristic-v3';
const GUARD_V4 = 'heuristic-v4';

// ── Fixture list (mirrors cross-encoder-bench.js) ──────────────────────────────

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
    const filePath  = resolve(dir, name);
    const text      = readFileSync(filePath, 'utf8');
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
          file_hash: 'bench-ce', vector_size: 1024, ...meta,
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
  const candidateLimit    = Math.max(TOP_K * RERANK_PREFETCH_MULT, TOP_K + 5);

  const t0 = Date.now();
  const hybridTrue = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
  const hybridTrueMs = Date.now() - t0;

  const t1 = Date.now();
  const pool = await hybridSearch(COLLECTION, dense, sparse, candidateLimit);
  const prefetchMs = Date.now() - t1;

  // Attach query string for guard distractor check (both pools need it).
  pool.__query__       = q.query;
  hybridTrue.__query__ = q.query;

  const t2 = Date.now();
  const detResults = rerankResults(pool, q.query, { finalLimit: TOP_K, collection: COLLECTION });
  const detRerankMs = Date.now() - t2;

  const t3 = Date.now();
  const ceRanked = (await scoreCrossEncoder(q.query, pool, { inputMode: CE_INPUT, batchSize: CE_BATCH_SIZE })).sort((a, b) => b.ceScore - a.ceScore);
  const ceRawResults = ceRanked.slice(0, TOP_K).map(x => ({ ...x.result, score: x.ceScore }));

  // v1 guard (heuristic-v1, original custom-50 guard)
  const queryClassV1 = classifyQueryV1(q.query);
  const { guarded: heurGuardedV1, guardFired: guardFiredV1, protectedId: protectedIdV1 } =
    applyHeuristicGuardV1(queryClassV1, ceRanked, hybridTrue);
  const ceRoutedV1Results = heurGuardedV1.slice(0, TOP_K);

  // v3 guard (heuristic-v3, provider-activation priority + exact-token single-protect)
  const queryClassV3 = classifyQueryV3C50(q.query, q.type ?? null);
  const { guarded: heurGuardedV3, guardFired: guardFiredV3, protectedId: protectedIdV3, routeClass: routeClassV3 } =
    applyHeuristicGuardV3C50(queryClassV3, ceRanked, hybridTrue, q.type ?? null);
  const ceRoutedV3Results = heurGuardedV3.slice(0, TOP_K);

  // v4 guard (heuristic-v4, v3 + provider-activation top-2 preservation)
  const { guarded: heurGuardedV4, guardFired: guardFiredV4, protectedId: protectedIdV4, routeClass: routeClassV4 } =
    applyHeuristicGuardV4C50(queryClassV3, ceRanked, hybridTrue, q.type ?? null);
  const ceRoutedV4Results = heurGuardedV4.slice(0, TOP_K);

  const { guarded: oracleGuarded, guardFired: oracleFired } =
    applyOracleGuard(ceRanked, hybridTrue, q.qrels);
  const ceOracleResults = oracleGuarded.slice(0, TOP_K);

  const crossEncoderMs = Date.now() - t3;

  return {
    hybridTrueMs, prefetchMs, detRerankMs, crossEncoderMs,
    queryClassV1, guardFiredV1, protectedIdV1,
    queryClassV3, guardFiredV3, protectedIdV3, routeClassV3,
    guardFiredV4, protectedIdV4, routeClassV4,
    oracleFired,
    byMode: {
      'hybrid-true':          hybridTrue,
      'det-rerank':           detResults,
      'ce-raw':               ceRawResults,
      'ce-routed-v1':         ceRoutedV1Results,
      'ce-routed-v3':         ceRoutedV3Results,
      'ce-routed-v4':         ceRoutedV4Results,
      'ce-oracle-regression': ceOracleResults,
    },
  };
}

// ── Aggregate metrics ──────────────────────────────────────────────────────────

const MODES = ['hybrid-true', 'det-rerank', 'ce-raw', 'ce-routed-v1', 'ce-routed-v3', 'ce-routed-v4', 'ce-oracle-regression'];

function computeAllMetrics(queryResults) {
  return computeRoutingMetrics(queryResults, MODES, { topK: TOP_K, window: BENCH_WINDOW });
}

// ── Regression detection ───────────────────────────────────────────────────────

const WATCHED_IDS_C50 = new Set(['c03', 'c16', 'c23', 'c36', 'c46', 'c29', 'c33']);

function buildQueryAnalysis(queryResults) {
  const rows = buildRoutingAnalysis(queryResults, MODES, { watchedIds: WATCHED_IDS_C50 });

  // Promote guard/class fields from _src to row (custom-50 report uses them directly).
  for (const row of rows) {
    const r = row._src;
    row.queryClassV1  = r.queryClassV1;
    row.queryClassV3  = r.queryClassV3;
    row.routeClassV3  = r.routeClassV3;
    row.guardFiredV1  = r.guardFiredV1;
    row.protectedIdV1 = r.protectedIdV1;
    row.guardFiredV3  = r.guardFiredV3;
    row.protectedIdV3 = r.protectedIdV3;
    row.routeClassV4  = r.routeClassV4;
    row.guardFiredV4  = r.guardFiredV4;
    row.protectedIdV4 = r.protectedIdV4;
    row.oracleFired   = r.oracleFired;
    // Flat aliases used by buildReport.
    row.isRegrRaw = row.isRegrByMode['ce-raw'];
    row.isRegrV1  = row.isRegrByMode['ce-routed-v1'];
    row.isRegrV3  = row.isRegrByMode['ce-routed-v3'];
    row.isRegrV4  = row.isRegrByMode['ce-routed-v4'];
    row.isImprovRaw = row.isImprovByMode['ce-raw'];
    row.isImprovV3  = row.isImprovByMode['ce-routed-v3'];
    row.isImprovV4  = row.isImprovByMode['ce-routed-v4'];
  }

  rows.sort((a, b) => {
    if (a.isRegrV4  !== b.isRegrV4)  return a.isRegrV4  ? -1 : 1;
    if (a.isRegrV3  !== b.isRegrV3)  return a.isRegrV3  ? -1 : 1;
    if (a.isRegrV1  !== b.isRegrV1)  return a.isRegrV1  ? -1 : 1;
    if (a.isRegrRaw !== b.isRegrRaw) return a.isRegrRaw ? -1 : 1;
    if (a.isWatched !== b.isWatched) return a.isWatched ? -1 : 1;
    return 0;
  });
  return rows;
}

// ── Report ─────────────────────────────────────────────────────────────────────

function guardFiredC50(queryResult, mode) {
  if (mode === 'ce-routed-v4') return queryResult.guardFiredV4;
  if (mode === 'ce-routed-v3') return queryResult.guardFiredV3;
  if (mode === 'ce-routed-v1') return queryResult.guardFiredV1;
  return false;
}

function buildPerClassSection(queryResults, analysis, SEP2) {
  const lines = [];
  const perClassData = computePerClassRows(queryResults, analysis, MODES, {
    topK: TOP_K,
    guardFiredFn: guardFiredC50,
  });

  for (const mode of MODES) {
    const showRegr  = mode !== 'hybrid-true';
    const guardsCol = mode === 'ce-routed-v1' || mode === 'ce-routed-v3' || mode === 'ce-routed-v4';

    lines.push(`Per-class metrics (${mode}):`);
    lines.push(SEP2);
    lines.push(
      pad('type', 22) + lpad('n', 4) +
      lpad('MRR@10', 8) + lpad('rank1', 6) + lpad('cR@5', 7) +
      (showRegr  ? lpad('regr', 5) : '') +
      (guardsCol ? lpad('guards', 7) : '') +
      lpad('negPass', 8)
    );
    lines.push(SEP2);

    for (const row of perClassData.get(mode)) {
      const mrrStr     = row.mrr10        != null ? row.mrr10.toFixed(3) : 'n/a';
      const cr5Str     = row.chunkRecall5 != null ? pct(row.chunkRecall5) : 'n/a';
      const negPassStr = row.negativePass != null ? `${(row.negativePass * 100).toFixed(0)}%` : 'n/a';
      lines.push(
        pad(row.type, 22) + lpad(row.count, 4) +
        lpad(row.posCount > 0 ? mrrStr            : 'n/a', 8) +
        lpad(row.posCount > 0 ? String(row.rank1) : 'n/a', 6) +
        lpad(row.posCount > 0 ? cr5Str            : 'n/a', 7) +
        (showRegr  ? lpad(row.posCount > 0 ? String(row.regressions) : 'n/a', 5) : '') +
        (guardsCol ? lpad(row.posCount > 0 ? String(row.guards ?? 0) : 'n/a', 7) : '') +
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

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('  custom-50 CE routing benchmark — guard v1 vs v3 vs v4');
  lines.push(`  Date              : ${today()}`);
  lines.push(`  Provider          : ${providerInfo.denseProvider}/${providerInfo.sparseProvider}`);
  lines.push(SEP2);
  lines.push(`  CE_MODEL          : ${CE_MODEL}`);
  lines.push(`  CE_INPUT          : ${CE_INPUT}`);
  lines.push(`  CE_DTYPE          : ${CE_DTYPE}`);
  lines.push(`  CE_BATCH_SIZE     : ${CE_BATCH_SIZE}`);
  lines.push(`  BENCH_TOP_K       : ${TOP_K}`);
  lines.push(`  RERANK_PREFETCH_MULT : ${RERANK_PREFETCH_MULT}`);
  lines.push(`  guard v1          : ${GUARD_V1} (original custom-50 guard)`);
  lines.push(`  guard v3          : ${GUARD_V3} (provider-activation priority + exact-token single-protect)`);
  lines.push(`  guard v4          : ${GUARD_V4} (v3 + provider-activation top-2 preservation for providers.md activation guides)`);
  lines.push(`  label usage       : v3/v4 use type label for provider-activation + config-env (benchmark-only)`);
  lines.push(`  BENCH_SKIP_INDEX  : ${SKIP_INDEX ? 'yes' : 'no'}`);
  lines.push(`  Query types       : ${typeLine}`);
  lines.push(SEP);
  lines.push('');

  // ── Aggregate table ──────────────────────────────────────────────────────────
  const COL = 12;
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
    ['p50 latency',      m => `${allMetrics[m].p50}ms`],
    ['p95 latency',      m => `${allMetrics[m].p95}ms`],
  ];
  for (const [label, fn] of metricRows) {
    lines.push(pad(label, LBL) + MODES.map(m => lpad(fn(m), COL)).join(''));
  }
  lines.push(SEP2);
  lines.push('');

  // ── Gate checklist (ce-routed-v4 vs hybrid-true) ────────────────────────────
  const base      = allMetrics['hybrid-true'];
  const routedV1  = allMetrics['ce-routed-v1'];
  const routedV3  = allMetrics['ce-routed-v3'];
  const routedV4  = allMetrics['ce-routed-v4'];
  const mrrBase   = base.mrr10 ?? 0;
  const mrrV1     = routedV1.mrr10 ?? 0;
  const mrrV3     = routedV3.mrr10 ?? 0;
  const mrrV4     = routedV4.mrr10 ?? 0;
  const cr5Base   = base.chunkRecall5 ?? 0;
  const cr10Base  = base.chunkRecall10 ?? 0;
  const cr5V4     = routedV4.chunkRecall5 ?? 0;
  const cr10V4    = routedV4.chunkRecall10 ?? 0;
  const negV4     = routedV4.negativePass ?? 0;

  const regrRaw = analysis.filter(r => r.isRegrRaw).length;
  const regrV1  = analysis.filter(r => r.isRegrV1).length;
  const regrV3  = analysis.filter(r => r.isRegrV3).length;
  const regrV4  = analysis.filter(r => r.isRegrV4).length;

  const WATCHED_IDS = ['c03', 'c16', 'c23', 'c36', 'c46'];
  const watchedChecks = WATCHED_IDS.map(id => {
    const row = analysis.find(r => r.query.id === id);
    return { id, ok: row ? !row.isRegrV4 : true, row };
  });
  const watchedPass = watchedChecks.every(w => w.ok);

  // Type-level MRR drop check for v4.
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
    let hybSum = 0, v4Sum = 0, cnt = 0;
    for (const r of pos) {
      const hv = mrrAt(r.byMode['hybrid-true'], r.query.qrels, 10);
      const vv = mrrAt(r.byMode['ce-routed-v4'], r.query.qrels, 10);
      if (hv !== null && vv !== null) { hybSum += hv; v4Sum += vv; cnt++; }
    }
    if (cnt > 0) {
      const drop = (hybSum - v4Sum) / cnt;
      if (drop > worstTypeDrop) { worstTypeDrop = drop; worstTypeLabel = type; }
    }
  }
  const gTypeMRR = worstTypeDrop < 0.030;

  const gMRRmin  = mrrV4 >= 0.755;
  const gCR5     = cr5V4 >= cr5Base;
  const gCR10    = cr10V4 >= cr10Base;
  const gNeg     = negV4 >= 1.0;
  const gRegr    = regrV4 === 0;
  const gatePass = gMRRmin && gCR5 && gCR10 && gNeg && gRegr && watchedPass && gTypeMRR;

  lines.push('Guard v1 vs v3 vs v4 regression comparison:');
  lines.push(SEP2);
  lines.push(`  ce-raw regressions         : ${regrRaw}`);
  lines.push(`  ce-routed-v1 regressions   : ${regrV1}  (${GUARD_V1}: original custom-50 guard)`);
  lines.push(`  ce-routed-v3 regressions   : ${regrV3}  (${GUARD_V3}: provider-activation priority + exact-token single-protect)`);
  lines.push(`  ce-routed-v4 regressions   : ${regrV4}  (${GUARD_V4}: v3 + provider-activation top-2 preservation)`);
  lines.push(`  MRR delta  v1 vs hybrid    : ${mrrV1 >= mrrBase ? '+' : ''}${(mrrV1 - mrrBase).toFixed(3)}`);
  lines.push(`  MRR delta  v3 vs hybrid    : ${mrrV3 >= mrrBase ? '+' : ''}${(mrrV3 - mrrBase).toFixed(3)}`);
  lines.push(`  MRR delta  v4 vs hybrid    : ${mrrV4 >= mrrBase ? '+' : ''}${(mrrV4 - mrrBase).toFixed(3)}`);
  lines.push('');

  const fixedByV4 = analysis.filter(r => r.isRegrV3 && !r.isRegrV4);
  const newInV4   = analysis.filter(r => !r.isRegrV3 && r.isRegrV4);
  if (fixedByV4.length) {
    lines.push(`  Fixed by v4 (regression in v3, not in v4) — ${fixedByV4.length}:`);
    for (const row of fixedByV4) {
      lines.push(`    [${row.query.id}] ${row.query.type ?? '?'} / v3-route=${row.routeClassV3} v4-route=${row.routeClassV4}  hybrid=#${row.ranks['hybrid-true']} v3=#${row.ranks['ce-routed-v3'] ?? 'miss'} v4=#${row.ranks['ce-routed-v4'] ?? 'miss'}`);
      lines.push(`      query: ${row.query.query.slice(0, 60)}`);
    }
  }
  if (newInV4.length) {
    lines.push(`  New regressions in v4 (not in v3) — ${newInV4.length}:`);
    for (const row of newInV4) {
      lines.push(`    [${row.query.id}] ${row.query.type ?? '?'} / v3-route=${row.routeClassV3} v4-route=${row.routeClassV4}  hybrid=#${row.ranks['hybrid-true']} v3=#${row.ranks['ce-routed-v3'] ?? 'miss'} v4=#${row.ranks['ce-routed-v4'] ?? 'miss'}`);
      lines.push(`      query: ${row.query.query.slice(0, 60)}`);
    }
  }
  lines.push(SEP2);
  lines.push('');

  lines.push('Promotion gate (ce-routed-v4 vs hybrid-true):');
  lines.push(SEP2);
  lines.push(`  [${gMRRmin ? '✓' : '✗'}] MRR@10 >= 0.755 (original v1 baseline 0.760 − 0.005)   (got ${f3(mrrV4).trim()}, base=${f3(mrrBase).trim()})`);
  lines.push(`  [${gCR5   ? '✓' : '✗'}] chunkRecall@5 >= hybrid baseline   (got ${pct(cr5V4).trim()}, base=${pct(cr5Base).trim()})`);
  lines.push(`  [${gCR10  ? '✓' : '✗'}] chunkRecall@10 >= hybrid baseline   (got ${pct(cr10V4).trim()}, base=${pct(cr10Base).trim()})`);
  lines.push(`  [${gNeg   ? '✓' : '✗'}] negativePass = 100%   (got ${pct(negV4).trim()})`);
  lines.push(`  [${gRegr  ? '✓' : '✗'}] zero regressions (rel>=3, hybrid rank <=3 → ce-routed-v4 >3)   (got ${regrV4})`);
  for (const { id, ok, row } of watchedChecks) {
    lines.push(`  [${ok ? '✓' : '✗'}] watched ${id} must not regress   (hybrid=#${row?.ranks['hybrid-true'] ?? 'n/a'} v3=#${row?.ranks['ce-routed-v3'] ?? 'miss'} v4=#${row?.ranks['ce-routed-v4'] ?? 'miss'})`);
  }
  lines.push(`  [${gTypeMRR ? '✓' : '✗'}] no query type with MRR drop >= 0.030 vs hybrid   (worst: ${worstTypeLabel || 'none'} drop=${worstTypeDrop.toFixed(3)})`);
  lines.push('');
  lines.push(`  ce-raw regressions for comparison : ${regrRaw}`);
  lines.push(`  v1 regressions for comparison     : ${regrV1}`);
  lines.push(`  v3 regressions for comparison     : ${regrV3}`);
  const verdictText = gatePass
    ? 'GATE PASSED — CE routing v4 does not regress custom-50; proceed to holdout-50 planning'
    : `GATE FAILED — ${!gMRRmin ? `MRR@10 ${f3(mrrV4).trim()} below 0.755` : !gRegr ? `${regrV4} rank<=3 regression(s)` : !watchedPass ? `watched query regression` : !gTypeMRR ? `type MRR drop ${worstTypeDrop.toFixed(3)} >= 0.030 (${worstTypeLabel})` : 'criteria not met'}`;
  lines.push(`  Verdict: ${verdictText}`);
  lines.push(SEP2);
  lines.push('');

  // ── Per-query routing table ──────────────────────────────────────────────────
  lines.push('Per-query routing table (v4 is the gate-evaluated mode):');
  lines.push(SEP2);
  lines.push(
    pad('ID', 5) + '  ' +
    pad('type', 20) + '  ' +
    pad('v4-route', 20) + '  ' +
    lpad('hyb', 5) + '  ' +
    lpad('raw', 5) + '  ' +
    lpad('v1', 5) + '  ' +
    lpad('v3', 5) + '  ' +
    lpad('v4', 5) + '  ' +
    pad('g4', 4) + '  ' +
    'query'
  );
  lines.push(SEP2);

  for (const row of analysis) {
    const rk = m => row.ranks[m] != null ? `#${row.ranks[m]}` : 'miss';
    const flag = row.isRegrV4                      ? '[REGR-v4!]' :
                 row.isRegrV3 && !row.isRegrV4     ? '[FIX-v4]'   :
                 row.isImprovV4                    ? '[IMPR-v4]'   : '';
    const g4 = row.guardFiredV4 ? 'Y' : (row.oracleFired ? 'o' : '');
    lines.push(
      pad(row.query.id, 5) + '  ' +
      pad(row.query.type ?? '?', 20) + '  ' +
      pad(row.routeClassV4 ?? row.queryClassV3, 20) + '  ' +
      lpad(rk('hybrid-true'), 5) + '  ' +
      lpad(rk('ce-raw'), 5) + '  ' +
      lpad(rk('ce-routed-v1'), 5) + '  ' +
      lpad(rk('ce-routed-v3'), 5) + '  ' +
      lpad(rk('ce-routed-v4'), 5) + '  ' +
      pad(g4, 4) + '  ' +
      (flag ? `${flag} ` : '') +
      row.query.query.slice(0, 50).trimEnd()
    );
  }
  lines.push(SEP2);
  lines.push('');

  // ── Regression detail ────────────────────────────────────────────────────────
  const regressions = analysis.filter(r => r.isRegrV4);
  if (regressions.length) {
    lines.push(`Remaining regressions in ce-routed-v4 (${regressions.length}):`);
    lines.push(SEP2);
    for (const row of regressions) {
      lines.push(`[${row.query.id}] type=${row.query.type ?? '?'}  v4-route=${row.routeClassV4}  g4-fired=${row.guardFiredV4}`);
      lines.push(`  query: ${row.query.query}`);
      for (const mode of MODES) {
        const top1cid = row.top1ByMode[mode];
        const rel = top1cid ? (row.qrels.get(top1cid) ?? 0) : 0;
        const rankStr = row.ranks[mode] != null ? `#${row.ranks[mode]}` : 'miss';
        lines.push(`  ${pad(mode, 22)} rank=${rankStr}  top1=${top1cid ?? '-'}  rel=${rel}`);
      }
      lines.push('');
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Fixed by v4 ─────────────────────────────────────────────────────────────
  const fixedV4 = analysis.filter(r => r.isRegrV3 && !r.isRegrV4);
  if (fixedV4.length) {
    lines.push(`Regressions fixed by v4 guard (${fixedV4.length}):`);
    lines.push(SEP2);
    for (const row of fixedV4) {
      lines.push(
        `  [${row.query.id}] type=${row.query.type ?? '?'}  v3-route=${row.routeClassV3}  v4-route=${row.routeClassV4}  g4-fired=${row.guardFiredV4}`
      );
      lines.push(`    query: ${row.query.query}`);
      lines.push(`    v3 rank ${row.ranks['ce-routed-v3'] ?? 'miss'} → v4 rank ${row.ranks['ce-routed-v4'] ?? 'miss'}`);
      if (row.protectedIdV4) lines.push(`    protected: ${row.protectedIdV4}`);
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Watched query detail ─────────────────────────────────────────────────────
  const watched = analysis.filter(r => r.isWatched);
  if (watched.length) {
    lines.push('Watched query detail (c03, c16, c23, c36, c46):');
    lines.push(SEP2);
    for (const row of watched) {
      const status = row.isRegrV4 ? 'REGRESSION-v4' : row.isRegrV3 && !row.isRegrV4 ? 'fixed-by-v4' : 'ok';
      lines.push(`  [${row.query.id}] ${status}  type=${row.query.type ?? '?'}  v1-route=${row.queryClassV1}  v3-route=${row.routeClassV3}  v4-route=${row.routeClassV4}`);
      lines.push(`    query: ${row.query.query}`);
      for (const mode of MODES) {
        lines.push(`    ${pad(mode, 22)}: rank ${row.ranks[mode] != null ? '#'+row.ranks[mode] : 'miss'}  top1=${row.top1ByMode[mode] ?? '-'}`);
      }
      if (row.guardFiredV1) lines.push(`    v1 guard fired: protected ${row.protectedIdV1}`);
      if (row.guardFiredV3) lines.push(`    v3 guard fired: protected ${row.protectedIdV3}`);
      if (row.guardFiredV4) lines.push(`    v4 guard fired: protected ${row.protectedIdV4}`);
      if (row.oracleFired)  lines.push(`    oracle guard also fired`);
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Acceptance criteria summary ──────────────────────────────────────────────
  lines.push('Acceptance criteria (ce-routed-v4):');
  lines.push(SEP2);
  lines.push(`  MRR@10 >= 0.755 (v1 baseline 0.760 − 0.005) : ${gMRRmin ? 'MET' : 'NOT MET'} (${f3(mrrV4).trim()}, v3=${f3(mrrV3).trim()}, v1=${f3(mrrV1).trim()})`);
  lines.push(`  chunkRecall@5 >= hybrid baseline             : ${gCR5  ? 'MET' : 'NOT MET'} (${pct(cr5V4).trim()} vs ${pct(cr5Base).trim()})`);
  lines.push(`  chunkRecall@10 >= hybrid baseline            : ${gCR10 ? 'MET' : 'NOT MET'} (${pct(cr10V4).trim()} vs ${pct(cr10Base).trim()})`);
  lines.push(`  negativePass = 100%                         : ${gNeg  ? 'MET' : 'NOT MET'} (${pct(negV4).trim()})`);
  lines.push(`  zero rank<=3 regressions                    : ${gRegr ? 'MET' : 'NOT MET'} (${regrV4} remaining)`);
  lines.push(`  watched queries (c03,c16,c23,c36,c46) ok    : ${watchedPass ? 'MET' : 'NOT MET'}`);
  lines.push(`  no type MRR drop >= 0.030                   : ${gTypeMRR ? 'MET' : 'NOT MET'} (worst: ${worstTypeLabel || 'none'} drop=${worstTypeDrop.toFixed(3)})`);
  lines.push('');
  lines.push(`  Overall: ${gatePass ? 'PASSED — proceed to holdout-50 planning' : 'FAILED — iterate guard before holdout'}`);
  lines.push(SEP2);
  lines.push('');

  // ── Ordering-loss diagnostic ─────────────────────────────────────────────────
  const lossRows = computeOrderingLoss(queryResults, MODES);
  for (const l of buildOrderingLossSection(lossRows, queryResults, SEP2, {
    modes: MODES, v4Mode: 'ce-routed-v4', showV2: false,
  })) lines.push(l);

  // ── Per-class metrics ────────────────────────────────────────────────────────
  for (const l of buildPerClassSection(queryResults, analysis, SEP2)) lines.push(l);
  lines.push('');

  lines.push(SEP);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

process.stderr.write(`=== semidex custom-50 CE routing benchmark (guard v1 vs v3 vs v4) ===\n`);
process.stderr.write(`CE_MODEL=${CE_MODEL}  CE_INPUT=${CE_INPUT}  CE_DTYPE=${CE_DTYPE}  v1=${GUARD_V1}  v3=${GUARD_V3}  v4=${GUARD_V4}\n`);

process.env.ONNX_EMBED = '1';
delete process.env.DENSE_PROVIDER;
delete process.env.SPARSE_PROVIDER;

process.stderr.write('\n[1/3] Setup collection...\n');
let indexedIds, emptyChunkIds;
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
  process.stderr.write('[2/3] Skipping index (BENCH_SKIP_INDEX=1) — fetching chunk IDs...\n');
  ({ indexedIds, emptyChunkIds } = await fetchIndexedChunkIds());
} else {
  process.stderr.write('[2/3] Indexing fixtures...\n');
  ({ indexedIds, emptyChunkIds } = await indexFixtures());
}

const rawQueries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
const queries = rawQueries.queries.map(q => ({
  ...q,
  qrels: buildQrels(q.relevantChunks),
  expectedTokens: q.expectedTokens ? q.expectedTokens.flatMap(t => tokenise(t)).filter(Boolean) : null,
}));

const { typeDistribution: _typeDist, warnings: _typeWarn } = validateQueryTypes(rawQueries.queries);
if (_typeWarn.length) {
  for (const w of _typeWarn) process.stderr.write(`[ce-routing] type warning: ${w}\n`);
}
process.stderr.write(`Types: ${formatTypeDistribution(_typeDist)}\n`);

validateQrels(queries, indexedIds);

process.stderr.write('\n[3/3] Pre-loading CE model...\n');
await loadCEModel({ modelId: CE_MODEL, dtype: CE_DTYPE, logPrefix: '[ce]' });

process.stderr.write('\nRunning queries...\n');
const queryResults = [];
for (const q of queries) {
  process.stderr.write(`  ${q.id}: ${q.query.slice(0, 50)}...`);
  const res = await runQuery(q);
  queryResults.push({ query: q, ...res });
  process.stderr.write(` v1=${res.queryClassV1} v3=${res.queryClassV3}${res.guardFiredV3 ? ' [g3]' : ''}${res.guardFiredV4 ? ' [g4]' : ''} (${res.hybridTrueMs + res.prefetchMs + res.crossEncoderMs}ms)\n`);
}

const allMetrics = computeAllMetrics(queryResults);
const analysis   = buildQueryAnalysis(queryResults);
const report     = buildReport(allMetrics, analysis, providerInfo, queryResults);

process.stdout.write(report + '\n');

mkdirSync(RESULTS_DIR, { recursive: true });
const modelSlug = CE_MODEL.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const outPath   = resolve(RESULTS_DIR, `${today()}-custom50-ce-routing-v4-${modelSlug}.txt`);
writeFileSync(outPath, report + '\n', 'utf8');
process.stderr.write(`\nSaved: ${outPath}\n`);
