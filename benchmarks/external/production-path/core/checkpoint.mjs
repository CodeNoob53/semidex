// Resume/checkpoint contract for the production-path benchmark. Mirrors
// benchmarks/external/beir/run-scifact.mjs's own isCompletedRunCheckpoint/
// validateResumeCheckpoint pattern (not imported — too tightly coupled to
// that file's own internals), applied at (suite, profile) granularity
// instead of per-run-config granularity.
import { writeFileSync, renameSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { RUNS_DIR_PATH } from './run-paths.mjs';

export const CHECKPOINT_VERSION = 1;

/**
 * Two DISJOINT paths for smoke vs full runs of the same suite — a smoke
 * run's checkpoint can never be confused with, or overwrite, a full run's
 * checkpoint (code review requirement: "smoke output cannot overwrite
 * full results").
 */
export function checkpointPathFor(suiteId, { smoke = false } = {}) {
  mkdirSync(RUNS_DIR_PATH, { recursive: true });
  return resolve(RUNS_DIR_PATH, smoke ? `${suiteId}-smoke-checkpoint.json` : `${suiteId}-checkpoint.json`);
}

/**
 * A profile run only counts as "complete" (resumable-skip-eligible) when
 * it has zero errors, zero unmapped hits, zero query errors, confirmed
 * cleanup, and full metric coverage — matching the strict discipline
 * beir/run-scifact.mjs's own isCompletedProfileRun-equivalent already
 * established, extended here with the two production-path-specific gates
 * (unmappedHitCount, queryErrorCount) that don't exist in the raw-client
 * suites at all.
 */
export function isCompletedProfileRun(profileBlock, expected) {
  if (!profileBlock) return false;
  if ((profileBlock.errors?.length ?? 0) !== 0) return false;
  if (profileBlock.cleanup?.deleted !== true) return false;
  if ((profileBlock.unmappedHitCount ?? -1) !== 0) return false;
  if ((profileBlock.queryErrorCount ?? -1) !== 0) return false;
  if (profileBlock.indexing?.errors && profileBlock.indexing.errors !== 0) return false;
  const metrics = profileBlock.metrics;
  if (!metrics || typeof metrics.ndcgAt10 !== 'number' || !Number.isFinite(metrics.ndcgAt10)) return false;
  if (expected?.queryCount !== undefined && metrics.queryCount !== expected.queryCount) return false;
  return true;
}

/**
 * Content-fingerprinted "contract" recorded in every checkpoint — a
 * resume is rejected if any of this changed since the checkpoint was
 * written. Includes the deterministic env block's own hash so a future
 * change to DETERMINISTIC_INDEXING_ENV_BASE becomes a visible contract
 * mismatch, never a silent drift.
 */
export function buildBenchmarkContract({
  suiteId, datasetFingerprint, qdrantUrl, collectionPrefix,
  chunkCandidateLimit, documentMetricDepth, collapseStrategy, cudaRequested,
  deterministicEnvHash,
}) {
  return {
    version: CHECKPOINT_VERSION,
    suiteId,
    datasetFingerprint,
    qdrantEndpointFingerprint: qdrantUrl ? sha256Hex(qdrantUrl).slice(0, 16) : null,
    collectionPrefix,
    hybridPrefetchLimit: 'pinned(2)',
    rrfK: 'pinned(60)',
    chunkCandidateLimit,
    documentMetricDepth,
    collapseStrategy,
    cudaRequested,
    deterministicEnvHash,
  };
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Rejects a resume if the checkpoint's own contract no longer matches
 * the CURRENT contract, or if any previously-recorded profile run is
 * incomplete without confirmed cleanup (an incomplete-but-uncleaned run
 * must never be silently treated as resumable — see also
 * core/run-suite.mjs's own step-0 orphan sweep, the real safety net for
 * a hard-killed process that never wrote a checkpoint update at all).
 */
export function validateResumeCheckpoint(previous, contract) {
  if (!previous || typeof previous !== 'object') {
    throw new Error('Resume checkpoint is not a JSON object.');
  }
  if (JSON.stringify(previous.benchmarkContract) !== JSON.stringify(contract)) {
    throw new Error('Resume checkpoint contract does not match the current dataset/profile/env configuration.');
  }
  for (const [profileId, block] of Object.entries(previous.profiles ?? {})) {
    const completed = isCompletedProfileRun(block, { queryCount: block?.metrics?.queryCount });
    if (!completed && block?.cleanup?.deleted !== true) {
      throw new Error(`Incomplete profile run "${profileId}" does not have confirmed cleanup; refusing to resume.`);
    }
  }
  return true;
}

/** Atomic write: temp file + rename, same primitive src/core/config.js's
 * own saveConfig() uses — never a partial/torn checkpoint file on crash. */
export function writeCheckpointAtomic(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/** Same atomic write primitive, generalized for .trec run files too. */
export function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

export function loadCheckpointIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function initialCheckpointState(contract) {
  return {
    version: CHECKPOINT_VERSION,
    benchmarkContract: contract,
    profiles: {},
    resumeEvents: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    verdict: null,
  };
}
