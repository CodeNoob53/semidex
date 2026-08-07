// Provider-neutral hybrid-search orchestration — the core retrieval service
// shared by /api/search (src/admin/api/search.js), the Ask evidence
// pipeline (src/core/ask/evidence.js), and MCP search
// (src/mcp/tools/search.js). One implementation: mode resolution, the
// collection-exists check, embedding-profile resolution, execution-mode
// branching (CLIENT: real vectors via embedQuery + searchHybridVectors();
// QDRANT_CLOUD: inference descriptors via buildCloudQueryInputs() +
// searchHybridInference() — never a local embed for a cloud profile), and
// the excludeNav filter all live here so every caller sees identical
// ranking and filtering behavior. MCP requests its own rerank candidate
// pool by passing a larger `top`; its deterministic/CE rerank remains
// MCP-specific post-processing on the returned hits.
//
// No HTTP concerns here (no HttpError, no req/res) — errors are reported via
// a typed { error } result so both an HTTP adapter and a non-HTTP caller
// (Ask) can render them however they need to.
import { embedForSearch } from '../embeddings.js';
import { resolveExistingCollectionProfile } from '../embedding-profile/resolve.js';
import { EXECUTION } from '../embedding-profile/schema.js';
import { findDenseModel } from '../embedding-profile/qdrant-cloud-models.js';
import { emitTelemetry } from '../bench-telemetry.js';

// Code review fix (Phase 8B Step 6): this module used to statically import
// buildCloudQueryInputs()/checkEmbedInputFits() from
// src/cloud/embedding/qdrant-cloud-catalog.js directly — a real
// `shared -> cloud IMPLEMENTATION` edge. `findDenseModel` (genuinely
// neutral typed catalog metadata — zero dependencies, no network, no
// tokenizer) stays a direct import, same as embeddings.js's own choice.
// `cloudEmbed` (the DI parameter below) is REQUIRED whenever a qdrant-cloud
// profile is actually resolved — never a module-scope default here, since
// this file has no composition-time hook of its own the way embeddings.js
// does (applyEmbeddingCapabilities()); every real caller
// (admin/api/search.js, core/ask/evidence.js, mcp/tools/search.js)
// receives its own `cloudEmbed` from ITS composition root and threads it
// through explicitly, mirroring how `embedQuery` already worked.

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
 *   cloudEmbed?: import('../embedding-profile/cloud-embedding-capability.js').CloudEmbeddingCapability,
 *   collection: string,
 *   query: string,
 *   top: number,
 *   filters?: { sourceFile?: string, tags?: string[] },
 *   settingsService?: ReturnType<typeof import('../settings/service.js').createSettingsService>,
 * }} opts
 *   settingsService is optional DI, forwarded to
 *   adapter.searchHybridVectors()/searchHybridInference() so
 *   HYBRID_PREFETCH_LIMIT/RRF_K (next_search settings) apply to admin
 *   /api/search, Ask, and MCP search uniformly — without it, this service
 *   silently fell back to qdrant/store.js's own direct envInt() reads
 *   (code review finding). `cloudEmbed` is only actually dereferenced when
 *   the resolved collection's own profile turns out to be qdrant-cloud —
 *   a caller that only ever searches client-execution collections may omit
 *   it safely.
 * @returns {Promise<{ searchMode: string, hits: Object[] } | RetrievalError>}
 */
export async function runHybridSearch({ adapter, embedQuery = embedForSearch, cloudEmbed, collection, query, top, filters = {}, settingsService } = {}) {
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
  const { sourceFile, tags } = filters;
  const filter = { ...(sourceFile && { sourceFile }), ...(tags && { tags }), excludeNav: true };
  const execution = resolution.profile.embedding.dense.execution;

  let hits;
  if (execution === EXECUTION.CLIENT) {
    let vectors;
    try {
      vectors = await embedQuery(resolution.profile, query);
    } catch (err) {
      return { error: 'embedding_failed', message: `Failed to embed query: ${err.message}` };
    }
    hits = await adapter.searchHybridVectors(collection, { dense: vectors.dense, sparse: vectors.sparse, limit: top, filter, settingsService });
  } else if (execution === EXECUTION.QDRANT_CLOUD) {
    // Same real, tokenizer-backed gate indexing already applies
    // (checkEmbedInputFits, embedForIndexCloud) — a query has no separate
    // "context" to trim (unlike a chunk's heading-path/skeleton-summary
    // prefix), so an over-long query is a typed rejection, never silently
    // truncated by Qdrant. Checked against the SAME dense catalog entry
    // embedForIndexCloud validates against, so an unknown/unsupported
    // dense model is reported the same way on both the index and query paths.
    if (!cloudEmbed) {
      return { error: 'embedding_failed', message: `Collection "${collection}" uses qdrant-cloud execution, but no cloudEmbed capability was supplied to runHybridSearch().` };
    }
    const denseModelId = resolution.profile.embedding.dense.model;
    const denseCatalog = findDenseModel(denseModelId);
    if (!denseCatalog || denseCatalog.status !== 'supported') {
      return { error: 'embedding_unsupported', message: `Collection "${collection}"'s dense model "${denseModelId}" is not a supported Qdrant Cloud model.` };
    }
    const fit = await cloudEmbed.checkEmbedInputFits(denseCatalog, query);
    if (!fit.fits) {
      return { error: 'embedding_failed', message: `Query is too long for "${denseModelId}" (code: ${fit.code}${fit.tokenCount ? `, ${fit.tokenCount}/${fit.contextWindow} tokens` : ''}).` };
    }

    // Descriptor-building is pure data assembly from the profile — no
    // embedding call, no network call, nothing ONNX/Ollama could touch.
    // buildCloudQueryInputs() — NOT embedForSearch, which stays
    // client-only. embedQuery (the DI param) is never used on this branch.
    const { denseQuery, sparseQuery } = cloudEmbed.buildCloudQueryInputs(resolution.profile, query);
    // Opt-in benchmark telemetry (no-op unless SEMIDEX_BENCH_TELEMETRY_PATH
    // is set — see src/core/bench-telemetry.js). Query-side counterpart of
    // embedForIndexCloud's own indexing-side emit — the only other place a
    // Qdrant Cloud Inference descriptor's real text/model is known.
    emitTelemetry({ kind: 'inference', phase: 'query', lane: 'dense', textLength: denseQuery.text.length, model: denseQuery.model });
    if (sparseQuery) {
      emitTelemetry({ kind: 'inference', phase: 'query', lane: 'sparse', textLength: sparseQuery.text.length, model: sparseQuery.model });
    }
    hits = await adapter.searchHybridInference(collection, { denseQuery, sparseQuery, limit: top, filter, settingsService });
  } else {
    return { error: 'embedding_unsupported', message: `Collection "${collection}"'s embedding profile uses execution "${execution}", which is not yet implemented.` };
  }

  return { searchMode, hits };
}
