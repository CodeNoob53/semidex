// One-time, provider-neutral input preparation shared by external retrieval benchmarks.
// Model-specific prefixes are applied later, at the embedding lane boundary.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ONNX_CACHE_DIR, ONNX_DENSE_MODEL_ID } from '../../../src/core/onnx-paths.js';
import { E5_MODEL_ID, E5_PREFIX, COMMON_REGIME_TOKEN_BUDGET } from './profiles.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = resolve(__dirname, '.cache');
export const PREPARED_CACHE_DIR = resolve(CACHE_DIR, 'prepared');
export const TOKENIZER_BATCH_SIZE = 256;
export const PREP_SCHEMA_VERSION = 8;

let bgeTokenizerPromise;
let e5TokenizerPromise;
let autoTokenizerPromise;

function releaseTokenizerReferences() {
  bgeTokenizerPromise = undefined;
  e5TokenizerPromise = undefined;
}

async function getAutoTokenizer() {
  autoTokenizerPromise ??= import('@huggingface/transformers')
    .then(({ AutoTokenizer }) => AutoTokenizer);
  return autoTokenizerPromise;
}

async function getBgeTokenizer() {
  const AutoTokenizer = await getAutoTokenizer();
  bgeTokenizerPromise ??= AutoTokenizer.from_pretrained(ONNX_DENSE_MODEL_ID, {
    cache_dir: ONNX_CACHE_DIR,
  });
  return bgeTokenizerPromise;
}

async function getE5Tokenizer() {
  const AutoTokenizer = await getAutoTokenizer();
  e5TokenizerPromise ??= AutoTokenizer.from_pretrained(E5_MODEL_ID, {
    cache_dir: ONNX_CACHE_DIR,
  });
  return e5TokenizerPromise;
}

function rowTokenCounts(encoding, budget, { ambiguousAtBudget = false } = {}) {
  const [rows, columns] = encoding.attention_mask.dims;
  const mask = encoding.attention_mask.data;
  const counts = new Array(rows);
  for (let row = 0; row < rows; row++) {
    let count = 0;
    for (let column = 0; column < columns; column++) {
      count += Number(mask[row * columns + column]);
    }
    counts[row] = ambiguousAtBudget && count >= budget
      ? budget + 1
      : Math.min(count, budget + 1);
  }
  return counts;
}

/**
 * Counts only up to budget + 1. The sentinel value proves an input is too
 * long without allocating tensors proportional to the complete document.
 */
async function boundedBatchTokenInfo(
  tokenizer,
  texts,
  {
    budget = COMMON_REGIME_TOKEN_BUDGET,
    batchSize = TOKENIZER_BATCH_SIZE,
    onProgress = () => {},
    captureDecodedWordCounts = false,
    ambiguousAtBudget = false,
  } = {},
) {
  const counts = [];
  const decodedWordCounts = new Array(texts.length).fill(null);
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    const encoding = await tokenizer(batch, {
      padding: true,
      truncation: true,
      max_length: budget + 1,
    });
    const batchCounts = rowTokenCounts(encoding, budget, { ambiguousAtBudget });
    counts.push(...batchCounts);
    if (captureDecodedWordCounts) {
      const [, columns] = encoding.input_ids.dims;
      const ids = encoding.input_ids.data;
      for (let row = 0; row < batch.length; row++) {
        if (batchCounts[row] <= budget) continue;
        const start = row * columns;
        const rowIds = Array.from(ids.slice(start, start + Math.min(columns, budget)), Number);
        const decoded = tokenizer.decode(rowIds, { skip_special_tokens: true });
        decodedWordCounts[offset + row] = decoded.trim() ? decoded.trim().split(/\s+/).length : 0;
      }
    }
    onProgress(Math.min(offset + batch.length, texts.length), texts.length);
  }
  return { counts, decodedWordCounts };
}

export async function boundedBatchTokenCounts(tokenizer, texts, options = {}) {
  return (await boundedBatchTokenInfo(tokenizer, texts, options)).counts;
}

function nativeDocumentBody(doc) {
  const title = doc.title ?? '';
  const text = doc.body ?? doc.text ?? '';
  return title ? `${title}\n\n${text}` : text;
}

/** Pure word-boundary search used by the real tokenizer path and unit tests. */
export async function largestFittingWordPrefix({ title = '', body = '', fits }) {
  const words = body.trim() ? body.trim().split(/\s+/) : [];
  const build = (wordCount) => {
    const prefix = words.slice(0, wordCount).join(' ');
    return title ? `${title}\n\n${prefix}` : prefix;
  };

  let low = 0;
  let high = words.length;
  let best = build(0);
  let bestCounts = { bgeCount: 0, e5Count: 0 };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = build(middle);
    const result = await fits(candidate);
    if (result.ok) {
      best = candidate;
      bestCounts = result;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { commonBody: best, ...bestCounts };
}

function buildWordPrefix(state, wordCount) {
  const prefix = state.words.slice(0, wordCount).join(' ');
  return state.title ? `${state.title}\n\n${prefix}` : prefix;
}

function wordCount(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function commonCandidateWordCount({
  totalWords,
  headerWords,
  prefixWords,
  bgeDecodedWords,
  e5DecodedWords,
}) {
  const bgeEstimate = bgeDecodedWords == null ? totalWords : bgeDecodedWords - headerWords;
  const e5Estimate = e5DecodedWords == null
    ? totalWords
    : e5DecodedWords - headerWords - prefixWords;
  return Math.max(0, Math.min(totalWords, bgeEstimate, e5Estimate) - 2);
}

async function truncateOverflowBatch(
  docs,
  overflowIndexes,
  { e5Prefix, budget, bge, e5, bgeDecodedWords, e5DecodedWords, log, trackRss },
) {
  const states = overflowIndexes.map((index) => {
    const doc = docs[index];
    const words = doc.body.trim() ? doc.body.trim().split(/\s+/) : [];
    const headerWords = wordCount(doc.title);
    return {
      index,
      title: doc.title,
      words,
      candidateWords: commonCandidateWordCount({
        totalWords: words.length,
        headerWords,
        prefixWords: wordCount(e5Prefix),
        bgeDecodedWords: bgeDecodedWords[index],
        e5DecodedWords: e5DecodedWords[index],
      }),
      best: null,
    };
  });

  let round = 0;
  while (true) {
    const active = states.filter((state) => state.best === null);
    if (active.length === 0) break;
    round += 1;
    const candidates = active.map((state) => ({
      state,
      body: buildWordPrefix(state, state.candidateWords),
    }));
    const bodies = candidates.map((candidate) => candidate.body);
    const bgeCounts = await boundedBatchTokenCounts(bge, bodies, { budget });
    const e5Counts = await boundedBatchTokenCounts(
      e5,
      bodies.map((body) => e5Prefix + body),
      { budget, ambiguousAtBudget: true },
    );

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const fits = bgeCounts[index] <= budget && e5Counts[index] <= budget;
      if (fits) {
        candidate.state.best = {
          commonBody: candidate.body,
          bgeCount: bgeCounts[index],
          e5Count: e5Counts[index],
        };
      } else {
        if (candidate.state.candidateWords === 0) {
          throw new Error(`[prepare-inputs] title exceeds the common token budget at input index ${candidate.state.index}`);
        }
        candidate.state.candidateWords = Math.max(0, candidate.state.candidateWords - 8);
      }
    }
    log(`[prepare-inputs] overflow validation round ${round}: ${active.length} active inputs`);
    trackRss();
  }

  // Decoding can collapse punctuation-heavy source text (for example long
  // table-of-contents dot leaders), making a word-count estimate too small.
  // Expand only those rare underfilled candidates with an exact batched
  // binary search; normal documents already sit near the token boundary.
  for (const state of states) {
    if (Math.max(state.best.bgeCount, state.best.e5Count) < 480 && state.candidateWords < state.words.length) {
      state.low = state.candidateWords + 1;
      state.high = state.words.length;
    }
  }
  let expansionRound = 0;
  while (true) {
    const active = states.filter((state) => state.low <= state.high);
    if (active.length === 0) break;
    expansionRound += 1;
    const candidates = active.map((state) => {
      const candidateWords = Math.floor((state.low + state.high) / 2);
      return { state, candidateWords, body: buildWordPrefix(state, candidateWords) };
    });
    const bodies = candidates.map((candidate) => candidate.body);
    const bgeCounts = await boundedBatchTokenCounts(bge, bodies, { budget });
    const e5Counts = await boundedBatchTokenCounts(
      e5,
      bodies.map((body) => e5Prefix + body),
      { budget, ambiguousAtBudget: true },
    );
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (bgeCounts[index] <= budget && e5Counts[index] <= budget) {
        candidate.state.best = {
          commonBody: candidate.body,
          bgeCount: bgeCounts[index],
          e5Count: e5Counts[index],
        };
        candidate.state.low = candidate.candidateWords + 1;
      } else {
        candidate.state.high = candidate.candidateWords - 1;
      }
    }
    log(`[prepare-inputs] underfilled expansion round ${expansionRound}: ${active.length} active inputs`);
    trackRss();
  }

  const fitted = new Map();
  for (const state of states) {
    fitted.set(state.index, state.best);
  }
  return fitted;
}

async function prepareBodies(
  entries,
  { kind, log, progressEvery, trackRss, budget = COMMON_REGIME_TOKEN_BUDGET },
) {
  const isDocument = kind === 'document';
  const e5Prefix = isDocument ? E5_PREFIX.passage : E5_PREFIX.query;
  const ids = [...entries.keys()];
  const docs = ids.map((id) => {
    const value = entries.get(id);
    return isDocument
      ? { title: value.title ?? '', body: value.text ?? '' }
      : { title: '', body: value ?? '' };
  });
  const nativeBodies = docs.map(nativeDocumentBody);

  const bge = await getBgeTokenizer();
  log(`[prepare-inputs] ${kind}: BGE count for ${ids.length} inputs`);
  const bgeStarted = Date.now();
  const bgeInfo = await boundedBatchTokenInfo(bge, nativeBodies, {
    budget,
    captureDecodedWordCounts: true,
    onProgress: (done, total) => {
      if (done === total || done % 1024 === 0) log(`[prepare-inputs] ${kind}: BGE ${done}/${total}`);
    },
  });
  log(`[prepare-inputs] ${kind}: BGE pass completed in ${Date.now() - bgeStarted}ms`);
  trackRss();

  const e5 = await getE5Tokenizer();
  log(`[prepare-inputs] ${kind}: E5 count for ${ids.length} inputs`);
  const e5Started = Date.now();
  const e5Info = await boundedBatchTokenInfo(
    e5,
    nativeBodies.map((body) => e5Prefix + body),
    {
      budget,
      captureDecodedWordCounts: true,
      ambiguousAtBudget: true,
      onProgress: (done, total) => {
        if (done === total || done % 1024 === 0) log(`[prepare-inputs] ${kind}: E5 ${done}/${total}`);
      },
    },
  );
  log(`[prepare-inputs] ${kind}: E5 pass completed in ${Date.now() - e5Started}ms`);
  trackRss();

  const bgeCounts = bgeInfo.counts;
  const e5Counts = e5Info.counts;

  const overflowIndexes = [];
  for (let index = 0; index < ids.length; index++) {
    if (bgeCounts[index] > budget || e5Counts[index] > budget) overflowIndexes.push(index);
  }
  log(`[prepare-inputs] ${kind}: ${overflowIndexes.length}/${ids.length} require truncation`);
  const fittedOverflow = await truncateOverflowBatch(docs, overflowIndexes, {
    e5Prefix,
    budget,
    bge,
    e5,
    bgeDecodedWords: bgeInfo.decodedWordCounts,
    e5DecodedWords: e5Info.decodedWordCounts,
    log,
    trackRss,
  });

  const results = new Map();
  for (let index = 0; index < ids.length; index++) {
    const fits = bgeCounts[index] <= budget && e5Counts[index] <= budget;
    if (fits) {
      results.set(ids[index], {
        nativeBody: nativeBodies[index],
        commonBody: nativeBodies[index],
        truncated: false,
        bgeCount: bgeCounts[index],
        e5Count: e5Counts[index],
      });
    } else {
      const fitted = fittedOverflow.get(index);
      results.set(ids[index], {
        nativeBody: nativeBodies[index],
        commonBody: fitted.commonBody,
        truncated: true,
        bgeCount: fitted.bgeCount,
        e5Count: fitted.e5Count,
      });
    }

    const processed = index + 1;
    if (processed % progressEvery === 0 || processed === ids.length) {
      log(`[prepare-inputs] ${kind}: assembled ${processed}/${ids.length}`);
      trackRss();
    }
  }
  return { entries: results, total: ids.length, truncated: overflowIndexes.length };
}

/** The only model-specific formatting boundary in the benchmark. */
export function formatForLanes({ body, profileKind, role }) {
  if (profileKind === 'local') return { denseText: body, sparseText: body };
  const densePrefix = role === 'document' ? E5_PREFIX.passage : E5_PREFIX.query;
  return {
    denseText: densePrefix + body,
    sparseText: body,
  };
}

function selectionDigest(corpus, queries) {
  const hash = createHash('sha1');
  for (const [id, doc] of corpus) hash.update(`d\0${id}\0${doc.title ?? ''}\0${doc.text ?? ''}\0`);
  for (const [id, query] of queries) hash.update(`q\0${id}\0${query}\0`);
  return hash.digest('hex');
}

function cacheManifest({ datasetMd5, corpus, queries }) {
  return {
    schemaVersion: PREP_SCHEMA_VERSION,
    datasetMd5,
    selectionDigest: selectionDigest(corpus, queries),
    bgeTokenizer: ONNX_DENSE_MODEL_ID,
    e5Tokenizer: E5_MODEL_ID,
    tokenBudget: COMMON_REGIME_TOKEN_BUDGET,
    documentCount: corpus.size,
    queryCount: queries.size,
  };
}

function manifestKey(manifest) {
  return createHash('sha1').update(JSON.stringify(manifest)).digest('hex').slice(0, 20);
}

export function cachePathFor(manifest) {
  mkdirSync(PREPARED_CACHE_DIR, { recursive: true });
  return resolve(PREPARED_CACHE_DIR, `prepared-inputs-${manifestKey(manifest)}.json`);
}

function serializeMap(map) {
  return [...map.entries()];
}

function deserializeMap(entries) {
  return new Map(entries);
}

function sameManifest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validatePrepared({ documents, queries }) {
  const problems = [];
  const validate = (entries, label) => {
    for (const [id, entry] of entries) {
      if (entry.bgeCount > COMMON_REGIME_TOKEN_BUDGET) {
        problems.push(`${label} ${id}: BGE count ${entry.bgeCount} exceeds budget`);
      }
      if (entry.e5Count > COMMON_REGIME_TOKEN_BUDGET) {
        problems.push(`${label} ${id}: E5 count ${entry.e5Count} exceeds budget`);
      }
      if (entry.commonBody.startsWith(E5_PREFIX.passage) || entry.commonBody.startsWith(E5_PREFIX.query)) {
        problems.push(`${label} ${id}: common body contains an E5 prefix`);
      }
    }
  };
  validate(documents, 'document');
  validate(queries, 'query');
  return { ok: problems.length === 0, problems };
}

export async function prepareInputs({
  corpus,
  queries,
  datasetMd5,
  log = () => {},
  trackRss = () => {},
  progressEvery = 200,
  useCache = true,
  prepareBodiesImpl = prepareBodies,
}) {
  const manifest = cacheManifest({ datasetMd5, corpus, queries });
  const cachePath = cachePathFor(manifest);
  if (useCache && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (sameManifest(cached.manifest, manifest)) {
        const documents = deserializeMap(cached.documents);
        const preparedQueries = deserializeMap(cached.queries);
        const validation = validatePrepared({ documents, queries: preparedQueries });
        if (validation.ok) {
          log(`[prepare-inputs] cache hit: ${cachePath}`);
          return {
            documents,
            queries: preparedQueries,
            stats: { ...cached.stats, cacheBytes: statSync(cachePath).size },
            cachePath,
            fromCache: true,
          };
        }
      }
    } catch {
      // A killed preparation process may leave a partial JSON file. Rebuild
      // it from the verified dataset instead of making the cache permanent.
    }
    log('[prepare-inputs] ignoring invalid prepared-input cache');
  }

  const started = Date.now();
  log(`[prepare-inputs] preparing ${corpus.size} documents and ${queries.size} queries once`);
  let documents;
  let preparedQueries;
  try {
    documents = await prepareBodiesImpl(corpus, {
      kind: 'document', log, progressEvery, trackRss,
    });
    preparedQueries = await prepareBodiesImpl(queries, {
      kind: 'query', log, progressEvery, trackRss,
    });
  } finally {
    // Fresh preparation can hold both tokenizer vocabularies. Do not retain
    // them while the subsequent live run loads the ONNX embedding model.
    releaseTokenizerReferences();
  }
  const validation = validatePrepared({
    documents: documents.entries,
    queries: preparedQueries.entries,
  });
  if (!validation.ok) {
    throw new Error(`[prepare-inputs] validation failed:\n- ${validation.problems.join('\n- ')}`);
  }

  const stats = {
    documents: { total: documents.total, truncated: documents.truncated },
    queries: { total: preparedQueries.total, truncated: preparedQueries.truncated },
    elapsedMs: Date.now() - started,
  };
  const payload = {
    manifest,
    stats,
    documents: serializeMap(documents.entries),
    queries: serializeMap(preparedQueries.entries),
  };
  if (useCache) {
    writeFileSync(cachePath, JSON.stringify(payload), 'utf8');
    stats.cacheBytes = statSync(cachePath).size;
    log(`[prepare-inputs] cache written: ${cachePath}`);
  }
  return {
    documents: documents.entries,
    queries: preparedQueries.entries,
    stats,
    cachePath,
    fromCache: false,
  };
}
