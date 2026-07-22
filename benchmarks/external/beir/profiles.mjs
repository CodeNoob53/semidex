// Locked provider profile definitions for the BEIR SciFact external
// benchmark. Every field here is fixed BEFORE the live run and must not be
// tuned post-hoc based on results — that is the whole point of "locked".
//
// Two profiles, run sequentially, never concurrently:
//   - local:  current Semidex bge-m3-onnx dense + learned sparse, fused via
//             Qdrant RRF k=60 (Semidex's own production default, per
//             core/settings/definitions.js RRF_K).
//   - cloud:  Qdrant-hosted intfloat/multilingual-e5-small dense (384,
//             Cosine) + server-side qdrant/bm25 sparse, run under BOTH
//             RRF k=2 (Qdrant's own default) and RRF k=60 (Semidex's
//             default), so the comparison is apples-to-apples on fusion
//             constant too.
//
// E5 asymmetric retrieval contract (official, from the model's own model
// card / usage instructions — intfloat/multilingual-e5-small is trained
// with instruction prefixes and MUST be queried asymmetrically): corpus
// documents get "passage: " prepended, queries get "query: " prepended.
// This harness runs ONLY that documented contract — no raw/unprefixed
// variant, no picking the better one after seeing results.

export const BM25_MODEL_ID = 'qdrant/bm25';
export const E5_MODEL_ID = 'intfloat/multilingual-e5-small';
export const E5_DENSE_SIZE = 384;
export const E5_PREFIX = Object.freeze({ passage: 'passage: ', query: 'query: ' });

// BM25 text-processing options — locked to the language-neutral multilingual
// candidate the prior live spike already validated end-to-end (upsert +
// query, modifier:idf). Identical between indexing and querying, as required
// — a mismatch would silently change tokenization.
export const BM25_OPTIONS = Object.freeze({ language: 'none', tokenizer: 'multilingual', ascii_folding: true });

// RRF fusion constants under test for the cloud profile. Qdrant's own
// default is k=2; Semidex's production default (core/settings/definitions.js
// RRF_K) is k=60 — both are run so the report can show the difference this
// one knob makes on a real external benchmark, not just on the earlier
// synthetic spike fixture.
export const RRF_K_QDRANT_DEFAULT = 2;
export const RRF_K_SEMIDEX_DEFAULT = 60;

// Fixed retrieval depth and prefetch width for every query, every profile,
// every regime — never varied per-mode, so results are comparable.
export const TOP_K = 100;
export const HYBRID_PREFETCH_LIMIT = 200;

// Input regimes (see prepare-inputs.mjs): "common-512" prepares one shared,
// provider-neutral word-boundary body that stays within 512 tokens under
// both BGE-M3 and E5 (including E5's role prefix for the E5 check). Local and
// cloud profiles consume that exact same body; only the embedding lane adds
// its model-specific prefix. "native" uses the full title+text with no
// artificial cap — each provider's own real context limit/truncation
// behavior applies (BGE-M3 ONNX: 8192 sequencer max_length in
// onnx-embed.js; E5-small: 512-token model context window).
export const REGIMES = Object.freeze(['common-512', 'native']);
export const COMMON_REGIME_TOKEN_BUDGET = 512;

/**
 * @typedef {Object} ProfileDef
 * @property {string} id
 * @property {string} label
 * @property {'local'|'cloud'} kind
 * @property {string} denseModelId
 * @property {number} denseSize
 * @property {string} sparseModelId
 * @property {number[]} rrfKs — every RRF k this profile is run under (each
 *   produces its own separate collection/run/report row)
 */

/** @type {ProfileDef[]} */
export const PROFILES = Object.freeze([
  Object.freeze({
    id: 'local',
    label: 'Local (bge-m3-onnx dense+sparse)',
    kind: 'local',
    denseModelId: 'aapot/bge-m3-onnx', // ONNX_DENSE_MODEL_ID, see run-scifact.mjs's import from core/onnx-paths.js
    denseSize: 1024,
    sparseModelId: 'bge-m3-onnx-lexical', // not a Qdrant-hosted model id — computed locally by onnx-embed.js
    rrfKs: [RRF_K_SEMIDEX_DEFAULT],
  }),
  Object.freeze({
    id: 'cloud',
    label: 'Qdrant Cloud (hosted E5-small dense + server-side BM25)',
    kind: 'cloud',
    denseModelId: E5_MODEL_ID,
    denseSize: E5_DENSE_SIZE,
    sparseModelId: BM25_MODEL_ID,
    rrfKs: [RRF_K_QDRANT_DEFAULT, RRF_K_SEMIDEX_DEFAULT],
  }),
]);

/** Every (profile, regime) combination this benchmark indexes — the
 * complete, locked indexing matrix. Iterating this array (in order) is the
 * only way run-scifact.mjs selects what to run; there is no other code path
 * that constructs a run configuration, so the matrix can never silently
 * drift from what's documented here.
 *
 * A collection is created ONCE per (profile, regime) — not once per
 * (profile, regime, rrfK) — because indexing is completely independent of
 * the RRF fusion constant: k only affects how the hybrid query's prefetch
 * results are combined at QUERY time, never what gets written to the
 * collection. Re-indexing per k would double cloud embedding cost/quota
 * for cloud.k2 vs cloud.k60 while producing byte-identical collections.
 * Each entry carries the full rrfKs array; run-scifact.mjs indexes once
 * per entry, then runs one hybrid query pass per k in that array, each
 * producing its own separate metrics row / TREC run / report entry. */
export function buildRunMatrix() {
  const matrix = [];
  for (const profile of PROFILES) {
    for (const regime of REGIMES) {
      matrix.push({
        profileId: profile.id,
        profile,
        regime,
        rrfKs: profile.rrfKs,
        runId: `${profile.id}-${regime}`,
      });
    }
  }
  return matrix;
}

/** Flattens buildRunMatrix() into one row per (profile, regime, rrfK) — used
 * only for verdict/report enumeration (e.g. "did every locked combination
 * produce valid metrics"), never for deciding what to index. */
export function flattenRunMatrixByK(matrix) {
  const rows = [];
  for (const entry of matrix) {
    for (const rrfK of entry.rrfKs) {
      rows.push({ ...entry, rrfK, metricRowId: `${entry.runId}-k${rrfK}` });
    }
  }
  return rows;
}

export const COLLECTION_PREFIX = 'semidex-beir-scifact-';

/** Unique collection name for one (profile, regime, run) combination. Kept
 * short and Qdrant-safe (lowercase, hyphens); run-scifact.mjs appends a
 * timestamp and random suffix before creation. */
export function collectionName(profileId, regime, runSuffix) {
  return `${COLLECTION_PREFIX}${profileId}-${regime}-${runSuffix}`;
}
