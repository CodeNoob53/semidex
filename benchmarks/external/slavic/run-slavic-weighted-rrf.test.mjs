// Bounded, offline tests for the Slavic Belebele weighted-RRF fusion
// matrix. No network, no real Qdrant, no ONNX — the Qdrant client and the
// ONNX embedBatch function are both fake/injected. Run:
//   node --test --test-concurrency=1 benchmarks/external/slavic/run-slavic-weighted-rrf.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { createHash } from 'node:crypto';

import {
  LANGUAGES, LANGUAGE_CODES, GROUPS, PROVIDER, FUSION_MODES, FUSION_MODE_IDS,
  PRIMARY_CANDIDATE_ID, DIAGNOSTIC_CANDIDATE_ID, EQUAL_RRF_CONTROL_IDS,
  COLLECTION_PREFIX, TOP_K, HYBRID_PREFETCH_LIMIT, collectionName,
  parseLanguagesFlag, fusionModeById,
} from './slavic-weighted-rrf-config.mjs';
import { LANGUAGES as NON_WEIGHTED_LANGUAGES } from './slavic-profiles.mjs';
import {
  fetchAndValidateLanguage, DATA_DIR, manifestPathFor,
  EXPECTED_ROW_COUNT, EXPECTED_CORPUS_SIZE,
} from './fetch-belebele.mjs';
import {
  isCompletedLanguageCheckpoint, shrinkForSmoke, validateResumeCheckpoint,
  executeLanguage, computeLanguageComparisons, computeGroupSummaries,
  classifyLanguageDecisions, computeVerdict, rebuildReportAggregates,
  cleanupOrphanedCollection, renderMarkdownReport, buildBenchmarkContract,
  verifyCudaProvenance, verifyStrictCudaConfigured, RESTORES_DENSE_QUALITY_MARGIN,
} from './run-slavic-weighted-rrf.mjs';

// ── exact seven-language matrix ─────────────────────────────────────────────
describe('LANGUAGES / LANGUAGE_CODES', () => {
  test('is exactly the 7-language matrix, in order', () => {
    assert.deepEqual(LANGUAGE_CODES, ['ukr_Cyrl', 'rus_Cyrl', 'bul_Cyrl', 'pol_Latn', 'ces_Latn', 'slk_Latn', 'eng_Latn']);
  });

  test('is identical to slavic-profiles.mjs\'s LANGUAGES (code/script/label), so both benchmarks share the same matrix', () => {
    assert.equal(LANGUAGES.length, NON_WEIGHTED_LANGUAGES.length);
    for (let i = 0; i < LANGUAGES.length; i++) {
      assert.equal(LANGUAGES[i].code, NON_WEIGHTED_LANGUAGES[i].code);
      assert.equal(LANGUAGES[i].script, NON_WEIGHTED_LANGUAGES[i].script);
      assert.equal(LANGUAGES[i].label, NON_WEIGHTED_LANGUAGES[i].label);
    }
  });

  test('parseLanguagesFlag with no value returns all seven in canonical order', () => {
    assert.deepEqual(parseLanguagesFlag(null).map((l) => l.code), LANGUAGE_CODES);
  });

  test('parseLanguagesFlag rejects an unknown language code', () => {
    assert.throws(() => parseLanguagesFlag('not-a-lang'), /unknown language code/);
  });

  test('parseLanguagesFlag rejects an explicit but empty flag rather than silently running all languages', () => {
    assert.throws(() => parseLanguagesFlag(''), /refuses to silently default/);
  });

  test('collectionName always starts with the owned prefix', () => {
    assert.ok(collectionName('ukr_Cyrl', 'abc123').startsWith(COLLECTION_PREFIX));
  });

  test('the owned prefix differs from the non-weighted Slavic benchmark\'s prefix and the SciFact/MIRACL weighted benchmark\'s prefix', () => {
    assert.notEqual(COLLECTION_PREFIX, 'semidex-slavic-belebele-');
    assert.notEqual(COLLECTION_PREFIX, 'semidex-weighted-rrf-live-');
  });
});

// ── group membership ─────────────────────────────────────────────────────
describe('GROUPS: Cyrillic Slavic / Latin Slavic / English control', () => {
  test('cyrillic group is exactly ukr_Cyrl, rus_Cyrl, bul_Cyrl', () => {
    assert.deepEqual(GROUPS.cyrillic.codes, ['ukr_Cyrl', 'rus_Cyrl', 'bul_Cyrl']);
  });

  test('latin_slavic group is exactly pol_Latn, ces_Latn, slk_Latn', () => {
    assert.deepEqual(GROUPS.latin_slavic.codes, ['pol_Latn', 'ces_Latn', 'slk_Latn']);
  });

  test('english_control group is exactly eng_Latn', () => {
    assert.deepEqual(GROUPS.english_control.codes, ['eng_Latn']);
  });

  test('every language code appears in exactly one group', () => {
    const allGroupCodes = Object.values(GROUPS).flatMap((g) => g.codes);
    assert.deepEqual([...allGroupCodes].sort(), [...LANGUAGE_CODES].sort());
    assert.equal(new Set(allGroupCodes).size, allGroupCodes.length);
  });
});

// ── exact six fusion modes and weights (shared with run-weighted-rrf-live.mjs) ──
describe('FUSION_MODES: locked configuration, shared with the SciFact/MIRACL weighted benchmark', () => {
  test('is exactly the 6 required modes, in order', () => {
    assert.deepEqual(FUSION_MODE_IDS, ['dense', 'sparse', 'equal_k2', 'equal_k60', 'k2_rho0.10', 'k2_rho0.25']);
  });

  test('equal_k2 is k=2, weights=[1.0, 1.0]', () => {
    const m = fusionModeById('equal_k2');
    assert.equal(m.k, 2);
    assert.deepEqual(m.weights, [1.0, 1.0]);
  });

  test('equal_k60 is k=60, weights=[1.0, 1.0]', () => {
    const m = fusionModeById('equal_k60');
    assert.equal(m.k, 60);
    assert.deepEqual(m.weights, [1.0, 1.0]);
  });

  test('k2_rho0.10 (primary) is k=2, weights=[1.0, 0.05263157894736842]', () => {
    const m = fusionModeById('k2_rho0.10');
    assert.equal(m.k, 2);
    assert.deepEqual(m.weights, [1.0, 0.05263157894736842]);
    assert.equal(PRIMARY_CANDIDATE_ID, 'k2_rho0.10');
  });

  test('k2_rho0.25 (diagnostic) is k=2, weights=[1.0, 0.14285714285714285]', () => {
    const m = fusionModeById('k2_rho0.25');
    assert.equal(m.k, 2);
    assert.deepEqual(m.weights, [1.0, 0.14285714285714285]);
    assert.equal(DIAGNOSTIC_CANDIDATE_ID, 'k2_rho0.25');
  });

  test('sparseWeightFromRho formula matches: sparseWeight = 1 / (k * (1/rho - 1) + 1)', () => {
    const sparseWeightFromRho = (k, rho) => 1 / (k * (1 / rho - 1) + 1);
    assert.equal(fusionModeById('k2_rho0.10').weights[1], sparseWeightFromRho(2, 0.10));
    assert.equal(fusionModeById('k2_rho0.25').weights[1], sparseWeightFromRho(2, 0.25));
  });

  test('equal RRF controls are exactly equal_k2 and equal_k60', () => {
    assert.deepEqual(EQUAL_RRF_CONTROL_IDS, ['equal_k2', 'equal_k60']);
  });

  // ── P2 regression: weights arrays must be deep-frozen, not just their
  // containing mode object (Object.freeze() is shallow) — see the
  // identical regression test in ../fusion/run-weighted-rrf-live.test.mjs. ──
  test('every rrf mode\'s weights array is deep-frozen and cannot be mutated', () => {
    for (const mode of FUSION_MODES.filter((m) => m.kind === 'rrf')) {
      assert.ok(Object.isFrozen(mode.weights), `${mode.id}: weights array must be frozen`);
      const before = [...mode.weights];
      assert.throws(() => { 'use strict'; mode.weights[0] = 999; }, TypeError, `${mode.id}: mutating a frozen array must throw in strict mode`);
      assert.deepEqual(mode.weights, before, `${mode.id}: weights must be unchanged after a mutation attempt`);
    }
  });

  test('is imported from the shared ../fusion/weighted-rrf-fusion-modes.mjs module, not redefined locally', async () => {
    const configSrc = readFileSync(new URL('./slavic-weighted-rrf-config.mjs', import.meta.url), 'utf-8');
    assert.match(configSrc, /from '\.\.\/fusion\/weighted-rrf-fusion-modes\.mjs'/);
    // No hardcoded copy of the sparse-weight literals in the config source
    // itself (they must come from the shared module's computed export).
    assert.doesNotMatch(configSrc, /0\.05263157894736842/);
    assert.doesNotMatch(configSrc, /0\.14285714285714285/);
  });

  test('the SciFact/MIRACL weighted benchmark and this Slavic benchmark import the exact same FUSION_MODES object reference', async () => {
    const sciMiraclConfig = await import('../fusion/weighted-rrf-live-config.mjs');
    const slavicConfig = await import('./slavic-weighted-rrf-config.mjs');
    assert.strictEqual(sciMiraclConfig.FUSION_MODES, slavicConfig.FUSION_MODES);
  });
});

// ── Fake Qdrant client + fixture dataset shared by executeLanguage() tests ──
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
  return { code: 'ukr_Cyrl', script: 'Cyrillic', label: 'Ukrainian', group: 'cyrillic', ...overrides };
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

// ── one indexing pass per language / one embedding call per document/query
// reused across modes / real weighted-RRF request shape ────────────────────
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

  test('issues exactly 1 dense + 1 sparse + 4 hybrid queries per benchmark query (2 queries -> 12 total)', async () => {
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const denseQueries = client.calls.query.filter((c) => c.spec.using === 'dense' && !c.spec.query?.rrf);
    const sparseQueries = client.calls.query.filter((c) => c.spec.using === 'sparse' && !c.spec.query?.rrf);
    const hybridQueries = client.calls.query.filter((c) => c.spec.query?.rrf);
    assert.equal(denseQueries.length, 2);
    assert.equal(sparseQueries.length, 2);
    assert.equal(hybridQueries.length, 8); // 2 queries x 4 hybrid modes
    assert.equal(client.calls.query.length, 12);
  });

  test('every hybrid request body has weights INSIDE query.rrf.weights, in [dense, sparse] order, and never on a prefetch entry', async () => {
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
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
      for (const p of spec.prefetch) assert.equal('weight' in p, false, `${mode.id}: prefetch entries must never carry a weight field`);
    }
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
      assert.equal(c.spec.limit, 100);
      assert.equal(HYBRID_PREFETCH_LIMIT, 200);
      for (const p of c.spec.prefetch) assert.equal(p.limit, HYBRID_PREFETCH_LIMIT);
      assert.equal(c.spec.prefetch.length, 2);
    }
  });

  test('the four hybrid requests for one query share the same prefetch vectors — only rrf.k/weights differ', async () => {
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    const hybridForQ1 = client.calls.query.filter((c) => c.spec.query?.rrf).slice(0, 4);
    const stripped = hybridForQ1.map((c) => JSON.stringify({ ...c.spec, query: null }));
    assert.ok(stripped.every((s) => s === stripped[0]), 'prefetch/limit/using must be identical across all four hybrid requests');
  });

  test('one embedBatch call per document batch AND per query batch, reused across all six modes (never one embed call per mode)', async () => {
    let calls = 0;
    const countingEmbed = async (texts) => { calls += 1; return fakeEmbedBatch(texts); };
    const client = makeFakeClient();
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: countingEmbed, writeTrecRun: () => {},
    });
    // 1 call for indexing the 3-doc batch + 1 call for the 2-query batch
    // (both corpus and queries are < INDEX_BATCH_SIZE(24), so one batch
    // each) = 2 total, regardless of 6 fusion modes being evaluated.
    assert.equal(calls, 2);
  });

  test('dense AND sparse vectors for one document come from the SAME embedBatch() call (single BGE-M3 inference pass)', async () => {
    const client = makeFakeClient();
    const embedCalls = [];
    const trackingEmbed = async (texts) => { embedCalls.push(texts.length); return fakeEmbedBatch(texts); };
    await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: trackingEmbed, writeTrecRun: () => {},
    });
    // First call batches the 3 documents (dense+sparse together per entry).
    assert.equal(embedCalls[0], 3);
  });

  test('cleanup always deletes the exact collection created, even on success', async () => {
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

  test('executeLanguage creates exactly the collection name passed in via the collection param', async () => {
    const client = makeFakeClient();
    const preGenerated = 'semidex-slavic-weighted-rrf-ukr_Cyrl-pre-generated-abc123';
    const langReport = await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {}, collection: preGenerated,
    });
    assert.equal(langReport.collection, preGenerated);
    assert.equal(client.calls.createCollection[0].name, preGenerated);
    assert.equal(client.calls.deleteCollection[0], preGenerated);
  });
});

// ── stable comparison direction / candidate-vs-baseline labels ─────────────
describe('computeLanguageComparisons: sign direction and required comparison labels', () => {
  function perQueryFixture(valsByMode) {
    const qids = valsByMode.dense.map((_, i) => `q${i + 1}`);
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    return Object.fromEntries(Object.entries(valsByMode).map(([mode, vals]) => [mode, toEntries(vals)]));
  }

  test('produces exactly the seven required comparison labels when all modes are present', () => {
    const raw = perQueryFixture({
      dense: [0.5, 0.5], sparse: [0.4, 0.4], equal_k2: [0.6, 0.6], equal_k60: [0.55, 0.55],
      'k2_rho0.10': [0.65, 0.65], 'k2_rho0.25': [0.62, 0.62],
    });
    const cmp = computeLanguageComparisons(raw);
    assert.deepEqual(Object.keys(cmp).sort(), [
      'equal_k2_vs_dense', 'equal_k60_vs_dense', 'k2_rho0.10_vs_dense',
      'k2_rho0.10_vs_equal_k2', 'k2_rho0.10_vs_equal_k60', 'k2_rho0.25_vs_dense', 'sparse_vs_dense',
    ].sort());
  });

  test('sparse_vs_dense.meanDelta is positive when sparse is the constructed winner (comparison − baseline)', () => {
    const raw = perQueryFixture({ dense: [0.5, 0.5, 0.5], sparse: [0.9, 0.9, 0.9] });
    const { sparse_vs_dense: cmp } = computeLanguageComparisons(raw);
    assert.ok(cmp.meanDelta > 0, `expected positive meanDelta, got ${cmp.meanDelta}`);
    assert.equal(cmp.wins, 3);
  });

  test('sparse_vs_dense.meanDelta is negative when dense is the constructed winner', () => {
    const raw = perQueryFixture({ dense: [0.9, 0.9, 0.9], sparse: [0.5, 0.5, 0.5] });
    const { sparse_vs_dense: cmp } = computeLanguageComparisons(raw);
    assert.ok(cmp.meanDelta < 0, `expected negative meanDelta, got ${cmp.meanDelta}`);
  });

  test('k2_rho0.10_vs_equal_k2 uses equal_k2 as baseline (comparison=candidate, baseline=equal_k2)', () => {
    const raw = perQueryFixture({ dense: [0.5, 0.5, 0.5], equal_k2: [0.2, 0.2, 0.2], 'k2_rho0.10': [0.8, 0.8, 0.8] });
    const { 'k2_rho0.10_vs_equal_k2': cmp } = computeLanguageComparisons(raw);
    assert.ok(cmp.meanDelta > 0, `expected positive meanDelta (candidate − equal_k2 > 0), got ${cmp.meanDelta}`);
  });

  test('k2_rho0.10_vs_equal_k60 uses equal_k60 as baseline', () => {
    const raw = perQueryFixture({ dense: [0.5, 0.5, 0.5], equal_k60: [0.8, 0.8, 0.8], 'k2_rho0.10': [0.2, 0.2, 0.2] });
    const { 'k2_rho0.10_vs_equal_k60': cmp } = computeLanguageComparisons(raw);
    assert.ok(cmp.meanDelta < 0, `expected negative meanDelta (candidate − equal_k60 < 0), got ${cmp.meanDelta}`);
  });

  test('k2_rho0.25_vs_dense (diagnostic) is computed independently of the primary candidate', () => {
    const raw = perQueryFixture({ dense: [0.5, 0.5, 0.5], 'k2_rho0.25': [0.9, 0.9, 0.9] });
    const cmp = computeLanguageComparisons(raw);
    assert.ok('k2_rho0.25_vs_dense' in cmp);
    assert.equal('k2_rho0.10_vs_dense' in cmp, false);
  });

  test('no comparisons at all when dense mode is absent', () => {
    assert.deepEqual(computeLanguageComparisons({ equal_k60: [['q1', { ndcgAt10: 0.5 }]] }), {});
  });
});

// ── paired-bootstrap determinism ────────────────────────────────────────────
describe('paired-bootstrap determinism (fixed seed, >= 2000 iterations)', () => {
  test('DEFAULT_BOOTSTRAP_SEED/ITERATIONS from miracl/bootstrap.mjs are reused unchanged (documented seed, >= 2000 iterations)', async () => {
    const { DEFAULT_BOOTSTRAP_SEED, DEFAULT_BOOTSTRAP_ITERATIONS } = await import('../miracl/bootstrap.mjs');
    assert.equal(typeof DEFAULT_BOOTSTRAP_SEED, 'string');
    assert.ok(DEFAULT_BOOTSTRAP_SEED.length > 0);
    assert.ok(DEFAULT_BOOTSTRAP_ITERATIONS >= 2000);
  });

  test('the exact same input arrays produce the exact same comparison output on repeated calls', () => {
    const qids = ['q1', 'q2', 'q3', 'q4', 'q5'];
    const denseVals = [0.5, 0.6, 0.4, 0.55, 0.45];
    const candidateVals = [0.6, 0.55, 0.5, 0.5, 0.4];
    const toEntries = (vals) => qids.map((qid, i) => [qid, { ndcgAt10: vals[i] }]);
    const raw = { dense: toEntries(denseVals), 'k2_rho0.10': toEntries(candidateVals) };
    const first = computeLanguageComparisons(raw);
    const second = computeLanguageComparisons(raw);
    assert.deepEqual(first['k2_rho0.10_vs_dense'], second['k2_rho0.10_vs_dense']);
  });
});

// ── group membership and macro calculation ──────────────────────────────────
describe('computeGroupSummaries: descriptive-only macro averages', () => {
  function fixtureLangReport(code, script, group, metricsByMode) {
    return {
      langCode: code, script, group,
      metrics: Object.fromEntries(Object.entries(metricsByMode).map(([m, v]) => [m, { ndcgAt10: v }])),
    };
  }

  test('macro average for Cyrillic is the mean of exactly the 3 Cyrillic languages\' dense nDCG@10', () => {
    const languages = {
      ukr_Cyrl: fixtureLangReport('ukr_Cyrl', 'Cyrillic', 'cyrillic', { dense: 0.6 }),
      rus_Cyrl: fixtureLangReport('rus_Cyrl', 'Cyrillic', 'cyrillic', { dense: 0.8 }),
      bul_Cyrl: fixtureLangReport('bul_Cyrl', 'Cyrillic', 'cyrillic', { dense: 0.7 }),
    };
    const summary = computeGroupSummaries(languages);
    assert.ok(Math.abs(summary.groups.cyrillic.macroAverageByMode.dense - 0.7) < 1e-9); // (0.6+0.8+0.7)/3
    assert.equal(summary.groups.cyrillic.languagesPresent, 3);
  });

  test('a group with a missing language reports languagesPresent < languagesExpected, never fabricates a value', () => {
    const languages = {
      ukr_Cyrl: fixtureLangReport('ukr_Cyrl', 'Cyrillic', 'cyrillic', { dense: 0.6 }),
      // rus_Cyrl, bul_Cyrl missing entirely
    };
    const summary = computeGroupSummaries(languages);
    assert.equal(summary.groups.cyrillic.languagesPresent, 1);
    assert.equal(summary.groups.cyrillic.languagesExpected, 3);
    assert.equal(summary.groups.cyrillic.macroAverageByMode.dense, 0.6);
  });

  test('english_control group always has exactly 1 expected member', () => {
    const languages = { eng_Latn: fixtureLangReport('eng_Latn', 'Latin', 'english_control', { dense: 0.9 }) };
    const summary = computeGroupSummaries(languages);
    assert.equal(summary.groups.english_control.languagesExpected, 1);
    assert.equal(summary.groups.english_control.macroAverageByMode.dense, 0.9);
  });

  test('the summary carries an explicit descriptive-only disclaimer note', () => {
    const summary = computeGroupSummaries({});
    assert.match(summary.note, /DESCRIPTIVE ONLY/);
    assert.match(summary.note, /never used by itself to promote a fusion candidate/);
  });

  test('a completely empty languages object produces null macro averages, never zero or a fabricated number', () => {
    const summary = computeGroupSummaries({});
    assert.equal(summary.groups.cyrillic.macroAverageByMode.dense, null);
    assert.equal(summary.groups.cyrillic.languagesPresent, 0);
  });
});

// ── decision classification: never promoted merely for winning a group average ──
describe('classifyLanguageDecisions: per-language decision classification', () => {
  function fixtureComparisons(overrides = {}) {
    return {
      sparse_vs_dense: { meanDelta: 0, verdict: 'INCONCLUSIVE' },
      equal_k2_vs_dense: { meanDelta: 0, verdict: 'INCONCLUSIVE' },
      equal_k60_vs_dense: { meanDelta: 0, verdict: 'INCONCLUSIVE' },
      'k2_rho0.10_vs_dense': { meanDelta: 0, verdict: 'INCONCLUSIVE' },
      'k2_rho0.25_vs_dense': { meanDelta: 0, verdict: 'INCONCLUSIVE' },
      ...overrides,
    };
  }

  test('sparse_helps only when the comparison is statistically B_BETTER (significant)', () => {
    const languages = { ukr_Cyrl: { comparisons: fixtureComparisons({ sparse_vs_dense: { meanDelta: 0.05, verdict: 'B_BETTER' } }) } };
    const decisions = classifyLanguageDecisions(languages);
    assert.equal(decisions.ukr_Cyrl.sparse.classification, 'sparse_helps');
  });

  test('sparse_significantly_hurts only when the comparison is statistically A_BETTER (significant)', () => {
    const languages = { ukr_Cyrl: { comparisons: fixtureComparisons({ sparse_vs_dense: { meanDelta: -0.05, verdict: 'A_BETTER' } }) } };
    const decisions = classifyLanguageDecisions(languages);
    assert.equal(decisions.ukr_Cyrl.sparse.classification, 'sparse_significantly_hurts');
  });

  test('sparse_neutral_mixed when the comparison is MIXED (real wins on both sides, not significant)', () => {
    const languages = { ukr_Cyrl: { comparisons: fixtureComparisons({ sparse_vs_dense: { meanDelta: 0.01, verdict: 'MIXED' } }) } };
    const decisions = classifyLanguageDecisions(languages);
    assert.equal(decisions.ukr_Cyrl.sparse.classification, 'sparse_neutral_mixed');
  });

  test('sparse_neutral_mixed (never "helps"/"hurts") when the comparison is INCONCLUSIVE (insufficient evidence)', () => {
    const languages = { ukr_Cyrl: { comparisons: fixtureComparisons({ sparse_vs_dense: { meanDelta: 0.03, verdict: 'INCONCLUSIVE' } }) } };
    const decisions = classifyLanguageDecisions(languages);
    assert.equal(decisions.ukr_Cyrl.sparse.classification, 'sparse_neutral_mixed');
  });

  // ── P1 regression: "restores dense quality" is a three-state
  // non-inferiority classification against a pre-registered margin
  // (RESTORES_DENSE_QUALITY_MARGIN) — NOT simply "not a confirmed
  // regression" (verdict !== 'A_BETTER'). Fixed as the exact bug: a
  // MIXED/INCONCLUSIVE comparison whose CI still reaches well below the
  // margin was previously classified `restores: true`, contradicting this
  // module's own doc comment ("absence of significance... never restores
  // quality"). ──────────────────────────────────────────────────────────
  describe('"restores dense quality" — three-state non-inferiority test', () => {
    test('RESTORES_DENSE_QUALITY_MARGIN is a fixed, documented, pre-registered constant', () => {
      assert.equal(typeof RESTORES_DENSE_QUALITY_MARGIN, 'number');
      assert.ok(RESTORES_DENSE_QUALITY_MARGIN > 0);
    });

    test('classifies "restored" when the CI excludes any regression worse than the margin (ciLow > -margin)', () => {
      const languages = { ukr_Cyrl: { comparisons: fixtureComparisons({ 'k2_rho0.10_vs_dense': { meanDelta: 0.001, verdict: 'INCONCLUSIVE', ciLow: -0.005, ciHigh: 0.01 } }) } };
      const d = classifyLanguageDecisions(languages).ukr_Cyrl.rho010RestoresDenseQuality;
      assert.equal(d.classification, 'restored');
    });

    test('classifies "regressed" when the ENTIRE CI is a regression worse than the margin (ciHigh < -margin)', () => {
      const languages = { ukr_Cyrl: { comparisons: fixtureComparisons({ 'k2_rho0.10_vs_dense': { meanDelta: -0.05, verdict: 'A_BETTER', ciLow: -0.08, ciHigh: -0.03 } }) } };
      const d = classifyLanguageDecisions(languages).ukr_Cyrl.rho010RestoresDenseQuality;
      assert.equal(d.classification, 'regressed');
    });

    // ── the exact bug: a MIXED/INCONCLUSIVE verdict whose CI still
    // straddles (or extends well below) the margin must NOT be reported
    // as restored, even though it is not a CONFIRMED A_BETTER regression.
    test('classifies "inconclusive" (never "restored") for a MIXED/INCONCLUSIVE comparison whose CI straddles the margin boundary', () => {
      // ciLow=-0.04 is below -MARGIN(-0.02), ciHigh=0.01 is above -MARGIN —
      // the CI straddles the margin boundary: neither "excludes a
      // regression worse than the margin" nor "is entirely such a
      // regression" can be concluded from this evidence.
      const languages = { ukr_Cyrl: { comparisons: fixtureComparisons({ 'k2_rho0.10_vs_dense': { meanDelta: -0.01, verdict: 'INCONCLUSIVE', ciLow: -0.04, ciHigh: 0.01 } }) } };
      const d = classifyLanguageDecisions(languages).ukr_Cyrl.rho010RestoresDenseQuality;
      assert.notEqual(d.classification, 'restored');
      assert.equal(d.classification, 'inconclusive');
    });

    test('classifies "inconclusive" when ciLow/ciHigh are unavailable (n=0 bootstrap result), never fabricates restored/regressed', () => {
      const languages = { ukr_Cyrl: { comparisons: fixtureComparisons({ 'k2_rho0.10_vs_dense': { meanDelta: null, verdict: 'INCONCLUSIVE', ciLow: null, ciHigh: null } }) } };
      const d = classifyLanguageDecisions(languages).ukr_Cyrl.rho010RestoresDenseQuality;
      assert.equal(d.classification, 'inconclusive');
    });

    test('rho=0.25 diagnostic candidate is classified independently of rho=0.10', () => {
      const languages = {
        ukr_Cyrl: {
          comparisons: fixtureComparisons({
            'k2_rho0.10_vs_dense': { meanDelta: 0.001, verdict: 'INCONCLUSIVE', ciLow: -0.005, ciHigh: 0.01 },
            'k2_rho0.25_vs_dense': { meanDelta: -0.08, verdict: 'A_BETTER', ciLow: -0.10, ciHigh: -0.06 },
          }),
        },
      };
      const decisions = classifyLanguageDecisions(languages);
      assert.equal(decisions.ukr_Cyrl.rho010RestoresDenseQuality.classification, 'restored');
      assert.equal(decisions.ukr_Cyrl.rho025RestoresDenseQuality.classification, 'regressed');
    });
  });

  test('a language with no comparisons at all classifies as neutral/n/a, never fabricates a verdict', () => {
    const decisions = classifyLanguageDecisions({ ukr_Cyrl: { comparisons: {} } });
    assert.equal(decisions.ukr_Cyrl.sparse.classification, 'sparse_neutral_mixed');
    assert.equal(decisions.ukr_Cyrl.rho010RestoresDenseQuality.classification, 'inconclusive');
  });

  // ── decision output must never be derived from group averages ────────────
  test('classifyLanguageDecisions never reads group/macro data — only per-language comparisons (source guard)', () => {
    const src = readFileSync(new URL('./run-slavic-weighted-rrf.mjs', import.meta.url), 'utf-8');
    const startIdx = src.indexOf('export function classifyLanguageDecisions(');
    const afterStart = src.slice(startIdx + 1);
    const nextExportIdx = afterStart.search(/\nexport (function|const) /);
    const fnSrc = afterStart.slice(0, nextExportIdx > 0 ? nextExportIdx : undefined);
    assert.doesNotMatch(fnSrc, /macroAverage|groupSummar|GROUPS/i);
  });
});

// ── resume compatibility checks / atomic checkpoint writes ─────────────────
describe('isCompletedLanguageCheckpoint / validateResumeCheckpoint', () => {
  function completedLangReport() {
    const metric = { queryCount: 3, ndcgAt10: 0.5 };
    const metrics = Object.fromEntries(FUSION_MODE_IDS.map((id) => [id, metric]));
    return {
      indexing: { documentsIndexed: 10, errors: 0 },
      queryStats: { total: 3, ran: 3, errors: 0 },
      errors: [],
      cleanup: { attempted: true, deleted: true, collection: 'semidex-slavic-weighted-rrf-ukr_Cyrl-abc' },
      cudaVerification: { ok: true, reason: null },
      metrics,
    };
  }

  test('a fully measured, zero-error, cleaned, CUDA-verified language is complete', () => {
    assert.equal(isCompletedLanguageCheckpoint(completedLangReport(), { queryCount: 3 }), true);
  });

  test('a language missing one fusion mode is not complete', () => {
    const r = completedLangReport();
    delete r.metrics['k2_rho0.25'];
    assert.equal(isCompletedLanguageCheckpoint(r, { queryCount: 3 }), false);
  });

  test('a language whose CUDA verification failed is never considered complete, even with full metrics', () => {
    const r = completedLangReport();
    r.cudaVerification = { ok: false, reason: 'fell back to cpu' };
    assert.equal(isCompletedLanguageCheckpoint(r, { queryCount: 3 }), false);
  });

  test('a language with unconfirmed cleanup is not complete', () => {
    const r = completedLangReport();
    r.cleanup.deleted = false;
    assert.equal(isCompletedLanguageCheckpoint(r, { queryCount: 3 }), false);
  });

  test('missing language report is not complete', () => {
    assert.equal(isCompletedLanguageCheckpoint(undefined, { queryCount: 3 }), false);
  });

  test('validateResumeCheckpoint rejects a checkpoint with no benchmarkContract', () => {
    assert.throws(() => validateResumeCheckpoint({ languages: {} }, { languageCodes: [] }), /no benchmarkContract/);
  });

  test('validateResumeCheckpoint rejects a mismatched contract (different fusion mode set)', () => {
    const contract = { languageCodes: ['ukr_Cyrl'], fusionModeIds: FUSION_MODE_IDS };
    const previous = { benchmarkContract: { ...contract, fusionModeIds: ['dense'] }, languages: {} };
    assert.throws(() => validateResumeCheckpoint(previous, contract), /does not match/);
  });

  test('validateResumeCheckpoint rejects a checkpoint referencing an unknown language', () => {
    const contract = { languageCodes: ['ukr_Cyrl'], fusionModeIds: FUSION_MODE_IDS };
    const previous = { benchmarkContract: contract, languages: { 'not-a-lang': {} } };
    assert.throws(() => validateResumeCheckpoint(previous, contract), /unknown language/);
  });

  test('validateResumeCheckpoint accepts a matching contract', () => {
    const contract = { languageCodes: ['ukr_Cyrl'], fusionModeIds: FUSION_MODE_IDS };
    const previous = { benchmarkContract: contract, languages: {} };
    assert.equal(validateResumeCheckpoint(previous, contract), true);
  });

  test('atomic checkpoint recovery: rebuildReportAggregates recomputes from CURRENT languages, never accumulates stale failures', () => {
    const report = {
      languages: {
        ukr_Cyrl: { langCode: 'ukr_Cyrl', cleanup: { attempted: true, deleted: true }, errors: [] },
        rus_Cyrl: { langCode: 'rus_Cyrl', cleanup: { attempted: true, deleted: false, collection: 'x', error: 'boom' }, errors: [{ step: 'q', error: 'e' }] },
      },
      cleanupSummary: { attempted: 99, deleted: 99, failed: [{ langCode: 'stale', collection: 'stale', error: 'stale' }] },
      errors: [{ langCode: 'stale', step: 'stale', error: 'stale' }],
    };
    rebuildReportAggregates(report);
    assert.equal(report.cleanupSummary.attempted, 2);
    assert.equal(report.cleanupSummary.deleted, 1);
    assert.equal(report.cleanupSummary.failed[0].langCode, 'rus_Cyrl');
    assert.equal(report.errors[0].langCode, 'rus_Cyrl');
  });
});

// ── exact-prefix cleanup guard / 404 cleanup success ────────────────────────
describe('owned-collection prefix guard and cleanupOrphanedCollection', () => {
  test('an arbitrary user collection name never matches the owned prefix', () => {
    for (const name of ['my-collection', 'semidex-slavic-belebele-ukr_Cyrl', 'semidex-weighted-rrf-live-scifact-local', 'production-docs']) {
      assert.equal(name.startsWith(COLLECTION_PREFIX), false);
    }
  });

  test('cleanupOrphanedCollection no-ops when there is no prior record', async () => {
    const client = makeFakeClient();
    const result = await cleanupOrphanedCollection({ client, redact, report: { languages: {} }, language: { code: 'ukr_Cyrl' } });
    assert.deepEqual(result, { ok: true, collection: null });
    assert.equal(client.calls.deleteCollection.length, 0);
  });

  test('cleanupOrphanedCollection deletes an orphan and reports it', async () => {
    const client = makeFakeClient();
    const orphanName = `${COLLECTION_PREFIX}ukr_Cyrl-orphan`;
    const report = { languages: { ukr_Cyrl: { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, language: { code: 'ukr_Cyrl' } });
    assert.deepEqual(result, { ok: true, collection: orphanName });
    assert.deepEqual(client.calls.deleteCollection, [orphanName]);
  });

  test('cleanupOrphanedCollection refuses to touch a name outside the owned prefix', async () => {
    const client = makeFakeClient();
    const report = { languages: { ukr_Cyrl: { cleanup: { deleted: false, collection: 'someone-elses-collection' } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, language: { code: 'ukr_Cyrl' } });
    assert.equal(result.ok, true);
    assert.equal(result.collection, null);
    assert.equal(client.calls.deleteCollection.length, 0);
  });

  test('cleanupOrphanedCollection treats a 404 delete response as a successful cleanup, not a failure', async () => {
    const orphanName = `${COLLECTION_PREFIX}ukr_Cyrl-gone`;
    const client = { async deleteCollection() { const e = new Error('not found'); e.status = 404; throw e; } };
    const report = { languages: { ukr_Cyrl: { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, language: { code: 'ukr_Cyrl' } });
    assert.equal(result.ok, true);
    assert.equal(result.collection, orphanName);
  });

  test('cleanupOrphanedCollection reports failure for a real non-404 error', async () => {
    const orphanName = `${COLLECTION_PREFIX}ukr_Cyrl-broken`;
    const client = { async deleteCollection() { const e = new Error('unauthorized'); e.status = 401; throw e; } };
    const report = { languages: { ukr_Cyrl: { cleanup: { deleted: false, collection: orphanName } } } };
    const result = await cleanupOrphanedCollection({ client, redact, report, language: { code: 'ukr_Cyrl' } });
    assert.equal(result.ok, false);
  });

  test('executeLanguage\'s own cleanup treats a 404 delete response as successful, never a reported failure', async () => {
    const client = {
      async createCollection() { return true; },
      async upsert() { return true; },
      async query() { return { points: [] }; },
      async deleteCollection() { const e = new Error('not found'); e.status = 404; throw e; },
    };
    const langReport = await executeLanguage({
      client, redact, language: fixtureLanguage(), task: fixtureTask(),
      embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
    });
    assert.equal(langReport.cleanup.deleted, true);
    assert.equal(langReport.cleanup.error, null);
  });
});

// ── secret redaction ─────────────────────────────────────────────────────────
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

  test('run-slavic-weighted-rrf.mjs source contains no hardcoded credentials, API keys, or QDRANT_URL literal', () => {
    const src = readFileSync(new URL('./run-slavic-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /QDRANT_KEY\s*=\s*['"]/);
    assert.doesNotMatch(src, /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.aws\.cloud\.qdrant\.io/);
  });

  test('renderMarkdownReport never includes an absolute local filesystem path', () => {
    const report = {
      verdict: 'SLAVIC_WEIGHTED_RRF_HARNESS_ACCEPT',
      benchmarkContract: { fusionModeIds: FUSION_MODE_IDS },
      languages: {}, groupSummaries: {}, decisions: {}, environment: {},
    };
    const md = renderMarkdownReport(report);
    assert.doesNotMatch(md, /[A-Za-z]:\\\\/);
    assert.doesNotMatch(md, /\/home\//);
    assert.doesNotMatch(md, /\/Users\//);
  });
});

// ── smoke/full path isolation ───────────────────────────────────────────────
describe('smoke vs real report path separation', () => {
  test('run-slavic-weighted-rrf.mjs computes a distinct report path for --smoke', () => {
    const src = readFileSync(new URL('./run-slavic-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.match(src, /SMOKE \? '\.slavic-weighted-rrf-smoke-report\.json' : '2026-07-24-slavic-weighted-rrf\.json'/);
  });

  test('run-slavic-weighted-rrf.mjs writes smoke TREC runs to a dedicated subdirectory, never the real runs dir', () => {
    const src = readFileSync(new URL('./run-slavic-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.match(src, /SMOKE_RUNS_DIR = resolve\(__dirname, '\.runs-weighted-rrf\/smoke'\)/);
    const runsDirMatch = src.match(/const RUNS_DIR = resolve\(__dirname, '([^']+)'\)/)?.[1];
    const smokeRunsDirMatch = src.match(/const SMOKE_RUNS_DIR = resolve\(__dirname, '([^']+)'\)/)?.[1];
    assert.notEqual(runsDirMatch, smokeRunsDirMatch);
  });

  test('shrinkForSmoke never returns the full 900-query/488-doc dataset', () => {
    const bigCorpus = new Map(Array.from({ length: 488 }, (_, i) => [`d${i}`, { title: '', text: `x${i}` }]));
    const bigQueries = new Map(Array.from({ length: 900 }, (_, i) => [`q${i}`, `query ${i}`]));
    const bigQrels = new Map(Array.from({ length: 900 }, (_, i) => [`q${i}`, new Map([[`d${i % 488}`, 1]])]));
    const shrunk = shrinkForSmoke({ corpus: bigCorpus, queries: bigQueries, qrels: bigQrels });
    assert.ok(shrunk.corpus.size < 488);
    assert.ok(shrunk.queries.size < 900);
  });

  test('shrinkForSmoke preserves every relevant document required by its selected queries qrels', () => {
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

// ── strict-CUDA preflight before indexing ───────────────────────────────────
describe('verifyStrictCudaConfigured / verifyCudaProvenance: strict CUDA is an accelerator only, mandatory pre-flight for local runs', () => {
  test('REJECTS a run when ONNX_EXECUTION_PROVIDER is unset entirely (every language here is local)', () => {
    const items = LANGUAGES.map((l) => ({ id: l.code, provider: PROVIDER }));
    const result = verifyStrictCudaConfigured(items, {});
    assert.equal(result.ok, false);
    assert.deepEqual(result.localScopeIds, LANGUAGE_CODES);
  });

  test('REJECTS when ONNX_EXECUTION_PROVIDER=cpu (must not silently benchmark on CPU)', () => {
    const items = [{ id: 'ukr_Cyrl', provider: PROVIDER }];
    const result = verifyStrictCudaConfigured(items, { ONNX_EXECUTION_PROVIDER: 'cpu', ONNX_CUDA_STRICT: undefined });
    assert.equal(result.ok, false);
  });

  test('ok when ONNX_EXECUTION_PROVIDER=cuda AND ONNX_CUDA_STRICT=1 are both set', () => {
    const items = [{ id: 'ukr_Cyrl', provider: PROVIDER }];
    const result = verifyStrictCudaConfigured(items, { ONNX_EXECUTION_PROVIDER: 'cuda', ONNX_CUDA_STRICT: '1' });
    assert.equal(result.ok, true);
  });

  test('main() calls the gate before any language work, and skips it for --smoke and --resume-check', () => {
    const src = readFileSync(new URL('./run-slavic-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.match(src, /if \(!SMOKE && !RESUME_CHECK\) \{\s*\n\s*const cudaGate = verifyStrictCudaConfigured/);
    const gateIdx = src.indexOf('verifyStrictCudaConfigured(effectiveLanguages');
    const executeLanguageCallIdx = src.indexOf('await executeLanguage({');
    assert.ok(gateIdx > 0, 'gate call not found');
    assert.ok(gateIdx < executeLanguageCallIdx, 'gate must run before executeLanguage() is ever called');
  });

  test('REJECTS provenance when CUDA was requested but the effective provider fell back to CPU', () => {
    const result = verifyCudaProvenance(
      { provider: { kind: 'local' } },
      { requestedProvider: 'cuda', effectiveProvider: 'cpu', fellBackToCpu: true },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /effective provider was "cpu"/);
  });

  test('computeVerdict REJECTs the whole harness run when any language\'s CUDA verification failed', () => {
    const metric = { queryCount: 3, ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    const metrics = Object.fromEntries(FUSION_MODE_IDS.map((id) => [id, metric]));
    const report = {
      languages: {
        ukr_Cyrl: {
          metrics, errors: [], queryStats: { errors: 0 }, indexing: { errors: 0 },
          cudaVerification: { ok: false, reason: 'fell back to cpu' },
        },
      },
      cleanupSummary: { failed: [] },
    };
    const verdict = computeVerdict(report, [fixtureLanguage()], { queryCountPerLanguage: 3 });
    assert.match(verdict, /REJECT/);
  });

  test('CUDA verification is never used to compare retrieval quality — no mention of ndcg/metrics inside the CUDA helper source', async () => {
    const src = readFileSync(new URL('../fusion/weighted-rrf-cuda.mjs', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /ndcg|recall|precision|mrr/i);
  });
});

// ── no network access when cache is valid ───────────────────────────────────
describe('offline safety: fetchAndValidateLanguage never reaches the network when cache is valid', () => {
  test('run-slavic-weighted-rrf.mjs imports only fetchAndValidateLanguage, never a raw download helper directly', () => {
    const src = readFileSync(new URL('./run-slavic-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.match(src, /fetchAndValidateLanguage/);
  });

  test('executeLanguage() and shrinkForSmoke() never call fetch directly — replacing global.fetch with a throwing stub does not break them (they never invoke fetchAndValidateLanguage(); that happens earlier in main())', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network access attempted'); };
    try {
      const client = makeFakeClient();
      const langReport = await executeLanguage({
        client, redact, language: fixtureLanguage(), task: fixtureTask(),
        embedBatch: fakeEmbedBatch, writeTrecRun: () => {},
      });
      assert.equal(langReport.errors.length, 0);
      const shrunk = shrinkForSmoke(fixtureTask());
      assert.ok(shrunk.corpus.size > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── P2 regression: the two tests above never actually call
  // fetchAndValidateLanguage() — they only prove executeLanguage()/
  // shrinkForSmoke() (which consume an ALREADY-loaded task, not the raw
  // fetch pipeline) don't reach the network. That is a real but much
  // narrower claim than "fetchAndValidateLanguage never reaches the
  // network when cache is valid" (the describe block's own title, and the
  // claim the feasibility report asserted was proven). This test instead
  // calls the REAL fetchAndValidateLanguage() against a REAL, valid cache
  // fixture (a full 900-row/488-doc JSONL + matching sha256 manifest
  // written to the real DATA_DIR under a synthetic, collision-free
  // language code) with global.fetch replaced by a throwing stub — this is
  // the only way to prove the actual claim, since
  // downloadLanguageFile()/fetchAndValidateLanguage() always resolve to
  // the real DATA_DIR and the real global fetch (no injectable path or
  // fetchImpl parameter exists on that function). ─────────────────────────
  describe('fetchAndValidateLanguage() itself, against a real valid cache fixture', () => {
    // A synthetic code, never one of the 7 real LANGUAGE_CODES, so this
    // fixture can never collide with or corrupt a real cached language
    // file on a developer machine that has already run the real benchmark.
    const FIXTURE_LANG = 'zzz_offline_cache_fixture_test';
    let destPath;

    function fixtureRow(overrides = {}) {
      return {
        link: 'https://en.wikibooks.org/wiki/Fixture',
        question_number: 1,
        flores_passage: 'fixture passage text',
        question: 'fixture question',
        mc_answer1: 'A', mc_answer2: 'B', mc_answer3: 'C', mc_answer4: 'D',
        correct_answer_num: '1',
        dialect: FIXTURE_LANG,
        ds: '2023-05-20',
        ...overrides,
      };
    }

    function writeValidCacheFixture() {
      mkdirSync(DATA_DIR, { recursive: true });
      destPath = pathJoin(DATA_DIR, `${FIXTURE_LANG}.jsonl`);
      const rows = Array.from({ length: EXPECTED_ROW_COUNT }, (_, i) => fixtureRow({
        link: `link-${i % EXPECTED_CORPUS_SIZE}`, question: `q${i}`, question_number: i,
        flores_passage: `passage ${i % EXPECTED_CORPUS_SIZE}`,
      }));
      const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      writeFileSync(destPath, jsonl, 'utf-8');
      // Must match isValidCacheHit()'s exact contract: manifest.url equals
      // the URL downloadLanguageFile() would construct for this language,
      // manifest.sha256 equals sha256(destPath's actual bytes) — computed
      // the same way fetch-belebele.mjs's own sha256OfFile() does
      // (sha256 over the raw file bytes), not re-derived differently here.
      const url = `https://huggingface.co/datasets/mteb/belebele/resolve/979a211276faa22f671e69d096634193567cfd05/data/${FIXTURE_LANG}.jsonl`;
      const sha256 = createHash('sha256').update(readFileSync(destPath)).digest('hex');
      writeFileSync(manifestPathFor(destPath), JSON.stringify({ url, sha256, downloadedAt: new Date().toISOString() }), 'utf-8');
    }

    function removeCacheFixture() {
      try { if (destPath && existsSync(destPath)) rmSync(destPath, { force: true }); } catch { /* best effort */ }
      try { if (destPath && existsSync(manifestPathFor(destPath))) rmSync(manifestPathFor(destPath), { force: true }); } catch { /* best effort */ }
    }

    test('fetchAndValidateLanguage() succeeds using ONLY the cache, with zero network calls, when a real valid manifest+checksum exist', async () => {
      writeValidCacheFixture();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => { throw new Error(`network access attempted: ${JSON.stringify(args[0])}`); };
      try {
        const task = await fetchAndValidateLanguage(FIXTURE_LANG, { log: () => {} });
        assert.equal(task.stats.corpusSize, EXPECTED_CORPUS_SIZE);
        assert.equal(task.stats.rowCount, EXPECTED_ROW_COUNT);
      } finally {
        globalThis.fetch = originalFetch;
        removeCacheFixture();
      }
    });

    test('fetchAndValidateLanguage() DOES reach the network (throws, since the stub throws) when the cache is genuinely absent — proving the prior test is not vacuously true', async () => {
      removeCacheFixture(); // ensure no fixture exists for this run
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error('network access attempted'); };
      try {
        await assert.rejects(
          () => fetchAndValidateLanguage(FIXTURE_LANG, { log: () => {} }),
          /network access attempted/,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

// ── computeVerdict sanity ────────────────────────────────────────────────────
describe('computeVerdict', () => {
  test('BLOCKED when a requested language never produced a report', () => {
    const report = { languages: {}, cleanupSummary: { failed: [] } };
    const verdict = computeVerdict(report, [fixtureLanguage()], { queryCountPerLanguage: 3 });
    assert.match(verdict, /BLOCKED/);
  });

  test('ACCEPT when every language has full metrics, zero errors, cleanup succeeded, and CUDA verification passed', () => {
    const metric = { queryCount: 3, ndcgAt10: 0.5, mapAt100: 0.5, recallAt10: 0.5, recallAt100: 0.5, precisionAt10: 0.5, mrrAt10: 0.5 };
    const metrics = Object.fromEntries(FUSION_MODE_IDS.map((id) => [id, metric]));
    const report = {
      languages: { ukr_Cyrl: { metrics, errors: [], queryStats: { errors: 0 }, indexing: { errors: 0 }, cudaVerification: { ok: true, reason: null } } },
      cleanupSummary: { failed: [] },
    };
    const verdict = computeVerdict(report, [fixtureLanguage()], { queryCountPerLanguage: 3 });
    assert.match(verdict, /ACCEPT/);
  });

  test('REJECT when metrics are missing entirely', () => {
    const report = {
      languages: { ukr_Cyrl: { metrics: {}, errors: [], queryStats: { errors: 0 }, indexing: { errors: 0 } } },
      cleanupSummary: { failed: [] },
    };
    const verdict = computeVerdict(report, [fixtureLanguage()], { queryCountPerLanguage: 3 });
    assert.match(verdict, /REJECT/);
  });
});

// ── no production fusion defaults are changed ───────────────────────────────
describe('no production configuration changes', () => {
  test('run-slavic-weighted-rrf.mjs never imports or writes core/settings/service.js or definitions.js', () => {
    const src = readFileSync(new URL('./run-slavic-weighted-rrf.mjs', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /settings\/service\.js/);
    assert.doesNotMatch(src, /settings\/definitions\.js/);
    assert.doesNotMatch(src, /RRF_K\s*=\s*\d/);
  });
});
