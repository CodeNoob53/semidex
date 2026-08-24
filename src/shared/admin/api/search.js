// POST /api/search — thin HTTP adapter over the shared retrieval service
// (src/core/retrieval/search.js). This file owns only HTTP concerns: body
// validation, translating the service's typed { error } results into
// HttpErrors, and window expansion (a search-route-only concern the Ask
// evidence pipeline does not need — it uses core getAnchoredContent()
// instead). The core service owns mode resolution, the collection-exists
// check, query embedding, and the excludeNav filter, so /api/search and Ask
// see identical ranking/filtering behavior from one implementation.
//
// Request validation and window-expansion domain logic (parseSearchRequest,
// toWindowChunk, expandWindows) live in src/core/retrieval/search-request.js
// — the SAME implementation the public POST /api/v1/search Integration route
// (src/core/search-api/v1/route.js) builds on, so the Admin dashboard's
// unversioned search and the public Integration API can never quietly drift
// on bounds, defaults, or window semantics. This file stays the Admin-only
// HTTP adapter: unversioned path, no auth, dashboard response shape.
//
// Search mode is capability-driven: hybrid requires
// caps.hybridSearch && caps.sparseVectors. The StorageAdapter contract has
// no dense-only search method yet, so a backend without those capabilities
// gets an explicit 501 (documented Phase 1C limitation) instead of a silent
// wrong-mode search.
import { sendJson, notFound, HttpError } from '../../../core/http/http.js';
import { readJsonBody } from '../../../core/http/http.js';
import { embedForSearch } from '../../core/embeddings.js';
import { runHybridSearch, resolveSearchMode } from '../../../core/retrieval/search.js';
import { parseSearchRequest, expandWindows } from '../../../core/retrieval/search-request.js';
import { AUDIENCE, OPERATION, COST_CLASS, COLLECTION_SOURCE } from '../../../core/http/route-audience.js';

export { resolveSearchMode, parseSearchRequest };

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
  }, { audience: AUDIENCE.ADMIN, operation: OPERATION.SEARCH, resourceType: 'collection', collectionSource: COLLECTION_SOURCE.BODY, costClass: COST_CLASS.QDRANT });
}
