import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadTrecRunAsRanked, validateTrecRun, assertMetricParity, strictCheckRawTrecLines,
  computeDenseSparseOverlap, computeRelevantOverlap, classifyRescueHarm, computeOracleMaxNdcg,
  analyzeScope, buildAllScopes, loadReportedMetricsByScope, pickRepresentativeCases, computeOverallVerdict,
} from './analyze-fusion.mjs';
import { parseTrecRun } from '../beir/build-rrf-mini-set.mjs';

// ── fixtures ────────────────────────────────────────────────────────────

function trecText(rows) {
  // rows: [qid, docId, rank, score]
  return rows.map(([qid, docId, rank, score]) => `${qid}\tQ0\t${docId}\t${rank}\t${score}\trun-tag`).join('\n') + '\n';
}

function qrelsMap(spec) {
  // spec: { qid: { docId: relevance, ... }, ... }
  const m = new Map();
  for (const [qid, docs] of Object.entries(spec)) {
    m.set(qid, new Map(Object.entries(docs)));
  }
  return m;
}

// ── strict TREC validation ──────────────────────────────────────────────

describe('validateTrecRun: strict structural checks', () => {
  test('accepts a well-formed run whose query set matches the expected contract exactly', () => {
    const byQuery = parseTrecRun(trecText([['q1', 'd1', 1, 0.9], ['q1', 'd2', 2, 0.8], ['q2', 'd3', 1, 0.7]]));
    assert.doesNotThrow(() => validateTrecRun(byQuery, { expectedQueryIds: ['q1', 'q2'], label: 'test' }));
  });

  test('rejects a run missing an expected query', () => {
    const byQuery = parseTrecRun(trecText([['q1', 'd1', 1, 0.9]]));
    assert.throws(() => validateTrecRun(byQuery, { expectedQueryIds: ['q1', 'q2'], label: 'test' }), /missing query q2/);
  });

  test('rejects a run with an unexpected extra query not in the benchmark contract', () => {
    const byQuery = parseTrecRun(trecText([['q1', 'd1', 1, 0.9], ['q99', 'd2', 1, 0.5]]));
    assert.throws(() => validateTrecRun(byQuery, { expectedQueryIds: ['q1'], label: 'test' }), /unexpected query q99/);
  });

  test('rejects a duplicate rank within one query (rank corruption)', () => {
    const byQuery = parseTrecRun(trecText([['q1', 'd1', 1, 0.9], ['q1', 'd2', 1, 0.8]]));
    assert.throws(() => validateTrecRun(byQuery, { expectedQueryIds: ['q1'], label: 'test' }), /duplicate rank 1/);
  });

  test('rejects a duplicate doc ID within one query', () => {
    const byQuery = parseTrecRun(trecText([['q1', 'd1', 1, 0.9], ['q1', 'd1', 2, 0.8]]));
    assert.throws(() => validateTrecRun(byQuery, { expectedQueryIds: ['q1'], label: 'test' }), /duplicate doc ID d1/);
  });

  test('rejects a non-positive rank', () => {
    const byQuery = new Map([['q1', [{ docId: 'd1', rank: 0 }]]]);
    assert.throws(() => validateTrecRun(byQuery, { expectedQueryIds: ['q1'], label: 'test' }), /non-positive or non-integer rank/);
  });

  test('rejects a non-integer rank', () => {
    const byQuery = new Map([['q1', [{ docId: 'd1', rank: 1.5 }]]]);
    assert.throws(() => validateTrecRun(byQuery, { expectedQueryIds: ['q1'], label: 'test' }), /non-positive or non-integer rank/);
  });

  test('reports every problem at once, not just the first (actionable multi-error message)', () => {
    const byQuery = parseTrecRun(trecText([['q1', 'd1', 1, 0.9], ['q1', 'd1', 1, 0.9]]));
    try {
      validateTrecRun(byQuery, { expectedQueryIds: ['q1'], label: 'test' });
      assert.fail('expected validateTrecRun to throw');
    } catch (err) {
      assert.match(err.message, /duplicate rank/);
      assert.match(err.message, /duplicate doc ID/);
    }
  });
});

describe('loadTrecRunAsRanked', () => {
  test('throws a clear error for a missing file rather than silently returning an empty run', () => {
    assert.throws(() => loadTrecRunAsRanked('/nonexistent/path/does-not-exist.trec'), /expected TREC run file missing/);
  });
});

// ── strict raw-line pre-check (P2 regression test) ────────────────────────
// parseTrecRun() (build-rrf-mini-set.mjs) silently skips any non-blank
// line with fewer than 6 fields — reasonable for the benchmark runners it
// was written for, but wrong for a diagnostic tool: a truncated/corrupted
// row would otherwise vanish before validateTrecRun() ever sees it, so a
// "strict" validation pass could hide real data loss. strictCheckRawTrecLines()
// / loadTrecRunAsRanked() must catch this BEFORE parseTrecRun() runs.

describe('strictCheckRawTrecLines: catches rows parseTrecRun() would silently drop', () => {
  test('accepts a well-formed 6-field TREC file', () => {
    assert.doesNotThrow(() => strictCheckRawTrecLines(trecText([['q1', 'd1', 1, 0.9]]), 'x'));
  });

  test('throws on a truncated row with fewer than 6 fields (the exact row parseTrecRun() would silently skip)', () => {
    const text = 'q1\tQ0\td1\t1\t0.9\trun-tag\nq1\tQ0\td2\t2\n'; // second row missing score+runtag
    // Sanity: confirm parseTrecRun() really does silently drop the
    // truncated row (proving the pre-check is catching a REAL gap, not a
    // hypothetical one).
    const silentlyParsed = parseTrecRun(text);
    assert.equal(silentlyParsed.get('q1').length, 1, 'parseTrecRun() should have silently dropped the truncated row');

    assert.throws(() => strictCheckRawTrecLines(text, 'my-label'), /malformed TREC line in my-label at line 2/);
  });

  test('throws on a row with extra fields (7 instead of 6)', () => {
    const text = 'q1\tQ0\td1\t1\t0.9\trun-tag\textra-field\n';
    assert.throws(() => strictCheckRawTrecLines(text, 'x'), /expected 6 whitespace-separated fields/);
  });

  test('ignores genuinely blank lines (trailing newline, blank line between rows)', () => {
    const text = 'q1\tQ0\td1\t1\t0.9\trun-tag\n\nq1\tQ0\td2\t2\t0.8\trun-tag\n';
    assert.doesNotThrow(() => strictCheckRawTrecLines(text, 'x'));
  });

  test('reports the correct 1-based line number for the malformed row', () => {
    const text = 'q1\tQ0\td1\t1\t0.9\trun-tag\nq1\tQ0\td2\t2\t0.8\trun-tag\nbroken-row\n';
    assert.throws(() => strictCheckRawTrecLines(text, 'x'), /at line 3/);
  });
});

describe('loadTrecRunAsRanked: rejects a real file with a malformed row instead of silently under-loading it', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fusion-trec-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('throws when the file on disk contains a truncated TREC row', () => {
    const path = join(dir, 'corrupt.trec');
    writeFileSync(path, 'q1\tQ0\td1\t1\t0.9\trun-tag\nq1\tQ0\td2\t2\n', 'utf-8'); // second row truncated
    assert.throws(() => loadTrecRunAsRanked(path), /malformed TREC line/);
  });

  test('loads successfully when every row on disk is well-formed', () => {
    const path = join(dir, 'ok.trec');
    writeFileSync(path, trecText([['q1', 'd1', 1, 0.9], ['q1', 'd2', 2, 0.8]]), 'utf-8');
    const { ranked } = loadTrecRunAsRanked(path);
    assert.deepEqual(ranked.get('q1'), ['d1', 'd2']);
  });
});

// ── metric parity ────────────────────────────────────────────────────────

describe('assertMetricParity', () => {
  test('passes silently within tolerance', () => {
    const recomputed = { ndcgAt10: 0.638008622054435, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    const reported = { ...recomputed };
    assert.doesNotThrow(() => assertMetricParity(recomputed, reported, { label: 'x' }));
  });

  test('fails when a field differs beyond the strict tolerance', () => {
    const recomputed = { ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    const reported = { ...recomputed, ndcgAt10: 0.51 };
    assert.throws(() => assertMetricParity(recomputed, reported, { label: 'x' }), /metric parity check failed/);
  });

  test('a difference within a looser explicit tolerance passes', () => {
    const recomputed = { ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    const reported = { ...recomputed, ndcgAt10: 0.5001 };
    assert.doesNotThrow(() => assertMetricParity(recomputed, reported, { label: 'x', tolerance: 1e-3 }));
  });

  test('treats null vs null as matching (both undefined for a zero-relevant query)', () => {
    const recomputed = { ndcgAt10: 0, mapAt100: null, recallAt10: null, recallAt100: null, precisionAt10: 0, mrrAt10: 0 };
    const reported = { ...recomputed };
    assert.doesNotThrow(() => assertMetricParity(recomputed, reported, { label: 'x' }));
  });

  test('flags null vs a real number as a mismatch', () => {
    const recomputed = { ndcgAt10: 0.5, mapAt100: null, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    const reported = { ...recomputed, mapAt100: 0.3 };
    assert.throws(() => assertMetricParity(recomputed, reported, { label: 'x' }), /mapAt100/);
  });

  test('is skipped (not failed) when no reported metrics are supplied', () => {
    const result = assertMetricParity({ ndcgAt10: 0.9 }, undefined, { label: 'x' });
    assert.equal(result.skipped, true);
  });
});

// ── overlap calculations ─────────────────────────────────────────────────

describe('computeDenseSparseOverlap', () => {
  test('full overlap when dense and sparse return the identical ranked list', () => {
    const dense = new Map([['q1', ['d1', 'd2', 'd3']]]);
    const sparse = new Map([['q1', ['d1', 'd2', 'd3']]]);
    const { top10OverlapMean, top100OverlapMean } = computeDenseSparseOverlap(['q1'], dense, sparse);
    assert.equal(top10OverlapMean, 1);
    assert.equal(top100OverlapMean, 1);
  });

  test('zero overlap when dense and sparse share no documents', () => {
    const dense = new Map([['q1', ['d1', 'd2']]]);
    const sparse = new Map([['q1', ['d3', 'd4']]]);
    const { top10OverlapMean } = computeDenseSparseOverlap(['q1'], dense, sparse);
    assert.equal(top10OverlapMean, 0);
  });

  test('partial overlap is computed correctly', () => {
    const dense = new Map([['q1', ['d1', 'd2']]]);
    const sparse = new Map([['q1', ['d1', 'd3']]]);
    const { top10OverlapMean } = computeDenseSparseOverlap(['q1'], dense, sparse);
    assert.equal(top10OverlapMean, 0.5); // 1 shared / min(2,2)
  });

  test('averages correctly across multiple queries', () => {
    const dense = new Map([['q1', ['d1']], ['q2', ['d2']]]);
    const sparse = new Map([['q1', ['d1']], ['q2', ['d9']]]);
    const { top10OverlapMean } = computeDenseSparseOverlap(['q1', 'q2'], dense, sparse);
    assert.equal(top10OverlapMean, 0.5); // (1 + 0) / 2
  });
});

describe('computeRelevantOverlap', () => {
  test('classifies relevant docs into dense-only, sparse-only, both, and neither', () => {
    const qrels = qrelsMap({ q1: { relA: 1, relB: 1, relC: 1, relD: 1 } });
    const dense = new Map([['q1', ['relA', 'relB', 'x']]]);   // has relA, relB
    const sparse = new Map([['q1', ['relB', 'relC', 'y']]]);  // has relB, relC
    const result = computeRelevantOverlap(['q1'], qrels, dense, sparse, 10);
    assert.equal(result.denseOnlyHits, 1); // relA
    assert.equal(result.sparseOnlyHits, 1); // relC
    assert.equal(result.bothHits, 1); // relB
    assert.equal(result.neitherHits, 1); // relD
  });

  test('a query missing from qrels is skipped, not crashed on', () => {
    const qrels = qrelsMap({ q1: { d1: 1 } });
    const dense = new Map([['q1', ['d1']], ['q2', ['d2']]]);
    const sparse = new Map([['q1', ['d1']], ['q2', ['d2']]]);
    assert.doesNotThrow(() => computeRelevantOverlap(['q1', 'q2'], qrels, dense, sparse, 10));
  });

  test('respects the k cutoff — a relevant doc ranked beyond k does not count as a hit', () => {
    const qrels = qrelsMap({ q1: { relA: 1 } });
    const dense = new Map([['q1', Array.from({ length: 15 }, (_, i) => (i === 12 ? 'relA' : `x${i}`))]]); // relA at rank 13
    const sparse = new Map([['q1', []]]);
    const result = computeRelevantOverlap(['q1'], qrels, dense, sparse, 10);
    assert.equal(result.denseOnlyHits, 0);
    assert.equal(result.neitherHits, 1);
  });
});

// ── rescue/harm classification ───────────────────────────────────────────

describe('classifyRescueHarm', () => {
  test('classifies a query as rescue when hybrid nDCG@10 exceeds dense nDCG@10', () => {
    const qrels = qrelsMap({ q1: { relA: 1 } });
    const dense = new Map([['q1', ['x1', 'x2']]]); // relA not retrieved -> nDCG 0
    const hybrid = new Map([['q1', ['relA', 'x2']]]); // relA at rank 1 -> nDCG 1
    const result = classifyRescueHarm(['q1'], qrels, dense, hybrid);
    assert.equal(result.rescueCount, 1);
    assert.equal(result.harmCount, 0);
    assert.equal(result.perQuery[0].classification, 'rescue');
    assert.equal(result.perQuery[0].denseBestRelevantRank, null);
    assert.equal(result.perQuery[0].hybridBestRelevantRank, 1);
  });

  test('classifies a query as harm when hybrid nDCG@10 is below dense nDCG@10', () => {
    const qrels = qrelsMap({ q1: { relA: 1 } });
    const dense = new Map([['q1', ['relA', 'x2']]]); // relA at rank 1
    const hybrid = new Map([['q1', ['x1', 'x2']]]); // relA not retrieved
    const result = classifyRescueHarm(['q1'], qrels, dense, hybrid);
    assert.equal(result.harmCount, 1);
    assert.equal(result.rescueCount, 0);
    assert.equal(result.perQuery[0].classification, 'harm');
    assert.equal(result.perQuery[0].denseBestRelevantRank, 1);
    assert.equal(result.perQuery[0].hybridBestRelevantRank, null);
  });

  test('classifies identical dense/hybrid nDCG@10 as a tie, not a spurious rescue/harm', () => {
    const qrels = qrelsMap({ q1: { relA: 1 } });
    const ranked = new Map([['q1', ['relA', 'x2']]]);
    const result = classifyRescueHarm(['q1'], qrels, ranked, ranked);
    assert.equal(result.tieCount, 1);
    assert.equal(result.rescueCount, 0);
    assert.equal(result.harmCount, 0);
  });

  test('counts rescue/harm/tie correctly across a mixed set of queries', () => {
    const qrels = qrelsMap({ q1: { r: 1 }, q2: { r: 1 }, q3: { r: 1 } });
    const dense = new Map([['q1', ['x']], ['q2', ['r']], ['q3', ['r']]]);
    const hybrid = new Map([['q1', ['r']], ['q2', ['x']], ['q3', ['r']]]);
    const result = classifyRescueHarm(['q1', 'q2', 'q3'], qrels, dense, hybrid);
    assert.equal(result.rescueCount, 1); // q1
    assert.equal(result.harmCount, 1); // q2
    assert.equal(result.tieCount, 1); // q3
  });
});

describe('computeOracleMaxNdcg', () => {
  test('takes the max of dense and sparse nDCG@10 per query', () => {
    const qrels = qrelsMap({ q1: { r: 1 } });
    const dense = new Map([['q1', ['x', 'r']]]); // rank 2
    const sparse = new Map([['q1', ['r']]]); // rank 1, better
    const oracle = computeOracleMaxNdcg(['q1'], qrels, dense, sparse);
    // sparse nDCG@10 for a single relevant doc at rank 1 is 1.0
    assert.equal(oracle, 1);
  });

  test('returns null for an empty query list rather than dividing by zero', () => {
    assert.equal(computeOracleMaxNdcg([], qrelsMap({}), new Map(), new Map()), null);
  });
});

describe('pickRepresentativeCases', () => {
  test('returns up to n rescues and n harms, sorted by |delta| descending', () => {
    const rescueHarmResult = {
      perQuery: [
        { qid: 'a', delta: 0.1, classification: 'rescue' },
        { qid: 'b', delta: 0.9, classification: 'rescue' },
        { qid: 'c', delta: 0.5, classification: 'rescue' },
        { qid: 'd', delta: -0.2, classification: 'harm' },
        { qid: 'e', delta: -0.8, classification: 'harm' },
        { qid: 'f', delta: 0, classification: 'tie' },
      ],
    };
    const { rescues, harms } = pickRepresentativeCases(rescueHarmResult, { n: 2 });
    assert.deepEqual(rescues.map((r) => r.qid), ['b', 'c']);
    assert.deepEqual(harms.map((r) => r.qid), ['e', 'd']);
  });

  test('never includes a query ID from a private/local path or passage text — only qid + numeric fields', () => {
    const rescueHarmResult = {
      perQuery: [{ qid: 'q1', delta: 0.5, classification: 'rescue', denseBestRelevantRank: 5, hybridBestRelevantRank: 1 }],
    };
    const { rescues } = pickRepresentativeCases(rescueHarmResult, { n: 1 });
    const keys = Object.keys(rescues[0]);
    assert.deepEqual(keys.sort(), ['classification', 'delta', 'denseBestRelevantRank', 'hybridBestRelevantRank', 'qid'].sort());
  });
});

// ── comparison sign direction (P1 regression test) ───────────────────────
// pairedBootstrap(valuesA, valuesB) reports meanDelta = mean(B - A). Every
// comparisons.* key in analyzeScope() must be built so meanDelta reads as
// "<second half of the key name> minus <first half>" — e.g.
// comparisons.k2_vs_k60.meanDelta must be (k2 - k60), NOT (k60 - k2). A
// swapped argument order silently flips every downstream sign without
// changing which number "looks positive," so this is checked directly
// against a fixture where the true winner is known by construction.

describe('analyzeScope: comparison sign direction', () => {
  function fixtureWithKnownWinner() {
    // 3 queries, one relevant doc "r" each. hybrid_k2 ranks it 1st on
    // every query (perfect); hybrid_k60 ranks it 1st on only one query and
    // misses it entirely on the other two — hybrid_k2 is unambiguously
    // better here, so k2_vs_k60.meanDelta MUST be positive.
    const qids = ['q1', 'q2', 'q3'];
    const qrels = qrelsMap({ q1: { r: 1 }, q2: { r: 1 }, q3: { r: 1 } });
    const modes = {
      dense: new Map([['q1', ['x']], ['q2', ['x']], ['q3', ['x']]]), // never finds r
      sparse: new Map([['q1', ['x']], ['q2', ['x']], ['q3', ['x']]]), // never finds r
      hybrid_k2: new Map([['q1', ['r']], ['q2', ['r']], ['q3', ['r']]]), // always rank 1
      hybrid_k60: new Map([['q1', ['r']], ['q2', ['x']], ['q3', ['x']]]), // rank 1 once, misses twice
    };
    return { label: 'sign-fixture', qids, qrels, modes };
  }

  test('k2_vs_k60.meanDelta is positive when k2 is the constructed winner (must be k2 − k60, not k60 − k2)', () => {
    const { comparisons } = analyzeScope(fixtureWithKnownWinner());
    // The sign is the P1 regression under test — a swapped argument order
    // in analyzeScope() would flip this to negative even though k2 is
    // unambiguously better by construction (2 wins, 0 losses). The exact
    // bootstrap verdict label (MIXED/INCONCLUSIVE/B_BETTER) depends on
    // pairedBootstrap()'s own CI-width behavior on a 3-query sample and is
    // not what this test is checking.
    assert.ok(comparisons.k2_vs_k60.meanDelta > 0, `expected positive meanDelta (k2 better), got ${comparisons.k2_vs_k60.meanDelta}`);
    assert.equal(comparisons.k2_vs_k60.wins, 2);
    assert.equal(comparisons.k2_vs_k60.losses, 0);
  });

  test('hybrid_vs_dense.meanDelta is positive when hybrid is unambiguously better than dense', () => {
    const { comparisons } = analyzeScope(fixtureWithKnownWinner());
    // hybrid_k2 finds the relevant doc every time, dense never does.
    assert.ok(comparisons.hybrid_k2_vs_dense.meanDelta > 0, `expected positive meanDelta (hybrid better than dense), got ${comparisons.hybrid_k2_vs_dense.meanDelta}`);
  });

  test('hybrid_vs_sparse.meanDelta is positive when hybrid is unambiguously better than sparse', () => {
    const { comparisons } = analyzeScope(fixtureWithKnownWinner());
    assert.ok(comparisons.hybrid_k2_vs_sparse.meanDelta > 0, `expected positive meanDelta (hybrid better than sparse), got ${comparisons.hybrid_k2_vs_sparse.meanDelta}`);
  });

  test('dense_vs_sparse.meanDelta is (sparse − dense): positive when sparse is the constructed winner', () => {
    const qids = ['q1', 'q2'];
    const qrels = qrelsMap({ q1: { r: 1 }, q2: { r: 1 } });
    const modes = {
      dense: new Map([['q1', ['x']], ['q2', ['x']]]), // never finds r
      sparse: new Map([['q1', ['r']], ['q2', ['r']]]), // always rank 1 — sparse wins
    };
    const { comparisons } = analyzeScope({ label: 'x', qids, qrels, modes });
    assert.ok(comparisons.dense_vs_sparse.meanDelta > 0, `expected positive meanDelta (sparse better than dense), got ${comparisons.dense_vs_sparse.meanDelta}`);
  });

  test('reversing which side wins flips the sign, proving the comparison is not order-independent by accident', () => {
    // Now hybrid_k60 is the constructed winner instead of hybrid_k2.
    const qids = ['q1', 'q2', 'q3'];
    const qrels = qrelsMap({ q1: { r: 1 }, q2: { r: 1 }, q3: { r: 1 } });
    const modes = {
      dense: new Map([['q1', ['x']], ['q2', ['x']], ['q3', ['x']]]),
      sparse: new Map([['q1', ['x']], ['q2', ['x']], ['q3', ['x']]]),
      hybrid_k2: new Map([['q1', ['r']], ['q2', ['x']], ['q3', ['x']]]), // rank 1 once
      hybrid_k60: new Map([['q1', ['r']], ['q2', ['r']], ['q3', ['r']]]), // always rank 1
    };
    const { comparisons } = analyzeScope({ label: 'reversed', qids, qrels, modes });
    assert.ok(comparisons.k2_vs_k60.meanDelta < 0, `expected negative meanDelta (k60 now better), got ${comparisons.k2_vs_k60.meanDelta}`);
  });
});

// ── determinism ──────────────────────────────────────────────────────────

describe('determinism', () => {
  test('analyzeScope on identical inputs produces byte-identical comparisons (same bootstrap seed)', () => {
    const qids = ['q1', 'q2', 'q3'];
    const qrels = qrelsMap({ q1: { r: 1 }, q2: { r: 1 }, q3: { r: 1 } });
    const modes = {
      dense: new Map([['q1', ['r']], ['q2', ['x']], ['q3', ['r']]]),
      sparse: new Map([['q1', ['x']], ['q2', ['r']], ['q3', ['r']]]),
      hybrid_k60: new Map([['q1', ['r']], ['q2', ['r']], ['q3', ['r']]]),
    };
    const scope = { label: 'fixture', qids, qrels, modes };
    const resultA = analyzeScope(scope);
    const resultB = analyzeScope({ ...scope });
    assert.deepEqual(resultA.comparisons, resultB.comparisons);
    assert.deepEqual(resultA.metricsByMode, resultB.metricsByMode);
  });

  test('computeOverallVerdict is a pure function of its inputs — same scopes always produce the same verdict', () => {
    const scopeStub = (id, meanDelta, excludesZero) => ({
      id, modes: { dense: new Map(), hybrid_k60: new Map() },
      comparisons: { hybrid_k60_vs_dense: { n: 10, meanDelta, excludesZero } },
    });
    const scopes = [scopeStub('a', 0.05, true)];
    assert.equal(computeOverallVerdict(scopes), computeOverallVerdict([...scopes]));
  });
});

// ── verdict logic ────────────────────────────────────────────────────────

describe('computeOverallVerdict', () => {
  function scopeStub(id, hybridModes) {
    return {
      id,
      modes: Object.fromEntries(['dense', ...hybridModes.map((h) => h.name)].map((m) => [m, new Map()])),
      comparisons: Object.fromEntries(hybridModes.map((h) => [`${h.name}_vs_dense`, { n: 10, meanDelta: h.meanDelta, excludesZero: h.excludesZero }])),
    };
  }

  test('FUSION_COMPLEMENTARY when every significant comparison favors hybrid', () => {
    const scopes = [scopeStub('a', [{ name: 'hybrid_k60', meanDelta: 0.05, excludesZero: true }])];
    assert.equal(computeOverallVerdict(scopes), 'FUSION_COMPLEMENTARY');
  });

  test('FUSION_SPARSE_DEGRADES when every significant comparison favors dense over hybrid', () => {
    const scopes = [scopeStub('a', [{ name: 'hybrid_k60', meanDelta: -0.05, excludesZero: true }])];
    assert.equal(computeOverallVerdict(scopes), 'FUSION_SPARSE_DEGRADES');
  });

  test('FUSION_DATASET_DEPENDENT when different scopes disagree in direction', () => {
    const scopes = [
      scopeStub('a', [{ name: 'hybrid_k60', meanDelta: 0.05, excludesZero: true }]),
      scopeStub('b', [{ name: 'hybrid_k60', meanDelta: -0.05, excludesZero: true }]),
    ];
    assert.equal(computeOverallVerdict(scopes), 'FUSION_DATASET_DEPENDENT');
  });

  test('FUSION_ANALYSIS_INCONCLUSIVE when no comparison excludes zero', () => {
    const scopes = [scopeStub('a', [{ name: 'hybrid_k60', meanDelta: 0.01, excludesZero: false }])];
    assert.equal(computeOverallVerdict(scopes), 'FUSION_ANALYSIS_INCONCLUSIVE');
  });

  test('FUSION_ANALYSIS_INCONCLUSIVE when there are no scopes/comparisons at all', () => {
    assert.equal(computeOverallVerdict([]), 'FUSION_ANALYSIS_INCONCLUSIVE');
  });
});

// ── live, offline, real-data integration tests ───────────────────────────
// These exercise the actual committed BEIR/MIRACL runs. They are the tests
// that prove the strictly-offline constraint (no ONNX, no Qdrant, no
// network) actually holds for the full pipeline, not just for the pure
// helper functions above.

describe('offline safety: no network call is ever reached', () => {
  test('buildAllScopes() succeeds end-to-end even when global.fetch throws on every call', () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('NETWORK CALL ATTEMPTED — this must never happen in offline analysis'); };
    try {
      const scopes = buildAllScopes({ reportedMetricsByScope: loadReportedMetricsByScope() });
      assert.equal(scopes.length, 5);
      for (const scope of scopes) {
        assert.ok(scope.qids.length > 0, `${scope.id} has no queries`);
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('a full analyzeScope() pass over every scope succeeds with fetch blocked, including metric parity against the committed reports', () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('NETWORK CALL ATTEMPTED'); };
    try {
      const scopes = buildAllScopes({ reportedMetricsByScope: loadReportedMetricsByScope() });
      for (const scope of scopes) {
        assert.doesNotThrow(() => analyzeScope(scope), `${scope.id} failed with fetch blocked`);
      }
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('scope separation between full and mini datasets', () => {
  test('beir_full_local and beir_mini_local are distinct scopes with different query counts, never merged', () => {
    const scopes = buildAllScopes();
    const full = scopes.find((s) => s.id === 'beir_full_local');
    const mini = scopes.find((s) => s.id === 'beir_mini_local');
    assert.ok(full && mini);
    assert.notEqual(full.qids.length, mini.qids.length);
    assert.equal(full.qids.length, 300);
    assert.equal(mini.qids.length, 100);
    assert.equal(mini.isMini, true);
    assert.notEqual(full.isMini, true);
  });

  test('MIRACL local and cloud scopes are distinct, each with their own TREC modes', () => {
    const scopes = buildAllScopes();
    const local = scopes.find((s) => s.id === 'miracl_local');
    const cloud = scopes.find((s) => s.id === 'miracl_cloud');
    assert.ok(local && cloud);
    assert.notEqual(local.modes.dense, cloud.modes.dense);
  });

  test('the mini scope never appears as, or gets merged into, "full SciFact" in scope labels', () => {
    const scopes = buildAllScopes();
    const mini = scopes.find((s) => s.id === 'beir_mini_local');
    assert.match(mini.label, /MINI/);
    assert.match(mini.label, /NOT full SciFact/i);
  });

  test('BEIR full local has no hybrid_k2 mode (the full harness never ran local at k=2)', () => {
    const scopes = buildAllScopes();
    const full = scopes.find((s) => s.id === 'beir_full_local');
    assert.equal(full.modes.hybrid_k2, undefined);
    assert.ok(full.modes.hybrid_k60);
  });
});

describe('metric parity against the real committed reports', () => {
  test('every scope with a committed report passes metric parity within strict tolerance', () => {
    const scopes = buildAllScopes({ reportedMetricsByScope: loadReportedMetricsByScope() });
    for (const scope of scopes) {
      assert.doesNotThrow(() => analyzeScope(scope), `metric parity failed for ${scope.id}`);
    }
  });

  test('deliberately corrupting a reported metric causes assertMetricParity to fail loudly, proving the check is not a no-op', () => {
    const scopes = buildAllScopes();
    const full = scopes.find((s) => s.id === 'beir_full_local');
    full.reportedMetrics = { dense: { ndcgAt10: 0.1234, mapAt100: 0, recallAt10: 0, recallAt100: 0, precisionAt10: 0, mrrAt10: 0 } };
    assert.throws(() => analyzeScope(full), /metric parity check failed/);
  });
});

describe('real-data rescue/harm and oracle sanity (regression guard on the actual committed runs)', () => {
  test('MIRACL local/cloud scopes show more harm than rescue for hybrid vs dense (matches the observed dataset behavior)', () => {
    const scopes = buildAllScopes();
    for (const id of ['miracl_local', 'miracl_cloud']) {
      const scope = scopes.find((s) => s.id === id);
      const analyzed = analyzeScope(scope);
      const rh = analyzed.rescueHarmByHybrid.hybrid_k60;
      assert.ok(rh.harmCount > rh.rescueCount, `${id}: expected harmCount > rescueCount, got harm=${rh.harmCount} rescue=${rh.rescueCount}`);
    }
  });

  test('BEIR full cloud shows a nonzero rescue count for hybrid vs dense (hybrid contributes something on SciFact)', () => {
    const scopes = buildAllScopes();
    const scope = scopes.find((s) => s.id === 'beir_full_cloud');
    const analyzed = analyzeScope(scope);
    assert.ok(analyzed.rescueHarmByHybrid.hybrid_k2.rescueCount > 0);
  });

  test('oracle max(dense, sparse) nDCG@10 is always >= both dense and sparse aggregate nDCG@10 for every scope', () => {
    const scopes = buildAllScopes();
    for (const scope of scopes) {
      const analyzed = analyzeScope(scope);
      if (analyzed.oracleMaxNdcg10 === null) continue;
      assert.ok(analyzed.oracleMaxNdcg10 >= analyzed.metricsByMode.dense.ndcgAt10 - 1e-9, `${scope.id}: oracle below dense`);
      assert.ok(analyzed.oracleMaxNdcg10 >= analyzed.metricsByMode.sparse.ndcgAt10 - 1e-9, `${scope.id}: oracle below sparse`);
    }
  });
});
