// Download/cache/validate helper for the official BEIR SciFact dataset.
// https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip
// MD5: 5f7d1de60b170fc8027bb7898e2efca1  (per the BEIR dataset wiki)
//
// Downloads once into a gitignored cache directory, verifies the MD5 BEFORE
// extracting, extracts with adm-zip (a direct devDependency — never an
// implicit transitive one), and validates the structural invariants this
// benchmark harness depends on: 300 test queries, >5000 corpus documents,
// and every qrels row referencing a real query/document ID.
//
// No production code touched. Not run as part of `npm test`/`npm run smoke`.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import AdmZip from 'adm-zip';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = resolve(__dirname, '.cache');
export const ZIP_PATH = join(CACHE_DIR, 'scifact.zip');
export const DATASET_DIR = join(CACHE_DIR, 'scifact');

export const SCIFACT_URL = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip';
export const SCIFACT_MD5 = '5f7d1de60b170fc8027bb7898e2efca1';

const EXPECTED_TEST_QUERY_COUNT = 300;
const EXPECTED_MIN_CORPUS_SIZE = 5000;

async function md5OfFile(path) {
  const hash = createHash('md5');
  const buf = readFileSync(path);
  hash.update(buf);
  return hash.digest('hex');
}

/** Downloads the zip to CACHE_DIR if not already present (or if a present
 * file fails MD5 verification, in which case it re-downloads once). Never
 * trusts an unverified cached file — MD5 is always checked, cache or fresh. */
export async function downloadZip({ log = () => {} } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });

  if (existsSync(ZIP_PATH)) {
    log(`[fetch-scifact] found cached zip, verifying MD5...`);
    const md5 = await md5OfFile(ZIP_PATH);
    if (md5 === SCIFACT_MD5) {
      log(`[fetch-scifact] cached zip MD5 OK, skipping download`);
      return { downloaded: false, path: ZIP_PATH };
    }
    log(`[fetch-scifact] cached zip MD5 mismatch (${md5} != ${SCIFACT_MD5}) — re-downloading`);
  }

  log(`[fetch-scifact] downloading ${SCIFACT_URL} ...`);
  const res = await fetch(SCIFACT_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`[fetch-scifact] download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let downloaded = 0;
  const writer = createWriteStream(ZIP_PATH);
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await new Promise((ok, fail) => writer.write(value, (e) => (e ? fail(e) : ok())));
    downloaded += value.length;
    if (total) process.stderr.write(`\r[fetch-scifact] ${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
  }
  await new Promise((ok, fail) => writer.end((e) => (e ? fail(e) : ok())));
  process.stderr.write('\n');

  const md5 = await md5OfFile(ZIP_PATH);
  if (md5 !== SCIFACT_MD5) {
    throw new Error(`[fetch-scifact] MD5 mismatch after download: got ${md5}, expected ${SCIFACT_MD5}. Refusing to extract a corrupted/tampered archive.`);
  }
  log(`[fetch-scifact] download complete, MD5 verified`);
  return { downloaded: true, path: ZIP_PATH };
}

/** Extracts scifact.zip into CACHE_DIR (producing CACHE_DIR/scifact/...).
 * MD5 must already be verified by the caller — this function does not
 * re-verify, so always call downloadZip() first (it always verifies). */
export function extractZip({ log = () => {} } = {}) {
  if (existsSync(DATASET_DIR)) {
    log(`[fetch-scifact] dataset directory already extracted, skipping`);
    return { extracted: false, dir: DATASET_DIR };
  }
  log(`[fetch-scifact] extracting ${ZIP_PATH} ...`);
  const zip = new AdmZip(ZIP_PATH);
  zip.extractAllTo(CACHE_DIR, /* overwrite */ true);
  if (!existsSync(DATASET_DIR)) {
    throw new Error(`[fetch-scifact] extraction did not produce expected directory: ${DATASET_DIR}`);
  }
  log(`[fetch-scifact] extraction complete`);
  return { extracted: true, dir: DATASET_DIR };
}

/** Streams a JSONL file into an array of parsed objects. SciFact's corpus
 * and queries files are JSONL (one JSON object per line). */
function readJsonl(path) {
  const text = readFileSync(path, 'utf-8');
  const items = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    items.push(JSON.parse(trimmed));
  }
  return items;
}

/**
 * Loads the extracted dataset into memory-friendly structures:
 *   corpus: Map<docId, { title, text }>
 *   queries: Map<queryId, string>  (only the TEST split's queries — SciFact's
 *     queries.jsonl contains train+dev+test; scoping to test.tsv's query IDs
 *     is what makes this "the test split")
 *   qrels: Map<queryId, Map<docId, relevance>>
 */
export function loadDataset() {
  const corpusPath = join(DATASET_DIR, 'corpus.jsonl');
  const queriesPath = join(DATASET_DIR, 'queries.jsonl');
  const qrelsPath = join(DATASET_DIR, 'qrels', 'test.tsv');
  for (const p of [corpusPath, queriesPath, qrelsPath]) {
    if (!existsSync(p)) throw new Error(`[fetch-scifact] expected file missing after extraction: ${p}`);
  }

  const corpus = new Map();
  for (const doc of readJsonl(corpusPath)) {
    corpus.set(String(doc._id), { title: doc.title ?? '', text: doc.text ?? '' });
  }

  const allQueries = new Map();
  for (const q of readJsonl(queriesPath)) {
    allQueries.set(String(q._id), q.text ?? '');
  }

  const qrelsRaw = readFileSync(qrelsPath, 'utf-8');
  const qrels = new Map();
  const testQueryIds = new Set();
  for (const line of qrelsRaw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [qid, docId, scoreRaw] = trimmed.split('\t');
    if (qid === 'query-id') continue; // header
    const score = Number(scoreRaw);
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid).set(docId, score);
    testQueryIds.add(qid);
  }

  // Scope queries to exactly the test split (qrels/test.tsv's own query IDs)
  // — queries.jsonl itself is the union of train/dev/test in BEIR's release.
  const queries = new Map();
  for (const qid of testQueryIds) {
    if (allQueries.has(qid)) queries.set(qid, allQueries.get(qid));
  }

  return { corpus, queries, qrels };
}

/**
 * Validates the structural invariants the task requires:
 *   - test queries: 300
 *   - corpus: > 5000 documents
 *   - every qrels row references an existing query ID AND an existing
 *     document ID (no dangling references)
 * Throws with an actionable message on the first violation rather than
 * silently returning a partially-valid dataset.
 */
export function validateDataset({ corpus, queries, qrels }) {
  const problems = [];

  if (queries.size !== EXPECTED_TEST_QUERY_COUNT) {
    problems.push(`expected exactly ${EXPECTED_TEST_QUERY_COUNT} test queries, got ${queries.size}`);
  }
  if (corpus.size <= EXPECTED_MIN_CORPUS_SIZE) {
    problems.push(`expected corpus > ${EXPECTED_MIN_CORPUS_SIZE} documents, got ${corpus.size}`);
  }

  let danglingQueryRefs = 0;
  let danglingDocRefs = 0;
  const danglingQuerySamples = [];
  const danglingDocSamples = [];
  for (const [qid, docsMap] of qrels.entries()) {
    if (!queries.has(qid)) {
      danglingQueryRefs += 1;
      if (danglingQuerySamples.length < 5) danglingQuerySamples.push(qid);
    }
    for (const docId of docsMap.keys()) {
      if (!corpus.has(docId)) {
        danglingDocRefs += 1;
        if (danglingDocSamples.length < 5) danglingDocSamples.push(docId);
      }
    }
  }
  if (danglingQueryRefs > 0) {
    problems.push(`${danglingQueryRefs} qrels rows reference a query ID not present in the test query set (examples: ${danglingQuerySamples.join(', ')})`);
  }
  if (danglingDocRefs > 0) {
    problems.push(`${danglingDocRefs} qrels rows reference a document ID not present in the corpus (examples: ${danglingDocSamples.join(', ')})`);
  }

  return {
    ok: problems.length === 0,
    problems,
    stats: { corpusSize: corpus.size, queryCount: queries.size, qrelsQueryCount: qrels.size },
  };
}

/** Full pipeline: download (MD5-verified) -> extract -> load -> validate.
 * Throws on any MD5 mismatch or structural validation failure — never
 * returns a dataset the caller hasn't been told is sound. */
export async function fetchAndValidateScifact({ log = () => {} } = {}) {
  await downloadZip({ log });
  extractZip({ log });
  const dataset = loadDataset();
  const validation = validateDataset(dataset);
  if (!validation.ok) {
    throw new Error(`[fetch-scifact] dataset validation failed:\n  - ${validation.problems.join('\n  - ')}`);
  }
  log(`[fetch-scifact] validated: ${validation.stats.corpusSize} corpus docs, ${validation.stats.queryCount} test queries, 0 dangling qrels refs`);
  return { ...dataset, validation };
}

// CLI: node benchmarks/external/beir/fetch-scifact.mjs
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { validation } = await fetchAndValidateScifact({ log: (m) => console.log(m) });
    console.log(JSON.stringify(validation, null, 2));
    process.exitCode = validation.ok ? 0 : 1;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
