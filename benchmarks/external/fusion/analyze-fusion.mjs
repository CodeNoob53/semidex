// Offline cross-dataset fusion diagnosis: explains when sparse retrieval
// helps, when it damages dense rankings, and why hybrid behavior differs
// between BEIR SciFact and MIRACL Russian / between the local and cloud
// providers — using ONLY already-completed benchmark runs.
//
// STRICTLY OFFLINE: no ONNX, no Qdrant, no network, no indexing, no
// background processes. Every loader this module calls (loadDataset(),
// loadCachedMiniSet(), loadCachedMiraclSubset()) reads only already-written
// local cache files and never falls back to fetching — verified directly
// in analyze-fusion.test.mjs by replacing global.fetch with a function that
// throws on every call and confirming every scope still loads correctly.
//
// IMPORTANT SCOPE CONSTRAINT (per task): this module analyzes ONLY hybrid
// TREC runs that were actually produced by a live Qdrant hybrid query. It
// does NOT reconstruct arbitrary RRF k values by replaying saved top-100
// dense/sparse TREC files locally — those files are capped at top-100,
// while the real Qdrant hybrid requests used prefetch limit 200, so a local
// replay would have an incomplete candidate pool and must never be
// presented as equivalent to a real Qdrant hybrid result. No such replay
// exists anywhere in this module.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTrecRun, loadCachedMiniSet } from '../beir/build-rrf-mini-set.mjs';
import { loadDataset, validateDataset } from '../beir/fetch-scifact.mjs';
import { computeMetrics, ndcgAtK } from '../beir/metrics.mjs';
import { loadCachedMiraclSubset } from '../miracl/build-miracl-subset.mjs';
import { pairedBootstrap, perQueryMetrics, DEFAULT_BOOTSTRAP_SEED, DEFAULT_BOOTSTRAP_ITERATIONS } from '../miracl/bootstrap.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const BEIR_RUNS_DIR = resolve(__dirname, '../beir/.runs');
const MIRACL_RUNS_DIR = resolve(__dirname, '../miracl/.runs');
const RESULTS_DIR = resolve(__dirname, '../results');

// Committed, full-precision JSON reports used ONLY as the metric-parity
// reference (never as a source of ranked TREC data — that always comes
// fresh from the .trec files above, per the task's TREC-file-as-source-of-
// truth requirement).
const BEIR_FULL_REPORT_PATH = join(RESULTS_DIR, '2026-07-21-beir-scifact-provider-comparison.json');
const BEIR_MINI_REPORT_PATH = join(RESULTS_DIR, '2026-07-22-beir-scifact-local-rrf-mini.json');
const MIRACL_REPORT_PATH = join(RESULTS_DIR, '2026-07-22-miracl-ru-provider-comparison.json');

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Loads the previously-committed, full-precision metrics for every scope
 * this module knows how to build, keyed the same way buildAllScopes()
 * keys its scopes. Used only for the metric-parity check — if a report is
 * missing, that scope's parity check is skipped (not failed), so this
 * analyzer still works against a partial set of prior reports. */
export function loadReportedMetricsByScope() {
  const beirFull = readJsonIfExists(BEIR_FULL_REPORT_PATH);
  const beirMini = readJsonIfExists(BEIR_MINI_REPORT_PATH);
  const miracl = readJsonIfExists(MIRACL_REPORT_PATH);

  return {
    beir_full_local: beirFull?.runs?.['local-common-512']?.metrics,
    beir_full_cloud: beirFull?.runs?.['cloud-common-512']?.metrics,
    beir_mini_local: beirMini?.run?.metrics,
    miracl_local: miracl?.runs?.local?.metrics,
    miracl_cloud: miracl?.runs?.cloud?.metrics,
  };
}

const OVERLAP_TOP_K = { top10: 10, top100: 100 };
const RESCUE_HARM_METRIC = 'ndcgAt10'; // the metric used to classify a query as rescued/harmed by fusion
const FLOAT_TOLERANCE = 1e-6; // strict metric-parity tolerance vs the committed JSON/report

// ── TREC loading + strict validation ────────────────────────────────────

/**
 * Pre-check over the RAW text of a TREC file, run BEFORE parseTrecRun().
 * parseTrecRun() (build-rrf-mini-set.mjs) silently SKIPS any non-blank
 * line with fewer than 6 whitespace-separated fields — a reasonable
 * tolerance for the benchmark runners it was written for (trailing
 * whitespace, accidental blank-ish lines), but wrong for a diagnostic tool
 * whose whole job is to catch corruption: a truncated or malformed row
 * would otherwise vanish before validateTrecRun() ever sees it, so
 * "strict TREC validation" would pass on a file that actually lost data.
 * This function throws on the first non-blank line that does NOT have
 * exactly 6 fields, so a malformed row is caught here instead of
 * disappearing silently downstream.
 */
export function strictCheckRawTrecLines(text, label) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 6) {
      throw new Error(`[analyze-fusion] malformed TREC line in ${label} at line ${i + 1}: expected 6 whitespace-separated fields (qid Q0 docid rank score runtag), got ${fields.length}: "${trimmed}"`);
    }
  }
}

/**
 * Loads a TREC run file and converts it to the Map<queryId, string[]>
 * shape metrics.mjs expects (ranked doc IDs, best first — rank ascending).
 * Throws if the file does not exist (a missing input is a hard failure,
 * never a silently-skipped scope), and throws on any malformed raw line
 * BEFORE handing the text to parseTrecRun() (build-rrf-mini-set.mjs),
 * which would otherwise silently drop a malformed row instead of
 * surfacing it — see strictCheckRawTrecLines().
 */
export function loadTrecRunAsRanked(path) {
  if (!existsSync(path)) {
    throw new Error(`[analyze-fusion] expected TREC run file missing: ${path}`);
  }
  const text = readFileSync(path, 'utf-8');
  strictCheckRawTrecLines(text, path);
  const byQuery = parseTrecRun(text);
  const ranked = new Map();
  for (const [qid, entries] of byQuery.entries()) {
    ranked.set(qid, entries.map((e) => e.docId));
  }
  return { ranked, byQueryRaw: byQuery };
}

/**
 * Strict structural validation of one loaded TREC run against the
 * benchmark contract it claims to belong to. Every check is a hard
 * failure (throws), never a warning — an analysis built on a corrupted
 * run would produce misleading verdicts.
 *
 *   - ranks are positive integers, unique per query (no duplicate rank
 *     within one query's block);
 *   - no duplicate doc ID within one query's block;
 *   - the run's query ID set exactly matches `expectedQueryIds` (no
 *     missing query, no unexpected extra query) — this is what "query
 *     sets match their corresponding benchmark contract" means in
 *     practice: a BEIR full run must cover exactly the 300 test queries,
 *     a mini/MIRACL-subset run must cover exactly its 100 selected
 *     queries, never a mismatched or partial set.
 */
export function validateTrecRun(byQueryRaw, { expectedQueryIds, label }) {
  const problems = [];
  const actualQueryIds = new Set(byQueryRaw.keys());
  const expectedSet = new Set(expectedQueryIds);

  for (const qid of expectedSet) {
    if (!actualQueryIds.has(qid)) problems.push(`${label}: missing query ${qid}`);
  }
  for (const qid of actualQueryIds) {
    if (!expectedSet.has(qid)) problems.push(`${label}: unexpected query ${qid} not in the benchmark's query set`);
  }

  for (const [qid, entries] of byQueryRaw.entries()) {
    const seenRanks = new Set();
    const seenDocIds = new Set();
    for (const { docId, rank } of entries) {
      if (!Number.isInteger(rank) || rank <= 0) {
        problems.push(`${label}: query ${qid} has a non-positive or non-integer rank (${rank}) for doc ${docId}`);
      }
      if (seenRanks.has(rank)) problems.push(`${label}: query ${qid} has a duplicate rank ${rank}`);
      seenRanks.add(rank);
      if (seenDocIds.has(docId)) problems.push(`${label}: query ${qid} has a duplicate doc ID ${docId}`);
      seenDocIds.add(docId);
    }
  }

  if (problems.length > 0) {
    throw new Error(`[analyze-fusion] TREC validation failed for ${label}:\n  - ${problems.join('\n  - ')}`);
  }
  return { ok: true };
}

/** Recomputes computeMetrics() from a freshly-loaded TREC run and compares
 * every field against an already-reported metrics object (from the
 * committed JSON/markdown report) within FLOAT_TOLERANCE. Throws on any
 * mismatch beyond tolerance — this is the "recomputed metrics match the
 * existing JSON/report metrics" requirement, and it is what proves this
 * analyzer's own TREC parsing/metric pipeline agrees with the pipeline
 * that produced the original report, not just that it runs without error. */
export function assertMetricParity(recomputed, reported, { label, tolerance = FLOAT_TOLERANCE } = {}) {
  if (!reported) return { ok: true, skipped: true, reason: `no reported metrics supplied for ${label}` };
  const fields = ['ndcgAt10', 'mapAt100', 'recallAt10', 'recallAt100', 'precisionAt10', 'mrrAt10'];
  const mismatches = [];
  for (const field of fields) {
    const a = recomputed[field];
    const b = reported[field];
    if (a === null && b === null) continue;
    if (a === null || b === null || typeof a !== 'number' || typeof b !== 'number') {
      mismatches.push(`${field}: recomputed=${a} reported=${b}`);
      continue;
    }
    if (Math.abs(a - b) > tolerance) {
      mismatches.push(`${field}: recomputed=${a} reported=${b} diff=${Math.abs(a - b)}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`[analyze-fusion] metric parity check failed for ${label} (tolerance ${tolerance}):\n  - ${mismatches.join('\n  - ')}`);
  }
  return { ok: true, skipped: false };
}

// ── overlap / rescue / harm ──────────────────────────────────────────────

/** Fraction of query-level top-k overlap between two ranked lists (docs
 * present in BOTH top-k sets, divided by k — or by the shorter list's
 * length if a run has fewer than k results for that query). */
function topKOverlapFraction(rankedA, rankedB, k) {
  const setA = new Set(rankedA.slice(0, k));
  const setB = new Set(rankedB.slice(0, k));
  const denom = Math.min(setA.size, setB.size) || 1;
  let shared = 0;
  for (const id of setA) if (setB.has(id)) shared += 1;
  return shared / denom;
}

/** Mean top-10/top-100 dense/sparse overlap across all queries in `qids`. */
export function computeDenseSparseOverlap(qids, denseRanked, sparseRanked) {
  let sum10 = 0;
  let sum100 = 0;
  for (const qid of qids) {
    const d = denseRanked.get(qid) ?? [];
    const s = sparseRanked.get(qid) ?? [];
    sum10 += topKOverlapFraction(d, s, OVERLAP_TOP_K.top10);
    sum100 += topKOverlapFraction(d, s, OVERLAP_TOP_K.top100);
  }
  const n = qids.length || 1;
  return { top10OverlapMean: sum10 / n, top100OverlapMean: sum100 / n };
}

/** Relevant-document overlap between dense and sparse channels: for each
 * query, which RELEVANT (qrels-positive) docs appear in dense's top-k,
 * sparse's top-k, both, or only one side. Aggregated into per-scope
 * counts, not per-query, since this is a corpus-level diagnostic about
 * whether the two channels retrieve the SAME relevant evidence or
 * COMPLEMENTARY relevant evidence. */
export function computeRelevantOverlap(qids, qrels, denseRanked, sparseRanked, k = 10) {
  let denseOnlyHits = 0;
  let sparseOnlyHits = 0;
  let bothHits = 0;
  let neitherHits = 0; // relevant docs that appear in neither top-k (missed by both channels)
  for (const qid of qids) {
    const qrelsForQuery = qrels.get(qid);
    if (!qrelsForQuery) continue;
    const relevantDocIds = [...qrelsForQuery.entries()].filter(([, rel]) => rel > 0).map(([id]) => id);
    const denseTopK = new Set((denseRanked.get(qid) ?? []).slice(0, k));
    const sparseTopK = new Set((sparseRanked.get(qid) ?? []).slice(0, k));
    for (const docId of relevantDocIds) {
      const inDense = denseTopK.has(docId);
      const inSparse = sparseTopK.has(docId);
      if (inDense && inSparse) bothHits += 1;
      else if (inDense) denseOnlyHits += 1;
      else if (inSparse) sparseOnlyHits += 1;
      else neitherHits += 1;
    }
  }
  return { denseOnlyHits, sparseOnlyHits, bothHits, neitherHits, k };
}

/**
 * Classifies each query as a hybrid "rescue" (hybrid nDCG@10 > dense
 * nDCG@10), "harm" (hybrid nDCG@10 < dense nDCG@10), or "tie" (equal),
 * comparing an ACTUAL Qdrant hybrid run against the dense-only run — never
 * a locally-reconstructed hybrid. Returns both the aggregate counts and
 * the full per-query list (for picking representative cases).
 */
/** 1-based rank of the best (lowest-rank) relevant document in a ranked
 * list, or null if no relevant document appears in it at all. Used to
 * describe rank MOVEMENT for representative cases without quoting any
 * passage text — only a query ID and a rank number. */
function bestRelevantRank(qrelsForQuery, ranked) {
  if (!qrelsForQuery) return null;
  for (let i = 0; i < ranked.length; i++) {
    if ((qrelsForQuery.get(ranked[i]) ?? 0) > 0) return i + 1;
  }
  return null;
}

export function classifyRescueHarm(qids, qrelsMap, denseRanked, hybridRanked) {
  const perQuery = [];
  let rescueCount = 0;
  let harmCount = 0;
  let tieCount = 0;
  for (const qid of qids) {
    const qrelsForQuery = qrelsMap.get(qid);
    const denseR = denseRanked.get(qid) ?? [];
    const hybridR = hybridRanked.get(qid) ?? [];
    const denseNdcg = ndcgAtK(qrelsForQuery, denseR, 10);
    const hybridNdcg = ndcgAtK(qrelsForQuery, hybridR, 10);
    const delta = hybridNdcg - denseNdcg;
    let classification = 'tie';
    if (delta > FLOAT_TOLERANCE) { classification = 'rescue'; rescueCount += 1; }
    else if (delta < -FLOAT_TOLERANCE) { classification = 'harm'; harmCount += 1; }
    else { tieCount += 1; }
    perQuery.push({
      qid, denseNdcg, hybridNdcg, delta, classification,
      denseBestRelevantRank: bestRelevantRank(qrelsForQuery, denseR),
      hybridBestRelevantRank: bestRelevantRank(qrelsForQuery, hybridR),
    });
  }
  return { rescueCount, harmCount, tieCount, perQuery };
}

/** Oracle max(dense, sparse) nDCG@10 per query, averaged — an UPPER-BOUND
 * diagnostic only (not an achievable fusion policy: it requires knowing in
 * advance, per query, which channel will do better). Used only to show how
 * much headroom exists between the best-of-both-worlds ceiling and what
 * hybrid actually achieves — never presented as a recommendation. */
export function computeOracleMaxNdcg(qids, qrelsMap, denseRanked, sparseRanked) {
  let sum = 0;
  for (const qid of qids) {
    const qrelsForQuery = qrelsMap.get(qid);
    const d = ndcgAtK(qrelsForQuery, denseRanked.get(qid) ?? [], 10);
    const s = ndcgAtK(qrelsForQuery, sparseRanked.get(qid) ?? [], 10);
    sum += Math.max(d, s);
  }
  return qids.length > 0 ? sum / qids.length : null;
}

// ── per-scope analysis ───────────────────────────────────────────────────

/**
 * Runs the full required analysis for one benchmark scope: aggregate
 * metrics per mode, paired bootstrap comparisons (dense vs sparse vs each
 * observed hybrid, k=2 vs k=60 when both exist), overlaps, relevant-doc
 * overlap, rescue/harm classification (against every observed hybrid
 * mode), and the oracle upper bound.
 *
 * @param {{
 *   label: string,
 *   qids: string[],
 *   qrels: Map<string, Map<string, number>>,
 *   modes: Record<string, Map<string, string[]>>,  // e.g. {dense, sparse, hybrid_k2, hybrid_k60}
 *   reportedMetrics?: Record<string, object>,        // optional, for parity checking
 * }} scope
 */
export function analyzeScope(scope) {
  const { label, qids, qrels, modes, reportedMetrics } = scope;

  const metricsByMode = {};
  const perQueryByMode = {};
  for (const [modeName, ranked] of Object.entries(modes)) {
    const recomputed = computeMetrics(qrels, ranked);
    assertMetricParity(recomputed, reportedMetrics?.[modeName], { label: `${label}/${modeName}` });
    metricsByMode[modeName] = recomputed;
    perQueryByMode[modeName] = perQueryMetrics(qrels, ranked);
  }

  const hybridModeNames = Object.keys(modes).filter((m) => m.startsWith('hybrid_k'));

  // pairedBootstrap(valuesA, valuesB) always reports meanDelta = mean(B -
  // A) — see bootstrap.mjs. Every comparison below is built as
  // pairedBootstrap(<baseline>, <comparison>) so that `meanDelta` always
  // reads as "<comparison> minus <baseline>", matching each key's own
  // name (e.g. comparisons.k2_vs_k60.meanDelta = k2 − k60, positive means
  // k2 scored higher — NOT k60 − k2). Getting the argument order backwards
  // here silently flips the sign of every downstream report table without
  // changing which value looks "positive", so double-check baseline/
  // comparison order against the key name whenever this block changes.
  const perQueryValues = (modeName) => qids.map((q) => perQueryByMode[modeName]?.get(q)?.[RESCUE_HARM_METRIC] ?? null);

  const comparisons = {};
  if (modes.dense && modes.sparse) {
    for (const hybridMode of hybridModeNames) {
      // ${hybridMode}_vs_dense: baseline=dense, comparison=hybrid -> meanDelta = hybrid − dense.
      comparisons[`${hybridMode}_vs_dense`] = pairedBootstrap(perQueryValues('dense'), perQueryValues(hybridMode));
      // ${hybridMode}_vs_sparse: baseline=sparse, comparison=hybrid -> meanDelta = hybrid − sparse.
      comparisons[`${hybridMode}_vs_sparse`] = pairedBootstrap(perQueryValues('sparse'), perQueryValues(hybridMode));
    }
    // dense_vs_sparse: baseline=dense, comparison=sparse -> meanDelta = sparse − dense.
    comparisons.dense_vs_sparse = pairedBootstrap(perQueryValues('dense'), perQueryValues('sparse'));
  }
  if (hybridModeNames.includes('hybrid_k2') && hybridModeNames.includes('hybrid_k60')) {
    // k2_vs_k60: baseline=hybrid_k60, comparison=hybrid_k2 -> meanDelta = k2 − k60.
    comparisons.k2_vs_k60 = pairedBootstrap(perQueryValues('hybrid_k60'), perQueryValues('hybrid_k2'));
  }

  const overlap = modes.dense && modes.sparse ? computeDenseSparseOverlap(qids, modes.dense, modes.sparse) : null;
  const relevantOverlap = modes.dense && modes.sparse ? computeRelevantOverlap(qids, qrels, modes.dense, modes.sparse) : null;
  const oracleMaxNdcg10 = modes.dense && modes.sparse ? computeOracleMaxNdcg(qids, qrels, modes.dense, modes.sparse) : null;

  const rescueHarmByHybrid = {};
  if (modes.dense) {
    for (const hybridMode of hybridModeNames) {
      rescueHarmByHybrid[hybridMode] = classifyRescueHarm(qids, qrels, modes.dense, modes[hybridMode]);
    }
  }

  return {
    label,
    queryCount: qids.length,
    metricsByMode,
    comparisons,
    overlap,
    relevantOverlap,
    oracleMaxNdcg10,
    rescueHarmByHybrid,
  };
}

// ── scope loading (offline only) ─────────────────────────────────────────

/** Loads the BEIR SciFact FULL dataset qrels (test split, 300 queries) —
 * strictly from the already-extracted local cache; never fetches. */
export function loadBeirFullQrels() {
  const { corpus, queries, qrels } = loadDataset();
  const validation = validateDataset({ corpus, queries, qrels });
  if (!validation.ok) {
    throw new Error(`[analyze-fusion] BEIR full dataset failed validation: ${validation.problems.join('; ')}`);
  }
  return { queries, qrels };
}

/** Loads the BEIR SciFact LOCAL MINI-SET qrels (100 queries, 1000-document
 * pooled subset) — strictly from the already-written cache; never
 * fetches, never rebuilds. This is a DIFFERENT, SMALLER query/qrels scope
 * than the full 300-query BEIR benchmark — never merged with it. */
export function loadBeirMiniQrels() {
  const miniSet = loadCachedMiniSet();
  return { queries: miniSet.queries, qrels: miniSet.qrels };
}

/** Loads the MIRACL Russian pooled-subset qrels (100 queries, 1000-passage
 * subset) — strictly from the already-written cache; never fetches, never
 * rebuilds. */
export function loadMiraclQrels() {
  const subset = loadCachedMiraclSubset();
  return { queries: subset.queries, qrels: subset.qrels };
}

function loadModeIfExists(path, expectedQueryIds, label) {
  if (!existsSync(path)) return null;
  const { ranked, byQueryRaw } = loadTrecRunAsRanked(path);
  validateTrecRun(byQueryRaw, { expectedQueryIds, label });
  return ranked;
}

/** Builds every scope this task requires, each strictly separated, each
 * carrying only the TREC modes that actually exist on disk (a mode that
 * was never run for that scope is simply absent — never synthesized). */
export function buildAllScopes({ reportedMetricsByScope = {} } = {}) {
  const scopes = [];

  // 1. SciFact full local common-512: dense, sparse, hybrid k=60 only
  //    (the full BEIR harness never ran local at k=2 — see profiles.mjs).
  {
    const { queries, qrels } = loadBeirFullQrels();
    const qids = [...queries.keys()];
    const modes = {};
    modes.dense = loadModeIfExists(join(BEIR_RUNS_DIR, 'local-common-512-dense.trec'), qids, 'beir-full-local/dense');
    modes.sparse = loadModeIfExists(join(BEIR_RUNS_DIR, 'local-common-512-sparse.trec'), qids, 'beir-full-local/sparse');
    modes.hybrid_k60 = loadModeIfExists(join(BEIR_RUNS_DIR, 'local-common-512-hybrid_k60.trec'), qids, 'beir-full-local/hybrid_k60');
    scopes.push({ id: 'beir_full_local', label: 'SciFact full — local BGE-M3 (common-512)', qids, qrels, modes, reportedMetrics: reportedMetricsByScope.beir_full_local });
  }

  // 2. SciFact full cloud common-512: dense, sparse, hybrid k=2/k=60
  {
    const { queries, qrels } = loadBeirFullQrels();
    const qids = [...queries.keys()];
    const modes = {};
    modes.dense = loadModeIfExists(join(BEIR_RUNS_DIR, 'cloud-common-512-dense.trec'), qids, 'beir-full-cloud/dense');
    modes.sparse = loadModeIfExists(join(BEIR_RUNS_DIR, 'cloud-common-512-sparse.trec'), qids, 'beir-full-cloud/sparse');
    modes.hybrid_k2 = loadModeIfExists(join(BEIR_RUNS_DIR, 'cloud-common-512-hybrid_k2.trec'), qids, 'beir-full-cloud/hybrid_k2');
    modes.hybrid_k60 = loadModeIfExists(join(BEIR_RUNS_DIR, 'cloud-common-512-hybrid_k60.trec'), qids, 'beir-full-cloud/hybrid_k60');
    scopes.push({ id: 'beir_full_cloud', label: 'SciFact full — Qdrant Cloud E5+BM25 (common-512)', qids, qrels, modes, reportedMetrics: reportedMetricsByScope.beir_full_cloud });
  }

  // 3. SciFact LOCAL MINI (separate scope — never merged with #1)
  {
    const { queries, qrels } = loadBeirMiniQrels();
    const qids = [...queries.keys()];
    const modes = {};
    modes.dense = loadModeIfExists(join(BEIR_RUNS_DIR, 'local-rrf-mini-dense.trec'), qids, 'beir-mini-local/dense');
    modes.sparse = loadModeIfExists(join(BEIR_RUNS_DIR, 'local-rrf-mini-sparse.trec'), qids, 'beir-mini-local/sparse');
    modes.hybrid_k2 = loadModeIfExists(join(BEIR_RUNS_DIR, 'local-rrf-mini-hybrid_k2.trec'), qids, 'beir-mini-local/hybrid_k2');
    modes.hybrid_k60 = loadModeIfExists(join(BEIR_RUNS_DIR, 'local-rrf-mini-hybrid_k60.trec'), qids, 'beir-mini-local/hybrid_k60');
    scopes.push({ id: 'beir_mini_local', label: 'SciFact LOCAL MINI (100q/1000d pooled subset — NOT full SciFact)', qids, qrels, modes, reportedMetrics: reportedMetricsByScope.beir_mini_local, isMini: true });
  }

  // 4. MIRACL pooled subset — local and cloud, each dense/sparse/hybrid k2/k60
  for (const profile of ['local', 'cloud']) {
    const { queries, qrels } = loadMiraclQrels();
    const qids = [...queries.keys()];
    const modes = {};
    modes.dense = loadModeIfExists(join(MIRACL_RUNS_DIR, `${profile}-dense.trec`), qids, `miracl-${profile}/dense`);
    modes.sparse = loadModeIfExists(join(MIRACL_RUNS_DIR, `${profile}-sparse.trec`), qids, `miracl-${profile}/sparse`);
    modes.hybrid_k2 = loadModeIfExists(join(MIRACL_RUNS_DIR, `${profile}-hybrid_k2.trec`), qids, `miracl-${profile}/hybrid_k2`);
    modes.hybrid_k60 = loadModeIfExists(join(MIRACL_RUNS_DIR, `${profile}-hybrid_k60.trec`), qids, `miracl-${profile}/hybrid_k60`);
    scopes.push({ id: `miracl_${profile}`, label: `MIRACL Russian pooled subset — ${profile}`, qids, qrels, modes, reportedMetrics: reportedMetricsByScope[`miracl_${profile}`] });
  }

  return scopes;
}

// ── representative case selection ────────────────────────────────────────

/** Picks up to `n` clearest rescue cases and `n` clearest harm cases (by
 * |delta| descending) from a rescue/harm classification, formatted with
 * only query ID + rank movement — no passage text, no local paths. */
export function pickRepresentativeCases(rescueHarmResult, { n = 3 } = {}) {
  const rescues = rescueHarmResult.perQuery.filter((r) => r.classification === 'rescue').sort((a, b) => b.delta - a.delta).slice(0, n);
  const harms = rescueHarmResult.perQuery.filter((r) => r.classification === 'harm').sort((a, b) => a.delta - b.delta).slice(0, n);
  return { rescues, harms };
}

// ── overall verdict ──────────────────────────────────────────────────────

/**
 * Descriptive diagnosis (never ACCEPT/REJECT), based on BOTH aggregate
 * rescue/harm counts and paired bootstrap significance across scopes:
 *   - FUSION_COMPLEMENTARY: hybrid significantly beats dense in most scopes
 *     with a real (bootstrap-significant) improvement.
 *   - FUSION_SPARSE_DEGRADES: hybrid significantly underperforms dense in
 *     most scopes.
 *   - FUSION_DATASET_DEPENDENT: direction differs by scope/dataset (the
 *     actually-observed pattern here — SciFact vs MIRACL disagree).
 *   - FUSION_ANALYSIS_INCONCLUSIVE: not enough bootstrap-significant
 *     evidence either way.
 */
export function computeOverallVerdict(scopes) {
  const directions = [];
  for (const scope of scopes) {
    for (const hybridMode of Object.keys(scope.modes).filter((m) => m.startsWith('hybrid_k'))) {
      const cmp = scope.comparisons[`${hybridMode}_vs_dense`];
      if (!cmp || cmp.n === 0) continue;
      if (cmp.excludesZero) directions.push(cmp.meanDelta > 0 ? 'hybrid_better' : 'hybrid_worse');
    }
  }
  if (directions.length === 0) return 'FUSION_ANALYSIS_INCONCLUSIVE';
  const better = directions.filter((d) => d === 'hybrid_better').length;
  const worse = directions.filter((d) => d === 'hybrid_worse').length;
  if (better > 0 && worse === 0) return 'FUSION_COMPLEMENTARY';
  if (worse > 0 && better === 0) return 'FUSION_SPARSE_DEGRADES';
  if (better > 0 && worse > 0) return 'FUSION_DATASET_DEPENDENT';
  return 'FUSION_ANALYSIS_INCONCLUSIVE';
}

// ── CLI entry point ───────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const scopes = buildAllScopes({ reportedMetricsByScope: loadReportedMetricsByScope() });
    const analyzed = scopes.map((scope) => ({ ...scope, ...analyzeScope(scope) }));
    const verdict = computeOverallVerdict(analyzed);
    console.log(JSON.stringify({
      verdict,
      scopes: analyzed.map((s) => ({
        id: s.id, label: s.label, queryCount: s.queryCount,
        metricsByMode: s.metricsByMode, comparisons: s.comparisons,
        overlap: s.overlap, relevantOverlap: s.relevantOverlap, oracleMaxNdcg10: s.oracleMaxNdcg10,
        rescueHarmSummary: Object.fromEntries(Object.entries(s.rescueHarmByHybrid).map(([k, v]) => [k, { rescueCount: v.rescueCount, harmCount: v.harmCount, tieCount: v.tieCount }])),
      })),
    }, null, 2));
    process.exitCode = 0;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
