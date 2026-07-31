// Semidex Lite package-build staging replacement for
// indexer/phases/tag-onnx-lazy.js.
//
// indexer/phases/tag-onnx.js and indexer/workers/tag-onnx-worker.js are
// never shipped in the Lite tarball, so the real tag-onnx-lazy.js's
// `await import('./tag-onnx.js')` is a literal dynamic-import target that
// would throw ERR_MODULE_NOT_FOUND in an installed Lite package if ever
// reached. packages/lite/build.mjs substitutes THIS file under the exact
// same path (indexer/phases/tag-onnx-lazy.js) when staging, so run.js's
// import specifier is unchanged.
//
// isOnnxTagProvider is re-exported for real (not stubbed) — it is a pure
// TAG_PROVIDER env predicate with no fork()/worker dependency, and Lite's
// own TAG_GEN=0 hard pin means run.js only ever calls it to correctly
// resolve to a no-op branch, never to actually reach addTagsOnnxBatch.
//
// Reaching addTagsOnnxBatch in Lite would mean TAG_PROVIDER=onnx AND
// TAG_GEN=1 were somehow both selected despite the CLI's unconditional
// TAG_GEN=0 hard pin and the Lite jobs policy rejecting any tagGen option —
// i.e. a bug elsewhere, not a normal Lite code path. Throws a typed error
// instead of a bare module-resolution crash so such a bug is immediately
// diagnosable.
export { isOnnxTagProvider } from './tag-provider.js';

export class TagOnnxNotAvailableInLiteError extends Error {
  constructor(fnName) {
    super(`${fnName}() is not available in Semidex Lite — the ONNX tag generation worker is not included in this package.`);
    this.name = 'TagOnnxNotAvailableInLiteError';
    this.code = 'not_available_in_lite';
  }
}

export const addTagsOnnxBatch = async () => { throw new TagOnnxNotAvailableInLiteError('addTagsOnnxBatch'); };

// shutdownOnnxTagWorker is DIFFERENT from addTagsOnnxBatch: it is cleanup
// code, unconditionally called from run.js's own `finally` block on every
// indexing run regardless of whether ONNX tagging was ever used — the real
// tag-onnx.js documents this exact function as a safe no-op when no worker
// was ever spawned (see tests/unit/indexer/phases/tag-onnx.test.js:
// "shutdownOnnxTagWorker() is a no-op (does not throw) when no worker has
// ever been spawned"). Since a worker can never have been spawned in Lite
// (TAG_GEN=0 hard pin), this must preserve that same no-op contract rather
// than throw — a real live-indexing run against Qdrant Cloud crashed with
// TagOnnxNotAvailableInLiteError on this exact call before this fix, even
// though tagging itself was correctly never attempted.
export async function shutdownOnnxTagWorker() { /* no-op: no worker is ever started in Semidex Lite */ }
