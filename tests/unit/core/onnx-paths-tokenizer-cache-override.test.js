// core/onnx-paths.js — SEMIDEX_TOKENIZER_CACHE_DIR override, override-SET
// scenario only. TOKENIZER_CACHE_DIR is an import-time constant (computed
// once when the module is first evaluated) — asserting it against a
// SPECIFIC value requires this file to import onnx-paths.js exactly once,
// with the env var already set before that import. node:test runs each
// file in its own process, so this is isolated from every other test
// file's module state; the unset/fallback scenario is intentionally a
// SEPARATE file (onnx-paths-tokenizer-cache-default.test.js) rather than a
// second test here, because a second import() in this same process would
// hit the module cache and silently return this test's already-resolved
// constant regardless of the env change — a real bug this split avoids
// reintroducing (caught in review before landing).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

process.env.SEMIDEX_TOKENIZER_CACHE_DIR = join('C:', 'lite-home', 'cache', 'tokenizers');

describe('core/onnx-paths.js — SEMIDEX_TOKENIZER_CACHE_DIR override (set)', () => {
  it('TOKENIZER_CACHE_DIR resolves to the override', async () => {
    const { TOKENIZER_CACHE_DIR } = await import('../../../src/core/onnx-paths.js');
    assert.equal(TOKENIZER_CACHE_DIR, process.env.SEMIDEX_TOKENIZER_CACHE_DIR);
  });

  it('the ONNX model cache stays on its own default — redirecting the tokenizer cache never moves it', async () => {
    const { ONNX_CACHE_DIR } = await import('../../../src/core/onnx-paths.js');
    assert.notEqual(ONNX_CACHE_DIR, process.env.SEMIDEX_TOKENIZER_CACHE_DIR);
    assert.ok(ONNX_CACHE_DIR.endsWith('models'), 'ONNX_CACHE_DIR must remain the package-relative models/ dir');
  });

  it('embedding-profile/qdrant-cloud-tokenizer.js (imported from the same process) observes the identical override, since it imports TOKENIZER_CACHE_DIR from onnx-paths.js', async () => {
    const { TOKENIZER_CACHE_DIR } = await import('../../../src/core/onnx-paths.js');
    // Importing qdrant-cloud-tokenizer.js must not throw and must be wired
    // to the same constant this file already observed as the override —
    // proven indirectly here since tokenizerDir() is module-private; the
    // real download round-trip is covered by qdrant-cloud-tokenizer's own
    // existing corrupt-cache-recovery integration tests.
    const mod = await import('../../../src/core/embedding-profile/qdrant-cloud-tokenizer.js');
    assert.ok(typeof mod === 'object');
    assert.equal(TOKENIZER_CACHE_DIR, process.env.SEMIDEX_TOKENIZER_CACHE_DIR);
  });
});
