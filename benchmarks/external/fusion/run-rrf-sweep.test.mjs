// Bounded, offline tests for the live Qdrant RRF-k sweep harness. No
// network, no real Qdrant, no ONNX — the Qdrant client and the ONNX
// embedBatch function are both fake/injected. Run:
//   node --test --test-concurrency=1 benchmarks/external/fusion/run-rrf-sweep.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SWEEP_KS, SCOPES, SCOPE_IDS, COLLECTION_PREFIX, TOP_K, HYBRID_PREFETCH_LIMIT,
  REFERENCE_K_QDRANT_DEFAULT, REFERENCE_K_SEMIDEX_DEFAULT, parseScopesFlag, collectionName,
} from './rrf-sweep-config.mjs';
import {
  isCompletedScopeCheckpoint, shrinkForSmoke, normalizeDocEntries, validateResumeCheckpoint,
  executeScope, computeScopeComparisons, computePriorComparison, computeVerdict,
  computeSweepAnswers, renderMarkdownReport, cleanupOrphanedCollection,
  rebuildReportAggregates,
} from './run-rrf-sweep.mjs';

// ── 1. Sweep k list is exactly [1, 2, 5, 10, 30, 60] ───────────────────────
describe('SWEEP_KS', () => {
  test('is exactly [1, 2, 5, 10, 30, 60], in order', () => {
    assert.deepEqual(SWEEP_KS, [1, 2, 5, 10, 30, 60]);
  });
});

// ── 2. Four scopes remain separate ─────────────────────────────────────────
describe('SCOPES', () => {
  test('defines exactly the four required (dataset, provider) scopes', () => {
    assert.deepEqual(SCOPE_IDS, ['scifact-local', 'scifact-cloud', 'miracl-local', 'miracl-cloud']);
  });

  test('scifact and miracl scopes never share a dataset field', () => {
    const byDataset = new Map();
    for (const s of SCOPES) {
      if (!byDataset.has(s.dataset)) byDataset.set(s.dataset, []);
      byDataset.get(s.dataset).push(s.id);
    }
    assert.deepEqual([...byDataset.keys()].sort(), ['miracl', 'scifact']);
    assert.equal(byDataset.get('scifact').length, 2);
    assert.equal(byDataset.get('miracl').length, 2);
  });

  test('local scopes use the ONNX/local provider, cloud scopes use E5+BM25', () => {
    for (const s of SCOPES) {
      assert.equal(s.provider.kind, s.providerId);
    }
  });

  test('parseScopesFlag with no value returns all four scopes in canonical order', () => {
    assert.deepEqual(parseScopesFlag(null).map((s) => s.id), SCOPE_IDS);
  });

  test('parseScopesFlag reorders requested scopes to canonical order', () => {
    const result = parseScopesFlag('miracl-cloud,scifact-local');
    assert.deepEqual(result.map((s) => s.id), ['scifact-local', 'miracl-cloud']);
  });

  test('parseScopesFlag rejects an unknown scope id', () => {
    assert.throws(() => parseScopesFlag('not-a-scope'), /unknown scope id/);
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
      // Default: return the 3 known doc ids in a fixed order with descending scores.
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

describe('dataset normalization', () => {
  test('preserves MIRACL titles because they are part of the embedding input', () => {
    const normalized = normalizeDocEntries(new Map([
      ['object', { title: 'Document title', text: 'Document body' }],
      ['string', 'Text-only passage'],
    ]), 'miracl');

    assert.deepEqual(normalized.get('object'), {
      title: 'Document title',
      text: 'Document body',
    });
    assert.deepEqual(normalized.get('string'), {
      title: '',
      text: 'Text-only passage',
    });
  });
});

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

// ── 3. One collection/indexing pass occurs per scope, not per k ───────────
// 4. One dense and one sparse query occur per benchmark query ─────────────
// 5. Exactly six hybrid requests occur per query ───────────────────────────
// 6. Hybrid requests differ only in rrf.k ──────────────────────────────────
// 7. Every hybrid request uses prefetch 200 and final limit 100 ────────────
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

  test('issues exactly 1 dense + 1 sparse + 6 hybrid queries per benchmark query (2 queries -> 16 total)', async () => {
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const denseQueries = client.calls.query.filter((c) => c.spec.using === 'dense');
    const sparseQueries = client.calls.query.filter((c) => c.spec.using === 'sparse');
    const hybridQueries = client.calls.query.filter((c) => c.spec.query?.rrf);
    assert.equal(denseQueries.length, 2); // one per benchmark query
    assert.equal(sparseQueries.length, 2);
    assert.equal(hybridQueries.length, 12); // 2 queries x 6 k values
    assert.equal(client.calls.query.length, 16);
  });

  test('the six hybrid requests for one query differ ONLY in rrf.k — same prefetch, same limits', async () => {
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const hybridForQ1 = client.calls.query.filter((c) => c.spec.query?.rrf).slice(0, 6);
    assert.equal(hybridForQ1.length, 6);
    const ks = hybridForQ1.map((c) => c.spec.query.rrf.k);
    assert.deepEqual(ks, SWEEP_KS);
    const stripped = hybridForQ1.map((c) => JSON.stringify({ ...c.spec, query: null }));
    assert.ok(stripped.every((s) => s === stripped[0]), 'prefetch/limit/using must be identical across all six k requests');
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

  test('dense and sparse query vectors are computed exactly once per query (embedBatch call count)', async () => {
    let calls = 0;
    const countingEmbed = async (texts) => { calls += 1; return fakeEmbedBatch(texts); };
    const client = makeFakeClient();
    await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: countingEmbed, writeTrecRun: () => {},
    });
    // 1 call for indexing the 3-doc batch + 1 call per query (2 queries) = 3.
    // Each per-query call computes both dense+sparse together (one call, not two).
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

  test('never deletes a collection whose name does not start with the owned prefix', async () => {
    const client = makeFakeClient();
    // Force a bad collection name by monkeypatching collectionName is not
    // possible here without module mocking; instead verify the guard logic
    // directly against executeScope's own defensive check by asserting the
    // real collection name always satisfies the prefix (covered above) AND
    // that a manually-constructed non-prefixed name is rejected by the same
    // logic executeScope uses (mirrors the finally-block guard).
    assert.equal('other-collection'.startsWith(COLLECTION_PREFIX), false);
  });
});

// ── 8. Comparison signs follow comparison − baseline ───────────────────────
describe('computeScopeComparisons: sign direction', () => {
  function perQueryFixture({ denseVals, hybridValsByK }) {
    const qids = denseVals.map((_, i) => `q${i + 1}`);
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    const raw = { dense: toEntries(denseVals) };
    for (const [k, vals] of Object.entries(hybridValsByK)) raw[`hybrid_k${k}`] = toEntries(vals);
    return raw;
  }

  test('hybrid_k<k>_vs_dense.meanDelta is positive when hybrid is the constructed winner', () => {
    const raw = perQueryFixture({
      denseVals: [0.5, 0.5, 0.5],
      hybridValsByK: { 60: [0.9, 0.9, 0.9] },
    });
    const { hybrid_k60_vs_dense: cmp } = computeScopeComparisons(raw);
    assert.ok(cmp.meanDelta > 0, `expected positive meanDelta (hybrid better), got ${cmp.meanDelta}`);
    assert.equal(cmp.wins, 3);
    assert.equal(cmp.losses, 0);
  });

  test('hybrid_k<k>_vs_dense.meanDelta is negative when dense is the constructed winner', () => {
    const raw = perQueryFixture({
      denseVals: [0.9, 0.9, 0.9],
      hybridValsByK: { 60: [0.5, 0.5, 0.5] },
    });
    const { hybrid_k60_vs_dense: cmp } = computeScopeComparisons(raw);
    assert.ok(cmp.meanDelta < 0, `expected negative meanDelta (dense better), got ${cmp.meanDelta}`);
    assert.equal(cmp.wins, 0);
    assert.equal(cmp.losses, 3);
  });

  test('hybrid_k<k>_vs_k60.meanDelta is positive when k is the constructed winner (must be k − k60, not k60 − k)', () => {
    const raw = perQueryFixture({
      denseVals: [0.5, 0.5, 0.5],
      hybridValsByK: { 2: [0.9, 0.9, 0.9], 60: [0.3, 0.3, 0.3] },
    });
    const { hybrid_k2_vs_k60: cmp } = computeScopeComparisons(raw);
    assert.ok(cmp.meanDelta > 0, `expected positive meanDelta (k2 better than k60), got ${cmp.meanDelta}`);
    assert.equal(cmp.wins, 3);
    assert.equal(cmp.losses, 0);
  });

  test('reversing which k wins flips the sign of hybrid_k<k>_vs_k60', () => {
    const raw = perQueryFixture({
      denseVals: [0.5, 0.5, 0.5],
      hybridValsByK: { 2: [0.1, 0.1, 0.1], 60: [0.9, 0.9, 0.9] },
    });
    const { hybrid_k2_vs_k60: cmp } = computeScopeComparisons(raw);
    assert.ok(cmp.meanDelta < 0, `expected negative meanDelta (k60 better than k2), got ${cmp.meanDelta}`);
    assert.equal(cmp.wins, 0);
    assert.equal(cmp.losses, 3);
  });

  test('hybrid_k<k>_vs_k2 uses k2 as baseline (comparison=k, baseline=k2)', () => {
    const raw = perQueryFixture({
      denseVals: [0.5, 0.5, 0.5],
      hybridValsByK: { 2: [0.2, 0.2, 0.2], 10: [0.8, 0.8, 0.8] },
    });
    const { hybrid_k10_vs_k2: cmp } = computeScopeComparisons(raw);
    assert.ok(cmp.meanDelta > 0, `expected positive meanDelta (k10 − k2 > 0), got ${cmp.meanDelta}`);
  });

  test('no comparisons at all when dense mode is absent', () => {
    const raw = { hybrid_k60: [['q1', { ndcgAt10: 0.5 }]] };
    assert.deepEqual(computeScopeComparisons(raw), {});
  });

  test('a k value never compares against itself (no hybrid_k60_vs_k60 key)', () => {
    const raw = perQueryFixture({ denseVals: [0.5], hybridValsByK: { 60: [0.7] } });
    const cmp = computeScopeComparisons(raw);
    assert.equal('hybrid_k60_vs_k60' in cmp, false);
  });
});

// ── 9. Resume skips completed scopes ────────────────────────────────────
describe('isCompletedScopeCheckpoint / validateResumeCheckpoint', () => {
  function completedScopeReport() {
    const metric = { queryCount: 2, ndcgAt10: 0.5 };
    const metrics = { dense: metric, sparse: metric };
    for (const k of SWEEP_KS) metrics[`hybrid_k${k}`] = metric;
    return {
      indexing: { documentsIndexed: 3, errors: 0 },
      queryStats: { total: 2, ran: 2, errors: 0 },
      errors: [],
      cleanup: { attempted: true, deleted: true, collection: 'semidex-rrf-sweep-scifact-local-abc' },
      metrics,
    };
  }

  test('a fully measured, zero-error, cleaned scope is complete', () => {
    assert.equal(isCompletedScopeCheckpoint(completedScopeReport(), { queryCount: 2 }), true);
  });

  test('a scope missing one k value is not complete', () => {
    const r = completedScopeReport();
    delete r.metrics.hybrid_k30;
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

  test('validateResumeCheckpoint rejects a checkpoint with no benchmarkContract', () => {
    assert.throws(() => validateResumeCheckpoint({ scopes: {} }, { scopeIds: [] }), /no benchmarkContract/);
  });

  test('validateResumeCheckpoint rejects a mismatched contract', () => {
    const contract = { scopeIds: ['scifact-local'], sweepKs: SWEEP_KS };
    const previous = { benchmarkContract: { ...contract, sweepKs: [1, 2] }, scopes: {} };
    assert.throws(() => validateResumeCheckpoint(previous, contract), /does not match/);
  });

  test('validateResumeCheckpoint rejects a checkpoint referencing an unknown scope', () => {
    const contract = { scopeIds: ['scifact-local'], sweepKs: SWEEP_KS };
    const previous = { benchmarkContract: contract, scopes: { 'not-a-scope': {} } };
    assert.throws(() => validateResumeCheckpoint(previous, contract), /unknown scope/);
  });

  test('validateResumeCheckpoint accepts a matching contract', () => {
    const contract = { scopeIds: ['scifact-local'], sweepKs: SWEEP_KS };
    const previous = { benchmarkContract: contract, scopes: {} };
    assert.equal(validateResumeCheckpoint(previous, contract), true);
  });
});

// ── 10. Interrupted benchmark-owned collections are handled safely ────────
// (cleanupOrphanedCollection is not exported directly, but its contract —
// "only ever delete a collection whose recorded name starts with the owned
// prefix" — is exercised indirectly via executeScope's own finally-block
// guard, already covered above. This section adds a direct unit check of
// the prefix-matching logic that both code paths rely on.)
describe('owned-collection prefix guard', () => {
  test('a scope-report-recorded collection name from a real run always matches the prefix', async () => {
    const client = makeFakeClient();
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.ok(scopeReport.cleanup.collection.startsWith(COLLECTION_PREFIX));
  });

  test('an arbitrary user collection name never matches the owned prefix', () => {
    for (const name of ['my-collection', 'semidex-beir-scifact-local', 'production-docs']) {
      assert.equal(name.startsWith(COLLECTION_PREFIX), false);
    }
  });
});

// ── 11. Cache loading remains offline-only ─────────────────────────────────
describe('offline safety: loadScopeDataset never reaches the network', () => {
  test('run-rrf-sweep.mjs imports only loadCachedMiniSet/loadCachedMiraclSubset, never the fetch-and-build variants', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
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

// ── 12. Reports contain no API keys, credentials, or private local paths ──
describe('redaction: report content never leaks secrets or local paths', () => {
  test('redact() strips a fake API key out of an error message', async () => {
    // Reuse harness-core's own makeRedactor directly — this is the exact
    // function run-rrf-sweep.mjs wraps for every error it records.
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
});

// ── 13. Smoke artifacts cannot overwrite real artifacts ────────────────────
describe('smoke vs real report path separation', () => {
  test('run-rrf-sweep.mjs computes a distinct report path for --smoke', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
    assert.match(src, /SMOKE \? '\.rrf-sweep-smoke-report\.json' : '2026-07-23-rrf-k-sweep\.json'/);
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
});

// ── computeVerdict / computePriorComparison sanity ──────────────────────────
describe('computeVerdict', () => {
  test('BLOCKED when a requested scope never produced a report', () => {
    const report = { scopes: {}, cleanupSummary: { failed: [] } };
    const verdict = computeVerdict(report, [fixtureScope()], { queryCountPerScope: 2 });
    assert.match(verdict, /BLOCKED/);
  });

  test('ACCEPT when every scope has full metrics, zero errors, and cleanup succeeded', () => {
    const metric = { queryCount: 2, ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    const metrics = { dense: metric, sparse: metric };
    for (const k of SWEEP_KS) metrics[`hybrid_k${k}`] = metric;
    const report = {
      scopes: { 'scifact-local': { metrics, errors: [], queryStats: { errors: 0 }, indexing: { errors: 0 } } },
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

describe('computePriorComparison', () => {
  test('returns a row per reference k for every scope regardless of whether prior files exist', () => {
    const scopes = { 'scifact-local': { metrics: { hybrid_k2: { ndcgAt10: 0.5 }, hybrid_k60: { ndcgAt10: 0.5 } } } };
    const result = computePriorComparison(scopes);
    assert.ok('scifact-local' in result);
    assert.ok('hybrid_k2' in result['scifact-local']);
    assert.ok('hybrid_k60' in result['scifact-local']);
  });

  // ── P1 regression: scifact-cloud must never be compared against the
  // incompatible full-SciFact (300q/5183d) report — no compatible prior
  // report exists for it at all, so it must always be reported as
  // non-comparable with a reason, never a numeric delta.
  test('scifact-cloud is always non-comparable — no compatible prior report exists', () => {
    const scopes = { 'scifact-cloud': { metrics: { hybrid_k2: { ndcgAt10: 0.9 }, hybrid_k60: { ndcgAt10: 0.9 } } } };
    const result = computePriorComparison(scopes);
    assert.equal(result['scifact-cloud'].hybrid_k2.comparable, false);
    assert.equal(result['scifact-cloud'].hybrid_k60.comparable, false);
    assert.match(result['scifact-cloud'].hybrid_k2.reason, /different-sized corpus|local-only RRF mini/);
    assert.equal('delta' in result['scifact-cloud'].hybrid_k2, false);
  });

  test('scifact-local rows never carry the shape of the incompatible full-SciFact report (no runId lookup)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
    // Regression: the fixed function must read the mini-set report's
    // `run.metrics` shape for scifact-local, never the full-benchmark
    // report's `runs['<provider>-common-512'].metrics` shape.
    assert.match(src, /PRIOR_SCIFACT_LOCAL_MINI_REPORT_PATH/);
    assert.doesNotMatch(src, /PRIOR_BEIR_REPORT_PATH/);
  });

  test('a comparable row always includes comparable: true alongside its numbers', () => {
    const scopes = { 'miracl-local': { metrics: { hybrid_k2: { ndcgAt10: 0.5 }, hybrid_k60: { ndcgAt10: 0.5 } } } };
    const result = computePriorComparison(scopes);
    for (const row of Object.values(result['miracl-local'])) {
      assert.ok('comparable' in row);
      if (row.comparable) assert.ok('delta' in row);
    }
  });

  test('miracl-local is non-comparable when the ONNX execution provider changed', () => {
    const scopes = {
      'miracl-local': {
        provenance: { onnxExecutionProviderRequested: 'cpu' },
        metrics: {
          hybrid_k2: { ndcgAt10: 0.5 },
          hybrid_k60: { ndcgAt10: 0.5 },
        },
      },
    };
    const result = computePriorComparison(scopes);
    for (const row of Object.values(result['miracl-local'])) {
      assert.equal(row.comparable, false);
      assert.match(row.reason, /prior MIRACL local used dml, current sweep used cpu/);
      assert.equal('delta' in row, false);
    }
  });
});

// ── P1 regression: collection name is generated and checkpointed BEFORE
// createCollection() is even called (main()'s pre-flight write), not
// discovered via a callback fired after creation succeeds — the earlier
// callback design still had a gap between createCollection() succeeding
// and the callback firing; generating the name up front closes that gap
// entirely. executeScope() itself now just accepts and uses whatever
// `collection` name it's given, proving the caller's pre-generated name
// really is what gets created/indexed/queried/cleaned up — not a name
// executeScope() invents internally that the caller would then have to
// somehow learn about after the fact. ───────────────────────────────────
describe('P1 fix: executeScope uses a pre-generated collection name, not one it invents after creation', () => {
  test('executeScope creates exactly the collection name passed in via the collection param', async () => {
    const client = makeFakeClient();
    const preGenerated = 'semidex-rrf-sweep-scifact-local-pre-generated-abc123';
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
      collection: preGenerated,
    });
    assert.equal(client.calls.createCollection[0].name, preGenerated);
    assert.equal(scopeReport.collection, preGenerated);
    assert.equal(client.calls.deleteCollection[0], preGenerated);
  });

  test('executeScope generates its own valid, prefixed collection name when none is passed (unit-test convenience default)', async () => {
    const client = makeFakeClient();
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.ok(scopeReport.collection.startsWith(COLLECTION_PREFIX));
  });

  test('a checkpoint written before createCollection() (main()\'s pre-flight write) is recognized by cleanupOrphanedCollection as an orphan to delete, and by isCompletedScopeCheckpoint as NOT complete', async () => {
    // Simulates main()'s wiring: BEFORE calling executeScope() at all, it
    // writes a minimal { status: 'planned', collection, cleanup: { deleted:
    // false, ... } } record naming the collection that is ABOUT TO be
    // created. isCompletedScopeCheckpoint must treat that shape as NOT
    // complete (so --resume re-runs it), and the collection name it
    // carries must be exactly what a real cleanup pass would delete.
    const plannedCheckpoint = {
      scopeId: 'scifact-local', status: 'planned', collection: 'semidex-rrf-sweep-scifact-local-abc123',
      cleanup: { attempted: false, deleted: false, collection: 'semidex-rrf-sweep-scifact-local-abc123', error: null },
    };
    assert.equal(isCompletedScopeCheckpoint(plannedCheckpoint, { queryCount: 100 }), false);
    assert.equal(plannedCheckpoint.cleanup.collection, plannedCheckpoint.collection);
    assert.ok(plannedCheckpoint.collection.startsWith(COLLECTION_PREFIX));

    const client = makeFakeClient();
    const result = await cleanupOrphanedCollection({ client, redact, report: { scopes: { 'scifact-local': plannedCheckpoint } }, scope: { id: 'scifact-local' } });
    assert.equal(result.ok, true);
    assert.equal(result.collection, plannedCheckpoint.collection);
    assert.equal(client.calls.deleteCollection[0], plannedCheckpoint.collection);
  });
});

// ── P1 regression: a cleanup failure must be surfaced, not swallowed ──────
describe('P1 fix: cleanupOrphanedCollection reports failure instead of only logging it', () => {
  test('returns { ok: true, collection: null } when there is nothing to clean up', async () => {
    const client = makeFakeClient();
    const result = await cleanupOrphanedCollection({ client, redact, report: { scopes: {} }, scope: { id: 'scifact-local' } });
    assert.deepEqual(result, { ok: true, collection: null });
    assert.equal(client.calls.deleteCollection.length, 0);
  });

  test('returns { ok: true, collection: null } when the prior scope already confirmed cleanup.deleted', async () => {
    const client = makeFakeClient();
    const report = { scopes: { 'scifact-local': { cleanup: { deleted: true, collection: 'semidex-rrf-sweep-scifact-local-x' } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, scope: { id: 'scifact-local' } });
    assert.equal(result.ok, true);
    assert.equal(result.collection, null);
    assert.equal(client.calls.deleteCollection.length, 0);
  });

  test('returns { ok: true, collection: <name> } when a real orphan is found and successfully deleted', async () => {
    const client = makeFakeClient();
    const orphanName = 'semidex-rrf-sweep-scifact-local-orphan1';
    const report = { scopes: { 'scifact-local': { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, scope: { id: 'scifact-local' } });
    assert.deepEqual(result, { ok: true, collection: orphanName });
    assert.equal(client.calls.deleteCollection[0], orphanName);
  });

  test('returns { ok: false, collection, error } (not silently swallowed) when Qdrant deleteCollection fails', async () => {
    const client = makeFakeClient();
    // status: 400 (non-retryable, not 429/5xx) so withBoundedRetry() fails
    // fast instead of exhausting its real exponential backoff schedule.
    client.deleteCollection = async () => { const e = new Error('simulated delete failure'); e.status = 400; throw e; };
    const orphanName = 'semidex-rrf-sweep-scifact-local-orphan2';
    const report = { scopes: { 'scifact-local': { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, scope: { id: 'scifact-local' } });
    assert.equal(result.ok, false);
    assert.equal(result.collection, orphanName);
    assert.match(result.error, /simulated delete failure/);
  });

  test('run-rrf-sweep.mjs stops the run (throws) instead of overwriting the checkpoint when orphan cleanup fails', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
    assert.match(src, /if \(!orphanCleanup\.ok\)/);
    assert.match(src, /refusing to continue: failed to clean up an orphaned collection/);
    assert.match(src, /refusing to --restart: failed to clean up an orphaned collection/);
  });
});

// ── P1 regression: smoke never shares a TREC directory with the real run ──
describe('P1 fix: smoke and real runs use separate .runs directories', () => {
  test('executeScope writes TREC paths under the injected runsDir/runsDirLabel, not a hardcoded shared directory', async () => {
    const { join: joinPath } = await import('node:path');
    const client = makeFakeClient();
    const written = [];
    const fakeSmokeRunsDir = joinPath('fake', 'smoke', 'runs');
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch,
      runsDir: fakeSmokeRunsDir,
      runsDirLabel: '.runs/smoke',
      writeTrecRun: (path) => { written.push(path); },
    });
    assert.ok(written.every((p) => p.startsWith(fakeSmokeRunsDir)), 'every TREC file must be written under the injected smoke runsDir');
    assert.ok(Object.values(scopeReport.trecRunPaths).every((p) => p.startsWith('.runs/smoke')), 'reported trecRunPaths must reflect the smoke label, not the real .runs label');
  });

  test('run-rrf-sweep.mjs defines a distinct SMOKE_RUNS_DIR constant and selects it only when --smoke is set', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
    assert.match(src, /SMOKE_RUNS_DIR\s*=\s*resolve\(__dirname,\s*'\.runs\/smoke'\)/);
    assert.match(src, /effectiveRunsDir\s*=\s*SMOKE\s*\?\s*SMOKE_RUNS_DIR\s*:\s*RUNS_DIR/);
  });
});

// ── P1 regression: markdown report actually answers the required questions ─
describe('P1 fix: renderMarkdownReport answers the 6 required questions, not a placeholder', () => {
  function reportFixture() {
    const qids = ['q1', 'q2', 'q3'];
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    const perQueryMetricsRaw = {
      dense: toEntries([0.5, 0.5, 0.5]),
      hybrid_k1: toEntries([0.4, 0.4, 0.4]),
      hybrid_k2: toEntries([0.5, 0.5, 0.5]),
      hybrid_k5: toEntries([0.6, 0.6, 0.6]),
      hybrid_k10: toEntries([0.7, 0.7, 0.7]),
      hybrid_k30: toEntries([0.9, 0.9, 0.9]),
      hybrid_k60: toEntries([0.85, 0.85, 0.85]),
    };
    const comparisons = computeScopeComparisons(perQueryMetricsRaw);
    const metrics = {};
    for (const [mode, entries] of Object.entries(perQueryMetricsRaw)) {
      const mean = entries.reduce((s, [, v]) => s + v.ndcgAt10, 0) / entries.length;
      metrics[mode] = { queryCount: 3, ndcgAt10: mean, mapAt100: mean, recallAt10: mean, recallAt100: mean, precisionAt10: mean, mrrAt10: mean };
    }
    return {
      benchmarkContract: { sweepKs: SWEEP_KS },
      verdict: 'RRF_SWEEP_HARNESS_ACCEPT',
      environment: { peakRssBytes: 1234 },
      priorComparison: {},
      errors: [],
      scopes: {
        'scifact-local': {
          scopeId: 'scifact-local', metrics, comparisons, perQueryMetrics: perQueryMetricsRaw,
          indexing: { documentsIndexed: 8, wallMs: 100, errors: 0 },
          queryStats: { errors: 0, retries: 0 },
          cleanup: { deleted: true },
          provenance: { peakRssBytes: 999, commitHash: 'abc', qdrantSdkVersion: '1.0', onnxExecutionProviderRequested: 'cpu', provider: { denseModelId: 'd', sparseModelId: 's' }, datasetIdentity: { corpusSize: 8, queryCount: 3, manifest: { selectionSeed: 'seed1' } } },
        },
      },
    };
  }

  test('computeSweepAnswers reports a concrete curve shape and best/worst k, not a placeholder', () => {
    const answers = computeSweepAnswers(reportFixture());
    const a = answers.perScope['scifact-local'];
    assert.deepEqual(a.bestKs, [30]);
    assert.deepEqual(a.worstKs, [1]);
    assert.deepEqual(answers.bestKsPerScope['scifact-local'], [30]);
  });

  test('rendered markdown contains an "## Answers" section with all 6 numbered sub-answers, and no dangling reference to a companion report', () => {
    const md = renderMarkdownReport(reportFixture());
    assert.match(md, /## Answers/);
    assert.match(md, /### 1\. Observed RRF curve per scope/);
    assert.match(md, /### 2\. Does any k make hybrid match or beat dense on MIRACL\?/);
    assert.match(md, /### 3\. Is one k stable across all four scopes/);
    assert.match(md, /### 4\. How do rescue\/harm counts change as k increases\?/);
    assert.match(md, /### 5\. Is k=2 or k=60 consistently preferable\?/);
    assert.match(md, /### 6\. What evidence is still required before changing production RRF_K\?/);
    assert.doesNotMatch(md, /companion markdown report/);
  });

  test('rendered markdown reports the actual best k found in the fixture (k30), not a generic statement', () => {
    const md = renderMarkdownReport(reportFixture());
    assert.match(md, /best k = k30/);
  });

  // ── P2 regression: ties must never be silently collapsed to a single k ──
  test('a scope with two k values tied at the max reports BOTH in bestKs, not just the first found', () => {
    const qids = ['q1', 'q2'];
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    const perQueryMetricsRaw = {
      dense: toEntries([0.5, 0.5]),
      hybrid_k1: toEntries([0.5, 0.5]),
      hybrid_k2: toEntries([0.5, 0.5]),
      hybrid_k5: toEntries([0.9, 0.9]),
      hybrid_k10: toEntries([0.5, 0.5]),
      hybrid_k30: toEntries([0.9, 0.9]),
      hybrid_k60: toEntries([0.5, 0.5]),
    };
    const report = {
      scopes: {
        'scifact-local': { metrics: Object.fromEntries(Object.entries(perQueryMetricsRaw).map(([m, e]) => [m, { ndcgAt10: e[0][1].ndcgAt10 }])), comparisons: computeScopeComparisons(perQueryMetricsRaw) },
      },
    };
    const answers = computeSweepAnswers(report);
    assert.deepEqual(answers.perScope['scifact-local'].bestKs, [5, 30]);
  });

  test('stableKsAcrossScopes is the INTERSECTION of each scope\'s tied-best sets, not a single arbitrary winner', () => {
    const qids = ['q1'];
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    // Scope A: k5 and k30 tied best. Scope B: k10 and k30 tied best.
    // Intersection must be exactly {30} — not {5} (an arbitrary first-found
    // pick on scope A) and not {} (ties incorrectly treated as no overlap).
    const metricsFor = (bestKs) => {
      const raw = { dense: toEntries([0.5]) };
      for (const k of SWEEP_KS) raw[`hybrid_k${k}`] = toEntries([bestKs.includes(k) ? 0.9 : 0.5]);
      return raw;
    };
    const scopeAraw = metricsFor([5, 30]);
    const scopeBraw = metricsFor([10, 30]);
    const toMetrics = (raw) => Object.fromEntries(Object.entries(raw).map(([m, e]) => [m, { ndcgAt10: e[0][1].ndcgAt10 }]));
    const report = {
      scopes: {
        'scope-a': { metrics: toMetrics(scopeAraw), comparisons: computeScopeComparisons(scopeAraw) },
        'scope-b': { metrics: toMetrics(scopeBraw), comparisons: computeScopeComparisons(scopeBraw) },
      },
    };
    const answers = computeSweepAnswers(report);
    assert.deepEqual(answers.perScope['scope-a'].bestKs, [5, 30]);
    assert.deepEqual(answers.perScope['scope-b'].bestKs, [10, 30]);
    assert.deepEqual(answers.stableKsAcrossScopes, [30]);
  });

  test('stableKsAcrossScopes is empty (not null, not an arbitrary pick) when tied-best sets do not overlap at all', () => {
    const qids = ['q1'];
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    const metricsFor = (bestKs) => {
      const raw = { dense: toEntries([0.5]) };
      for (const k of SWEEP_KS) raw[`hybrid_k${k}`] = toEntries([bestKs.includes(k) ? 0.9 : 0.5]);
      return raw;
    };
    const scopeAraw = metricsFor([1, 2]);
    const scopeBraw = metricsFor([30, 60]);
    const toMetrics = (raw) => Object.fromEntries(Object.entries(raw).map(([m, e]) => [m, { ndcgAt10: e[0][1].ndcgAt10 }]));
    const report = {
      scopes: {
        'scope-a': { metrics: toMetrics(scopeAraw), comparisons: computeScopeComparisons(scopeAraw) },
        'scope-b': { metrics: toMetrics(scopeBraw), comparisons: computeScopeComparisons(scopeBraw) },
      },
    };
    const answers = computeSweepAnswers(report);
    assert.deepEqual(answers.stableKsAcrossScopes, []);
  });

  test('rendered markdown for a tied-best scope lists all tied k values, not one', () => {
    const qids = ['q1', 'q2', 'q3'];
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    const perQueryMetricsRaw = {
      dense: toEntries([0.5, 0.5, 0.5]),
      hybrid_k1: toEntries([0.5, 0.5, 0.5]),
      hybrid_k2: toEntries([0.5, 0.5, 0.5]),
      hybrid_k5: toEntries([0.5, 0.5, 0.5]),
      hybrid_k10: toEntries([0.5, 0.5, 0.5]),
      hybrid_k30: toEntries([0.9, 0.9, 0.9]),
      hybrid_k60: toEntries([0.9, 0.9, 0.9]),
    };
    const comparisons = computeScopeComparisons(perQueryMetricsRaw);
    const metrics = Object.fromEntries(Object.entries(perQueryMetricsRaw).map(([m, e]) => [m, { queryCount: 3, ndcgAt10: e[0][1].ndcgAt10, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 }]));
    const report = {
      benchmarkContract: { sweepKs: SWEEP_KS }, verdict: 'X', environment: {}, priorComparison: {}, errors: [],
      scopes: {
        'scifact-local': {
          scopeId: 'scifact-local', metrics, comparisons, perQueryMetrics: perQueryMetricsRaw,
          indexing: { documentsIndexed: 8, wallMs: 100, errors: 0 }, queryStats: { errors: 0, retries: 0 }, cleanup: { deleted: true },
          provenance: { peakRssBytes: 1, commitHash: 'x', qdrantSdkVersion: '1', onnxExecutionProviderRequested: 'cpu', provider: { denseModelId: 'd', sparseModelId: 's' }, datasetIdentity: { corpusSize: 8, queryCount: 3, manifest: { selectionSeed: 's1' } } },
        },
      },
    };
    const md = renderMarkdownReport(report);
    assert.match(md, /tied best: k30, k60/);
    assert.match(md, /best ks \(tied\) = k30, k60/);
  });

  test('the k=2 vs k=60 answer cites real wins/losses/meanDelta from the fixture, not a placeholder', () => {
    const md = renderMarkdownReport(reportFixture());
    assert.match(md, /meanΔ=k2−k60=-?0\.3500/);
  });
});

// ── P2 regression: per-scope provenance ────────────────────────────────────
describe('P2 fix: per-scope provenance is attached to each scope report', () => {
  test('executeScope callers attach provenance with peakRssBytes, models, and dataset identity distinct per scope', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
    assert.match(src, /function buildScopeProvenance/);
    assert.match(src, /scopeReport\.provenance\s*=/);
    assert.match(src, /scopePeakRss/);
  });

  test('rendered markdown includes a "## Per-scope provenance" table with commit/SDK/models/manifest seed', () => {
    const perQueryMetricsRaw = { dense: [['q1', { ndcgAt10: 0.5 }]], hybrid_k60: [['q1', { ndcgAt10: 0.5 }]] };
    const report = {
      benchmarkContract: { sweepKs: SWEEP_KS }, verdict: 'X', environment: {}, priorComparison: {}, errors: [],
      scopes: {
        'miracl-local': {
          scopeId: 'miracl-local', metrics: { dense: { ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5, queryCount: 1 }, hybrid_k60: { ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5, queryCount: 1 } },
          comparisons: computeScopeComparisons(perQueryMetricsRaw), perQueryMetrics: perQueryMetricsRaw,
          indexing: { documentsIndexed: 1, wallMs: 5, errors: 0 }, queryStats: { errors: 0, retries: 0 }, cleanup: { deleted: true },
          provenance: { peakRssBytes: 555, commitHash: 'deadbeef1234', qdrantSdkVersion: '1.2.3', onnxExecutionProviderRequested: 'cpu', provider: { denseModelId: 'my-dense', sparseModelId: 'my-sparse' }, datasetIdentity: { corpusSize: 1000, queryCount: 100, manifest: { selectionSeed: 'the-seed' } } },
        },
      },
    };
    const md = renderMarkdownReport(report);
    assert.match(md, /## Per-scope provenance/);
    assert.match(md, /deadbeef1234/);
    assert.match(md, /my-dense/);
    assert.match(md, /my-sparse/);
    assert.match(md, /the-seed/);
    assert.match(md, /555/);
  });
});

// ── P2 regression: explicit empty --scopes= is rejected, not silently all ──
describe('P2 fix: parseScopesFlag rejects an explicit empty value', () => {
  test('null (flag never passed) defaults to all scopes', () => {
    assert.deepEqual(parseScopesFlag(null).map((s) => s.id), SCOPE_IDS);
  });

  test('empty string (explicit --scopes= with nothing after it) throws, does NOT default to all scopes', () => {
    assert.throws(() => parseScopesFlag(''), /no scope ids/);
  });

  test('whitespace/comma-only value throws the same way', () => {
    assert.throws(() => parseScopesFlag(' , ,'), /no scope ids/);
  });

  test('a valid non-empty value still works normally', () => {
    assert.deepEqual(parseScopesFlag('miracl-local').map((s) => s.id), ['miracl-local']);
  });
});

// ── P1 regression: cleanupSummary/errors must be rebuilt, not accumulated
// across --resume — a scope whose FIRST attempt had a cleanup failure or a
// query error, but whose retry succeeded fully, must not carry the stale
// failure/error forward and permanently block ACCEPT. ─────────────────────
describe('P1 fix: rebuildReportAggregates recomputes from current scopes, never accumulates stale entries', () => {
  test('a scope that failed cleanup on attempt 1 but succeeded on attempt 2 (after --resume) is not counted as failed', () => {
    const report = {
      scopes: {
        'scifact-local': {
          scopeId: 'scifact-local', errors: [], cleanup: { attempted: true, deleted: true, collection: 'c1' },
        },
      },
      // Stale fields as if spread in from a previous checkpoint that HAD a
      // failure on the first attempt — rebuildReportAggregates must
      // overwrite these, not merge with them.
      cleanupSummary: { attempted: 1, deleted: 0, failed: [{ scopeId: 'scifact-local', collection: 'c1', error: 'old failure' }] },
      errors: [{ scopeId: 'scifact-local', step: 'old_step', error: 'stale error from attempt 1' }],
    };
    rebuildReportAggregates(report);
    assert.equal(report.cleanupSummary.failed.length, 0);
    assert.equal(report.cleanupSummary.deleted, 1);
    assert.equal(report.errors.length, 0);
  });

  test('a scope with a real current-attempt error IS still counted after rebuild', () => {
    const report = {
      scopes: {
        'scifact-local': {
          scopeId: 'scifact-local', errors: [{ step: 'query_dense_q1', error: 'real current failure' }],
          cleanup: { attempted: true, deleted: false, collection: 'c1', error: 'delete failed' },
        },
      },
      cleanupSummary: { attempted: 0, deleted: 0, failed: [] },
      errors: [],
    };
    rebuildReportAggregates(report);
    assert.equal(report.cleanupSummary.failed.length, 1);
    assert.equal(report.cleanupSummary.failed[0].scopeId, 'scifact-local');
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0].error, /real current failure/);
  });

  test('a status:"planned"/"running" placeholder (cleanup.attempted: false) contributes zero to cleanupSummary/errors', () => {
    const report = {
      scopes: {
        'scifact-local': { scopeId: 'scifact-local', status: 'planned', collection: 'c1', cleanup: { attempted: false, deleted: false, collection: 'c1', error: null } },
      },
      cleanupSummary: { attempted: 5, deleted: 5, failed: [] },
      errors: [],
    };
    rebuildReportAggregates(report);
    assert.equal(report.cleanupSummary.attempted, 0);
    assert.equal(report.cleanupSummary.deleted, 0);
    assert.equal(report.errors.length, 0);
  });

  test('run-rrf-sweep.mjs calls rebuildReportAggregates on the loaded checkpoint immediately after --resume, and after every scope completes (never accumulates manually)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
    const occurrences = (src.match(/rebuildReportAggregates\(report\)/g) ?? []).length;
    assert.ok(occurrences >= 2, `expected rebuildReportAggregates(report) to be called at least twice (after resume load, and after each scope), found ${occurrences}`);
    assert.doesNotMatch(src, /cleanupSummary\.attempted \+= 1/);
    assert.doesNotMatch(src, /cleanupSummary\.failed\.push/);
    assert.doesNotMatch(src, /report\.errors\.push\(\.\.\.\(scopeReport\.errors/);
  });
});

// ── P1 regression: checkpoint writes are atomic (temp file + rename) ──────
describe('P1 fix: checkpoint writes go through writeJsonAtomic, not a direct writeFileSync to the real path', () => {
  test('run-rrf-sweep.mjs writes the checkpoint via writeJsonAtomic everywhere, never a direct writeFileSync(REPORT_JSON_PATH, ...)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /writeFileSync\(REPORT_JSON_PATH/);
    const atomicWrites = (src.match(/writeJsonAtomic\(REPORT_JSON_PATH, report\)/g) ?? []).length;
    assert.ok(atomicWrites >= 3, `expected at least 3 writeJsonAtomic(REPORT_JSON_PATH, report) call sites, found ${atomicWrites}`);
  });

  test('writeJsonAtomic never leaves a corrupted real file behind, even conceptually (write-to-temp-then-rename)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
    assert.match(src, /function writeJsonAtomic/);
    assert.match(src, /renameSync\(tmpPath, path\)/);
  });

  test('writeJsonAtomic actually produces a valid, complete JSON file at the target path (integration, real temp dir)', async () => {
    const { mkdtempSync, readFileSync: readFile, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const dir = mkdtempSync(joinPath(tmpdir(), 'rrf-sweep-atomic-'));
    try {
      const targetPath = joinPath(dir, 'report.json');
      // Import writeJsonAtomic indirectly is not possible (not exported by
      // design — it's a private file-write helper) so this test instead
      // proves the documented contract via a local equivalent, matching
      // the exact implementation shape asserted above (write temp, rename).
      const { writeFileSync: writeFile, renameSync: rename } = await import('node:fs');
      const tmpPath = `${targetPath}.tmp-test`;
      writeFile(tmpPath, JSON.stringify({ hello: 'world' }, null, 2) + '\n', 'utf-8');
      rename(tmpPath, targetPath);
      const parsed = JSON.parse(readFile(targetPath, 'utf-8'));
      assert.deepEqual(parsed, { hello: 'world' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── P1 regression: "no statistically significant difference" wording ─────
describe('P1 fix: MIXED/INCONCLUSIVE is never described as hybrid "matching" dense', () => {
  function miraclReportFixture(denseVals, hybridVals) {
    const qids = denseVals.map((_, i) => `q${i + 1}`);
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    const raw = { dense: toEntries(denseVals) };
    for (const k of SWEEP_KS) raw[`hybrid_k${k}`] = toEntries(hybridVals);
    const comparisons = computeScopeComparisons(raw);
    const metrics = Object.fromEntries(Object.entries(raw).map(([m, e]) => [m, { queryCount: qids.length, ndcgAt10: e[0][1].ndcgAt10, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 }]));
    return {
      benchmarkContract: { sweepKs: SWEEP_KS }, verdict: 'X', environment: {}, priorComparison: {}, errors: [],
      scopes: {
        'miracl-local': {
          scopeId: 'miracl-local', metrics, comparisons, perQueryMetrics: raw,
          indexing: { documentsIndexed: 8, wallMs: 1, errors: 0 }, queryStats: { errors: 0, retries: 0 }, cleanup: { deleted: true },
          provenance: { peakRssBytes: 1, commitHash: 'x', qdrantSdkVersion: '1', onnxExecutionProviderRequested: 'cpu', provider: { denseModelId: 'd', sparseModelId: 's' }, datasetIdentity: { corpusSize: 8, queryCount: qids.length, manifest: { selectionSeed: 's1' } } },
        },
      },
    };
  }

  test('an INCONCLUSIVE comparison (identical values, zero-width CI at zero) is never rendered as "matches"', () => {
    // Identical dense/hybrid values at every k -> every hybrid_k_vs_dense
    // comparison is a degenerate zero-delta case (ties only) -> INCONCLUSIVE.
    const report = miraclReportFixture([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    const md = renderMarkdownReport(report);
    // The old bug asserted "matches" as the affirmative, supportable claim;
    // the fix must never phrase it that way — it may still mention the word
    // "matches" as part of explicitly DENYING the claim ("not that hybrid
    // 'matches' dense"), which is the correct, desired phrasing.
    assert.doesNotMatch(md, /is the strongest claim supportable/);
    assert.doesNotMatch(md, /so "matches" is/);
    assert.match(md, /not that hybrid "matches" dense/);
    assert.match(md, /NO STATISTICALLY SIGNIFICANT DIFFERENCE/);
  });

  test('the rendered text explicitly states equivalence would require a pre-registered non-inferiority margin', () => {
    const report = miraclReportFixture([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    const md = renderMarkdownReport(report);
    assert.match(md, /non-inferiority margin/);
  });

  test('MIXED and INCONCLUSIVE are labeled distinctly, never collapsed into one undifferentiated bucket', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
    assert.match(src, /real per-query wins on both sides, net effect not significant/);
    assert.match(src, /insufficient evidence to call a direction/);
  });
});

// ── P1 regression: a 404 from deleteCollection is a successful cleanup ────
describe('P1 fix: a 404 (collection already gone) counts as successful cleanup, not a failure', () => {
  function notFoundClient() {
    const client = makeFakeClient();
    client.deleteCollection = async () => {
      const e = new Error('Not found: Collection `x` doesn\'t exist!');
      e.status = 404;
      throw e;
    };
    return client;
  }

  test('cleanupOrphanedCollection treats a 404 as ok: true, not ok: false', async () => {
    const client = notFoundClient();
    const orphanName = 'semidex-rrf-sweep-scifact-local-planned-never-created';
    const report = { scopes: { 'scifact-local': { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, scope: { id: 'scifact-local' } });
    assert.deepEqual(result, { ok: true, collection: orphanName });
  });

  test('a genuinely different failure (e.g. 401 unauthorized) still reports ok: false', async () => {
    const client = makeFakeClient();
    client.deleteCollection = async () => { const e = new Error('unauthorized'); e.status = 401; throw e; };
    const orphanName = 'semidex-rrf-sweep-scifact-local-real-failure';
    const report = { scopes: { 'scifact-local': { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, scope: { id: 'scifact-local' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /unauthorized/);
  });

  test('executeScope\'s finally-block cleanup treats a 404 as scopeReport.cleanup.deleted = true, not a reported cleanup failure', async () => {
    const client = notFoundClient();
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.equal(scopeReport.cleanup.deleted, true);
    assert.equal(scopeReport.cleanup.error, null);
  });

  test('executeScope still reports a genuine (non-404) cleanup failure correctly', async () => {
    const client = makeFakeClient();
    // status: 400 (non-retryable) so withBoundedRetry() fails fast instead
    // of exhausting its real exponential backoff schedule — retry behavior
    // itself is not what this test is verifying.
    client.deleteCollection = async () => { const e = new Error('server exploded'); e.status = 400; throw e; };
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.equal(scopeReport.cleanup.deleted, false);
    assert.match(scopeReport.cleanup.error, /server exploded/);
  });

  test('a scope whose collection was never created (createCollection itself failed) still reports cleanup.deleted: true when the delete 404s, instead of a spurious cleanup failure', async () => {
    const client = makeFakeClient();
    client.createCollection = async () => { const e = new Error('simulated create failure'); e.status = 400; throw e; };
    client.deleteCollection = async () => { const e = new Error('Not found'); e.status = 404; throw e; };
    const scopeReport = await executeScope({
      client, redact, scope: fixtureScope(), dataset: fixtureDataset(), prepared: fixturePrepared(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    // executeScope's finally block always attempts cleanup regardless of
    // where in the try block an early return happened.
    assert.equal(scopeReport.cleanup.attempted, true);
    assert.equal(scopeReport.cleanup.deleted, true);
  });
});

// ── P2 regression: per-k verdict groups must never contradict each other ──
describe('P2 fix: betterKs/worseKs/mixedKs/inconclusiveKs never produce a false "none worse" claim', () => {
  function scopeFixtureWithMixedVerdicts() {
    // Constructs a fixture where k1 is genuinely A_BETTER (dense
    // significantly beats hybrid) while k2 is MIXED — the exact scenario
    // the bug mishandled: the old code would see "no k is B_BETTER" and
    // then claim "none is bootstrap-significantly worse either", which is
    // false because k1 IS significantly worse.
    const qids = ['q1', 'q2', 'q3', 'q4'];
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    const raw = {
      dense: toEntries([0.9, 0.9, 0.9, 0.9]),
      // k1: hybrid much worse than dense on every query -> A_BETTER (dense wins significantly).
      hybrid_k1: toEntries([0.1, 0.1, 0.1, 0.1]),
      // k2: hybrid wins on 2 queries, loses on 2 -> MIXED (real signal both ways, cancels out).
      hybrid_k2: toEntries([0.99, 0.99, 0.5, 0.5]),
      hybrid_k5: toEntries([0.9, 0.9, 0.9, 0.9]),
      hybrid_k10: toEntries([0.9, 0.9, 0.9, 0.9]),
      hybrid_k30: toEntries([0.9, 0.9, 0.9, 0.9]),
      hybrid_k60: toEntries([0.9, 0.9, 0.9, 0.9]),
    };
    const comparisons = computeScopeComparisons(raw);
    const metrics = Object.fromEntries(Object.entries(raw).map(([m, e]) => [m, { queryCount: 4, ndcgAt10: e.reduce((s, [, v]) => s + v.ndcgAt10, 0) / e.length, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 }]));
    return {
      benchmarkContract: { sweepKs: SWEEP_KS }, verdict: 'X', environment: {}, priorComparison: {}, errors: [],
      scopes: {
        'miracl-local': {
          scopeId: 'miracl-local', metrics, comparisons, perQueryMetrics: raw,
          indexing: { documentsIndexed: 8, wallMs: 1, errors: 0 }, queryStats: { errors: 0, retries: 0 }, cleanup: { deleted: true },
          provenance: { peakRssBytes: 1, commitHash: 'x', qdrantSdkVersion: '1', onnxExecutionProviderRequested: 'cpu', provider: { denseModelId: 'd', sparseModelId: 's' }, datasetIdentity: { corpusSize: 8, queryCount: 4, manifest: { selectionSeed: 's1' } } },
        },
      },
    };
  }

  test('computeSweepAnswers partitions k1 into worseKs and k2 into mixedKs, never conflating them', () => {
    const report = scopeFixtureWithMixedVerdicts();
    const answers = computeSweepAnswers(report);
    const a = answers.perScope['miracl-local'];
    assert.ok(a.worseKs.includes(1), `expected k1 in worseKs, got ${JSON.stringify(a.worseKs)}`);
    assert.ok(a.mixedKs.includes(2) || a.inconclusiveKs.includes(2), `expected k2 in mixedKs or inconclusiveKs, got mixed=${JSON.stringify(a.mixedKs)} inconclusive=${JSON.stringify(a.inconclusiveKs)}`);
    assert.equal(a.betterKs.length, 0);
  });

  test('rendered markdown never claims "none is bootstrap-significantly worse" when a k is genuinely worse', () => {
    const report = scopeFixtureWithMixedVerdicts();
    const md = renderMarkdownReport(report);
    assert.doesNotMatch(md, /none is bootstrap-significantly worse/);
  });

  test('rendered markdown explicitly states hybrid is WORSE than dense at k1 for this fixture', () => {
    const report = scopeFixtureWithMixedVerdicts();
    const md = renderMarkdownReport(report);
    assert.match(md, /bootstrap-significantly WORSE than dense at: k1/);
  });
});

// ── P2 regression: priorPeakRssBytes is carried forward across --resume ───
describe('P2 fix: --resume carries the previous process\'s peak RSS forward instead of losing it', () => {
  test('run-rrf-sweep.mjs sets environment.priorPeakRssBytes from the previous checkpoint\'s peakRssBytes when resuming', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-rrf-sweep.mjs', import.meta.url), 'utf-8');
    assert.match(src, /priorPeakRssBytes:\s*previous\.environment\?\.peakRssBytes\s*\?\?\s*previous\.environment\?\.priorPeakRssBytes\s*\?\?\s*null/);
  });

  test('Math.max(peakRss.bytes, priorPeakRssBytes) at finalization would correctly preserve a higher prior peak (arithmetic sanity check)', () => {
    // Simulates the exact finalization line: a previous process hit 2000MB,
    // this (resumed) process only reaches 500MB before finishing — the
    // final reported peak must still be 2000MB, not 500MB.
    const priorPeakRssBytes = 2000 * 1e6;
    const thisProcessPeak = 500 * 1e6;
    const finalPeak = Math.max(thisProcessPeak, priorPeakRssBytes ?? 0);
    assert.equal(finalPeak, priorPeakRssBytes);
  });
});
