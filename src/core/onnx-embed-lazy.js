// Lazy accessor for local/core/onnx-embed.js and local/core/length-bucket.js
// (Phase 8B Step 2 — physically relocated from core/ to local/core/, this
// file's own dynamic-import specifiers below are the only thing that
// changed). Every module that needs local ONNX embedding reaches it THROUGH
// this module's dynamic loader instead of statically importing
// onnx-embed.js/length-bucket.js directly — mirrors core/ollama-lazy.js's
// pattern exactly (see that file's own header comment for the full
// rationale).
//
// Why this matters: Semidex Lite hard-pins DENSE_PROVIDER=qdrant-cloud
// unconditionally, so the ONNX dispatch branch in core/embeddings.js
// (cfg.denseProvider === 'bge-m3-onnx') is policy-unreachable in Lite.
// core/embeddings.js itself IS staged in Lite (it also handles the
// qdrant-cloud embedding path run.js/search.js use) — but onnx-embed.js and
// length-bucket.js (which pull onnxruntime-node, a heavy native dependency)
// must not be. With this static edge cut, both files have zero static
// importers among kept files and can be excluded from the staged package
// entirely.
//
// Full-Semidex behavior is observably unchanged: the same functions run,
// resolved one dynamic-import hop later; each module is cached after first
// load so there is no per-call overhead beyond the first.

let _onnxEmbedMod = null;
let _lengthBucketMod = null;

async function loadOnnxEmbedModule() {
  if (!_onnxEmbedMod) _onnxEmbedMod = await import('../local/core/onnx-embed.js');
  return _onnxEmbedMod;
}

async function loadLengthBucketModule() {
  if (!_lengthBucketMod) _lengthBucketMod = await import('../local/core/length-bucket.js');
  return _lengthBucketMod;
}

export async function loadOnnx() {
  return (await loadOnnxEmbedModule()).embedOnnx;
}

export async function loadOnnxBatch() {
  const { embedOnnxBatch } = await loadOnnxEmbedModule();
  const { embedBucketed } = await loadLengthBucketModule();
  return { embedOnnxBatch, embedBucketed };
}
