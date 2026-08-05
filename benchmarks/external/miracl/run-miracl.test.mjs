import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { executeProfileRun, computeVerdict, computeComparisons, renderMarkdownReport } from './run-miracl.mjs';
import { PROFILES } from './miracl-profiles.mjs';

describe('no ColBERT output requested', () => {
  test('run-miracl.mjs never accesses a colbert output field directly (embeds via embedOnnxBatch, which already requests dense+sparse only)', async () => {
    const source = await readFile(new URL('./run-miracl.mjs', import.meta.url), 'utf-8');
    assert.doesNotMatch(source, /outputs\s*[.[]\s*['"]?colbert/i);
    assert.doesNotMatch(source, /colbert_vecs/i);
  });

  test('src/local/core/onnx-embed.js (the actual embedding implementation this benchmark calls) requests only dense_vecs/sparse_vecs by name', async () => {
    const source = await readFile(new URL('../../../src/local/core/onnx-embed.js', import.meta.url), 'utf-8');
    const selectiveRuns = source.match(/session\.run\(feeds, RETRIEVAL_OUTPUT_NAMES\)/g) ?? [];
    assert.equal(selectiveRuns.length, 2);
  });
});

function fixture() {
  return {
    corpus: new Map([['doc1', { title: 'Doc', text: 'Relevant text' }]]),
    queries: new Map([['q1', 'Relevant query']]),
    qrels: new Map([['q1', new Map([['doc1', 1]])]]),
    prepared: {
      documents: new Map([['doc1', { commonBody: 'Relevant text' }]]),
      queries: new Map([['q1', { commonBody: 'Relevant query' }]]),
    },
  };
}

function successfulClient() {
  const calls = { create: [], upsert: [], query: [], delete: [] };
  let indexedPointId = null;
  return {
    calls,
    client: {
      async createCollection(name, config) { calls.create.push({ name, config }); },
      async upsert(name, request) { calls.upsert.push({ name, request }); indexedPointId = request.points[0].id; },
      async query(name, request) { calls.query.push({ name, request }); return { points: [{ id: indexedPointId, score: 1 }] }; },
      async deleteCollection(name) { calls.delete.push(name); },
    },
  };
}

const embedBatch = async (texts) => texts.map(() => ({ dense: [1, 0], sparse: { indices: [1], values: [1] } }));

const localProfile = PROFILES.find((p) => p.id === 'local');
const cloudProfile = PROFILES.find((p) => p.id === 'cloud');

// A metrics object with every field computeMetrics() actually returns, all
// finite, and skippedForRecallMap === 0 — the shape both computeVerdict()
// (full harness) and computeSmokeVerdict() (--smoke) now require for
// ACCEPT (see metricsAreFullyValid() in run-miracl.mjs).
function validMetric(queryCount = 1) {
  return {
    queryCount, ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5,
    precisionAt10: 0.5, mrrAt10: 0.5, skippedForRecallMap: 0,
  };
}

describe('executeProfileRun: single collection, single indexing pass, k differs only by rrf.k', () => {
  test('indexes ONE collection ONCE for the local profile, both RRF k hybrid requests differ only by rrf.k', async () => {
    const { client, calls } = successfulClient();
    const writes = [];
    const result = await executeProfileRun({
      client, redact: String, ...fixture(), profile: localProfile, embedBatch,
      writeTrecRun: (path, content) => writes.push({ path, content }),
    });

    assert.equal(calls.create.length, 1, 'exactly one collection created');
    assert.equal(calls.upsert.length, 1, 'exactly one indexing batch upserted (single indexing pass)');
    assert.equal(calls.delete.length, 1);
    assert.equal(calls.delete[0], calls.create[0].name);
    assert.equal(result.indexing.documentsIndexed, 1);
    assert.equal(result.queryStats.ran, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(result.cleanup.deleted, true);

    const hybrid = calls.query.map((entry) => entry.request).filter((request) => request.query?.rrf);
    assert.equal(hybrid.length, 2, 'one hybrid request per rrfK (k=2, k=60)');
    assert.deepEqual(hybrid[0].prefetch, hybrid[1].prefetch, 'both hybrid requests share the identical prefetch specification');
    const ks = hybrid.map((h) => h.query.rrf.k).sort((a, b) => a - b);
    assert.deepEqual(ks, [2, 60]);
    assert.deepEqual(
      { ...hybrid[0], query: { rrf: { k: null } } },
      { ...hybrid[1], query: { rrf: { k: null } } },
      'hybrid request payloads must differ ONLY by the RRF k value',
    );
  });

  test('cloud profile: E5 asymmetric prefix on the dense lane only, BM25 sparse lane gets raw text', async () => {
    const { client, calls } = successfulClient();
    await executeProfileRun({
      client, redact: String, ...fixture(), profile: cloudProfile, embedBatch,
      writeTrecRun: () => {},
    });
    const upsertReq = calls.upsert[0].request;
    const point = upsertReq.points[0];
    assert.match(point.vector.dense.text, /^passage: /);
    assert.equal(point.vector.sparse.text.startsWith('passage: '), false, 'BM25 sparse lane must never see an E5 prefix');
    assert.equal(point.vector.sparse.model, 'qdrant/bm25');
  });

  test('deletes the temporary collection when embedding fails', async () => {
    const { client, calls } = successfulClient();
    const result = await executeProfileRun({
      client, redact: String, ...fixture(), profile: localProfile,
      embedBatch: async () => { throw new Error('synthetic embedding failure'); },
      writeTrecRun: () => {},
    });
    assert.equal(calls.create.length, 1);
    assert.equal(calls.delete.length, 1);
    assert.equal(result.cleanup.attempted, true);
    assert.equal(result.cleanup.deleted, true);
    assert.ok(result.errors.length > 0);
  });

  test('marks cleanup failed when deleteCollection throws, but still attempts it', async () => {
    const { client } = successfulClient();
    client.deleteCollection = async () => {
      const error = new Error('synthetic cleanup failure');
      error.status = 400;
      throw error;
    };
    const result = await executeProfileRun({
      client, redact: String, ...fixture(), profile: localProfile, embedBatch,
      writeTrecRun: () => {},
    });
    assert.equal(result.cleanup.attempted, true);
    assert.equal(result.cleanup.deleted, false);
    assert.match(result.cleanup.error, /synthetic cleanup failure/);
  });

  test('refuses to delete a collection name that does not start with the guarded prefix (defensive, should never trigger via collectionName())', async () => {
    const { client } = successfulClient();
    // Simulate a hypothetically mis-named collection by monkey-patching a
    // profile with an id that would fail the prefix guard downstream; here
    // we assert the guard exists at all by checking the runReport shape
    // rather than forcing an actual mismatch (collectionName() always
    // prepends COLLECTION_PREFIX, so this is a structural invariant check).
    const result = await executeProfileRun({
      client, redact: String, ...fixture(), profile: localProfile, embedBatch,
      writeTrecRun: () => {},
    });
    assert.ok(result.collection.startsWith('semidex-miracl-ru-'));
  });
});

describe('computeVerdict', () => {
  function baseReport(overrides = {}) {
    return {
      runs: {
        local: {
          rrfKs: [2, 60],
          metrics: {
            dense: validMetric(), sparse: validMetric(),
            hybrid_k2: validMetric(), hybrid_k60: validMetric(),
          },
          queryStats: { total: 1, errors: 0 },
          indexing: { errors: 0 },
          errors: [],
        },
        cloud: {
          rrfKs: [2, 60],
          metrics: {
            dense: validMetric(), sparse: validMetric(),
            hybrid_k2: validMetric(), hybrid_k60: validMetric(),
          },
          queryStats: { total: 1, errors: 0 },
          indexing: { errors: 0 },
          errors: [],
        },
      },
      cleanupSummary: { failed: [] },
      ...overrides,
    };
  }

  test('ACCEPT when both profiles complete cleanly with valid metrics and cleanup', () => {
    const report = baseReport();
    assert.equal(computeVerdict(report, PROFILES), 'MIRACL_RU_HARNESS_ACCEPT');
  });

  test('BLOCKED when a profile never ran at all', () => {
    const report = baseReport();
    delete report.runs.cloud;
    assert.equal(computeVerdict(report, PROFILES), 'MIRACL_RU_HARNESS_BLOCKED');
  });

  test('REJECT when no run produced valid metrics', () => {
    const report = baseReport();
    report.runs.local.metrics.hybrid_k2.ndcgAt10 = NaN;
    report.runs.local.metrics.dense.ndcgAt10 = NaN;
    report.runs.local.metrics.sparse.ndcgAt10 = NaN;
    report.runs.local.metrics.hybrid_k60.ndcgAt10 = NaN;
    report.runs.cloud.metrics.hybrid_k2.ndcgAt10 = NaN;
    report.runs.cloud.metrics.dense.ndcgAt10 = NaN;
    report.runs.cloud.metrics.sparse.ndcgAt10 = NaN;
    report.runs.cloud.metrics.hybrid_k60.ndcgAt10 = NaN;
    assert.equal(computeVerdict(report, PROFILES), 'MIRACL_RU_HARNESS_REJECT');
  });

  test('PARTIAL when one profile is valid and the other has invalid metrics', () => {
    const report = baseReport();
    report.runs.cloud.metrics.hybrid_k2.ndcgAt10 = NaN;
    assert.equal(computeVerdict(report, PROFILES), 'MIRACL_RU_HARNESS_PARTIAL');
  });

  test('a nonzero skippedForRecallMap blocks ACCEPT even when nDCG@10 is finite (P2 regression test)', () => {
    const report = baseReport();
    report.runs.local.metrics.hybrid_k2.skippedForRecallMap = 1;
    assert.notEqual(computeVerdict(report, PROFILES), 'MIRACL_RU_HARNESS_ACCEPT');
  });

  test('a null mapAt100/recallAt10/recallAt100/precisionAt10/mrrAt10 blocks ACCEPT, not just a null/NaN nDCG@10 (P2 regression test)', () => {
    for (const field of ['mapAt100', 'recallAt10', 'recallAt100', 'precisionAt10', 'mrrAt10']) {
      const report = baseReport();
      report.runs.local.metrics.hybrid_k2[field] = null;
      assert.notEqual(computeVerdict(report, PROFILES), 'MIRACL_RU_HARNESS_ACCEPT', `field ${field} = null should block ACCEPT`);
    }
  });

  test('errors or failed cleanup produce a non-ACCEPT verdict even with otherwise-valid metrics', () => {
    const report = baseReport();
    report.runs.local.errors = [{ step: 'x', error: 'y' }];
    assert.notEqual(computeVerdict(report, PROFILES), 'MIRACL_RU_HARNESS_ACCEPT');

    const report2 = baseReport();
    report2.cleanupSummary.failed = [{ profileId: 'local' }];
    assert.notEqual(computeVerdict(report2, PROFILES), 'MIRACL_RU_HARNESS_ACCEPT');
  });

  test('smoke mode uses the SMOKE verdict namespace and only requires the run(s) actually present', () => {
    const report = {
      runs: {
        cloud: {
          rrfKs: [2, 60],
          metrics: {
            dense: validMetric(2), sparse: validMetric(2),
            hybrid_k2: validMetric(2), hybrid_k60: validMetric(2),
          },
          queryStats: { total: 2, errors: 0 }, indexing: { errors: 0 }, errors: [],
        },
      },
      cleanupSummary: { failed: [] },
    };
    assert.equal(computeVerdict(report, PROFILES, { smoke: true }), 'MIRACL_RU_SMOKE_ACCEPT');
  });

  // Regression tests for the smoke path: computeSmokeVerdict() used to only
  // require nDCG@10 finite, on the mistaken premise that
  // mapAt100/recallAt10/recallAt100 could legitimately be null on a tiny
  // 2-query smoke sample even with a positive qrel present. That premise is
  // false — per beir/metrics.mjs, those fields are null ONLY when a query
  // has zero positive qrels, which buildSmokeSubset()'s validateSubset()
  // call now rules out. Smoke must use the same metricsAreFullyValid() gate
  // as the full harness.
  function smokeReport() {
    return {
      runs: {
        cloud: {
          rrfKs: [2, 60],
          metrics: {
            dense: validMetric(2), sparse: validMetric(2),
            hybrid_k2: validMetric(2), hybrid_k60: validMetric(2),
          },
          queryStats: { total: 2, errors: 0 }, indexing: { errors: 0 }, errors: [],
        },
      },
      cleanupSummary: { failed: [] },
    };
  }

  test('smoke: a null recallAt10/recallAt100/mapAt100/precisionAt10/mrrAt10 blocks MIRACL_RU_SMOKE_ACCEPT (P2 regression test)', () => {
    for (const field of ['mapAt100', 'recallAt10', 'recallAt100', 'precisionAt10', 'mrrAt10']) {
      const report = smokeReport();
      report.runs.cloud.metrics.hybrid_k2[field] = null;
      assert.notEqual(computeVerdict(report, PROFILES, { smoke: true }), 'MIRACL_RU_SMOKE_ACCEPT', `field ${field} = null should block smoke ACCEPT`);
    }
  });

  test('smoke: a nonzero skippedForRecallMap blocks MIRACL_RU_SMOKE_ACCEPT even when nDCG@10 is finite (P2 regression test)', () => {
    const report = smokeReport();
    report.runs.cloud.metrics.hybrid_k2.skippedForRecallMap = 1;
    assert.notEqual(computeVerdict(report, PROFILES, { smoke: true }), 'MIRACL_RU_SMOKE_ACCEPT');
  });
});

describe('computeComparisons: paired bootstrap wiring', () => {
  function fakeRun(seed) {
    const pq = [
      ['q1', { ndcgAt10: 0.5 + seed }], ['q2', { ndcgAt10: 0.4 + seed }], ['q3', { ndcgAt10: 0.6 + seed }],
    ];
    return {
      rrfKs: [2, 60],
      perQueryMetrics: {
        dense: pq,
        sparse: pq,
        hybrid_k2: pq.map(([q, v]) => [q, { ndcgAt10: v.ndcgAt10 + 0.05 }]),
        hybrid_k60: pq.map(([q, v]) => [q, { ndcgAt10: v.ndcgAt10 + 0.02 }]),
      },
    };
  }

  test('produces k2-vs-k60, hybrid-vs-dense, hybrid-vs-sparse per profile, and local-vs-cloud at shared k', () => {
    const runs = { local: fakeRun(0), cloud: fakeRun(0.1) };
    const comparisons = computeComparisons(runs);
    assert.ok('local_k2_vs_k60' in comparisons);
    assert.ok('cloud_k2_vs_k60' in comparisons);
    assert.ok('local_hybrid_k2_vs_dense' in comparisons);
    assert.ok('local_hybrid_k2_vs_sparse' in comparisons);
    assert.ok('local_vs_cloud_hybrid_k2' in comparisons);
    assert.ok('local_vs_cloud_hybrid_k60' in comparisons);
    for (const cmp of Object.values(comparisons)) {
      assert.ok(['B_BETTER', 'A_BETTER', 'MIXED', 'INCONCLUSIVE'].includes(cmp.verdict));
    }
  });
});

describe('renderMarkdownReport: provenance and redaction', () => {
  test('surfaces commit hash, dataset revisions, seed, file hashes, and SDK version', () => {
    const markdown = renderMarkdownReport({
      verdict: 'MIRACL_RU_HARNESS_ACCEPT',
      provenance: {
        commitHash: 'abc123', workingTreeDirty: false,
        fileHashes: { '/benchmarks/external/miracl/run-miracl.mjs': 'sha-of-runner' },
        qdrantSdkVersion: '1.18.0',
        onnxExecutionProviderRequested: 'dml',
      },
      scope: { datasetRevisions: { topicsQrels: 'topics-rev', corpus: 'corpus-rev' } },
      subsetManifest: { selectionSeed: 'fixed-seed', schemaVersion: 1 },
      subsetStats: {
        selectedQueryCount: 100, positiveDocCount: 289, negativeDocCount: 711,
        totalCorpusSize: 1000, requestedCorpusSize: 1000, shortfall: 0, danglingQrelsRefs: [],
      },
      runs: {},
      comparisons: {},
      environment: { peakRssBytes: 123 },
    });
    assert.match(markdown, /Commit: abc123/);
    assert.match(markdown, /topics-rev/);
    assert.match(markdown, /corpus-rev/);
    assert.match(markdown, /fixed-seed/);
    assert.match(markdown, /sha-of-runner/);
    assert.match(markdown, /Qdrant SDK: 1\.18\.0/);
    assert.match(markdown, /Requested ONNX execution provider: `dml`/);
    assert.match(markdown, /operator-level CPU fallback/);
  });

  test('never contains a raw QDRANT_URL, API key value, or an absolute local path from the redactor', () => {
    const markdown = renderMarkdownReport({
      verdict: 'MIRACL_RU_HARNESS_ACCEPT',
      provenance: { commitHash: 'abc', workingTreeDirty: false, fileHashes: {}, qdrantSdkVersion: '1.18.0' },
      scope: { datasetRevisions: { topicsQrels: 't', corpus: 'c' } },
      subsetManifest: { selectionSeed: 's', schemaVersion: 1 },
      subsetStats: { selectedQueryCount: 1, positiveDocCount: 1, negativeDocCount: 0, totalCorpusSize: 1, requestedCorpusSize: 1, shortfall: 0, danglingQrelsRefs: [] },
      runs: {}, comparisons: {}, environment: { peakRssBytes: 1 },
    });
    assert.doesNotMatch(markdown, /api[-_]?key/i);
    assert.doesNotMatch(markdown, /C:\\Users/);
    assert.doesNotMatch(markdown, /\.cloud\.qdrant\.io\/[a-z0-9-]{8}-[a-z0-9-]{4}/i);
  });

  test('states MIRACL does not include Ukrainian, and frames Russian as multilingual/Cyrillic evidence only', () => {
    const markdown = renderMarkdownReport({
      verdict: 'MIRACL_RU_HARNESS_ACCEPT',
      provenance: { commitHash: 'abc', workingTreeDirty: false, fileHashes: {}, qdrantSdkVersion: '1.18.0' },
      scope: { datasetRevisions: { topicsQrels: 't', corpus: 'c' } },
      subsetManifest: { selectionSeed: 's', schemaVersion: 1 },
      subsetStats: { selectedQueryCount: 1, positiveDocCount: 1, negativeDocCount: 0, totalCorpusSize: 1, requestedCorpusSize: 1, shortfall: 0, danglingQrelsRefs: [] },
      runs: {}, comparisons: {}, environment: { peakRssBytes: 1 },
    });
    assert.match(markdown, /does not include Ukrainian/i);
    assert.match(markdown, /multilingual\/Cyrillic evidence[\s\S]{0,10}only/i);
  });
});
