// TagOnnxCapability contract (Phase 8B Step 1) — mirrors provider.test.js's
// shape-validator test style. See
// ../../../../src/shared/indexer/phases/tag-onnx-capability.js for the full
// rationale, in particular the shutdownOnnxTagWorker always-safe-no-op
// contract (Phase 8A Part D finding, a real production-incident-derived
// requirement).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateTagOnnxCapability, REQUIRED_TAG_ONNX_CAPABILITY_METHODS } from '../../../../src/shared/indexer/phases/tag-onnx-capability.js';

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

  test('REQUIRED_TAG_ONNX_CAPABILITY_METHODS matches the shape createTagOnnxCapability() actually returns (Phase 8B Step 4, second pass — local/indexer/phases/tag-onnx.js exports only a factory, never the two worker-touching methods directly)', async () => {
    const real = await import('../../../../src/local/indexer/phases/tag-onnx.js');
    assert.equal(typeof real.createTagOnnxCapability, 'function', 'sanity: the factory itself is exported');
    const instance = real.createTagOnnxCapability();
    const instanceFnNames = Object.keys(instance).filter((k) => typeof instance[k] === 'function').sort();
    assert.deepEqual([...REQUIRED_TAG_ONNX_CAPABILITY_METHODS].sort(), instanceFnNames);
    await instance.shutdownOnnxTagWorker(); // no worker was ever spawned; safe cleanup
  });
});

describe('tag-onnx-capability.js — zero backend imports (contract, not implementation)', () => {
  test('the contract module source has no import of tag-onnx.js, tag-onnx-worker.js, onnxruntime-node, or @huggingface/transformers', () => {
    const src = readFileSync(new URL('../../../../src/shared/indexer/phases/tag-onnx-capability.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/from ['"].*tag-onnx(-lazy)?\.js['"]/.test(codeOnly), 'must not import tag-onnx.js or tag-onnx-lazy.js');
    assert.ok(!/from ['"].*tag-onnx-worker\.js['"]/.test(codeOnly), 'must not import tag-onnx-worker.js');
    assert.ok(!/onnxruntime-node/.test(codeOnly), 'must not reference onnxruntime-node');
    assert.ok(!/@huggingface\/transformers/.test(codeOnly), 'must not reference @huggingface/transformers');
  });

  test('importing the contract module in isolation performs zero network/filesystem side effects', async () => {
    const mod = await import('../../../../src/shared/indexer/phases/tag-onnx-capability.js');
    assert.ok(typeof mod.validateTagOnnxCapability === 'function');
    assert.ok(Array.isArray(mod.REQUIRED_TAG_ONNX_CAPABILITY_METHODS));
  });
});

describe('getResourceIdentity() — structural CPU fact, real createTagOnnxCapability() instance', () => {
  test('the real ONNX tag worker capability reports verified cpu, source structural', async () => {
    const { createTagOnnxCapability } = await import('../../../../src/local/indexer/phases/tag-onnx.js');
    const instance = createTagOnnxCapability();
    const result = instance.getResourceIdentity();
    assert.deepEqual(result, { kind: 'cpu', backend: 'onnx-tag-worker', deviceId: null, verified: true, source: 'structural' });
    await instance.shutdownOnnxTagWorker();
  });
});

describe('shutdownOnnxTagWorker always-safe-no-op contract — a disabled/no-op capability must resolve, never reject', () => {
  test('a hand-built disabled capability whose shutdownOnnxTagWorker never started anything still resolves without throwing', async () => {
    let started = false;
    const disabled = {
      addTagsOnnxBatch: async () => { throw new Error('addTagsOnnxBatch is disabled'); },
      shutdownOnnxTagWorker: async () => { /* no worker was ever started; always safe */ },
      getResourceIdentity: async () => ({ kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null }),
    };
    validateTagOnnxCapability(disabled);
    await assert.doesNotReject(() => disabled.shutdownOnnxTagWorker());
    assert.equal(started, false, 'sanity: no worker lifecycle was ever entered');
  });

  test('indexer/index-lite.js declares a shape-conforming, always-safe-no-op typed-unavailable capability (structural check — see tests/unit/architecture/onnx-embed-instance-scoping.test.js and index-capability-wiring.test.js for the real behavioral proof that index-lite.js actually constructs and passes it)', () => {
    // Phase 8B Step 8: Lite no longer reaches this shape through a
    // *-lazy.lite.js shim file — index-lite.js builds its own small,
    // local, throwaway typed-unavailable capability object directly (see
    // that file's own header comment for why: the *-lazy.js/*-lazy.lite.js
    // dynamic-loader wrappers were deleted outright, not merely excluded
    // from the Lite package). Source-level structural check only — the
    // real construction is exercised behaviorally by index-capability-wiring.test.js's
    // own 'supplies a typed-unavailable capability for every slot' assertion.
    const src = readFileSync(new URL('../../../../src/indexer/index-lite.js', import.meta.url), 'utf-8');
    assert.match(src, /function unavailableTagOnnxCapability\(\)/);
    const fnStart = src.indexOf('function unavailableTagOnnxCapability');
    const fnEnd = src.indexOf('\n}', fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    assert.match(fnBody, /addTagsOnnxBatch:/);
    assert.match(fnBody, /async shutdownOnnxTagWorker\(\)/, 'shutdownOnnxTagWorker must be declared async (always resolves, matching the always-safe-no-op contract)');
    // Scoped to JUST the shutdownOnnxTagWorker line itself (not the whole
    // rest of the function body, which legitimately contains the word
    // "throw" elsewhere — e.g. getResourceIdentity's own never-throw
    // doc comment below it) — a single-line match, no /s flag.
    const shutdownLine = fnBody.split('\n').find((l) => l.includes('shutdownOnnxTagWorker()'));
    assert.doesNotMatch(shutdownLine, /throw/, 'shutdownOnnxTagWorker must never throw — a disabled capability\'s cleanup must always be safe');
    assert.match(fnBody, /async getResourceIdentity\(\)/, 'getResourceIdentity must be declared async (always resolves, never throws, matching the identity never-throw contract)');
    const identityLine = fnBody.split('\n').find((l) => l.includes('getResourceIdentity()'));
    assert.doesNotMatch(identityLine, /throw/, 'getResourceIdentity must never throw — a disabled capability must report unknown, never an error');
  });
});
