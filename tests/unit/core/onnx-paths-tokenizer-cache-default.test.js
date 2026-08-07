// core/onnx-paths.js — SEMIDEX_TOKENIZER_CACHE_DIR UNSET (fallback)
// scenario, kept in its own file/process for the same reason as its
// override-set sibling (onnx-paths-tokenizer-cache-override.test.js) — an
// import-time constant must never be asserted twice against different env
// values within one process.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SEMIDEX_TOKENIZER_CACHE_DIR;

describe('core/onnx-paths.js — SEMIDEX_TOKENIZER_CACHE_DIR unset (default)', () => {
  it('TOKENIZER_CACHE_DIR falls back to ONNX_CACHE_DIR exactly — full Semidex behavior unchanged', async () => {
    const { TOKENIZER_CACHE_DIR, ONNX_CACHE_DIR } = await import('../../../src/shared/core/onnx-paths.js');
    assert.equal(TOKENIZER_CACHE_DIR, ONNX_CACHE_DIR);
    assert.ok(TOKENIZER_CACHE_DIR.endsWith('models'), 'must be the exact pre-existing package-relative default');
  });
});
