// Targeted unit test for metrics.mjs, verified against a small
// hand-calculated fixture (fixtures/metrics-small.json) — the expected
// values there were computed independently by hand, not derived from this
// module, so a passing test is real, non-circular verification of the
// nDCG/MAP/Recall/Precision/MRR implementations.
//
// Run in isolation (per the task's own verification instructions):
//   node --test --test-concurrency=1 benchmarks/external/beir/metrics.test.mjs
// This file is intentionally NOT under tests/unit/ — it is not part of the
// main `npm test` suite; it is the harness's own targeted metric check.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ndcgAtK, recallAtK, precisionAtK, averagePrecisionAtK, reciprocalRankAtK,
  computeMetrics, parseQrelsTsv, toTrecRunFormat,
} from './metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/metrics-small.json'), 'utf-8'));

function toQrelsMap(obj) {
  const m = new Map();
  for (const [qid, docs] of Object.entries(obj)) m.set(qid, new Map(Object.entries(docs)));
  return m;
}
function toRunMap(obj) {
  const m = new Map();
  for (const [qid, docs] of Object.entries(obj)) m.set(qid, docs);
  return m;
}

const qrels = toQrelsMap(fixture.qrels);
const run = toRunMap(fixture.run);

describe('metrics.mjs — per-query, against hand-calculated fixture', () => {
  for (const [qid, expected] of Object.entries(fixture.expectedPerQuery)) {
    test(`${qid}: nDCG@10, Recall@10, Precision@10, MRR@10, AP@100 match hand calculation`, () => {
      const qr = qrels.get(qid);
      const ranked = run.get(qid);
      assert.ok(Math.abs(ndcgAtK(qr, ranked, 10) - expected.ndcgAt10) < 1e-9, 'ndcgAt10');
      assert.ok(Math.abs(recallAtK(qr, ranked, 10) - expected.recallAt10) < 1e-9, 'recallAt10');
      assert.ok(Math.abs(precisionAtK(qr, ranked, 10) - expected.precisionAt10) < 1e-9, 'precisionAt10');
      assert.ok(Math.abs(reciprocalRankAtK(qr, ranked, 10) - expected.mrrAt10) < 1e-9, 'mrrAt10');
      assert.ok(Math.abs(averagePrecisionAtK(qr, ranked, 100) - expected.apAt100) < 1e-9, 'apAt100');
    });
  }
});

describe('metrics.mjs — computeMetrics aggregate, against hand-calculated fixture', () => {
  test('averages across both queries match hand calculation', () => {
    const agg = computeMetrics(qrels, run);
    const exp = fixture.expectedAggregate;
    assert.equal(agg.queryCount, exp.queryCount);
    assert.ok(Math.abs(agg.ndcgAt10 - exp.ndcgAt10) < 1e-9, 'ndcgAt10');
    assert.ok(Math.abs(agg.mapAt100 - exp.mapAt100) < 1e-9, 'mapAt100');
    assert.ok(Math.abs(agg.recallAt10 - exp.recallAt10) < 1e-9, 'recallAt10');
    assert.ok(Math.abs(agg.precisionAt10 - exp.precisionAt10) < 1e-9, 'precisionAt10');
    assert.ok(Math.abs(agg.mrrAt10 - exp.mrrAt10) < 1e-9, 'mrrAt10');
  });
});

describe('metrics.mjs — edge cases', () => {
  test('a query with zero relevant docs in qrels returns null for Recall/AP, not zero or NaN', () => {
    const qr = new Map(); // no relevant docs at all for this query
    assert.equal(recallAtK(qr, ['a', 'b'], 10), null);
    assert.equal(averagePrecisionAtK(qr, ['a', 'b'], 100), null);
    // nDCG/Precision/MRR are still well-defined (0) for an unjudged/empty-qrels query.
    assert.equal(ndcgAtK(qr, ['a', 'b'], 10), 0);
    assert.equal(precisionAtK(qr, ['a', 'b'], 10), 0);
    assert.equal(reciprocalRankAtK(qr, ['a', 'b'], 10), 0);
  });

  test('a doc in the run but absent from qrels is treated as non-relevant, not an error', () => {
    const qr = new Map([['d1', 1]]);
    // 'unjudged' is not in qrels at all — it must count as non-relevant, not
    // throw and not silently match. precisionAtK's denominator is k (10),
    // not the run length, so 1 hit out of the top-10 slice is 1/10 = 0.1.
    assert.equal(precisionAtK(qr, ['unjudged', 'd1'], 10), 0.1);
    // 'd1' is the first (and only) relevant doc, at rank 2 -> RR = 1/2.
    assert.equal(reciprocalRankAtK(qr, ['unjudged', 'd1'], 10), 0.5);
  });

  test('nDCG@k caps at k even when more relevant docs exist beyond the cutoff', () => {
    const qr = new Map([['a', 1], ['b', 1], ['c', 1]]);
    const ranked = ['a', 'x', 'b', 'y', 'c']; // 3 relevant, but k=1 only sees rank-1 hit
    const ndcg1 = ndcgAtK(qr, ranked, 1);
    // Only 'a' (relevant) is visible within k=1; IDCG@1 = 1/log2(2) = 1; DCG@1 = 1/log2(2) = 1.
    assert.ok(Math.abs(ndcg1 - 1) < 1e-9);
  });

  test('recallAtK never exceeds 1 even if k is larger than the corpus', () => {
    const qr = new Map([['a', 1]]);
    assert.equal(recallAtK(qr, ['a'], 1000), 1);
  });

  test('empty run for a query yields 0 for nDCG/Precision/MRR and 0 for Recall/AP (not null, since qrels has relevant docs)', () => {
    const qr = new Map([['a', 1]]);
    assert.equal(ndcgAtK(qr, [], 10), 0);
    assert.equal(precisionAtK(qr, [], 10), 0);
    assert.equal(reciprocalRankAtK(qr, [], 10), 0);
    assert.equal(recallAtK(qr, [], 10), 0);
    assert.equal(averagePrecisionAtK(qr, [], 100), 0);
  });
});

describe('parseQrelsTsv', () => {
  test('parses BEIR-format qrels TSV, skips the header row', () => {
    const tsv = 'query-id\tcorpus-id\tscore\nq1\td1\t1\nq1\td2\t0\nq2\td3\t1\n';
    const parsed = parseQrelsTsv(tsv);
    assert.equal(parsed.size, 2);
    assert.equal(parsed.get('q1').get('d1'), 1);
    assert.equal(parsed.get('q1').get('d2'), 0);
    assert.equal(parsed.get('q2').get('d3'), 1);
  });

  test('skips blank lines and malformed rows without throwing', () => {
    const tsv = 'query-id\tcorpus-id\tscore\nq1\td1\t1\n\n   \nq2\tbad-row-no-score\n';
    const parsed = parseQrelsTsv(tsv);
    assert.equal(parsed.get('q1').get('d1'), 1);
    assert.equal(parsed.has('q2'), false);
  });
});

describe('toTrecRunFormat', () => {
  test('produces standard 6-column TREC run lines: query Q0 doc rank score tag', () => {
    const scoredRun = new Map([
      ['q1', [{ docId: 'd1', score: 0.9 }, { docId: 'd2', score: 0.5 }]],
    ]);
    const text = toTrecRunFormat(scoredRun, 'my-run-tag');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'q1\tQ0\td1\t1\t0.9\tmy-run-tag');
    assert.equal(lines[1], 'q1\tQ0\td2\t2\t0.5\tmy-run-tag');
  });
});
