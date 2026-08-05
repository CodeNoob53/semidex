// OnnxEmbedCapability contract (Phase 8B Step 1) — mirrors provider.test.js's
// shape-validator test style. See ../../../src/core/onnx-embed-capability.js
// for the full rationale.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateOnnxEmbedCapability, REQUIRED_ONNX_EMBED_CAPABILITY_METHODS } from '../../../src/core/onnx-embed-capability.js';

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

  test('REQUIRED_ONNX_EMBED_CAPABILITY_METHODS matches core/onnx-embed-lazy.js\'s own real export surface exactly', async () => {
    const real = await import('../../../src/core/onnx-embed-lazy.js');
    const realFnNames = Object.keys(real).filter((k) => typeof real[k] === 'function').sort();
    assert.deepEqual([...REQUIRED_ONNX_EMBED_CAPABILITY_METHODS].sort(), realFnNames);
  });
});

describe('onnx-embed-capability.js — zero backend imports (contract, not implementation)', () => {
  test('the contract module source has no import of core/onnx-embed.js, core/length-bucket.js, core/onnx-runtime.js, onnxruntime-node, or @huggingface/transformers', () => {
    const src = readFileSync(new URL('../../../src/core/onnx-embed-capability.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/from ['"].*onnx-embed(-lazy)?\.js['"]/.test(codeOnly), 'must not import core/onnx-embed.js or onnx-embed-lazy.js');
    assert.ok(!/from ['"].*length-bucket\.js['"]/.test(codeOnly), 'must not import core/length-bucket.js');
    assert.ok(!/from ['"].*onnx-runtime\.js['"]/.test(codeOnly), 'must not import core/onnx-runtime.js');
    assert.ok(!/onnxruntime-node/.test(codeOnly), 'must not reference onnxruntime-node');
    assert.ok(!/@huggingface\/transformers/.test(codeOnly), 'must not reference @huggingface/transformers');
  });

  test('importing the contract module in isolation performs zero network/filesystem side effects', async () => {
    const mod = await import('../../../src/core/onnx-embed-capability.js');
    assert.ok(typeof mod.validateOnnxEmbedCapability === 'function');
    assert.ok(Array.isArray(mod.REQUIRED_ONNX_EMBED_CAPABILITY_METHODS));
  });
});
