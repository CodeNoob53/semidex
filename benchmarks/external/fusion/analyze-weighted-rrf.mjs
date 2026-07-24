// Offline weighted-RRF candidate analysis, using ONLY already-completed
// TREC runs from the BEIR SciFact, MIRACL Russian, and Slavic Belebele
// benchmarks. Narrows weighted-RRF configurations before any new live
// Qdrant benchmark — it never queries Qdrant itself.
//
// STRICTLY OFFLINE: no ONNX, no Qdrant client, no network, no indexing.
// Every loader here reads only already-written local files (TREC runs,
// cached dataset JSON) and throws if a required file is missing — it
// never fetches or rebuilds.
//
// ── Qdrant's REAL weighted-RRF formula (not the naive weight/(k+rank)) ──
// Qdrant 1.17+ supports `query: { rrf: { k, weights: [denseWeight,
// sparseWeight] } }`. Its actual per-document contribution for one
// prefetch lane, given the document's ZERO-BASED rank in that lane and
// the lane's weight, is:
//
//   contribution(rank, weight, k) = 1 / (k + (rank + 1) / weight - 1)
//
// This is NOT weight / (k + rank) — that formula is explicitly wrong and
// is never used anywhere in this module. A document's fused score is the
// SUM of its per-lane contributions (0 contribution for a lane it does
// not appear in at all).
//
// Weight parametrization: raw Qdrant weights mean very different things
// under different k (see weightedRrfContribution()'s own doc comment for
// the exact reason — k dominates the denominator at large k, so a raw
// weight change barely moves the top-rank contribution there). This
// module therefore parametrizes configurations by a TARGET rank-1
// contribution ratio `rho = sparseContribution(rank=0) /
// denseContribution(rank=0)`, converted to an actual Qdrant sparse weight
// via `sparseWeightFromRho()` — see that function for the closed-form
// conversion and its exact algebraic derivation.
//
// query.rrf.weights is NEVER emulated via prefetch.weight (prefetch has
// no such field in Qdrant's real hybrid-query API) and dense-only is
// never emulated as "hybrid with sparse weight 0" — it is evaluated as
// its own genuinely separate baseline (the plain dense TREC run).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadTrecRunAsRanked, validateTrecRun, loadBeirFullQrels, loadMiraclQrels,
} from './analyze-fusion.mjs';
import { computeMetrics } from '../beir/metrics.mjs';
import { pairedBootstrapByQuery, perQueryMetrics, DEFAULT_BOOTSTRAP_SEED, DEFAULT_BOOTSTRAP_ITERATIONS } from '../miracl/bootstrap.mjs';
import {
  DATA_DIR as BELEBELE_DATA_DIR, parseJsonlRows, validateRowSchema, synthesizeRetrievalTask,
  validateRetrievalTask, BELEBELE_REPO, BELEBELE_REVISION,
} from '../slavic/fetch-belebele.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const BEIR_RUNS_DIR = resolve(__dirname, '../beir/.runs');
const MIRACL_RUNS_DIR = resolve(__dirname, '../miracl/.runs');
const FUSION_RUNS_DIR = resolve(__dirname, '.runs');
const SLAVIC_RUNS_DIR = resolve(__dirname, '../slavic/.runs');
const RESULTS_DIR = resolve(__dirname, '../results');

const REPORT_JSON_PATH = resolve(RESULTS_DIR, '2026-07-23-weighted-rrf-offline-analysis.json');
const REPORT_MD_PATH = resolve(RESULTS_DIR, '2026-07-23-weighted-rrf-offline-analysis.md');

// ── locked parametrization ──────────────────────────────────────────────
export const RHO_VALUES = Object.freeze([0.10, 0.25, 0.50, 0.75, 1.00]);
export const K_VALUES = Object.freeze([2, 60]);
export const DENSE_WEIGHT = 1.0;
export const TOP_K = 100; // evaluation depth (final fused ranking, per task)
const FLOAT_TOLERANCE = 1e-6;

// ── Qdrant weighted-RRF formula ─────────────────────────────────────────

/**
 * Qdrant's exact per-lane weighted-RRF contribution for one document at a
 * given ZERO-BASED rank in that lane. NEVER weight/(k+rank) — that is the
 * explicitly-incorrect formula this module must never implement.
 * @param {number} rank zero-based rank (0 = first result)
 * @param {number} weight lane weight (denseWeight or sparseWeight)
 * @param {number} k RRF k constant
 */
export function weightedRrfContribution(rank, weight, k) {
  return 1 / (k + (rank + 1) / weight - 1);
}

/**
 * Converts a target rank-1 contribution ratio (rho = sparse/dense
 * contribution at rank=0, with denseWeight=1) into the actual Qdrant
 * sparse weight to pass in query.rrf.weights[1].
 *
 * Derivation: at rank=0, contribution(0, w, k) = 1 / (k + 1/w - 1). Setting
 * rho = contribution(0, sparseWeight, k) / contribution(0, 1, k) and
 * solving for sparseWeight yields the closed form below. Verified against
 * all 10 (k, rho) example pairs the task specifies, to within 1e-6.
 */
export function sparseWeightFromRho(k, rho) {
  return 1 / (k * (1 / rho - 1) + 1);
}

// ── offline weighted fusion ──────────────────────────────────────────────

/**
 * Merges dense and sparse ranked lists (already zero-based-rank-ordered,
 * best first) into ONE fused ranking of the given depth, using Qdrant's
 * real weighted-RRF contribution formula. A document present in only one
 * lane receives ONLY that lane's contribution (never a fabricated
 * contribution for the lane it is absent from). Ties (identical fused
 * score) are broken by a single documented deterministic rule: the
 * document that appears at the BETTER (lower) rank in the DENSE lane wins;
 * if it is absent from dense, the better sparse rank wins; if still tied
 * (e.g. present in neither, which cannot happen for a merged document, or
 * identical rank in both lanes), the doc ID string sort order is used as
 * the final, fully deterministic tiebreaker. This rule is fixed BEFORE
 * looking at any qrels/metric — it is never tuned to improve a score.
 */
export function fuseWeightedRrf(denseRanked, sparseRanked, { k, denseWeight, sparseWeight, depth = TOP_K }) {
  const denseRankOf = new Map(denseRanked.map((docId, i) => [docId, i]));
  const sparseRankOf = new Map(sparseRanked.map((docId, i) => [docId, i]));
  const allDocIds = new Set([...denseRankOf.keys(), ...sparseRankOf.keys()]);

  const scored = [];
  for (const docId of allDocIds) {
    let score = 0;
    const dRank = denseRankOf.get(docId);
    if (dRank !== undefined) score += weightedRrfContribution(dRank, denseWeight, k);
    const sRank = sparseRankOf.get(docId);
    if (sRank !== undefined) score += weightedRrfContribution(sRank, sparseWeight, k);
    scored.push({ docId, score, dRank, sRank });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tie-break, fixed before any qrels are consulted:
    // 1) better (lower) dense rank wins; docs absent from dense sort after
    //    docs present in dense.
    const aDense = a.dRank ?? Infinity;
    const bDense = b.dRank ?? Infinity;
    if (aDense !== bDense) return aDense - bDense;
    // 2) better (lower) sparse rank wins.
    const aSparse = a.sRank ?? Infinity;
    const bSparse = b.sRank ?? Infinity;
    if (aSparse !== bSparse) return aSparse - bSparse;
    // 3) doc ID string sort order — fully deterministic, never data-dependent.
    return a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0;
  });

  return scored.slice(0, depth).map((s) => s.docId);
}

/** Fuses every query in `qids` using fuseWeightedRrf(), returning
 * Map<queryId, string[]> ready for computeMetrics()/perQueryMetrics(). */
export function fuseWeightedRrfAllQueries(qids, denseByQuery, sparseByQuery, config) {
  const result = new Map();
  for (const qid of qids) {
    const dense = denseByQuery.get(qid) ?? [];
    const sparse = sparseByQuery.get(qid) ?? [];
    result.set(qid, fuseWeightedRrf(dense, sparse, config));
  }
  return result;
}

// ── input validation ────────────────────────────────────────────────────

function loadModeOrThrow(path, expectedQueryIds, label) {
  if (!existsSync(path)) {
    throw new Error(`[analyze-weighted-rrf] required TREC file missing: ${path} (${label})`);
  }
  const { ranked, byQueryRaw } = loadTrecRunAsRanked(path);
  validateTrecRun(byQueryRaw, { expectedQueryIds, label });
  return ranked;
}

function loadModeIfExists(path, expectedQueryIds, label) {
  if (!existsSync(path)) return null;
  const { ranked, byQueryRaw } = loadTrecRunAsRanked(path);
  validateTrecRun(byQueryRaw, { expectedQueryIds, label });
  return ranked;
}

/** Records the available ranking depth per mode for one scope — the
 * minimum and maximum number of ranked documents across all queries. A
 * scope whose min depth is 0 for a required channel cannot be fused for
 * any query and must be reported explicitly, never silently skipped or
 * padded with fabricated candidates. */
function recordRankingDepth(qids, rankedByQuery) {
  let min = Infinity;
  let max = 0;
  for (const qid of qids) {
    const len = (rankedByQuery.get(qid) ?? []).length;
    if (len < min) min = len;
    if (len > max) max = len;
  }
  if (min === Infinity) min = 0;
  return { min, max };
}

/** Strictly offline Belebele loader: reads ONLY the already-cached JSONL
 * file for one language (DATA_DIR from ../slavic/fetch-belebele.mjs) and
 * synthesizes+validates its retrieval task — never calls
 * downloadLanguageFile()/fetchAndValidateLanguage() (both network-capable
 * on a cache miss). Throws an actionable error if the cache is absent. */
export function loadCachedBelebeleQrels(lang) {
  const path = join(BELEBELE_DATA_DIR, `${lang}.jsonl`);
  if (!existsSync(path)) {
    throw new Error(`[analyze-weighted-rrf] no cached Belebele JSONL for "${lang}" at ${path} — run the Slavic benchmark harness online first (benchmarks/external/slavic/fetch-belebele.mjs); this analyzer never fetches over the network.`);
  }
  const rows = parseJsonlRows(readFileSync(path, 'utf-8'), lang);
  const schemaValidation = validateRowSchema(rows, lang, lang);
  if (!schemaValidation.ok) {
    throw new Error(`[analyze-weighted-rrf] cached Belebele data for "${lang}" failed schema validation: ${schemaValidation.problems.join('; ')}`);
  }
  const task = synthesizeRetrievalTask(rows);
  const taskValidation = validateRetrievalTask(task);
  if (!taskValidation.ok) {
    throw new Error(`[analyze-weighted-rrf] cached Belebele data for "${lang}" failed retrieval-task validation: ${taskValidation.problems.join('; ')}`);
  }
  return { queries: task.queries, qrels: task.qrels };
}

// ── scope definitions ────────────────────────────────────────────────────

export const BELEBELE_LANGUAGES = Object.freeze([
  'ukr_Cyrl', 'rus_Cyrl', 'bul_Cyrl', 'pol_Latn', 'ces_Latn', 'slk_Latn', 'eng_Latn',
]);

const CYRILLIC_LANGUAGES = new Set(['ukr_Cyrl', 'rus_Cyrl', 'bul_Cyrl']);
const SLAVIC_LATIN_LANGUAGES = new Set(['pol_Latn', 'ces_Latn', 'slk_Latn']);

/** Builds one scope's {qids, qrels, dense, sparse, parityHybrid} —
 * `parityHybrid` carries whichever REAL Qdrant hybrid TREC runs exist for
 * that scope (never fabricated), keyed by 'k2'/'k60', for the parity
 * check. Never mixes Qdrant Cloud E5/BM25 runs into this BGE-M3-only
 * analysis — only the "local"-profile TREC files are ever read here,
 * never a "cloud"-profile file. */
export function buildScope(id) {
  if (id === 'scifact_local') {
    const { queries, qrels } = loadBeirFullQrels();
    const qids = [...queries.keys()];
    const dense = loadModeOrThrow(join(BEIR_RUNS_DIR, 'local-common-512-dense.trec'), qids, 'scifact_local/dense');
    const sparse = loadModeOrThrow(join(BEIR_RUNS_DIR, 'local-common-512-sparse.trec'), qids, 'scifact_local/sparse');
    const parityHybrid = {};
    parityHybrid.k60 = loadModeIfExists(join(BEIR_RUNS_DIR, 'local-common-512-hybrid_k60.trec'), qids, 'scifact_local/hybrid_k60');
    // No local hybrid_k2 run exists for the full 300-query SciFact scope
    // (see ../beir/profiles.mjs) — never fabricated here.
    return { id, label: 'SciFact full test split — local BGE-M3', qids, qrels, dense, sparse, parityHybrid };
  }
  if (id === 'miracl_local') {
    const { queries, qrels } = loadMiraclQrels();
    const qids = [...queries.keys()];
    const dense = loadModeOrThrow(join(MIRACL_RUNS_DIR, 'local-dense.trec'), qids, 'miracl_local/dense');
    const sparse = loadModeOrThrow(join(MIRACL_RUNS_DIR, 'local-sparse.trec'), qids, 'miracl_local/sparse');
    const parityHybrid = {};
    parityHybrid.k2 = loadModeIfExists(join(MIRACL_RUNS_DIR, 'local-hybrid_k2.trec'), qids, 'miracl_local/hybrid_k2');
    parityHybrid.k60 = loadModeIfExists(join(MIRACL_RUNS_DIR, 'local-hybrid_k60.trec'), qids, 'miracl_local/hybrid_k60');
    return { id, label: 'MIRACL Russian pooled subset — local BGE-M3', qids, qrels, dense, sparse, parityHybrid };
  }
  if (id.startsWith('belebele_')) {
    const lang = id.slice('belebele_'.length);
    if (!BELEBELE_LANGUAGES.includes(lang)) {
      throw new Error(`[analyze-weighted-rrf] unknown Belebele language scope "${id}"`);
    }
    const { queries, qrels } = loadCachedBelebeleQrels(lang);
    const qids = [...queries.keys()];
    const dense = loadModeOrThrow(join(SLAVIC_RUNS_DIR, `${lang}-dense.trec`), qids, `${id}/dense`);
    const sparse = loadModeOrThrow(join(SLAVIC_RUNS_DIR, `${lang}-sparse.trec`), qids, `${id}/sparse`);
    const parityHybrid = {};
    // The Slavic harness ran ONE fixed equal-RRF mode (k=60) — see
    // ../slavic/slavic-profiles.mjs's RRF_K. No k=2 hybrid run exists
    // there; never fabricated here.
    parityHybrid.k60 = loadModeIfExists(join(SLAVIC_RUNS_DIR, `${lang}-hybrid.trec`), qids, `${id}/hybrid`);
    return { id, label: `Belebele ${lang}`, qids, qrels, dense, sparse, parityHybrid, lang };
  }
  throw new Error(`[analyze-weighted-rrf] unknown scope id "${id}"`);
}

export const SCOPE_IDS = Object.freeze([
  'scifact_local',
  'miracl_local',
  ...BELEBELE_LANGUAGES.map((l) => `belebele_${l}`),
]);

// ── parity validation ────────────────────────────────────────────────────

/**
 * Reconstructs equal RRF (weights=[1,1]) offline for a given k, compares
 * it against a REAL Qdrant hybrid TREC run for the same scope/k (if one
 * exists), and reports (a) exact metric differences, (b) how many queries'
 * top-10 ranking differs between reconstruction and the real run, and (c)
 * an explicit faithful/not-faithful verdict — never claims exact
 * simulation if parity fails.
 */
export function checkParity(scope, k) {
  const realHybrid = scope.parityHybrid[`k${k}`];
  if (!realHybrid) {
    return { k, available: false, reason: `no real Qdrant hybrid_k${k} TREC run exists for scope "${scope.id}"` };
  }
  const denseByQuery = scope.dense;
  const sparseByQuery = scope.sparse;
  const reconstructed = fuseWeightedRrfAllQueries(scope.qids, denseByQuery, sparseByQuery, {
    k, denseWeight: 1.0, sparseWeight: 1.0, depth: TOP_K,
  });

  const reconstructedMetrics = computeMetrics(scope.qrels, reconstructed);
  const realMetrics = computeMetrics(scope.qrels, realHybrid);

  const metricFields = ['ndcgAt10', 'mapAt100', 'recallAt10', 'recallAt100', 'precisionAt10', 'mrrAt10'];
  const metricDiffs = {};
  let maxAbsDiff = 0;
  for (const field of metricFields) {
    const a = reconstructedMetrics[field];
    const b = realMetrics[field];
    const diff = (typeof a === 'number' && typeof b === 'number') ? a - b : null;
    metricDiffs[field] = { reconstructed: a, real: b, diff };
    if (diff !== null) maxAbsDiff = Math.max(maxAbsDiff, Math.abs(diff));
  }

  let queriesWithTop10Diff = 0;
  for (const qid of scope.qids) {
    const a = (reconstructed.get(qid) ?? []).slice(0, 10);
    const b = (realHybrid.get(qid) ?? []).slice(0, 10);
    if (a.length !== b.length || a.some((id, i) => id !== b[i])) queriesWithTop10Diff += 1;
  }
  const queriesWithTop10DiffPct = scope.qids.length > 0 ? (queriesWithTop10Diff / scope.qids.length) * 100 : 0;

  // "Sufficiently faithful" is a descriptive judgment, not a fabricated
  // pass: within FLOAT_TOLERANCE-scale metric agreement AND fewer than
  // 5% of queries showing a top-10 ranking difference (the fixed
  // threshold below is documented, not tuned per-scope after seeing
  // results).
  const FAITHFUL_MAX_METRIC_DIFF = 0.01; // nDCG-scale, not float-equality — real Qdrant prefetch pool (200) vs this analyzer's saved top-100 dense/sparse lanes can legitimately differ slightly
  const FAITHFUL_MAX_QUERY_DIFF_PCT = 5;
  const sufficientlyFaithful = maxAbsDiff <= FAITHFUL_MAX_METRIC_DIFF && queriesWithTop10DiffPct <= FAITHFUL_MAX_QUERY_DIFF_PCT;

  return {
    k, available: true,
    metricDiffs, maxAbsDiff,
    queriesWithTop10Diff, queryCount: scope.qids.length, queriesWithTop10DiffPct,
    sufficientlyFaithful,
    caveat: 'The saved dense/sparse TREC lane files are capped at top-100 per query, while the real Qdrant hybrid queries that produced the compared run used prefetch limit 200 per lane. This reconstruction can only ever be as complete as the saved top-100 lanes allow, and is never claimed to be an exact simulation of the live prefetch=200 request.',
  };
}

// ── metrics + comparisons for one configuration ─────────────────────────

/** Full metrics + dense-relative comparison + bootstrap CI for one fused
 * ranking (or the plain dense/sparse baseline). */
function evaluateConfig(scope, label, rankedByQuery, densePerQuery) {
  const metrics = computeMetrics(scope.qrels, rankedByQuery);
  const perQuery = perQueryMetrics(scope.qrels, rankedByQuery);

  let improved = 0; let harmed = 0; let ties = 0;
  const deltas = [];
  for (const qid of scope.qids) {
    const a = densePerQuery.get(qid)?.ndcgAt10 ?? null;
    const b = perQuery.get(qid)?.ndcgAt10 ?? null;
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    const delta = b - a;
    deltas.push(delta);
    if (delta > FLOAT_TOLERANCE) improved += 1;
    else if (delta < -FLOAT_TOLERANCE) harmed += 1;
    else ties += 1;
  }
  const n = deltas.length || 1;
  const sorted = [...deltas].sort((x, y) => x - y);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  const mean = deltas.length ? deltas.reduce((s, v) => s + v, 0) / deltas.length : null;

  // vs dense: baseline=dense, comparison=this config -> meanDelta = config − dense.
  const vsDense = pairedBootstrapByQuery(densePerQuery, perQuery, 'ndcgAt10');

  return {
    label, metrics,
    perQuery,
    vsDense: {
      improved, harmed, ties,
      improvedPct: (improved / n) * 100, harmedPct: (harmed / n) * 100, tiesPct: (ties / n) * 100,
      meanDeltaNdcg10: mean, medianDeltaNdcg10: median,
      bootstrap: vsDense,
    },
  };
}

// ── full per-scope analysis ──────────────────────────────────────────────

export function analyzeScopeWeightedRrf(scope) {
  const densePerQuery = perQueryMetrics(scope.qrels, scope.dense);

  const denseResult = evaluateConfig(scope, 'dense', scope.dense, densePerQuery);
  const sparseResult = evaluateConfig(scope, 'sparse', scope.sparse, densePerQuery);

  const configs = { dense: denseResult, sparse: sparseResult };
  const configMeta = [];

  for (const k of K_VALUES) {
    for (const rho of RHO_VALUES) {
      const sparseWeight = sparseWeightFromRho(k, rho);
      const configId = `k${k}_rho${rho.toFixed(2)}`;
      const fused = fuseWeightedRrfAllQueries(scope.qids, scope.dense, scope.sparse, {
        k, denseWeight: DENSE_WEIGHT, sparseWeight, depth: TOP_K,
      });
      const result = evaluateConfig(scope, configId, fused, densePerQuery);
      configs[configId] = result;
      configMeta.push({ configId, k, rho, denseWeight: DENSE_WEIGHT, sparseWeight });
    }
  }

  // Equal RRF (rho=1.0, i.e. weights=[1,1]) vs each weighted config, for
  // the "paired-bootstrap comparison versus equal RRF" requirement.
  const equalRrfComparisons = {};
  for (const k of K_VALUES) {
    const equalConfigId = `k${k}_rho1.00`;
    const equalPerQuery = configs[equalConfigId].perQuery;
    for (const rho of RHO_VALUES) {
      if (rho === 1.00) continue;
      const configId = `k${k}_rho${rho.toFixed(2)}`;
      // vs equal RRF: baseline=equal(rho=1), comparison=this config -> meanDelta = config − equal.
      equalRrfComparisons[configId] = pairedBootstrapByQuery(equalPerQuery, configs[configId].perQuery, 'ndcgAt10');
    }
  }

  const parity = { k2: checkParity(scope, 2), k60: checkParity(scope, 60) };

  const rankingDepth = {
    dense: recordRankingDepth(scope.qids, scope.dense),
    sparse: recordRankingDepth(scope.qids, scope.sparse),
  };

  return {
    id: scope.id, label: scope.label, queryCount: scope.qids.length,
    rankingDepth, parity, configMeta,
    metrics: Object.fromEntries(Object.entries(configs).map(([id, r]) => [id, r.metrics])),
    vsDense: Object.fromEntries(Object.entries(configs).map(([id, r]) => [id, r.vsDense])),
    vsEqualRrf: equalRrfComparisons,
  };
}

// ── macro summaries (Belebele only; descriptive) ────────────────────────

export function computeBelebeleMacroSummary(belebeleResults) {
  const byGroup = { cyrillic: [], slavicLatin: [], english: [] };
  for (const r of belebeleResults) {
    if (CYRILLIC_LANGUAGES.has(r.lang)) byGroup.cyrillic.push(r);
    else if (SLAVIC_LATIN_LANGUAGES.has(r.lang)) byGroup.slavicLatin.push(r);
    else if (r.lang === 'eng_Latn') byGroup.english.push(r);
  }
  const meanNdcg10 = (results, configId) => {
    const vals = results.map((r) => r.metrics[configId]?.ndcgAt10).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const allConfigIds = belebeleResults[0] ? Object.keys(belebeleResults[0].metrics) : [];
  const summaryFor = (results) => Object.fromEntries(allConfigIds.map((id) => [id, meanNdcg10(results, id)]));
  return {
    note: 'DESCRIPTIVE ONLY — never used to select weights by script or language. See per-language results for the actual evidence.',
    cyrillicMacroAverage: { languageCount: byGroup.cyrillic.length, ndcgAt10ByConfig: summaryFor(byGroup.cyrillic) },
    slavicLatinMacroAverage: { languageCount: byGroup.slavicLatin.length, ndcgAt10ByConfig: summaryFor(byGroup.slavicLatin) },
    englishControl: { languageCount: byGroup.english.length, ndcgAt10ByConfig: summaryFor(byGroup.english) },
    allSevenMacroAverage: { languageCount: belebeleResults.length, ndcgAt10ByConfig: summaryFor(belebeleResults) },
  };
}

// ── candidate selection (rule-based, never subjective) ──────────────────

const SIGNIFICANT_HARM_THRESHOLD = 0; // a bootstrap CI entirely below this vs dense = "statistically significant regression"
const MIRACL_NOTE = 'MIRACL has already been inspected during scope construction and is not a blind holdout — treated as diagnostic/validation evidence, not confirmatory evidence.';

function isSignificantRegressionVsDense(vsDenseBootstrap) {
  return vsDenseBootstrap.excludesZero && vsDenseBootstrap.meanDelta < SIGNIFICANT_HARM_THRESHOLD;
}

/**
 * True only if `configId` is CONFIRMED safe (not significantly regressive
 * vs dense) for scope `s`. Missing data (no scope result, no vsDense entry
 * for this config, no bootstrap object) is NEVER treated as "safe" — a
 * scope/config that cannot be checked disqualifies the candidate. This is
 * the exact inverse of the prior (buggy) contract, which read
 * "!bootstrap || !isSignificantRegression(...)" — under that formula, a
 * missing bootstrap short-circuited the `||` to `true`, i.e. "no data"
 * read as "definitely not a regression." A live-verified case: a
 * hand-built config with a real metric but no vsDense entry at all was
 * accepted as CANDIDATES_SELECTED under the old logic.
 */
function isConfirmedSafe(scope, configId) {
  const bootstrap = scope?.vsDense?.[configId]?.bootstrap;
  if (!bootstrap) return false;
  return !isSignificantRegressionVsDense(bootstrap);
}

/**
 * Rule-based selection of at most 3 candidates for a future live Qdrant
 * benchmark: one dense-heavy candidate, one balanced/quality candidate,
 * and equal RRF as a control (never a recommendation). Never picks by
 * subjective inspection — every rule below is fixed and applied
 * mechanically to the already-computed per-scope results.
 *
 * Rules:
 *   - dense-heavy candidate: among configs with (a) a positive mean
 *     nDCG@10 benefit vs dense on scifact_local, AND (b) NO
 *     statistically-significant regression vs dense on ANY required scope
 *     (scifact_local, miracl_local, and all 7 Belebele languages — MIRACL
 *     is explicitly INCLUDED here; the original rule text said "minimizes
 *     harm on Belebele" but never named MIRACL, which let a config with a
 *     confirmed significant MIRACL regression be picked and mislabeled
 *     "dense-heavy" — fixed to require zero significant regressions
 *     anywhere), picks the SMALLEST rho (i.e. the smallest actual sparse
 *     weight, genuinely the most dense-dominated eligible option) rather
 *     than the config with the fewest Belebele regressions — "dense-heavy"
 *     must mean minimal sparse contribution, not merely "happened to avoid
 *     harm."
 *   - balanced/quality candidate: maximizes cross-dataset macro quality
 *     (mean nDCG@10 across scifact_local + miracl_local + the 7 Belebele
 *     languages) among configs with NO statistically significant
 *     regression vs dense on ANY required scope — the explicit, named
 *     risk tolerance for this candidate is "zero significant regressions,"
 *     not merely "better on average."
 *   - equal RRF (rho=1.00) is always included as the control baseline,
 *     for both k=2 and k=60 where available — never presented as a
 *     recommendation.
 *
 * A scope/config pair that cannot be confirmed safe (missing result,
 * missing vsDense entry, missing bootstrap) disqualifies that config from
 * BOTH candidate slots — never treated as passing by default.
 *
 * This function ALSO requires `scopeResults` to cover the exact SCOPE_IDS
 * set (scifact_local, miracl_local, all 7 belebele_* — no more, no fewer)
 * before it will select anything. A partial scope set (e.g. only
 * scifact_local) can never demonstrate "no significant regression
 * anywhere" for scopes it never saw, so it must never be able to produce
 * a selected candidate — it returns NO_WEIGHTED_RRF_CANDIDATE instead of
 * silently evaluating "safe everywhere" over whatever subset happened to
 * be passed in.
 *
 * Returns `{ verdict: 'NO_WEIGHTED_RRF_CANDIDATE' }` if the required scope
 * set is incomplete, or if no weighted (rho < 1.00) configuration
 * satisfies either rule — a winner is never forced.
 */
export function selectCandidates(scopeResults) {
  const NO_CANDIDATE_RESULT = { verdict: 'NO_WEIGHTED_RRF_CANDIDATE', denseHeavyCandidate: null, balancedCandidate: null, balancedCollidedWithDenseHeavy: false, equalRrfControls: K_VALUES.map((k) => `k${k}_rho1.00`), miraclNote: MIRACL_NOTE };

  const actualScopeIds = new Set(scopeResults.map((s) => s.id));
  const expectedScopeIds = new Set(SCOPE_IDS);
  // scopeResults.length must equal SCOPE_IDS.length TOO, not just the
  // deduplicated ID sets matching — otherwise a scopeResults array with a
  // duplicated entry (e.g. scifact_local listed twice, 10 entries but only
  // 9 unique ids) passes the Set-equality check and silently double-counts
  // that scope in macroQuality()'s average.
  const scopeSetMatches = scopeResults.length === SCOPE_IDS.length
    && actualScopeIds.size === expectedScopeIds.size
    && [...expectedScopeIds].every((id) => actualScopeIds.has(id));
  if (!scopeSetMatches) {
    return NO_CANDIDATE_RESULT;
  }

  const scifact = scopeResults.find((s) => s.id === 'scifact_local');
  const allScopes = scopeResults;

  const weightedConfigIds = [];
  for (const k of K_VALUES) for (const rho of RHO_VALUES) if (rho < 1.00) weightedConfigIds.push({ configId: `k${k}_rho${rho.toFixed(2)}`, rho });

  // A config is eligible for EITHER candidate slot only if every scope in
  // `allScopes` (scifact_local, miracl_local, all 7 Belebele languages —
  // whichever were actually supplied) can be CONFIRMED safe for it. This
  // is the shared "no significant regression anywhere" gate both rules
  // require; missing data never passes it (see isConfirmedSafe()).
  const safeEverywhere = (configId) => allScopes.every((s) => isConfirmedSafe(s, configId));

  // ── dense-heavy candidate: smallest rho among the safe-everywhere
  // configs that also show a positive SciFact benefit ─────────────────
  let denseHeavy = null;
  {
    const eligible = weightedConfigIds
      .filter(({ configId }) => safeEverywhere(configId))
      .map(({ configId, rho }) => {
        const scifactBenefit = scifact?.vsDense?.[configId] ? scifact.vsDense[configId].meanDeltaNdcg10 : null;
        return { configId, rho, scifactBenefit };
      })
      .filter((c) => typeof c.scifactBenefit === 'number' && c.scifactBenefit > 0);
    if (eligible.length > 0) {
      eligible.sort((a, b) => a.rho - b.rho); // smallest sparse contribution first
      denseHeavy = eligible[0].configId;
    }
  }

  // ── balanced/quality candidate: best cross-dataset macro nDCG@10 among
  // the same safe-everywhere set. macroQuality() REQUIRES a finite
  // nDCG@10 in EVERY scope in `allScopes` — a config missing a metric for
  // even one required scope returns null (never a partial average over
  // whichever scopes happened to have data; that would silently reward
  // incompleteness instead of disqualifying it). ─────────────────────────
  const macroQuality = (configId) => {
    const vals = allScopes.map((s) => s.metrics?.[configId]?.ndcgAt10);
    if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  const balancedEligible = weightedConfigIds
    .filter(({ configId }) => safeEverywhere(configId))
    .map(({ configId }) => ({ configId, macroQuality: macroQuality(configId) }))
    .filter((c) => typeof c.macroQuality === 'number')
    .sort((a, b) => b.macroQuality - a.macroQuality);

  // ── balanced/quality candidate MUST be a config distinct from
  // dense-heavy — a live benchmark must never be asked to run the exact
  // same query twice under two different labels. If the single best
  // balanced config happens to equal denseHeavy, fall through to the
  // next-best eligible balanced config that differs from it; if none
  // exists, balanced stays null rather than duplicating denseHeavy.
  //
  // balancedCollidedWithDenseHeavy must reflect ONLY whether the TOP-
  // RANKED (rank-0) balanced pick was denseHeavy — not whether denseHeavy
  // merely appears SOMEWHERE in balancedEligible. denseHeavy can rank
  // anywhere in the macro-quality ordering (it's selected by a completely
  // different rule — smallest rho, not best macro nDCG@10); its mere
  // presence in the eligible list is expected and unremarkable whenever
  // it's simply also "safe everywhere," and must not be reported as a
  // collision when the actual best balanced pick never involved it at all.
  let balanced = null;
  const balancedCollidedWithDenseHeavy = balancedEligible.length > 0 && balancedEligible[0].configId === denseHeavy;
  {
    const distinctEligible = balancedEligible.filter((c) => c.configId !== denseHeavy);
    if (distinctEligible.length > 0) balanced = distinctEligible[0].configId;
  }

  const equalRrfControls = K_VALUES.map((k) => `k${k}_rho1.00`);

  if (!denseHeavy && !balanced) {
    return { verdict: 'NO_WEIGHTED_RRF_CANDIDATE', denseHeavyCandidate: null, balancedCandidate: null, balancedCollidedWithDenseHeavy: false, equalRrfControls, miraclNote: MIRACL_NOTE };
  }

  return {
    verdict: 'CANDIDATES_SELECTED',
    denseHeavyCandidate: denseHeavy,
    balancedCandidate: balanced,
    // True only when the single best balanced-quality config was the SAME
    // as denseHeavy and a distinct next-best balanced config was
    // substituted (or none existed) — surfaced so the report can explain
    // why the "balanced" slot is not simply the single best macro-quality
    // config, without ever silently printing denseHeavy's payload twice.
    balancedCollidedWithDenseHeavy,
    equalRrfControls,
    miraclNote: MIRACL_NOTE,
  };
}

/** Builds the exact future JavaScript Qdrant query payload for one
 * candidate config ID (e.g. "k60_rho0.25"), for direct copy-paste into a
 * future live benchmark. */
export function buildQdrantPayload(configId, configMetaByScope) {
  const meta = configMetaByScope.find((m) => m.configId === configId);
  if (!meta) return null;
  return {
    query: { rrf: { k: meta.k, weights: [meta.denseWeight, meta.sparseWeight] } },
  };
}

// ── report rendering ──────────────────────────────────────────────────

function metricCell(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : 'n/a';
}

function bootstrapCell(cmp) {
  if (!cmp) return 'n/a';
  const ci = cmp.ciLow !== null ? `[${cmp.ciLow.toFixed(4)}, ${cmp.ciHigh.toFixed(4)}]` : 'n/a';
  return `${cmp.verdict} (meanΔ=${cmp.meanDelta !== null ? cmp.meanDelta.toFixed(4) : 'n/a'}, CI95%=${ci})`;
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push('# Offline weighted-RRF candidate analysis');
  lines.push('');
  lines.push(`Verdict: **${report.candidateSelection.verdict}**`);
  lines.push('');
  lines.push('> This offline analysis narrows candidates only. Final acceptance requires');
  lines.push('> real Qdrant 1.17+ weighted-RRF queries using `query.rrf.weights`.');
  lines.push('');
  lines.push('This analysis uses ONLY already-completed TREC runs. No Qdrant queries were');
  lines.push('executed, no ONNX models were loaded, and no collections were created or');
  lines.push('deleted while producing this report.');
  lines.push('');

  lines.push('## Qdrant\'s real weighted-RRF formula');
  lines.push('');
  lines.push('Qdrant 1.17+ (this project runs server 1.17.1, `@qdrant/js-client-rest`');
  lines.push('1.18.0) computes a document\'s per-lane weighted-RRF contribution as:');
  lines.push('');
  lines.push('```');
  lines.push('contribution(rank, weight, k) = 1 / (k + (rank + 1) / weight - 1)');
  lines.push('```');
  lines.push('');
  lines.push('where `rank` is ZERO-BASED. This is passed via');
  lines.push('`query: { rrf: { k, weights: [denseWeight, sparseWeight] } }` — never via');
  lines.push('`prefetch.weight` (no such field exists in Qdrant\'s hybrid-query API), and');
  lines.push('never approximated with `FormulaQuery` (which sees raw prefetch scores, not');
  lines.push('prefetch ranks, and is therefore not a substitute for rank fusion). The');
  lines.push('naive formula `weight / (k + rank)` is explicitly WRONG and is not used');
  lines.push('anywhere in this analysis.');
  lines.push('');
  lines.push('### Why raw weights mean different things under k=2 vs k=60');
  lines.push('');
  lines.push('At rank=0 (the top result), `contribution(0, w, k) = 1 / (k + 1/w - 1)`.');
  lines.push('When `k` is small (k=2), `1/w` is a large fraction of the denominator, so');
  lines.push('changing `w` moves the contribution a lot. When `k` is large (k=60), `k`');
  lines.push('itself dominates the denominator and `1/w` barely matters — a raw');
  lines.push('`weight=0.25` at k=60 leaves the top-rank contribution at ~95% of equal');
  lines.push('weighting (`1/60 / (1/60 + (1-1)/1)`... concretely: dense contributes');
  lines.push('1/60≈0.01667 at rank 0 regardless; sparse at weight 0.25 contributes');
  lines.push('1/(60+4-1)=1/63≈0.01587 — barely reduced), while the SAME raw weight at');
  lines.push('k=2 cuts the top-rank contribution to 40% of equal weighting. This is');
  lines.push('exactly why this analysis parametrizes configurations by a TARGET rank-1');
  lines.push('contribution ratio `rho`, converted to the actual Qdrant weight per-k via');
  lines.push('`sparseWeightFromRho(k, rho) = 1 / (k * (1/rho - 1) + 1)`, rather than');
  lines.push('sweeping raw weight values that would mean incomparable things at k=2 vs');
  lines.push('k=60.');
  lines.push('');
  lines.push('| k | rho | sparseWeight |');
  lines.push('|---:|---:|---:|');
  for (const k of K_VALUES) for (const rho of RHO_VALUES) lines.push(`| ${k} | ${rho.toFixed(2)} | ${sparseWeightFromRho(k, rho).toFixed(7)} |`);
  lines.push('');

  lines.push('## Dataset roles');
  lines.push('');
  lines.push('- **SciFact (local BGE-M3)**: English, full 300-query test split.');
  lines.push('- **MIRACL Russian (local BGE-M3)**: 100-query pooled subset. Already');
  lines.push('  inspected in prior tasks — NOT a blind holdout. Treated here as');
  lines.push('  diagnostic/validation evidence, never as confirmatory evidence for a');
  lines.push('  final decision.');
  lines.push('- **Belebele (7 languages, local BGE-M3)**: parallel corpus, MRC-derived');
  lines.push('  qrels (one relevant passage per query) — see');
  lines.push('  `../slavic/fetch-belebele.mjs`\'s module header for the full caveat.');
  lines.push('- Only local BGE-M3 runs are used. Qdrant Cloud E5/BM25 runs are never');
  lines.push('  mixed into this analysis.');
  lines.push('');

  lines.push('## Input ranking depth and dataset revision');
  lines.push('');
  lines.push(`Belebele dataset: \`${BELEBELE_REPO}\` @ \`${BELEBELE_REVISION}\`.`);
  lines.push('');
  lines.push('| Scope | Queries | Dense depth (min/max) | Sparse depth (min/max) |');
  lines.push('|---|---:|---:|---:|');
  for (const r of report.scopes) {
    lines.push(`| ${r.id} | ${r.queryCount} | ${r.rankingDepth.dense.min}/${r.rankingDepth.dense.max} | ${r.rankingDepth.sparse.min}/${r.rankingDepth.sparse.max} |`);
  }
  lines.push('');

  lines.push('## Parity with real Qdrant runs');
  lines.push('');
  lines.push('Offline equal-RRF (weights=[1,1]) reconstructed from the saved dense/sparse');
  lines.push('TREC lanes and compared against a REAL Qdrant hybrid run for the same');
  lines.push('scope/k, where one exists.');
  lines.push('');
  lines.push('| Scope | k | Available | Max |Δmetric| | Queries w/ top-10 diff | Faithful? |');
  lines.push('|---|---:|---|---:|---:|---|');
  for (const r of report.scopes) {
    for (const k of K_VALUES) {
      const p = r.parity[`k${k}`];
      if (!p.available) { lines.push(`| ${r.id} | ${k} | no | n/a | n/a | n/a (${p.reason}) |`); continue; }
      lines.push(`| ${r.id} | ${k} | yes | ${p.maxAbsDiff.toFixed(4)} | ${p.queriesWithTop10Diff}/${p.queryCount} (${p.queriesWithTop10DiffPct.toFixed(1)}%) | ${p.sufficientlyFaithful ? 'yes' : 'NO — do not treat as exact simulation'} |`);
    }
  }
  lines.push('');
  lines.push('Caveat (applies to every row above): the saved dense/sparse TREC lane');
  lines.push('files are capped at top-100 per query, while the real Qdrant hybrid');
  lines.push('queries used prefetch limit 200 per lane. This reconstruction is never');
  lines.push('claimed to be an exact simulation of the live prefetch=200 request.');
  lines.push('');

  lines.push('## Aggregate metrics per scope and configuration');
  lines.push('');
  for (const r of report.scopes) {
    lines.push(`### ${r.id} (${r.label})`);
    lines.push('');
    lines.push('| Config | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 | Improved | Harmed | Ties | Mean Δ | Median Δ | vs dense (bootstrap) |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const [configId, m] of Object.entries(r.metrics)) {
      const vsD = r.vsDense[configId];
      lines.push(`| ${configId} | ${metricCell(m.ndcgAt10)} | ${metricCell(m.mapAt100)} | ${metricCell(m.recallAt10)} | ${metricCell(m.recallAt100)} | ${metricCell(m.mrrAt10)} | ${vsD.improved} (${vsD.improvedPct.toFixed(1)}%) | ${vsD.harmed} (${vsD.harmedPct.toFixed(1)}%) | ${vsD.ties} | ${metricCell(vsD.meanDeltaNdcg10)} | ${metricCell(vsD.medianDeltaNdcg10)} | ${bootstrapCell(vsD.bootstrap)} |`);
    }
    lines.push('');
  }

  lines.push('## Belebele macro summaries (descriptive only — never used to select weights)');
  lines.push('');
  lines.push(report.belebeleMacroSummary.note);
  lines.push('');
  lines.push('| Group | Languages | nDCG@10 by config |');
  lines.push('|---|---:|---|');
  for (const [key, group] of Object.entries(report.belebeleMacroSummary)) {
    if (key === 'note') continue;
    const cells = Object.entries(group.ndcgAt10ByConfig).map(([id, v]) => `${id}=${metricCell(v)}`).join(', ');
    lines.push(`| ${key} | ${group.languageCount} | ${cells} |`);
  }
  lines.push('');

  lines.push('## Selected candidates for a future live Qdrant benchmark');
  lines.push('');
  const cs = report.candidateSelection;
  lines.push(`Verdict: **${cs.verdict}**`);
  lines.push('');
  lines.push(cs.miraclNote);
  lines.push('');
  if (cs.verdict === 'NO_WEIGHTED_RRF_CANDIDATE') {
    lines.push('No weighted-RRF configuration satisfied the predefined dense-heavy or');
    lines.push('balanced selection rules against this offline evidence. No winner is');
    lines.push('forced. Equal RRF remains available as the existing control/baseline.');
  } else {
    if (cs.denseHeavyCandidate) {
      const payload = buildQdrantPayload(cs.denseHeavyCandidate, report.allConfigMeta);
      lines.push(`### Dense-heavy candidate: \`${cs.denseHeavyCandidate}\``);
      lines.push('');
      lines.push('```js');
      lines.push(JSON.stringify(payload, null, 2));
      lines.push('```');
      lines.push('');
    } else {
      lines.push('No dense-heavy candidate satisfied its selection rule (positive SciFact');
      lines.push('benefit with no statistically significant regression vs dense on ANY');
      lines.push('required scope, including MIRACL).');
      lines.push('');
    }
    if (cs.balancedCandidate) {
      const payload = buildQdrantPayload(cs.balancedCandidate, report.allConfigMeta);
      lines.push(`### Balanced/quality candidate: \`${cs.balancedCandidate}\``);
      lines.push('');
      if (cs.balancedCollidedWithDenseHeavy) {
        lines.push('(The single best macro-quality config was the same as the dense-heavy');
        lines.push('candidate above — this is the next-best DISTINCT eligible config instead,');
        lines.push('so a live benchmark never runs the identical query twice under two labels.)');
        lines.push('');
      }
      lines.push('```js');
      lines.push(JSON.stringify(payload, null, 2));
      lines.push('```');
      lines.push('');
    } else if (cs.balancedCollidedWithDenseHeavy) {
      lines.push('The only config satisfying the balanced/quality rule was identical to the');
      lines.push('dense-heavy candidate above, and no other distinct eligible config existed');
      lines.push('— rather than print the same payload twice, no separate balanced/quality');
      lines.push('candidate is reported.');
      lines.push('');
    } else {
      lines.push('No balanced/quality candidate satisfied its selection rule (no statistically');
      lines.push('significant regression vs dense on any required scope).');
      lines.push('');
    }
  }
  lines.push('### Equal RRF (control, not a recommendation)');
  lines.push('');
  for (const configId of cs.equalRrfControls) {
    const payload = buildQdrantPayload(configId, report.allConfigMeta);
    lines.push(`\`${configId}\`:`);
    lines.push('```js');
    lines.push(JSON.stringify(payload, null, 2));
    lines.push('```');
  }
  lines.push('');

  lines.push('## Limitations of offline reconstruction');
  lines.push('');
  const availableParityChecks = report.scopes.flatMap((r) => [r.parity.k2, r.parity.k60]).filter((p) => p.available);
  const faithfulCount = availableParityChecks.filter((p) => p.sufficientlyFaithful).length;
  const unfaithfulChecks = availableParityChecks.filter((p) => !p.sufficientlyFaithful);
  lines.push(`- **Measured parity result: ${faithfulCount}/${availableParityChecks.length} available (scope, k) checks were`);
  lines.push('  sufficiently faithful.**');
  if (availableParityChecks.length === 0) {
    lines.push('  No real Qdrant hybrid TREC run was available for any (scope, k) pair, so');
    lines.push('  parity could not be measured at all in this run — treat every offline');
    lines.push('  weighted-RRF number below as UNVALIDATED against a real Qdrant run.');
  } else if (unfaithfulChecks.length === 0) {
    lines.push('  Every available parity check in this run met the faithfulness threshold —');
    lines.push('  see the parity table above for exact per-scope numbers. This is a');
    lines.push('  stronger basis for trusting the offline weighted-RRF numbers below than a');
    lines.push('  prior run that failed parity, but a live weighted-RRF query is still the');
    lines.push('  only way to confirm this holds for the actual configurations selected.');
  } else {
    const diffPcts = unfaithfulChecks.map((p) => p.queriesWithTop10DiffPct);
    const minDiffPct = Math.min(...diffPcts);
    const maxDiffPct = Math.max(...diffPcts);
    const metricDiffs = availableParityChecks.map((p) => p.maxAbsDiff).filter((v) => typeof v === 'number');
    const minMetricDiff = metricDiffs.length ? Math.min(...metricDiffs) : null;
    const maxMetricDiff = metricDiffs.length ? Math.max(...metricDiffs) : null;
    lines.push(`  In this run, ${unfaithfulChecks.length}/${availableParityChecks.length} available parity checks failed`);
    lines.push(`  the faithfulness threshold (${minDiffPct.toFixed(1)}-${maxDiffPct.toFixed(1)}% of queries showed a`);
    lines.push('  different top-10 ranking than the real Qdrant run, even where aggregate');
    lines.push(`  nDCG@10 differed by only ~${minMetricDiff !== null ? minMetricDiff.toFixed(4) : 'n/a'}-${maxMetricDiff !== null ? maxMetricDiff.toFixed(4) : 'n/a'}) — see the parity`);
    lines.push('  table above for exact per-scope numbers. This means offline weighted-RRF');
    lines.push('  metrics in this report should be read as DIRECTIONAL evidence for');
    lines.push('  narrowing candidates, not as a precise prediction of what a live Qdrant');
    lines.push('  weighted-RRF query will score.');
  }
  lines.push('- Saved dense/sparse TREC lanes are capped at top-100 per query; real');
  lines.push('  Qdrant hybrid queries use prefetch limit 200 per lane — this is the most');
  lines.push('  likely cause of any parity gap above (queries whose true top-100-under-');
  lines.push('  prefetch-200 candidate set differs from the saved top-100-only lane).');
  lines.push('- The same SciFact/MIRACL/Belebele scopes used to SELECT the candidate');
  lines.push('  weights above are also used to EVALUATE them — there is no held-out');
  lines.push('  validation split. A live Qdrant run on these same scopes will confirm');
  lines.push('  whether the offline reconstruction matches real Qdrant behavior, but it');
  lines.push('  will NOT confirm that the selected weights generalize beyond this exact');
  lines.push('  eval set. Per Qdrant\'s own tuning guidance, weights should ideally be');
  lines.push('  tuned on one part of an eval set and confirmed on a separate, untouched');
  lines.push('  holdout before being treated as validated.');
  lines.push('- MIRACL has already been inspected in prior tasks and is not a blind');
  lines.push('  holdout for this analysis.');
  lines.push('- Belebele qrels are MRC-derived (one relevant document per query), not');
  lines.push('  pooled IR judgments — see `../slavic/README.md`.');
  lines.push('- This offline analysis does not by itself justify a production RRF');
  lines.push('  default change. It only narrows candidates for a future live benchmark.');
  lines.push('');

  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────

async function main() {
  const peakRss = { bytes: process.memoryUsage().rss };
  const trackRss = () => { const cur = process.memoryUsage().rss; if (cur > peakRss.bytes) peakRss.bytes = cur; };

  mkdirSync(RESULTS_DIR, { recursive: true });

  const scopeResults = [];
  const allConfigMeta = [];
  // Process one scope at a time; the scope object (holding full-depth
  // ranking maps) goes out of scope and becomes eligible for GC before the
  // next scope is built — never accumulate every Slavic TREC run in
  // memory simultaneously.
  for (const scopeId of SCOPE_IDS) {
    console.log(`[analyze-weighted-rrf] processing scope: ${scopeId}`);
    const scope = buildScope(scopeId);
    const result = analyzeScopeWeightedRrf(scope);
    scopeResults.push(result);
    if (allConfigMeta.length === 0) allConfigMeta.push(...result.configMeta);
    // scope (full-depth dense/sparse ranking Maps + qrels) is now
    // unreferenced and eligible for collection. Node defers GC under its
    // default heap-growth policy, so without an explicit nudge here RSS
    // climbs monotonically across scopes even though nothing is actually
    // leaking (verified: with --expose-gc + gc() called here, peak RSS
    // stabilizes after a few scopes instead of growing through all 9).
    // global.gc is only defined when the process was launched with
    // --expose-gc; silently skipped otherwise (correctness never depends
    // on this call running).
    if (typeof global.gc === 'function') global.gc();
    trackRss();
  }

  const belebeleResults = scopeResults.filter((r) => r.id.startsWith('belebele_')).map((r) => ({ ...r, lang: r.id.slice('belebele_'.length) }));
  const belebeleMacroSummary = computeBelebeleMacroSummary(belebeleResults);
  const candidateSelection = selectCandidates(scopeResults);

  trackRss();

  const report = {
    generatedAt: new Date().toISOString(),
    parametrization: { rhoValues: RHO_VALUES, kValues: K_VALUES, denseWeight: DENSE_WEIGHT, topK: TOP_K },
    bootstrap: { seed: DEFAULT_BOOTSTRAP_SEED, iterations: DEFAULT_BOOTSTRAP_ITERATIONS },
    allConfigMeta,
    scopes: scopeResults,
    belebeleMacroSummary,
    candidateSelection,
    environment: { peakRssBytes: peakRss.bytes },
  };

  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  writeFileSync(REPORT_MD_PATH, renderMarkdownReport(report), 'utf-8');

  console.log(`[analyze-weighted-rrf] verdict: ${candidateSelection.verdict}`);
  console.log(`[analyze-weighted-rrf] peak RSS: ${(peakRss.bytes / 1e6).toFixed(0)} MB`);
  console.log(`[analyze-weighted-rrf] report json: ${REPORT_JSON_PATH.replace(REPO_ROOT, '.')}`);
  console.log(`[analyze-weighted-rrf] report md: ${REPORT_MD_PATH.replace(REPO_ROOT, '.')}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('[analyze-weighted-rrf] unhandled error:', err.message);
    process.exitCode = 1;
  });
}
