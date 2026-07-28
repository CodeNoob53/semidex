// Provider-neutral hybrid-search orchestration — the core retrieval service
// shared by /api/search (src/admin/api/search.js) and the Ask evidence
// pipeline (src/core/ask/evidence.js). One implementation: mode resolution,
// the collection-exists check, embedding-profile resolution, query
// embedding, and the excludeNav filter all live here so both callers see
// identical ranking and filtering behavior. MCP search
// (src/mcp/tools/search.js) resolves its collection's profile through the
// SAME resolveExistingCollectionProfile() this file uses, but is not routed
// through runHybridSearch() itself — out of scope to refactor MCP's whole
// pipeline onto this service.
//
// No HTTP concerns here (no HttpError, no req/res) — errors are reported via
// a typed { error } result so both an HTTP adapter and a non-HTTP caller
// (Ask) can render them however they need to.
import { embedForSearch } from '../embeddings.js';
import { resolveExistingCollectionProfile } from '../embedding-profile/resolve.js';

/**
 * @typedef {Object} RetrievalError
 * @property {'not_implemented'|'collection_not_found'|'embedding_unresolved'|'embedding_unsupported'|'embedding_failed'} error
 * @property {string} message
 */

/**
 * Resolves the search mode from adapter capabilities. Returns 'hybrid' when
 * both hybrid search and sparse vectors are supported, null otherwise (the
 * caller decides how to surface "not implemented").
 * @param {Object} capabilities
 * @returns {'hybrid'|null}
 */
export function resolveSearchMode(capabilities) {
  if (capabilities.hybridSearch && capabilities.sparseVectors) return 'hybrid';
  return null;
}

/**
 * Run hybrid retrieval for a query against one collection. Always excludes
 * skeleton navigation points (excludeNav: true) — no caller may opt out.
 *
 * @param {{
 *   adapter: import('../storage/adapter.js').StorageAdapter,
 *   embedQuery?: (profile: Object, query: string) => Promise<{ dense: number[], sparse: Object }>,
 *   collection: string,
 *   query: string,
 *   top: number,
 *   filters?: { sourceFile?: string, tags?: string[] },
 *   settingsService?: ReturnType<typeof import('../settings/service.js').createSettingsService>,
 * }} opts
 *   settingsService is optional DI, forwarded to adapter.searchHybrid() so
 *   HYBRID_PREFETCH_LIMIT/RRF_K (next_search settings) apply to admin
 *   /api/search and Ask the same way they already do for MCP search (see
 *   mcp/tools/search.js) — without it, this service silently fell back to
 *   qdrant/store.js's own direct envInt() reads (code review finding).
 * @returns {Promise<{ searchMode: string, hits: Object[] } | RetrievalError>}
 */
export async function runHybridSearch({ adapter, embedQuery = embedForSearch, collection, query, top, filters = {}, settingsService } = {}) {
  const searchMode = resolveSearchMode(adapter.capabilities());
  if (searchMode === null) {
    return { error: 'not_implemented', message: 'This storage backend does not support hybrid search.' };
  }

  const existing = await adapter.getCollection(collection);
  if (!existing) {
    return { error: 'collection_not_found', message: `Collection "${collection}" not found` };
  }

  // Resolve the collection's OWN embedding profile before embedding at
  // all — never falls back to a local default model for an
  // unresolved/unsupported profile. This is the query-time half of the
  // same resolution embedForIndex/embedForIndexBatch use at index time
  // (src/core/embedding-profile/resolve.js), so a query always embeds
  // against the exact identity the collection's vectors were written with.
  const resolution = await resolveExistingCollectionProfile(adapter, collection);
  if (!resolution.resolved) {
    return { error: 'embedding_unresolved', message: `Collection "${collection}" has no resolvable embedding profile (${resolution.reason}) — reindex or run "npm run sync" to migrate.` };
  }
  if (resolution.profile.embedding.dense.execution !== 'client') {
    return { error: 'embedding_unsupported', message: `Collection "${collection}"'s embedding profile uses execution "${resolution.profile.embedding.dense.execution}", which is not yet implemented.` };
  }

  let vectors;
  try {
    vectors = await embedQuery(resolution.profile, query);
  } catch (err) {
    return { error: 'embedding_failed', message: `Failed to embed query: ${err.message}` };
  }

  const { sourceFile, tags } = filters;
  const filter = { ...(sourceFile && { sourceFile }), ...(tags && { tags }), excludeNav: true };
  const hits = await adapter.searchHybrid(collection, { dense: vectors.dense, sparse: vectors.sparse, limit: top, filter, settingsService });

  return { searchMode, hits };
}
