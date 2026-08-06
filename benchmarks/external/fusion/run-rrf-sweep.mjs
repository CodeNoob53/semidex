// Live Qdrant RRF-k sweep benchmark: measures the real Qdrant hybrid-fusion
// curve for k = [1, 2, 5, 10, 30, 60] across four strictly separate
// (dataset, provider) scopes — SciFact mini local/cloud, MIRACL Russian
// local/cloud.
//
// This uses REAL Qdrant hybrid queries, not a local RRF reconstruction.
// The earlier offline fusion diagnosis (analyze-fusion.mjs) explicitly
// avoided reconstructing arbitrary k values from saved top-100 TREC files
// because the real hybrid requests use prefetch limit 200 per lane — an
// offline replay would operate on an incomplete candidate pool. This
// module is the live counterpart: it always issues real Qdrant hybrid
// queries with prefetch=200/lane, varying only `query.rrf.k`.
//
// Execution rule per scope: ONE collection, ONE indexing pass, then per
// query: one dense-only query, one sparse-only query, and SIX hybrid
// queries (one per k in SWEEP_KS) — all six sharing the exact same
// prefetch specification (same dense/sparse query vectors, same prefetch
// limit 200, same final limit 100), differing only in rrf.k. Scopes run
// strictly sequentially — never Promise.all() across scopes, never
// concurrent collections/indexing/ONNX sessions.
//
// Run (full, 4 scopes):     node benchmarks/external/fusion/run-rrf-sweep.mjs
// Resume:                   node benchmarks/external/fusion/run-rrf-sweep.mjs --resume
// Restart (discard prior):  node benchmarks/external/fusion/run-rrf-sweep.mjs --restart
// Check resume state only:  node benchmarks/external/fusion/run-rrf-sweep.mjs --resume-check
// Smoke (tiny, plumbing only, separate path): node benchmarks/external/fusion/run-rrf-sweep.mjs --smoke
// Subset of scopes:         node benchmarks/external/fusion/run-rrf-sweep.mjs --scopes=scifact-local,miracl-cloud
//
// Requires QDRANT_URL / QDRANT_KEY (Semidex's own bootstrapEnv()). Uses
// only the existing validated cached subsets (loadCachedMiniSet(),
// loadCachedMiraclSubset()) — never fetches or rebuilds a dataset; missing
// or invalid caches fail with an actionable error.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

import { bootstrapEnv } from '../../../src/core/env-bootstrap.js';
import { createOnnxEmbeddingCapability } from '../../../src/local/core/onnx-embed.js';

// This benchmark's own single-instance, lazy-construct-on-first-use seam
// (Phase 8B — onnx-embed.js no longer exports a bare module-scope-backed
// embedOnnxBatch function). A benchmark script runs as one short-lived
// process across its whole sweep — no multi-instance isolation concern
// applies here (that requirement targets production composition roots,
// each of which now constructs its OWN instance — see
// local/core/onnx-embed.js's own header comment). Constructed on first
// call across any scope in the sweep, reused for every subsequent scope,
// released via shutdownOnnxEmbedCapability() once the whole sweep
// completes.
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

import { computeMetrics, toTrecRunFormat } from '../beir/metrics.mjs';
import { prepareInputs, formatForLanes } from '../beir/prepare-inputs.mjs';
import {
  makeRedactor as makeRedactorCore, describeEndpoint, buildClient, timed, withBoundedRetry,
  percentile, buildIdMapping,
} from '../beir/harness-core.mjs';
import { loadCachedMiniSet } from '../beir/build-rrf-mini-set.mjs';
import { loadCachedMiraclSubset } from '../miracl/build-miracl-subset.mjs';
import { pairedBootstrapByQuery, perQueryMetrics, DEFAULT_BOOTSTRAP_SEED, DEFAULT_BOOTSTRAP_ITERATIONS } from '../miracl/bootstrap.mjs';

import {
  SWEEP_KS, REFERENCE_K_QDRANT_DEFAULT, REFERENCE_K_SEMIDEX_DEFAULT,
  SCOPES, COLLECTION_PREFIX, collectionName, BM25_MODEL_ID, BM25_OPTIONS,
  TOP_K, HYBRID_PREFETCH_LIMIT, INDEX_BATCH_SIZE, RSS_TRACK_INTERVAL_MS,
  SMOKE_QUERY_COUNT, SMOKE_CORPUS_SIZE, BENCHMARK_CHECKPOINT_VERSION,
  parseScopesFlag,
} from './rrf-sweep-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
// Smoke writes TREC runs to a dedicated subdirectory so it can never
// overwrite the real benchmark's TREC files — both modes use the same
// `${scopeId}-${label}.trec` naming, and scope ids are shared between
// smoke and real runs (smoke reuses e.g. "scifact-local"), so the
// directory itself must differ, not just the JSON report path.
const RUNS_DIR = resolve(__dirname, '.runs');
const SMOKE_RUNS_DIR = resolve(__dirname, '.runs/smoke');
const RESULTS_DIR = resolve(__dirname, '../results');

const SMOKE = process.argv.includes('--smoke');
const RESUME_CHECK = process.argv.includes('--resume-check');
const RESUME = process.argv.includes('--resume') || RESUME_CHECK;
const RESTART = process.argv.includes('--restart');
const SCOPES_FLAG = process.argv.find((a) => a.startsWith('--scopes='));

const REPORT_JSON_PATH = resolve(RESULTS_DIR, SMOKE ? '.rrf-sweep-smoke-report.json' : '2026-07-23-rrf-k-sweep.json');
const REPORT_MD_PATH = resolve(RESULTS_DIR, '2026-07-23-rrf-k-sweep.md');

// Previously committed reports this benchmark compares its new k=2/k=60
// rows against — never overwritten by this script. SciFact has two prior
// reports with INCOMPATIBLE corpora: the full 300-query/5183-doc provider
// comparison, and the 100-query/1000-doc local-only RRF mini benchmark.
// Only the mini report is a like-for-like comparison for this sweep's
// scifact-local scope (same mini subset, same local provider) — the full
// report is never used for comparison (a delta against a different corpus
// size is not "drift"). scifact-cloud has no compatible prior mini run at
// all (the mini benchmark only ever ran the local profile), so it is
// reported as n/a, never silently compared against the incompatible full
// report either.
const PRIOR_MIRACL_REPORT_PATH = resolve(RESULTS_DIR, '2026-07-22-miracl-ru-provider-comparison.json');
const PRIOR_SCIFACT_LOCAL_MINI_REPORT_PATH = resolve(RESULTS_DIR, '2026-07-22-beir-scifact-local-rrf-mini.json');

function makeRedactor(secret) {
  return makeRedactorCore(secret, REPO_ROOT);
}

/** Writes JSON atomically: write to a sibling temp file, then rename over
 * the real path. A hard kill can only ever leave the temp file corrupted
 * (harmless, never read) or leave the real file exactly as it was before
 * this call — it can never leave the real checkpoint half-written. Plain
 * writeFileSync() to the real path directly does not have this guarantee:
 * a kill mid-write truncates the file that --resume/--restart read next. */
function writeJsonAtomic(path, value) {
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, path);
}

/** A 404 from deleteCollection means the collection is already gone — a
 * genuinely successful cleanup outcome, not a failure. This matters here
 * specifically because a checkpoint entry can legitimately name a
 * collection that was never created (a "planned" entry written before
 * createCollection() ran, then the process crashed before creation
 * happened) or one a previous cleanup pass already deleted — both are
 * completely normal states for --resume/--restart to encounter, and must
 * not be treated the same as "Qdrant rejected the delete for a real
 * reason" (auth failure, network issue, etc.), which SHOULD block the run. */
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

/** Per-scope provenance — each scope can differ meaningfully in memory
 * footprint (local ONNX embedding vs cloud server-side inference), models
 * used, and dataset identity, so a single global peak-RSS/commit/SDK-version
 * block is not enough to reconstruct exactly what produced one scope's
 * numbers. Captured once per scope, not just once globally. */
export function buildScopeProvenance({ scope, dataset, prepared }) {
  return {
    commitHash: currentCommitHash(),
    qdrantSdkVersion: sdkVersion(),
    onnxExecutionProviderRequested: scope.provider.kind === 'local'
      ? ((process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu').trim().toLowerCase() || 'cpu')
      : null,
    provider: {
      kind: scope.provider.kind,
      denseModelId: scope.provider.denseModelId,
      denseSize: scope.provider.denseSize,
      sparseModelId: scope.provider.sparseModelId,
    },
    datasetIdentity: {
      datasetMd5: dataset.datasetMd5,
      manifest: dataset.manifest ?? null,
      corpusSize: dataset.corpus.size,
      queryCount: dataset.queries.size,
    },
    preparedCache: {
      cachePath: prepared.cachePath ? prepared.cachePath.replace(REPO_ROOT, '.').replace(/\\/g, '/') : null,
      fromCache: prepared.fromCache ?? null,
    },
  };
}

function expectedMetricModes() {
  return ['dense', 'sparse', ...SWEEP_KS.map((k) => `hybrid_k${k}`)];
}

/** A scope is "complete" for --resume purposes only if it recorded every
 * expected mode's metrics for every expected query, indexing had zero
 * errors, and cleanup confirmed deletion. */
export function isCompletedScopeCheckpoint(scopeReport, { queryCount }) {
  if (!scopeReport) return false;
  if (scopeReport.indexing?.documentsIndexed == null || scopeReport.indexing?.errors !== 0) return false;
  if (scopeReport.queryStats?.total !== queryCount || scopeReport.queryStats?.ran !== queryCount || scopeReport.queryStats?.errors !== 0) return false;
  if ((scopeReport.errors?.length ?? 0) !== 0 || scopeReport.cleanup?.deleted !== true) return false;
  return expectedMetricModes().every((mode) => {
    const m = scopeReport.metrics?.[mode];
    return m?.queryCount === queryCount && typeof m.ndcgAt10 === 'number' && Number.isFinite(m.ndcgAt10);
  });
}

/** Loads the fixed 100-query/1000-doc dataset for one scope, strictly
 * offline (never fetches, never rebuilds — throws an actionable error if
 * the required cache is absent). SciFact and MIRACL loaders/qrels are
 * never merged into a shared structure. */
function loadScopeDataset(scope) {
  if (scope.dataset === 'scifact') {
    const miniSet = loadCachedMiniSet();
    return { corpus: miniSet.corpus, queries: miniSet.queries, qrels: miniSet.qrels, datasetMd5: 'beir-scifact-mini', manifest: miniSet.manifest ?? null };
  }
  const subset = loadCachedMiraclSubset();
  return { corpus: subset.corpus, queries: subset.queries, qrels: subset.qrels, datasetMd5: 'miracl-ru-subset', manifest: subset.manifest ?? null };
}

/** --smoke: shrinks an already-loaded scope dataset to a tiny deterministic
 * subset while preserving every relevant document required by the selected
 * queries' qrels (so metrics stay non-trivially computable). Still runs all
 * six k values — smoke validates plumbing, not benchmark results. */
export function shrinkForSmoke(dataset, { queryCount = SMOKE_QUERY_COUNT, corpusSize = SMOKE_CORPUS_SIZE } = {}) {
  const { corpus, queries, qrels } = dataset;
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
  return { corpus: smallCorpus, queries: smallQueries, qrels: smallQrels, datasetMd5: `${dataset.datasetMd5}-smoke`, manifest: null };
}

/** Normalizes a scope's corpus into the shared {title, text} shape
 * prepareInputs()/formatForLanes() expect. Preserve titles when the cached
 * dataset provides them because they are part of the embedding input. */
export function normalizeDocEntries(corpus, dataset) {
  if (dataset === 'scifact') return corpus;
  const normalized = new Map();
  for (const [id, passage] of corpus) {
    normalized.set(id, typeof passage === 'string'
      ? { title: '', text: passage }
      : { title: passage.title ?? '', text: passage.text ?? '' });
  }
  return normalized;
}

function buildBenchmarkContract({ scopeIds, corpusSize, queryCount }) {
  return {
    version: BENCHMARK_CHECKPOINT_VERSION,
    scopeIds,
    sweepKs: SWEEP_KS,
    referenceKs: [REFERENCE_K_QDRANT_DEFAULT, REFERENCE_K_SEMIDEX_DEFAULT],
    topK: TOP_K,
    hybridPrefetchLimit: HYBRID_PREFETCH_LIMIT,
    bm25Options: BM25_OPTIONS,
    corpusSizePerScope: corpusSize,
    queryCountPerScope: queryCount,
  };
}

/** Recomputes cleanupSummary/errors from CURRENT report.scopes, never by
 * accumulating across a --resume. Without this, a scope whose FIRST attempt
 * had a cleanup failure or a transient query error, but whose retry (after
 * --resume) succeeded fully, would still carry the stale failure/error
 * record forward from the spread of the old checkpoint — permanently
 * blocking an ACCEPT verdict for a run that actually completed cleanly.
 * `status: 'planned'`/`'running'` placeholder entries (a scope this run
 * hasn't reached yet, or one interrupted before finishing) never had a
 * cleanup attempt in the sense this function counts, so they contribute
 * zero to cleanupSummary and nothing to errors — only a scope with a real
 * `errors` array or `cleanup.attempted` flag (i.e. one executeScope()
 * actually ran to its finally block) does. */
export function rebuildReportAggregates(report) {
  const scopes = Object.values(report.scopes ?? {});
  report.cleanupSummary = {
    attempted: scopes.filter((s) => s.cleanup?.attempted).length,
    deleted: scopes.filter((s) => s.cleanup?.deleted).length,
    failed: scopes
      .filter((s) => s.cleanup?.attempted && !s.cleanup?.deleted)
      .map((s) => ({ scopeId: s.scopeId, collection: s.cleanup?.collection, error: s.cleanup?.error })),
  };
  report.errors = scopes.flatMap((s) => (s.errors ?? []).map((error) => ({ scopeId: s.scopeId, ...error })));
}

export function validateResumeCheckpoint(previous, contract) {
  if (!previous || typeof previous !== 'object') throw new Error('Resume checkpoint is not a JSON object.');
  if (!previous.benchmarkContract) throw new Error('Resume checkpoint has no benchmarkContract — cannot validate compatibility; use --restart.');
  if (JSON.stringify(previous.benchmarkContract) !== JSON.stringify(contract)) {
    throw new Error('Resume checkpoint contract does not match the current scope/k configuration.');
  }
  for (const scopeId of Object.keys(previous.scopes ?? {})) {
    if (!contract.scopeIds.includes(scopeId)) throw new Error(`Resume checkpoint contains unknown scope: ${scopeId}`);
  }
  return true;
}

async function main() {
  bootstrapEnv();
  if (RESUME && RESTART) throw new Error('Use either --resume or --restart, not both.');
  if (SMOKE && (RESUME || RESTART)) throw new Error('--resume/--restart are only valid for the full benchmark.');
  const scopesToRun = parseScopesFlag(SCOPES_FLAG ? SCOPES_FLAG.slice('--scopes='.length) : null);
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
  const effectiveScopes = SMOKE ? scopesToRun.slice(0, 1) : scopesToRun;
  console.log(`[rrf-sweep] scopes: ${effectiveScopes.map((s) => s.id).join(', ')}${SMOKE ? ' (SMOKE MODE)' : ''}`);
  console.log(`[rrf-sweep] sweep ks: ${SWEEP_KS.join(', ')}`);

  const contract = buildBenchmarkContract({
    scopeIds: effectiveScopes.map((s) => s.id),
    corpusSize: SMOKE ? SMOKE_CORPUS_SIZE : 1000,
    queryCount: SMOKE ? SMOKE_QUERY_COUNT : 100,
  });

  if (RESUME_CHECK) {
    const previous = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf-8'));
    validateResumeCheckpoint(previous, contract);
    const completed = effectiveScopes.filter((s) => isCompletedScopeCheckpoint(previous.scopes?.[s.id], { queryCount: contract.queryCountPerScope })).map((s) => s.id);
    const pending = effectiveScopes.map((s) => s.id).filter((id) => !completed.includes(id));
    clearInterval(rssTimer);
    console.log(`[rrf-sweep] resume checkpoint valid: ${completed.length}/${effectiveScopes.length} scopes complete`);
    console.log(`[rrf-sweep] completed: ${completed.join(', ') || '(none)'}`);
    console.log(`[rrf-sweep] pending: ${pending.join(', ') || '(none)'}`);
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
        // Carry the PREVIOUS process's peak RSS forward explicitly, before
        // this process's own (freshly-initialized, necessarily lower at
        // this point) peakRssBytes tracking overwrites it at finalization.
        // Without this, --resume always reports a peak no higher than
        // whatever THIS process alone reached — silently losing whatever
        // higher peak the earlier, now-exited process actually hit.
        priorPeakRssBytes: previous.environment?.peakRssBytes ?? previous.environment?.priorPeakRssBytes ?? null,
      },
    };
    delete report.finishedAt;
    // Recompute cleanupSummary/errors from the loaded scopes immediately —
    // never trust the spread-in previous.cleanupSummary/previous.errors,
    // which may reflect a now-superseded first attempt at a scope this
    // --resume is about to redo from scratch (see rebuildReportAggregates()).
    rebuildReportAggregates(report);
    console.log(`[rrf-sweep] checkpoint loaded: ${Object.keys(report.scopes ?? {}).length} scopes recorded`);
  } else {
    if (RESTART && existsSync(REPORT_JSON_PATH)) {
      // --restart discards the old checkpoint entirely, but that checkpoint
      // may still name a real, undeleted Qdrant collection from an
      // interrupted prior run. Clean up every such orphan BEFORE the
      // checkpoint recording their names is overwritten — otherwise they
      // become permanently untracked. If any cleanup fails, stop here
      // WITHOUT discarding the old checkpoint, so a later retry still has
      // the orphan's name to work from.
      let discarded;
      try { discarded = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf-8')); } catch { discarded = null; }
      if (discarded?.scopes) {
        for (const scopeId of Object.keys(discarded.scopes)) {
          const result = await cleanupOrphanedCollection({ client, redact, report: discarded, scope: { id: scopeId } });
          if (!result.ok) {
            clearInterval(rssTimer);
            throw new Error(`[rrf-sweep] refusing to --restart: failed to clean up an orphaned collection from the checkpoint being discarded, scope "${scopeId}" (${result.collection}). Fix the Qdrant connectivity/permissions issue and retry --restart — the old checkpoint has not been touched. Underlying error: ${result.error}`);
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
      },
      scopes: {},
      priorComparison: {},
      errors: [],
      cleanupSummary: { attempted: 0, deleted: 0, failed: [] },
      verdict: null,
    };
  }
  writeJsonAtomic(REPORT_JSON_PATH, report);

  // Strictly sequential — one scope at a time, never Promise.all().
  for (const scope of effectiveScopes) {
    if (RESUME && isCompletedScopeCheckpoint(report.scopes?.[scope.id], { queryCount: contract.queryCountPerScope })) {
      console.log(`[rrf-sweep] --- scope: ${scope.id} (checkpoint complete, skipping) ---`);
      continue;
    }
    const orphanCleanup = await cleanupOrphanedCollection({ client, redact, report, scope });
    if (!orphanCleanup.ok) {
      // A cleanup failure here means a previous run's collection is STILL
      // in Qdrant, untracked by anything this process is about to do next.
      // Continuing (which would overwrite the checkpoint that names it, or
      // run a new scope that replaces its recorded name) would make that
      // collection permanently unrecoverable. Stop the whole run instead —
      // the existing checkpoint is left exactly as it was, still naming the
      // orphan, so a later retry of --resume/--restart can try again.
      clearInterval(rssTimer);
      throw new Error(`[rrf-sweep] refusing to continue: failed to clean up an orphaned collection from a previous interrupted run for scope "${scope.id}" (${orphanCleanup.collection}). Fix the Qdrant connectivity/permissions issue and retry --resume or --restart — nothing in this run has been overwritten. Underlying error: ${orphanCleanup.error}`);
    }

    console.log(`\n[rrf-sweep] === scope: ${scope.id} ===`);
    let dataset = loadScopeDataset(scope);
    if (SMOKE) dataset = shrinkForSmoke(dataset);
    console.log(`[rrf-sweep] [${scope.id}] dataset ready: ${dataset.corpus.size} docs, ${dataset.queries.size} queries`);

    const docEntries = normalizeDocEntries(dataset.corpus, scope.dataset);
    const prepared = await prepareInputs({
      corpus: docEntries, queries: dataset.queries, datasetMd5: dataset.datasetMd5,
      log: (m) => console.log(m), trackRss, progressEvery: 200,
    });

    // Per-scope peak RSS: reset the baseline to the current process RSS
    // right before this scope's own indexing/querying starts, so each
    // scope's provenance reports what THAT scope added, not a cumulative
    // figure dominated by whichever scope ran first (e.g. local ONNX model
    // load) — the global peak (report.environment.peakRssBytes) is still
    // tracked separately and unaffected by this reset.
    const scopePeakRss = { bytes: process.memoryUsage().rss };
    const trackScopeRss = () => {
      const cur = process.memoryUsage().rss;
      if (cur > scopePeakRss.bytes) scopePeakRss.bytes = cur;
      trackRss();
    };

    // Generate the collection name and persist it to the checkpoint,
    // ATOMICALLY, BEFORE createCollection() is even called — this closes
    // the orphan window entirely (the earlier onCollectionCreated-callback
    // design still had a gap between createCollection() succeeding and the
    // callback firing; generating the name up front and recording it before
    // the collection exists means there is no window at all: either the
    // checkpoint names a collection that was never created, which
    // cleanupOrphanedCollection() safely no-ops on, or one that was).
    const collectionSuffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
    const plannedCollection = collectionName(scope.id, collectionSuffix);
    report.scopes[scope.id] = {
      scopeId: scope.id, status: 'planned', collection: plannedCollection,
      cleanup: { attempted: false, deleted: false, collection: plannedCollection, error: null },
    };
    writeJsonAtomic(REPORT_JSON_PATH, report);

    const scopeReport = await executeScope({
      client, redact, scope, dataset, prepared, trackRss: trackScopeRss,
      runsDir: effectiveRunsDir,
      runsDirLabel: effectiveRunsDirLabel,
      collection: plannedCollection,
    });
    scopeReport.provenance = {
      ...buildScopeProvenance({ scope, dataset, prepared }),
      peakRssBytes: scopePeakRss.bytes,
    };
    report.scopes[scope.id] = scopeReport;
    // Rebuild from current report.scopes rather than incrementally
    // appending — see rebuildReportAggregates()'s own doc comment for why
    // incremental appending double-counts/permanently retains a
    // superseded first attempt's failures across --resume.
    rebuildReportAggregates(report);

    writeJsonAtomic(REPORT_JSON_PATH, report);
  }

  if (!SMOKE) {
    report.priorComparison = computePriorComparison(report.scopes);
  }

  clearInterval(rssTimer);
  trackRss();
  report.environment.peakRssBytes = Math.max(peakRss.bytes, report.environment.priorPeakRssBytes ?? 0);
  report.finishedAt = new Date().toISOString();
  report.verdict = computeVerdict(report, effectiveScopes, contract);
  writeJsonAtomic(REPORT_JSON_PATH, report);
  if (!SMOKE) writeFileSync(REPORT_MD_PATH, renderMarkdownReport(report), 'utf-8');

  console.log('\n[rrf-sweep] === SUMMARY ===');
  for (const [scopeId, r] of Object.entries(report.scopes)) {
    const curve = SWEEP_KS.map((k) => `k${k}=${r.metrics?.[`hybrid_k${k}`]?.ndcgAt10?.toFixed(4) ?? 'n/a'}`).join(' ');
    console.log(`${scopeId}: dense=${r.metrics?.dense?.ndcgAt10?.toFixed(4) ?? 'n/a'} sparse=${r.metrics?.sparse?.ndcgAt10?.toFixed(4) ?? 'n/a'} | ${curve} | cleanup=${r.cleanup?.deleted ? 'ok' : 'FAILED'}`);
  }
  console.log('peak RSS:', (peakRss.bytes / 1e6).toFixed(0), 'MB');
  console.log('verdict:', report.verdict);
  console.log('report json:', REPORT_JSON_PATH.replace(REPO_ROOT, '.'));

  if (report.cleanupSummary.failed.length > 0) {
    console.error('\n!! CLEANUP FAILURES:');
    for (const f of report.cleanupSummary.failed) console.error(`!!   ${f.scopeId}: ${f.collection}`);
    process.exitCode = 1;
  }
}

/** If a previous interrupted run left this scope's owned collection behind
 * (recorded in the checkpoint but never confirmed deleted), delete ONLY
 * that exact collection name — verified to start with COLLECTION_PREFIX —
 * before re-running the scope from scratch. Never touches any other
 * collection. */
/**
 * @returns {{ ok: true, collection: null } | { ok: true, collection: string } | { ok: false, collection: string, error: string }}
 * `ok: true, collection: null` — nothing to clean up (no prior record, or
 * it was already confirmed deleted). `ok: true, collection` — an orphan was
 * found and successfully deleted (or Qdrant reports the delete succeeded
 * against a collection that may never have existed — either way, safe).
 * `ok: false` — an orphan is known to exist and deleting it failed; the
 * caller MUST NOT proceed to overwrite the checkpoint recording it, or the
 * collection becomes permanently untracked.
 */
export async function cleanupOrphanedCollection({ client, redact, report, scope }) {
  const prior = report.scopes?.[scope.id];
  if (!prior || prior.cleanup?.deleted) return { ok: true, collection: null };
  const orphan = prior.cleanup?.collection ?? prior.collection;
  if (!orphan || !orphan.startsWith(COLLECTION_PREFIX)) return { ok: true, collection: null };
  console.log(`[rrf-sweep] [${scope.id}] found an orphaned collection from an interrupted run: ${orphan} — deleting before re-running`);
  const delRes = await withBoundedRetry(() => client.deleteCollection(orphan));
  if (!isDeleteResultSuccessful(delRes)) {
    const errorMessage = redact(delRes.err);
    console.error(`[rrf-sweep] [${scope.id}] failed to delete orphaned collection ${orphan}: ${errorMessage}`);
    return { ok: false, collection: orphan, error: errorMessage };
  }
  return { ok: true, collection: orphan };
}

/** Runs ONE scope end to end: create collection -> index corpus ONCE
 * (batched) -> for every query, compute dense+sparse query vectors ONCE,
 * run dense-only ONCE, sparse-only ONCE, then SIX hybrid queries (one per
 * SWEEP_KS entry) sharing the same prefetch spec -> compute metrics
 * (aggregate + per-query for bootstrap) -> write TREC runs -> cleanup.
 * Cleanup always runs in `finally`, guarded to the exact collection prefix. */
export async function executeScope({
  client, redact, scope, dataset, prepared, trackRss = () => {},
  embedBatch = embedOnnxBatch,
  writeTrecRun = (path, content) => writeFileSync(path, content, 'utf-8'),
  runsDir = RUNS_DIR,
  runsDirLabel = '.runs',
  // Callers that need to persist the collection's name to a checkpoint
  // BEFORE it is created (see main()'s pre-flight checkpoint write below,
  // which closes the orphan window entirely by writing the name before
  // createCollection() is even called) should pass it in here instead of
  // letting this function generate its own — generating it internally
  // would reopen exactly the gap this parameter exists to close.
  collection = collectionName(scope.id, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`),
}) {
  const { corpus, queries, qrels } = dataset;
  const { provider } = scope;

  const scopeReport = {
    scopeId: scope.id, dataset: scope.dataset, providerId: scope.providerId, collection,
    indexing: { wallMs: null, documentsIndexed: 0, batches: 0, errors: 0, retries: 0 },
    queryStats: {
      total: queries.size, ran: 0, errors: 0, retries: 0,
      latencyMs: { dense: [], sparse: [], ...Object.fromEntries(SWEEP_KS.map((k) => [`hybrid_k${k}`, []])) },
    },
    metrics: {},
    perQueryMetrics: {},
    trecRunPaths: {},
    cleanup: { attempted: false, deleted: false, collection, error: null },
    errors: [],
  };

  const idMap = buildIdMapping([...corpus.keys()], `${collection}:doc`);
  if (idMap.collisions.length > 0) {
    scopeReport.errors.push({ step: 'id_mapping', error: `${idMap.collisions.length} point-ID collisions detected in doc ID mapping — aborting scope` });
    return scopeReport;
  }

  try {
    const docBodies = new Map([...prepared.documents].map(([docId, entry]) => [docId, entry.commonBody]));

    const vectors = { dense: { size: provider.denseSize, distance: 'Cosine' } };
    const sparse_vectors = provider.kind === 'local'
      ? { sparse: { index: { on_disk: false } } }
      : { sparse: { modifier: 'idf' } };
    const createRes = await withBoundedRetry(() => client.createCollection(collection, { vectors, sparse_vectors }));
    if (!createRes.ok) {
      scopeReport.errors.push({ step: 'create_collection', error: redact(createRes.err) });
      return scopeReport;
    }

    // ── index corpus ONCE, in bounded batches ──────────────────────────
    const indexStart = process.hrtime.bigint();
    const docIds = [...corpus.keys()];
    for (let i = 0; i < docIds.length; i += INDEX_BATCH_SIZE) {
      const batchIds = docIds.slice(i, i + INDEX_BATCH_SIZE);
      const points = await buildPoints({ provider, batchIds, docBodies, idMap, redact, scopeReport, embedBatch });
      if (points === null) continue;
      const upsertRes = await withBoundedRetry(
        () => client.upsert(collection, { wait: true, points }),
        { onRetry: () => { scopeReport.indexing.retries += 1; } },
      );
      if (!upsertRes.ok) {
        scopeReport.indexing.errors += 1;
        scopeReport.errors.push({ step: `upsert_batch_${i}`, error: redact(upsertRes.err) });
      } else {
        scopeReport.indexing.documentsIndexed += points.length;
      }
      scopeReport.indexing.batches += 1;
      if (scopeReport.indexing.batches % 10 === 0) {
        console.log(`[rrf-sweep] [${scope.id}] indexed ${scopeReport.indexing.documentsIndexed}/${docIds.length}`);
        trackRss();
      }
    }
    scopeReport.indexing.wallMs = Number((process.hrtime.bigint() - indexStart) / 1000000n);
    console.log(`[rrf-sweep] [${scope.id}] indexing complete: ${scopeReport.indexing.documentsIndexed} docs in ${scopeReport.indexing.wallMs}ms`);

    // ── sequential queries: one dense, one sparse, six hybrid (per k) ────
    const emptyRun = () => new Map([...queries.keys()].map((qid) => [qid, []]));
    const denseRun = emptyRun();
    const sparseRun = emptyRun();
    const hybridRuns = new Map(SWEEP_KS.map((k) => [k, emptyRun()]));

    let qi = 0;
    for (const queryId of queries.keys()) {
      qi += 1;
      const queryBody = prepared.queries.get(queryId)?.commonBody;
      if (typeof queryBody !== 'string') {
        scopeReport.queryStats.errors += 1;
        scopeReport.errors.push({ step: `prepare_query_${queryId}`, error: 'Prepared query body is missing' });
        continue;
      }

      // Dense + sparse query vectors computed exactly once, reused for the
      // dense-only query, the sparse-only query, and all six hybrid
      // queries' prefetch requests.
      const queryVectors = await buildQueryVector({ provider, body: queryBody, redact, scopeReport, embedBatch });
      if (queryVectors === null) { scopeReport.queryStats.errors += 1; continue; }

      const denseQ = await withBoundedRetry(
        () => client.query(collection, { query: queryVectors.dense, using: 'dense', limit: TOP_K, with_payload: false }),
        { onRetry: () => { scopeReport.queryStats.retries += 1; } },
      );
      const sparseQ = await withBoundedRetry(
        () => client.query(collection, { query: queryVectors.sparse, using: 'sparse', limit: TOP_K, with_payload: false }),
        { onRetry: () => { scopeReport.queryStats.retries += 1; } },
      );

      const modeResults = [['dense', denseQ, denseRun], ['sparse', sparseQ, sparseRun]];
      // Exactly six hybrid requests per query — same prefetch (dense+sparse,
      // limit 200 each), differing ONLY in query.rrf.k.
      for (const k of SWEEP_KS) {
        const hybridQ = await withBoundedRetry(
          () => client.query(collection, {
            prefetch: [
              { query: queryVectors.dense, using: 'dense', limit: HYBRID_PREFETCH_LIMIT },
              { query: queryVectors.sparse, using: 'sparse', limit: HYBRID_PREFETCH_LIMIT },
            ],
            query: { rrf: { k } },
            limit: TOP_K, with_payload: false,
          }),
          { onRetry: () => { scopeReport.queryStats.retries += 1; } },
        );
        modeResults.push([`hybrid_k${k}`, hybridQ, hybridRuns.get(k)]);
      }

      for (const [label, res, store] of modeResults) {
        if (res.ok) {
          scopeReport.queryStats.latencyMs[label].push(res.ms);
          const points = res.value?.points ?? [];
          store.set(queryId, points.map((p) => ({ docId: idMap.toString.get(String(p.id)) ?? String(p.id), score: p.score })));
        } else {
          scopeReport.queryStats.errors += 1;
          scopeReport.errors.push({ step: `query_${label}_${queryId}`, error: redact(res.err) });
          store.set(queryId, []);
        }
      }
      scopeReport.queryStats.ran += 1;
      if (qi % 25 === 0) { console.log(`[rrf-sweep] [${scope.id}] queries ${qi}/${queries.size}`); trackRss(); }
    }

    // ── metrics + TREC run persistence ───────────────────────────────────
    const toRankedMap = (scoredMap) => {
      const m = new Map();
      for (const [qid, docs] of scoredMap.entries()) m.set(qid, docs.map((d) => d.docId));
      return m;
    };
    const rankedByMode = {
      dense: toRankedMap(denseRun),
      sparse: toRankedMap(sparseRun),
      ...Object.fromEntries(SWEEP_KS.map((k) => [`hybrid_k${k}`, toRankedMap(hybridRuns.get(k))])),
    };
    for (const [label, ranked] of Object.entries(rankedByMode)) {
      scopeReport.metrics[label] = computeMetrics(qrels, ranked);
      scopeReport.perQueryMetrics[label] = [...perQueryMetrics(qrels, ranked).entries()];
    }

    const allModeStores = [['dense', denseRun], ['sparse', sparseRun], ...SWEEP_KS.map((k) => [`hybrid_k${k}`, hybridRuns.get(k)])];
    for (const [label, scoredMap] of allModeStores) {
      const trecPath = join(runsDir, `${scope.id}-${label}.trec`);
      writeTrecRun(trecPath, toTrecRunFormat(scoredMap, `rrf-sweep-${scope.id}-${label}`));
      scopeReport.trecRunPaths[label] = trecPath.replace(runsDir, runsDirLabel);
    }

    for (const label of Object.keys(rankedByMode)) {
      const arr = [...scopeReport.queryStats.latencyMs[label]].sort((a, b) => a - b);
      scopeReport.queryStats.latencyMs[label] = {
        p50: percentile(arr, 0.5), p95: percentile(arr, 0.95), max: arr.length ? arr[arr.length - 1] : null, count: arr.length,
      };
    }

    // ── per-k comparisons vs dense and vs the two reference constants ────
    scopeReport.comparisons = computeScopeComparisons(scopeReport.perQueryMetrics);
  } catch (err) {
    scopeReport.errors.push({ step: 'fatal', error: redact(err) });
  } finally {
    scopeReport.cleanup.attempted = true;
    if (!collection.startsWith(COLLECTION_PREFIX)) {
      scopeReport.cleanup.error = `Refusing to delete: name does not start with ${COLLECTION_PREFIX}`;
    } else {
      const delRes = await withBoundedRetry(() => client.deleteCollection(collection));
      scopeReport.cleanup.deleted = isDeleteResultSuccessful(delRes);
      if (!scopeReport.cleanup.deleted) scopeReport.cleanup.error = redact(delRes.err);
    }
  }

  return scopeReport;
}

async function buildPoints({ provider, batchIds, docBodies, idMap, redact, scopeReport, embedBatch }) {
  const bodies = batchIds.map((id) => docBodies.get(id));
  if (provider.kind === 'local') {
    const embedRes = await timed(() => embedBatch(bodies));
    if (!embedRes.ok) {
      scopeReport.indexing.errors += 1;
      scopeReport.errors.push({ step: 'embed_batch_local', error: redact(embedRes.err) });
      return null;
    }
    return batchIds.map((docId, i) => {
      const { dense, sparse } = embedRes.value[i];
      return {
        id: idMap.toPoint.get(docId),
        payload: { doc_id: docId, benchmark: 'rrf-sweep', scope: scopeReport.scopeId },
        vector: { dense, sparse: { indices: sparse.indices, values: sparse.values } },
      };
    });
  }
  return batchIds.map((docId, i) => {
    const { denseText, sparseText } = formatForLanes({ body: bodies[i], profileKind: provider.kind, role: 'document' });
    return {
      id: idMap.toPoint.get(docId),
      payload: { doc_id: docId, benchmark: 'rrf-sweep', scope: scopeReport.scopeId },
      vector: {
        dense: { text: denseText, model: provider.denseModelId },
        sparse: { text: sparseText, model: BM25_MODEL_ID, options: BM25_OPTIONS },
      },
    };
  });
}

async function buildQueryVector({ provider, body, redact, scopeReport, embedBatch }) {
  if (provider.kind === 'local') {
    const embedRes = await timed(() => embedBatch([body]));
    if (!embedRes.ok) {
      scopeReport.errors.push({ step: 'embed_query_local', error: redact(embedRes.err) });
      return null;
    }
    const { dense, sparse } = embedRes.value[0];
    return { dense, sparse: { indices: sparse.indices, values: sparse.values } };
  }
  const { denseText, sparseText } = formatForLanes({ body, profileKind: provider.kind, role: 'query' });
  return {
    dense: { text: denseText, model: provider.denseModelId },
    sparse: { text: sparseText, model: BM25_MODEL_ID, options: BM25_OPTIONS },
  };
}

/** Per-k comparisons within one scope: each hybrid_k vs dense, and each
 * hybrid_k vs the two reference constants (k=2, k=60). Every comparison is
 * built as pairedBootstrapByQuery(<baseline>, <comparison>) so meanDelta
 * always reads as "<comparison> minus <baseline>" — matching the earlier
 * fusion-diagnosis sign-label bug fix, never repeated here. */
export function computeScopeComparisons(perQueryMetricsRaw) {
  const pq = Object.fromEntries(Object.entries(perQueryMetricsRaw).map(([label, entries]) => [label, new Map(entries)]));
  const comparisons = {};
  if (!pq.dense) return comparisons;

  for (const k of SWEEP_KS) {
    const hybridKey = `hybrid_k${k}`;
    if (!pq[hybridKey]) continue;
    // hybrid_k<k>_vs_dense: baseline=dense, comparison=hybrid_k<k> -> meanDelta = hybrid_k<k> − dense.
    comparisons[`${hybridKey}_vs_dense`] = pairedBootstrapByQuery(pq.dense, pq[hybridKey], 'ndcgAt10');
  }

  for (const refK of [REFERENCE_K_QDRANT_DEFAULT, REFERENCE_K_SEMIDEX_DEFAULT]) {
    const refKey = `hybrid_k${refK}`;
    if (!pq[refKey]) continue;
    for (const k of SWEEP_KS) {
      if (k === refK) continue;
      const hybridKey = `hybrid_k${k}`;
      if (!pq[hybridKey]) continue;
      // hybrid_k<k>_vs_k<refK>: baseline=hybrid_k<refK>, comparison=hybrid_k<k> -> meanDelta = k<k> − k<refK>.
      comparisons[`${hybridKey}_vs_k${refK}`] = pairedBootstrapByQuery(pq[refKey], pq[hybridKey], 'ndcgAt10');
    }
  }

  return comparisons;
}

/** Compares the new sweep's k=2/k=60 rows against a previously committed
 * report that measured the same corpus/query set under a compatible
 * provider configuration. A delta between incompatible runs is not
 * "drift" and must not be reported as if it were. Concretely:
 *   - miracl-local / miracl-cloud: compared against the committed MIRACL
 *     provider-comparison report when the execution-provider configuration
 *     is also compatible.
 *   - scifact-local: compared against the committed LOCAL-ONLY RRF mini
 *     benchmark — same 100q/1000d mini subset, exact match. This is the
 *     ONLY compatible prior SciFact report; the full 300-query/5183-doc
 *     provider-comparison report is never used here even though it exists,
 *     because its corpus is a different size entirely.
 *   - scifact-cloud: no compatible prior report exists at all (the mini
 *     benchmark only ever ran the local profile) — reported as
 *     `{ comparable: false, reason: ... }`, never silently compared
 *     against the incompatible full-SciFact report.
 * Cloud drift (where a comparison IS made) may reflect hosted-model/
 * service changes; local drift should be investigated — this function only
 * records the numbers, it never labels drift as expected or unexpected. */
export function computePriorComparison(scopes) {
  const priorMiracl = readJsonIfExists(PRIOR_MIRACL_REPORT_PATH);
  const priorScifactLocalMini = readJsonIfExists(PRIOR_SCIFACT_LOCAL_MINI_REPORT_PATH);
  const result = {};

  const buildRow = (priorMetrics, newMetrics) => {
    if (!priorMetrics || !newMetrics) return null;
    return {
      comparable: true,
      priorNdcgAt10: priorMetrics.ndcgAt10 ?? null,
      newNdcgAt10: newMetrics.ndcgAt10 ?? null,
      delta: (typeof priorMetrics.ndcgAt10 === 'number' && typeof newMetrics.ndcgAt10 === 'number')
        ? newMetrics.ndcgAt10 - priorMetrics.ndcgAt10
        : null,
    };
  };

  for (const [scopeId, scopeReport] of Object.entries(scopes)) {
    const rows = {};
    for (const refK of [REFERENCE_K_QDRANT_DEFAULT, REFERENCE_K_SEMIDEX_DEFAULT]) {
      const mode = `hybrid_k${refK}`;
      const newMetrics = scopeReport.metrics?.[mode];

      if (scopeId === 'scifact-cloud') {
        rows[mode] = { comparable: false, reason: 'No compatible prior report exists: the local-only RRF mini benchmark never ran the cloud profile, and the full 300-query/5183-doc SciFact report uses a different-sized corpus than this sweep\'s 100-query/1000-doc mini subset.' };
        continue;
      }
      if (scopeId === 'scifact-local') {
        const priorMetrics = priorScifactLocalMini?.run?.metrics?.[mode] ?? null;
        rows[mode] = buildRow(priorMetrics, newMetrics) ?? { comparable: false, reason: 'Prior local mini-benchmark report or this mode\'s metrics are unavailable.' };
        continue;
      }
      // miracl-local / miracl-cloud
      const [, providerId] = scopeId.split('-');
      if (scopeId === 'miracl-local') {
        const priorEp = priorMiracl?.provenance?.onnxExecutionProviderRequested;
        const currentEp = scopeReport.provenance?.onnxExecutionProviderRequested;
        if (priorEp && currentEp && priorEp !== currentEp) {
          rows[mode] = {
            comparable: false,
            reason: `Execution provider differs: prior MIRACL local used ${priorEp}, current sweep used ${currentEp}.`,
          };
          continue;
        }
      }
      const priorMetrics = priorMiracl?.runs?.[providerId]?.metrics?.[mode] ?? null;
      rows[mode] = buildRow(priorMetrics, newMetrics) ?? { comparable: false, reason: 'Prior MIRACL provider-comparison report or this mode\'s metrics are unavailable.' };
    }
    result[scopeId] = rows;
  }
  return result;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function metricsAreFullyValid(m, expectedQueryCount) {
  if (!m || m.queryCount !== expectedQueryCount) return false;
  const fields = ['ndcgAt10', 'mapAt100', 'recallAt10', 'recallAt100', 'precisionAt10', 'mrrAt10'];
  return fields.every((f) => typeof m[f] === 'number' && Number.isFinite(m[f]));
}

export function computeVerdict(report, scopesRun, contract) {
  const expectedScopeIds = new Set(scopesRun.map((s) => s.id));
  const completedScopeIds = new Set(Object.keys(report.scopes));
  const allPresent = expectedScopeIds.size === completedScopeIds.size && [...expectedScopeIds].every((id) => completedScopeIds.has(id));
  if (!allPresent) return SMOKE ? 'RRF_SWEEP_SMOKE_BLOCKED' : 'RRF_SWEEP_HARNESS_BLOCKED';

  const cleanupOk = report.cleanupSummary.failed.length === 0;
  let anyMetricsValid = false;
  let allMetricsValid = true;
  let anyRequestErrors = false;
  for (const scopeReport of Object.values(report.scopes)) {
    const metricsOk = expectedMetricModes().every((mode) => metricsAreFullyValid(scopeReport.metrics?.[mode], contract.queryCountPerScope));
    if (metricsOk) anyMetricsValid = true; else allMetricsValid = false;
    if ((scopeReport.errors?.length ?? 0) > 0 || scopeReport.queryStats.errors > 0 || scopeReport.indexing.errors > 0) anyRequestErrors = true;
  }

  const prefix = SMOKE ? 'RRF_SWEEP_SMOKE' : 'RRF_SWEEP_HARNESS';
  if (allMetricsValid && cleanupOk && !anyRequestErrors) return `${prefix}_ACCEPT`;
  if (anyMetricsValid) return `${prefix}_PARTIAL`;
  return `${prefix}_REJECT`;
}

function metricCell(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : 'n/a';
}

/** Derives the concrete, per-scope answers the task's report requirements
 * ask for, straight from already-computed metrics/comparisons — never a
 * placeholder deferring to some other document. */
export function computeSweepAnswers(report) {
  const perScope = {};
  for (const [scopeId, r] of Object.entries(report.scopes ?? {})) {
    const curve = SWEEP_KS.map((k) => ({ k, ndcgAt10: r.metrics?.[`hybrid_k${k}`]?.ndcgAt10 ?? null }));
    const finiteCurve = curve.filter((p) => typeof p.ndcgAt10 === 'number' && Number.isFinite(p.ndcgAt10));
    // bestKs/worstKs: ALL k values tied at the max/min, not just the first
    // one reduce() happens to land on. A scope where k=5 and k=30 are
    // exactly tied at the top must report BOTH, not silently pick one and
    // let a later cross-scope comparison treat it as a single, arbitrary
    // "the" best k.
    const bestNdcg = finiteCurve.length ? Math.max(...finiteCurve.map((p) => p.ndcgAt10)) : null;
    const worstNdcg = finiteCurve.length ? Math.min(...finiteCurve.map((p) => p.ndcgAt10)) : null;
    const bestKs = bestNdcg === null ? [] : finiteCurve.filter((p) => p.ndcgAt10 === bestNdcg).map((p) => p.k);
    const worstKs = worstNdcg === null ? [] : finiteCurve.filter((p) => p.ndcgAt10 === worstNdcg).map((p) => p.k);
    // "Does hybrid match or beat dense" per k — bootstrap-significant only.
    const vsDenseByK = SWEEP_KS.map((k) => {
      const cmp = r.comparisons?.[`hybrid_k${k}_vs_dense`];
      if (!cmp) return { k, verdict: null, meanDelta: null, wins: null, losses: null, ties: null };
      return { k, verdict: cmp.verdict, meanDelta: cmp.meanDelta, wins: cmp.wins, losses: cmp.losses, ties: cmp.ties };
    });
    // Partition every k into its own verdict group — a scope can genuinely
    // have SOME k's significantly better than dense (B_BETTER), SOME
    // significantly worse (A_BETTER), and SOME MIXED/INCONCLUSIVE, all at
    // once. Never collapse these into one "any k did X" boolean and then
    // describe the whole scope as if that boolean covered every k — that
    // was the exact bug: "none is bootstrap-significantly worse" was
    // asserted whenever no k was B_BETTER, even when some OTHER k was
    // genuinely A_BETTER (significantly worse than dense).
    const betterKs = vsDenseByK.filter((row) => row.verdict === 'B_BETTER').map((row) => row.k);
    const worseKs = vsDenseByK.filter((row) => row.verdict === 'A_BETTER').map((row) => row.k);
    const mixedKs = vsDenseByK.filter((row) => row.verdict === 'MIXED').map((row) => row.k);
    const inconclusiveKs = vsDenseByK.filter((row) => row.verdict === 'INCONCLUSIVE').map((row) => row.k);
    // rescue/harm trend as k increases (using wins=rescue, losses=harm from
    // each hybrid_k_vs_dense comparison — the same paired-query classification
    // the earlier offline fusion diagnosis used).
    const rescueHarmByK = vsDenseByK.map((row) => ({ k: row.k, rescues: row.wins, harms: row.losses, ties: row.ties }));

    perScope[scopeId] = {
      curve, bestKs, worstKs, vsDenseByK, betterKs, worseKs, mixedKs, inconclusiveKs, rescueHarmByK,
    };
  }

  // Is any single k a best (or tied-best) point on EVERY scope that has a
  // valid curve? Computed as the INTERSECTION of each scope's own bestKs
  // set — a k that is merely the (arbitrary) first-found max on one scope
  // and absent from another scope's tie set must never be reported as
  // "stable across scopes". If a scope has multiple tied best k values,
  // any of them can participate in the intersection.
  const scopeIdsWithCurve = Object.keys(perScope).filter((id) => perScope[id].bestKs.length > 0);
  const bestKsPerScope = Object.fromEntries(scopeIdsWithCurve.map((id) => [id, perScope[id].bestKs]));
  let stableKsAcrossScopes = null;
  if (scopeIdsWithCurve.length > 0) {
    let intersection = new Set(bestKsPerScope[scopeIdsWithCurve[0]]);
    for (const id of scopeIdsWithCurve.slice(1)) {
      const scopeBestKs = new Set(bestKsPerScope[id]);
      intersection = new Set([...intersection].filter((k) => scopeBestKs.has(k)));
    }
    stableKsAcrossScopes = [...intersection].sort((a, b) => a - b);
  }

  return { perScope, bestKsPerScope, stableKsAcrossScopes, scopeIdsWithCurve };
}

function bootstrapCell(cmp) {
  if (!cmp) return 'n/a';
  const ci = cmp.ciLow !== null ? `[${cmp.ciLow.toFixed(4)}, ${cmp.ciHigh.toFixed(4)}]` : 'n/a';
  return `${cmp.verdict} (meanΔ=${cmp.meanDelta !== null ? cmp.meanDelta.toFixed(4) : 'n/a'}, CI95%=${ci}, W/L/T=${cmp.wins}/${cmp.losses}/${cmp.ties}, n=${cmp.n})`;
}

function curveShapeLabel(curve) {
  const finite = curve.filter((p) => typeof p.ndcgAt10 === 'number' && Number.isFinite(p.ndcgAt10));
  if (finite.length < SWEEP_KS.length) return 'incomplete';
  const values = finite.map((p) => p.ndcgAt10);
  const range = Math.max(...values) - Math.min(...values);
  if (range < 0.005) return 'flat (nDCG@10 varies by less than 0.005 across all six k values)';
  let increasing = true;
  let decreasing = true;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) increasing = false;
    if (values[i] > values[i - 1]) decreasing = false;
  }
  if (increasing) return 'monotonically increasing with k';
  if (decreasing) return 'monotonically decreasing with k';
  return 'non-monotonic (has an interior peak or trough)';
}

/** Renders the FACT/INFERENCE/HYPOTHESIS-labeled answers to the six
 * required questions, straight from computeSweepAnswers()'s already-derived
 * per-scope numbers — never a placeholder deferring elsewhere. */
function renderAnswersSection(answers, report) {
  const lines = [];
  const scopeIds = Object.keys(report.scopes ?? {});

  lines.push('### 1. Observed RRF curve per scope');
  lines.push('');
  for (const scopeId of scopeIds) {
    const a = answers.perScope[scopeId];
    if (!a || a.bestKs.length === 0) { lines.push(`- **${scopeId}**: FACT — curve incomplete or all k values invalid; no shape can be reported.`); continue; }
    const curveStr = a.curve.map((p) => `k${p.k}=${metricCell(p.ndcgAt10)}`).join(', ');
    const bestLabel = a.bestKs.length > 1 ? `tied best: ${a.bestKs.map((k) => `k${k}`).join(', ')}` : `best: k${a.bestKs[0]}`;
    const worstLabel = a.worstKs.length > 1 ? `tied worst: ${a.worstKs.map((k) => `k${k}`).join(', ')}` : `worst: k${a.worstKs[0]}`;
    const bestNdcg = a.curve.find((p) => p.k === a.bestKs[0])?.ndcgAt10;
    const worstNdcg = a.curve.find((p) => p.k === a.worstKs[0])?.ndcgAt10;
    lines.push(`- **${scopeId}**: FACT — ${curveShapeLabel(a.curve)}. Values: ${curveStr}. ${bestLabel} (${metricCell(bestNdcg)}), ${worstLabel} (${metricCell(worstNdcg)}).`);
  }
  lines.push('');

  lines.push('### 2. Does any k make hybrid match or beat dense on MIRACL?');
  lines.push('');
  for (const scopeId of scopeIds.filter((id) => id.startsWith('miracl-'))) {
    const a = answers.perScope[scopeId];
    if (!a) { lines.push(`- **${scopeId}**: FACT — no data.`); continue; }
    // Every k is partitioned into exactly one of four groups
    // (betterKs/worseKs/mixedKs/inconclusiveKs) — describe whichever groups
    // are non-empty explicitly, rather than a single boolean branch that
    // can claim "none is worse" while a DIFFERENT k in the same scope is
    // genuinely bootstrap-significantly worse than dense.
    if (a.betterKs.length > 0) {
      lines.push(`- **${scopeId}**: FACT — yes, hybrid is bootstrap-significantly better than dense at: ${a.betterKs.map((k) => `k${k}`).join(', ')}.`);
    }
    if (a.worseKs.length > 0) {
      lines.push(`- **${scopeId}**: FACT — hybrid is bootstrap-significantly WORSE than dense at: ${a.worseKs.map((k) => `k${k}`).join(', ')}.`);
    }
    if (a.mixedKs.length > 0) {
      lines.push(`- **${scopeId}**: FACT — MIXED (real per-query wins on both sides, net effect not significant — NOT evidence of equivalence) at: ${a.mixedKs.map((k) => `k${k}`).join(', ')}.`);
    }
    if (a.inconclusiveKs.length > 0) {
      lines.push(`- **${scopeId}**: FACT — INCONCLUSIVE (insufficient evidence to call a direction — NOT evidence of equivalence) at: ${a.inconclusiveKs.map((k) => `k${k}`).join(', ')}.`);
    }
    if (a.mixedKs.length > 0 || a.inconclusiveKs.length > 0) {
      lines.push(`  - Absence of a significant difference at these k values means NO STATISTICALLY SIGNIFICANT DIFFERENCE was found there, not that hybrid "matches" dense — establishing equivalence would require a pre-registered non-inferiority margin, which this sweep does not define.`);
    }
    if (a.betterKs.length === 0 && a.worseKs.length === 0 && a.mixedKs.length === 0 && a.inconclusiveKs.length === 0) {
      lines.push(`- **${scopeId}**: FACT — no valid dense-vs-hybrid comparison available for any k.`);
    }
  }
  lines.push('');

  lines.push('### 3. Is one k stable across all four scopes, or dataset/provider-dependent?');
  lines.push('');
  if (answers.scopeIdsWithCurve.length < scopeIds.length) {
    lines.push('- INFERENCE — not all scopes produced a valid curve in this run; a stability claim across "all four scopes" cannot be made from partial data. See per-scope best k below.');
  } else if (answers.stableKsAcrossScopes && answers.stableKsAcrossScopes.length > 0) {
    lines.push(`- FACT — k${answers.stableKsAcrossScopes.join(', k')} ${answers.stableKsAcrossScopes.length > 1 ? 'are each' : 'is'} a best (or tied-best) point on EVERY scope's curve in this run.`);
  } else {
    lines.push('- FACT — no single k is a best (or tied-best) point on every scope; the best-k sets differ by scope.');
  }
  for (const [scopeId, ks] of Object.entries(answers.bestKsPerScope)) {
    lines.push(`  - ${scopeId}: best k${ks.length > 1 ? 's (tied)' : ''} = k${ks.join(', k')}`);
  }
  lines.push('- HYPOTHESIS — even where one k happens to be best (or tied-best) in this run, that does not establish it as the correct default: a bootstrap-insignificant best point (small margin, wide CI) is not real evidence of superiority over neighboring k values. See the per-scope bootstrap comparisons above before treating "best observed" as "best".');
  lines.push('');

  lines.push('### 4. How do rescue/harm counts change as k increases?');
  lines.push('');
  for (const scopeId of scopeIds) {
    const a = answers.perScope[scopeId];
    if (!a) continue;
    const trend = a.rescueHarmByK.map((r) => `k${r.k}: ${r.rescues ?? 'n/a'}R/${r.harms ?? 'n/a'}H/${r.ties ?? 'n/a'}T`).join(', ');
    lines.push(`- **${scopeId}**: FACT — ${trend} (R=hybrid nDCG@10 > dense per query, H=hybrid < dense, T=tie; from the hybrid_k*_vs_dense paired comparisons above).`);
  }
  lines.push('');

  lines.push('### 5. Is k=2 or k=60 consistently preferable?');
  lines.push('');
  for (const scopeId of scopeIds) {
    const r = report.scopes[scopeId];
    const cmp = r?.comparisons?.hybrid_k2_vs_k60;
    if (!cmp) { lines.push(`- **${scopeId}**: FACT — no direct k2-vs-k60 comparison available.`); continue; }
    const label = cmp.verdict === 'B_BETTER' ? 'k2 is bootstrap-significantly better than k60'
      : cmp.verdict === 'A_BETTER' ? 'k60 is bootstrap-significantly better than k2'
        : cmp.verdict === 'MIXED' ? 'no significant difference — real per-query wins on both sides, net effect not significant (MIXED)'
          : 'no significant difference — insufficient evidence to call a direction (INCONCLUSIVE)';
    lines.push(`- **${scopeId}**: FACT — ${label} (meanΔ=k2−k60=${metricCell(cmp.meanDelta)}, W/L/T=${cmp.wins}/${cmp.losses}/${cmp.ties}).`);
  }
  lines.push('- INFERENCE — a per-scope winner between k=2 and k=60 is not the same claim as "one of these two constants is consistently preferable across scopes"; see whether the per-scope labels above agree before drawing that conclusion.');
  lines.push('');

  lines.push('### 6. What evidence is still required before changing production RRF_K?');
  lines.push('');
  lines.push('- HYPOTHESIS — this exploratory sweep alone is not sufficient: it covers');
  lines.push('  4 scopes at fixed 100-query/1000-document subsets, not the full corpora');
  lines.push('  or Semidex\'s actual production document mix (chunked Markdown/code,');
  lines.push('  not SciFact abstracts or MIRACL passages).');
  lines.push('- Before changing the production `RRF_K` default, additional evidence');
  lines.push('  would need to include: (a) confirmation the observed best-k pattern');
  lines.push('  replicates on a held-out query sample, not just this run\'s 100 queries;');
  lines.push('  (b) a full, non-mini SciFact and non-mini MIRACL run at the same k');
  lines.push('  values, to rule out subset-selection artifacts; (c) evaluation on');
  lines.push('  Semidex\'s own indexed content (chunked technical documents), since');
  lines.push('  neither SciFact nor MIRACL is representative of that domain; (d) repeat');
  lines.push('  runs to establish whether cloud-side hosted-model variance (see the');
  lines.push('  prior-comparison section above) changes the outcome run to run.');
  lines.push('- This report does not recommend changing the production RRF_K default,');
  lines.push('  and does not recommend disabling sparse retrieval globally.');
  lines.push('');

  return lines;
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push('# Live Qdrant RRF-k sweep — SciFact and MIRACL Russian');
  lines.push('');
  lines.push(`Verdict: **${report.verdict}**`);
  lines.push('');
  lines.push('Real Qdrant hybrid queries only — every hybrid_k row below was produced');
  lines.push('by a live query with prefetch=200/lane, varying only `query.rrf.k`. No');
  lines.push('local RRF reconstruction from saved TREC files is used anywhere in this');
  lines.push('report. SciFact and MIRACL scopes are kept strictly separate.');
  lines.push('');
  lines.push(`Sweep k values: ${report.benchmarkContract.sweepKs.join(', ')}`);
  lines.push('');
  lines.push('## Retrieval quality');
  lines.push('');
  lines.push('| Scope | Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | Precision@10 | MRR@10 |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const [scopeId, r] of Object.entries(report.scopes)) {
    for (const [mode, m] of Object.entries(r.metrics ?? {})) {
      lines.push(`| ${scopeId} | ${mode} | ${metricCell(m.ndcgAt10)} | ${metricCell(m.mapAt100)} | ${metricCell(m.recallAt10)} | ${metricCell(m.recallAt100)} | ${metricCell(m.precisionAt10)} | ${metricCell(m.mrrAt10)} |`);
    }
  }
  lines.push('');
  lines.push('## Per-k comparisons (deterministic paired bootstrap, vs dense; sign = comparison − baseline)');
  lines.push('');
  lines.push(`Seed: \`${DEFAULT_BOOTSTRAP_SEED}\`, iterations: ${DEFAULT_BOOTSTRAP_ITERATIONS}.`);
  lines.push('');
  for (const [scopeId, r] of Object.entries(report.scopes)) {
    lines.push(`### ${scopeId}`);
    lines.push('');
    for (const [label, cmp] of Object.entries(r.comparisons ?? {})) {
      lines.push(`- **${label}**: ${bootstrapCell(cmp)}`);
    }
    lines.push('');
  }
  lines.push('## Comparison against previously committed k=2/k=60 reports');
  lines.push('');
  lines.push('Only compared against a prior report on the same corpus/query set with');
  lines.push('a compatible provider configuration. Deltas between incompatible runs');
  lines.push('are not "drift" and are never reported as numbers. Where a real');
  lines.push('comparison is made: local drift should be investigated. Cloud drift may');
  lines.push('reflect hosted-model/service changes on Qdrant\'s side — reported as a');
  lines.push('fact, not silently treated as equivalent to the prior run.');
  lines.push('');
  lines.push('| Scope | Mode | Prior nDCG@10 | New nDCG@10 | Delta | Comparable |');
  lines.push('|---|---|---:|---:|---:|---|');
  for (const [scopeId, rows] of Object.entries(report.priorComparison ?? {})) {
    for (const [mode, row] of Object.entries(rows)) {
      if (!row || row.comparable === false) {
        lines.push(`| ${scopeId} | ${mode} | n/a | n/a | n/a | no — ${row?.reason ?? 'unavailable'} |`);
        continue;
      }
      lines.push(`| ${scopeId} | ${mode} | ${metricCell(row.priorNdcgAt10)} | ${metricCell(row.newNdcgAt10)} | ${metricCell(row.delta)} | yes |`);
    }
  }
  lines.push('');
  lines.push('## Answers');
  lines.push('');
  const answers = computeSweepAnswers(report);
  lines.push(...renderAnswersSection(answers, report));
  lines.push('## Operations');
  lines.push('');
  lines.push('| Scope | Indexed | Index wall ms | Query errors | Retries | Cleanup | Scope peak RSS |');
  lines.push('|---|---:|---:|---:|---:|---|---:|');
  for (const [scopeId, r] of Object.entries(report.scopes)) {
    lines.push(`| ${scopeId} | ${r.indexing.documentsIndexed} | ${r.indexing.wallMs ?? 'n/a'} | ${r.queryStats.errors} | ${r.indexing.retries + r.queryStats.retries} | ${r.cleanup?.deleted ? 'deleted' : 'FAILED'} | ${r.provenance?.peakRssBytes ?? 'n/a'} |`);
  }
  lines.push(`\nPeak process RSS (whole run): ${report.environment.peakRssBytes ?? 'n/a'} bytes`);
  lines.push('');
  lines.push('## Per-scope provenance');
  lines.push('');
  lines.push('| Scope | Commit | SDK | ONNX EP | Dense model | Sparse model | Corpus/queries | Manifest seed |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const [scopeId, r] of Object.entries(report.scopes)) {
    const p = r.provenance;
    if (!p) { lines.push(`| ${scopeId} | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`); continue; }
    const seed = p.datasetIdentity?.manifest?.selectionSeed ?? 'n/a';
    lines.push(`| ${scopeId} | ${p.commitHash?.slice(0, 12) ?? 'n/a'} | ${p.qdrantSdkVersion ?? 'n/a'} | ${p.onnxExecutionProviderRequested ?? 'n/a'} | ${p.provider.denseModelId} | ${p.provider.sparseModelId} | ${p.datasetIdentity.corpusSize}/${p.datasetIdentity.queryCount} | ${seed} |`);
  }
  lines.push('');
  lines.push('## Interpretation limits');
  lines.push('');
  lines.push('- FACT: every hybrid_k row was produced by a real Qdrant hybrid query,');
  lines.push('  prefetch=200/lane, final limit 100 — never a local RRF reconstruction.');
  lines.push('- FACT: SciFact and MIRACL qrels/metrics are never merged.');
  lines.push('- FACT: SciFact scope here is the LOCAL MINI pooled subset (100q/1000d),');
  lines.push('  not the full 300-query SciFact test split.');
  lines.push('- This exploratory sweep does not by itself justify changing the');
  lines.push('  production RRF_K default, and does not justify disabling sparse globally.');
  lines.push('- No single k should be called a universal winner merely because it has');
  lines.push('  the largest aggregate average on one or two scopes.');
  lines.push('');
  if (report.errors?.length) {
    lines.push('## Errors', '', `Recorded errors: ${report.errors.length}. See the JSON report for redacted details.`, '');
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .catch((err) => {
      const redact = makeRedactor(process.env.QDRANT_KEY);
      console.error('[rrf-sweep] unhandled error:', redact(err));
      process.exitCode = 1;
    })
    .finally(() => shutdownOnnxEmbedCapability());
}
