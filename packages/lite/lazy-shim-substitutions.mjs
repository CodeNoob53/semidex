// Semidex Lite lazy-shim substitution list — the single, canonical
// declaration of which *-lazy.js modules packages/lite/build.mjs's real
// staging step (substituteLazyShims()) replaces with a *-lazy.lite.js
// content substitute, and which scripts/audit/classify-modules.mjs's
// computeReachable({ applyLiteShims: true }) models when computing
// POST-shim ("what actually ships in the tarball") reachability.
//
// Phase 7 (docs/design/full-lite-shared-architecture-audit-2026-08-01.md,
// "Phase 7 — Audit and reduce unnecessary Semidex Lite lazy shims"): before
// this file existed, build.mjs and classify-modules.mjs each declared
// their OWN independent copy of this same three-pair list, in two
// different shapes (a REPO_SRC-relative { real, shim } array vs. a
// src/-prefixed repo-root-relative { [realPath]: shimPath } object) — a
// real silent-drift risk the audit explicitly flagged: adding, removing,
// or renaming a shim pair in one file with no corresponding update to the
// other would leave the two tools silently disagreeing about which files
// are substituted, with no test catching it. All three pairs were found,
// by real AST import-graph analysis, to still be load-bearing (see
// docs/design/phase-7-lite-shim-reduction-2026-08-02.md for the full
// per-pair dependency-path evidence) — so this phase did not remove any
// substitution, only unified the one declaration both tools now import.
//
// Pure data, zero imports, zero I/O — safe for both a Node ESM script
// (classify-modules.mjs) and a Vite-adjacent build script (build.mjs) to
// import without pulling in any heavier dependency.
export const LAZY_SHIM_SUBSTITUTIONS = Object.freeze([
  Object.freeze({ real: 'core/ollama-lazy.js', shim: 'core/ollama-lazy.lite.js' }),
  Object.freeze({ real: 'core/onnx-embed-lazy.js', shim: 'core/onnx-embed-lazy.lite.js' }),
  Object.freeze({ real: 'indexer/phases/tag-onnx-lazy.js', shim: 'indexer/phases/tag-onnx-lazy.lite.js' }),
]);
