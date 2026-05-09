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

export const SCHEMA_VERSION = 2;

let _embedOnnx = null;
async function loadOnnx() {
  if (!_embedOnnx) _embedOnnx = (await import('./onnx-embed.js')).embedOnnx;
  return _embedOnnx;
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
 * Embed a search query. Returns dense + sparse vectors only.
 * @param {string} collection
 * @param {string} query
 * @returns {Promise<{ dense: number[], sparse: { indices: number[], values: number[] } }>}
 */
export async function embedForSearch(collection, query) {
  const cfg = getEmbeddingConfig(collection);
  return _embed(cfg, query);
}

const VALID_COMBOS = new Set(['ollama:hashed-tf', 'bge-m3-onnx:bge-m3-onnx']);

function assertValidCombo(denseProvider, sparseProvider) {
  const key = `${denseProvider}:${sparseProvider}`;
  if (!VALID_COMBOS.has(key)) {
    throw new Error(
      `Unsupported provider combination: denseProvider="${denseProvider}", sparseProvider="${sparseProvider}". ` +
      `Valid combinations: ollama+hashed-tf, bge-m3-onnx+bge-m3-onnx.`
    );
  }
}

async function _embed(cfg, text) {
  assertValidCombo(cfg.denseProvider, cfg.sparseProvider);

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
