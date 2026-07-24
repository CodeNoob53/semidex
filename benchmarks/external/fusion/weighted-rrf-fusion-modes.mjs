// Shared, pure fusion-mode definitions for every live weighted-RRF
// benchmark harness (run-weighted-rrf-live.mjs for SciFact/MIRACL,
// run-slavic-weighted-rrf.mjs for the Slavic Belebele matrix). Extracted so
// the six-mode list and the rho -> sparseWeight formula are defined in
// exactly ONE place — no harness re-derives or re-tunes these numbers.
//
// Real Qdrant weighted-RRF contract only: `query: { rrf: { k, weights:
// [denseWeight, sparseWeight] } }`. Weights always live in
// `query.rrf.weights`, never on a `prefetch` entry (`prefetch.weight` is
// not the weighted-RRF contract this repo's harnesses test).
//
// rho -> sparseWeight is the exact closed-form conversion the offline
// analyzer (analyze-weighted-rrf.mjs: sparseWeightFromRho) and the live
// SciFact/MIRACL benchmark both already validated, with denseWeight fixed
// at 1.0:
//   sparseWeight = 1 / (k * (1/rho - 1) + 1)
// k2/rho0.10 -> 1 / (2 * 9 + 1) = 1/19 = 0.05263157894736842
// k2/rho0.25 -> 1 / (2 * 3 + 1) = 1/7  = 0.14285714285714285
// These two numeric literals are locked to the offline analyzer's own
// selected primary candidate and its diagnostic neighbor — never
// recomputed or re-tuned by any consumer of this module.
export function sparseWeightFromRho(k, rho) {
  return 1 / (k * (1 / rho - 1) + 1);
}

// The six required retrieval modes, in this exact order — every consumer
// runs all six, never more, never fewer. dense-only and sparse-only are
// plain `using: 'dense'|'sparse'` queries (no rrf); the remaining four are
// real `query: { rrf: { k, weights: [dense, sparse] } }` hybrid queries
// sharing the same prefetch spec (limit HYBRID_PREFETCH_LIMIT per lane),
// differing only in k/weights.
//
// Object.freeze() is shallow — freezing a mode object does NOT freeze its
// `weights` array, which would otherwise remain silently mutable (e.g.
// `fusionModeById('equal_k2').weights[0] = 999` would succeed with no
// error and corrupt every subsequent live Qdrant request built from this
// "locked" config). Each weights array is frozen individually below,
// before being embedded into its mode object.
const weights = (arr) => Object.freeze(arr);

export const FUSION_MODES = Object.freeze([
  Object.freeze({ id: 'dense', kind: 'single', using: 'dense', label: 'Dense-only' }),
  Object.freeze({ id: 'sparse', kind: 'single', using: 'sparse', label: 'Sparse-only' }),
  Object.freeze({
    id: 'equal_k2', kind: 'rrf', k: 2, weights: weights([1.0, 1.0]),
    label: 'Equal RRF k=2 (Qdrant default weights)', role: 'control',
  }),
  Object.freeze({
    id: 'equal_k60', kind: 'rrf', k: 60, weights: weights([1.0, 1.0]),
    label: 'Equal RRF k=60 (Semidex default weights)', role: 'control',
  }),
  Object.freeze({
    id: 'k2_rho0.10', kind: 'rrf', k: 2, weights: weights([1.0, sparseWeightFromRho(2, 0.10)]),
    label: 'Weighted RRF k=2, rho=0.10 (offline primary dense-heavy candidate)', role: 'primary',
  }),
  Object.freeze({
    id: 'k2_rho0.25', kind: 'rrf', k: 2, weights: weights([1.0, sparseWeightFromRho(2, 0.25)]),
    label: 'Weighted RRF k=2, rho=0.25 (diagnostic neighbor — never promoted merely for winning one scope/language)', role: 'diagnostic',
  }),
]);

export const FUSION_MODE_IDS = Object.freeze(FUSION_MODES.map((m) => m.id));

export function fusionModeById(id) {
  const mode = FUSION_MODES.find((m) => m.id === id);
  if (!mode) throw new Error(`[weighted-rrf-fusion-modes] unknown fusion mode id "${id}" — must be one of: ${FUSION_MODE_IDS.join(', ')}`);
  return mode;
}

export const PRIMARY_CANDIDATE_ID = 'k2_rho0.10';
export const DIAGNOSTIC_CANDIDATE_ID = 'k2_rho0.25';
export const EQUAL_RRF_CONTROL_IDS = Object.freeze(['equal_k2', 'equal_k60']);
