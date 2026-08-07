// RerankCapability contract (code review, Phase 8B Step 6 second pass, P1
// fix) — mirrors onnx-embed-capability.js/generation/ollama-capability.js:
// a small runtime shape validator plus JSDoc typedefs, zero backend
// imports (never imports core/rerank.js or core/ce-rerank.js directly).
// mcp/tools/search.js (the one real shared consumer) depends on THIS shape
// only — never on core/ce-rerank.js directly — via an injected capability
// from its own composition root (src/mcp/server.js).
//
// core/ce-rerank.js is declared 'local' in the architecture manifest — it
// spawns a persistent child process running @huggingface/transformers, the
// same heavy local-runtime coupling onnx-embed.js/ollama.js carry. This
// contract is what lets mcp/tools/search.js (declared 'shared') depend on
// the CE reranking BEHAVIOR without importing that implementation directly.
// core/rerank.js's own deterministic (non-CE) rerankResults() has no real
// local-runtime coupling of its own — it is bundled into this same
// contract anyway, rather than split into a second capability, because
// mcp/tools/search.js always calls both from the SAME composition step
// (see that file's own two-stage det-rerank -> CE-rerank pipeline comment)
// and a real implementation always supplies both together.

/**
 * @typedef {Object} RerankCapability
 * @property {(results: Array<Object>, query: string, options: {finalLimit?: number}, deps: {settingsService?: Object}) => Array<Object>} rerankResults — deterministic lexical rerank (core/rerank.js).
 * @property {(candidates: Array<Object>, query: string, options: {finalLimit?: number}, deps: {settingsService?: Object}) => Promise<Array<Object>>} ceRerank — cross-encoder rerank (core/ce-rerank.js), backed by a persistent local child process.
 * @property {(promise: Promise, ms: number, fallback: () => any, options?: {label?: string}) => Promise<any>} withCETimeout
 * @property {(deps: {settingsService?: Object}) => {timeoutMs: number}} getCeRerankConfig
 */

export const REQUIRED_RERANK_CAPABILITY_METHODS = ['rerankResults', 'ceRerank', 'withCETimeout', 'getCeRerankConfig'];

/**
 * Verify an object satisfies the RerankCapability shape. Shallow, like the
 * sibling capability/provider/adapter validators — a shape check, not a
 * type system.
 * @param {Object} capability
 * @throws {Error} with an actionable message naming the missing piece
 */
export function validateRerankCapability(capability) {
  if (typeof capability !== 'object' || capability === null) {
    throw new Error('validateRerankCapability: capability must be a non-null object');
  }

  const missing = REQUIRED_RERANK_CAPABILITY_METHODS.filter(m => typeof capability[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `validateRerankCapability: capability is missing required method(s): ${missing.join(', ')}`
    );
  }

  return true;
}
