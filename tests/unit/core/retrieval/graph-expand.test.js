// Focused unit tests + deterministic fixture for graph-expanded retrieval
// (docs/design/graph-expanded-retrieval.md, docs/tasks/graph-expanded-retrieval-step1.md).
// No live Qdrant: expandSeedsWithGraph() is exercised entirely against a
// fake adapter (same convention as tests/unit/core/retrieval/search.test.js's
// fakeAdapter) whose getStructuralNeighbors() simulates real, deterministic
// structural relations (section siblings, prev/next chunk) — proving the
// coordinator's dedup/ranking/limit/filter logic without any network call.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandSeedsWithGraph } from '../../../../src/core/retrieval/graph-expand.js';

function chunk(overrides) {
  return {
    sourceFile: 'docs/guide.md', chunkIndex: 0, section: 'Intro', text: 'text',
    tags: [], nodeId: null, nodePath: null, nodeType: null, parentId: null,
    score: null, isMatch: null,
    ...overrides,
  };
}

function fakeAdapter({ capabilities, neighborsByNodeId = {} } = {}) {
  return {
    capabilities: () => capabilities ?? { structuralExpansion: true },
    getStructuralNeighbors: async (name, opts) => {
      fakeAdapter.calls = fakeAdapter.calls ?? [];
      fakeAdapter.calls.push(opts);
      return neighborsByNodeId[opts.nodeId] ?? [];
    },
  };
}

describe('expandSeedsWithGraph — feature-off / unsupported-adapter passthrough', () => {
  it('returns seeds unchanged (as seed entries) when adapter lacks structuralExpansion capability', async () => {
    const adapter = fakeAdapter({ capabilities: { structuralExpansion: false } });
    const seeds = [chunk({ nodeId: 'n1' }), chunk({ nodeId: 'n2', chunkIndex: 1 })];
    const result = await expandSeedsWithGraph({ adapter, collection: 'c', seeds, seedLimit: 5, maxExpandedPerSeed: 3 });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((e) => e.retrievalOrigin), ['seed', 'seed']);
    assert.deepEqual(result.map((e) => e.seedRank), [0, 1]);
  });

  it('returns seeds unchanged when adapter has no getStructuralNeighbors method at all', async () => {
    const adapter = { capabilities: () => ({ structuralExpansion: true }) };
    const seeds = [chunk({ nodeId: 'n1' })];
    const result = await expandSeedsWithGraph({ adapter, collection: 'c', seeds, seedLimit: 5, maxExpandedPerSeed: 3 });
    assert.deepEqual(result.map((e) => e.retrievalOrigin), ['seed']);
  });

  it('never calls getStructuralNeighbors for a legacy seed with no nodeId (no-skeleton non-goal)', async () => {
    fakeAdapter.calls = [];
    const adapter = fakeAdapter();
    const seeds = [chunk({ nodeId: null })];
    const result = await expandSeedsWithGraph({ adapter, collection: 'c', seeds, seedLimit: 5, maxExpandedPerSeed: 3 });
    assert.deepEqual(result.map((e) => e.retrievalOrigin), ['seed']);
    assert.deepEqual(fakeAdapter.calls, []);
  });

  it('a broken/throwing getStructuralNeighbors degrades to seed-only for that seed, never fails the whole call', async () => {
    const adapter = {
      capabilities: () => ({ structuralExpansion: true }),
      getStructuralNeighbors: async () => { throw new Error('boom'); },
    };
    const seeds = [chunk({ nodeId: 'n1' })];
    const result = await expandSeedsWithGraph({ adapter, collection: 'c', seeds, seedLimit: 5, maxExpandedPerSeed: 3 });
    assert.deepEqual(result.map((e) => e.retrievalOrigin), ['seed']);
  });
});

describe('expandSeedsWithGraph — deterministic fixture: recovers a content node the seed pool missed', () => {
  // Fixture: a query returns exactly ONE seed hit (chunkIndex 0, nodeId
  // 'seed-1', parentId 'section-A'). The real document also has a second,
  // topically-relevant chunk in the SAME section (nodeId 'sibling-1') that
  // hybrid search did NOT surface as a seed at all — simulating the
  // "evidence split across related nodes" scenario the design doc exists to
  // recover. getStructuralNeighbors() is wired to return that real
  // structural edge (section-sibling relation) exactly as the Qdrant
  // adapter's own bounded parent_id lookup would.
  const seedChunk = chunk({ nodeId: 'seed-1', parentId: 'section-A', chunkIndex: 0, sourceFile: 'docs/guide.md' });
  const missedSibling = chunk({ nodeId: 'sibling-1', parentId: 'section-A', chunkIndex: 4, sourceFile: 'docs/guide.md', text: 'the missed evidence' });

  function buildAdapter() {
    return fakeAdapter({
      neighborsByNodeId: {
        'seed-1': [{ chunk: missedSibling, relation: 'section-sibling' }],
      },
    });
  }

  it('the missed sibling is absent from the raw seed pool (sanity check the fixture is real)', () => {
    assert.equal([seedChunk].some((c) => c.nodeId === 'sibling-1'), false);
  });

  it('is recovered as a graph-origin candidate carrying full provenance', async () => {
    const adapter = buildAdapter();
    const result = await expandSeedsWithGraph({
      adapter, collection: 'c', seeds: [seedChunk], seedLimit: 5, maxExpandedPerSeed: 3,
    });
    assert.equal(result.length, 2);
    assert.equal(result[0].chunk.nodeId, 'seed-1');
    assert.equal(result[0].retrievalOrigin, 'seed');
    const recovered = result[1];
    assert.equal(recovered.chunk.nodeId, 'sibling-1');
    assert.equal(recovered.chunk.text, 'the missed evidence');
    assert.equal(recovered.retrievalOrigin, 'graph');
    assert.equal(recovered.seedRank, 0, 'inherits its originating seed\'s rank');
    assert.deepEqual(recovered.relationPath, ['section-sibling'], 'a depth-1 candidate carries a one-hop relation sequence, not a bare scalar');
    assert.equal(recovered.depth, 1);
    assert.equal(recovered.seedId, result[0].seedId, 'attributed to the originating seed\'s own normalized identity, not just its rank');
  });

  it('the recovered candidate is a real retrieval-content chunk, never a skeleton_nav summary (no summary/children fields present)', async () => {
    const adapter = buildAdapter();
    const result = await expandSeedsWithGraph({ adapter, collection: 'c', seeds: [seedChunk], seedLimit: 5, maxExpandedPerSeed: 3 });
    const recovered = result[1].chunk;
    assert.equal('summary' in recovered, false);
    assert.equal('children' in recovered, false);
    assert.equal(typeof recovered.text, 'string');
  });
});

describe('expandSeedsWithGraph — dedup, ranking, and limits', () => {
  it('deduplicates a candidate reachable from two eligible seeds under its BEST (lowest) seed rank', async () => {
    const shared = chunk({ nodeId: 'shared-1', parentId: 'section-A', chunkIndex: 5 });
    const seedA = chunk({ nodeId: 'seed-A', parentId: 'section-A', chunkIndex: 0 });
    const seedB = chunk({ nodeId: 'seed-B', parentId: 'section-A', chunkIndex: 1 });
    const adapter = fakeAdapter({
      neighborsByNodeId: {
        'seed-A': [],
        'seed-B': [{ chunk: shared, relation: 'section-sibling' }],
      },
    });
    // seedA is rank 0 but its own neighbor list is empty; seedB (rank 1)
    // is the ONLY seed that actually reaches `shared`, so it must inherit
    // rank 1, not some artificially-better rank.
    const result = await expandSeedsWithGraph({ adapter, collection: 'c', seeds: [seedA, seedB], seedLimit: 5, maxExpandedPerSeed: 3 });
    const sharedEntry = result.find((e) => e.chunk.nodeId === 'shared-1');
    const seedBEntry = result.find((e) => e.chunk.nodeId === 'seed-B');
    assert.ok(sharedEntry);
    assert.equal(sharedEntry.seedRank, 1);
    assert.equal(result.filter((e) => e.chunk.nodeId === 'shared-1').length, 1, 'must appear exactly once, never duplicated across seeds');
    assert.equal(sharedEntry.seedId, seedBEntry.seedId, 'seedId must identify the SAME best seed (seed-B) that produced bestRank, never seed-A even though seed-A ran first');
  });

  it('a candidate that is already a seed is never re-added as a graph candidate', async () => {
    const seedA = chunk({ nodeId: 'seed-A', parentId: 'section-A', chunkIndex: 0 });
    const seedB = chunk({ nodeId: 'seed-B', parentId: 'section-A', chunkIndex: 1 });
    const adapter = fakeAdapter({
      neighborsByNodeId: {
        'seed-A': [{ chunk: seedB, relation: 'section-sibling' }],
        'seed-B': [],
      },
    });
    const result = await expandSeedsWithGraph({ adapter, collection: 'c', seeds: [seedA, seedB], seedLimit: 5, maxExpandedPerSeed: 3 });
    assert.equal(result.length, 2, 'seedB must not appear twice (once as seed, once as a graph candidate of seedA)');
  });

  it('seedLimit bounds how many top seeds are eligible for expansion — later seeds are never queried', async () => {
    const seeds = [0, 1, 2].map((i) => chunk({ nodeId: `seed-${i}`, parentId: `section-${i}`, chunkIndex: i }));
    fakeAdapter.calls = [];
    const adapter = fakeAdapter();
    await expandSeedsWithGraph({ adapter, collection: 'c', seeds, seedLimit: 2, maxExpandedPerSeed: 3 });
    assert.equal(fakeAdapter.calls.length, 2, 'only the first 2 (seedLimit) seeds may be queried for neighbors');
    assert.deepEqual(fakeAdapter.calls.map((c) => c.nodeId), ['seed-0', 'seed-1']);
  });

  it('maxExpandedPerSeed is forwarded as the per-seed limit passed to the adapter', async () => {
    fakeAdapter.calls = [];
    const adapter = fakeAdapter();
    const seed = chunk({ nodeId: 'seed-0', parentId: 'section-0' });
    await expandSeedsWithGraph({ adapter, collection: 'c', seeds: [seed], seedLimit: 5, maxExpandedPerSeed: 7 });
    assert.equal(fakeAdapter.calls[0].limit, 7);
  });

  it('seed order is always preserved; each seed\'s own graph candidates are grouped immediately after it, sorted by stable document order', async () => {
    const seed0 = chunk({ nodeId: 'seed-0', parentId: 'section-0', chunkIndex: 0, sourceFile: 'b.md' });
    const seed1 = chunk({ nodeId: 'seed-1', parentId: 'section-1', chunkIndex: 0, sourceFile: 'a.md' });
    const c0b = chunk({ nodeId: 'c0b', sourceFile: 'b.md', chunkIndex: 9 });
    const c0a = chunk({ nodeId: 'c0a', sourceFile: 'a.md', chunkIndex: 9 });
    const c1 = chunk({ nodeId: 'c1', sourceFile: 'a.md', chunkIndex: 1 });
    const adapter = fakeAdapter({
      neighborsByNodeId: {
        'seed-0': [{ chunk: c0b, relation: 'section-sibling' }, { chunk: c0a, relation: 'section-sibling' }],
        'seed-1': [{ chunk: c1, relation: 'section-sibling' }],
      },
    });
    const result = await expandSeedsWithGraph({ adapter, collection: 'c', seeds: [seed0, seed1], seedLimit: 5, maxExpandedPerSeed: 5 });
    assert.deepEqual(result.map((e) => e.chunk.nodeId), ['seed-0', 'c0a', 'c0b', 'seed-1', 'c1'], 'seed-0\'s own candidates (a.md before b.md, stable doc order) precede seed-1, which precedes seed-1\'s own candidate');
  });

  it('re-applies the caller\'s tags filter to expanded candidates — a structural neighbor lacking the queried tag is dropped', async () => {
    const seed = chunk({ nodeId: 'seed-0', parentId: 'section-0', tags: ['x'] });
    const untaggedNeighbor = chunk({ nodeId: 'n1', tags: [] });
    const taggedNeighbor = chunk({ nodeId: 'n2', tags: ['x'] });
    const adapter = fakeAdapter({
      neighborsByNodeId: {
        'seed-0': [
          { chunk: untaggedNeighbor, relation: 'section-sibling' },
          { chunk: taggedNeighbor, relation: 'section-sibling' },
        ],
      },
    });
    const result = await expandSeedsWithGraph({
      adapter, collection: 'c', seeds: [seed], seedLimit: 5, maxExpandedPerSeed: 5, filters: { tags: ['x'] },
    });
    assert.deepEqual(result.map((e) => e.chunk.nodeId), ['seed-0', 'n2']);
  });

  it('re-applies the caller\'s sourceFile filter to expanded candidates', async () => {
    const seed = chunk({ nodeId: 'seed-0', parentId: 'section-0', sourceFile: 'docs/a.md' });
    const wrongFile = chunk({ nodeId: 'n1', sourceFile: 'docs/b.md' });
    const rightFile = chunk({ nodeId: 'n2', sourceFile: 'docs/a.md' });
    const adapter = fakeAdapter({
      neighborsByNodeId: {
        'seed-0': [
          { chunk: wrongFile, relation: 'section-sibling' },
          { chunk: rightFile, relation: 'section-sibling' },
        ],
      },
    });
    const result = await expandSeedsWithGraph({
      adapter, collection: 'c', seeds: [seed], seedLimit: 5, maxExpandedPerSeed: 5, filters: { sourceFile: 'docs/a.md' },
    });
    assert.deepEqual(result.map((e) => e.chunk.nodeId), ['seed-0', 'n2']);
  });
});

describe('expandSeedsWithGraph — internal provenance completeness (design doc, "Provenance")', () => {
  it('every seed entry carries its own normalized identity as seedId and an empty relationPath (zero hops)', async () => {
    const seedA = chunk({ nodeId: 'seed-A', parentId: 'section-A', chunkIndex: 0, sourceFile: 'docs/a.md' });
    const legacySeed = chunk({ nodeId: null, sourceFile: 'docs/legacy.md', chunkIndex: 3 }); // no nodeId — falls back to sourceFile+chunkIndex
    const adapter = fakeAdapter();
    const result = await expandSeedsWithGraph({ adapter, collection: 'c', seeds: [seedA, legacySeed], seedLimit: 5, maxExpandedPerSeed: 3 });
    assert.equal(result[0].seedId, 'node:seed-A');
    assert.deepEqual(result[0].relationPath, []);
    assert.equal(result[1].seedId, 'pos:docs/legacy.md::3', 'a seed without nodeId still gets a normalized plain-data identity, never null/undefined');
    assert.deepEqual(result[1].relationPath, []);
  });

  it('a depth-1 graph entry\'s relationPath is a one-element sequence (array), not a bare scalar, and seedId is plain normalized data, never the full seed chunk object', async () => {
    const seed = chunk({ nodeId: 'seed-0', parentId: 'section-0', chunkIndex: 0 });
    const neighbor = chunk({ nodeId: 'n1', chunkIndex: 1 });
    const adapter = fakeAdapter({ neighborsByNodeId: { 'seed-0': [{ chunk: neighbor, relation: 'prev' }] } });
    const result = await expandSeedsWithGraph({ adapter, collection: 'c', seeds: [seed], seedLimit: 5, maxExpandedPerSeed: 3 });
    const graphEntry = result.find((e) => e.chunk.nodeId === 'n1');
    assert.deepEqual(graphEntry.relationPath, ['prev']);
    assert.equal(typeof graphEntry.seedId, 'string', 'seedId must be normalized plain data (a string identity key), never an object/full chunk');
    assert.equal(graphEntry.seedId, 'node:seed-0');
  });
});
