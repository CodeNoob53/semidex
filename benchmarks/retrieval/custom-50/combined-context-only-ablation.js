/**
 * Context-only combined ablation — custom-50
 *
 * Tests the hypothesis: does asking the model for both context AND tags in one
 * combined prompt degrade context quality compared to asking for context only?
 *
 * Three variants run against the same custom-50 fixture corpus:
 *   1. baseline separate   — COMBINED_LLM=0, separate context + tags (production default)
 *   2. combined ctx+tags   — COMBINED_LLM=1, {"context","tags"} in one call (gemma3:4b)
 *   3. combined ctx-only   — COMBINED_LLM=1 + BENCH_COMBINED_CONTEXT_ONLY=1,
 *                            {"context"} only, tags stored as [] (benchmark-only flag)
 *
 * If ctx-only recovers quality vs ctx+tags → regression is caused by the dual-task prompt.
 * If ctx-only does not recover → regression is caused by prompt wording / JSON constraint /
 * LLM variance, not the presence of a tags field.
 *
 * Usage:
 *   node benchmarks/retrieval/custom-50/combined-context-only-ablation.js
 *   npm run bench:custom50:context-only-ablation
 *
 * Optional env:
 *   MODEL=gemma3:4b        — model to use for combined variants (default: gemma3:4b)
 *   KEEP_COLLECTIONS=1     — skip Qdrant cleanup (debugging)
 *
 * BENCH_COMBINED_CONTEXT_ONLY is a benchmark-only flag in combined.js.
 * Do not expose it as documented production config.
 *
 * Requires: Qdrant reachable, Ollama running with MODEL pulled.
 * All transient dirs live under .tmp/ (gitignored).
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
// ONNX_EMBED in resolveEnvProviders(), so it must be set explicitly.
process.env.DENSE_PROVIDER  = 'bge-m3-onnx';
process.env.SPARSE_PROVIDER = 'bge-m3-onnx';
process.env.ONNX_EMBED      = '1';
process.env.ONNX_EXECUTION_PROVIDER = process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu';

const MODEL      = process.env.MODEL || 'gemma3:4b';
const QDRANT_URL = (process.env.QDRANT_URL ?? '').replace(/\/$/, '');
const STAMP      = Date.now();

const COL_BASELINE    = `bench-c50-base-${STAMP}`;
const COL_CTX_TAGS    = `bench-c50-ctxtags-${STAMP}`;
const COL_CTX_ONLY    = `bench-c50-ctxonly-${STAMP}`;

const CORPUS_DIR        = join(ROOT, '.tmp', `bench-c50-co-corpus-${STAMP}`);
const CHUNKS_BASELINE   = join(ROOT, '.tmp', `bench-c50-co-chunks-base-${STAMP}`);
const CHUNKS_CTX_TAGS   = join(ROOT, '.tmp', `bench-c50-co-chunks-ctxtags-${STAMP}`);
const CHUNKS_CTX_ONLY   = join(ROOT, '.tmp', `bench-c50-co-chunks-ctxonly-${STAMP}`);

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
    if (!existsSync(src)) { console.error(`[ablation] Fixture missing: ${src}`); process.exit(1); }
    copyFileSync(src, join(CORPUS_DIR, name));
  }
}

function cleanupTransient() {
  for (const d of [CORPUS_DIR, CHUNKS_BASELINE, CHUNKS_CTX_TAGS, CHUNKS_CTX_ONLY]) {
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
    description: `combined context-only ablation — auto-managed (${STAMP})`,
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
  console.log(`\n[ablation] Running ${label}...`);
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
    console.error(`  [ablation] ${label} FAILED (exit ${result.status})`);
    console.error(stderr.slice(-3000));
    return { ok: false, totalMs, stdout, stderr, fallbacks: 0, tagFallbacks: 0, indexed: 0 };
  }

  const fallbacks    = (stderr.match(/\[combined\] parse failed/g) ?? []).length;
  const tagFallbacks = (stderr.match(/\[tag\] batch parse failed/g) ?? []).length;
  const indexedMatch = stdout.match(/(\d+) indexed/);
  const indexed      = indexedMatch ? parseInt(indexedMatch[1], 10) : 0;

  console.log(`  done in ${totalMs} ms — exit 0`);
  console.log(`  indexed ${indexed} file(s)`);
  if (fallbacks)    console.log(`  [combined] parse fallbacks: ${fallbacks}`);
  if (tagFallbacks) console.log(`  [tag] batch fallbacks: ${tagFallbacks}`);
  return { ok: true, totalMs, stdout, stderr, fallbacks, tagFallbacks, indexed };
}

// ── Query loading & metrics ───────────────────────────────────────────────────

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
  console.log(`\n[ablation] Querying ${label}...`);
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
  const regressed = diffRows.filter(r => r.change === 'regressed');
  const improved  = diffRows.filter(r => r.change === 'improved');
  const same      = diffRows.filter(r => r.change === 'same');
  const hardReg   = regressed.filter(r => r.bCr5 && !r.cCr5);
  const softReg   = regressed.filter(r => !(r.bCr5 && !r.cCr5));
  return { regressed, improved, same, hardReg, softReg };
}

// ── Report builder ────────────────────────────────────────────────────────────

function diffTable(diffRows) {
  const lines = [];
  lines.push('| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |');
  lines.push('|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|');
  const sorted = [...diffRows].sort((a, b) => a.mrrDelta - b.mrrDelta);
  for (const r of sorted) {
    const lbl = r.change === 'regressed' ? '**regressed**' : r.change === 'improved' ? 'improved' : '—';
    lines.push(`| ${r.id} | ${r.type} | ${f3(r.bMrr)} | ${f3(r.cMrr)} | ${delta(r.mrrDelta)} | ${f3(r.bNdcg)} | ${f3(r.cNdcg)} | ${delta(r.ndcgDelta)} | ${r.bCr5 ? '✓' : '✗'} | ${r.cCr5 ? '✓' : '✗'} | ${lbl} |`);
  }
  return lines;
}

function regressionDetail(label, diffRows) {
  const lines = [];
  const regressed = diffRows.filter(r => r.change === 'regressed');
  lines.push(`## Regression Detail: ${label}`);
  lines.push('');
  if (regressed.length === 0) {
    lines.push('No regressions (MRR@10 Δ > 0.001) detected.');
    lines.push('');
    return lines;
  }
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
  return lines;
}

function buildReport({ dateStr, baseRun, baseCount, ctxTagsRun, ctxTagsCount, ctxOnlyRun, ctxOnlyCount,
                       bMetrics, ctxTagsMetrics, ctxOnlyMetrics,
                       ctxTagsDiff, ctxOnlyDiff }) {
  const lines = [];
  lines.push(`# Combined Context-Only Ablation — custom-50 — ${dateStr}`);
  lines.push('');
  lines.push('## Purpose');
  lines.push('');
  lines.push('Test hypothesis: does asking the model for both context AND tags in one combined prompt');
  lines.push('degrade context quality vs asking for context only?');
  lines.push('');
  lines.push('- **baseline separate**: production separate context + tags path (COMBINED_LLM=0)');
  lines.push('- **combined ctx+tags**: COMBINED_LLM=1, one call returns {"context","tags"}');
  lines.push('- **combined ctx-only**: COMBINED_LLM=1 + BENCH_COMBINED_CONTEXT_ONLY=1, one call returns {"context"}, tags=[]');
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push('| Item | Value |');
  lines.push('|------|-------|');
  lines.push(`| Node.js | ${process.version} |`);
  lines.push(`| DENSE_PROVIDER | bge-m3-onnx |`);
  lines.push(`| ONNX_EXECUTION_PROVIDER | ${process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu (default)'} |`);
  lines.push(`| Model | ${MODEL} |`);
  lines.push(`| Corpus | custom-50 fixture docs (10 files) |`);
  lines.push(`| Queries | 50 (v3 schema, graded chunk-level qrels) |`);
  lines.push(`| Search mode | hybrid (RRF) |`);
  lines.push(`| Top-K | ${TOP_K} |`);
  lines.push('');
  lines.push('## Indexing');
  lines.push('');
  lines.push('| Variant | Exit | Points | Wall time | Combined fallbacks | Tag batch fallbacks |');
  lines.push('|---------|------|--------|-----------|-------------------|---------------------|');
  lines.push(`| baseline separate | ${baseRun.ok ? 'OK' : 'FAIL'} | ${baseCount ?? '?'} | ${baseRun.totalMs} ms | n/a | ${baseRun.tagFallbacks} |`);
  lines.push(`| combined ctx+tags | ${ctxTagsRun.ok ? 'OK' : 'FAIL'} | ${ctxTagsCount ?? '?'} | ${ctxTagsRun.totalMs} ms | ${ctxTagsRun.fallbacks} | n/a |`);
  lines.push(`| combined ctx-only | ${ctxOnlyRun.ok ? 'OK' : 'FAIL'} | ${ctxOnlyCount ?? '?'} | ${ctxOnlyRun.totalMs} ms | ${ctxOnlyRun.fallbacks} | n/a |`);
  lines.push('');
  lines.push('## Aggregate Metrics');
  lines.push('');
  lines.push('| Metric | baseline | ctx+tags (Δ) | ctx-only (Δ) |');
  lines.push('|--------|----------|-------------|-------------|');

  function metricRow(label, key, fmt) {
    const bv  = bMetrics[key];
    const tv  = ctxTagsMetrics[key];
    const ov  = ctxOnlyMetrics[key];
    const td  = (bv != null && tv != null) ? delta(tv - bv) : '—';
    const od  = (bv != null && ov != null) ? delta(ov - bv) : '—';
    return `| ${label} | ${fmt(bv)} | ${fmt(tv)} (${td}) | ${fmt(ov)} (${od}) |`;
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
  lines.push('*Δ = combined variant − baseline.*');
  lines.push('');

  // Per-query diff tables
  const ctxTagsSummary = regressionSummary(ctxTagsDiff);
  const ctxOnlySummary = regressionSummary(ctxOnlyDiff);

  lines.push('## Per-Query Diff: combined ctx+tags vs baseline');
  lines.push('');
  lines.push(`${ctxTagsSummary.regressed.length} regressed (${ctxTagsSummary.hardReg.length} hard / ${ctxTagsSummary.softReg.length} soft), ${ctxTagsSummary.improved.length} improved, ${ctxTagsSummary.same.length} unchanged`);
  lines.push('');
  lines.push('*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*');
  lines.push('');
  lines.push(...diffTable(ctxTagsDiff));
  lines.push('');
  lines.push(...regressionDetail('combined ctx+tags', ctxTagsDiff));

  lines.push('## Per-Query Diff: combined ctx-only vs baseline');
  lines.push('');
  lines.push(`${ctxOnlySummary.regressed.length} regressed (${ctxOnlySummary.hardReg.length} hard / ${ctxOnlySummary.softReg.length} soft), ${ctxOnlySummary.improved.length} improved, ${ctxOnlySummary.same.length} unchanged`);
  lines.push('');
  lines.push('*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*');
  lines.push('');
  lines.push(...diffTable(ctxOnlyDiff));
  lines.push('');
  lines.push(...regressionDetail('combined ctx-only', ctxOnlyDiff));

  // Hypothesis answer
  lines.push('## Hypothesis Answer');
  lines.push('');

  const ctxTagsMrrDelta = (ctxTagsMetrics.mrr10 ?? 0) - (bMetrics.mrr10 ?? 0);
  const ctxOnlyMrrDelta = (ctxOnlyMetrics.mrr10 ?? 0) - (bMetrics.mrr10 ?? 0);
  const ctxOnlyVsCtxTags = (ctxOnlyMetrics.mrr10 ?? 0) - (ctxTagsMetrics.mrr10 ?? 0);

  lines.push(`| Comparison | MRR@10 Δ | nDCG@10 Δ | Hard regressions |`);
  lines.push(`|------------|----------|-----------|-----------------|`);
  lines.push(`| ctx+tags vs baseline | ${delta(ctxTagsMrrDelta)} | ${delta((ctxTagsMetrics.ndcgK??0)-(bMetrics.ndcgK??0))} | ${ctxTagsSummary.hardReg.length} |`);
  lines.push(`| ctx-only vs baseline | ${delta(ctxOnlyMrrDelta)} | ${delta((ctxOnlyMetrics.ndcgK??0)-(bMetrics.ndcgK??0))} | ${ctxOnlySummary.hardReg.length} |`);
  const hardRegDiff = ctxOnlySummary.hardReg.length - ctxTagsSummary.hardReg.length;
  const hardRegDiffStr = hardRegDiff === 0 ? '—'
    : hardRegDiff > 0 ? `ctx-only has ${hardRegDiff} more`
    : `ctx-only has ${-hardRegDiff} fewer`;
  lines.push(`| ctx-only vs ctx+tags | ${delta(ctxOnlyVsCtxTags)} | ${delta((ctxOnlyMetrics.ndcgK??0)-(ctxTagsMetrics.ndcgK??0))} | ${hardRegDiffStr} |`);
  lines.push('');

  // Interpret
  const ctxOnlyRecovered = ctxOnlyVsCtxTags > 0.01;
  const ctxOnlyNeutral   = Math.abs(ctxOnlyVsCtxTags) <= 0.01;

  if (ctxOnlyRecovered) {
    lines.push('**HYPOTHESIS SUPPORTED**: ctx-only recovers quality vs ctx+tags (MRR@10 Δ > +0.01).');
    lines.push('The dual-task prompt (context + tags in one call) is likely degrading context quality.');
    lines.push('Combined mode with context-only prompt is worth investigating as a production path.');
  } else if (ctxOnlyNeutral) {
    lines.push('**HYPOTHESIS NEUTRAL**: ctx-only and ctx+tags perform similarly (MRR@10 Δ ≤ 0.01).');
    lines.push('The tags field in the prompt is not the primary cause of combined-mode regressions.');
    lines.push('Regression source is likely prompt wording / JSON constraint / LLM variance.');
  } else {
    lines.push('**HYPOTHESIS REJECTED**: ctx-only does not recover quality vs ctx+tags.');
    lines.push('The tags field in the prompt is not degrading context. Regression source is');
    lines.push('likely the combined prompt wording itself, JSON format constraint, or LLM variance.');
  }
  lines.push('');

  lines.push('## Notes');
  lines.push('');
  lines.push('- `BENCH_COMBINED_CONTEXT_ONLY=1` is a benchmark-only flag in `src/indexer/phases/combined.js`.');
  lines.push('  Do not use it in production. Not documented as stable config.');
  lines.push('- ctx-only variant stores tags=[] — tag-based retrieval (qdrant_find_by_tag) not usable for those chunks.');
  lines.push('- Production default (baseline separate path) unchanged.');
  lines.push('');
  lines.push(`*Generated: ${dateStr}*`);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[ablation] Combined context-only ablation — custom-50');
  console.log(`  model: ${MODEL}`);
  if (!QDRANT_URL) { console.error('[ablation] QDRANT_URL not set'); process.exit(1); }

  const allCollections = [COL_BASELINE, COL_CTX_TAGS, COL_CTX_ONLY];

  try {
    buildCorpus();
    console.log(`  corpus built: ${FIXTURE_FILES.length} files → ${CORPUS_DIR}`);

    for (const name of allCollections) await ensureBenchCollection(name);

    // ── Baseline: separate context + tags ────────────────────────────────────
    const baseRun = runIndexer(COL_BASELINE, {
      DENSE_PROVIDER:           'bge-m3-onnx',
      SPARSE_PROVIDER:          'bge-m3-onnx',
      ONNX_EMBED:               '1',
      COMBINED_LLM:             '0',
      CONTEXT_MODEL:            MODEL,
      TAG_MODEL:                MODEL,
      TAG_GEN:                  '1',
      BENCH_CONTEXT_POLICY:     'current-minimal',
      BENCH_COMBINED_CONTEXT_ONLY: '0',
    }, CHUNKS_BASELINE, `baseline separate (${MODEL})`);

    // ── Combined ctx+tags ────────────────────────────────────────────────────
    const ctxTagsRun = runIndexer(COL_CTX_TAGS, {
      DENSE_PROVIDER:           'bge-m3-onnx',
      SPARSE_PROVIDER:          'bge-m3-onnx',
      ONNX_EMBED:               '1',
      COMBINED_LLM:             '1',
      CONTEXT_MODEL:            MODEL,
      TAG_MODEL:                '',
      TAG_GEN:                  '1',
      BENCH_CONTEXT_POLICY:     'current-minimal',
      BENCH_COMBINED_CONTEXT_ONLY: '0',
    }, CHUNKS_CTX_TAGS, `combined ctx+tags (${MODEL})`);

    // ── Combined ctx-only ────────────────────────────────────────────────────
    const ctxOnlyRun = runIndexer(COL_CTX_ONLY, {
      DENSE_PROVIDER:           'bge-m3-onnx',
      SPARSE_PROVIDER:          'bge-m3-onnx',
      ONNX_EMBED:               '1',
      COMBINED_LLM:             '1',
      CONTEXT_MODEL:            MODEL,
      TAG_MODEL:                '',
      TAG_GEN:                  '1',
      BENCH_CONTEXT_POLICY:     'current-minimal',
      BENCH_COMBINED_CONTEXT_ONLY: '1',
    }, CHUNKS_CTX_ONLY, `combined ctx-only (${MODEL})`);

    if (!baseRun.ok || !ctxTagsRun.ok || !ctxOnlyRun.ok) {
      throw new Error('one or more indexing runs failed — aborting');
    }

    console.log('\n[ablation] Fetching point counts...');
    const baseCount    = await countPoints(COL_BASELINE);
    const ctxTagsCount = await countPoints(COL_CTX_TAGS);
    const ctxOnlyCount = await countPoints(COL_CTX_ONLY);
    console.log(`  baseline: ${baseCount} points`);
    console.log(`  ctx+tags: ${ctxTagsCount} points`);
    console.log(`  ctx-only: ${ctxOnlyCount} points`);
    if (baseCount === 0) throw new Error('baseline collection is empty after indexing');

    const raw     = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
    const queries = raw.queries.map(normaliseQuery);
    console.log(`\n[ablation] Loaded ${queries.length} queries`);

    const bResults       = await runAllQueries(COL_BASELINE, queries, 'baseline');
    const ctxTagsResults = await runAllQueries(COL_CTX_TAGS, queries, 'combined ctx+tags');
    const ctxOnlyResults = await runAllQueries(COL_CTX_ONLY, queries, 'combined ctx-only');

    const bMetrics        = computeMetrics(bResults);
    const ctxTagsMetrics  = computeMetrics(ctxTagsResults);
    const ctxOnlyMetrics  = computeMetrics(ctxOnlyResults);
    const ctxTagsDiff     = queryDiff(bResults, ctxTagsResults, queries);
    const ctxOnlyDiff     = queryDiff(bResults, ctxOnlyResults, queries);

    const { hardReg: ctH, softReg: ctS, improved: ctI } = regressionSummary(ctxTagsDiff);
    const { hardReg: coH, softReg: coS, improved: coI } = regressionSummary(ctxOnlyDiff);
    console.log(`\n[ablation] ctx+tags:  MRR@10 baseline=${f3(bMetrics.mrr10)} combined=${f3(ctxTagsMetrics.mrr10)} Δ=${delta((ctxTagsMetrics.mrr10??0)-(bMetrics.mrr10??0))}`);
    console.log(`  regressions: ${ctH.length} hard / ${ctS.length} soft   improvements: ${ctI.length}`);
    console.log(`\n[ablation] ctx-only:  MRR@10 baseline=${f3(bMetrics.mrr10)} combined=${f3(ctxOnlyMetrics.mrr10)} Δ=${delta((ctxOnlyMetrics.mrr10??0)-(bMetrics.mrr10??0))}`);
    console.log(`  regressions: ${coH.length} hard / ${coS.length} soft   improvements: ${coI.length}`);

    const now     = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');
    const report  = buildReport({
      dateStr, baseRun, baseCount, ctxTagsRun, ctxTagsCount, ctxOnlyRun, ctxOnlyCount,
      bMetrics, ctxTagsMetrics, ctxOnlyMetrics, ctxTagsDiff, ctxOnlyDiff,
    });

    mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = join(RESULTS_DIR, `${dateStr}T${timeStr}-combined-context-only-ablation.md`);
    writeFileSync(outPath, report, 'utf8');
    console.log(`\n[ablation] Report: ${outPath}`);

  } finally {
    if (!KEEP) {
      console.log('\n[ablation] Cleaning up collections...');
      for (const name of allCollections) await deleteBenchCollection(name);
      cleanupConfigEntries(allCollections);
    } else {
      console.log(`\n[ablation] KEEP_COLLECTIONS=1 — retained: ${allCollections.join(', ')}`);
    }
    cleanupTransient();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
