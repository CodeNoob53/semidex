// Locked configuration for the live Slavic Belebele weighted-RRF fusion
// matrix (run-slavic-weighted-rrf.mjs). Every field here is fixed BEFORE
// the live run and must not be tuned post-hoc based on results.
//
// Goal: determine whether sparse/equal-weight RRF regressions correlate
// with individual Slavic languages or script groups — using the SAME six
// fusion modes and rho -> sparseWeight conversion already validated by the
// live SciFact/MIRACL weighted-RRF benchmark
// (../fusion/run-weighted-rrf-live.mjs). The mode list and formula are
// imported from ../fusion/weighted-rrf-fusion-modes.mjs — a small shared
// pure module — so this harness can never silently drift from that
// benchmark's definitions.
//
// Scope, deliberately narrow (same rationale as slavic-profiles.mjs, this
// benchmark's non-weighted sibling): ONLY the local BGE-M3 ONNX
// dense+learned-sparse provider — no Qdrant Cloud E5/BM25 profile. Adding
// a second, different model pair would reintroduce exactly the confound
// this benchmark exists to remove: it isolates the LANGUAGE factor under
// one fixed embedding provider, not a provider factor.
//
// CUDA is an execution ACCELERATOR only, never a retrieval-quality
// variable — see ../fusion/weighted-rrf-cuda.mjs's module header. This
// config file carries no CUDA-specific fields itself; the harness reads
// ONNX_EXECUTION_PROVIDER/ONNX_CUDA_STRICT directly, exactly like
// run-weighted-rrf-live.mjs and run-slavic-benchmark.mjs already do.
import { ONNX_DENSE_MODEL_ID } from '../../../src/core/onnx-paths.js';
import {
  FUSION_MODES, FUSION_MODE_IDS, fusionModeById,
  PRIMARY_CANDIDATE_ID, DIAGNOSTIC_CANDIDATE_ID, EQUAL_RRF_CONTROL_IDS,
} from '../fusion/weighted-rrf-fusion-modes.mjs';

export {
  FUSION_MODES, FUSION_MODE_IDS, fusionModeById,
  PRIMARY_CANDIDATE_ID, DIAGNOSTIC_CANDIDATE_ID, EQUAL_RRF_CONTROL_IDS,
};

// The exact seven-language matrix — identical to slavic-profiles.mjs's
// LANGUAGES, re-declared here (not imported) so this config file has zero
// dependency on the non-weighted benchmark's module and cannot be affected
// by any future change there. Kept byte-for-byte in sync deliberately; a
// dedicated test asserts both LANGUAGES arrays are identical.
export const LANGUAGES = Object.freeze([
  Object.freeze({ code: 'ukr_Cyrl', script: 'Cyrillic', label: 'Ukrainian', group: 'cyrillic' }),
  Object.freeze({ code: 'rus_Cyrl', script: 'Cyrillic', label: 'Russian', group: 'cyrillic' }),
  Object.freeze({ code: 'bul_Cyrl', script: 'Cyrillic', label: 'Bulgarian', group: 'cyrillic' }),
  Object.freeze({ code: 'pol_Latn', script: 'Latin', label: 'Polish', group: 'latin_slavic' }),
  Object.freeze({ code: 'ces_Latn', script: 'Latin', label: 'Czech', group: 'latin_slavic' }),
  Object.freeze({ code: 'slk_Latn', script: 'Latin', label: 'Slovak', group: 'latin_slavic' }),
  Object.freeze({ code: 'eng_Latn', script: 'Latin', label: 'English (control)', group: 'english_control' }),
]);

export const LANGUAGE_CODES = Object.freeze(LANGUAGES.map((l) => l.code));

// Descriptive-only group definitions — the macro-average groupings the
// task requires. Never used to select or promote a fusion candidate; see
// computeGroupSummaries()/classifyLanguageDecisions() in
// run-slavic-weighted-rrf.mjs for the explicit MIXED-unless-consistent
// rule that enforces this.
export const GROUPS = Object.freeze({
  cyrillic: Object.freeze({ id: 'cyrillic', label: 'Cyrillic Slavic', codes: Object.freeze(['ukr_Cyrl', 'rus_Cyrl', 'bul_Cyrl']) }),
  latin_slavic: Object.freeze({ id: 'latin_slavic', label: 'Latin Slavic', codes: Object.freeze(['pol_Latn', 'ces_Latn', 'slk_Latn']) }),
  english_control: Object.freeze({ id: 'english_control', label: 'English control', codes: Object.freeze(['eng_Latn']) }),
});

export function languageByCode(code) {
  const lang = LANGUAGES.find((l) => l.code === code);
  if (!lang) throw new Error(`[slavic-weighted-rrf-config] unknown language code "${code}" — must be one of: ${LANGUAGE_CODES.join(', ')}`);
  return lang;
}

/** Parses a --languages=a,b,c CLI flag value into an ordered, deduplicated,
 * validated list of language defs — preserving LANGUAGES' own canonical
 * order regardless of the order the user listed them in. `value === null`
 * (flag never passed) is the only input that defaults to all languages; an
 * explicit but empty value is rejected rather than silently defaulting to
 * "run everything" — mirrors slavic-profiles.mjs's parseLanguagesFlag()
 * and rrf-sweep-config.mjs's parseScopesFlag() exactly. */
export function parseLanguagesFlag(value) {
  if (value === null || value === undefined) return LANGUAGES;
  const requested = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
  if (requested.size === 0) {
    throw new Error(`[slavic-weighted-rrf-config] --languages was passed with no language codes — this refuses to silently default to running all ${LANGUAGES.length} languages. Omit --languages entirely to run all, or pass explicit codes: ${LANGUAGE_CODES.join(',')}`);
  }
  for (const code of requested) languageByCode(code); // throws on unknown code
  return LANGUAGES.filter((l) => requested.has(l.code));
}

// Locked single provider — BGE-M3 ONNX only, matching slavic-profiles.mjs
// and every other local-provider harness's ONNX_DENSE_MODEL_ID single
// source of truth. The harness adapts `{ code }` language entries into the
// `{ id, provider: { kind } }` shape ../fusion/weighted-rrf-cuda.mjs's
// shared, generic CUDA-verification functions expect (id: language.code,
// provider: PROVIDER) — this config module itself stays free of any
// CUDA-specific shape requirement.
export const PROVIDER = Object.freeze({
  kind: 'local',
  denseModelId: ONNX_DENSE_MODEL_ID,
  denseSize: 1024,
  sparseModelId: 'bge-m3-onnx-lexical', // not a Qdrant-hosted model id — computed locally by onnx-embed.js
});

export const TOP_K = 100;
export const HYBRID_PREFETCH_LIMIT = 200;

export const COLLECTION_PREFIX = 'semidex-slavic-weighted-rrf-';

/** Unique collection name for one language's single indexing pass. */
export function collectionName(langCode, runSuffix) {
  return `${COLLECTION_PREFIX}${langCode}-${runSuffix}`;
}

// Bounded indexing/query safety knobs — matching the existing Slavic/fusion
// harnesses' own bounded batch sizes (never re-tuned here).
export const INDEX_BATCH_SIZE = 24;
export const RSS_TRACK_INTERVAL_MS = 2000;

// ONNX's own tokenizer max_length (see src/local/core/onnx-embed.js) — the
// single, deterministic, model-imposed truncation limit, identical to
// slavic-profiles.mjs's ONNX_MAX_SEQ_LENGTH.
export const ONNX_MAX_SEQ_LENGTH = 8192;

// Smoke mode: tiny deterministic subset (still exercises all six fusion
// modes), writes to a dedicated, separate, never-real path.
export const SMOKE_QUERY_COUNT = 3;
export const SMOKE_CORPUS_SIZE = 10;

export const BENCHMARK_CHECKPOINT_VERSION = 1;
