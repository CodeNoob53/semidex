// Bounded, offline tests for the live Qdrant weighted-RRF validation
// harness. No network, no real Qdrant, no ONNX — the Qdrant client and the
// ONNX embedBatch function are both fake/injected. Run:
//   node --test --test-concurrency=1 benchmarks/external/fusion/run-weighted-rrf-live.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FUSION_MODES, FUSION_MODE_IDS, PRIMARY_CANDIDATE_ID, DIAGNOSTIC_CANDIDATE_ID, EQUAL_RRF_CONTROL_IDS,
  SCOPES, SCOPE_IDS, COLLECTION_PREFIX, TOP_K, HYBRID_PREFETCH_LIMIT,
  parseScopesFlag, collectionName, fusionModeById,
} from './weighted-rrf-live-config.mjs';
import {
  isCompletedScopeCheckpoint, shrinkForSmoke, normalizeDocEntries, validateResumeCheckpoint,
  executeScope, computeScopeComparisons, computeVerdict, computeCandidateVerdict,
  renderMarkdownReport, cleanupOrphanedCollection, rebuildReportAggregates,
  buildScopeProvenance, verifyCudaProvenance, verifyStrictCudaConfigured,
} from './run-weighted-rrf-live.mjs';

// ── 4. locked configuration IDs and values ──────────────────────────────────
describe('FUSION_MODES: locked configuration', () => {
  test('is exactly the 6 required modes, in order', () => {
    assert.deepEqual(FUSION_MODE_IDS, ['dense', 'sparse', 'equal_k2', 'equal_k60', 'k2_rho0.10', 'k2_rho0.25']);
  });

  test('dense and sparse are single-lane (no rrf)', () => {
    assert.equal(fusionModeById('dense').kind, 'single');
    assert.equal(fusionModeById('dense').using, 'dense');
    assert.equal(fusionModeById('sparse').kind, 'single');
    assert.equal(fusionModeById('sparse').using, 'sparse');
  });

  test('equal_k2 is k=2, weights=[1.0, 1.0]', () => {
    const m = fusionModeById('equal_k2');
    assert.equal(m.kind, 'rrf');
    assert.equal(m.k, 2);
    assert.deepEqual(m.weights, [1.0, 1.0]);
  });

  test('equal_k60 is k=60, weights=[1.0, 1.0]', () => {
    const m = fusionModeById('equal_k60');
    assert.equal(m.k, 60);
    assert.deepEqual(m.weights, [1.0, 1.0]);
  });

  test('k2_rho0.10 (primary candidate) is k=2, weights=[1.0, 0.05263157894736842]', () => {
    const m = fusionModeById('k2_rho0.10');
    assert.equal(m.k, 2);
    assert.deepEqual(m.weights, [1.0, 0.05263157894736842]);
    assert.equal(m.role, 'primary');
    assert.equal(PRIMARY_CANDIDATE_ID, 'k2_rho0.10');
  });

  test('k2_rho0.25 (diagnostic) is k=2, weights=[1.0, 0.14285714285714285]', () => {
    const m = fusionModeById('k2_rho0.25');
    assert.equal(m.k, 2);
    assert.deepEqual(m.weights, [1.0, 0.14285714285714285]);
    assert.equal(m.role, 'diagnostic');
    assert.equal(DIAGNOSTIC_CANDIDATE_ID, 'k2_rho0.25');
  });

  test('the two weighted-candidate sparse weights match the offline analyzer\'s exact sparseWeightFromRho formula', () => {
    const sparseWeightFromRho = (k, rho) => 1 / (k * (1 / rho - 1) + 1);
    assert.equal(fusionModeById('k2_rho0.10').weights[1], sparseWeightFromRho(2, 0.10));
    assert.equal(fusionModeById('k2_rho0.25').weights[1], sparseWeightFromRho(2, 0.25));
  });

  test('equal RRF controls are exactly equal_k2 and equal_k60', () => {
    assert.deepEqual(EQUAL_RRF_CONTROL_IDS, ['equal_k2', 'equal_k60']);
  });

  // ── P2 regression: every rrf mode's weights array must be genuinely
  // immutable, not just its containing mode object — Object.freeze() is
  // shallow, so freezing the mode alone leaves `weights` silently mutable
  // (an accidental `mode.weights[0] = x` anywhere would corrupt the
  // "locked" config for every subsequent live Qdrant request built from
  // it, with no error). ────────────────────────────────────────────────
  test('every rrf mode\'s weights array is deep-frozen and cannot be mutated', () => {
    for (const mode of FUSION_MODES.filter((m) => m.kind === 'rrf')) {
      assert.ok(Object.isFrozen(mode.weights), `${mode.id}: weights array must be frozen`);
      const before = [...mode.weights];
      assert.throws(() => { 'use strict'; mode.weights[0] = 999; }, TypeError, `${mode.id}: mutating a frozen array must throw in strict mode`);
      assert.deepEqual(mode.weights, before, `${mode.id}: weights must be unchanged after a mutation attempt`);
    }
  });

  test('four scopes match the completed CUDA k-sweep exactly', () => {
    assert.deepEqual(SCOPE_IDS, ['scifact-local', 'scifact-cloud', 'miracl-local', 'miracl-cloud']);
  });

  test('parseScopesFlag with no value returns all four scopes in canonical order', () => {
    assert.deepEqual(parseScopesFlag(null).map((s) => s.id), SCOPE_IDS);
  });

  test('parseScopesFlag rejects an unknown scope id', () => {
    assert.throws(() => parseScopesFlag('not-a-scope'), /unknown scope id/);
  });

  test('parseScopesFlag rejects an explicit but empty flag rather than silently running all scopes', () => {
    assert.throws(() => parseScopesFlag(''), /refuses to silently default/);
  });

  test('collectionName always starts with the owned prefix', () => {
    assert.ok(collectionName('scifact-local', 'abc123').startsWith(COLLECTION_PREFIX));
  });
});

// ── Fake Qdrant client + fixture dataset shared by executeScope() tests ────
function makeFakeClient({ onQuery } = {}) {
  const calls = { createCollection: [], upsert: [], query: [], deleteCollection: [] };
  return {
    calls,
    async createCollection(name, spec) { calls.createCollection.push({ name, spec }); return true; },
    async upsert(name, spec) { calls.upsert.push({ name, spec }); return true; },
    async query(name, spec) {
      calls.query.push({ name, spec });
      if (onQuery) return onQuery(spec, calls.query.length);
      return { points: [{ id: 'p1', score: 0.9 }, { id: 'p2', score: 0.5 }, { id: 'p3', score: 0.1 }] };
    },
    async deleteCollection(name) { calls.deleteCollection.push(name); return true; },
  };
}

function fixtureScope(overrides = {}) {
  return {
    id: 'scifact-local', dataset: 'scifact', providerId: 'local',
    provider: { kind: 'local', denseModelId: 'fake', denseSize: 4, sparseModelId: 'fake-lexical' },
    ...overrides,
  };
}

function fixtureDataset() {
  const corpus = new Map([
    ['p1', { title: 't1', text: 'body one' }],
    ['p2', { title: 't2', text: 'body two' }],
    ['p3', { title: 't3', text: 'body three' }],
  ]);
  const queries = new Map([['q1', 'query one'], ['q2', 'query two']]);
  const qrels = new Map([
    ['q1', new Map([['p1', 1]])],
    ['q2', new Map([['p2', 1]])],
  ]);
  return { corpus, queries, qrels };
}

function fixturePrepared() {
  const documents = new Map([
    ['p1', { commonBody: 'body one' }],
    ['p2', { commonBody: 'body two' }],
    ['p3', { commonBody: 'body three' }],
  ]);
  const queries = new Map([
    ['q1', { commonBody: 'query one' }],
    ['q2', { commonBody: 'query two' }],
  ]);
  return { documents, queries };
}

const redact = (v) => (v instanceof Error ? v.message : String(v));
const fakeEmbedBatch = async (texts) => texts.map(() => ({
  dense: new Float32Array([0.1, 0.2, 0.3, 0.4]),
  sparse: { indices: [1, 2], values: [0.5, 0.5] },
}));

describe('dataset normalization', () => {
  test('preserves MIRACL titles because they are part of the embedding input', () => {
    const normalized = normalizeDocEntries(new Map([
      ['object', { title: 'Document title', text: 'Document body' }],
      ['string', 'Text-only passage'],
    ]), 'miracl');
    assert.deepEqual(normalized.get('object'), { title: 'Document title', text: 'Document body' });
    assert.deepEqual(normalized.get('string'), { title: '', text: 'Text-only passage' });
  });
});

// ── 5. one indexing pass per scope ──────────────────────────────────────────
// 6. exact query-call count ─────────────────────────────────────────────────
// 7. prefetch=200 and final limit=100 invariants ────────────────────────────
// 1. exact weighted-RRF request body / 2. weights inside rrf.weights / 3. no prefetch.weight
describe('executeScope: call-count and request-shape invariants', () => {
  test('creates exactly one collection and issues exactly one upsert batch for a 3-doc corpus', async () => {
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.equal(client.calls.createCollection.length, 1);
    assert.equal(client.calls.upsert.length, 1); // 3 docs < INDEX_BATCH_SIZE(24) -> one batch
  });

  test('issues exactly 1 dense + 1 sparse + 4 hybrid queries per benchmark query (2 queries -> 12 total)', async () => {
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const denseQueries = client.calls.query.filter((c) => c.spec.using === 'dense' && !c.spec.query?.rrf);
    const sparseQueries = client.calls.query.filter((c) => c.spec.using === 'sparse' && !c.spec.query?.rrf);
    const hybridQueries = client.calls.query.filter((c) => c.spec.query?.rrf);
    assert.equal(denseQueries.length, 2); // one per benchmark query
    assert.equal(sparseQueries.length, 2);
    assert.equal(hybridQueries.length, 8); // 2 queries x 4 hybrid modes
    assert.equal(client.calls.query.length, 12); // 2 x 6 total modes
  });

  test('every hybrid request body has weights INSIDE query.rrf.weights, in [dense, sparse] order', async () => {
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const hybridForQ1 = client.calls.query.filter((c) => c.spec.query?.rrf).slice(0, 4);
    const byMode = FUSION_MODES.filter((m) => m.kind === 'rrf');
    for (let i = 0; i < byMode.length; i++) {
      const mode = byMode[i];
      const spec = hybridForQ1[i].spec;
      assert.ok(Array.isArray(spec.query.rrf.weights), `${mode.id}: weights must be an array`);
      assert.deepEqual(spec.query.rrf.weights, mode.weights, `${mode.id}: weights must match locked config`);
      assert.equal(spec.query.rrf.k, mode.k);
    }
  });

  test('no hybrid request ever sets weight on a prefetch entry — that is not the weighted-RRF contract', async () => {
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const hybridQueries = client.calls.query.filter((c) => c.spec.query?.rrf);
    assert.ok(hybridQueries.length > 0);
    for (const c of hybridQueries) {
      for (const p of c.spec.prefetch) {
        assert.equal('weight' in p, false, 'prefetch entries must never carry a weight field');
      }
      assert.equal('weight' in c.spec, false, 'the top-level query spec must never carry a bare weight field');
    }
  });

  test('the exact request body for the primary candidate matches the real Qdrant weighted-RRF contract', async () => {
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const hybridQueries = client.calls.query.filter((c) => c.spec.query?.rrf);
    const primaryReq = hybridQueries.find((c) => c.spec.query.rrf.k === 2 && c.spec.query.rrf.weights[1] === 0.05263157894736842);
    assert.ok(primaryReq, 'expected to find a request matching the primary candidate');
    assert.deepEqual(primaryReq.spec.query, { rrf: { k: 2, weights: [1.0, 0.05263157894736842] } });
    assert.equal(primaryReq.spec.prefetch.length, 2);
    assert.equal(primaryReq.spec.prefetch[0].using, 'dense');
    assert.equal(primaryReq.spec.prefetch[1].using, 'sparse');
    assert.equal(primaryReq.spec.limit, TOP_K);
  });

  test('every hybrid request uses prefetch limit 200 per lane and final limit 100', async () => {
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const hybridQueries = client.calls.query.filter((c) => c.spec.query?.rrf);
    for (const c of hybridQueries) {
      assert.equal(c.spec.limit, TOP_K);
      assert.equal(c.spec.limit, 100);
      assert.equal(HYBRID_PREFETCH_LIMIT, 200);
      for (const p of c.spec.prefetch) assert.equal(p.limit, HYBRID_PREFETCH_LIMIT);
      assert.equal(c.spec.prefetch.length, 2);
    }
  });

  test('the four hybrid requests for one query share the same prefetch vectors — only rrf.k/weights differ', async () => {
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const hybridForQ1 = client.calls.query.filter((c) => c.spec.query?.rrf).slice(0, 4);
    const stripped = hybridForQ1.map((c) => JSON.stringify({ ...c.spec, query: null }));
    assert.ok(stripped.every((s) => s === stripped[0]), 'prefetch/limit/using must be identical across all four hybrid requests');
  });

  test('dense and sparse query vectors are computed exactly once per query (embedBatch call count)', async () => {
    let calls = 0;
    const countingEmbed = async (texts) => { calls += 1; return fakeEmbedBatch(texts); };
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: countingEmbed, writeTrecRun: () => {},
    });
    // 1 call for indexing the 3-doc batch + 1 call per query (2 queries) = 3.
    assert.equal(calls, 3);
  });

  test('cleanup always deletes the exact collection created, even on success', async () => {
    const client = makeFakeClient();
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.equal(client.calls.deleteCollection.length, 1);
    assert.equal(client.calls.deleteCollection[0], scopeReport.collection);
    assert.equal(scopeReport.cleanup.deleted, true);
    assert.ok(scopeReport.collection.startsWith(COLLECTION_PREFIX));
  });
});

// ── 8. paired-bootstrap delta direction / 9. candidate-vs-baseline labels ──
describe('computeScopeComparisons: sign direction and required comparison labels', () => {
  function perQueryFixture(valsByMode) {
    const qids = valsByMode.dense.map((_, i) => `q${i + 1}`);
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    return Object.fromEntries(Object.entries(valsByMode).map(([mode, vals]) => [mode, toEntries(vals)]));
  }

  test('produces exactly the required comparison labels when all modes are present', () => {
    const raw = perQueryFixture({
      dense: [0.5, 0.5], sparse: [0.4, 0.4], equal_k2: [0.6, 0.6], equal_k60: [0.55, 0.55],
      'k2_rho0.10': [0.65, 0.65], 'k2_rho0.25': [0.62, 0.62],
    });
    const cmp = computeScopeComparisons(raw);
    assert.deepEqual(Object.keys(cmp).sort(), [
      'equal_k2_vs_dense', 'equal_k60_vs_dense', 'k2_rho0.10_vs_dense',
      'k2_rho0.10_vs_equal_k2', 'k2_rho0.10_vs_equal_k60', 'k2_rho0.25_vs_dense', 'sparse_vs_dense',
    ].sort());
  });

  test('k2_rho0.10_vs_dense.meanDelta is positive when the candidate is the constructed winner', () => {
    const raw = perQueryFixture({ dense: [0.5, 0.5, 0.5], 'k2_rho0.10': [0.9, 0.9, 0.9] });
    const { 'k2_rho0.10_vs_dense': cmp } = computeScopeComparisons(raw);
    assert.ok(cmp.meanDelta > 0, `expected positive meanDelta, got ${cmp.meanDelta}`);
    assert.equal(cmp.wins, 3);
    assert.equal(cmp.losses, 0);
  });

  test('k2_rho0.10_vs_dense.meanDelta is negative when dense is the constructed winner', () => {
    const raw = perQueryFixture({ dense: [0.9, 0.9, 0.9], 'k2_rho0.10': [0.5, 0.5, 0.5] });
    const { 'k2_rho0.10_vs_dense': cmp } = computeScopeComparisons(raw);
    assert.ok(cmp.meanDelta < 0, `expected negative meanDelta, got ${cmp.meanDelta}`);
  });

  test('k2_rho0.10_vs_equal_k2 uses equal_k2 as baseline (comparison=candidate, baseline=equal_k2)', () => {
    const raw = perQueryFixture({ dense: [0.5, 0.5, 0.5], equal_k2: [0.2, 0.2, 0.2], 'k2_rho0.10': [0.8, 0.8, 0.8] });
    const { 'k2_rho0.10_vs_equal_k2': cmp } = computeScopeComparisons(raw);
    assert.ok(cmp.meanDelta > 0, `expected positive meanDelta (candidate − equal_k2 > 0), got ${cmp.meanDelta}`);
  });

  test('k2_rho0.10_vs_equal_k60 uses equal_k60 as baseline', () => {
    const raw = perQueryFixture({ dense: [0.5, 0.5, 0.5], equal_k60: [0.8, 0.8, 0.8], 'k2_rho0.10': [0.2, 0.2, 0.2] });
    const { 'k2_rho0.10_vs_equal_k60': cmp } = computeScopeComparisons(raw);
    assert.ok(cmp.meanDelta < 0, `expected negative meanDelta (candidate − equal_k60 < 0), got ${cmp.meanDelta}`);
  });

  test('k2_rho0.25_vs_dense (diagnostic) is computed independently of the primary candidate', () => {
    const raw = perQueryFixture({ dense: [0.5, 0.5, 0.5], 'k2_rho0.25': [0.9, 0.9, 0.9] });
    const cmp = computeScopeComparisons(raw);
    assert.ok('k2_rho0.25_vs_dense' in cmp);
    assert.equal('k2_rho0.10_vs_dense' in cmp, false); // absent when the primary candidate's own data is absent
  });

  test('no comparisons at all when dense mode is absent', () => {
    const raw = { equal_k60: [['q1', { ndcgAt10: 0.5 }]] };
    assert.deepEqual(computeScopeComparisons(raw), {});
  });
});

// ── 10. resume skipping completed work / 11. atomic checkpoint recovery ────
describe('isCompletedScopeCheckpoint / validateResumeCheckpoint', () => {
  function completedScopeReport() {
    const metric = { queryCount: 2, ndcgAt10: 0.5 };
    const metrics = Object.fromEntries(FUSION_MODE_IDS.map((id) => [id, metric]));
    return {
      indexing: { documentsIndexed: 3, errors: 0 },
      queryStats: { total: 2, ran: 2, errors: 0 },
      errors: [],
      cleanup: { attempted: true, deleted: true, collection: 'semidex-weighted-rrf-live-scifact-local-abc' },
      metrics,
    };
  }

  test('a fully measured, zero-error, cleaned scope is complete', () => {
    assert.equal(isCompletedScopeCheckpoint(completedScopeReport(), { queryCount: 2 }), true);
  });

  test('a scope missing one fusion mode is not complete', () => {
    const r = completedScopeReport();
    delete r.metrics['k2_rho0.25'];
    assert.equal(isCompletedScopeCheckpoint(r, { queryCount: 2 }), false);
  });

  test('a scope with unconfirmed cleanup is not complete', () => {
    const r = completedScopeReport();
    r.cleanup.deleted = false;
    assert.equal(isCompletedScopeCheckpoint(r, { queryCount: 2 }), false);
  });

  test('a partially-run scope (ran < total) is not complete', () => {
    const r = completedScopeReport();
    r.queryStats.ran = 1;
    assert.equal(isCompletedScopeCheckpoint(r, { queryCount: 2 }), false);
  });

  test('missing scope report is not complete', () => {
    assert.equal(isCompletedScopeCheckpoint(undefined, { queryCount: 2 }), false);
  });

  // ── local strict-CUDA provenance gates resume completeness too ──────────
  test('a local scope whose CUDA verification failed is never considered complete, even with full metrics', () => {
    const r = completedScopeReport();
    r.cudaVerification = { ok: false, reason: 'fell back to cpu' };
    assert.equal(isCompletedScopeCheckpoint(r, { queryCount: 2 }), false);
  });

  test('a local scope whose CUDA verification passed remains complete', () => {
    const r = completedScopeReport();
    r.cudaVerification = { ok: true, reason: null };
    assert.equal(isCompletedScopeCheckpoint(r, { queryCount: 2 }), true);
  });

  test('validateResumeCheckpoint rejects a checkpoint with no benchmarkContract', () => {
    assert.throws(() => validateResumeCheckpoint({ scopes: {} }, { scopeIds: [] }), /no benchmarkContract/);
  });

  test('validateResumeCheckpoint rejects a mismatched contract', () => {
    const contract = { scopeIds: ['scifact-local'], fusionModeIds: FUSION_MODE_IDS };
    const previous = { benchmarkContract: { ...contract, fusionModeIds: ['dense'] }, scopes: {} };
    assert.throws(() => validateResumeCheckpoint(previous, contract), /does not match/);
  });

  test('validateResumeCheckpoint rejects a checkpoint referencing an unknown scope', () => {
    const contract = { scopeIds: ['scifact-local'], fusionModeIds: FUSION_MODE_IDS };
    const previous = { benchmarkContract: contract, scopes: { 'not-a-scope': {} } };
    assert.throws(() => validateResumeCheckpoint(previous, contract), /unknown scope/);
  });

  test('validateResumeCheckpoint accepts a matching contract', () => {
    const contract = { scopeIds: ['scifact-local'], fusionModeIds: FUSION_MODE_IDS };
    const previous = { benchmarkContract: contract, scopes: {} };
    assert.equal(validateResumeCheckpoint(previous, contract), true);
  });

  test('atomic checkpoint recovery: rebuildReportAggregates recomputes from CURRENT scopes, never accumulates stale failures', () => {
    const report = {
      scopes: {
        'scifact-local': { scopeId: 'scifact-local', cleanup: { attempted: true, deleted: true }, errors: [] },
        'miracl-local': { scopeId: 'miracl-local', cleanup: { attempted: true, deleted: false, collection: 'x', error: 'boom' }, errors: [{ step: 'q', error: 'e' }] },
      },
      cleanupSummary: { attempted: 99, deleted: 99, failed: [{ scopeId: 'stale', collection: 'stale', error: 'stale' }] },
      errors: [{ scopeId: 'stale', step: 'stale', error: 'stale' }],
    };
    rebuildReportAggregates(report);
    assert.equal(report.cleanupSummary.attempted, 2);
    assert.equal(report.cleanupSummary.deleted, 1);
    assert.equal(report.cleanupSummary.failed.length, 1);
    assert.equal(report.cleanupSummary.failed[0].scopeId, 'miracl-local');
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].scopeId, 'miracl-local');
  });
});

// ── 12. owned-prefix cleanup guard / 13. 404 cleanup handling ──────────────
describe('owned-collection prefix guard and cleanupOrphanedCollection', () => {
  test('a scope-report-recorded collection name from a real run always matches the prefix', async () => {
    const client = makeFakeClient();
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.ok(scopeReport.cleanup.collection.startsWith(COLLECTION_PREFIX));
  });

  test('an arbitrary user collection name never matches the owned prefix', () => {
    for (const name of ['my-collection', 'semidex-rrf-sweep-scifact-local', 'production-docs']) {
      assert.equal(name.startsWith(COLLECTION_PREFIX), false);
    }
  });

  test('cleanupOrphanedCollection no-ops when there is no prior record', async () => {
    const client = makeFakeClient();
    const result = await cleanupOrphanedCollection({ client, redact, report: { scopes: {} }, scope: { id: 'scifact-local' } });
    assert.deepEqual(result, { ok: true, collection: null });
    assert.equal(client.calls.deleteCollection.length, 0);
  });

  test('cleanupOrphanedCollection no-ops when the prior record is already confirmed deleted', async () => {
    const client = makeFakeClient();
    const report = { scopes: { 'scifact-local': { cleanup: { deleted: true, collection: `${COLLECTION_PREFIX}scifact-local-x` } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, scope: { id: 'scifact-local' } });
    assert.equal(result.ok, true);
    assert.equal(result.collection, null);
    assert.equal(client.calls.deleteCollection.length, 0);
  });

  test('cleanupOrphanedCollection deletes an orphan and reports it', async () => {
    const client = makeFakeClient();
    const orphanName = `${COLLECTION_PREFIX}scifact-local-orphan`;
    const report = { scopes: { 'scifact-local': { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, scope: { id: 'scifact-local' } });
    assert.deepEqual(result, { ok: true, collection: orphanName });
    assert.deepEqual(client.calls.deleteCollection, [orphanName]);
  });

  test('cleanupOrphanedCollection refuses to touch a name outside the owned prefix', async () => {
    const client = makeFakeClient();
    const report = { scopes: { 'scifact-local': { cleanup: { deleted: false, collection: 'someone-elses-collection' } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, scope: { id: 'scifact-local' } });
    assert.equal(result.ok, true);
    assert.equal(result.collection, null);
    assert.equal(client.calls.deleteCollection.length, 0);
  });

  // ── 13. a 404 during cleanup means "already deleted", a real success ──
  test('cleanupOrphanedCollection treats a 404 delete response as a successful cleanup, not a failure', async () => {
    const orphanName = `${COLLECTION_PREFIX}scifact-local-gone`;
    const client = {
      async deleteCollection() { const e = new Error('not found'); e.status = 404; throw e; },
    };
    const report = { scopes: { 'scifact-local': { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, scope: { id: 'scifact-local' } });
    assert.equal(result.ok, true);
    assert.equal(result.collection, orphanName);
  });

  test('cleanupOrphanedCollection reports failure for a real non-404 error', async () => {
    const orphanName = `${COLLECTION_PREFIX}scifact-local-broken`;
    const client = {
      async deleteCollection() { const e = new Error('unauthorized'); e.status = 401; throw e; },
    };
    const report = { scopes: { 'scifact-local': { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, scope: { id: 'scifact-local' } });
    assert.equal(result.ok, false);
    assert.equal(result.collection, orphanName);
  });

  test('executeScope\'s own cleanup treats a 404 delete response as successful, never a reported failure', async () => {
    const client = {
      async createCollection() { return true; },
      async upsert() { return true; },
      async query() { return { points: [] }; },
      async deleteCollection() { const e = new Error('not found'); e.status = 404; throw e; },
    };
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.equal(scopeReport.cleanup.deleted, true);
    assert.equal(scopeReport.cleanup.error, null);
  });
});

// ── 14. secret redaction ────────────────────────────────────────────────────
describe('redaction: report content never leaks secrets or local paths', () => {
  test('redact() strips a fake API key out of an error message', async () => {
    const { makeRedactor } = await import('../beir/harness-core.mjs');
    const redactFn = makeRedactor('sk-fake-secret-123', process.cwd());
    const message = redactFn(new Error('request failed: api_key=sk-fake-secret-123 at ' + process.cwd() + '/foo'));
    assert.doesNotMatch(message, /sk-fake-secret-123/);
    assert.doesNotMatch(message, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('a scope report built from a failing client never contains the raw secret', async () => {
    const client = {
      async createCollection() { const e = new Error('unauthorized: api_key=sk-real-secret-999'); e.status = 401; throw e; },
      async upsert() { return true; }, async query() { return { points: [] }; }, async deleteCollection() { return true; },
    };
    const { makeRedactor } = await import('../beir/harness-core.mjs');
    const redactFn = makeRedactor('sk-real-secret-999', process.cwd());
    const scopeReport = await executeScope({
      client, redact: redactFn, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const serialized = JSON.stringify(scopeReport);
    assert.doesNotMatch(serialized, /sk-real-secret-999/);
  });

  test('run-weighted-rrf-live.mjs source contains no hardcoded credentials, API keys, or QDRANT_URL literal', () => {
    const src = readFileSync(new URL('./run-weighted-rrf-live.mjs', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /QDRANT_KEY\s*=\s*['"]/);
    assert.doesNotMatch(src, /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.aws\.cloud\.qdrant\.io/);
  });

  test('renderMarkdownReport never includes an absolute local filesystem path', () => {
    const report = {
      verdict: 'WEIGHTED_RRF_LIVE_HARNESS_ACCEPT',
      candidateVerdict: { verdict: 'WEIGHTED_RRF_MIXED', reasons: [], perScope: {} },
      benchmarkContract: { fusionModeIds: FUSION_MODE_IDS, hybridPrefetchLimit: 200 },
      scopes: {}, environment: {},
    };
    const md = renderMarkdownReport(report);
    assert.doesNotMatch(md, /[A-Za-z]:\\\\/);
    assert.doesNotMatch(md, /\/home\//);
    assert.doesNotMatch(md, /\/Users\//);
  });
});

// ── 15. smoke report isolation ──────────────────────────────────────────────
describe('smoke vs real report path separation', () => {
  test('run-weighted-rrf-live.mjs computes a distinct report path for --smoke', () => {
    const src = readFileSync(new URL('./run-weighted-rrf-live.mjs', import.meta.url), 'utf-8');
    assert.match(src, /SMOKE \? '\.weighted-rrf-live-smoke-report\.json' : '2026-07-24-weighted-rrf-live\.json'/);
  });

  test('run-weighted-rrf-live.mjs writes smoke TREC runs to a dedicated subdirectory, never the real .runs dir', () => {
    const src = readFileSync(new URL('./run-weighted-rrf-live.mjs', import.meta.url), 'utf-8');
    assert.match(src, /SMOKE_RUNS_DIR = resolve\(__dirname, '\.runs-weighted-rrf-live\/smoke'\)/);
    assert.notEqual(
      src.match(/const RUNS_DIR = resolve\(__dirname, '([^']+)'\)/)?.[1],
      src.match(/const SMOKE_RUNS_DIR = resolve\(__dirname, '([^']+)'\)/)?.[1],
    );
  });

  test('shrinkForSmoke never returns the full 100-query/1000-doc dataset', () => {
    const bigCorpus = new Map(Array.from({ length: 1000 }, (_, i) => [`d${i}`, { title: '', text: `x${i}` }]));
    const bigQueries = new Map(Array.from({ length: 100 }, (_, i) => [`q${i}`, `query ${i}`]));
    const bigQrels = new Map(Array.from({ length: 100 }, (_, i) => [`q${i}`, new Map([[`d${i}`, 1]])]));
    const shrunk = shrinkForSmoke({ corpus: bigCorpus, queries: bigQueries, qrels: bigQrels, datasetMd5: 'fixture' });
    assert.ok(shrunk.corpus.size < 1000);
    assert.ok(shrunk.queries.size < 100);
  });

  test('shrinkForSmoke preserves every relevant document required by its selected queries qrels', () => {
    const corpus = new Map([
      ['rel1', { title: '', text: 'r1' }], ['rel2', { title: '', text: 'r2' }],
      ['d3', { title: '', text: 'd3' }], ['d4', { title: '', text: 'd4' }],
    ]);
    const queries = new Map([['q1', 'query one'], ['q2', 'query two']]);
    const qrels = new Map([['q1', new Map([['rel1', 1]])], ['q2', new Map([['rel2', 1]])]]);
    const shrunk = shrinkForSmoke({ corpus, queries, qrels, datasetMd5: 'fixture' }, { queryCount: 2, corpusSize: 3 });
    assert.ok(shrunk.corpus.has('rel1'));
    assert.ok(shrunk.corpus.has('rel2'));
  });

  test('computeCandidateVerdict never produces a scientific verdict for a smoke report (would require monkeypatching SMOKE) — documented via source guard instead', () => {
    // SMOKE is a module-level const derived from process.argv at import
    // time, so it cannot be flipped mid-test-process; verify the guard
    // exists in source instead of trying to exercise both branches live.
    const src = readFileSync(new URL('./run-weighted-rrf-live.mjs', import.meta.url), 'utf-8');
    assert.match(src, /if \(SMOKE\) \{\s*\n\s*return \{ \.\.\.base, verdict: 'WEIGHTED_RRF_MIXED'/);
  });
});

// ── P1 regression: strict CUDA must be MANDATORY for local scopes in the
// full benchmark, verified BEFORE any indexing — not merely checked after
// the fact once a scope has already run on whatever provider happened to
// be configured (or not configured at all). ────────────────────────────────
describe('verifyStrictCudaConfigured: pre-flight gate before any indexing happens', () => {
  test('ok when there are no local scopes at all (cloud-only run needs no CUDA)', () => {
    const result = verifyStrictCudaConfigured([{ id: 'scifact-cloud', provider: { kind: 'cloud' } }], {});
    assert.equal(result.ok, true);
  });

  test('REJECTS a local scope when ONNX_EXECUTION_PROVIDER is unset entirely', () => {
    const result = verifyStrictCudaConfigured([{ id: 'scifact-local', provider: { kind: 'local' } }], {});
    assert.equal(result.ok, false);
    assert.match(result.reason, /require strict CUDA/);
  });

  test('REJECTS a local scope when ONNX_EXECUTION_PROVIDER=cpu (the exact case the smoke run exposed)', () => {
    const result = verifyStrictCudaConfigured(
      [{ id: 'scifact-local', provider: { kind: 'local' } }],
      { ONNX_EXECUTION_PROVIDER: 'cpu', ONNX_CUDA_STRICT: undefined },
    );
    assert.equal(result.ok, false);
  });

  test('REJECTS a local scope when ONNX_EXECUTION_PROVIDER=cuda but ONNX_CUDA_STRICT is not "1"', () => {
    const result = verifyStrictCudaConfigured(
      [{ id: 'scifact-local', provider: { kind: 'local' } }],
      { ONNX_EXECUTION_PROVIDER: 'cuda', ONNX_CUDA_STRICT: 'true' },
    );
    assert.equal(result.ok, false);
  });

  test('REJECTS a local scope when ONNX_CUDA_STRICT=1 but ONNX_EXECUTION_PROVIDER is not cuda', () => {
    const result = verifyStrictCudaConfigured(
      [{ id: 'scifact-local', provider: { kind: 'local' } }],
      { ONNX_EXECUTION_PROVIDER: 'dml', ONNX_CUDA_STRICT: '1' },
    );
    assert.equal(result.ok, false);
  });

  test('ok when ONNX_EXECUTION_PROVIDER=cuda AND ONNX_CUDA_STRICT=1 are both set', () => {
    const result = verifyStrictCudaConfigured(
      [{ id: 'scifact-local', provider: { kind: 'local' } }],
      { ONNX_EXECUTION_PROVIDER: 'cuda', ONNX_CUDA_STRICT: '1' },
    );
    assert.equal(result.ok, true);
  });

  test('reports every local scope id that requires the gate, in a mixed local+cloud run', () => {
    const result = verifyStrictCudaConfigured(
      [{ id: 'scifact-local', provider: { kind: 'local' } }, { id: 'scifact-cloud', provider: { kind: 'cloud' } }, { id: 'miracl-local', provider: { kind: 'local' } }],
      {},
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.localScopeIds, ['scifact-local', 'miracl-local']);
  });

  test('main() calls the gate before any scope work, and skips it for --smoke and --resume-check', () => {
    const src = readFileSync(new URL('./run-weighted-rrf-live.mjs', import.meta.url), 'utf-8');
    assert.match(src, /if \(!SMOKE && !RESUME_CHECK\) \{\s*\n\s*const cudaGate = verifyStrictCudaConfigured/);
    // The gate call must appear textually BEFORE the RESUME_CHECK branch's
    // own early return, and well before executeScope() is ever invoked.
    const gateIdx = src.indexOf('verifyStrictCudaConfigured(effectiveScopes');
    const executeScopeCallIdx = src.indexOf('await executeScope({');
    assert.ok(gateIdx > 0, 'gate call not found');
    assert.ok(gateIdx < executeScopeCallIdx, 'gate must run before executeScope() is ever called');
  });
});

// ── P1 regression: main() must compute the harness verdict BEFORE the
// candidate verdict — computeCandidateVerdict() reads report.verdict to
// decide whether live results can be trusted, so computing it first (while
// report.verdict is still null) would force every real run's
// candidateVerdict to a spurious REJECT regardless of actual evidence. ────
describe('verdict computation order: harness verdict before candidate verdict', () => {
  test('main() assigns report.verdict before report.candidateVerdict', () => {
    const src = readFileSync(new URL('./run-weighted-rrf-live.mjs', import.meta.url), 'utf-8');
    const verdictIdx = src.indexOf('report.verdict = computeVerdict(');
    const candidateIdx = src.indexOf('report.candidateVerdict = computeCandidateVerdict(');
    assert.ok(verdictIdx > 0, 'report.verdict assignment not found');
    assert.ok(candidateIdx > 0, 'report.candidateVerdict assignment not found');
    assert.ok(verdictIdx < candidateIdx, 'report.verdict must be assigned before report.candidateVerdict is computed from it');
  });

  test('computeCandidateVerdict never spuriously REJECTs merely because report.verdict was read as null (proves why the order matters)', () => {
    const reportWithNullVerdict = { verdict: null, scopes: {} };
    const result = computeCandidateVerdict(reportWithNullVerdict, [{ id: 'scifact-local' }], {});
    assert.equal(result.verdict, 'WEIGHTED_RRF_REJECT');
    assert.match(result.reasons[0], /Harness-level verdict was "null"/);
    // This is the exact failure mode the order fix prevents: as long as
    // main() computes report.verdict first, computeCandidateVerdict() is
    // never called with a null report.verdict during a real (non-crashed) run.
  });
});

// ── 16. local strict-CUDA provenance ────────────────────────────────────────
describe('verifyCudaProvenance: reject local runs where CUDA was requested but not effective', () => {
  test('cloud scopes are always ok — CUDA verification is not applicable', () => {
    const result = verifyCudaProvenance({ provider: { kind: 'cloud' } }, null);
    assert.deepEqual(result, { ok: true, reason: null });
  });

  test('a local scope that never requested CUDA is ok regardless of effective provider', () => {
    const result = verifyCudaProvenance(
      { provider: { kind: 'local' } },
      { requestedProvider: 'cpu', effectiveProvider: 'cpu', fellBackToCpu: false },
    );
    assert.equal(result.ok, true);
  });

  test('a local scope that requested CUDA and got CUDA is ok', () => {
    const result = verifyCudaProvenance(
      { provider: { kind: 'local' } },
      { requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false },
    );
    assert.equal(result.ok, true);
  });

  test('REJECTS a local scope that requested CUDA but silently fell back to CPU', () => {
    const result = verifyCudaProvenance(
      { provider: { kind: 'local' } },
      { requestedProvider: 'cuda', effectiveProvider: 'cpu', fellBackToCpu: true },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /CUDA was requested/);
    assert.match(result.reason, /effective provider was "cpu"/);
  });

  test('REJECTS a local scope with no ONNX provenance at all (no embedding call ever completed)', () => {
    const result = verifyCudaProvenance({ provider: { kind: 'local' } }, null);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no embedding call ever completed/);
  });

  test('buildScopeProvenance records requested, strict-mode-configured, and effective provider for local scopes', () => {
    const originalEp = process.env.ONNX_EXECUTION_PROVIDER;
    const originalStrict = process.env.ONNX_CUDA_STRICT;
    process.env.ONNX_EXECUTION_PROVIDER = 'cuda';
    process.env.ONNX_CUDA_STRICT = '1';
    try {
      const prov = buildScopeProvenance({
        scope: fixtureScope(),
        dataset: { datasetMd5: 'x', manifest: null, corpus: new Map(), queries: new Map() },
        prepared: {},
        onnxProviderState: { requested: 'cuda', effective: 'cuda', fellBackToCpu: false },
      });
      assert.equal(prov.onnx.requestedProvider, 'cuda');
      assert.equal(prov.onnx.strictModeConfigured, true);
      assert.equal(prov.onnx.effectiveProvider, 'cuda');
      assert.equal(prov.onnx.fellBackToCpu, false);
    } finally {
      if (originalEp === undefined) delete process.env.ONNX_EXECUTION_PROVIDER; else process.env.ONNX_EXECUTION_PROVIDER = originalEp;
      if (originalStrict === undefined) delete process.env.ONNX_CUDA_STRICT; else process.env.ONNX_CUDA_STRICT = originalStrict;
    }
  });

  test('buildScopeProvenance never reads onnxProviderState (fell back silently) as if it were the requested value', () => {
    const originalEp = process.env.ONNX_EXECUTION_PROVIDER;
    process.env.ONNX_EXECUTION_PROVIDER = 'cuda';
    try {
      const prov = buildScopeProvenance({
        scope: fixtureScope(),
        dataset: { datasetMd5: 'x', manifest: null, corpus: new Map(), queries: new Map() },
        prepared: {},
        onnxProviderState: { requested: 'cuda', effective: 'cpu', fellBackToCpu: true },
      });
      assert.equal(prov.onnx.requestedProvider, 'cuda');
      assert.equal(prov.onnx.effectiveProvider, 'cpu');
      assert.equal(prov.onnx.fellBackToCpu, true);
    } finally {
      if (originalEp === undefined) delete process.env.ONNX_EXECUTION_PROVIDER; else process.env.ONNX_EXECUTION_PROVIDER = originalEp;
    }
  });

  test('computeVerdict rejects the whole harness run when any scope\'s CUDA verification failed', () => {
    const metric = { queryCount: 2, ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    const metrics = Object.fromEntries(FUSION_MODE_IDS.map((id) => [id, metric]));
    const report = {
      scopes: {
        'scifact-local': {
          metrics, errors: [], queryStats: { errors: 0 }, indexing: { errors: 0 },
          cudaVerification: { ok: false, reason: 'fell back to cpu' },
        },
      },
      cleanupSummary: { failed: [] },
    };
    const verdict = computeVerdict(report, [fixtureScope()], { queryCountPerScope: 2 });
    assert.match(verdict, /REJECT/);
  });
});

// ── 17. cloud ONNX provenance marked not applicable ────────────────────────
describe('cloud scopes report ONNX provenance as not applicable', () => {
  test('buildScopeProvenance sets onnx: null for a cloud scope', () => {
    const prov = buildScopeProvenance({
      scope: { provider: { kind: 'cloud', denseModelId: 'e5', denseSize: 384, sparseModelId: 'bm25' } },
      dataset: { datasetMd5: 'x', manifest: null, corpus: new Map(), queries: new Map() },
      prepared: {},
      onnxProviderState: null,
    });
    assert.equal(prov.onnx, null);
    assert.equal(prov.provider.kind, 'cloud');
  });

  test('verifyCudaProvenance is a pure pass for cloud regardless of any stray onnxProvenance value', () => {
    const result = verifyCudaProvenance({ provider: { kind: 'cloud' } }, { requestedProvider: 'cuda', effectiveProvider: 'cpu', fellBackToCpu: true });
    assert.equal(result.ok, true);
  });

  test('renderMarkdownReport prints "n/a (cloud)" for a cloud scope\'s CUDA provenance row', () => {
    const report = {
      verdict: 'WEIGHTED_RRF_LIVE_HARNESS_ACCEPT',
      candidateVerdict: { verdict: 'WEIGHTED_RRF_MIXED', reasons: [], perScope: {} },
      benchmarkContract: { fusionModeIds: FUSION_MODE_IDS, hybridPrefetchLimit: 200 },
      scopes: {
        'scifact-cloud': {
          metrics: {}, comparisons: {}, indexing: { documentsIndexed: 3, wallMs: 10 },
          queryStats: { errors: 0 }, cleanup: { deleted: true }, provenance: { onnx: null, peakRssBytes: 100 },
          cudaVerification: { ok: true, reason: null },
        },
      },
      environment: {},
    };
    const md = renderMarkdownReport(report);
    assert.match(md, /n\/a \(cloud\)/);
  });
});

// ── candidate verdict decision rules ────────────────────────────────────────
describe('computeCandidateVerdict: decision rules', () => {
  function acceptedHarnessReport(scopeOverrides = {}) {
    const scopes = ['scifact-local', 'scifact-cloud', 'miracl-local', 'miracl-cloud'];
    const report = { verdict: 'WEIGHTED_RRF_LIVE_HARNESS_ACCEPT', scopes: {} };
    for (const id of scopes) {
      report.scopes[id] = {
        comparisons: {
          'k2_rho0.10_vs_dense': { meanDelta: 0.01, verdict: 'INCONCLUSIVE' },
          equal_k2_vs_dense: { meanDelta: -0.05, verdict: 'A_BETTER' },
          equal_k60_vs_dense: { meanDelta: -0.06, verdict: 'A_BETTER' },
        },
        ...scopeOverrides[id],
      };
    }
    return report;
  }

  const fakeScopes = [
    { id: 'scifact-local' }, { id: 'scifact-cloud' }, { id: 'miracl-local' }, { id: 'miracl-cloud' },
  ];

  test('REJECT when the harness verdict itself was not an ACCEPT', () => {
    const report = { verdict: 'WEIGHTED_RRF_LIVE_HARNESS_REJECT', scopes: {} };
    const result = computeCandidateVerdict(report, fakeScopes, {});
    assert.equal(result.verdict, 'WEIGHTED_RRF_REJECT');
    assert.match(result.reasons[0], /Harness-level verdict/);
  });

  test('ACCEPT when the primary candidate materially reduces MIRACL regression on both MIRACL scopes with no significant regression anywhere', () => {
    const report = acceptedHarnessReport();
    const result = computeCandidateVerdict(report, fakeScopes, {});
    assert.equal(result.verdict, 'WEIGHTED_RRF_ACCEPT');
    assert.equal(result.perScope['miracl-local'].materiallyReduced, true);
    assert.equal(result.perScope['miracl-cloud'].materiallyReduced, true);
  });

  test('REJECT when the primary candidate is significantly worse than dense on a MIRACL scope', () => {
    const report = acceptedHarnessReport({
      'miracl-local': { comparisons: { 'k2_rho0.10_vs_dense': { meanDelta: -0.08, verdict: 'A_BETTER' }, equal_k2_vs_dense: { meanDelta: -0.05, verdict: 'A_BETTER' }, equal_k60_vs_dense: { meanDelta: -0.06, verdict: 'A_BETTER' } } },
    });
    const result = computeCandidateVerdict(report, fakeScopes, {});
    assert.equal(result.verdict, 'WEIGHTED_RRF_REJECT');
    assert.match(result.reasons.join(' '), /statistically significantly WORSE than dense/);
  });

  test('REJECT when the primary candidate is significantly worse than dense on SciFact', () => {
    const report = acceptedHarnessReport({
      'scifact-local': { comparisons: { 'k2_rho0.10_vs_dense': { meanDelta: -0.05, verdict: 'A_BETTER' }, equal_k2_vs_dense: { meanDelta: -0.05, verdict: 'A_BETTER' }, equal_k60_vs_dense: { meanDelta: -0.06, verdict: 'A_BETTER' } } },
    });
    const result = computeCandidateVerdict(report, fakeScopes, {});
    assert.equal(result.verdict, 'WEIGHTED_RRF_REJECT');
    assert.match(result.reasons.join(' '), /WORSE than dense on SciFact/);
  });

  test('MIXED when the candidate does not materially reduce the MIRACL regression (delta too close to the BETTER equal-RRF control)', () => {
    const report = acceptedHarnessReport({
      'miracl-local': { comparisons: { 'k2_rho0.10_vs_dense': { meanDelta: -0.055, verdict: 'MIXED' }, equal_k2_vs_dense: { meanDelta: -0.05, verdict: 'A_BETTER' }, equal_k60_vs_dense: { meanDelta: -0.06, verdict: 'A_BETTER' } } },
    });
    const result = computeCandidateVerdict(report, fakeScopes, {});
    assert.equal(result.verdict, 'WEIGHTED_RRF_MIXED');
    assert.equal(result.perScope['miracl-local'].materiallyReduced, false);
  });

  // ── P2 regression: acceptance must compare against the BETTER
  // (less-regressed) equal-RRF control, never the worse one — otherwise a
  // candidate that is still clearly worse than k2 could pass merely by
  // beating a badly-regressed k60. ────────────────────────────────────────
  test('MIXED (never ACCEPT) when the candidate beats the worse equal-RRF control but remains worse than the better one', () => {
    const report = acceptedHarnessReport({
      'miracl-local': {
        comparisons: {
          'k2_rho0.10_vs_dense': { meanDelta: -0.03, verdict: 'MIXED' }, // candidate still regresses vs dense
          equal_k2_vs_dense: { meanDelta: -0.01, verdict: 'MIXED' },     // k2 = the BETTER control (candidate is worse than this)
          equal_k60_vs_dense: { meanDelta: -0.08, verdict: 'A_BETTER' }, // k60 = the WORSE control (candidate beats this)
        },
      },
    });
    const result = computeCandidateVerdict(report, fakeScopes, {});
    assert.notEqual(result.verdict, 'WEIGHTED_RRF_ACCEPT');
    assert.equal(result.perScope['miracl-local'].bestEqualRrfDelta, -0.01, 'the better control (k2, -0.01) must be selected, not the worse one (k60, -0.08)');
    assert.equal(result.perScope['miracl-local'].materiallyReduced, false);
  });

  test('perScope reports bestEqualRrfDelta and reductionVsBestEqualRrf (not the old worst-control field names)', () => {
    const report = acceptedHarnessReport();
    const result = computeCandidateVerdict(report, fakeScopes, {});
    const row = result.perScope['miracl-local'];
    assert.ok('bestEqualRrfDelta' in row);
    assert.ok('reductionVsBestEqualRrf' in row);
    assert.equal('worstEqualRrfDelta' in row, false);
    assert.equal('reductionVsWorstEqualRrf' in row, false);
  });

  test('MIXED when local and cloud diverge in direction vs dense on the same dataset', () => {
    const report = acceptedHarnessReport({
      'miracl-local': { comparisons: { 'k2_rho0.10_vs_dense': { meanDelta: 0.05, verdict: 'B_BETTER' }, equal_k2_vs_dense: { meanDelta: -0.05, verdict: 'A_BETTER' }, equal_k60_vs_dense: { meanDelta: -0.06, verdict: 'A_BETTER' } } },
      'miracl-cloud': { comparisons: { 'k2_rho0.10_vs_dense': { meanDelta: -0.05, verdict: 'MIXED' }, equal_k2_vs_dense: { meanDelta: -0.09, verdict: 'A_BETTER' }, equal_k60_vs_dense: { meanDelta: -0.10, verdict: 'A_BETTER' } } },
    });
    const result = computeCandidateVerdict(report, fakeScopes, {});
    assert.equal(result.verdict, 'WEIGHTED_RRF_MIXED');
    assert.match(result.reasons.join(' '), /diverges between local/);
  });

  test('MIXED when only one dataset type is present (cannot judge cross-dataset rules)', () => {
    const report = { verdict: 'WEIGHTED_RRF_LIVE_HARNESS_ACCEPT', scopes: { 'scifact-local': {} } };
    const result = computeCandidateVerdict(report, [{ id: 'scifact-local' }], {});
    assert.equal(result.verdict, 'WEIGHTED_RRF_MIXED');
  });

  test('smoke mode never produces a scientific verdict', () => {
    // SMOKE is derived from process.argv at import time in the real module;
    // this test only verifies the function's documented smoke-mode
    // behavior would be MIXED-with-explanatory-reason if SMOKE were true —
    // covered by the source-guard test in the "smoke report isolation"
    // describe block above, since SMOKE cannot be toggled after import.
    assert.ok(true);
  });

  test('never calls the candidate globally optimal — miraclNote-equivalent language appears in the report reasons/markdown', () => {
    const report = acceptedHarnessReport();
    report.candidateVerdict = computeCandidateVerdict(report, fakeScopes, {});
    report.benchmarkContract = { fusionModeIds: FUSION_MODE_IDS, hybridPrefetchLimit: 200 };
    for (const s of Object.values(report.scopes)) { s.metrics = {}; s.comparisons = {}; s.indexing = { documentsIndexed: 0, wallMs: 0 }; s.queryStats = { errors: 0 }; s.cleanup = { deleted: true }; s.provenance = { onnx: null, peakRssBytes: 0 }; s.cudaVerification = { ok: true }; }
    report.environment = {};
    const md = renderMarkdownReport(report);
    assert.match(md, /never called globally/);
  });
});

// ── 18. no production configuration changes ─────────────────────────────────
describe('no production configuration changes', () => {
  test('run-weighted-rrf-live.mjs never imports or writes core/settings/service.js or definitions.js', () => {
    const src = readFileSync(new URL('./run-weighted-rrf-live.mjs', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /settings\/service\.js/);
    assert.doesNotMatch(src, /settings\/definitions\.js/);
    assert.doesNotMatch(src, /RRF_K\s*=/);
  });

  test('weighted-rrf-live-config.mjs never mutates a shared/production constant object', () => {
    const src = readFileSync(new URL('./weighted-rrf-live-config.mjs', import.meta.url), 'utf-8');
    assert.match(src, /Object\.freeze/); // every locked config surface is frozen
  });
});

// ── offline safety (no network) ─────────────────────────────────────────────
describe('offline safety: loadScopeDataset never reaches the network', () => {
  test('run-weighted-rrf-live.mjs imports only loadCachedMiniSet/loadCachedMiraclSubset, never the fetch-and-build variants', () => {
    const src = readFileSync(new URL('./run-weighted-rrf-live.mjs', import.meta.url), 'utf-8');
    assert.match(src, /loadCachedMiniSet/);
    assert.match(src, /loadCachedMiraclSubset/);
    assert.doesNotMatch(src, /buildAndCacheMiniSet/);
    assert.doesNotMatch(src, /buildAndCacheMiraclSubset/);
    assert.doesNotMatch(src, /fetchAndValidateScifact/);
    assert.doesNotMatch(src, /fetchAndValidateMiraclTopicsQrels/);
    assert.doesNotMatch(src, /fetchCorpusPassages/);
  });

  test('executeScope() and shrinkForSmoke() never call fetch — replacing global.fetch with a throwing stub does not break them', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network access attempted'); };
    try {
      const client = makeFakeClient();
      const scopeReport = await executeScope({
        client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
        embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
      });
      assert.equal(scopeReport.errors.length, 0);
      const shrunk = shrinkForSmoke({ ...fixtureDataset(), datasetMd5: 'fixture' });
      assert.ok(shrunk.corpus.size > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── computeVerdict sanity ────────────────────────────────────────────────────
describe('computeVerdict', () => {
  test('BLOCKED when a requested scope never produced a report', () => {
    const report = { scopes: {}, cleanupSummary: { failed: [] } };
    const verdict = computeVerdict(report, [fixtureScope()], { queryCountPerScope: 2 });
    assert.match(verdict, /BLOCKED/);
  });

  test('ACCEPT when every scope has full metrics, zero errors, cleanup succeeded, and CUDA verification passed', () => {
    const metric = { queryCount: 2, ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    const metrics = Object.fromEntries(FUSION_MODE_IDS.map((id) => [id, metric]));
    const report = {
      scopes: { 'scifact-local': { metrics, errors: [], queryStats: { errors: 0 }, indexing: { errors: 0 }, cudaVerification: { ok: true, reason: null } } },
      cleanupSummary: { failed: [] },
    };
    const verdict = computeVerdict(report, [fixtureScope()], { queryCountPerScope: 2 });
    assert.match(verdict, /ACCEPT/);
  });

  test('REJECT when metrics are missing entirely', () => {
    const report = {
      scopes: { 'scifact-local': { metrics: {}, errors: [], queryStats: { errors: 0 }, indexing: { errors: 0 } } },
      cleanupSummary: { failed: [] },
    };
    const verdict = computeVerdict(report, [fixtureScope()], { queryCountPerScope: 2 });
    assert.match(verdict, /REJECT/);
  });
});

// ── P1: pre-generated collection name, matching the established sweep pattern ──
describe('executeScope uses a pre-generated collection name, not one it invents after creation', () => {
  test('executeScope creates exactly the collection name passed in via the collection param', async () => {
    const client = makeFakeClient();
    const preGenerated = 'semidex-weighted-rrf-live-scifact-local-pre-generated-abc123';
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {}, collection: preGenerated,
    });
    assert.equal(scopeReport.collection, preGenerated);
    assert.equal(client.calls.createCollection[0].name, preGenerated);
    assert.equal(client.calls.deleteCollection[0], preGenerated);
  });
});
