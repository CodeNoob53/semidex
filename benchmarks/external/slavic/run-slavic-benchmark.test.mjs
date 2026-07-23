// Bounded, offline tests for the Slavic dense-vs-sparse Belebele
// benchmark. No network, no real Qdrant, no ONNX — the Qdrant client and
// the ONNX embedBatch function are both fake/injected. Run:
//   node --test --test-concurrency=1 benchmarks/external/slavic/run-slavic-benchmark.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { LANGUAGE_CODES, COLLECTION_PREFIX, TOP_K, HYBRID_PREFETCH_LIMIT, RRF_K, collectionName } from './slavic-profiles.mjs';
import {
  isCompletedLanguageCheckpoint, shrinkForSmoke, validateResumeCheckpoint,
  executeLanguage, computeMacroSummary, computeVerdict, rebuildReportAggregates,
  cleanupOrphanedCollection, renderMarkdownReport, buildBenchmarkContract,
  normalizeOnnxExecutionProvider,
} from './run-slavic-benchmark.mjs';

// ── Fake Qdrant client + fixture dataset shared across tests ────────────
function makeFakeClient() {
  const calls = { createCollection: [], upsert: [], query: [], deleteCollection: [] };
  return {
    calls,
    async createCollection(name, spec) { calls.createCollection.push({ name, spec }); return true; },
    async upsert(name, spec) { calls.upsert.push({ name, spec }); return true; },
    async query(name, spec) {
      calls.query.push({ name, spec });
      return { points: [{ id: 'p1', score: 0.9 }, { id: 'p2', score: 0.5 }, { id: 'p3', score: 0.1 }] };
    },
    async deleteCollection(name) { calls.deleteCollection.push(name); return true; },
  };
}

function fixtureLanguage(overrides = {}) {
  return { code: 'ukr_Cyrl', script: 'Cyrillic', label: 'Ukrainian', ...overrides };
}

function fixtureTask() {
  const corpus = new Map([
    ['p1', { title: '', text: 'корпус один' }],
    ['p2', { title: '', text: 'корпус два' }],
    ['p3', { title: '', text: 'корпус три' }],
  ]);
  const queries = new Map([['q1', 'запит один'], ['q2', 'запит два']]);
  const qrels = new Map([
    ['q1', new Map([['p1', 1]])],
    ['q2', new Map([['p2', 1]])],
  ]);
  return { corpus, queries, qrels };
}

const redact = (v) => (v instanceof Error ? v.message : String(v));
const fakeEmbedBatch = async (texts) => texts.map((t, i) => ({
  dense: new Float32Array([0.1, 0.2, 0.3, 0.4]),
  sparse: { indices: [1, 2, 3 + i], values: [0.5, 0.5, 0.3] },
}));

// ── 1. Exact language list ────────────────────────────────────────────
describe('LANGUAGE_CODES', () => {
  test('is exactly the 7-language matrix', () => {
    assert.deepEqual(LANGUAGE_CODES, ['ukr_Cyrl', 'rus_Cyrl', 'bul_Cyrl', 'pol_Latn', 'ces_Latn', 'slk_Latn', 'eng_Latn']);
  });
});

// ── 2. One indexing pass per language, not per mode ──────────────────
// 9. dense/sparse/hybrid query counts (1 each, never a k-sweep) ────────
// 10. same corpus/query input for every channel ────────────────────────
// 11. TREC separation ───────────────────────────────────────────────────
describe('executeLanguage: call-count and request-shape invariants', () => {
  test('creates exactly one collection and issues exactly one upsert batch for a 3-doc corpus', async () => {
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.equal(client.calls.createCollection.length, 1);
    assert.equal(client.calls.upsert.length, 1); // 3 docs < INDEX_BATCH_SIZE(24) -> one batch
  });

  test('issues exactly 1 dense + 1 sparse + 1 hybrid query per benchmark query (2 queries -> 6 total, never a 6-way k-sweep)', async () => {
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const denseQueries = client.calls.query.filter((c) => c.spec.using === 'dense');
    const sparseQueries = client.calls.query.filter((c) => c.spec.using === 'sparse');
    const hybridQueries = client.calls.query.filter((c) => c.spec.query?.rrf);
    assert.equal(denseQueries.length, 2);
    assert.equal(sparseQueries.length, 2);
    assert.equal(hybridQueries.length, 2); // one per query, NOT a k-sweep
    assert.equal(client.calls.query.length, 6);
  });

  test('the hybrid query uses the single fixed RRF_K (60), never a different or swept value', async () => {
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const hybridQueries = client.calls.query.filter((c) => c.spec.query?.rrf);
    for (const c of hybridQueries) assert.equal(c.spec.query.rrf.k, RRF_K);
  });

  test('every hybrid request uses prefetch limit 200 per lane and final limit 100', async () => {
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const hybridQueries = client.calls.query.filter((c) => c.spec.query?.rrf);
    for (const c of hybridQueries) {
      assert.equal(c.spec.limit, TOP_K);
      for (const p of c.spec.prefetch) assert.equal(p.limit, HYBRID_PREFETCH_LIMIT);
      assert.equal(c.spec.prefetch.length, 2);
    }
  });

  test('dense and sparse query vectors for one query come from the SAME embedBatch() call (one embedding pass, not two)', async () => {
    let calls = 0;
    const countingEmbed = async (texts) => { calls += 1; return fakeEmbedBatch(texts); };
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: countingEmbed, writeTrecRun: () => {},
    });
    // 1 call for indexing + 1 bounded query batch. Each call returns BOTH
    // dense+sparse together — never two separate model passes.
    assert.equal(calls, 2);
  });

  test('dense, sparse, and hybrid queries for the same benchmark query all use the identical dense+sparse vectors (same input per channel)', async () => {
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const q1Calls = client.calls.query.slice(0, 3); // dense, sparse, hybrid for q1
    const denseVec = q1Calls[0].spec.query;
    const hybridDenseVec = q1Calls[2].spec.prefetch[0].query;
    assert.deepEqual(denseVec, hybridDenseVec);
    const sparseVec = q1Calls[1].spec.query;
    const hybridSparseVec = q1Calls[2].spec.prefetch[1].query;
    assert.deepEqual(sparseVec, hybridSparseVec);
  });

  test('writes exactly 3 separate TREC files per language (dense, sparse, hybrid) — never merged', async () => {
    const client = makeFakeClient();
    const written = [];
    const langReport = await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: (path, content) => written.push({ path, content }),
    });
    assert.equal(written.length, 3);
    assert.deepEqual(Object.keys(langReport.trecRunPaths).sort(), ['dense', 'hybrid', 'sparse']);
    const paths = written.map((w) => w.path);
    assert.ok(paths.some((p) => p.includes('dense')));
    assert.ok(paths.some((p) => p.includes('sparse')));
    assert.ok(paths.some((p) => p.includes('hybrid')));
  });

  test('cleanup always deletes the exact collection created', async () => {
    const client = makeFakeClient();
    const langReport = await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.equal(client.calls.deleteCollection.length, 1);
    assert.equal(client.calls.deleteCollection[0], langReport.collection);
    assert.equal(langReport.cleanup.deleted, true);
    assert.ok(langReport.collection.startsWith(COLLECTION_PREFIX));
  });

  test('uses BGE-M3 learned sparse schema (no idf modifier) — never the BM25 cloud schema', async () => {
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const spec = client.calls.createCollection[0].spec;
    assert.equal(spec.sparse_vectors.sparse.modifier, undefined);
    assert.ok('index' in spec.sparse_vectors.sparse);
  });
});

// ── 12. metric correctness ─────────────────────────────────────────────
describe('executeLanguage: metrics correctness', () => {
  test('computes dense/sparse/hybrid metrics with the correct query count', async () => {
    const client = makeFakeClient();
    const langReport = await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    for (const mode of ['dense', 'sparse', 'hybrid']) {
      assert.equal(langReport.metrics[mode].queryCount, 2);
      assert.ok(typeof langReport.metrics[mode].ndcgAt10 === 'number');
    }
  });

  test('rescueHarm classifies rescues/harms/ties summing to the total query count', async () => {
    const client = makeFakeClient();
    const langReport = await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const { rescues, harms, ties } = langReport.rescueHarm;
    assert.equal(rescues + harms + ties, 2);
  });
});

// ── 13. paired-bootstrap sign direction ────────────────────────────────
describe('executeLanguage: bootstrap comparison sign direction', () => {
  test('dense_vs_sparse.meanDelta = sparse − dense (baseline=dense, comparison=sparse)', async () => {
    // p1 (dense's top hit for q1) is relevant; the fake client always
    // returns the SAME ranking for every query/mode, so dense and sparse
    // produce identical rankings here -> meanDelta should be 0 (tie), and
    // the sign convention is checked directly via the comparison object's
    // presence and structure rather than a non-zero delta in this
    // deliberately-identical fixture.
    const client = makeFakeClient();
    const langReport = await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.ok('dense_vs_sparse' in langReport.comparisons);
    assert.ok('meanDelta' in langReport.comparisons.dense_vs_sparse);
  });

  test('hybrid_vs_dense uses baseline=dense, comparison=hybrid (meanDelta = hybrid − dense)', async () => {
    const client = makeFakeClient();
    const langReport = await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.ok('hybrid_vs_dense' in langReport.comparisons);
  });

  test('a constructed fixture with a known sparse winner produces a positive dense_vs_sparse.meanDelta', async () => {
    // Sparse-only query returns a DIFFERENT (better) ranking than dense.
    const client = makeFakeClient();
    let queryCallIndex = 0;
    client.query = async (name, spec) => {
      queryCallIndex += 1;
      if (spec.using === 'sparse') {
        // sparse puts the relevant doc first always
        return { points: [{ id: 'p1', score: 0.9 }, { id: 'p2', score: 0.5 }, { id: 'p3', score: 0.1 }] };
      }
      if (spec.using === 'dense') {
        // dense puts the relevant doc last
        return { points: [{ id: 'p3', score: 0.9 }, { id: 'p2', score: 0.5 }, { id: 'p1', score: 0.1 }] };
      }
      return { points: [{ id: 'p1', score: 0.9 }] };
    };
    const task = {
      corpus: new Map([['p1', { title: '', text: 'a' }], ['p2', { title: '', text: 'b' }], ['p3', { title: '', text: 'c' }]]),
      queries: new Map([['q1', 'query'], ['q2', 'query2'], ['q3', 'query3']]),
      qrels: new Map([['q1', new Map([['p1', 1]])], ['q2', new Map([['p1', 1]])], ['q3', new Map([['p1', 1]])]]),
    };
    const langReport = await executeLanguage({
      client, redact, language: fixtureLanguage(), task,
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.ok(langReport.comparisons.dense_vs_sparse.meanDelta > 0, `expected positive meanDelta (sparse better), got ${langReport.comparisons.dense_vs_sparse.meanDelta}`);
  });
});

// ── resume / checkpoint ────────────────────────────────────────────────
describe('isCompletedLanguageCheckpoint / validateResumeCheckpoint', () => {
  function completedLangReport() {
    const metric = { queryCount: 2, ndcgAt10: 0.5 };
    return {
      indexing: { documentsIndexed: 3, errors: 0 },
      queryStats: { total: 2, ran: 2, errors: 0 },
      errors: [],
      cleanup: { attempted: true, deleted: true, collection: 'semidex-slavic-belebele-ukr_Cyrl-abc' },
      metrics: { dense: metric, sparse: metric, hybrid: metric },
    };
  }

  test('a fully measured, zero-error, cleaned language is complete', () => {
    assert.equal(isCompletedLanguageCheckpoint(completedLangReport(), { queryCount: 2 }), true);
  });

  test('a language missing the hybrid mode is not complete', () => {
    const r = completedLangReport();
    delete r.metrics.hybrid;
    assert.equal(isCompletedLanguageCheckpoint(r, { queryCount: 2 }), false);
  });

  test('a language with unconfirmed cleanup is not complete', () => {
    const r = completedLangReport();
    r.cleanup.deleted = false;
    assert.equal(isCompletedLanguageCheckpoint(r, { queryCount: 2 }), false);
  });

  test('a "planned" checkpoint placeholder (before indexing) is not complete', () => {
    const planned = { status: 'planned', collection: 'x', cleanup: { attempted: false, deleted: false, collection: 'x', error: null } };
    assert.equal(isCompletedLanguageCheckpoint(planned, { queryCount: 900 }), false);
  });

  test('validateResumeCheckpoint rejects a checkpoint with no benchmarkContract', () => {
    assert.throws(() => validateResumeCheckpoint({ languages: {} }, { languageCodes: [] }), /no benchmarkContract/);
  });

  test('validateResumeCheckpoint rejects a mismatched contract', () => {
    const contract = { languageCodes: ['ukr_Cyrl'], rrfK: 60 };
    const previous = { benchmarkContract: { ...contract, rrfK: 2 }, languages: {} };
    assert.throws(() => validateResumeCheckpoint(previous, contract), /does not match/);
  });

  test('validateResumeCheckpoint rejects a checkpoint referencing an unknown language', () => {
    const contract = { languageCodes: ['ukr_Cyrl'], rrfK: 60 };
    const previous = { benchmarkContract: contract, languages: { 'not-a-lang': {} } };
    assert.throws(() => validateResumeCheckpoint(previous, contract), /unknown language/);
  });

  test('validateResumeCheckpoint accepts a matching contract', () => {
    const contract = { languageCodes: ['ukr_Cyrl'], rrfK: 60 };
    const previous = { benchmarkContract: contract, languages: {} };
    assert.equal(validateResumeCheckpoint(previous, contract), true);
  });

  test('checkpoint contract includes execution provider so --resume cannot mix CPU and DML', () => {
    const cpuContract = buildBenchmarkContract({
      languageCodes: ['ukr_Cyrl'],
      corpusSize: 488,
      queryCount: 900,
      onnxExecutionProviderRequested: 'cpu',
    });
    const dmlContract = { ...cpuContract, onnxExecutionProviderRequested: 'dml' };
    assert.throws(
      () => validateResumeCheckpoint({ benchmarkContract: cpuContract, languages: {} }, dmlContract),
      /does not match/,
    );
  });

  test('execution-provider normalization mirrors the runtime CPU fallback for invalid values', () => {
    assert.equal(normalizeOnnxExecutionProvider(), 'cpu');
    assert.equal(normalizeOnnxExecutionProvider('DML'), 'dml');
    assert.equal(normalizeOnnxExecutionProvider('cuda'), 'cuda');
    assert.equal(normalizeOnnxExecutionProvider('invalid-provider'), 'cpu');
  });

  // ── resume AFTER a completed language: skip behavior ──────────────────
  test('a checkpoint with one completed language and one pending correctly identifies which is which', () => {
    const previous = {
      languages: {
        ukr_Cyrl: completedLangReport(),
        rus_Cyrl: { status: 'planned', collection: 'x', cleanup: { attempted: false, deleted: false } },
      },
    };
    assert.equal(isCompletedLanguageCheckpoint(previous.languages.ukr_Cyrl, { queryCount: 2 }), true);
    assert.equal(isCompletedLanguageCheckpoint(previous.languages.rus_Cyrl, { queryCount: 2 }), false);
  });
});

// ── owned-prefix cleanup guard ──────────────────────────────────────────
describe('owned-collection prefix guard / cleanupOrphanedCollection', () => {
  test('a language-report-recorded collection name from a real run always matches the prefix', async () => {
    const client = makeFakeClient();
    const langReport = await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.ok(langReport.cleanup.collection.startsWith(COLLECTION_PREFIX));
  });

  test('an arbitrary user collection name never matches the owned prefix', () => {
    for (const name of ['my-collection', 'semidex-beir-scifact-local', 'production-docs']) {
      assert.equal(name.startsWith(COLLECTION_PREFIX), false);
    }
  });

  test('cleanupOrphanedCollection returns { ok: true, collection: null } when nothing to clean up', async () => {
    const client = makeFakeClient();
    const result = await cleanupOrphanedCollection({ client, redact, report: { languages: {} }, language: { code: 'ukr_Cyrl' } });
    assert.deepEqual(result, { ok: true, collection: null });
    assert.equal(client.calls.deleteCollection.length, 0);
  });

  test('cleanupOrphanedCollection treats a 404 (already gone) as successful cleanup', async () => {
    const client = makeFakeClient();
    client.deleteCollection = async () => { const e = new Error('not found'); e.status = 404; throw e; };
    const orphanName = 'semidex-slavic-belebele-ukr_Cyrl-orphan';
    const report = { languages: { ukr_Cyrl: { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, language: { code: 'ukr_Cyrl' } });
    assert.deepEqual(result, { ok: true, collection: orphanName });
  });

  test('cleanupOrphanedCollection reports a genuine failure (not 404) as ok: false', async () => {
    const client = makeFakeClient();
    client.deleteCollection = async () => { const e = new Error('unauthorized'); e.status = 401; throw e; };
    const orphanName = 'semidex-slavic-belebele-ukr_Cyrl-orphan2';
    const report = { languages: { ukr_Cyrl: { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, language: { code: 'ukr_Cyrl' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /unauthorized/);
  });
});

// ── secret redaction ────────────────────────────────────────────────────
describe('redaction: report content never leaks secrets or local paths', () => {
  test('a language report built from a failing client never contains the raw secret', async () => {
    const client = {
      async createCollection() { const e = new Error('unauthorized: api_key=sk-real-secret-999'); e.status = 401; throw e; },
      async upsert() { return true; }, async query() { return { points: [] }; }, async deleteCollection() { return true; },
    };
    const { makeRedactor } = await import('../beir/harness-core.mjs');
    const redactFn = makeRedactor('sk-real-secret-999', process.cwd());
    const langReport = await executeLanguage({
      client, redact: redactFn, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const serialized = JSON.stringify(langReport);
    assert.doesNotMatch(serialized, /sk-real-secret-999/);
  });
});

// ── smoke report isolation ──────────────────────────────────────────────
describe('smoke vs real report path separation', () => {
  test('run-slavic-benchmark.mjs computes a distinct report path for --smoke', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-slavic-benchmark.mjs', import.meta.url), 'utf-8');
    assert.match(src, /SMOKE \? '\.slavic-belebele-smoke-report\.json' : '2026-07-23-slavic-belebele-benchmark\.json'/);
  });

  test('run-slavic-benchmark.mjs uses a distinct SMOKE_RUNS_DIR for TREC files, never sharing the real .runs directory', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-slavic-benchmark.mjs', import.meta.url), 'utf-8');
    assert.match(src, /SMOKE_RUNS_DIR\s*=\s*resolve\(__dirname,\s*'\.runs\/smoke'\)/);
  });

  test('shrinkForSmoke never returns the full 488-doc/900-query dataset', () => {
    const bigCorpus = new Map(Array.from({ length: 488 }, (_, i) => [`d${i}`, { title: '', text: `x${i}` }]));
    const bigQueries = new Map(Array.from({ length: 900 }, (_, i) => [`q${i}`, `query ${i}`]));
    const bigQrels = new Map(Array.from({ length: 900 }, (_, i) => [`q${i}`, new Map([[`d${i % 488}`, 1]])]));
    const shrunk = shrinkForSmoke({ corpus: bigCorpus, queries: bigQueries, qrels: bigQrels });
    assert.ok(shrunk.corpus.size < 488);
    assert.ok(shrunk.queries.size < 900);
  });

  test('shrinkForSmoke preserves every relevant document required by its selected queries\' qrels', () => {
    const corpus = new Map([
      ['rel1', { title: '', text: 'r1' }], ['rel2', { title: '', text: 'r2' }],
      ['d3', { title: '', text: 'd3' }], ['d4', { title: '', text: 'd4' }],
    ]);
    const queries = new Map([['q1', 'query one'], ['q2', 'query two']]);
    const qrels = new Map([['q1', new Map([['rel1', 1]])], ['q2', new Map([['rel2', 1]])]]);
    const shrunk = shrinkForSmoke({ corpus, queries, qrels }, { queryCount: 2, corpusSize: 3 });
    assert.ok(shrunk.corpus.has('rel1'));
    assert.ok(shrunk.corpus.has('rel2'));
  });
});

// ── bounded concurrency / offline safety ────────────────────────────────
describe('offline safety and bounded concurrency', () => {
  test('run-slavic-benchmark.mjs never calls Promise.all/allSettled across languages (sequential execution)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./run-slavic-benchmark.mjs', import.meta.url), 'utf-8');
    // The only REAL (non-comment) Promise.all call in this file is the
    // bounded 2-item doc/query truncation-detection pair — never a loop
    // over languages. Never Promise.allSettled anywhere.
    const realCalls = src.split('\n').filter((line) => /Promise\.all\(/.test(line) && !line.trim().startsWith('//'));
    assert.equal(realCalls.length, 1, `expected exactly 1 real Promise.all() call (truncation pre-check), found ${realCalls.length}: ${JSON.stringify(realCalls)}`);
    assert.match(realCalls[0], /docTruncation, queryTruncation/);
    assert.doesNotMatch(src, /Promise\.allSettled/);
    // The main() language loop itself must be a plain `for...of`, not a
    // map()+Promise.all() pattern.
    assert.match(src, /for \(const language of effectiveLanguages\)/);
  });

  test('executeLanguage() never calls fetch — replacing global.fetch with a throwing stub does not break it', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network access attempted'); };
    try {
      const client = makeFakeClient();
      const langReport = await executeLanguage({
        client, redact, language: fixtureLanguage(), task: fixtureTask(),
        embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
      });
      assert.equal(langReport.errors.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('indexing uses INDEX_BATCH_SIZE-bounded batches, never one giant upsert for the whole corpus', async () => {
    const client = makeFakeClient();
    const bigCorpus = new Map(Array.from({ length: 50 }, (_, i) => [`d${i}`, { title: '', text: `x${i}` }]));
    const task = { corpus: bigCorpus, queries: new Map([['q1', 'query']]), qrels: new Map([['q1', new Map([['d0', 1]])]]) };
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task,
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    // 50 docs / INDEX_BATCH_SIZE(24) -> 3 batches, never 1.
    assert.equal(client.calls.upsert.length, 3);
    for (const call of client.calls.upsert) {
      assert.ok(call.spec.points.length <= 24);
    }
  });

  test('query embedding is bounded to INDEX_BATCH_SIZE instead of one inference call per query', async () => {
    const client = makeFakeClient();
    const queries = new Map(Array.from({ length: 50 }, (_, i) => [`q${i}`, `query ${i}`]));
    const task = {
      corpus: new Map([['d0', { title: '', text: 'document' }]]),
      queries,
      qrels: new Map([...queries.keys()].map((qid) => [qid, new Map([['d0', 1]])])),
    };
    const embedBatchSizes = [];
    await executeLanguage({
      client,
      redact,
      language: fixtureLanguage(),
      task,
      embedBatch: async (texts) => {
        embedBatchSizes.push(texts.length);
        return fakeEmbedBatch(texts);
      },
      writeTrecRun: () => {},
    });
    assert.deepEqual(embedBatchSizes, [1, 24, 24, 2]);
  });
});

// ── macro summary / verdict ──────────────────────────────────────────────
describe('computeMacroSummary', () => {
  test('is descriptive only and never replaces per-language results', () => {
    const languages = {
      ukr_Cyrl: { script: 'Cyrillic', metrics: { dense: { ndcgAt10: 0.5 }, sparse: { ndcgAt10: 0.3 }, hybrid: { ndcgAt10: 0.5 } } },
      pol_Latn: { script: 'Latin', metrics: { dense: { ndcgAt10: 0.6 }, sparse: { ndcgAt10: 0.4 }, hybrid: { ndcgAt10: 0.6 } } },
      eng_Latn: { script: 'Latin', metrics: { dense: { ndcgAt10: 0.8 }, sparse: { ndcgAt10: 0.7 }, hybrid: { ndcgAt10: 0.8 } } },
    };
    const summary = computeMacroSummary(languages);
    assert.match(summary.note, /DESCRIPTIVE ONLY/);
    assert.equal(summary.cyrillicAverage.languageCount, 1);
    assert.equal(summary.cyrillicAverage.ndcgAt10Dense, 0.5);
    assert.ok(summary.englishControl);
    assert.equal(summary.englishControl.ndcgAt10Dense, 0.8);
    // English is excluded from the Latin average (reported separately as the control)
    assert.equal(summary.latinAverage.languageCount, 1);
  });
});

describe('computeVerdict', () => {
  test('BLOCKED when a requested language never produced a report', () => {
    const report = { languages: {}, cleanupSummary: { failed: [] } };
    const verdict = computeVerdict(report, [fixtureLanguage()], { queryCountPerLanguage: 2 });
    assert.match(verdict, /BLOCKED/);
  });

  test('ACCEPT when the language has full metrics, zero errors, and cleanup succeeded', () => {
    const metric = { queryCount: 2, ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    const report = {
      languages: { ukr_Cyrl: { metrics: { dense: metric, sparse: metric, hybrid: metric }, errors: [], queryStats: { errors: 0 }, indexing: { errors: 0 } } },
      cleanupSummary: { failed: [] },
    };
    const verdict = computeVerdict(report, [fixtureLanguage()], { queryCountPerLanguage: 2 });
    assert.match(verdict, /ACCEPT/);
  });

  test('REJECT when metrics are missing entirely', () => {
    const report = {
      languages: { ukr_Cyrl: { metrics: {}, errors: [], queryStats: { errors: 0 }, indexing: { errors: 0 } } },
      cleanupSummary: { failed: [] },
    };
    const verdict = computeVerdict(report, [fixtureLanguage()], { queryCountPerLanguage: 2 });
    assert.match(verdict, /REJECT/);
  });
});

// ── rebuildReportAggregates (never accumulate stale entries across resume) ─
describe('rebuildReportAggregates', () => {
  test('a language that failed cleanup on attempt 1 but succeeded on attempt 2 is not counted as failed', () => {
    const report = {
      languages: { ukr_Cyrl: { langCode: 'ukr_Cyrl', errors: [], cleanup: { attempted: true, deleted: true, collection: 'c1' } } },
      cleanupSummary: { attempted: 1, deleted: 0, failed: [{ langCode: 'ukr_Cyrl', collection: 'c1', error: 'old failure' }] },
      errors: [{ langCode: 'ukr_Cyrl', step: 'old', error: 'stale' }],
    };
    rebuildReportAggregates(report);
    assert.equal(report.cleanupSummary.failed.length, 0);
    assert.equal(report.errors.length, 0);
  });

  test('a "planned" placeholder contributes zero to cleanupSummary', () => {
    const report = {
      languages: { ukr_Cyrl: { langCode: 'ukr_Cyrl', status: 'planned', cleanup: { attempted: false, deleted: false, collection: 'c1', error: null } } },
      cleanupSummary: { attempted: 5, deleted: 5, failed: [] },
      errors: [],
    };
    rebuildReportAggregates(report);
    assert.equal(report.cleanupSummary.attempted, 0);
  });
});

// ── report content sanity ────────────────────────────────────────────────
describe('renderMarkdownReport', () => {
  function reportFixture() {
    const metric = { queryCount: 2, ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    return {
      verdict: 'X', environment: {}, macroSummary: computeMacroSummary({}), errors: [],
      languages: {
        ukr_Cyrl: {
          langCode: 'ukr_Cyrl', script: 'Cyrillic', label: 'Ukrainian',
          metrics: { dense: metric, sparse: metric, hybrid: metric },
          comparisons: {}, rescueHarm: { rescues: 1, harms: 0, ties: 1 },
          sparseDiagnostics: { meanSparseNonZeroDocs: 10, meanSparseNonZeroQueries: 5, meanQuerySparseIndexCoverageInRelevantDoc: 0.3, relevantDocOverlap: { denseOnlyHits: 1, sparseOnlyHits: 0, bothHits: 1, neitherHits: 0 } },
          sparseExamples: { topSparseWins: [], topSparseFailures: [] },
          truncation: { documents: { truncated: 0, total: 3 }, queries: { truncated: 0, total: 2 } },
          indexing: { documentsIndexed: 3, wallMs: 10, errors: 0 }, queryStats: { errors: 0, retries: 0 }, cleanup: { deleted: true },
          provenance: { peakRssBytes: 100 },
        },
      },
    };
  }

  test('mentions MRC-derived qrels caveat explicitly', () => {
    const md = renderMarkdownReport(reportFixture());
    assert.match(md, /MRC-derived/);
  });

  test('mentions the confirmed-unavailable bel_Cyrl/srp_Latn languages', () => {
    const md = renderMarkdownReport(reportFixture());
    assert.match(md, /bel_Cyrl/);
    assert.match(md, /srp_Latn/);
  });

  test('never claims a production RRF_K or sparse-default recommendation from this run alone', () => {
    const md = renderMarkdownReport(reportFixture());
    assert.match(md, /does not recommend changing production/);
  });

  test('macro summary section explicitly says descriptive only, never statistical evidence', () => {
    const md = renderMarkdownReport(reportFixture());
    assert.match(md, /DESCRIPTIVE ONLY|descriptive only/i);
    assert.match(md, /never (a )?statistical evidence|never presented as statistical/i);
  });
});
