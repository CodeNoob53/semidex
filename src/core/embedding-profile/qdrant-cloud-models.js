// Pure-data Qdrant Cloud Inference model catalog — zero dependencies (no
// fs, no fetch, no tokenizer). Split out of qdrant-cloud-catalog.js
// specifically so the Admin Settings UI (browser bundle, built via Vite)
// can import the catalog data + coarse compatibility check WITHOUT pulling
// in qdrant-cloud-tokenizer.js's Node-only fs/fetch code and the native
// @huggingface/tokenizers package — those stay server-only, reachable
// through qdrant-cloud-catalog.js's checkEmbedInputFits(), never through
// this file. This is the ONE source of truth for model
// ID/dimensions/context window/status; qdrant-cloud-catalog.js re-exports
// everything here unchanged.
export const QDRANT_CLOUD_DENSE_MODELS = Object.freeze([
  Object.freeze({
    id: 'intfloat/multilingual-e5-small',
    displayName: 'Multilingual E5 Small',
    vectorType: 'dense',
    modality: 'text',
    dimensions: 384,
    contextWindow: 512,
    costLabel: 'Free',
    status: 'supported',
    reason: null,
  }),
  Object.freeze({
    id: 'sentence-transformers/all-minilm-l6-v2',
    displayName: 'All MiniLM L6 v2',
    vectorType: 'dense',
    modality: 'text',
    dimensions: 384,
    contextWindow: 256,
    costLabel: 'Free',
    status: 'unsupported',
    reason: 'Context window (256 tokens) is smaller than Semidex\'s default chunk budget (MAX_CHUNK_TOKENS=512) plus structural context — indexing with this model risks silent truncation of indexed evidence.',
  }),
]);

export const QDRANT_CLOUD_SPARSE_MODELS = Object.freeze([
  Object.freeze({
    id: 'qdrant/bm25',
    displayName: 'BM25 (Qdrant-hosted)',
    vectorType: 'sparse',
    modality: 'text',
    dimensions: null,
    contextWindow: null,
    costLabel: 'Free',
    status: 'supported',
    reason: null,
    modifier: 'idf',
  }),
]);

export function findDenseModel(id) {
  return QDRANT_CLOUD_DENSE_MODELS.find((m) => m.id === id) ?? null;
}

export function findSparseModel(id) {
  return QDRANT_CLOUD_SPARSE_MODELS.find((m) => m.id === id) ?? null;
}

export function isDenseModelSupported(id) {
  const model = findDenseModel(id);
  return model !== null && model.status === 'supported';
}

/**
 * Coarse, settings-time compatibility check: does this model's context
 * window fit Semidex's chunk budget in the best case (ignoring the
 * heading-path/skeleton-summary context that gets prepended at embed
 * time)? This can only ever rule OUT hopeless models (e.g. MiniLM's 256
 * tokens vs. a 512-token chunk budget) — it can never certify that every
 * future chunk will fit, since it never sees real chunk text. The real,
 * exact gate is checkEmbedInputFits() (qdrant-cloud-catalog.js), run per
 * chunk at embed time against the actual assembled string.
 * @param {{contextWindow: number|null}} model
 * @param {{maxChunkTokens: number}} opts
 * @returns {boolean}
 */
export function isCatalogCompatibleWithChunking(model, { maxChunkTokens }) {
  return model.contextWindow == null || model.contextWindow >= maxChunkTokens;
}
