// Shared orchestration for all four production-path suites. adapter/
// runIndexer/queryOne are REQUIRED parameters, never internally
// constructed — this is what makes "offline tests never touch the
// network" a structural property of what's passed in (throw-on-call
// stubs for offline tests), rather than something inferred from source
// text (code review, round 2/3: reject any regex-based "proves this is
// offline" test in favor of this DI discipline).
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { computeMetrics, toTrecRunFormat } from '../../beir/metrics.mjs';
import {
  LOCAL_PROFILE, CLOUD_PROFILE, buildIndexEnv, collectionName, COLLECTION_PREFIX,
  applyDeterministicHarnessEnv, restoreHarnessEnv, DETERMINISTIC_INDEXING_ENV_BASE,
} from './profiles.mjs';
import { materializeDataset } from './materialize.mjs';
import { isolatedConfigPath, telemetryPath, ensureParentDirExists } from './isolated-config.mjs';
import { collapseHitsToDocuments, COLLAPSE_STRATEGY } from './collapse.mjs';
import { checkDepthSufficient, DOCUMENT_METRIC_DEPTH, CHUNK_CANDIDATE_LIMIT } from './query-via-search.mjs';
import { summarizeTelemetry } from './telemetry-reader.mjs';
import { cleanupCollection, cleanupAllOwnedCollections } from './cleanup.mjs';
import {
  checkpointPathFor, buildBenchmarkContract, initialCheckpointState,
  loadCheckpointIfExists, validateResumeCheckpoint, writeCheckpointAtomic,
  isCompletedProfileRun, writeFileAtomic,
} from './checkpoint.mjs';
import { redact } from './redact.mjs';
import { RUNS_DIR_PATH } from './run-paths.mjs';
import { probeOnnxProvider } from '../../../../src/local/core/onnx-provider-probe.js';

function deterministicEnvHash() {
  return JSON.stringify(DETERMINISTIC_INDEXING_ENV_BASE);
}

function serializeError(err) {
  return { message: redact(err?.message ?? String(err)), stack: err?.stack ? redact(err.stack) : undefined };
}

/**
 * Runs ONE suite across BOTH profiles (LOCAL then CLOUD, never
 * interleaved). Every step below is wrapped so cleanup ALWAYS runs
 * (unconditional finally, never gated on a "was it created" flag —
 * Finding 4's fix) and every profile's own checkpoint entry is written
 * atomically after that profile completes.
 *
 * @param {{
 *   suiteId: string,
 *   datasetFingerprint: string,
 *   corpus: Map<string, any>,
 *   queries: Map<string, string>,
 *   qrels: Map<string, Map<string, number>>,
 *   toMarkdown: (doc: any, docId: string) => string,
 *   smoke?: boolean,
 *   resume?: boolean,
 *   restart?: boolean,
 *   cudaRequested?: boolean,
 *   adapter: Object,
 *   runIndexer: Function,
 *   queryOne: Function,
 *   log?: Function,
 * }} params
 * @returns {Promise<Object>} the final checkpoint state
 */
export async function runSuiteAcrossProfiles({
  suiteId, datasetFingerprint, corpus, queries, qrels, toMarkdown,
  smoke = false, resume = false, restart = false, cudaRequested = false,
  adapter, runIndexer, queryOne, log = () => {},
  probeOnnxProviderFn = probeOnnxProvider,
}) {
  if (!adapter || !runIndexer || !queryOne) {
    throw new Error('runSuiteAcrossProfiles: adapter, runIndexer, and queryOne are all required (no internal default construction) — offline callers must pass throw-on-call stubs, real runners must pass the real implementations.');
  }
  if (resume && restart) throw new Error('Use either resume or restart, not both.');

  // Step 0: unconditional orphan sweep — the real safety net for a prior
  // run that was hard-killed (no finally ever ran for it at all). Never
  // skipped, regardless of resume/restart/smoke.
  await cleanupAllOwnedCollections(adapter);

  const checkpointPath = checkpointPathFor(suiteId, { smoke });
  const contract = buildBenchmarkContract({
    suiteId,
    datasetFingerprint,
    qdrantUrl: process.env.QDRANT_URL,
    collectionPrefix: COLLECTION_PREFIX,
    chunkCandidateLimit: CHUNK_CANDIDATE_LIMIT,
    documentMetricDepth: DOCUMENT_METRIC_DEPTH,
    collapseStrategy: COLLAPSE_STRATEGY,
    cudaRequested,
    deterministicEnvHash: deterministicEnvHash(),
  });

  let state;
  const previous = loadCheckpointIfExists(checkpointPath);
  if (resume) {
    if (!previous) throw new Error(`No checkpoint exists at ${checkpointPath}. Start without resume.`);
    validateResumeCheckpoint(previous, contract);
    state = { ...previous, benchmarkContract: contract, resumeEvents: [...(previous.resumeEvents ?? []), { resumedAt: new Date().toISOString() }], verdict: null };
  } else {
    if (previous && !restart) {
      throw new Error(`A checkpoint already exists at ${checkpointPath}. Use resume to continue it or restart to replace it.`);
    }
    state = initialCheckpointState(contract);
  }

  const runSuffixBase = randomBytes(4).toString('hex');
  const rankedRunsByProfile = {}; // profileId -> Map<queryId, string[]> — NOT JSON-serialized into the checkpoint; returned separately for bootstrap CI

  for (const profile of [LOCAL_PROFILE, CLOUD_PROFILE]) {
    if (resume && isCompletedProfileRun(state.profiles[profile.id], { queryCount: queries.size })) {
      log(`[${suiteId}] --- profile: ${profile.id} (checkpoint complete, skipping) ---`);
      continue;
    }
    // An invalid/incomplete profile run is ALWAYS retried as a full rerun
    // (never a partial "retry only the errored query IDs" resume) —
    // cleanup already deleted the collection unconditionally on the prior
    // attempt, so there is no partial indexed state to resume against.
    log(`[${suiteId}] --- profile: ${profile.id} ---`);
    const { profileReport, rankedRun } = await runOneProfile({
      suiteId, profileId: profile.id, profile, runSuffix: `${runSuffixBase}-${profile.id}`,
      corpus, queries, qrels, toMarkdown, cudaRequested,
      adapter, runIndexer, queryOne, log, probeOnnxProviderFn,
    });
    state.profiles[profile.id] = profileReport;
    if (rankedRun) rankedRunsByProfile[profile.id] = rankedRun;
    writeCheckpointAtomic(checkpointPath, state);
  }

  state.finishedAt = new Date().toISOString();
  const allComplete = Object.values(state.profiles).every((p) => isCompletedProfileRun(p, {}));
  state.verdict = allComplete ? 'COMPLETE' : 'INCOMPLETE';
  writeCheckpointAtomic(checkpointPath, state);
  return { state, rankedRunsByProfile };
}

async function runOneProfile({
  suiteId, profileId, profile, runSuffix, corpus, queries, qrels, toMarkdown, cudaRequested,
  adapter, runIndexer, queryOne, log, probeOnnxProviderFn,
}) {
  const collection = collectionName(suiteId, profileId, runSuffix);
  const profileReport = {
    collection,
    profileId,
    errors: [],
    cleanup: { attempted: false, deleted: false },
    unmappedHitCount: 0,
    queryErrorCount: 0,
    indexing: null,
    metrics: null,
  };
  // Kept as a local, NEVER assigned into profileReport (which is
  // JSON.stringify'd into the checkpoint — a Map silently serializes to
  // "{}", which would be a subtle checkpoint-corruption bug). Returned
  // separately below for the suite runner's own pairedBootstrapByQuery
  // use, which needs the real per-query ranked lists, not just the
  // averaged metrics.
  let rankedRun = null;

  // Telemetry env is scoped to THIS profile only — saved and restored
  // afterward so a later profile/suite never inherits a stale path.
  const previousTelemetryEnv = process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
  const previousHarnessEnv = applyDeterministicHarnessEnv();

  try {
    if (cudaRequested && profileId === 'local') {
      const probe = await probeOnnxProviderFn('cuda');
      if (!probe.ok || probe.fellBackToCpu) {
        throw Object.assign(new Error(`CUDA requested but unavailable: ${probe.message ?? 'preflight failed'}`), { code: 'cuda_unavailable' });
      }
    }

    const { dir: materializedDirPath, sourceFileToDocId } = materializeDataset({
      suiteId, profileId, runSuffix, corpus, toMarkdown,
    });

    const configPath = isolatedConfigPath(suiteId, profileId, runSuffix);
    const telemPath = telemetryPath(suiteId, profileId, runSuffix);
    ensureParentDirExists(configPath);
    ensureParentDirExists(telemPath);

    const indexEnv = {
      ...buildIndexEnv(profile, collection, { materializedDir: materializedDirPath }, { cuda: cudaRequested }),
      SEMIDEX_CONFIG_PATH: configPath,
      SEMIDEX_BENCH_TELEMETRY_PATH: telemPath,
    };

    log(`[${suiteId}/${profileId}] indexing ${corpus.size} documents...`);
    const indexResult = await runIndexer(indexEnv, materializedDirPath);
    profileReport.indexing = { ms: indexResult.ms, exitCode: indexResult.exitCode, peakChildRssBytes: indexResult.peakChildRssBytes, documentsIndexed: corpus.size, errors: 0 };

    // Query-phase telemetry lands in the SAME file as indexing-phase
    // telemetry — the indexer subprocess has already exited (indexing
    // fully completes before querying begins), so the two phases' writes
    // are temporally disjoint, never concurrent.
    process.env.SEMIDEX_BENCH_TELEMETRY_PATH = telemPath;

    log(`[${suiteId}/${profileId}] querying ${queries.size} queries...`);
    rankedRun = new Map();
    const latenciesMs = [];
    let unmappedHitCount = 0;
    let queryErrorCount = 0;
    let queriesWithInsufficientDepth = 0;

    for (const [qid, queryText] of queries.entries()) {
      const result = await queryOne({ adapter, collection, query: queryText });
      latenciesMs.push(result.ms);
      if (!result.ok) {
        queryErrorCount += 1;
        profileReport.errors.push({ queryId: qid, ...result.error });
        continue; // an {error} result is NEVER scored as an empty ranking
      }
      const { rankedDocs, unmappedHits } = collapseHitsToDocuments(result.hits, sourceFileToDocId);
      unmappedHitCount += unmappedHits.length;
      if (!checkDepthSufficient(rankedDocs, corpus.size)) queriesWithInsufficientDepth += 1;
      rankedRun.set(qid, rankedDocs.map((d) => d.docId));
    }

    profileReport.unmappedHitCount = unmappedHitCount;
    profileReport.queryErrorCount = queryErrorCount;
    profileReport.queriesWithInsufficientDepth = queriesWithInsufficientDepth;
    profileReport.latency = summarizeLatency(latenciesMs);

    const scoredRun = new Map();
    for (const [qid, ranked] of rankedRun.entries()) {
      scoredRun.set(qid, ranked.map((docId, i) => ({ docId, score: ranked.length - i })));
    }
    const trecPath = resolve(RUNS_DIR_PATH, `${suiteId}-${profileId}.trec`);
    writeFileAtomic(trecPath, toTrecRunFormat(scoredRun, `${suiteId}-${profileId}`));

    profileReport.metrics = { ...computeMetrics(qrels, rankedRun), queryCount: queries.size };

    const telemetrySummary = summarizeTelemetry(telemPath);
    profileReport.telemetry = telemetrySummary;
  } catch (err) {
    profileReport.errors.push(serializeError(err));
  } finally {
    // Unconditional — never gated on a "was the collection created" flag.
    // If the indexer subprocess crashed immediately after createCollection()
    // succeeded server-side but before this process observed that,
    // cleanup still runs and either finds+deletes the collection, or gets
    // a "not found" response — both are a correctly cleaned-up state.
    profileReport.cleanup = await cleanupCollection(adapter, collection);
    if (previousTelemetryEnv === undefined) delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
    else process.env.SEMIDEX_BENCH_TELEMETRY_PATH = previousTelemetryEnv;
    restoreHarnessEnv(previousHarnessEnv);
  }

  return { profileReport, rankedRun };
}

function summarizeLatency(msValues) {
  const sorted = [...msValues].sort((a, b) => a - b);
  const percentile = (p) => {
    if (sorted.length === 0) return null;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
  };
  return { count: sorted.length, p50: percentile(50), p95: percentile(95) };
}
