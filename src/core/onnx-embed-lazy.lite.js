// Semidex Lite package-build staging replacement for core/onnx-embed-lazy.js.
//
// local/core/onnx-embed.js and local/core/length-bucket.js are never shipped in the
// Lite tarball, so the real onnx-embed-lazy.js's `await import('./onnx-embed.js')`/
// `await import('./length-bucket.js')` are literal dynamic-import targets
// that would throw ERR_MODULE_NOT_FOUND in an installed Lite package if
// ever reached. packages/lite/build.mjs substitutes THIS file under the
// exact same path (core/onnx-embed-lazy.js) when staging, so
// core/embeddings.js's import specifier is unchanged and does not need to
// know which variant it is running against.
//
// Reaching either export below in Lite would mean cfg.denseProvider ===
// 'bge-m3-onnx' was somehow selected despite the CLI's unconditional
// DENSE_PROVIDER=qdrant-cloud hard pin and the Lite settings service
// rejecting any write to DENSE_PROVIDER/EMBEDDING_BACKEND that isn't
// qdrant-cloud — i.e. a bug elsewhere, not a normal Lite code path. Throws
// a typed error instead of a bare module-resolution crash so such a bug is
// immediately diagnosable.
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

export const loadOnnx = unavailable('loadOnnx');
export const loadOnnxBatch = unavailable('loadOnnxBatch');
