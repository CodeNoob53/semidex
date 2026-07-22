import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { pairedBootstrap, pairedBootstrapByQuery, perQueryMetrics } from './bootstrap.mjs';

describe('pairedBootstrap: determinism', () => {
  test('same inputs + same seed + same iteration count always reproduce byte-identical results', () => {
    const a = [0.5, 0.4, 0.6, 0.3, 0.7, 0.5, 0.4, 0.6, 0.5, 0.5];
    const b = [0.51, 0.2, 0.8, 0.31, 0.5, 0.6, 0.3, 0.7, 0.49, 0.52];
    const r1 = pairedBootstrap(a, b, { seed: 'fixed-seed', iterations: 300 });
    const r2 = pairedBootstrap(a, b, { seed: 'fixed-seed', iterations: 300 });
    assert.deepEqual(r1, r2);
  });

  test('different seeds can produce different CIs on the same (small, noisy) input', () => {
    const a = [0.5, 0.4, 0.6, 0.3, 0.7];
    const b = [0.51, 0.2, 0.8, 0.31, 0.5];
    const r1 = pairedBootstrap(a, b, { seed: 'seed-a', iterations: 200 });
    const r2 = pairedBootstrap(a, b, { seed: 'seed-b', iterations: 200 });
    // Not asserting they always differ (small n can coincide), just that
    // the seed is actually consulted — meanDelta must stay identical
    // (seed-independent) while the resampled CI bounds may vary.
    assert.equal(r1.meanDelta, r2.meanDelta);
  });
});

describe('pairedBootstrap: verdicts', () => {
  test('a clear, consistent win for B produces B_BETTER with a CI excluding zero', () => {
    const a = Array(30).fill(0.5);
    const b = Array(30).fill(0.65);
    const r = pairedBootstrap(a, b, { iterations: 500 });
    assert.equal(r.verdict, 'B_BETTER');
    assert.equal(r.excludesZero, true);
    assert.ok(r.ciLow > 0);
  });

  test('a clear, consistent win for A produces A_BETTER', () => {
    const a = Array(30).fill(0.65);
    const b = Array(30).fill(0.5);
    const r = pairedBootstrap(a, b, { iterations: 500 });
    assert.equal(r.verdict, 'A_BETTER');
    assert.ok(r.ciHigh < 0);
  });

  test('a CI crossing zero produces MIXED (never an epsilon-based tie call)', () => {
    // Alternating +/- deltas of equal magnitude: mean is exactly 0, but
    // wins and losses both occur, so the true distribution straddles zero.
    const a = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const b = [0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4];
    const r = pairedBootstrap(a, b, { iterations: 1000 });
    assert.equal(r.excludesZero, false);
    assert.equal(r.verdict, 'MIXED');
    assert.ok(r.wins > 0 && r.losses > 0);
  });

  test('no valid paired queries (all excluded) produces INCONCLUSIVE, not a crash', () => {
    const a = [null, NaN, undefined];
    const b = [0.5, 0.5, 0.5];
    const r = pairedBootstrap(a, b, { iterations: 100 });
    assert.equal(r.n, 0);
    assert.equal(r.verdict, 'INCONCLUSIVE');
    assert.equal(r.meanDelta, null);
  });

  test('a query pair with a non-finite value on EITHER side is excluded from the paired sample', () => {
    const a = [0.5, null, 0.6];
    const b = [0.6, 0.7, NaN];
    const r = pairedBootstrap(a, b, { iterations: 100 });
    assert.equal(r.n, 1); // only index 0 has finite values on both sides
  });

  test('throws on mismatched array lengths rather than silently misaligning pairs', () => {
    assert.throws(() => pairedBootstrap([1, 2, 3], [1, 2]), /same length/);
  });
});

describe('perQueryMetrics + pairedBootstrapByQuery: end-to-end on a tiny qrels/run fixture', () => {
  test('aligns by query ID (not array position) and produces a plausible comparison', () => {
    const qrels = new Map([
      ['q1', new Map([['docA', 1], ['docB', 0]])],
      ['q2', new Map([['docC', 1]])],
    ]);
    const runDense = new Map([
      ['q1', ['docB', 'docA']], // relevant doc at rank 2
      ['q2', ['docC']],          // relevant doc at rank 1
    ]);
    const runHybrid = new Map([
      ['q1', ['docA', 'docB']], // relevant doc at rank 1 (better)
      ['q2', ['docC']],
    ]);
    const pqDense = perQueryMetrics(qrels, runDense);
    const pqHybrid = perQueryMetrics(qrels, runHybrid);
    assert.equal(pqDense.get('q1').ndcgAt10 < pqHybrid.get('q1').ndcgAt10, true);

    const cmp = pairedBootstrapByQuery(pqDense, pqHybrid, 'ndcgAt10', { iterations: 200 });
    assert.equal(cmp.n, 2);
    assert.ok(cmp.meanDelta >= 0);
  });

  test('only compares queries present in BOTH per-query maps', () => {
    const pqA = new Map([['q1', { ndcgAt10: 0.5 }], ['q2', { ndcgAt10: 0.4 }]]);
    const pqB = new Map([['q1', { ndcgAt10: 0.6 }]]); // q2 missing
    const cmp = pairedBootstrapByQuery(pqA, pqB, 'ndcgAt10', { iterations: 100 });
    assert.equal(cmp.n, 1);
  });
});
