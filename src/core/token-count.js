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
//    silent over/under-budget mismatch. Routed through an injected
//    `cloudEmbed` capability's own getCloudTokenCounter() (code review
//    fix, Phase 8B Step 6 — this file used to statically import
//    src/cloud/embedding/qdrant-cloud-tokenizer.js directly, a real
//    `shared -> cloud IMPLEMENTATION` edge; see
//    core/embedding-profile/cloud-embedding-capability.js for the
//    contract). TOKEN_COUNT is never consulted for a cloud profile —
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

// Review finding (P1): a bare module-scope Map keyed only on
// `modelId\0localFilesOnly` silently conflated the counter/text caches of
// TWO DIFFERENT `cloudEmbed` capability instances the moment they shared
// a model id — the SECOND composition root constructed in a process (e.g.
// a test harness building two independent capabilities, or any future
// caller that legitimately wants a differently-behaved counter for the
// "same" model id) would never actually call its OWN cloudEmbed at all;
// it would silently receive the FIRST capability's cached counter/results
// instead. Reproduced directly: capability A resolves modelId "x" to
// counter 11, capability B (a distinct instance) resolves the same
// modelId to counter 22 — with the old bare-Map cache, only A's
// getCloudTokenCounter() was ever actually invoked, and B's calls
// silently returned A's counter value.
//
// Fixed by keying the ENTIRE per-model cache (both the counter-closure
// cache and its own per-text result cache) on the `cloudEmbed` object
// reference itself, via a WeakMap: two distinct cloudEmbed instances can
// never observe or share each other's cached state, and an instance that
// becomes unreachable (no other reference held) lets its own cache
// entries be garbage-collected along with it — no manual cache eviction
// needed for capability lifecycle, unlike the bounded/LRU-ish
// _tokenCountCache below (which stays keyed by bare text, since it is
// exclusively the BGE-M3-mode cache — see getTokenCounter()'s own
// 'bge-m3' branch — and was never part of this conflation in the first
// place: BGE-M3 has exactly one tokenizer per process, not one per
// composition root).
const _cloudCapabilityCaches = new WeakMap();

function getCloudCapabilityCache(cloudEmbed) {
  let entry = _cloudCapabilityCaches.get(cloudEmbed);
  if (!entry) {
    entry = { counters: new Map(), texts: new Map() };
    _cloudCapabilityCaches.set(cloudEmbed, entry);
  }
  return entry;
}

// `cloudEmbed` is REQUIRED whenever a caller actually resolves a
// qdrant-cloud mode string — no module-scope default exists here (code
// review, Phase 8B Step 6): every real caller (indexer/run.js,
// admin/register-neutral-routes.js's own defaultCountTokens() where
// relevant) receives its own real CloudEmbeddingCapability from its
// composition root and threads it through explicitly.
async function getCloudTokenCounter(modelId, { localFilesOnly = false, cloudEmbed } = {}) {
  if (!cloudEmbed) {
    throw new Error('token-count.js: no cloudEmbed capability available for a qdrant-cloud token-count mode — pass { cloudEmbed } explicitly.');
  }
  const { counters, texts } = getCloudCapabilityCache(cloudEmbed);
  // Counter-cache key includes localFilesOnly: a prior localFilesOnly:true
  // call that failed (or a differently-scoped counter) must never be
  // returned for a later call that actually needs network access, or vice
  // versa.
  const counterCacheKey = `${modelId}\0${localFilesOnly}`;
  if (counters.has(counterCacheKey)) return counters.get(counterCacheKey);
  const rawCounter = await cloudEmbed.getCloudTokenCounter(modelId, { localFilesOnly });
  const counter = async function cloudCount(text) {
    // Per-text cache lives in the SAME per-cloudEmbed entry as the
    // counter closure above — never the shared, BGE-M3-only
    // _tokenCountCache — so two capabilities can never see each other's
    // cached token counts for a text either, even for the identical
    // model id and text string. Review finding (P1, follow-up): `texts`
    // is a SINGLE Map shared by every counterCacheKey within one
    // capability entry (one CloudEmbeddingCapability can resolve many
    // distinct models/localFilesOnly combinations over its lifetime), so
    // the key must include counterCacheKey too — keying by bare `text`
    // alone let a second model (e.g. MiniLM) silently reuse a first
    // model's (e.g. E5) cached count for the identical text.
    const textCacheKey = `${counterCacheKey}\0${text}`;
    if (texts.has(textCacheKey)) return texts.get(textCacheKey);
    // Simple bounded FIFO eviction, same intent as _tokenCountCache's own
    // entry cap below (avoids unbounded growth over a long-lived
    // process/large indexing run) — a per-char budget isn't tracked here
    // since this cache is scoped to one capability instance already
    // (garbage-collected with it via the outer WeakMap), unlike
    // _tokenCountCache, which is shared process-wide for the entire
    // process lifetime.
    if (texts.size >= TOKEN_COUNT_CACHE_MAX_ENTRIES) {
      const oldest = texts.keys().next().value;
      if (oldest !== undefined) texts.delete(oldest);
    }
    const count = await rawCounter(text);
    texts.set(textCacheKey, count);
    return count;
  };
  counters.set(counterCacheKey, counter);
  return counter;
}

/**
 * Returns a token counter function.
 * mode 'bge-m3': returns async (text) => Promise<number> backed by the real
 *   BGE-M3 tokenizer (core/bge-tokenizer.js).
 * mode 'heuristic': returns sync (text) => number backed by chars/4.
 * mode `qdrant-cloud:<model-id>`: returns async (text) => Promise<number>
 *   backed by that EXACT model's real tokenizer (via the injected
 *   `cloudEmbed` capability) — never BGE-M3, never the heuristic. A
 *   supported-status cloud model with no available tokenizer throws
 *   (cloudEmbed.getCloudTokenCounter()'s own contract) — this is an
 *   intentional fail-fast, never a silent char/4 fallback, since a wrong
 *   token count for a cloud model risks a real over-budget embed request
 *   Qdrant itself would reject.
 * Default: bge-m3.
 *
 * @param {{ mode?: 'bge-m3' | 'heuristic' | string, localFilesOnly?: boolean, cloudEmbed?: import('./embedding-profile/cloud-embedding-capability.js').CloudEmbeddingCapability }} [options]
 *   `cloudEmbed` is required only when `mode` resolves to a
 *   `qdrant-cloud:<model-id>` string — omit it safely for bge-m3/heuristic
 *   modes.
 * @returns {Promise<(text: string) => number | Promise<number>>}
 */
export async function getTokenCounter(options = {}) {
  const mode = options.mode ?? resolveTokenCountMode();
  if (mode.startsWith(QDRANT_CLOUD_TOKEN_MODE_PREFIX)) {
    const modelId = mode.slice(QDRANT_CLOUD_TOKEN_MODE_PREFIX.length);
    return getCloudTokenCounter(modelId, { localFilesOnly: options.localFilesOnly, cloudEmbed: options.cloudEmbed });
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
