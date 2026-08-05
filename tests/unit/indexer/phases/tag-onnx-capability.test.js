// TagOnnxCapability contract (Phase 8B Step 1) — mirrors provider.test.js's
// shape-validator test style. See
// ../../../../src/indexer/phases/tag-onnx-capability.js for the full
// rationale, in particular the shutdownOnnxTagWorker always-safe-no-op
// contract (Phase 8A Part D finding, a real production-incident-derived
// requirement).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateTagOnnxCapability, REQUIRED_TAG_ONNX_CAPABILITY_METHODS } from '../../../../src/indexer/phases/tag-onnx-capability.js';

function validCapability() {
  const capability = {};
  for (const m of REQUIRED_TAG_ONNX_CAPABILITY_METHODS) capability[m] = async () => undefined;
  return capability;
}

describe('validateTagOnnxCapability', () => {
  test('accepts a conforming capability', () => {
    assert.equal(validateTagOnnxCapability(validCapability()), true);
  });

  test('rejects non-object input', () => {
    assert.throws(() => validateTagOnnxCapability(null), /non-null object/);
    assert.throws(() => validateTagOnnxCapability('nope'), /non-null object/);
  });

  test('rejects a capability missing any required method', () => {
    for (const method of REQUIRED_TAG_ONNX_CAPABILITY_METHODS) {
      const c = validCapability();
      delete c[method];
      assert.throws(() => validateTagOnnxCapability(c), new RegExp(method));
    }
  });

  test('REQUIRED_TAG_ONNX_CAPABILITY_METHODS matches core/ollama-lazy.js-sibling tag-onnx-lazy.js\'s own worker-touching export surface (isOnnxTagProvider deliberately excluded — see header comment)', async () => {
    const real = await import('../../../../src/indexer/phases/tag-onnx-lazy.js');
    const realFnNames = Object.keys(real).filter((k) => typeof real[k] === 'function' && k !== 'isOnnxTagProvider').sort();
    assert.deepEqual([...REQUIRED_TAG_ONNX_CAPABILITY_METHODS].sort(), realFnNames);
  });
});

describe('tag-onnx-capability.js — zero backend imports (contract, not implementation)', () => {
  test('the contract module source has no import of tag-onnx.js, tag-onnx-worker.js, onnxruntime-node, or @huggingface/transformers', () => {
    const src = readFileSync(new URL('../../../../src/indexer/phases/tag-onnx-capability.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/from ['"].*tag-onnx(-lazy)?\.js['"]/.test(codeOnly), 'must not import tag-onnx.js or tag-onnx-lazy.js');
    assert.ok(!/from ['"].*tag-onnx-worker\.js['"]/.test(codeOnly), 'must not import tag-onnx-worker.js');
    assert.ok(!/onnxruntime-node/.test(codeOnly), 'must not reference onnxruntime-node');
    assert.ok(!/@huggingface\/transformers/.test(codeOnly), 'must not reference @huggingface/transformers');
  });

  test('importing the contract module in isolation performs zero network/filesystem side effects', async () => {
    const mod = await import('../../../../src/indexer/phases/tag-onnx-capability.js');
    assert.ok(typeof mod.validateTagOnnxCapability === 'function');
    assert.ok(Array.isArray(mod.REQUIRED_TAG_ONNX_CAPABILITY_METHODS));
  });
});

describe('shutdownOnnxTagWorker always-safe-no-op contract — a disabled/no-op capability must resolve, never reject', () => {
  test('a hand-built disabled capability whose shutdownOnnxTagWorker never started anything still resolves without throwing', async () => {
    let started = false;
    const disabled = {
      addTagsOnnxBatch: async () => { throw new Error('addTagsOnnxBatch is disabled'); },
      shutdownOnnxTagWorker: async () => { /* no worker was ever started; always safe */ },
    };
    validateTagOnnxCapability(disabled);
    await assert.doesNotReject(() => disabled.shutdownOnnxTagWorker());
    assert.equal(started, false, 'sanity: no worker lifecycle was ever entered');
  });

  test('the real tag-onnx-lazy.lite.js shim already satisfies this exact contract (cross-check against the existing, already-shipped implementation)', async () => {
    const shim = await import('../../../../src/indexer/phases/tag-onnx-lazy.lite.js');
    validateTagOnnxCapability(shim);
    await assert.doesNotReject(() => shim.shutdownOnnxTagWorker());
    await assert.rejects(() => shim.addTagsOnnxBatch([]), /not available in Semidex Lite/);
  });
});
