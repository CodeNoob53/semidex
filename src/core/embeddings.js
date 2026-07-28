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

import { embed as ollamaEmbed } from './ollama.js';
import { encode as hashedTfEncode } from './sparse.js';
import { assertProviderCombo } from './env.js';
import { EXECUTION } from './embedding-profile/schema.js';

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

let _embedOnnx      = null;
let _embedOnnxBatch = null;
let _embedBucketed  = null;

async function loadOnnx() {
  if (!_embedOnnx) _embedOnnx = (await import('./onnx-embed.js')).embedOnnx;
  return _embedOnnx;
}

async function loadOnnxBatch() {
  if (!_embedOnnxBatch) _embedOnnxBatch = (await import('./onnx-embed.js')).embedOnnxBatch;
  if (!_embedBucketed)  _embedBucketed  = (await import('./length-bucket.js')).embedBucketed;
  return { embedOnnxBatch: _embedOnnxBatch, embedBucketed: _embedBucketed };
}

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

/**
 * Embed text for indexing. Returns vectors + the metadata to store in payload.
 * @param {Object} profile — an already-resolved, valid embedding profile
 * @param {string} text
 * @returns {Promise<{ dense: number[], sparse: { indices: number[], values: number[] }, meta: object }>}
 */
export async function embedForIndex(profile, text) {
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
 * @returns {Promise<Array<{ dense: number[], sparse: object, meta: object }>>}
 */
export async function embedForIndexBatch(profile, texts, runBatched, batchSize) {
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


async function _embed(cfg, text) {
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
