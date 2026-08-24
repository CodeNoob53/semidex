// Search API v1 — the canonical, application-facing Search endpoint:
// POST /api/v1/search.
//
// This is the ONE public Search contract module. It owns:
//   - the route registration itself (mounted by whatever HTTP server the
//     caller supplies — see src/shared/admin/register-neutral-routes.js);
//   - request parsing/validation (request.js, itself built on the SAME
//     shared parser the Admin dashboard's /api/search uses);
//   - public response/error projection (contract.js);
//   - stage-2 collection authorization and error-code mapping (this file).
//
// It does NOT duplicate retrieval, embedding, filter, or window-expansion
// logic — all of that stays in src/core/retrieval/search.js (mode
// resolution, embedding-profile resolution, execution-mode branching) and
// src/core/retrieval/search-request.js (request validation, window
// expansion), the SAME modules the Admin dashboard's POST /api/search
// route builds on. Search has no generation provider, so — unlike Ask v1/v2
// — this route never touches a token/spend budget ledger and returns plain
// JSON, never SSE.
import { sendJson, notFound, readJsonBody, HttpError } from '../../http/http.js';
import { runHybridSearch } from '../../retrieval/search.js';
import { expandWindows } from '../../retrieval/search-request.js';
import { embedForSearch } from '../../../shared/core/embeddings.js';
import { AUDIENCE, OPERATION, COST_CLASS, COLLECTION_SOURCE } from '../../http/route-audience.js';
import { authorizeCollectionAccess } from '../../http/authorize.js';
import { sanitiseErrorMessage } from '../../../shared/core/doctor-checks.js';
import { parseSearchRequestV1 } from './request.js';
import { SEARCH_PATH, ERROR_CODES, projectSearchResponse, projectErrorResponseBody } from './contract.js';

export { SEARCH_PATH };

function safeMessage(message) {
  return sanitiseErrorMessage(message ?? '', [process.env.QDRANT_KEY]);
}

// Maps a runHybridSearch() typed { error } result to an HTTP status + public
// v1 error code — mirrors how /api/search and Ask v1/v2 report the same
// underlying codes from src/core/retrieval/search.js.
const RETRIEVAL_ERROR = {
  not_implemented: { status: 501, code: ERROR_CODES.NOT_IMPLEMENTED },
  collection_not_found: { status: 404, code: ERROR_CODES.NOT_FOUND },
  embedding_unresolved: { status: 503, code: ERROR_CODES.EMBEDDING_UNRESOLVED },
  embedding_unsupported: { status: 501, code: ERROR_CODES.EMBEDDING_UNSUPPORTED },
  embedding_failed: { status: 500, code: ERROR_CODES.EMBEDDING_FAILED },
};

/**
 * @param {Object} router
 * @param {import('../../storage/adapter.js').StorageAdapter} adapter
 * @param {{
 *   embedQuery?: (profile: Object, query: string) => Promise<{dense: number[], sparse: Object}>,
 *   cloudEmbed?: import('../../embedding-profile/cloud-embedding-capability.js').CloudEmbeddingCapability,
 *   settingsService?: ReturnType<typeof import('../../settings/service.js').createSettingsService>,
 * }} [deps]
 *   Same DI contract as registerSearchRoutes() (Admin's /api/search) —
 *   embedQuery/cloudEmbed/settingsService are all optional and threaded
 *   through to the SAME core/retrieval/search.js implementation, so tests
 *   never need ONNX/Ollama/a real Qdrant connection.
 */
export function registerSearchRoutesV1(router, adapter, { embedQuery = embedForSearch, cloudEmbed, settingsService } = {}) {
  router.post(SEARCH_PATH, async ({ req, res, auth }) => {
    try {
      const body = await readJsonBody(req);
      const { collection, query, top, window, windowFormat, sourceFile, tags } = parseSearchRequestV1(body);

      // Stage 2 — object-level authorization (OWASP API1:2023), same
      // contract as Ask v1/v2: the collection identifier is client-supplied
      // and only known now that the body is parsed, which is exactly why
      // the router's pre-body seam cannot perform this check. Runs BEFORE
      // any embedding/Qdrant work, so a denied request costs nothing.
      await authorizeCollectionAccess(auth, { req, collection, operation: OPERATION.SEARCH });

      // Cross-process propagation: a settings.json change saved via the
      // admin UI while this process has been running must be picked up
      // without a restart — same reasoning as Admin /api/search and MCP.
      settingsService?.refreshIfChanged();

      const result = await runHybridSearch({
        adapter, embedQuery, cloudEmbed, collection, query, top, filters: { sourceFile, tags }, settingsService,
      });

      if (result.error) {
        const mapped = RETRIEVAL_ERROR[result.error] ?? { status: 500, code: ERROR_CODES.INTERNAL_ERROR };
        if (mapped.code === ERROR_CODES.NOT_FOUND) throw notFound(safeMessage(result.message));
        throw new HttpError(mapped.status, mapped.code, safeMessage(result.message));
      }

      const { searchMode, hits } = result;
      const results = window > 0
        ? await expandWindows(adapter, collection, hits, { window, windowFormat })
        : hits.map((h) => ({ ...h, isMatch: true }));

      sendJson(res, 200, projectSearchResponse({ collection, query, top, window, windowFormat, searchMode, results }));
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.statusCode, projectErrorResponseBody(err.code, safeMessage(err.message)));
        return;
      }
      // Unexpected (non-HttpError) failure — a raw exception from the
      // adapter, embedding provider, or filesystem — can legitimately
      // contain a connection string, local path, or other internal detail
      // that safeMessage()'s fixed secret list was never meant to catch (it
      // only strips QDRANT_KEY, not arbitrary internals). Never forward
      // err.message to the client for this branch; a FIXED public message
      // goes out instead, mirroring how HttpError/RETRIEVAL_ERROR messages
      // above are always pre-composed, known-safe strings. Full detail is
      // still logged server-side only (console.error, same seam
      // src/shared/admin/router.js's own unexpected-principal branch uses)
      // so operators can still diagnose the failure.
      console.error(`[semidex] search v1: unexpected error — ${err?.stack ?? err?.message ?? String(err)}`);
      sendJson(res, 500, projectErrorResponseBody(ERROR_CODES.INTERNAL_ERROR, 'An unexpected internal error occurred. Please try again later.'));
    }
  }, { audience: AUDIENCE.INTEGRATION, operation: OPERATION.SEARCH, resourceType: 'collection', collectionSource: COLLECTION_SOURCE.BODY, costClass: COST_CLASS.QDRANT });
}
