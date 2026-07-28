// Tests for src/core/embeddings.js's profile-driven refactor (Part E of the
// native-metadata task). embedForIndex/embedForIndexBatch/embedForSearch
// now take an already-resolved embedding profile directly instead of a
// bare collection name — this module no longer reads config.json/env
// itself at all.
//
// No mock.module() here (this repo's floor Node version is >=20.16.0,
// mock.module() stabilized later and is deliberately not used anywhere in
// this codebase — see tests/unit/admin/api/onnx.test.js's own comment on
// this exact constraint) — a real dense embed call (ollama fetch or ONNX
// session) cannot be network-mocked at this layer, so these tests exercise
// only the parts reachable WITHOUT a real embed call: the execution-mode
// guard (assertClientExecution) and the provider-combo guard
// (assertProviderCombo), both of which throw before any network/ONNX call
// happens.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { embedForIndex, embedForIndexBatch, embedForSearch, SCHEMA_VERSION, shouldUseOnnxBatching, resolveOnnxBatchSize } from '../../../src/core/embeddings.js';

function profile({ denseProvider = 'ollama', sparseProvider = 'hashed-tf', execution = 'client', sparseExecution = execution } = {}) {
  return {
    schemaVersion: 1,
    managedBy: 'semidex',
    embedding: {
      dense: { provider: denseProvider, model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution },
      sparse: sparseProvider === null ? null : { provider: sparseProvider, model: sparseProvider, vectorName: 'sparse', execution: sparseExecution },
    },
    embeddingSchemaVersion: 2,
  };
}

describe('embeddings.js — execution-mode guard (assertClientExecution)', () => {
  it('embedForSearch rejects a profile with a non-client dense execution before any embed call', async () => {
    await assert.rejects(
      () => embedForSearch(profile({ execution: 'qdrant-cloud' }), 'query'),
      /execution: 'client'/,
    );
  });

  it('embedForIndex rejects a profile with a non-client dense execution', async () => {
    await assert.rejects(
      () => embedForIndex(profile({ execution: 'qdrant-cluster' }), 'text'),
      /execution: 'client'/,
    );
  });

  it('embedForIndexBatch rejects a profile with a non-client dense execution', async () => {
    await assert.rejects(
      () => embedForIndexBatch(profile({ execution: 'qdrant-cloud' }), ['a', 'b'], async (items, size, fn) => Promise.all(items.map(fn)), 2),
      /execution: 'client'/,
    );
  });

  it('the error message names the actual declared execution mode, not a generic message', async () => {
    try {
      await embedForSearch(profile({ execution: 'qdrant-cloud' }), 'query');
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /qdrant-cloud/);
    }
  });
});

describe('embeddings.js — provider-combo guard (assertProviderCombo), same profile in, same dispatch out for all three functions', () => {
  it('embedForSearch rejects an invalid dense/sparse provider combination', async () => {
    await assert.rejects(
      () => embedForSearch(profile({ denseProvider: 'ollama', sparseProvider: 'bge-m3-onnx' }), 'query'),
      /Invalid provider combination/,
    );
  });

  it('embedForIndex rejects the same invalid combination', async () => {
    await assert.rejects(
      () => embedForIndex(profile({ denseProvider: 'ollama', sparseProvider: 'bge-m3-onnx' }), 'text'),
      /Invalid provider combination/,
    );
  });

  it('embedForIndexBatch rejects the same invalid combination before any batching/runBatched call', async () => {
    let runBatchedCalled = false;
    await assert.rejects(
      () => embedForIndexBatch(
        profile({ denseProvider: 'ollama', sparseProvider: 'bge-m3-onnx' }),
        ['a'],
        async (items, size, fn) => { runBatchedCalled = true; return Promise.all(items.map(fn)); },
        2,
      ),
      /Invalid provider combination/,
    );
    assert.equal(runBatchedCalled, false, 'must reject before ever calling runBatched');
  });
});

describe('embeddings.js — execution-mode guard runs before the provider-combo guard', () => {
  it('a profile with BOTH a bad execution AND a bad combo fails on the execution check first (more specific, checked first)', async () => {
    try {
      await embedForSearch(profile({ execution: 'qdrant-cloud', denseProvider: 'ollama', sparseProvider: 'bge-m3-onnx' }), 'query');
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /execution: 'client'/);
    }
  });
});

describe('embeddings.js — unchanged pure exports', () => {
  it('SCHEMA_VERSION is 2', () => {
    assert.equal(SCHEMA_VERSION, 2);
  });

  it('shouldUseOnnxBatching / resolveOnnxBatchSize are unaffected by the profile refactor', () => {
    assert.equal(shouldUseOnnxBatching({ ONNX_EMBED: '1', ONNX_EXECUTION_PROVIDER: 'dml' }), true);
    assert.equal(shouldUseOnnxBatching({ ONNX_EMBED: '0' }), false);
    assert.equal(resolveOnnxBatchSize({ ONNX_BATCH_SIZE: '8' }), 8);
  });
});
