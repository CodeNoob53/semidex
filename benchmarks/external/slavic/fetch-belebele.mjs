// Download/cache/validate helper for mteb/belebele — the Slavic-language
// dense vs sparse benchmark's data source.
//
// Dataset contract, verified directly against the live HuggingFace repo
// before any code was written here (see README.md's "Dataset contract"
// section for the full writeup):
//
//   - Repo: https://huggingface.co/datasets/mteb/belebele (NOT
//     mteb/BelebeleRetrieval — that repo is gated/requires authentication,
//     confirmed via a live HTTP 401 from its API; mteb/belebele is the
//     public, ungated repo MTEB's own BelebeleRetrieval task code actually
//     loads at runtime, per its source at
//     embeddings-benchmark/mteb/mteb/tasks/retrieval/multilingual/belebele_retrieval.py).
//   - Pinned revision: 979a211276faa22f671e69d096634193567cfd05 (main HEAD
//     at verification time, and the exact revision MTEB's own task
//     metadata hardcodes).
//   - License: cc-by-sa-4.0 (from the repo's README frontmatter and its HF
//     API cardData.license field). Underlying paper: Bandarkar et al.,
//     ACL 2024, arXiv:2308.16884.
//   - One file per language config: data/{config}.jsonl (plain
//     newline-delimited JSON — NOT Parquet; no parquet-parsing dependency
//     is needed or added by this harness). One split only: "test".
//   - Row fields (verified live against 7 language files, all identical
//     schema): link, question_number, flores_passage, question,
//     mc_answer1..4, correct_answer_num, dialect, ds.
//   - Every language file verified to contain exactly 900 rows, 900
//     UNIQUE `question` strings (no duplicate query text across rows), and
//     488 unique `link` values (the shared FLORES-200 passage identifier).
//
// IMPORTANT — what the qrels here actually are (see README's "MRC-derived,
// not pooled" section for the full caveat this harness surfaces
// everywhere): mteb/belebele is a raw multiple-choice reading-comprehension
// (MRC) dataset, not a retrieval dataset with pre-built qrels. This module
// SYNTHESIZES the retrieval task exactly the way MTEB's own
// BelebeleRetrieval task code does (traced from the source file above):
//   - corpus  = one entry per unique `link`, text = that link's
//     `flores_passage` (deduplicated — multiple questions share a passage).
//   - queries = one entry per unique `question` string (verified 1:1 with
//     rows above, so this is a no-op dedup here, but the logic still
//     dedupes defensively rather than assuming it).
//   - qrels   = for every row, relevance(question -> link) = 1. Every
//     query therefore has EXACTLY ONE relevant document — this is
//     MRC-derived ("the passage the question was written against"), never
//     a pooled/graded IR judgment set with multiple relevant docs or
//     annotated negatives. This harness never invents additional qrels
//     rows beyond this exact construction.
//
// No production code touched. Not run as part of `npm test`/`npm run smoke`.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = resolve(__dirname, '.cache');

export const BELEBELE_REPO = 'mteb/belebele';
export const BELEBELE_REVISION = '979a211276faa22f671e69d096634193567cfd05';
export const BELEBELE_LICENSE = 'cc-by-sa-4.0';

// Cache directory is namespaced by revision — a revision bump gets its own
// directory rather than silently reusing files downloaded under a
// different revision (same rationale as fetch-miracl.mjs's TOPICS_DIR/
// QRELS_DIR/CORPUS_DIR).
export const DATA_DIR = join(CACHE_DIR, `data-${BELEBELE_REVISION}`);

function jsonlUrl(lang) {
  return `https://huggingface.co/datasets/${BELEBELE_REPO}/resolve/${BELEBELE_REVISION}/data/${lang}.jsonl`;
}

// Every language file has exactly this many rows — verified live against
// all 7 languages this harness uses before writing this constant.
export const EXPECTED_ROW_COUNT = 900;
export const EXPECTED_CORPUS_SIZE = 488;

const EXPECTED_FIELDS = Object.freeze([
  'link', 'question_number', 'flores_passage', 'question',
  'mc_answer1', 'mc_answer2', 'mc_answer3', 'mc_answer4',
  'correct_answer_num', 'dialect', 'ds',
]);

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function manifestPathFor(destPath) {
  return `${destPath}.manifest.json`;
}

/** True only if destPath exists AND its recorded manifest (sha256 + source
 * URL, written atomically alongside the final file — see downloadTo())
 * matches. A file present without a valid manifest is treated as absent, so
 * an interrupted download is always safely retried rather than silently
 * reused (same contract as fetch-miracl.mjs's isValidCacheHit()). */
export function isValidCacheHit(destPath, url) {
  if (!existsSync(destPath)) return false;
  const manifestPath = manifestPathFor(destPath);
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (manifest.url !== url) return false;
    return manifest.sha256 === sha256OfFile(destPath);
  } catch {
    return false;
  }
}

/** Downloads to a `.part` file, then atomically renames to the final path
 * only after the download completes successfully — an interrupted download
 * never leaves the final path in a half-written state (same contract as
 * fetch-miracl.mjs's downloadTo()). */
export async function downloadTo(url, destPath, { log = () => {}, fetchImpl = fetch } = {}) {
  const partPath = `${destPath}.part`;
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`[fetch-belebele] download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let downloaded = 0;
  const writer = createWriteStream(partPath);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((ok, fail) => writer.write(value, (e) => (e ? fail(e) : ok())));
      downloaded += value.length;
      if (total) process.stderr.write(`\r[fetch-belebele] ${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB — ${destPath.split(/[\\/]/).pop()}`);
    }
    await new Promise((ok, fail) => writer.end((e) => (e ? fail(e) : ok())));
  } catch (err) {
    await new Promise((done) => { writer.destroy(); writer.once('close', done); });
    try { unlinkSync(partPath); } catch { /* best effort cleanup */ }
    throw err;
  }
  if (total) process.stderr.write('\n');

  renameSync(partPath, destPath);
  const sha256 = sha256OfFile(destPath);
  writeFileSync(manifestPathFor(destPath), JSON.stringify({ url, sha256, downloadedAt: new Date().toISOString() }), 'utf-8');
  log(`[fetch-belebele] downloaded ${destPath} (sha256 ${sha256.slice(0, 16)}...)`);
}

/** Downloads one language's JSONL file if not already validly cached. */
export async function downloadLanguageFile(lang, { log = () => {} } = {}) {
  mkdirSync(DATA_DIR, { recursive: true });
  const destPath = join(DATA_DIR, `${lang}.jsonl`);
  const url = jsonlUrl(lang);
  if (isValidCacheHit(destPath, url)) { log(`[fetch-belebele] ${lang} already cached (checksum verified)`); return destPath; }
  await downloadTo(url, destPath, { log });
  return destPath;
}

/** Parses one language's JSONL file into an array of raw row objects.
 * Throws on any line that fails JSON.parse (never silently drops a
 * malformed row — unlike parseTrecRun()'s deliberate tolerance for
 * benchmark-runner-generated TREC files, this is source dataset content
 * and a malformed line means something is genuinely wrong with the
 * download). */
export function parseJsonlRows(text, label) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`[fetch-belebele] ${label}: malformed JSON at line ${i + 1}: ${err.message}`);
    }
    rows.push(row);
  }
  return rows;
}

/** Validates every row has exactly the expected field set (no missing
 * content field, no silently-added/renamed field this harness doesn't know
 * about) and that the `dialect` field matches the language being loaded
 * (catches a mixed-up download/cache mismatch). */
export function validateRowSchema(rows, expectedLang, label) {
  const problems = [];
  if (rows.length !== EXPECTED_ROW_COUNT) {
    problems.push(`expected exactly ${EXPECTED_ROW_COUNT} rows, got ${rows.length}`);
  }
  let schemaMismatches = 0;
  let dialectMismatches = 0;
  const schemaSamples = [];
  for (const row of rows) {
    const fields = Object.keys(row).sort();
    const expected = [...EXPECTED_FIELDS].sort();
    if (fields.length !== expected.length || fields.some((f, i) => f !== expected[i])) {
      schemaMismatches += 1;
      if (schemaSamples.length < 3) schemaSamples.push(fields.join(','));
    }
    if (row.dialect !== expectedLang) dialectMismatches += 1;
  }
  if (schemaMismatches > 0) {
    problems.push(`${schemaMismatches} rows have an unexpected field set (examples: ${schemaSamples.join(' | ')})`);
  }
  if (dialectMismatches > 0) {
    problems.push(`${dialectMismatches} rows have dialect != "${expectedLang}"`);
  }
  return { ok: problems.length === 0, problems, stats: { rowCount: rows.length, label } };
}

/**
 * Synthesizes the retrieval task (corpus, queries, qrels) from raw MRC
 * rows, replicating MTEB's own BelebeleRetrieval construction exactly:
 *   - corpus: Map<docId, {title: '', text: flores_passage}> — one entry
 *     per unique `link`, deduplicated. title is always '' (Belebele/FLORES
 *     passages carry no separate title field — flores_passage IS the full
 *     content field, preserved verbatim, never truncated or reformatted
 *     here).
 *   - queries: Map<queryId, questionText> — one entry per unique
 *     `question` string, deduplicated defensively (verified 1:1 with rows
 *     for every language checked, but this dedup is not assumed to always
 *     hold for languages not yet verified).
 *   - qrels: Map<queryId, Map<docId, 1>> — exactly one relevant document
 *     per query (MRC-derived, not pooled — see this module's header).
 * IDs are deterministic hashes of the underlying content (link / question
 * text), not array indices — so re-running this on the same input always
 * produces the same IDs, and two different questions/passages can never
 * collide onto the same ID silently.
 */
export function synthesizeRetrievalTask(rows) {
  const corpus = new Map();
  const linkToDocId = new Map();
  const queries = new Map();
  const questionToQueryId = new Map();
  const qrels = new Map();
  const danglingCheck = [];

  for (const row of rows) {
    let docId = linkToDocId.get(row.link);
    if (docId === undefined) {
      docId = `doc-${createHash('sha1').update(row.link).digest('hex').slice(0, 16)}`;
      linkToDocId.set(row.link, docId);
      corpus.set(docId, { title: '', text: row.flores_passage });
    } else {
      // Same link, different question — verify the passage text is
      // identical every time (it must be, since it's keyed by the same
      // link within one language file) rather than silently trusting it.
      const existing = corpus.get(docId);
      if (existing.text !== row.flores_passage) {
        throw new Error(`[fetch-belebele] link "${row.link}" has inconsistent flores_passage text across rows — refusing to synthesize a corpus from conflicting content`);
      }
    }

    let queryId = questionToQueryId.get(row.question);
    if (queryId === undefined) {
      queryId = `q-${createHash('sha1').update(row.question).digest('hex').slice(0, 16)}`;
      questionToQueryId.set(row.question, queryId);
      queries.set(queryId, row.question);
    }

    if (!qrels.has(queryId)) qrels.set(queryId, new Map());
    qrels.get(queryId).set(docId, 1);
    danglingCheck.push({ queryId, docId });
  }

  // Verify: no qrels row references a document absent from the corpus —
  // this can only fail if the synthesis logic above has a bug, since every
  // docId used in qrels was just added to corpus in the same loop
  // iteration, but it is checked directly rather than assumed.
  const danglingQrelsRefs = [];
  for (const { queryId, docId } of danglingCheck) {
    if (!corpus.has(docId)) danglingQrelsRefs.push({ queryId, docId });
  }

  return {
    corpus, queries, qrels,
    stats: {
      rowCount: rows.length,
      corpusSize: corpus.size,
      queryCount: queries.size,
      qrelsJudgmentCount: [...qrels.values()].reduce((sum, m) => sum + m.size, 0),
      danglingQrelsRefs,
    },
  };
}

/** Validates the synthesized retrieval task's structural invariants: exact
 * expected corpus size, every query has exactly one relevant doc (this
 * dataset's MRC-derived contract — a query with zero or multiple relevant
 * docs would mean the synthesis logic diverged from the raw rows), no
 * dangling qrels references, and no empty/missing content field. */
export function validateRetrievalTask({ corpus, queries, qrels, stats }) {
  const problems = [];
  if (stats.corpusSize !== EXPECTED_CORPUS_SIZE) {
    problems.push(`expected exactly ${EXPECTED_CORPUS_SIZE} unique corpus passages, got ${stats.corpusSize}`);
  }
  if (stats.danglingQrelsRefs.length > 0) {
    problems.push(`${stats.danglingQrelsRefs.length} qrels rows reference a document absent from the corpus`);
  }
  let emptyText = 0;
  for (const doc of corpus.values()) {
    if (typeof doc.text !== 'string' || doc.text.trim() === '') emptyText += 1;
  }
  if (emptyText > 0) problems.push(`${emptyText} corpus documents have empty/missing text`);

  let emptyQuery = 0;
  for (const q of queries.values()) {
    if (typeof q !== 'string' || q.trim() === '') emptyQuery += 1;
  }
  if (emptyQuery > 0) problems.push(`${emptyQuery} queries have empty/missing text`);

  let wrongRelevantCount = 0;
  const samples = [];
  for (const [qid, docsMap] of qrels.entries()) {
    if (docsMap.size !== 1) {
      wrongRelevantCount += 1;
      if (samples.length < 5) samples.push(`${qid}: ${docsMap.size} relevant docs`);
    }
  }
  if (wrongRelevantCount > 0) {
    problems.push(`${wrongRelevantCount} queries do not have exactly 1 relevant document, as this MRC-derived dataset's contract requires (examples: ${samples.join('; ')})`);
  }
  if (qrels.size !== queries.size) {
    problems.push(`qrels cover ${qrels.size} queries but ${queries.size} queries exist — every query must have qrels in this dataset`);
  }

  return { ok: problems.length === 0, problems };
}

/** Full pipeline for one language: download (or use cache) -> parse ->
 * validate raw schema -> synthesize retrieval task -> validate synthesized
 * task. Throws on any validation failure — never silently proceeds with
 * partial/invalid data. */
export async function fetchAndValidateLanguage(lang, { log = () => {} } = {}) {
  const path = await downloadLanguageFile(lang, { log });
  const rows = parseJsonlRows(readFileSync(path, 'utf-8'), lang);
  const schemaValidation = validateRowSchema(rows, lang, lang);
  if (!schemaValidation.ok) {
    throw new Error(`[fetch-belebele] ${lang}: schema validation failed:\n  - ${schemaValidation.problems.join('\n  - ')}`);
  }
  const task = synthesizeRetrievalTask(rows);
  const taskValidation = validateRetrievalTask(task);
  if (!taskValidation.ok) {
    throw new Error(`[fetch-belebele] ${lang}: retrieval task validation failed:\n  - ${taskValidation.problems.join('\n  - ')}`);
  }
  log(`[fetch-belebele] ${lang} validated: ${task.stats.corpusSize} passages, ${task.stats.queryCount} queries, ${task.stats.qrelsJudgmentCount} qrels judgments`);
  return { ...task, lang, sourcePath: path };
}

// CLI: node benchmarks/external/slavic/fetch-belebele.mjs [lang]
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const lang = process.argv[2] ?? 'eng_Latn';
  try {
    const task = await fetchAndValidateLanguage(lang, { log: (m) => console.log(m) });
    console.log(JSON.stringify(task.stats, null, 2));
    process.exitCode = 0;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
