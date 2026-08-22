// Offline unit tests for the graph-expanded-retrieval live A/B benchmark's
// pure calculation/reporting logic (benchmarks/graph-expand-retrieval/metrics.js).
// No live Qdrant, no network — every case here fabricates ranked hit arrays
// and qrels entries directly, per docs/tasks/graph-expanded-retrieval-live-benchmark.md's
// "Add focused offline tests for the harness calculation/reporting logic."
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hitKey, relevantKeySet, irrelevantKeySet, recallAtK, mrrValue, ndcgAtK,
  recoveredByGraph, displacedSeeds, filterViolations, irrelevantSurfaced,
  latencyStats, sameRankedKeys, hasNoProvenanceFields, analyzeQuery,
} from '../../../benchmarks/graph-expand-retrieval/metrics.js';

function hit(overrides) {
  return { sourceFile: 'a.md', chunkIndex: 0, ...overrides };
}

describe('hitKey / relevantKeySet / irrelevantKeySet', () => {
  it('builds a stable sourceFile::chunkIndex key', () => {
    assert.equal(hitKey({ sourceFile: 'a.md', chunkIndex: 2 }), 'a.md::2');
  });

  it('relevantKeySet/irrelevantKeySet read the qrels entry shape', () => {
    const qrels = {
      relevant: [{ sourceFile: 'a.md', chunkIndex: 0 }, { sourceFile: 'a.md', chunkIndex: 1 }],
      irrelevant: [{ sourceFile: 'a.md', chunkIndex: 2 }],
    };
    assert.deepEqual([...relevantKeySet(qrels)].sort(), ['a.md::0', 'a.md::1']);
    assert.deepEqual([...irrelevantKeySet(qrels)], ['a.md::2']);
  });

  it('empty qrels entry yields empty sets, not a throw', () => {
    assert.equal(relevantKeySet({}).size, 0);
    assert.equal(irrelevantKeySet(undefined).size, 0);
  });
});

describe('recallAtK / mrrValue / ndcgAtK', () => {
  const relevant = new Set(['a.md::0', 'a.md::1']);

  it('recallAtK counts relevant items found anywhere in top-k', () => {
    const hits = [hit({ chunkIndex: 5 }), hit({ chunkIndex: 0 }), hit({ chunkIndex: 9 })];
    assert.equal(recallAtK(hits, relevant, 3), 0.5); // finds chunkIndex 0, misses chunkIndex 1
  });

  it('recallAtK only looks within the first k hits', () => {
    const hits = [hit({ chunkIndex: 9 }), hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 })];
    assert.equal(recallAtK(hits, relevant, 1), 0); // both relevant items are past k=1
  });

  it('recallAtK/mrrValue/ndcgAtK return null (n/a) for a negative query (no relevant items)', () => {
    const hits = [hit({ chunkIndex: 0 })];
    assert.equal(recallAtK(hits, new Set(), 3), null);
    assert.equal(mrrValue(hits, new Set()), null);
    assert.equal(ndcgAtK(hits, new Set(), 3), null);
  });

  it('mrrValue is the reciprocal of the first relevant hit rank (1-based)', () => {
    const hits = [hit({ chunkIndex: 9 }), hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 })];
    assert.equal(mrrValue(hits, relevant), 1 / 2);
  });

  it('mrrValue is 0 when no returned hit is relevant', () => {
    const hits = [hit({ chunkIndex: 8 }), hit({ chunkIndex: 9 })];
    assert.equal(mrrValue(hits, relevant), 0);
  });

  it('ndcgAtK is 1.0 when every relevant item is ranked ideally (best-first)', () => {
    const hits = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 }), hit({ chunkIndex: 9 })];
    assert.equal(ndcgAtK(hits, relevant, 3), 1);
  });

  it('ndcgAtK penalizes relevant items ranked lower than ideal', () => {
    const idealFirst = ndcgAtK([hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 })], relevant, 2);
    const reversed = ndcgAtK([hit({ chunkIndex: 9 }), hit({ chunkIndex: 0 })], relevant, 2);
    assert.ok(reversed < idealFirst);
  });
});

describe('recoveredByGraph', () => {
  const relevant = new Set(['a.md::0', 'a.md::1']);

  it('reports a relevant key present in B top-k but absent from A top-k', () => {
    const hitsA = [hit({ chunkIndex: 0 })]; // seed-only misses chunkIndex 1 entirely
    const hitsB = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 1, retrievalOrigin: 'graph' })];
    assert.deepEqual(recoveredByGraph(hitsA, hitsB, relevant, 2), ['a.md::1']);
  });

  it('reports nothing when A already contains every relevant item within k', () => {
    const hitsA = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 })];
    const hitsB = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 })];
    assert.deepEqual(recoveredByGraph(hitsA, hitsB, relevant, 2), []);
  });

  it('does not count a relevant item recovered by B but outside the k window', () => {
    const hitsA = [hit({ chunkIndex: 9 })];
    const hitsB = [hit({ chunkIndex: 9 }), hit({ chunkIndex: 8 }), hit({ chunkIndex: 1 })];
    assert.deepEqual(recoveredByGraph(hitsA, hitsB, relevant, 2), []); // chunkIndex 1 is rank 3, past k=2
  });
});

describe('displacedSeeds', () => {
  it('flags a direct seed present in A top-k but pushed out of B top-k by a graph candidate', () => {
    const hitsA = [
      hit({ chunkIndex: 0, retrievalOrigin: 'seed' }),
      hit({ chunkIndex: 1, retrievalOrigin: 'seed' }),
      hit({ chunkIndex: 2, retrievalOrigin: 'seed' }),
    ];
    const hitsB = [
      hit({ chunkIndex: 0, retrievalOrigin: 'seed' }),
      hit({ chunkIndex: 5, retrievalOrigin: 'graph' }), // seed 0's own graph neighbor
      hit({ chunkIndex: 1, retrievalOrigin: 'seed' }),
      // chunkIndex 2 (a real, lower-ranked seed) fell out of the top-3 window
    ];
    assert.deepEqual(displacedSeeds(hitsA, hitsB, 3), ['a.md::2']);
  });

  it('reports nothing when B has no graph-origin hit within k (no attributable cause)', () => {
    const hitsA = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 }), hit({ chunkIndex: 2 })];
    const hitsB = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 })]; // fewer hits, but no graph-origin
    assert.deepEqual(displacedSeeds(hitsA, hitsB, 3), []);
  });

  it('reports nothing when every A seed is still present in B', () => {
    const hitsA = [hit({ chunkIndex: 0, retrievalOrigin: 'seed' }), hit({ chunkIndex: 1, retrievalOrigin: 'seed' })];
    const hitsB = [
      hit({ chunkIndex: 0, retrievalOrigin: 'seed' }),
      hit({ chunkIndex: 1, retrievalOrigin: 'seed' }),
      hit({ chunkIndex: 9, retrievalOrigin: 'graph' }),
    ];
    assert.deepEqual(displacedSeeds(hitsA, hitsB, 3), []);
  });
});

describe('filterViolations', () => {
  it('flags a hit whose sourceFile disagrees with the query filter', () => {
    const hits = [hit({ sourceFile: 'a.md' }), hit({ sourceFile: 'b.md', chunkIndex: 1 })];
    const violations = filterViolations(hits, { sourceFile: 'a.md' });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].key, 'b.md::1');
  });

  it('flags a hit with none of the required tags', () => {
    const hits = [hit({ tags: ['x'] }), hit({ chunkIndex: 1, tags: ['y'] })];
    const violations = filterViolations(hits, { tags: ['x'] });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].key, 'a.md::1');
  });

  it('no filters means no violations regardless of content', () => {
    const hits = [hit({ sourceFile: 'anything.md' })];
    assert.deepEqual(filterViolations(hits, {}), []);
    assert.deepEqual(filterViolations(hits, undefined), []);
  });
});

describe('irrelevantSurfaced', () => {
  it('reports a known-irrelevant key that made it into top-k', () => {
    const hits = [hit({ chunkIndex: 2 }), hit({ chunkIndex: 0 })];
    const irrelevant = new Set(['a.md::2']);
    assert.deepEqual(irrelevantSurfaced(hits, irrelevant, 2), ['a.md::2']);
  });

  it('respects the k window', () => {
    const hits = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 2 })];
    const irrelevant = new Set(['a.md::2']);
    assert.deepEqual(irrelevantSurfaced(hits, irrelevant, 1), []);
  });
});

describe('latencyStats', () => {
  it('computes median/p95/min/max over repeated samples', () => {
    const stats = latencyStats([10, 20, 30, 40, 50]);
    assert.equal(stats.medianMs, 30);
    assert.equal(stats.minMs, 10);
    assert.equal(stats.maxMs, 50);
    assert.equal(stats.n, 5);
    assert.ok(stats.p95Ms >= stats.medianMs);
  });

  it('handles a single sample without throwing', () => {
    const stats = latencyStats([42]);
    assert.equal(stats.medianMs, 42);
    assert.equal(stats.p95Ms, 42);
  });

  it('handles an empty array without throwing', () => {
    const stats = latencyStats([]);
    assert.equal(stats.medianMs, 0);
    assert.equal(stats.n, 0);
  });
});

describe('sameRankedKeys', () => {
  it('true for identical ranked key sequences', () => {
    const a = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 })];
    const b = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 })];
    assert.equal(sameRankedKeys(a, b), true);
  });

  it('false when order differs', () => {
    const a = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 })];
    const b = [hit({ chunkIndex: 1 }), hit({ chunkIndex: 0 })];
    assert.equal(sameRankedKeys(a, b), false);
  });

  it('false when lengths differ', () => {
    const a = [hit({ chunkIndex: 0 })];
    const b = [hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 })];
    assert.equal(sameRankedKeys(a, b), false);
  });
});

describe('hasNoProvenanceFields', () => {
  it('true for plain hits with no provenance fields at all', () => {
    assert.equal(hasNoProvenanceFields([hit({}), hit({ chunkIndex: 1 })]), true);
  });

  it('false when any hit carries a retrievalOrigin field', () => {
    assert.equal(hasNoProvenanceFields([hit({ retrievalOrigin: 'seed' })]), false);
  });

  it('false when any hit carries any of the other provenance fields', () => {
    assert.equal(hasNoProvenanceFields([hit({ graphDepth: 0 })]), false);
    assert.equal(hasNoProvenanceFields([hit({ graphSeedRank: 0 })]), false);
    assert.equal(hasNoProvenanceFields([hit({ graphSeedId: 'x' })]), false);
    assert.equal(hasNoProvenanceFields([hit({ graphRelationPath: [] })]), false);
  });
});

describe('analyzeQuery', () => {
  it('bundles every metric for a positive query with a recovered candidate and a displaced seed', () => {
    const qrelsEntry = {
      relevant: [{ sourceFile: 'a.md', chunkIndex: 0 }, { sourceFile: 'a.md', chunkIndex: 1 }],
      irrelevant: [{ sourceFile: 'a.md', chunkIndex: 2 }],
    };
    const hitsA = [
      hit({ chunkIndex: 0, retrievalOrigin: undefined }),
      hit({ chunkIndex: 2, retrievalOrigin: undefined }),
      hit({ chunkIndex: 3, retrievalOrigin: undefined }),
    ];
    const hitsB = [
      hit({ chunkIndex: 0, retrievalOrigin: 'seed' }),
      hit({ chunkIndex: 1, retrievalOrigin: 'graph' }),
      hit({ chunkIndex: 2, retrievalOrigin: undefined }),
    ];
    const result = analyzeQuery({ queryId: 'qX', hitsA, hitsB, qrelsEntry, filters: {}, k: 3 });

    assert.equal(result.queryId, 'qX');
    assert.equal(result.isNegative, false);
    assert.equal(result.modeA.recallAtK, 0.5);
    assert.equal(result.modeB.recallAtK, 1);
    assert.deepEqual(result.recoveredByGraph, ['a.md::1']);
    assert.deepEqual(result.displacedSeeds, ['a.md::3']);
    assert.deepEqual(result.modeA.irrelevantSurfaced, ['a.md::2']);
    assert.equal(result.modeB.graphOriginCount, 1);
  });

  it('marks a qrels entry with negative:true as isNegative', () => {
    const result = analyzeQuery({
      queryId: 'qNeg', hitsA: [hit({})], hitsB: [hit({})],
      qrelsEntry: { relevant: [], irrelevant: [], negative: true }, filters: {}, k: 3,
    });
    assert.equal(result.isNegative, true);
    assert.equal(result.modeA.recallAtK, null);
  });
});
