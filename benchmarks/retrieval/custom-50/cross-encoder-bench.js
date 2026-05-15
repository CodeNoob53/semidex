// Cross-encoder rerank benchmark for custom-50.
//
// Runs four candidates against the same ONNX index and produces a side-by-side
// aggregate comparison plus per-query delta table and a promotion gate checklist.
//
// Candidates:
//   hybrid-true      hybridSearch(TOP_K)                          — true baseline
//   hybrid-prefetch  hybridSearch(TOP_K × MULT).slice(0, TOP_K)   — isolates prefetch effect
//   det-rerank       rerankResults() on prefetch pool              — current deterministic default
//   cross-encoder    AutoModel logits on prefetch pool             — experimental
//
// Usage:
//   npm run bench:custom50:ce
//   BENCH_SKIP_INDEX=1 npm run bench:custom50:ce
//   CE_MODEL=cross-encoder/ms-marco-MiniLM-L-6-v2 npm run bench:custom50:ce
//   CE_INPUT=text+section npm run bench:custom50:ce

if (process.argv.includes('--help')) {
  process.stdout.write(`custom-50 cross-encoder rerank benchmark

Usage:
  npm run bench:custom50:ce
  BENCH_SKIP_INDEX=1 npm run bench:custom50:ce

Candidates compared:
  hybrid-true      hybridSearch(TOP_K) — true baseline, separate Qdrant call
  hybrid-prefetch  slice(0, TOP_K) of shared prefetch pool — isolates prefetch effect
  det-rerank       rerankResults() on shared pool (current defaults, intro penalty=0.02)
  cross-encoder    AutoModelForSequenceClassification raw logits on shared pool

Environment:
  CE_MODEL                 HF model ID or local path (default: cross-encoder/ms-marco-MiniLM-L-6-v2)
  CE_INPUT                 text | text+section | text+meta  (default: text)
  CE_DTYPE                 Model dtype passed to from_pretrained (default: fp32; use q4/int8/q8 for quantized ONNX repos)
  CE_BATCH_SIZE            Pairs per tokenizer/model call (default: 16)
  CE_PROTECT_TOP1_DELTA    CE logit margin to displace RRF rank-0 (default: 0 = off)
  BENCH_TOP_K              Search depth (default: 10)
  BENCH_SKIP_INDEX         1 = reuse existing collection
  RERANK_PREFETCH_MULT     Candidate multiplier for rerank/CE pool (default: 4)

Output:
  benchmarks/retrieval/results/YYYY-MM-DD-custom50-ce-bench-{model_slug}-{dtype}-{input_mode}.txt
  model_slug = last path segment of CE_MODEL, lowercased, non-alphanumeric → hyphen
  dtype      = CE_DTYPE value (fp32, q4, int8, ...)

Promotion gate (cross-encoder vs hybrid-true):
  MRR@10 >= baseline + 0.030
  chunkRecall@5 >= baseline (no regression)
  negativePass = 100%
  zero regressions: rel>=3 chunk moved from rank <=3 to rank >3
`);
  process.exit(0);
}

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { AutoTokenizer, AutoModelForSequenceClassification, env as hfEnv } from '@huggingface/transformers';

import { chunkFile } from '../../../src/indexer/phases/chunk.js';
import {
  listCollections, createCollection, deleteBySourceFile,
  upsertPoints, hybridSearch, scroll,
} from '../../../src/core/qdrant.js';
import { embedForIndex, embedForSearch, SCHEMA_VERSION } from '../../../src/core/embeddings.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../../../src/core/config.js';
import { rerankResults } from '../../../src/core/rerank.js';
import { validateQueryTypes, formatTypeDistribution } from './query-types.js';

const __dirname        = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SHARED  = resolve(__dirname, '../fixtures/docs');
const FIXTURES_OWN     = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH     = resolve(__dirname, 'queries.json');
const RESULTS_DIR      = resolve(__dirname, '../results');
const COLLECTION       = 'bench-retrieval-custom-50';

// ── Env knobs ─────────────────────────────────────────────────────────────────

function envInt(name, def, min, max) {
  const v = parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      process.stderr.write(`[ce-bench] ${name}="${process.env[name]}" invalid — using ${def}\n`);
    return def;
  }
  return v;
}

function envFloat(name, def, min, max) {
  const v = parseFloat(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      process.stderr.write(`[ce-bench] ${name}="${process.env[name]}" invalid — using ${def}\n`);
    return def;
  }
  return v;
}

const CE_MODEL              = process.env.CE_MODEL ?? 'cross-encoder/ms-marco-MiniLM-L-6-v2';
const CE_INPUT              = process.env.CE_INPUT ?? 'text';
const CE_DTYPE              = process.env.CE_DTYPE ?? 'fp32';
const CE_BATCH_SIZE         = envInt('CE_BATCH_SIZE', 16, 1, 256);
const CE_PROTECT_TOP1_DELTA = envFloat('CE_PROTECT_TOP1_DELTA', 0, 0, 100);
const TOP_K                 = envInt('BENCH_TOP_K', 10, 1, 1000);
const BENCH_WINDOW          = envInt('BENCH_WINDOW', 1, 0, 10);
const SKIP_INDEX            = process.env.BENCH_SKIP_INDEX === '1';
const RERANK_PREFETCH_MULT  = envInt('RERANK_PREFETCH_MULT', 4, 1, 100);

if (!['text', 'text+section', 'text+meta'].includes(CE_INPUT)) {
  process.stderr.write(`[ce-bench] CE_INPUT="${CE_INPUT}" invalid — use text, text+section, or text+meta\n`);
  process.exit(1);
}

// ── HF model cache — same directory as ONNX embedder ─────────────────────────

hfEnv.cacheDir = resolve(__dirname, '../../../models');

// ── Fixture files ─────────────────────────────────────────────────────────────

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

// ── Collection setup (mirrors run-v3.js) ─────────────────────────────────────

async function ensureCollection() {
  const cols = await listCollections();
  if (!cols.includes(COLLECTION)) await createCollection(COLLECTION, 1024);
  const { denseProvider, denseModel, sparseProvider } = resolveEnvProviders();
  const cfg = loadConfig();
  cfg.collections ??= {};
  cfg.collections[COLLECTION] = {
    denseProvider, denseModel, sparseProvider,
    embeddingSchemaVersion: SCHEMA_VERSION,
    vectorSize: 1024,
    description: 'custom-50 quality benchmark — auto-managed',
  };
  saveConfig(cfg);
  return { denseProvider, sparseProvider };
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
  const indexedIds  = new Set();
  const emptyChunkIds = new Set();
  for (const { name, dir } of FIXTURE_FILES) {
    const filePath  = resolve(dir, name);
    const text      = readFileSync(filePath, 'utf8');
    const sourceFile = name;
    await deleteBySourceFile(COLLECTION, sourceFile);
    const chunks = chunkFile(filePath, text, sourceFile);
    const points = [];
    for (const chunk of chunks) {
      const cid = `${sourceFile}#${chunk.chunkIndex}`;
      indexedIds.add(cid);
      if (isEmptyChunkText(chunk.text)) emptyChunkIds.add(cid);
      const { dense, sparse, meta } = await embedForIndex(COLLECTION, chunk.text);
      points.push({
        id: randomUUID(),
        vector: { dense, sparse },
        payload: {
          text: chunk.text, section: chunk.section, source_file: sourceFile,
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
  const indexedIds = new Set();
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

// ── Cross-encoder ─────────────────────────────────────────────────────────────

function buildPassage(p) {
  if (CE_INPUT === 'text+section') return `${p.section ?? ''}\n${p.text ?? ''}`;
  if (CE_INPUT === 'text+meta')    return `${p.source_file ?? ''} ${p.section ?? ''}\n${p.text ?? ''}`;
  return p.text ?? '';
}

let _ceTokenizer = null;
let _ceModel     = null;

// Resolve which column of logits.data to use as the relevance score.
// logits shape is [batchSize, numLabels]. Supported layouts:
//   numLabels=1  single regression head — use column 0 directly (raw logit, higher = more relevant)
//   numLabels=2  binary classification  — use column 1 (the "relevant/positive" logit)
// Any other numLabels is rejected at load time so ranking is never silently corrupted.
let _ceNumLabels = null;

async function loadCE() {
  if (_ceModel) return;
  process.stderr.write(`[ce] Loading ${CE_MODEL} ...\n`);
  _ceTokenizer = await AutoTokenizer.from_pretrained(CE_MODEL);
  _ceModel = await AutoModelForSequenceClassification.from_pretrained(CE_MODEL, { dtype: CE_DTYPE });

  // Determine numLabels from model config. logits.dims[1] is the authoritative source.
  // config.num_labels may be undefined for some ONNX exports, so we probe with a dummy pair.
  const probe = _ceTokenizer(['probe'], { text_pair: ['probe'], truncation: true,
    max_length: 16, return_tensors: 'pt', padding: true });
  const { logits: probeLogits } = await _ceModel(probe);
  _ceNumLabels = probeLogits.dims[1]; // [1, numLabels]

  if (_ceNumLabels === 1) {
    process.stderr.write(`[ce] Ready. numLabels=1 (regression head, using raw logit)\n`);
  } else if (_ceNumLabels === 2) {
    process.stderr.write(`[ce] Ready. numLabels=2 (binary classification, using logit[:,1] as relevance score)\n`);
  } else {
    process.stderr.write(`[ce] Error: CE_MODEL="${CE_MODEL}" has numLabels=${_ceNumLabels}. ` +
      `Only 1 (regression) and 2 (binary classification) are supported.\n`);
    process.exitCode = 1;
    process.exit();
  }
}

// Extract one relevance score per candidate from a logits tensor [batchSize, numLabels].
function extractScores(logits, batchSize) {
  const data = logits.data; // flat Float32Array, row-major: [row0col0, row0col1, row1col0, ...]
  if (data.length !== batchSize * _ceNumLabels) {
    throw new Error(`logits.data length ${data.length} !== batchSize(${batchSize}) × numLabels(${_ceNumLabels})`);
  }
  const scores = [];
  for (let row = 0; row < batchSize; row++) {
    // numLabels=1: column 0 is the only logit.
    // numLabels=2: column 1 is the positive/relevant class logit.
    const col = _ceNumLabels === 2 ? 1 : 0;
    scores.push(data[row * _ceNumLabels + col]);
  }
  return scores;
}

// Returns candidates sorted descending by relevance score.
// Confirmed call shape from spike: return_tensors 'pt' works in @huggingface/transformers v4.2.
async function ceScore(query, candidates) {
  await loadCE();
  const rawScores = [];
  for (let i = 0; i < candidates.length; i += CE_BATCH_SIZE) {
    const batch    = candidates.slice(i, i + CE_BATCH_SIZE);
    const passages = batch.map(r => buildPassage(r.payload));
    const queries  = Array(batch.length).fill(query);
    // Tokenizer called with parallel arrays: confirmed shape from spike.
    const inputs = _ceTokenizer(queries, {
      text_pair: passages, truncation: true, max_length: 512,
      return_tensors: 'pt', padding: true,
    });
    const { logits } = await _ceModel(inputs);
    for (const v of extractScores(logits, batch.length)) rawScores.push(v);
  }
  return candidates
    .map((r, i) => ({ result: r, ceScore: rawScores[i] }))
    .sort((a, b) => b.ceScore - a.ceScore);
}

// Optional top-1 protection on the CE logit scale.
// CE_PROTECT_TOP1_DELTA=0 (default) disables this entirely.
// Note: delta is in CE logit units, not deterministic score units — keep separate.
function applyTop1Protection(ceRanked, rrfTop) {
  if (!CE_PROTECT_TOP1_DELTA || !rrfTop) return ceRanked;
  const rrfEntry = ceRanked.find(x => x.result === rrfTop);
  if (!rrfEntry || ceRanked[0] === rrfEntry) return ceRanked;
  if (ceRanked[0].ceScore - rrfEntry.ceScore < CE_PROTECT_TOP1_DELTA) {
    const out = ceRanked.filter(x => x !== rrfEntry);
    out.unshift(rrfEntry);
    return out;
  }
  return ceRanked;
}

// ── Per-query runner ──────────────────────────────────────────────────────────

async function runQuery(queryText) {
  const { dense, sparse } = await embedForSearch(COLLECTION, queryText);
  const candidateLimit    = Math.max(TOP_K * RERANK_PREFETCH_MULT, TOP_K + 5);

  // True baseline: exact TOP_K from Qdrant (separate call, not a slice of the larger pool).
  const t0 = Date.now();
  const hybridTrue = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
  const hybridTrueMs = Date.now() - t0;

  // Shared prefetch pool for all three rerank candidates.
  const t1 = Date.now();
  const candidates = await hybridSearch(COLLECTION, dense, sparse, candidateLimit);
  const prefetchMs = Date.now() - t1;

  // hybrid-prefetch: top-K slice of the expanded pool (no reranking).
  const hybridPrefetch = candidates.slice(0, TOP_K);

  // det-rerank: deterministic reranker (current module defaults, intro penalty=0.02 already active).
  const t2 = Date.now();
  const detResults = rerankResults(candidates, queryText, { finalLimit: TOP_K, collection: COLLECTION });
  const detRerankMs = Date.now() - t2;

  // cross-encoder: AutoModel logits on same pool.
  const t3 = Date.now();
  const ceRanked    = await ceScore(queryText, candidates);
  const ceProtected = applyTop1Protection(ceRanked, candidates[0]);
  const ceResults   = ceProtected.slice(0, TOP_K).map(x => ({ ...x.result, score: x.ceScore }));
  const crossEncoderMs = Date.now() - t3;

  return {
    hybridTrueMs,
    prefetchMs,
    detRerankMs,
    crossEncoderMs,
    byMode: {
      'hybrid-true':      hybridTrue,
      'hybrid-prefetch':  hybridPrefetch,
      'det-rerank':       detResults,
      'cross-encoder':    ceResults,
    },
  };
}

// ── Metric helpers (mirrors run-v3.js) ────────────────────────────────────────

function resultChunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  return (sf != null && ci != null) ? `${sf}#${ci}` : null;
}

function parseChunkId(id) {
  if (!id) return null;
  const h = id.lastIndexOf('#');
  if (h < 0) return null;
  const sourceFile  = id.slice(0, h);
  const chunkIndex  = parseInt(id.slice(h + 1), 10);
  return (sourceFile && Number.isFinite(chunkIndex)) ? { sourceFile, chunkIndex } : null;
}

function buildQrels(relevantChunks) {
  const m = new Map();
  for (const rc of (relevantChunks ?? [])) m.set(rc.chunkId, rc.relevance ?? 3);
  return m;
}

function tokenise(str) { return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []; }

function chunkRecallHit(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const rel = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!rel.size) return null;
  return results.slice(0, k).some(r => rel.has(resultChunkId(r)));
}

function windowRecallHit(results, qrels, k, window) {
  if (!qrels.size) return null;
  const exactIds = [...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id);
  if (!exactIds.length) return null;
  const topK = results.slice(0, k);
  if (topK.some(r => qrels.get(resultChunkId(r)) >= 3)) return true;
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

function gradedNDCG(results, qrels, k) {
  if (!qrels.size) return null;
  const topK = results.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = qrels.get(resultChunkId(topK[i])) ?? 0;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  const gains = [...qrels.values()].map(r => Math.pow(2, r) - 1).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(gains.length, k); i++) idcg += gains[i] / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

function mrrAt(results, qrels, k) {
  if (!qrels.size) return null;
  const rel = new Set([...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id));
  if (!rel.size) return null;
  for (let i = 0; i < Math.min(results.length, k); i++) {
    if (rel.has(resultChunkId(results[i]))) return 1 / (i + 1);
  }
  return 0;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
}

// ── Aggregate metrics per mode ────────────────────────────────────────────────

const MODES = ['hybrid-true', 'hybrid-prefetch', 'det-rerank', 'cross-encoder'];

function computeAllMetrics(queryResults, emptyChunkIds) {
  const out = {};
  for (const mode of MODES) {
    let cr3=0, cr5=0, cr10=0, wr5=0, wr10=0, supp10=0, ndcgSum=0, mrrSum=0, mrrCount=0;
    let rank1Exact=0, negPass=0;
    const positives = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
    const negatives = queryResults.filter(r =>  r.query.shouldHaveNoStrongHit);
    const hasExact  = positives.filter(r => [...r.query.qrels.values()].some(v => v >= 3)).length;
    const hasAnyQrels = positives.filter(r => r.query.qrels.size > 0).length;

    // Per-mode latencies: rerank candidates include the shared prefetch Qdrant call,
    // since that call is required for those modes to produce any result.
    //   hybrid-true     : hybridTrueMs only (separate call at TOP_K)
    //   hybrid-prefetch : prefetchMs only (the expanded call, no reranking)
    //   det-rerank      : prefetchMs + detRerankMs
    //   cross-encoder   : prefetchMs + crossEncoderMs
    const modeLat = r => {
      if (mode === 'hybrid-true')     return r.hybridTrueMs;
      if (mode === 'hybrid-prefetch') return r.prefetchMs;
      if (mode === 'det-rerank')      return r.prefetchMs + r.detRerankMs;
      /* cross-encoder */             return r.prefetchMs + r.crossEncoderMs;
    };
    const lats = queryResults.map(modeLat).filter(Number.isFinite).sort((a, b) => a - b);

    for (const r of positives) {
      const results = r.byMode[mode];
      const { qrels } = r.query;
      const cr3h  = chunkRecallHit(results, qrels, 3);
      const cr5h  = chunkRecallHit(results, qrels, 5);
      const cr10h = chunkRecallHit(results, qrels, TOP_K);
      const wr5h   = windowRecallHit(results, qrels, 5, BENCH_WINDOW);
      const wr10h  = windowRecallHit(results, qrels, TOP_K, BENCH_WINDOW);
      const suppH  = chunkRecallHit(results, qrels, TOP_K, 2);
      const ndcgV  = gradedNDCG(results, qrels, TOP_K);
      const mrrV   = mrrAt(results, qrels, 10);
      if (cr3h  !== null) cr3   += cr3h  ? 1 : 0;
      if (cr5h  !== null) cr5   += cr5h  ? 1 : 0;
      if (cr10h !== null) cr10  += cr10h ? 1 : 0;
      if (wr5h  !== null) wr5   += wr5h  ? 1 : 0;
      if (wr10h !== null) wr10  += wr10h ? 1 : 0;
      if (suppH !== null) supp10 += suppH ? 1 : 0;
      if (ndcgV !== null) ndcgSum += ndcgV;
      if (mrrV  !== null) { mrrSum += mrrV; mrrCount++; }
      // rank1 exact: first result is a rel>=3 chunk.
      if (qrels.size && [...qrels.values()].some(v => v >= 3)) {
        if ((qrels.get(resultChunkId(results[0])) ?? 0) >= 3) rank1Exact++;
      }
    }

    for (const r of negatives) {
      const results = r.byMode[mode];
      const top1Words = new Set([
        ...tokenise(results[0]?.payload?.text ?? ''),
        ...tokenise(results[0]?.payload?.section ?? ''),
      ]);
      const strongHit = (r.query.expectedTokens ?? []).some(t => top1Words.has(t));
      if (!strongHit) negPass++;
    }

    out[mode] = {
      rank1Exact,
      chunkRecall3:    hasExact > 0    ? cr3    / hasExact    : null,
      chunkRecall5:    hasExact > 0    ? cr5    / hasExact    : null,
      chunkRecall10:   hasExact > 0    ? cr10   / hasExact    : null,
      windowRecall5:   hasExact > 0    ? wr5    / hasExact    : null,
      windowRecall10:  hasExact > 0    ? wr10   / hasExact    : null,
      supportRecall10: hasAnyQrels > 0 ? supp10 / hasAnyQrels : null,
      ndcgK:           hasAnyQrels > 0 ? ndcgSum / hasAnyQrels : null,
      mrr10:           mrrCount > 0    ? mrrSum  / mrrCount   : null,
      negativePass:    negatives.length > 0 ? negPass / negatives.length : null,
      p50: percentile(lats, 50),
      p95: percentile(lats, 95),
    };
  }
  return out;
}

// ── Per-query rank-1 analysis ─────────────────────────────────────────────────

function bestExactRank(results, qrels) {
  for (let i = 0; i < results.length; i++) {
    if ((qrels.get(resultChunkId(results[i])) ?? 0) >= 3) return i + 1;
  }
  return null;
}

function buildQueryDeltas(queryResults) {
  const rows = [];
  for (const r of queryResults) {
    if (r.query.shouldHaveNoStrongHit) continue;
    const { qrels } = r.query;
    const ranks = {};
    for (const mode of MODES) {
      ranks[mode] = bestExactRank(r.byMode[mode], qrels);
    }
    const top1ByMode = {};
    for (const mode of MODES) {
      const top = r.byMode[mode][0];
      top1ByMode[mode] = top ? resultChunkId(top) : null;
    }

    // Regression flag: rel>=3 chunk was at rank <=3 in hybrid-true but >3 in cross-encoder.
    const hybridRank = ranks['hybrid-true'];
    const ceRank     = ranks['cross-encoder'];
    const isRegression = hybridRank != null && hybridRank <= 3 && (ceRank == null || ceRank > 3);
    const isImprovement = (hybridRank == null || hybridRank > 1) && ceRank === 1;

    rows.push({ query: r.query, ranks, top1ByMode, isRegression, isImprovement, qrels });
  }
  // Regressions first, then improvements, then rest — stable within each group.
  rows.sort((a, b) => {
    if (a.isRegression !== b.isRegression) return a.isRegression ? -1 : 1;
    if (a.isImprovement !== b.isImprovement) return a.isImprovement ? -1 : 1;
    return 0;
  });
  return rows;
}

// ── Report rendering ──────────────────────────────────────────────────────────

function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
}

function f3(v) { return v == null ? ' n/a' : v.toFixed(3); }
function pct(v) { return v == null ? '  n/a' : `${(v*100).toFixed(1)}%`; }
function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

// True per-mode regression: rel>=3 chunk was at hybrid-true rank <=3 but mode moves it to >3 or miss.
function isModeRegression(r, mode) {
  const h = bestExactRank(r.byMode['hybrid-true'], r.query.qrels);
  const m = bestExactRank(r.byMode[mode],          r.query.qrels);
  return h != null && h <= 3 && (m == null || m > 3);
}

function buildPerClassSection(queryResults, SEP2) {
  const lines = [];
  const byType = new Map();
  for (const r of queryResults) {
    const t = r.query.type ?? '(missing)';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }

  const sorted = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const mode of MODES) {
    // hybrid-true is baseline — regr vs itself is always 0, skip the column
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

    for (const [type, rows] of sorted) {
      const neg = rows.filter(r =>  r.query.shouldHaveNoStrongHit);
      const pos = rows.filter(r => !r.query.shouldHaveNoStrongHit);

      let mrrSum = 0, mrrCount = 0, rank1 = 0, cr5 = 0, cr5Count = 0, regrCount = 0;
      for (const r of pos) {
        const results = r.byMode[mode];
        const mrrV = mrrAt(results, r.query.qrels, 10);
        const cr5h = chunkRecallHit(results, r.query.qrels, 5);
        if (mrrV !== null) { mrrSum += mrrV; mrrCount++; }
        if (cr5h !== null) { cr5 += cr5h ? 1 : 0; cr5Count++; }
        if (results.length && (r.query.qrels.get(resultChunkId(results[0])) ?? 0) >= 3) rank1++;
        if (showRegr && isModeRegression(r, mode)) regrCount++;
      }

      let negPassStr = 'n/a';
      if (neg.length > 0) {
        let pass = 0;
        for (const r of neg) {
          const results = r.byMode[mode];
          const top1Words = new Set([
            ...tokenise(results?.[0]?.payload?.text ?? ''),
            ...tokenise(results?.[0]?.payload?.section ?? ''),
          ]);
          if (!(r.query.expectedTokens ?? []).some(t => top1Words.has(t))) pass++;
        }
        negPassStr = `${(pass / neg.length * 100).toFixed(0)}%`;
      }

      const mrrStr = mrrCount > 0 ? (mrrSum / mrrCount).toFixed(3) : 'n/a';
      const cr5Str = cr5Count > 0 ? pct(cr5 / cr5Count) : 'n/a';

      lines.push(
        pad(type, 22) + lpad(rows.length, 4) +
        lpad(pos.length > 0 ? mrrStr           : 'n/a', 8) +
        lpad(pos.length > 0 ? String(rank1)    : 'n/a', 6) +
        lpad(pos.length > 0 ? cr5Str           : 'n/a', 7) +
        (showRegr ? lpad(pos.length > 0 ? String(regrCount) : 'n/a', 5) : '') +
        lpad(negPassStr, 8)
      );
    }
    lines.push(SEP2);
    lines.push('');
  }
  return lines;
}

function buildReport(allMetrics, queryDeltas, providerInfo, queryResults) {
  const lines = [];
  const SEP  = '='.repeat(100);
  const SEP2 = '-'.repeat(100);
  const M    = MODES;

  const { typeDistribution } = validateQueryTypes(queryResults.map(r => r.query));
  const typeLine = formatTypeDistribution(typeDistribution);

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('  custom-50 cross-encoder rerank benchmark');
  lines.push(`  Date              : ${today()}`);
  lines.push(`  Provider          : ${providerInfo.denseProvider}/${providerInfo.sparseProvider}`);
  lines.push(SEP2);
  lines.push(`  CE_MODEL          : ${CE_MODEL}`);
  lines.push(`  CE_INPUT          : ${CE_INPUT}`);
  lines.push(`  CE_DTYPE          : ${CE_DTYPE}`);
  lines.push(`  CE_BATCH_SIZE     : ${CE_BATCH_SIZE}`);
  lines.push(`  CE_PROTECT_TOP1   : ${CE_PROTECT_TOP1_DELTA > 0 ? CE_PROTECT_TOP1_DELTA : 'off'}`);
  lines.push(`  BENCH_TOP_K       : ${TOP_K}`);
  lines.push(`  RERANK_PREFETCH_MULT : ${RERANK_PREFETCH_MULT}`);
  lines.push(`  BENCH_SKIP_INDEX  : ${SKIP_INDEX ? 'yes' : 'no'}`);
  lines.push(`  Query types       : ${typeLine}`);
  lines.push(SEP);
  lines.push('');

  // ── Aggregate table ─────────────────────────────────────────────────────────
  const COL = 14;
  const LBL = 18;

  lines.push('Aggregate metrics:');
  lines.push(SEP2);
  lines.push(pad('', LBL) + M.map(m => lpad(m, COL)).join(''));
  lines.push(SEP2);

  const rows = [
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

  for (const [label, fn] of rows) {
    lines.push(pad(label, LBL) + M.map(m => lpad(fn(m), COL)).join(''));
  }
  lines.push(SEP2);
  lines.push('');

  // ── Promotion gate ───────────────────────────────────────────────────────────
  const base     = allMetrics['hybrid-true'];
  const ce       = allMetrics['cross-encoder'];
  const mrrBase  = base.mrr10 ?? 0;
  const mrrCE    = ce.mrr10   ?? 0;
  const cr5Base  = base.chunkRecall5 ?? 0;
  const cr5CE    = ce.chunkRecall5   ?? 0;
  const negCE    = ce.negativePass   ?? 0;
  const regrCount = queryDeltas.filter(r => r.isRegression).length;

  const gMRR  = mrrCE >= mrrBase + 0.030;
  const gCR5  = cr5CE >= cr5Base;
  const gNeg  = negCE >= 1.0;
  const gRegr = regrCount === 0;
  const gatePass = gMRR && gCR5 && gNeg && gRegr;

  lines.push('Promotion gate (cross-encoder vs hybrid-true):');
  lines.push(SEP2);
  lines.push(`  [${gMRR  ? '✓' : '✗'}] MRR@10 >= ${(mrrBase + 0.030).toFixed(3)}   (got ${f3(mrrCE)}, need +0.030 from ${f3(mrrBase)})`);
  lines.push(`  [${gCR5  ? '✓' : '✗'}] chunkRecall@5 >= ${pct(cr5Base).trim()}   (got ${pct(cr5CE).trim()})`);
  lines.push(`  [${gNeg  ? '✓' : '✗'}] negativePass = 100%   (got ${pct(negCE).trim()})`);
  lines.push(`  [${gRegr ? '✓' : '✗'}] zero regressions (rel>=3 rank <=3 -> >3)   (got ${regrCount})`);
  lines.push('');
  lines.push(`  Verdict: ${gatePass ? 'GATE PASSED — eligible for promotion review' : 'GATE FAILED — do not promote'}`);
  lines.push(SEP2);
  lines.push('');

  // ── Per-query delta table ────────────────────────────────────────────────────
  lines.push('Per-query rank-1 analysis (non-rank-1 hybrid-true, regressions first):');
  lines.push(SEP2);

  const nonRank1 = queryDeltas.filter(r => r.ranks['hybrid-true'] !== 1 || r.isRegression || r.isImprovement);

  lines.push(
    pad('ID', 5) + '  ' +
    M.map(m => lpad(m.slice(0, 12), 12)).join('  ') + '  ' +
    'flag  query'
  );
  lines.push(SEP2);

  for (const row of nonRank1) {
    const rankStr = m => row.ranks[m] != null ? `#${row.ranks[m]}` : 'miss';
    const flag    = row.isRegression ? 'REGR' : row.isImprovement ? 'IMPR' : '    ';
    lines.push(
      pad(row.query.id, 5) + '  ' +
      M.map(m => lpad(rankStr(m), 12)).join('  ') + '  ' +
      flag + '  ' +
      row.query.query.slice(0, 60)
    );
  }
  lines.push(SEP2);
  lines.push('');

  // ── Regression detail ────────────────────────────────────────────────────────
  const regressions = queryDeltas.filter(r => r.isRegression);
  if (regressions.length) {
    lines.push(`Regression detail (${regressions.length} queries where CE hurt rank <=3):`)
    lines.push(SEP2);
    for (const row of regressions) {
      lines.push(`[${row.query.id}] ${row.query.query}`);
      for (const mode of MODES) {
        const top1cid = row.top1ByMode[mode];
        const rel = top1cid ? (row.qrels.get(top1cid) ?? 0) : 0;
        lines.push(`  ${pad(mode, 18)} rank=${row.ranks[mode] != null ? '#'+row.ranks[mode] : 'miss'} top1=${top1cid ?? '-'} rel=${rel}`);
      }
      lines.push('');
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Per-class metrics ────────────────────────────────────────────────────────
  for (const l of buildPerClassSection(queryResults, SEP2)) lines.push(l);

  lines.push(SEP);
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

process.stderr.write(`=== semidex custom-50 cross-encoder benchmark ===\n`);
process.stderr.write(`CE_MODEL=${CE_MODEL}  CE_INPUT=${CE_INPUT}  CE_DTYPE=${CE_DTYPE}  TOP_K=${TOP_K}\n`);

// Force ONNX provider (same as run-v3.js when BENCH_PROVIDER=onnx)
process.env.ONNX_EMBED = '1';
delete process.env.DENSE_PROVIDER;
delete process.env.SPARSE_PROVIDER;

process.stderr.write('\n[1/3] Setup collection...\n');
let indexedIds, emptyChunkIds;
const providerInfo = { denseProvider: 'bge-m3-onnx', sparseProvider: 'bge-m3-onnx' };

if (SKIP_INDEX) {
  const stored = await fetchStoredProvider();
  if (stored && (stored.denseProvider !== 'bge-m3-onnx' || stored.sparseProvider !== 'bge-m3-onnx')) {
    process.stderr.write(`Error: BENCH_SKIP_INDEX=1 but stored provider (${stored.denseProvider}/${stored.sparseProvider}) differs from current (bge-m3-onnx/bge-m3-onnx).\nRe-run without BENCH_SKIP_INDEX=1.\n`);
    process.exitCode = 1;
    process.exit();
  }
  process.stderr.write('[2/3] Skipping index (BENCH_SKIP_INDEX=1) — fetching chunk IDs...\n');
  ({ indexedIds, emptyChunkIds } = await fetchIndexedChunkIds());
} else {
  await ensureCollection();
  process.stderr.write('[2/3] Indexing fixtures...\n');
  ({ indexedIds, emptyChunkIds } = await indexFixtures());
}

const rawQueries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
const queries = rawQueries.queries.map(q => ({
  ...q,
  qrels: buildQrels(q.relevantChunks),
  expectedTokens: q.expectedTokens ? q.expectedTokens.flatMap(t => tokenise(t)).filter(Boolean) : null,
}));

const { typeDistribution, warnings: typeWarnings } = validateQueryTypes(rawQueries.queries);
if (typeWarnings.length) {
  for (const w of typeWarnings) process.stderr.write(`[ce-bench] type warning: ${w}\n`);
}
process.stderr.write(`Types: ${formatTypeDistribution(typeDistribution)}\n`);

validateQrels(queries, indexedIds);

// Pre-load CE model before query loop so first-query latency is not inflated.
process.stderr.write('\n[3/3] Pre-loading cross-encoder model...\n');
await loadCE();

process.stderr.write('\nRunning queries...\n');
const queryResults = [];
for (const q of queries) {
  process.stderr.write(`  ${q.id}: ${q.query.slice(0, 50)}...`);
  const res = await runQuery(q.query);
  queryResults.push({ query: q, ...res });
  process.stderr.write(` done (${res.hybridTrueMs + res.prefetchMs + res.crossEncoderMs}ms)\n`);
}

const allMetrics  = computeAllMetrics(queryResults, emptyChunkIds);
const queryDeltas = buildQueryDeltas(queryResults);
const report      = buildReport(allMetrics, queryDeltas, providerInfo, queryResults);

process.stdout.write(report + '\n');

mkdirSync(RESULTS_DIR, { recursive: true });
// Slug: last path segment of CE_MODEL (e.g. "mmarco-mMiniLMv2-L12-H384-v1", "bge-reranker-v2-m3-ONNX"),
// lowercased, non-alphanumeric runs collapsed to single hyphen, leading/trailing hyphens stripped.
const modelSlug = CE_MODEL.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const inputSlug = CE_INPUT.replace(/\+/g, '-');
const outPath = resolve(RESULTS_DIR, `${today()}-custom50-ce-bench-${modelSlug}-${CE_DTYPE}-${inputSlug}.txt`);
writeFileSync(outPath, report + '\n', 'utf8');
process.stderr.write(`\nSaved: ${outPath}\n`);
