// OnnxEmbedCapability contract (Phase 8B Step 1, extended for instance-
// scoped session lifecycle) — mirrors generation/provider.js/storage/
// adapter.js: a small runtime shape validator plus JSDoc typedefs, zero
// backend imports (never imports local/core/onnx-embed.js,
// local/core/length-bucket.js, local/core/onnx-runtime.js, onnxruntime-node, or
// @huggingface/transformers). core/embeddings.js (the one real shared
// consumer) depends on THIS shape only — never on core/onnx-embed-lazy.js
// or local/core/onnx-embed.js directly — via its own
// applyEmbeddingCapabilities() composition seam.
//
// The loadOnnx()/loadOnnxBatch() method list is exactly core/
// onnx-embed-lazy.js's own export surface: they are themselves LOADERS
// that resolve to the real embed function references (embeddings.js calls
// the returned function itself) — this file preserves that exact shape
// rather than flattening it into direct embed/embedBatch methods, since
// embeddings.js's own DML-batch vs. per-call dispatch logic already
// depends on getting back distinct function references (embedOnnxBatch,
// embedBucketed) it then composes itself.
//
// `shutdown` (code review parity with Step 4's tag-onnx.js fix): every
// implementation of this contract now owns real, instance-scoped session
// state (see local/core/onnx-embed.js's own createOnnxEmbeddingCapability())
// that must eventually release native resources
// (InferenceSession.release()) — mirrors TagOnnxCapability's own
// shutdownOnnxTagWorker() requirement exactly, including its ALWAYS-SAFE-
// NO-OP contract: MUST resolve without throwing even when no session was
// ever created (a disabled/Lite implementation, or a real instance that
// was never actually used for an embed call). indexer/run.js calls this
// unconditionally in its own `finally` block on every indexing run.

/**
 * @typedef {Object} OnnxEmbedCapability
 * @property {() => Promise<(text: string) => Promise<{dense: number[], sparse: Object}>>} loadOnnx
 * @property {() => Promise<{ embedOnnxBatch: Function, embedBucketed: Function }>} loadOnnxBatch
 * @property {() => Promise<void>} shutdown — MUST always resolve, never reject, even when no session was ever created (see header comment).
 */

export const REQUIRED_ONNX_EMBED_CAPABILITY_METHODS = ['loadOnnx', 'loadOnnxBatch', 'shutdown'];

/**
 * Verify an object satisfies the OnnxEmbedCapability shape. Shallow, like
 * the sibling capability/provider/adapter validators — a shape check, not a
 * type system.
 * @param {Object} capability
 * @throws {Error} with an actionable message naming the missing piece
 */
export function validateOnnxEmbedCapability(capability) {
  if (typeof capability !== 'object' || capability === null) {
    throw new Error('validateOnnxEmbedCapability: capability must be a non-null object');
  }

  const missing = REQUIRED_ONNX_EMBED_CAPABILITY_METHODS.filter(m => typeof capability[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `validateOnnxEmbedCapability: capability is missing required method(s): ${missing.join(', ')}`
    );
  }

  return true;
}
