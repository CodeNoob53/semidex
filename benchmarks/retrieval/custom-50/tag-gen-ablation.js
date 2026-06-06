/**
 * TAG_GEN=0 ablation — quality + latency benchmark against custom-50.
 *
 * Runs the production indexer twice on the same custom-50 fixture corpus:
 *   A. baseline  — default pipeline (TAG_GEN=1, tags generated)
 *   B. tag-off   — TAG_GEN=0 (tags skipped, tags:[] stored)
 *
 * Then runs all 50 queries against both collections using the same hybrid
 * search as run-v3.js, computes identical metrics, and writes a diff report.
 *
 * Also validates that TAG_GEN=0 payloads actually have empty tags via scroll.
 *
 * Usage:
 *   node benchmarks/retrieval/custom-50/tag-gen-ablation.js
 *   npm run bench:custom50:tag-gen
 *
 * Requires: Qdrant reachable, Ollama running with CONTEXT_MODEL + TAG_MODEL pulled.
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
  deleteCollection,
  hybridSearch,
} from '../../../src/core/qdrant.js';
import { stableSortResults } from './sort-results.js';
import { embedForSearch } from '../../../src/core/embeddings.js';
import { loadConfig, saveConfig } from '../../../src/core/config.js';

const ROOT         = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const QUERIES_PATH = join(ROOT, 'benchmarks', 'retrieval', 'custom-50', 'queries.json');
const FIXTURES_SHARED = join(ROOT, 'benchmarks', 'retrieval', 'fixtures', 'docs');
const FIXTURES_OWN    = join(ROOT, 'benchmarks', 'retrieval', 'custom-50', 'fixtures', 'docs');
const RESULTS_DIR  = join(ROOT, 'benchmarks', 'retrieval', 'results');
const KEEP         = process.env.KEEP_COLLECTIONS === '1';
const TOP_K        = 10;
const BENCH_WINDOW = 1;

const CONTEXT_MODEL = process.env.CONTEXT_MODEL || 'gemma3:4b';
const TAG_MODEL     = process.env.TAG_MODEL     || 'gemma3:4b';
const QDRANT_URL    = (process.env.QDRANT_URL ?? '').replace(/\/$/, '');

const STAMP        = Date.now();
const COL_BASELINE = `bench-c50-tag-on-${STAMP}`;
const COL_TAGOFF   = `bench-c50-tag-off-${STAMP}`;

const CORPUS_DIR      = join(ROOT, '.tmp', `bench-c50-tag-corpus-${STAMP}`);
const CHUNKS_BASELINE = join(ROOT, '.tmp', `bench-c50-tag-chunks-on-${STAMP}`);
const CHUNKS_TAGOFF   = join(ROOT, '.tmp', `bench-c50-tag-chunks-off-${STAMP}`);

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
      console.error(`[tag-ablation] Fixture missing: ${src}`);
      process.exit(1);
    }
    copyFileSync(src, join(CORPUS_DIR, name));
  }
}

function cleanupTransient() {
  try { rmSync(CORPUS_DIR,      { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(CHUNKS_BASELINE, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(CHUNKS_TAGOFF,   { recursive: true, force: true }); } catch { /* ignore */ }
}

function cleanupConfigEntries() {
  try {
    const cfg = loadConfig();
    if (!cfg.collections) return;
    delete cfg.collections[COL_BASELINE];
    delete cfg.collections[COL_TAGOFF];
    saveConfig(cfg);
  } catch { /* best-effort */ }
}

// ── Qdrant collection management ──────────────────────────────────────────────

async function deleteBenchCollection(name) {
  try {
    await deleteCollection(name);
    console.log(`  [cleanup] deleted collection "${name}"`);
  } catch {
    console.log(`  [cleanup] could not delete "${name}" (may not exist)`);
  }
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
    try {
      data = await scrollPage(collection, offset);
    } catch (e) {
      if (offset === null && e.message === 'fetch failed') {
        console.log('  [scroll] network error on first page — retrying once...');
        await new Promise(r => setTimeout(r, 2000));
        data = await scrollPage(collection, offset);
      } else {
        throw e;
      }
    }
    const batch = data?.result?.points ?? [];
    points.push(...batch);
    offset = data?.result?.next_page_offset ?? null;
    if (offset === null || batch.length === 0) break;
  }
  return points;
}

async function countPoints(collection) {
  return (await scrollAll(collection)).length;
}

// Validate TAG_GEN=0 payload: check tags field on a sample of points.
async function auditTagPayloads(collection) {
  const points = await scrollAll(collection);
  const sample = points.slice(0, 20);
  const withTags    = sample.filter(p => Array.isArray(p.payload?.tags) && p.payload.tags.length > 0).length;
  const emptyTags   = sample.filter(p => Array.isArray(p.payload?.tags) && p.payload.tags.length === 0).length;
  const missingTags = sample.filter(p => !Array.isArray(p.payload?.tags)).length;
  return { total: points.length, sampleSize: sample.length, withTags, emptyTags, missingTags };
}

// ── Indexer runner ────────────────────────────────────────────────────────────

function runIndexer(collection, extraEnv, chunksOutDir, label) {
  console.log(`\n[tag-ablation] Running ${label}...`);
  const env = {
    ...process.env,
    COLLECTION:    collection,
    SOURCE_ROOT:   CORPUS_DIR,
    ONNX_EMBED:    '1',
    CONTEXT_MODEL: CONTEXT_MODEL,
    TAG_MODEL:     TAG_MODEL,
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
    console.error(`  [tag-ablation] ${label} FAILED (exit ${result.status})`);
    console.error(stderr.slice(-3000));
    return { ok: false, totalMs, stdout, stderr, phases: {}, tagFallbacks: 0, indexed: 0 };
  }

  const phases       = parseProfilerOutput(stdout);
  const tagFallbacks = (stderr.match(/\[tag\] batch parse failed/g) ?? []).length;
  const indexedMatch = stdout.match(/(\d+) indexed/);
  const indexed      = indexedMatch ? parseInt(indexedMatch[1], 10) : 0;

  console.log(`  done in ${totalMs} ms — exit 0`);
  console.log(`  indexed ${indexed} file(s)`);
  if (tagFallbacks) console.log(`  [tag] batch fallbacks: ${tagFallbacks}`);

  return { ok: true, totalMs, stdout, stderr, phases, tagFallbacks, indexed };
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

// ── Metric helpers (mirrors run-v3.js) ────────────────────────────────────────

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
    if (chunkRecallHit(results, query.qrels, 3,     3)) cr3++;
    if (chunkRecallHit(results, query.qrels, 5,     3)) cr5++;
    if (chunkRecallHit(results, query.qrels, TOP_K, 3)) cr10++;
    if (windowRecallHit(results, query.qrels, 5,     BENCH_WINDOW)) wr5++;
    if (windowRecallHit(results, query.qrels, TOP_K, BENCH_WINDOW)) wr10++;
    if (chunkRecallHit(results, query.qrels, TOP_K, 2)) supp++;
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
  const results = stableSortResults(await hybridSearch(collection, dense, sparse, TOP_K));
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

function queryDiff(bResults, tResults, queries) {
  const rows = [];
  for (const q of queries) {
    if (q.shouldHaveNoStrongHit) continue;
    const br = bResults.find(r => r.query.id === q.id);
    const tr = tResults.find(r => r.query.id === q.id);
    if (!br || !tr) continue;

    const bMrr  = mrr(br.results, q.qrels, 10, 3) ?? 0;
    const tMrr  = mrr(tr.results, q.qrels, 10, 3) ?? 0;
    const bNdcg = gradedNDCG(br.results, q.qrels, TOP_K) ?? 0;
    const tNdcg = gradedNDCG(tr.results, q.qrels, TOP_K) ?? 0;
    const bCr5  = chunkRecallHit(br.results, q.qrels, 5, 3) ? 1 : 0;
    const tCr5  = chunkRecallHit(tr.results, q.qrels, 5, 3) ? 1 : 0;

    const mrrDelta  = tMrr  - bMrr;
    const ndcgDelta = tNdcg - bNdcg;

    let change = 'same';
    if      (mrrDelta >  0.001) change = 'improved';
    else if (mrrDelta < -0.001) change = 'regressed';

    rows.push({
      id: q.id, type: q.type,
      bMrr, tMrr, mrrDelta,
      bNdcg, tNdcg, ndcgDelta,
      bCr5, tCr5,
      change,
    });
  }
  return rows;
}

// ── Report builder ────────────────────────────────────────────────────────────

function pct(v)   { return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`; }
function f3(v)    { return v === null || v === undefined ? 'n/a' : v.toFixed(3); }
function delta(v) {
  if (Math.abs(v) < 0.001) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(3);
}

function buildReport({ dateStr, baselineRun, tagoffRun, bMetrics, tMetrics, diffRows, baselineCount, tagoffCount, tagAudit }) {
  const lines = [];
  lines.push(`# TAG_GEN=0 Ablation — custom-50 Retrieval Quality + Latency — ${dateStr}`);
  lines.push('');
  lines.push('## Purpose');
  lines.push('');
  lines.push('Verify that disabling tag generation (`TAG_GEN=0`) does not degrade hybrid RRF');
  lines.push('retrieval quality, and measure the indexing latency difference (tag phase cost).');
  lines.push('');
  lines.push('Tags are payload-only metadata — not embedded into dense/sparse vectors.');
  lines.push('Default hybrid RRF search is tag-agnostic. This benchmark confirms that empirically.');
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push('| Item | Value |');
  lines.push('|------|-------|');
  lines.push(`| Node.js | ${process.version} |`);
  lines.push(`| CONTEXT_MODEL | ${CONTEXT_MODEL} |`);
  lines.push(`| TAG_MODEL | ${TAG_MODEL} |`);
  lines.push(`| ONNX_EMBED | 1 |`);
  lines.push(`| ONNX_EXECUTION_PROVIDER | ${process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu (default)'} |`);
  lines.push(`| Corpus | custom-50 fixture docs (10 files) |`);
  lines.push(`| Queries | 50 (v3 schema, graded chunk-level qrels) |`);
  lines.push(`| Search mode | hybrid (RRF) |`);
  lines.push(`| Top-K | ${TOP_K} |`);
  lines.push('');
  lines.push('## Indexing');
  lines.push('');
  lines.push('| Run | TAG_GEN | Exit | Points | Wall time | Phase context (mean/file) | Phase tag (mean/file) | Tag batch fallbacks |');
  lines.push('|-----|---------|------|--------|-----------|--------------------------|----------------------|---------------------|');

  const bCtx = baselineRun.phases?.context ?? 0;
  const bTag = baselineRun.phases?.tag     ?? 0;
  const tCtx = tagoffRun.phases?.context   ?? 0;
  const tTag = tagoffRun.phases?.tag       ?? 0;

  lines.push(`| Baseline | 1 (default) | ${baselineRun.ok ? 'OK' : 'FAIL'} | ${baselineCount ?? '?'} | ${baselineRun.totalMs} ms | ${bCtx} ms | ${bTag} ms | ${baselineRun.tagFallbacks} |`);
  lines.push(`| TAG_GEN=0 | 0 (disabled) | ${tagoffRun.ok ? 'OK' : 'FAIL'} | ${tagoffCount ?? '?'} | ${tagoffRun.totalMs} ms | ${tCtx} ms | ${tTag} ms | n/a |`);
  lines.push('');

  const tagSaving = baselineRun.totalMs > 0
    ? `${(((baselineRun.totalMs - tagoffRun.totalMs) / baselineRun.totalMs) * 100).toFixed(1)}%`
    : 'n/a';
  const tagPhaseSaving = bTag > 0
    ? `${(((bTag - tTag) / bTag) * 100).toFixed(1)}%`
    : 'n/a';

  lines.push(`Wall-time saving (TAG_GEN=0 vs baseline): ${tagoffRun.totalMs > 0 ? (baselineRun.totalMs - tagoffRun.totalMs) + ' ms' : 'n/a'} (${tagSaving} total), tag phase: ${bTag - tTag} ms (${tagPhaseSaving})`);
  lines.push('');
  lines.push('## TAG_GEN=0 Payload Audit');
  lines.push('');
  lines.push('Scroll sample of TAG_GEN=0 collection to confirm `tags: []` is stored correctly.');
  lines.push('');
  if (tagAudit) {
    lines.push(`| Field | Count (sample ${tagAudit.sampleSize} of ${tagAudit.total} points) |`);
    lines.push('|-------|------|');
    lines.push(`| tags: [] (empty, correct) | ${tagAudit.emptyTags} |`);
    lines.push(`| tags: [...] (non-empty, unexpected) | ${tagAudit.withTags} |`);
    lines.push(`| tags field missing | ${tagAudit.missingTags} |`);
    lines.push('');
    if (tagAudit.withTags > 0) {
      lines.push(`**WARNING:** ${tagAudit.withTags}/${tagAudit.sampleSize} sampled points have non-empty tags in the TAG_GEN=0 collection. Review \`shouldGenerateTags\` logic.`);
    } else if (tagAudit.missingTags > 0) {
      lines.push(`**WARN:** ${tagAudit.missingTags}/${tagAudit.sampleSize} points missing tags field entirely.`);
    } else {
      lines.push(`All ${tagAudit.sampleSize} sampled points have \`tags: []\` — TAG_GEN=0 payload storage confirmed correct.`);
    }
  } else {
    lines.push('Payload audit skipped (collection unavailable).');
  }
  lines.push('');
  lines.push('## Aggregate Metrics');
  lines.push('');
  lines.push('| Metric | Baseline (TAG_GEN=1) | TAG_GEN=0 | Delta |');
  lines.push('|--------|---------------------|-----------|-------|');

  function mrow(label, bv, tv) {
    const d = (bv !== null && tv !== null) ? delta(tv - bv) : '—';
    return `| ${label} | ${f3(bv)} | ${f3(tv)} | ${d} |`;
  }
  function prow(label, bv, tv) {
    const d = (bv !== null && tv !== null) ? delta(tv - bv) : '—';
    return `| ${label} | ${pct(bv)} | ${pct(tv)} | ${d} |`;
  }

  lines.push(prow('chunkRecall@3',    bMetrics.chunkRecall3,    tMetrics.chunkRecall3));
  lines.push(prow('chunkRecall@5',    bMetrics.chunkRecall5,    tMetrics.chunkRecall5));
  lines.push(prow('chunkRecall@10',   bMetrics.chunkRecall10,   tMetrics.chunkRecall10));
  lines.push(prow('windowRecall@5',   bMetrics.windowRecall5,   tMetrics.windowRecall5));
  lines.push(prow('windowRecall@10',  bMetrics.windowRecall10,  tMetrics.windowRecall10));
  lines.push(prow('supportRecall@10', bMetrics.supportRecallK,  tMetrics.supportRecallK));
  lines.push(mrow('nDCG@10',          bMetrics.ndcgK,           tMetrics.ndcgK));
  lines.push(mrow('MRR@10',           bMetrics.mrr10,           tMetrics.mrr10));
  lines.push(prow('negativePass',     bMetrics.negativePassRate, tMetrics.negativePassRate));
  lines.push('');
  lines.push('## Per-Query Diff (positive queries only)');
  lines.push('');

  const regressed = diffRows.filter(r => r.change === 'regressed');
  const improved  = diffRows.filter(r => r.change === 'improved');
  const same      = diffRows.filter(r => r.change === 'same');
  const hardReg   = regressed.filter(r => r.bCr5 && !r.tCr5);
  const softReg   = regressed.filter(r => !(r.bCr5 && !r.tCr5));

  lines.push(`${regressed.length} regressed (${hardReg.length} hard / ${softReg.length} soft), ${improved.length} improved, ${same.length} unchanged (by MRR@10 Δ > 0.001)`);
  lines.push('');
  lines.push('*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*');
  lines.push('');
  lines.push('| ID | type | base MRR | off MRR | ΔMRR | base nDCG | off nDCG | ΔnDCG | bCr5 | oCr5 | change |');
  lines.push('|----|------|----------|---------|------|-----------|----------|-------|------|------|--------|');

  const sortedRows = [...diffRows].sort((a, b) => a.mrrDelta - b.mrrDelta);
  for (const r of sortedRows) {
    const changeLabel = r.change === 'regressed' ? '**regressed**' : r.change === 'improved' ? 'improved' : '—';
    lines.push(`| ${r.id} | ${r.type} | ${f3(r.bMrr)} | ${f3(r.tMrr)} | ${delta(r.mrrDelta)} | ${f3(r.bNdcg)} | ${f3(r.tNdcg)} | ${delta(r.ndcgDelta)} | ${r.bCr5 ? '✓' : '✗'} | ${r.tCr5 ? '✓' : '✗'} | ${changeLabel} |`);
  }
  lines.push('');

  lines.push('## Verdict');
  lines.push('');

  const bothOk      = baselineRun.ok && tagoffRun.ok;
  const countOk     = baselineCount !== null && tagoffCount !== null && Math.abs(baselineCount - tagoffCount) <= 2;
  const mrrDelta    = (tMetrics.mrr10 ?? 0) - (bMetrics.mrr10 ?? 0);
  const hardRegCount = diffRows.filter(r => r.change === 'regressed' && r.bCr5 && !r.tCr5).length;
  const payloadOk   = tagAudit ? tagAudit.withTags === 0 && tagAudit.missingTags === 0 : null;

  if (!bothOk) {
    lines.push('**blocked** — one or both indexing runs failed. See Indexing table above.');
  } else if (!countOk) {
    lines.push(`**blocked** — point counts differ significantly (baseline: ${baselineCount}, tag-off: ${tagoffCount}). Check for indexing errors.`);
  } else if (payloadOk === false) {
    lines.push(`**blocked** — TAG_GEN=0 payload audit failed: ${tagAudit?.withTags} points have non-empty tags. Review shouldGenerateTags() implementation.`);
  } else if (hardRegCount === 0 && mrrDelta >= -0.02) {
    lines.push('**confirmed** — TAG_GEN=0 has no retrieval quality impact on custom-50 hybrid RRF.');
    lines.push('');
    lines.push(`MRR@10 delta: ${delta(mrrDelta)}. chunkRecall@5 delta: ${delta((tMetrics.chunkRecall5 ?? 0) - (bMetrics.chunkRecall5 ?? 0))}. Hard regressions: 0.`);
    lines.push('');
    lines.push('This is expected: tags are payload-only and not embedded. TAG_GEN=0 is safe to use');
    lines.push('for automated pipelines where `qdrant_find_by_tag` is not needed.');
    lines.push('');
    lines.push(`Indexing wall-time: ${tagoffRun.totalMs} ms vs ${baselineRun.totalMs} ms baseline (${tagSaving} faster).`);
    if (tagAudit) {
      lines.push(`Payload audit: all ${tagAudit.sampleSize} sampled points confirmed \`tags: []\`.`);
    }
  } else {
    lines.push(`**unexpected** — ${hardRegCount} hard regression(s) detected. MRR@10 delta: ${delta(mrrDelta)}.`);
    lines.push('');
    lines.push('Hard regressions are unexpected since tags are not embedded. Investigate whether');
    lines.push('the context phase produced different output between the two runs (model temperature,');
    lines.push('Ollama state, or ordering effects).');
  }

  lines.push('');
  lines.push(`*Generated: ${dateStr} — collections: ${COL_BASELINE}, ${COL_TAGOFF}*`);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[tag-ablation] TAG_GEN=0 ablation — custom-50 quality + latency');
  console.log(`  CONTEXT_MODEL: ${CONTEXT_MODEL}`);
  console.log(`  TAG_MODEL:     ${TAG_MODEL}`);
  console.log(`  collections:   ${COL_BASELINE}  |  ${COL_TAGOFF}`);
  console.log(`  corpus:        ${CORPUS_DIR}`);

  if (!QDRANT_URL) {
    console.error('[tag-ablation] QDRANT_URL not set');
    process.exit(1);
  }

  try {
    buildCorpus();
    console.log(`  corpus built: ${FIXTURE_FILES.length} files`);

    // ── A: baseline indexing (explicit TAG_GEN=1) ────────────────────────────
    const baselineRun = runIndexer(COL_BASELINE, { TAG_GEN: '1' }, CHUNKS_BASELINE, 'A: baseline (TAG_GEN=1)');

    // ── B: tag-off indexing (TAG_GEN=0) ──────────────────────────────────────
    const tagoffRun = runIndexer(COL_TAGOFF, { TAG_GEN: '0' }, CHUNKS_TAGOFF, 'B: TAG_GEN=0');

    if (!baselineRun.ok || !tagoffRun.ok) {
      throw new Error('one or both indexing runs failed — aborting quality check');
    }

    // ── Point count check ────────────────────────────────────────────────────
    console.log('\n[tag-ablation] Fetching point counts...');
    const baselineCount = await countPoints(COL_BASELINE);
    const tagoffCount   = await countPoints(COL_TAGOFF);
    console.log(`  baseline: ${baselineCount} points`);
    console.log(`  tag-off:  ${tagoffCount} points`);

    if (baselineCount === 0 || tagoffCount === 0) {
      throw new Error(`empty collection after indexing (baseline: ${baselineCount}, tag-off: ${tagoffCount})`);
    }

    // ── Payload audit for TAG_GEN=0 collection ───────────────────────────────
    console.log('\n[tag-ablation] Auditing TAG_GEN=0 payloads...');
    const tagAudit = await auditTagPayloads(COL_TAGOFF);
    console.log(`  sample ${tagAudit.sampleSize}/${tagAudit.total} points: empty_tags=${tagAudit.emptyTags}, with_tags=${tagAudit.withTags}, missing=${tagAudit.missingTags}`);
    if (tagAudit.withTags > 0) {
      console.warn(`  [WARN] ${tagAudit.withTags} points have non-empty tags — TAG_GEN=0 may not be working`);
    }

    // ── Load queries ─────────────────────────────────────────────────────────
    const raw     = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
    const queries = raw.queries.map(normaliseQuery);
    console.log(`\n[tag-ablation] Loaded ${queries.length} queries`);

    // ── Run queries against baseline ─────────────────────────────────────────
    console.log('\n[tag-ablation] Querying baseline collection...');
    const bResults = await runAllQueries(COL_BASELINE, queries);

    // ── Run queries against tag-off ──────────────────────────────────────────
    console.log('\n[tag-ablation] Querying TAG_GEN=0 collection...');
    const tResults = await runAllQueries(COL_TAGOFF, queries);

    // ── Compute metrics ──────────────────────────────────────────────────────
    const bMetrics = computeMetrics(bResults);
    const tMetrics = computeMetrics(tResults);

    // ── Per-query diff ───────────────────────────────────────────────────────
    const diffRows = queryDiff(bResults, tResults, queries);
    const regressed    = diffRows.filter(r => r.change === 'regressed');
    const improved     = diffRows.filter(r => r.change === 'improved');
    const hardRegressed = regressed.filter(r => r.bCr5 && !r.tCr5);
    const softRegressed = regressed.filter(r => !(r.bCr5 && !r.tCr5));

    // ── Write report ─────────────────────────────────────────────────────────
    const now     = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');

    const report = buildReport({
      dateStr, baselineRun, tagoffRun,
      bMetrics, tMetrics, diffRows,
      baselineCount, tagoffCount, tagAudit,
    });

    mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = join(RESULTS_DIR, `${dateStr}T${timeStr}-tag-gen-ablation-custom50.md`);
    writeFileSync(outPath, report, 'utf8');
    console.log(`\n[tag-ablation] Report: ${outPath}`);

    // ── Console summary ──────────────────────────────────────────────────────
    console.log('\n[tag-ablation] Summary');
    console.log(`  Baseline points: ${baselineCount}  TAG_GEN=0 points: ${tagoffCount}`);
    console.log(`  Wall time:       baseline=${baselineRun.totalMs}ms  tag-off=${tagoffRun.totalMs}ms`);
    console.log(`  MRR@10:          baseline=${f3(bMetrics.mrr10)}  tag-off=${f3(tMetrics.mrr10)}  Δ=${delta((tMetrics.mrr10 ?? 0) - (bMetrics.mrr10 ?? 0))}`);
    console.log(`  nDCG@10:         baseline=${f3(bMetrics.ndcgK)}  tag-off=${f3(tMetrics.ndcgK)}  Δ=${delta((tMetrics.ndcgK ?? 0) - (bMetrics.ndcgK ?? 0))}`);
    console.log(`  chunkRecall@5:   baseline=${pct(bMetrics.chunkRecall5)}  tag-off=${pct(tMetrics.chunkRecall5)}`);
    console.log(`  Regressions:     ${regressed.length} (${hardRegressed.length} hard / ${softRegressed.length} soft)  Improvements: ${improved.length}`);
    if (hardRegressed.length > 0) console.log(`  Hard reg IDs:    ${hardRegressed.map(r => r.id).join(', ')}`);
    console.log(`  Payload audit:   empty_tags=${tagAudit.emptyTags}/${tagAudit.sampleSize} correct`);

  } finally {
    if (!KEEP) {
      console.log('\n[tag-ablation] Cleaning up collections...');
      await deleteBenchCollection(COL_BASELINE);
      await deleteBenchCollection(COL_TAGOFF);
      cleanupConfigEntries();
    } else {
      console.log(`\n[tag-ablation] KEEP_COLLECTIONS=1 — retained: ${COL_BASELINE}, ${COL_TAGOFF}`);
    }
    cleanupTransient();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
