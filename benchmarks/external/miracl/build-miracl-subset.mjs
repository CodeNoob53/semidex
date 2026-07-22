// Deterministic MIRACL Russian ('ru') pooled retrieval subset builder.
//
// This is a GLOBAL 1000-passage retrieval corpus, not 100 separate
// per-query reranking pools — every selected query searches the same
// single collection built from this subset.
//
// Selection algorithm (fixed, deterministic, seeded — every step below is a
// pure function of the fetched dataset, so re-running this script on
// unchanged inputs always produces byte-identical output):
//   1. Select 100 of the 1252 dev queries via a canonical-sort +
//      SHA-256-seeded deterministic shuffle of ALL query IDs (identical
//      mechanism to benchmarks/external/beir/build-rrf-mini-set.mjs's
//      selectQueryIds() — sorting first makes the result independent of the
//      Map's insertion order, which itself just tracks qrels file row
//      order and would otherwise be an arbitrary, non-random stratum).
//   2. Union of every positive passage (qrels relevance > 0) referenced by
//      the selected queries.
//   3. Pad the corpus to exactly 1000 unique passages using MIRACL's own
//      ANNOTATED NEGATIVES — qrels rows with relevance = 0 for the selected
//      queries. These are human-annotated non-relevant passages, NOT
//      retrieval-mined "hard negatives" in the IR sense (see the module
//      header of fetch-miracl.mjs and the README's "Dataset contract"
//      section for the full citation trail — MIRACL publishes no
//      downloadable official baseline run to mine hard negatives from).
//      Selected round-robin across queries (one candidate per query per
//      round, queries in selection order, each query's own relevance=0
//      qrels rows in file order — there is no "rank" for annotated
//      negatives, unlike BEIR's TREC-run-based hard negatives, so the
//      round-robin dimension here is (query) only, not (query x source)).
//   4. If the annotated-negative pool cannot fill the corpus to exactly
//      1000 unique passages, the builder throws instead of running a
//      benchmark against a corpus smaller than the report would claim.
//
// Every qrels row in the subset is checked to reference a passage present
// in the subset corpus (verified, not assumed).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fetchAndValidateMiraclTopicsQrels, fetchCorpusPassages,
  MIRACL_TOPICS_QRELS_REVISION, MIRACL_CORPUS_REVISION,
} from './fetch-miracl.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, '.cache');
const SUBSET_DIR = resolve(CACHE_DIR, 'subsets');

export const SUBSET_QUERY_COUNT = 100;
export const SUBSET_CORPUS_SIZE = 1000;

// Fixed, published seed for the query-selection shuffle — same mechanism
// and same "why a seed, not a slice" rationale as the BEIR mini-set
// builder. Changing this string changes which 100 of 1252 queries are
// selected; it must never be derived from anything that varies run to run.
export const SELECTION_SHUFFLE_SEED = 'semidex-miracl-ru-pooled-subset-v1';
export const SUBSET_SCHEMA_VERSION = 1;

/** Deterministic counter-mode SHA-256 stream — identical mechanism to
 * benchmarks/external/beir/build-rrf-mini-set.mjs's sha256Stream(), kept
 * as a separate copy here rather than a cross-directory import so the
 * MIRACL harness has no dependency on the BEIR harness's internals (only
 * on the shared, directory-neutral harness-core.mjs, per the task's own
 * "do not duplicate Qdrant client/retry/redaction/ID-mapping code" scope —
 * this tiny seeded-shuffle primitive is below that bar and is intentionally
 * self-contained so each benchmark's selection logic can evolve
 * independently). */
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

/** Selects `count` query IDs deterministically, independent of the
 * caller's input array order (sorts to a canonical order first, THEN
 * shuffles — so the result depends only on the seed and the SET of IDs). */
export function selectQueryIds(allQueryIds, count, seed = SELECTION_SHUFFLE_SEED) {
  const canonical = [...allQueryIds].sort();
  return seededShuffle(canonical, seed).slice(0, count);
}

/**
 * Builds the deterministic subset SELECTION (query IDs, positive docids,
 * annotated-negative docids) from already-loaded topics/qrels. Does NOT
 * fetch passage text — that is a separate step (fetchCorpusPassages) since
 * text fetching requires streaming the multi-gigabyte corpus shards, which
 * this pure selection function must not depend on to stay unit-testable.
 */
export function selectSubsetDocIds({ queries, qrels, queryCount = SUBSET_QUERY_COUNT, corpusSize = SUBSET_CORPUS_SIZE, selectionSeed = SELECTION_SHUFFLE_SEED }) {
  const allQueryIds = [...queries.keys()];
  const selectedQueryIds = selectQueryIds(allQueryIds, queryCount, selectionSeed);

  const positiveDocIds = new Set();
  for (const qid of selectedQueryIds) {
    const qr = qrels.get(qid);
    if (!qr) continue;
    for (const [docId, rel] of qr.entries()) if (rel > 0) positiveDocIds.add(docId);
  }

  const subsetDocIds = new Set(positiveDocIds);

  // Round-robin annotated-negative padding: one candidate per query per
  // round, in selection order; each query's own relevance=0 rows in the
  // order qrels.get(qid) iterates them (Map insertion order = file row
  // order for that query, itself deterministic since qrels is parsed from
  // a static file). No "source"/"rank" dimension exists for these
  // annotated negatives (unlike BEIR's TREC-run-based hard negatives), so
  // round-robin here is purely across queries.
  const negativeListsByQuery = selectedQueryIds.map((qid) => {
    const qr = qrels.get(qid);
    if (!qr) return [];
    return [...qr.entries()].filter(([, rel]) => rel === 0).map(([docId]) => docId);
  });
  const cursors = new Array(selectedQueryIds.length).fill(0);
  let exhausted = false;
  let round = 0;
  const negativesAdded = [];
  while (subsetDocIds.size < corpusSize && !exhausted) {
    let anyCursorAdvanced = false;
    for (let qi = 0; qi < selectedQueryIds.length; qi++) {
      if (subsetDocIds.size >= corpusSize) break;
      const list = negativeListsByQuery[qi];
      const cursor = cursors[qi];
      if (cursor >= list.length) continue;
      const candidate = list[cursor];
      cursors[qi] += 1;
      anyCursorAdvanced = true;
      if (subsetDocIds.has(candidate)) continue; // already positive or already added
      subsetDocIds.add(candidate);
      negativesAdded.push({ docId: candidate, fromQueryId: selectedQueryIds[qi], round });
    }
    round += 1;
    if (!anyCursorAdvanced) exhausted = true;
  }

  const shortfall = Math.max(0, corpusSize - subsetDocIds.size);

  // Qrels are scoped to docids actually present in the subset corpus.
  // The full per-query qrels can reference MORE docids than the round-robin
  // padding selected (only some of a query's negatives make it into the
  // fixed 1000-passage corpus) — keeping those extra rows would create
  // exactly the dangling-qrels condition the task requires rejecting.
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
    selectedQueryIds,
    subsetDocIds: [...subsetDocIds],
    subsetQueries,
    subsetQrels,
    stats: {
      selectedQueryCount: selectedQueryIds.length,
      positiveDocCount: positiveDocIds.size,
      negativeDocCount: negativesAdded.length,
      totalCorpusSize: subsetDocIds.size,
      requestedCorpusSize: corpusSize,
      shortfall,
    },
  };
}

/** Full subset: selection + fetched passage text + validated invariants. */
export function assembleSubset({ selection, corpusPassages }) {
  const missingText = [];
  const corpus = new Map();
  for (const docId of selection.subsetDocIds) {
    const passage = corpusPassages.get(docId);
    if (!passage) { missingText.push(docId); continue; }
    corpus.set(docId, passage);
  }

  const danglingQrelsRefs = [];
  for (const [qid, docsMap] of selection.subsetQrels.entries()) {
    for (const docId of docsMap.keys()) {
      if (!corpus.has(docId)) danglingQrelsRefs.push({ qid, docId });
    }
  }

  return {
    corpus,
    queries: selection.subsetQueries,
    qrels: selection.subsetQrels,
    stats: {
      ...selection.stats,
      missingPassageTextCount: missingText.length,
      missingPassageTextSamples: missingText.slice(0, 5),
      danglingQrelsRefs,
    },
  };
}

/** Revalidates both freshly built and cached subsets — mirrors
 * build-rrf-mini-set.mjs's validateMiniSet(): a cache manifest proves which
 * inputs produced a file, not that the file is complete/unedited. */
export function validateSubset(subset, { queryCount = SUBSET_QUERY_COUNT, corpusSize = SUBSET_CORPUS_SIZE } = {}) {
  const errors = [];
  if (!(subset?.corpus instanceof Map)) errors.push('corpus is not a Map');
  if (!(subset?.queries instanceof Map)) errors.push('queries is not a Map');
  if (!(subset?.qrels instanceof Map)) errors.push('qrels is not a Map');
  if (!subset?.stats || typeof subset.stats !== 'object') errors.push('stats are missing');
  if (errors.length > 0) return errors;

  if (subset.corpus.size !== corpusSize) errors.push(`corpus size is ${subset.corpus.size}, expected ${corpusSize}`);
  if (subset.queries.size !== queryCount) errors.push(`query count is ${subset.queries.size}, expected ${queryCount}`);
  if (subset.stats.totalCorpusSize !== corpusSize) errors.push(`stats.totalCorpusSize is ${subset.stats.totalCorpusSize}, expected ${corpusSize}`);
  if (subset.stats.shortfall !== 0) errors.push(`corpus shortfall is ${subset.stats.shortfall}`);
  if ((subset.stats.missingPassageTextCount ?? 0) !== 0) errors.push(`${subset.stats.missingPassageTextCount} selected docids have no fetched passage text`);
  if ((subset.stats.danglingQrelsRefs?.length ?? 0) !== 0) errors.push(`${subset.stats.danglingQrelsRefs.length} qrels rows reference documents absent from the subset corpus`);

  // Every selected query must have qrels AND at least one relevant
  // (relevance > 0) passage. A query with no positives would make
  // nDCG/Recall/MAP silently undefined for it downstream (metrics.mjs
  // treats a zero-relevant query as excluded from Recall/MAP averages,
  // not as an error) — catching it here, before any Qdrant call, is what
  // prevents an ACCEPT verdict built on a benchmark that quietly measured
  // fewer than the claimed 100 "real" queries.
  if (subset.qrels.size !== subset.queries.size) {
    errors.push(`qrels cover ${subset.qrels.size} queries but ${subset.queries.size} were selected — every selected query must have qrels`);
  }
  for (const qid of subset.queries.keys()) {
    const docsMap = subset.qrels.get(qid);
    if (!docsMap || docsMap.size === 0) {
      errors.push(`query ${qid} has no qrels at all in the subset`);
      continue;
    }
    const hasPositive = [...docsMap.values()].some((rel) => rel > 0);
    if (!hasPositive) errors.push(`query ${qid} has no positive (relevance > 0) passage in the subset`);
  }

  let danglingCount = 0;
  for (const [qid, docsMap] of subset.qrels) {
    if (!subset.queries.has(qid)) errors.push(`qrels contain unselected query ${qid}`);
    for (const docId of docsMap.keys()) if (!subset.corpus.has(docId)) danglingCount += 1;
  }
  if (danglingCount > 0 && (subset.stats.danglingQrelsRefs?.length ?? 0) === 0) {
    errors.push(`${danglingCount} qrels rows reference documents absent from the subset corpus (not reflected in stats)`);
  }

  return errors;
}

function digest(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

export function subsetCachePath({ topicsQrelsRevision, corpusRevision, queryCount, corpusSize, selectionSeed }) {
  mkdirSync(SUBSET_DIR, { recursive: true });
  const key = digest({
    schemaVersion: SUBSET_SCHEMA_VERSION, topicsQrelsRevision, corpusRevision, queryCount, corpusSize, selectionSeed,
  });
  return resolve(SUBSET_DIR, `miracl-ru-subset-${key}.json`);
}

function serializeSubset(subset, manifest) {
  return {
    manifest,
    corpus: [...subset.corpus.entries()],
    queries: [...subset.queries.entries()],
    qrels: [...subset.qrels.entries()].map(([qid, docsMap]) => [qid, [...docsMap.entries()]]),
    stats: subset.stats,
  };
}

function deserializeSubset(raw) {
  return {
    corpus: new Map(raw.corpus),
    queries: new Map(raw.queries),
    qrels: new Map(raw.qrels.map(([qid, entries]) => [qid, new Map(entries)])),
    stats: raw.stats,
  };
}

function sameManifest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Full pipeline: fetch+validate topics/qrels, select the deterministic
 * query/docid subset, fetch exactly the needed passage text from the
 * corpus shards, assemble + validate, and cache. Throws on any shortfall,
 * missing passage text, or dangling qrels reference — all fatal, matching
 * the task's explicit "fail if the official pool cannot provide 1000
 * unique passages" / "reject dangling qrels" requirements. */
export async function buildAndCacheMiraclSubset({ log = () => {}, trackRss = () => {}, useCache = true } = {}) {
  const { queries, qrels } = await fetchAndValidateMiraclTopicsQrels({ log });

  const manifest = {
    schemaVersion: SUBSET_SCHEMA_VERSION,
    topicsQrelsRevision: MIRACL_TOPICS_QRELS_REVISION,
    corpusRevision: MIRACL_CORPUS_REVISION,
    queryCount: SUBSET_QUERY_COUNT,
    corpusSize: SUBSET_CORPUS_SIZE,
    selectionSeed: SELECTION_SHUFFLE_SEED,
  };
  const cachePath = subsetCachePath({
    topicsQrelsRevision: MIRACL_TOPICS_QRELS_REVISION, corpusRevision: MIRACL_CORPUS_REVISION,
    queryCount: SUBSET_QUERY_COUNT, corpusSize: SUBSET_CORPUS_SIZE, selectionSeed: SELECTION_SHUFFLE_SEED,
  });

  if (useCache && existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
      if (raw.manifest && sameManifest(raw.manifest, manifest)) {
        const cached = deserializeSubset(raw);
        const validationErrors = validateSubset(cached);
        if (validationErrors.length === 0) {
          log(`[build-miracl-subset] cache hit: ${cachePath}`);
          return { ...cached, cachePath, fromCache: true, manifest: raw.manifest };
        }
        log(`[build-miracl-subset] cache failed validation (${validationErrors.join('; ')}) — rebuilding`);
      } else {
        log('[build-miracl-subset] cache file present but manifest mismatch — rebuilding');
      }
    } catch { /* fall through to build */ }
  }

  const selection = selectSubsetDocIds({ queries, qrels });
  if (selection.stats.shortfall > 0) {
    throw new Error(`[build-miracl-subset] annotated-negative pool exhausted before reaching the target corpus size (${selection.stats.totalCorpusSize}/${selection.stats.requestedCorpusSize}, shortfall ${selection.stats.shortfall}) — refusing to run a benchmark on a corpus smaller than the report would claim.`);
  }
  log(`[build-miracl-subset] selected ${selection.stats.selectedQueryCount} queries, ${selection.stats.positiveDocCount} positives, ${selection.stats.negativeDocCount} annotated negatives, ${selection.stats.totalCorpusSize} total docids`);

  log(`[build-miracl-subset] fetching passage text for ${selection.subsetDocIds.length} docids from the corpus shards...`);
  const corpusPassages = await fetchCorpusPassages(selection.subsetDocIds, { log, trackRss });

  const subset = assembleSubset({ selection, corpusPassages });
  const validationErrors = validateSubset(subset);
  if (validationErrors.length > 0) {
    throw new Error(`[build-miracl-subset] invalid subset: ${validationErrors.join('; ')} — refusing to run the benchmark`);
  }

  writeFileSync(cachePath, JSON.stringify(serializeSubset(subset, manifest)), 'utf-8');
  log(`[build-miracl-subset] cache written: ${cachePath}`);

  return { ...subset, cachePath, fromCache: false, manifest };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const subset = await buildAndCacheMiraclSubset({ log: (m) => console.log(m) });
    console.log(JSON.stringify(subset.stats, null, 2));
    process.exitCode = subset.stats.shortfall > 0 || subset.stats.danglingQrelsRefs.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
