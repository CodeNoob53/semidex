// custom-50 v4 metrics — named to match their formulas (audit 2026-09-06, P2:
// "chunkRecall is actually Hit@K", "NegativePassRate is not abstention
// quality"). Pure functions, no I/O — unit-tested directly against tiny
// hand-built fixtures in metrics-v4.test.mjs.
//
// A "ranked result" here is the minimal shape both the low-level
// hybridSearch() path and a runHybridSearch() Chunk expose: an object from
// which resultChunkId() can derive "<source_file>#<chunk_index>".

/** "<source_file>#<chunk_index>" from a Qdrant point or a Chunk, or null. */
export function resultChunkId(r) {
  const sf = r?.payload?.source_file ?? r?.sourceFile ?? null;
  const ci = r?.payload?.chunk_index ?? r?.chunkIndex ?? null;
  if (sf == null || ci == null) return null;
  return `${sf}#${ci}`;
}

/**
 * Hit@K — fraction of queries for which AT LEAST ONE relevance>=minRel
 * chunk appears in the top K. This is what the v3 metric called
 * `chunkRecall@K`; the name was misleading (it is not a recall of all
 * relevant chunks). Returns null when the query has no qrel at that grade.
 *
 * @param {Array} results ranked results (index 0 = rank 1)
 * @param {Map<string, number>} qrels chunkId -> relevance
 * @param {number} k
 * @param {number} [minRel=3]
 * @returns {boolean|null}
 */
export function hitAtK(results, qrels, k, minRel = 3) {
  const relevantIds = gradeIds(qrels, minRel);
  if (relevantIds.size === 0) return null;
  return results.slice(0, k).some((r) => relevantIds.has(resultChunkId(r)));
}

/**
 * Recall@K — fraction of the query's relevance>=minRel chunks that appear
 * in the top K (|retrieved ∩ relevant| / |relevant|). For a query with one
 * relevant chunk this equals Hit@K; for multi-relevant queries it does not.
 * Returns null when the query has no qrel at that grade.
 *
 * @returns {number|null} in [0, 1]
 */
export function recallAtK(results, qrels, k, minRel = 3) {
  const relevantIds = gradeIds(qrels, minRel);
  if (relevantIds.size === 0) return null;
  const topIds = new Set(results.slice(0, k).map(resultChunkId));
  let found = 0;
  for (const id of relevantIds) if (topIds.has(id)) found += 1;
  return found / relevantIds.size;
}

/**
 * requiredEvidenceCoverage@K — for a query that needs specific chunk(s) to
 * be fully answerable (`requiredEvidence`: an array of groups; a group is
 * satisfied when ANY of its chunkIds is in the top K; the query is covered
 * when EVERY group is satisfied). Distinct from Hit@K: Hit@K fires on one
 * lucky chunk; this fires only when all required evidence is actually
 * delivered. Returns null when the query declares no requiredEvidence.
 *
 * @param {Array} results
 * @param {string[][]} requiredEvidence
 * @param {number} k
 * @returns {boolean|null}
 */
export function requiredEvidenceCoverageAtK(results, requiredEvidence, k) {
  if (!Array.isArray(requiredEvidence) || requiredEvidence.length === 0) return null;
  const topIds = new Set(results.slice(0, k).map(resultChunkId));
  return requiredEvidence.every((group) => group.some((id) => topIds.has(id)));
}

/**
 * Graded nDCG@K. Gain convention: gain(rel) = 2^rel - 1 (rel in {0,1,2,3}),
 * discount = 1 / log2(rank + 1) with rank 1-based. IDCG is over the query's
 * own qrel grades. This is the "graded nDCG" the v3 schema documented; the
 * gain convention is stated here so it is never ambiguous which one is used.
 *
 * @returns {number|null} null when the query has no qrels at all
 */
export function gradedNdcgAtK(results, qrels, k) {
  if (qrels.size === 0) return null;
  const gain = (rel) => (2 ** rel) - 1;
  let dcg = 0;
  const top = results.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    const rel = qrels.get(resultChunkId(top[i])) ?? 0;
    dcg += gain(rel) / Math.log2(i + 2);
  }
  const idealGains = [...qrels.values()].map(gain).sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealGains.length; i++) idcg += idealGains[i] / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * MRR@K over relevance>=minRel chunks. Reciprocal rank of the first such
 * chunk in the top K, or 0 if none. Null when the query has no qrel at that
 * grade.
 */
export function mrrAtK(results, qrels, k, minRel = 3) {
  const relevantIds = gradeIds(qrels, minRel);
  if (relevantIds.size === 0) return null;
  const top = results.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    if (relevantIds.has(resultChunkId(top[i]))) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Negative diagnostic (token-absence). For a retrieval-negative query,
 * returns true when NONE of `expectedAbsentTokens` appears in the rank-1
 * result's text/section. This is NOT an abstention/no-answer quality
 * metric — the retriever always returns nearest neighbours, so this only
 * says "the closest chunk isn't obviously about the (nonexistent) subject".
 * Real refusal quality needs a live-generation Ask eval.
 *
 * @param {Array} results
 * @param {string[]} expectedAbsentTokens
 * @returns {boolean|null} null when no tokens given
 */
export function negativeTokenAbsenceAtRank1(results, expectedAbsentTokens) {
  if (!Array.isArray(expectedAbsentTokens) || expectedAbsentTokens.length === 0) return null;
  const r0 = results[0];
  if (!r0) return true; // genuinely empty — vacuously "absent"
  const hay = `${textOf(r0)} ${sectionOf(r0)}`.toLowerCase();
  return !expectedAbsentTokens.some((t) => hay.includes(String(t).toLowerCase()));
}

// ── internal ──────────────────────────────────────────────────────────────

function gradeIds(qrels, minRel) {
  const s = new Set();
  for (const [id, rel] of qrels.entries()) if (rel >= minRel) s.add(id);
  return s;
}

function textOf(r) {
  return r?.payload?.text ?? r?.text ?? '';
}
function sectionOf(r) {
  return r?.payload?.section ?? r?.section ?? '';
}

/**
 * v3-compatibility aliases — ONLY for consumers that still read the old
 * names. `chunkRecallAtK` is exactly `hitAtK`; keep the alias but never
 * present it in a report as "recall".
 */
export const chunkRecallAtK = hitAtK;
