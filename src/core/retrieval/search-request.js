// Shared search request validation + window expansion — the ONE
// implementation both the Admin dashboard's POST /api/search
// (src/shared/admin/api/search.js) and the public Integration
// POST /api/v1/search (src/core/search-api/v1/route.js) use, so the two
// surfaces can never quietly drift on bounds, defaults, or window semantics.
// No HTTP concerns here beyond throwing the shared HttpError helpers
// (badRequest) — no versioned wire contract, no audience/auth knowledge.
import { badRequest } from '../http/http.js';

export const TOP_DEFAULT = 3;
export const TOP_MIN = 1;
export const TOP_MAX = 20;
export const WINDOW_MIN = 0;
export const WINDOW_MAX = 5;
export const WINDOW_FORMATS = ['compact', 'full'];
export const SNIPPET_CHARS = 150;

// ── Body validation ───────────────────────────────────────────────────────────
// Body fields (not query params), so query-params.js helpers don't apply.
// Same philosophy though: reject, never guess.

function requireStringField(body, name) {
  const v = body[name];
  if (typeof v !== 'string' || v.trim() === '') {
    throw badRequest(`Body field "${name}" is required and must be a non-empty string`);
  }
  return v;
}

function optionalStringField(body, name) {
  const v = body[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.trim() === '') {
    throw badRequest(`Body field "${name}" must be a non-empty string when provided`);
  }
  return v;
}

function optionalIntField(body, name, { defaultValue, min, max }) {
  const v = body[name];
  if (v === undefined || v === null) return defaultValue;
  if (!Number.isInteger(v)) {
    throw badRequest(`Body field "${name}" must be an integer, got ${JSON.stringify(v)}`);
  }
  if (v < min || v > max) {
    throw badRequest(`Body field "${name}" must be between ${min} and ${max}, got ${v}`);
  }
  return v;
}

function optionalTagsField(body) {
  const v = body.tags;
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length === 0 || v.some(t => typeof t !== 'string' || t.trim() === '')) {
    throw badRequest('Body field "tags" must be a non-empty array of non-empty strings when provided');
  }
  return v;
}

/**
 * Parses and validates a search request body. Identical semantics for the
 * Admin dashboard's /api/search and the public /api/v1/search — this is the
 * single implementation both build on, so bounds/defaults/window rules can
 * never quietly diverge between the two surfaces.
 * @param {unknown} body
 * @returns {{ collection: string, query: string, top: number, window: number, windowFormat: 'compact'|'full'|null, sourceFile: string|null, tags: string[]|null }}
 * @throws {import('../http/http.js').HttpError} 400 bad_request
 */
export function parseSearchRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  const collection = requireStringField(body, 'collection');
  const query = requireStringField(body, 'query');
  const top = optionalIntField(body, 'top', { defaultValue: TOP_DEFAULT, min: TOP_MIN, max: TOP_MAX });
  const window = optionalIntField(body, 'window', { defaultValue: 0, min: WINDOW_MIN, max: WINDOW_MAX });

  let windowFormat = body.windowFormat ?? null;
  if (windowFormat !== null && !WINDOW_FORMATS.includes(windowFormat)) {
    throw badRequest(`Body field "windowFormat" must be one of: ${WINDOW_FORMATS.join(', ')}`);
  }
  // windowFormat is meaningful only with a window; normalise so the response
  // never implies a format was applied to a window that doesn't exist.
  windowFormat = window > 0 ? (windowFormat ?? 'compact') : null;

  const sourceFile = optionalStringField(body, 'sourceFile');
  const tags = optionalTagsField(body);

  return { collection, query, top, window, windowFormat, sourceFile, tags };
}

// ── Window expansion (domain shapes only) ────────────────────────────────────
// Mirrors the MCP compact/full window semantics — matched chunk always kept,
// duplicate neighbors across results emitted once, compact snippets capped —
// but implemented on adapter Chunk objects, not Qdrant payloads.

export function toWindowChunk(chunk, matchedChunkIndex, windowFormat) {
  const isMatch = chunk.chunkIndex === matchedChunkIndex;
  const base = {
    sourceFile: chunk.sourceFile,
    chunkIndex: chunk.chunkIndex,
    section: chunk.section ?? '',
    isMatch,
  };
  if (windowFormat === 'compact') {
    const text = chunk.text ?? '';
    return {
      ...base,
      textSnippet: text.length > SNIPPET_CHARS ? text.slice(0, SNIPPET_CHARS) + '...' : text,
    };
  }
  return { ...base, text: chunk.text ?? null };
}

export async function expandWindows(adapter, collection, hits, { window, windowFormat }) {
  const seen = new Set();
  const expanded = [];
  for (const hit of hits) {
    if (!Number.isInteger(hit.chunkIndex) || !hit.sourceFile) {
      expanded.push({ ...hit, isMatch: true, windowChunks: [] });
      continue;
    }
    const neighbors = await adapter.getChunk(collection, hit.sourceFile, hit.chunkIndex, { window });
    const windowChunks = [];
    for (const chunk of neighbors) {
      const isMatch = chunk.chunkIndex === hit.chunkIndex;
      const sig = `${chunk.sourceFile}::${chunk.chunkIndex}`;
      // The matched chunk is always preserved in its own window; duplicate
      // non-match neighbors across results are emitted once.
      if (!isMatch && seen.has(sig)) continue;
      seen.add(sig);
      windowChunks.push(toWindowChunk(chunk, hit.chunkIndex, windowFormat));
    }
    expanded.push({ ...hit, isMatch: true, windowChunks });
  }
  return expanded;
}
