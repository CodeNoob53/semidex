import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runHybridSearch, resolveSearchMode } from '../../../../src/core/retrieval/search.js';

function fakeAdapter({ capabilities, collection, hits } = {}) {
  return {
    capabilities: () => capabilities ?? { hybridSearch: true, sparseVectors: true },
    getCollection: async (name) => (collection === undefined ? { name } : collection),
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
    });
  });
});
