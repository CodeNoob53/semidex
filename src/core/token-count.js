// Token counting for chunk sizing. Two independent counter families:
//
//  - LOCAL profiles (Ollama/BGE-M3-ONNX/no profile at all — e.g. Ask
//    prompt-context budgeting, which is a SEPARATE concern from embedding-
//    input budgeting and never touches this profile-aware branch): real
//    BGE-M3 tokenizer (tokenizer files only, no ONNX inference session),
//    backed by @huggingface/tokenizers via core/bge-tokenizer.js — never
//    @huggingface/transformers, which bundles its own ONNX Runtime build
//    and must not load in a process that may also load the custom
//    CUDA-enabled onnxruntime-node build (duplicate ORT backend
//    registration risk). TOKEN_COUNT=heuristic is an explicit fast
//    fallback for this family.
//  - CLOUD (qdrant-cloud execution) profiles: the tokenizer is NOT a
//    choice — it is dictated entirely by the active dense model, since a
//    Qdrant Cloud Inference model tokenizes its own input server-side, and
//    Semidex must count tokens the SAME way that model will to avoid a
//    silent over/under-budget mismatch. Routed through
//    core/embedding-profile/qdrant-cloud-tokenizer.js's
//    loadQdrantCloudTokenizer()/qdrantCloudTokenCount() — imported
//    directly (not via qdrant-cloud-catalog.js, which itself imports
//    heuristicTokenCount FROM this file; importing back from it here would
//    be circular). TOKEN_COUNT is never consulted for a cloud profile —
//    there is no bge-m3/heuristic choice to make.
//
// Previously, resolveTokenCountMode()/getTokenCounter() were completely
// profile-blind and unconditionally defaulted to BGE-M3 regardless of the
// active embedding backend — a live Qdrant Cloud (E5) collection reported
// `token count mode: bge-m3` in the Admin UI even though BGE-M3 was never
// actually loaded for its chunking decisions (chunk.js's own
// budget-aware branch already used the correct per-model cloud tokenizer
// for SPLITTING, just not for the REPORTED mode string). Fixed by making
// both functions profile-aware.

import { loadBgeTokenizer, bgeTokenCount } from './bge-tokenizer.js';
import { loadQdrantCloudTokenizer, qdrantCloudTokenCount } from './embedding-profile/qdrant-cloud-tokenizer.js';
import { EXECUTION } from './embedding-profile/schema.js';

export const CHUNKING_SCHEMA_VERSION = 4;

// Prefix for the model-scoped mode identity a cloud profile resolves to —
// e.g. "qdrant-cloud:intfloat/multilingual-e5-small". Exported so callers
// that need to test/pattern-match a resolved mode string (not just pass
// one through) don't have to duplicate the literal.
export const QDRANT_CLOUD_TOKEN_MODE_PREFIX = 'qdrant-cloud:';

// ── heuristic (sync, always available) ────────────────────────────────────

export function heuristicTokenCount(text) {
  return Math.ceil(text.length / 4);
}

// ── real BGE-M3 tokenizer (async, production default) ──────────────────────

const TOKEN_COUNT_CACHE_MAX_ENTRIES = 4096;
const TOKEN_COUNT_CACHE_MAX_CHARS = 2_000_000;
const _tokenCountCache = new Map();
let _tokenCountCacheChars = 0;

function cacheTokenCount(text, count) {
  if (text.length > TOKEN_COUNT_CACHE_MAX_CHARS) return;
  while (
    _tokenCountCache.size >= TOKEN_COUNT_CACHE_MAX_ENTRIES ||
    _tokenCountCacheChars + text.length > TOKEN_COUNT_CACHE_MAX_CHARS
  ) {
    const oldest = _tokenCountCache.keys().next().value;
    if (oldest === undefined) break;
    _tokenCountCacheChars -= oldest.length;
    _tokenCountCache.delete(oldest);
  }
  _tokenCountCache.set(text, count);
  _tokenCountCacheChars += text.length;
}

async function getTokenizer({ localFilesOnly = false } = {}) {
  try {
    return await loadBgeTokenizer({ localFilesOnly });
  } catch (err) {
    const prefix = localFilesOnly
      ? 'BGE-M3 tokenizer not cached locally.'
      : 'Unable to load BGE-M3 tokenizer.';
    throw new Error(
      `${prefix} Check network/cache access or set TOKEN_COUNT=heuristic. ` +
      `(Original error: ${err.message})`
    );
  }
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Resolves the token-counting MODE identity — not just an env read anymore.
 * A qdrant-cloud-execution profile has no bge-m3/heuristic choice at all:
 * the tokenizer is dictated by the active dense model, so TOKEN_COUNT is
 * never consulted for one, and this always returns
 * `qdrant-cloud:<dense-model-id>` instead. Every other profile shape
 * (client execution — Ollama/BGE-M3-ONNX — or no profile passed at all,
 * e.g. Ask prompt-context budgeting, which is a SEPARATE concern from
 * embedding-input budgeting) falls back to the original env-only behavior,
 * byte-identical to before this function became profile-aware.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Object|null} [profile] — a resolved embedding profile (or null/omitted for the pre-existing env-only behavior)
 * @returns {string} 'bge-m3' | 'heuristic' | `qdrant-cloud:${modelId}`
 */
export function resolveTokenCountMode(env = process.env, profile = null) {
  if (profile?.embedding?.dense?.execution === EXECUTION.QDRANT_CLOUD) {
    return `${QDRANT_CLOUD_TOKEN_MODE_PREFIX}${profile.embedding.dense.model}`;
  }
  const mode = (env.TOKEN_COUNT ?? 'bge-m3').trim().toLowerCase();
  if (mode === 'bge-m3' || mode === 'heuristic') return mode;
  throw new Error(
    `Unsupported TOKEN_COUNT="${env.TOKEN_COUNT}". Use "bge-m3" or "heuristic".`
  );
}

// Per-model-id cloud tokenizer cache — mirrors _tokenCountCache's own
// per-text cache below (both are safe to share across calls within one
// process: a tokenizer's own encode() result for a given model+text pair
// never changes mid-process). Keyed by dense model id, not by the full
// `qdrant-cloud:<id>` mode string, since loadQdrantCloudTokenizer() itself
// already caches per model id internally — this second cache just avoids
// re-deriving the counter closure on every getTokenCounter() call.
const _cloudCounterCache = new Map();

async function getCloudTokenCounter(modelId, { localFilesOnly = false } = {}) {
  // Counter-cache key includes localFilesOnly: a prior localFilesOnly:true
  // call that failed (or a differently-scoped counter) must never be
  // returned for a later call that actually needs network access, or vice
  // versa.
  const counterCacheKey = `${modelId}\0${localFilesOnly}`;
  if (_cloudCounterCache.has(counterCacheKey)) return _cloudCounterCache.get(counterCacheKey);
  const tok = await loadQdrantCloudTokenizer(modelId, { localFilesOnly });
  const counter = async function cloudCount(text) {
    // NUL (\0) can never appear in real indexed text or a model id --
    // using it as the join separator guarantees this per-TEXT cache key
    // can never collide with a plain BGE-M3-mode entry (which keys
    // directly on `text`, no prefix at all).
    const textCacheKey = `${modelId}\0${text}`;
    if (_tokenCountCache.has(textCacheKey)) return _tokenCountCache.get(textCacheKey);
    const count = qdrantCloudTokenCount(tok, text);
    cacheTokenCount(textCacheKey, count);
    return count;
  };
  _cloudCounterCache.set(counterCacheKey, counter);
  return counter;
}

/**
 * Returns a token counter function.
 * mode 'bge-m3': returns async (text) => Promise<number> backed by the real
 *   BGE-M3 tokenizer (core/bge-tokenizer.js).
 * mode 'heuristic': returns sync (text) => number backed by chars/4.
 * mode `qdrant-cloud:<model-id>`: returns async (text) => Promise<number>
 *   backed by that EXACT model's real tokenizer
 *   (embedding-profile/qdrant-cloud-tokenizer.js) — never BGE-M3, never
 *   the heuristic. A supported-status cloud model with no available
 *   tokenizer throws (loadQdrantCloudTokenizer's own contract) — this is
 *   an intentional fail-fast, never a silent char/4 fallback, since a
 *   wrong token count for a cloud model risks a real over-budget embed
 *   request Qdrant itself would reject.
 * Default: bge-m3.
 *
 * @param {{ mode?: 'bge-m3' | 'heuristic' | string, localFilesOnly?: boolean }} [options]
 * @returns {Promise<(text: string) => number | Promise<number>>}
 */
export async function getTokenCounter(options = {}) {
  const mode = options.mode ?? resolveTokenCountMode();
  if (mode.startsWith(QDRANT_CLOUD_TOKEN_MODE_PREFIX)) {
    const modelId = mode.slice(QDRANT_CLOUD_TOKEN_MODE_PREFIX.length);
    return getCloudTokenCounter(modelId, { localFilesOnly: options.localFilesOnly });
  }
  if (mode !== 'bge-m3') return heuristicTokenCount;

  const tok = await getTokenizer({ localFilesOnly: options.localFilesOnly });
  return async function bgeCount(text) {
    if (_tokenCountCache.has(text)) return _tokenCountCache.get(text);
    const count = bgeTokenCount(tok, text);
    cacheTokenCount(text, count);
    return count;
  };
}

/**
 * Count real BGE-M3 tokens for a single text.
 * options.mode 'bge-m3' or omitted: real tokenizer count.
 * options.mode 'heuristic': Math.ceil(text.length / 4) (sync-wrapped).
 *
 * @param {string} text
 * @param {{ mode?: 'bge-m3' | 'heuristic', localFilesOnly?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function countTokens(text, options = {}) {
  const counter = await getTokenCounter(options);
  return counter(text);
}

/**
 * Return the suffix of text that fits within maxTokens real BGE-M3 tokens.
 * Used for token-based overlap: takeLastTokens(prevChunk, OVERLAP_TOKENS).
 *
 * Implementation: binary search on character boundaries, each probe decodes
 * the suffix. For heuristic mode: Math.ceil(suffix.length / 4) <= maxTokens.
 * For bge-m3 mode: real tokenizer count.
 *
 * Note: this is correct but O(n log n) in worst case. Suitable for overlap
 * sizing at indexing time; not recommended for hot paths on very long texts.
 *
 * @param {string} text
 * @param {number} maxTokens
 * @param {{ mode?: 'bge-m3' | 'heuristic', localFilesOnly?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function takeLastTokens(text, maxTokens, options = {}) {
  if (!text || maxTokens <= 0) return '';
  const counter = await getTokenCounter(options);
  const fullCount = await counter(text);
  if (fullCount <= maxTokens) return text;

  // Binary search: find the smallest char offset from the end such that
  // the suffix starting there has token count <= maxTokens.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const suffix = text.slice(mid);
    const count = await counter(suffix);
    if (count <= maxTokens) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return text.slice(lo);
}
