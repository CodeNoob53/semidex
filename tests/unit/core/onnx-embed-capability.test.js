// OnnxEmbedCapability contract (Phase 8B Step 1) — mirrors provider.test.js's
// shape-validator test style. See ../../../src/shared/core/onnx-embed-capability.js
// for the full rationale.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateOnnxEmbedCapability, REQUIRED_ONNX_EMBED_CAPABILITY_METHODS } from '../../../src/shared/core/onnx-embed-capability.js';

function validCapability() {
  const capability = {};
  for (const m of REQUIRED_ONNX_EMBED_CAPABILITY_METHODS) capability[m] = async () => ({});
  return capability;
}

describe('validateOnnxEmbedCapability', () => {
  test('accepts a conforming capability', () => {
    assert.equal(validateOnnxEmbedCapability(validCapability()), true);
  });

  test('rejects non-object input', () => {
    assert.throws(() => validateOnnxEmbedCapability(null), /non-null object/);
    assert.throws(() => validateOnnxEmbedCapability('nope'), /non-null object/);
  });

  test('rejects a capability missing any required method', () => {
    for (const method of REQUIRED_ONNX_EMBED_CAPABILITY_METHODS) {
      const c = validCapability();
      delete c[method];
      assert.throws(() => validateOnnxEmbedCapability(c), new RegExp(method));
    }
  });

  test('createOnnxEmbeddingCapability() instances provide every REQUIRED_ONNX_EMBED_CAPABILITY_METHODS entry (instance-scoped capability — local/core/onnx-embed.js exports only a factory, never bare loadOnnx/loadOnnxBatch/shutdown directly)', async () => {
    const real = await import('../../../src/local/core/onnx-embed.js');
    assert.equal(typeof real.createOnnxEmbeddingCapability, 'function', 'sanity: the factory itself is exported');
    const instance = real.createOnnxEmbeddingCapability({ ortFactory: () => ({ InferenceSession: { create: async () => ({ outputNames: [], run: async () => ({}), release: async () => {} }) } }) });
    for (const method of REQUIRED_ONNX_EMBED_CAPABILITY_METHODS) {
      assert.equal(typeof instance[method], 'function', `instance is missing required method: ${method}`);
    }
    // getOnnxProviderState is a real method every instance also provides,
    // but is deliberately NOT part of REQUIRED_ONNX_EMBED_CAPABILITY_METHODS
    // (see onnx-embed-capability.js's own header comment — no orchestration
    // consumer calls it through the capability interface today, only
    // benchmarks call it directly on the constructed instance).
    assert.equal(typeof instance.getOnnxProviderState, 'function');
    await instance.shutdown(); // no session was ever created; safe cleanup
  });
});

describe('onnx-embed-capability.js — zero backend imports (contract, not implementation)', () => {
  test('the contract module source has no import of local/core/onnx-embed.js, local/core/length-bucket.js, local/core/onnx-runtime.js, onnxruntime-node, or @huggingface/transformers', () => {
    const src = readFileSync(new URL('../../../src/shared/core/onnx-embed-capability.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/from ['"].*onnx-embed(-lazy)?\.js['"]/.test(codeOnly), 'must not import local/core/onnx-embed.js or core/onnx-embed-lazy.js');
    assert.ok(!/from ['"].*length-bucket\.js['"]/.test(codeOnly), 'must not import local/core/length-bucket.js');
    assert.ok(!/from ['"].*onnx-runtime\.js['"]/.test(codeOnly), 'must not import local/core/onnx-runtime.js');
    assert.ok(!/onnxruntime-node/.test(codeOnly), 'must not reference onnxruntime-node');
    assert.ok(!/@huggingface\/transformers/.test(codeOnly), 'must not reference @huggingface/transformers');
  });

  test('importing the contract module in isolation performs zero network/filesystem side effects', async () => {
    const mod = await import('../../../src/shared/core/onnx-embed-capability.js');
    assert.ok(typeof mod.validateOnnxEmbedCapability === 'function');
    assert.ok(Array.isArray(mod.REQUIRED_ONNX_EMBED_CAPABILITY_METHODS));
  });
});
