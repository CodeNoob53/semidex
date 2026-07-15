// indexer/index.js is a CLI entry point, not importable for unit testing
// its internals directly (module-level side effects, no exported main()).
// The write-back mechanism itself (applyIndexerSettings) is private to
// that file, so this test proves the CONTRACT it depends on instead:
// every consumer function it write-backs for (resolveTokenCountMode,
// shouldUseOnnxBatching, resolveOnnxBatchSize, isCudaStrict,
// shouldGenerateTags, isOnnxTagProvider) genuinely re-reads process.env on
// each call — i.e. writing a new string into process.env before calling
// them (exactly what applyIndexerSettings does) is sufficient to change
// their output, with no caching/staleness in the way.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTokenCountMode } from '../../../src/core/token-count.js';
import { shouldUseOnnxBatching, resolveOnnxBatchSize } from '../../../src/core/embeddings.js';
import { isCudaStrict } from '../../../src/core/doctor-checks.js';
import { shouldGenerateTags } from '../../../src/indexer/phases/tag.js';
import { isOnnxTagProvider } from '../../../src/indexer/phases/tag-onnx.js';

function withEnv(overrides, fn) {
  const originals = {};
  for (const key of Object.keys(overrides)) originals[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  }
}

describe('write-back-to-process.env contract — every consumer applyIndexerSettings() targets re-reads process.env live', () => {
  test('resolveTokenCountMode() picks up a process.env write immediately (no default-arg caching)', () => {
    withEnv({ TOKEN_COUNT: 'heuristic' }, () => {
      assert.equal(resolveTokenCountMode(), 'heuristic');
    });
    withEnv({ TOKEN_COUNT: 'bge-m3' }, () => {
      assert.equal(resolveTokenCountMode(), 'bge-m3');
    });
  });

  test('shouldUseOnnxBatching(process.env)/resolveOnnxBatchSize(process.env) reflect a live write', () => {
    withEnv({ ONNX_EMBED: '1', ONNX_EXECUTION_PROVIDER: 'dml', ONNX_BATCH_SIZE: '32' }, () => {
      assert.equal(shouldUseOnnxBatching(process.env), true);
      assert.equal(resolveOnnxBatchSize(process.env), 32);
    });
    withEnv({ ONNX_EMBED: '0' }, () => {
      assert.equal(shouldUseOnnxBatching(process.env), false);
    });
  });

  test('isCudaStrict(process.env) reflects a live write', () => {
    withEnv({ ONNX_CUDA_STRICT: '1' }, () => assert.equal(isCudaStrict(process.env), true));
    withEnv({ ONNX_CUDA_STRICT: '0' }, () => assert.equal(isCudaStrict(process.env), false));
  });

  test('shouldGenerateTags(process.env)/isOnnxTagProvider(process.env) reflect a live write', () => {
    withEnv({ TAG_GEN: '1', TAG_PROVIDER: 'onnx' }, () => {
      assert.equal(shouldGenerateTags(process.env), true);
      assert.equal(isOnnxTagProvider(process.env), true);
    });
    withEnv({ TAG_GEN: '0', TAG_PROVIDER: 'ollama' }, () => {
      assert.equal(shouldGenerateTags(process.env), false);
      assert.equal(isOnnxTagProvider(process.env), false);
    });
  });
});
