// Live Qdrant weighted-RRF validation benchmark: validates the offline
// weighted-RRF candidate selection (analyze-weighted-rrf.mjs,
// 2026-07-23-weighted-rrf-offline-analysis.json) against REAL Qdrant 1.17+
// hybrid queries, using the real `query.rrf.weights` contract — never
// `prefetch.weight`, never a local rank reconstruction.
//
// This is NOT another RRF-k sweep (see run-rrf-sweep.mjs for that) and NOT
// another offline reconstruction (see analyze-weighted-rrf.mjs). It answers
// four questions with real Qdrant execution:
//   1. Does dense-heavy weighted RRF remove/reduce the MIRACL regression
//      the completed CUDA k-sweep observed under equal-weight hybrid?
//   2. Does it preserve useful sparse contribution where sparse helps?
//   3. Does it preserve SciFact quality vs dense-only and equal hybrid?
//   4. Do the offline weighted-RRF conclusions agree with real execution?
//
// Execution rule per scope: ONE collection, ONE indexing pass, then per
// query: dense and sparse query vectors computed ONCE, then all six fusion
// modes evaluated from those same vectors (dense-only, sparse-only, equal
// RRF k=2, equal RRF k=60, primary candidate k2/rho0.10, diagnostic
// neighbor k2/rho0.25) — every hybrid mode shares the identical prefetch
// spec (same vectors, HYBRID_PREFETCH_LIMIT per lane), differing only in
// query.rrf.k/weights. Scopes run strictly sequentially — never
// Promise.all() across scopes, never concurrent collections/indexing/ONNX
// sessions.
//
// CUDA requirement: local scopes MUST run under strict CUDA
// (ONNX_EXECUTION_PROVIDER=cuda ONNX_CUDA_STRICT=1) — the harness verifies
// the EFFECTIVE provider (via core/onnx-embed.js's getOnnxProviderState(),
// not just what was requested) after the first local embedding call, and
// rejects the scope if CUDA was requested but the effective provider was
// not CUDA. Cloud scopes report ONNX EP as not applicable (n/a) — Qdrant
// Cloud Inference does all embedding server-side.
//
// Run (full, 4 scopes):     node benchmarks/external/fusion/run-weighted-rrf-live.mjs
// Resume:                   node benchmarks/external/fusion/run-weighted-rrf-live.mjs --resume
// Restart (discard prior):  node benchmarks/external/fusion/run-weighted-rrf-live.mjs --restart
// Check resume state only:  node benchmarks/external/fusion/run-weighted-rrf-live.mjs --resume-check
// Smoke (tiny, plumbing only, separate path): node benchmarks/external/fusion/run-weighted-rrf-live.mjs --smoke
// Subset of scopes:         node benchmarks/external/fusion/run-weighted-rrf-live.mjs --scopes=scifact-local,miracl-cloud
//
// Requires QDRANT_URL / QDRANT_KEY (Semidex's own bootstrapEnv()). For
// local scopes, ONNX_EXECUTION_PROVIDER=cuda and ONNX_CUDA_STRICT=1 should
// be set in the environment before running the full (non-smoke) benchmark
// — the harness does not set these itself (never hardcodes a user-specific
// runtime configuration; reads whatever the environment already provides).
// Uses only the existing validated cached subsets (loadCachedMiniSet(),
// loadCachedMiraclSubset()) — never fetches or rebuilds a dataset; missing
// or invalid caches fail with an actionable error.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

import { bootstrapEnv } from '../../../src/core/env-bootstrap.js';
import { embedOnnxBatch, getOnnxProviderState } from '../../../src/core/onnx-embed.js';

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
  FUSION_MODES, FUSION_MODE_IDS, PRIMARY_CANDIDATE_ID, DIAGNOSTIC_CANDIDATE_ID, EQUAL_RRF_CONTROL_IDS,
  SCOPES, COLLECTION_PREFIX, collectionName, BM25_MODEL_ID, BM25_OPTIONS,
  TOP_K, HYBRID_PREFETCH_LIMIT, INDEX_BATCH_SIZE, RSS_TRACK_INTERVAL_MS,
  SMOKE_QUERY_COUNT, SMOKE_CORPUS_SIZE, BENCHMARK_CHECKPOINT_VERSION,
  parseScopesFlag,
} from './weighted-rrf-live-config.mjs';
// verifyStrictCudaConfigured/verifyCudaProvenance are the shared, pure
// CUDA-verification helpers also consumed by run-slavic-weighted-rrf.mjs —
// re-exported here unchanged so this module's existing public API (and its
// test suite's imports) are unaffected by the extraction.
import { verifyStrictCudaConfigured, verifyCudaProvenance } from './weighted-rrf-cuda.mjs';

export { verifyStrictCudaConfigured, verifyCudaProvenance };

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
// Smoke writes TREC runs to a dedicated subdirectory so it can never
// overwrite the real benchmark's TREC files — both modes use the same
// `${scopeId}-${modeId}.trec` naming, and scope ids are shared between
// smoke and real runs, so the directory itself must differ.
const RUNS_DIR = resolve(__dirname, '.runs-weighted-rrf-live');
const SMOKE_RUNS_DIR = resolve(__dirname, '.runs-weighted-rrf-live/smoke');
const RESULTS_DIR = resolve(__dirname, '../results');

const SMOKE = process.argv.includes('--smoke');
const RESUME_CHECK = process.argv.includes('--resume-check');
const RESUME = process.argv.includes('--resume') || RESUME_CHECK;
const RESTART = process.argv.includes('--restart');
const SCOPES_FLAG = process.argv.find((a) => a.startsWith('--scopes='));

const REPORT_JSON_PATH = resolve(RESULTS_DIR, SMOKE ? '.weighted-rrf-live-smoke-report.json' : '2026-07-24-weighted-rrf-live.json');
const REPORT_MD_PATH = resolve(RESULTS_DIR, '2026-07-24-weighted-rrf-live.md');

function makeRedactor(secret) {
  return makeRedactorCore(secret, REPO_ROOT);
}

/** Writes JSON atomically: write to a sibling temp file, then rename over
 * the real path. A hard kill can only ever leave the temp file corrupted
 * (harmless, never read) or leave the real file exactly as it was before
 * this call — never a half-written checkpoint. */
function writeJsonAtomic(path, value) {
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, path);
}

/** A 404 from deleteCollection means the collection is already gone — a
 * genuinely successful cleanup outcome, not a failure. */
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

/** Per-scope provenance. For local scopes, records BOTH the requested and
 * the EFFECTIVE ONNX execution provider (via getOnnxProviderState(), read
 * AFTER at least one local embedding call has happened) plus whether strict
 * mode was configured — never just the requested value, which is exactly
 * the gap that let a silent CPU fallback go unnoticed in earlier reports.
 * Cloud scopes report onnx: null (not applicable — embedding is server-side). */
export function buildScopeProvenance({ scope, dataset, prepared, onnxProviderState }) {
  const isLocal = scope.provider.kind === 'local';
  return {
    commitHash: currentCommitHash(),
    qdrantSdkVersion: sdkVersion(),
    onnx: isLocal ? {
      requestedProvider: (process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu').trim().toLowerCase() || 'cpu',
      strictModeConfigured: process.env.ONNX_CUDA_STRICT === '1',
      effectiveProvider: onnxProviderState?.effective ?? null,
      fellBackToCpu: onnxProviderState?.fellBackToCpu ?? null,
      modelId: scope.provider.denseModelId,
      denseSize: scope.provider.denseSize,
    } : null,
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

/** A scope is "complete" for --resume purposes only if it recorded every
 * expected mode's metrics for every expected query, indexing had zero
 * errors, cleanup confirmed deletion, and (for local scopes) CUDA
 * provenance verification passed. */
export function isCompletedScopeCheckpoint(scopeReport, { queryCount }) {
  if (!scopeReport) return false;
  if (scopeReport.indexing?.documentsIndexed == null || scopeReport.indexing?.errors !== 0) return false;
  if (scopeReport.queryStats?.total !== queryCount || scopeReport.queryStats?.ran !== queryCount || scopeReport.queryStats?.errors !== 0) return false;
  if ((scopeReport.errors?.length ?? 0) !== 0 || scopeReport.cleanup?.deleted !== true) return false;
  if (scopeReport.cudaVerification && scopeReport.cudaVerification.ok !== true) return false;
  return FUSION_MODE_IDS.every((mode) => {
    const m = scopeReport.metrics?.[mode];
    return m?.queryCount === queryCount && typeof m.ndcgAt10 === 'number' && Number.isFinite(m.ndcgAt10);
  });
}

/** Loads the fixed 100-query/1000-doc dataset for one scope, strictly
 * offline — reuses the exact same cached subsets as the completed CUDA
 * k-sweep; never fetches or rebuilds a dataset. */
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
 * queries' qrels. Still runs all six fusion modes — smoke validates
 * plumbing, not benchmark results. */
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
 * prepareInputs()/formatForLanes() expect. */
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
    fusionModeIds: FUSION_MODE_IDS,
    topK: TOP_K,
    hybridPrefetchLimit: HYBRID_PREFETCH_LIMIT,
    bm25Options: BM25_OPTIONS,
    corpusSizePerScope: corpusSize,
    queryCountPerScope: queryCount,
  };
}

/** Recomputes cleanupSummary/errors from CURRENT report.scopes, never by
 * accumulating across a --resume — see run-rrf-sweep.mjs's identical
 * function for the full rationale (a retried scope's earlier failed
 * attempt must never permanently block an ACCEPT verdict for a run that
 * actually completed cleanly on retry). */
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
    throw new Error('Resume checkpoint contract does not match the current scope/fusion-mode configuration.');
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
  const effectiveRunsDirLabel = SMOKE ? '.runs-weighted-rrf-live/smoke' : '.runs-weighted-rrf-live';

  const peakRss = { bytes: process.memoryUsage().rss };
  const trackRss = () => { const cur = process.memoryUsage().rss; if (cur > peakRss.bytes) peakRss.bytes = cur; };
  const rssTimer = setInterval(trackRss, RSS_TRACK_INTERVAL_MS);
  rssTimer.unref();

  const client = buildClient();
  const effectiveScopes = SMOKE ? scopesToRun.slice(0, 1) : scopesToRun;
  console.log(`[weighted-rrf-live] scopes: ${effectiveScopes.map((s) => s.id).join(', ')}${SMOKE ? ' (SMOKE MODE)' : ''}`);
  console.log(`[weighted-rrf-live] fusion modes: ${FUSION_MODE_IDS.join(', ')}`);

  // Pre-flight gate: the full benchmark must never index a local scope
  // without strict CUDA actually configured — checked BEFORE any
  // collection/indexing work, not merely verified after the fact. Smoke is
  // plumbing-only (never claims real CUDA numbers) and --resume-check is
  // read-only (no indexing happens), so both are exempt.
  if (!SMOKE && !RESUME_CHECK) {
    const cudaGate = verifyStrictCudaConfigured(effectiveScopes, process.env);
    if (!cudaGate.ok) {
      clearInterval(rssTimer);
      throw new Error(`[weighted-rrf-live] refusing to start: ${cudaGate.reason}`);
    }
  }

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
    console.log(`[weighted-rrf-live] resume checkpoint valid: ${completed.length}/${effectiveScopes.length} scopes complete`);
    console.log(`[weighted-rrf-live] completed: ${completed.join(', ') || '(none)'}`);
    console.log(`[weighted-rrf-live] pending: ${pending.join(', ') || '(none)'}`);
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
    console.log(`[weighted-rrf-live] checkpoint loaded: ${Object.keys(report.scopes ?? {}).length} scopes recorded`);
  } else {
    if (RESTART && existsSync(REPORT_JSON_PATH)) {
      let discarded;
      try { discarded = JSON.parse(readFileSync(REPORT_JSON_PATH, 'utf-8')); } catch { discarded = null; }
      if (discarded?.scopes) {
        for (const scopeId of Object.keys(discarded.scopes)) {
          const result = await cleanupOrphanedCollection({ client, redact, report: discarded, scope: { id: scopeId } });
          if (!result.ok) {
            clearInterval(rssTimer);
            throw new Error(`[weighted-rrf-live] refusing to --restart: failed to clean up an orphaned collection from the checkpoint being discarded, scope "${scopeId}" (${result.collection}). Fix the Qdrant connectivity/permissions issue and retry --restart — the old checkpoint has not been touched. Underlying error: ${result.error}`);
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
      errors: [],
      cleanupSummary: { attempted: 0, deleted: 0, failed: [] },
      verdict: null,
    };
  }
  writeJsonAtomic(REPORT_JSON_PATH, report);

  // Strictly sequential — one scope at a time, never Promise.all().
  for (const scope of effectiveScopes) {
    if (RESUME && isCompletedScopeCheckpoint(report.scopes?.[scope.id], { queryCount: contract.queryCountPerScope })) {
      console.log(`[weighted-rrf-live] --- scope: ${scope.id} (checkpoint complete, skipping) ---`);
      continue;
    }
    const orphanCleanup = await cleanupOrphanedCollection({ client, redact, report, scope });
    if (!orphanCleanup.ok) {
      clearInterval(rssTimer);
      throw new Error(`[weighted-rrf-live] refusing to continue: failed to clean up an orphaned collection from a previous interrupted run for scope "${scope.id}" (${orphanCleanup.collection}). Fix the Qdrant connectivity/permissions issue and retry --resume or --restart — nothing in this run has been overwritten. Underlying error: ${orphanCleanup.error}`);
    }

    console.log(`\n[weighted-rrf-live] === scope: ${scope.id} ===`);
    let dataset = loadScopeDataset(scope);
    if (SMOKE) dataset = shrinkForSmoke(dataset);
    console.log(`[weighted-rrf-live] [${scope.id}] dataset ready: ${dataset.corpus.size} docs, ${dataset.queries.size} queries`);

    const docEntries = normalizeDocEntries(dataset.corpus, scope.dataset);
    const prepared = await prepareInputs({
      corpus: docEntries, queries: dataset.queries, datasetMd5: dataset.datasetMd5,
      log: (m) => console.log(m), trackRss, progressEvery: 200,
    });

    const scopePeakRss = { bytes: process.memoryUsage().rss };
    const trackScopeRss = () => {
      const cur = process.memoryUsage().rss;
      if (cur > scopePeakRss.bytes) scopePeakRss.bytes = cur;
      trackRss();
    };

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
    const onnxProviderState = scope.provider.kind === 'local' ? getOnnxProviderState() : null;
    scopeReport.provenance = {
      ...buildScopeProvenance({ scope, dataset, prepared, onnxProviderState }),
      peakRssBytes: scopePeakRss.bytes,
    };
    scopeReport.cudaVerification = verifyCudaProvenance(scope, scopeReport.provenance.onnx);
    if (!scopeReport.cudaVerification.ok) {
      scopeReport.errors.push({ step: 'cuda_verification', error: scopeReport.cudaVerification.reason });
    }
    report.scopes[scope.id] = scopeReport;
    rebuildReportAggregates(report);

    writeJsonAtomic(REPORT_JSON_PATH, report);
  }

  clearInterval(rssTimer);
  trackRss();
  report.environment.peakRssBytes = Math.max(peakRss.bytes, report.environment.priorPeakRssBytes ?? 0);
  report.finishedAt = new Date().toISOString();
  // Harness-integrity verdict MUST be computed first — computeCandidateVerdict()
  // reads report.verdict to decide whether live results can even be trusted
  // to judge the candidate; computing it first (while report.verdict is
  // still null) would make every real run's candidateVerdict a spurious
  // REJECT with "harness verdict was null" regardless of actual evidence.
  report.verdict = computeVerdict(report, effectiveScopes, contract);
  report.candidateVerdict = computeCandidateVerdict(report, effectiveScopes, contract);
  writeJsonAtomic(REPORT_JSON_PATH, report);
  if (!SMOKE) writeFileSync(REPORT_MD_PATH, renderMarkdownReport(report), 'utf-8');

  console.log('\n[weighted-rrf-live] === SUMMARY ===');
  for (const [scopeId, r] of Object.entries(report.scopes)) {
    const row = FUSION_MODE_IDS.map((m) => `${m}=${r.metrics?.[m]?.ndcgAt10?.toFixed(4) ?? 'n/a'}`).join(' ');
    console.log(`${scopeId}: ${row} | cuda=${r.cudaVerification?.ok === false ? 'FAILED' : 'ok'} | cleanup=${r.cleanup?.deleted ? 'ok' : 'FAILED'}`);
  }
  console.log('peak RSS:', (peakRss.bytes / 1e6).toFixed(0), 'MB');
  console.log('harness verdict:', report.verdict);
  console.log('candidate verdict:', report.candidateVerdict?.verdict);
  console.log('report json:', REPORT_JSON_PATH.replace(REPO_ROOT, '.'));

  if (report.cleanupSummary.failed.length > 0) {
    console.error('\n!! CLEANUP FAILURES:');
    for (const f of report.cleanupSummary.failed) console.error(`!!   ${f.scopeId}: ${f.collection}`);
    process.exitCode = 1;
  }
}

/** If a previous interrupted run left this scope's owned collection behind,
 * delete ONLY that exact collection name — verified to start with
 * COLLECTION_PREFIX — before re-running the scope from scratch. */
/**
 * @returns {{ ok: true, collection: null } | { ok: true, collection: string } | { ok: false, collection: string, error: string }}
 */
export async function cleanupOrphanedCollection({ client, redact, report, scope }) {
  const prior = report.scopes?.[scope.id];
  if (!prior || prior.cleanup?.deleted) return { ok: true, collection: null };
  const orphan = prior.cleanup?.collection ?? prior.collection;
  if (!orphan || !orphan.startsWith(COLLECTION_PREFIX)) return { ok: true, collection: null };
  console.log(`[weighted-rrf-live] [${scope.id}] found an orphaned collection from an interrupted run: ${orphan} — deleting before re-running`);
  const delRes = await withBoundedRetry(() => client.deleteCollection(orphan));
  if (!isDeleteResultSuccessful(delRes)) {
    const errorMessage = redact(delRes.err);
    console.error(`[weighted-rrf-live] [${scope.id}] failed to delete orphaned collection ${orphan}: ${errorMessage}`);
    return { ok: false, collection: orphan, error: errorMessage };
  }
  return { ok: true, collection: orphan };
}

/** Runs ONE scope end to end: create collection -> index corpus ONCE
 * (batched) -> for every query, compute dense+sparse query vectors ONCE,
 * then evaluate all six fusion modes from those vectors -> compute metrics
 * (aggregate + per-query for bootstrap) -> write TREC runs -> cleanup.
 * Cleanup always runs in `finally`, guarded to the exact collection prefix. */
export async function executeScope({
  client, redact, scope, dataset, prepared, trackRss = () => {},
  embedBatch = embedOnnxBatch,
  writeTrecRun = (path, content) => writeFileSync(path, content, 'utf-8'),
  runsDir = RUNS_DIR,
  runsDirLabel = '.runs-weighted-rrf-live',
  collection = collectionName(scope.id, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`),
}) {
  const { corpus, queries, qrels } = dataset;
  const { provider } = scope;

  const scopeReport = {
    scopeId: scope.id, dataset: scope.dataset, providerId: scope.providerId, collection,
    indexing: { wallMs: null, documentsIndexed: 0, batches: 0, errors: 0, retries: 0 },
    queryStats: {
      total: queries.size, ran: 0, errors: 0, retries: 0,
      latencyMs: Object.fromEntries(FUSION_MODE_IDS.map((m) => [m, []])),
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
        console.log(`[weighted-rrf-live] [${scope.id}] indexed ${scopeReport.indexing.documentsIndexed}/${docIds.length}`);
        trackRss();
      }
    }
    scopeReport.indexing.wallMs = Number((process.hrtime.bigint() - indexStart) / 1000000n);
    console.log(`[weighted-rrf-live] [${scope.id}] indexing complete: ${scopeReport.indexing.documentsIndexed} docs in ${scopeReport.indexing.wallMs}ms`);

    // ── sequential queries: dense+sparse vectors computed once, then all
    // six fusion modes evaluated from those same vectors ────────────────
    const emptyRun = () => new Map([...queries.keys()].map((qid) => [qid, []]));
    const runsByMode = new Map(FUSION_MODE_IDS.map((id) => [id, emptyRun()]));

    let qi = 0;
    for (const queryId of queries.keys()) {
      qi += 1;
      const queryBody = prepared.queries.get(queryId)?.commonBody;
      if (typeof queryBody !== 'string') {
        scopeReport.queryStats.errors += 1;
        scopeReport.errors.push({ step: `prepare_query_${queryId}`, error: 'Prepared query body is missing' });
        continue;
      }

      // Dense + sparse query vectors computed exactly once, reused for
      // dense-only, sparse-only, and all four hybrid fusion modes' prefetch.
      const queryVectors = await buildQueryVector({ provider, body: queryBody, redact, scopeReport, embedBatch });
      if (queryVectors === null) { scopeReport.queryStats.errors += 1; continue; }

      const modeResults = [];
      for (const mode of FUSION_MODES) {
        let res;
        if (mode.kind === 'single') {
          res = await withBoundedRetry(
            () => client.query(collection, { query: queryVectors[mode.using], using: mode.using, limit: TOP_K, with_payload: false }),
            { onRetry: () => { scopeReport.queryStats.retries += 1; } },
          );
        } else {
          // Real Qdrant weighted-RRF contract: weights live in
          // query.rrf.weights, never on prefetch entries.
          res = await withBoundedRetry(
            () => client.query(collection, {
              prefetch: [
                { query: queryVectors.dense, using: 'dense', limit: HYBRID_PREFETCH_LIMIT },
                { query: queryVectors.sparse, using: 'sparse', limit: HYBRID_PREFETCH_LIMIT },
              ],
              query: { rrf: { k: mode.k, weights: mode.weights } },
              limit: TOP_K, with_payload: false,
            }),
            { onRetry: () => { scopeReport.queryStats.retries += 1; } },
          );
        }
        modeResults.push([mode.id, res, runsByMode.get(mode.id)]);
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
      if (qi % 25 === 0) { console.log(`[weighted-rrf-live] [${scope.id}] queries ${qi}/${queries.size}`); trackRss(); }
    }

    // ── metrics + TREC run persistence ───────────────────────────────────
    const toRankedMap = (scoredMap) => {
      const m = new Map();
      for (const [qid, docs] of scoredMap.entries()) m.set(qid, docs.map((d) => d.docId));
      return m;
    };
    const rankedByMode = Object.fromEntries(FUSION_MODE_IDS.map((id) => [id, toRankedMap(runsByMode.get(id))]));
    for (const [label, ranked] of Object.entries(rankedByMode)) {
      scopeReport.metrics[label] = computeMetrics(qrels, ranked);
      scopeReport.perQueryMetrics[label] = [...perQueryMetrics(qrels, ranked).entries()];
    }

    for (const [label, scoredMap] of runsByMode.entries()) {
      const trecPath = join(runsDir, `${scope.id}-${label}.trec`);
      writeTrecRun(trecPath, toTrecRunFormat(scoredMap, `weighted-rrf-live-${scope.id}-${label}`));
      scopeReport.trecRunPaths[label] = trecPath.replace(runsDir, runsDirLabel);
    }

    for (const label of Object.keys(rankedByMode)) {
      const arr = [...scopeReport.queryStats.latencyMs[label]].sort((a, b) => a - b);
      scopeReport.queryStats.latencyMs[label] = {
        p50: percentile(arr, 0.5), p95: percentile(arr, 0.95), max: arr.length ? arr[arr.length - 1] : null, count: arr.length,
      };
    }

    // ── comparisons: every mode vs dense, plus the required candidate/
    // diagnostic/control comparisons ─────────────────────────────────────
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
        payload: { doc_id: docId, benchmark: 'weighted-rrf-live', scope: scopeReport.scopeId },
        vector: { dense, sparse: { indices: sparse.indices, values: sparse.values } },
      };
    });
  }
  return batchIds.map((docId, i) => {
    const { denseText, sparseText } = formatForLanes({ body: bodies[i], profileKind: provider.kind, role: 'document' });
    return {
      id: idMap.toPoint.get(docId),
      payload: { doc_id: docId, benchmark: 'weighted-rrf-live', scope: scopeReport.scopeId },
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

/** Required paired-bootstrap comparisons within one scope, each built as
 * pairedBootstrapByQuery(<baseline>, <comparison>) so meanDelta always
 * reads as "<comparison> minus <baseline>":
 *   - k2_rho0.10 (primary) vs dense
 *   - k2_rho0.10 (primary) vs equal RRF k=2
 *   - k2_rho0.10 (primary) vs equal RRF k=60
 *   - k2_rho0.25 (diagnostic) vs dense
 *   - equal RRF k=2 vs dense
 *   - equal RRF k=60 vs dense
 * Plus sparse vs dense (context for "does sparse help at all here"). */
export function computeScopeComparisons(perQueryMetricsRaw) {
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

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function metricsAreFullyValid(m, expectedQueryCount) {
  if (!m || m.queryCount !== expectedQueryCount) return false;
  const fields = ['ndcgAt10', 'mapAt100', 'recallAt10', 'recallAt100', 'precisionAt10', 'mrrAt10'];
  return fields.every((f) => typeof m[f] === 'number' && Number.isFinite(m[f]));
}

/** Harness-integrity verdict: did every planned scope run to completion
 * with valid metrics, clean cleanup, and (for local scopes) verified CUDA
 * provenance — separate from computeCandidateVerdict()'s scientific
 * question of whether the weighted-RRF candidate itself should be
 * accepted. A harness that fails technically can never produce a
 * meaningful candidate verdict, so main() always computes this first. */
export function computeVerdict(report, scopesRun, contract) {
  const expectedScopeIds = new Set(scopesRun.map((s) => s.id));
  const completedScopeIds = new Set(Object.keys(report.scopes));
  const allPresent = expectedScopeIds.size === completedScopeIds.size && [...expectedScopeIds].every((id) => completedScopeIds.has(id));
  if (!allPresent) return SMOKE ? 'WEIGHTED_RRF_LIVE_SMOKE_BLOCKED' : 'WEIGHTED_RRF_LIVE_HARNESS_BLOCKED';

  const cleanupOk = report.cleanupSummary.failed.length === 0;
  let anyMetricsValid = false;
  let allMetricsValid = true;
  let anyRequestErrors = false;
  let anyCudaFailure = false;
  for (const scopeReport of Object.values(report.scopes)) {
    const metricsOk = FUSION_MODE_IDS.every((mode) => metricsAreFullyValid(scopeReport.metrics?.[mode], contract.queryCountPerScope));
    if (metricsOk) anyMetricsValid = true; else allMetricsValid = false;
    if ((scopeReport.errors?.length ?? 0) > 0 || scopeReport.queryStats.errors > 0 || scopeReport.indexing.errors > 0) anyRequestErrors = true;
    if (scopeReport.cudaVerification && scopeReport.cudaVerification.ok !== true) anyCudaFailure = true;
  }

  const prefix = SMOKE ? 'WEIGHTED_RRF_LIVE_SMOKE' : 'WEIGHTED_RRF_LIVE_HARNESS';
  if (anyCudaFailure) return `${prefix}_REJECT`;
  if (allMetricsValid && cleanupOk && !anyRequestErrors) return `${prefix}_ACCEPT`;
  if (anyMetricsValid) return `${prefix}_PARTIAL`;
  return `${prefix}_REJECT`;
}

/** Scientific decision-rule verdict for the primary weighted-RRF candidate
 * (k2_rho0.10), applied ONLY once the harness itself is technically sound
 * (report.verdict does not start with _ACCEPT is treated as "cannot judge
 * the candidate" — a harness-level failure/partial run must never be
 * silently read as scientific evidence either way).
 *
 * WEIGHTED_RRF_ACCEPT requires ALL of:
 *   - no statistically significant nDCG@10 regression vs dense on EITHER
 *     MIRACL scope (miracl-local, miracl-cloud)
 *   - material reduction of the equal-RRF MIRACL regression (the
 *     candidate's meanDelta-vs-dense on MIRACL must be closer to zero, or
 *     positive, than BOTH equal_k2_vs_dense and equal_k60_vs_dense's
 *     meanDelta on that same scope — "materially" defined as at least
 *     MATERIAL_REDUCTION_MARGIN nDCG@10 improvement over the BETTER
 *     (less-regressed) of the two equal-RRF controls, so the candidate
 *     must genuinely beat both k=2 and k=60, not merely beat whichever one
 *     happened to regress worse)
 *   - no statistically significant regression vs dense on SciFact (either
 *     scope)
 *   - all technical integrity/cleanup checks pass (report.verdict is an
 *     _ACCEPT)
 *
 * WEIGHTED_RRF_MIXED when the harness passed but the candidate's own
 * evidence is inconclusive: any CI crosses zero where a firm claim would be
 * needed, OR local/cloud results diverge in direction on the same dataset,
 * OR the candidate helps one dataset while significantly harming the other.
 *
 * WEIGHTED_RRF_REJECT when the candidate remains significantly worse than
 * dense on MIRACL, or produces a significant SciFact regression, or the
 * harness itself failed/was blocked/partial (live results cannot validate
 * the offline candidate if the harness didn't actually complete). */
const MATERIAL_REDUCTION_MARGIN = 0.02;

export function computeCandidateVerdict(report, scopesRun, contract) {
  const scopeIds = scopesRun.map((s) => s.id);
  const miraclScopeIds = scopeIds.filter((id) => id.startsWith('miracl-'));
  const scifactScopeIds = scopeIds.filter((id) => id.startsWith('scifact-'));
  const primaryVsDenseKey = `${PRIMARY_CANDIDATE_ID}_vs_dense`;

  const base = {
    verdict: 'WEIGHTED_RRF_MIXED',
    primaryCandidateId: PRIMARY_CANDIDATE_ID,
    diagnosticCandidateId: DIAGNOSTIC_CANDIDATE_ID,
    equalRrfControlIds: [...EQUAL_RRF_CONTROL_IDS],
    reasons: [],
    perScope: {},
  };

  if (SMOKE) {
    return { ...base, verdict: 'WEIGHTED_RRF_MIXED', reasons: ['Smoke mode never produces a scientific candidate verdict — plumbing check only.'] };
  }

  const harnessOk = typeof report.verdict === 'string' && report.verdict.endsWith('_ACCEPT');
  if (!harnessOk) {
    return {
      ...base,
      verdict: 'WEIGHTED_RRF_REJECT',
      reasons: [`Harness-level verdict was "${report.verdict}", not an ACCEPT — live results cannot validate the offline candidate when the harness itself did not complete cleanly.`],
    };
  }
  if (miraclScopeIds.length === 0 || scifactScopeIds.length === 0) {
    return {
      ...base,
      verdict: 'WEIGHTED_RRF_MIXED',
      reasons: ['Both a MIRACL scope and a SciFact scope are required to judge the primary candidate; this run scoped out one or the other.'],
    };
  }

  const reasons = [];
  let anyMiraclSignificantRegression = false;
  let anyScifactSignificantRegression = false;
  let materiallyReducesMiraclRegression = true; // AND over both MIRACL scopes
  let anyDirectionDivergence = false;

  for (const scopeId of miraclScopeIds) {
    const r = report.scopes[scopeId];
    const primaryCmp = r?.comparisons?.[primaryVsDenseKey];
    const k2Cmp = r?.comparisons?.equal_k2_vs_dense;
    const k60Cmp = r?.comparisons?.equal_k60_vs_dense;
    const rowOk = primaryCmp && k2Cmp && k60Cmp
      && typeof primaryCmp.meanDelta === 'number' && typeof k2Cmp.meanDelta === 'number' && typeof k60Cmp.meanDelta === 'number';
    if (!rowOk) {
      materiallyReducesMiraclRegression = false;
      reasons.push(`${scopeId}: missing primary/equal-RRF comparisons — cannot judge MIRACL regression reduction.`);
      base.perScope[scopeId] = { ok: false };
      continue;
    }
    const primarySignificantRegression = primaryCmp.verdict === 'A_BETTER'; // A=dense(baseline) better -> candidate is worse
    if (primarySignificantRegression) {
      anyMiraclSignificantRegression = true;
      reasons.push(`${scopeId}: primary candidate is statistically significantly WORSE than dense (meanΔ=${primaryCmp.meanDelta.toFixed(4)}).`);
    }
    // Must materially improve on the BETTER (less-regressed, i.e. larger/
    // less-negative meanDelta) of the two equal-RRF controls — comparing
    // against only the worse control would let a candidate that is still
    // clearly worse than the better control (e.g. worse than k2 but better
    // than a badly-regressed k60) pass as "materially reducing" the
    // regression, which is not the claim "improvement against both
    // controls" requires.
    const bestEqualRrfDelta = Math.max(k2Cmp.meanDelta, k60Cmp.meanDelta);
    const reduction = primaryCmp.meanDelta - bestEqualRrfDelta; // candidate delta minus best (least-regressed) equal-RRF delta
    const reducesEnough = reduction >= MATERIAL_REDUCTION_MARGIN;
    if (!reducesEnough) materiallyReducesMiraclRegression = false;
    base.perScope[scopeId] = {
      ok: true,
      primaryMeanDelta: primaryCmp.meanDelta,
      equalK2MeanDelta: k2Cmp.meanDelta,
      equalK60MeanDelta: k60Cmp.meanDelta,
      bestEqualRrfDelta,
      reductionVsBestEqualRrf: reduction,
      materiallyReduced: reducesEnough,
      primarySignificantRegression,
    };
    if (!reducesEnough) {
      reasons.push(`${scopeId}: primary candidate does not materially reduce the equal-RRF MIRACL regression relative to the BETTER equal-RRF control (reduction=${reduction.toFixed(4)} < margin=${MATERIAL_REDUCTION_MARGIN}).`);
    }
  }

  for (const scopeId of scifactScopeIds) {
    const r = report.scopes[scopeId];
    const primaryCmp = r?.comparisons?.[primaryVsDenseKey];
    if (!primaryCmp || typeof primaryCmp.meanDelta !== 'number') {
      reasons.push(`${scopeId}: missing primary-vs-dense comparison — cannot judge SciFact regression.`);
      base.perScope[scopeId] = { ok: false };
      continue;
    }
    const significantRegression = primaryCmp.verdict === 'A_BETTER';
    if (significantRegression) {
      anyScifactSignificantRegression = true;
      reasons.push(`${scopeId}: primary candidate is statistically significantly WORSE than dense on SciFact (meanΔ=${primaryCmp.meanDelta.toFixed(4)}).`);
    }
    base.perScope[scopeId] = { ok: true, primaryMeanDelta: primaryCmp.meanDelta, primarySignificantRegression: significantRegression };
  }

  // local/cloud direction divergence on the SAME dataset (MIRACL local vs
  // MIRACL cloud, SciFact local vs SciFact cloud) — a real MIXED signal,
  // not by itself a rejection.
  for (const pair of [['miracl-local', 'miracl-cloud'], ['scifact-local', 'scifact-cloud']]) {
    const [localId, cloudId] = pair;
    if (!scopeIds.includes(localId) || !scopeIds.includes(cloudId)) continue;
    const localCmp = report.scopes[localId]?.comparisons?.[primaryVsDenseKey];
    const cloudCmp = report.scopes[cloudId]?.comparisons?.[primaryVsDenseKey];
    if (!localCmp || !cloudCmp || typeof localCmp.meanDelta !== 'number' || typeof cloudCmp.meanDelta !== 'number') continue;
    const localSign = Math.sign(localCmp.meanDelta);
    const cloudSign = Math.sign(cloudCmp.meanDelta);
    if (localSign !== 0 && cloudSign !== 0 && localSign !== cloudSign) {
      anyDirectionDivergence = true;
      reasons.push(`${localId} vs ${cloudId}: primary candidate's direction vs dense diverges between local (meanΔ=${localCmp.meanDelta.toFixed(4)}) and cloud (meanΔ=${cloudCmp.meanDelta.toFixed(4)}).`);
    }
  }

  let verdict;
  if (anyMiraclSignificantRegression || anyScifactSignificantRegression) {
    verdict = 'WEIGHTED_RRF_REJECT';
  } else if (materiallyReducesMiraclRegression && !anyDirectionDivergence) {
    verdict = 'WEIGHTED_RRF_ACCEPT';
  } else {
    verdict = 'WEIGHTED_RRF_MIXED';
  }

  if (reasons.length === 0) reasons.push('Primary candidate shows no statistically significant regression on MIRACL or SciFact, and materially reduces the equal-RRF MIRACL regression on every MIRACL scope.');

  return { ...base, verdict, reasons };
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
  lines.push('# Live Qdrant weighted-RRF validation — SciFact and MIRACL Russian');
  lines.push('');
  lines.push(`Harness verdict: **${report.verdict}**`);
  lines.push(`Candidate verdict: **${report.candidateVerdict?.verdict ?? 'n/a'}**`);
  lines.push('');
  lines.push('This offline analysis narrows candidates only. Final acceptance requires');
  lines.push('real Qdrant 1.17+ weighted-RRF queries using `query.rrf.weights` — which is');
  lines.push('exactly what this report is. Every hybrid row below was produced by a live');
  lines.push('`query: { rrf: { k, weights: [dense, sparse] } }` request with');
  lines.push(`prefetch=${report.benchmarkContract.hybridPrefetchLimit}/lane, never \`prefetch.weight\`, never a local RRF`);
  lines.push('reconstruction. SciFact and MIRACL scopes are kept strictly separate.');
  lines.push('');
  lines.push('MIRACL has already influenced the offline candidate selection this run');
  lines.push('validates — this is validation/diagnostic evidence, not a blind');
  lines.push('confirmatory holdout, and the primary candidate is never called globally');
  lines.push('optimal on the strength of this report alone.');
  lines.push('');
  lines.push(`Fusion modes: ${report.benchmarkContract.fusionModeIds.join(', ')}`);
  lines.push('');

  lines.push('## Candidate verdict reasons');
  lines.push('');
  for (const reason of report.candidateVerdict?.reasons ?? []) lines.push(`- ${reason}`);
  lines.push('');

  lines.push('## Retrieval quality');
  lines.push('');
  lines.push('| Scope | Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 |');
  lines.push('|---|---|---:|---:|---:|---:|---:|');
  for (const [scopeId, r] of Object.entries(report.scopes)) {
    for (const [mode, m] of Object.entries(r.metrics ?? {})) {
      lines.push(`| ${scopeId} | ${mode} | ${metricCell(m.ndcgAt10)} | ${metricCell(m.mapAt100)} | ${metricCell(m.recallAt10)} | ${metricCell(m.recallAt100)} | ${metricCell(m.mrrAt10)} |`);
    }
  }
  lines.push('');

  lines.push('## Paired bootstrap comparisons (sign = comparison − baseline)');
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

  lines.push('## MIRACL regression reduction (primary candidate vs the BETTER equal-RRF control)');
  lines.push('');
  lines.push('The candidate must materially improve on whichever equal-RRF control');
  lines.push('regressed LESS — beating only the worse control is not sufficient.');
  lines.push('');
  lines.push('| Scope | Primary meanΔ | Equal k=2 meanΔ | Equal k=60 meanΔ | Reduction vs better control | Materially reduced |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const [scopeId, row] of Object.entries(report.candidateVerdict?.perScope ?? {})) {
    if (!scopeId.startsWith('miracl-') || !row.ok) continue;
    lines.push(`| ${scopeId} | ${metricCell(row.primaryMeanDelta)} | ${metricCell(row.equalK2MeanDelta)} | ${metricCell(row.equalK60MeanDelta)} | ${metricCell(row.reductionVsBestEqualRrf)} | ${row.materiallyReduced ? 'yes' : 'no'} |`);
  }
  lines.push('');

  lines.push('## CUDA provenance (local scopes)');
  lines.push('');
  lines.push('| Scope | Requested | Effective | Strict configured | Fell back to CPU | Verified |');
  lines.push('|---|---|---|---|---|---|');
  for (const [scopeId, r] of Object.entries(report.scopes)) {
    const onnx = r.provenance?.onnx;
    if (!onnx) { lines.push(`| ${scopeId} | n/a (cloud) | n/a | n/a | n/a | n/a |`); continue; }
    lines.push(`| ${scopeId} | ${onnx.requestedProvider} | ${onnx.effectiveProvider ?? 'n/a'} | ${onnx.strictModeConfigured} | ${onnx.fellBackToCpu} | ${r.cudaVerification?.ok ? 'yes' : 'NO — ' + (r.cudaVerification?.reason ?? '')} |`);
  }
  lines.push('');

  lines.push('## Operations');
  lines.push('');
  lines.push('| Scope | Indexed | Index wall ms | Query errors | Retries | Cleanup | Scope peak RSS |');
  lines.push('|---|---:|---:|---:|---:|---|---:|');
  for (const [scopeId, r] of Object.entries(report.scopes)) {
    lines.push(`| ${scopeId} | ${r.indexing.documentsIndexed} | ${r.indexing.wallMs ?? 'n/a'} | ${r.queryStats.errors} | ${r.indexing.retries + r.queryStats.retries} | ${r.cleanup?.deleted ? 'deleted' : 'FAILED'} | ${r.provenance?.peakRssBytes ?? 'n/a'} |`);
  }
  lines.push(`\nPeak process RSS (whole run): ${report.environment.peakRssBytes ?? 'n/a'} bytes`);
  lines.push('');

  lines.push('## Interpretation limits');
  lines.push('');
  lines.push('- FACT: every hybrid row was produced by a real Qdrant `query.rrf.weights`');
  lines.push('  request, prefetch=200/lane, final limit 100 — never a local RRF');
  lines.push('  reconstruction, never `prefetch.weight`.');
  lines.push('- FACT: SciFact and MIRACL qrels/metrics are never merged.');
  lines.push('- FACT: k2_rho0.25 is diagnostic only — never promoted to primary merely');
  lines.push('  because it wins one scope in this report.');
  lines.push('- FACT: MIRACL already influenced the offline candidate selection this');
  lines.push('  run validates — an ACCEPT verdict here is validation/diagnostic evidence,');
  lines.push('  not a blind confirmatory holdout, and does not by itself justify calling');
  lines.push('  the candidate globally optimal or changing a production default.');
  lines.push('- This report does not implement or recommend adaptive/language-specific');
  lines.push('  fusion.');
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
    console.error('[weighted-rrf-live] unhandled error:', redact(err));
    process.exitCode = 1;
  });
}
