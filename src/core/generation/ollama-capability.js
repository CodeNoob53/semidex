// Ollama capability contracts (Phase 8B Step 1, split twice after code
// review — see the Phase 8B report's own "P2" notes) — mirror
// provider.js/adapter.js: small runtime shape validators plus JSDoc
// typedefs, zero backend imports (never import core/ollama.js,
// onnxruntime-node, or @huggingface/transformers).
//
// Round 1: a first version of this file copied all 9 of
// core/ollama-lazy.js's exports into a single OllamaCapability shape,
// which forced every consumer to implement methods it never calls.
// Round 2: the post-round-1 OllamaGenerationCapability (4 methods) was
// STILL wider than each individual consumer needed — context.js/tag.js/
// combined.js each call ONLY generate(); skeleton-summary.js calls
// generate()/getModelContextLength()/isThinkingModel() but never
// generateStream(). Checked directly (grepping every real _ollama.*/
// *Fn call site, not assumed) that generateStream() is called through NO
// capability object anywhere in src/ — its one real consumer,
// core/generation/ollama-provider.js, already has its own separate,
// working per-method DI (generateStreamFn, unchanged by this file) that
// has nothing to do with these contracts. So generateStream() does not
// belong in any contract here at all.
//
// Four contracts, matching real per-consumer usage exactly:
//   - OllamaGenerateCapability: generate — used by indexer/phases/{combined,context,tag}.js.
//   - OllamaSummaryCapability: generate/getModelContextLength/isThinkingModel
//     — used by indexer/phases/skeleton-summary.js (its own module-scope
//     fallback only; every real call site already accepts its own
//     opts.generateFn override).
//   - OllamaEmbedCapability: embed/getOllamaEmbeddingDimension — used by
//     core/embeddings.js and indexer/run.js (new-collection vector-size
//     detection).
//   - OllamaDiscoveryCapability: isOllamaReachable/listOllamaModels/
//     validateOllamaModels — used by indexer/preflight.js.
// core/generation/ollama-provider.js needs generate-shaped methods AND
// discovery-shaped methods, but already has its own working per-method DI
// since Phase 4A.5a (isOllamaReachableFn, listOllamaModelsFn,
// generateStreamFn, getModelContextLengthFn) — it does not consume any of
// these 4 contract objects directly, so it never has to satisfy a
// contract wider than what it individually needs either.

/**
 * @typedef {Object} OllamaGenerateCapability
 * @property {(model: string, prompt: string, opts?: Object) => Promise<string>} generate
 */

export const REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS = ['generate'];

/**
 * @param {Object} capability
 * @throws {Error} with an actionable message naming the missing piece
 */
export function validateOllamaGenerateCapability(capability) {
  if (typeof capability !== 'object' || capability === null) {
    throw new Error('validateOllamaGenerateCapability: capability must be a non-null object');
  }
  const missing = REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS.filter(m => typeof capability[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(`validateOllamaGenerateCapability: capability is missing required method(s): ${missing.join(', ')}`);
  }
  return true;
}

/**
 * @typedef {Object} OllamaSummaryCapability
 * @property {(model: string, prompt: string, opts?: Object) => Promise<string>} generate
 * @property {(model: string, fallback?: number, baseUrl?: string) => Promise<number>} getModelContextLength
 * @property {(model: string) => Promise<boolean>} isThinkingModel
 */

export const REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS = ['generate', 'getModelContextLength', 'isThinkingModel'];

/**
 * @param {Object} capability
 * @throws {Error} with an actionable message naming the missing piece
 */
export function validateOllamaSummaryCapability(capability) {
  if (typeof capability !== 'object' || capability === null) {
    throw new Error('validateOllamaSummaryCapability: capability must be a non-null object');
  }
  const missing = REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS.filter(m => typeof capability[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(`validateOllamaSummaryCapability: capability is missing required method(s): ${missing.join(', ')}`);
  }
  return true;
}

/**
 * @typedef {Object} OllamaEmbedCapability
 * @property {(text: string, model: string) => Promise<number[]>} embed
 * @property {(model: string, baseUrl?: string) => Promise<number>} getOllamaEmbeddingDimension
 */

export const REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS = ['embed', 'getOllamaEmbeddingDimension'];

/**
 * @param {Object} capability
 * @throws {Error} with an actionable message naming the missing piece
 */
export function validateOllamaEmbedCapability(capability) {
  if (typeof capability !== 'object' || capability === null) {
    throw new Error('validateOllamaEmbedCapability: capability must be a non-null object');
  }
  const missing = REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS.filter(m => typeof capability[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(`validateOllamaEmbedCapability: capability is missing required method(s): ${missing.join(', ')}`);
  }
  return true;
}

/**
 * @typedef {Object} OllamaDiscoveryCapability
 * @property {(baseUrl: string) => Promise<boolean>} isOllamaReachable
 * @property {(baseUrl: string) => Promise<string[]>} listOllamaModels
 * @property {(required: string[], available: string[]) => Promise<string[]|null>} validateOllamaModels
 */

export const REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS = ['isOllamaReachable', 'listOllamaModels', 'validateOllamaModels'];

/**
 * @param {Object} capability
 * @throws {Error} with an actionable message naming the missing piece
 */
export function validateOllamaDiscoveryCapability(capability) {
  if (typeof capability !== 'object' || capability === null) {
    throw new Error('validateOllamaDiscoveryCapability: capability must be a non-null object');
  }
  const missing = REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS.filter(m => typeof capability[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(`validateOllamaDiscoveryCapability: capability is missing required method(s): ${missing.join(', ')}`);
  }
  return true;
}
