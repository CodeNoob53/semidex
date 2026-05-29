// Merge strategy benchmark v2: LLM-merge (current) vs deterministic split+overlap.
//
// Phase 1 — custom-50 quality:
//   Indexes the 10-file custom-50 fixture corpus with each strategy, runs all
//   custom-50 queries, and computes chunkRecall@5, windowRecall@5, MRR@10, nDCG@10.
//   Includes qrel safety validation: verifies every expected chunk id exists after
//   indexing before computing quality. LLM merge can renumber chunks if it merges
//   sub-chunks; missing qrels are reported as qrel_missing_after_strategy.
//
// Phase 2 — hard-boundary diagnostic:
//   Indexes a synthetic fixture that forces many needsBoundaryCheck chunks (long prose,
//   long checklist, long config block). Reports raw vs final chunk counts, boundary
//   count, LLM calls, merge decisions, and whether the two strategies produce identical
//   chunk text. No quality claims for this phase — no qrels exist.
//
// Timing breakdown per strategy:
//   measuredPhaseMs = chunkMs + mergeMs + embedUpsertMs
//   (excludes readFileSync, deleteBySourceFile, ensureCollection)
//
// Usage:
//   ONNX_EMBED=1 node benchmarks/retrieval/merge-strategy-bench.js
//   BENCH_SKIP_INDEX=1 ONNX_EMBED=1 node benchmarks/retrieval/merge-strategy-bench.js
//   BENCH_RUNS=3 ONNX_EMBED=1 node benchmarks/retrieval/merge-strategy-bench.js
//
// Collections: merge-llm-current, merge-deterministic
// Does NOT modify production defaults.

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

import { stableSortResults } from './custom-50/sort-results.js';
import { chunkFile } from '../../src/indexer/phases/chunk.js';
import { mergeChunksWithDecisions, mergeChunksDeterministic, shouldMerge } from '../../src/indexer/phases/context.js';
import {
  listCollections, createCollection, deleteBySourceFile,
  upsertPoints, hybridSearch, scroll,
} from '../../src/core/qdrant.js';
import { embedForIndex, embedForSearch, SCHEMA_VERSION } from '../../src/core/embeddings.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../../src/core/config.js';

const __dirname       = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SHARED = resolve(__dirname, 'fixtures/docs');
const FIXTURES_OWN    = resolve(__dirname, 'custom-50/fixtures/docs');
const FIXTURES_ROOT   = resolve(__dirname, 'fixtures');
const QUERIES_PATH    = resolve(__dirname, 'custom-50/queries.json');

const TOP_K        = 10;
const BENCH_WINDOW = 1;
const SKIP_INDEX   = process.env.BENCH_SKIP_INDEX === '1';
const BENCH_RUNS   = Math.max(1, parseInt(process.env.BENCH_RUNS ?? '1') || 1);

// Same 10-file fixture set as custom-50/run-v3.js.
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

// Synthetic hard-boundary fixture: long sections that force sentence-level splitting.
const HARD_BOUNDARY_FILE = { name: 'hard-boundary.md', dir: FIXTURES_ROOT };

// ── Strategies ────────────────────────────────────────────────────────────────

// Per-file LLM call counter. Reset before each file's merge phase.
let _llmCallCount  = 0;
let _llmMergeCount = 0; // times LLM said "merge"
let _llmSplitCount = 0; // times LLM said "split"

async function shouldMergeInstrumented(a, b) {
  _llmCallCount++;
  const decision = await shouldMerge(a, b);
  if (decision) _llmMergeCount++; else _llmSplitCount++;
  return decision;
}

const STRATEGIES = [
  {
    id: 'llm',
    label: 'LLM merge (current)',
    collection: 'merge-llm-current',
    mergeFn: async (chunks) => mergeChunksWithDecisions(chunks, shouldMergeInstrumented),
  },
  {
    id: 'deterministic',
    label: 'Deterministic split+overlap',
    collection: 'merge-deterministic',
    mergeFn: (chunks) => mergeChunksDeterministic(chunks),
  },
];

// ── Schema helpers ────────────────────────────────────────────────────────────

function buildQrels(relevantChunks) {
  const map = new Map();
  for (const rc of (relevantChunks ?? [])) map.set(rc.chunkId, rc.relevance ?? 3);
  return map;
}

function normaliseQuery(q) {
  return {
    id:                    q.id,
    type:                  q.type ?? 'file-level',
    query:                 q.query,
    relevantChunks:        q.relevantChunks ?? [],
    qrels:                 buildQrels(q.relevantChunks),
    shouldHaveNoStrongHit: q.shouldHaveNoStrongHit ?? false,
  };
}

// ── Indexing ──────────────────────────────────────────────────────────────────

async function ensureCollection(collection) {
  const cols = await listCollections();
  if (!cols.includes(collection)) await createCollection(collection, 1024);
  const { denseProvider, denseModel, sparseProvider } = resolveEnvProviders();
  const cfg = loadConfig();
  cfg.collections ??= {};
  cfg.collections[collection] = {
    denseProvider, denseModel, sparseProvider,
    embeddingSchemaVersion: SCHEMA_VERSION,
    vectorSize: 1024,
    description: 'merge-strategy benchmark — auto-managed',
  };
  saveConfig(cfg);
}

async function fetchIndexedChunkIds(collection) {
  const points = await scroll(collection, undefined, 2000, ['source_file', 'chunk_index']);
  const ids = new Set();
  for (const p of points) {
    const sf = p.payload?.source_file;
    const ci = p.payload?.chunk_index;
    if (sf != null && ci != null) ids.add(`${sf}#${ci}`);
  }
  return ids;
}

// Index a set of files with a strategy. Returns detailed timing + chunk stats.
// counters object is shared across files for LLM call totals.
async function indexFiles(files, strategy, counters) {
  const allChunks = [];

  let totalChunkMs       = 0;
  let totalMergeMs       = 0;
  let totalEmbedUpsertMs = 0;
  let totalBoundaryCount = 0;
  let rawChunkCount      = 0;

  for (const { name, dir } of files) {
    const filePath   = resolve(dir, name);
    const text       = readFileSync(filePath, 'utf8');
    const sourceFile = name;

    await deleteBySourceFile(strategy.collection, sourceFile);

    const t0 = performance.now();
    const rawChunks = chunkFile(filePath, text, sourceFile);
    totalChunkMs += performance.now() - t0;

    const boundaryCount = rawChunks.filter(c => c.needsBoundaryCheck).length;
    totalBoundaryCount += boundaryCount;
    rawChunkCount      += rawChunks.length;

    _llmCallCount  = 0;
    _llmMergeCount = 0;
    _llmSplitCount = 0;

    const tm0 = performance.now();
    const mergedChunks = await strategy.mergeFn(rawChunks);
    const mergeElapsed = performance.now() - tm0;
    totalMergeMs += mergeElapsed;

    counters.llmCalls  += _llmCallCount;
    counters.llmMerge  += _llmMergeCount;
    counters.llmSplit  += _llmSplitCount;

    const te0 = performance.now();
    const points = [];
    for (const chunk of mergedChunks) {
      const { dense, sparse, meta } = await embedForIndex(strategy.collection, chunk.text);
      points.push({
        id: randomUUID(),
        vector: { dense, sparse },
        payload: {
          text:         chunk.text,
          section:      chunk.section,
          source_file:  sourceFile,
          chunk_index:  chunk.chunkIndex,
          total_chunks: chunk.totalChunks,
          file_hash:    'merge-bench-v2',
          vector_size:  1024,
          ...meta,
        },
      });
    }
    await upsertPoints(strategy.collection, points);
    totalEmbedUpsertMs += performance.now() - te0;

    const mergeNote = strategy.id === 'llm' && _llmCallCount > 0
      ? ` [LLM: ${_llmCallCount} calls, ${_llmMergeCount} merge, ${_llmSplitCount} split]`
      : '';
    process.stdout.write(
      `    ${name}: ${rawChunks.length} raw (${boundaryCount} boundary) → ${mergedChunks.length} merged` +
      ` (${mergeElapsed.toFixed(0)}ms merge)${mergeNote}\n`
    );
    allChunks.push(...mergedChunks);
  }

  const finalCount = allChunks.length;
  const avgLen = finalCount > 0
    ? Math.round(allChunks.reduce((s, c) => s + c.text.length, 0) / finalCount)
    : 0;

  return {
    rawChunkCount: rawChunkCount,
    chunkCount: finalCount,
    avgLen,
    totalBoundaryCount,
    totalChunkMs,
    totalMergeMs,
    totalEmbedUpsertMs,
    // Measured phases only: chunkMs + mergeMs + embedUpsertMs.
    // Does NOT include readFileSync, deleteBySourceFile, ensureCollection.
    measuredPhaseMs: totalChunkMs + totalMergeMs + totalEmbedUpsertMs,
    finalChunks: allChunks,
  };
}

async function indexWithStrategy(strategy) {
  console.log(`\n  Strategy: ${strategy.label}`);
  await ensureCollection(strategy.collection);

  const counters = { llmCalls: 0, llmMerge: 0, llmSplit: 0 };
  const stats = await indexFiles(FIXTURE_FILES, strategy, counters);
  return { ...stats, ...counters };
}

// ── Qrel safety validation ────────────────────────────────────────────────────

// Verifies every rel>=1 qrel chunkId exists in the strategy's index.
// LLM merge can merge sub-chunks, renumbering chunk_index values, so qrels
// validated against one strategy may not hold for another.
function validateQrelsForStrategy(queries, indexedIds, strategyLabel) {
  const missing = [];
  for (const q of queries) {
    if (q.shouldHaveNoStrongHit) continue;
    for (const rc of q.relevantChunks) {
      if (!indexedIds.has(rc.chunkId)) {
        missing.push({ queryId: q.id, chunkId: rc.chunkId, relevance: rc.relevance });
      }
    }
  }
  if (missing.length > 0) {
    console.warn(`\n  [qrel_missing_after_strategy] ${strategyLabel}: ${missing.length} qrel chunk id(s) not found in index.`);
    console.warn(`  LLM merge renumbers chunks when it merges sub-chunks; qrels may be stale.`);
    for (const m of missing) {
      console.warn(`    [${m.queryId}] "${m.chunkId}" (relevance=${m.relevance})`);
    }
  }
  return missing;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

function resultChunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  if (!sf || ci == null) return null;
  return `${sf}#${ci}`;
}

function chunkRecallHit(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const relevantIds = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!relevantIds.size) return null;
  return results.slice(0, k).some(r => relevantIds.has(resultChunkId(r)));
}

function mrr(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const relevantIds = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!relevantIds.size) return null;
  for (let i = 0; i < Math.min(results.length, k); i++) {
    if (relevantIds.has(resultChunkId(results[i]))) return 1 / (i + 1);
  }
  return 0;
}

function idealDCG(qrels, k) {
  const gains = [...qrels.values()].map(rel => Math.pow(2, rel) - 1).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(gains.length, k); i++) idcg += gains[i] / Math.log2(i + 2);
  return idcg;
}

function gradedNDCG(results, qrels, k) {
  if (!qrels.size) return null;
  let dcg = 0;
  for (let i = 0; i < Math.min(results.length, k); i++) {
    const cid = resultChunkId(results[i]);
    const rel = cid ? (qrels.get(cid) ?? 0) : 0;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  const idcg = idealDCG(qrels, k);
  return idcg === 0 ? 0 : dcg / idcg;
}

function parseChunkId(chunkId) {
  if (!chunkId) return null;
  const hash = chunkId.lastIndexOf('#');
  if (hash < 0) return null;
  const sourceFile  = chunkId.slice(0, hash);
  const chunkIndex  = parseInt(chunkId.slice(hash + 1), 10);
  if (!sourceFile || !Number.isFinite(chunkIndex)) return null;
  return { sourceFile, chunkIndex };
}

function windowRecallHit(results, qrels, k, window) {
  if (!qrels.size) return null;
  const exactIds = [...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id);
  if (!exactIds.length) return null;
  const topK = results.slice(0, k);
  if (topK.some(r => { const cid = resultChunkId(r); return cid && qrels.get(cid) >= 3; })) return true;
  for (const exactId of exactIds) {
    const ep = parseChunkId(exactId);
    if (!ep) continue;
    if (topK.some(r => {
      const rp = parseChunkId(resultChunkId(r));
      return rp && rp.sourceFile === ep.sourceFile && Math.abs(rp.chunkIndex - ep.chunkIndex) <= window;
    })) return true;
  }
  return false;
}

// ── Aggregate metrics ─────────────────────────────────────────────────────────

function computeMetrics(queryResults) {
  const positives = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
  const hasExact  = positives.filter(r => [...r.query.qrels.values()].some(v => v >= 3)).length;
  let cr5 = 0, wr5 = 0, mrrSum = 0, mrrCount = 0, ndcgSum = 0, ndcgCount = 0;
  for (const r of positives) {
    const cr5h  = chunkRecallHit(r.results, r.query.qrels, 5, 3);
    const wr5h  = windowRecallHit(r.results, r.query.qrels, 5, BENCH_WINDOW);
    const mrrV  = mrr(r.results, r.query.qrels, 10, 3);
    const ndcgV = gradedNDCG(r.results, r.query.qrels, TOP_K);
    if (cr5h  !== null) cr5  += cr5h ? 1 : 0;
    if (wr5h  !== null) wr5  += wr5h ? 1 : 0;
    if (mrrV  !== null) { mrrSum  += mrrV;  mrrCount++;  }
    if (ndcgV !== null) { ndcgSum += ndcgV; ndcgCount++; }
  }
  return {
    chunkRecall5:  hasExact > 0  ? cr5     / hasExact  : null,
    windowRecall5: hasExact > 0  ? wr5     / hasExact  : null,
    mrr10:         mrrCount > 0  ? mrrSum  / mrrCount  : null,
    ndcg10:        ndcgCount > 0 ? ndcgSum / ndcgCount : null,
    nPositive: positives.length,
  };
}

// ── Diff helpers ──────────────────────────────────────────────────────────────

function top5Ids(results) {
  return results.slice(0, 5).map(resultChunkId).filter(Boolean);
}

function classifyChange(llmResults, detResults, query) {
  const qrels = query.qrels;
  const llmCr5 = chunkRecallHit(llmResults, qrels, 5, 3);
  const detCr5 = chunkRecallHit(detResults, qrels, 5, 3);
  if (llmCr5 && !detCr5) return 'REGRESSION';
  if (!llmCr5 && detCr5) return 'IMPROVEMENT';
  return 'NEUTRAL_REORDER';
}

// ── Query execution ───────────────────────────────────────────────────────────

async function runQueriesOnCollection(collection, queries) {
  const results = [];
  for (const query of queries) {
    const latencies = [];
    let lastResults = [];
    for (let run = 0; run < BENCH_RUNS; run++) {
      const { dense, sparse } = await embedForSearch(collection, query.query);
      const t0 = performance.now();
      const raw = await hybridSearch(collection, dense, sparse, TOP_K);
      latencies.push(performance.now() - t0);
      lastResults = stableSortResults(raw);
    }
    results.push({
      query,
      results: lastResults,
      latency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    });
  }
  return results;
}

// ── Hard-boundary diagnostic (no quality claims) ──────────────────────────────

async function runHardBoundaryDiagnostic() {
  console.log('\n[hard-boundary] Diagnostic on synthetic long-section fixture...');
  const { name, dir } = HARD_BOUNDARY_FILE;
  const filePath   = resolve(dir, name);
  const text       = readFileSync(filePath, 'utf8');
  const sourceFile = name;

  const rawChunks = chunkFile(filePath, text, sourceFile);
  const boundaryCount = rawChunks.filter(c => c.needsBoundaryCheck).length;
  console.log(`  Raw chunks: ${rawChunks.length}  Boundary (needsBoundaryCheck): ${boundaryCount}`);
  console.log(`  Sections with splits:`);
  for (const c of rawChunks.filter(c => c.needsBoundaryCheck)) {
    console.log(`    #${c.chunkIndex} section="${c.section}" len=${c.text.length}`);
  }

  // Run LLM strategy.
  _llmCallCount = 0; _llmMergeCount = 0; _llmSplitCount = 0;
  const tm0 = performance.now();
  const llmChunks = await mergeChunksWithDecisions(rawChunks, shouldMergeInstrumented);
  const llmMs = performance.now() - tm0;
  const llmCalls = _llmCallCount;
  const llmMerge = _llmMergeCount;
  const llmSplit = _llmSplitCount;

  // Run deterministic strategy.
  const td0 = performance.now();
  const detChunks = await mergeChunksDeterministic(rawChunks);
  const detMs = performance.now() - td0;

  // Compare chunk text identity.
  const identical = llmChunks.length === detChunks.length &&
    llmChunks.every((c, i) => c.text === detChunks[i]?.text);

  console.log(`\n  LLM merge:     ${rawChunks.length} raw → ${llmChunks.length} final (${llmMs.toFixed(0)}ms merge)`);
  console.log(`    LLM calls: ${llmCalls}  merge decisions: ${llmMerge}  split decisions: ${llmSplit}`);
  console.log(`  Deterministic: ${rawChunks.length} raw → ${detChunks.length} final (${detMs.toFixed(1)}ms merge)`);
  console.log(`  Chunk text identical: ${identical}`);

  // If strategies differ, show sample boundaries where LLM merged.
  const mergeSamples = [];
  if (!identical && llmMerge > 0) {
    console.log(`\n  Sample boundaries where LLM chose merge (showing up to 2):`);
    let shown = 0;
    for (let i = 0; i < rawChunks.length && shown < 2; i++) {
      const c = rawChunks[i];
      if (!c.needsBoundaryCheck) continue;
      // Check if this boundary was merged: the corresponding index in llmChunks would be absent.
      // We detect merges by comparing chunk counts per section.
      const prev = rawChunks[i - 1];
      const sectionA = `${prev?.source_file}|${prev?.section}`;
      const sectionB = `${c.source_file}|${c.section}`;
      if (sectionA !== sectionB) continue;
      // Try to detect: if llmChunks has fewer chunks from this section than detChunks, a merge happened.
      const llmSection = llmChunks.filter(x => x.section === c.section).length;
      const detSection = detChunks.filter(x => x.section === c.section).length;
      if (llmSection < detSection) {
        console.log(`    Section "${c.section}" — LLM merged boundary #${i}:`);
        console.log(`      prev end: ...${prev?.text.slice(-80).replace(/\n/g,' ')}`);
        console.log(`      curr start: ${c.text.slice(0,80).replace(/\n/g,' ')}...`);
        mergeSamples.push({ section: c.section, boundary: i });
        shown++;
      }
    }
    if (shown === 0) {
      console.log(`    (merge detection inconclusive — chunk texts differ but section counts match)`);
    }
  }

  return {
    rawChunks: rawChunks.length,
    boundaryCount,
    llm: { finalChunks: llmChunks.length, mergeMs: llmMs, llmCalls, llmMerge, llmSplit },
    det: { finalChunks: detChunks.length, mergeMs: detMs },
    identical,
    mergeSamples,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function pct(v) { return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`; }
function ms(v)  { return v == null ? 'n/a' : `${Math.round(v)}ms`; }

function printQualityTable(llmM, detM) {
  const delta = (a, b) => {
    if (a === null || b === null) return 'n/a';
    const d = (b - a) * 100;
    return (d >= 0 ? '+' : '') + d.toFixed(1) + 'pp';
  };
  const fmtRow = (label, av, bv) => {
    const as = pct(av); const bs = pct(bv);
    const ds = typeof av === 'number' && typeof bv === 'number' ? delta(av, bv) : 'n/a';
    return `│ ${label.padEnd(19)} │ ${as.padEnd(13)} │ ${bs.padEnd(13)} │ ${ds.padEnd(12)} │`;
  };
  const fmtRowRaw = (label, av, bv) => {
    const as = av != null ? av.toFixed(3) : 'n/a';
    const bs = bv != null ? bv.toFixed(3) : 'n/a';
    const ds = typeof av === 'number' && typeof bv === 'number' ? delta(av, bv) : 'n/a';
    return `│ ${label.padEnd(19)} │ ${as.padEnd(13)} │ ${bs.padEnd(13)} │ ${ds.padEnd(12)} │`;
  };
  console.log('\n┌─────────────────────┬───────────────┬───────────────┬──────────────┐');
  console.log('│ Quality metric      │ LLM merge     │ Deterministic │ Δ (det−llm)  │');
  console.log('├─────────────────────┼───────────────┼───────────────┼──────────────┤');
  console.log(fmtRow('chunkRecall@5',   llmM.chunkRecall5,  detM.chunkRecall5));
  console.log(fmtRow('windowRecall@5',  llmM.windowRecall5, detM.windowRecall5));
  console.log(fmtRowRaw('MRR@10',       llmM.mrr10,         detM.mrr10));
  console.log(fmtRowRaw('nDCG@10',      llmM.ndcg10,        detM.ndcg10));
  console.log('└─────────────────────┴───────────────┴───────────────┴──────────────┘');
}

function printCostTable(llmStat, detStat) {
  const col = (v, w) => String(v ?? 'n/a').padEnd(w);
  console.log('\n┌─────────────────────┬───────────────┬───────────────┐');
  console.log('│ Cost metric         │ LLM merge     │ Deterministic │');
  console.log('├─────────────────────┼───────────────┼───────────────┤');
  const row = (label, a, b) => `│ ${label.padEnd(19)} │ ${col(a,13)} │ ${col(b,13)} │`;
  console.log(row('raw chunks',       llmStat.rawChunkCount ?? 'n/a', detStat.rawChunkCount ?? 'n/a'));
  console.log(row('final chunks',     llmStat.chunkCount,           detStat.chunkCount));
  console.log(row('raw boundary chks', llmStat.totalBoundaryCount,  detStat.totalBoundaryCount));
  console.log(row('avg chunk len',    llmStat.avgLen ?? 'n/a',       detStat.avgLen ?? 'n/a'));
  console.log(row('LLM calls',        llmStat.llmCalls,             0));
  console.log(row('LLM merge/split',  `${llmStat.llmMerge}/${llmStat.llmSplit}`, 'n/a'));
  console.log(row('chunkMs',          ms(llmStat.totalChunkMs),     ms(detStat.totalChunkMs)));
  console.log(row('mergeMs',          ms(llmStat.totalMergeMs),     ms(detStat.totalMergeMs)));
  console.log(row('embedUpsertMs',    ms(llmStat.totalEmbedUpsertMs), ms(detStat.totalEmbedUpsertMs)));
  console.log(row('measuredPhaseMs',  ms(llmStat.measuredPhaseMs),  ms(detStat.measuredPhaseMs)));
  console.log('└─────────────────────┴───────────────┴───────────────┘');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.env.ONNX_EMBED = '1';

  const raw     = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const queries = raw.queries.map(normaliseQuery);
  const positives = queries.filter(q => !q.shouldHaveNoStrongHit);

  const { denseProvider, sparseProvider } = resolveEnvProviders();

  console.log('\n=== semidex merge-strategy benchmark v2 ===');
  console.log(`Provider  : ${denseProvider}/${sparseProvider}`);
  console.log(`Top-K     : ${TOP_K}  Window: ±${BENCH_WINDOW}`);
  console.log(`Queries   : ${queries.length} (${positives.length} positive, ${queries.filter(q => q.shouldHaveNoStrongHit).length} negative)`);
  console.log(`Retrieval runs: ${BENCH_RUNS}`);

  // ── Phase 1: custom-50 indexing ───────────────────────────────────────────

  const indexStats = {};

  if (SKIP_INDEX) {
    console.log('\n[phase1/index] BENCH_SKIP_INDEX=1 — reusing existing collections');
    for (const strategy of STRATEGIES) {
      const ids = await fetchIndexedChunkIds(strategy.collection);
      if (!ids.size) {
        console.error(`Error: no points in "${strategy.collection}". Re-run without BENCH_SKIP_INDEX=1.`);
        process.exit(1);
      }
      indexStats[strategy.id] = {
        rawChunkCount: null, chunkCount: ids.size, avgLen: null, totalBoundaryCount: null,
        totalChunkMs: null, totalMergeMs: null, totalEmbedUpsertMs: null, measuredPhaseMs: null,
        llmCalls: null, llmMerge: null, llmSplit: null,
      };
      console.log(`  ${strategy.collection}: ${ids.size} indexed chunks (from scroll)`);
    }
  } else {
    console.log('\n[phase1/index] Indexing custom-50 fixture corpus with each strategy...');
    for (const strategy of STRATEGIES) {
      await ensureCollection(strategy.collection);
      const counters = { llmCalls: 0, llmMerge: 0, llmSplit: 0 };
      const stats = await indexFiles(FIXTURE_FILES, strategy, counters);
      indexStats[strategy.id] = { ...stats, ...counters };
    }
  }

  // ── Phase 1: qrel safety validation ──────────────────────────────────────

  console.log('\n[phase1/qrel] Validating qrels against each collection...');
  const qrelResults = {};
  for (const strategy of STRATEGIES) {
    const ids = await fetchIndexedChunkIds(strategy.collection);
    const missing = validateQrelsForStrategy(queries, ids, strategy.label);
    qrelResults[strategy.id] = { missing, indexedCount: ids.size };
    if (missing.length === 0) {
      console.log(`  ${strategy.label}: all qrels valid (${ids.size} chunks indexed)`);
    }
  }

  // ── Phase 1: quality benchmark ────────────────────────────────────────────

  console.log('\n[phase1/query] Running custom-50 queries...');
  const queryResultsByStrategy = {};
  for (const strategy of STRATEGIES) {
    process.stdout.write(`  ${strategy.label}... `);
    queryResultsByStrategy[strategy.id] = await runQueriesOnCollection(strategy.collection, queries);
    console.log('done');
  }

  const llmMetrics = computeMetrics(queryResultsByStrategy['llm']);
  const detMetrics = computeMetrics(queryResultsByStrategy['deterministic']);

  printQualityTable(llmMetrics, detMetrics);
  printCostTable(indexStats['llm'], indexStats['deterministic']);

  // Per-query diff.
  const llmQR = queryResultsByStrategy['llm'];
  const detQR = queryResultsByStrategy['deterministic'];
  const changed = [], regressions = [], improvements = [], neutralChange = [];
  for (const q of positives) {
    const llmRow = llmQR.find(r => r.query.id === q.id);
    const detRow = detQR.find(r => r.query.id === q.id);
    if (!llmRow || !detRow) continue;
    const llmTop = top5Ids(llmRow.results);
    const detTop = top5Ids(detRow.results);
    if (JSON.stringify(llmTop) === JSON.stringify(detTop)) continue;
    const verdict = classifyChange(llmRow.results, detRow.results, q);
    const entry = { query: q, llmRow, detRow, verdict };
    changed.push(entry);
    if (verdict === 'REGRESSION')      regressions.push(entry);
    else if (verdict === 'IMPROVEMENT') improvements.push(entry);
    else                                neutralChange.push(entry);
  }

  console.log(`\nChanged queries (top-5 differs): ${changed.length} / ${positives.length}`);
  console.log(`  Regressions (det worse @5): ${regressions.length}`);
  console.log(`  Improvements (det better @5): ${improvements.length}`);
  console.log(`  Neutral reorders: ${neutralChange.length}`);

  for (const { query, llmRow, detRow } of regressions) {
    console.log(`\n  REGRESSION [${query.id}] ${query.query.slice(0, 60)}`);
    console.log(`    LLM top-5: ${top5Ids(llmRow.results).join(', ')}`);
    console.log(`    Det top-5: ${top5Ids(detRow.results).join(', ')}`);
  }
  for (const { query, llmRow, detRow } of improvements) {
    console.log(`\n  IMPROVEMENT [${query.id}] ${query.query.slice(0, 60)}`);
    console.log(`    LLM top-5: ${top5Ids(llmRow.results).join(', ')}`);
    console.log(`    Det top-5: ${top5Ids(detRow.results).join(', ')}`);
  }

  // ── Phase 2: hard-boundary diagnostic ────────────────────────────────────

  const hbDiag = await runHardBoundaryDiagnostic();

  // ── Final summary ─────────────────────────────────────────────────────────

  const summary = {
    provider: `${denseProvider}/${sparseProvider}`,
    topK: TOP_K, window: BENCH_WINDOW, benchRuns: BENCH_RUNS,
    custom50: {
      queries: queries.length, positives: positives.length,
      qrelMissingLlm: qrelResults['llm'].missing.length,
      qrelMissingDet: qrelResults['deterministic'].missing.length,
      llm: { ...llmMetrics, ...indexStats['llm'] },
      det: { ...detMetrics, ...indexStats['deterministic'] },
      changed: changed.length, regressions: regressions.length,
      improvements: improvements.length, neutralChange: neutralChange.length,
      regressionDetails: regressions.map(c => ({
        id: c.query.id, query: c.query.query,
        llmTop5: top5Ids(c.llmRow.results), detTop5: top5Ids(c.detRow.results),
      })),
    },
    hardBoundary: hbDiag,
  };

  console.log('\n--- JSON summary ---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
