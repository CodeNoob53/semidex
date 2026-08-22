// Pure calculation/reporting logic for the graph-expanded-retrieval live A/B
// benchmark (docs/tasks/graph-expanded-retrieval-live-benchmark.md). No I/O,
// no Qdrant, no network — every function here takes plain hit arrays (as
// returned by src/core/retrieval/search.js's runHybridSearch()) and a qrels
// entry (benchmarks/graph-expand-retrieval/qrels.json) and returns plain
// data. Kept separate from run-live.mjs so it can be covered by fast offline
// unit tests without a live Qdrant instance.

/**
 * Deterministic identity key for a hit or a qrels relevance entry — the same
 * (sourceFile, chunkIndex) pair both use. Never nodeId: qrels are authored
 * against the fixture's stable sourceFile/chunkIndex, which the offline
 * skeleton-chunker dry run confirmed maps deterministically onto the fixture
 * text (see qrels.json's own header comment).
 * @param {{ sourceFile: string, chunkIndex: number }} entry
 */
export function hitKey(entry) {
  return `${entry.sourceFile}::${entry.chunkIndex}`;
}

/**
 * @param {{ relevant?: Array<{sourceFile:string, chunkIndex:number}> }} qrelsEntry
 * @returns {Set<string>}
 */
export function relevantKeySet(qrelsEntry) {
  return new Set((qrelsEntry?.relevant ?? []).map(hitKey));
}

/**
 * @param {{ irrelevant?: Array<{sourceFile:string, chunkIndex:number}> }} qrelsEntry
 * @returns {Set<string>}
 */
export function irrelevantKeySet(qrelsEntry) {
  return new Set((qrelsEntry?.irrelevant ?? []).map(hitKey));
}

function topKeys(hits, k) {
  return hits.slice(0, k).map(hitKey);
}

/**
 * Recall@k: fraction of qrels-relevant items present anywhere in the top-k
 * hits. Returns null ("n/a") when the query has no relevant items at all
 * (a negative query) — recall is undefined, not zero, for such a query.
 */
export function recallAtK(hits, relevantKeys, k) {
  if (relevantKeys.size === 0) return null;
  const top = new Set(topKeys(hits, k));
  let found = 0;
  for (const key of relevantKeys) if (top.has(key)) found++;
  return found / relevantKeys.size;
}

/**
 * Mean-reciprocal-rank contribution for one query: 1/(rank+1) of the first
 * relevant hit, 0 if none of the returned hits are relevant. null when the
 * query has no relevant items (negative query).
 */
export function mrrValue(hits, relevantKeys) {
  if (relevantKeys.size === 0) return null;
  const idx = hits.findIndex((h) => relevantKeys.has(hitKey(h)));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

/**
 * nDCG@k with binary relevance (1 if the hit's key is in relevantKeys, else
 * 0) — the same formula benchmarks/retrieval/run.js's own ndcg() uses,
 * reimplemented here (not imported) because that module is a CLI script with
 * side effects at import time, not an importable pure library; this keeps
 * the two independent so a scientific formula-level bug here can't inherit
 * from, or reintroduce, a bug in the unrelated file-level benchmark.
 * null when the query has no relevant items (negative query).
 */
export function ndcgAtK(hits, relevantKeys, k) {
  if (relevantKeys.size === 0) return null;
  const top = hits.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    if (relevantKeys.has(hitKey(top[i]))) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(relevantKeys.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Qrels-relevant items present in modeB's top-k but ABSENT from modeA's
 * top-k — i.e. content graph expansion recovered that seed-only hybrid
 * search (bounded to the same final `top`) missed entirely. This is the
 * evaluation gate's core claim (design doc item 3) measured against a real
 * A/B run instead of assumed.
 */
export function recoveredByGraph(hitsA, hitsB, relevantKeys, k) {
  const inA = new Set(topKeys(hitsA, k));
  const inB = new Set(topKeys(hitsB, k));
  const recovered = [];
  for (const key of relevantKeys) {
    if (inB.has(key) && !inA.has(key)) recovered.push(key);
  }
  return recovered;
}

/**
 * Keys present in modeA's top-k but absent from modeB's top-k, restricted to
 * keys that were a 'seed'-origin hit in A (a real, directly-retrieved hybrid
 * hit, never a graph candidate — modeA never has graph-origin hits by
 * construction) AND where modeB's top-k contains at least one 'graph'-origin
 * hit (so the displacement is attributable to graph candidates entering the
 * result, not to ordinary run-to-run hybrid-search nondeterminism). This is
 * the design doc's documented "Known ranking-order tradeoff" — measured
 * generically for ANY query, not asserted only for the one query the fixture
 * was designed to make most plausible (q1).
 */
export function displacedSeeds(hitsA, hitsB, k) {
  const seedKeysInA = new Set(
    hitsA.slice(0, k).filter((h) => (h.retrievalOrigin ?? 'seed') === 'seed').map(hitKey),
  );
  const keysInB = new Set(topKeys(hitsB, k));
  const bHasGraphOrigin = hitsB.slice(0, k).some((h) => h.retrievalOrigin === 'graph');
  if (!bHasGraphOrigin) return [];
  const displaced = [];
  for (const key of seedKeysInA) {
    if (!keysInB.has(key)) displaced.push(key);
  }
  return displaced;
}

/**
 * Hits (in either mode) whose sourceFile/tags disagree with the query's own
 * filters — "expansion respects caller filters" (design doc, Safety and
 * correctness invariants). Empty array means full compliance.
 */
export function filterViolations(hits, filters) {
  const violations = [];
  for (const h of hits) {
    if (filters?.sourceFile && h.sourceFile !== filters.sourceFile) {
      violations.push({ key: hitKey(h), reason: `sourceFile "${h.sourceFile}" !== filter "${filters.sourceFile}"` });
      continue;
    }
    if (filters?.tags?.length && !filters.tags.some((t) => h.tags?.includes(t))) {
      violations.push({ key: hitKey(h), reason: `tags ${JSON.stringify(h.tags ?? [])} do not include any of ${JSON.stringify(filters.tags)}` });
    }
  }
  return violations;
}

/**
 * Qrels-irrelevant items (explicitly authored, not merely "unlisted") that
 * a mode placed in its top-k anyway — never itself a failure (a structural
 * neighbor CAN legitimately outrank nothing), but tracked so the report can
 * show whether graph expansion specifically is what surfaced known-irrelevant
 * structural neighbors (case 3 of the task's required fixture cases).
 */
export function irrelevantSurfaced(hits, irrelevantKeys, k) {
  return topKeys(hits, k).filter((key) => irrelevantKeys.has(key));
}

function median(sortedNums) {
  if (!sortedNums.length) return 0;
  const mid = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 === 0 ? (sortedNums[mid - 1] + sortedNums[mid]) / 2 : sortedNums[mid];
}

function percentile(sortedNums, p) {
  if (!sortedNums.length) return 0;
  const idx = Math.ceil((sortedNums.length * p) / 100) - 1;
  return sortedNums[Math.max(0, idx)];
}

/**
 * @param {number[]} samplesMs — repeated timed-sample latencies for one query+mode
 * @returns {{ medianMs: number, p95Ms: number, minMs: number, maxMs: number, n: number }}
 */
export function latencyStats(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    medianMs: median(sorted),
    p95Ms: percentile(sorted, 95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    n: sorted.length,
  };
}

/**
 * Two hit arrays are "deterministic across repeated runs" (required
 * analysis item 4) when they carry the exact same ranked key sequence.
 */
export function sameRankedKeys(hitsA, hitsB) {
  const a = hitsA.map(hitKey);
  const b = hitsB.map(hitKey);
  if (a.length !== b.length) return false;
  return a.every((k, i) => k === b[i]);
}

/**
 * Byte-for-byte feature-off parity check (design doc, evaluation gate item
 * 2 / "Step 2 ... return the byte-for-byte compatible result"): every hit
 * modeA (GRAPH_EXPANSION_ENABLED=false) returns must carry no provenance
 * fields at all.
 */
export function hasNoProvenanceFields(hits) {
  return hits.every((h) =>
    !('retrievalOrigin' in h) && !('graphSeedRank' in h) && !('graphSeedId' in h) &&
    !('graphRelationPath' in h) && !('graphDepth' in h));
}

/**
 * Full per-query analysis bundle, combining every metric above. Pure: takes
 * already-retrieved hit arrays for both modes plus the query's qrels entry
 * and filters; returns one plain object suitable for JSON serialization and
 * for driving the Markdown report table.
 *
 * @param {{
 *   queryId: string,
 *   hitsA: Object[], hitsB: Object[],
 *   qrelsEntry: Object, filters: Object, k: number,
 * }} opts
 */
export function analyzeQuery({ queryId, hitsA, hitsB, qrelsEntry, filters, k }) {
  const relevantKeys = relevantKeySet(qrelsEntry);
  const irrelevantKeys = irrelevantKeySet(qrelsEntry);
  const isNegative = qrelsEntry?.negative === true;

  return {
    queryId,
    isNegative,
    k,
    modeA: {
      recallAtK: recallAtK(hitsA, relevantKeys, k),
      mrr: mrrValue(hitsA, relevantKeys),
      ndcgAtK: ndcgAtK(hitsA, relevantKeys, k),
      rankedKeys: topKeys(hitsA, k),
      filterViolations: filterViolations(hitsA.slice(0, k), filters),
      irrelevantSurfaced: irrelevantSurfaced(hitsA, irrelevantKeys, k),
      noProvenanceFields: hasNoProvenanceFields(hitsA),
    },
    modeB: {
      recallAtK: recallAtK(hitsB, relevantKeys, k),
      mrr: mrrValue(hitsB, relevantKeys),
      ndcgAtK: ndcgAtK(hitsB, relevantKeys, k),
      rankedKeys: topKeys(hitsB, k),
      filterViolations: filterViolations(hitsB.slice(0, k), filters),
      irrelevantSurfaced: irrelevantSurfaced(hitsB, irrelevantKeys, k),
      graphOriginCount: hitsB.slice(0, k).filter((h) => h.retrievalOrigin === 'graph').length,
    },
    recoveredByGraph: recoveredByGraph(hitsA, hitsB, relevantKeys, k),
    displacedSeeds: displacedSeeds(hitsA, hitsB, k),
  };
}
