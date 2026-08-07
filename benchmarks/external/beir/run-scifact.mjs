// BEIR SciFact external retrieval-provider benchmark: local BGE-M3 ONNX vs
// Qdrant Cloud Inference (hosted E5-small dense + server-side BM25).
//
// This is a retrieval-PROVIDER benchmark, not end-to-end RAG and not a
// Semidex chunker evaluation. SciFact has document-level qrels, so every
// document is indexed as ONE atomic point — no chunking, no Markdown
// conversion, no production indexer invocation.
//
// No production code changed. Nothing committed by this script. One
// profile at a time, one query at a time (bounded concurrency 1), bounded
// indexing batches, bounded retry with backoff, no background processes.
//
// Run:  node benchmarks/external/beir/run-scifact.mjs
// Smoke (tiny subset, cloud-only, separate output path, for validating the
// pipeline before a full run):
//   node benchmarks/external/beir/run-scifact.mjs --smoke
// Full/smoke runs require QDRANT_URL / QDRANT_KEY in the environment
// (Semidex's own bootstrapEnv()). The dataset is fetched and validated by
// this script when it is not already present in the local cache.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { bootstrapEnv } from '../../../src/shared/core/env-bootstrap.js';
import { createOnnxEmbeddingCapability } from '../../../src/local/core/onnx-embed.js';

// This benchmark's own single-instance, lazy-construct-on-first-use seam
// (Phase 8B — onnx-embed.js no longer exports a bare module-scope-backed
// embedOnnxBatch function). A benchmark script runs as one short-lived
// process with exactly one indexing/query pass — no multi-instance
// isolation concern applies here (that requirement targets production
// composition roots, e.g. index-full.js/admin/server-full.js, each of
// which now constructs its OWN instance — see local/core/onnx-embed.js's
// own header comment). Constructed on first call, so a cloud-only run
// (--smoke defaults to cloud, or any run whose matrix never includes the
// local profile) never touches onnxruntime-node at all; released via
// shutdownOnnxEmbedCapability() at the end of main().
let _onnxCapability = null;
let _embedOnnxBatch = null;
async function embedOnnxBatch(texts) {
  if (!_embedOnnxBatch) {
    _onnxCapability = createOnnxEmbeddingCapability();
    ({ embedOnnxBatch: _embedOnnxBatch } = await _onnxCapability.loadOnnxBatch());
  }
  return _embedOnnxBatch(texts);
}
async function shutdownOnnxEmbedCapability() {
  if (_onnxCapability) await _onnxCapability.shutdown();
}

import { fetchAndValidateScifact, SCIFACT_MD5 } from './fetch-scifact.mjs';
import {
  PROFILES, buildRunMatrix, flattenRunMatrixByK, COLLECTION_PREFIX, collectionName,
  BM25_MODEL_ID, BM25_OPTIONS, TOP_K, HYBRID_PREFETCH_LIMIT,
} from './profiles.mjs';
import { computeMetrics, toTrecRunFormat } from './metrics.mjs';
import { formatForLanes, prepareInputs } from './prepare-inputs.mjs';
import {
  makeRedactor as makeRedactorCore, describeEndpoint, buildClient, timed, withBoundedRetry,
  percentile, buildIdMapping,
} from './harness-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const RUNS_DIR = resolve(__dirname, '.runs');
const RESULTS_DIR = resolve(__dirname, '../results');

// --smoke: tiny subset (5 docs incl. all relevant docs for 2 queries, 2
// queries), cloud profile only, k=2/native only — validates the full
// pipeline (create/index/query/metrics/cleanup) cheaply before committing
// to the real ~5000-doc x 6-run matrix. Writes to a SEPARATE path so it can
// never overwrite the real report.
const SMOKE = process.argv.includes('--smoke');
const PREPARE_INPUTS_ONLY = process.argv.includes('--prepare-inputs-only');
const RESUME_CHECK = process.argv.includes('--resume-check');
const RESUME = process.argv.includes('--resume') || RESUME_CHECK;
const RESTART = process.argv.includes('--restart');
const REPORT_JSON_PATH = resolve(RESULTS_DIR, SMOKE ? '.smoke-report.json' : '2026-07-21-beir-scifact-provider-comparison.json');
const REPORT_MD_PATH = resolve(RESULTS_DIR, '2026-07-21-beir-scifact-provider-comparison.md');
const BENCHMARK_CHECKPOINT_VERSION = 1;

// ── resource safety knobs ────────────────────────────────────────────────────
const INDEX_BATCH_SIZE = 24; // within the required 16-32 range
const LOCAL_NATIVE_LONG_BATCH_SIZE = 4;
const QUERY_CONCURRENCY = 1; // sequential — explicit, not implicit

// Thin wrapper preserving this file's original makeRedactor(secret) call
// shape (REPO_ROOT closed over) on top of harness-core.mjs's shared
// implementation, which takes repoRoot explicitly since it has no fixed
// notion of "the repo this script lives in".
function makeRedactor(secret) {
  return makeRedactorCore(secret, REPO_ROOT);
}

// Input regimes are prepared and validated once in prepare-inputs.mjs.
// "native": full title + "\n\n" + text, no artificial cap. Each provider's
// own real truncation applies downstream (BGE-M3 ONNX: 8192 max_length in
// onnx-embed.js; E5-small: 512-token model context window at the API).
// "common-512": binary-search the largest BODY prefix such that
// title + "\n\n" + bodyPrefix, WITH the model's own instruction prefix
// prepended where applicable, is <= 512 tokens under BOTH the E5 tokenizer
// and the BGE-M3 tokenizer simultaneously — the same literal input length
// budget for both profiles in this regime. Title is never truncated (short
// enough in SciFact to not matter; truncating it would make cross-profile
// text non-comparable in a different way).

function expectedMetricModes(runCfg) {
  return ['dense', 'sparse', ...runCfg.rrfKs.map((k) => `hybrid_k${k}`)];
}

export function isCompletedRunCheckpoint(run, runCfg, { documentCount, queryCount }) {
  if (!run || run.runId !== runCfg.runId || run.profileId !== runCfg.profileId || run.regime !== runCfg.regime) return false;
  if (JSON.stringify(run.rrfKs) !== JSON.stringify(runCfg.rrfKs)) return false;
  if (run.indexing?.documentsIndexed !== documentCount || run.indexing?.errors !== 0) return false;
  if (run.queryStats?.total !== queryCount || run.queryStats?.ran !== queryCount || run.queryStats?.errors !== 0) return false;
  if ((run.errors?.length ?? 0) !== 0 || run.cleanup?.deleted !== true) return false;
  return expectedMetricModes(runCfg).every((mode) => {
    const metrics = run.metrics?.[mode];
    return metrics?.queryCount === queryCount
      && typeof metrics.ndcgAt10 === 'number'
      && Number.isFinite(metrics.ndcgAt10);
  });
}

function buildBenchmarkContract({ runMatrix, corpus, queries, prepared }) {
  return {
    version: BENCHMARK_CHECKPOINT_VERSION,
    datasetMd5: SCIFACT_MD5,
    qdrantEndpointFingerprint: createHash('sha256')
      .update(process.env.QDRANT_URL ?? '')
      .digest('hex')
      .slice(0, 16),
    documentCount: corpus.size,
    queryCount: queries.size,
    preparedCache: basename(prepared.cachePath),
    topK: TOP_K,
    hybridPrefetchLimit: HYBRID_PREFETCH_LIMIT,
    bm25Options: BM25_OPTIONS,
    runs: runMatrix.map(({ runId, profileId, regime, rrfKs, profile }) => ({
      runId,
      profileId,
      regime,
      rrfKs,
      denseModelId: profile.denseModelId,
      sparseModelId: profile.sparseModelId,
      denseSize: profile.denseSize,
    })),
  };
}

export function validateResumeCheckpoint(previous, contract, runMatrix) {
  if (!previous || typeof previous !== 'object') throw new Error('Resume checkpoint is not a JSON object.');
  const knownRuns = new Map(runMatrix.map((run) => [run.runId, run]));
  const previousRunIds = Object.keys(previous.runs ?? {});
  for (const runId of previousRunIds) {
    if (!knownRuns.has(runId)) throw new Error(`Resume checkpoint contains unknown run: ${runId}`);
  }

  if (previous.benchmarkContract) {
    if (JSON.stringify(previous.benchmarkContract) !== JSON.stringify(contract)) {
      throw new Error('Resume checkpoint contract does not match the current dataset/profile configuration.');
    }
  } else {
    // Backward-compatible validation for the first checkpoint written before
    // benchmarkContract existed. Validate all fields that old reports carry.
    const stats = previous.environment?.datasetStats;
    if (stats?.corpusSize !== contract.documentCount || stats?.queryCount !== contract.queryCount) {
      throw new Error('Legacy resume checkpoint dataset size does not match the current dataset.');
    }
  }

  for (const [runId, run] of Object.entries(previous.runs ?? {})) {
    const runCfg = knownRuns.get(runId);
    const completed = isCompletedRunCheckpoint(run, runCfg, contract);
    if (!completed && run.cleanup?.deleted !== true) {
      throw new Error(`Incomplete run ${runId} does not have confirmed cleanup; refusing to resume.`);
    }
  }
  return true;
}

function rebuildReportAggregates(report) {
  const runs = Object.values(report.runs ?? {});
  report.cleanupSummary = {
    attempted: runs.filter((run) => run.cleanup?.attempted).length,
    deleted: runs.filter((run) => run.cleanup?.deleted).length,
    failed: runs
      .filter((run) => run.cleanup?.attempted && !run.cleanup?.deleted)
      .map((run) => ({ runId: run.runId, collection: run.cleanup?.collection, error: run.cleanup?.error })),
  };
  report.errors = runs.flatMap((run) => (run.errors ?? []).map((error) => ({ runId: run.runId, ...error })));
}

export function buildIndexBatches({ docIds, preparedDocuments, profileKind, regime }) {
  if (profileKind !== 'local' || regime !== 'native') {
    const batches = [];
    for (let i = 0; i < docIds.length; i += INDEX_BATCH_SIZE) {
      batches.push(docIds.slice(i, i + INDEX_BATCH_SIZE));
    }
    return batches;
  }

  // A single long sequence pads every item in its ONNX batch to the same
  // length. Keep the normal throughput batch for <=512-token documents, but
  // isolate documents that the shared preparation had to truncate. Four
  // worst-case SciFact documents stay near the memory footprint of the
  // common-512 path while retaining almost identical per-document throughput.
  const regular = [];
  const long = [];
  for (const docId of docIds) {
    const entry = preparedDocuments.get(docId);
    (entry?.truncated ? long : regular).push(docId);
  }

  const batches = [];
  for (let i = 0; i < regular.length; i += INDEX_BATCH_SIZE) {
    batches.push(regular.slice(i, i + INDEX_BATCH_SIZE));
  }
  for (let i = 0; i < long.length; i += LOCAL_NATIVE_LONG_BATCH_SIZE) {
    batches.push(long.slice(i, i + LOCAL_NATIVE_LONG_BATCH_SIZE));
  }
  return batches;
}

// ── main ─────────────────────────────────────────────────────────────────────
/** --smoke: shrink to 2 test queries + every doc their qrels judge (so
 * metrics are non-trivially computable) + a couple of unrelated distractor
 * docs. Never used for the real report — only to validate the pipeline. */
function shrinkDatasetForSmoke(dataset) {
  const { corpus, queries, qrels } = dataset;
  const testQids = [...queries.keys()].slice(0, 2);
  const keepDocIds = new Set();
  for (const qid of testQids) {
    const qr = qrels.get(qid);
    if (qr) for (const docId of qr.keys()) keepDocIds.add(docId);
  }
  // Pad with a few arbitrary distractor docs so the collection isn't
  // trivially "every doc is relevant".
  for (const docId of corpus.keys()) {
    if (keepDocIds.size >= 8) break;
    keepDocIds.add(docId);
  }
  const smallCorpus = new Map([...corpus.entries()].filter(([id]) => keepDocIds.has(id)));
  const smallQueries = new Map(testQids.map((qid) => [qid, queries.get(qid)]));
  const smallQrels = new Map(testQids.map((qid) => [qid, qrels.get(qid)]));
  return { corpus: smallCorpus, queries: smallQueries, qrels: smallQrels, validation: { stats: { corpusSize: smallCorpus.size, queryCount: smallQueries.size } } };
}

async function main() {
  bootstrapEnv();
  if (RESUME && RESTART) throw new Error('Use either --resume or --restart, not both.');
  if (SMOKE && (RESUME || RESTART)) throw new Error('--resume/--restart are only valid for the full benchmark.');
  if (!SMOKE && !PREPARE_INPUTS_ONLY) {
    if (RESUME && !existsSync(REPORT_JSON_PATH)) {
      throw new Error(`No checkpoint exists at ${REPORT_JSON_PATH}. Start without --resume.`);
    }
    if (!RESUME && !RESTART && existsSync(REPORT_JSON_PATH)) {
      throw new Error(`A benchmark checkpoint already exists at ${REPORT_JSON_PATH}. Use --resume to continue it or --restart to replace it.`);
    }
  }
  const redact = makeRedactor(process.env.QDRANT_KEY);
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const peakRss = { bytes: process.memoryUsage().rss };
  const trackRss = () => { const cur = process.memoryUsage().rss; if (cur > peakRss.bytes) peakRss.bytes = cur; };
  const rssTimer = setInterval(trackRss, 2000);
  rssTimer.unref();

  console.log('[beir-scifact] fetching/validating dataset...');
  let dataset = await fetchAndValidateScifact({ log: (m) => console.log(m) });
  if (SMOKE) dataset = shrinkDatasetForSmoke(dataset);
  const { corpus, queries, qrels } = dataset;
  console.log(`[beir-scifact] dataset ready: ${corpus.size} docs, ${queries.size} queries${SMOKE ? ' (SMOKE MODE)' : ''}`);

  const preparationStarted = Date.now();
  const prepared = await prepareInputs({
    corpus,
    queries,
    datasetMd5: SCIFACT_MD5,
    log: (message) => console.log(message),
    trackRss,
  });
  const preparationWallMs = Date.now() - preparationStarted;
  trackRss();
  console.log(
    `[beir-scifact] inputs ready: docs truncated=${prepared.stats.documents.truncated}, `
    + `queries truncated=${prepared.stats.queries.truncated}, cache=${prepared.fromCache ? 'hit' : 'written'}`,
  );
  if (PREPARE_INPUTS_ONLY) {
    clearInterval(rssTimer);
    console.log(`[beir-scifact] prepare-only complete in ${preparationWallMs}ms`);
    console.log(`[beir-scifact] cache bytes: ${prepared.stats.cacheBytes ?? 0}`);
    console.log(`[beir-scifact] peak RSS: ${(peakRss.bytes / 1e6).toFixed(0)} MB`);
    return;
  }

  const client = buildClient();
  let runMatrix = buildRunMatrix();
  if (SMOKE) runMatrix = runMatrix.filter((r) => r.profileId === 'cloud' && r.regime === 'native').slice(0, 1);
  console.log(`[beir-scifact] run matrix: ${runMatrix.length} indexing runs (${flattenRunMatrixByK(runMatrix).length} metric rows across rrfKs)`);
  for (const r of runMatrix) console.log(`  - ${r.runId} (rrfKs: ${r.rrfKs.join(', ')})`);

  const benchmarkContract = buildBenchmarkContract({ runMatrix, corpus, queries, prepared });
  const currentEnvironment = {
    qdrantEndpoint: describeEndpoint(process.env.QDRANT_URL),
    qdrantKeyConfigured: Boolean(process.env.QDRANT_KEY),
    sdkVersion: null,
    datasetStats: dataset.validation.stats,
    inputPreparation: {
      ...prepared.stats,
      wallMs: preparationWallMs,
      fromCache: prepared.fromCache,
    },
  };
  if (RESUME_CHECK) {
    const previous = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf-8'));
    validateResumeCheckpoint(previous, benchmarkContract, runMatrix);
    const completed = runMatrix
      .filter((runCfg) => isCompletedRunCheckpoint(previous.runs?.[runCfg.runId], runCfg, benchmarkContract))
      .map((runCfg) => runCfg.runId);
    const pending = runMatrix.map((runCfg) => runCfg.runId).filter((runId) => !completed.includes(runId));
    clearInterval(rssTimer);
    console.log(`[beir-scifact] resume checkpoint valid: ${completed.length}/${runMatrix.length} runs complete`);
    console.log(`[beir-scifact] completed: ${completed.join(', ') || '(none)'}`);
    console.log(`[beir-scifact] pending: ${pending.join(', ') || '(none)'}`);
    return;
  }
  let report;
  if (RESUME) {
    const previous = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf-8'));
    validateResumeCheckpoint(previous, benchmarkContract, runMatrix);
    report = {
      ...previous,
      benchmarkContract,
      environment: {
        ...previous.environment,
        ...currentEnvironment,
        priorPeakRssBytes: previous.environment?.peakRssBytes ?? previous.environment?.priorPeakRssBytes ?? null,
      },
      resumeEvents: [...(previous.resumeEvents ?? []), { resumedAt: new Date().toISOString() }],
      verdict: null,
    };
    delete report.finishedAt;
    rebuildReportAggregates(report);
    console.log(`[beir-scifact] checkpoint loaded: ${Object.keys(report.runs ?? {}).length}/${runMatrix.length} runs recorded`);
  } else {
    report = {
      startedAt: new Date().toISOString(),
      benchmarkContract,
      environment: currentEnvironment,
      runs: {}, // runId -> per-run report block
      errors: [],
      cleanupSummary: { attempted: 0, deleted: 0, failed: [] },
      verdict: null,
    };
  }
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'node_modules/@qdrant/js-client-rest/package.json'), 'utf-8'));
    report.environment.sdkVersion = pkg.version;
  } catch { /* leave null */ }
  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');

  // One profile at a time — collect distinct profile IDs in matrix order and
  // process each profile's runs together (never interleaved), matching the
  // task's "один profile одночасно" requirement literally.
  const profileOrder = [...new Set(runMatrix.map((r) => r.profileId))];
  for (const profileId of profileOrder) {
    const runsForProfile = runMatrix.filter((r) => r.profileId === profileId);
    console.log(`\n[beir-scifact] === profile: ${profileId} ===`);
    for (const runCfg of runsForProfile) {
      if (RESUME && isCompletedRunCheckpoint(report.runs?.[runCfg.runId], runCfg, benchmarkContract)) {
        console.log(`[beir-scifact] --- run: ${runCfg.runId} (checkpoint complete, skipping) ---`);
        continue;
      }
      console.log(`\n[beir-scifact] --- run: ${runCfg.runId} ---`);
      const runReport = await executeRun({
        client, redact, dataset, prepared, runCfg, trackRss,
      });
      report.runs[runCfg.runId] = runReport;
      rebuildReportAggregates(report);

      // Persist incrementally after every run — a later run crashing must
      // not lose already-completed runs' results.
      writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    }
  }

  clearInterval(rssTimer);
  trackRss();
  report.environment.peakRssBytes = Math.max(
    peakRss.bytes,
    report.environment.priorPeakRssBytes ?? 0,
  );
  report.finishedAt = new Date().toISOString();
  report.verdict = computeVerdict(report, runMatrix);
  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  if (!SMOKE) writeFileSync(REPORT_MD_PATH, renderMarkdownReport(report), 'utf-8');

  console.log('\n[beir-scifact] === SUMMARY ===');
  for (const [runId, r] of Object.entries(report.runs)) {
    const hybridSummary = (r.rrfKs ?? []).map((k) => {
      const m = r.metrics?.[`hybrid_k${k}`];
      return `k${k} nDCG@10=${m?.ndcgAt10?.toFixed(4) ?? 'n/a'}`;
    }).join(', ');
    console.log(`${runId}: ${hybridSummary} | cleanup=${r.cleanup?.deleted ? 'ok' : 'FAILED'}`);
  }
  console.log('peak RSS:', (peakRss.bytes / 1e6).toFixed(0), 'MB');
  console.log('verdict:', report.verdict);
  console.log('report json:', REPORT_JSON_PATH.replace(REPO_ROOT, '.'));

  if (report.cleanupSummary.failed.length > 0) {
    console.error('\n!! CLEANUP FAILURES:');
    for (const f of report.cleanupSummary.failed) console.error(`!!   ${f.runId}: ${f.collection}`);
    process.exitCode = 1;
  }
}

/** Runs ONE (profile, regime) configuration end to end: create collection
 * -> index corpus ONCE (batched) -> for every query run dense-only and
 * sparse-only ONCE, then hybrid ONCE PER rrfK in profile.rrfKs (same
 * prefetch results, different fusion constant — no re-indexing, no
 * redundant dense/sparse query calls) -> compute metrics per mode/k ->
 * write TREC runs -> cleanup. Cleanup always runs in `finally`, guarded to
 * the exact collection name prefix. */
async function executeRun({ client, redact, dataset, prepared, runCfg, trackRss }) {
  const { corpus, queries, qrels } = dataset;
  const { profile, regime, rrfKs, runId } = runCfg;
  const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const collection = collectionName(profile.id, regime, suffix);

  const runReport = {
    runId, profileId: profile.id, regime, rrfKs, collection,
    indexing: { wallMs: null, documentsIndexed: 0, batches: 0, errors: 0, retries: 0 },
    queryStats: {
      total: queries.size, ran: 0, errors: 0, retries: 0,
      latencyMs: { dense: [], sparse: [], ...Object.fromEntries(rrfKs.map((k) => [`hybrid_k${k}`, []])) },
    },
    truncation: null,
    metrics: {}, // 'dense' | 'sparse' | 'hybrid_k<K>' -> computeMetrics() result
    trecRunPaths: {},
    cleanup: { attempted: false, deleted: false, collection, error: null },
    errors: [],
  };

  const idMap = buildIdMapping([...corpus.keys()], `${collection}:doc`);
  if (idMap.collisions.length > 0) {
    runReport.errors.push({ step: 'id_mapping', error: `${idMap.collisions.length} point-ID collisions detected in doc ID mapping — aborting run` });
    return runReport;
  }

  try {
    const bodyKey = regime === 'native' ? 'nativeBody' : 'commonBody';
    const docBodies = new Map(
      [...prepared.documents].map(([docId, entry]) => [docId, entry[bodyKey]]),
    );
    if (regime === 'common-512') {
      runReport.truncation = {
        documentsTruncated: prepared.stats.documents.truncated,
        documentsTotal: prepared.stats.documents.total,
        queriesTruncated: prepared.stats.queries.truncated,
        queriesTotal: prepared.stats.queries.total,
      };
    }

    // ── create collection ────────────────────────────────────────────────
    // modifier:idf is a BM25-specific convention (Qdrant applies live corpus
    // IDF on top of the stored term-frequency-shaped sparse vector) — it
    // does NOT apply to BGE-M3's sparse output, which is already a set of
    // learned per-token weights, not raw term frequencies. Matches
    // Semidex's own production schema (core/qdrant/schema.js), which never
    // sets modifier on the local bge-m3-onnx sparse lane.
    const vectors = { dense: { size: profile.denseSize, distance: 'Cosine' } };
    const sparse_vectors = profile.kind === 'local'
      ? { sparse: { index: { on_disk: false } } }
      : { sparse: { modifier: 'idf' } };
    const createRes = await withBoundedRetry(() => client.createCollection(collection, { vectors, sparse_vectors }));
    if (!createRes.ok) {
      runReport.errors.push({ step: 'create_collection', error: redact(createRes.err) });
      return runReport;
    }

    // ── index corpus in bounded batches ──────────────────────────────────
    const indexStart = process.hrtime.bigint();
    const docIds = [...corpus.keys()];
    const indexBatches = buildIndexBatches({
      docIds,
      preparedDocuments: prepared.documents,
      profileKind: profile.kind,
      regime,
    });
    runReport.indexing.batchPolicy = profile.kind === 'local' && regime === 'native'
      ? { regular: INDEX_BATCH_SIZE, long: LOCAL_NATIVE_LONG_BATCH_SIZE }
      : { regular: INDEX_BATCH_SIZE, long: null };
    for (let batchIndex = 0; batchIndex < indexBatches.length; batchIndex++) {
      const batchIds = indexBatches[batchIndex];
      const points = await buildPoints({ profile, batchIds, docBodies, idMap, redact, runReport });
      if (points === null) continue; // buildPoints already recorded the error
      const upsertRes = await withBoundedRetry(
        () => client.upsert(collection, { wait: true, points }),
        { onRetry: () => { runReport.indexing.retries += 1; } }
      );
      if (!upsertRes.ok) {
        runReport.indexing.errors += 1;
        runReport.errors.push({ step: `upsert_batch_${batchIndex}`, error: redact(upsertRes.err) });
      } else {
        runReport.indexing.documentsIndexed += points.length;
      }
      runReport.indexing.batches += 1;
      if (runReport.indexing.batches % 20 === 0) {
        console.log(`[beir-scifact] [${runId}] indexed ${runReport.indexing.documentsIndexed}/${docIds.length}`);
        trackRss();
      }
    }
    runReport.indexing.wallMs = Number((process.hrtime.bigint() - indexStart) / 1000000n);
    console.log(`[beir-scifact] [${runId}] indexing complete: ${runReport.indexing.documentsIndexed} docs in ${runReport.indexing.wallMs}ms`);

    // ── sequential queries: dense-only, sparse-only ONCE, hybrid ONCE PER k ─
    // Pre-seed every judged query with an empty result. A failed embedding or
    // request must remain in the metric denominator instead of silently
    // making the reported quality look better.
    const emptyRun = () => new Map([...queries.keys()].map((queryId) => [queryId, []]));
    const denseRun = emptyRun(); // queryId -> [{docId, score}]
    const sparseRun = emptyRun();
    const hybridRuns = new Map(rrfKs.map((k) => [k, emptyRun()])); // k -> queryId -> [{docId,score}]
    const hybridLabels = rrfKs.map((k) => `hybrid_k${k}`);

    let qi = 0;
    for (const queryId of queries.keys()) {
      qi += 1;
      const queryBody = prepared.queries.get(queryId)?.[bodyKey];
      if (typeof queryBody !== 'string') {
        runReport.queryStats.errors += 1;
        runReport.errors.push({ step: `prepare_query_${queryId}`, error: 'Prepared query body is missing' });
        continue;
      }

      const queryVectors = await buildQueryVector({ profile, body: queryBody, redact, runReport });
      if (queryVectors === null) { runReport.queryStats.errors += 1; continue; }

      const denseQ = await withBoundedRetry(
        () => client.query(collection, { query: queryVectors.dense, using: 'dense', limit: TOP_K, with_payload: false }),
        { onRetry: () => { runReport.queryStats.retries += 1; } }
      );
      const sparseQ = await withBoundedRetry(
        () => client.query(collection, { query: queryVectors.sparse, using: 'sparse', limit: TOP_K, with_payload: false }),
        { onRetry: () => { runReport.queryStats.retries += 1; } }
      );

      const modeResults = [['dense', denseQ, denseRun], ['sparse', sparseQ, sparseRun]];
      // One hybrid query per rrfK — same prefetch, different fusion constant.
      for (const k of rrfKs) {
        const hybridQ = await withBoundedRetry(
          () => client.query(collection, {
            prefetch: [
              { query: queryVectors.dense, using: 'dense', limit: HYBRID_PREFETCH_LIMIT },
              { query: queryVectors.sparse, using: 'sparse', limit: HYBRID_PREFETCH_LIMIT },
            ],
            query: { rrf: { k } },
            limit: TOP_K, with_payload: false,
          }),
          { onRetry: () => { runReport.queryStats.retries += 1; } }
        );
        modeResults.push([`hybrid_k${k}`, hybridQ, hybridRuns.get(k)]);
      }

      for (const [label, res, store] of modeResults) {
        if (res.ok) {
          runReport.queryStats.latencyMs[label].push(res.ms);
          const points = res.value?.points ?? [];
          store.set(queryId, points.map((p) => ({ docId: idMap.toString.get(String(p.id)) ?? String(p.id), score: p.score })));
        } else {
          runReport.queryStats.errors += 1;
          runReport.errors.push({ step: `query_${label}_${queryId}`, error: redact(res.err) });
          store.set(queryId, []);
        }
      }
      runReport.queryStats.ran += 1;
      if (qi % 50 === 0) { console.log(`[beir-scifact] [${runId}] queries ${qi}/${queries.size}`); trackRss(); }
    }

    // ── metrics + TREC run persistence ───────────────────────────────────
    const toRankedMap = (scoredMap) => {
      const m = new Map();
      for (const [qid, docs] of scoredMap.entries()) m.set(qid, docs.map((d) => d.docId));
      return m;
    };
    runReport.metrics.dense = computeMetrics(qrels, toRankedMap(denseRun));
    runReport.metrics.sparse = computeMetrics(qrels, toRankedMap(sparseRun));
    for (const k of rrfKs) {
      runReport.metrics[`hybrid_k${k}`] = computeMetrics(qrels, toRankedMap(hybridRuns.get(k)));
    }

    const allModeStores = [['dense', denseRun], ['sparse', sparseRun], ...rrfKs.map((k) => [`hybrid_k${k}`, hybridRuns.get(k)])];
    for (const [label, scoredMap] of allModeStores) {
      const trecPath = join(RUNS_DIR, `${runId}-${label}.trec`);
      writeFileSync(trecPath, toTrecRunFormat(scoredMap, `${runId}-${label}`), 'utf-8');
      runReport.trecRunPaths[label] = trecPath.replace(RUNS_DIR, '.runs');
    }

    for (const label of ['dense', 'sparse', ...hybridLabels]) {
      const arr = [...runReport.queryStats.latencyMs[label]].sort((a, b) => a - b);
      runReport.queryStats.latencyMs[label] = {
        p50: percentile(arr, 0.5), p95: percentile(arr, 0.95), max: arr.length ? arr[arr.length - 1] : null, count: arr.length,
      };
    }
  } catch (err) {
    runReport.errors.push({ step: 'fatal', error: redact(err) });
  } finally {
    runReport.cleanup.attempted = true;
    if (!collection.startsWith(COLLECTION_PREFIX)) {
      runReport.cleanup.error = `Refusing to delete: name does not start with ${COLLECTION_PREFIX}`;
    } else {
      const delRes = await withBoundedRetry(() => client.deleteCollection(collection));
      runReport.cleanup.deleted = delRes.ok;
      if (!delRes.ok) runReport.cleanup.error = redact(delRes.err);
    }
  }

  return runReport;
}

/** Builds Qdrant points for one indexing batch. Local profile: computes
 * dense+sparse via embedOnnxBatch() (bounded batch size, sequential across
 * batches — no unbounded Promise.all). Cloud profile: server-side inference,
 * dense via {text, model} on the `dense` vector, sparse via {text,
 * model:'qdrant/bm25', options} on the `sparse` vector. Returns null (and
 * records the error onto runReport) on failure, so the caller can skip the
 * batch without crashing the whole run. */
async function buildPoints({ profile, batchIds, docBodies, idMap, redact, runReport }) {
  const bodies = batchIds.map((id) => docBodies.get(id));
  if (profile.kind === 'local') {
    const embedRes = await timed(() => embedOnnxBatch(bodies));
    if (!embedRes.ok) {
      runReport.indexing.errors += 1;
      runReport.errors.push({ step: 'embed_batch_local', error: redact(embedRes.err) });
      return null;
    }
    return batchIds.map((docId, i) => {
      const { dense, sparse } = embedRes.value[i];
      return {
        id: idMap.toPoint.get(docId),
        payload: { beir_doc_id: docId, benchmark: 'beir-scifact', profile: profile.id },
        vector: { dense, sparse: { indices: sparse.indices, values: sparse.values } },
      };
    });
  }
  // Cloud: server-side inference — one point per doc, model/options carried
  // in the vector spec itself (no local embedding call at all).
  return batchIds.map((docId, i) => {
    const { denseText, sparseText } = formatForLanes({
      body: bodies[i], profileKind: profile.kind, role: 'document',
    });
    return {
      id: idMap.toPoint.get(docId),
      payload: { beir_doc_id: docId, benchmark: 'beir-scifact', profile: profile.id },
      vector: {
        dense: { text: denseText, model: profile.denseModelId },
        sparse: { text: sparseText, model: BM25_MODEL_ID, options: BM25_OPTIONS },
      },
    };
  });
}

/** Builds the dense+sparse QUERY vectors for one query text. Local: real
 * ONNX embedding of the query text. Cloud: server-side {text, model} query
 * documents — identical shape to what buildPoints() sends for indexing,
 * required for the vector to be comparable to what was indexed. */
async function buildQueryVector({ profile, body, redact, runReport }) {
  if (profile.kind === 'local') {
    const embedRes = await timed(() => embedOnnxBatch([body]));
    if (!embedRes.ok) {
      runReport.errors.push({ step: 'embed_query_local', error: redact(embedRes.err) });
      return null;
    }
    const { dense, sparse } = embedRes.value[0];
    return { dense, sparse: { indices: sparse.indices, values: sparse.values } };
  }
  const { denseText, sparseText } = formatForLanes({
    body, profileKind: profile.kind, role: 'query',
  });
  return {
    dense: { text: denseText, model: profile.denseModelId },
    sparse: { text: sparseText, model: BM25_MODEL_ID, options: BM25_OPTIONS },
  };
}

function computeVerdict(report, runMatrix) {
  const expectedRunIds = new Set(runMatrix.map((r) => r.runId));
  const completedRunIds = new Set(Object.keys(report.runs));
  const allRunsPresent = expectedRunIds.size === completedRunIds.size && [...expectedRunIds].every((id) => completedRunIds.has(id));
  if (!allRunsPresent) return 'BEIR_SCIFACT_HARNESS_BLOCKED';

  const cleanupOk = report.cleanupSummary.failed.length === 0;
  let anyMetricsValid = false;
  let allMetricsValid = true;
  let anyRequestErrors = false;
  for (const run of Object.values(report.runs)) {
    const expectedModes = ['dense', 'sparse', ...(run.rrfKs ?? []).map((k) => `hybrid_k${k}`)];
    const metricsOk = expectedModes.every((mode) => {
      const m = run.metrics?.[mode];
      return m && typeof m.ndcgAt10 === 'number' && Number.isFinite(m.ndcgAt10) && m.queryCount === run.queryStats.total;
    });
    if (metricsOk) anyMetricsValid = true; else allMetricsValid = false;
    if ((run.errors?.length ?? 0) > 0 || run.queryStats.errors > 0 || run.indexing.errors > 0) anyRequestErrors = true;
  }

  if (allMetricsValid && cleanupOk && !anyRequestErrors) return 'BEIR_SCIFACT_HARNESS_ACCEPT';
  if (anyMetricsValid) return 'BEIR_SCIFACT_HARNESS_PARTIAL';
  return 'BEIR_SCIFACT_HARNESS_REJECT';
}

function metricCell(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : 'n/a';
}

function renderMarkdownReport(report) {
  const lines = [
    '# BEIR SciFact provider comparison',
    '',
    `Verdict: **${report.verdict}**`,
    '',
    'This is a document-level retrieval-provider benchmark, not an end-to-end RAG or chunking evaluation.',
    '',
    '## Environment',
    '',
    `- Dataset: ${report.environment.datasetStats.corpusSize} documents, ${report.environment.datasetStats.queryCount} queries.`,
    `- Input preparation: ${report.environment.inputPreparation.fromCache ? 'cache hit' : 'fresh'}, wall ${report.environment.inputPreparation.wallMs} ms.`,
    `- Common-512 truncation: ${report.environment.inputPreparation.documents.truncated}/${report.environment.inputPreparation.documents.total} documents; ${report.environment.inputPreparation.queries.truncated}/${report.environment.inputPreparation.queries.total} queries.`,
    `- Peak process RSS: ${report.environment.peakRssBytes ?? 'n/a'} bytes.`,
    '',
    '## Retrieval quality',
    '',
    '| Run | Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | Precision@10 | MRR@10 |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [runId, run] of Object.entries(report.runs)) {
    for (const [mode, metrics] of Object.entries(run.metrics ?? {})) {
      lines.push(`| ${runId} | ${mode} | ${metricCell(metrics.ndcgAt10)} | ${metricCell(metrics.mapAt100)} | ${metricCell(metrics.recallAt10)} | ${metricCell(metrics.recallAt100)} | ${metricCell(metrics.precisionAt10)} | ${metricCell(metrics.mrrAt10)} |`);
    }
  }
  lines.push(
    '',
    '## Operations',
    '',
    '| Run | Indexed | Index wall ms | Query errors | Retries | Cleanup |',
    '|---|---:|---:|---:|---:|---|',
  );
  for (const [runId, run] of Object.entries(report.runs)) {
    lines.push(`| ${runId} | ${run.indexing.documentsIndexed} | ${run.indexing.wallMs ?? 'n/a'} | ${run.queryStats.errors} | ${run.indexing.retries + run.queryStats.retries} | ${run.cleanup.deleted ? 'deleted' : 'failed'} |`);
  }
  lines.push(
    '',
    '## Interpretation limits',
    '',
    '- FACT: values above are measured on the official English SciFact test split.',
    '- FACT: common-512 uses one provider-neutral body; E5 prefixes only its dense lane, while BM25 receives raw text.',
    '- HYPOTHESIS: multilingual quality must be tested separately on MIRACL (its own supported languages — MIRACL does not include Ukrainian) or another external multilingual dataset. Ukrainian quality specifically requires a separate, dedicated Ukrainian dataset — no MIRACL language substitutes for it.',
    '- No general Semidex-wide winner should be inferred from this benchmark alone.',
    '',
  );
  if (report.errors.length) {
    lines.push('## Errors', '', `Recorded errors: ${report.errors.length}. See the JSON report for redacted details.`, '');
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // shutdownOnnxEmbedCapability() runs regardless of which of main()'s own
  // several early-return paths (--prepare-only, --resume-check, a
  // cloud-only run matrix) was taken — it is a safe no-op whenever
  // embedOnnxBatch() was never actually called (see its own definition
  // above).
  main()
    .catch((err) => {
      const redact = makeRedactor(process.env.QDRANT_KEY);
      console.error('[beir-scifact] unhandled error:', redact(err));
      process.exitCode = 1;
    })
    .finally(() => shutdownOnnxEmbedCapability());
}
