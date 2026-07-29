// Profile definitions for the production-path benchmark: Local (BGE-M3
// ONNX dense + learned sparse) vs Semidex Lite (Qdrant Cloud Inference:
// E5-small dense + BM25 sparse). Pure data + small env-building helpers —
// no I/O, no process spawning (see core/index-via-cli.mjs for that).

export const COLLECTION_PREFIX = 'semidex-prodpath-bench-';

// Every value pinned explicitly (never omitted to "get the default"):
// ambient .env/OS env could otherwise silently enable LLM summaries, tag
// generation, a different chunking budget, or a different fusion config
// for one run and not another, corrupting the local-vs-cloud comparison.
// These are the SAME values as each setting's own registry default today
// (src/core/settings/definitions.js) — pinning them here just means a
// future change to those defaults can never silently drift this
// benchmark's own results out from under it (the checkpoint's
// benchmarkContract also fingerprints this whole block — see
// core/checkpoint.mjs).
export const DETERMINISTIC_INDEXING_ENV_BASE = Object.freeze({
  TAG_GEN: '0',
  SKELETON_SUMMARY: 'deterministic',
  PIPELINE_MODE: '0',
  STAGEA_CONCURRENCY: '1',
  OLLAMA_STAGE_CONCURRENCY: '1',
  EMBED_STAGE_CONCURRENCY: '1',
  MAX_CHUNK_TOKENS: '512',
  MIN_CHUNK_TOKENS: '160',
  CHUNK_OVERLAP_TOKENS: '80',
  SKELETON_CARRYOVER_CHARS: '500',
  HYBRID_PREFETCH_LIMIT: '2',
  RRF_K: '60',
  PRUNE_STALE: '0',
  COMBINED_LLM: '0',
  FORCE_REINDEX: '0',
  ONNX_EXECUTION_PROVIDER: 'cpu',
  ONNX_CUDA_STRICT: '0',
});

export const LOCAL_PROFILE = Object.freeze({
  id: 'local',
  label: 'Local (BGE-M3 ONNX dense + learned sparse)',
  env: Object.freeze({ DENSE_PROVIDER: 'bge-m3-onnx', SPARSE_PROVIDER: 'bge-m3-onnx' }),
});

export const CLOUD_PROFILE = Object.freeze({
  id: 'cloud',
  label: 'Semidex Lite (Qdrant Cloud Inference: E5-small + BM25)',
  env: Object.freeze({
    DENSE_PROVIDER: 'qdrant-cloud',
    SPARSE_PROVIDER: 'qdrant-cloud',
    QDRANT_CLOUD_DENSE_MODEL: 'intfloat/multilingual-e5-small',
  }),
});

export const PROFILES = Object.freeze([LOCAL_PROFILE, CLOUD_PROFILE]);

/**
 * Builds the FULL env object for spawning the indexer subprocess for one
 * profile — deterministic base + profile-specific provider selection +
 * COLLECTION + an explicit absolute SOURCE_ROOT (never left to default to
 * a CWD-relative resolution, which would be a reproducibility risk) + an
 * explicit CUDA override only when both requested and this is the local
 * profile.
 * @param {{id:string, env:Object}} profile
 * @param {string} collectionName
 * @param {{ materializedDir: string }} runCtx
 * @param {{ cuda?: boolean }} [opts]
 */
export function buildIndexEnv(profile, collectionName, runCtx, { cuda = false } = {}) {
  const env = {
    ...DETERMINISTIC_INDEXING_ENV_BASE,
    COLLECTION: collectionName,
    SOURCE_ROOT: runCtx.materializedDir,
    ...profile.env,
  };
  if (profile.id === 'local' && cuda) {
    env.ONNX_EXECUTION_PROVIDER = 'cuda';
    env.ONNX_CUDA_STRICT = '1';
  }
  return env;
}

/**
 * Applies the deterministic HYBRID_PREFETCH_LIMIT/RRF_K env vars to the
 * HARNESS'S OWN process.env — the harness process itself issues
 * in-process runHybridSearch() calls (query phase), which read these
 * settings from process.env directly when no settingsService is passed
 * (see src/core/qdrant/store.js's resolvePrefetchLimit/resolveRrfK).
 * Pinning the indexer subprocess's env alone is not enough; the harness
 * process querying afterward must see the same values.
 * @returns {{ previous: Object }} the previous values of every key this
 *   function touched, for exact restoration afterward (see
 *   restoreHarnessEnv below and core/run-suite.mjs's per-profile cleanup).
 */
export function applyDeterministicHarnessEnv() {
  const keys = ['HYBRID_PREFETCH_LIMIT', 'RRF_K'];
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    process.env[key] = DETERMINISTIC_INDEXING_ENV_BASE[key];
  }
  return { previous };
}

/** Restores process.env keys to whatever restoreState.previous recorded. */
export function restoreHarnessEnv(restoreState) {
  for (const [key, value] of Object.entries(restoreState.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Deterministic, prefix-owned collection name for one (suite, profile,
 * run) triple — never random beyond the caller-supplied runSuffix, so a
 * resumed run can recompute and re-locate the exact same collection name.
 */
export function collectionName(suiteId, profileId, runSuffix) {
  return `${COLLECTION_PREFIX}${suiteId}-${profileId}-${runSuffix}`;
}
