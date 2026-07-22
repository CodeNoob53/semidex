// Download/cache/validate helper for the official MIRACL Russian ('ru')
// topics + qrels + corpus.
//
// Dataset contract, verified directly against official sources before any
// code was written here (see benchmarks/external/miracl/README.md's
// "Dataset contract" section for the full writeup and citations):
//
//   - Repo: https://huggingface.co/datasets/miracl/miracl (topics/qrels),
//     pinned to commit 5be20db9509754dadad47689368639fcec739c00
//     (config miracl-v1.0-ru).
//   - Repo: https://huggingface.co/datasets/miracl/miracl-corpus (passage
//     text), pinned to commit d921ec7e349ce0d28daf30b2da9da5ee698bef0d
//     (config miracl-corpus-v1.0-ru).
//   - Both repos are public (gated: false) and Apache-2.0 licensed — no
//     redistribution restriction beyond attribution, and this harness never
//     redistributes the raw content anyway (gitignored cache only).
//   - topics.miracl-v1.0-ru-dev.tsv: "qid\tquery_text" (no header).
//   - qrels.miracl-v1.0-ru-dev.tsv: standard 4-column TREC qrels
//     "qid Q0 docid relevance" (no header), relevance is binary 0/1.
//   - miracl-corpus-v1.0-ru/docs-*.jsonl.gz (20 shards): one JSON object per
//     line, {"docid": "<wikipedia_page_id>#<passage_index>", "title", "text"}.
//   - Dev split: 1,252 queries, 13,100 total qrels judgments (3,560
//     relevance=1, 9,540 relevance=0) — verified against the live files,
//     matching the dataset card's stated totals.
//
// IMPORTANT — what "negative_passages" means here (see README for the full
// feasibility discussion): the Python `datasets` library's loading script
// synthesizes a `negative_passages` field from qrels rows with relevance=0,
// but the dataset card is explicit that these are passages a human
// annotator judged non-relevant during pooling — "instead of the
// non-positive passages from top-k retrieval results." They are NOT
// retrieval-mined hard negatives (unlike this repo's BEIR SciFact mini
// benchmark, which pools negatives from a TREC run's top-k). MIRACL
// publishes no downloadable official baseline run file for the Russian dev
// split (only a Pyserini reproduction COMMAND that requires indexing the
// full 9.5M-passage corpus with Anserini/Lucene — out of scope for this
// Node.js/Qdrant harness). This harness therefore uses MIRACL's own
// annotated relevance=0 qrels rows as the corpus-padding pool, and calls
// them "annotated negatives" throughout — never "hard negatives" — to keep
// the distinction honest.
//
// No production code touched. Not run as part of `npm test`/`npm run smoke`.
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  createWriteStream, createReadStream,
} from 'node:fs';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = resolve(__dirname, '.cache');

export const MIRACL_TOPICS_QRELS_REVISION = '5be20db9509754dadad47689368639fcec739c00';
export const MIRACL_CORPUS_REVISION = 'd921ec7e349ce0d28daf30b2da9da5ee698bef0d';
export const MIRACL_TOPICS_QRELS_CONFIG = 'miracl-v1.0-ru';
export const MIRACL_CORPUS_CONFIG = 'miracl-corpus-v1.0-ru';

// Cache directories are namespaced by revision — a topics/qrels or corpus
// revision bump gets its own directory rather than silently reusing files
// downloaded under a different revision. Without this, changing
// MIRACL_TOPICS_QRELS_REVISION above would leave the OLD revision's files
// sitting under the same fixed path, and downloadTopicsAndQrels()'s
// existsSync() check would happily reuse them while the report claimed the
// NEW revision.
export const TOPICS_DIR = join(CACHE_DIR, `topics-${MIRACL_TOPICS_QRELS_REVISION}`);
export const QRELS_DIR = join(CACHE_DIR, `qrels-${MIRACL_TOPICS_QRELS_REVISION}`);
export const CORPUS_DIR = join(CACHE_DIR, `corpus-${MIRACL_CORPUS_REVISION}`);

const TOPICS_URL = `https://huggingface.co/datasets/miracl/miracl/resolve/${MIRACL_TOPICS_QRELS_REVISION}/${MIRACL_TOPICS_QRELS_CONFIG}/topics/topics.${MIRACL_TOPICS_QRELS_CONFIG}-dev.tsv`;
const QRELS_URL = `https://huggingface.co/datasets/miracl/miracl/resolve/${MIRACL_TOPICS_QRELS_REVISION}/${MIRACL_TOPICS_QRELS_CONFIG}/qrels/qrels.${MIRACL_TOPICS_QRELS_CONFIG}-dev.tsv`;
const CORPUS_SHARD_COUNT = 20;
const corpusShardUrl = (i) => `https://huggingface.co/datasets/miracl/miracl-corpus/resolve/${MIRACL_CORPUS_REVISION}/${MIRACL_CORPUS_CONFIG}/docs-${i}.jsonl.gz`;

const EXPECTED_DEV_QUERY_COUNT = 1252;
const EXPECTED_DEV_JUDGMENT_COUNT = 13100;

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function manifestPathFor(destPath) {
  return `${destPath}.manifest.json`;
}

/** True only if destPath exists AND its recorded manifest (sha256 + source
 * URL, written atomically alongside the final file — see downloadTo())
 * matches. A file present without a valid manifest is treated as absent —
 * this is what makes an interrupted download safe to retry rather than
 * silently reused: a partial/corrupt file never has a manifest written for
 * it (the manifest is only written after the .part -> final rename), so it
 * always fails this check and gets re-downloaded. Exported for direct unit
 * testing of the cache-validity contract without needing a real network
 * download. */
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
 * only after the download completes successfully. An interrupted download
 * (process killed, network drop) leaves only the `.part` file behind — the
 * final path never exists in a half-written state, so a later run's
 * existsSync()-based cache check can never see a corrupted file. A manifest
 * (source URL + sha256 of the completed file) is written right after the
 * rename, and is what isValidCacheHit() actually trusts — not just the
 * final path's existence. */
export async function downloadTo(url, destPath, { log = () => {}, fetchImpl = fetch } = {}) {
  const partPath = `${destPath}.part`;
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`[fetch-miracl] download failed (${res.status}): ${url}`);
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
      if (total) process.stderr.write(`\r[fetch-miracl] ${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB — ${destPath.split(/[\\/]/).pop()}`);
    }
    await new Promise((ok, fail) => writer.end((e) => (e ? fail(e) : ok())));
  } catch (err) {
    // Wait for the writer to actually finish closing before touching the
    // .part file — destroy() alone only SCHEDULES the close; unlinking
    // immediately after can race the file descriptor still being open,
    // which surfaces as a spurious async ENOENT/EBUSY well after this
    // function has already returned/thrown.
    await new Promise((done) => { writer.destroy(); writer.once('close', done); });
    try { unlinkSync(partPath); } catch { /* best effort cleanup */ }
    throw err;
  }
  if (total) process.stderr.write('\n');

  renameSync(partPath, destPath); // atomic on the same filesystem (same directory)
  const sha256 = sha256OfFile(destPath);
  writeFileSync(manifestPathFor(destPath), JSON.stringify({ url, sha256, downloadedAt: new Date().toISOString() }), 'utf-8');
  log(`[fetch-miracl] downloaded ${destPath} (sha256 ${sha256.slice(0, 16)}...)`);
}

/** Downloads topics + qrels TSVs for the Russian dev split if not already
 * validly cached (existing file + matching manifest). Always plain-text,
 * no gzip, no auth required (both repos are public per the dataset
 * contract above). Cache paths are revision-namespaced (see TOPICS_DIR/
 * QRELS_DIR above), so a revision bump never reuses a prior revision's
 * files. */
export async function downloadTopicsAndQrels({ log = () => {} } = {}) {
  mkdirSync(TOPICS_DIR, { recursive: true });
  mkdirSync(QRELS_DIR, { recursive: true });
  const topicsPath = join(TOPICS_DIR, `topics.${MIRACL_TOPICS_QRELS_CONFIG}-dev.tsv`);
  const qrelsPath = join(QRELS_DIR, `qrels.${MIRACL_TOPICS_QRELS_CONFIG}-dev.tsv`);
  if (isValidCacheHit(topicsPath, TOPICS_URL)) log('[fetch-miracl] topics already cached (checksum verified), skipping download');
  else await downloadTo(TOPICS_URL, topicsPath, { log });
  if (isValidCacheHit(qrelsPath, QRELS_URL)) log('[fetch-miracl] qrels already cached (checksum verified), skipping download');
  else await downloadTo(QRELS_URL, qrelsPath, { log });
  return { topicsPath, qrelsPath };
}

/** Parses "qid\tquery_text" (no header) into Map<qid, queryText>. */
export function parseTopicsTsv(text) {
  const queries = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tabIdx = trimmed.indexOf('\t');
    if (tabIdx < 0) continue;
    const qid = trimmed.slice(0, tabIdx);
    const query = trimmed.slice(tabIdx + 1);
    queries.set(qid, query);
  }
  return queries;
}

/** Parses standard 4-column TREC qrels "qid Q0 docid relevance" (no
 * header, whitespace-separated — MIRACL's own files use tabs) into
 * Map<qid, Map<docid, relevance>>. Relevance is binary 0/1 for MIRACL. */
export function parseMiraclQrelsTsv(text) {
  const qrels = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const [qid, , docid, relRaw] = parts;
    const rel = Number(relRaw);
    if (!Number.isFinite(rel)) continue;
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid).set(docid, rel);
  }
  return qrels;
}

export function loadTopicsAndQrels({ topicsPath, qrelsPath }) {
  const queries = parseTopicsTsv(readFileSync(topicsPath, 'utf-8'));
  const qrels = parseMiraclQrelsTsv(readFileSync(qrelsPath, 'utf-8'));
  return { queries, qrels };
}

/**
 * Validates the structural invariants this benchmark depends on for the
 * Russian dev split: exact query count, exact total judgment count (both
 * independently verified against the live HF files before this code was
 * written — see the module header), and every qrels row referencing a
 * query ID actually present in topics.
 */
export function validateTopicsAndQrels({ queries, qrels }) {
  const problems = [];
  if (queries.size !== EXPECTED_DEV_QUERY_COUNT) {
    problems.push(`expected exactly ${EXPECTED_DEV_QUERY_COUNT} dev queries, got ${queries.size}`);
  }
  let judgmentCount = 0;
  let danglingQueryRefs = 0;
  const danglingSamples = [];
  for (const [qid, docsMap] of qrels.entries()) {
    judgmentCount += docsMap.size;
    if (!queries.has(qid)) {
      danglingQueryRefs += 1;
      if (danglingSamples.length < 5) danglingSamples.push(qid);
    }
  }
  if (judgmentCount !== EXPECTED_DEV_JUDGMENT_COUNT) {
    problems.push(`expected exactly ${EXPECTED_DEV_JUDGMENT_COUNT} total judgments, got ${judgmentCount}`);
  }
  if (danglingQueryRefs > 0) {
    problems.push(`${danglingQueryRefs} qrels rows reference a query ID not present in topics (examples: ${danglingSamples.join(', ')})`);
  }
  return { ok: problems.length === 0, problems, stats: { queryCount: queries.size, judgmentCount } };
}

/** Downloads corpus shard `i` (gzip JSONL) if not already validly cached
 * (existing file + matching manifest — see isValidCacheHit()). Shards are
 * cached compressed — they are streamed+decompressed on read, never fully
 * inflated to disk, to keep the on-disk footprint close to the ~2GB
 * compressed total rather than a larger inflated copy. Cache path is
 * revision-namespaced (CORPUS_DIR), so a corpus revision bump never reuses
 * a prior revision's shard files. */
async function downloadCorpusShard(i, { log = () => {} } = {}) {
  mkdirSync(CORPUS_DIR, { recursive: true });
  const destPath = join(CORPUS_DIR, `docs-${i}.jsonl.gz`);
  const url = corpusShardUrl(i);
  if (isValidCacheHit(destPath, url)) { log(`[fetch-miracl] corpus shard ${i} already cached (checksum verified)`); return destPath; }
  await downloadTo(url, destPath, { log });
  return destPath;
}

// Every corpus line starts with the docid field literally first:
// {"docid": "7#0", "title": "...", "text": "..."} — verified against the
// live shard files. docid values are plain "<wikipedia_page_id>#<index>"
// (digits and '#' only, no quotes/backslashes to escape), so a cheap
// anchored regex on just the line's prefix can extract it without paying
// for a full JSON.parse of the (often much longer) title/text fields.
const DOCID_PREFIX_RE = /^\{"docid":\s*"([^"]*)"/;

/** Extracts the docid from a raw JSONL line WITHOUT parsing the full JSON
 * object — returns null if the line doesn't match the expected prefix
 * shape (falls back to a full parse at the call site in that case, so a
 * shard whose formatting ever changes still works correctly, just without
 * the fast path). */
export function extractDocIdCheaply(line) {
  const match = DOCID_PREFIX_RE.exec(line);
  return match ? match[1] : null;
}

/**
 * Streams every corpus shard, keeping only passages whose docid is in
 * `neededDocIds` (a Set). Never materializes the full 9.5M-passage corpus
 * in memory — each shard is read line-by-line and 99%+ of lines are
 * discarded immediately. The docid is extracted from just the line's
 * prefix (extractDocIdCheaply()) and checked against `remaining` BEFORE
 * JSON.parse() runs on the full line — most lines' title+text are never
 * parsed at all, only the ~1000/9.5M lines that actually match. Downloads
 * shards sequentially (bounded, no unbounded Promise.all) since this can
 * be a large one-time transfer. Returns Map<docid, {title, text}> for
 * exactly the requested IDs (missing IDs are simply absent from the
 * result — the caller must check for those).
 */
export async function fetchCorpusPassages(neededDocIds, { log = () => {}, trackRss = () => {} } = {}) {
  const remaining = new Set(neededDocIds);
  const found = new Map();
  for (let shard = 0; shard < CORPUS_SHARD_COUNT && remaining.size > 0; shard++) {
    const shardPath = await downloadCorpusShard(shard, { log });
    log(`[fetch-miracl] scanning shard ${shard} for ${remaining.size} remaining docids...`);
    const gunzip = createGunzip();
    const fileStream = createReadStream(shardPath);
    const rl = readline.createInterface({ input: fileStream.pipe(gunzip), crlfDelay: Infinity });
    let scanned = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      scanned += 1;

      const cheapDocId = extractDocIdCheaply(line);
      // Fast path: the cheap prefix match ran and the docid isn't one we
      // need — skip this line entirely, no JSON.parse() at all.
      if (cheapDocId !== null && !remaining.has(cheapDocId)) {
        if (scanned % 200000 === 0) trackRss();
        continue;
      }

      // Slow path: either the cheap match found a docid we DO need (parse
      // to get title/text), or the line didn't match the expected prefix
      // shape at all (parse anyway so formatting drift never silently
      // drops a passage).
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (remaining.has(obj.docid)) {
        found.set(obj.docid, { title: obj.title ?? '', text: obj.text ?? '' });
        remaining.delete(obj.docid);
        if (remaining.size === 0) break;
      }
      if (scanned % 200000 === 0) trackRss();
    }
    log(`[fetch-miracl] shard ${shard}: ${scanned} lines scanned, ${found.size}/${neededDocIds.size} found so far`);
    trackRss();
  }
  return found;
}

/** Full pipeline for the topics+qrels half only (no corpus fetch — the
 * corpus is fetched separately, scoped to exactly the docids the
 * deterministic subset builder needs, since downloading all 9.5M passages
 * for a 1000-passage benchmark would be wasteful). */
export async function fetchAndValidateMiraclTopicsQrels({ log = () => {} } = {}) {
  const { topicsPath, qrelsPath } = await downloadTopicsAndQrels({ log });
  const { queries, qrels } = loadTopicsAndQrels({ topicsPath, qrelsPath });
  const validation = validateTopicsAndQrels({ queries, qrels });
  if (!validation.ok) {
    throw new Error(`[fetch-miracl] topics/qrels validation failed:\n  - ${validation.problems.join('\n  - ')}`);
  }
  log(`[fetch-miracl] validated: ${validation.stats.queryCount} dev queries, ${validation.stats.judgmentCount} total judgments`);
  return { queries, qrels, validation };
}

// CLI: node benchmarks/external/miracl/fetch-miracl.mjs
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { validation } = await fetchAndValidateMiraclTopicsQrels({ log: (m) => console.log(m) });
    console.log(JSON.stringify(validation, null, 2));
    process.exitCode = validation.ok ? 0 : 1;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
