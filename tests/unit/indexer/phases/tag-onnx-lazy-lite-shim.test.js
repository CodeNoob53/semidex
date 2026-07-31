// indexer/phases/tag-onnx-lazy.lite.js — the Semidex Lite package-build
// staging replacement for tag-onnx-lazy.js. Export-surface parity
// (excluding isOnnxTagProvider, which is a REAL re-export, not stubbed —
// see the shim's own header comment), no actual reference to tag-onnx.js
// in executable code, and DIFFERENT contracts for its two worker-touching
// exports: addTagsOnnxBatch() rejects with a typed not_available_in_lite
// error (a real policy violation if ever reached), while
// shutdownOnnxTagWorker() is a genuine no-op (matching the real
// tag-onnx.js's own documented "safe to call when no worker was ever
// spawned" contract — run.js's `finally` block calls it unconditionally on
// every indexing run, so it must never throw just because Lite excludes
// the worker itself; a real live-indexing run against Qdrant Cloud crashed
// on exactly this call before the fix this test now pins).
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

  it('addTagsOnnxBatch rejects with a typed not_available_in_lite error', async () => {
    const shim = await import('../../../../src/indexer/phases/tag-onnx-lazy.lite.js');
    await assert.rejects(
      () => shim.addTagsOnnxBatch(),
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
    await assert.doesNotReject(() => shim.shutdownOnnxTagWorker());
  });

  it('the shim module source contains no ACTUAL (non-comment) reference to tag-onnx.js', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../../src/indexer/phases/tag-onnx-lazy.lite.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/from ['"]\.\/tag-onnx\.js['"]/.test(codeOnly));
    assert.ok(!/import\(['"]\.\/tag-onnx\.js['"]\)/.test(codeOnly));
  });
});
