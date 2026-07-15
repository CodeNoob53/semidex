// Provider-neutral hybrid-search orchestration — the core retrieval service
// shared by /api/search (src/admin/api/search.js) and the Ask evidence
// pipeline (src/core/ask/evidence.js). One implementation: mode resolution,
// the collection-exists check, query embedding, and the excludeNav filter
// all live here so both callers see identical ranking and filtering
// behavior. MCP search (src/mcp/tools/search.js) is NOT refactored onto this
// service in this phase — out of scope, do not touch it.
//
// No HTTP concerns here (no HttpError, no req/res) — errors are reported via
// a typed { error } result so both an HTTP adapter and a non-HTTP caller
// (Ask) can render them however they need to.
import { embedForSearch } from '../embeddings.js';

/**
 * @typedef {Object} RetrievalError
 * @property {'not_implemented'|'collection_not_found'|'embedding_failed'} error
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
 *   embedQuery?: (collection: string, query: string) => Promise<{ dense: number[], sparse: Object }>,
 *   collection: string,
 *   query: string,
 *   top: number,
 *   filters?: { sourceFile?: string, tags?: string[] },
 * }} opts
 * @returns {Promise<{ searchMode: string, hits: Object[] } | RetrievalError>}
 */
export async function runHybridSearch({ adapter, embedQuery = embedForSearch, collection, query, top, filters = {} }) {
  const searchMode = resolveSearchMode(adapter.capabilities());
  if (searchMode === null) {
    return { error: 'not_implemented', message: 'This storage backend does not support hybrid search.' };
  }

  const existing = await adapter.getCollection(collection);
  if (!existing) {
    return { error: 'collection_not_found', message: `Collection "${collection}" not found` };
  }

  let vectors;
  try {
    vectors = await embedQuery(collection, query);
  } catch (err) {
    return { error: 'embedding_failed', message: `Failed to embed query: ${err.message}` };
  }

  const { sourceFile, tags } = filters;
  const filter = { ...(sourceFile && { sourceFile }), ...(tags && { tags }), excludeNav: true };
  const hits = await adapter.searchHybrid(collection, { dense: vectors.dense, sparse: vectors.sparse, limit: top, filter });

  return { searchMode, hits };
}
