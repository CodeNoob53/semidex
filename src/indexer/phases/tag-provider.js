// Pure TAG_PROVIDER predicate — extracted out of tag-onnx.js so it can be
// imported without pulling tag-onnx.js's fork()/WORKER_PATH machinery into
// the module graph (tag-onnx-lazy.js needs this constant-time check
// available synchronously, but must never statically import tag-onnx.js
// itself — see tag-onnx-lazy.js's own header comment). tag-onnx.js
// re-exports this for backward compatibility with existing callers.
export function isOnnxTagProvider(env = process.env) {
  return env.TAG_PROVIDER === 'onnx';
}
