// Locked configuration for the live Qdrant RRF-k sweep benchmark
// (run-rrf-sweep.mjs). Every field here is fixed BEFORE the live run and
// must not be tuned post-hoc based on results.
//
// This measures the real Qdrant RRF curve for k = [1, 2, 5, 10, 30, 60]
// across four strictly separate (dataset, provider) scopes:
//   - scifact-local:  BEIR SciFact mini (100q/1000d) — local BGE-M3 ONNX
//   - scifact-cloud:  BEIR SciFact mini (100q/1000d) — Qdrant Cloud Inference
//   - miracl-local:   MIRACL Russian pooled subset (100q/1000d) — local BGE-M3 ONNX
//   - miracl-cloud:   MIRACL Russian pooled subset (100q/1000d) — Qdrant Cloud Inference
//
// SciFact and MIRACL qrels/metrics are never merged. Reuses the exact
// locked constants (TOP_K, HYBRID_PREFETCH_LIMIT, E5 prefixes, BM25
// options, dense/sparse vector schema) from ../beir/profiles.mjs and
// ../miracl/miracl-profiles.mjs — this file adds only what is genuinely
// new: the k sweep list and the 4-scope matrix.
import {
  E5_MODEL_ID, E5_DENSE_SIZE, BM25_MODEL_ID, BM25_OPTIONS,
  TOP_K, HYBRID_PREFETCH_LIMIT,
} from '../beir/profiles.mjs';
import { ONNX_DENSE_MODEL_ID } from '../../../src/shared/core/onnx-paths.js';

export { TOP_K, HYBRID_PREFETCH_LIMIT, BM25_MODEL_ID, BM25_OPTIONS, E5_MODEL_ID, E5_DENSE_SIZE };

// The complete, locked RRF k sweep — every hybrid query in this benchmark
// runs at exactly these 6 values, in this order, never more, never fewer.
export const SWEEP_KS = Object.freeze([1, 2, 5, 10, 30, 60]);

// Reference constants every sweep k is also compared against directly (in
// addition to dense/sparse), matching the two k values the earlier BEIR/
// MIRACL benchmarks already measured.
export const REFERENCE_K_QDRANT_DEFAULT = 2;
export const REFERENCE_K_SEMIDEX_DEFAULT = 60;

export const COLLECTION_PREFIX = 'semidex-rrf-sweep-';

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
    label: 'SciFact mini (100q/1000d) — local BGE-M3 ONNX',
  }),
  Object.freeze({
    id: 'scifact-cloud', dataset: 'scifact', providerId: 'cloud', provider: PROVIDERS.cloud,
    label: 'SciFact mini (100q/1000d) — Qdrant Cloud Inference (E5-small + BM25)',
  }),
  Object.freeze({
    id: 'miracl-local', dataset: 'miracl', providerId: 'local', provider: PROVIDERS.local,
    label: 'MIRACL Russian pooled subset (100q/1000d) — local BGE-M3 ONNX',
  }),
  Object.freeze({
    id: 'miracl-cloud', dataset: 'miracl', providerId: 'cloud', provider: PROVIDERS.cloud,
    label: 'MIRACL Russian pooled subset (100q/1000d) — Qdrant Cloud Inference (E5-small + BM25)',
  }),
]);

export const SCOPE_IDS = Object.freeze(SCOPES.map((s) => s.id));

export function scopeById(id) {
  const scope = SCOPES.find((s) => s.id === id);
  if (!scope) throw new Error(`[rrf-sweep-config] unknown scope id "${id}" — must be one of: ${SCOPE_IDS.join(', ')}`);
  return scope;
}

/** Parses a --scopes=a,b,c CLI flag value into an ordered, deduplicated,
 * validated list of ScopeDef — preserving SCOPES' own canonical order
 * regardless of the order the user listed them in, so scopes always run in
 * the same fixed sequence. Throws on an unknown scope id.
 *
 * `value === null` (the flag was never passed at all) is the ONLY input
 * that defaults to running all scopes. An explicit but empty flag
 * (`--scopes=`, `--scopes= ,, `) is a distinct, deliberately REJECTED
 * input — this benchmark is expensive enough (real Qdrant collections,
 * real ONNX/cloud embedding calls) that silently treating "explicit but
 * empty" the same as "not specified, run everything" would be a dangerous
 * default. Callers that truly want every scope must omit --scopes
 * entirely, not pass an empty value. */
export function parseScopesFlag(value) {
  if (value === null || value === undefined) return SCOPES;
  const requested = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
  if (requested.size === 0) {
    throw new Error(`[rrf-sweep-config] --scopes was passed with no scope ids — this refuses to silently default to running all ${SCOPES.length} scopes. Omit --scopes entirely to run all scopes, or pass explicit ids: ${SCOPE_IDS.join(',')}`);
  }
  for (const id of requested) scopeById(id); // throws on unknown id
  return SCOPES.filter((s) => requested.has(s.id));
}

/** Unique collection name for one scope's single indexing pass. */
export function collectionName(scopeId, runSuffix) {
  return `${COLLECTION_PREFIX}${scopeId}-${runSuffix}`;
}

// Bounded indexing/query safety knobs — matching the existing BEIR/MIRACL
// harnesses' own bounded batch sizes (never re-tuned here).
export const INDEX_BATCH_SIZE = 24;
export const RSS_TRACK_INTERVAL_MS = 2000;

// Smoke mode: tiny deterministic subset (still exercises all 6 k values),
// writes to a dedicated, separate, never-real path.
export const SMOKE_QUERY_COUNT = 2;
export const SMOKE_CORPUS_SIZE = 8;

export const BENCHMARK_CHECKPOINT_VERSION = 1;
