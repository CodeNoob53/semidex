// Standard TREC-style document-level retrieval metrics for the BEIR SciFact
// benchmark harness. Pure functions only — no I/O, no Qdrant, no network —
// so they can be unit-tested against a small hand-calculated fixture
// (fixtures/metrics-small.json) independent of any live run.
//
// Conventions (standard IR, matching BEIR's own reference implementation
// semantics — see https://github.com/beir-cellar/beir):
//   - qrels: Map<queryId, Map<docId, relevance>>  (relevance is an integer;
//     SciFact's own qrels.tsv is binary 0/1, but this module supports graded
//     relevance so it is not SciFact-specific).
//   - run:   Map<queryId, string[]>  ranked list of doc IDs, best first,
//     already truncated to whatever depth the caller retrieved (this module
//     never assumes a fixed depth beyond each metric's own @k cutoff).
//   - A doc ID present in `run` but absent from that query's qrels is
//     treated as non-relevant (relevance 0), not an error — BEIR qrels are
//     sparse: only judged documents are listed, everything else is an
//     implicit non-relevant judgment. This matches trec_eval/BEIR behavior.

/**
 * @param {Map<string, number>} qrelsForQuery
 * @param {string} docId
 * @returns {number} relevance grade, 0 if unjudged/absent
 */
function relevanceOf(qrelsForQuery, docId) {
  return qrelsForQuery?.get(docId) ?? 0;
}

/**
 * Total number of relevant (relevance > 0) documents for a query, per its
 * qrels — the denominator for Recall.
 */
function totalRelevant(qrelsForQuery) {
  if (!qrelsForQuery) return 0;
  let n = 0;
  for (const rel of qrelsForQuery.values()) if (rel > 0) n += 1;
  return n;
}

// ── per-query metrics ────────────────────────────────────────────────────────

/** nDCG@k — standard log2 discount, binary-or-graded gain = relevance grade
 * itself (not 2^rel-1 — BEIR's own pytrec_eval-based reference uses the
 * identity gain for graded qrels, and SciFact's qrels are binary 0/1 so the
 * two formulations coincide there anyway). Ideal DCG (IDCG) is computed from
 * the qrels' own relevance values sorted descending, not from the run. */
export function ndcgAtK(qrelsForQuery, rankedDocIds, k) {
  const topK = rankedDocIds.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = relevanceOf(qrelsForQuery, topK[i]);
    if (rel > 0) dcg += rel / Math.log2(i + 2); // rank is 0-based here, +2 so rank0 -> log2(2)=1
  }
  const idealRels = qrelsForQuery ? [...qrelsForQuery.values()].filter((r) => r > 0).sort((a, b) => b - a) : [];
  let idcg = 0;
  for (let i = 0; i < Math.min(k, idealRels.length); i++) {
    idcg += idealRels[i] / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

/** Recall@k — fraction of ALL relevant docs (per qrels) that appear in the
 * top-k of the run. Denominator is total relevant, not min(k, totalRelevant),
 * so Recall@k can never exceed 1 and correctly reflects "how much of the
 * known-relevant set did we surface in the top k." */
export function recallAtK(qrelsForQuery, rankedDocIds, k) {
  const total = totalRelevant(qrelsForQuery);
  if (total === 0) return null; // undefined for a query with no relevant docs at all
  const topK = rankedDocIds.slice(0, k);
  let hit = 0;
  for (const id of topK) if (relevanceOf(qrelsForQuery, id) > 0) hit += 1;
  return hit / total;
}

/** Precision@k — fraction of the top-k that are relevant. Denominator is k
 * itself (standard precision@k; unlike Recall, this does NOT shrink to the
 * available relevant count — a query with only 1 relevant doc can never
 * exceed Precision@10 = 0.1 with a single hit, exactly per convention). */
export function precisionAtK(qrelsForQuery, rankedDocIds, k) {
  const topK = rankedDocIds.slice(0, k);
  let hit = 0;
  for (const id of topK) if (relevanceOf(qrelsForQuery, id) > 0) hit += 1;
  return hit / k;
}

/** Average Precision@k (used for MAP@k) — mean of precision-at-each-relevant-
 * rank, within the top-k, divided by the total number of relevant docs (not
 * by the number of relevant docs found within k) — standard trec_eval
 * average precision semantics restricted to a cutoff. */
export function averagePrecisionAtK(qrelsForQuery, rankedDocIds, k) {
  const total = totalRelevant(qrelsForQuery);
  if (total === 0) return null;
  const topK = rankedDocIds.slice(0, k);
  let hit = 0;
  let sumPrecisions = 0;
  for (let i = 0; i < topK.length; i++) {
    if (relevanceOf(qrelsForQuery, topK[i]) > 0) {
      hit += 1;
      sumPrecisions += hit / (i + 1);
    }
  }
  return sumPrecisions / total;
}

/** Reciprocal Rank@k — 1/rank of the FIRST relevant doc within the top-k, 0
 * if none found in the top-k. MRR@k is the mean of this across queries. */
export function reciprocalRankAtK(qrelsForQuery, rankedDocIds, k) {
  const topK = rankedDocIds.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (relevanceOf(qrelsForQuery, topK[i]) > 0) return 1 / (i + 1);
  }
  return 0;
}

// ── aggregate over a full run ────────────────────────────────────────────────

/**
 * Computes the full standard metric set, averaged over all queries present
 * in `run`. A query is skipped from a given metric's average if that metric
 * returns null for it (queries with zero relevant docs in qrels — Recall and
 * MAP are undefined there, not zero; including them as 0 would understate
 * quality for reasons unrelated to retrieval). nDCG/Precision/RR are always
 * defined (0 when nothing relevant retrieved), so they average over every
 * query in `run`.
 *
 * @param {Map<string, Map<string, number>>} qrels
 * @param {Map<string, string[]>} run
 * @returns {{
 *   queryCount: number,
 *   ndcgAt10: number,
 *   mapAt100: number,
 *   recallAt10: number,
 *   recallAt100: number,
 *   precisionAt10: number,
 *   mrrAt10: number,
 *   skippedForRecallMap: number,
 * }}
 */
export function computeMetrics(qrels, run) {
  const queryIds = [...run.keys()];
  let sumNdcg10 = 0;
  let sumMap100 = 0;
  let sumRecall10 = 0;
  let sumRecall100 = 0;
  let sumPrecision10 = 0;
  let sumMrr10 = 0;
  let mapCount = 0;
  let recall10Count = 0;
  let recall100Count = 0;
  let skippedForRecallMap = 0;

  for (const qid of queryIds) {
    const qrelsForQuery = qrels.get(qid);
    const ranked = run.get(qid) ?? [];

    sumNdcg10 += ndcgAtK(qrelsForQuery, ranked, 10);
    sumPrecision10 += precisionAtK(qrelsForQuery, ranked, 10);
    sumMrr10 += reciprocalRankAtK(qrelsForQuery, ranked, 10);

    const map100 = averagePrecisionAtK(qrelsForQuery, ranked, 100);
    if (map100 !== null) { sumMap100 += map100; mapCount += 1; } else { skippedForRecallMap += 1; }

    const r10 = recallAtK(qrelsForQuery, ranked, 10);
    if (r10 !== null) { sumRecall10 += r10; recall10Count += 1; }
    const r100 = recallAtK(qrelsForQuery, ranked, 100);
    if (r100 !== null) { sumRecall100 += r100; recall100Count += 1; }
  }

  const n = queryIds.length;
  return {
    queryCount: n,
    ndcgAt10: n > 0 ? sumNdcg10 / n : null,
    mapAt100: mapCount > 0 ? sumMap100 / mapCount : null,
    recallAt10: recall10Count > 0 ? sumRecall10 / recall10Count : null,
    recallAt100: recall100Count > 0 ? sumRecall100 / recall100Count : null,
    precisionAt10: n > 0 ? sumPrecision10 / n : null,
    mrrAt10: n > 0 ? sumMrr10 / n : null,
    skippedForRecallMap,
  };
}

/**
 * Parses a BEIR-format qrels TSV (`query-id\tcorpus-id\tscore`, header row
 * `query-id\tcorpus-id\tscore`) into the Map<queryId, Map<docId, relevance>>
 * shape every function above expects.
 * @param {string} tsvText
 * @returns {Map<string, Map<string, number>>}
 */
export function parseQrelsTsv(tsvText) {
  const qrels = new Map();
  const lines = tsvText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [qid, docId, scoreRaw] = trimmed.split('\t');
    if (qid === 'query-id' || qid === undefined || docId === undefined) continue; // header or malformed
    const score = Number(scoreRaw);
    if (!Number.isFinite(score)) continue;
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid).set(docId, score);
  }
  return qrels;
}

/**
 * Serializes a run to TREC run format:
 * `queryId Q0 docId rank score runTag`
 * (the standard 6-column format trec_eval and most external tooling expect).
 * @param {Map<string, Array<{ docId: string, score: number }>>} scoredRun
 * @param {string} runTag
 * @returns {string}
 */
export function toTrecRunFormat(scoredRun, runTag) {
  const lines = [];
  for (const [qid, docs] of scoredRun.entries()) {
    docs.forEach((d, i) => {
      lines.push(`${qid}\tQ0\t${d.docId}\t${i + 1}\t${d.score}\t${runTag}`);
    });
  }
  return lines.join('\n') + '\n';
}
