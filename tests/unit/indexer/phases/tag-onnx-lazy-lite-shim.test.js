// indexer/phases/tag-onnx-lazy.lite.js — the Semidex Lite package-build
// staging replacement for tag-onnx-lazy.js. Export-surface parity
// (excluding isOnnxTagProvider, which is a REAL re-export, not stubbed —
// see the shim's own header comment), no actual reference to tag-onnx.js
// in executable code, and DIFFERENT contracts for the two worker-touching
// methods createTagOnnxCapability() returns: addTagsOnnxBatch() rejects
// with a typed not_available_in_lite error (a real policy violation if
// ever reached), while shutdownOnnxTagWorker() is a genuine no-op
// (matching the real tag-onnx.js's own documented "safe to call when no
// worker was ever spawned" contract — run.js's `finally` block calls it
// unconditionally on every indexing run, so it must never throw just
// because Lite excludes the worker itself; a real live-indexing run
// against Qdrant Cloud crashed on exactly this call before the fix this
// test now pins).
//
// Both the real and the .lite.js shim now expose createTagOnnxCapability()
// (Phase 8B Step 4, second review pass) rather than bare
// addTagsOnnxBatch/shutdownOnnxTagWorker exports — every consumer
// constructs its own instance.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('indexer/phases/tag-onnx-lazy.lite.js — Lite staging shim', () => {
  it('exports the exact same names as the real tag-onnx-lazy.js (drop-in replacement)', async () => {
    const real = await import('../../../../src/indexer/phases/tag-onnx-lazy.js');
    const shim = await import('../../../../src/indexer/phases/tag-onnx-lazy.lite.js');
    const realNames = Object.keys(real).sort();
    const shimNames = Object.keys(shim).filter((k) => k !== 'TagOnnxNotAvailableInLiteError').sort();
    assert.deepEqual(shimNames, realNames);
  });

  it('isOnnxTagProvider is a REAL working predicate, not stubbed', async () => {
    const shim = await import('../../../../src/indexer/phases/tag-onnx-lazy.lite.js');
    assert.equal(shim.isOnnxTagProvider({ TAG_PROVIDER: 'onnx' }), true);
    assert.equal(shim.isOnnxTagProvider({ TAG_PROVIDER: 'ollama' }), false);
  });

  it('createTagOnnxCapability() is exported as a callable async factory, matching the real one\'s shape', async () => {
    const shim = await import('../../../../src/indexer/phases/tag-onnx-lazy.lite.js');
    assert.equal(typeof shim.createTagOnnxCapability, 'function');
    const cap = await shim.createTagOnnxCapability();
    assert.equal(typeof cap.addTagsOnnxBatch, 'function');
    assert.equal(typeof cap.shutdownOnnxTagWorker, 'function');
  });

  it('two createTagOnnxCapability() calls return two distinct objects (no shared state, even in the stub)', async () => {
    const shim = await import('../../../../src/indexer/phases/tag-onnx-lazy.lite.js');
    const capA = await shim.createTagOnnxCapability();
    const capB = await shim.createTagOnnxCapability();
    assert.notEqual(capA, capB);
  });

  it('addTagsOnnxBatch rejects with a typed not_available_in_lite error', async () => {
    const shim = await import('../../../../src/indexer/phases/tag-onnx-lazy.lite.js');
    const cap = await shim.createTagOnnxCapability();
    await assert.rejects(
      () => cap.addTagsOnnxBatch(),
      (err) => {
        assert.equal(err.code, 'not_available_in_lite');
        assert.match(err.message, /Semidex Lite/);
        assert.match(err.message, /addTagsOnnxBatch\(\)/);
        return true;
      },
    );
  });

  it('shutdownOnnxTagWorker() resolves successfully (a genuine no-op, never throws) — run.js calls it unconditionally in its own cleanup path regardless of whether tagging was ever used', async () => {
    const shim = await import('../../../../src/indexer/phases/tag-onnx-lazy.lite.js');
    const cap = await shim.createTagOnnxCapability();
    await assert.doesNotReject(() => cap.shutdownOnnxTagWorker());
  });

  it('the shim module source contains no ACTUAL (non-comment) reference to tag-onnx.js', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../../src/indexer/phases/tag-onnx-lazy.lite.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/from ['"]\.\/tag-onnx\.js['"]/.test(codeOnly));
    assert.ok(!/import\(['"]\.\/tag-onnx\.js['"]\)/.test(codeOnly));
  });
});
