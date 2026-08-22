// Focused store-level characterization for getSectionSiblings()
// (src/core/qdrant/store.js, added for graph-expanded retrieval —
// docs/design/graph-expanded-retrieval.md). Same convention as
// tests/unit/core/qdrant-store-hybrid-search-telemetry.test.js: a real
// QdrantClient with only client.scroll monkey-patched, never a live
// cluster. Exists because getStructuralNeighbors()'s own tests
// (tests/unit/core/storage/qdrant-adapter.test.js) exercise it entirely
// through the storeOverrides DI seam and never touch this function's own
// bounded-scroll-call / client-side nav-filter / sort contract directly.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { getSectionSiblings } from '../../../src/core/qdrant/store.js';
import { resetQdrantClientCache } from '../../../src/core/qdrant/client.js';

let originalScroll;
let lastScrollCall;

beforeEach(() => {
  process.env.QDRANT_URL = 'http://localhost:6333';
  resetQdrantClientCache();
  originalScroll = QdrantClient.prototype.scroll;
  lastScrollCall = null;
});

afterEach(() => {
  QdrantClient.prototype.scroll = originalScroll;
  resetQdrantClientCache();
  delete process.env.QDRANT_URL;
});

function contentPoint(chunkIndex, overrides = {}) {
  return {
    id: `p${chunkIndex}`,
    payload: { point_kind: 'retrieval_content', parent_id: 'section-A', source_file: 'docs/guide.md', chunk_index: chunkIndex, ...overrides },
  };
}

function navPoint(overrides = {}) {
  return { id: 'nav-1', payload: { point_kind: 'skeleton_nav', parent_id: 'section-A', ...overrides } };
}

describe('getSectionSiblings() — bounded single-page sibling lookup (docs/design/graph-expanded-retrieval.md)', () => {
  it('requests exactly ONE scroll call capped at limit + 1, filtered by parent_id and nav-excluded', async () => {
    QdrantClient.prototype.scroll = (collection, opts) => {
      lastScrollCall = { collection, opts };
      return Promise.resolve({ points: [contentPoint(1)] });
    };
    await getSectionSiblings('c1', 'section-A', 5);
    assert.equal(lastScrollCall.collection, 'c1');
    assert.equal(lastScrollCall.opts.limit, 6, 'must request limit + 1 headroom for the seed\'s own point, never an unbounded/paginated scroll');
    assert.deepEqual(lastScrollCall.opts.filter.must, [{ key: 'parent_id', match: { value: 'section-A' } }]);
    assert.ok(
      lastScrollCall.opts.filter.must_not.some((c) => c.key === 'point_kind' && c.match.value === 'skeleton_nav'),
      'must merge withNavExcluded() so a skeleton_nav point can never be requested as a sibling',
    );
  });

  it('a skeleton_nav point sharing the same parent_id is excluded client-side even if the (mocked) server ever returned one', async () => {
    QdrantClient.prototype.scroll = () => Promise.resolve({ points: [navPoint(), contentPoint(1), contentPoint(2)] });
    const results = await getSectionSiblings('c1', 'section-A', 5);
    assert.equal(results.length, 2, 'the nav point must never survive into the returned siblings, regardless of what a non-conforming server sends back');
    assert.ok(results.every((p) => p.payload.point_kind !== 'skeleton_nav'));
  });

  it('sorts results by chunk_index ascending, independent of the (unspecified) scroll return order', async () => {
    QdrantClient.prototype.scroll = () => Promise.resolve({ points: [contentPoint(5), contentPoint(1), contentPoint(3)] });
    const results = await getSectionSiblings('c1', 'section-A', 5);
    assert.deepEqual(results.map((p) => p.payload.chunk_index), [1, 3, 5]);
  });

  it('drops a point with no integer chunk_index rather than letting it sort unpredictably among real siblings', async () => {
    QdrantClient.prototype.scroll = () => Promise.resolve({
      points: [contentPoint(1), { id: 'malformed', payload: { point_kind: 'retrieval_content', parent_id: 'section-A' } }],
    });
    const results = await getSectionSiblings('c1', 'section-A', 5);
    assert.deepEqual(results.map((p) => p.id), ['p1']);
  });
});
