// Semidex Lite staging replacement for core/ollama-lazy.js.
//
// core/ollama.js is NOT shipped in the Lite tarball (it is a local
// provider client Lite does not support) — so ollama-lazy.js's real
// `await import('./ollama.js')` is a literal dynamic-import target that
// would resolve to nothing in a Lite install, throwing ERR_MODULE_NOT_FOUND
// if it were ever reached. The Lite package-closure build (build.mjs) never
// stages ollama.js NOR the real ollama-lazy.js — it substitutes THIS file
// under the same path (core/ollama-lazy.js) instead, so every caller's
// import specifier is unchanged.
//
// Every export below throws a typed, clearly-labeled error instead of
// attempting any import. This is a policy rejection, not a runtime import
// failure: Semidex Lite's hard pins (TAG_GEN=0, SKELETON_SUMMARY=deterministic,
// COMBINED_LLM=0, CONTEXT_MODE=deterministic, SEMIDEX_GENERATION_BACKEND=gemini)
// mean none of these functions are ever actually called in a Lite process —
// this file exists so that IF a future code change accidentally introduced
// a call path that bypasses the pins, the failure is an immediate, legible
// "not available in Semidex Lite" error rather than a missing-module crash
// deep in a dynamic import.

export class OllamaNotAvailableInLiteError extends Error {
  constructor(fnName) {
    super(`${fnName}() is not available in Semidex Lite — Ollama is a local-only provider and is not included in this package.`);
    this.name = 'OllamaNotAvailableInLiteError';
    this.code = 'not_available_in_lite';
  }
}

function unavailable(fnName) {
  return async () => { throw new OllamaNotAvailableInLiteError(fnName); };
}

export const generate = unavailable('generate');
export const embed = unavailable('embed');
export const getModelContextLength = unavailable('getModelContextLength');
export const isThinkingModel = unavailable('isThinkingModel');
export const getOllamaEmbeddingDimension = unavailable('getOllamaEmbeddingDimension');
export const isOllamaReachable = unavailable('isOllamaReachable');
export const listOllamaModels = unavailable('listOllamaModels');
export const validateOllamaModels = unavailable('validateOllamaModels');
export const generateStream = unavailable('generateStream');
