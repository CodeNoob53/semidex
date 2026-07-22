import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { computeVerdict, executeMiniRun, renderMarkdownReport } from './run-rrf-mini.mjs';

function fixture() {
  return {
    corpus: new Map([['doc1', { title: 'Document', text: 'Relevant text' }]]),
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
      async createCollection(name, config) {
        calls.create.push({ name, config });
      },
      async upsert(name, request) {
        calls.upsert.push({ name, request });
        indexedPointId = request.points[0].id;
      },
      async query(name, request) {
        calls.query.push({ name, request });
        return { points: [{ id: indexedPointId, score: 1 }] };
      },
      async deleteCollection(name) {
        calls.delete.push(name);
      },
    },
  };
}

const embedBatch = async (texts) => texts.map(() => ({
  dense: [1, 0],
  sparse: { indices: [1], values: [1] },
}));

describe('local RRF mini runner contract', () => {
  test('indexes one collection once and changes only RRF k between hybrid queries', async () => {
    const { client, calls } = successfulClient();
    const writes = [];
    const result = await executeMiniRun({
      client,
      redact: String,
      ...fixture(),
      embedBatch,
      writeTrecRun: (path, content) => writes.push({ path, content }),
    });

    assert.equal(calls.create.length, 1);
    assert.equal(calls.upsert.length, 1);
    assert.equal(calls.delete.length, 1);
    assert.equal(calls.delete[0], calls.create[0].name);
    assert.equal(result.indexing.documentsIndexed, 1);
    assert.equal(result.queryStats.ran, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(result.cleanup.deleted, true);
    assert.equal(writes.length, 4);

    const hybrid = calls.query.map((entry) => entry.request).filter((request) => request.query?.rrf);
    assert.equal(hybrid.length, 2);
    assert.deepEqual(hybrid[0].prefetch, hybrid[1].prefetch);
    assert.equal(hybrid[0].query.rrf.k, 2);
    assert.equal(hybrid[1].query.rrf.k, 60);
    assert.deepEqual(
      { ...hybrid[0], query: { rrf: { k: null } } },
      { ...hybrid[1], query: { rrf: { k: null } } },
      'hybrid request payloads must differ only by the RRF k value',
    );
  });

  test('deletes the temporary collection when embedding fails', async () => {
    const { client, calls } = successfulClient();
    const result = await executeMiniRun({
      client,
      redact: String,
      ...fixture(),
      embedBatch: async () => { throw new Error('synthetic embedding failure'); },
      writeTrecRun: () => {},
    });

    assert.equal(calls.create.length, 1);
    assert.equal(calls.delete.length, 1);
    assert.equal(result.cleanup.attempted, true);
    assert.equal(result.cleanup.deleted, true);
    assert.ok(result.errors.length > 0);
    assert.equal(computeVerdict(result), 'LOCAL_RRF_MINI_INVALID');
  });

  test('marks the run invalid when temporary-collection cleanup fails', async () => {
    const { client } = successfulClient();
    client.deleteCollection = async () => {
      const error = new Error('synthetic cleanup failure');
      error.status = 400;
      throw error;
    };
    const result = await executeMiniRun({
      client,
      redact: String,
      ...fixture(),
      embedBatch,
      writeTrecRun: () => {},
    });

    assert.equal(result.cleanup.attempted, true);
    assert.equal(result.cleanup.deleted, false);
    assert.match(result.cleanup.error, /synthetic cleanup failure/);
    assert.equal(computeVerdict(result), 'LOCAL_RRF_MINI_INVALID');
  });

  test('renders the provenance needed to reproduce a fresh report', () => {
    const markdown = renderMarkdownReport({
      verdict: 'LOCAL_RRF_MINI_MIXED',
      commitHash: 'abc123',
      scope: {
        denseModelId: 'bge-m3-onnx', denseSize: 1024, sparseModelId: 'bge-m3-onnx',
        corpusSize: 1000, indexBatchSize: 24,
      },
      miniSetManifest: {
        datasetMd5: 'dataset-md5', selectionSeed: 'fixed-seed', schemaVersion: 2,
        sourceHashes: [{ path: '.runs/dense.trec', sha256: 'source-sha256' }],
      },
      miniSetStats: {
        selectedQueryCount: 100, relevantDocCount: 110, negativeDocCount: 890,
        totalCorpusSize: 1000, requestedCorpusSize: 1000, shortfall: 0, danglingQrelsRefs: [],
      },
      environment: { qdrantSdkVersion: '1.18.0', peakRssBytes: 1 },
      run: null,
    });

    assert.match(markdown, /Commit: abc123/);
    assert.match(markdown, /SciFact dataset MD5: dataset-md5/);
    assert.match(markdown, /source-sha256/);
    assert.match(markdown, /fixed-seed/);
    assert.match(markdown, /Qdrant SDK: 1\.18\.0/);
  });
});
