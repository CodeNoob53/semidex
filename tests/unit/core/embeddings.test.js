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
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  embedForIndex, embedForIndexBatch, embedForSearch, SCHEMA_VERSION, shouldUseOnnxBatching, resolveOnnxBatchSize,
  EmbeddingInputTooLongError, setLocalEmbedOverrideForTest,
} from '../../../src/core/embeddings.js';

afterEach(() => setLocalEmbedOverrideForTest(null));

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

  it('embedForIndex rejects a profile with a still-unimplemented (e.g. qdrant-cluster) dense execution — qdrant-cloud is now supported (see the cloud describe block below)', async () => {
    await assert.rejects(
      () => embedForIndex(profile({ execution: 'qdrant-cluster' }), 'text'),
      /execution: 'client'/,
    );
  });

  it('embedForIndexBatch rejects a profile with a still-unimplemented (e.g. qdrant-cluster) dense execution', async () => {
    await assert.rejects(
      () => embedForIndexBatch(profile({ execution: 'qdrant-cluster' }), ['a', 'b'], async (items, size, fn) => Promise.all(items.map(fn)), 2),
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

function cloudProfile({ denseModel = 'intfloat/multilingual-e5-small', sparseModel = 'qdrant/bm25' } = {}) {
  return {
    schemaVersion: 1, managedBy: 'semidex',
    embedding: {
      dense: { provider: 'qdrant-cloud', model: denseModel, vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
      sparse: sparseModel === null ? null : { provider: 'qdrant-cloud', model: sparseModel, vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
    },
    embeddingSchemaVersion: 2,
  };
}

describe('embeddings.js — qdrant-cloud execution: REAL behavioral proof the local embed step is never called', () => {
  it('embedForIndex on a qdrant-cloud profile completes successfully and returns {text, model} descriptors WITHOUT ever calling the local embed step', async () => {
    setLocalEmbedOverrideForTest(() => { throw new Error('local embed must never be called for a qdrant-cloud profile'); });
    const result = await embedForIndex(cloudProfile(), 'hello world');
    assert.deepEqual(result.dense, { text: 'hello world', model: 'intfloat/multilingual-e5-small' });
    assert.deepEqual(result.sparse, { text: 'hello world', model: 'qdrant/bm25' });
    assert.equal(result.meta.dense_provider, 'qdrant-cloud');
  });

  it('embedForIndexBatch on a qdrant-cloud profile completes successfully for every text, never calling the local embed step', async () => {
    setLocalEmbedOverrideForTest(() => { throw new Error('local embed must never be called for a qdrant-cloud profile'); });
    const runBatched = async (items, size, fn) => Promise.all(items.map(fn));
    const results = await embedForIndexBatch(cloudProfile(), ['a', 'b', 'c'], runBatched, 2);
    assert.equal(results.length, 3);
    for (let i = 0; i < results.length; i++) {
      assert.deepEqual(results[i].dense, { text: ['a', 'b', 'c'][i], model: 'intfloat/multilingual-e5-small' });
    }
  });

  it('REGRESSION (P2 fix): embedForSearch has NO qdrant-cloud branch — it stays client-only and still rejects a cloud profile exactly as before (cloud query building lives in buildCloudQueryInputs, never in embeddings.js)', async () => {
    setLocalEmbedOverrideForTest(() => { throw new Error('must not be reached — this test only checks the rejection happens before any embed attempt'); });
    await assert.rejects(
      () => embedForSearch(cloudProfile(), 'query'),
      /execution: 'client'/,
    );
  });

  it('sparse descriptor never carries options/modifier (Revision 2 regression check)', async () => {
    const result = await embedForIndex(cloudProfile(), 'text');
    assert.ok(!('options' in result.sparse));
    assert.ok(!('modifier' in result.sparse));
  });

  it('dense === null-sparse profile returns sparse: null, not a descriptor', async () => {
    const result = await embedForIndex(cloudProfile({ sparseModel: null }), 'text');
    assert.equal(result.sparse, null);
  });

  it('an unknown/unsupported dense model throws before returning any descriptor', async () => {
    await assert.rejects(
      () => embedForIndex(cloudProfile({ denseModel: 'sentence-transformers/all-minilm-l6-v2' }), 'text'),
      /not in the supported Qdrant Cloud dense model catalog|not a supported/,
    );
  });

  it('checkEmbedInputFits rejection surfaces as a typed EmbeddingInputTooLongError, never a silent truncate', async () => {
    // A context prefix long enough to push the assembled text over E5's
    // 512-token window — mirrors the catalog test's own regression fixture.
    const heavyContext = 'Section > Subsection > '.repeat(300);
    await assert.rejects(
      () => embedForIndex(cloudProfile(), `${heavyContext}\n\nshort chunk body`),
      (err) => {
        assert.ok(err instanceof EmbeddingInputTooLongError);
        assert.equal(err.code, 'EMBEDDING_INPUT_TOO_LONG');
        return true;
      },
    );
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
