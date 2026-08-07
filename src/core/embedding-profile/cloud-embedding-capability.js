// CloudEmbeddingCapability contract (Phase 8B Step 6, code review fix) —
// mirrors onnx-embed-capability.js/generation/provider.js/storage/
// adapter.js: a small runtime shape validator plus JSDoc typedefs, zero
// backend imports (never imports src/cloud/embedding/qdrant-cloud-catalog.js
// or src/cloud/embedding/qdrant-cloud-tokenizer.js directly). Every real
// shared consumer (core/embeddings.js, core/retrieval/search.js,
// core/token-count.js, indexer/run.js) depends on THIS shape only — never
// on the real qdrant-cloud-catalog.js implementation directly — via an
// injected `cloudEmbed` capability parameter.
//
// Code review finding (the actual defect this contract fixes): the
// original Step 6 relocation moved the seven cloud-only files into
// src/cloud/ but left every shared consumer with a direct, unconditional
// static import of the real implementation — a pure path rename, not the
// architectural separation the task required. `shared -> cloud`
// IMPLEMENTATION edges are the exact thing Part C's dependency rules
// forbid; only `shared -> shared` (this contract, and the genuinely
// neutral catalog DATA in qdrant-cloud-models.js) and
// `composition root -> cloud` (the real factory call, made once at
// startup) are allowed.
//
// Every method here is a THIN pass-through to qdrant-cloud-catalog.js's
// own same-named export — this contract does not change behavior, call
// shape, or error types; it only moves WHERE the real implementation is
// selected from (a composition root, not a shared module's own static
// import).

/**
 * @typedef {Object} CloudEmbeddingCapability
 * @property {(model: {id: string, contextWindow: number|null}, embedText: string) => Promise<
 *   | { fits: true, tokenCount: number|null, contextWindow: number|null }
 *   | { fits: false, code: 'TOKENIZER_UNAVAILABLE', message: string }
 *   | { fits: false, code: 'EMBEDDING_INPUT_TOO_LONG', tokenCount: number, contextWindow: number }
 * >} checkEmbedInputFits — real per-embed input-budget check (real tokenizer, never the heuristic).
 * @property {(model: {id: string, contextWindow: number|null}, context: string, text: string) => Promise<{ context: string, tokenCount: number } | null>} fitContextToBudget — trims `context` (never `text`) to fit the model's window.
 * @property {(profile: Object, query: string) => { denseQuery: {text: string, model: string}, sparseQuery: {text: string, model: string}|null }} buildCloudQueryInputs — pure descriptor assembly, no network call.
 * @property {(profile: Object) => { maxInputTokens: number, countTokens: (text: string) => Promise<number> }|null} resolveEmbeddingBudget — generic chunk-sizing budget for a qdrant-cloud profile, or null for a non-cloud profile.
 * @property {(modelId: string, options?: { localFilesOnly?: boolean }) => Promise<(text: string) => Promise<number>>} getCloudTokenCounter — a per-model-id counter function, for core/token-count.js's own resolveTokenCountMode()/getTokenCounter() dispatch (the token-counting concern is distinct from the embed-fit-check concern above, but backed by the same real tokenizer loader).
 */

export const REQUIRED_CLOUD_EMBEDDING_CAPABILITY_METHODS = [
  'checkEmbedInputFits', 'fitContextToBudget', 'buildCloudQueryInputs', 'resolveEmbeddingBudget', 'getCloudTokenCounter',
];

/**
 * Verify an object satisfies the CloudEmbeddingCapability shape. Shallow,
 * like the sibling capability/provider/adapter validators — a shape
 * check, not a type system.
 * @param {Object} capability
 * @throws {Error} with an actionable message naming the missing piece
 */
export function validateCloudEmbeddingCapability(capability) {
  if (typeof capability !== 'object' || capability === null) {
    throw new Error('validateCloudEmbeddingCapability: capability must be a non-null object');
  }

  const missing = REQUIRED_CLOUD_EMBEDDING_CAPABILITY_METHODS.filter(m => typeof capability[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `validateCloudEmbeddingCapability: capability is missing required method(s): ${missing.join(', ')}`
    );
  }

  return true;
}
