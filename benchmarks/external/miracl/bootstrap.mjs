// Deterministic paired bootstrap significance testing for retrieval-metric
// comparisons (e.g. k=2 vs k=60, hybrid vs dense, local vs cloud).
//
// Standard paired bootstrap over per-query metric values: resample query
// indices with replacement B times, compute the mean paired delta for each
// resample, and report the 2.5th/97.5th percentiles of that distribution as
// a 95% confidence interval. A configuration is only ever called "better"
// when this interval excludes zero — this module never uses an arbitrary
// epsilon as statistical evidence (unlike, e.g., the BEIR RRF mini
// benchmark's earlier epsilon-based tie rule, which this harness's task
// explicitly supersedes with a real statistical test).
//
// Determinism: resampling uses a seeded counter-mode SHA-256 stream (same
// mechanism as build-miracl-subset.mjs's seededShuffle) — never
// Math.random() — so the exact same (seed, iteration count, input arrays)
// always reproduces the identical confidence interval, byte for byte.
import { createHash } from 'node:crypto';
import { ndcgAtK, recallAtK, precisionAtK, averagePrecisionAtK, reciprocalRankAtK } from '../beir/metrics.mjs';

export const DEFAULT_BOOTSTRAP_SEED = 'semidex-miracl-ru-bootstrap-v1';
export const DEFAULT_BOOTSTRAP_ITERATIONS = 2000;

function* sha256Stream(seed) {
  let counter = 0;
  while (true) {
    const digestBuf = createHash('sha256').update(`${seed}:${counter}`).digest();
    for (let i = 0; i + 4 <= digestBuf.length; i += 4) {
      yield digestBuf.readUInt32BE(i);
    }
    counter += 1;
  }
}

/** Deterministic integer in [0, n) drawn from a seeded uint32 stream. */
function nextIndex(stream, n) {
  const raw = stream.next().value / 0x100000000; // uint32 -> [0, 1)
  return Math.floor(raw * n);
}

/**
 * Paired bootstrap over two equal-length arrays of per-query metric values
 * (same query order in both — the caller is responsible for aligning them).
 * A query pair where either value is null/undefined/non-finite is excluded
 * from the paired sample entirely (that query is undefined for this metric
 * under at least one of the two configurations being compared — e.g.
 * Recall for a query with zero relevant docs).
 *
 * @param {Array<number|null>} valuesA
 * @param {Array<number|null>} valuesB
 * @param {{ seed?: string, iterations?: number }} [options]
 * @returns {{
 *   n: number,
 *   meanDelta: number,        // mean(B - A) over paired, non-excluded queries
 *   wins: number,              // count where B > A
 *   losses: number,            // count where B < A
 *   ties: number,               // count where B === A
 *   ciLow: number, ciHigh: number, // 95% bootstrap CI on meanDelta (B - A)
 *   excludesZero: boolean,      // true iff the 95% CI does not contain 0
 *   verdict: 'B_BETTER'|'A_BETTER'|'MIXED'|'INCONCLUSIVE',
 *   seed: string, iterations: number,
 * }}
 */
export function pairedBootstrap(valuesA, valuesB, { seed = DEFAULT_BOOTSTRAP_SEED, iterations = DEFAULT_BOOTSTRAP_ITERATIONS } = {}) {
  if (valuesA.length !== valuesB.length) {
    throw new Error(`[bootstrap] paired arrays must be the same length (got ${valuesA.length} vs ${valuesB.length})`);
  }
  const pairedDeltas = [];
  let wins = 0; let losses = 0; let ties = 0;
  for (let i = 0; i < valuesA.length; i++) {
    const a = valuesA[i]; const b = valuesB[i];
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const delta = b - a;
    pairedDeltas.push(delta);
    if (delta > 0) wins += 1; else if (delta < 0) losses += 1; else ties += 1;
  }

  const n = pairedDeltas.length;
  if (n === 0) {
    return {
      n: 0, meanDelta: null, wins, losses, ties, ciLow: null, ciHigh: null,
      excludesZero: false, verdict: 'INCONCLUSIVE', seed, iterations,
    };
  }

  const meanDelta = pairedDeltas.reduce((s, v) => s + v, 0) / n;

  const stream = sha256Stream(seed);
  const resampleMeans = new Array(iterations);
  for (let iter = 0; iter < iterations; iter++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += pairedDeltas[nextIndex(stream, n)];
    resampleMeans[iter] = sum / n;
  }
  resampleMeans.sort((x, y) => x - y);

  // Percentile via linear index (standard bootstrap percentile method).
  const lowIdx = Math.max(0, Math.floor(0.025 * iterations));
  const highIdx = Math.min(iterations - 1, Math.ceil(0.975 * iterations) - 1);
  const ciLow = resampleMeans[lowIdx];
  const ciHigh = resampleMeans[highIdx];
  const excludesZero = (ciLow > 0 && ciHigh > 0) || (ciLow < 0 && ciHigh < 0);

  let verdict = 'INCONCLUSIVE';
  if (excludesZero) verdict = meanDelta > 0 ? 'B_BETTER' : 'A_BETTER';
  else if (wins > 0 && losses > 0) verdict = 'MIXED';

  return { n, meanDelta, wins, losses, ties, ciLow, ciHigh, excludesZero, verdict, seed, iterations };
}

/**
 * Convenience wrapper: extracts per-query values for a given metric name
 * from two Map<queryId, metricsObject>-shaped "per-query metrics" records
 * (see runMiraclComparisons() below for how these are produced), aligning
 * by query ID (not array position) so callers never have to pre-sort.
 */
export function pairedBootstrapByQuery(perQueryA, perQueryB, metricKey, options = {}) {
  const queryIds = [...perQueryA.keys()].filter((qid) => perQueryB.has(qid));
  const valuesA = queryIds.map((qid) => perQueryA.get(qid)?.[metricKey] ?? null);
  const valuesB = queryIds.map((qid) => perQueryB.get(qid)?.[metricKey] ?? null);
  return pairedBootstrap(valuesA, valuesB, options);
}

/**
 * Computes PER-QUERY metric values (not aggregated averages) for one
 * qrels/run pair — the shape pairedBootstrapByQuery() consumes. Reuses the
 * same per-query metric functions beir/metrics.mjs's computeMetrics()
 * averages over, so per-query and aggregate numbers are always consistent
 * with each other by construction (same underlying formulas, no
 * duplicated metric logic).
 *
 * @param {Map<string, Map<string, number>>} qrels
 * @param {Map<string, string[]>} run
 * @returns {Map<string, {ndcgAt10, mapAt100, recallAt10, recallAt100, precisionAt10, mrrAt10}>}
 */
export function perQueryMetrics(qrels, run) {
  const result = new Map();
  for (const [qid, ranked] of run.entries()) {
    const qrelsForQuery = qrels.get(qid);
    result.set(qid, {
      ndcgAt10: ndcgAtK(qrelsForQuery, ranked, 10),
      mapAt100: averagePrecisionAtK(qrelsForQuery, ranked, 100),
      recallAt10: recallAtK(qrelsForQuery, ranked, 10),
      recallAt100: recallAtK(qrelsForQuery, ranked, 100),
      precisionAt10: precisionAtK(qrelsForQuery, ranked, 10),
      mrrAt10: reciprocalRankAtK(qrelsForQuery, ranked, 10),
    });
  }
  return result;
}
