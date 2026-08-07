// CloudGenerationCapability contract (Phase 8B Step 6, code review fix) —
// mirrors onnx-embed-capability.js/embedding-profile/
// cloud-embedding-capability.js: a small runtime shape validator plus
// JSDoc typedefs, zero backend imports (never imports
// src/cloud/generation/gemini-provider.js or gemini-models.js directly).
// generation/registry.js (the one real shared consumer) depends on THIS
// shape only — a composition root passes a real implementation in as
// `providers.gemini`/`discoverGeminiModelsFn`, never a static import
// inside a shared file.
//
// Two independent concerns, both cloud-generation-specific:
//   - createProvider: builds a real GenerationProvider (see
//     core/generation/provider.js's own contract) for the 'gemini' backend
//     — registry.js's own `providers` map entry.
//   - discoverModels: Gemini model discovery/listing — admin/api/
//     generation-models.js's own `discoverGeminiModelsFn` DI parameter.
// Kept as two separate exported functions on one capability object
// (rather than two separate capability contracts) because both are always
// sourced from the SAME real implementation directory
// (src/cloud/generation/) and always injected by the SAME composition
// root at the SAME construction step — splitting them into two contracts
// would not buy any real independent-lifecycle benefit the way, say,
// OnnxEmbedCapability's persistent session state did.

/**
 * @typedef {Object} CloudGenerationCapability
 * @property {(options: Object) => import('./provider.js').GenerationProvider} createProvider — real createGeminiProvider(options), for generation/registry.js's own `providers.gemini` map entry.
 * @property {(options: Object) => Promise<{available: boolean, reason: string|null, models: Array<Object>}>} discoverModels — real discoverGeminiModels(options).
 */

export const REQUIRED_CLOUD_GENERATION_CAPABILITY_METHODS = ['createProvider', 'discoverModels'];

/**
 * Verify an object satisfies the CloudGenerationCapability shape. Shallow,
 * like the sibling capability/provider/adapter validators — a shape
 * check, not a type system.
 * @param {Object} capability
 * @throws {Error} with an actionable message naming the missing piece
 */
export function validateCloudGenerationCapability(capability) {
  if (typeof capability !== 'object' || capability === null) {
    throw new Error('validateCloudGenerationCapability: capability must be a non-null object');
  }

  const missing = REQUIRED_CLOUD_GENERATION_CAPABILITY_METHODS.filter(m => typeof capability[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `validateCloudGenerationCapability: capability is missing required method(s): ${missing.join(', ')}`
    );
  }

  return true;
}
