// Unified embedding provider layer.
// All indexer/search/link code goes through here — no direct ollama/onnx imports needed.
//
// Providers:
//   ollama       — dense via Ollama API, sparse via hashed-tf (default)
//   bge-m3-onnx  — dense + sparse from local ONNX model (ONNX_EMBED=1 or denseProvider config)
//
// Valid combinations:
//   ollama      + hashed-tf    (default)
//   bge-m3-onnx + bge-m3-onnx (ONNX_EMBED=1)
// Mixed combinations are rejected at call time to prevent payload/metadata drift.
//
// Every function here takes an already-resolved embedding PROFILE (see
// src/core/embedding-profile/schema.js) directly — never a bare collection
// name. This module no longer reads config.json or env itself at all; the
// caller is responsible for resolving the profile first, via
// src/core/embedding-profile/resolve.js's resolveExistingCollectionProfile()
// (existing collection) or resolveNewCollectionProfile() (new collection).
// This is what guarantees indexing and search always embed against the
// SAME identity — before this change, embedForIndex/embedForIndexBatch
// still read config.json independently of embedForSearch's own resolution,
// so after config.json was lost/wrong, search could be "fixed" via a
// different resolution path while reindexing silently wrote incompatible
// vectors into the same collection.

import { embed as ollamaEmbed } from './ollama-lazy.js';
import { loadOnnx, loadOnnxBatch } from './onnx-embed-lazy.js';
import { encode as hashedTfEncode } from './sparse.js';
import { assertProviderCombo } from './env.js';
import { EXECUTION } from './embedding-profile/schema.js';
import { findDenseModel, checkEmbedInputFits, fitContextToBudget } from './embedding-profile/qdrant-cloud-catalog.js';
import { emitTelemetry } from './bench-telemetry.js';

export const SCHEMA_VERSION = 2;

// ── DML batching gate ─────────────────────────────────────────────────────────

/**
 * Returns true only when ONNX_EMBED=1 and ONNX_EXECUTION_PROVIDER=dml.
 * All other providers (cpu, cuda, unset) return false. CUDA can use a custom
 * runtime build, while the default package remains CPU-only.
 * @param {NodeJS.ProcessEnv} env
 */
export function shouldUseOnnxBatching(env) {
  const onnxEmbed = env.ONNX_EMBED === '1' || env.ONNX_EMBED === 'true';
  const provider  = (env.ONNX_EXECUTION_PROVIDER ?? '').trim().toLowerCase();
  return onnxEmbed && provider === 'dml';
}

/**
 * Parse ONNX_BATCH_SIZE from env. Valid range 1–64; invalid values warn and use 4.
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
export function resolveOnnxBatchSize(env) {
  const raw = parseInt(env.ONNX_BATCH_SIZE ?? '4', 10);
  if (!Number.isFinite(raw) || raw < 1 || raw > 64) {
    process.stderr.write(`[onnx] ONNX_BATCH_SIZE="${env.ONNX_BATCH_SIZE}" invalid — using 4\n`);
    return 4;
  }
  return raw;
}

// ── Lazy singletons ───────────────────────────────────────────────────────────
//
// loadOnnx/loadOnnxBatch now live in core/onnx-embed-lazy.js (imported
// above) — extracted so this file's own static import graph never pulls
// onnx-embed.js/length-bucket.js, matching the ollama-lazy.js pattern this
// file already uses for Ollama (see the top-of-file import). See
// onnx-embed-lazy.js's own header comment for the full rationale.

// Adapts a resolved embedding profile's dense/sparse lanes into the small
// { denseProvider, denseModel, sparseProvider } shape _embed()'s dispatch
// logic already expects — the dispatch logic itself is unchanged, only
// what builds this input changed (profile-driven, not config.json-driven).
function laneConfig(profile) {
  return {
    denseProvider: profile.embedding.dense.provider,
    denseModel: profile.embedding.dense.model,
    sparseProvider: profile.embedding.sparse?.provider ?? null,
  };
}

// A profile whose dense execution mode isn't 'client' (e.g. 'qdrant-cloud',
// 'qdrant-cluster') cannot be embedded by this module at all — this module
// only ever performs CLIENT-side embedding (ONNX/Ollama, in this process).
// Throwing here (rather than silently attempting local dispatch) is what
// lets a caller (Part E's query/index paths) surface a precise typed
// "unsupported execution" result instead of a confusing provider error, and
// guarantees this module never falls back to a local default model for an
// unsupported profile.
function assertClientExecution(profile) {
  if (profile.embedding.dense.execution !== EXECUTION.CLIENT) {
    throw new Error(`embeddings.js only supports execution: 'client' — profile declares '${profile.embedding.dense.execution}', which this module cannot embed itself.`);
  }
}

// Typed error thrown by embedForIndexCloud()/embedForIndexBatch() when a
// chunk's assembled embed text cannot be safely sent to Qdrant Cloud
// Inference — always a hard stop, never caught-and-truncated anywhere in
// this call chain. `code` is one of the checkEmbedInputFits() codes:
// EMBEDDING_INPUT_TOO_LONG (the chunk BODY alone, even with context fully
// trimmed to nothing, still exceeds the model's context window — trimming
// context can never fix this, since text is never shortened) or
// TOKENIZER_UNAVAILABLE (the tokenizer itself couldn't be loaded — never
// silently downgrades to the heuristic as a substitute safety gate).
export class EmbeddingInputTooLongError extends Error {
  constructor(code, details) {
    super(`embedForIndexCloud: ${code}${details.message ? ` — ${details.message}` : ''}`);
    this.name = 'EmbeddingInputTooLongError';
    this.code = code;
    Object.assign(this, details);
  }
}

const CONTEXT_TEXT_SEPARATOR = '\n\n';

// Cloud-only sibling of embedForIndex — never touches _embed/loadOnnx/
// ollamaEmbed/assertClientExecution. Builds {text, model} inference
// descriptors, never real vector arrays.
//
// `text` is ALWAYS the full assembled embed string (context+text joined by
// CONTEXT_TEXT_SEPARATOR — src/indexer/run.js's stageC — or a bare summary
// string with no separate context), matching every other caller's
// convention in this file. `context` (optional) is the SAME context string
// already folded into the front of `text`, supplied separately so that,
// if the full assembly doesn't fit, `context` (never the chunk body —
// silently shortening indexed content is forbidden) can be trimmed via
// fitContextToBudget() and the check retried once with a shortened
// assembly. This is what keeps a typical-sized chunk (body near
// MAX_CHUNK_TOKENS, plus a normal heading-path/skeleton-summary context)
// from hard-failing indexing on a model like E5 whose window equals
// MAX_CHUNK_TOKENS — reserving budget for context instead of rejecting
// outright. A chunk whose BODY ALONE already exceeds the window still
// throws — trimming context can never rescue that case.
//
// When `context` is omitted (e.g. a directory/skeleton summary string with
// no real context prefix to trim), behavior is unchanged from before this
// fix: `text` is checked as-is, and a failing check throws immediately
// with no retry.
async function embedForIndexCloud(profile, text, context = null) {
  const denseModelId = profile.embedding.dense.model;
  const sparseModelId = profile.embedding.sparse?.model;

  const denseCatalog = findDenseModel(denseModelId);
  if (!denseCatalog) {
    throw new Error(`embedForIndexCloud: "${denseModelId}" is not in the supported Qdrant Cloud dense model catalog`);
  }
  if (denseCatalog.status !== 'supported') {
    throw new Error(`embedForIndexCloud: "${denseModelId}" is not a supported Qdrant Cloud dense model (${denseCatalog.reason})`);
  }

  let embedText = text;
  // Only attempt the trim-and-retry when `text` genuinely starts with
  // `context` + the known separator — i.e. `text` really is the assembled
  // `context+body` string this function expects, not some unrelated
  // caller-supplied string that merely happens to have a context value
  // alongside it. The chunk body is derived by SLICING, never rebuilt by
  // concatenation, so it is always byte-identical to what the caller
  // intended as the indexed content, regardless of what separator-like
  // substrings the body itself might contain.
  if (context !== null && text.startsWith(`${context}${CONTEXT_TEXT_SEPARATOR}`)) {
    const body = text.slice(context.length + CONTEXT_TEXT_SEPARATOR.length);
    const fitted = await fitContextToBudget(denseCatalog, context, body);
    if (fitted !== null) {
      embedText = `${fitted.context}${CONTEXT_TEXT_SEPARATOR}${body}`;
    }
    // fitted === null: the chunk body alone (even with context reduced to
    // empty) still doesn't fit, or the tokenizer couldn't be loaded to
    // attempt trimming — fall through to the exact check below, which
    // reports the precise typed reason (EMBEDDING_INPUT_TOO_LONG vs
    // TOKENIZER_UNAVAILABLE) against the ORIGINAL untrimmed text.
  }

  const fit = await checkEmbedInputFits(denseCatalog, embedText);
  if (!fit.fits) {
    throw new EmbeddingInputTooLongError(fit.code, fit);
  }

  // Opt-in benchmark telemetry (no-op unless SEMIDEX_BENCH_TELEMETRY_PATH
  // is set — see src/core/bench-telemetry.js). Fired here, after the
  // fits-check passes, with embedText's FINAL post-context-trim value —
  // the exact text that will actually be sent as the inference
  // descriptor, never the original pre-trim `text` parameter.
  emitTelemetry({ kind: 'inference', phase: 'indexing', lane: 'dense', textLength: embedText.length, model: denseModelId });
  if (sparseModelId) {
    emitTelemetry({ kind: 'inference', phase: 'indexing', lane: 'sparse', textLength: embedText.length, model: sparseModelId });
  }

  return {
    dense: { text: embedText, model: denseModelId },
    sparse: sparseModelId ? { text: embedText, model: sparseModelId } : null,
    meta: {
      dense_provider:           'qdrant-cloud',
      dense_model:              denseModelId,
      sparse_provider:          sparseModelId ? 'qdrant-cloud' : null,
      embedding_schema_version: profile.embeddingSchemaVersion,
    },
  };
}

/**
 * Embed text for indexing. Returns vectors + the metadata to store in payload.
 * For a qdrant-cloud profile, returns {text, model} inference descriptors
 * instead of real arrays — never touches local ONNX/Ollama code.
 * @param {Object} profile — an already-resolved, valid embedding profile
 * @param {string} text — the full assembled embed input (context+text for a
 *   real chunk, or a bare summary string for e.g. a directory/skeleton
 *   summary with no separate context to reserve budget for)
 * @param {{ context?: string }} [opts] — cloud-only: the context prefix
 *   already folded into `text`, supplied separately so a too-long input
 *   can have ITS CONTEXT trimmed (never the chunk body) and be retried
 *   once before failing. Ignored for a client-execution profile.
 * @returns {Promise<{ dense: number[]|{text,model}, sparse: object|{text,model}|null, meta: object }>}
 */
export async function embedForIndex(profile, text, { context = null } = {}) {
  if (profile.embedding.dense.execution === EXECUTION.QDRANT_CLOUD) {
    return embedForIndexCloud(profile, text, context);
  }
  assertClientExecution(profile);
  const cfg = laneConfig(profile);
  const { dense, sparse } = await _embed(cfg, text);
  return {
    dense,
    sparse,
    meta: {
      dense_provider:        cfg.denseProvider,
      dense_model:           cfg.denseModel,
      sparse_provider:       cfg.sparseProvider,
      embedding_schema_version: profile.embeddingSchemaVersion,
    },
  };
}

/**
 * Embed a batch of texts for indexing. DML-gated: uses length-bucketed batch
 * inference when ONNX_EMBED=1 + ONNX_EXECUTION_PROVIDER=dml; otherwise falls
 * back to the same concurrent runBatched behavior as the current per-text path.
 *
 * Return shape per element: { dense, sparse, meta } — identical to embedForIndex.
 *
 * @param {Object} profile — an already-resolved, valid embedding profile
 * @param {string[]} texts — pre-formatted embed texts
 * @param {(items: any[], size: number, fn: Function) => Promise<any[]>} runBatched
 * @param {number} batchSize — LLM_BATCH_SIZE for the non-DML concurrent path
 * @param {{ contexts?: (string|null)[] }} [opts] — cloud-only: per-text
 *   context prefixes (same index order as `texts`), see embedForIndex()'s
 *   own `context` option. Omitted or a shorter/missing entry means "no
 *   known context prefix to trim" for that text, matching embedForIndex()'s
 *   default.
 * @returns {Promise<Array<{ dense: number[], sparse: object, meta: object }>>}
 */
export async function embedForIndexBatch(profile, texts, runBatched, batchSize, { contexts = null } = {}) {
  if (profile.embedding.dense.execution === EXECUTION.QDRANT_CLOUD) {
    // Each chunk's checkEmbedInputFits() gate (with the context-trim retry)
    // still runs individually inside embedForIndexCloud() — batching here
    // is plain concurrency via runBatched, never DML/ONNX batching
    // (shouldUseOnnxBatching() is never consulted for a cloud profile — a
    // separate top-level branch, not a downstream condition, so this is
    // structurally unreachable). texts/contexts are zipped BEFORE calling
    // runBatched — its own batch.map(fn) index is relative to each batch
    // slice, not the original array, so pairing up front (rather than
    // indexing into `contexts` inside the callback) is what keeps each
    // text matched to its own context correctly across every batch.
    const pairs = texts.map((text, i) => ({ text, context: contexts?.[i] ?? null }));
    return runBatched(pairs, batchSize, ({ text, context }) => embedForIndexCloud(profile, text, context));
  }
  assertClientExecution(profile);
  const cfg = laneConfig(profile);
  assertProviderCombo(cfg.denseProvider, cfg.sparseProvider);
  const meta = {
    dense_provider:           cfg.denseProvider,
    dense_model:              cfg.denseModel,
    sparse_provider:          cfg.sparseProvider,
    embedding_schema_version: profile.embeddingSchemaVersion,
  };

  if (cfg.denseProvider === 'bge-m3-onnx' && shouldUseOnnxBatching(process.env)) {
    const maxBatch = resolveOnnxBatchSize(process.env);
    const { embedOnnxBatch, embedBucketed } = await loadOnnxBatch();
    const vectors = await embedBucketed(texts, embedOnnxBatch, maxBatch);
    return vectors.map(({ dense, sparse }) => ({ dense, sparse, meta }));
  }

  // Non-DML path: preserve existing concurrent runBatched behavior.
  return runBatched(texts, batchSize, async (text) => {
    const { dense, sparse } = await _embed(cfg, text);
    return { dense, sparse, meta };
  });
}

/**
 * Embed a search query. Returns dense + sparse vectors only.
 * @param {Object} profile — an already-resolved, valid embedding profile
 * @param {string} query
 * @returns {Promise<{ dense: number[], sparse: { indices: number[], values: number[] } }>}
 */
export async function embedForSearch(profile, query) {
  assertClientExecution(profile);
  const cfg = laneConfig(profile);
  return _embed(cfg, query);
}


// Test-only override seam for the CLIENT (local ONNX/Ollama) embed step —
// mirrors this codebase's existing storeOverrides()-style DI pattern
// (e.g. src/core/qdrant/store.js). NEVER used by production code (nothing
// in src/ outside this file calls setLocalEmbedOverrideForTest); it exists
// specifically so a test can inject a throw-if-called sentinel and assert,
// BEHAVIORALLY (not via source regex), that a qdrant-cloud profile's
// embedForIndex/embedForIndexBatch calls NEVER reach this function — see
// tests/unit/core/embeddings.test.js.
let _localEmbedOverrideForTest = null;
export function setLocalEmbedOverrideForTest(fn) { _localEmbedOverrideForTest = fn; }

async function _embed(cfg, text) {
  if (_localEmbedOverrideForTest) return _localEmbedOverrideForTest(cfg, text);

  assertProviderCombo(cfg.denseProvider, cfg.sparseProvider);

  if (cfg.denseProvider === 'bge-m3-onnx') {
    const embedOnnx = await loadOnnx();
    const { dense, sparse } = await embedOnnx(text);
    return { dense, sparse };
  }

  // ollama + hashed-tf
  const [dense, sparse] = await Promise.all([
    ollamaEmbed(text, cfg.denseModel),
    Promise.resolve(hashedTfEncode(text)),
  ]);
  return { dense, sparse };
}
