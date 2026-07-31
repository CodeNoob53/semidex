// Lazy accessor for indexer/phases/tag-onnx.js. run.js reaches
// addTagsOnnxBatch()/shutdownOnnxTagWorker() THROUGH this module's dynamic
// loader instead of statically importing tag-onnx.js — so that merely
// importing run.js never pulls tag-onnx.js (and its fork() target,
// indexer/workers/tag-onnx-worker.js, which imports
// @huggingface/transformers — a heavy native dependency) into the module
// graph.
//
// Why this matters: Semidex Lite is a cloud-only distribution and pins
// TAG_GEN=0 unconditionally (hard pin, jobs policy also rejects the tagGen
// option) — the ONNX tag worker's fork() call is therefore
// policy-unreachable in Lite. With this static edge cut, tag-onnx.js and
// tag-onnx-worker.js have zero static importers among kept files and can
// be excluded from the staged package entirely (build.mjs's closure
// validator has no "intentionally absent fork path" escape hatch — a
// module with a real static importer would have to be staged; cutting the
// edge here is what makes exclusion valid, matching Refactor 1's
// core/ollama-lazy.js pattern exactly).
//
// isOnnxTagProvider is re-exported synchronously (not wrapped in a
// Promise) from tag-provider.js — a separate, neutral module with no
// fork()/WORKER_PATH of its own — NEVER from tag-onnx.js directly, since a
// static import of tag-onnx.js here would defeat this whole module's
// purpose regardless of which export it names.
//
// Full-Semidex behavior is observably unchanged: the same functions run,
// resolved one dynamic-import hop later for the two worker-touching
// exports; the module is cached after first load so there is no per-call
// overhead beyond the first.
export { isOnnxTagProvider } from './tag-provider.js';

let _mod = null;

async function loadTagOnnx() {
  if (!_mod) _mod = await import('./tag-onnx.js');
  return _mod;
}

export async function addTagsOnnxBatch(...args) {
  return (await loadTagOnnx()).addTagsOnnxBatch(...args);
}

export async function shutdownOnnxTagWorker(...args) {
  return (await loadTagOnnx()).shutdownOnnxTagWorker(...args);
}
