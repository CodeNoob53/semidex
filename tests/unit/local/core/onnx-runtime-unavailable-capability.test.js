// src/local/core/onnx-runtime-unavailable-capability.js — the typed
// "runtime unavailable" OnnxEmbedCapability review finding P2 introduced:
// a long-lived server process (Admin, MCP) must never silently attempt to
// load a runtime already proven broken. Every real method must throw
// immediately with the specific diagnostic reason, and shutdown() must
// stay a safe no-op regardless (indexer/run.js's own `finally` block
// calls it unconditionally).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_ONNX_EMBED_CAPABILITY_METHODS, validateOnnxEmbedCapability } from '../../../../src/shared/core/onnx-embed-capability.js';
import { createOnnxRuntimeUnavailableCapability, OnnxRuntimeUnavailableError } from '../../../../src/local/core/onnx-runtime-unavailable-capability.js';

describe('createOnnxRuntimeUnavailableCapability()', () => {
  it('satisfies the OnnxEmbedCapability shape validator', () => {
    const capability = createOnnxRuntimeUnavailableCapability('recorded cuDNN directory no longer exists');
    assert.doesNotThrow(() => validateOnnxEmbedCapability(capability));
  });

  it('exposes exactly the required methods, all functions', () => {
    const capability = createOnnxRuntimeUnavailableCapability('some reason');
    for (const m of REQUIRED_ONNX_EMBED_CAPABILITY_METHODS) {
      assert.equal(typeof capability[m], 'function', `expected ${m} to be a function`);
    }
  });

  it('loadOnnx() rejects immediately with an OnnxRuntimeUnavailableError naming the exact reason', async () => {
    const capability = createOnnxRuntimeUnavailableCapability('recorded cuDNN directory no longer exists on disk');
    await assert.rejects(
      () => capability.loadOnnx(),
      (err) => {
        assert.ok(err instanceof OnnxRuntimeUnavailableError);
        assert.equal(err.code, 'onnx_runtime_unavailable');
        assert.match(err.message, /recorded cuDNN directory no longer exists on disk/);
        assert.match(err.message, /loadOnnx/);
        return true;
      },
    );
  });

  it('loadOnnxBatch() rejects immediately with the same reason', async () => {
    const capability = createOnnxRuntimeUnavailableCapability('cuDNN directory vanished');
    await assert.rejects(
      () => capability.loadOnnxBatch(),
      (err) => {
        assert.ok(err instanceof OnnxRuntimeUnavailableError);
        assert.match(err.message, /cuDNN directory vanished/);
        assert.match(err.message, /loadOnnxBatch/);
        return true;
      },
    );
  });

  it('shutdown() ALWAYS resolves without throwing, even though every other method throws — matches every real OnnxEmbedCapability implementation\'s always-safe-no-op contract', async () => {
    const capability = createOnnxRuntimeUnavailableCapability('broken runtime');
    await assert.doesNotReject(() => capability.shutdown());
  });

  it('two independently-constructed capabilities never share state — each throws its OWN reason', async () => {
    const capabilityA = createOnnxRuntimeUnavailableCapability('reason A');
    const capabilityB = createOnnxRuntimeUnavailableCapability('reason B');
    await assert.rejects(() => capabilityA.loadOnnx(), /reason A/);
    await assert.rejects(() => capabilityB.loadOnnx(), /reason B/);
  });
});
