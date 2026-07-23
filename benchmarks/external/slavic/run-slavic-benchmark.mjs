// Slavic dense-vs-sparse benchmark on mteb/belebele (see fetch-belebele.mjs
// for the full dataset contract and MRC-derived-qrels caveat).
//
// Isolates the LANGUAGE factor: only the local BGE-M3 ONNX dense+learned-
// sparse provider, only one fixed equal-RRF hybrid mode (k=60) — no Qdrant
// Cloud E5/BM25 profile, no k-sweep. Adding either would reintroduce a
// confound this benchmark exists to remove (see slavic-profiles.mjs's
// module header).
//
// Execution rule per language: ONE Qdrant collection, ONE indexing pass —
// dense AND sparse vectors for every document come from the SAME
// embedOnnxBatch() call (BGE-M3 always returns both in one inference pass;
// there is no way to embed only-dense or only-sparse, so "one embedding
// pass" is the natural, only possible behavior here, not something this
// harness has to enforce separately). Then per query: one dense-only
// query, one sparse-only query, one equal-RRF hybrid query — three TREC
// runs per language, never merged.
//
// Run (full, 7 languages): node benchmarks/external/slavic/run-slavic-benchmark.mjs
// Resume:                  node benchmarks/external/slavic/run-slavic-benchmark.mjs --resume
// Restart:                 node benchmarks/external/slavic/run-slavic-benchmark.mjs --restart
// Smoke (tiny, separate path): node benchmarks/external/slavic/run-slavic-benchmark.mjs --smoke
// Subset of languages:     node benchmarks/external/slavic/run-slavic-benchmark.mjs --languages=ukr_Cyrl,bul_Cyrl
//
// Requires QDRANT_URL / QDRANT_KEY (Semidex's own bootstrapEnv()). Uses
// only fetchAndValidateLanguage() from fetch-belebele.mjs — never fetches
// or rebuilds silently on cache mismatch (that module's own validation
// throws first).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { AutoTokenizer } from '@huggingface/transformers';

import { bootstrapEnv } from '../../../src/core/env-bootstrap.js';
import { embedOnnxBatch } from '../../../src/core/onnx-embed.js';
import { ONNX_DENSE_MODEL_ID, ONNX_CACHE_DIR } from '../../../src/core/onnx-paths.js';

import { computeMetrics, toTrecRunFormat } from '../beir/metrics.mjs';
import {
  makeRedactor as makeRedactorCore, describeEndpoint, buildClient, timed, withBoundedRetry,
  percentile, buildIdMapping,
} from '../beir/harness-core.mjs';
import { pairedBootstrapByQuery, perQueryMetrics, DEFAULT_BOOTSTRAP_SEED, DEFAULT_BOOTSTRAP_ITERATIONS } from '../miracl/bootstrap.mjs';

import { fetchAndValidateLanguage, BELEBELE_REPO, BELEBELE_REVISION, BELEBELE_LICENSE } from './fetch-belebele.mjs';
import {
  LANGUAGES, PROVIDER, RRF_K, TOP_K, HYBRID_PREFETCH_LIMIT, COLLECTION_PREFIX, collectionName,
  INDEX_BATCH_SIZE, RSS_TRACK_INTERVAL_MS, ONNX_MAX_SEQ_LENGTH, SMOKE_QUERY_COUNT, SMOKE_CORPUS_SIZE,
  BENCHMARK_CHECKPOINT_VERSION, parseLanguagesFlag,
} from './slavic-profiles.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
// Smoke writes TREC runs to a dedicated subdirectory so it can never
// overwrite the real benchmark's TREC files (same rationale/fix as
// benchmarks/external/fusion/run-rrf-sweep.mjs's SMOKE_RUNS_DIR — smoke
// reuses the same language codes as real runs, so the JSON report path
// alone isn't enough separation).
const RUNS_DIR = resolve(__dirname, '.runs');
const SMOKE_RUNS_DIR = resolve(__dirname, '.runs/smoke');
const RESULTS_DIR = resolve(__dirname, '../results');

const SMOKE = process.argv.includes('--smoke');
const RESUME_CHECK = process.argv.includes('--resume-check');
const RESUME = process.argv.includes('--resume') || RESUME_CHECK;
const RESTART = process.argv.includes('--restart');
const LANGUAGES_FLAG = process.argv.find((a) => a.startsWith('--languages='));

const REPORT_JSON_PATH = resolve(RESULTS_DIR, SMOKE ? '.slavic-belebele-smoke-report.json' : '2026-07-23-slavic-belebele-benchmark.json');
const REPORT_MD_PATH = resolve(RESULTS_DIR, '2026-07-23-slavic-belebele-benchmark.md');

function makeRedactor(secret) {
  return makeRedactorCore(secret, REPO_ROOT);
}

/** Writes JSON atomically: write to a sibling temp file, then rename over
 * the real path — a hard kill can only ever leave an unread temp file
 * behind, never a half-written real checkpoint (same fix as
 * benchmarks/external/fusion/run-rrf-sweep.mjs's writeJsonAtomic(), after
 * that module's own review-driven correction). */
function writeJsonAtomic(path, value) {
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, path);
}

/** A 404 from deleteCollection means the collection is already gone — a
 * successful cleanup outcome, not a failure (same fix as
 * run-rrf-sweep.mjs's isDeleteResultSuccessful(), carried over here from
 * the start rather than re-discovered later). */
function isDeleteResultSuccessful(delRes) {
  if (delRes.ok) return true;
  const status = delRes.err?.status ?? delRes.err?.response?.status ?? null;
  return status === 404;
}

function currentCommitHash() {
  try { return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim(); } catch { return null; }
}

function sdkVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'node_modules/@qdrant/js-client-rest/package.json'), 'utf-8'));
    return pkg.version;
  } catch { return null; }
}

function expectedMetricModes() {
  return ['dense', 'sparse', 'hybrid'];
}

/** A language is "complete" for --resume purposes only if it recorded
 * every mode's metrics for every query, indexing had zero errors, and
 * cleanup confirmed deletion. */
export function isCompletedLanguageCheckpoint(langReport, { queryCount }) {
  if (!langReport) return false;
  if (langReport.indexing?.documentsIndexed == null || langReport.indexing?.errors !== 0) return false;
  if (langReport.queryStats?.total !== queryCount || langReport.queryStats?.ran !== queryCount || langReport.queryStats?.errors !== 0) return false;
  if ((langReport.errors?.length ?? 0) !== 0 || langReport.cleanup?.deleted !== true) return false;
  return expectedMetricModes().every((mode) => {
    const m = langReport.metrics?.[mode];
    return m?.queryCount === queryCount && typeof m.ndcgAt10 === 'number' && Number.isFinite(m.ndcgAt10);
  });
}

/** --smoke: shrinks an already-loaded language's dataset to a tiny
 * deterministic subset while preserving every relevant document required
 * by the selected queries' qrels — every query in this dataset has exactly
 * one relevant doc, so this always keeps exactly SMOKE_QUERY_COUNT
 * relevant docs plus padding up to SMOKE_CORPUS_SIZE. */
export function shrinkForSmoke(task, { queryCount = SMOKE_QUERY_COUNT, corpusSize = SMOKE_CORPUS_SIZE } = {}) {
  const { corpus, queries, qrels } = task;
  const testQids = [...queries.keys()].slice(0, queryCount);
  const keepDocIds = new Set();
  for (const qid of testQids) {
    const qr = qrels.get(qid);
    if (qr) for (const docId of qr.keys()) keepDocIds.add(docId);
  }
  for (const docId of corpus.keys()) {
    if (keepDocIds.size >= corpusSize) break;
    keepDocIds.add(docId);
  }
  const smallCorpus = new Map([...corpus.entries()].filter(([id]) => keepDocIds.has(id)));
  const smallQueries = new Map(testQids.map((qid) => [qid, queries.get(qid)]));
  const smallQrels = new Map(testQids.map((qid) => [qid, qrels.get(qid)]));
  return { corpus: smallCorpus, queries: smallQueries, qrels: smallQrels };
}

export function normalizeOnnxExecutionProvider(value) {
  const normalized = (value ?? '').trim().toLowerCase();
  return ['cpu', 'dml', 'cuda'].includes(normalized) ? normalized : 'cpu';
}

export function buildBenchmarkContract({
  languageCodes,
  corpusSize,
  queryCount,
  onnxExecutionProviderRequested,
}) {
  return {
    version: BENCHMARK_CHECKPOINT_VERSION,
    languageCodes,
    rrfK: RRF_K,
    topK: TOP_K,
    hybridPrefetchLimit: HYBRID_PREFETCH_LIMIT,
    datasetRepo: BELEBELE_REPO,
    datasetRevision: BELEBELE_REVISION,
    corpusSizePerLanguage: corpusSize,
    queryCountPerLanguage: queryCount,
    onnxExecutionProviderRequested,
  };
}

export function validateResumeCheckpoint(previous, contract) {
  if (!previous || typeof previous !== 'object') throw new Error('Resume checkpoint is not a JSON object.');
  if (!previous.benchmarkContract) throw new Error('Resume checkpoint has no benchmarkContract — cannot validate compatibility; use --restart.');
  if (JSON.stringify(previous.benchmarkContract) !== JSON.stringify(contract)) {
    throw new Error('Resume checkpoint contract does not match the current language/dataset configuration.');
  }
  for (const code of Object.keys(previous.languages ?? {})) {
    if (!contract.languageCodes.includes(code)) throw new Error(`Resume checkpoint contains unknown language: ${code}`);
  }
  return true;
}

/** Recomputes cleanupSummary/errors from CURRENT report.languages, never
 * by accumulating across a --resume (same fix as run-rrf-sweep.mjs's
 * rebuildReportAggregates(), applied here from the start). */
export function rebuildReportAggregates(report) {
  const languages = Object.values(report.languages ?? {});
  report.cleanupSummary = {
    attempted: languages.filter((l) => l.cleanup?.attempted).length,
    deleted: languages.filter((l) => l.cleanup?.deleted).length,
    failed: languages
      .filter((l) => l.cleanup?.attempted && !l.cleanup?.deleted)
      .map((l) => ({ langCode: l.langCode, collection: l.cleanup?.collection, error: l.cleanup?.error })),
  };
  report.errors = languages.flatMap((l) => (l.errors ?? []).map((error) => ({ langCode: l.langCode, ...error })));
}

/** If a previous interrupted run left this language's owned collection
 * behind, delete ONLY that exact collection name — verified to start with
 * COLLECTION_PREFIX — before re-running from scratch. Returns a result the
 * caller MUST check: on failure, the caller must not proceed to overwrite
 * the checkpoint recording the orphan (same contract as run-rrf-sweep.mjs's
 * cleanupOrphanedCollection(), applied here from the start). */
export async function cleanupOrphanedCollection({ client, redact, report, language }) {
  const prior = report.languages?.[language.code];
  if (!prior || prior.cleanup?.deleted) return { ok: true, collection: null };
  const orphan = prior.cleanup?.collection ?? prior.collection;
  if (!orphan || !orphan.startsWith(COLLECTION_PREFIX)) return { ok: true, collection: null };
  console.log(`[slavic-belebele] [${language.code}] found an orphaned collection from an interrupted run: ${orphan} — deleting before re-running`);
  const delRes = await withBoundedRetry(() => client.deleteCollection(orphan));
  if (!isDeleteResultSuccessful(delRes)) {
    const errorMessage = redact(delRes.err);
    console.error(`[slavic-belebele] [${language.code}] failed to delete orphaned collection ${orphan}: ${errorMessage}`);
    return { ok: false, collection: orphan, error: errorMessage };
  }
  return { ok: true, collection: orphan };
}

let tokenizerPromise;
function getTokenizer() {
  tokenizerPromise ??= AutoTokenizer.from_pretrained(ONNX_DENSE_MODEL_ID, { cache_dir: ONNX_CACHE_DIR });
  return tokenizerPromise;
}

/** Detects (never trims) texts exceeding ONNX_MAX_SEQ_LENGTH, using the
 * SAME tokenizer BGE-M3's own embedding call uses internally — this is
 * purely diagnostic counting, never a different truncation policy than
 * what embedOnnxBatch() already applies deterministically inside itself.
 * Returns { truncatedCount, total, tokenCounts } where tokenCounts is an
 * array aligned to `texts`, capped at MAX_SEQ_LENGTH+1 (a sentinel proving
 * "too long" without paying for the full tensor). */
async function detectTruncation(texts) {
  const tokenizer = await getTokenizer();
  const batchSize = 64;
  const tokenCounts = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const encoded = await tokenizer(batch, { padding: true, truncation: true, max_length: ONNX_MAX_SEQ_LENGTH + 1 });
    const [rows, cols] = encoded.attention_mask.dims;
    const mask = encoded.attention_mask.data;
    for (let row = 0; row < rows; row++) {
      let count = 0;
      for (let col = 0; col < cols; col++) count += Number(mask[row * cols + col]);
      tokenCounts.push(Math.min(count, ONNX_MAX_SEQ_LENGTH + 1));
    }
  }
  const truncatedCount = tokenCounts.filter((c) => c > ONNX_MAX_SEQ_LENGTH).length;
  return { truncatedCount, total: texts.length, tokenCounts };
}

async function main() {
  bootstrapEnv();
  if (RESUME && RESTART) throw new Error('Use either --resume or --restart, not both.');
  if (SMOKE && (RESUME || RESTART)) throw new Error('--resume/--restart are only valid for the full benchmark.');
  const languagesToRun = parseLanguagesFlag(LANGUAGES_FLAG ? LANGUAGES_FLAG.slice('--languages='.length) : null);
  if (!SMOKE) {
    if (RESUME && !existsSync(REPORT_JSON_PATH)) {
      throw new Error(`No checkpoint exists at ${REPORT_JSON_PATH}. Start without --resume.`);
    }
    if (!RESUME && !RESTART && existsSync(REPORT_JSON_PATH)) {
      throw new Error(`A benchmark checkpoint already exists at ${REPORT_JSON_PATH}. Use --resume to continue it or --restart to replace it.`);
    }
  }

  const redact = makeRedactor(process.env.QDRANT_KEY);
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(SMOKE_RUNS_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const effectiveRunsDir = SMOKE ? SMOKE_RUNS_DIR : RUNS_DIR;
  const effectiveRunsDirLabel = SMOKE ? '.runs/smoke' : '.runs';

  const peakRss = { bytes: process.memoryUsage().rss };
  const trackRss = () => { const cur = process.memoryUsage().rss; if (cur > peakRss.bytes) peakRss.bytes = cur; };
  const rssTimer = setInterval(trackRss, RSS_TRACK_INTERVAL_MS);
  rssTimer.unref();

  const client = buildClient();
  const effectiveLanguages = SMOKE ? languagesToRun.slice(0, 1) : languagesToRun;
  const onnxExecutionProviderRequested = normalizeOnnxExecutionProvider(process.env.ONNX_EXECUTION_PROVIDER);
  console.log(`[slavic-belebele] languages: ${effectiveLanguages.map((l) => l.code).join(', ')}${SMOKE ? ' (SMOKE MODE)' : ''}`);
  console.log(`[slavic-belebele] provider: BGE-M3 ONNX only, hybrid RRF_K=${RRF_K} (equal, no sweep)`);
  console.log(`[slavic-belebele] ONNX execution provider requested: ${onnxExecutionProviderRequested}`);

  const contract = buildBenchmarkContract({
    languageCodes: effectiveLanguages.map((l) => l.code),
    corpusSize: SMOKE ? SMOKE_CORPUS_SIZE : 488,
    queryCount: SMOKE ? SMOKE_QUERY_COUNT : 900,
    onnxExecutionProviderRequested,
  });

  if (RESUME_CHECK) {
    const previous = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf-8'));
    validateResumeCheckpoint(previous, contract);
    const completed = effectiveLanguages.filter((l) => isCompletedLanguageCheckpoint(previous.languages?.[l.code], { queryCount: contract.queryCountPerLanguage })).map((l) => l.code);
    const pending = effectiveLanguages.map((l) => l.code).filter((code) => !completed.includes(code));
    clearInterval(rssTimer);
    console.log(`[slavic-belebele] resume checkpoint valid: ${completed.length}/${effectiveLanguages.length} languages complete`);
    console.log(`[slavic-belebele] completed: ${completed.join(', ') || '(none)'}`);
    console.log(`[slavic-belebele] pending: ${pending.join(', ') || '(none)'}`);
    return;
  }

  let report;
  if (RESUME) {
    const previous = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf-8'));
    validateResumeCheckpoint(previous, contract);
    report = {
      ...previous,
      benchmarkContract: contract,
      resumeEvents: [...(previous.resumeEvents ?? []), { resumedAt: new Date().toISOString() }],
      verdict: null,
      environment: {
        ...previous.environment,
        priorPeakRssBytes: previous.environment?.peakRssBytes ?? previous.environment?.priorPeakRssBytes ?? null,
      },
    };
    delete report.finishedAt;
    rebuildReportAggregates(report);
    console.log(`[slavic-belebele] checkpoint loaded: ${Object.keys(report.languages ?? {}).length} languages recorded`);
  } else {
    if (RESTART && existsSync(REPORT_JSON_PATH)) {
      let discarded;
      try { discarded = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf-8')); } catch { discarded = null; }
      if (discarded?.languages) {
        for (const langCode of Object.keys(discarded.languages)) {
          const result = await cleanupOrphanedCollection({ client, redact, report: discarded, language: { code: langCode } });
          if (!result.ok) {
            clearInterval(rssTimer);
            throw new Error(`[slavic-belebele] refusing to --restart: failed to clean up an orphaned collection from the checkpoint being discarded, language "${langCode}" (${result.collection}). Fix the Qdrant connectivity/permissions issue and retry --restart — the old checkpoint has not been touched. Underlying error: ${result.error}`);
          }
        }
      }
    }
    report = {
      startedAt: new Date().toISOString(),
      benchmarkContract: contract,
      environment: {
        qdrantEndpoint: describeEndpoint(process.env.QDRANT_URL),
        qdrantKeyConfigured: Boolean(process.env.QDRANT_KEY),
        datasetLicense: BELEBELE_LICENSE,
        onnxExecutionProviderRequested,
      },
      languages: {},
      macroSummary: {},
      errors: [],
      cleanupSummary: { attempted: 0, deleted: 0, failed: [] },
      verdict: null,
    };
  }
  writeJsonAtomic(REPORT_JSON_PATH, report);

  // Strictly sequential — one language at a time, never Promise.all(), and
  // never more than one Qdrant collection or ONNX embedding call in
  // flight at once.
  for (const language of effectiveLanguages) {
    if (RESUME && isCompletedLanguageCheckpoint(report.languages?.[language.code], { queryCount: contract.queryCountPerLanguage })) {
      console.log(`[slavic-belebele] --- language: ${language.code} (checkpoint complete, skipping) ---`);
      continue;
    }
    const orphanCleanup = await cleanupOrphanedCollection({ client, redact, report, language });
    if (!orphanCleanup.ok) {
      clearInterval(rssTimer);
      throw new Error(`[slavic-belebele] refusing to continue: failed to clean up an orphaned collection from a previous interrupted run for language "${language.code}" (${orphanCleanup.collection}). Fix the Qdrant connectivity/permissions issue and retry --resume or --restart — nothing in this run has been overwritten. Underlying error: ${orphanCleanup.error}`);
    }

    console.log(`\n[slavic-belebele] === language: ${language.code} (${language.label}, ${language.script}) ===`);
    let task = await fetchAndValidateLanguage(language.code, { log: (m) => console.log(m) });
    if (SMOKE) task = shrinkForSmoke(task);
    console.log(`[slavic-belebele] [${language.code}] dataset ready: ${task.corpus.size} docs, ${task.queries.size} queries`);

    const langPeakRss = { bytes: process.memoryUsage().rss };
    const trackLangRss = () => {
      const cur = process.memoryUsage().rss;
      if (cur > langPeakRss.bytes) langPeakRss.bytes = cur;
      trackRss();
    };

    const collectionSuffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
    const plannedCollection = collectionName(language.code, collectionSuffix);
    // Persist the collection name BEFORE createCollection() is even
    // called — closes the orphan-tracking window entirely (same fix
    // pattern as run-rrf-sweep.mjs's pre-flight checkpoint write).
    report.languages[language.code] = {
      langCode: language.code, status: 'planned', collection: plannedCollection,
      cleanup: { attempted: false, deleted: false, collection: plannedCollection, error: null },
    };
    writeJsonAtomic(REPORT_JSON_PATH, report);

    const langReport = await executeLanguage({
      client, redact, language, task, trackRss: trackLangRss,
      runsDir: effectiveRunsDir, runsDirLabel: effectiveRunsDirLabel,
      collection: plannedCollection,
    });
    langReport.provenance = {
      commitHash: currentCommitHash(),
      qdrantSdkVersion: sdkVersion(),
      onnxExecutionProviderRequested,
      denseModelId: PROVIDER.denseModelId,
      sparseModelId: PROVIDER.sparseModelId,
      datasetRepo: BELEBELE_REPO,
      datasetRevision: BELEBELE_REVISION,
      corpusSize: task.corpus.size,
      queryCount: task.queries.size,
      peakRssBytes: langPeakRss.bytes,
    };
    report.languages[language.code] = langReport;
    rebuildReportAggregates(report);
    writeJsonAtomic(REPORT_JSON_PATH, report);
  }

  if (!SMOKE) {
    report.macroSummary = computeMacroSummary(report.languages);
  }

  clearInterval(rssTimer);
  trackRss();
  report.environment.peakRssBytes = Math.max(peakRss.bytes, report.environment.priorPeakRssBytes ?? 0);
  report.finishedAt = new Date().toISOString();
  report.verdict = computeVerdict(report, effectiveLanguages, contract);
  writeJsonAtomic(REPORT_JSON_PATH, report);
  if (!SMOKE) writeFileSync(REPORT_MD_PATH, renderMarkdownReport(report), 'utf-8');

  console.log('\n[slavic-belebele] === SUMMARY ===');
  for (const [code, r] of Object.entries(report.languages)) {
    console.log(`${code}: dense=${r.metrics?.dense?.ndcgAt10?.toFixed(4) ?? 'n/a'} sparse=${r.metrics?.sparse?.ndcgAt10?.toFixed(4) ?? 'n/a'} hybrid=${r.metrics?.hybrid?.ndcgAt10?.toFixed(4) ?? 'n/a'} | cleanup=${r.cleanup?.deleted ? 'ok' : 'FAILED'}`);
  }
  console.log('peak RSS:', (peakRss.bytes / 1e6).toFixed(0), 'MB');
  console.log('verdict:', report.verdict);
  console.log('report json:', REPORT_JSON_PATH.replace(REPO_ROOT, '.'));

  if (report.cleanupSummary.failed.length > 0) {
    console.error('\n!! CLEANUP FAILURES:');
    for (const f of report.cleanupSummary.failed) console.error(`!!   ${f.langCode}: ${f.collection}`);
    process.exitCode = 1;
  }
}

/** Runs ONE language end to end: create collection -> index corpus ONCE
 * (batched, dense+sparse from the SAME embedOnnxBatch() call) -> for every
 * query: one dense-only query, one sparse-only query, one equal-RRF hybrid
 * query -> compute metrics (aggregate + per-query for bootstrap) -> sparse
 * diagnostics -> write TREC runs -> cleanup. Cleanup always runs in
 * `finally`, guarded to the exact collection prefix. */
export async function executeLanguage({
  client, redact, language, task, trackRss = () => {},
  embedBatch = embedOnnxBatch,
  writeTrecRun = (path, content) => writeFileSync(path, content, 'utf-8'),
  runsDir = RUNS_DIR,
  runsDirLabel = '.runs',
  collection = collectionName(language.code, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`),
}) {
  const { corpus, queries, qrels } = task;

  const langReport = {
    langCode: language.code, script: language.script, label: language.label, collection,
    indexing: { wallMs: null, documentsIndexed: 0, batches: 0, errors: 0, retries: 0 },
    queryStats: {
      total: queries.size, ran: 0, errors: 0, retries: 0,
      latencyMs: { dense: [], sparse: [], hybrid: [] },
    },
    metrics: {},
    perQueryMetrics: {},
    comparisons: {},
    trecRunPaths: {},
    sparseDiagnostics: null,
    cleanup: { attempted: false, deleted: false, collection, error: null },
    errors: [],
  };

  const idMap = buildIdMapping([...corpus.keys()], `${collection}:doc`);
  if (idMap.collisions.length > 0) {
    langReport.errors.push({ step: 'id_mapping', error: `${idMap.collisions.length} point-ID collisions detected in doc ID mapping — aborting language` });
    return langReport;
  }

  // Truncation diagnostics — detection only, never a different truncation
  // policy per language. Uses the SAME tokenizer/max_length embedOnnxBatch()
  // applies internally.
  const docTexts = [...corpus.values()].map((d) => d.text);
  const queryTexts = [...queries.values()];
  const [docTruncation, queryTruncation] = await Promise.all([
    detectTruncation(docTexts),
    detectTruncation(queryTexts),
  ]);
  langReport.truncation = {
    documents: { truncated: docTruncation.truncatedCount, total: docTruncation.total },
    queries: { truncated: queryTruncation.truncatedCount, total: queryTruncation.total },
  };

  try {
    const vectors = { dense: { size: PROVIDER.denseSize, distance: 'Cosine' } };
    const sparse_vectors = { sparse: { index: { on_disk: false } } }; // BGE-M3 learned sparse, not BM25 — no idf modifier (matches production schema)
    const createRes = await withBoundedRetry(() => client.createCollection(collection, { vectors, sparse_vectors }));
    if (!createRes.ok) {
      langReport.errors.push({ step: 'create_collection', error: redact(createRes.err) });
      return langReport;
    }

    // ── index corpus ONCE, in bounded batches — dense+sparse from the
    // SAME embedOnnxBatch() call per batch, never separate passes. ──────
    const indexStart = process.hrtime.bigint();
    const docIds = [...corpus.keys()];
    const sparseNonZeroByDocId = new Map();
    // Retains only the SET of non-zero sparse token indices per document
    // (not the weight values, not the dense vector) — bounded by corpus
    // size (<=488 documents for the real benchmark, <=SMOKE_CORPUS_SIZE
    // for smoke), needed to compute a real query<->relevant-doc sparse
    // token-overlap diagnostic below rather than leaving that metric
    // unimplemented.
    const sparseIndexSetByDocId = new Map();
    for (let i = 0; i < docIds.length; i += INDEX_BATCH_SIZE) {
      const batchIds = docIds.slice(i, i + INDEX_BATCH_SIZE);
      const bodies = batchIds.map((id) => corpus.get(id).text);
      const embedRes = await timed(() => embedBatch(bodies));
      if (!embedRes.ok) {
        langReport.indexing.errors += 1;
        langReport.errors.push({ step: 'embed_batch', error: redact(embedRes.err) });
        continue;
      }
      const points = batchIds.map((docId, j) => {
        const { dense, sparse } = embedRes.value[j];
        sparseNonZeroByDocId.set(docId, sparse.indices.length);
        sparseIndexSetByDocId.set(docId, new Set(sparse.indices));
        return {
          id: idMap.toPoint.get(docId),
          payload: { doc_id: docId, benchmark: 'slavic-belebele', language: language.code },
          vector: { dense, sparse: { indices: sparse.indices, values: sparse.values } },
        };
      });
      const upsertRes = await withBoundedRetry(
        () => client.upsert(collection, { wait: true, points }),
        { onRetry: () => { langReport.indexing.retries += 1; } },
      );
      if (!upsertRes.ok) {
        langReport.indexing.errors += 1;
        langReport.errors.push({ step: `upsert_batch_${i}`, error: redact(upsertRes.err) });
      } else {
        langReport.indexing.documentsIndexed += points.length;
      }
      langReport.indexing.batches += 1;
      if (langReport.indexing.batches % 5 === 0) {
        console.log(`[slavic-belebele] [${language.code}] indexed ${langReport.indexing.documentsIndexed}/${docIds.length}`);
        trackRss();
      }
    }
    langReport.indexing.wallMs = Number((process.hrtime.bigint() - indexStart) / 1000000n);
    console.log(`[slavic-belebele] [${language.code}] indexing complete: ${langReport.indexing.documentsIndexed} docs in ${langReport.indexing.wallMs}ms`);

    // ── sequential queries: one dense, one sparse, one equal-RRF hybrid ──
    const emptyRun = () => new Map([...queries.keys()].map((qid) => [qid, []]));
    const denseRun = emptyRun();
    const sparseRun = emptyRun();
    const hybridRun = emptyRun();
    const sparseQueryNonZero = new Map();
    const sparseOverlapByQuery = new Map(); // qid -> fraction of query's non-zero token indices also present in its relevant doc

    let qi = 0;
    const queryEntries = [...queries.entries()];
    for (let queryBatchStart = 0; queryBatchStart < queryEntries.length; queryBatchStart += INDEX_BATCH_SIZE) {
      const queryBatch = queryEntries.slice(queryBatchStart, queryBatchStart + INDEX_BATCH_SIZE);
      const embedRes = await timed(() => embedBatch(queryBatch.map(([, queryBody]) => queryBody)));
      if (!embedRes.ok) {
        langReport.queryStats.errors += queryBatch.length;
        langReport.errors.push({
          step: `embed_query_batch_${queryBatchStart}`,
          queryCount: queryBatch.length,
          error: redact(embedRes.err),
        });
        continue;
      }

      for (let queryOffset = 0; queryOffset < queryBatch.length; queryOffset++) {
        const [queryId] = queryBatch[queryOffset];
        qi += 1;
        const { dense, sparse } = embedRes.value[queryOffset];
        sparseQueryNonZero.set(queryId, sparse.indices.length);
        const queryVectors = { dense, sparse: { indices: sparse.indices, values: sparse.values } };

        const denseQ = await withBoundedRetry(
          () => client.query(collection, { query: queryVectors.dense, using: 'dense', limit: TOP_K, with_payload: false }),
          { onRetry: () => { langReport.queryStats.retries += 1; } },
        );
        const sparseQ = await withBoundedRetry(
          () => client.query(collection, { query: queryVectors.sparse, using: 'sparse', limit: TOP_K, with_payload: false }),
          { onRetry: () => { langReport.queryStats.retries += 1; } },
        );
        const hybridQ = await withBoundedRetry(
          () => client.query(collection, {
            prefetch: [
              { query: queryVectors.dense, using: 'dense', limit: HYBRID_PREFETCH_LIMIT },
              { query: queryVectors.sparse, using: 'sparse', limit: HYBRID_PREFETCH_LIMIT },
            ],
            query: { rrf: { k: RRF_K } },
            limit: TOP_K, with_payload: false,
          }),
          { onRetry: () => { langReport.queryStats.retries += 1; } },
        );

        const modeResults = [['dense', denseQ, denseRun], ['sparse', sparseQ, sparseRun], ['hybrid', hybridQ, hybridRun]];
        for (const [label, res, store] of modeResults) {
          if (res.ok) {
            langReport.queryStats.latencyMs[label].push(res.ms);
            const points = res.value?.points ?? [];
            store.set(queryId, points.map((p) => ({ docId: idMap.toString.get(String(p.id)) ?? String(p.id), score: p.score })));
          } else {
            langReport.queryStats.errors += 1;
            langReport.errors.push({ step: `query_${label}_${queryId}`, error: redact(res.err) });
            store.set(queryId, []);
          }
        }

        // Fraction of the query's non-zero sparse indices that also occur in
        // its relevant document. This is query-index coverage, not Jaccard:
        // the denominator is intentionally the query set size.
        const queryIndexSet = new Set(sparse.indices);
        const relevantDocIds = [...(qrels.get(queryId)?.keys() ?? [])];
        const overlaps = relevantDocIds.map((docId) => {
          const docIndexSet = sparseIndexSetByDocId.get(docId);
          if (!docIndexSet || queryIndexSet.size === 0) return null;
          let intersectionCount = 0;
          for (const idx of queryIndexSet) if (docIndexSet.has(idx)) intersectionCount += 1;
          return intersectionCount / queryIndexSet.size;
        }).filter((v) => v !== null);
        sparseOverlapByQuery.set(queryId, overlaps.length ? overlaps.reduce((s, v) => s + v, 0) / overlaps.length : null);

        langReport.queryStats.ran += 1;
        if (qi % 100 === 0) { console.log(`[slavic-belebele] [${language.code}] queries ${qi}/${queries.size}`); trackRss(); }
      }
    }

    // ── metrics + TREC run persistence ───────────────────────────────────
    const toRankedMap = (scoredMap) => {
      const m = new Map();
      for (const [qid, docs] of scoredMap.entries()) m.set(qid, docs.map((d) => d.docId));
      return m;
    };
    const rankedByMode = { dense: toRankedMap(denseRun), sparse: toRankedMap(sparseRun), hybrid: toRankedMap(hybridRun) };
    for (const [label, ranked] of Object.entries(rankedByMode)) {
      langReport.metrics[label] = computeMetrics(qrels, ranked);
      langReport.perQueryMetrics[label] = [...perQueryMetrics(qrels, ranked).entries()];
    }

    const allModeStores = [['dense', denseRun], ['sparse', sparseRun], ['hybrid', hybridRun]];
    for (const [label, scoredMap] of allModeStores) {
      const trecPath = join(runsDir, `${language.code}-${label}.trec`);
      writeTrecRun(trecPath, toTrecRunFormat(scoredMap, `slavic-belebele-${language.code}-${label}`));
      langReport.trecRunPaths[label] = trecPath.replace(runsDir, runsDirLabel);
    }

    for (const label of Object.keys(rankedByMode)) {
      const arr = [...langReport.queryStats.latencyMs[label]].sort((a, b) => a - b);
      langReport.queryStats.latencyMs[label] = {
        p50: percentile(arr, 0.5), p95: percentile(arr, 0.95), max: arr.length ? arr[arr.length - 1] : null, count: arr.length,
      };
    }

    // ── comparisons: hybrid vs dense, dense vs sparse ─────────────────────
    const pq = Object.fromEntries(Object.entries(langReport.perQueryMetrics).map(([label, entries]) => [label, new Map(entries)]));
    if (pq.dense && pq.sparse) {
      // dense_vs_sparse: baseline=dense, comparison=sparse -> meanDelta = sparse − dense.
      langReport.comparisons.dense_vs_sparse = pairedBootstrapByQuery(pq.dense, pq.sparse, 'ndcgAt10');
    }
    if (pq.dense && pq.hybrid) {
      // hybrid_vs_dense: baseline=dense, comparison=hybrid -> meanDelta = hybrid − dense.
      langReport.comparisons.hybrid_vs_dense = pairedBootstrapByQuery(pq.dense, pq.hybrid, 'ndcgAt10');
    }

    // ── rescue/harm/tie for hybrid vs dense ───────────────────────────────
    langReport.rescueHarm = computeRescueHarm(qrels, rankedByMode.dense, rankedByMode.hybrid);

    // ── sparse diagnostics ─────────────────────────────────────────────
    langReport.sparseDiagnostics = computeSparseDiagnostics({
      qrels, rankedByMode, sparseNonZeroByDocId, sparseQueryNonZero, sparseOverlapByQuery,
    });
    langReport.sparseExamples = computeSparseExamples(qrels, rankedByMode.dense, rankedByMode.sparse);
  } catch (err) {
    langReport.errors.push({ step: 'fatal', error: redact(err) });
  } finally {
    langReport.cleanup.attempted = true;
    if (!collection.startsWith(COLLECTION_PREFIX)) {
      langReport.cleanup.error = `Refusing to delete: name does not start with ${COLLECTION_PREFIX}`;
    } else {
      const delRes = await withBoundedRetry(() => client.deleteCollection(collection));
      langReport.cleanup.deleted = isDeleteResultSuccessful(delRes);
      if (!langReport.cleanup.deleted) langReport.cleanup.error = redact(delRes.err);
    }
  }

  return langReport;
}

/** Per-query rescue/harm/tie classification for hybrid vs dense, plus
 * dense-only/sparse-only/both relevant-document overlap — mirroring the
 * offline fusion diagnosis's own classifyRescueHarm()/computeRelevantOverlap()
 * semantics (benchmarks/external/fusion/analyze-fusion.mjs), reimplemented
 * here rather than imported since that module's functions take saved TREC
 * runs, not live ranked maps, and importing across benchmark directories
 * for one function each would be a heavier dependency than duplicating
 * ~15 lines of paired-classification logic. */
function computeRescueHarm(qrels, denseRanked, hybridRanked) {
  let rescues = 0; let harms = 0; let ties = 0;
  const examples = { rescues: [], harms: [] };
  for (const [qid, qrelsForQuery] of qrels.entries()) {
    const denseTop10 = denseRanked.get(qid) ?? [];
    const hybridTop10 = hybridRanked.get(qid) ?? [];
    const ndcg = (ranked) => {
      const topK = ranked.slice(0, 10);
      for (let i = 0; i < topK.length; i++) {
        if (qrelsForQuery.has(topK[i])) return 1 / Math.log2(i + 2);
      }
      return 0;
    };
    const denseNdcg = ndcg(denseTop10);
    const hybridNdcg = ndcg(hybridTop10);
    const delta = hybridNdcg - denseNdcg;
    const entry = { qid, denseNdcg, hybridNdcg, delta };
    if (delta > 0) { rescues += 1; examples.rescues.push(entry); }
    else if (delta < 0) { harms += 1; examples.harms.push(entry); }
    else ties += 1;
  }
  examples.rescues.sort((a, b) => b.delta - a.delta);
  examples.harms.sort((a, b) => a.delta - b.delta);
  return {
    rescues, harms, ties,
    topRescues: examples.rescues.slice(0, 3),
    topHarms: examples.harms.slice(0, 3),
  };
}

/** Biggest sparse wins/failures RELATIVE TO DENSE (not hybrid) — per-query
 * sparse nDCG@10 minus dense nDCG@10, sorted to the largest positive
 * (sparse win) and largest negative (sparse failure) deltas. Distinct from
 * computeRescueHarm() above, which classifies hybrid vs dense, not sparse
 * vs dense directly — the task asks for both, separately. */
function computeSparseExamples(qrels, denseRanked, sparseRanked) {
  const ndcg = (ranked, qrelsForQuery) => {
    const topK = ranked.slice(0, 10);
    for (let i = 0; i < topK.length; i++) {
      if (qrelsForQuery.has(topK[i])) return 1 / Math.log2(i + 2);
    }
    return 0;
  };
  const deltas = [];
  for (const [qid, qrelsForQuery] of qrels.entries()) {
    const denseNdcg = ndcg(denseRanked.get(qid) ?? [], qrelsForQuery);
    const sparseNdcg = ndcg(sparseRanked.get(qid) ?? [], qrelsForQuery);
    deltas.push({ qid, denseNdcg, sparseNdcg, delta: sparseNdcg - denseNdcg });
  }
  const wins = deltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta);
  const failures = deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta);
  return { topSparseWins: wins.slice(0, 3), topSparseFailures: failures.slice(0, 3) };
}

/** Aggregates sparse-channel diagnostics: mean non-zero sparse weights for
 * queries/docs, mean query<->relevant-doc sparse token-index overlap, and
 * dense-only/sparse-only/both relevant-document hit counts (document-query
 * pair counts, not query counts — same counting unit as the offline fusion
 * diagnosis, to avoid repeating that module's own review-fixed denominator
 * confusion). No causal/morphological conclusion is drawn here — this
 * function only computes numbers; any interpretation belongs in the report
 * as an explicitly labeled hypothesis. */
function computeSparseDiagnostics({ qrels, rankedByMode, sparseNonZeroByDocId, sparseQueryNonZero, sparseOverlapByQuery }) {
  const docCounts = [...sparseNonZeroByDocId.values()];
  const queryCounts = [...sparseQueryNonZero.values()];
  const overlapValues = [...sparseOverlapByQuery.values()].filter((v) => v !== null);
  const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

  let denseOnlyHits = 0; let sparseOnlyHits = 0; let bothHits = 0; let neitherHits = 0;
  for (const [qid, qrelsForQuery] of qrels.entries()) {
    const denseTop10 = new Set((rankedByMode.dense.get(qid) ?? []).slice(0, 10));
    const sparseTop10 = new Set((rankedByMode.sparse.get(qid) ?? []).slice(0, 10));
    for (const docId of qrelsForQuery.keys()) {
      const inDense = denseTop10.has(docId);
      const inSparse = sparseTop10.has(docId);
      if (inDense && inSparse) bothHits += 1;
      else if (inDense) denseOnlyHits += 1;
      else if (inSparse) sparseOnlyHits += 1;
      else neitherHits += 1;
    }
  }

  return {
    meanSparseNonZeroDocs: mean(docCounts),
    meanSparseNonZeroQueries: mean(queryCounts),
    meanQuerySparseIndexCoverageInRelevantDoc: mean(overlapValues),
    relevantDocOverlap: { denseOnlyHits, sparseOnlyHits, bothHits, neitherHits },
  };
}

/** Macro summary — DESCRIPTIVE ONLY, never a substitute for or statistical
 * claim about per-language results. Groups by script (Cyrillic/Latin) and
 * separately reports the English control. */
export function computeMacroSummary(languages) {
  const byScript = { Cyrillic: [], Latin: [] };
  let englishControl = null;
  for (const [code, r] of Object.entries(languages)) {
    if (!r.metrics?.dense) continue;
    if (code === 'eng_Latn') { englishControl = { ndcgAt10Dense: r.metrics.dense.ndcgAt10, ndcgAt10Sparse: r.metrics.sparse?.ndcgAt10 ?? null, ndcgAt10Hybrid: r.metrics.hybrid?.ndcgAt10 ?? null }; continue; }
    if (r.script === 'Cyrillic') byScript.Cyrillic.push(r);
    else if (r.script === 'Latin') byScript.Latin.push(r);
  }
  const meanOf = (arr, path) => {
    const vals = arr.map((r) => path(r)).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  return {
    note: 'DESCRIPTIVE ONLY — never a statistical claim about script/language effects. See per-language results for the actual evidence.',
    cyrillicAverage: {
      languageCount: byScript.Cyrillic.length,
      ndcgAt10Dense: meanOf(byScript.Cyrillic, (r) => r.metrics.dense.ndcgAt10),
      ndcgAt10Sparse: meanOf(byScript.Cyrillic, (r) => r.metrics.sparse?.ndcgAt10),
      ndcgAt10Hybrid: meanOf(byScript.Cyrillic, (r) => r.metrics.hybrid?.ndcgAt10),
    },
    latinAverage: {
      languageCount: byScript.Latin.length,
      ndcgAt10Dense: meanOf(byScript.Latin, (r) => r.metrics.dense.ndcgAt10),
      ndcgAt10Sparse: meanOf(byScript.Latin, (r) => r.metrics.sparse?.ndcgAt10),
      ndcgAt10Hybrid: meanOf(byScript.Latin, (r) => r.metrics.hybrid?.ndcgAt10),
    },
    englishControl,
  };
}

function metricsAreFullyValid(m, expectedQueryCount) {
  if (!m || m.queryCount !== expectedQueryCount) return false;
  const fields = ['ndcgAt10', 'mapAt100', 'recallAt10', 'recallAt100', 'precisionAt10', 'mrrAt10'];
  return fields.every((f) => typeof m[f] === 'number' && Number.isFinite(m[f]));
}

export function computeVerdict(report, languagesRun, contract) {
  const expectedCodes = new Set(languagesRun.map((l) => l.code));
  const completedCodes = new Set(Object.keys(report.languages));
  const allPresent = expectedCodes.size === completedCodes.size && [...expectedCodes].every((c) => completedCodes.has(c));
  if (!allPresent) return SMOKE ? 'SLAVIC_BELEBELE_SMOKE_BLOCKED' : 'SLAVIC_BELEBELE_HARNESS_BLOCKED';

  const cleanupOk = report.cleanupSummary.failed.length === 0;
  let anyMetricsValid = false;
  let allMetricsValid = true;
  let anyRequestErrors = false;
  for (const langReport of Object.values(report.languages)) {
    const metricsOk = expectedMetricModes().every((mode) => metricsAreFullyValid(langReport.metrics?.[mode], contract.queryCountPerLanguage));
    if (metricsOk) anyMetricsValid = true; else allMetricsValid = false;
    if ((langReport.errors?.length ?? 0) > 0 || langReport.queryStats.errors > 0 || langReport.indexing.errors > 0) anyRequestErrors = true;
  }

  const prefix = SMOKE ? 'SLAVIC_BELEBELE_SMOKE' : 'SLAVIC_BELEBELE_HARNESS';
  if (allMetricsValid && cleanupOk && !anyRequestErrors) return `${prefix}_ACCEPT`;
  if (anyMetricsValid) return `${prefix}_PARTIAL`;
  return `${prefix}_REJECT`;
}

function metricCell(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : 'n/a';
}

function bootstrapCell(cmp) {
  if (!cmp) return 'n/a';
  const ci = cmp.ciLow !== null ? `[${cmp.ciLow.toFixed(4)}, ${cmp.ciHigh.toFixed(4)}]` : 'n/a';
  return `${cmp.verdict} (meanΔ=${cmp.meanDelta !== null ? cmp.meanDelta.toFixed(4) : 'n/a'}, CI95%=${ci}, W/L/T=${cmp.wins}/${cmp.losses}/${cmp.ties}, n=${cmp.n})`;
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push('# Slavic dense vs sparse benchmark — mteb/belebele');
  lines.push('');
  lines.push(`Verdict: **${report.verdict}**`);
  lines.push('');
  lines.push('Isolates the LANGUAGE factor: local BGE-M3 ONNX dense+learned-sparse');
  lines.push('only, one fixed equal-RRF hybrid mode (k=60), no Qdrant Cloud E5/BM25.');
  lines.push('Qrels are MRC-derived (one relevant passage per question, synthesized');
  lines.push('from mteb/belebele exactly as MTEB\'s own BelebeleRetrieval task does) —');
  lines.push('never pooled IR judgments. See the companion feasibility report for the');
  lines.push('full dataset contract and limitations.');
  lines.push('');
  lines.push('## Retrieval quality per language');
  lines.push('');
  lines.push('| Language | Script | Mode | nDCG@10 | MAP@100 | MRR@10 | Recall@10 | Recall@100 |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|');
  for (const [code, r] of Object.entries(report.languages)) {
    for (const [mode, m] of Object.entries(r.metrics ?? {})) {
      lines.push(`| ${code} | ${r.script} | ${mode} | ${metricCell(m.ndcgAt10)} | ${metricCell(m.mapAt100)} | ${metricCell(m.mrrAt10)} | ${metricCell(m.recallAt10)} | ${metricCell(m.recallAt100)} |`);
    }
  }
  lines.push('');
  lines.push('## Dense vs sparse vs hybrid comparisons (paired bootstrap, sign = comparison − baseline)');
  lines.push('');
  lines.push(`Seed: \`${DEFAULT_BOOTSTRAP_SEED}\`, iterations: ${DEFAULT_BOOTSTRAP_ITERATIONS}.`);
  lines.push('');
  for (const [code, r] of Object.entries(report.languages)) {
    lines.push(`### ${code} (${r.label})`);
    lines.push('');
    lines.push(`- **dense_vs_sparse**: ${bootstrapCell(r.comparisons?.dense_vs_sparse)}`);
    lines.push(`- **hybrid_vs_dense**: ${bootstrapCell(r.comparisons?.hybrid_vs_dense)}`);
    if (r.rescueHarm) lines.push(`- rescue/harm/tie (hybrid vs dense): ${r.rescueHarm.rescues}/${r.rescueHarm.harms}/${r.rescueHarm.ties}`);
    lines.push('');
  }
  lines.push('## Sparse diagnostics per language');
  lines.push('');
  lines.push('| Language | Mean non-zero sparse (docs) | Mean non-zero sparse (queries) | Mean query sparse-index coverage in relevant doc | Dense-only hits | Sparse-only hits | Both hits | Neither hits |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [code, r] of Object.entries(report.languages)) {
    const d = r.sparseDiagnostics;
    if (!d) continue;
    lines.push(`| ${code} | ${metricCell(d.meanSparseNonZeroDocs)} | ${metricCell(d.meanSparseNonZeroQueries)} | ${metricCell(d.meanQuerySparseIndexCoverageInRelevantDoc)} | ${d.relevantDocOverlap.denseOnlyHits} | ${d.relevantDocOverlap.sparseOnlyHits} | ${d.relevantDocOverlap.bothHits} | ${d.relevantDocOverlap.neitherHits} |`);
  }
  lines.push('');
  lines.push('HYPOTHESIS ONLY: these counts describe WHAT happened, not WHY. No');
  lines.push('morphological or linguistic causal conclusion is drawn from sparse');
  lines.push('token counts or overlap alone — any such explanation in this report is');
  lines.push('explicitly labeled as a hypothesis, never a proven mechanism.');
  lines.push('');
  lines.push('## Largest sparse wins / failures per language (sparse nDCG@10 − dense nDCG@10)');
  lines.push('');
  for (const [code, r] of Object.entries(report.languages)) {
    const ex = r.sparseExamples;
    if (!ex) continue;
    lines.push(`### ${code}`);
    lines.push('');
    lines.push('Wins (sparse beat dense):');
    for (const w of ex.topSparseWins) lines.push(`- ${w.qid}: dense=${metricCell(w.denseNdcg)} sparse=${metricCell(w.sparseNdcg)} Δ=${metricCell(w.delta)}`);
    if (ex.topSparseWins.length === 0) lines.push('- (none)');
    lines.push('Failures (sparse lost to dense):');
    for (const f of ex.topSparseFailures) lines.push(`- ${f.qid}: dense=${metricCell(f.denseNdcg)} sparse=${metricCell(f.sparseNdcg)} Δ=${metricCell(f.delta)}`);
    if (ex.topSparseFailures.length === 0) lines.push('- (none)');
    lines.push('');
  }
  lines.push('## Truncation');
  lines.push('');
  lines.push('| Language | Documents truncated | Queries truncated |');
  lines.push('|---|---:|---:|');
  for (const [code, r] of Object.entries(report.languages)) {
    if (!r.truncation) continue;
    lines.push(`| ${code} | ${r.truncation.documents.truncated}/${r.truncation.documents.total} | ${r.truncation.queries.truncated}/${r.truncation.queries.total} |`);
  }
  lines.push('');
  lines.push('## Macro summary (descriptive only)');
  lines.push('');
  lines.push(report.macroSummary?.note ?? 'n/a');
  lines.push('');
  lines.push('| Group | Languages | nDCG@10 dense | nDCG@10 sparse | nDCG@10 hybrid |');
  lines.push('|---|---:|---:|---:|---:|');
  if (report.macroSummary?.cyrillicAverage) {
    const c = report.macroSummary.cyrillicAverage;
    lines.push(`| Cyrillic average | ${c.languageCount} | ${metricCell(c.ndcgAt10Dense)} | ${metricCell(c.ndcgAt10Sparse)} | ${metricCell(c.ndcgAt10Hybrid)} |`);
  }
  if (report.macroSummary?.latinAverage) {
    const l = report.macroSummary.latinAverage;
    lines.push(`| Latin average | ${l.languageCount} | ${metricCell(l.ndcgAt10Dense)} | ${metricCell(l.ndcgAt10Sparse)} | ${metricCell(l.ndcgAt10Hybrid)} |`);
  }
  if (report.macroSummary?.englishControl) {
    const e = report.macroSummary.englishControl;
    lines.push(`| English control | 1 | ${metricCell(e.ndcgAt10Dense)} | ${metricCell(e.ndcgAt10Sparse)} | ${metricCell(e.ndcgAt10Hybrid)} |`);
  }
  lines.push('');
  lines.push('These aggregates never replace or outweigh per-language results, and');
  lines.push('are never presented as statistical evidence of a script effect.');
  lines.push('');
  lines.push('## Operations');
  lines.push('');
  lines.push('| Language | Indexed | Index wall ms | Query errors | Retries | Cleanup | Peak RSS |');
  lines.push('|---|---:|---:|---:|---:|---|---:|');
  for (const [code, r] of Object.entries(report.languages)) {
    lines.push(`| ${code} | ${r.indexing.documentsIndexed} | ${r.indexing.wallMs ?? 'n/a'} | ${r.queryStats.errors} | ${r.indexing.retries + r.queryStats.retries} | ${r.cleanup?.deleted ? 'deleted' : 'FAILED'} | ${r.provenance?.peakRssBytes ?? 'n/a'} |`);
  }
  lines.push(`\nPeak process RSS (whole run): ${report.environment.peakRssBytes ?? 'n/a'} bytes`);
  lines.push('');
  lines.push('## Interpretation limits');
  lines.push('');
  lines.push('- FACT: qrels are MRC-derived (one relevant passage per question),');
  lines.push('  never pooled IR judgments — see fetch-belebele.mjs\'s module header.');
  lines.push('- FACT: only the local BGE-M3 provider was measured — no Qdrant Cloud');
  lines.push('  E5/BM25 comparison in this run, by design.');
  lines.push('- FACT: bel_Cyrl and srp_Latn are confirmed absent from Belebele/');
  lines.push('  FLORES-200 and are not substituted or approximated anywhere here.');
  lines.push('- This benchmark does not recommend changing production RRF_K or');
  lines.push('  sparse-enablement defaults from this run alone.');
  lines.push('');
  if (report.errors?.length) {
    lines.push('## Errors', '', `Recorded errors: ${report.errors.length}. See the JSON report for redacted details.`, '');
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    const redact = makeRedactor(process.env.QDRANT_KEY);
    console.error('[slavic-belebele] unhandled error:', redact(err));
    process.exitCode = 1;
  });
}
