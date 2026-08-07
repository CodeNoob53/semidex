// Lazy accessor for local/indexer/phases/tag-onnx.js (Phase 8B Step 4 —
// physically relocated from indexer/phases/ to local/indexer/phases/; this
// file's own dynamic-import specifier below is the only thing that
// changed). index-full.js reaches tag-onnx.js's real implementation
// THROUGH this module's dynamic loader instead of statically importing
// tag-onnx.js — so that merely importing this file never pulls tag-onnx.js
// (and its fork() target, local/indexer/workers/tag-onnx-worker.js, which
// imports @huggingface/transformers — a heavy native dependency) into the
// module graph.
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
// createTagOnnxCapability() (code review, Phase 8B Step 4, second pass):
// tag-onnx.js's own coordinator state (worker, pending requests, dispatch
// queue, failure flags) is no longer module-scope singleton state — each
// call to tag-onnx.js's own createTagOnnxCapability() returns a fresh,
// independent instance with its own worker lifecycle (see that file's own
// header comment for the full isolation-gap finding and fix). This
// module's OWN job — deferring the heavy import until first real use — is
// unaffected: loadTagOnnx() still dynamically imports tag-onnx.js exactly
// once (cached in _mod), and this wrapper's createTagOnnxCapability()
// forwards to the real one only once that import has resolved.
// index-full.js calls this exactly ONCE, at composition time, and passes
// the resulting instance in as `tagOnnx` — never calls it per-request, and
// never shares one instance across two separately-constructed
// compositions.
export { isOnnxTagProvider } from '../../shared/indexer/phases/tag-provider.js';

let _mod = null;

async function loadTagOnnx() {
  if (!_mod) _mod = await import('../../local/indexer/phases/tag-onnx.js');
  return _mod;
}

/**
 * Returns a fresh, independent TagOnnxCapability instance — see
 * tag-onnx.js's own createTagOnnxCapability() for the full contract. The
 * heavy dynamic import only happens the first time ANY exported function
 * on this module is called (including this one); the module itself stays
 * cached (_mod) so a second call here does not re-import tag-onnx.js, but
 * DOES construct a genuinely new, independent capability instance.
 * @returns {Promise<{ addTagsOnnxBatch: Function, shutdownOnnxTagWorker: Function }>}
 */
export async function createTagOnnxCapability() {
  const mod = await loadTagOnnx();
  return mod.createTagOnnxCapability();
}
