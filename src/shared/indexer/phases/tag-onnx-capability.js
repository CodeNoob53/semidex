// TagOnnxCapability contract (Phase 8B Step 1) — mirrors generation/
// provider.js/storage/adapter.js: a small runtime shape validator plus
// JSDoc typedefs, zero backend imports (never imports
// indexer/phases/tag-onnx.js, indexer/workers/tag-onnx-worker.js,
// onnxruntime-node, or @huggingface/transformers). run.js (the one real
// shared consumer) depends on THIS shape only — never on
// indexer/phases/tag-onnx-lazy.js or tag-onnx.js directly — via its own
// applyTagOnnxCapability() composition seam.
//
// isOnnxTagProvider is deliberately NOT part of this contract — it already
// lives in tag-provider.js as a pure, zero-dependency TAG_PROVIDER env
// predicate with no fork()/worker coupling of its own, and every consumer
// (run.js, tag-onnx-lazy.js, tag-onnx-lazy.lite.js) already imports it
// directly from there. Wrapping an already-neutral predicate in a
// capability object would add indirection with no boundary it actually
// crosses.
//
// shutdownOnnxTagWorker's ALWAYS-SAFE-NO-OP CONTRACT (Phase 8A Part D,
// docs/design/phase-8a-shared-cloud-local-migration-audit-2026-08-02.md
// §4.3): run.js calls this unconditionally in its own `finally` block on
// EVERY indexing run, regardless of whether ONNX tagging ever ran. A real
// production incident occurred when an earlier Lite shim variant threw
// here instead of resolving — any implementation of this contract
// (including a disabled/no-op one) MUST resolve without throwing even when
// no worker was ever started. This is a load-bearing behavioral
// requirement, not a simplification left up to each implementer.

/**
 * @typedef {Object} TagOnnxCapability
 * @property {(chunks: Object[]) => Promise<Object[]>} addTagsOnnxBatch
 * @property {() => Promise<void>} shutdownOnnxTagWorker — MUST always resolve, never reject, even when no worker was ever spawned (see header comment).
 * @property {(context?: {env?: NodeJS.ProcessEnv}) => Promise<import('../device/resource-identity.js').ResourceIdentity>} getResourceIdentity — the device-aware bounded pipeline's tagging identity source; a structural fact of this worker's implementation (always CPU, no execution-provider concept exists), never a probed runtime value. MUST never throw — a disabled/unavailable implementation returns `{kind:'unknown',...}`, same never-throw exception already established for the Ollama generation identity capability.
 */

export const REQUIRED_TAG_ONNX_CAPABILITY_METHODS = ['addTagsOnnxBatch', 'shutdownOnnxTagWorker', 'getResourceIdentity'];

/**
 * Verify an object satisfies the TagOnnxCapability shape. Shallow, like the
 * sibling capability/provider/adapter validators — a shape check, not a
 * type system. Does not (and cannot statically) verify the
 * shutdownOnnxTagWorker no-throw-before-start contract described above —
 * that is a behavioral guarantee, verified by
 * tests/unit/indexer/phases/tag-onnx-capability.test.js instead.
 * @param {Object} capability
 * @throws {Error} with an actionable message naming the missing piece
 */
export function validateTagOnnxCapability(capability) {
  if (typeof capability !== 'object' || capability === null) {
    throw new Error('validateTagOnnxCapability: capability must be a non-null object');
  }

  const missing = REQUIRED_TAG_ONNX_CAPABILITY_METHODS.filter(m => typeof capability[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `validateTagOnnxCapability: capability is missing required method(s): ${missing.join(', ')}`
    );
  }

  return true;
}
