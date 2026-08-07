// CE routing benchmark for custom-150 Tier B.
//
// Compares guard v1 (custom-50 heuristic-v1 ported verbatim), guard v2
// (adds config-env route, fixes provider-activation config-env suppression,
// fixes protected insertion order), guard v3 (provider-activation priority
// before config-env; exact-token single-protect with overlap+structural scoring),
// and guard v4 (v3 base + provider-activation top-2 preservation for providers.md
// activation-guide chunks displaced from hybrid top-2 to CE index 2).
//
// Requires: bench-retrieval-custom-150 already indexed.
//   Run  BENCH_PROVIDER=onnx npm run bench:custom150  first, or use BENCH_SKIP_INDEX=1.
//
// Modes compared:
//   hybrid-true    hybridSearch(TOP_K) baseline
//   det-rerank     current deterministic reranker (rerankResults)
//   ce-raw         CE rerank, no routing guard
//   ce-routed-v1   CE rerank + heuristic-v1 guard (custom-50 port, no config-env)
//   ce-routed-v2   CE rerank + heuristic-v2 guard (config-env route + insertion fix)
//   ce-routed-v3   CE rerank + heuristic-v3 guard (provider-activation priority + exact-token single-protect)
//   ce-routed-v4   CE rerank + heuristic-v4 guard (v3 + provider-activation top-2 preservation)
//   ce-oracle      CE rerank + oracle guard (qrel-aware regression guard — pure CE order, promotes rel>=3 hybrid top-3 chunks; not a global upper bound)
//
// Usage:
//   BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 \
//   CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 CE_INPUT=text+meta \
//     node benchmarks/retrieval/custom-150/ce-routing-bench.js
//
//   npm run bench:custom150:ce-routing   (requires BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 as env)

if (process.argv.includes('--help')) {
  process.stdout.write(`CE routing benchmark — custom-150 Tier B (guard v1 vs v2 vs v3 vs v4)

Usage:
  BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 \\
  CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 \\
  CE_INPUT=text+meta \\
    node benchmarks/retrieval/custom-150/ce-routing-bench.js

Environment:
  CE_MODEL             HF model ID (default: cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)
  CE_INPUT             text | text+section | text+meta  (default: text+meta)
  CE_DTYPE             dtype for from_pretrained (default: fp32)
  CE_BATCH_SIZE        Pairs per batch (default: 16)
  BENCH_TOP_K          Search depth (default: 10)
  BENCH_WINDOW         Adjacency window for windowRecall (default: 1)
  RERANK_PREFETCH_MULT Candidate pool multiplier (default: 4)
  BENCH_SKIP_INDEX     1 = reuse existing bench-retrieval-custom-150 collection
  BENCH_PROVIDER       onnx = force bge-m3-onnx (recommended)

Output:
  benchmarks/retrieval/results/YYYY-MM-DD-custom150-ce-routing-v4-{model_slug}.txt

Modes:
  hybrid-true   baseline
  det-rerank    deterministic rerankResults
  ce-raw        CE only, no guard
  ce-routed-v1  CE + heuristic-v1 guard (custom-50 port, no config-env route)
  ce-routed-v2  CE + heuristic-v2 guard (adds config-env route, fixes insertion order)
  ce-routed-v3  CE + heuristic-v3 guard (provider-activation priority + exact-token single-protect)
  ce-routed-v4  CE + heuristic-v4 guard (v3 + provider-activation top-2 preservation)
  ce-oracle     CE + oracle guard (qrel-aware regression guard — pure CE order, promotes rel>=3 hybrid top-3 chunks; not a global upper bound)

Gate (ce-routed-v4 vs hybrid-true):
  MRR@10 improvement >= +0.030
  chunkRecall@5 >= hybrid baseline
  chunkRecall@10 >= hybrid baseline
  negativePass = 100%
  zero rank<=3 -> >3 regressions on rel>=3 chunks
  no cross-lingual-ua-en cR@5 drop below hybrid
  no query type with MRR drop >= 0.030 vs hybrid
`);
  process.exit(0);
}

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { env as hfEnv } from '@huggingface/transformers';

import { chunkFile } from '../../../src/shared/indexer/phases/chunk.js';
import {
  deleteBySourceFile,
  upsertPoints, hybridSearch, scroll,
} from '../../../src/shared/core/qdrant.js';
import { embedForIndex, embedForSearch } from '../../../src/shared/core/embeddings.js';
import { rerankResults } from '../../../src/core/rerank.js';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { resolveBenchProfile } from '../../lib/resolve-profile.js';
import { validateQueryTypes, formatTypeDistribution } from '../custom-50/query-types.js';

import { today, f3, pct, pad, lpad } from '../lib/ce-routing-format.js';
import {
  buildQrels, tokenise, chunkRecallHit, mrrAt,
  computeRoutingMetrics, buildRoutingAnalysis, computePerClassRows,
  computeOrderingLoss, buildOrderingLossSection,
} from '../lib/ce-routing-metrics.js';
import {
  classifyQueryV1, classifyQueryV2, classifyQueryV3C150,
  applyHeuristicGuardV1, applyHeuristicGuardV2,
  applyHeuristicGuardV3C150, applyHeuristicGuardV4C150,
  applyOracleGuard,
} from '../lib/ce-routing-guards.js';
import { loadCEModel, scoreCrossEncoder } from '../lib/ce-model.js';

const __dirname        = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SHARED  = resolve(__dirname, '../fixtures/docs');
const FIXTURES_C50     = resolve(__dirname, '../custom-50/fixtures/docs');
const FIXTURES_OWN     = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH     = resolve(__dirname, 'queries.json');
const RESULTS_DIR      = resolve(__dirname, '../results');
const COLLECTION       = 'bench-retrieval-custom-150';

const storageAdapter = createStorageAdapter();
// Resolved before indexing/search — embedForIndex/embedForSearch require a
// resolved profile object, not a bare collection name.
let PROFILE = null;

hfEnv.cacheDir = resolve(__dirname, '../../../models');

// ── Env knobs ─────────────────────────────────────────────────────────────────

function envInt(name, def, min, max) {
  const v = parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      process.stderr.write(`[ce-routing-c150] ${name}="${process.env[name]}" invalid — using ${def}\n`);
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

if (process.env.BENCH_PROVIDER === 'onnx') {
  process.env.ONNX_EMBED = '1';
  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
}

const GUARD_V1 = 'heuristic-v1';
const GUARD_V2 = 'heuristic-v2';
const GUARD_V3 = 'heuristic-v3';
const GUARD_V4 = 'heuristic-v4';

// ── Fixture list (mirrors custom-150/run.js) ──────────────────────────────────

function buildFixtureList() {
  const list = [
    { name: 'providers.md',         dir: FIXTURES_SHARED },
    { name: 'qdrant.md',            dir: FIXTURES_SHARED },
    { name: 'chunking.md',          dir: FIXTURES_SHARED },
    { name: 'sync.md',              dir: FIXTURES_SHARED },
    { name: 'mcp-workflow.md',      dir: FIXTURES_C50 },
    { name: 'obsidian.md',          dir: FIXTURES_C50 },
    { name: 'project-structure.md', dir: FIXTURES_C50 },
    { name: 'benchmarking.md',      dir: FIXTURES_C50 },
    { name: 'config-env.md',        dir: FIXTURES_C50 },
    { name: 'multilingual.md',      dir: FIXTURES_C50 },
  ];
  if (existsSync(FIXTURES_OWN)) {
    for (const name of readdirSync(FIXTURES_OWN).filter(f => f.endsWith('.md'))) {
      list.push({ name, dir: FIXTURES_OWN });
    }
  }
  return list;
}

const FIXTURE_FILES = buildFixtureList();

// ── Collection setup ──────────────────────────────────────────────────────────

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
  const indexedIds    = new Set();
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
          file_hash: 'bench-c150-ce', vector_size: 1024, ...meta,
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
  const indexedIds    = new Set();
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

// ── Per-query runner ──────────────────────────────────────────────────────────

async function runQuery(q) {
  const { dense, sparse } = await embedForSearch(PROFILE, q.query);
  const candidateLimit    = Math.max(TOP_K * RERANK_PREFETCH_MULT, TOP_K + 5);

  const t0 = Date.now();
  const hybridTrue   = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
  const hybridTrueMs = Date.now() - t0;

  const t1 = Date.now();
  const pool         = await hybridSearch(COLLECTION, dense, sparse, candidateLimit);
  const prefetchMs   = Date.now() - t1;

  pool.__query__       = q.query;
  hybridTrue.__query__ = q.query;

  const t2 = Date.now();
  const detResults  = rerankResults(pool, q.query, { finalLimit: TOP_K, collection: COLLECTION });
  const detRerankMs = Date.now() - t2;

  const t3 = Date.now();
  const ceRanked    = (await scoreCrossEncoder(q.query, pool, { inputMode: CE_INPUT, batchSize: CE_BATCH_SIZE })).sort((a, b) => b.ceScore - a.ceScore);
  const ceRawResults = ceRanked.slice(0, TOP_K).map(x => ({ ...x.result, score: x.ceScore }));

  // v1 guard (heuristic-v1, custom-50 port)
  const queryClassV1 = classifyQueryV1(q.query);
  const { guarded: heurGuardedV1, guardFired: guardFiredV1, protectedId: protectedIdV1 } =
    applyHeuristicGuardV1(queryClassV1, ceRanked, hybridTrue);
  const ceRoutedV1Results = heurGuardedV1.slice(0, TOP_K);

  // v2 guard (heuristic-v2, adds config-env route + insertion-order fix)
  const queryClassV2 = classifyQueryV2(q.query, q.type ?? null);
  const { guarded: heurGuardedV2, guardFired: guardFiredV2, protectedId: protectedIdV2, routeClass: routeClassV2 } =
    applyHeuristicGuardV2(queryClassV2, ceRanked, hybridTrue, q.type ?? null);
  const ceRoutedV2Results = heurGuardedV2.slice(0, TOP_K);

  // v3 guard (heuristic-v3, provider-activation priority fix + exact-token single-protect)
  const queryClassV3 = classifyQueryV3C150(q.query, q.type ?? null);
  const { guarded: heurGuardedV3, guardFired: guardFiredV3, protectedId: protectedIdV3, routeClass: routeClassV3 } =
    applyHeuristicGuardV3C150(queryClassV3, ceRanked, hybridTrue, q.type ?? null);
  const ceRoutedV3Results = heurGuardedV3.slice(0, TOP_K);

  // v4 guard (heuristic-v4, v3 + provider-activation top-2 preservation)
  const { guarded: heurGuardedV4, guardFired: guardFiredV4, protectedId: protectedIdV4, routeClass: routeClassV4 } =
    applyHeuristicGuardV4C150(queryClassV3, ceRanked, hybridTrue, q.type ?? null);
  const ceRoutedV4Results = heurGuardedV4.slice(0, TOP_K);

  const { guarded: oracleGuarded, guardFired: oracleFired } =
    applyOracleGuard(ceRanked, hybridTrue, q.qrels);
  const ceOracleResults = oracleGuarded.slice(0, TOP_K);

  const crossEncoderMs = Date.now() - t3;

  return {
    hybridTrueMs, prefetchMs, detRerankMs, crossEncoderMs,
    queryClassV1, guardFiredV1, protectedIdV1,
    queryClassV2, guardFiredV2, protectedIdV2, routeClassV2,
    queryClassV3, guardFiredV3, protectedIdV3, routeClassV3,
    guardFiredV4, protectedIdV4, routeClassV4,
    oracleFired,
    byMode: {
      'hybrid-true':  hybridTrue,
      'det-rerank':   detResults,
      'ce-raw':       ceRawResults,
      'ce-routed-v1': ceRoutedV1Results,
      'ce-routed-v2': ceRoutedV2Results,
      'ce-routed-v3': ceRoutedV3Results,
      'ce-routed-v4': ceRoutedV4Results,
      'ce-oracle':    ceOracleResults,
    },
  };
}

function rankedFileList(results) {
  const seen = new Set();
  const out  = [];
  for (const r of results) {
    const sf = r.payload?.source_file;
    if (sf && !seen.has(sf)) { seen.add(sf); out.push(sf); }
  }
  return out;
}

// ── Aggregate metrics ─────────────────────────────────────────────────────────

const MODES = ['hybrid-true', 'det-rerank', 'ce-raw', 'ce-routed-v1', 'ce-routed-v2', 'ce-routed-v3', 'ce-routed-v4', 'ce-oracle'];

function computeAllMetrics(queryResults) {
  return computeRoutingMetrics(queryResults, MODES, {
    topK: TOP_K,
    window: BENCH_WINDOW,
    includeFileRecall: true,
    fileRecallFn: (results, query) => {
      if (!query.expectedFiles?.length) return null;
      return rankedFileList(results).slice(0, 1).some(f => query.expectedFiles.includes(f));
    },
  });
}

// ── Regression detection ──────────────────────────────────────────────────────

const WATCHED_TYPES_C150 = new Set(['cross-lingual-ua-en', 'provider-activation', 'source-navigation', 'config-env']);

function buildQueryAnalysis(queryResults) {
  const rows = buildRoutingAnalysis(queryResults, MODES, { watchedTypes: WATCHED_TYPES_C150 });

  // Promote guard/class fields from _src to row (custom-150 report uses them directly).
  for (const row of rows) {
    const r = row._src;
    row.queryClassV1  = r.queryClassV1;
    row.queryClassV2  = r.queryClassV2;
    row.routeClassV2  = r.routeClassV2;
    row.queryClassV3  = r.queryClassV3;
    row.routeClassV3  = r.routeClassV3;
    row.routeClassV4  = r.routeClassV4;
    row.guardFiredV1  = r.guardFiredV1;
    row.guardFiredV2  = r.guardFiredV2;
    row.guardFiredV3  = r.guardFiredV3;
    row.guardFiredV4  = r.guardFiredV4;
    row.protectedIdV1 = r.protectedIdV1;
    row.protectedIdV2 = r.protectedIdV2;
    row.protectedIdV3 = r.protectedIdV3;
    row.protectedIdV4 = r.protectedIdV4;
    row.oracleFired   = r.oracleFired;
    // Flat aliases used by buildReport.
    row.isRegrRaw    = row.isRegrByMode['ce-raw'];
    row.isRegrV1     = row.isRegrByMode['ce-routed-v1'];
    row.isRegrV2     = row.isRegrByMode['ce-routed-v2'];
    row.isRegrRouted = row.isRegrByMode['ce-routed-v3'];
    row.isRegrV4     = row.isRegrByMode['ce-routed-v4'];
    row.isImprovRaw    = row.isImprovByMode['ce-raw'];
    row.isImprovRouted = row.isImprovByMode['ce-routed-v3'];
    row.isImprovV4     = row.isImprovByMode['ce-routed-v4'];
  }

  rows.sort((a, b) => {
    if (a.isRegrV4     !== b.isRegrV4)     return a.isRegrV4     ? -1 : 1;
    if (a.isRegrRouted !== b.isRegrRouted) return a.isRegrRouted ? -1 : 1;
    if (a.isRegrV2     !== b.isRegrV2)     return a.isRegrV2     ? -1 : 1;
    if (a.isRegrV1     !== b.isRegrV1)     return a.isRegrV1     ? -1 : 1;
    if (a.isRegrRaw    !== b.isRegrRaw)    return a.isRegrRaw    ? -1 : 1;
    if (a.isWatched    !== b.isWatched)    return a.isWatched    ? -1 : 1;
    return 0;
  });
  return rows;
}

// ── Report ────────────────────────────────────────────────────────────────────

function guardFiredC150(queryResult, mode) {
  if (mode === 'ce-routed-v4') return queryResult.guardFiredV4;
  if (mode === 'ce-routed-v3') return queryResult.guardFiredV3;
  if (mode === 'ce-routed-v2') return queryResult.guardFiredV2;
  if (mode === 'ce-routed-v1') return queryResult.guardFiredV1;
  return false;
}

function buildPerClassSection(queryResults, analysis, SEP2) {
  const lines = [];
  const perClassData = computePerClassRows(queryResults, analysis, MODES, {
    topK: TOP_K,
    guardFiredFn: guardFiredC150,
  });

  for (const mode of MODES) {
    const showRegr    = mode !== 'hybrid-true';
    const guardsColV1 = mode === 'ce-routed-v1';
    const guardsColV2 = mode === 'ce-routed-v2';
    const guardsColV3 = mode === 'ce-routed-v3';
    const guardsColV4 = mode === 'ce-routed-v4';

    lines.push(`Per-class metrics (${mode}):`);
    lines.push(SEP2);
    lines.push(
      pad('type', 22) + lpad('n', 4) +
      lpad('MRR@10', 8) + lpad('rank1', 6) + lpad('cR@5', 7) +
      (showRegr    ? lpad('regr', 5) : '') +
      (guardsColV1 ? lpad('guards', 7) : '') +
      (guardsColV2 ? lpad('guards', 7) : '') +
      (guardsColV3 ? lpad('guards', 7) : '') +
      (guardsColV4 ? lpad('guards', 7) : '') +
      lpad('negPass', 8)
    );
    lines.push(SEP2);

    for (const row of perClassData.get(mode)) {
      const mrrStr     = row.mrr10        != null ? row.mrr10.toFixed(3) : 'n/a';
      const cr5Str     = row.chunkRecall5 != null ? pct(row.chunkRecall5) : 'n/a';
      const negPassStr = row.negativePass != null ? `${(row.negativePass * 100).toFixed(0)}%` : 'n/a';
      const g          = row.guards ?? 0;
      lines.push(
        pad(row.type, 22) + lpad(row.count, 4) +
        lpad(row.posCount > 0 ? mrrStr            : 'n/a', 8) +
        lpad(row.posCount > 0 ? String(row.rank1) : 'n/a', 6) +
        lpad(row.posCount > 0 ? cr5Str            : 'n/a', 7) +
        (showRegr    ? lpad(row.posCount > 0 ? String(row.regressions) : 'n/a', 5) : '') +
        (guardsColV1 ? lpad(row.posCount > 0 ? String(g) : 'n/a', 7) : '') +
        (guardsColV2 ? lpad(row.posCount > 0 ? String(g) : 'n/a', 7) : '') +
        (guardsColV3 ? lpad(row.posCount > 0 ? String(g) : 'n/a', 7) : '') +
        (guardsColV4 ? lpad(row.posCount > 0 ? String(g) : 'n/a', 7) : '') +
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
  const SEP  = '='.repeat(120);
  const SEP2 = '-'.repeat(120);

  const { typeDistribution } = validateQueryTypes(queryResults.map(r => r.query));
  const typeLine = formatTypeDistribution(typeDistribution);

  const base     = allMetrics['hybrid-true'];
  const routedV1 = allMetrics['ce-routed-v1'];
  const routedV2 = allMetrics['ce-routed-v2'];
  const routedV3 = allMetrics['ce-routed-v3'];
  const routedV4 = allMetrics['ce-routed-v4'];
  const mrrBase      = base.mrr10            ?? 0;
  const mrrRoutedV1  = routedV1.mrr10        ?? 0;
  const mrrRoutedV2  = routedV2.mrr10        ?? 0;
  const mrrRoutedV3  = routedV3.mrr10        ?? 0;
  const mrrRoutedV4  = routedV4.mrr10        ?? 0;
  const cr5Base      = base.chunkRecall5     ?? 0;
  const cr5RoutedV4  = routedV4.chunkRecall5 ?? 0;
  const cr10Base     = base.chunkRecall10    ?? 0;
  const cr10RoutedV4 = routedV4.chunkRecall10 ?? 0;
  const negRoutedV4  = routedV4.negativePass ?? 0;

  const regrRaw = analysis.filter(r => r.isRegrRaw).length;
  const regrV1  = analysis.filter(r => r.isRegrV1).length;
  const regrV2  = analysis.filter(r => r.isRegrV2).length;
  const regrV3  = analysis.filter(r => r.isRegrRouted).length;
  const regrV4  = analysis.filter(r => r.isRegrV4).length;

  // Per-class chunkRecall@5 for cross-lingual gate.
  function classMetric(type, mode, fn) {
    const pos = queryResults.filter(r => r.query.type === type && !r.query.shouldHaveNoStrongHit);
    if (!pos.length) return null;
    let sum = 0, count = 0;
    for (const r of pos) {
      const v = fn(r.byMode[mode], r.query.qrels);
      if (v !== null) { sum += v ? 1 : 0; count++; }
    }
    return count > 0 ? sum / count : null;
  }

  // Per-class MRR for gate type-check.
  function classMRR(type, mode) {
    const pos = queryResults.filter(r => r.query.type === type && !r.query.shouldHaveNoStrongHit);
    if (!pos.length) return null;
    let sum = 0, count = 0;
    for (const r of pos) {
      const v = mrrAt(r.byMode[mode], r.query.qrels, 10);
      if (v !== null) { sum += v; count++; }
    }
    return count > 0 ? sum / count : null;
  }

  const xlingCR5Base  = classMetric('cross-lingual-ua-en', 'hybrid-true',  (res, qrels) => chunkRecallHit(res, qrels, 5));
  const xlingCR5V4    = classMetric('cross-lingual-ua-en', 'ce-routed-v4', (res, qrels) => chunkRecallHit(res, qrels, 5));

  // Check per-type MRR drop >= 0.030 (gate evaluates v4).
  const allTypes = [...new Set(queryResults.map(r => r.query.type).filter(Boolean))];
  let worstTypeDrop = null;
  let worstTypeLabel = null;
  for (const t of allTypes) {
    const h = classMRR(t, 'hybrid-true');
    const v = classMRR(t, 'ce-routed-v4');
    if (h != null && v != null && (h - v) >= 0.030) {
      if (worstTypeDrop == null || (h - v) > worstTypeDrop) {
        worstTypeDrop = h - v;
        worstTypeLabel = t;
      }
    }
  }

  // Gate criteria (evaluates ce-routed-v4).
  const gMRRImprove = (mrrRoutedV4 - mrrBase) >= 0.030;
  const gCR5        = cr5RoutedV4  >= cr5Base;
  const gCR10       = cr10RoutedV4 >= cr10Base;
  const gNeg        = negRoutedV4  >= 1.0;
  const gRegr       = regrV4 === 0;
  const gXling      = xlingCR5V4 == null || xlingCR5V4 >= (xlingCR5Base ?? 0);
  const gTypeDrop   = worstTypeDrop == null;
  const gatePass    = gMRRImprove && gCR5 && gCR10 && gNeg && gRegr && gXling && gTypeDrop;

  // v1/v2/v3/v4 cross-sets for comparison section.
  const stillFailingV3 = analysis.filter(r => r.isRegrRouted);
  const newInV3        = analysis.filter(r => r.isRegrRouted && !r.isRegrV2);
  const fixedByV3      = analysis.filter(r => r.isRegrV2  && !r.isRegrRouted);
  const fixedByV4      = analysis.filter(r => r.isRegrRouted && !r.isRegrV4);
  const newInV4        = analysis.filter(r => !r.isRegrRouted && r.isRegrV4);
  const stillFailingV4 = analysis.filter(r => r.isRegrV4);

  // ── Header ──
  lines.push(SEP);
  lines.push('  custom-150 Tier B CE routing benchmark — guard v1 vs v2 vs v3 vs v4');
  lines.push(`  Date              : ${today()}`);
  lines.push(`  Provider          : ${providerInfo.denseProvider}/${providerInfo.sparseProvider}`);
  lines.push(`  Queries           : ${queryResults.length} total (${queryResults.filter(r => !r.query.shouldHaveNoStrongHit).length} positive, ${queryResults.filter(r => r.query.shouldHaveNoStrongHit).length} negative)`);
  lines.push(SEP2);
  lines.push(`  CE_MODEL          : ${CE_MODEL}`);
  lines.push(`  CE_INPUT          : ${CE_INPUT}`);
  lines.push(`  CE_DTYPE          : ${CE_DTYPE}`);
  lines.push(`  CE_BATCH_SIZE     : ${CE_BATCH_SIZE}`);
  lines.push(`  BENCH_TOP_K       : ${TOP_K}`);
  lines.push(`  BENCH_WINDOW      : ${BENCH_WINDOW}`);
  lines.push(`  RERANK_PREFETCH_MULT : ${RERANK_PREFETCH_MULT}`);
  lines.push(`  guard v1          : ${GUARD_V1} (custom-50 port, no config-env route)`);
  lines.push(`  guard v2          : ${GUARD_V2} (config-env route, insertion-order fix)`);
  lines.push(`  guard v3          : ${GUARD_V3} (provider-activation priority before config-env; exact-token single-protect)`);
  lines.push(`  guard v4          : ${GUARD_V4} (v3 + provider-activation top-2 preservation for providers.md activation guides)`);
  lines.push(`  label usage       : v2 uses type label for config-env; v3/v4 use type label for provider-activation + config-env (benchmark-only)`);
  lines.push(`  BENCH_SKIP_INDEX  : ${SKIP_INDEX ? 'yes' : 'no'}`);
  lines.push(`  Query types       : ${typeLine}`);
  lines.push(SEP);
  lines.push('');

  // ── Aggregate table ──
  const COL = 14;
  const LBL = 20;
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
    ['fileRecall@1',     m => pct(allMetrics[m].fileRecall1)],
    ['negativePass',     m => pct(allMetrics[m].negativePass)],
    ['p50 latency',      m => `${allMetrics[m].p50}ms`],
    ['p95 latency',      m => `${allMetrics[m].p95}ms`],
  ];
  for (const [label, fn] of metricRows) {
    lines.push(pad(label, LBL) + MODES.map(m => lpad(fn(m), COL)).join(''));
  }
  lines.push(SEP2);
  lines.push('');

  // ── v1 vs v2 vs v3 vs v4 regression comparison ──
  lines.push('Guard v1 vs v2 vs v3 vs v4 regression comparison:');
  lines.push(SEP2);
  lines.push(`  ce-raw regressions         : ${regrRaw}`);
  lines.push(`  ce-routed-v1 regressions   : ${regrV1}  (heuristic-v1: custom-50 port)`);
  lines.push(`  ce-routed-v2 regressions   : ${regrV2}  (heuristic-v2: config-env route + insertion fix)`);
  lines.push(`  ce-routed-v3 regressions   : ${regrV3}  (heuristic-v3: provider-activation priority + exact-token single-protect)`);
  lines.push(`  ce-routed-v4 regressions   : ${regrV4}  (heuristic-v4: v3 + provider-activation top-2 preservation)`);
  lines.push(`  MRR delta  v1 vs hybrid    : ${(mrrRoutedV1-mrrBase>=0?'+':'')+(mrrRoutedV1-mrrBase).toFixed(3)}`);
  lines.push(`  MRR delta  v2 vs hybrid    : ${(mrrRoutedV2-mrrBase>=0?'+':'')+(mrrRoutedV2-mrrBase).toFixed(3)}`);
  lines.push(`  MRR delta  v3 vs hybrid    : ${(mrrRoutedV3-mrrBase>=0?'+':'')+(mrrRoutedV3-mrrBase).toFixed(3)}`);
  lines.push(`  MRR delta  v4 vs hybrid    : ${(mrrRoutedV4-mrrBase>=0?'+':'')+(mrrRoutedV4-mrrBase).toFixed(3)}`);
  lines.push('');

  // Known regression status table.
  const KNOWN = ['c150-039', 'c150-044', 'c150-009', 'c150-032'];
  lines.push('  Known regression status:');
  lines.push(`  ${'ID'.padEnd(12)} ${'type'.padEnd(22)} ${'hyb'.padStart(5)} ${'v1'.padStart(5)} ${'v2'.padStart(5)} ${'v3'.padStart(5)} ${'v4'.padStart(5)}  status`);
  lines.push(`  ${'-'.repeat(82)}`);
  for (const qid of KNOWN) {
    const row = analysis.find(a => a.query.id === qid);
    if (!row) { lines.push(`  ${qid}  (not in analysis)`); continue; }
    const rk = m => row.ranks[m] != null ? `#${row.ranks[m]}` : 'miss';
    const statusV4 = row.isRegrV4    ? 'STILL FAILING' :
                     (row.isRegrRouted && !row.isRegrV4) ? 'FIXED by v4' :
                     (row.isRegrV2 && !row.isRegrRouted) ? 'fixed by v3' :
                     (row.isRegrV1 && !row.isRegrV2) ? 'fixed by v2' : 'was OK';
    lines.push(`  ${qid.padEnd(12)} ${(row.query.type ?? '?').padEnd(22)} ${rk('hybrid-true').padStart(5)} ${rk('ce-routed-v1').padStart(5)} ${rk('ce-routed-v2').padStart(5)} ${rk('ce-routed-v3').padStart(5)} ${rk('ce-routed-v4').padStart(5)}  ${statusV4}`);
  }
  lines.push('');

  if (fixedByV4.length) {
    lines.push(`  Fixed by v4 (regression in v3, not in v4) — ${fixedByV4.length}:`);
    for (const r of fixedByV4) {
      lines.push(`    [${r.query.id}] ${r.query.type ?? '?'} / v3-route=${r.routeClassV3} v4-route=${r.routeClassV4}  hybrid=#${r.ranks['hybrid-true']} v3=#${r.ranks['ce-routed-v3']??'miss'} v4=#${r.ranks['ce-routed-v4']??'miss'}`);
      lines.push(`      query: ${r.query.query.slice(0, 70)}`);
    }
    lines.push('');
  }
  if (newInV4.length) {
    lines.push(`  NEW regressions introduced by v4 (not in v3) — ${newInV4.length}:`);
    for (const r of newInV4) {
      lines.push(`    [${r.query.id}] ${r.query.type ?? '?'} / v3-route=${r.routeClassV3} v4-route=${r.routeClassV4}  hybrid=#${r.ranks['hybrid-true']} v3=#${r.ranks['ce-routed-v3']??'miss'} v4=#${r.ranks['ce-routed-v4']??'miss'}`);
      lines.push(`      query: ${r.query.query.slice(0, 70)}`);
    }
    lines.push('');
  }
  if (stillFailingV4.length && !newInV4.length && !fixedByV4.length) {
    lines.push(`  Still failing in v4 — ${stillFailingV4.length}:`);
    for (const r of stillFailingV4) {
      lines.push(`    [${r.query.id}] ${r.query.type ?? '?'} / v4-route=${r.routeClassV4}  hybrid=#${r.ranks['hybrid-true']} v4=#${r.ranks['ce-routed-v4']??'miss'}`);
    }
    lines.push('');
  }
  lines.push(SEP2);
  lines.push('');

  // ── Gate checklist (ce-routed-v4) ──
  lines.push('Promotion gate (ce-routed-v4 vs hybrid-true):');
  lines.push(SEP2);
  lines.push(`  [${gMRRImprove ? '✓' : '✗'}] MRR@10 improvement >= +0.030   (got ${(mrrRoutedV4-mrrBase>=0?'+':'')+(mrrRoutedV4-mrrBase).toFixed(3)}, base=${f3(mrrBase).trim()}, v4=${f3(mrrRoutedV4).trim()})`);
  lines.push(`  [${gCR5       ? '✓' : '✗'}] chunkRecall@5 >= hybrid baseline   (got ${pct(cr5RoutedV4).trim()}, base=${pct(cr5Base).trim()})`);
  lines.push(`  [${gCR10      ? '✓' : '✗'}] chunkRecall@10 >= hybrid baseline   (got ${pct(cr10RoutedV4).trim()}, base=${pct(cr10Base).trim()})`);
  lines.push(`  [${gNeg       ? '✓' : '✗'}] negativePass = 100%   (got ${pct(negRoutedV4).trim()})`);
  lines.push(`  [${gRegr      ? '✓' : '✗'}] zero regressions (rel>=3, hybrid rank <=3 → ce-routed-v4 >3)   (got ${regrV4})`);
  lines.push(`  [${gXling     ? '✓' : '✗'}] cross-lingual-ua-en cR@5 >= hybrid baseline   (got ${pct(xlingCR5V4).trim()}, base=${pct(xlingCR5Base).trim()})`);
  lines.push(`  [${gTypeDrop  ? '✓' : '✗'}] no query type with MRR drop >= 0.030 vs hybrid   (${gTypeDrop ? 'all types OK' : `worst: ${worstTypeLabel} drop=${worstTypeDrop?.toFixed(3)}`})`);
  lines.push('');
  lines.push(`  ce-raw regressions for comparison : ${regrRaw}`);
  lines.push(`  v1 regressions for comparison     : ${regrV1}`);
  lines.push(`  v2 regressions for comparison     : ${regrV2}`);
  lines.push(`  v3 regressions for comparison     : ${regrV3}`);
  lines.push('');

  lines.push(`  Q: Did CE routing v4 beat hybrid by >= +0.030 MRR?        ${gMRRImprove ? 'YES' : 'NO'}  (delta=${(mrrRoutedV4-mrrBase>=0?'+':'')+(mrrRoutedV4-mrrBase).toFixed(3)})`);
  lines.push(`  Q: Did it preserve chunkRecall@5?                         ${gCR5   ? 'YES' : 'NO'}  (${pct(cr5RoutedV4).trim()} vs ${pct(cr5Base).trim()})`);
  lines.push(`  Q: Did it preserve chunkRecall@10?                        ${gCR10  ? 'YES' : 'NO'}  (${pct(cr10RoutedV4).trim()} vs ${pct(cr10Base).trim()})`);
  lines.push(`  Q: Did it preserve cross-lingual-ua-en?                   ${gXling ? 'YES' : 'NO'}  (cR@5 ${pct(xlingCR5V4).trim()} vs ${pct(xlingCR5Base).trim()})`);
  lines.push(`  Q: Rank<=3 -> >3 regressions?                             ${regrV4 === 0 ? 'NONE' : regrV4 + ' regression(s)'}`);
  lines.push(`  Q: Any type with MRR drop >= 0.030?                       ${gTypeDrop ? 'NO' : 'YES — ' + worstTypeLabel + ' (drop=' + worstTypeDrop?.toFixed(3) + ')'}`);
  lines.push(`  Q: v3 regressions fixed by v4?                            v3 had ${regrV3}, v4 has ${regrV4} (fixed=${fixedByV4.length}, new=${newInV4.length})`);
  lines.push('');

  let verdict;
  if (gatePass) {
    verdict = 'GATE PASSED — CE routing v4 generalises to custom-150; proceed to custom-50 regression check then holdout-50';
  } else if (!gMRRImprove && gCR5 && gCR10 && gNeg && gRegr && gXling && gTypeDrop) {
    verdict = 'GATE FAILED (MRR gap only) — v4 routing is safe but does not lift MRR enough on custom-150';
  } else if (!gRegr) {
    verdict = 'GATE FAILED (regressions) — v4 introduces rank<=3 -> >3 regressions';
  } else if (!gTypeDrop) {
    verdict = `GATE FAILED (type MRR drop) — ${worstTypeLabel} drops ${worstTypeDrop?.toFixed(3)} MRR vs hybrid`;
  } else if (!gXling) {
    verdict = 'GATE FAILED (cross-lingual regression) — MRR improves globally but cross-lingual-ua-en regresses';
  } else {
    verdict = 'GATE FAILED — multiple criteria not met; see detail above';
  }
  lines.push(`  Verdict: ${verdict}`);
  lines.push(SEP2);
  lines.push('');

  // ── Watched class detail ──
  const analysisById = new Map(analysis.map(a => [a.query.id, a]));
  const WATCHED_LIST = ['cross-lingual-ua-en', 'provider-activation', 'source-navigation', 'config-env', 'exact-token'];
  lines.push('Watched class detail (cross-lingual-ua-en, provider-activation, source-navigation, config-env, exact-token):');
  lines.push(SEP2);
  for (const cls of WATCHED_LIST) {
    const classQRs = queryResults.filter(r => r.query.type === cls);
    if (!classQRs.length) { lines.push(`  ${cls}: no queries`); continue; }
    const pos = classQRs.filter(r => !r.query.shouldHaveNoStrongHit);
    const regrInV1 = pos.filter(r => analysisById.get(r.query.id)?.isRegrV1).length;
    const regrInV2 = pos.filter(r => analysisById.get(r.query.id)?.isRegrV2).length;
    const regrInV3 = pos.filter(r => analysisById.get(r.query.id)?.isRegrRouted).length;
    const regrInV4 = pos.filter(r => analysisById.get(r.query.id)?.isRegrV4).length;
    const hyb  = pos.length ? pos.reduce((s, r) => s + (mrrAt(r.byMode['hybrid-true'],  r.query.qrels, 10) ?? 0), 0) / pos.length : null;
    const rou1 = pos.length ? pos.reduce((s, r) => s + (mrrAt(r.byMode['ce-routed-v1'], r.query.qrels, 10) ?? 0), 0) / pos.length : null;
    const rou2 = pos.length ? pos.reduce((s, r) => s + (mrrAt(r.byMode['ce-routed-v2'], r.query.qrels, 10) ?? 0), 0) / pos.length : null;
    const rou3 = pos.length ? pos.reduce((s, r) => s + (mrrAt(r.byMode['ce-routed-v3'], r.query.qrels, 10) ?? 0), 0) / pos.length : null;
    const rou4 = pos.length ? pos.reduce((s, r) => s + (mrrAt(r.byMode['ce-routed-v4'], r.query.qrels, 10) ?? 0), 0) / pos.length : null;
    const cr5H  = pos.length ? pos.filter(r => chunkRecallHit(r.byMode['hybrid-true'],  r.query.qrels, 5) === true).length / pos.length : null;
    const cr5V4 = pos.length ? pos.filter(r => chunkRecallHit(r.byMode['ce-routed-v4'], r.query.qrels, 5) === true).length / pos.length : null;
    const d1 = rou1!=null&&hyb!=null ? (rou1-hyb>=0?'+':'')+(rou1-hyb).toFixed(3) : 'n/a';
    const d2 = rou2!=null&&hyb!=null ? (rou2-hyb>=0?'+':'')+(rou2-hyb).toFixed(3) : 'n/a';
    const d3 = rou3!=null&&hyb!=null ? (rou3-hyb>=0?'+':'')+(rou3-hyb).toFixed(3) : 'n/a';
    const d4 = rou4!=null&&hyb!=null ? (rou4-hyb>=0?'+':'')+(rou4-hyb).toFixed(3) : 'n/a';
    lines.push(`  ${cls} (${pos.length} positive):`);
    lines.push(`    MRR@10  hybrid=${f3(hyb).trim()}  v1=${f3(rou1).trim()} (${d1})  v2=${f3(rou2).trim()} (${d2})  v3=${f3(rou3).trim()} (${d3})  v4=${f3(rou4).trim()} (${d4})`);
    lines.push(`    cR@5    hybrid=${pct(cr5H).trim()}  v4=${pct(cr5V4).trim()}`);
    lines.push(`    regressions  v1=${regrInV1}  v2=${regrInV2}  v3=${regrInV3}  v4=${regrInV4}`);
    const firedV1 = pos.filter(r => analysisById.get(r.query.id)?.guardFiredV1);
    const firedV2 = pos.filter(r => analysisById.get(r.query.id)?.guardFiredV2);
    const firedV3 = pos.filter(r => analysisById.get(r.query.id)?.guardFiredV3);
    const firedV4 = pos.filter(r => analysisById.get(r.query.id)?.guardFiredV4);
    if (firedV1.length) lines.push(`    v1 guard fired on: ${firedV1.map(r => r.query.id).join(', ')}`);
    if (firedV2.length) lines.push(`    v2 guard fired on: ${firedV2.map(r => r.query.id).join(', ')}`);
    if (firedV3.length) lines.push(`    v3 guard fired on: ${firedV3.map(r => r.query.id).join(', ')}`);
    if (firedV4.length) lines.push(`    v4 guard fired on: ${firedV4.map(r => r.query.id).join(', ')}`);
  }
  lines.push(SEP2);
  lines.push('');

  // ── Per-query routing table ──
  lines.push('Per-query routing table (v4 is the gate-evaluated mode):');
  lines.push(SEP2);
  lines.push(
    pad('ID', 9) + '  ' +
    pad('type', 20) + '  ' +
    pad('v4-route', 16) + '  ' +
    lpad('hyb', 5) + '  ' +
    lpad('raw', 5) + '  ' +
    lpad('v1', 5) + '  ' +
    lpad('v2', 5) + '  ' +
    lpad('v3', 5) + '  ' +
    lpad('v4', 5) + '  ' +
    pad('g4', 3) + '  ' +
    'query'
  );
  lines.push(SEP2);

  for (const row of analysis) {
    const rk = m => row.ranks[m] != null ? `#${row.ranks[m]}` : 'miss';
    const flag = row.isRegrV4                        ? 'REGR-v4!' :
                 row.isRegrRouted && !row.isRegrV4   ? 'FIX-v4'   :
                 row.isImprovV4                      ? 'IMPR-v4'   : '';
    const g4 = row.guardFiredV4 ? 'Y' : (row.oracleFired ? 'o' : '');
    lines.push(
      pad(row.query.id, 9) + '  ' +
      pad(row.query.type ?? '?', 20) + '  ' +
      pad(row.routeClassV4 ?? row.queryClassV3 ?? '?', 16) + '  ' +
      lpad(rk('hybrid-true'),  5) + '  ' +
      lpad(rk('ce-raw'),       5) + '  ' +
      lpad(rk('ce-routed-v1'), 5) + '  ' +
      lpad(rk('ce-routed-v2'), 5) + '  ' +
      lpad(rk('ce-routed-v3'), 5) + '  ' +
      lpad(rk('ce-routed-v4'), 5) + '  ' +
      pad(g4, 3) + '  ' +
      (flag ? `[${flag}] ` : '') +
      row.query.query.slice(0, 42).trimEnd()
    );
  }
  lines.push(SEP2);
  lines.push('');

  // ── Remaining regressions in v3 ──
  if (stillFailingV3.length) {
    lines.push(`Remaining regressions in ce-routed-v3 (${stillFailingV3.length}):`);
    lines.push(SEP2);
    for (const row of stillFailingV3) {
      lines.push(`[${row.query.id}] type=${row.query.type ?? '?'}  v3-route=${row.routeClassV3 ?? row.queryClassV3}  g3=${row.guardFiredV3}`);
      lines.push(`  query: ${row.query.query}`);
      for (const mode of MODES) {
        const top1cid = row.top1ByMode[mode];
        const rel     = top1cid ? (row.qrels.get(top1cid) ?? 0) : 0;
        const rankStr = row.ranks[mode] != null ? `#${row.ranks[mode]}` : 'miss';
        lines.push(`  ${pad(mode, 16)} rank=${rankStr}  top1=${top1cid ?? '-'}  rel=${rel}`);
      }
      lines.push('');
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── New regressions introduced by v3 ──
  if (newInV3.length) {
    lines.push(`NEW regressions introduced by v3 (${newInV3.length}):`);
    lines.push(SEP2);
    for (const row of newInV3) {
      lines.push(`[${row.query.id}] type=${row.query.type ?? '?'}  v2-route=${row.routeClassV2 ?? row.queryClassV2}  v3-route=${row.routeClassV3 ?? row.queryClassV3}  g2=${row.guardFiredV2}  g3=${row.guardFiredV3}`);
      lines.push(`  query: ${row.query.query}`);
      for (const mode of MODES) {
        const top1cid = row.top1ByMode[mode];
        const rel     = top1cid ? (row.qrels.get(top1cid) ?? 0) : 0;
        const rankStr = row.ranks[mode] != null ? `#${row.ranks[mode]}` : 'miss';
        lines.push(`  ${pad(mode, 16)} rank=${rankStr}  top1=${top1cid ?? '-'}  rel=${rel}`);
      }
      lines.push('');
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Regressions fixed by v3 (were in v2, not in v3) ──
  if (fixedByV3.length) {
    lines.push(`Regressions fixed by v3 guard (${fixedByV3.length}):`);
    lines.push(SEP2);
    for (const row of fixedByV3) {
      lines.push(`  [${row.query.id}] type=${row.query.type ?? '?'}  v3-route=${row.routeClassV3 ?? row.queryClassV3}  g3-fired=${row.guardFiredV3}`);
      lines.push(`    query: ${row.query.query}`);
      lines.push(`    v2 rank ${row.ranks['ce-routed-v2'] ?? 'miss'} → v3 rank ${row.ranks['ce-routed-v3'] ?? 'miss'}`);
      if (row.protectedIdV3) lines.push(`    v3 protected: ${row.protectedIdV3}`);
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Remaining regressions in v4 ──
  if (stillFailingV4.length) {
    lines.push(`Remaining regressions in ce-routed-v4 (${stillFailingV4.length}):`);
    lines.push(SEP2);
    for (const row of stillFailingV4) {
      lines.push(`[${row.query.id}] type=${row.query.type ?? '?'}  v4-route=${row.routeClassV4 ?? row.queryClassV3}  g4=${row.guardFiredV4}`);
      lines.push(`  query: ${row.query.query}`);
      for (const mode of MODES) {
        const top1cid = row.top1ByMode[mode];
        const rel     = top1cid ? (row.qrels.get(top1cid) ?? 0) : 0;
        const rankStr = row.ranks[mode] != null ? `#${row.ranks[mode]}` : 'miss';
        lines.push(`  ${pad(mode, 16)} rank=${rankStr}  top1=${top1cid ?? '-'}  rel=${rel}`);
      }
      lines.push('');
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── New regressions introduced by v4 ──
  if (newInV4.length) {
    lines.push(`NEW regressions introduced by v4 (${newInV4.length}):`);
    lines.push(SEP2);
    for (const row of newInV4) {
      lines.push(`[${row.query.id}] type=${row.query.type ?? '?'}  v3-route=${row.routeClassV3 ?? row.queryClassV3}  v4-route=${row.routeClassV4}  g3=${row.guardFiredV3}  g4=${row.guardFiredV4}`);
      lines.push(`  query: ${row.query.query}`);
      for (const mode of MODES) {
        const top1cid = row.top1ByMode[mode];
        const rel     = top1cid ? (row.qrels.get(top1cid) ?? 0) : 0;
        const rankStr = row.ranks[mode] != null ? `#${row.ranks[mode]}` : 'miss';
        lines.push(`  ${pad(mode, 16)} rank=${rankStr}  top1=${top1cid ?? '-'}  rel=${rel}`);
      }
      lines.push('');
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Regressions fixed by v4 (were in v3, not in v4) ──
  if (fixedByV4.length) {
    lines.push(`Regressions fixed by v4 guard (${fixedByV4.length}):`);
    lines.push(SEP2);
    for (const row of fixedByV4) {
      lines.push(`  [${row.query.id}] type=${row.query.type ?? '?'}  v4-route=${row.routeClassV4 ?? row.queryClassV3}  g4-fired=${row.guardFiredV4}`);
      lines.push(`    query: ${row.query.query}`);
      lines.push(`    v3 rank ${row.ranks['ce-routed-v3'] ?? 'miss'} → v4 rank ${row.ranks['ce-routed-v4'] ?? 'miss'}`);
      if (row.protectedIdV4) lines.push(`    v4 protected: ${row.protectedIdV4}`);
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Ordering-loss diagnostic ──
  const lossRows = computeOrderingLoss(queryResults, MODES);
  for (const l of buildOrderingLossSection(lossRows, queryResults, SEP2, {
    modes: MODES, v4Mode: 'ce-routed-v4', showV2: true,
  })) lines.push(l);

  // ── Per-class metrics (all modes) ──
  for (const l of buildPerClassSection(queryResults, analysis, SEP2)) lines.push(l);

  lines.push(SEP);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

process.stderr.write(`=== semidex custom-150 CE routing benchmark (guard v1 vs v2 vs v3 vs v4) ===\n`);
process.stderr.write(`CE_MODEL=${CE_MODEL}  CE_INPUT=${CE_INPUT}  CE_DTYPE=${CE_DTYPE}  v1=${GUARD_V1}  v2=${GUARD_V2}  v3=${GUARD_V3}  v4=${GUARD_V4}\n`);

process.stderr.write('\n[1/3] Setup collection...\n');
let indexedIds, emptyChunkIds;
// Resolves PROFILE from the collection's own native metadata if it already
// exists, or from current env if creating it fresh — never a second,
// independent env read after this point. This is what makes
// BENCH_SKIP_INDEX=1 safe: PROFILE always reflects the collection's REAL
// recorded identity, not whatever the current shell happens to have set.
const { denseProvider: ceDenseProvider, sparseProvider: ceSparseProvider } = await ensureCollection();
const providerInfo = { denseProvider: ceDenseProvider, sparseProvider: ceSparseProvider };

if (SKIP_INDEX) {
  const stored = await fetchStoredProvider();
  if (!stored) {
    process.stderr.write(
      `Error: BENCH_SKIP_INDEX=1 but no indexed points found in "${COLLECTION}".\n` +
      `Run BENCH_PROVIDER=onnx npm run bench:custom150 first.\n`
    );
    process.exitCode = 1; process.exit();
  }
  // Sanity check: the collection's own point payload must agree with its own
  // recorded profile — a disagreement here means the collection was
  // partially reindexed with a different model, not that env changed.
  if (stored.denseProvider !== ceDenseProvider || stored.sparseProvider !== ceSparseProvider) {
    process.stderr.write(
      `Error: BENCH_SKIP_INDEX=1 but stored point payload (${stored.denseProvider}/${stored.sparseProvider}) ` +
      `disagrees with "${COLLECTION}"'s own recorded embedding profile (${ceDenseProvider}/${ceSparseProvider}).\n` +
      `The collection may be partially reindexed with a different model. Delete it and re-run without ` +
      `BENCH_SKIP_INDEX=1 to rebuild it cleanly.\n`
    );
    process.exitCode = 1; process.exit();
  }
  process.stderr.write('[2/3] Skipping index (BENCH_SKIP_INDEX=1) — fetching chunk IDs...\n');
  ({ indexedIds, emptyChunkIds } = await fetchIndexedChunkIds());
} else {
  process.stderr.write(`[2/3] Indexing ${FIXTURE_FILES.length} fixture docs...\n`);
  ({ indexedIds, emptyChunkIds } = await indexFixtures());
}

const rawQueries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
const queries = rawQueries.queries.map(q => ({
  ...q,
  qrels:          buildQrels(q.relevantChunks),
  shouldHaveNoStrongHit: q.shouldHaveNoStrongHit ?? false,
  expectedTokens: q.expectedTokens
    ? q.expectedTokens.flatMap(t => tokenise(t)).filter(Boolean)
    : null,
}));

const { typeDistribution: _typeDist, warnings: _typeWarn } = validateQueryTypes(rawQueries.queries);
if (_typeWarn.length) {
  for (const w of _typeWarn) process.stderr.write(`[ce-routing-c150] type warning: ${w}\n`);
}
process.stderr.write(`Types: ${formatTypeDistribution(_typeDist)}\n`);

validateQrels(queries, indexedIds);

process.stderr.write('\n[3/3] Pre-loading CE model...\n');
await loadCEModel({ modelId: CE_MODEL, dtype: CE_DTYPE, logPrefix: '[ce]' });

process.stderr.write('\nRunning queries...\n');
const queryResults = [];
for (const q of queries) {
  process.stderr.write(`  ${q.id}: ${q.query.slice(0, 48)}...`);
  const res = await runQuery(q);
  queryResults.push({ query: q, ...res });
  const guardNote = (res.guardFiredV1 ? ' [g1]' : '') + (res.guardFiredV2 ? ' [g2]' : '') + (res.guardFiredV3 ? ' [g3]' : '') + (res.guardFiredV4 ? ' [g4]' : '');
  process.stderr.write(` v1=${res.queryClassV1} v4=${res.routeClassV4}${guardNote} (${res.hybridTrueMs + res.prefetchMs + res.crossEncoderMs}ms)\n`);
}

const allMetrics = computeAllMetrics(queryResults);
const analysis   = buildQueryAnalysis(queryResults);
const report     = buildReport(allMetrics, analysis, providerInfo, queryResults);

process.stdout.write(report + '\n');

mkdirSync(RESULTS_DIR, { recursive: true });
const modelSlug = CE_MODEL.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const outPath   = resolve(RESULTS_DIR, `${today()}-custom150-ce-routing-v4-${modelSlug}.txt`);
writeFileSync(outPath, report + '\n', 'utf8');
process.stderr.write(`\nSaved: ${outPath}\n`);
