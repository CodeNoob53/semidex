import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LITE_HARD_PINS, applyLiteHardPins } from '../../../packages/lite/lite-src/hard-pins.js';

describe('LITE_HARD_PINS', () => {
  it('pins every cloud-only/deterministic value the plan requires', () => {
    assert.deepEqual(LITE_HARD_PINS, {
      DENSE_PROVIDER: 'qdrant-cloud',
      SPARSE_PROVIDER: 'qdrant-cloud',
      SEMIDEX_GENERATION_BACKEND: 'gemini',
      CONTEXT_MODE: 'deterministic',
      TAG_GEN: '0',
      SKELETON_SUMMARY: 'deterministic',
      COMBINED_LLM: '0',
      ONNX_EMBED: '0',
    });
  });

  it('is frozen — cannot be mutated at runtime', () => {
    assert.throws(() => { LITE_HARD_PINS.ONNX_EMBED = '1'; }, TypeError);
  });
});

describe('applyLiteHardPins()', () => {
  it('overwrites a stray local env var that would otherwise re-enable a local-only path', () => {
    const env = { ONNX_EMBED: '1', TAG_GEN: '1', SOME_UNRELATED_VAR: 'kept' };
    applyLiteHardPins(env);
    assert.equal(env.ONNX_EMBED, '0');
    assert.equal(env.TAG_GEN, '0');
    assert.equal(env.SOME_UNRELATED_VAR, 'kept');
  });

  it('sets every pin on an empty env object', () => {
    const env = {};
    applyLiteHardPins(env);
    for (const [key, value] of Object.entries(LITE_HARD_PINS)) {
      assert.equal(env[key], value);
    }
  });

  it('returns the same env object it mutated', () => {
    const env = {};
    const returned = applyLiteHardPins(env);
    assert.equal(returned, env);
  });
});
