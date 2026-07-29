// Deterministic SciFact PILOT subset — used ONLY to produce a
// representative runtime/request-volume estimate before the full run
// (never the final report itself). Mirrors
// benchmarks/external/miracl/build-miracl-subset.mjs's own construction
// discipline (seeded shuffle, positives-first, round-robin padding,
// hard-fail on shortfall, content-hash cache) applied to SciFact.
//
// NAMING: the padding documents are DETERMINISTIC UNJUDGED NEGATIVES, not
// "hard negatives" — a real hard negative would be a top-ranked-but-non-
// relevant document mined from an actual retrieval run, which requires a
// baseline run to mine from. These are simply corpus documents NOT judged
// relevant for a given query, drawn deterministically in corpus order —
// sufficient for a TIMING pilot, not a difficulty-calibrated eval set.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, '../.cache/pilot-subset');

export const PILOT_SEED = 'semidex-prodpath-scifact-pilot-v1';
export const PILOT_QUERY_COUNT = 25;
export const PILOT_CORPUS_SIZE = 150;
export const PILOT_SCHEMA_VERSION = 1;

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

export function seededShuffle(items, seed) {
  const arr = [...items];
  const stream = sha256Stream(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const rand = stream.next().value / 0x100000000;
    const j = Math.floor(rand * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Builds the deterministic SciFact pilot subset from an already-loaded
 * full dataset ({corpus, queries, qrels} — see fetch-scifact.mjs's
 * loadDataset()). Pure function, no I/O.
 *
 * 1. Deterministic query selection: sort all test-query IDs, seeded
 *    Fisher-Yates shuffle, take the first PILOT_QUERY_COUNT.
 * 2. Positives: union of every corpus doc referenced by the selected
 *    queries' qrels — ALL of them included, never subsampled.
 * 3. Pad to PILOT_CORPUS_SIZE with deterministic unjudged negatives,
 *    round-robin across the selected queries, drawn from the FULL corpus
 *    in canonical (sorted) doc-ID order per query, skipping any doc
 *    already in the subset (positive or already-added negative).
 * 4. Hard-fail if the corpus can't be padded to PILOT_CORPUS_SIZE.
 * 5. Rescope qrels to only reference docs actually in the final subset.
 */
export function buildScifactPilotSubset({ corpus, queries, qrels }) {
  const allQueryIds = [...queries.keys()].sort();
  const selectedQueryIds = seededShuffle(allQueryIds, PILOT_SEED).slice(0, PILOT_QUERY_COUNT);

  const positiveDocIds = new Set();
  for (const qid of selectedQueryIds) {
    const qr = qrels.get(qid);
    if (!qr) continue;
    for (const [docId, rel] of qr.entries()) if (rel > 0) positiveDocIds.add(docId);
  }

  const subsetDocIds = new Set(positiveDocIds);

  // Round-robin unjudged-negative padding: one candidate per query per
  // round, each query's own candidate list is the FULL corpus in
  // canonical sorted order, minus that query's own positives (a doc
  // relevant to query A but not judged for query B could otherwise be
  // picked as "B's negative" while still being a real positive overall —
  // excluding every SELECTED query's positives from every candidate list
  // keeps the padding honestly unjudged-for-the-subset, not just
  // unjudged-for-one-query).
  const allDocIdsSorted = [...corpus.keys()].sort();
  const candidateLists = selectedQueryIds.map(() => allDocIdsSorted.filter((docId) => !positiveDocIds.has(docId)));
  const cursors = new Array(selectedQueryIds.length).fill(0);
  let round = 0;
  let exhausted = false;
  while (subsetDocIds.size < PILOT_CORPUS_SIZE && !exhausted) {
    let anyCursorAdvanced = false;
    for (let qi = 0; qi < selectedQueryIds.length; qi++) {
      if (subsetDocIds.size >= PILOT_CORPUS_SIZE) break;
      const list = candidateLists[qi];
      const cursor = cursors[qi];
      if (cursor >= list.length) continue;
      const candidate = list[cursor];
      cursors[qi] += 1;
      anyCursorAdvanced = true;
      if (subsetDocIds.has(candidate)) continue;
      subsetDocIds.add(candidate);
    }
    round += 1;
    if (!anyCursorAdvanced) exhausted = true;
  }

  const shortfall = Math.max(0, PILOT_CORPUS_SIZE - subsetDocIds.size);
  if (shortfall > 0) {
    throw new Error(`buildScifactPilotSubset: could not reach the required pilot corpus size (${PILOT_CORPUS_SIZE}) — short by ${shortfall}. The full SciFact corpus may be smaller than expected.`);
  }

  const subsetCorpus = new Map();
  for (const docId of subsetDocIds) {
    const doc = corpus.get(docId);
    if (doc) subsetCorpus.set(docId, doc);
  }

  const subsetQueries = new Map(selectedQueryIds.map((qid) => [qid, queries.get(qid)]));
  const subsetQrels = new Map();
  for (const qid of selectedQueryIds) {
    const qr = qrels.get(qid);
    if (!qr) continue;
    const scoped = new Map();
    for (const [docId, rel] of qr.entries()) {
      if (subsetDocIds.has(docId)) scoped.set(docId, rel);
    }
    if (scoped.size > 0) subsetQrels.set(qid, scoped);
  }

  return {
    corpus: subsetCorpus,
    queries: subsetQueries,
    qrels: subsetQrels,
    fingerprint: pilotFingerprint(),
  };
}

/** Content-hash fingerprint of the pilot's own construction parameters —
 * recorded into the checkpoint's benchmarkContract so a resume rejects if
 * this pilot's own construction ever changes underneath it. Does NOT
 * depend on dataset content — use datasetAwarePilotFingerprint() below
 * for the cache-key/collision-safety concern (two different underlying
 * datasets must never share a cache file just because the pilot's own
 * seed/size constants happen to match). */
export function pilotFingerprint() {
  return createHash('sha256')
    .update(JSON.stringify({ PILOT_SEED, PILOT_QUERY_COUNT, PILOT_CORPUS_SIZE, PILOT_SCHEMA_VERSION }))
    .digest('hex')
    .slice(0, 16);
}

/** Cache-key fingerprint — incorporates BOTH the pilot's own construction
 * parameters AND a content signature of the input dataset (corpus/query
 * ID sets), so two different underlying datasets (e.g. a real SciFact
 * fetch vs. a test's synthetic dataset, or SciFact after a future
 * re-release) can never collide on the same cache filename despite
 * identical PILOT_SEED/PILOT_QUERY_COUNT/PILOT_CORPUS_SIZE constants. */
export function datasetAwarePilotFingerprint({ corpus, queries }) {
  const datasetSignature = createHash('sha256')
    .update(JSON.stringify({ corpusSize: corpus.size, queryCount: queries.size, firstQueryIds: [...queries.keys()].sort().slice(0, 5) }))
    .digest('hex')
    .slice(0, 16);
  return createHash('sha256')
    .update(`${pilotFingerprint()}:${datasetSignature}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Validates the pilot subset's structural invariants — mirrors
 * build-miracl-subset.mjs's own validateSubset(): exact corpus/query
 * counts, zero shortfall, zero missing passage text, zero dangling
 * qrels, every selected query has >=1 positive (else Recall/nDCG are
 * undefined for it).
 * @returns {string[]} errors — empty array means valid
 */
export function validatePilotSubset(subset) {
  const errors = [];
  if (!(subset?.corpus instanceof Map)) { errors.push('corpus is not a Map'); return errors; }
  if (!(subset?.queries instanceof Map)) { errors.push('queries is not a Map'); return errors; }
  if (!(subset?.qrels instanceof Map)) { errors.push('qrels is not a Map'); return errors; }

  if (subset.corpus.size !== PILOT_CORPUS_SIZE) {
    errors.push(`corpus size is ${subset.corpus.size}, expected ${PILOT_CORPUS_SIZE}`);
  }
  if (subset.queries.size !== PILOT_QUERY_COUNT) {
    errors.push(`query count is ${subset.queries.size}, expected ${PILOT_QUERY_COUNT}`);
  }
  for (const [docId, doc] of subset.corpus.entries()) {
    if (!doc || (!doc.text && !doc.title)) errors.push(`corpus doc "${docId}" has no text/title`);
  }
  for (const qid of subset.queries.keys()) {
    const qr = subset.qrels.get(qid);
    if (!qr || qr.size === 0) {
      errors.push(`query "${qid}" has no qrels — Recall/nDCG would be undefined for it`);
      continue;
    }
    let hasPositive = false;
    for (const rel of qr.values()) if (rel > 0) hasPositive = true;
    if (!hasPositive) errors.push(`query "${qid}" has qrels but no positive (relevant) document`);
  }
  for (const [qid, qr] of subset.qrels.entries()) {
    for (const docId of qr.keys()) {
      if (!subset.corpus.has(docId)) errors.push(`dangling qrels reference: query "${qid}" -> doc "${docId}" not in subset corpus`);
    }
  }
  return errors;
}

function subsetCachePath(fullDataset) {
  return resolve(CACHE_DIR, `scifact-pilot-${datasetAwarePilotFingerprint(fullDataset)}.json`);
}

function serializeSubset(subset) {
  return JSON.stringify({
    fingerprint: subset.fingerprint,
    corpus: [...subset.corpus.entries()],
    queries: [...subset.queries.entries()],
    qrels: [...subset.qrels.entries()].map(([qid, qr]) => [qid, [...qr.entries()]]),
  });
}

function deserializeSubset(json) {
  const raw = JSON.parse(json);
  return {
    fingerprint: raw.fingerprint,
    corpus: new Map(raw.corpus),
    queries: new Map(raw.queries),
    qrels: new Map(raw.qrels.map(([qid, entries]) => [qid, new Map(entries)])),
  };
}

/** Builds (or loads from cache) the pilot subset, validates it, and
 * persists it for reuse across runs — same content-hash-keyed cache
 * convention as build-miracl-subset.mjs. The cache key incorporates the
 * INPUT dataset's own identity (datasetAwarePilotFingerprint), so a
 * synthetic test dataset and the real fetched SciFact corpus never
 * collide on the same cache file despite identical PILOT_SEED/
 * PILOT_QUERY_COUNT/PILOT_CORPUS_SIZE constants. */
export function buildAndCachePilotSubset(fullDataset) {
  const cachePath = subsetCachePath(fullDataset);
  if (existsSync(cachePath)) {
    const cached = deserializeSubset(readFileSync(cachePath, 'utf-8'));
    const errors = validatePilotSubset(cached);
    if (errors.length === 0) return cached;
    // Cached file failed validation (corrupted/stale) — rebuild below.
  }
  const subset = buildScifactPilotSubset(fullDataset);
  const errors = validatePilotSubset(subset);
  if (errors.length > 0) {
    throw new Error(`buildAndCachePilotSubset: freshly built pilot subset failed validation:\n${errors.join('\n')}`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, serializeSubset(subset), 'utf-8');
  return subset;
}

/** Strictly offline loader — never builds. Still requires the SAME
 * dataset identity info (corpus/query sizes + first few query IDs) used
 * to build the cache key originally, since the cache key is now dataset-
 * aware — pass the same fullDataset (or a dataset with an identical
 * signature) used when the subset was first cached. */
export function loadCachedPilotSubset(fullDataset) {
  const cachePath = subsetCachePath(fullDataset);
  if (!existsSync(cachePath)) return null;
  return deserializeSubset(readFileSync(cachePath, 'utf-8'));
}
