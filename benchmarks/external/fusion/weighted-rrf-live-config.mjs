// Locked configuration for the live Qdrant weighted-RRF validation benchmark
// (run-weighted-rrf-live.mjs). Every field here is fixed BEFORE the live run
// and must not be tuned post-hoc based on results.
//
// This validates the offline weighted-RRF candidate selection
// (analyze-weighted-rrf.mjs, 2026-07-23-weighted-rrf-offline-analysis.json)
// against REAL Qdrant 1.17+ weighted-RRF queries (`query.rrf.weights`) —
// never `prefetch.weight`, never a local rank reconstruction. Reuses the
// exact same four scopes, cached dataset subsets, and provider profiles as
// the completed live RRF-k sweep (run-rrf-sweep.mjs /
// 2026-07-24-rrf-k-sweep-cuda.{json,md}).
//
// The six-mode fusion-mode list (and the rho -> sparseWeight formula) live
// in weighted-rrf-fusion-modes.mjs — a small shared pure module also
// consumed by the Slavic weighted-RRF harness
// (../slavic/slavic-weighted-rrf-config.mjs), so both benchmarks can never
// silently drift on mode definitions or the sparse-weight conversion.
import {
  E5_MODEL_ID, E5_DENSE_SIZE, BM25_MODEL_ID, BM25_OPTIONS,
  TOP_K, HYBRID_PREFETCH_LIMIT,
} from '../beir/profiles.mjs';
import { ONNX_DENSE_MODEL_ID } from '../../../src/shared/core/onnx-paths.js';
import {
  FUSION_MODES, FUSION_MODE_IDS, fusionModeById,
  PRIMARY_CANDIDATE_ID, DIAGNOSTIC_CANDIDATE_ID, EQUAL_RRF_CONTROL_IDS,
} from './weighted-rrf-fusion-modes.mjs';

export {
  TOP_K, HYBRID_PREFETCH_LIMIT, BM25_MODEL_ID, BM25_OPTIONS, E5_MODEL_ID, E5_DENSE_SIZE, ONNX_DENSE_MODEL_ID,
  FUSION_MODES, FUSION_MODE_IDS, fusionModeById,
  PRIMARY_CANDIDATE_ID, DIAGNOSTIC_CANDIDATE_ID, EQUAL_RRF_CONTROL_IDS,
};

export const COLLECTION_PREFIX = 'semidex-weighted-rrf-live-';

/**
 * @typedef {Object} ProviderDef
 * @property {'local'|'cloud'} kind
 * @property {string} denseModelId
 * @property {number} denseSize
 * @property {string} sparseModelId
 */

/** @type {Record<'local'|'cloud', ProviderDef>} */
export const PROVIDERS = Object.freeze({
  local: Object.freeze({
    kind: 'local',
    denseModelId: ONNX_DENSE_MODEL_ID,
    denseSize: 1024,
    sparseModelId: 'bge-m3-onnx-lexical', // not a Qdrant-hosted model id — computed locally by onnx-embed.js
  }),
  cloud: Object.freeze({
    kind: 'cloud',
    denseModelId: E5_MODEL_ID,
    denseSize: E5_DENSE_SIZE,
    sparseModelId: BM25_MODEL_ID,
  }),
});

/**
 * @typedef {Object} ScopeDef
 * @property {string} id
 * @property {'scifact'|'miracl'} dataset
 * @property {'local'|'cloud'} providerId
 * @property {ProviderDef} provider
 * @property {string} label
 */

/** @type {ScopeDef[]} */
export const SCOPES = Object.freeze([
  Object.freeze({
    id: 'scifact-local', dataset: 'scifact', providerId: 'local', provider: PROVIDERS.local,
    label: 'SciFact mini (100q/1000d) — local BGE-M3 ONNX, strict CUDA',
  }),
  Object.freeze({
    id: 'scifact-cloud', dataset: 'scifact', providerId: 'cloud', provider: PROVIDERS.cloud,
    label: 'SciFact mini (100q/1000d) — Qdrant Cloud Inference (E5-small + BM25)',
  }),
  Object.freeze({
    id: 'miracl-local', dataset: 'miracl', providerId: 'local', provider: PROVIDERS.local,
    label: 'MIRACL Russian pooled subset (100q/1000d) — local BGE-M3 ONNX, strict CUDA',
  }),
  Object.freeze({
    id: 'miracl-cloud', dataset: 'miracl', providerId: 'cloud', provider: PROVIDERS.cloud,
    label: 'MIRACL Russian pooled subset (100q/1000d) — Qdrant Cloud Inference (E5-small + BM25)',
  }),
]);

export const SCOPE_IDS = Object.freeze(SCOPES.map((s) => s.id));

export function scopeById(id) {
  const scope = SCOPES.find((s) => s.id === id);
  if (!scope) throw new Error(`[weighted-rrf-live-config] unknown scope id "${id}" — must be one of: ${SCOPE_IDS.join(', ')}`);
  return scope;
}

/** Parses a --scopes=a,b,c CLI flag value into an ordered, deduplicated,
 * validated list of ScopeDef — preserving SCOPES' own canonical order
 * regardless of the order the user listed them in. Throws on an unknown
 * scope id. `value === null` (flag never passed) is the ONLY input that
 * defaults to running all scopes; an explicit but empty flag is rejected —
 * this benchmark is expensive enough (real Qdrant collections, real
 * ONNX/cloud embedding calls, strict CUDA) that silently defaulting to
 * "run everything" on an empty explicit flag would be dangerous. */
export function parseScopesFlag(value) {
  if (value === null || value === undefined) return SCOPES;
  const requested = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
  if (requested.size === 0) {
    throw new Error(`[weighted-rrf-live-config] --scopes was passed with no scope ids — this refuses to silently default to running all ${SCOPES.length} scopes. Omit --scopes entirely to run all scopes, or pass explicit ids: ${SCOPE_IDS.join(',')}`);
  }
  for (const id of requested) scopeById(id); // throws on unknown id
  return SCOPES.filter((s) => requested.has(s.id));
}

/** Unique collection name for one scope's single indexing pass. */
export function collectionName(scopeId, runSuffix) {
  return `${COLLECTION_PREFIX}${scopeId}-${runSuffix}`;
}

// Bounded indexing/query safety knobs — matching the existing RRF-k sweep's
// own bounded batch sizes (never re-tuned here).
export const INDEX_BATCH_SIZE = 24;
export const RSS_TRACK_INTERVAL_MS = 2000;

// Smoke mode: tiny deterministic subset (still exercises all 6 fusion
// modes), writes to a dedicated, separate, never-real path.
export const SMOKE_QUERY_COUNT = 2;
export const SMOKE_CORPUS_SIZE = 8;

export const BENCHMARK_CHECKPOINT_VERSION = 1;
