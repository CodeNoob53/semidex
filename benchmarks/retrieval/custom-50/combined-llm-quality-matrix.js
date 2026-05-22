/**
 * COMBINED_LLM=1 quality matrix — baseline vs gemma3:4b vs qwen2.5:3b-instruct.
 *
 * Runs the production indexer once for the shared baseline and once per combined
 * model variant, all on the same custom-50 fixture corpus.  Queries each
 * collection with the same 50 queries as run-v3.js and emits a single comparison
 * report so baseline variance does not confound per-model numbers.
 *
 * Usage:
 *   node benchmarks/retrieval/custom-50/combined-llm-quality-matrix.js
 *   npm run bench:custom50:combined-matrix
 *
 * Optional env:
 *   COMBINED_MODELS    — comma-separated model list (default: gemma3:4b,qwen2.5:3b-instruct)
 *   KEEP_COLLECTIONS=1 — skip Qdrant cleanup (debugging)
 *
 * Requires: Qdrant reachable, Ollama running with all COMBINED_MODELS pulled.
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

// Force benchmark provider env on the parent process so resolveEnvProviders()
// in ensureBenchCollection() writes correct ONNX metadata to config, regardless
// of what the caller's shell had set.  DENSE_PROVIDER takes precedence over
// ONNX_EMBED in resolveEnvProviders(), so it must be set explicitly to prevent
// a stale shell DENSE_PROVIDER=ollama from leaking into collection metadata.
process.env.DENSE_PROVIDER  = 'bge-m3-onnx';
process.env.SPARSE_PROVIDER = 'bge-m3-onnx';
process.env.ONNX_EMBED      = '1';
process.env.ONNX_EXECUTION_PROVIDER = process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu';

const COMBINED_MODELS = (process.env.COMBINED_MODELS || 'gemma3:4b,qwen2.5:3b-instruct')
  .split(',').map(m => m.trim()).filter(Boolean);

const QDRANT_URL = (process.env.QDRANT_URL ?? '').replace(/\/$/, '');
const STAMP      = Date.now();

const COL_BASELINE = `bench-c50-baseline-${STAMP}`;
const colCombined  = (model) => `bench-c50-combined-${model.replace(/[^a-z0-9]/gi, '_')}-${STAMP}`;

const CORPUS_DIR      = join(ROOT, '.tmp', `bench-c50-corpus-${STAMP}`);
const CHUNKS_BASELINE = join(ROOT, '.tmp', `bench-c50-chunks-baseline-${STAMP}`);
const chunksCombined  = (model) => join(ROOT, '.tmp', `bench-c50-chunks-${model.replace(/[^a-z0-9]/gi, '_')}-${STAMP}`);

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
    if (!existsSync(src)) { console.error(`[matrix] Fixture missing: ${src}`); process.exit(1); }
    copyFileSync(src, join(CORPUS_DIR, name));
  }
}

function cleanupTransient(extraChunkDirs) {
  for (const d of [CORPUS_DIR, CHUNKS_BASELINE, ...extraChunkDirs]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function cleanupConfigEntries(collections) {
  try {
    const cfg = loadConfig();
    if (!cfg.collections) return;
    for (const name of collections) delete cfg.collections[name];
    saveConfig(cfg);
  } catch { /* best-effort */ }
}

// ── Qdrant collection management ──────────────────────────────────────────────

async function ensureBenchCollection(name) {
  const cols = await listCollections();
  if (!cols.includes(name)) await createCollection(name, 1024);
  const { denseProvider, denseModel, sparseProvider } = resolveEnvProviders();
  const cfg = loadConfig();
  cfg.collections ??= {};
  cfg.collections[name] = {
    denseProvider, denseModel, sparseProvider,
    embeddingSchemaVersion: SCHEMA_VERSION,
    vectorSize: 1024,
    description: `combined-llm quality matrix — auto-managed (${STAMP})`,
  };
  saveConfig(cfg);
}

async function deleteBenchCollection(name) {
  try { await deleteCollection(name); console.log(`  [cleanup] deleted "${name}"`); }
  catch { console.log(`  [cleanup] could not delete "${name}"`); }
}

async function scrollPage(collection, offset) {
  const body = { limit: 100, with_payload: true, with_vectors: false };
  if (offset !== null) body.offset = offset;
  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: { 'api-key': process.env.QDRANT_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Qdrant scroll "${collection}" returned ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

async function scrollAll(collection) {
  const points = [];
  let offset = null;
  while (true) {
    let data;
    try { data = await scrollPage(collection, offset); }
    catch (e) {
      if (offset === null && e.message === 'fetch failed') {
        console.log('  [scroll] network error on first page — retrying once...');
        await new Promise(r => setTimeout(r, 2000));
        data = await scrollPage(collection, offset);
      } else { throw e; }
    }
    const batch = data?.result?.points ?? [];
    points.push(...batch);
    offset = data?.result?.next_page_offset ?? null;
    if (offset === null || batch.length === 0) break;
  }
  return points;
}

async function countPoints(collection) { return (await scrollAll(collection)).length; }

// ── Indexer runner ────────────────────────────────────────────────────────────

function runIndexer(collection, extraEnv, chunksOutDir, label) {
  console.log(`\n[matrix] Running ${label}...`);
  const env = {
    ...process.env,
    COLLECTION:    collection,
    SOURCE_ROOT:   CORPUS_DIR,
    ONNX_EMBED:    '1',
    CHUNKS_OUT_DIR: chunksOutDir,
    INDEX_PROFILE: '1',
    ...extraEnv,
  };

  const t0 = Date.now();
  const result = spawnSync('node', ['src/indexer/index.js', CORPUS_DIR], {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  const totalMs = Date.now() - t0;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.status !== 0) {
    console.error(`  [matrix] ${label} FAILED (exit ${result.status})`);
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
  for (const [phase, vals] of Object.entries(phaseMs))
    result[phase] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  return result;
}

// ── Query loading & metrics (mirrors run-v3.js / combined-llm-quality.js) ─────

function tokenise(str) { return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []; }
function buildQrels(rc) { const m = new Map(); for (const c of (rc ?? [])) m.set(c.chunkId, c.relevance ?? 3); return m; }
function normaliseQuery(q) {
  return {
    id: q.id, type: q.type ?? 'file-level', query: q.query,
    expectedFiles: q.expectedFiles ?? [], relevantChunks: q.relevantChunks ?? [],
    qrels: buildQrels(q.relevantChunks),
    expectedTokens: q.expectedTokens ? q.expectedTokens.flatMap(t => tokenise(t)).filter(Boolean) : null,
    shouldHaveNoStrongHit: q.shouldHaveNoStrongHit ?? false, note: q.note ?? '',
  };
}
function resultChunkId(r) {
  const sf = r.payload?.source_file, ci = r.payload?.chunk_index;
  return (sf && ci != null) ? `${sf}#${ci}` : null;
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
  for (let i = 0; i < Math.min(results.length, k); i++)
    dcg += (Math.pow(2, qrels.get(resultChunkId(results[i])) ?? 0) - 1) / Math.log2(i + 2);
  const idcg = idealDCG(qrels, k);
  return idcg === 0 ? 0 : dcg / idcg;
}
function chunkRecallHit(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const ids = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  return ids.size ? results.slice(0, k).some(r => ids.has(resultChunkId(r))) : null;
}
function mrr(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const ids = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!ids.size) return null;
  for (let i = 0; i < Math.min(results.length, k); i++)
    if (ids.has(resultChunkId(results[i]))) return 1 / (i + 1);
  return 0;
}
function parseChunkId(id) {
  if (!id) return null;
  const h = id.lastIndexOf('#');
  if (h < 0) return null;
  const ci = parseInt(id.slice(h + 1), 10);
  return (id.slice(0, h) && Number.isFinite(ci)) ? { sourceFile: id.slice(0, h), chunkIndex: ci } : null;
}
function windowRecallHit(results, qrels, k, window) {
  if (!qrels.size) return null;
  const exactIds = [...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id);
  if (!exactIds.length) return null;
  const topK = results.slice(0, k);
  if (topK.some(r => { const cid = resultChunkId(r); return cid && qrels.get(cid) >= 3; })) return true;
  for (const eid of exactIds) {
    const ep = parseChunkId(eid);
    if (!ep) continue;
    if (topK.some(r => {
      const rp = parseChunkId(resultChunkId(r));
      return rp && rp.sourceFile === ep.sourceFile && Math.abs(rp.chunkIndex - ep.chunkIndex) <= window;
    })) return true;
  }
  return false;
}
function negativePass(results, query) {
  if (!results.length) return true;
  const words = new Set([...tokenise(results[0].payload?.text ?? ''), ...tokenise(results[0].payload?.section ?? '')]);
  return !(query.expectedTokens ?? []).some(t => words.has(t));
}
function computeMetrics(queryResults) {
  const pos = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
  const neg = queryResults.filter(r =>  r.query.shouldHaveNoStrongHit);
  const hasExact    = pos.filter(r => [...r.query.qrels.values()].some(v => v >= 3)).length;
  const hasAnyQrels = pos.filter(r => r.query.qrels.size > 0).length;
  let cr3=0,cr5=0,cr10=0,wr5=0,wr10=0,supp=0,ndcgSum=0,mrrSum=0,mrrCount=0,negPass=0;
  const latencies = queryResults.map(r => r.latency).sort((a, b) => a - b);
  for (const { results, query } of pos) {
    if (chunkRecallHit(results, query.qrels, 3,     3)) cr3++;
    if (chunkRecallHit(results, query.qrels, 5,     3)) cr5++;
    if (chunkRecallHit(results, query.qrels, TOP_K, 3)) cr10++;
    if (windowRecallHit(results, query.qrels, 5,     BENCH_WINDOW)) wr5++;
    if (windowRecallHit(results, query.qrels, TOP_K, BENCH_WINDOW)) wr10++;
    if (chunkRecallHit(results, query.qrels, TOP_K, 2)) supp++;
    const nv = gradedNDCG(results, query.qrels, TOP_K); if (nv !== null) ndcgSum += nv;
    const mv = mrr(results, query.qrels, 10, 3);        if (mv !== null) { mrrSum += mv; mrrCount++; }
  }
  for (const { results, query } of neg) if (negativePass(results, query)) negPass++;
  return {
    chunkRecall3:    hasExact    > 0 ? cr3/hasExact     : null,
    chunkRecall5:    hasExact    > 0 ? cr5/hasExact     : null,
    chunkRecall10:   hasExact    > 0 ? cr10/hasExact    : null,
    windowRecall5:   hasExact    > 0 ? wr5/hasExact     : null,
    windowRecall10:  hasExact    > 0 ? wr10/hasExact    : null,
    supportRecallK:  hasAnyQrels > 0 ? supp/hasAnyQrels : null,
    ndcgK:           hasAnyQrels > 0 ? ndcgSum/hasAnyQrels : null,
    mrr10:           mrrCount    > 0 ? mrrSum/mrrCount  : null,
    negativePassRate: neg.length > 0 ? negPass/neg.length : null,
    p50Latency: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
    p95Latency: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
    nPositive: pos.length, nNegative: neg.length,
  };
}

// ── Search ────────────────────────────────────────────────────────────────────

async function runQuery(collection, queryText) {
  const t0 = Date.now();
  const { dense, sparse } = await embedForSearch(collection, queryText);
  const results = await hybridSearch(collection, dense, sparse, TOP_K);
  return { results, latency: Date.now() - t0 };
}

async function runAllQueries(collection, queries, label) {
  console.log(`\n[matrix] Querying ${label}...`);
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
    const mrrDelta = cMrr - bMrr;
    let change = 'same';
    if      (mrrDelta >  0.001) change = 'improved';
    else if (mrrDelta < -0.001) change = 'regressed';
    const bTop1 = resultChunkId(br.results[0]);
    const cTop1 = resultChunkId(cr.results[0]);
    rows.push({
      id: q.id, type: q.type, bMrr, cMrr, mrrDelta,
      bNdcg, cNdcg, ndcgDelta: cNdcg - bNdcg,
      bCr5, cCr5,
      bTop1Rel: bTop1 ? (q.qrels.get(bTop1) ?? 0) : 0,
      cTop1Rel: cTop1 ? (q.qrels.get(cTop1) ?? 0) : 0,
      change,
    });
  }
  return rows;
}

// ── Report helpers ────────────────────────────────────────────────────────────

const pct   = v => v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
const f3    = v => v == null ? 'n/a' : v.toFixed(3);
const delta = v => Math.abs(v) < 0.001 ? '—' : (v > 0 ? '+' : '') + v.toFixed(3);

function regressionSummary(diffRows) {
  const regressed  = diffRows.filter(r => r.change === 'regressed');
  const improved   = diffRows.filter(r => r.change === 'improved');
  const same       = diffRows.filter(r => r.change === 'same');
  const hardReg    = regressed.filter(r => r.bCr5 && !r.cCr5);
  const softReg    = regressed.filter(r => !(r.bCr5 && !r.cCr5));
  return { regressed, improved, same, hardReg, softReg };
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport({ dateStr, baselineRun, baselineCount, combinedVariants, bMetrics, bResults, queries }) {
  const lines = [];
  lines.push(`# COMBINED_LLM=1 Quality Matrix — custom-50 — ${dateStr}`);
  lines.push('');
  lines.push('## Purpose');
  lines.push('');
  lines.push('Compare retrieval quality for baseline (separate context+tags) against');
  lines.push('COMBINED_LLM=1 with each tested model. A shared baseline eliminates');
  lines.push('run-to-run variance from confounding per-model comparisons.');
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push('| Item | Value |');
  lines.push('|------|-------|');
  lines.push(`| Node.js | ${process.version} |`);
  lines.push(`| ONNX_EMBED | 1 |`);
  lines.push(`| ONNX_EXECUTION_PROVIDER | ${process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu (default)'} |`);
  lines.push(`| Corpus | custom-50 fixture docs (10 files) |`);
  lines.push(`| Queries | 50 (v3 schema, graded chunk-level qrels) |`);
  lines.push(`| Search mode | hybrid (RRF) |`);
  lines.push(`| Top-K | ${TOP_K} |`);
  lines.push(`| Combined models tested | ${COMBINED_MODELS.join(', ')} |`);
  lines.push('');
  lines.push('## Indexing');
  lines.push('');
  lines.push('| Variant | Exit | Points | Wall time | Combined fallbacks | Tag batch fallbacks |');
  lines.push('|---------|------|--------|-----------|-------------------|---------------------|');
  lines.push(`| baseline (separate) | ${baselineRun.ok ? 'OK' : 'FAIL'} | ${baselineCount ?? '?'} | ${baselineRun.totalMs} ms | n/a | ${baselineRun.tagFallbacks} |`);
  for (const v of combinedVariants) {
    lines.push(`| combined ${v.model} | ${v.run.ok ? 'OK' : 'FAIL'} | ${v.count ?? '?'} | ${v.run.totalMs} ms | ${v.run.fallbacks} | n/a |`);
  }
  lines.push('');
  lines.push('## Aggregate Metrics');
  lines.push('');
  lines.push(`| Metric | baseline | ${combinedVariants.map(v => v.model).join(' | ')} |`);
  lines.push(`|--------|----------|${combinedVariants.map(() => '---').join('|')}|`);

  function metricRow(label, key, fmt) {
    const bv = bMetrics[key];
    const vals = combinedVariants.map(v => {
      const cv = v.metrics[key];
      const d = (bv != null && cv != null) ? delta(cv - bv) : '—';
      return `${fmt(cv)} (${d})`;
    });
    return `| ${label} | ${fmt(bv)} | ${vals.join(' | ')} |`;
  }

  lines.push(metricRow('chunkRecall@3',    'chunkRecall3',    pct));
  lines.push(metricRow('chunkRecall@5',    'chunkRecall5',    pct));
  lines.push(metricRow('chunkRecall@10',   'chunkRecall10',   pct));
  lines.push(metricRow('windowRecall@5',   'windowRecall5',   pct));
  lines.push(metricRow('windowRecall@10',  'windowRecall10',  pct));
  lines.push(metricRow('supportRecall@10', 'supportRecallK',  pct));
  lines.push(metricRow('nDCG@10',          'ndcgK',           f3));
  lines.push(metricRow('MRR@10',           'mrr10',           f3));
  lines.push(metricRow('negativePass',     'negativePassRate',pct));
  lines.push('');
  lines.push('*Delta vs shared baseline in parentheses.*');
  lines.push('');

  // Per-variant regression tables
  for (const v of combinedVariants) {
    const { regressed, improved, same, hardReg, softReg } = regressionSummary(v.diffRows);
    lines.push(`## Per-Query Diff: combined ${v.model} vs baseline`);
    lines.push('');
    lines.push(`${regressed.length} regressed (${hardReg.length} hard / ${softReg.length} soft), ${improved.length} improved, ${same.length} unchanged (by MRR@10 Δ > 0.001)`);
    lines.push('');
    lines.push('*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*');
    lines.push('');
    lines.push('| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |');
    lines.push('|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|');
    const sorted = [...v.diffRows].sort((a, b) => a.mrrDelta - b.mrrDelta);
    for (const r of sorted) {
      const lbl = r.change === 'regressed' ? '**regressed**' : r.change === 'improved' ? 'improved' : '—';
      lines.push(`| ${r.id} | ${r.type} | ${f3(r.bMrr)} | ${f3(r.cMrr)} | ${delta(r.mrrDelta)} | ${f3(r.bNdcg)} | ${f3(r.cNdcg)} | ${delta(r.ndcgDelta)} | ${r.bCr5 ? '✓' : '✗'} | ${r.cCr5 ? '✓' : '✗'} | ${lbl} |`);
    }
    lines.push('');

    if (regressed.length > 0) {
      lines.push(`## Regression Detail: ${v.model}`);
      lines.push('');
      for (const r of regressed) {
        const rt = (r.bCr5 && !r.cCr5) ? 'hard' : 'soft';
        lines.push(`### ${r.id} (${r.type}) — ${rt}`);
        lines.push('');
        lines.push(`- MRR: ${f3(r.bMrr)} → ${f3(r.cMrr)} (${delta(r.mrrDelta)})`);
        lines.push(`- nDCG@10: ${f3(r.bNdcg)} → ${f3(r.cNdcg)} (${delta(r.ndcgDelta)})`);
        lines.push(`- chunkRecall@5: ${r.bCr5 ? '✓' : '✗'} → ${r.cCr5 ? '✓' : '✗'}`);
        lines.push(`- top-1 relevance: ${r.bTop1Rel} → ${r.cTop1Rel}`);
        lines.push('');
      }
    } else {
      lines.push(`## Regression Detail: ${v.model}`);
      lines.push('');
      lines.push('No regressions (MRR@10 Δ > 0.001) detected.');
      lines.push('');
    }
  }

  // Cross-model absolute comparison table
  if (combinedVariants.length >= 2) {
    lines.push('## Cross-Model Absolute Comparison (combined variants)');
    lines.push('');
    lines.push(`| Metric | ${combinedVariants.map(v => v.model).join(' | ')} |`);
    lines.push(`|--------|${combinedVariants.map(() => '---').join('|')}|`);
    for (const [label, key, fmt] of [
      ['MRR@10', 'mrr10', f3], ['nDCG@10', 'ndcgK', f3],
      ['chunkRecall@5', 'chunkRecall5', pct], ['chunkRecall@10', 'chunkRecall10', pct],
      ['windowRecall@10', 'windowRecall10', pct], ['negativePass', 'negativePassRate', pct],
    ]) {
      lines.push(`| ${label} | ${combinedVariants.map(v => fmt(v.metrics[key])).join(' | ')} |`);
    }
    lines.push('');
    lines.push('| indexing time | ' + combinedVariants.map(v => `${v.run.totalMs} ms`).join(' | ') + ' |');
    lines.push('| combined fallbacks | ' + combinedVariants.map(v => String(v.run.fallbacks)).join(' | ') + ' |');
    lines.push('| hard regressions | ' + combinedVariants.map(v => String(regressionSummary(v.diffRows).hardReg.length)).join(' | ') + ' |');
    lines.push('| soft regressions | ' + combinedVariants.map(v => String(regressionSummary(v.diffRows).softReg.length)).join(' | ') + ' |');
    lines.push('| improvements | ' + combinedVariants.map(v => String(regressionSummary(v.diffRows).improved.length)).join(' | ') + ' |');
    lines.push('');
  }

  // Verdict
  lines.push('## Verdict');
  lines.push('');

  const allOk = baselineRun.ok && combinedVariants.every(v => v.run.ok);
  if (!allOk) {
    lines.push('**blocked** — one or more indexing runs failed. See Indexing table above.');
    lines.push('');
    lines.push(`*Generated: ${dateStr}*`);
    return lines.join('\n');
  }

  const verdicts = [];
  for (const v of combinedVariants) {
    const { hardReg, softReg } = regressionSummary(v.diffRows);
    const mrrDelta  = (v.metrics.mrr10 ?? 0) - (bMetrics.mrr10 ?? 0);
    const crDelta   = (v.metrics.chunkRecall5 ?? 0) - (bMetrics.chunkRecall5 ?? 0);
    const cr10Delta = (v.metrics.chunkRecall10 ?? 0) - (bMetrics.chunkRecall10 ?? 0);

    let label, detail;
    if (hardReg.length === 0 && mrrDelta >= -0.02) {
      label  = `RECOMMEND_COMBINED_${v.model.split(':')[0].toUpperCase().replace(/[^A-Z0-9]/g, '_')}_OPT_IN`;
      detail = `${v.model}: no hard regressions. MRR@10 Δ ${delta(mrrDelta)}, chunkRecall@5 Δ ${delta(crDelta)}, chunkRecall@10 Δ ${delta(cr10Delta)}. Combined parse fallbacks: ${v.run.fallbacks}.`;
      if (softReg.length > 0) detail += ` ${softReg.length} soft regression(s): ${softReg.map(r => r.id).join(', ')}.`;
    } else if (hardReg.length <= 2 && mrrDelta >= -0.03) {
      label  = 'COMBINED_DEFER_HARD_REGRESSIONS';
      detail = `${v.model}: ${hardReg.length} hard regression(s) (${hardReg.map(r => r.id).join(', ')}). MRR@10 Δ ${delta(mrrDelta)}. Within tolerance but needs investigation.`;
    } else {
      label  = 'COMBINED_DEFER_HARD_REGRESSIONS';
      detail = `${v.model}: ${hardReg.length} hard regression(s). MRR@10 Δ ${delta(mrrDelta)}. Not recommended for opt-in.`;
    }
    verdicts.push({ model: v.model, label, detail });
  }

  for (const v of verdicts) {
    lines.push(`### ${v.model}`);
    lines.push('');
    lines.push(`**${v.label}**`);
    lines.push('');
    lines.push(v.detail);
    lines.push('');
  }

  lines.push('### Notes');
  lines.push('');
  lines.push('- Parser stability confirmed separately — see `benchmarks/retrieval/results/2026-05-22T0239-combined-parser-stability.md`.');
  lines.push('- Retrieval quality above is the primary decision signal for opt-in recommendation.');
  lines.push('- COMBINED_LLM=1 remains opt-in. Production default unchanged.');
  lines.push('- Before default promotion: run on a broader fixture corpus; verify cross-lingual and config-env query types.');
  lines.push('');
  lines.push(`*Generated: ${dateStr}*`);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[matrix] COMBINED_LLM=1 quality matrix — custom-50');
  console.log(`  combined models: ${COMBINED_MODELS.join(', ')}`);
  console.log(`  baseline:        ${COL_BASELINE}`);
  if (!QDRANT_URL) { console.error('[matrix] QDRANT_URL not set'); process.exit(1); }

  const allCollections = [COL_BASELINE, ...COMBINED_MODELS.map(colCombined)];
  const allChunkDirs   = [CHUNKS_BASELINE, ...COMBINED_MODELS.map(chunksCombined)];

  try {
    buildCorpus();
    console.log(`  corpus built: ${FIXTURE_FILES.length} files → ${CORPUS_DIR}`);

    // Pre-register all collections
    for (const name of allCollections) await ensureBenchCollection(name);

    // ── Shared baseline ──────────────────────────────────────────────────────
    // Explicitly set every benchmark-sensitive env so stale parent-process vars
    // (COMBINED_LLM, TAG_MODEL, TAG_GEN, BENCH_CONTEXT_POLICY) cannot silently
    // change what "baseline separate" means.
    const baselineRun = runIndexer(COL_BASELINE, {
      DENSE_PROVIDER:      'bge-m3-onnx',
      SPARSE_PROVIDER:     'bge-m3-onnx',
      ONNX_EMBED:          '1',
      COMBINED_LLM:        '0',
      CONTEXT_MODEL:       'gemma3:4b',
      TAG_MODEL:           'gemma3:4b',
      TAG_GEN:             '1',
      BENCH_CONTEXT_POLICY: 'current-minimal',
    }, CHUNKS_BASELINE, 'baseline (separate context+tags, gemma3:4b)');

    // ── Per-model combined runs ──────────────────────────────────────────────
    const combinedRuns = {};
    for (const model of COMBINED_MODELS) {
      combinedRuns[model] = runIndexer(colCombined(model), {
        DENSE_PROVIDER:      'bge-m3-onnx',
        SPARSE_PROVIDER:     'bge-m3-onnx',
        ONNX_EMBED:          '1',
        COMBINED_LLM:        '1',
        CONTEXT_MODEL:       model,
        TAG_MODEL:           '',   // combined path owns tag generation; clear to avoid interference
        TAG_GEN:             '1',
        BENCH_CONTEXT_POLICY: 'current-minimal',
      }, chunksCombined(model), `combined COMBINED_LLM=1 CONTEXT_MODEL=${model}`);
    }

    if (!baselineRun.ok || COMBINED_MODELS.some(m => !combinedRuns[m].ok)) {
      throw new Error('one or more indexing runs failed — aborting');
    }

    // ── Point counts ─────────────────────────────────────────────────────────
    console.log('\n[matrix] Fetching point counts...');
    const baselineCount = await countPoints(COL_BASELINE);
    console.log(`  baseline: ${baselineCount} points`);
    const combinedCounts = {};
    for (const model of COMBINED_MODELS) {
      combinedCounts[model] = await countPoints(colCombined(model));
      console.log(`  combined ${model}: ${combinedCounts[model]} points`);
    }
    if (baselineCount === 0) throw new Error('baseline collection is empty after indexing');

    // ── Load queries ─────────────────────────────────────────────────────────
    const raw     = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
    const queries = raw.queries.map(normaliseQuery);
    console.log(`\n[matrix] Loaded ${queries.length} queries`);

    // ── Query baseline ────────────────────────────────────────────────────────
    const bResults = await runAllQueries(COL_BASELINE, queries, 'baseline');
    const bMetrics = computeMetrics(bResults);

    // ── Query each combined variant ───────────────────────────────────────────
    const combinedVariants = [];
    for (const model of COMBINED_MODELS) {
      const cResults = await runAllQueries(colCombined(model), queries, `combined ${model}`);
      const cMetrics = computeMetrics(cResults);
      const diffRows = queryDiff(bResults, cResults, queries);
      const { hardReg, softReg, improved } = regressionSummary(diffRows);
      console.log(`\n[matrix] ${model}: MRR@10 baseline=${f3(bMetrics.mrr10)} combined=${f3(cMetrics.mrr10)} Δ=${delta((cMetrics.mrr10??0)-(bMetrics.mrr10??0))}`);
      console.log(`  chunkRecall@5: ${pct(bMetrics.chunkRecall5)} → ${pct(cMetrics.chunkRecall5)}`);
      console.log(`  regressions: ${hardReg.length} hard / ${softReg.length} soft   improvements: ${improved.length}`);
      combinedVariants.push({ model, run: combinedRuns[model], count: combinedCounts[model], metrics: cMetrics, diffRows });
    }

    // ── Report ────────────────────────────────────────────────────────────────
    const now     = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');
    const report  = buildReport({ dateStr, baselineRun, baselineCount, combinedVariants, bMetrics, bResults, queries });

    mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = join(RESULTS_DIR, `${dateStr}T${timeStr}-combined-llm-quality-matrix.md`);
    writeFileSync(outPath, report, 'utf8');
    console.log(`\n[matrix] Report: ${outPath}`);

  } finally {
    if (!KEEP) {
      console.log('\n[matrix] Cleaning up collections...');
      for (const name of allCollections) await deleteBenchCollection(name);
      cleanupConfigEntries(allCollections);
    } else {
      console.log(`\n[matrix] KEEP_COLLECTIONS=1 — retained: ${allCollections.join(', ')}`);
    }
    cleanupTransient(allChunkDirs);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
