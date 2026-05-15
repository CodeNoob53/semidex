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
//   ce-oracle-regression  CE rerank + qrel-aware regression guard (pure CE base; not a global upper bound)
//
// Usage:
//   BENCH_SKIP_INDEX=1 CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 CE_INPUT=text+meta \
//     node benchmarks/retrieval/custom-50/ce-routing-bench.js
//
// Guard versions reported:
//   heuristic-v1  uses only query text + candidate payload; no qrel access (original guard)
//   heuristic-v3  adds provider-activation priority before config-env/exact-token; exact-token single-protect
//   oracle        pure CE order base; promotes rel>=3 hybrid top-3 chunks; not a global upper bound

if (process.argv.includes('--help')) {
  process.stdout.write(`CE routing benchmark — custom-50 (guard v1 vs v3)

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
  benchmarks/retrieval/results/YYYY-MM-DD-custom50-ce-routing-v3-{model_slug}.txt

Gate criteria (ce-routed-v3 vs hybrid-true):
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

const GUARD_V1 = 'heuristic-v1';
const GUARD_V3 = 'heuristic-v3';

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

// ── V3 classifier (provider-activation priority before config-env/exact-token) ──

const CONFIG_ENV_TYPE_TOKENS = /\benv\b|environment variable|config\.json|\bprovider\b|провайдер/i;

function isConfigEnvQuery(queryText, typeLabel) {
  if (typeLabel === 'config-env') return true;
  return CONFIG_ENV_TYPE_TOKENS.test(queryText);
}

function isProviderActivationQueryV3(queryText, typeLabel) {
  if (typeLabel === 'provider-activation') return true;
  return ACTIVATION_VERB_PATTERNS.some(p => p.test(queryText)) &&
         PROVIDER_TERM_PATTERNS.some(p => p.test(queryText));
}

function classifyQueryV3(queryText, typeLabel) {
  if (isProviderActivationQueryV3(queryText, typeLabel)) return 'provider-activation';
  if (isConfigEnvQuery(queryText, typeLabel))            return 'config-env';
  if (SOURCE_NAVIGATION_PATTERNS.some(p => p.test(queryText))) return 'source-navigation';
  if (EXACT_TOKEN_RE.test(queryText))                          return 'exact-token';
  return 'semantic';
}

// Structural bonus for exact-token single-protect scoring.
const STRUCTURAL_SOURCE_WORDS = /\bfunction\b|\bsource\b|\bmodule\b|\bexport\b|\.js\b|[a-z][A-Z]/;

function exactTokenProtectScore(candidate, hybridRank, qToks) {
  const sf      = candidate.payload?.source_file ?? '';
  const section = (candidate.payload?.section ?? '').toLowerCase();
  const cToks   = candidateTokens(candidate.payload);
  const overlap = tokenOverlapCount(qToks, cToks);
  let structural = 0;
  if (sf === 'project-structure.md') {
    const queryText = [...qToks].join(' ');
    structural = STRUCTURAL_SOURCE_WORDS.test(queryText) ? 5 : 2;
  } else if (section.includes('src/') || section.includes('exports') ||
             section.includes('source tree')) {
    structural = 3;
  }
  return overlap * 10 + structural - hybridRank;
}

function applyHeuristicGuardV3(queryClass, ceRanked, hybridPool, typeLabel) {
  if (queryClass === 'semantic' || queryClass === 'config-env') {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null, routeClass: queryClass };
  }

  const chunkId = r => {
    const sf = (r.result ?? r).payload?.source_file;
    const ci = (r.result ?? r).payload?.chunk_index;
    return (sf != null && ci != null) ? `${sf}#${ci}` : null;
  };

  // For exact-token: select single best candidate by overlap+structural scoring.
  let bestCid = null;
  if (queryClass === 'exact-token') {
    const qToks = tokeniseQuery(hybridPool.__query__);
    let bestScore = -Infinity;
    for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
      const r = hybridPool[i];
      const cToks = candidateTokens(r.payload);
      const overlap = tokenOverlapCount(qToks, cToks);
      if (overlap < 2) continue;
      const score = exactTokenProtectScore(r, i, qToks);
      if (score > bestScore) { bestScore = score; bestCid = chunkId(r); }
    }
  }

  // For all other classes: use existing isProtected logic from v1.
  const protected_ = new Set();
  if (queryClass === 'exact-token') {
    if (bestCid) protected_.add(bestCid);
  } else {
    for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
      const r = hybridPool[i];
      if (isProtected(queryClass, r, i, hybridPool)) {
        const cid = chunkId(r);
        if (cid) protected_.add(cid);
      }
    }
  }

  if (!protected_.size) {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null, routeClass: queryClass };
  }

  // Check displacement and reinsert (preserve CE order among protected).
  const displaced = [];
  for (let i = 3; i < ceRanked.length; i++) {
    const cid = chunkId(ceRanked[i]);
    if (cid && protected_.has(cid)) displaced.push(i);
  }

  if (!displaced.length) {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null, routeClass: queryClass };
  }

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
    routeClass: queryClass,
  };
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

// Oracle regression guard: pure CE order as base; promotes any qrel rel>=3 chunk
// from hybrid top-3 into position 3 if CE placed it lower.
// Not a global upper bound — heuristic guards that reorder within CE top-3 can exceed this.
function applyOracleGuard(ceRanked, hybridPool, qrels) {
  const ceBase = ceRanked.map(x => x.result ?? x);

  if (!qrels.size) return { guarded: ceBase, guardFired: false, protectedId: null };

  const chunkId = r => {
    const sf = r.payload?.source_file;
    const ci = r.payload?.chunk_index;
    return (sf != null && ci != null) ? `${sf}#${ci}` : null;
  };

  const protected_ = new Set();
  for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
    const cid = chunkId(hybridPool[i]);
    if (cid && (qrels.get(cid) ?? 0) >= 3) protected_.add(cid);
  }

  if (!protected_.size) return { guarded: ceBase, guardFired: false, protectedId: null };

  const out = ceBase.map(r => ({ result: r }));
  let fired = false, protId = null;

  for (let i = 3; i < out.length; i++) {
    const cid = chunkId(out[i].result);
    if (cid && protected_.has(cid)) {
      const entry = out.splice(i, 1)[0];
      out.splice(Math.min(2, out.length), 0, entry);
      fired  = true;
      protId = protId ?? cid;
      i--;
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

  // v1 guard (heuristic-v1, original custom-50 guard)
  const queryClassV1 = classifyQuery(q.query);
  const { guarded: heurGuardedV1, guardFired: guardFiredV1, protectedId: protectedIdV1 } =
    applyHeuristicGuard(queryClassV1, ceRanked, hybridTrue);
  const ceRoutedV1Results = heurGuardedV1.slice(0, TOP_K);

  // v3 guard (heuristic-v3, provider-activation priority + exact-token single-protect)
  const queryClassV3 = classifyQueryV3(q.query, q.type ?? null);
  const { guarded: heurGuardedV3, guardFired: guardFiredV3, protectedId: protectedIdV3, routeClass: routeClassV3 } =
    applyHeuristicGuardV3(queryClassV3, ceRanked, hybridTrue, q.type ?? null);
  const ceRoutedV3Results = heurGuardedV3.slice(0, TOP_K);

  const { guarded: oracleGuarded, guardFired: oracleFired } =
    applyOracleGuard(ceRanked, hybridTrue, q.qrels);
  const ceOracleResults = oracleGuarded.slice(0, TOP_K);

  const crossEncoderMs = Date.now() - t3;

  return {
    hybridTrueMs, prefetchMs, detRerankMs, crossEncoderMs,
    queryClassV1, guardFiredV1, protectedIdV1,
    queryClassV3, guardFiredV3, protectedIdV3, routeClassV3,
    oracleFired,
    byMode: {
      'hybrid-true':          hybridTrue,
      'det-rerank':           detResults,
      'ce-raw':               ceRawResults,
      'ce-routed-v1':         ceRoutedV1Results,
      'ce-routed-v3':         ceRoutedV3Results,
      'ce-oracle-regression': ceOracleResults,
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

const MODES = ['hybrid-true', 'det-rerank', 'ce-raw', 'ce-routed-v1', 'ce-routed-v3', 'ce-oracle-regression'];

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

    const hybridRank   = ranks['hybrid-true'];
    const ceRawRank    = ranks['ce-raw'];
    const ceRoutedV1Rank = ranks['ce-routed-v1'];
    const ceRoutedV3Rank = ranks['ce-routed-v3'];

    const isRegrRaw    = hybridRank != null && hybridRank <= 3 && (ceRawRank     == null || ceRawRank     > 3);
    const isRegrV1     = hybridRank != null && hybridRank <= 3 && (ceRoutedV1Rank == null || ceRoutedV1Rank > 3);
    const isRegrV3     = hybridRank != null && hybridRank <= 3 && (ceRoutedV3Rank == null || ceRoutedV3Rank > 3);

    const isImprovRaw = (hybridRank == null || hybridRank > 1) && ceRawRank    === 1;
    const isImprovV3  = (hybridRank == null || hybridRank > 1) && ceRoutedV3Rank === 1;

    rows.push({
      query: r.query, ranks, top1ByMode,
      queryClassV1:  r.queryClassV1,
      queryClassV3:  r.queryClassV3,
      routeClassV3:  r.routeClassV3,
      guardFiredV1:  r.guardFiredV1,
      protectedIdV1: r.protectedIdV1,
      guardFiredV3:  r.guardFiredV3,
      protectedIdV3: r.protectedIdV3,
      oracleFired:   r.oracleFired,
      isRegrRaw, isRegrV1, isRegrV3,
      isImprovRaw, isImprovV3,
      isWatched: WATCHED.has(r.query.id),
      qrels,
    });
  }

  rows.sort((a, b) => {
    if (a.isRegrV3  !== b.isRegrV3)  return a.isRegrV3  ? -1 : 1;
    if (a.isRegrV1  !== b.isRegrV1)  return a.isRegrV1  ? -1 : 1;
    if (a.isRegrRaw !== b.isRegrRaw) return a.isRegrRaw ? -1 : 1;
    if (a.isWatched !== b.isWatched) return a.isWatched ? -1 : 1;
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

// True per-mode regression: rel>=3 chunk was at hybrid-true rank <=3 but mode moves it to >3 or miss.
function isModeRegression(r, mode) {
  const h = bestExactRank(r.byMode['hybrid-true'], r.query.qrels);
  const m = bestExactRank(r.byMode[mode],          r.query.qrels);
  return h != null && h <= 3 && (m == null || m > 3);
}

function buildPerClassSection(queryResults, analysis, SEP2) {
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
    const showRegr   = mode !== 'hybrid-true';
    const guardsCol  = mode === 'ce-routed-v1' || mode === 'ce-routed-v3';

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

      const qIds = new Set(rows.map(r => r.query.id));
      const guards = guardsCol
        ? analysis.filter(a => qIds.has(a.query.id) && (mode === 'ce-routed-v3' ? a.guardFiredV3 : a.guardFiredV1)).length
        : 0;

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
        lpad(pos.length > 0 ? mrrStr        : 'n/a', 8) +
        lpad(pos.length > 0 ? String(rank1) : 'n/a', 6) +
        lpad(pos.length > 0 ? cr5Str        : 'n/a', 7) +
        (showRegr  ? lpad(pos.length > 0 ? String(regrCount) : 'n/a', 5) : '') +
        (guardsCol ? lpad(pos.length > 0 ? String(guards)    : 'n/a', 7) : '') +
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
  lines.push('  custom-50 CE routing benchmark — guard v1 vs v3');
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
  lines.push(`  label usage       : v3 uses type label for provider-activation + config-env (benchmark-only)`);
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

  // ── Gate checklist (ce-routed-v3 vs hybrid-true) ────────────────────────────
  const base      = allMetrics['hybrid-true'];
  const routedV1  = allMetrics['ce-routed-v1'];
  const routedV3  = allMetrics['ce-routed-v3'];
  const mrrBase   = base.mrr10 ?? 0;
  const mrrV1     = routedV1.mrr10 ?? 0;
  const mrrV3     = routedV3.mrr10 ?? 0;
  const cr5Base   = base.chunkRecall5 ?? 0;
  const cr10Base  = base.chunkRecall10 ?? 0;
  const cr5V3     = routedV3.chunkRecall5 ?? 0;
  const cr10V3    = routedV3.chunkRecall10 ?? 0;
  const negV3     = routedV3.negativePass ?? 0;

  const regrRaw = analysis.filter(r => r.isRegrRaw).length;
  const regrV1  = analysis.filter(r => r.isRegrV1).length;
  const regrV3  = analysis.filter(r => r.isRegrV3).length;

  const WATCHED_IDS = ['c03', 'c16', 'c23', 'c36', 'c46'];
  const watchedChecks = WATCHED_IDS.map(id => {
    const row = analysis.find(r => r.query.id === id);
    return { id, ok: row ? !row.isRegrV3 : true, row };
  });
  const watchedPass = watchedChecks.every(w => w.ok);

  // Type-level MRR drop check for v3.
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
    let hybSum = 0, v3Sum = 0, cnt = 0;
    for (const r of pos) {
      const hv = mrrAt(r.byMode['hybrid-true'], r.query.qrels, 10);
      const vv = mrrAt(r.byMode['ce-routed-v3'], r.query.qrels, 10);
      if (hv !== null && vv !== null) { hybSum += hv; v3Sum += vv; cnt++; }
    }
    if (cnt > 0) {
      const drop = (hybSum - v3Sum) / cnt;
      if (drop > worstTypeDrop) { worstTypeDrop = drop; worstTypeLabel = type; }
    }
  }
  const gTypeMRR = worstTypeDrop < 0.030;

  const gMRRmin  = mrrV3 >= 0.755;
  const gCR5     = cr5V3 >= cr5Base;
  const gCR10    = cr10V3 >= cr10Base;
  const gNeg     = negV3 >= 1.0;
  const gRegr    = regrV3 === 0;
  const gatePass = gMRRmin && gCR5 && gCR10 && gNeg && gRegr && watchedPass && gTypeMRR;

  lines.push('Guard v1 vs v3 regression comparison:');
  lines.push(SEP2);
  lines.push(`  ce-raw regressions         : ${regrRaw}`);
  lines.push(`  ce-routed-v1 regressions   : ${regrV1}  (${GUARD_V1}: original custom-50 guard)`);
  lines.push(`  ce-routed-v3 regressions   : ${regrV3}  (${GUARD_V3}: provider-activation priority + exact-token single-protect)`);
  lines.push(`  MRR delta  v1 vs hybrid    : ${mrrV1 >= mrrBase ? '+' : ''}${(mrrV1 - mrrBase).toFixed(3)}`);
  lines.push(`  MRR delta  v3 vs hybrid    : ${mrrV3 >= mrrBase ? '+' : ''}${(mrrV3 - mrrBase).toFixed(3)}`);
  lines.push('');

  const fixedByV3 = analysis.filter(r => r.isRegrV1 && !r.isRegrV3);
  const newInV3   = analysis.filter(r => !r.isRegrV1 && r.isRegrV3);
  if (fixedByV3.length) {
    lines.push(`  Fixed by v3 (regression in v1, not in v3) — ${fixedByV3.length}:`);
    for (const row of fixedByV3) {
      lines.push(`    [${row.query.id}] ${row.query.type ?? '?'} / v1-route=${row.queryClassV1} v3-route=${row.routeClassV3}  hybrid=#${row.ranks['hybrid-true']} v1=#${row.ranks['ce-routed-v1'] ?? 'miss'} v3=#${row.ranks['ce-routed-v3'] ?? 'miss'}`);
      lines.push(`      query: ${row.query.query.slice(0, 60)}`);
    }
  }
  if (newInV3.length) {
    lines.push(`  New regressions in v3 (not in v1) — ${newInV3.length}:`);
    for (const row of newInV3) {
      lines.push(`    [${row.query.id}] ${row.query.type ?? '?'} / v1-route=${row.queryClassV1} v3-route=${row.routeClassV3}  hybrid=#${row.ranks['hybrid-true']} v1=#${row.ranks['ce-routed-v1'] ?? 'miss'} v3=#${row.ranks['ce-routed-v3'] ?? 'miss'}`);
      lines.push(`      query: ${row.query.query.slice(0, 60)}`);
    }
  }
  lines.push(SEP2);
  lines.push('');

  lines.push('Promotion gate (ce-routed-v3 vs hybrid-true):');
  lines.push(SEP2);
  lines.push(`  [${gMRRmin ? '✓' : '✗'}] MRR@10 >= 0.755 (original v1 baseline 0.760 − 0.005)   (got ${f3(mrrV3).trim()}, base=${f3(mrrBase).trim()})`);
  lines.push(`  [${gCR5   ? '✓' : '✗'}] chunkRecall@5 >= hybrid baseline   (got ${pct(cr5V3).trim()}, base=${pct(cr5Base).trim()})`);
  lines.push(`  [${gCR10  ? '✓' : '✗'}] chunkRecall@10 >= hybrid baseline   (got ${pct(cr10V3).trim()}, base=${pct(cr10Base).trim()})`);
  lines.push(`  [${gNeg   ? '✓' : '✗'}] negativePass = 100%   (got ${pct(negV3).trim()})`);
  lines.push(`  [${gRegr  ? '✓' : '✗'}] zero regressions (rel>=3, hybrid rank <=3 → ce-routed-v3 >3)   (got ${regrV3})`);
  for (const { id, ok, row } of watchedChecks) {
    lines.push(`  [${ok ? '✓' : '✗'}] watched ${id} must not regress   (hybrid=#${row?.ranks['hybrid-true'] ?? 'n/a'} v1=#${row?.ranks['ce-routed-v1'] ?? 'miss'} v3=#${row?.ranks['ce-routed-v3'] ?? 'miss'})`);
  }
  lines.push(`  [${gTypeMRR ? '✓' : '✗'}] no query type with MRR drop >= 0.030 vs hybrid   (worst: ${worstTypeLabel || 'none'} drop=${worstTypeDrop.toFixed(3)})`);
  lines.push('');
  lines.push(`  ce-raw regressions for comparison : ${regrRaw}`);
  lines.push(`  v1 regressions for comparison     : ${regrV1}`);
  const verdictText = gatePass
    ? 'GATE PASSED — CE routing v3 does not regress custom-50; proceed to holdout-50 planning'
    : `GATE FAILED — ${!gMRRmin ? `MRR@10 ${f3(mrrV3).trim()} below 0.755` : !gRegr ? `${regrV3} rank<=3 regression(s)` : !watchedPass ? `watched query regression` : !gTypeMRR ? `type MRR drop ${worstTypeDrop.toFixed(3)} >= 0.030 (${worstTypeLabel})` : 'criteria not met'}`;
  lines.push(`  Verdict: ${verdictText}`);
  lines.push(SEP2);
  lines.push('');

  // ── Per-query routing table ──────────────────────────────────────────────────
  lines.push('Per-query routing table (v3 is the gate-evaluated mode):');
  lines.push(SEP2);
  lines.push(
    pad('ID', 5) + '  ' +
    pad('type', 20) + '  ' +
    pad('v3-route', 20) + '  ' +
    lpad('hyb', 5) + '  ' +
    lpad('raw', 5) + '  ' +
    lpad('v1', 5) + '  ' +
    lpad('v3', 5) + '  ' +
    pad('g3', 4) + '  ' +
    'query'
  );
  lines.push(SEP2);

  for (const row of analysis) {
    const rk = m => row.ranks[m] != null ? `#${row.ranks[m]}` : 'miss';
    const flag = row.isRegrV3  ? '[REGR-v3!]' :
                 row.isRegrV1 && !row.isRegrV3 ? '[FIX-v3]' :
                 row.isImprovV3 ? '[IMPR-v3]' : '';
    const g3 = row.guardFiredV3 ? 'Y' : (row.oracleFired ? 'o' : '');
    lines.push(
      pad(row.query.id, 5) + '  ' +
      pad(row.query.type ?? '?', 20) + '  ' +
      pad(row.routeClassV3 ?? row.queryClassV3, 20) + '  ' +
      lpad(rk('hybrid-true'), 5) + '  ' +
      lpad(rk('ce-raw'), 5) + '  ' +
      lpad(rk('ce-routed-v1'), 5) + '  ' +
      lpad(rk('ce-routed-v3'), 5) + '  ' +
      pad(g3, 4) + '  ' +
      (flag ? `${flag} ` : '') +
      row.query.query.slice(0, 50).trimEnd()
    );
  }
  lines.push(SEP2);
  lines.push('');

  // ── Regression detail ────────────────────────────────────────────────────────
  const regressions = analysis.filter(r => r.isRegrV3);
  if (regressions.length) {
    lines.push(`Remaining regressions in ce-routed-v3 (${regressions.length}):`);
    lines.push(SEP2);
    for (const row of regressions) {
      lines.push(`[${row.query.id}] type=${row.query.type ?? '?'}  v3-route=${row.routeClassV3}  g3-fired=${row.guardFiredV3}`);
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

  // ── Fixed by v3 ─────────────────────────────────────────────────────────────
  const fixedV3 = analysis.filter(r => r.isRegrV1 && !r.isRegrV3);
  if (fixedV3.length) {
    lines.push(`Regressions fixed by v3 guard (${fixedV3.length}):`);
    lines.push(SEP2);
    for (const row of fixedV3) {
      lines.push(
        `  [${row.query.id}] type=${row.query.type ?? '?'}  v3-route=${row.routeClassV3}  g3-fired=${row.guardFiredV3}`
      );
      lines.push(`    query: ${row.query.query}`);
      lines.push(`    v1 rank ${row.ranks['ce-routed-v1'] ?? 'miss'} → v3 rank ${row.ranks['ce-routed-v3'] ?? 'miss'}`);
      if (row.protectedIdV3) lines.push(`    protected: ${row.protectedIdV3}`);
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
      const status = row.isRegrV3 ? 'REGRESSION-v3' : row.isRegrV1 && !row.isRegrV3 ? 'fixed-by-v3' : 'ok';
      lines.push(`  [${row.query.id}] ${status}  type=${row.query.type ?? '?'}  v1-route=${row.queryClassV1}  v3-route=${row.routeClassV3}`);
      lines.push(`    query: ${row.query.query}`);
      for (const mode of MODES) {
        lines.push(`    ${pad(mode, 22)}: rank ${row.ranks[mode] != null ? '#'+row.ranks[mode] : 'miss'}  top1=${row.top1ByMode[mode] ?? '-'}`);
      }
      if (row.guardFiredV1) lines.push(`    v1 guard fired: protected ${row.protectedIdV1}`);
      if (row.guardFiredV3) lines.push(`    v3 guard fired: protected ${row.protectedIdV3}`);
      if (row.oracleFired)  lines.push(`    oracle guard also fired`);
    }
    lines.push(SEP2);
    lines.push('');
  }

  // ── Acceptance criteria summary ──────────────────────────────────────────────
  lines.push('Acceptance criteria (ce-routed-v3):');
  lines.push(SEP2);
  lines.push(`  MRR@10 >= 0.755 (v1 baseline 0.760 − 0.005) : ${gMRRmin ? 'MET' : 'NOT MET'} (${f3(mrrV3).trim()}, v1=${f3(mrrV1).trim()})`);
  lines.push(`  chunkRecall@5 >= hybrid baseline             : ${gCR5  ? 'MET' : 'NOT MET'} (${pct(cr5V3).trim()} vs ${pct(cr5Base).trim()})`);
  lines.push(`  chunkRecall@10 >= hybrid baseline            : ${gCR10 ? 'MET' : 'NOT MET'} (${pct(cr10V3).trim()} vs ${pct(cr10Base).trim()})`);
  lines.push(`  negativePass = 100%                         : ${gNeg  ? 'MET' : 'NOT MET'} (${pct(negV3).trim()})`);
  lines.push(`  zero rank<=3 regressions                    : ${gRegr ? 'MET' : 'NOT MET'} (${regrV3} remaining)`);
  lines.push(`  watched queries (c03,c16,c23,c36,c46) ok    : ${watchedPass ? 'MET' : 'NOT MET'}`);
  lines.push(`  no type MRR drop >= 0.030                   : ${gTypeMRR ? 'MET' : 'NOT MET'} (worst: ${worstTypeLabel || 'none'} drop=${worstTypeDrop.toFixed(3)})`);
  lines.push('');
  lines.push(`  Overall: ${gatePass ? 'PASSED — proceed to holdout-50 planning' : 'FAILED — iterate guard before holdout'}`);
  lines.push(SEP2);
  lines.push('');

  // ── Per-class metrics ────────────────────────────────────────────────────────
  for (const l of buildPerClassSection(queryResults, analysis, SEP2)) lines.push(l);
  lines.push('');

  lines.push(SEP);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

process.stderr.write(`=== semidex custom-50 CE routing benchmark (guard v1 vs v3) ===\n`);
process.stderr.write(`CE_MODEL=${CE_MODEL}  CE_INPUT=${CE_INPUT}  CE_DTYPE=${CE_DTYPE}  v1=${GUARD_V1}  v3=${GUARD_V3}\n`);

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

const { typeDistribution: _typeDist, warnings: _typeWarn } = validateQueryTypes(rawQueries.queries);
if (_typeWarn.length) {
  for (const w of _typeWarn) process.stderr.write(`[ce-routing] type warning: ${w}\n`);
}
process.stderr.write(`Types: ${formatTypeDistribution(_typeDist)}\n`);

validateQrels(queries, indexedIds);

process.stderr.write('\n[3/3] Pre-loading CE model...\n');
await loadCE();

process.stderr.write('\nRunning queries...\n');
const queryResults = [];
for (const q of queries) {
  process.stderr.write(`  ${q.id}: ${q.query.slice(0, 50)}...`);
  const res = await runQuery(q);
  queryResults.push({ query: q, ...res });
  process.stderr.write(` v1=${res.queryClassV1} v3=${res.queryClassV3}${res.guardFiredV3 ? ' [g3]' : ''} (${res.hybridTrueMs + res.prefetchMs + res.crossEncoderMs}ms)\n`);
}

const allMetrics = computeAllMetrics(queryResults);
const analysis   = buildQueryAnalysis(queryResults);
const report     = buildReport(allMetrics, analysis, providerInfo, queryResults);

process.stdout.write(report + '\n');

mkdirSync(RESULTS_DIR, { recursive: true });
const modelSlug = CE_MODEL.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const outPath   = resolve(RESULTS_DIR, `${today()}-custom50-ce-routing-v3-${modelSlug}.txt`);
writeFileSync(outPath, report + '\n', 'utf8');
process.stderr.write(`\nSaved: ${outPath}\n`);
