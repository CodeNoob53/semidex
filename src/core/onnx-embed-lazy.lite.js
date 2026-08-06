// Semidex Lite package-build staging replacement for core/onnx-embed-lazy.js.
//
// local/core/onnx-embed.js and local/core/length-bucket.js are never shipped in the
// Lite tarball, so the real onnx-embed-lazy.js's `await import('../local/core/onnx-embed.js')`/
// `await import('../local/core/length-bucket.js')` are literal dynamic-import targets
// that would throw ERR_MODULE_NOT_FOUND in an installed Lite package if
// ever reached. packages/lite/build.mjs substitutes THIS file under the
// exact same path (core/onnx-embed-lazy.js) when staging, so
// core/embeddings.js's import specifier is unchanged and does not need to
// know which variant it is running against.
//
// Mirrors the real onnx-embed-lazy.js's own createOnnxEmbeddingCapability()
// shape (code review parity with Step 4's tag-onnx-lazy.lite.js fix — the
// real module no longer exports bare loadOnnx/loadOnnxBatch functions,
// only a factory returning a fresh, independent instance per call) — kept
// in sync even though this file is dead code today (never staged, never
// imported; see this file's own EXCLUDE_FILES entry in build.mjs), so a
// future consumer building against "the *-lazy.lite.js shim shape" never
// diverges from the real one it stands in for.
//
// Reaching any method on the returned capability in Lite would mean
// cfg.denseProvider === 'bge-m3-onnx' was somehow selected despite the
// CLI's unconditional DENSE_PROVIDER=qdrant-cloud hard pin and the Lite
// settings service rejecting any write to DENSE_PROVIDER/EMBEDDING_BACKEND
// that isn't qdrant-cloud — i.e. a bug elsewhere, not a normal Lite code
// path. Throws a typed error instead of a bare module-resolution crash so
// such a bug is immediately diagnosable. shutdown() is the one exception —
// it is unconditional cleanup, safe to call even though no session was
// ever created (mirrors admin/composition/lite.js's/index-lite.js's own
// unavailableOnnxEmbedCapability() contract, which already gets this
// right — this file simply needs to keep matching that same shape).
export class OnnxEmbedNotAvailableInLiteError extends Error {
  constructor(fnName) {
    super(`${fnName}() is not available in Semidex Lite — the local ONNX embedding runtime is not included in this package.`);
    this.name = 'OnnxEmbedNotAvailableInLiteError';
    this.code = 'not_available_in_lite';
  }
}

function unavailable(fnName) {
  return async () => { throw new OnnxEmbedNotAvailableInLiteError(fnName); };
}

// Synchronous, mirroring the real onnx-embed-lazy.js's own
// createOnnxEmbeddingCapability() signature exactly (that file is
// synchronous specifically so admin/server-full.js's createApp() — a
// synchronous function with many existing call sites — never needs to
// become async just to construct this capability; see its own header
// comment for the full reasoning).
export function createOnnxEmbeddingCapability() {
  return {
    loadOnnx: unavailable('loadOnnx'),
    loadOnnxBatch: unavailable('loadOnnxBatch'),
    getOnnxProviderState: () => null,
    async shutdown() { /* no-op: no session is ever created in Semidex Lite */ },
  };
}
