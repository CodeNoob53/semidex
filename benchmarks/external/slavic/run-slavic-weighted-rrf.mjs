// Live Slavic Belebele weighted-RRF fusion matrix (see fetch-belebele.mjs
// for the full dataset contract and MRC-derived-qrels caveat).
//
// Goal: determine whether sparse/equal-weight RRF regressions correlate
// with individual Slavic languages or script groups — using the SAME six
// fusion modes and rho -> sparseWeight conversion already validated by the
// live SciFact/MIRACL weighted-RRF benchmark
// (../fusion/run-weighted-rrf-live.mjs), imported from the shared
// ../fusion/weighted-rrf-fusion-modes.mjs module so neither harness can
// silently drift on mode definitions.
//
// Isolates the LANGUAGE factor exactly like run-slavic-benchmark.mjs: only
// the local BGE-M3 ONNX dense+learned-sparse provider — no Qdrant Cloud
// E5/BM25 profile.
//
// CUDA is an execution ACCELERATOR ONLY — never interpreted as a
// retrieval-quality variable, and CPU/DML/CUDA quality is never compared
// anywhere in this module. See ../fusion/weighted-rrf-cuda.mjs's module
// header. For a non-smoke full run, every language in this benchmark is a
// local scope, so the strict-CUDA pre-flight gate always applies unless
// --smoke is passed.
//
// Execution rule per language: ONE Qdrant collection, ONE indexing pass —
// dense AND sparse vectors for every document come from the SAME
// embedOnnxBatch() call (matches run-slavic-benchmark.mjs). Then per
// query: dense and sparse query vectors computed ONCE and reused for all
// six fusion modes (matches run-weighted-rrf-live.mjs) — the four hybrid
// modes share the identical prefetch spec, differing only in
// query.rrf.k/weights. Languages run strictly sequentially, never
// Promise.all().
//
// Run (full, 7 languages): node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs
// Resume:                  node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --resume
// Restart:                 node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --restart
// Check resume state only: node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --resume-check
// Smoke (tiny, separate path): node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --smoke
// Subset of languages:     node benchmarks/external/slavic/run-slavic-weighted-rrf.mjs --languages=ukr_Cyrl,bul_Cyrl
//
// Requires QDRANT_URL / QDRANT_KEY (Semidex's own bootstrapEnv()). Uses
// only fetchAndValidateLanguage() from fetch-belebele.mjs — never fetches
// or rebuilds silently on cache mismatch (that module's own validation
// throws first); confirmed offline-safe by this module's own test suite
// (replacing global.fetch with a throwing stub).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { AutoTokenizer } from '@huggingface/transformers';

import { bootstrapEnv } from '../../../src/core/env-bootstrap.js';
import { embedOnnxBatch, getOnnxProviderState } from '../../../src/core/onnx-embed.js';
import { ONNX_DENSE_MODEL_ID, ONNX_CACHE_DIR } from '../../../src/core/onnx-paths.js';

import { computeMetrics, toTrecRunFormat } from '../beir/metrics.mjs';
import {
  makeRedactor as makeRedactorCore, describeEndpoint, buildClient, timed, withBoundedRetry,
  percentile, buildIdMapping,
} from '../beir/harness-core.mjs';
import { pairedBootstrapByQuery, perQueryMetrics, DEFAULT_BOOTSTRAP_SEED, DEFAULT_BOOTSTRAP_ITERATIONS } from '../miracl/bootstrap.mjs';
import { verifyStrictCudaConfigured, verifyCudaProvenance } from '../fusion/weighted-rrf-cuda.mjs';

import { fetchAndValidateLanguage, BELEBELE_REPO, BELEBELE_REVISION, BELEBELE_LICENSE } from './fetch-belebele.mjs';
import {
  LANGUAGES, GROUPS, PROVIDER, FUSION_MODES, FUSION_MODE_IDS,
  PRIMARY_CANDIDATE_ID, DIAGNOSTIC_CANDIDATE_ID, EQUAL_RRF_CONTROL_IDS,
  TOP_K, HYBRID_PREFETCH_LIMIT, COLLECTION_PREFIX, collectionName,
  INDEX_BATCH_SIZE, RSS_TRACK_INTERVAL_MS, ONNX_MAX_SEQ_LENGTH,
  SMOKE_QUERY_COUNT, SMOKE_CORPUS_SIZE, BENCHMARK_CHECKPOINT_VERSION,
  parseLanguagesFlag,
} from './slavic-weighted-rrf-config.mjs';

export { verifyStrictCudaConfigured, verifyCudaProvenance };

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
// Smoke writes TREC runs to a dedicated subdirectory so it can never
// overwrite the real benchmark's TREC files (same rationale/fix as the
// other harnesses' SMOKE_RUNS_DIR — smoke reuses the same language codes
// as real runs, so the JSON report path alone isn't enough separation).
const RUNS_DIR = resolve(__dirname, '.runs-weighted-rrf');
const SMOKE_RUNS_DIR = resolve(__dirname, '.runs-weighted-rrf/smoke');
const RESULTS_DIR = resolve(__dirname, '../results');

const SMOKE = process.argv.includes('--smoke');
const RESUME_CHECK = process.argv.includes('--resume-check');
const RESUME = process.argv.includes('--resume') || RESUME_CHECK;
const RESTART = process.argv.includes('--restart');
const LANGUAGES_FLAG = process.argv.find((a) => a.startsWith('--languages='));

const REPORT_JSON_PATH = resolve(RESULTS_DIR, SMOKE ? '.slavic-weighted-rrf-smoke-report.json' : '2026-07-24-slavic-weighted-rrf.json');
const REPORT_MD_PATH = resolve(RESULTS_DIR, '2026-07-24-slavic-weighted-rrf.md');

function makeRedactor(secret) {
  return makeRedactorCore(secret, REPO_ROOT);
}

/** Writes JSON atomically: write to a sibling temp file, then rename over
 * the real path — a hard kill can only ever leave an unread temp file
 * behind, never a half-written real checkpoint. */
function writeJsonAtomic(path, value) {
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, path);
}

/** A 404 from deleteCollection means the collection is already gone — a
 * successful cleanup outcome, not a failure. */
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

/** Adapts a `{ code }` language entry into the `{ id, provider: { kind } }`
 * shape ../fusion/weighted-rrf-cuda.mjs's shared, generic CUDA-verification
 * functions expect. Every language in this benchmark uses the same single
 * local PROVIDER, so this is a pure, static mapping. */
function asCudaItem(language) {
  return { id: language.code, provider: PROVIDER };
}

/** A language is "complete" for --resume purposes only if it recorded
 * every one of the six fusion modes' metrics for every query, indexing had
 * zero errors, cleanup confirmed deletion, and CUDA provenance verification
 * passed (every language here is a local scope). */
export function isCompletedLanguageCheckpoint(langReport, { queryCount }) {
  if (!langReport) return false;
  if (langReport.indexing?.documentsIndexed == null || langReport.indexing?.errors !== 0) return false;
  if (langReport.queryStats?.total !== queryCount || langReport.queryStats?.ran !== queryCount || langReport.queryStats?.errors !== 0) return false;
  if ((langReport.errors?.length ?? 0) !== 0 || langReport.cleanup?.deleted !== true) return false;
  if (langReport.cudaVerification && langReport.cudaVerification.ok !== true) return false;
  return FUSION_MODE_IDS.every((mode) => {
    const m = langReport.metrics?.[mode];
    return m?.queryCount === queryCount && typeof m.ndcgAt10 === 'number' && Number.isFinite(m.ndcgAt10);
  });
}

/** --smoke: shrinks an already-loaded language's dataset to a tiny
 * deterministic subset while preserving every relevant document required
 * by the selected queries' qrels. */
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

export function buildBenchmarkContract({ languageCodes, corpusSize, queryCount }) {
  return {
    version: BENCHMARK_CHECKPOINT_VERSION,
    languageCodes,
    fusionModeIds: FUSION_MODE_IDS,
    topK: TOP_K,
    hybridPrefetchLimit: HYBRID_PREFETCH_LIMIT,
    datasetRepo: BELEBELE_REPO,
    datasetRevision: BELEBELE_REVISION,
    corpusSizePerLanguage: corpusSize,
    queryCountPerLanguage: queryCount,
  };
}

export function validateResumeCheckpoint(previous, contract) {
  if (!previous || typeof previous !== 'object') throw new Error('Resume checkpoint is not a JSON object.');
  if (!previous.benchmarkContract) throw new Error('Resume checkpoint has no benchmarkContract — cannot validate compatibility; use --restart.');
  if (JSON.stringify(previous.benchmarkContract) !== JSON.stringify(contract)) {
    throw new Error('Resume checkpoint contract does not match the current language/fusion-mode configuration.');
  }
  for (const code of Object.keys(previous.languages ?? {})) {
    if (!contract.languageCodes.includes(code)) throw new Error(`Resume checkpoint contains unknown language: ${code}`);
  }
  return true;
}

/** Recomputes cleanupSummary/errors from CURRENT report.languages, never by
 * accumulating across a --resume (same fix pattern as every other harness
 * in this repo's own review-driven history). */
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
 * COLLECTION_PREFIX — before re-running from scratch. */
export async function cleanupOrphanedCollection({ client, redact, report, language }) {
  const prior = report.languages?.[language.code];
  if (!prior || prior.cleanup?.deleted) return { ok: true, collection: null };
  const orphan = prior.cleanup?.collection ?? prior.collection;
  if (!orphan || !orphan.startsWith(COLLECTION_PREFIX)) return { ok: true, collection: null };
  console.log(`[slavic-weighted-rrf] [${language.code}] found an orphaned collection from an interrupted run: ${orphan} — deleting before re-running`);
  const delRes = await withBoundedRetry(() => client.deleteCollection(orphan));
  if (!isDeleteResultSuccessful(delRes)) {
    const errorMessage = redact(delRes.err);
    console.error(`[slavic-weighted-rrf] [${language.code}] failed to delete orphaned collection ${orphan}: ${errorMessage}`);
    return { ok: false, collection: orphan, error: errorMessage };
  }
  return { ok: true, collection: orphan };
}

let tokenizerPromise;
function getTokenizer() {
  tokenizerPromise ??= AutoTokenizer.from_pretrained(ONNX_DENSE_MODEL_ID, { cache_dir: ONNX_CACHE_DIR });
  return tokenizerPromise;
}

/** Detects (never trims) texts exceeding ONNX_MAX_SEQ_LENGTH — purely
 * diagnostic counting, matching run-slavic-benchmark.mjs's own
 * detectTruncation() exactly. */
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
  const effectiveRunsDirLabel = SMOKE ? '.runs-weighted-rrf/smoke' : '.runs-weighted-rrf';

  const peakRss = { bytes: process.memoryUsage().rss };
  const trackRss = () => { const cur = process.memoryUsage().rss; if (cur > peakRss.bytes) peakRss.bytes = cur; };
  const rssTimer = setInterval(trackRss, RSS_TRACK_INTERVAL_MS);
  rssTimer.unref();

  const client = buildClient();
  const effectiveLanguages = SMOKE ? languagesToRun.slice(0, 1) : languagesToRun;
  console.log(`[slavic-weighted-rrf] languages: ${effectiveLanguages.map((l) => l.code).join(', ')}${SMOKE ? ' (SMOKE MODE)' : ''}`);
  console.log(`[slavic-weighted-rrf] fusion modes: ${FUSION_MODE_IDS.join(', ')}`);

  // Pre-flight gate: the full benchmark must never index a language
  // without strict CUDA actually configured — checked BEFORE any
  // collection/indexing work. Every language here is a local scope, so
  // this always applies to a non-smoke, non-resume-check run. Smoke is
  // plumbing-only (never claims real CUDA numbers) and --resume-check is
  // read-only (no indexing happens), so both are exempt.
  if (!SMOKE && !RESUME_CHECK) {
    const cudaGate = verifyStrictCudaConfigured(effectiveLanguages.map(asCudaItem), process.env);
    if (!cudaGate.ok) {
      clearInterval(rssTimer);
      throw new Error(`[slavic-weighted-rrf] refusing to start: ${cudaGate.reason}`);
    }
  }

  const contract = buildBenchmarkContract({
    languageCodes: effectiveLanguages.map((l) => l.code),
    corpusSize: SMOKE ? SMOKE_CORPUS_SIZE : 488,
    queryCount: SMOKE ? SMOKE_QUERY_COUNT : 900,
  });

  if (RESUME_CHECK) {
    const previous = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf-8'));
    validateResumeCheckpoint(previous, contract);
    const completed = effectiveLanguages.filter((l) => isCompletedLanguageCheckpoint(previous.languages?.[l.code], { queryCount: contract.queryCountPerLanguage })).map((l) => l.code);
    const pending = effectiveLanguages.map((l) => l.code).filter((code) => !completed.includes(code));
    clearInterval(rssTimer);
    console.log(`[slavic-weighted-rrf] resume checkpoint valid: ${completed.length}/${effectiveLanguages.length} languages complete`);
    console.log(`[slavic-weighted-rrf] completed: ${completed.join(', ') || '(none)'}`);
    console.log(`[slavic-weighted-rrf] pending: ${pending.join(', ') || '(none)'}`);
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
    console.log(`[slavic-weighted-rrf] checkpoint loaded: ${Object.keys(report.languages ?? {}).length} languages recorded`);
  } else {
    if (RESTART && existsSync(REPORT_JSON_PATH)) {
      let discarded;
      try { discarded = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf-8')); } catch { discarded = null; }
      if (discarded?.languages) {
        for (const langCode of Object.keys(discarded.languages)) {
          const result = await cleanupOrphanedCollection({ client, redact, report: discarded, language: { code: langCode } });
          if (!result.ok) {
            clearInterval(rssTimer);
            throw new Error(`[slavic-weighted-rrf] refusing to --restart: failed to clean up an orphaned collection from the checkpoint being discarded, language "${langCode}" (${result.collection}). Fix the Qdrant connectivity/permissions issue and retry --restart — the old checkpoint has not been touched. Underlying error: ${result.error}`);
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
      },
      languages: {},
      groupSummaries: {},
      decisions: {},
      errors: [],
      cleanupSummary: { attempted: 0, deleted: 0, failed: [] },
      verdict: null,
    };
  }
  writeJsonAtomic(REPORT_JSON_PATH, report);

  // Strictly sequential — one language at a time, never Promise.all().
  for (const language of effectiveLanguages) {
    if (RESUME && isCompletedLanguageCheckpoint(report.languages?.[language.code], { queryCount: contract.queryCountPerLanguage })) {
      console.log(`[slavic-weighted-rrf] --- language: ${language.code} (checkpoint complete, skipping) ---`);
      continue;
    }
    const orphanCleanup = await cleanupOrphanedCollection({ client, redact, report, language });
    if (!orphanCleanup.ok) {
      clearInterval(rssTimer);
      throw new Error(`[slavic-weighted-rrf] refusing to continue: failed to clean up an orphaned collection from a previous interrupted run for language "${language.code}" (${orphanCleanup.collection}). Fix the Qdrant connectivity/permissions issue and retry --resume or --restart — nothing in this run has been overwritten. Underlying error: ${orphanCleanup.error}`);
    }

    console.log(`\n[slavic-weighted-rrf] === language: ${language.code} (${language.label}, ${language.script}) ===`);
    let task = await fetchAndValidateLanguage(language.code, { log: (m) => console.log(m) });
    if (SMOKE) task = shrinkForSmoke(task);
    console.log(`[slavic-weighted-rrf] [${language.code}] dataset ready: ${task.corpus.size} docs, ${task.queries.size} queries`);

    const langPeakRss = { bytes: process.memoryUsage().rss };
    const trackLangRss = () => {
      const cur = process.memoryUsage().rss;
      if (cur > langPeakRss.bytes) langPeakRss.bytes = cur;
      trackRss();
    };

    const collectionSuffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
    const plannedCollection = collectionName(language.code, collectionSuffix);
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
    const onnxProviderState = getOnnxProviderState();
    langReport.provenance = {
      commitHash: currentCommitHash(),
      qdrantSdkVersion: sdkVersion(),
      onnx: {
        requestedProvider: (process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu').trim().toLowerCase() || 'cpu',
        strictModeConfigured: process.env.ONNX_CUDA_STRICT === '1',
        effectiveProvider: onnxProviderState?.effective ?? null,
        fellBackToCpu: onnxProviderState?.fellBackToCpu ?? null,
      },
      denseModelId: PROVIDER.denseModelId,
      sparseModelId: PROVIDER.sparseModelId,
      datasetRepo: BELEBELE_REPO,
      datasetRevision: BELEBELE_REVISION,
      corpusSize: task.corpus.size,
      queryCount: task.queries.size,
      peakRssBytes: langPeakRss.bytes,
    };
    langReport.cudaVerification = verifyCudaProvenance(asCudaItem(language), langReport.provenance.onnx);
    if (!langReport.cudaVerification.ok) {
      langReport.errors.push({ step: 'cuda_verification', error: langReport.cudaVerification.reason });
    }
    report.languages[language.code] = langReport;
    rebuildReportAggregates(report);
    writeJsonAtomic(REPORT_JSON_PATH, report);
  }

  if (!SMOKE) {
    report.groupSummaries = computeGroupSummaries(report.languages);
    report.decisions = classifyLanguageDecisions(report.languages);
  }

  clearInterval(rssTimer);
  trackRss();
  report.environment.peakRssBytes = Math.max(peakRss.bytes, report.environment.priorPeakRssBytes ?? 0);
  report.finishedAt = new Date().toISOString();
  report.verdict = computeVerdict(report, effectiveLanguages, contract);
  writeJsonAtomic(REPORT_JSON_PATH, report);
  if (!SMOKE) writeFileSync(REPORT_MD_PATH, renderMarkdownReport(report), 'utf-8');

  console.log('\n[slavic-weighted-rrf] === SUMMARY ===');
  for (const [code, r] of Object.entries(report.languages)) {
    const row = FUSION_MODE_IDS.map((m) => `${m}=${r.metrics?.[m]?.ndcgAt10?.toFixed(4) ?? 'n/a'}`).join(' ');
    console.log(`${code}: ${row} | cuda=${r.cudaVerification?.ok === false ? 'FAILED' : 'ok'} | cleanup=${r.cleanup?.deleted ? 'ok' : 'FAILED'}`);
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
 * query: dense+sparse query vectors computed ONCE, then all six fusion
 * modes evaluated from those same vectors -> compute metrics (aggregate +
 * per-query for bootstrap) -> write TREC runs -> cleanup. Cleanup always
 * runs in `finally`, guarded to the exact collection prefix. */
export async function executeLanguage({
  client, redact, language, task, trackRss = () => {},
  embedBatch = embedOnnxBatch,
  writeTrecRun = (path, content) => writeFileSync(path, content, 'utf-8'),
  runsDir = RUNS_DIR,
  runsDirLabel = '.runs-weighted-rrf',
  collection = collectionName(language.code, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`),
}) {
  const { corpus, queries, qrels } = task;

  const langReport = {
    langCode: language.code, script: language.script, label: language.label, group: language.group, collection,
    indexing: { wallMs: null, documentsIndexed: 0, batches: 0, errors: 0, retries: 0 },
    queryStats: {
      total: queries.size, ran: 0, errors: 0, retries: 0,
      latencyMs: Object.fromEntries(FUSION_MODE_IDS.map((m) => [m, []])),
    },
    metrics: {},
    perQueryMetrics: {},
    comparisons: {},
    trecRunPaths: {},
    cleanup: { attempted: false, deleted: false, collection, error: null },
    errors: [],
  };

  const idMap = buildIdMapping([...corpus.keys()], `${collection}:doc`);
  if (idMap.collisions.length > 0) {
    langReport.errors.push({ step: 'id_mapping', error: `${idMap.collisions.length} point-ID collisions detected in doc ID mapping — aborting language` });
    return langReport;
  }

  // Truncation diagnostics — detection only, matching run-slavic-benchmark.mjs.
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
    const sparse_vectors = { sparse: { index: { on_disk: false } } }; // BGE-M3 learned sparse, not BM25
    const createRes = await withBoundedRetry(() => client.createCollection(collection, { vectors, sparse_vectors }));
    if (!createRes.ok) {
      langReport.errors.push({ step: 'create_collection', error: redact(createRes.err) });
      return langReport;
    }

    // ── index corpus ONCE, in bounded batches — dense+sparse from the
    // SAME embedOnnxBatch() call per batch, never separate passes ────────
    const indexStart = process.hrtime.bigint();
    const docIds = [...corpus.keys()];
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
        return {
          id: idMap.toPoint.get(docId),
          payload: { doc_id: docId, benchmark: 'slavic-weighted-rrf', language: language.code },
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
        console.log(`[slavic-weighted-rrf] [${language.code}] indexed ${langReport.indexing.documentsIndexed}/${docIds.length}`);
        trackRss();
      }
    }
    langReport.indexing.wallMs = Number((process.hrtime.bigint() - indexStart) / 1000000n);
    console.log(`[slavic-weighted-rrf] [${language.code}] indexing complete: ${langReport.indexing.documentsIndexed} docs in ${langReport.indexing.wallMs}ms`);

    // ── sequential queries: dense+sparse vectors computed once, then all
    // six fusion modes evaluated from those same vectors ────────────────
    const emptyRun = () => new Map([...queries.keys()].map((qid) => [qid, []]));
    const runsByMode = new Map(FUSION_MODE_IDS.map((id) => [id, emptyRun()]));

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
        const queryVectors = { dense, sparse: { indices: sparse.indices, values: sparse.values } };

        const modeResults = [];
        for (const mode of FUSION_MODES) {
          let res;
          if (mode.kind === 'single') {
            res = await withBoundedRetry(
              () => client.query(collection, { query: queryVectors[mode.using], using: mode.using, limit: TOP_K, with_payload: false }),
              { onRetry: () => { langReport.queryStats.retries += 1; } },
            );
          } else {
            // Real Qdrant weighted-RRF contract: weights live in
            // query.rrf.weights, never on a prefetch entry.
            res = await withBoundedRetry(
              () => client.query(collection, {
                prefetch: [
                  { query: queryVectors.dense, using: 'dense', limit: HYBRID_PREFETCH_LIMIT },
                  { query: queryVectors.sparse, using: 'sparse', limit: HYBRID_PREFETCH_LIMIT },
                ],
                query: { rrf: { k: mode.k, weights: mode.weights } },
                limit: TOP_K, with_payload: false,
              }),
              { onRetry: () => { langReport.queryStats.retries += 1; } },
            );
          }
          modeResults.push([mode.id, res, runsByMode.get(mode.id)]);
        }

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

        langReport.queryStats.ran += 1;
        if (qi % 100 === 0) { console.log(`[slavic-weighted-rrf] [${language.code}] queries ${qi}/${queries.size}`); trackRss(); }
      }
    }

    // ── metrics + TREC run persistence ───────────────────────────────────
    const toRankedMap = (scoredMap) => {
      const m = new Map();
      for (const [qid, docs] of scoredMap.entries()) m.set(qid, docs.map((d) => d.docId));
      return m;
    };
    const rankedByMode = Object.fromEntries(FUSION_MODE_IDS.map((id) => [id, toRankedMap(runsByMode.get(id))]));
    for (const [label, ranked] of Object.entries(rankedByMode)) {
      langReport.metrics[label] = computeMetrics(qrels, ranked);
      langReport.perQueryMetrics[label] = [...perQueryMetrics(qrels, ranked).entries()];
    }

    for (const [label, scoredMap] of runsByMode.entries()) {
      const trecPath = join(runsDir, `${language.code}-${label}.trec`);
      writeTrecRun(trecPath, toTrecRunFormat(scoredMap, `slavic-weighted-rrf-${language.code}-${label}`));
      langReport.trecRunPaths[label] = trecPath.replace(runsDir, runsDirLabel);
    }

    for (const label of Object.keys(rankedByMode)) {
      const arr = [...langReport.queryStats.latencyMs[label]].sort((a, b) => a - b);
      langReport.queryStats.latencyMs[label] = {
        p50: percentile(arr, 0.5), p95: percentile(arr, 0.95), max: arr.length ? arr[arr.length - 1] : null, count: arr.length,
      };
    }

    // ── required paired-bootstrap comparisons ────────────────────────────
    langReport.comparisons = computeLanguageComparisons(langReport.perQueryMetrics);
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

/** Required paired-bootstrap comparisons within one language, each built as
 * pairedBootstrapByQuery(<baseline>, <comparison>) so meanDelta always
 * reads as "<comparison> minus <baseline>" — matching
 * run-weighted-rrf-live.mjs's own computeScopeComparisons() exactly:
 *   - sparse vs dense
 *   - equal_k2 vs dense
 *   - equal_k60 vs dense
 *   - k2_rho0.10 (primary) vs dense
 *   - k2_rho0.10 (primary) vs equal_k2
 *   - k2_rho0.10 (primary) vs equal_k60
 *   - k2_rho0.25 (diagnostic) vs dense */
export function computeLanguageComparisons(perQueryMetricsRaw) {
  const pq = Object.fromEntries(Object.entries(perQueryMetricsRaw).map(([label, entries]) => [label, new Map(entries)]));
  const comparisons = {};
  if (!pq.dense) return comparisons;

  const cmp = (baselineKey, comparisonKey, label) => {
    if (!pq[baselineKey] || !pq[comparisonKey]) return;
    comparisons[label] = pairedBootstrapByQuery(pq[baselineKey], pq[comparisonKey], 'ndcgAt10');
  };

  cmp('dense', 'sparse', 'sparse_vs_dense');
  cmp('dense', 'equal_k2', 'equal_k2_vs_dense');
  cmp('dense', 'equal_k60', 'equal_k60_vs_dense');
  cmp('dense', PRIMARY_CANDIDATE_ID, `${PRIMARY_CANDIDATE_ID}_vs_dense`);
  cmp('equal_k2', PRIMARY_CANDIDATE_ID, `${PRIMARY_CANDIDATE_ID}_vs_equal_k2`);
  cmp('equal_k60', PRIMARY_CANDIDATE_ID, `${PRIMARY_CANDIDATE_ID}_vs_equal_k60`);
  cmp('dense', DIAGNOSTIC_CANDIDATE_ID, `${DIAGNOSTIC_CANDIDATE_ID}_vs_dense`);

  return comparisons;
}

/** Group summaries — DESCRIPTIVE ONLY, never a substitute for or
 * statistical claim about per-language results, and never used to promote
 * a fusion candidate (see classifyLanguageDecisions() for the rule that
 * enforces this explicitly). Groups: Cyrillic Slavic, Latin Slavic,
 * English control — per GROUPS in slavic-weighted-rrf-config.mjs. */
export function computeGroupSummaries(languages) {
  const mean = (vals) => {
    const finite = vals.filter((v) => typeof v === 'number' && Number.isFinite(v));
    return finite.length ? finite.reduce((s, v) => s + v, 0) / finite.length : null;
  };
  const summaries = {};
  for (const group of Object.values(GROUPS)) {
    const members = group.codes.map((code) => languages[code]).filter((r) => r?.metrics);
    const perLanguage = group.codes.map((code) => {
      const r = languages[code];
      if (!r?.metrics) return { code, ok: false };
      return {
        code, ok: true,
        ndcgAt10ByMode: Object.fromEntries(FUSION_MODE_IDS.map((m) => [m, r.metrics[m]?.ndcgAt10 ?? null])),
      };
    });
    const macroAverageByMode = Object.fromEntries(FUSION_MODE_IDS.map((m) => [
      m, mean(members.map((r) => r.metrics[m]?.ndcgAt10)),
    ]));
    summaries[group.id] = {
      groupId: group.id, label: group.label, languageCodes: [...group.codes],
      languagesPresent: members.length, languagesExpected: group.codes.length,
      perLanguage, macroAverageByMode,
    };
  }
  return {
    note: 'DESCRIPTIVE ONLY — never a statistical claim about script/language effects, and never used by itself to promote a fusion candidate. Script and language are confounded in this dataset; see per-language results and classifyLanguageDecisions() for the actual evidence.',
    groups: summaries,
  };
}

// Pre-registered non-inferiority margin for "restores dense quality",
// fixed BEFORE any result is inspected — never tuned post-hoc. A candidate
// "restores" dense quality only when the bootstrap 95% CI on meanDelta
// (candidate − dense) excludes any regression worse than this margin
// (ciLow > -RESTORES_DENSE_QUALITY_MARGIN). Absence of a statistically
// significant regression is NOT the same claim as "restored" — a wide or
// uninformative CI (e.g. INCONCLUSIVE with ciLow far below -margin) must
// classify as inconclusive, never restored.
export const RESTORES_DENSE_QUALITY_MARGIN = 0.02;

/** Per-language decision classification, per the task's required
 * categories. A weighted candidate is NEVER promoted merely because it
 * wins a group average — every classification here is MIXED unless the
 * underlying per-language bootstrap evidence is both directionally
 * consistent AND statistically significant (CI excludes zero). Absence of
 * significance is reported as MIXED/neutral, never silently treated as
 * "no effect" or "restores quality". */
export function classifyLanguageDecisions(languages) {
  const decisions = {};
  for (const [code, r] of Object.entries(languages)) {
    const c = r.comparisons ?? {};
    const classifySignificant = (cmp, helpsLabel, hurtsLabel, neutralLabel) => {
      if (!cmp || cmp.verdict == null) return { classification: neutralLabel, meanDelta: cmp?.meanDelta ?? null, verdict: cmp?.verdict ?? null };
      if (cmp.verdict === 'B_BETTER') return { classification: helpsLabel, meanDelta: cmp.meanDelta, verdict: cmp.verdict };
      if (cmp.verdict === 'A_BETTER') return { classification: hurtsLabel, meanDelta: cmp.meanDelta, verdict: cmp.verdict };
      return { classification: neutralLabel, meanDelta: cmp.meanDelta, verdict: cmp.verdict }; // MIXED or INCONCLUSIVE
    };

    const sparseVsDense = classifySignificant(c.sparse_vs_dense, 'sparse_helps', 'sparse_significantly_hurts', 'sparse_neutral_mixed');
    const equalK2VsDense = classifySignificant(c.equal_k2_vs_dense, 'equal_hybrid_helps', 'equal_hybrid_hurts', 'equal_hybrid_neutral_mixed');
    const equalK60VsDense = classifySignificant(c.equal_k60_vs_dense, 'equal_hybrid_helps', 'equal_hybrid_hurts', 'equal_hybrid_neutral_mixed');

    // Three-state non-inferiority classification against dense, using the
    // pre-registered RESTORES_DENSE_QUALITY_MARGIN — never the plain
    // A_BETTER/B_BETTER/MIXED/INCONCLUSIVE verdict alone, which only tests
    // against a delta of exactly zero and cannot distinguish "genuinely
    // restored" from "we simply don't know" (a MIXED/INCONCLUSIVE result
    // with a CI extending far below -margin is NOT evidence of restoration
    // — it means the evidence is insufficient to say either way):
    //   'restored'     — ciLow > -margin: the CI rules out a regression
    //                     worse than the margin (candidate is statistically
    //                     non-inferior to dense, or better).
    //   'regressed'    — ciHigh < -margin: the ENTIRE CI is a regression
    //                     worse than the margin (confirmed regression
    //                     beyond the tolerated margin).
    //   'inconclusive' — the CI straddles -margin (partially overlaps the
    //                     margin boundary), or the CI is unavailable —
    //                     insufficient evidence to call it either way.
    const nonInferiorityClassification = (cmp) => {
      if (!cmp || typeof cmp.ciLow !== 'number' || typeof cmp.ciHigh !== 'number') {
        return { classification: 'inconclusive', meanDelta: cmp?.meanDelta ?? null, verdict: cmp?.verdict ?? null, ciLow: null, ciHigh: null, marginUsed: RESTORES_DENSE_QUALITY_MARGIN };
      }
      const margin = RESTORES_DENSE_QUALITY_MARGIN;
      let classification;
      if (cmp.ciLow > -margin) classification = 'restored';
      else if (cmp.ciHigh < -margin) classification = 'regressed';
      else classification = 'inconclusive';
      return { classification, meanDelta: cmp.meanDelta, verdict: cmp.verdict, ciLow: cmp.ciLow, ciHigh: cmp.ciHigh, marginUsed: margin };
    };

    decisions[code] = {
      langCode: code,
      sparse: sparseVsDense,
      equalHybridK2: equalK2VsDense,
      equalHybridK60: equalK60VsDense,
      rho010RestoresDenseQuality: nonInferiorityClassification(c[`${PRIMARY_CANDIDATE_ID}_vs_dense`]),
      rho025RestoresDenseQuality: nonInferiorityClassification(c[`${DIAGNOSTIC_CANDIDATE_ID}_vs_dense`]),
    };
  }
  return decisions;
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
  if (!allPresent) return SMOKE ? 'SLAVIC_WEIGHTED_RRF_SMOKE_BLOCKED' : 'SLAVIC_WEIGHTED_RRF_HARNESS_BLOCKED';

  const cleanupOk = report.cleanupSummary.failed.length === 0;
  let anyMetricsValid = false;
  let allMetricsValid = true;
  let anyRequestErrors = false;
  let anyCudaFailure = false;
  for (const langReport of Object.values(report.languages)) {
    const metricsOk = FUSION_MODE_IDS.every((mode) => metricsAreFullyValid(langReport.metrics?.[mode], contract.queryCountPerLanguage));
    if (metricsOk) anyMetricsValid = true; else allMetricsValid = false;
    if ((langReport.errors?.length ?? 0) > 0 || langReport.queryStats.errors > 0 || langReport.indexing.errors > 0) anyRequestErrors = true;
    if (langReport.cudaVerification && langReport.cudaVerification.ok !== true) anyCudaFailure = true;
  }

  const prefix = SMOKE ? 'SLAVIC_WEIGHTED_RRF_SMOKE' : 'SLAVIC_WEIGHTED_RRF_HARNESS';
  if (anyCudaFailure) return `${prefix}_REJECT`;
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
  lines.push('# Slavic Belebele weighted-RRF fusion matrix');
  lines.push('');
  lines.push(`Verdict: **${report.verdict}**`);
  lines.push('');
  lines.push('Goal: determine whether sparse/equal-weight RRF regressions correlate');
  lines.push('with individual Slavic languages or script groups. Uses the SAME six');
  lines.push('fusion modes and rho -> sparseWeight conversion already validated by the');
  lines.push('live SciFact/MIRACL weighted-RRF benchmark — real Qdrant');
  lines.push('`query.rrf.weights` requests only, never `prefetch.weight`, never a');
  lines.push('local RRF reconstruction. Local BGE-M3 ONNX only — no Qdrant Cloud');
  lines.push('E5/BM25 profile, isolating the language factor under one fixed provider.');
  lines.push('');
  lines.push('CUDA is an execution ACCELERATOR ONLY. It is never interpreted as');
  lines.push('affecting retrieval quality, and CPU/DML/CUDA quality is never compared');
  lines.push('anywhere in this report.');
  lines.push('');
  lines.push('Script and language are confounded in this dataset — findings are');
  lines.push('reported as observed associations requiring further validation, never');
  lines.push('as a causal claim that script itself causes a difference.');
  lines.push('');
  lines.push(`Fusion modes: ${report.benchmarkContract.fusionModeIds.join(', ')}`);
  lines.push('');

  lines.push('## Retrieval quality per language');
  lines.push('');
  lines.push('| Language | Script | Mode | nDCG@10 | MAP@100 | MRR@10 | Recall@10 | Recall@100 | Queries | Errors |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [code, r] of Object.entries(report.languages)) {
    for (const [mode, m] of Object.entries(r.metrics ?? {})) {
      lines.push(`| ${code} | ${r.script} | ${mode} | ${metricCell(m.ndcgAt10)} | ${metricCell(m.mapAt100)} | ${metricCell(m.mrrAt10)} | ${metricCell(m.recallAt10)} | ${metricCell(m.recallAt100)} | ${m.queryCount ?? 'n/a'} | ${r.queryStats?.errors ?? 'n/a'} |`);
    }
  }
  lines.push('');

  lines.push('## Paired bootstrap comparisons (sign = comparison − baseline)');
  lines.push('');
  lines.push(`Seed: \`${DEFAULT_BOOTSTRAP_SEED}\`, iterations: ${DEFAULT_BOOTSTRAP_ITERATIONS}.`);
  lines.push('');
  for (const [code, r] of Object.entries(report.languages)) {
    lines.push(`### ${code} (${r.label})`);
    lines.push('');
    for (const [label, cmp] of Object.entries(r.comparisons ?? {})) {
      lines.push(`- **${label}**: ${bootstrapCell(cmp)}`);
    }
    lines.push('');
  }

  lines.push('## Per-language decision classification');
  lines.push('');
  lines.push('A weighted candidate is never promoted merely because it wins a group');
  lines.push('average — MIXED is reported unless the per-language bootstrap evidence');
  lines.push('is both directionally consistent and statistically significant.');
  lines.push('');
  lines.push(`"Restores dense quality" is a pre-registered non-inferiority test`);
  lines.push(`(margin=${RESTORES_DENSE_QUALITY_MARGIN} nDCG@10, fixed before any result was inspected): **restored**`);
  lines.push('means the 95% CI on meanΔ (candidate − dense) excludes any regression');
  lines.push('worse than the margin; **regressed** means the entire CI is a regression');
  lines.push('beyond the margin; **inconclusive** means the CI straddles the margin');
  lines.push('boundary or is unavailable — an absence of significant regression is NOT');
  lines.push('by itself evidence of restoration.');
  lines.push('');
  lines.push('| Language | Sparse vs dense | Equal k=2 vs dense | Equal k=60 vs dense | rho=0.10 vs dense | rho=0.25 vs dense |');
  lines.push('|---|---|---|---|---|---|');
  for (const [code, d] of Object.entries(report.decisions ?? {})) {
    lines.push(`| ${code} | ${d.sparse.classification} | ${d.equalHybridK2.classification} | ${d.equalHybridK60.classification} | ${d.rho010RestoresDenseQuality.classification} | ${d.rho025RestoresDenseQuality.classification} |`);
  }
  lines.push('');

  lines.push('## Group summaries (descriptive only)');
  lines.push('');
  lines.push(report.groupSummaries?.note ?? 'n/a');
  lines.push('');
  lines.push('| Group | Languages present | dense | sparse | equal_k2 | equal_k60 | k2_rho0.10 | k2_rho0.25 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const g of Object.values(report.groupSummaries?.groups ?? {})) {
    const m = g.macroAverageByMode;
    lines.push(`| ${g.label} | ${g.languagesPresent}/${g.languagesExpected} | ${metricCell(m.dense)} | ${metricCell(m.sparse)} | ${metricCell(m.equal_k2)} | ${metricCell(m.equal_k60)} | ${metricCell(m['k2_rho0.10'])} | ${metricCell(m['k2_rho0.25'])} |`);
  }
  lines.push('');
  lines.push('These macro averages never replace or outweigh per-language results,');
  lines.push('and are never presented as statistical evidence of a script effect.');
  lines.push('');

  lines.push('## CUDA provenance (execution accelerator only — not a quality variable)');
  lines.push('');
  lines.push('| Language | Requested | Effective | Strict configured | Fell back to CPU | Verified |');
  lines.push('|---|---|---|---|---|---|');
  for (const [code, r] of Object.entries(report.languages)) {
    const onnx = r.provenance?.onnx;
    if (!onnx) { lines.push(`| ${code} | n/a | n/a | n/a | n/a | n/a |`); continue; }
    lines.push(`| ${code} | ${onnx.requestedProvider} | ${onnx.effectiveProvider ?? 'n/a'} | ${onnx.strictModeConfigured} | ${onnx.fellBackToCpu} | ${r.cudaVerification?.ok ? 'yes' : 'NO — ' + (r.cudaVerification?.reason ?? '')} |`);
  }
  lines.push('');

  lines.push('## Truncation');
  lines.push('');
  lines.push('| Language | Documents truncated | Queries truncated |');
  lines.push('|---|---:|---:|');
  for (const [code, r] of Object.entries(report.languages)) {
    if (!r.truncation) continue;
    lines.push(`| ${code} | ${r.truncation.documents.truncated}/${r.truncation.documents.total} | ${r.truncation.queries.truncated}/${r.truncation.queries.total} |`);
  }
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
  lines.push('- FACT: every hybrid row was produced by a real Qdrant `query.rrf.weights`');
  lines.push('  request, prefetch=200/lane, final limit 100 — never a local RRF');
  lines.push('  reconstruction, never `prefetch.weight`.');
  lines.push('- FACT: qrels are MRC-derived (one relevant passage per question),');
  lines.push('  never pooled IR judgments — see fetch-belebele.mjs\'s module header.');
  lines.push('- FACT: only the local BGE-M3 provider was measured — no Qdrant Cloud');
  lines.push('  E5/BM25 comparison in this run, by design.');
  lines.push('- FACT: CUDA is an execution accelerator only; this report never compares');
  lines.push('  CPU/DML/CUDA retrieval quality.');
  lines.push('- FACT: script and language are confounded in this 7-language matrix —');
  lines.push('  no per-script causal claim is made anywhere in this report.');
  lines.push('- This benchmark does not implement or recommend production');
  lines.push('  language-aware fusion, and does not change any production fusion');
  lines.push('  default from this run alone.');
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
    console.error('[slavic-weighted-rrf] unhandled error:', redact(err));
    process.exitCode = 1;
  });
}
