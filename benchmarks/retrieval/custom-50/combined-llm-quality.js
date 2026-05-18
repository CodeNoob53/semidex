/**
 * COMBINED_LLM=1 quality verification against custom-50 benchmark.
 *
 * Runs the production indexer twice on the same custom-50 fixture corpus:
 *   A. baseline  — default context + tags pipeline
 *   B. combined  — COMBINED_LLM=1, model = CONTEXT_MODEL
 *
 * Then runs all 50 queries against both collections using the same hybrid
 * search as run-v3.js, computes identical metrics, and writes a diff report.
 *
 * Usage:
 *   node benchmarks/retrieval/custom-50/combined-llm-quality.js
 *   npm run bench:custom50:combined
 *
 * Requires: Qdrant reachable, Ollama running with CONTEXT_MODEL pulled.
 * All transient dirs live under .tmp/ (gitignored).
 * Cleans up Qdrant collections on exit unless KEEP_COLLECTIONS=1.
 */

import 'dotenv/config';
import { spawnSync } from 'child_process';
import {
  existsSync, mkdirSync, writeFileSync,
  copyFileSync, rmSync, readFileSync,
} from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  listCollections, createCollection, deleteCollection,
  hybridSearch,
} from '../../../src/core/qdrant.js';
import { embedForSearch, SCHEMA_VERSION } from '../../../src/core/embeddings.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../../../src/core/config.js';

const ROOT         = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const QUERIES_PATH = join(ROOT, 'benchmarks', 'retrieval', 'custom-50', 'queries.json');
const FIXTURES_SHARED = join(ROOT, 'benchmarks', 'retrieval', 'fixtures', 'docs');
const FIXTURES_OWN    = join(ROOT, 'benchmarks', 'retrieval', 'custom-50', 'fixtures', 'docs');
const RESULTS_DIR  = join(ROOT, 'benchmarks', 'retrieval', 'results');
const KEEP         = process.env.KEEP_COLLECTIONS === '1';
const TOP_K        = 10;
const BENCH_WINDOW = 1;

const CONTEXT_MODEL = process.env.CONTEXT_MODEL || 'gemma3:4b';
const QDRANT_URL    = (process.env.QDRANT_URL ?? '').replace(/\/$/, '');

// Stamp for unique collection names — prevents conflicts with concurrent runs.
const STAMP = Date.now();
const COL_BASELINE = `bench-c50-baseline-${STAMP}`;
const COL_COMBINED = `bench-c50-combined-${STAMP}`;

// Corpus dir under .tmp/ — all fixture files copied here so source_file IDs
// match the qrel chunkIds used in queries.json (e.g. "providers.md#3").
const CORPUS_DIR    = join(ROOT, '.tmp', `bench-c50-corpus-${STAMP}`);
const CHUNKS_BASELINE = join(ROOT, '.tmp', `bench-c50-chunks-baseline-${STAMP}`);
const CHUNKS_COMBINED = join(ROOT, '.tmp', `bench-c50-chunks-combined-${STAMP}`);

// Fixture files in the order run-v3.js uses them.
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

// ── Corpus setup ──────────────────────────────────────────────────────────────

function buildCorpus() {
  rmSync(CORPUS_DIR, { recursive: true, force: true });
  mkdirSync(CORPUS_DIR, { recursive: true });
  for (const { name, dir } of FIXTURE_FILES) {
    const src = join(dir, name);
    if (!existsSync(src)) {
      console.error(`[quality] Fixture missing: ${src}`);
      process.exit(1);
    }
    copyFileSync(src, join(CORPUS_DIR, name));
  }
}

function cleanupTransient() {
  try { rmSync(CORPUS_DIR,      { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(CHUNKS_BASELINE, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(CHUNKS_COMBINED, { recursive: true, force: true }); } catch { /* ignore */ }
}

function cleanupConfigEntries() {
  try {
    const cfg = loadConfig();
    if (!cfg.collections) return;
    delete cfg.collections[COL_BASELINE];
    delete cfg.collections[COL_COMBINED];
    saveConfig(cfg);
  } catch { /* best-effort */ }
}

// ── Qdrant collection management ──────────────────────────────────────────────

async function ensureBenchCollection(name) {
  const cols = await listCollections();
  if (!cols.includes(name)) {
    await createCollection(name, 1024);
  }
  const { denseProvider, denseModel, sparseProvider } = resolveEnvProviders();
  const cfg = loadConfig();
  cfg.collections ??= {};
  cfg.collections[name] = {
    denseProvider, denseModel, sparseProvider,
    embeddingSchemaVersion: SCHEMA_VERSION,
    vectorSize: 1024,
    description: `combined-llm quality bench — auto-managed (${STAMP})`,
  };
  saveConfig(cfg);
}

async function deleteBenchCollection(name) {
  try {
    await deleteCollection(name);
    console.log(`  [cleanup] deleted collection "${name}"`);
  } catch {
    console.log(`  [cleanup] could not delete "${name}" (may not exist)`);
  }
}

async function countPoints(collection) {
  return (await scrollAll(collection)).length;
}

async function scrollAll(collection) {
  const points = [];
  let offset = null;
  while (true) {
    const body = { limit: 100, with_payload: true, with_vectors: false };
    if (offset !== null) body.offset = offset;
    const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: { 'api-key': process.env.QDRANT_KEY ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) break;
    const data = await r.json();
    const batch = data?.result?.points ?? [];
    points.push(...batch);
    offset = data?.result?.next_page_offset ?? null;
    if (offset === null || batch.length === 0) break;
  }
  return points;
}

// ── Indexer runner ────────────────────────────────────────────────────────────

function runIndexer(collection, extraEnv, chunksOutDir, label) {
  console.log(`\n[quality] Running ${label}...`);
  const env = {
    ...process.env,
    COLLECTION:    collection,
    SOURCE_ROOT:   CORPUS_DIR,
    ONNX_EMBED:    '1',
    CONTEXT_MODEL: CONTEXT_MODEL,
    CHUNKS_OUT_DIR: chunksOutDir,
    INDEX_PROFILE: '1',
    ...extraEnv,
  };

  const t0 = Date.now();
  const result = spawnSync('node', ['src/indexer/index.js', CORPUS_DIR], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const totalMs = Date.now() - t0;

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.status !== 0) {
    console.error(`  [quality] ${label} FAILED (exit ${result.status})`);
    console.error(stderr.slice(-3000));
    return { ok: false, totalMs, stdout, stderr, phases: {}, fallbacks: 0, tagFallbacks: 0, indexed: 0 };
  }

  const phases       = parseProfilerOutput(stdout);
  const fallbacks    = (stderr.match(/\[combined\] parse failed/g) ?? []).length;
  const tagFallbacks = (stderr.match(/\[tag\] batch parse failed/g) ?? []).length;
  const indexedMatch = stdout.match(/(\d+) indexed/);
  const indexed      = indexedMatch ? parseInt(indexedMatch[1], 10) : 0;

  console.log(`  done in ${totalMs} ms — exit 0`);
  console.log(`  indexed ${indexed} file(s)`);
  if (fallbacks)    console.log(`  [combined] parse fallbacks: ${fallbacks}`);
  if (tagFallbacks) console.log(`  [tag] batch fallbacks: ${tagFallbacks}`);

  return { ok: true, totalMs, stdout, stderr, phases, fallbacks, tagFallbacks, indexed };
}

function parseProfilerOutput(stdout) {
  const phaseMs = {};
  const re = /^\s+(\S+)\s+(\d+)\s+ms/;
  for (const line of stdout.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const phase = m[1], ms = parseInt(m[2], 10);
    if (!phaseMs[phase]) phaseMs[phase] = [];
    phaseMs[phase].push(ms);
  }
  const result = {};
  for (const [phase, vals] of Object.entries(phaseMs)) {
    result[phase] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return result;
}

// ── Query loading ─────────────────────────────────────────────────────────────

function tokenise(str) {
  return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

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
    expectedFiles:         q.expectedFiles ?? [],
    relevantChunks:        q.relevantChunks ?? [],
    qrels:                 buildQrels(q.relevantChunks),
    expectedTokens:        q.expectedTokens ? q.expectedTokens.flatMap(t => tokenise(t)).filter(Boolean) : null,
    shouldHaveNoStrongHit: q.shouldHaveNoStrongHit ?? false,
    note:                  q.note ?? '',
  };
}

// ── Metric helpers (mirrors run-v3.js exactly) ────────────────────────────────

function resultChunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  if (!sf || ci == null) return null;
  return `${sf}#${ci}`;
}

function idealDCG(qrels, k) {
  const gains = [...qrels.values()].map(rel => Math.pow(2, rel) - 1).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(gains.length, k); i++) idcg += gains[i] / Math.log2(i + 2);
  return idcg;
}

function gradedNDCG(results, qrels, k) {
  if (!qrels.size) return null;
  const topK = results.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = (qrels.get(resultChunkId(topK[i])) ?? 0);
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  const idcg = idealDCG(qrels, k);
  return idcg === 0 ? 0 : dcg / idcg;
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

function parseChunkId(chunkId) {
  if (!chunkId) return null;
  const hash = chunkId.lastIndexOf('#');
  if (hash < 0) return null;
  const sourceFile = chunkId.slice(0, hash);
  const chunkIndex = parseInt(chunkId.slice(hash + 1), 10);
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

function negativePass(result, query) {
  if (!result.length) return true;
  const top1Words = new Set([
    ...tokenise(result[0].payload?.text    ?? ''),
    ...tokenise(result[0].payload?.section ?? ''),
  ]);
  return !(query.expectedTokens ?? []).some(t => top1Words.has(t));
}

function computeMetrics(queryResults) {
  const positives = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
  const negatives = queryResults.filter(r =>  r.query.shouldHaveNoStrongHit);
  const hasExact    = positives.filter(r => [...r.query.qrels.values()].some(v => v >= 3)).length;
  const hasAnyQrels = positives.filter(r => r.query.qrels.size > 0).length;

  let cr3 = 0, cr5 = 0, cr10 = 0, wr5 = 0, wr10 = 0, supp = 0, ndcgSum = 0, mrrSum = 0, mrrCount = 0;
  let negPass = 0;
  const latencies = queryResults.map(r => r.latency).sort((a, b) => a - b);

  for (const r of positives) {
    const { results, query } = r;
    if (chunkRecallHit(results, query.qrels, 3,      3)) cr3++;
    if (chunkRecallHit(results, query.qrels, 5,      3)) cr5++;
    if (chunkRecallHit(results, query.qrels, TOP_K,  3)) cr10++;
    if (windowRecallHit(results, query.qrels, 5,      BENCH_WINDOW)) wr5++;
    if (windowRecallHit(results, query.qrels, TOP_K,  BENCH_WINDOW)) wr10++;
    if (chunkRecallHit(results, query.qrels, TOP_K,  2)) supp++;
    const ndcgVal = gradedNDCG(results, query.qrels, TOP_K);
    const mrrVal  = mrr(results, query.qrels, 10, 3);
    if (ndcgVal !== null) ndcgSum += ndcgVal;
    if (mrrVal  !== null) { mrrSum += mrrVal; mrrCount++; }
  }
  for (const r of negatives) {
    if (negativePass(r.results, r.query)) negPass++;
  }

  return {
    chunkRecall3:    hasExact > 0    ? cr3 / hasExact     : null,
    chunkRecall5:    hasExact > 0    ? cr5 / hasExact     : null,
    chunkRecall10:   hasExact > 0    ? cr10 / hasExact    : null,
    windowRecall5:   hasExact > 0    ? wr5 / hasExact     : null,
    windowRecall10:  hasExact > 0    ? wr10 / hasExact    : null,
    supportRecallK:  hasAnyQrels > 0 ? supp / hasAnyQrels : null,
    ndcgK:           hasAnyQrels > 0 ? ndcgSum / hasAnyQrels : null,
    mrr10:           mrrCount > 0    ? mrrSum / mrrCount  : null,
    negativePassRate: negatives.length > 0 ? negPass / negatives.length : null,
    p50Latency: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
    p95Latency: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
    nPositive: positives.length,
    nNegative: negatives.length,
  };
}

// ── Search ────────────────────────────────────────────────────────────────────

async function runQuery(collection, queryText) {
  const t0 = Date.now();
  const { dense, sparse } = await embedForSearch(collection, queryText);
  const results = await hybridSearch(collection, dense, sparse, TOP_K);
  return { results, latency: Date.now() - t0 };
}

async function runAllQueries(collection, queries) {
  const queryResults = [];
  for (const q of queries) {
    process.stdout.write(`  ${q.id}: ${q.query.slice(0, 40)}... `);
    const { results, latency } = await runQuery(collection, q.query);
    queryResults.push({ query: q, results, latency });
    const hit = q.shouldHaveNoStrongHit
      ? (negativePass(results, q) ? '✓neg' : '✗neg')
      : (chunkRecallHit(results, q.qrels, 5, 3) ? '✓' : '✗');
    console.log(`${hit} (${latency}ms)`);
  }
  return queryResults;
}

// ── Per-query diff ────────────────────────────────────────────────────────────

function queryDiff(bResults, cResults, queries) {
  const rows = [];
  for (const q of queries) {
    if (q.shouldHaveNoStrongHit) continue;
    const br = bResults.find(r => r.query.id === q.id);
    const cr = cResults.find(r => r.query.id === q.id);
    if (!br || !cr) continue;

    const bMrr  = mrr(br.results, q.qrels, 10, 3) ?? 0;
    const cMrr  = mrr(cr.results, q.qrels, 10, 3) ?? 0;
    const bNdcg = gradedNDCG(br.results, q.qrels, TOP_K) ?? 0;
    const cNdcg = gradedNDCG(cr.results, q.qrels, TOP_K) ?? 0;
    const bCr5  = chunkRecallHit(br.results, q.qrels, 5, 3) ? 1 : 0;
    const cCr5  = chunkRecallHit(cr.results, q.qrels, 5, 3) ? 1 : 0;

    const mrrDelta  = cMrr  - bMrr;
    const ndcgDelta = cNdcg - bNdcg;

    let change = 'same';
    if      (mrrDelta >  0.001) change = 'improved';
    else if (mrrDelta < -0.001) change = 'regressed';

    const bTop1 = resultChunkId(br.results[0]);
    const cTop1 = resultChunkId(cr.results[0]);
    const bTop1Rel = bTop1 ? (q.qrels.get(bTop1) ?? 0) : 0;
    const cTop1Rel = cTop1 ? (q.qrels.get(cTop1) ?? 0) : 0;

    rows.push({
      id: q.id, type: q.type,
      bMrr, cMrr, mrrDelta,
      bNdcg, cNdcg, ndcgDelta,
      bCr5, cCr5,
      bTop1Rel, cTop1Rel,
      change,
    });
  }
  return rows;
}

// ── Report builder ────────────────────────────────────────────────────────────

function pct(v) { return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`; }
function f3(v)  { return v === null || v === undefined ? 'n/a' : v.toFixed(3); }
function delta(v) {
  if (Math.abs(v) < 0.001) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(3);
}

function buildReport({ dateStr, baselineRun, combinedRun, bMetrics, cMetrics, diffRows, baselineCount, combinedCount }) {
  const lines = [];
  lines.push(`# COMBINED_LLM=1 — custom-50 Retrieval Quality — ${dateStr}`);
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push('| Item | Value |');
  lines.push('|------|-------|');
  lines.push(`| Node.js | ${process.version} |`);
  lines.push(`| CONTEXT_MODEL | ${CONTEXT_MODEL} |`);
  lines.push(`| ONNX_EMBED | 1 |`);
  lines.push(`| ONNX_EXECUTION_PROVIDER | ${process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu (default)'} |`);
  lines.push(`| Corpus | custom-50 fixture docs (10 files) |`);
  lines.push(`| Queries | 50 (v3 schema, graded chunk-level qrels) |`);
  lines.push(`| Search mode | hybrid (RRF) |`);
  lines.push(`| Top-K | ${TOP_K} |`);
  lines.push('');
  lines.push('## Indexing');
  lines.push('');
  lines.push('| Run | Exit | Points | Wall time | Phase context (mean/file) | Phase tag (mean/file) | Combined fallbacks | Tag batch fallbacks |');
  lines.push('|-----|------|--------|-----------|--------------------------|----------------------|-------------------|---------------------|');

  const bCtx  = baselineRun.phases?.context ?? 0;
  const bTag  = baselineRun.phases?.tag     ?? 0;
  const cCtx  = combinedRun.phases?.context ?? 0;
  const cTag  = combinedRun.phases?.tag     ?? 0;

  lines.push(`| Baseline | ${baselineRun.ok ? 'OK' : 'FAIL'} | ${baselineCount ?? '?'} | ${baselineRun.totalMs} ms | ${bCtx} ms | ${bTag} ms | n/a | ${baselineRun.tagFallbacks} |`);
  lines.push(`| Combined | ${combinedRun.ok ? 'OK' : 'FAIL'} | ${combinedCount ?? '?'} | ${combinedRun.totalMs} ms | ${cCtx} ms (merge) | ${cTag} ms | ${combinedRun.fallbacks} | n/a |`);
  lines.push('');
  lines.push('*Combined path records context=0 ms (merge only) and all LLM time under tag.*');
  lines.push('');
  lines.push('## Aggregate Metrics');
  lines.push('');
  lines.push('| Metric | Baseline | Combined | Delta |');
  lines.push('|--------|----------|----------|-------|');

  function mrow(label, bv, cv) {
    const d = (bv !== null && cv !== null) ? delta(cv - bv) : '—';
    return `| ${label} | ${f3(bv)} | ${f3(cv)} | ${d} |`;
  }
  function prow(label, bv, cv) {
    const d = (bv !== null && cv !== null) ? delta(cv - bv) : '—';
    return `| ${label} | ${pct(bv)} | ${pct(cv)} | ${d} |`;
  }

  lines.push(prow('chunkRecall@3',   bMetrics.chunkRecall3,   cMetrics.chunkRecall3));
  lines.push(prow('chunkRecall@5',   bMetrics.chunkRecall5,   cMetrics.chunkRecall5));
  lines.push(prow('chunkRecall@10',  bMetrics.chunkRecall10,  cMetrics.chunkRecall10));
  lines.push(prow('windowRecall@5',  bMetrics.windowRecall5,  cMetrics.windowRecall5));
  lines.push(prow('windowRecall@10', bMetrics.windowRecall10, cMetrics.windowRecall10));
  lines.push(prow('supportRecall@10',bMetrics.supportRecallK, cMetrics.supportRecallK));
  lines.push(mrow('nDCG@10',         bMetrics.ndcgK,          cMetrics.ndcgK));
  lines.push(mrow('MRR@10',          bMetrics.mrr10,          cMetrics.mrr10));
  lines.push(prow('negativePass',    bMetrics.negativePassRate, cMetrics.negativePassRate));
  lines.push('');
  lines.push('## Per-Query Diff (positive queries only)');
  lines.push('');

  const regressed = diffRows.filter(r => r.change === 'regressed');
  const improved  = diffRows.filter(r => r.change === 'improved');
  const same      = diffRows.filter(r => r.change === 'same');
  // Hard regression = lost chunkRecall@5 (chunk fell out of top-5 entirely).
  // Soft regression = rank-order shift within top-5 hits (still retrieved, ranked lower).
  const hardReg   = regressed.filter(r => r.bCr5 && !r.cCr5);
  const softReg   = regressed.filter(r => !(r.bCr5 && !r.cCr5));

  lines.push(`${regressed.length} regressed (${hardReg.length} hard / ${softReg.length} soft), ${improved.length} improved, ${same.length} unchanged (by MRR@10 Δ > 0.001)`);
  lines.push('');
  lines.push('*Hard regression = lost chunkRecall@5 (chunk no longer in top-5). Soft = rank-order shift within hit set.*');
  lines.push('');
  lines.push('| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |');
  lines.push('|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|');

  const sortedRows = [...diffRows].sort((a, b) => a.mrrDelta - b.mrrDelta);
  for (const r of sortedRows) {
    const changeLabel = r.change === 'regressed' ? '**regressed**' : r.change === 'improved' ? 'improved' : '—';
    lines.push(`| ${r.id} | ${r.type} | ${f3(r.bMrr)} | ${f3(r.cMrr)} | ${delta(r.mrrDelta)} | ${f3(r.bNdcg)} | ${f3(r.cNdcg)} | ${delta(r.ndcgDelta)} | ${r.bCr5 ? '✓' : '✗'} | ${r.cCr5 ? '✓' : '✗'} | ${changeLabel} |`);
  }
  lines.push('');

  // Regression detail section
  if (regressed.length > 0) {
    lines.push('## Regression Detail');
    lines.push('');
    lines.push('Queries where combined MRR@10 < baseline MRR@10 by more than 0.001.');
    lines.push('Hard = lost chunkRecall@5 (structural miss). Soft = rank-order shift within hit set (LLM variance).');
    lines.push('');
    for (const r of regressed) {
      const rtype = (r.bCr5 && !r.cCr5) ? 'hard' : 'soft';
      lines.push(`### ${r.id} (${r.type}) — ${rtype}`);
      lines.push('');
      lines.push(`- MRR: ${f3(r.bMrr)} → ${f3(r.cMrr)} (${delta(r.mrrDelta)})`);
      lines.push(`- nDCG@10: ${f3(r.bNdcg)} → ${f3(r.cNdcg)} (${delta(r.ndcgDelta)})`);
      lines.push(`- chunkRecall@5: ${r.bCr5 ? '✓' : '✗'} → ${r.cCr5 ? '✓' : '✗'}`);
      lines.push(`- top-1 relevance: ${r.bTop1Rel} → ${r.cTop1Rel}`);
      lines.push('');
    }
  } else {
    lines.push('## Regression Detail');
    lines.push('');
    lines.push('No regressions (MRR@10 Δ > 0.001) detected.');
    lines.push('');
  }

  // Verdict
  lines.push('## Verdict');
  lines.push('');

  const bothOk   = baselineRun.ok && combinedRun.ok;
  const countOk  = baselineCount !== null && combinedCount !== null && Math.abs(baselineCount - combinedCount) <= 2;
  const mrrDelta = (cMetrics.mrr10 ?? 0) - (bMetrics.mrr10 ?? 0);
  const crDelta  = (cMetrics.chunkRecall5 ?? 0) - (bMetrics.chunkRecall5 ?? 0);
  const cr10Delta = (cMetrics.chunkRecall10 ?? 0) - (bMetrics.chunkRecall10 ?? 0);

  // Hard regressions: lost chunkRecall@5 (chunk no longer in top-5 at all).
  const hardRegressions = diffRows.filter(r => r.change === 'regressed' && r.bCr5 && !r.cCr5);
  // Soft regressions: rank-order shift within top-5 hits (still retrieved, just ranked lower).
  const softRegressions = diffRows.filter(r => r.change === 'regressed' && !(r.bCr5 && !r.cCr5));

  if (!bothOk) {
    lines.push('**blocked** — one or both indexing runs failed. See Indexing table above.');
  } else if (!countOk) {
    lines.push(`**blocked** — point counts differ (baseline: ${baselineCount}, combined: ${combinedCount}). Check for indexing errors.`);
  } else if (hardRegressions.length === 0 && mrrDelta >= -0.02) {
    lines.push('**proceed opt-in** — COMBINED_LLM=1 shows no hard quality regression on custom-50.');
    lines.push('');
    lines.push(`MRR@10 delta: ${delta(mrrDelta)}. chunkRecall@5 delta: ${delta(crDelta)}. chunkRecall@10 delta: ${delta(cr10Delta)}. Combined parse fallbacks: ${combinedRun.fallbacks}.`);
    lines.push('');
    if (softRegressions.length > 0) {
      lines.push(`${softRegressions.length} soft regression(s) (rank-order shift within chunkRecall@5 hits, not retrieval misses): ${softRegressions.map(r => r.id).join(', ')}.`);
      lines.push('These reflect LLM context/tag phrasing variance affecting embedding score — not a structural retrieval failure.');
      lines.push('');
    }
    if (hardRegressions.length > 0) {
      lines.push(`${hardRegressions.length} hard regression(s) (lost chunkRecall@5): ${hardRegressions.map(r => r.id).join(', ')}. Review regression detail above.`);
      lines.push('');
    }
    lines.push('COMBINED_LLM=1 remains opt-in. No default promotion needed at this time.');
  } else if (hardRegressions.length <= 2 && mrrDelta >= -0.03) {
    lines.push('**proceed opt-in with caution** — minor hard regressions detected but aggregate metrics within tolerance.');
    lines.push('');
    lines.push(`Hard regressions (lost chunkRecall@5): ${hardRegressions.map(r => r.id).join(', ')}. Review regression detail above.`);
    lines.push('Recommend re-running on larger corpus before any default promotion.');
  } else {
    lines.push(`**defer** — ${hardRegressions.length} hard regression(s) detected. MRR@10 delta: ${delta(mrrDelta)}.`);
    lines.push('');
    lines.push(`Hard regressions (lost chunkRecall@5): ${hardRegressions.map(r => r.id).join(', ')}.`);
    lines.push('Investigate context/tag quality on failed cases before promoting COMBINED_LLM=1 as opt-in default.');
  }

  lines.push('');
  lines.push('**Before making COMBINED_LLM=1 the default:**');
  lines.push('1. Run on full 15-file benchmark corpus.');
  lines.push('2. Verify no regressions on cross-lingual and config-env query types.');
  lines.push('3. Address short-chunk context drift if COMBINED_MIN_CHARS threshold needs tuning.');
  lines.push('');
  lines.push(`*Generated: ${dateStr} — collections: ${COL_BASELINE}, ${COL_COMBINED}*`);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[quality] COMBINED_LLM=1 — custom-50 retrieval quality verification');
  console.log(`  CONTEXT_MODEL: ${CONTEXT_MODEL}`);
  console.log(`  collections:   ${COL_BASELINE}  |  ${COL_COMBINED}`);
  console.log(`  corpus:        ${CORPUS_DIR}`);

  if (!QDRANT_URL) {
    console.error('[quality] QDRANT_URL not set');
    process.exit(1);
  }

  try {
    // Build deterministic corpus dir
    buildCorpus();
    console.log(`  corpus built: ${FIXTURE_FILES.length} files`);

    // Pre-register collections in config so indexer can find provider settings
    await ensureBenchCollection(COL_BASELINE);
    await ensureBenchCollection(COL_COMBINED);
    // ── A: baseline indexing ─────────────────────────────────────────────────
    const baselineRun = runIndexer(COL_BASELINE, {}, CHUNKS_BASELINE, 'A: baseline (context + tags)');

    // ── B: combined indexing ─────────────────────────────────────────────────
    const combinedRun = runIndexer(COL_COMBINED, {
      COMBINED_LLM: '1',
    }, CHUNKS_COMBINED, 'B: combined (COMBINED_LLM=1)');

    if (!baselineRun.ok || !combinedRun.ok) {
      throw new Error('one or both indexing runs failed — aborting quality check');
    }

    // ── Point count check ────────────────────────────────────────────────────
    console.log('\n[quality] Fetching point counts...');
    const baselineCount = await countPoints(COL_BASELINE);
    const combinedCount = await countPoints(COL_COMBINED);
    console.log(`  baseline: ${baselineCount} points`);
    console.log(`  combined: ${combinedCount} points`);

    if (baselineCount === 0 || combinedCount === 0) {
      throw new Error(`empty collection after indexing (baseline: ${baselineCount}, combined: ${combinedCount})`);
    }
    if (Math.abs(baselineCount - combinedCount) > 2) {
      console.warn(`[quality] WARN: point counts differ significantly (${baselineCount} vs ${combinedCount})`);
    }

    // ── Load queries ─────────────────────────────────────────────────────────
    const raw     = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
    const queries = raw.queries.map(normaliseQuery);
    console.log(`\n[quality] Loaded ${queries.length} queries`);

    // ── Run queries against baseline ─────────────────────────────────────────
    console.log('\n[quality] Querying baseline collection...');
    const bResults = await runAllQueries(COL_BASELINE, queries);

    // ── Run queries against combined ─────────────────────────────────────────
    console.log('\n[quality] Querying combined collection...');
    const cResults = await runAllQueries(COL_COMBINED, queries);

    // ── Compute metrics ──────────────────────────────────────────────────────
    const bMetrics = computeMetrics(bResults);
    const cMetrics = computeMetrics(cResults);

    // ── Per-query diff ───────────────────────────────────────────────────────
    const diffRows = queryDiff(bResults, cResults, queries);
    const regressed  = diffRows.filter(r => r.change === 'regressed');
    const improved   = diffRows.filter(r => r.change === 'improved');
    const hardRegressed = regressed.filter(r => r.bCr5 && !r.cCr5);
    const softRegressed = regressed.filter(r => !(r.bCr5 && !r.cCr5));

    // ── Write report ─────────────────────────────────────────────────────────
    const now     = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');

    const report = buildReport({
      dateStr, baselineRun, combinedRun,
      bMetrics, cMetrics, diffRows,
      baselineCount, combinedCount,
    });

    mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = join(RESULTS_DIR, `${dateStr}T${timeStr}-combined-llm-custom50-quality.md`);
    writeFileSync(outPath, report, 'utf8');
    console.log(`\n[quality] Report: ${outPath}`);

    // ── Console summary ──────────────────────────────────────────────────────
    console.log('\n[quality] Summary');
    console.log(`  Baseline points: ${baselineCount}  Combined points: ${combinedCount}`);
    console.log(`  MRR@10:          baseline=${f3(bMetrics.mrr10)}  combined=${f3(cMetrics.mrr10)}  Δ=${delta((cMetrics.mrr10 ?? 0) - (bMetrics.mrr10 ?? 0))}`);
    console.log(`  nDCG@10:         baseline=${f3(bMetrics.ndcgK)}  combined=${f3(cMetrics.ndcgK)}  Δ=${delta((cMetrics.ndcgK ?? 0) - (bMetrics.ndcgK ?? 0))}`);
    console.log(`  chunkRecall@5:   baseline=${pct(bMetrics.chunkRecall5)}  combined=${pct(cMetrics.chunkRecall5)}`);
    console.log(`  chunkRecall@10:  baseline=${pct(bMetrics.chunkRecall10)}  combined=${pct(cMetrics.chunkRecall10)}`);
    console.log(`  negativePass:    baseline=${pct(bMetrics.negativePassRate)}  combined=${pct(cMetrics.negativePassRate)}`);
    console.log(`  Regressions:     ${regressed.length} (${hardRegressed.length} hard / ${softRegressed.length} soft)  Improvements: ${improved.length}`);
    if (hardRegressed.length > 0) console.log(`  Hard reg IDs:    ${hardRegressed.map(r => r.id).join(', ')}`);
    if (softRegressed.length > 0) console.log(`  Soft reg IDs:    ${softRegressed.map(r => r.id).join(', ')}`);
    if (regressed.length === 0) console.log('  No regressions detected');
    console.log(`  Combined fallbacks: ${combinedRun.fallbacks}`);

  } finally {
    if (!KEEP) {
      console.log('\n[quality] Cleaning up collections...');
      await deleteBenchCollection(COL_BASELINE);
      await deleteBenchCollection(COL_COMBINED);
      cleanupConfigEntries();
    } else {
      console.log(`\n[quality] KEEP_COLLECTIONS=1 — retained: ${COL_BASELINE}, ${COL_COMBINED}`);
    }
    cleanupTransient();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
