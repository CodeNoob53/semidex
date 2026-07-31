// Semidex Lite settings allow-list — pure data, no I/O. The single source
// of truth for which definitions.js keys a cloud-only Lite deployment may
// read/write through the Settings API. Anything not listed here is
// rejected (see settings-service.lite.js), never silently accepted or
// silently dropped.
//
// Rationale per key:
//  - QDRANT_URL/QDRANT_KEY: the only storage backend Lite supports.
//  - QDRANT_CLOUD_DENSE_MODEL/QDRANT_SPARSE_MODEL: Qdrant Cloud Inference
//    embedding model selection for new collections.
//  - EMBEDDING_BACKEND/DENSE_PROVIDER/SPARSE_PROVIDER/VECTOR_SIZE: the
//    provider-selection surface EMBEDDING_BACKEND expands into — kept even
//    though Lite's hard pins (server.js CLI) already force
//    DENSE_PROVIDER=SPARSE_PROVIDER=qdrant-cloud, so the Settings API can
//    still render the (now read-only-in-practice, since any write attempt
//    would conflict with the os_env pin) current value rather than 404ing
//    on a field the UI's shared rendering code expects to exist.
//  - SEMIDEX_GENERATION_BACKEND/ASK_MODEL/ASK_NUM_CTX/GEMINI_API_KEY: the
//    only generation backend Lite supports.
//  - CONTEXT_MODE: hard-pinned to 'deterministic' by the CLI, kept
//    read-only-in-practice for the same reason as the provider keys above.
//  - ADMIN_HOST/ADMIN_PORT/ADMIN_ALLOW_REMOTE/SEMIDEX_STORAGE_BACKEND:
//    ordinary server bind/runtime settings, no local-model concept.
//  - HYBRID_PREFETCH_LIMIT/RRF_K: read internally by
//    core/qdrant/store.js's hybridSearch()/hybridSearchCloud() on every
//    search request via the SAME shared settingsService instance that
//    backs the Settings API (registerNeutralRoutes passes one instance to
//    both registerSearchRoutes and registerSettingsRoutes) — must stay
//    Lite-allowed or every Lite search would throw not_available_in_lite
//    (found via a full call-site audit of getActiveValue(), not
//    aspirational: excluding these silently broke retrieval).
// Explicitly EXCLUDED (not_available_in_lite): every ONNX_*/TAG_ONNX_*/
// RERANK_CE_*/ONNXRUNTIME_NODE_PATH field (local ONNX runtime), OLLAMA_URL/
// TAG_MODEL/TAG_PROVIDER/CONTEXT_MODEL/GENERATION_DEVICE/DENSE_MODEL/
// EMBED_MODEL (Ollama-only concepts), MAX_CHUNK_TOKENS and the rest of the
// chunking/retrieval-tuning surface (full-Semidex advanced tuning, out of
// scope for Lite's minimal cloud surface — may be added later without
// breaking compatibility, since expanding an allow-list is additive).
export const LITE_SETTINGS_KEYS = Object.freeze([
  'QDRANT_URL',
  'QDRANT_KEY',
  'QDRANT_CLOUD_DENSE_MODEL',
  'QDRANT_SPARSE_MODEL',
  'EMBEDDING_BACKEND',
  'DENSE_PROVIDER',
  'SPARSE_PROVIDER',
  'VECTOR_SIZE',
  'SEMIDEX_GENERATION_BACKEND',
  'ASK_MODEL',
  'ASK_NUM_CTX',
  'GEMINI_API_KEY',
  'CONTEXT_MODE',
  'SEMIDEX_STORAGE_BACKEND',
  'ADMIN_HOST',
  'ADMIN_PORT',
  'ADMIN_ALLOW_REMOTE',
  'HYBRID_PREFETCH_LIMIT',
  'RRF_K',
]);

export const LITE_SETTINGS_KEY_SET = new Set(LITE_SETTINGS_KEYS);

export function isLiteSettingsKey(key) {
  return LITE_SETTINGS_KEY_SET.has(key);
}
