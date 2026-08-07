// Provider-neutral embedding/search availability status — pure
// orchestration, no admin import (core/ never imports admin/; callers with
// admin-specific infra, e.g. src/admin/system/ollama.js's checkOllama(),
// inject it here as a function parameter instead).
//
// A missing embedding model does NOT make a collection unreadable — payload
// browsing, skeleton navigation, and direct chunk retrieval never depend on
// this module's result (browsingAvailable is unconditionally true).
// Semantic/hybrid search is what becomes unavailable.
import { createProfileCache } from '../storage/embedding-profile-cache.js';
import { EXECUTION } from './schema.js';
import { findDenseModel, findSparseModel } from './qdrant-cloud-models.js';

// Per-model lane-availability cache — SEPARATE from the per-collection
// resolved-profile cache (storage/embedding-profile-cache.js's
// createProfileCache() instance living inside qdrant-adapter.js). Many
// collections can share one Ollama model; without this, resolving
// availability for N collections that all use the same Ollama model would
// make N live Ollama calls in the time it takes the per-collection profile
// cache to expire. Keyed by "provider:model", not by collection name — the
// SAME createProfileCache() factory is reused here since its Map/TTL
// mechanics are already collection-agnostic (just a keyed TTL cache), not
// because lane results and collection profiles are the same kind of value.
const LANE_AVAILABILITY_TTL_MS = 20_000;
const laneAvailabilityCache = createProfileCache({ ttlMs: LANE_AVAILABILITY_TTL_MS });

// Test-only reset seam, mirroring resetQdrantClientCache()
// (src/core/qdrant/client.js) — clears the module-level cache between
// tests so one test's cached Ollama/ONNX lane result can never leak into
// another's assertions.
export function resetLaneAvailabilityCache() {
  laneAvailabilityCache.invalidateAll();
}
export const LANE_STATUS = Object.freeze({
  AVAILABLE: 'available',
  MISSING_MODEL: 'missing_model',
  MISSING_CREDENTIALS: 'missing_credentials',
  UNSUPPORTED_BACKEND: 'unsupported_backend',
  // MODEL_CACHED means "configured and locally cached, but runtime-
  // unverified" — this must NOT be conflated with AVAILABLE anywhere
  // downstream, including in the aggregate hybrid-search boolean. A
  // cached-but-unverified ONNX lane is attemptable (a real search call may
  // still be issued and proves runtime availability for THAT operation),
  // but this task does not feed a successful attempt back into any
  // verification cache, so the reported status stays MODEL_CACHED/
  // RUNTIME_UNVERIFIED regardless of how many searches have since
  // succeeded — routine availability remains unverified until an explicit
  // probe is implemented (out of this task's scope).
  MODEL_CACHED: 'model_cached',
  // NOT_CACHED is NOT "unavailable" for ONNX specifically — Semidex's ONNX
  // path auto-downloads the model on first real use (onnx-embed.js's
  // _doLoad() unconditionally downloads before creating a session), so a
  // real search against a NOT_CACHED collection will still work given
  // network access — it is "will download on first use," not "broken."
  // This is a genuine behavioral difference from Ollama, where Semidex
  // does NOT auto-pull a missing model (MISSING_MODEL stays a hard block).
  NOT_CACHED: 'not_cached',
  RUNTIME_UNAVAILABLE: 'runtime_unavailable', // only ever produced by the EXPLICIT full probe path, never by resolveAvailability's routine call
  // qdrant-cloud lane states (Tier 1/Tier 2 split — see
  // src/cloud/admin/qdrant-cloud-system.js's probeQdrantCloudInference() for
  // Tier 2). Tier 1 (resolveLaneAvailability, routine/cheap) can only ever
  // prove Qdrant itself is reachable and authenticated — it CANNOT prove
  // Cloud Inference actually works (no dry-run/verify-only endpoint
  // exists), so its ceiling is INFERENCE_UNVERIFIED, never AVAILABLE.
  CLOUD_UNREACHABLE: 'cloud_unreachable',
  // Reachable + authenticated, but inference itself was never attempted —
  // the honest Tier 1 ceiling, analogous to MODEL_CACHED for the ONNX
  // lane ("attemptable but not proven").
  INFERENCE_UNVERIFIED: 'inference_unverified',
  // Tier 2 ONLY (probeQdrantCloudInference()) — a REAL inference attempt
  // failed with an inference-specific error. Never produced by Tier 1.
  INFERENCE_DISABLED_OR_MODEL_UNAVAILABLE: 'inference_disabled_or_model_unavailable',
});

export const COLLECTION_STATUS = Object.freeze({
  AVAILABLE: 'available',
  // The collection-level counterpart to a MODEL_CACHED lane — search is
  // genuinely attemptable (the model is on disk) but not runtime-verified.
  // Distinct from AVAILABLE, which is only ever reached when every
  // required lane's real status is AVAILABLE (never MODEL_CACHED).
  RUNTIME_UNVERIFIED: 'runtime_unverified',
  // The collection-level counterpart to a NOT_CACHED ONNX lane
  // specifically — distinct from MISSING_MODEL (Ollama, hard block,
  // Semidex never auto-pulls) because Semidex's ONNX path DOES
  // auto-download on first real use.
  DOWNLOAD_REQUIRED: 'download_required',
  MISSING_MODEL: 'missing_model',
  MISSING_CREDENTIALS: 'missing_credentials',
  UNSUPPORTED_BACKEND: 'unsupported_backend',
  SCHEMA_MISMATCH: 'schema_mismatch',
  AMBIGUOUS_LEGACY: 'ambiguous_legacy',
  // These map 1:1 onto Part C's resolveExistingCollectionProfile
  // non-resolved reasons and Part B's typed getEmbeddingProfile states.
  LEGACY_UNMIGRATED: 'legacy_unmigrated',           // { resolved: false, reason: 'legacy_unmigrated' }
  INVALID_PROFILE: 'invalid_profile',               // { state: 'invalid' }
  UNSUPPORTED_PROFILE_SCHEMA: 'unsupported_profile_schema', // { state: 'unsupported_schema_version' }
  // Not produced by resolveAvailability() itself — reserved for callers
  // (qdrant-adapter.js's getCollection()) that catch a missing-DI throw
  // from resolveLaneAvailability() (e.g. an ollama lane with no
  // checkOllamaLane injected) and need an honest status distinct from
  // every outcome resolveAvailability can itself produce.
  UNKNOWN_DEPENDENCIES: 'unknown_dependencies',
});

const RESOLVE_REASON_TO_COLLECTION_STATUS = {
  legacy_unmigrated: COLLECTION_STATUS.LEGACY_UNMIGRATED,
  invalid: COLLECTION_STATUS.INVALID_PROFILE,
  unsupported_schema_version: COLLECTION_STATUS.UNSUPPORTED_PROFILE_SCHEMA,
  // A shape-valid profile that disagrees with the collection's REAL live
  // vector schema (qdrant-adapter.js's resolveEmbeddingProfileFromInfo()) —
  // distinct from every other non-resolved reason: the metadata parses
  // fine, it just describes a different vector space than what's actually
  // there (corrupted/tampered metadata, or a third-party client wrote it).
  schema_mismatch: COLLECTION_STATUS.SCHEMA_MISMATCH,
};

/**
 * Resolves ONE lane's (dense or sparse) availability. `lane` is
 * `profile.embedding.dense` or `profile.embedding.sparse` (possibly null
 * for a dense-only collection's sparse lane).
 *
 * checkOllamaLane/checkOnnxModelCached are REQUIRED DI params — no default
 * implementation lives in core/. Callers with different infra needs
 * (Admin API has src/admin/system/ollama.js already; MCP builds an
 * equivalent tiny wrapper directly from local/core/ollama.js's primitives)
 * supply their own. core/embedding-profile/availability.js itself never
 * imports Ollama-probing code, only accepts it as a function parameter.
 *
 * @param {{ provider: string, model: string, execution: string, vectorName?: string } | null} lane
 * @param {{ checkOllamaLane?: Function, checkOnnxModelCached?: Function, checkQdrantReachable?: Function }} deps
 * @returns {Promise<{ status: string, reason: string }>}
 */
export async function resolveLaneAvailability(lane, { checkOllamaLane, checkOnnxModelCached, checkQdrantReachable } = {}) {
  if (lane === null) {
    // A dense-only collection's sparse lane isn't "broken," it's simply
    // absent — the aggregate step in resolveAvailability() is what turns
    // this into hybridSearchAvailable: false, not this function.
    return { status: LANE_STATUS.AVAILABLE, reason: 'no sparse lane configured' };
  }
  if (lane.execution === EXECUTION.QDRANT_CLOUD) {
    if (lane.provider !== 'qdrant-cloud') {
      return { status: LANE_STATUS.UNSUPPORTED_BACKEND, reason: `unrecognized qdrant-cloud provider "${lane.provider}"` };
    }
    const catalogEntry = lane.vectorName === 'sparse' ? findSparseModel(lane.model) : findDenseModel(lane.model);
    if (!catalogEntry) {
      return { status: LANE_STATUS.MISSING_MODEL, reason: `model "${lane.model}" is not in the supported Qdrant Cloud catalog` };
    }
    if (catalogEntry.status !== 'supported') {
      return { status: LANE_STATUS.UNSUPPORTED_BACKEND, reason: catalogEntry.reason };
    }
    // Tier 1 ONLY — checkQdrantReachable is DELIBERATELY cheap and
    // DELIBERATELY does not prove inference works (no dry-run/verify-only
    // endpoint exists). Its ceiling result is INFERENCE_UNVERIFIED, never
    // AVAILABLE — see Tier 2 (probeQdrantCloudInference(), admin-owned)
    // for the only code path that can actually prove inference works.
    if (!checkQdrantReachable) throw new Error('resolveLaneAvailability: checkQdrantReachable is required for a qdrant-cloud lane');
    const result = await checkQdrantReachable();
    if (result.status === 'unreachable') {
      return { status: LANE_STATUS.CLOUD_UNREACHABLE, reason: result.message ?? 'Qdrant is not reachable' };
    }
    if (result.status === 'auth_failed') {
      return { status: LANE_STATUS.MISSING_CREDENTIALS, reason: result.message ?? 'Qdrant authentication failed' };
    }
    return { status: LANE_STATUS.INFERENCE_UNVERIFIED, reason: 'Qdrant is reachable and the API key is valid, but Cloud Inference has not been verified for this model. Run "Test Cloud Inference" to confirm.' };
  }
  if (lane.execution !== 'client') {
    return { status: LANE_STATUS.UNSUPPORTED_BACKEND, reason: `execution "${lane.execution}" is not implemented yet` };
  }
  if (lane.provider === 'ollama') {
    if (!checkOllamaLane) throw new Error('resolveLaneAvailability: checkOllamaLane is required for an ollama lane');
    const cacheKey = `ollama:${lane.model}`;
    const cached = laneAvailabilityCache.get(cacheKey);
    if (cached) return cached;
    const result = await checkOllamaLane({ requiredModel: lane.model });
    const resolved = result.status === 'available'
      ? { status: LANE_STATUS.AVAILABLE, reason: 'Ollama is running with the required model available' }
      : result.status === 'model_missing'
        ? { status: LANE_STATUS.MISSING_MODEL, reason: result.message ?? `model "${lane.model}" is not pulled` }
        : { status: LANE_STATUS.MISSING_MODEL, reason: result.message ?? 'Ollama is not reachable' };
    laneAvailabilityCache.set(cacheKey, resolved);
    return resolved;
  }
  if (lane.provider === 'bge-m3-onnx') {
    if (!checkOnnxModelCached) throw new Error('resolveLaneAvailability: checkOnnxModelCached is required for a bge-m3-onnx lane');
    const cacheKey = `bge-m3-onnx:${lane.model}`;
    const cached = laneAvailabilityCache.get(cacheKey);
    if (cached) return cached;
    const result = await checkOnnxModelCached({ requiredModel: lane.model });
    const resolved = { status: result.status, reason: result.status === LANE_STATUS.MODEL_CACHED ? 'model files cached, runtime not verified' : 'model not yet downloaded' };
    laneAvailabilityCache.set(cacheKey, resolved);
    return resolved;
  }
  if (lane.provider === 'hashed-tf') {
    return { status: LANE_STATUS.AVAILABLE, reason: 'no external dependency' };
  }
  return { status: LANE_STATUS.UNSUPPORTED_BACKEND, reason: `unrecognized provider "${lane.provider}"` };
}

const verified = (status) => status === LANE_STATUS.AVAILABLE;
// INFERENCE_UNVERIFIED is treated exactly like MODEL_CACHED — "attemptable
// but not proven." A real search MAY still be issued (Part E never gates
// the actual search code path on availability); it never satisfies
// hybridSearchAvailable's strict verified() check above.
const attemptable = (status) => status === LANE_STATUS.AVAILABLE || status === LANE_STATUS.MODEL_CACHED || status === LANE_STATUS.NOT_CACHED || status === LANE_STATUS.INFERENCE_UNVERIFIED;

function laneToCollectionStatus(status) {
  if (status === LANE_STATUS.MISSING_MODEL) return COLLECTION_STATUS.MISSING_MODEL;
  if (status === LANE_STATUS.MISSING_CREDENTIALS) return COLLECTION_STATUS.MISSING_CREDENTIALS;
  if (status === LANE_STATUS.UNSUPPORTED_BACKEND) return COLLECTION_STATUS.UNSUPPORTED_BACKEND;
  if (status === LANE_STATUS.RUNTIME_UNAVAILABLE) return COLLECTION_STATUS.MISSING_MODEL;
  if (status === LANE_STATUS.CLOUD_UNREACHABLE) return COLLECTION_STATUS.MISSING_CREDENTIALS;
  if (status === LANE_STATUS.INFERENCE_DISABLED_OR_MODEL_UNAVAILABLE) return COLLECTION_STATUS.MISSING_MODEL;
  return COLLECTION_STATUS.MISSING_MODEL; // defensive fallback, should be unreachable given the enum
}

/**
 * The ONE place every Part C resolution outcome (resolved or not) is
 * turned into a reportable availability status.
 *
 * @param {{ resolved: true, profile: Object } | { resolved: false, reason: string }} resolveResult
 *   Part C's resolveExistingCollectionProfile() result.
 * @param {{ checkOllamaLane?: Function, checkOnnxModelCached?: Function }} [deps]
 * @returns {Promise<{
 *   status: string,
 *   dense: { status: string, reason: string } | null,
 *   sparse: { status: string, reason: string } | null,
 *   aggregate: { hybridSearchAvailable: boolean, searchAttemptable: boolean, browsingAvailable: true },
 * }>}
 */
export async function resolveAvailability(resolveResult, deps = {}) {
  if (!resolveResult.resolved) {
    const status = RESOLVE_REASON_TO_COLLECTION_STATUS[resolveResult.reason] ?? COLLECTION_STATUS.AMBIGUOUS_LEGACY;
    return {
      status,
      dense: null,
      sparse: null,
      aggregate: { hybridSearchAvailable: false, searchAttemptable: false, browsingAvailable: true },
    };
  }

  const { profile } = resolveResult;
  const dense = await resolveLaneAvailability(profile.embedding.dense, deps);
  const sparse = await resolveLaneAvailability(profile.embedding.sparse ?? null, deps);

  // hybridSearchAvailable: STRICT — every required lane's status must be
  // the real, verified LANE_STATUS.AVAILABLE. A MODEL_CACHED or NOT_CACHED
  // lane does NOT satisfy this. sparse === null in the profile also fails
  // this (Semidex's implemented search contract is hybrid dense+sparse;
  // there is no separately implemented dense-only search path).
  const sparseConfigured = profile.embedding.sparse !== null;
  const hybridSearchAvailable = verified(dense.status) && sparseConfigured && verified(sparse.status);

  // searchAttemptable: a real search call MAY still be issued against an
  // unverified (MODEL_CACHED) or not-yet-downloaded (NOT_CACHED, ONNX
  // auto-downloads) lane — this does NOT block the actual search code path
  // (Part E never gates on availability, only on Part C's resolution
  // result). Required lanes (dense always; sparse only when configured)
  // must each be attemptable() for this to be true.
  const searchAttemptable = attemptable(dense.status) && sparseConfigured && attemptable(sparse.status);

  let status;
  if (hybridSearchAvailable) {
    status = COLLECTION_STATUS.AVAILABLE;
  } else if (!sparseConfigured) {
    // No sparse lane at all — not a lane failure, a profile shape; still
    // report SOMETHING distinct from a genuine failure. Falls through to
    // the same precedence as a missing/unsupported lane below via dense's
    // own status once sparse itself can't explain non-availability.
    status = attemptable(dense.status)
      ? (dense.status === LANE_STATUS.NOT_CACHED ? COLLECTION_STATUS.DOWNLOAD_REQUIRED
        : dense.status === LANE_STATUS.MODEL_CACHED ? COLLECTION_STATUS.RUNTIME_UNVERIFIED
        : COLLECTION_STATUS.AVAILABLE)
      : laneToCollectionStatus(dense.status);
  } else if (dense.status === LANE_STATUS.NOT_CACHED || sparse.status === LANE_STATUS.NOT_CACHED) {
    // DOWNLOAD_REQUIRED takes precedence over RUNTIME_UNVERIFIED — "will
    // download" is a more specific, more actionable statement.
    status = COLLECTION_STATUS.DOWNLOAD_REQUIRED;
  } else if (searchAttemptable) {
    // Every required lane at least attemptable(), but not fully verified
    // (the remaining case is MODEL_CACHED on one or both lanes).
    status = COLLECTION_STATUS.RUNTIME_UNVERIFIED;
  } else {
    // Some required lane is neither verified nor attemptable — map from
    // whichever lane is the worse of the two.
    const worseLane = !attemptable(dense.status) ? dense : sparse;
    status = laneToCollectionStatus(worseLane.status);
  }

  return {
    status,
    dense,
    sparse: sparseConfigured ? sparse : null,
    aggregate: { hybridSearchAvailable, searchAttemptable, browsingAvailable: true },
  };
}
