// Guarded / blended ColBERT ordering — pure functions, no model load, no I/O.
//
// Implements the three mitigations recommended by the 2026-05-17 ColBERT verdict
// (benchmarks/retrieval/results/2026-05-16-bge-m3-colbert-head-probe.md):
//
//   1. Top-1 protection — the original hybrid #1 keeps position 1 unless the
//      ColBERT challenger's raw MaxSim advantage exceeds `protectDelta`.
//      Mirrors the protection mechanism in src/core/rerank.js (compared by
//      identity, on the raw MaxSim scale where typical scores span 0.39–0.74).
//
//   2. Hybrid/ColBERT blend — final ordering score mixes min-max-normalised
//      ColBERT MaxSim with the hybrid rank prior 1/(rank+1):
//        blend = alpha * colbertNorm + (1 - alpha) * 1/(hybridRank + 1)
//      RRF scores (0.016–0.033) and MaxSim scores (0.39–0.74) are not on a
//      shared scale, so the hybrid leg uses rank, not raw RRF score.
//
//   3. Trigger-only rerank — apply ColBERT only when hybrid confidence is low,
//      measured as the relative RRF score gap between hybrid #1 and #2:
//        gap = (s1 - s2) / s1
//      A large gap means hybrid is confident — keep its order and (in a real
//      runtime) skip the ColBERT inference cost entirely.
//
// Tested by src/smoke/sections/40-colbert-guard.js.

// Min-max normalise an array of scores to [0, 1].
// A constant array (span 0) maps every element to 0.5.
export function minMaxNormalize(scores) {
  if (!scores.length) return [];
  let min = Infinity, max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const span = max - min;
  return scores.map(s => (span > 0 ? (s - min) / span : 0.5));
}

/**
 * Order a ColBERT-scored candidate pool with blend + top-1 protection.
 *
 * @param {Array} allScored — candidates in ORIGINAL hybrid pool order, each
 *                            carrying `.score` (raw ColBERT MaxSim). This is
 *                            exactly the output of scoreColBERTAll().
 * @param {Object} opts
 * @param {number} [opts.protectDelta=0.05] — min raw-MaxSim advantage required
 *                 to displace the hybrid #1. 0 disables protection.
 * @param {number} [opts.blendAlpha=0.7] — weight of the ColBERT leg in the
 *                 blend. 1 = pure ColBERT order, 0 = pure hybrid order.
 * @param {number} [opts.topK=allScored.length]
 * @returns {Array} reordered candidates, `.score` replaced by the blend score.
 */
export function guardedColbertOrder(allScored, {
  protectDelta = 0.05,
  blendAlpha   = 0.7,
  topK         = allScored.length,
} = {}) {
  if (!allScored.length) return [];

  const colbertNorm = minMaxNormalize(allScored.map(c => c.score));
  const entries = allScored.map((cand, hybridRank) => ({
    cand,
    hybridRank,
    colbertScore: cand.score,
    blend: blendAlpha * colbertNorm[hybridRank]
         + (1 - blendAlpha) * (1 / (hybridRank + 1)),
  }));

  // entries[0] is the original hybrid #1 (pool arrives in hybrid order).
  const hybridTop = entries[0];

  const sorted = [...entries].sort((a, b) =>
    b.blend - a.blend || a.hybridRank - b.hybridRank); // stable tie-break: hybrid order

  // Top-1 protection on the raw MaxSim scale (identity comparison, like rerank.js).
  if (protectDelta > 0 && sorted[0] !== hybridTop) {
    const challenger = sorted[0];
    if (challenger.colbertScore - hybridTop.colbertScore < protectDelta) {
      const idx = sorted.indexOf(hybridTop);
      sorted.splice(idx, 1);
      sorted.unshift(hybridTop);
    }
  }

  return sorted.slice(0, topK).map(e => ({ ...e.cand, score: e.blend }));
}

/**
 * Relative confidence gap between hybrid #1 and #2 RRF scores.
 * Returns null when the pool has fewer than 2 results or #1 has a
 * non-positive score (no meaningful confidence signal).
 *
 * @param {Array} pool — hybrid results in rank order, each with `.score`.
 * @returns {number|null} (s1 - s2) / s1, in [0, 1] for normal RRF output.
 */
export function hybridConfidenceGap(pool) {
  if (!Array.isArray(pool) || pool.length < 2) return null;
  const s1 = pool[0]?.score ?? 0;
  const s2 = pool[1]?.score ?? 0;
  if (!(s1 > 0)) return null;
  return (s1 - s2) / s1;
}

/**
 * Trigger policy: rerank with ColBERT only when hybrid confidence is low.
 * Unknown confidence (tiny pool / zero scores) triggers the rerank — the
 * conservative choice for ambiguous queries.
 *
 * @param {Array} pool — hybrid results in rank order.
 * @param {number} [gapThreshold=0.10]
 * @returns {boolean} true → apply ColBERT; false → keep hybrid order.
 */
export function shouldTriggerColbert(pool, gapThreshold = 0.10) {
  const gap = hybridConfidenceGap(pool);
  return gap === null || gap < gapThreshold;
}
