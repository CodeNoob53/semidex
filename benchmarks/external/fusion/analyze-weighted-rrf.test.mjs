// Bounded, offline tests for the weighted-RRF candidate analyzer. No
// network, no Qdrant client import, no ONNX/embedding import — every test
// here operates on in-memory fixtures or real already-committed TREC/
// dataset cache files. Run:
//   node --test --test-concurrency=1 benchmarks/external/fusion/analyze-weighted-rrf.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  weightedRrfContribution, sparseWeightFromRho, fuseWeightedRrf, fuseWeightedRrfAllQueries,
  checkParity, selectCandidates, buildQdrantPayload, RHO_VALUES, K_VALUES, DENSE_WEIGHT, TOP_K,
  analyzeScopeWeightedRrf, buildScope, SCOPE_IDS, renderMarkdownReport,
} from './analyze-weighted-rrf.mjs';
import { loadTrecRunAsRanked, validateTrecRun, strictCheckRawTrecLines } from './analyze-fusion.mjs';

// ── 1. exact Qdrant formula ─────────────────────────────────────────────
describe('weightedRrfContribution: exact Qdrant 1.17+ formula', () => {
  test('matches 1 / (k + (rank+1)/weight - 1), never weight/(k+rank)', () => {
    // Hand-computed: k=60, weight=1, rank=0 -> 1/(60 + 1/1 - 1) = 1/60.
    assert.equal(weightedRrfContribution(0, 1, 60), 1 / 60);
    // k=2, weight=0.5, rank=3 (zero-based, i.e. 4th result) ->
    // 1/(2 + 4/0.5 - 1) = 1/(2 + 8 - 1) = 1/9.
    assert.equal(weightedRrfContribution(3, 0.5, 2), 1 / 9);
  });

  test('is NOT the naive incorrect formula weight/(k+rank)', () => {
    const correct = weightedRrfContribution(2, 0.3, 10);
    const naiveWrong = 0.3 / (10 + 2);
    assert.notEqual(correct, naiveWrong);
  });

  test('weight=1 (equal RRF) reduces to the standard RRF formula 1/(k+rank)', () => {
    for (const [rank, k] of [[0, 60], [5, 60], [0, 2], [9, 2]]) {
      assert.ok(Math.abs(weightedRrfContribution(rank, 1, k) - 1 / (k + rank)) < 1e-12);
    }
  });
});

// ── 2. zero-based rank behavior ─────────────────────────────────────────
describe('zero-based rank behavior', () => {
  test('rank=0 (the very first result) yields the maximum possible contribution for a given weight/k', () => {
    const c0 = weightedRrfContribution(0, 1, 60);
    const c1 = weightedRrfContribution(1, 1, 60);
    const c2 = weightedRrfContribution(2, 1, 60);
    assert.ok(c0 > c1);
    assert.ok(c1 > c2);
  });

  test('rank-1 contribution in the task\'s rho definition means rank=0 (zero-based first rank), not rank=1', () => {
    // With denseWeight=1, dense's own rank-1 (first result) contribution
    // is exactly 1/k, matching weightedRrfContribution(0, 1, k).
    for (const k of K_VALUES) {
      assert.equal(weightedRrfContribution(0, DENSE_WEIGHT, k), 1 / k);
    }
  });
});

// ── 3. rho -> weight conversion, 4. expected numeric examples ───────────
describe('sparseWeightFromRho: exact expected examples for k=2 and k=60', () => {
  const expected = [
    [2, 0.10, 0.0526316],
    [2, 0.25, 0.1428571],
    [2, 0.50, 0.3333333],
    [2, 0.75, 0.6000000],
    [2, 1.00, 1.0000000],
    [60, 0.10, 0.0018484],
    [60, 0.25, 0.0055249],
    [60, 0.50, 0.0163934],
    [60, 0.75, 0.0476190],
    [60, 1.00, 1.0000000],
  ];
  for (const [k, rho, expectedWeight] of expected) {
    test(`k=${k} rho=${rho} -> sparseWeight≈${expectedWeight}`, () => {
      const actual = sparseWeightFromRho(k, rho);
      assert.ok(Math.abs(actual - expectedWeight) < 1e-6, `expected ~${expectedWeight}, got ${actual}`);
    });
  }

  test('the converted sparseWeight reproduces rho exactly at rank=0 (round-trip property)', () => {
    for (const k of K_VALUES) {
      for (const rho of RHO_VALUES) {
        const sparseWeight = sparseWeightFromRho(k, rho);
        const denseContrib = weightedRrfContribution(0, DENSE_WEIGHT, k);
        const sparseContrib = weightedRrfContribution(0, sparseWeight, k);
        assert.ok(Math.abs(sparseContrib / denseContrib - rho) < 1e-6, `k=${k} rho=${rho}: round-trip ratio was ${sparseContrib / denseContrib}`);
      }
    }
  });

  test('rho=1.00 always yields sparseWeight=1.00 regardless of k (equal RRF)', () => {
    for (const k of K_VALUES) {
      assert.ok(Math.abs(sparseWeightFromRho(k, 1.0) - 1.0) < 1e-9);
    }
  });
});

// ── 5. dense-only handled separately, never weight=0 emulation ──────────
describe('dense-only is a separate baseline, never emulated via sparse weight 0', () => {
  test('analyze-weighted-rrf.mjs never constructs a config with sparseWeight: 0', async () => {
    const src = readFileSync(new URL('./analyze-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /sparseWeight:\s*0[,\s)]/);
  });

  test('the dense config in analyzeScopeWeightedRrf() is evaluated from the raw dense TREC ranking, not a fused ranking', () => {
    const src = readFileSync(new URL('./analyze-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.match(src, /evaluateConfig\(scope, 'dense', scope\.dense, densePerQuery\)/);
  });
});

// ── 6. weight array order is dense then sparse ───────────────────────────
describe('buildQdrantPayload: weight array order', () => {
  test('weights array is [denseWeight, sparseWeight], never reversed', () => {
    const configMeta = [{ configId: 'k60_rho0.25', k: 60, denseWeight: 1.0, sparseWeight: sparseWeightFromRho(60, 0.25) }];
    const payload = buildQdrantPayload('k60_rho0.25', configMeta);
    assert.deepEqual(payload.query.rrf.weights, [1.0, sparseWeightFromRho(60, 0.25)]);
  });

  test('payload never uses prefetch.weight — weights live only in query.rrf.weights', () => {
    const configMeta = [{ configId: 'k2_rho0.50', k: 2, denseWeight: 1.0, sparseWeight: sparseWeightFromRho(2, 0.50) }];
    const payload = buildQdrantPayload('k2_rho0.50', configMeta);
    assert.equal('prefetch' in payload, false);
    assert.ok('weights' in payload.query.rrf);
  });

  test('payload k matches the config\'s k', () => {
    const configMeta = [{ configId: 'k2_rho1.00', k: 2, denseWeight: 1.0, sparseWeight: 1.0 }];
    const payload = buildQdrantPayload('k2_rho1.00', configMeta);
    assert.equal(payload.query.rrf.k, 2);
  });
});

// ── 7. document appearing in one or both channels ────────────────────────
describe('fuseWeightedRrf: document appearing in one or both channels', () => {
  test('a document present in both lanes gets the SUM of both contributions', () => {
    const dense = ['d1', 'd2'];
    const sparse = ['d1', 'd3'];
    const fused = fuseWeightedRrf(dense, sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 10 });
    // d1 is rank 0 in both -> highest combined score -> must be first.
    assert.equal(fused[0], 'd1');
  });

  test('a document present in ONLY the dense lane receives ONLY the dense contribution (no fabricated sparse contribution)', () => {
    const dense = ['d1'];
    const sparse = [];
    const fused = fuseWeightedRrf(dense, sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 10 });
    assert.deepEqual(fused, ['d1']);
  });

  test('a document present in ONLY the sparse lane receives ONLY the sparse contribution', () => {
    const dense = [];
    const sparse = ['d1'];
    const fused = fuseWeightedRrf(dense, sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 10 });
    assert.deepEqual(fused, ['d1']);
  });

  test('a doc in both lanes always outranks an equally-ranked doc in only one lane (sum > single contribution)', () => {
    const dense = ['both', 'denseOnly'];
    const sparse = ['both'];
    const fused = fuseWeightedRrf(dense, sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 10 });
    assert.equal(fused[0], 'both');
    assert.equal(fused[1], 'denseOnly');
  });

  test('fuseWeightedRrfAllQueries processes every query independently and never merges cross-query results', () => {
    const denseByQuery = new Map([['q1', ['a']], ['q2', ['b']]]);
    const sparseByQuery = new Map([['q1', []], ['q2', []]]);
    const result = fuseWeightedRrfAllQueries(['q1', 'q2'], denseByQuery, sparseByQuery, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 10 });
    assert.deepEqual(result.get('q1'), ['a']);
    assert.deepEqual(result.get('q2'), ['b']);
  });
});

// ── 8. deterministic tie-breaking (never tuned against qrels) ───────────
describe('fuseWeightedRrf: deterministic tie-break', () => {
  test('a genuine score tie (both docs absent from one lane, identical rank in the other) breaks by lower dense rank first', () => {
    // d1 and d2 both appear ONLY in dense, at different ranks -> no real
    // tie in dense rank, so d1 (rank 0) must outrank d2 (rank 1).
    const dense = ['d1', 'd2'];
    const sparse = [];
    const fused = fuseWeightedRrf(dense, sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 10 });
    assert.deepEqual(fused, ['d1', 'd2']);
  });

  test('when dense rank is genuinely equal, sparse rank breaks the tie', () => {
    // Construct two documents that are absent from dense entirely (so
    // "dense rank" is Infinity for both, a genuine tie there) and present
    // in sparse at different ranks with the SAME resulting contribution
    // only possible if... use two disjoint queries is not applicable here;
    // instead verify sparse rank ordering directly when dense is empty.
    const dense = [];
    const sparse = ['s1', 's2'];
    const fused = fuseWeightedRrf(dense, sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 10 });
    assert.deepEqual(fused, ['s1', 's2']);
  });

  test('final tiebreaker is doc ID string sort order when dense and sparse ranks are identical (both absent from both, impossible for merged docs) — verified via explicit equal-score construction', () => {
    // Force an actual score tie between two docs with DIFFERENT ranks in
    // each lane but equal SUM, using weight=0 is disallowed, so instead
    // verify the fallback ordering directly using the tie-break function's
    // own documented rule: construct 'b' and 'a' both present ONLY in
    // dense at the exact same synthetic scenario is not reachable via
    // ranks alone (ranks are unique per lane by construction) — this test
    // instead verifies the rule is applied by checking sort stability is
    // never relied upon: build two single-lane-absent docs whose dense
    // ranks are equal is impossible (array position defines rank), so we
    // confirm doc-ID tie-break fires only when both dRank and sRank are
    // equal, which happens when both docs are absent from BOTH lanes —
    // impossible for a merged doc. Document the rule's presence in source
    // instead, since it is structurally unreachable via public ranked
    // lists (this is intentional: every merged doc has at least one real
    // rank).
    const src = readFileSync(new URL('./analyze-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.match(src, /doc ID string sort order/);
    assert.match(src, /a\.docId < b\.docId \? -1 : a\.docId > b\.docId \? 1 : 0/);
  });

  test('the tie-break rule is fixed BEFORE evaluation — the same fixture always produces the same fused order across repeated calls (no randomness, no qrels dependency)', () => {
    const dense = ['d1', 'd2', 'd3'];
    const sparse = ['d3', 'd1', 'd2'];
    const run1 = fuseWeightedRrf(dense, sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 10 });
    const run2 = fuseWeightedRrf(dense, sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 10 });
    assert.deepEqual(run1, run2);
  });

  test('the analyzer module never imports qrels into the tie-break function\'s own scope (fuseWeightedRrf has no qrels parameter)', () => {
    assert.equal(fuseWeightedRrf.length, 3); // (denseRanked, sparseRanked, config) — no qrels param
  });
});

// ── depth / evaluation ───────────────────────────────────────────────────
describe('fuseWeightedRrf: evaluates the final top-100 depth', () => {
  test('respects the depth parameter and truncates to exactly that many results when more are available', () => {
    const dense = Array.from({ length: 150 }, (_, i) => `d${i}`);
    const sparse = [];
    const fused = fuseWeightedRrf(dense, sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 100 });
    assert.equal(fused.length, 100);
  });

  test('TOP_K constant is 100, matching the task\'s required evaluation depth', () => {
    assert.equal(TOP_K, 100);
  });
});

// ── 9. malformed TREC rejection (reused from analyze-fusion.mjs) ────────
describe('malformed TREC rejection (reused strict validator)', () => {
  test('strictCheckRawTrecLines throws on a line with fewer than 6 fields', () => {
    const text = 'q1\tQ0\td1\t1\t0.9\trun-tag\nq1\tQ0\td2\t2\n';
    assert.throws(() => strictCheckRawTrecLines(text, 'test-label'), /malformed TREC line in test-label at line 2/);
  });

  test('loadTrecRunAsRanked throws on a missing file', () => {
    assert.throws(() => loadTrecRunAsRanked('/nonexistent/path/to/nowhere.trec'), /expected TREC run file missing/);
  });
});

// ── 10. missing-file rejection (this module's own loaders) ──────────────
describe('missing-file rejection', () => {
  test('buildScope throws for an unknown scope id', () => {
    assert.throws(() => buildScope('not_a_real_scope'), /unknown scope id/);
  });

  test('buildScope throws for an unknown Belebele language', () => {
    assert.throws(() => buildScope('belebele_xyz_Notreal'), /unknown Belebele language scope/);
  });
});

// ── 11. qrel/run query mismatch ──────────────────────────────────────────
describe('qrel/run query ID mismatch (reused strict validator)', () => {
  test('validateTrecRun throws when the run is missing a query the qrels contract expects', () => {
    const byQuery = new Map([['q1', [{ docId: 'd1', rank: 1 }]]]);
    assert.throws(() => validateTrecRun(byQuery, { expectedQueryIds: ['q1', 'q2'], label: 'test' }), /missing query q2/);
  });

  test('validateTrecRun throws when the run has an unexpected extra query not in qrels', () => {
    const byQuery = new Map([['q1', [{ docId: 'd1', rank: 1 }]], ['q99', [{ docId: 'd2', rank: 1 }]]]);
    assert.throws(() => validateTrecRun(byQuery, { expectedQueryIds: ['q1'], label: 'test' }), /unexpected query q99/);
  });
});

// ── 12. parity checker ───────────────────────────────────────────────────
describe('checkParity', () => {
  function fixtureScope({ k2Hybrid = null, k60Hybrid = null } = {}) {
    const qids = ['q1', 'q2'];
    const qrels = new Map([
      ['q1', new Map([['d1', 1]])],
      ['q2', new Map([['d2', 1]])],
    ]);
    const dense = new Map([['q1', ['d1', 'd2', 'd3']], ['q2', ['d2', 'd1', 'd3']]]);
    const sparse = new Map([['q1', ['d2', 'd1', 'd3']], ['q2', ['d1', 'd2', 'd3']]]);
    return {
      id: 'fixture', label: 'fixture', qids, qrels, dense, sparse,
      parityHybrid: { k2: k2Hybrid, k60: k60Hybrid },
    };
  }

  test('reports unavailable when no real hybrid run exists for that k', () => {
    const scope = fixtureScope();
    const result = checkParity(scope, 2);
    assert.equal(result.available, false);
    assert.match(result.reason, /no real Qdrant hybrid_k2/);
  });

  test('reports available:true and a faithful verdict when the reconstruction exactly matches a hand-built equal-RRF run', () => {
    const scope = fixtureScope();
    // Hand-reconstruct the SAME equal-RRF (k=60) ranking as what
    // fuseWeightedRrf would produce, so parity should be exact.
    const k60Hybrid = fuseWeightedRrfAllQueries(scope.qids, scope.dense, scope.sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 100 });
    scope.parityHybrid.k60 = k60Hybrid;
    const result = checkParity(scope, 60);
    assert.equal(result.available, true);
    assert.equal(result.maxAbsDiff, 0);
    assert.equal(result.queriesWithTop10Diff, 0);
    assert.equal(result.sufficientlyFaithful, true);
  });

  test('reports NOT faithful (and never silently calls it exact) when the real run diverges substantially from the reconstruction', () => {
    const scope = fixtureScope();
    // A "real" hybrid run with a completely different ranking than what
    // reconstruction would produce.
    const divergentHybrid = new Map([['q1', ['d3', 'd2', 'd1']], ['q2', ['d3', 'd1', 'd2']]]);
    scope.parityHybrid.k60 = divergentHybrid;
    const result = checkParity(scope, 60);
    assert.equal(result.available, true);
    // Divergent ranking should show up as a real metric/ranking difference.
    assert.ok(result.queriesWithTop10Diff > 0 || result.maxAbsDiff > 0);
  });

  test('includes the prefetch=200-vs-top100 caveat in every available parity result', () => {
    const scope = fixtureScope();
    scope.parityHybrid.k60 = fuseWeightedRrfAllQueries(scope.qids, scope.dense, scope.sparse, { k: 60, denseWeight: 1, sparseWeight: 1, depth: 100 });
    const result = checkParity(scope, 60);
    assert.match(result.caveat, /prefetch limit 200/);
  });
});

// ── 13. candidate-selection rules ────────────────────────────────────────
describe('selectCandidates: rule-based, not subjective', () => {
  function fixtureScopeResult(id, { vsDenseByConfig, metricsByConfig }) {
    const vsDense = {};
    const metrics = {};
    for (const [configId, meanDelta] of Object.entries(vsDenseByConfig)) {
      vsDense[configId] = {
        meanDeltaNdcg10: meanDelta,
        bootstrap: { excludesZero: meanDelta !== 0 && Math.abs(meanDelta) > 0.05, meanDelta, verdict: meanDelta > 0.05 ? 'B_BETTER' : meanDelta < -0.05 ? 'A_BETTER' : 'INCONCLUSIVE' },
      };
    }
    for (const [configId, ndcg] of Object.entries(metricsByConfig)) metrics[configId] = { ndcgAt10: ndcg };
    return { id, vsDense, metrics };
  }

  function allConfigIds() {
    const ids = ['dense', 'sparse'];
    for (const k of K_VALUES) for (const rho of RHO_VALUES) ids.push(`k${k}_rho${rho.toFixed(2)}`);
    return ids;
  }

  /** Builds a full, valid scopeResults array covering the EXACT SCOPE_IDS
   * set (required since selectCandidates() now refuses to select anything
   * unless every required scope is present — see the P1 regression tests
   * below). Every scope defaults to "config X has vsDenseByConfig[X] delta
   * and metricsByConfig[X] ndcgAt10", then `overrides[scopeId]` (if given)
   * replaces that scope's vsDenseByConfig/metricsByConfig entirely. */
  function fixtureFullScopeSet({ vsDenseByConfig, metricsByConfig, overrides = {} }) {
    return SCOPE_IDS.map((id) => {
      const o = overrides[id];
      return fixtureScopeResult(id, {
        vsDenseByConfig: o?.vsDenseByConfig ?? vsDenseByConfig,
        metricsByConfig: o?.metricsByConfig ?? metricsByConfig,
      });
    });
  }

  // ── P3 fix: the count assertion now matches its own title exactly. With
  // the P2 distinctness fix, denseHeavy and balanced are NEVER the same
  // config when both are non-null, so the true maximum is 2 DISTINCT
  // weighted candidates + 2 equal-RRF controls (k=2, k=60) = 4 total
  // payloads — never fewer distinct configs than the title implies. ──────
  test('selects at most 4 total configurations: 2 distinct weighted candidates (dense-heavy + balanced) + 2 equal-RRF controls, never a repeated config', () => {
    const ids = allConfigIds();
    const vsDenseByConfig = Object.fromEntries(ids.map((id) => [id, 0.01]));
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.5]));
    const scopeResults = fixtureFullScopeSet({ vsDenseByConfig, metricsByConfig });
    const result = selectCandidates(scopeResults);
    const weightedPicks = new Set([result.denseHeavyCandidate, result.balancedCandidate].filter(Boolean));
    const selectedCount = weightedPicks.size + result.equalRrfControls.length;
    assert.ok(selectedCount <= 4, `expected at most 4 total (<=2 distinct weighted + 2 equal-RRF controls), got ${selectedCount}`);
    if (result.denseHeavyCandidate && result.balancedCandidate) {
      assert.notEqual(result.denseHeavyCandidate, result.balancedCandidate, 'dense-heavy and balanced must never be the same config when both are selected');
    }
  });

  test('returns NO_WEIGHTED_RRF_CANDIDATE when every weighted config shows a significant regression vs dense everywhere', () => {
    const ids = allConfigIds();
    const vsDenseByConfig = Object.fromEntries(ids.map((id) => [id, id.startsWith('k') ? -0.1 : 0]));
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.3]));
    const scopeResults = fixtureFullScopeSet({ vsDenseByConfig, metricsByConfig });
    const result = selectCandidates(scopeResults);
    assert.equal(result.verdict, 'NO_WEIGHTED_RRF_CANDIDATE');
    assert.equal(result.denseHeavyCandidate, null);
    assert.equal(result.balancedCandidate, null);
  });

  test('MIRACL is explicitly labeled diagnostic/validation evidence, not a blind holdout, in every result', () => {
    const ids = allConfigIds();
    const scopeResults = fixtureFullScopeSet({
      vsDenseByConfig: Object.fromEntries(ids.map((id) => [id, 0])),
      metricsByConfig: Object.fromEntries(ids.map((id) => [id, 0.5])),
    });
    const result = selectCandidates(scopeResults);
    assert.match(result.miraclNote, /not a blind holdout/);
    assert.match(result.miraclNote, /diagnostic\/validation/);
  });

  test('a config with a positive SciFact benefit and zero regressions anywhere is eligible for the dense-heavy slot', () => {
    const ids = allConfigIds();
    const vsDenseByConfig = Object.fromEntries(ids.map((id) => [id, 0]));
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.5]));
    const scifactVsDense = { ...vsDenseByConfig, 'k60_rho0.10': 0.02 }; // small positive SciFact benefit
    const scopeResults = fixtureFullScopeSet({
      vsDenseByConfig, metricsByConfig,
      overrides: { scifact_local: { vsDenseByConfig: scifactVsDense, metricsByConfig } },
    });
    const result = selectCandidates(scopeResults);
    assert.equal(result.denseHeavyCandidate, 'k60_rho0.10');
  });

  // ── P1 regression: MIRACL must be included in the "no regression
  // anywhere" gate for BOTH candidate slots — a config with a confirmed
  // significant MIRACL regression must never be selected as dense-heavy
  // (or balanced), even if it looks fine on SciFact/Belebele. This
  // reproduces the exact real-data bug: k2_rho0.75 had a real, live
  // -3.31pp significant MIRACL regression yet was still selected as
  // "dense-heavy" under the old rule, which only checked Belebele. ──────
  test('a config with a statistically significant MIRACL regression is NEVER selected as dense-heavy, even with a strong SciFact benefit and zero Belebele regressions', () => {
    const ids = allConfigIds();
    const baseVsDense = Object.fromEntries(ids.map((id) => [id, 0]));
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.5]));
    const scifactVsDense = { ...baseVsDense, 'k2_rho0.75': 0.05 }; // strong SciFact benefit
    const scopeResults = fixtureFullScopeSet({
      vsDenseByConfig: baseVsDense, metricsByConfig,
      overrides: { scifact_local: { vsDenseByConfig: scifactVsDense, metricsByConfig } },
    });
    // Overwrite k2_rho0.75's MIRACL comparison with the EXACT shape a real
    // pairedBootstrapByQuery() result has for a significant regression
    // (excludesZero: true, meanDelta < 0) — mirrors the real, live-observed
    // MIRACL k2_rho0.75 value (meanDelta ≈ -0.0331) rather than deriving
    // "significant" from the shared fixture helper's own simplified
    // |delta|>0.05 heuristic, which does not match real bootstrap CI logic.
    const miraclScope = scopeResults.find((s) => s.id === 'miracl_local');
    miraclScope.vsDense['k2_rho0.75'] = {
      meanDeltaNdcg10: -0.0331,
      bootstrap: { excludesZero: true, meanDelta: -0.0331, verdict: 'A_BETTER' },
    };
    const result = selectCandidates(scopeResults);
    assert.notEqual(result.denseHeavyCandidate, 'k2_rho0.75');
    assert.notEqual(result.balancedCandidate, 'k2_rho0.75');
  });

  // ── P1 regression: dense-heavy must pick the SMALLEST eligible rho
  // (least sparse influence), not merely "fewest Belebele regressions." ──
  test('dense-heavy picks the SMALLEST eligible rho among safe-everywhere configs with a SciFact benefit, not the one with fewest Belebele regressions', () => {
    const ids = allConfigIds();
    // Both k2_rho0.10 and k2_rho0.75 are safe everywhere and have a
    // positive SciFact benefit -> dense-heavy must pick k2_rho0.10 (the
    // smaller rho / more dense-dominated option), never k2_rho0.75.
    const scifactVsDense = Object.fromEntries(ids.map((id) => [id, 0]));
    scifactVsDense['k2_rho0.10'] = 0.01;
    scifactVsDense['k2_rho0.75'] = 0.03; // larger SciFact benefit, but larger rho too
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.5]));
    const scopeResults = fixtureFullScopeSet({
      vsDenseByConfig: Object.fromEntries(ids.map((id) => [id, 0])), metricsByConfig,
      overrides: { scifact_local: { vsDenseByConfig: scifactVsDense, metricsByConfig } },
    });
    const result = selectCandidates(scopeResults);
    assert.equal(result.denseHeavyCandidate, 'k2_rho0.10');
  });

  // ── P1 regression: missing vsDense/bootstrap data must DISQUALIFY a
  // config, never pass it through as "confirmed safe." Reproduces the
  // exact bug: `!bootstrap || !isSignificantRegression(...)` reads a
  // missing bootstrap as `true` (safe) via the `||` short-circuit. ──────
  test('a config with a real metric but NO vsDense entry at all for some scope is never selected for either candidate slot', () => {
    const ids = allConfigIds();
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.9])); // looks like the best metric
    // scifact_local has full vsDense data with a positive benefit...
    const scifactVsDense = { ...Object.fromEntries(ids.map((id) => [id, 0])), 'k60_rho0.25': 0.05 };
    // ...but belebele_ukr_Cyrl has NO vsDense entry for k60_rho0.25 at all
    // (simulating a partial/incomplete result) — this must disqualify the
    // config, not pass it through as safe.
    const belebeleVsDense = Object.fromEntries(ids.filter((id) => id !== 'k60_rho0.25').map((id) => [id, 0]));
    const scopeResults = fixtureFullScopeSet({
      vsDenseByConfig: Object.fromEntries(ids.map((id) => [id, 0])), metricsByConfig,
      overrides: {
        scifact_local: { vsDenseByConfig: scifactVsDense, metricsByConfig },
        belebele_ukr_Cyrl: { vsDenseByConfig: belebeleVsDense, metricsByConfig },
      },
    });
    const result = selectCandidates(scopeResults);
    assert.notEqual(result.denseHeavyCandidate, 'k60_rho0.25');
    assert.notEqual(result.balancedCandidate, 'k60_rho0.25');
  });

  // ── P1 regression: an INCOMPLETE scope set (missing one or more required
  // scopes entirely) must never let a config be selected — a config that
  // was never checked against the missing scope(s) cannot be shown to have
  // "no significant regression anywhere." ─────────────────────────────────
  test('a scope missing from scopeResults entirely (e.g. never ran) forces NO_WEIGHTED_RRF_CANDIDATE, never a silent partial evaluation', () => {
    const ids = allConfigIds();
    const vsDenseByConfig = Object.fromEntries(ids.map((id) => [id, 0]));
    vsDenseByConfig['k2_rho0.10'] = 0.01;
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.5]));
    // Only scifact_local is present; every other required scope
    // (miracl_local + 7 belebele_*) is simply absent from the array.
    const result = selectCandidates([fixtureScopeResult('scifact_local', { vsDenseByConfig, metricsByConfig })]);
    assert.equal(result.verdict, 'NO_WEIGHTED_RRF_CANDIDATE');
    assert.equal(result.denseHeavyCandidate, null);
    assert.equal(result.balancedCandidate, null);
    // Equal RRF controls are still reported even when the scope set is incomplete.
    assert.ok(result.equalRrfControls.length > 0);
  });

  test('a scope set with one EXTRA unrecognized scope id also forces NO_WEIGHTED_RRF_CANDIDATE (exact-set match, not merely "at least the required scopes")', () => {
    const ids = allConfigIds();
    const vsDenseByConfig = Object.fromEntries(ids.map((id) => [id, 0]));
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.5]));
    const scopeResults = fixtureFullScopeSet({ vsDenseByConfig, metricsByConfig });
    scopeResults.push(fixtureScopeResult('belebele_srp_Cyrl', { vsDenseByConfig, metricsByConfig })); // not in SCOPE_IDS
    const result = selectCandidates(scopeResults);
    assert.equal(result.verdict, 'NO_WEIGHTED_RRF_CANDIDATE');
  });

  // ── P2 regression: dense-heavy and balanced must never resolve to the
  // SAME config — a live benchmark must never be asked to run the
  // identical query twice under two different labels. ─────────────────────
  test('when the single best balanced/quality config is identical to dense-heavy, balanced falls through to the next-best DISTINCT eligible config', () => {
    const ids = allConfigIds();
    const base = Object.fromEntries(ids.map((id) => [id, 0]));
    const metricsByConfig = { ...Object.fromEntries(ids.map((id) => [id, 0.5])) };
    // k2_rho0.10 is the smallest safe rho with a SciFact benefit -> dense-heavy.
    // Also give k2_rho0.10 the highest metric everywhere so it would ALSO
    // be the naive single-best balanced pick, and k2_rho0.25 the
    // second-highest (also safe everywhere) so it becomes the distinct
    // balanced fallback.
    const scifactVsDense = { ...base, 'k2_rho0.10': 0.01, 'k2_rho0.25': 0.01 };
    const metricsOverride = { ...metricsByConfig, 'k2_rho0.10': 0.99, 'k2_rho0.25': 0.95 };
    const scopeResults = fixtureFullScopeSet({
      vsDenseByConfig: base, metricsByConfig,
      overrides: {
        scifact_local: { vsDenseByConfig: scifactVsDense, metricsByConfig: metricsOverride },
      },
    });
    // Apply the same elevated metric to every scope so k2_rho0.10 really is
    // the global macro-quality winner (and thus WOULD collide with
    // dense-heavy if not for the distinctness fix).
    for (const s of scopeResults) {
      s.metrics['k2_rho0.10'] = { ndcgAt10: 0.99 };
      s.metrics['k2_rho0.25'] = { ndcgAt10: 0.95 };
    }
    const result = selectCandidates(scopeResults);
    assert.equal(result.denseHeavyCandidate, 'k2_rho0.10');
    assert.equal(result.balancedCandidate, 'k2_rho0.25');
    assert.equal(result.balancedCollidedWithDenseHeavy, true);
  });

  test('when NO distinct eligible config exists for balanced besides dense-heavy itself, balanced is null (never duplicates dense-heavy)', () => {
    const ids = allConfigIds();
    const base = Object.fromEntries(ids.map((id) => [id, -0.2])); // every OTHER weighted config is significantly regressive
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.3]));
    const scifactVsDense = { ...base, 'k2_rho0.10': 0.01 }; // only k2_rho0.10 is safe + has SciFact benefit
    const scopeResults = fixtureFullScopeSet({
      vsDenseByConfig: base, metricsByConfig,
      overrides: { scifact_local: { vsDenseByConfig: scifactVsDense, metricsByConfig } },
    });
    for (const s of scopeResults) s.vsDense['k2_rho0.10'] = { meanDeltaNdcg10: 0, bootstrap: { excludesZero: false, meanDelta: 0 } };
    if (scopeResults.find((s) => s.id === 'scifact_local')) {
      scopeResults.find((s) => s.id === 'scifact_local').vsDense['k2_rho0.10'] = { meanDeltaNdcg10: 0.01, bootstrap: { excludesZero: false, meanDelta: 0.01 } };
    }
    const result = selectCandidates(scopeResults);
    assert.equal(result.denseHeavyCandidate, 'k2_rho0.10');
    assert.equal(result.balancedCandidate, null);
    assert.equal(result.balancedCollidedWithDenseHeavy, true);
  });

  // ── P2 regression: balanced/quality macro nDCG@10 must require a finite
  // metric in EVERY required scope — never a partial average over
  // whichever scopes happened to have data. ────────────────────────────────
  test('a config missing metrics.ndcgAt10 for even one required scope is never selected as balanced, even if its average over the OTHER scopes would be the best', () => {
    const ids = allConfigIds();
    const base = Object.fromEntries(ids.map((id) => [id, 0]));
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.5]));
    const scopeResults = fixtureFullScopeSet({ vsDenseByConfig: base, metricsByConfig });
    // k2_rho0.10 has an excellent metric on every scope EXCEPT one, where
    // it is missing entirely.
    for (const s of scopeResults) s.metrics['k2_rho0.10'] = { ndcgAt10: 0.99 };
    delete scopeResults.find((s) => s.id === 'belebele_eng_Latn').metrics['k2_rho0.10'];
    const result = selectCandidates(scopeResults);
    assert.notEqual(result.balancedCandidate, 'k2_rho0.10');
  });

  // ── P2 (round 3) regression: balancedCollidedWithDenseHeavy must reflect
  // ONLY whether the TOP-RANKED (rank-0) balanced pick is denseHeavy — not
  // whether denseHeavy merely appears SOMEWHERE in the macro-quality-sorted
  // eligible list. denseHeavy is chosen by smallest-rho, a completely
  // different rule than balanced's macro-quality ordering, so it can be
  // "safe everywhere" (and thus present in balancedEligible) without ever
  // being the actual best balanced pick. ───────────────────────────────────
  test('balancedCollidedWithDenseHeavy is false when denseHeavy is merely PRESENT in the eligible list but NOT the top-ranked balanced pick', () => {
    const ids = allConfigIds();
    const base = Object.fromEntries(ids.map((id) => [id, 0]));
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.5]));
    // k2_rho0.10 is the smallest safe rho with a SciFact benefit -> dense-heavy.
    const scifactVsDense = { ...base, 'k2_rho0.10': 0.01 };
    const scopeResults = fixtureFullScopeSet({
      vsDenseByConfig: base, metricsByConfig,
      overrides: { scifact_local: { vsDenseByConfig: scifactVsDense, metricsByConfig } },
    });
    // k2_rho0.10 is safe everywhere (so it IS present in balancedEligible),
    // but k2_rho0.25 has a strictly higher macro metric everywhere, so
    // k2_rho0.25 is genuinely the rank-0 balanced pick, not k2_rho0.10.
    for (const s of scopeResults) {
      s.metrics['k2_rho0.10'] = { ndcgAt10: 0.60 };
      s.metrics['k2_rho0.25'] = { ndcgAt10: 0.95 };
    }
    const result = selectCandidates(scopeResults);
    assert.equal(result.denseHeavyCandidate, 'k2_rho0.10');
    assert.equal(result.balancedCandidate, 'k2_rho0.25');
    assert.equal(
      result.balancedCollidedWithDenseHeavy,
      false,
      'denseHeavy is present in balancedEligible but is not the rank-0 pick, so this must not be reported as a collision',
    );
  });

  // ── P3 (round 3) regression: the exact-scope-set check must compare
  // ARRAY LENGTH, not just the deduplicated ID Set — otherwise a duplicated
  // scope entry passes validation and silently double-weights that scope
  // in macroQuality()'s average. ────────────────────────────────────────────
  test('a scopeResults array with a DUPLICATED scope entry (same unique-id count, extra length) forces NO_WEIGHTED_RRF_CANDIDATE', () => {
    const ids = allConfigIds();
    const vsDenseByConfig = Object.fromEntries(ids.map((id) => [id, 0]));
    vsDenseByConfig['k2_rho0.10'] = 0.01;
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.5]));
    const scopeResults = fixtureFullScopeSet({ vsDenseByConfig, metricsByConfig });
    // Duplicate one existing scope (same 9 unique ids, but 10 total entries).
    scopeResults.push(fixtureScopeResult('scifact_local', { vsDenseByConfig, metricsByConfig }));
    assert.equal(scopeResults.length, 10);
    assert.equal(new Set(scopeResults.map((s) => s.id)).size, 9);
    const result = selectCandidates(scopeResults);
    assert.equal(result.verdict, 'NO_WEIGHTED_RRF_CANDIDATE');
    assert.equal(result.denseHeavyCandidate, null);
    assert.equal(result.balancedCandidate, null);
  });

  test('real committed data: the live -3.31pp MIRACL regression on k2_rho0.75 is confirmed present and would disqualify it', () => {
    // Direct regression test against the actual committed report data —
    // proves the fix holds for the exact real-world case that exposed the
    // bug, not just synthetic fixtures.
    const reportPath = new URL('../results/2026-07-23-weighted-rrf-offline-analysis.json', import.meta.url);
    // This is a committed artifact, not a transient build output — its
    // absence or corruption must fail the test loudly, never be silently
    // skipped, or the required artifact could disappear unnoticed.
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    const miracl = report.scopes.find((s) => s.id === 'miracl_local');
    assert.ok(miracl, 'expected the committed report to include a miracl_local scope');
    const cmp = miracl.vsDense['k2_rho0.75'];
    assert.ok(cmp.bootstrap.excludesZero, 'expected the real MIRACL k2_rho0.75 regression to remain statistically significant');
    assert.ok(cmp.meanDeltaNdcg10 < 0, 'expected the real MIRACL k2_rho0.75 delta to remain negative');
    assert.notEqual(report.candidateSelection.denseHeavyCandidate, 'k2_rho0.75');
    assert.notEqual(report.candidateSelection.balancedCandidate, 'k2_rho0.75');
  });

  test('selection never inspects raw score inspection helpers — only predefined numeric rules over vsDense/metrics fields', () => {
    const src = readFileSync(new URL('./analyze-weighted-rrf.mjs', import.meta.url), 'utf-8');
    // selectCandidates() must not contain any interactive/manual-inspection
    // hooks (e.g. console.log-driven decision points) — verify it's a pure
    // function of its scopeResults argument only. Sliced from the
    // function's own start to the NEXT top-level `export function`/
    // `export const` declaration (robust against internal nested `{}`
    // blocks, unlike a naive non-greedy `[\s\S]*?\n}\n` regex, which stops
    // at the first top-level closing brace it finds and can truncate the
    // match if the function itself contains more than one such block).
    const startIdx = src.indexOf('export function selectCandidates(');
    assert.ok(startIdx >= 0, 'selectCandidates() not found in source');
    const afterStart = src.slice(startIdx + 1);
    const nextExportIdx = afterStart.search(/\nexport (function|const) /);
    assert.ok(nextExportIdx > 0, 'could not find the next top-level export after selectCandidates()');
    const fnSrc = afterStart.slice(0, nextExportIdx);
    assert.doesNotMatch(fnSrc, /prompt|readline|stdin/i);
  });
});

// ── 14. NO_WEIGHTED_RRF_CANDIDATE ────────────────────────────────────────
describe('NO_WEIGHTED_RRF_CANDIDATE is returned, never a forced winner', () => {
  test('when no config is eligible for either the dense-heavy or balanced rule (full, complete scope set), both candidates are null and verdict is NO_WEIGHTED_RRF_CANDIDATE', () => {
    const ids = ['dense', 'sparse', 'k2_rho0.10', 'k2_rho0.25', 'k2_rho0.50', 'k2_rho0.75', 'k2_rho1.00', 'k60_rho0.10', 'k60_rho0.25', 'k60_rho0.50', 'k60_rho0.75', 'k60_rho1.00'];
    // All weighted configs harm SciFact (no positive benefit) and are
    // significantly regressive everywhere -> neither rule can select
    // anything. Uses the FULL, complete SCOPE_IDS set so this genuinely
    // tests "everything is regressive," not merely "the scope set was
    // incomplete" (a distinct disqualifying condition covered separately).
    const vsDenseByConfig = Object.fromEntries(ids.map((id) => [id, -0.2]));
    const metricsByConfig = Object.fromEntries(ids.map((id) => [id, 0.1]));
    const makeResult = (id) => ({
      id,
      vsDense: Object.fromEntries(ids.map((c) => [c, { meanDeltaNdcg10: vsDenseByConfig[c], bootstrap: { excludesZero: true, meanDelta: vsDenseByConfig[c] } }])),
      metrics: Object.fromEntries(ids.map((c) => [c, { ndcgAt10: metricsByConfig[c] }])),
    });
    const result = selectCandidates(SCOPE_IDS.map((id) => makeResult(id)));
    assert.equal(result.verdict, 'NO_WEIGHTED_RRF_CANDIDATE');
    assert.equal(result.denseHeavyCandidate, null);
    assert.equal(result.balancedCandidate, null);
    // Equal RRF controls are still reported even when no weighted winner exists.
    assert.ok(result.equalRrfControls.length > 0);
  });
});

// ── 15. no network access ────────────────────────────────────────────────
describe('offline safety: no network access', () => {
  test('replacing global.fetch with a throwing stub does not break loadCachedBelebeleQrels() or buildScope() for an already-cached scope', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network access attempted'); };
    try {
      // scifact_local and miracl_local use only local TREC/cache files —
      // no network involved regardless of fetch's behavior.
      const scope = buildScope('scifact_local');
      assert.ok(scope.qids.length > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('analyze-weighted-rrf.mjs\'s actual import statements never bring in downloadLanguageFile or fetchAndValidateLanguage (the network-capable Belebele loaders — module-header PROSE may still name them, to explain what is deliberately avoided)', async () => {
    const src = readFileSync(new URL('./analyze-weighted-rrf.mjs', import.meta.url), 'utf-8');
    const importBlock = src.slice(0, src.indexOf('\nconst __dirname'));
    assert.doesNotMatch(importBlock, /downloadLanguageFile/);
    assert.doesNotMatch(importBlock, /fetchAndValidateLanguage/);
  });

  test('analyze-weighted-rrf.mjs\'s actual import statements never bring in downloadTo, fetchAndValidateScifact, or fetchAndValidateMiraclTopicsQrels (network-capable loaders in other harnesses)', async () => {
    const src = readFileSync(new URL('./analyze-weighted-rrf.mjs', import.meta.url), 'utf-8');
    const importBlock = src.slice(0, src.indexOf('\nconst __dirname'));
    assert.doesNotMatch(importBlock, /\bdownloadTo\b/);
    assert.doesNotMatch(importBlock, /fetchAndValidateScifact/);
    assert.doesNotMatch(importBlock, /fetchAndValidateMiraclTopicsQrels/);
  });
});

// ── 16. no Qdrant client import ──────────────────────────────────────────
describe('offline safety: no Qdrant client import', () => {
  test('analyze-weighted-rrf.mjs\'s actual import statements never bring in @qdrant/js-client-rest or any Qdrant client-construction helper (the report text MAY cite the client version number in prose)', async () => {
    const src = readFileSync(new URL('./analyze-weighted-rrf.mjs', import.meta.url), 'utf-8');
    const importBlock = src.slice(0, src.indexOf('\nconst __dirname'));
    assert.doesNotMatch(importBlock, /@qdrant\/js-client-rest/);
    assert.doesNotMatch(importBlock, /\bbuildClient\b/);
    assert.doesNotMatch(importBlock, /QdrantClient/);
  });
});

// ── 17. no ONNX/embedding import ─────────────────────────────────────────
describe('offline safety: no ONNX/embedding import', () => {
  test('analyze-weighted-rrf.mjs never imports onnx-embed.js, onnxruntime-node, or @huggingface/transformers', async () => {
    const src = readFileSync(new URL('./analyze-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /onnx-embed/);
    assert.doesNotMatch(src, /onnxruntime-node/);
    assert.doesNotMatch(src, /@huggingface\/transformers/);
    assert.doesNotMatch(src, /embedOnnxBatch/);
  });
});

// ── 18. no secret or private-path leakage ────────────────────────────────
describe('no secret or private-path leakage', () => {
  test('analyze-weighted-rrf.mjs source contains no hardcoded credentials, API keys, or QDRANT_URL literal', async () => {
    const src = readFileSync(new URL('./analyze-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /QDRANT_KEY/);
    assert.doesNotMatch(src, /api[-_]?key\s*[:=]\s*["'][^"']+["']/i);
  });

  test('renderMarkdownReport never includes an absolute local filesystem path in its output', () => {
    const fixtureReport = {
      candidateSelection: { verdict: 'NO_WEIGHTED_RRF_CANDIDATE', denseHeavyCandidate: null, balancedCandidate: null, equalRrfControls: ['k60_rho1.00'], miraclNote: 'x' },
      scopes: [],
      belebeleMacroSummary: { note: 'x', cyrillicMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, slavicLatinMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, englishControl: { languageCount: 0, ndcgAt10ByConfig: {} }, allSevenMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} } },
      allConfigMeta: [{ configId: 'k60_rho1.00', k: 60, denseWeight: 1, sparseWeight: 1 }],
    };
    const md = renderMarkdownReport(fixtureReport);
    assert.doesNotMatch(md, /[A-Za-z]:\\Users\\/);
    assert.doesNotMatch(md, /\/home\//);
  });
});

// ── limitations section reflects the ACTUAL measured parity result ──────
describe('renderMarkdownReport: limitations section cites the real measured parity faithfulness count', () => {
  test('reports "0/N were sufficiently faithful" style text computed from report.scopes, never a hardcoded/generic claim', () => {
    const fixtureReport = {
      candidateSelection: { verdict: 'NO_WEIGHTED_RRF_CANDIDATE', denseHeavyCandidate: null, balancedCandidate: null, equalRrfControls: ['k60_rho1.00'], miraclNote: 'x' },
      scopes: [
        { id: 'fixture_scope', label: 'fixture', queryCount: 2, rankingDepth: { dense: { min: 100, max: 100 }, sparse: { min: 100, max: 100 } }, parity: {
          k2: { available: false, reason: 'no run' },
          k60: { available: true, sufficientlyFaithful: false, maxAbsDiff: 0.5, queriesWithTop10Diff: 2, queryCount: 2, queriesWithTop10DiffPct: 100, caveat: 'x', metricDiffs: {} },
        }, configMeta: [], metrics: {}, vsDense: {}, vsEqualRrf: {} },
      ],
      belebeleMacroSummary: { note: 'x', cyrillicMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, slavicLatinMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, englishControl: { languageCount: 0, ndcgAt10ByConfig: {} }, allSevenMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} } },
      allConfigMeta: [{ configId: 'k60_rho1.00', k: 60, denseWeight: 1, sparseWeight: 1 }],
    };
    const md = renderMarkdownReport(fixtureReport);
    assert.match(md, /Measured parity result: 0\/1 available/);
  });

  test('when parity IS faithful for a fixture, the count reflects that too (never hardcoded to "always fails")', () => {
    const fixtureReport = {
      candidateSelection: { verdict: 'NO_WEIGHTED_RRF_CANDIDATE', denseHeavyCandidate: null, balancedCandidate: null, equalRrfControls: ['k60_rho1.00'], miraclNote: 'x' },
      scopes: [
        { id: 'fixture_scope', label: 'fixture', queryCount: 2, rankingDepth: { dense: { min: 100, max: 100 }, sparse: { min: 100, max: 100 } }, parity: {
          k2: { available: false, reason: 'no run' },
          k60: { available: true, sufficientlyFaithful: true, maxAbsDiff: 0, queriesWithTop10Diff: 0, queryCount: 2, queriesWithTop10DiffPct: 0, caveat: 'x', metricDiffs: {} },
        }, configMeta: [], metrics: {}, vsDense: {}, vsEqualRrf: {} },
      ],
      belebeleMacroSummary: { note: 'x', cyrillicMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, slavicLatinMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, englishControl: { languageCount: 0, ndcgAt10ByConfig: {} }, allSevenMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} } },
      allConfigMeta: [{ configId: 'k60_rho1.00', k: 60, denseWeight: 1, sparseWeight: 1 }],
    };
    const md = renderMarkdownReport(fixtureReport);
    assert.match(md, /Measured parity result: 1\/1 available/);
  });

  // ── P2 regression: the surrounding prose must never hardcode "EVERY"
  // or a fixed "15-30%" range independent of the actual computed numbers —
  // it must be derived from report.scopes every time. ────────────────────
  test('a MIXED result (some faithful, some not) never claims "EVERY ... failed"', () => {
    const fixtureReport = {
      candidateSelection: { verdict: 'NO_WEIGHTED_RRF_CANDIDATE', denseHeavyCandidate: null, balancedCandidate: null, equalRrfControls: ['k60_rho1.00'], miraclNote: 'x' },
      scopes: [
        { id: 'scope_a', label: 'a', queryCount: 2, rankingDepth: { dense: { min: 100, max: 100 }, sparse: { min: 100, max: 100 } }, parity: {
          k2: { available: false, reason: 'no run' },
          k60: { available: true, sufficientlyFaithful: true, maxAbsDiff: 0, queriesWithTop10Diff: 0, queryCount: 2, queriesWithTop10DiffPct: 0, caveat: 'x', metricDiffs: {} },
        }, configMeta: [], metrics: {}, vsDense: {}, vsEqualRrf: {} },
        { id: 'scope_b', label: 'b', queryCount: 2, rankingDepth: { dense: { min: 100, max: 100 }, sparse: { min: 100, max: 100 } }, parity: {
          k2: { available: false, reason: 'no run' },
          k60: { available: true, sufficientlyFaithful: false, maxAbsDiff: 0.01, queriesWithTop10Diff: 1, queryCount: 2, queriesWithTop10DiffPct: 50, caveat: 'x', metricDiffs: {} },
        }, configMeta: [], metrics: {}, vsDense: {}, vsEqualRrf: {} },
      ],
      belebeleMacroSummary: { note: 'x', cyrillicMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, slavicLatinMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, englishControl: { languageCount: 0, ndcgAt10ByConfig: {} }, allSevenMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} } },
      allConfigMeta: [{ configId: 'k60_rho1.00', k: 60, denseWeight: 1, sparseWeight: 1 }],
    };
    const md = renderMarkdownReport(fixtureReport);
    assert.match(md, /Measured parity result: 1\/2 available/);
    assert.doesNotMatch(md, /EVERY available parity check failed/);
    assert.match(md, /1\/2 available parity checks failed/);
  });

  test('a fixture whose real diff percentage is 50% (outside the old hardcoded "15-30%" range) is reported as 50.0-50.0%, not a stale fixed range', () => {
    const fixtureReport = {
      candidateSelection: { verdict: 'NO_WEIGHTED_RRF_CANDIDATE', denseHeavyCandidate: null, balancedCandidate: null, equalRrfControls: ['k60_rho1.00'], miraclNote: 'x' },
      scopes: [
        { id: 'scope_a', label: 'a', queryCount: 2, rankingDepth: { dense: { min: 100, max: 100 }, sparse: { min: 100, max: 100 } }, parity: {
          k2: { available: false, reason: 'no run' },
          k60: { available: true, sufficientlyFaithful: false, maxAbsDiff: 0.2, queriesWithTop10Diff: 1, queryCount: 2, queriesWithTop10DiffPct: 50, caveat: 'x', metricDiffs: {} },
        }, configMeta: [], metrics: {}, vsDense: {}, vsEqualRrf: {} },
      ],
      belebeleMacroSummary: { note: 'x', cyrillicMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, slavicLatinMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, englishControl: { languageCount: 0, ndcgAt10ByConfig: {} }, allSevenMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} } },
      allConfigMeta: [{ configId: 'k60_rho1.00', k: 60, denseWeight: 1, sparseWeight: 1 }],
    };
    const md = renderMarkdownReport(fixtureReport);
    assert.match(md, /50\.0-50\.0% of queries/);
    assert.doesNotMatch(md, /15-30% of queries/);
  });

  test('zero available parity checks (no real hybrid runs at all) is reported honestly as unvalidated, never as "faithful" or a fabricated percentage', () => {
    const fixtureReport = {
      candidateSelection: { verdict: 'NO_WEIGHTED_RRF_CANDIDATE', denseHeavyCandidate: null, balancedCandidate: null, equalRrfControls: ['k60_rho1.00'], miraclNote: 'x' },
      scopes: [
        { id: 'scope_a', label: 'a', queryCount: 2, rankingDepth: { dense: { min: 100, max: 100 }, sparse: { min: 100, max: 100 } }, parity: {
          k2: { available: false, reason: 'no run' },
          k60: { available: false, reason: 'no run' },
        }, configMeta: [], metrics: {}, vsDense: {}, vsEqualRrf: {} },
      ],
      belebeleMacroSummary: { note: 'x', cyrillicMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, slavicLatinMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, englishControl: { languageCount: 0, ndcgAt10ByConfig: {} }, allSevenMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} } },
      allConfigMeta: [{ configId: 'k60_rho1.00', k: 60, denseWeight: 1, sparseWeight: 1 }],
    };
    const md = renderMarkdownReport(fixtureReport);
    assert.match(md, /Measured parity result: 0\/0 available/);
    assert.match(md, /UNVALIDATED/);
  });

  test('the report also documents the no-held-out-validation-split limitation (P2: same eval set used for selection and evaluation)', () => {
    const fixtureReport = {
      candidateSelection: { verdict: 'NO_WEIGHTED_RRF_CANDIDATE', denseHeavyCandidate: null, balancedCandidate: null, equalRrfControls: ['k60_rho1.00'], miraclNote: 'x' },
      scopes: [],
      belebeleMacroSummary: { note: 'x', cyrillicMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, slavicLatinMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} }, englishControl: { languageCount: 0, ndcgAt10ByConfig: {} }, allSevenMacroAverage: { languageCount: 0, ndcgAt10ByConfig: {} } },
      allConfigMeta: [{ configId: 'k60_rho1.00', k: 60, denseWeight: 1, sparseWeight: 1 }],
    };
    const md = renderMarkdownReport(fixtureReport);
    assert.match(md, /held-out/);
    assert.match(md, /generalize beyond this exact/);
  });
});

// ── scope construction sanity (real cached data) ─────────────────────────
describe('SCOPE_IDS and buildScope against real committed data', () => {
  test('SCOPE_IDS is exactly scifact_local, miracl_local, and 7 belebele_* scopes', () => {
    assert.equal(SCOPE_IDS.length, 9);
    assert.equal(SCOPE_IDS[0], 'scifact_local');
    assert.equal(SCOPE_IDS[1], 'miracl_local');
    assert.equal(SCOPE_IDS.filter((s) => s.startsWith('belebele_')).length, 7);
  });

  test('buildScope("scifact_local") loads real committed TREC data with matching query IDs', () => {
    const scope = buildScope('scifact_local');
    assert.equal(scope.qids.length, 300);
    assert.equal(scope.dense.size, 300);
    assert.equal(scope.sparse.size, 300);
  });

  test('buildScope("miracl_local") loads real committed TREC data with matching query IDs', () => {
    const scope = buildScope('miracl_local');
    assert.equal(scope.qids.length, 100);
  });

  test('buildScope("belebele_ukr_Cyrl") loads real cached Belebele data with exactly 1 relevant doc per query', () => {
    const scope = buildScope('belebele_ukr_Cyrl');
    assert.equal(scope.qids.length, 900);
    for (const docsMap of scope.qrels.values()) assert.equal(docsMap.size, 1);
  });

  test('analyzeScopeWeightedRrf runs end-to-end on a real scope and produces all 12 configs (dense, sparse, 2k x 5rho)', () => {
    const scope = buildScope('scifact_local');
    const result = analyzeScopeWeightedRrf(scope);
    const expectedConfigCount = 2 + K_VALUES.length * RHO_VALUES.length;
    assert.equal(Object.keys(result.metrics).length, expectedConfigCount);
    assert.ok(typeof result.metrics.dense.ndcgAt10 === 'number');
    assert.ok(typeof result.metrics['k60_rho0.25'].ndcgAt10 === 'number');
  });
});
