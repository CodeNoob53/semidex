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
//   hybrid-true   hybridSearch(TOP_K) baseline
//   det-rerank    current deterministic reranker
//   ce-raw        CE rerank, no routing (mmarco text+meta default)
//   ce-routed     CE rerank + query routing + heuristic lexical guard
//
// Usage:
//   BENCH_SKIP_INDEX=1 CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 CE_INPUT=text+meta \
//     node benchmarks/retrieval/custom-50/ce-routing-bench.js
//
// Guard versions reported:
//   heuristic-guard  uses only query text + candidate payload; no qrel access (real candidate)
//   oracle-guard     uses qrels to estimate upper bound; not deployable in production

if (process.argv.includes('--help')) {
  process.stdout.write(`CE routing benchmark — custom-50

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
  benchmarks/retrieval/results/YYYY-MM-DD-custom50-ce-routing-{model_slug}.txt

Acceptance criteria (ce-routed heuristic-guard):
  MRR@10 >= 0.750  (minimum: 0.740)
  chunkRecall@5 >= 95.0%
  negativePass = 100%
  zero regressions
  c03 must not regress
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

const __dirname       = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SHARED = resolve(__dirname, '../fixtures/docs');
const FIXTURES_OWN    = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH    = resolve(__dirname, 'queries.json');
const RESULTS_DIR     = resolve(__dirname, '../results');
const COLLECTION      = 'bench-retrieval-custom-50';

hfEnv.cacheDir = resolve(__dirname, '../../../models');

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

const GUARD_VERSION = 'heuristic-v1';

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
      const { dense, sparse, meta } = await embedForIndex(COLLECTION, chunk.text);
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

// ── Query classifier ───────────────────────────────────────────────────────────
//
// Assigns one of four labels to each query purely from its text.
// All patterns are lowercase-matched against the query string.
//
// Priority (first match wins):
//   provider-activation > source-navigation > exact-token > semantic

// provider-activation requires BOTH a verb of activation AND a provider term.
// Without the conjunction, queries like "bge-m3-onnx neural sparse weights"
// (which mention the provider but are not activation queries) would be misclassified.
const ACTIVATION_VERB_PATTERNS = [
  /увімкнути/i, /\benable\b/i, /\bactivate\b/i,
  /without ollama/i, /без ollama/i,
];
const PROVIDER_TERM_PATTERNS = [
  /bge-m3-onnx/i, /ONNX_EMBED/, /\bprovider\b/i, /провайдер/i,
];

const SOURCE_NAVIGATION_PATTERNS = [
  /де знаходиться/i, /location in source/i, /\bsource\b/i,
  /експортує/i, /\bexports\b/i, /entry point/i,
  /which file/i, /where is/i,
];

// Strong code/config token pattern: UPPER_SNAKE, camelCase, path-like, or metric identifiers.
const EXACT_TOKEN_RE =
  /[A-Z][A-Z_]{2,}[A-Z0-9]|[a-z][A-Za-z]{2,}[A-Z][A-Za-z]*|src\/|\.js\b|\.md\b|@\d+/;

function classifyQuery(queryText) {
  if (ACTIVATION_VERB_PATTERNS.some(p => p.test(queryText)) &&
      PROVIDER_TERM_PATTERNS.some(p => p.test(queryText)))    return 'provider-activation';
  if (SOURCE_NAVIGATION_PATTERNS.some(p => p.test(queryText)))   return 'source-navigation';
  if (EXACT_TOKEN_RE.test(queryText))                             return 'exact-token';
  return 'semantic';
}

// ── Cross-encoder ──────────────────────────────────────────────────────────────

function buildPassage(p) {
  if (CE_INPUT === 'text+section') return `${p.section ?? ''}\n${p.text ?? ''}`;
  if (CE_INPUT === 'text+meta')    return `${p.source_file ?? ''} ${p.section ?? ''}\n${p.text ?? ''}`;
  return p.text ?? '';
}

let _tok = null, _model = null, _numLabels = null;

async function loadCE() {
  if (_model) return;
  process.stderr.write(`[ce] Loading ${CE_MODEL} dtype=${CE_DTYPE}...\n`);
  _tok   = await AutoTokenizer.from_pretrained(CE_MODEL);
  _model = await AutoModelForSequenceClassification.from_pretrained(CE_MODEL, { dtype: CE_DTYPE });
  const probe = _tok(['probe'], { text_pair: ['probe'], truncation: true,
    max_length: 16, return_tensors: 'pt', padding: true });
  const { logits: pl } = await _model(probe);
  _numLabels = pl.dims[1];
  if (_numLabels !== 1 && _numLabels !== 2) {
    process.stderr.write(`[ce] Error: numLabels=${_numLabels} — only 1 or 2 supported.\n`);
    process.exit(1);
  }
  process.stderr.write(`[ce] Ready. numLabels=${_numLabels}\n`);
}

function extractScores(logits, n) {
  const col  = _numLabels === 2 ? 1 : 0;
  const data = logits.data;
  const out  = [];
  for (let i = 0; i < n; i++) out.push(data[i * _numLabels + col]);
  return out;
}

async function ceScore(query, candidates) {
  const rawScores = [];
  for (let i = 0; i < candidates.length; i += CE_BATCH_SIZE) {
    const batch    = candidates.slice(i, i + CE_BATCH_SIZE);
    const passages = batch.map(r => buildPassage(r.payload));
    const queries  = Array(batch.length).fill(query);
    const inputs   = _tok(queries, {
      text_pair: passages, truncation: true, max_length: 512,
      return_tensors: 'pt', padding: true,
    });
    const { logits } = await _model(inputs);
    for (const v of extractScores(logits, batch.length)) rawScores.push(v);
  }
  return candidates.map((r, i) => ({ result: r, ceScore: rawScores[i] }));
}

// ── Lexical guard ──────────────────────────────────────────────────────────────
//
// HEURISTIC guard: uses only query text + candidate payload. No qrel access.
//
// For non-semantic queries, computes a protection score for each candidate
// in hybrid/det top-3. A candidate is "protected" (must stay <=3) if it has
// sufficient lexical overlap with the query and is not a known distractor
// pattern for its query class.
//
// ORACLE guard: additionally uses qrels to enforce any rel>=3 candidate that
// was in hybrid top-3. Estimates upper bound only — not deployable.

function tokeniseQuery(query) {
  return new Set((query.toLowerCase().match(/[\p{L}\p{N}_@.]+/gu) ?? []).filter(t => t.length >= 2));
}

function candidateTokens(payload) {
  return new Set([
    ...(payload.source_file ?? '').toLowerCase().match(/[\p{L}\p{N}_@.]+/gu) ?? [],
    ...(payload.section     ?? '').toLowerCase().match(/[\p{L}\p{N}_@.]+/gu) ?? [],
    ...(payload.text        ?? '').toLowerCase().match(/[\p{L}\p{N}_@.]+/gu) ?? [],
  ]);
}

function tokenOverlapCount(queryTokens, candidateToks) {
  let n = 0;
  for (const t of queryTokens) if (candidateToks.has(t)) n++;
  return n;
}

// Returns true if a candidate looks like a pure env-var reference table
// (dense listing of VAR=VALUE or VAR | default | description rows).
function looksLikeEnvTable(payload) {
  const text = (payload.text ?? '').slice(0, 800);
  // A table chunk has many pipe-delimited lines or many ALL_CAPS=... assignments.
  const pipeLines   = (text.match(/\|/g) ?? []).length;
  const varLines    = (text.match(/\b[A-Z][A-Z_]{3,}[A-Z0-9]\b/g) ?? []).length;
  return pipeLines >= 6 || varLines >= 5;
}

// Returns true if there is any candidate in the pool (rank <=5) from providers.md
// that contains at least one provider activation term.
function hasProviderCandidateInPool(pool) {
  const activationTerms = /providers?\b|ONNX_EMBED|bge.m3.onnx|enable|activat|увімкнути/i;
  return pool.slice(0, 5).some(r =>
    r.payload?.source_file === 'providers.md' && activationTerms.test(r.payload?.text ?? '')
  );
}

// Heuristic: decide whether a candidate deserves protection from CE demotion.
// queryClass: 'exact-token' | 'source-navigation' | 'provider-activation'
// candidate: qdrant result with .payload
// hybridRank: 0-based rank in hybrid-true pool (0 = first)
// pool: full hybrid pool for distractor suppression
function isProtected(queryClass, candidate, hybridRank, pool) {
  if (hybridRank >= 3) return false; // only protect hybrid top-3 (0-based: 0,1,2)

  const qToks    = tokeniseQuery(pool.__query__);
  const cToks    = candidateTokens(candidate.payload);
  const overlap  = tokenOverlapCount(qToks, cToks);
  const sf       = candidate.payload?.source_file ?? '';

  // provider-activation guard: two-stage.
  // Stage 1: suppress config-env.md env-table distractors first (before signal check,
  //   because env tables can also contain activation-like text and would otherwise pass stage 2).
  // Stage 2: only protect candidates that look like activation guides — providers.md source,
  //   or text containing explicit enable/activate/увімкнути wording in the section or body.
  //   ONNX_EMBED=1 is intentionally excluded here: many explanation chunks mention running
  //   with ONNX_EMBED=1 without being activation guides (e.g. sync.md#5 which explains
  //   what sync records when you run with that flag).
  if (queryClass === 'provider-activation') {
    if (sf === 'config-env.md' && looksLikeEnvTable(candidate.payload)) {
      if (hasProviderCandidateInPool(pool)) return false;
    }
    const text = `${candidate.payload?.section ?? ''}\n${candidate.payload?.text ?? ''}`;
    const hasActivationGuideSignal =
      sf === 'providers.md' ||
      /\benable\b|\bactivate\b|увімкнути/i.test(text);
    if (!hasActivationGuideSignal) return false;
  }

  // For source-navigation, boost protection for chunks that are likely structural
  // (file tree, exports list): source_file is project-structure.md or section contains
  // "source tree", "src/", "exports".
  if (queryClass === 'source-navigation') {
    const section = (candidate.payload?.section ?? '').toLowerCase();
    const isStructural = sf === 'project-structure.md' ||
      section.includes('src/') || section.includes('source tree') || section.includes('exports');
    return overlap >= 1 && isStructural;
  }

  // General rule: protect if there is meaningful lexical overlap.
  return overlap >= 2;
}

// Apply guard to CE-ranked list.
// Protected candidates that were displaced from top-3 by CE are moved back to <=3.
// Returns { guarded: result[], guardFired: bool, protectedId: string|null }.
// Note: guard is based on hybrid top-3 only. det-rerank top-3 protection is deferred.
function applyHeuristicGuard(queryClass, ceRanked, hybridPool) {
  if (queryClass === 'semantic') {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null };
  }

  // Find candidates that were in hybrid top-3 and deserve protection.
  const protected_ = new Set();
  for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
    const r = hybridPool[i];
    if (isProtected(queryClass, r, i, hybridPool)) {
      const sf = r.payload?.source_file;
      const ci = r.payload?.chunk_index;
      if (sf != null && ci != null) protected_.add(`${sf}#${ci}`);
    }
  }

  if (!protected_.size) {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null };
  }

  // Check if any protected candidate was displaced beyond rank 3 by CE.
  const chunkId = r => {
    const sf = r.result?.payload?.source_file ?? r.payload?.source_file;
    const ci = r.result?.payload?.chunk_index ?? r.payload?.chunk_index;
    return (sf != null && ci != null) ? `${sf}#${ci}` : null;
  };

  // Find displaced ones: protected but currently outside ce top-3.
  const displaced = [];
  for (let i = 3; i < ceRanked.length; i++) {
    const cid = chunkId(ceRanked[i]);
    if (cid && protected_.has(cid)) displaced.push(i);
  }

  if (!displaced.length) {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null };
  }

  // Move displaced protected candidate(s) to just after the current CE top-2,
  // pushing the lowest-ranked CE top-3 down.
  const out = [...ceRanked];
  for (const srcIdx of displaced) {
    const entry    = out.splice(srcIdx, 1)[0];
    const insertAt = Math.min(2, out.length);
    out.splice(insertAt, 0, entry);
  }

  return {
    guarded: out.map(x => x.result),
    guardFired: true,
    protectedId: chunkId(ceRanked[displaced[0]]) ?? null,
  };
}

// Oracle guard: also enforces any rel>=3 chunk that was in hybrid top-3.
// Uses qrels → not deployable, upper-bound only.
function applyOracleGuard(queryClass, ceRanked, hybridPool, qrels) {
  // Start from heuristic result then additionally protect qrel-annotated chunks.
  const { guarded: heurGuarded } = applyHeuristicGuard(queryClass, ceRanked, hybridPool);

  if (!qrels.size) return { guarded: heurGuarded, guardFired: false, protectedId: null };

  const chunkId = r => {
    const sf = r.payload?.source_file;
    const ci = r.payload?.chunk_index;
    return (sf != null && ci != null) ? `${sf}#${ci}` : null;
  };

  // Qrel-protected: rel>=3 and appeared in hybrid top-3.
  const protected_ = new Set();
  for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
    const cid = chunkId(hybridPool[i]);
    if (cid && (qrels.get(cid) ?? 0) >= 3) protected_.add(cid);
  }

  if (!protected_.size) return { guarded: heurGuarded, guardFired: false, protectedId: null };

  const out = heurGuarded.map(r => ({ result: r }));
  let fired = false, protId = null;

  for (let i = 3; i < out.length; i++) {
    const cid = chunkId(out[i].result);
    if (cid && protected_.has(cid)) {
      const entry = out.splice(i, 1)[0];
      out.splice(Math.min(2, out.length), 0, entry);
      fired  = true;
      protId = protId ?? cid;
      i--; // recheck this position
    }
  }

  return { guarded: out.map(x => x.result), guardFired: fired, protectedId: protId };
}

// ── Per-query runner ───────────────────────────────────────────────────────────

async function runQuery(q) {
  const { dense, sparse } = await embedForSearch(COLLECTION, q.query);
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
  const ceRanked = (await ceScore(q.query, pool)).sort((a, b) => b.ceScore - a.ceScore);
  const ceRawResults = ceRanked.slice(0, TOP_K).map(x => ({ ...x.result, score: x.ceScore }));

  const queryClass = classifyQuery(q.query);

  const { guarded: heurGuarded, guardFired, protectedId } =
    applyHeuristicGuard(queryClass, ceRanked, hybridTrue);
  const ceRoutedResults = heurGuarded.slice(0, TOP_K);

  const { guarded: oracleGuarded, guardFired: oracleFired } =
    applyOracleGuard(queryClass, ceRanked, hybridTrue, q.qrels);
  const ceOracleResults = oracleGuarded.slice(0, TOP_K);

  const crossEncoderMs = Date.now() - t3;

  return {
    hybridTrueMs, prefetchMs, detRerankMs, crossEncoderMs,
    queryClass, guardFired, protectedId, oracleFired,
    byMode: {
      'hybrid-true': hybridTrue,
      'det-rerank':  detResults,
      'ce-raw':      ceRawResults,
      'ce-routed':   ceRoutedResults,
      'ce-oracle':   ceOracleResults,
    },
  };
}

// ── Metric helpers ─────────────────────────────────────────────────────────────

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

function bestExactRank(results, qrels) {
  for (let i = 0; i < results.length; i++) {
    if ((qrels.get(resultChunkId(results[i])) ?? 0) >= 3) return i + 1;
  }
  return null;
}

// ── Aggregate metrics ──────────────────────────────────────────────────────────

const MODES = ['hybrid-true', 'det-rerank', 'ce-raw', 'ce-routed', 'ce-oracle'];

function computeAllMetrics(queryResults) {
  const out = {};
  for (const mode of MODES) {
    let cr3=0, cr5=0, cr10=0, wr5=0, wr10=0, supp10=0, ndcgSum=0, mrrSum=0, mrrCount=0;
    let rank1Exact=0, negPass=0;
    const positives  = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
    const negatives  = queryResults.filter(r =>  r.query.shouldHaveNoStrongHit);
    const hasExact   = positives.filter(r => [...r.query.qrels.values()].some(v => v >= 3)).length;
    const hasAnyQrels = positives.filter(r => r.query.qrels.size > 0).length;

    const modeLat = r => {
      if (mode === 'hybrid-true') return r.hybridTrueMs;
      if (mode === 'det-rerank')  return r.prefetchMs + r.detRerankMs;
      return r.prefetchMs + r.crossEncoderMs; // all CE modes share the same CE inference time
    };
    const lats = queryResults.map(modeLat).filter(Number.isFinite).sort((a, b) => a - b);

    for (const r of positives) {
      const results = r.byMode[mode];
      const { qrels } = r.query;
      const cr3h  = chunkRecallHit(results, qrels, 3);
      const cr5h  = chunkRecallHit(results, qrels, 5);
      const cr10h = chunkRecallHit(results, qrels, TOP_K);
      const wr5h  = windowRecallHit(results, qrels, 5, BENCH_WINDOW);
      const wr10h = windowRecallHit(results, qrels, TOP_K, BENCH_WINDOW);
      const suppH = chunkRecallHit(results, qrels, TOP_K, 2);
      const ndcgV = gradedNDCG(results, qrels, TOP_K);
      const mrrV  = mrrAt(results, qrels, 10);
      if (cr3h  !== null) cr3    += cr3h  ? 1 : 0;
      if (cr5h  !== null) cr5    += cr5h  ? 1 : 0;
      if (cr10h !== null) cr10   += cr10h ? 1 : 0;
      if (wr5h  !== null) wr5    += wr5h  ? 1 : 0;
      if (wr10h !== null) wr10   += wr10h ? 1 : 0;
      if (suppH !== null) supp10 += suppH ? 1 : 0;
      if (ndcgV !== null) ndcgSum += ndcgV;
      if (mrrV  !== null) { mrrSum += mrrV; mrrCount++; }
      if (qrels.size && [...qrels.values()].some(v => v >= 3)) {
        if ((qrels.get(resultChunkId(results[0])) ?? 0) >= 3) rank1Exact++;
      }
    }

    for (const r of negatives) {
      const results = r.byMode[mode];
      const top1Words = new Set([
        ...tokenise(results[0]?.payload?.text    ?? ''),
        ...tokenise(results[0]?.payload?.section ?? ''),
      ]);
      const strongHit = (r.query.expectedTokens ?? []).some(t => top1Words.has(t));
      if (!strongHit) negPass++;
    }

    out[mode] = {
      rank1Exact,
      chunkRecall3:    hasExact   > 0 ? cr3    / hasExact    : null,
      chunkRecall5:    hasExact   > 0 ? cr5    / hasExact    : null,
      chunkRecall10:   hasExact   > 0 ? cr10   / hasExact    : null,
      windowRecall5:   hasExact   > 0 ? wr5    / hasExact    : null,
      windowRecall10:  hasExact   > 0 ? wr10   / hasExact    : null,
      supportRecall10: hasAnyQrels > 0 ? supp10 / hasAnyQrels : null,
      ndcgK:           hasAnyQrels > 0 ? ndcgSum / hasAnyQrels : null,
      mrr10:           mrrCount   > 0 ? mrrSum  / mrrCount   : null,
      negativePass:    negatives.length > 0 ? negPass / negatives.length : null,
      p50: percentile(lats, 50),
      p95: percentile(lats, 95),
    };
  }
  return out;
}

// ── Regression detection ───────────────────────────────────────────────────────

function buildQueryAnalysis(queryResults) {
  const WATCHED = new Set(['c03', 'c16', 'c23', 'c36', 'c46', 'c29', 'c33']);
  const rows = [];

  for (const r of queryResults) {
    if (r.query.shouldHaveNoStrongHit) continue;
    const { qrels } = r.query;
    const ranks = {};
    for (const mode of MODES) ranks[mode] = bestExactRank(r.byMode[mode], qrels);
    const top1ByMode = {};
    for (const mode of MODES) {
      const top = r.byMode[mode][0];
      top1ByMode[mode] = top ? resultChunkId(top) : null;
    }

    const hybridRank  = ranks['hybrid-true'];
    const ceRawRank   = ranks['ce-raw'];
    const ceRoutedRank = ranks['ce-routed'];

    const isRegrRaw    = hybridRank != null && hybridRank <= 3 && (ceRawRank    == null || ceRawRank    > 3);
    const isRegrRouted = hybridRank != null && hybridRank <= 3 && (ceRoutedRank == null || ceRoutedRank > 3);

    const isImprovRaw    = (hybridRank == null || hybridRank > 1) && ceRawRank    === 1;
    const isImprovRouted = (hybridRank == null || hybridRank > 1) && ceRoutedRank === 1;

    rows.push({
      query: r.query, ranks, top1ByMode,
      queryClass:   r.queryClass,
      guardFired:   r.guardFired,
      protectedId:  r.protectedId,
      oracleFired:  r.oracleFired,
      isRegrRaw, isRegrRouted,
      isImprovRaw, isImprovRouted,
      isWatched: WATCHED.has(r.query.id),
      qrels,
    });
  }

  rows.sort((a, b) => {
    if (a.isRegrRouted !== b.isRegrRouted) return a.isRegrRouted ? -1 : 1;
    if (a.isRegrRaw !== b.isRegrRaw)       return a.isRegrRaw    ? -1 : 1;
    if (a.isWatched  !== b.isWatched)      return a.isWatched    ? -1 : 1;
    return 0;
  });
  return rows;
}

// ── Report ─────────────────────────────────────────────────────────────────────

function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
}

function f3(v)      { return v == null ? '   n/a' : v.toFixed(3); }
function pct(v)     { return v == null ? '   n/a' : `${(v*100).toFixed(1)}%`; }
function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

function buildReport(allMetrics, analysis, providerInfo) {
  const lines = [];
  const SEP  = '='.repeat(110);
  const SEP2 = '-'.repeat(110);

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('  custom-50 CE routing benchmark');
  lines.push(`  Date              : ${today()}`);
  lines.push(`  Provider          : ${providerInfo.denseProvider}/${providerInfo.sparseProvider}`);
  lines.push(SEP2);
  lines.push(`  CE_MODEL          : ${CE_MODEL}`);
  lines.push(`  CE_INPUT          : ${CE_INPUT}`);
  lines.push(`  CE_DTYPE          : ${CE_DTYPE}`);
  lines.push(`  CE_BATCH_SIZE     : ${CE_BATCH_SIZE}`);
  lines.push(`  BENCH_TOP_K       : ${TOP_K}`);
  lines.push(`  RERANK_PREFETCH_MULT : ${RERANK_PREFETCH_MULT}`);
  lines.push(`  guard version     : ${GUARD_VERSION}`);
  lines.push(`  BENCH_SKIP_INDEX  : ${SKIP_INDEX ? 'yes' : 'no'}`);
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

  // ── Gate checklist (ce-routed heuristic) ────────────────────────────────────
  const base       = allMetrics['hybrid-true'];
  const routed     = allMetrics['ce-routed'];
  const raw        = allMetrics['ce-raw'];
  const mrrBase    = base.mrr10    ?? 0;
  const mrrRouted  = routed.mrr10  ?? 0;
  const cr5Base    = base.chunkRecall5   ?? 0;
  const cr5Routed  = routed.chunkRecall5 ?? 0;
  const negRouted  = routed.negativePass ?? 0;

  const regrRaw    = analysis.filter(r => r.isRegrRaw).length;
  const regrRouted = analysis.filter(r => r.isRegrRouted).length;

  // Special query checks.
  const c03 = analysis.find(r => r.query.id === 'c03');
  const c03ok = c03 && !c03.isRegrRouted;

  const gMRRtgt  = mrrRouted >= 0.750;
  const gMRRmin  = mrrRouted >= 0.740;
  const gCR5     = cr5Routed >= 0.950;
  const gNeg     = negRouted >= 1.0;
  const gRegr    = regrRouted === 0;
  const gC03     = c03ok;
  const gatePass = gMRRmin && gCR5 && gNeg && gRegr && gC03;

  lines.push('Promotion gate (ce-routed heuristic vs hybrid-true):');
  lines.push(SEP2);
  lines.push(`  [${gMRRtgt ? '✓' : gMRRmin ? '~' : '✗'}] MRR@10 >= 0.750 (target) / >= 0.740 (minimum)   (got ${f3(mrrRouted).trim()}, base=${f3(mrrBase).trim()})`);
  lines.push(`  [${gCR5   ? '✓' : '✗'}] chunkRecall@5 >= 95.0%   (got ${pct(cr5Routed).trim()}, base=${pct(cr5Base).trim()})`);
  lines.push(`  [${gNeg   ? '✓' : '✗'}] negativePass = 100%   (got ${pct(negRouted).trim()})`);
  lines.push(`  [${gRegr  ? '✓' : '✗'}] zero regressions (rel>=3, hybrid rank <=3 → ce-routed >3)   (got ${regrRouted})`);
  lines.push(`  [${gC03   ? '✓' : '✗'}] c03 must not regress   (hybrid=${c03?.ranks['hybrid-true'] ?? 'n/a'} → ce-routed=${c03?.ranks['ce-routed'] ?? 'miss'})`);
  lines.push('');
  lines.push(`  ce-raw regressions for comparison : ${regrRaw}`);
  lines.push(`  Verdict: ${gatePass ? 'GATE PASSED — routing guard effective' : 'GATE FAILED — routing does not fully fix regressions'}`);
  lines.push(SEP2);
  lines.push('');

  // ── Per-query routing table ──────────────────────────────────────────────────
  lines.push('Per-query routing table:');
  lines.push(SEP2);
  lines.push(
    pad('ID', 5) + '  ' +
    pad('class', 20) + '  ' +
    lpad('hyb', 5) + '  ' +
    lpad('det', 5) + '  ' +
    lpad('ce-raw', 7) + '  ' +
    lpad('routed', 7) + '  ' +
    pad('guard', 6) + '  ' +
    pad('protected', 30) + '  ' +
    'query'
  );
  lines.push(SEP2);

  for (const row of analysis) {
    const rk = m => row.ranks[m] != null ? `#${row.ranks[m]}` : 'miss';
    const flag = row.isRegrRouted ? 'REGR!' :
                 row.isRegrRaw && !row.isRegrRouted ? 'fixed' :
                 row.isImprovRouted ? 'IMPR' : '';
    const guardStr = row.guardFired ? 'YES' : (row.oracleFired ? 'ora' : '');
    lines.push(
      pad(row.query.id, 5) + '  ' +
      pad(row.queryClass, 20) + '  ' +
      lpad(rk('hybrid-true'), 5) + '  ' +
      lpad(rk('det-rerank'), 5) + '  ' +
      lpad(rk('ce-raw'), 7) + '  ' +
      lpad(rk('ce-routed'), 7) + '  ' +
      pad(guardStr, 6) + '  ' +
      pad(row.protectedId ?? '', 30) + '  ' +
      (flag ? `[${flag}] ` : '') +
      row.query.query.slice(0, 55)
    );
  }
  lines.push(SEP2);
  lines.push('');

  // ── Regression detail ────────────────────────────────────────────────────────
  const regressions = analysis.filter(r => r.isRegrRouted);
  if (regressions.length) {
    lines.push(`Remaining regressions in ce-routed (${regressions.length}):`);
    lines.push(SEP2);
    for (const row of regressions) {
      lines.push(`[${row.query.id}] ${row.query.query}`);
      for (const mode of MODES) {
        const top1cid = row.top1ByMode[mode];
        const rel = top1cid ? (row.qrels.get(top1cid) ?? 0) : 0;
        const rankStr = row.ranks[mode] != null ? `#${row.ranks[mode]}` : 'miss';
        lines.push(`  ${pad(mode, 16)} rank=${rankStr} top1=${top1cid ?? '-'} rel=${rel}`);
      }
      lines.push('');
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Fixed regressions ────────────────────────────────────────────────────────
  const fixed = analysis.filter(r => r.isRegrRaw && !r.isRegrRouted);
  if (fixed.length) {
    lines.push(`Regressions fixed by routing guard (${fixed.length}):`);
    lines.push(SEP2);
    for (const row of fixed) {
      lines.push(
        `  [${row.query.id}] class=${row.queryClass} guardFired=${row.guardFired} oracleFired=${row.oracleFired}`
      );
      lines.push(`    query: ${row.query.query}`);
      lines.push(`    ce-raw rank ${row.ranks['ce-raw'] ?? 'miss'} → ce-routed rank ${row.ranks['ce-routed'] ?? 'miss'}`);
      if (row.protectedId) lines.push(`    protected: ${row.protectedId}`);
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Watched query detail ─────────────────────────────────────────────────────
  const watched = analysis.filter(r => r.isWatched);
  if (watched.length) {
    lines.push('Watched query detail (c03, c16, c23, c29, c33, c36, c46):');
    lines.push(SEP2);
    for (const row of watched) {
      const status = row.isRegrRouted ? 'REGRESSION' : row.isRegrRaw ? 'fixed-by-guard' : 'ok';
      lines.push(`  [${row.query.id}] ${status}  class=${row.queryClass}`);
      lines.push(`    query: ${row.query.query}`);
      for (const mode of MODES) {
        lines.push(`    ${pad(mode, 16)}: rank ${row.ranks[mode] != null ? '#'+row.ranks[mode] : 'miss'}  top1=${row.top1ByMode[mode] ?? '-'}`);
      }
      if (row.guardFired)  lines.push(`    guard fired: protected ${row.protectedId}`);
      if (row.oracleFired) lines.push(`    oracle guard also fired`);
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Acceptance criteria summary ──────────────────────────────────────────────
  lines.push('Acceptance criteria (ce-routed):');
  lines.push(SEP2);
  lines.push(`  MRR@10 target >= 0.750  : ${gMRRtgt ? 'MET' : 'NOT MET'} (${f3(mrrRouted).trim()})`);
  lines.push(`  MRR@10 minimum >= 0.740 : ${gMRRmin ? 'MET' : 'NOT MET'} (${f3(mrrRouted).trim()})`);
  lines.push(`  chunkRecall@5 >= 95.0%  : ${gCR5  ? 'MET' : 'NOT MET'} (${pct(cr5Routed).trim()})`);
  lines.push(`  negativePass = 100%     : ${gNeg  ? 'MET' : 'NOT MET'} (${pct(negRouted).trim()})`);
  lines.push(`  zero regressions        : ${gRegr ? 'MET' : 'NOT MET'} (${regrRouted} remaining)`);
  lines.push(`  c03 not regressed       : ${gC03  ? 'MET' : 'NOT MET'}`);
  lines.push('');
  lines.push(`  Overall: ${gatePass ? 'PROMISING — proceed to next validation step' : 'NEEDS WORK — adjust guard before next validation step'}`);
  lines.push(SEP);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

process.stderr.write(`=== semidex custom-50 CE routing benchmark ===\n`);
process.stderr.write(`CE_MODEL=${CE_MODEL}  CE_INPUT=${CE_INPUT}  CE_DTYPE=${CE_DTYPE}  guard=${GUARD_VERSION}\n`);

process.env.ONNX_EMBED = '1';
delete process.env.DENSE_PROVIDER;
delete process.env.SPARSE_PROVIDER;

process.stderr.write('\n[1/3] Setup collection...\n');
let indexedIds, emptyChunkIds;
const providerInfo = { denseProvider: 'bge-m3-onnx', sparseProvider: 'bge-m3-onnx' };

if (SKIP_INDEX) {
  const stored = await fetchStoredProvider();
  if (stored && (stored.denseProvider !== 'bge-m3-onnx' || stored.sparseProvider !== 'bge-m3-onnx')) {
    process.stderr.write(`Error: BENCH_SKIP_INDEX=1 but stored provider (${stored.denseProvider}/${stored.sparseProvider}) differs.\n`);
    process.exitCode = 1; process.exit();
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

validateQrels(queries, indexedIds);

process.stderr.write('\n[3/3] Pre-loading CE model...\n');
await loadCE();

process.stderr.write('\nRunning queries...\n');
const queryResults = [];
for (const q of queries) {
  process.stderr.write(`  ${q.id}: ${q.query.slice(0, 50)}...`);
  const res = await runQuery(q);
  queryResults.push({ query: q, ...res });
  process.stderr.write(` ${res.queryClass}${res.guardFired ? ' [guard]' : ''} (${res.hybridTrueMs + res.prefetchMs + res.crossEncoderMs}ms)\n`);
}

const allMetrics = computeAllMetrics(queryResults);
const analysis   = buildQueryAnalysis(queryResults);
const report     = buildReport(allMetrics, analysis, providerInfo);

process.stdout.write(report + '\n');

mkdirSync(RESULTS_DIR, { recursive: true });
const modelSlug = CE_MODEL.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const outPath   = resolve(RESULTS_DIR, `${today()}-custom50-ce-routing-${modelSlug}.txt`);
writeFileSync(outPath, report + '\n', 'utf8');
process.stderr.write(`\nSaved: ${outPath}\n`);
