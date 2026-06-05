// Token counting for BGE-M3 chunking.
// Production default: real BGE-M3 AutoTokenizer (tokenizer files only, no ONNX
// inference session). TOKEN_COUNT=heuristic is an explicit fast fallback.

import { mkdirSync } from 'fs';
import { ONNX_CACHE_DIR } from './onnx-paths.js';

const MODEL_ID = 'aapot/bge-m3-onnx';
export const CHUNKING_SCHEMA_VERSION = 2;

// ── heuristic (sync, always available) ────────────────────────────────────

export function heuristicTokenCount(text) {
  return Math.ceil(text.length / 4);
}

// ── real BGE-M3 tokenizer (async, production default) ──────────────────────

let _tokenizer = null;
let _tokenizerPromise = null;
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

async function loadBgeTokenizer({ localFilesOnly = false } = {}) {
  if (_tokenizer) return _tokenizer;
  if (_tokenizerPromise) return _tokenizerPromise;

  mkdirSync(ONNX_CACHE_DIR, { recursive: true });
  _tokenizerPromise = (async () => {
    const { env, AutoTokenizer } = await import('@huggingface/transformers');
    env.cacheDir = ONNX_CACHE_DIR;
    _tokenizer = await AutoTokenizer.from_pretrained(
      MODEL_ID,
      { local_files_only: localFilesOnly }
    );
    return _tokenizer;
  })();

  try {
    return await _tokenizerPromise;
  } catch (err) {
    _tokenizerPromise = null;
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

export function resolveTokenCountMode(env = process.env) {
  const mode = (env.TOKEN_COUNT ?? 'bge-m3').trim().toLowerCase();
  if (mode === 'bge-m3' || mode === 'heuristic') return mode;
  throw new Error(
    `Unsupported TOKEN_COUNT="${env.TOKEN_COUNT}". Use "bge-m3" or "heuristic".`
  );
}

/**
 * Returns a token counter function.
 * mode 'bge-m3': returns async (text) => Promise<number> backed by AutoTokenizer.
 * mode 'heuristic': returns sync (text) => number backed by chars/4.
 * Default: bge-m3.
 *
 * @param {{ mode?: 'bge-m3' | 'heuristic', localFilesOnly?: boolean }} [options]
 * @returns {Promise<(text: string) => number | Promise<number>>}
 */
export async function getTokenCounter(options = {}) {
  const mode = options.mode ?? resolveTokenCountMode();
  if (mode !== 'bge-m3') return heuristicTokenCount;

  const tok = await loadBgeTokenizer({ localFilesOnly: options.localFilesOnly });
  return async function bgeCount(text) {
    if (_tokenCountCache.has(text)) return _tokenCountCache.get(text);
    const encoded = await tok(text, { padding: false, truncation: false });
    const count = encoded.input_ids.dims[1];
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
