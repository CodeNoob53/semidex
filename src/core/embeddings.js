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
// Config key read order: config.json collection entry → env fallback.

import { embed as ollamaEmbed } from './ollama.js';
import { encode as hashedTfEncode } from './sparse.js';
import { getDenseProvider, getDenseModel, getSparseProvider } from './config.js';
import { assertProviderCombo } from './env.js';

export const SCHEMA_VERSION = 2;

// ── DML batching gate ─────────────────────────────────────────────────────────

/**
 * Returns true only when ONNX_EMBED=1 and ONNX_EXECUTION_PROVIDER=dml.
 * All other providers (cpu, cuda, unset) return false — CPU batching regresses
 * and CUDA falls back to CPU in the current onnxruntime-node package.
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

/**
 * Returns the resolved provider config for a collection.
 * @param {string} collection
 * @returns {{ denseProvider: string, denseModel: string, sparseProvider: string, schemaVersion: number }}
 */
export function getEmbeddingConfig(collection) {
  return {
    denseProvider:  getDenseProvider(collection),
    denseModel:     getDenseModel(collection),
    sparseProvider: getSparseProvider(collection),
    schemaVersion:  SCHEMA_VERSION,
  };
}

/**
 * Embed text for indexing. Returns vectors + the metadata to store in payload.
 * @param {string} collection
 * @param {string} text
 * @returns {Promise<{ dense: number[], sparse: { indices: number[], values: number[] }, meta: object }>}
 */
export async function embedForIndex(collection, text) {
  const cfg = getEmbeddingConfig(collection);
  const { dense, sparse } = await _embed(cfg, text);
  return {
    dense,
    sparse,
    meta: {
      dense_provider:        cfg.denseProvider,
      dense_model:           cfg.denseModel,
      sparse_provider:       cfg.sparseProvider,
      embedding_schema_version: cfg.schemaVersion,
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
 * @param {string} collection
 * @param {string[]} texts — pre-formatted embed texts
 * @param {(items: any[], size: number, fn: Function) => Promise<any[]>} runBatched
 * @param {number} batchSize — LLM_BATCH_SIZE for the non-DML concurrent path
 * @returns {Promise<Array<{ dense: number[], sparse: object, meta: object }>>}
 */
export async function embedForIndexBatch(collection, texts, runBatched, batchSize) {
  const cfg = getEmbeddingConfig(collection);
  assertProviderCombo(cfg.denseProvider, cfg.sparseProvider);
  const meta = {
    dense_provider:           cfg.denseProvider,
    dense_model:              cfg.denseModel,
    sparse_provider:          cfg.sparseProvider,
    embedding_schema_version: cfg.schemaVersion,
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
 * @param {string} collection
 * @param {string} query
 * @returns {Promise<{ dense: number[], sparse: { indices: number[], values: number[] } }>}
 */
export async function embedForSearch(collection, query) {
  const cfg = getEmbeddingConfig(collection);
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
