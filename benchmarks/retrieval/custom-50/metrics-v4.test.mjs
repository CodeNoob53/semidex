// Hand-built tiny fixtures that pin every v4 metric's formula (audit
// 2026-09-06, P2: "Ручні маленькі fixtures підтверджують Hit/Recall/nDCG
// і multi-evidence metrics"). Every expected number is computed by hand in
// the comment above the assertion.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resultChunkId, hitAtK, recallAtK, requiredEvidenceCoverageAtK,
  gradedNdcgAtK, mrrAtK, negativeTokenAbsenceAtRank1, chunkRecallAtK,
} from './metrics-v4.mjs';

// A ranked result list: rank 1 = index 0. Uses the flat Chunk shape.
function r(sourceFile, chunkIndex, extra = {}) {
  return { sourceFile, chunkIndex, ...extra };
}
function qrels(pairs) {
  return new Map(pairs);
}

describe('resultChunkId', () => {
  it('reads the flat Chunk shape', () => {
    assert.equal(resultChunkId({ sourceFile: 'a.md', chunkIndex: 3 }), 'a.md#3');
  });
  it('reads the raw Qdrant point shape', () => {
    assert.equal(resultChunkId({ payload: { source_file: 'a.md', chunk_index: 0 } }), 'a.md#0');
  });
  it('null when either part is missing', () => {
    assert.equal(resultChunkId({ sourceFile: 'a.md' }), null);
  });
});

describe('hitAtK (a.k.a. chunkRecall@K) — at least one rel>=3 chunk in top K', () => {
  // ranking: [b#1, a#3, a#7, c#0]; relevant (rel3) = {a#3}
  const ranking = [r('b', 1), r('a', 3), r('a', 7), r('c', 0)];
  const q = qrels([['a#3', 3], ['a#7', 2]]);

  it('Hit@1 is false — a#3 is at rank 2', () => {
    assert.equal(hitAtK(ranking, q, 1), false);
  });
  it('Hit@2 is true — a#3 is within the top 2', () => {
    assert.equal(hitAtK(ranking, q, 2), true);
  });
  it('minRel=2 lets the rel-2 chunk count: Hit@3 true (a#7 at rank 3)', () => {
    assert.equal(hitAtK([r('x', 0), r('y', 0), r('a', 7)], q, 3, 2), true);
  });
  it('null when the query has no qrel at the requested grade', () => {
    assert.equal(hitAtK(ranking, qrels([['a#3', 2]]), 5, 3), null);
  });
  it('chunkRecallAtK is the exact same function (v3 alias)', () => {
    assert.equal(chunkRecallAtK, hitAtK);
  });
});

describe('recallAtK — fraction of ALL rel>=3 chunks retrieved', () => {
  // relevant (rel3) = {a#1, a#2, a#3}; ranking top-3 = [a#1, b#0, a#3]
  const ranking = [r('a', 1), r('b', 0), r('a', 3), r('a', 2)];
  const q = qrels([['a#1', 3], ['a#2', 3], ['a#3', 3]]);

  it('Recall@3 = 2/3 (a#1 and a#3 in top 3, a#2 not)', () => {
    assert.equal(recallAtK(ranking, q, 3), 2 / 3);
  });
  it('Recall@4 = 1 (all three in top 4)', () => {
    assert.equal(recallAtK(ranking, q, 4), 1);
  });
  it('for a single-relevant query, Recall@K equals Hit@K (0 or 1)', () => {
    const single = qrels([['a#3', 3]]);
    assert.equal(recallAtK(ranking, single, 3), 1);
    assert.equal(recallAtK([r('z', 0)], single, 3), 0);
    assert.equal(hitAtK([r('z', 0)], single, 3), false);
  });
});

describe('requiredEvidenceCoverageAtK — every group must have one member in top K', () => {
  // groups: [[a#4], [b#1, b#2]]  (a#4 required; either b#1 or b#2 required)
  const groups = [['a#4'], ['b#1', 'b#2']];

  it('true when a#4 and b#2 are both in the top K', () => {
    const ranking = [r('a', 4), r('x', 0), r('b', 2)];
    assert.equal(requiredEvidenceCoverageAtK(ranking, groups, 3), true);
  });
  it('false when only a#4 is present (the b-group is unsatisfied)', () => {
    const ranking = [r('a', 4), r('x', 0), r('y', 0)];
    assert.equal(requiredEvidenceCoverageAtK(ranking, groups, 3), false);
  });
  it('false when a lucky b#1 is in but a#4 is not — Hit@K would be true here, coverage is not', () => {
    const ranking = [r('b', 1), r('x', 0), r('y', 0)];
    assert.equal(requiredEvidenceCoverageAtK(ranking, groups, 3), false);
  });
  it('null when the query declares no requiredEvidence', () => {
    assert.equal(requiredEvidenceCoverageAtK([r('a', 4)], [], 3), null);
    assert.equal(requiredEvidenceCoverageAtK([r('a', 4)], undefined, 3), null);
  });
});

describe('gradedNdcgAtK — gain = 2^rel - 1, discount = 1/log2(rank+1)', () => {
  it('perfect ranking scores 1', () => {
    // qrels a#0:3, a#1:2 ; ranking [a#0, a#1]
    const q = qrels([['a#0', 3], ['a#1', 2]]);
    assert.equal(gradedNdcgAtK([r('a', 0), r('a', 1)], q, 5), 1);
  });
  it('swapped top-2 scores below 1, by the exact hand-computed value', () => {
    // qrels a#0:3 (gain 7), a#1:1 (gain 1)
    // ranking [a#1, a#0]: DCG = 1/log2(2) + 7/log2(3) = 1 + 4.416508 = 5.416508
    // IDCG = 7/log2(2) + 1/log2(3) = 7 + 0.630930 = 7.630930
    // nDCG = 5.416508 / 7.630930 = 0.7098097...
    const q = qrels([['a#0', 3], ['a#1', 1]]);
    const got = gradedNdcgAtK([r('a', 1), r('a', 0)], q, 5);
    assert.ok(Math.abs(got - 0.7098097) < 1e-6, `expected ~0.7098097, got ${got}`);
  });
  it('a non-relevant chunk at rank 1 pushes nDCG down', () => {
    // qrels a#0:3 ; ranking [z#9, a#0]
    // DCG = 0 + 7/log2(3) = 4.41627 ; IDCG = 7 ; nDCG = 0.630930
    const q = qrels([['a#0', 3]]);
    const got = gradedNdcgAtK([r('z', 9), r('a', 0)], q, 5);
    assert.ok(Math.abs(got - 0.630930) < 1e-5, `expected ~0.630930, got ${got}`);
  });
  it('null when the query has no qrels', () => {
    assert.equal(gradedNdcgAtK([r('a', 0)], new Map(), 5), null);
  });
});

describe('mrrAtK', () => {
  const q = qrels([['a#3', 3]]);
  it('first rel-3 chunk at rank 3 -> 1/3', () => {
    assert.equal(mrrAtK([r('x', 0), r('y', 0), r('a', 3)], q, 10), 1 / 3);
  });
  it('no rel-3 chunk in top K -> 0', () => {
    assert.equal(mrrAtK([r('x', 0), r('y', 0)], q, 10), 0);
  });
});

describe('negativeTokenAbsenceAtRank1 — token-absence, NOT abstention quality', () => {
  it('true when rank-1 text/section contains none of the absent tokens', () => {
    const ranking = [{ text: 'Qdrant hybrid search with RRF fusion', section: 'Hybrid Search' }];
    assert.equal(negativeTokenAbsenceAtRank1(ranking, ['postgres', 'connection pool']), true);
  });
  it('false when rank-1 contains an absent token (case-insensitive)', () => {
    const ranking = [{ text: 'semidex uses a PostgreSQL connection pool', section: 'DB' }];
    assert.equal(negativeTokenAbsenceAtRank1(ranking, ['postgresql']), false);
  });
  it('true (vacuously) on a genuinely empty result list', () => {
    assert.equal(negativeTokenAbsenceAtRank1([], ['postgres']), true);
  });
  it('null when no tokens supplied', () => {
    assert.equal(negativeTokenAbsenceAtRank1([{ text: 'x' }], []), null);
  });
});
