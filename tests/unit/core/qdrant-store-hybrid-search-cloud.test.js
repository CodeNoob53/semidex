// Behavioral test for src/core/qdrant/store.js's hybridSearchCloud() —
// captures the EXACT request body it builds via a real Qdrant SDK client
// whose prototype .query() method is monkey-patched to record call args
// instead of making a network call (getQdrantClient() only constructs the
// client lazily and never calls the network itself, so this never touches
// a real Qdrant instance). Proves: two prefetch lanes (using: 'dense'/
// 'sparse', each carrying the caller's already-built {text, model}
// inference descriptor verbatim), top-level query: {rrf: {k}}, limit,
// with_payload: true, and — when a filter is supplied — that same filter
// threaded into BOTH prefetch entries.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { hybridSearchCloud } from '../../../src/core/qdrant/store.js';
import { resetQdrantClientCache } from '../../../src/core/qdrant/client.js';

let originalQuery;
let captured;

beforeEach(() => {
  process.env.QDRANT_URL = 'http://localhost:6333';
  resetQdrantClientCache();
  captured = null;
  originalQuery = QdrantClient.prototype.query;
  QdrantClient.prototype.query = function (collection, body) {
    captured = { collection, body };
    return Promise.resolve({ points: [{ id: 1, score: 0.5, payload: { source_file: 'a.md' } }] });
  };
});

afterEach(() => {
  QdrantClient.prototype.query = originalQuery;
  resetQdrantClientCache();
});

const denseQuery = { text: 'привіт', model: 'intfloat/multilingual-e5-small' };
const sparseQuery = { text: 'привіт', model: 'qdrant/bm25' };

describe('hybridSearchCloud() — exact Qdrant Query API request shape', () => {
  it('builds two prefetch lanes carrying the caller-supplied inference descriptors verbatim, using: dense/sparse', async () => {
    await hybridSearchCloud('my-collection', denseQuery, sparseQuery, 5, null, {});
    assert.equal(captured.collection, 'my-collection');
    assert.equal(captured.body.prefetch.length, 2);
    const denseLane = captured.body.prefetch.find((p) => p.using === 'dense');
    const sparseLane = captured.body.prefetch.find((p) => p.using === 'sparse');
    assert.deepEqual(denseLane.query, denseQuery);
    assert.deepEqual(sparseLane.query, sparseQuery);
  });

  it('top-level query is {rrf: {k}} — RRF fusion stays server-side, never computed in JS here', async () => {
    await hybridSearchCloud('c', denseQuery, sparseQuery, 5, null, {});
    assert.ok('rrf' in captured.body.query);
    assert.equal(typeof captured.body.query.rrf.k, 'number');
  });

  it('limit and with_payload:true are set on the top-level request', async () => {
    await hybridSearchCloud('c', denseQuery, sparseQuery, 7, null, {});
    assert.equal(captured.body.limit, 7);
    assert.equal(captured.body.with_payload, true);
  });

  it('a supplied filter is threaded into BOTH prefetch entries', async () => {
    const filter = { must: [{ key: 'source_file', match: { value: 'a.md' } }] };
    await hybridSearchCloud('c', denseQuery, sparseQuery, 5, filter, {});
    for (const lane of captured.body.prefetch) {
      assert.deepEqual(lane.filter, filter);
    }
  });

  it('with no sparseQuery (dense-only), only ONE prefetch lane is built, still using: dense', async () => {
    await hybridSearchCloud('c', denseQuery, null, 5, null, {});
    assert.equal(captured.body.prefetch.length, 1);
    assert.equal(captured.body.prefetch[0].using, 'dense');
  });

  it('resolves HYBRID_PREFETCH_LIMIT/RRF_K via the SAME settingsService-driven helpers as hybridSearch() (no drift between the two)', async () => {
    const fakeSettingsService = {
      getActiveValue: (key) => (key === 'HYBRID_PREFETCH_LIMIT' ? 3 : key === 'RRF_K' ? 42 : null),
    };
    await hybridSearchCloud('c', denseQuery, sparseQuery, 5, null, { settingsService: fakeSettingsService });
    assert.equal(captured.body.query.rrf.k, 42);
    assert.equal(captured.body.prefetch[0].limit, Math.max(5 * 3, 5 + 1));
  });

  it('returns result.points straight through (result.hits mapping happens at the adapter layer, not here)', async () => {
    const points = await hybridSearchCloud('c', denseQuery, sparseQuery, 5, null, {});
    assert.deepEqual(points, [{ id: 1, score: 0.5, payload: { source_file: 'a.md' } }]);
  });
});
