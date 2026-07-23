// Locked configuration for the Slavic dense-vs-sparse benchmark
// (run-slavic-benchmark.mjs), built on mteb/belebele (see
// fetch-belebele.mjs's module header for the full dataset contract).
//
// Scope, deliberately narrow for this first run (per the task's explicit
// "isolate the language factor" goal): ONLY the local BGE-M3 ONNX
// dense+learned-sparse provider, ONLY one fixed equal-RRF hybrid mode
// (k=60, Semidex's own production default — no k-sweep here, that
// question is already covered by benchmarks/external/fusion/). No Qdrant
// Cloud E5/BM25 profile — adding a second, different model pair would
// reintroduce exactly the confound this benchmark exists to remove.
import { ONNX_DENSE_MODEL_ID } from '../../../src/core/onnx-paths.js';

// The final, user-decided language matrix (see README.md's "Language
// matrix and why" section for the full decision trail — bel_Cyrl and
// srp_Latn were investigated and confirmed absent from Belebele/
// FLORES-200 before this list was finalized; they are not silently
// substituted).
export const LANGUAGES = Object.freeze([
  Object.freeze({ code: 'ukr_Cyrl', script: 'Cyrillic', label: 'Ukrainian' }),
  Object.freeze({ code: 'rus_Cyrl', script: 'Cyrillic', label: 'Russian' }),
  Object.freeze({ code: 'bul_Cyrl', script: 'Cyrillic', label: 'Bulgarian' }),
  Object.freeze({ code: 'pol_Latn', script: 'Latin', label: 'Polish' }),
  Object.freeze({ code: 'ces_Latn', script: 'Latin', label: 'Czech' }),
  Object.freeze({ code: 'slk_Latn', script: 'Latin', label: 'Slovak' }),
  Object.freeze({ code: 'eng_Latn', script: 'Latin', label: 'English (control)' }),
]);

export const LANGUAGE_CODES = Object.freeze(LANGUAGES.map((l) => l.code));

// Reserved for a later, explicitly separate expanded run — not part of
// this benchmark's scope, listed here only so a future task can find them
// without re-doing the same dataset-availability investigation. Never
// silently added to LANGUAGES above.
export const RESERVED_FOR_LATER_EXPANSION = Object.freeze([
  Object.freeze({ code: 'mkd_Cyrl', script: 'Cyrillic', label: 'Macedonian' }),
  Object.freeze({ code: 'srp_Cyrl', script: 'Cyrillic', label: 'Serbian (Cyrillic)' }),
  Object.freeze({ code: 'hrv_Latn', script: 'Latin', label: 'Croatian' }),
  Object.freeze({ code: 'slv_Latn', script: 'Latin', label: 'Slovenian' }),
]);

// Confirmed unavailable in Belebele/FLORES-200 — documented, never
// substituted silently. See README.md for the verification trail.
export const CONFIRMED_UNAVAILABLE = Object.freeze([
  Object.freeze({ code: 'bel_Cyrl', label: 'Belarusian', reason: 'Not present in FLORES-200 (Belebele\'s source corpus) at all — no config exists for any script.' }),
  Object.freeze({ code: 'srp_Latn', label: 'Serbian (Latin)', reason: 'Only srp_Cyrl exists in Belebele; no Latin-script Serbian config is present, even though Serbian is genuinely digraphic in real-world use.' }),
]);

export function languageByCode(code) {
  const lang = LANGUAGES.find((l) => l.code === code);
  if (!lang) throw new Error(`[slavic-profiles] unknown language code "${code}" — must be one of: ${LANGUAGE_CODES.join(', ')}`);
  return lang;
}

/** Parses a --languages=a,b,c CLI flag value into an ordered, deduplicated,
 * validated list of language defs — preserving LANGUAGES' own canonical
 * order regardless of the order the user listed them in. `value === null`
 * (flag never passed) is the only input that defaults to all languages; an
 * explicit but empty value is rejected rather than silently defaulting to
 * "run everything" — same rationale as rrf-sweep-config.mjs's
 * parseScopesFlag(), which this deliberately mirrors after that module's
 * own review-driven fix. */
export function parseLanguagesFlag(value) {
  if (value === null || value === undefined) return LANGUAGES;
  const requested = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
  if (requested.size === 0) {
    throw new Error(`[slavic-profiles] --languages was passed with no language codes — this refuses to silently default to running all ${LANGUAGES.length} languages. Omit --languages entirely to run all, or pass explicit codes: ${LANGUAGE_CODES.join(',')}`);
  }
  for (const code of requested) languageByCode(code); // throws on unknown code
  return LANGUAGES.filter((l) => requested.has(l.code));
}

// Locked single provider — BGE-M3 ONNX only, matching the ONNX_DENSE_MODEL_ID
// single source of truth already used across every other benchmark harness.
export const PROVIDER = Object.freeze({
  kind: 'local',
  denseModelId: ONNX_DENSE_MODEL_ID,
  denseSize: 1024,
  sparseModelId: 'bge-m3-onnx-lexical', // not a Qdrant-hosted model id — computed locally by onnx-embed.js
});

// Single fixed hybrid mode — Semidex's own production RRF_K default. No
// sweep, no k=2 alternative: this benchmark isolates the LANGUAGE factor,
// not the fusion-constant factor (already covered by
// benchmarks/external/fusion/run-rrf-sweep.mjs).
export const RRF_K = 60;

export const TOP_K = 100;
export const HYBRID_PREFETCH_LIMIT = 200;

export const COLLECTION_PREFIX = 'semidex-slavic-belebele-';

/** Unique collection name for one language's single indexing pass. */
export function collectionName(langCode, runSuffix) {
  return `${COLLECTION_PREFIX}${langCode}-${runSuffix}`;
}

// Bounded indexing/query safety knobs — matching the existing BEIR/MIRACL/
// fusion harnesses' own bounded batch sizes (never re-tuned here).
export const INDEX_BATCH_SIZE = 24;
export const RSS_TRACK_INTERVAL_MS = 2000;

// ONNX's own tokenizer max_length (see src/core/onnx-embed.js) — the
// single, deterministic, model-imposed truncation limit applied
// IDENTICALLY to every language in this benchmark. This harness never
// tunes a per-language token budget; it only DETECTS and COUNTS how many
// documents/queries exceed this limit per language, for reporting.
export const ONNX_MAX_SEQ_LENGTH = 8192;

// Smoke mode: tiny deterministic subset (still exercises dense+sparse+
// hybrid), writes to a dedicated, separate, never-real path.
export const SMOKE_QUERY_COUNT = 3;
export const SMOKE_CORPUS_SIZE = 10;

export const BENCHMARK_CHECKPOINT_VERSION = 1;
