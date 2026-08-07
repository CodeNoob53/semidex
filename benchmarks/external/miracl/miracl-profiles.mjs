// Locked provider profile definitions for the MIRACL Russian pooled-subset
// benchmark. Every field here is fixed BEFORE the live run and must not be
// tuned post-hoc based on results.
//
// Two profiles, run sequentially, never concurrently, BOTH under RRF k=2
// AND k=60 (unlike the BEIR SciFact harness, where only the cloud profile
// got both k values — this MIRACL run measures the fusion constant for
// both providers so the local-vs-cloud comparison is apples-to-apples on
// fusion too):
//   - local:  current Semidex bge-m3-onnx dense + learned sparse.
//   - cloud:  Qdrant-hosted intfloat/multilingual-e5-small dense (384,
//             Cosine) + server-side qdrant/bm25 sparse.
//
// Shared constants (model IDs, E5 prefix contract, BM25 options, RRF k
// values, TOP_K, prefetch limit) are imported from the BEIR harness's
// profiles.mjs rather than re-declared — they describe the SAME Qdrant
// Cloud Inference contract validated there, not a MIRACL-specific choice.
// Only the profile list (rrfKs per profile) and the regime differ here.
import {
  BM25_MODEL_ID, E5_MODEL_ID, E5_DENSE_SIZE, E5_PREFIX, BM25_OPTIONS,
  RRF_K_QDRANT_DEFAULT, RRF_K_SEMIDEX_DEFAULT, TOP_K, HYBRID_PREFETCH_LIMIT,
  COMMON_REGIME_TOKEN_BUDGET,
} from '../beir/profiles.mjs';
import { ONNX_DENSE_MODEL_ID } from '../../../src/shared/core/onnx-paths.js';

export {
  BM25_MODEL_ID, E5_MODEL_ID, E5_DENSE_SIZE, E5_PREFIX, BM25_OPTIONS,
  RRF_K_QDRANT_DEFAULT, RRF_K_SEMIDEX_DEFAULT, TOP_K, HYBRID_PREFETCH_LIMIT,
  COMMON_REGIME_TOKEN_BUDGET,
};

// This first MIRACL run uses ONLY the common-512 provider-neutral regime —
// no native/full-text regime, per the task's explicit scope lock.
export const REGIME = 'common-512';

const RRF_KS = Object.freeze([RRF_K_QDRANT_DEFAULT, RRF_K_SEMIDEX_DEFAULT]); // [2, 60]

/**
 * @typedef {Object} ProfileDef
 * @property {string} id
 * @property {string} label
 * @property {'local'|'cloud'} kind
 * @property {string} denseModelId
 * @property {number} denseSize
 * @property {string} sparseModelId
 * @property {number[]} rrfKs
 */

/** @type {ProfileDef[]} */
export const PROFILES = Object.freeze([
  Object.freeze({
    id: 'local',
    label: 'Local (bge-m3-onnx dense+sparse)',
    kind: 'local',
    denseModelId: ONNX_DENSE_MODEL_ID,
    denseSize: 1024,
    sparseModelId: 'bge-m3-onnx-lexical',
    rrfKs: RRF_KS,
  }),
  Object.freeze({
    id: 'cloud',
    label: 'Qdrant Cloud (hosted E5-small dense + server-side BM25)',
    kind: 'cloud',
    denseModelId: E5_MODEL_ID,
    denseSize: E5_DENSE_SIZE,
    sparseModelId: BM25_MODEL_ID,
    rrfKs: RRF_KS,
  }),
]);

export const COLLECTION_PREFIX = 'semidex-miracl-ru-';

/** Unique collection name for one (profile, run) combination. */
export function collectionName(profileId, runSuffix) {
  return `${COLLECTION_PREFIX}${profileId}-${runSuffix}`;
}
