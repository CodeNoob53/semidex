// POST /api/search — thin HTTP adapter over the shared retrieval service
// (src/core/retrieval/search.js). This file owns only HTTP concerns: body
// validation, translating the service's typed { error } results into
// HttpErrors, and window expansion (a search-route-only concern the Ask
// evidence pipeline does not need — it uses core getAnchoredContent()
// instead). The core service owns mode resolution, the collection-exists
// check, query embedding, and the excludeNav filter, so /api/search and Ask
// see identical ranking/filtering behavior from one implementation.
//
// Search mode is capability-driven: hybrid requires
// caps.hybridSearch && caps.sparseVectors. The StorageAdapter contract has
// no dense-only search method yet, so a backend without those capabilities
// gets an explicit 501 (documented Phase 1C limitation) instead of a silent
// wrong-mode search.
import { sendJson, badRequest, notFound, HttpError } from '../../core/http/http.js';
import { readJsonBody } from '../../core/http/http.js';
import { embedForSearch } from '../../shared/core/embeddings.js';
import { runHybridSearch, resolveSearchMode } from '../../core/retrieval/search.js';

export { resolveSearchMode };

const TOP_DEFAULT = 3;
const TOP_MIN = 1;
const TOP_MAX = 20;
const WINDOW_MIN = 0;
const WINDOW_MAX = 5;
const WINDOW_FORMATS = ['compact', 'full'];
const SNIPPET_CHARS = 150;

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

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} router
 * @param {import('../../core/storage/adapter.js').StorageAdapter} adapter
 * @param {{
 *   embedQuery?: (profile: Object, query: string) => Promise<{dense: number[], sparse: Object}>,
 *   cloudEmbed?: import('../../core/embedding-profile/cloud-embedding-capability.js').CloudEmbeddingCapability,
 *   settingsService?: ReturnType<typeof import('../../core/settings/service.js').createSettingsService>,
 * }} [deps]
 *   embedQuery is dependency-injectable so tests never need ONNX/Ollama.
 *   The default delegates to core/embeddings.js, which embeds with the
 *   collection's configured provider. cloudEmbed is optional DI (code
 *   review, Phase 8B Step 6) — only dereferenced by runHybridSearch() when
 *   the resolved collection turns out to be qdrant-cloud; the composition
 *   root supplies the real one (see server-full.js's/composition/lite.js's
 *   own createCloudEmbeddingCapability() call). settingsService is optional
 *   DI, forwarded to runHybridSearch() so HYBRID_PREFETCH_LIMIT/RRF_K apply
 *   here too, not just to MCP search — see core/retrieval/search.js's own
 *   JSDoc for why this matters (code review finding).
 */
export function registerSearchRoutes(router, adapter, { embedQuery = embedForSearch, cloudEmbed, settingsService } = {}) {
  router.post('/api/search', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const { collection, query, top, window, windowFormat, sourceFile, tags } = parseSearchRequest(body);

    // Cross-process propagation: a settings.json change saved via the admin
    // UI while this admin process has been running must be picked up
    // without a restart — same reasoning as MCP's search tool handler.
    settingsService?.refreshIfChanged();

    const result = await runHybridSearch({
      adapter, embedQuery, cloudEmbed, collection, query, top, filters: { sourceFile, tags }, settingsService,
    });

    if (result.error === 'not_implemented') throw new HttpError(501, result.error, result.message);
    if (result.error === 'collection_not_found') throw notFound(result.message);
    if (result.error === 'embedding_unresolved') throw new HttpError(503, result.error, result.message);
    if (result.error === 'embedding_unsupported') throw new HttpError(501, result.error, result.message);
    if (result.error === 'embedding_failed') throw new HttpError(500, result.error, result.message);

    const { searchMode, hits } = result;
    const results = window > 0
      ? await expandWindows(adapter, collection, hits, { window, windowFormat })
      : hits.map(h => ({ ...h, isMatch: true }));

    sendJson(res, 200, { collection, query, searchMode, top, window, windowFormat, results });
  });
}
