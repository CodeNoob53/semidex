import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runHybridSearch, resolveSearchMode } from '../../../../src/core/retrieval/search.js';

const validProfile = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function fakeAdapter({ capabilities, collection, hits, embeddingProfileResult } = {}) {
  return {
    capabilities: () => capabilities ?? { hybridSearch: true, sparseVectors: true },
    getCollection: async (name) => (collection === undefined ? { name } : collection),
    getEmbeddingProfile: async () => embeddingProfileResult ?? { state: 'valid', profile: validProfile },
    searchHybrid: async (name, opts) => {
      fakeAdapter.lastCall = { name, opts };
      return hits ?? [];
    },
  };
}

describe('resolveSearchMode', () => {
  test('hybrid when both capabilities present', () => {
    assert.equal(resolveSearchMode({ hybridSearch: true, sparseVectors: true }), 'hybrid');
  });
  test('null when either capability missing', () => {
    assert.equal(resolveSearchMode({ hybridSearch: true, sparseVectors: false }), null);
    assert.equal(resolveSearchMode({ hybridSearch: false, sparseVectors: true }), null);
  });
});

describe('runHybridSearch', () => {
  test('returns not_implemented when adapter lacks hybrid capabilities', async () => {
    const adapter = fakeAdapter({ capabilities: { hybridSearch: false, sparseVectors: false } });
    const result = await runHybridSearch({ adapter, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'not_implemented');
  });

  test('returns collection_not_found when adapter.getCollection resolves null', async () => {
    const adapter = fakeAdapter({ collection: null });
    const result = await runHybridSearch({ adapter, collection: 'missing', query: 'q', top: 5 });
    assert.equal(result.error, 'collection_not_found');
    assert.match(result.message, /missing/);
  });

  test('returns embedding_failed when embedQuery rejects', async () => {
    const adapter = fakeAdapter();
    const embedQuery = async () => { throw new Error('boom'); };
    const result = await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'embedding_failed');
    assert.match(result.message, /boom/);
  });

  test('always sets excludeNav: true on the filter, even with no other filters', async () => {
    const adapter = fakeAdapter();
    const embedQuery = async () => ({ dense: [1, 2], sparse: { indices: [], values: [] } });
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.deepEqual(fakeAdapter.lastCall.opts.filter, { excludeNav: true });
  });

  test('merges sourceFile and tags filters alongside excludeNav', async () => {
    const adapter = fakeAdapter();
    const embedQuery = async () => ({ dense: [1], sparse: {} });
    await runHybridSearch({
      adapter, embedQuery, collection: 'c', query: 'q', top: 5,
      filters: { sourceFile: 'docs/a.md', tags: ['x', 'y'] },
    });
    assert.deepEqual(fakeAdapter.lastCall.opts.filter, {
      sourceFile: 'docs/a.md', tags: ['x', 'y'], excludeNav: true,
    });
  });

  test('passes dense/sparse vectors and limit through to searchHybrid, returns hits and searchMode', async () => {
    const hits = [{ sourceFile: 'a.md', chunkIndex: 0, score: 0.9 }];
    const adapter = fakeAdapter({ hits });
    const embedQuery = async () => ({ dense: [0.1, 0.2], sparse: { indices: [1], values: [0.5] } });
    const result = await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 7 });
    assert.equal(result.searchMode, 'hybrid');
    assert.deepEqual(result.hits, hits);
    assert.deepEqual(fakeAdapter.lastCall.opts, {
      dense: [0.1, 0.2], sparse: { indices: [1], values: [0.5] }, limit: 7, filter: { excludeNav: true },
      settingsService: undefined,
    });
  });

  test('forwards a supplied settingsService through to searchHybrid (so HYBRID_PREFETCH_LIMIT/RRF_K apply to admin search and Ask, not just MCP)', async () => {
    const adapter = fakeAdapter();
    const embedQuery = async () => ({ dense: [1], sparse: {} });
    const fakeSettingsService = { getActiveValue: () => 42, refreshIfChanged: () => {} };
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5, settingsService: fakeSettingsService });
    assert.equal(fakeAdapter.lastCall.opts.settingsService, fakeSettingsService);
  });

  test('passes the RESOLVED PROFILE (not a bare collection string) to embedQuery', async () => {
    const adapter = fakeAdapter();
    let capturedFirstArg;
    const embedQuery = async (profileArg, query) => { capturedFirstArg = profileArg; return { dense: [1], sparse: {} }; };
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.deepEqual(capturedFirstArg, validProfile);
  });

  test('resolution failure short-circuits BEFORE embedQuery is ever called — never invokes a local default model for an unresolved profile', async () => {
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'missing' } });
    let embedQueryCalled = false;
    const embedQuery = async () => { embedQueryCalled = true; return { dense: [1], sparse: {} }; };
    const result = await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'embedding_unresolved');
    assert.equal(embedQueryCalled, false);
  });

  test('an "invalid" profile state also produces embedding_unresolved, never a silent fallback', async () => {
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'invalid', errors: ['bad'] } });
    const result = await runHybridSearch({ adapter, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'embedding_unresolved');
  });

  test('a profile with a non-client execution mode (e.g. qdrant-cloud) produces embedding_unsupported, never invoking embedQuery', async () => {
    const cloudProfile = { ...validProfile, embedding: { ...validProfile.embedding, dense: { ...validProfile.embedding.dense, execution: 'qdrant-cloud' } } };
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: cloudProfile } });
    let embedQueryCalled = false;
    const embedQuery = async () => { embedQueryCalled = true; return { dense: [1], sparse: {} }; };
    const result = await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'embedding_unsupported');
    assert.match(result.message, /qdrant-cloud/);
    assert.equal(embedQueryCalled, false);
  });

  test('same-dimension-different-model is never accepted as compatible: two profiles with equal dimensions but different models are passed through distinctly, never cross-substituted', async () => {
    const profileA = validProfile;
    const profileB = { ...validProfile, embedding: { ...validProfile.embedding, dense: { ...validProfile.embedding.dense, model: 'a-completely-different-model', dimensions: 1024 } } };
    const adapterA = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: profileA } });
    const adapterB = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: profileB } });
    const captured = [];
    const embedQuery = async (profileArg) => { captured.push(profileArg.embedding.dense.model); return { dense: [1], sparse: {} }; };
    await runHybridSearch({ adapter: adapterA, embedQuery, collection: 'c', query: 'q', top: 5 });
    await runHybridSearch({ adapter: adapterB, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.equal(captured[0], 'bge-m3');
    assert.equal(captured[1], 'a-completely-different-model');
    assert.notEqual(captured[0], captured[1], 'equal dimensions must never cause the two distinct models to be treated as interchangeable');
  });
});
