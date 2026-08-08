// Semidex Lite settings policy — pure data, no I/O. The single source of
// truth for which definitions.js keys a cloud-only Lite deployment may
// read/write through the Settings API. Anything not listed here is
// rejected (see settings-service.lite.js), never silently accepted or
// silently dropped.
//
// Phase 5 (docs/design/full-lite-shared-architecture-audit-2026-08-01.md
// §9.2/§11): LITE_SETTINGS_KEYS used to be the only artifact here — adding a
// new key to DEFINITIONS required no corresponding decision about Lite at
// all (an omission from LITE_SETTINGS_KEYS silently meant "excluded," which
// is runtime-safe but gives an author no signal that a decision is even
// being made). LITE_SETTINGS_POLICY below is now the canonical, exhaustive
// classification: every single key in DEFINITIONS must appear here with an
// explicit exposure status. tests/unit/core/settings-lite-policy-completeness.test.js
// enforces this against the real DEFINITIONS object — a new definition with
// no matching policy entry fails that test, forcing the author to make the
// Lite-exposure decision explicitly rather than by omission.
//
// LITE_SETTINGS_KEYS/LITE_SETTINGS_KEY_SET/isLiteSettingsKey() below are
// mechanically DERIVED from LITE_SETTINGS_POLICY (every 'exposed' key, in
// policy-declaration order) — a real, single-source-of-truth derivation,
// not a second hand-maintained list. This is why the 'exposed' entries are
// declared FIRST below, in their original (pre-Phase-5) order, followed by
// the 'excluded' entries grouped by category for readability — declaration
// order IS the exported array's order (code review finding: an earlier
// version instead added a second, separately-declared LITE_EXPOSED_KEY_ORDER
// array specifically to pin this order, which reintroduced exactly the
// two-sources-of-truth problem this phase exists to eliminate; fixed by
// ordering the canonical policy itself instead of adding a second list).
// Their own public API/shape is otherwise unchanged, so
// settings-service.lite.js (the only real runtime consumer) needs no
// changes at all. This satisfies the "LITE_SETTINGS_KEYS must remain the
// canonical list ... or be mechanically derived from the canonical policy
// without changing its public API" requirement.
//
// Every 'excluded' entry carries a `reason` — documentation/test metadata
// only, consulted by the completeness test (a real, recognized reason is
// required) and available to any future doc-generation tooling. Reasons
// are NOT read by settings-service.lite.js or any other runtime code —
// LITE_SETTINGS_KEY_SET membership is the only thing that gates a read/
// write, exactly as before this phase.
export const LITE_EXCLUSION_REASONS = Object.freeze({
  LOCAL_RUNTIME: 'local_runtime', // local ONNX/Ollama engine, process, or hardware-execution concept — no meaning for a cloud-only deployment
  LOCAL_MODEL: 'local_model', // a specific local (ONNX/Ollama) model identifier or model-adjacent choice
  FULL_ONLY: 'full_only', // a Full-Semidex-only concept with no Lite equivalent at all
  UNSUPPORTED_BACKEND: 'unsupported_backend', // names a backend/feature Lite's cloud-only build does not implement (e.g. local tag generation, cross-encoder reranking)
  ADVANCED_TUNING: 'advanced_tuning', // backend-agnostic chunking/retrieval tuning surface, out of scope for Lite's minimal cloud surface — additive to expose later, never a correctness requirement
});

const REASON_VALUES = new Set(Object.values(LITE_EXCLUSION_REASONS));

// Frozen entries — code review finding (P2): Object.freeze() on the outer
// LITE_SETTINGS_POLICY object only prevents reassigning/adding/removing
// its own top-level keys; each { status, reason } entry is a separate
// object and stayed mutable, so e.g. LITE_SETTINGS_POLICY.QDRANT_URL.status
// could be reassigned at runtime, silently diverging from the already-
// derived LITE_SETTINGS_KEYS below (computed once, at module-load time,
// from the pre-mutation values). Freezing each entry here closes that gap
// — see the "immutability" describe block in
// tests/unit/core/settings-lite-policy-completeness.test.js.
function exposed() {
  return Object.freeze({ status: 'exposed' });
}

function excluded(reason) {
  if (!REASON_VALUES.has(reason)) {
    throw new Error(`lite-policy.js: unrecognized exclusion reason "${reason}" — must be one of LITE_EXCLUSION_REASONS.`);
  }
  return Object.freeze({ status: 'excluded', reason });
}

const { LOCAL_RUNTIME, LOCAL_MODEL, UNSUPPORTED_BACKEND, ADVANCED_TUNING } = LITE_EXCLUSION_REASONS;

// Exhaustive: every key in src/core/settings/definitions.js's DEFINITIONS
// must appear exactly once below. tests/unit/core/settings-lite-policy-completeness.test.js
// proves this against the real, live DEFINITIONS object — not merely
// documented here.
//
// Declaration order matters: LITE_SETTINGS_KEYS below is derived via
// Object.entries(LITE_SETTINGS_POLICY).filter(exposed), so the 'exposed'
// entries are declared FIRST, in the exact order the original (pre-Phase-5)
// hand-maintained LITE_SETTINGS_KEYS array used — do not reorder them
// without updating the exact-order regression test in
// tests/unit/core/settings-lite-policy-completeness.test.js.
export const LITE_SETTINGS_POLICY = Object.freeze({
  // ── exposed (Lite Settings API surface) — order pinned to match the
  // original pre-Phase-5 LITE_SETTINGS_KEYS array exactly.
  QDRANT_URL: exposed(),
  QDRANT_KEY: exposed(),
  QDRANT_CLOUD_DENSE_MODEL: exposed(),
  QDRANT_SPARSE_MODEL: exposed(),
  EMBEDDING_BACKEND: exposed(),
  DENSE_PROVIDER: exposed(),
  SPARSE_PROVIDER: exposed(),
  VECTOR_SIZE: exposed(),
  SEMIDEX_GENERATION_BACKEND: exposed(),
  ASK_MODEL: exposed(),
  ASK_NUM_CTX: exposed(),
  GEMINI_API_KEY: exposed(),
  CONTEXT_MODE: exposed(),
  SEMIDEX_STORAGE_BACKEND: exposed(),
  ADMIN_HOST: exposed(),
  ADMIN_PORT: exposed(),
  ADMIN_ALLOW_REMOTE: exposed(),
  HYBRID_PREFETCH_LIMIT: exposed(),
  RRF_K: exposed(),

  // ── excluded — grouped by category for readability; order here has no
  // exported meaning (only the 'exposed' block above's order is pinned).

  // indexing (chunking + skeleton) — advanced tuning, out of Lite's
  // minimal cloud surface for now; backend-agnostic, safe to expose later.
  MAX_CHUNK_TOKENS: excluded(ADVANCED_TUNING),
  MIN_CHUNK_TOKENS: excluded(ADVANCED_TUNING),
  CHUNK_OVERLAP_TOKENS: excluded(ADVANCED_TUNING),
  OVERLAP_SENTENCES: excluded(ADVANCED_TUNING),
  LLM_BATCH_SIZE: excluded(ADVANCED_TUNING),
  SKELETON_SUMMARY: excluded(ADVANCED_TUNING),
  SKELETON_CARRYOVER_CHARS: excluded(ADVANCED_TUNING),
  SUMMARY_LANG: excluded(ADVANCED_TUNING),

  // ai (tagging) — Lite's cloud-only build implements no tag-generation
  // backend at all (both Ollama and ONNX tagging are local-inference
  // concepts); TAG_GEN itself is excluded because there is no supported
  // provider for it to select between in Lite.
  TAG_GEN: excluded(UNSUPPORTED_BACKEND),
  TAG_PROVIDER: excluded(UNSUPPORTED_BACKEND),
  TAG_MODEL: excluded(LOCAL_MODEL),
  TAG_ONNX_MODEL: excluded(LOCAL_MODEL),
  TAG_ONNX_THREADS: excluded(LOCAL_RUNTIME),
  TAG_ONNX_ALLOW_DOWNLOAD: excluded(LOCAL_RUNTIME),

  // ai (generation) — OLLAMA_URL/GENERATION_DEVICE/CONTEXT_MODEL are
  // Ollama-only concepts; COMBINED_LLM is advanced indexing tuning.
  // GENERATION_DEVICE_OVERRIDE is a fallback for the device-aware bounded
  // indexing pipeline's Ollama VRAM-placement scheduling signal — Lite
  // has no local Ollama runtime for this to describe at all.
  OLLAMA_URL: excluded(LOCAL_RUNTIME),
  GENERATION_DEVICE: excluded(LOCAL_RUNTIME),
  GENERATION_DEVICE_OVERRIDE: excluded(LOCAL_RUNTIME),
  CONTEXT_MODEL: excluded(LOCAL_MODEL),
  COMBINED_LLM: excluded(ADVANCED_TUNING),

  // embeddings & hardware
  EMBED_MODEL: excluded(LOCAL_MODEL),
  DENSE_MODEL: excluded(LOCAL_MODEL),
  ONNX_EXECUTION_PROVIDER: excluded(LOCAL_RUNTIME),
  ONNX_BATCH_SIZE: excluded(LOCAL_RUNTIME),
  ONNX_CUDA_STRICT: excluded(LOCAL_RUNTIME),
  ONNXRUNTIME_NODE_PATH: excluded(LOCAL_RUNTIME),
  ONNX_MANAGED_RUNTIME: excluded(LOCAL_RUNTIME),
  // Cloud-native display rows (tokenizer identity/context window derived
  // from the selected Qdrant Cloud dense model) — NOT local-runtime- or
  // local-model-coupled, but not yet part of Lite's Settings API surface
  // either; kept excluded to match today's actual, tested LITE_SETTINGS_KEYS
  // contents exactly (this phase is an architectural guard, not a feature
  // change — see the Known limitations section of
  // docs/design/phase-5-lite-settings-policy-completeness-2026-08-02.md).
  // Expanding Lite's Settings API to include these is a real, additive,
  // low-risk future candidate, not a correctness requirement of this phase.
  QDRANT_CLOUD_TOKENIZER: excluded(ADVANCED_TUNING),
  QDRANT_CLOUD_DENSE_CONTEXT_WINDOW: excluded(ADVANCED_TUNING),

  // retrieval & ranking — deterministic rerank and cross-encoder rerank
  // are both out of Lite's minimal cloud surface: RERANK_ENABLED's own
  // boost/penalty tuning is advanced_tuning; the whole RERANK_CE_* family
  // is a local-inference feature Lite's cloud-only build does not
  // implement at all (unsupported_backend for the on/off switch and
  // behavior knobs, local_runtime for the hardware/cache-path knobs,
  // local_model for the model identifier). HYBRID_PREFETCH_LIMIT/RRF_K
  // are exposed above, not here — see their own note in the exposed block.
  RERANK_ENABLED: excluded(ADVANCED_TUNING),
  RERANK_CE_ENABLED: excluded(UNSUPPORTED_BACKEND),
  RERANK_PREFETCH_MULT: excluded(ADVANCED_TUNING),
  RERANK_BOOST_SOURCE_FILE: excluded(ADVANCED_TUNING),
  RERANK_BOOST_SECTION: excluded(ADVANCED_TUNING),
  RERANK_BOOST_TAGS: excluded(ADVANCED_TUNING),
  RERANK_BOOST_TEXT: excluded(ADVANCED_TUNING),
  RERANK_BASE_WEIGHT: excluded(ADVANCED_TUNING),
  RERANK_PROTECT_TOP1_DELTA: excluded(ADVANCED_TUNING),
  RERANK_BOOST_TEXT_LEAD: excluded(ADVANCED_TUNING),
  RERANK_TEXT_LEAD_CHARS: excluded(ADVANCED_TUNING),
  RERANK_PENALTY_INTRO_CHUNK: excluded(ADVANCED_TUNING),
  RERANK_INTRO_CHUNK_TECH_MIN: excluded(ADVANCED_TUNING),
  RERANK_CE_MODEL: excluded(LOCAL_MODEL),
  RERANK_CE_DEVICE: excluded(LOCAL_RUNTIME),
  RERANK_CE_CACHE_DIR: excluded(LOCAL_RUNTIME),
  RERANK_CE_WARMUP: excluded(LOCAL_RUNTIME),
  RERANK_CE_INPUT: excluded(UNSUPPORTED_BACKEND),
  RERANK_CE_TOP_N: excluded(UNSUPPORTED_BACKEND),
  RERANK_CE_TIMEOUT_MS: excluded(UNSUPPORTED_BACKEND),
  RERANK_CE_BATCH_SIZE: excluded(UNSUPPORTED_BACKEND),

  // system & diagnostics
  TOKEN_COUNT: excluded(ADVANCED_TUNING),
});

// Mechanically derived from LITE_SETTINGS_POLICY — a real single-source-
// of-truth derivation, not a second hand-maintained list. Order matches
// LITE_SETTINGS_POLICY's own declaration order for 'exposed' entries
// (Object.keys() order for a plain object with only string keys is
// insertion order, per the ES spec) — which is why the 'exposed' entries
// are declared first, in the pinned original order, above.
export const LITE_SETTINGS_KEYS = Object.freeze(
  Object.entries(LITE_SETTINGS_POLICY)
    .filter(([, entry]) => entry.status === 'exposed')
    .map(([key]) => key),
);

export const LITE_SETTINGS_KEY_SET = new Set(LITE_SETTINGS_KEYS);

export function isLiteSettingsKey(key) {
  return LITE_SETTINGS_KEY_SET.has(key);
}
