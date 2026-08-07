import { fetchWindowChunks } from '../../shared/core/qdrant.js';
import { createStorageAdapter } from '../../core/storage/factory.js';
import { runHybridSearch } from '../../core/retrieval/search.js';
import { validateRerankCapability } from '../../shared/core/rerank-capability.js';

import { envInt } from '../../shared/core/env.js';

// runHybridSearch() returns adapter Chunk objects (camelCase, via
// toChunk()) — rerankResults()/ceRerank() both read the raw snake_case
// Qdrant point shape ({ payload: {...}, score }), a contract shared with
// their other (non-MCP) callers that this function does not change.
// Reconstructs the minimal shape those two functions actually read, scoped
// entirely to this file — MCP is the only caller that needs this
// adaptation (Admin Search never calls either rerank function).
export function chunkToLegacyPoint(chunk) {
  return {
    score: chunk.score,
    payload: {
      source_file: chunk.sourceFile,
      chunk_index: chunk.chunkIndex,
      total_chunks: chunk.totalChunks,
      section: chunk.section,
      text: chunk.text,
      tags: chunk.tags,
      context: chunk.context,
      node_id: chunk.nodeId,
      node_path: chunk.nodePath,
      node_type: chunk.nodeType,
    },
  };
}

// MCP search routes through runHybridSearch() (core/retrieval/search.js) —
// the SAME shared call site admin search and Ask use, which itself owns
// embedding-profile resolution internally. MCP never imports or calls a
// profile resolver directly. Lazily constructed (never at import time) so
// a test importing this module directly never
// touches a real Qdrant connection unless handle() actually runs.
// setStorageAdapter() mirrors setSettingsService()'s existing DI pattern in
// this same file — a test-only override seam for a module with no
// constructor of its own (the MCP SDK calls handle(args) directly).
let storageAdapter = null;
let storageAdapterOverride = null;
export function setStorageAdapter(adapter) { storageAdapterOverride = adapter; }
function getStorageAdapter() {
  if (storageAdapterOverride) return storageAdapterOverride;
  if (!storageAdapter) storageAdapter = createStorageAdapter();
  return storageAdapter;
}

// settingsService is set once by mcp/server.js at process startup
// (setSettingsService()) — this tool module has no constructor/DI point of
// its own (the MCP SDK calls handle(args) directly with a fixed signature),
// so a module-level settable reference is the lowest-risk way to thread the
// shared service in without changing every tool's call signature. When
// unset (e.g. a test that imports this module directly), every read below
// falls back to its original direct env read, unchanged.
let settingsService = null;
export function setSettingsService(service) { settingsService = service; }

// embedQuery mirrors setSettingsService()'s own pattern — set once by
// mcp/server.js at process startup to a closure bound to THIS process's own
// real capability (code review, round 3): without this, runHybridSearch()'s
// own `embedQuery = embedForSearch` default would fall through to
// core/embeddings.js's shared module-scope fallback — a singleton none of
// the three composition roots mutate anymore as of round 4, so it stays
// pointed at embeddings.js's own baked-in default regardless of which
// composition root(s) have run in this process. Binding explicitly here
// means this server's own search requests never consult that shared
// fallback at all, isolated from every other composition root by
// construction rather than by convention. When unset (e.g. a test
// importing this module directly), runHybridSearch()'s own default
// applies, unchanged.
let embedQueryOverride = null;
export function setEmbedQuery(fn) { embedQueryOverride = fn; }

// cloudEmbed mirrors setEmbedQuery()'s own pattern (code review, Phase 8B
// Step 6) — set once by mcp/server.js at process startup to this process's
// own real CloudEmbeddingCapability. Without this, a qdrant-cloud
// collection's search would have no capability to reach
// checkEmbedInputFits()/buildCloudQueryInputs() with. When unset (e.g. a
// test importing this module directly, or a query against a
// client-execution collection), runHybridSearch() simply never
// dereferences it.
let cloudEmbedOverride = null;
export function setCloudEmbed(capability) { cloudEmbedOverride = capability; }

// rerank (code review, Phase 8B Step 6 second pass, P1 fix): this module
// previously imported core/rerank.js/core/ce-rerank.js directly — a real
// `shared -> local implementation` edge (ce-rerank.js spawns a persistent
// local child process; this file is declared 'shared' in the architecture
// manifest). Set once by src/mcp/server.js at process startup to its own
// real RerankCapability (core/rerank-provider.js's createRerankCapability()
// — see core/rerank-capability.js for the contract), mirroring
// setCloudEmbed()'s own pattern. handle() below throws a clear, actionable
// error if reranking is enabled but no capability was ever injected — no
// silent real-import fallback.
let rerankOverride = null;
export function setRerank(capability) {
  if (capability !== null) validateRerankCapability(capability);
  rerankOverride = capability;
}

// next_search fields — refreshIfChanged() is called once per tool
// invocation (not per read) so a change saved via the admin UI while this
// MCP process has been running propagates without restarting it, per the
// Global Settings phase's cross-process propagation requirement.
function refreshSettingsIfNeeded() {
  settingsService?.refreshIfChanged();
}

// Exported for direct unit testing (search-settings-service.test.js) —
// handle() itself has no existing test harness (requires a live embed/
// Qdrant call), so these small resolver functions are the testable seam
// for the settingsService extraction contract.
export function getRerankEnabled() {
  return settingsService ? settingsService.getActiveValue('RERANK_ENABLED') : process.env.RERANK_ENABLED === '1';
}
export function getRerankCeEnabled() {
  return settingsService ? settingsService.getActiveValue('RERANK_CE_ENABLED') : process.env.RERANK_CE_ENABLED === '1';
}
export function getRerankPrefetchMult() {
  return settingsService
    ? settingsService.getActiveValue('RERANK_PREFETCH_MULT')
    : envInt('RERANK_PREFETCH_MULT', 4, 1, 100, '[search] ');
}

// Phase 3X: node_id is qdrant_get_content's anchor_node_id input — every
// window chunk that carries one (skeleton-aware collections) exposes it so
// an agent can expand context around ANY window chunk, not just the primary
// hit. Legacy collections never had node_id at all; the field is OMITTED
// entirely for those points (never invented as null, which would look like
// "checked, absent" rather than "this collection predates node identity").
function anchorFields(payload) {
  return payload.node_id
    ? { node_id: payload.node_id, node_path: payload.node_path ?? null, node_type: payload.node_type ?? null }
    : {};
}

export function assembleWindowChunks(wPoints, matchedChunkIndex, window_format, seenChunks = new Set()) {
  const result = [];
  for (const wp of wPoints) {
    const is_match = wp.payload.chunk_index === matchedChunkIndex;
    const sig = `${wp.payload.source_file}_${wp.payload.chunk_index}`;
    if (!is_match && seenChunks.has(sig)) continue;
    seenChunks.add(sig);
    const text_snippet = window_format === 'compact' && wp.payload.text
      ? wp.payload.text.slice(0, 150) + (wp.payload.text.length > 150 ? '...' : '')
      : undefined;
    result.push({
      source_file: wp.payload.source_file,
      chunk_index: wp.payload.chunk_index,
      section: wp.payload.section || '',
      is_match,
      ...anchorFields(wp.payload),
      ...(window_format === 'compact' ? { text_snippet } : { text: wp.payload.text }),
    });
  }
  return result;
}

export const schema = {
  name: 'qdrant_search',
  description: 'Hybrid search over a collection (dense semantic + sparse keyword, fused via RRF). Optionally filter by tags or source file.',
  inputSchema: {
    type: 'object',
    properties: {
      query:       { type: 'string',  description: 'Search query in natural language' },
      collection:  { type: 'string',  description: 'Collection name' },
      top:         { type: 'integer', description: 'Number of results (default 5)', default: 5 },
      tags:        { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any match)' },
      source_file: { type: 'string',  description: 'Filter to a specific source file' },
      window:      { type: 'integer', description: 'Extra chunks before/after to include (default 0, max 2)', default: 0, minimum: 0, maximum: 2 },
      window_format: { type: 'string', enum: ['full', 'compact'], description: 'Format of window chunks', default: 'full' },
    },
    required: ['query', 'collection'],
  },
};

export async function handle({ query, collection, top = 5, tags, source_file, window = 0, window_format = 'full' }) {
  refreshSettingsIfNeeded();
  const RERANK_ENABLED = getRerankEnabled();
  const RERANK_CE_ENABLED = getRerankCeEnabled();
  const RERANK_PREFETCH_MULT = getRerankPrefetchMult();

  top = Math.min(Math.max(1, parseInt(top) || 5), 20);
  window = Math.max(0, Math.min(2, parseInt(window) || 0));

  // MCP requests its own candidate pool by passing a larger `top` to
  // runHybridSearch() when reranking is enabled — the shared retrieval
  // service (embedding-profile resolution, execution-mode branching
  // between CLIENT and QDRANT_CLOUD, excludeNav filtering) is identical to
  // Admin Search and Ask; only this post-processing (rerank) stays
  // MCP-specific, same as it always has.
  const requestLimit = (RERANK_ENABLED || RERANK_CE_ENABLED)
    ? Math.max(top * RERANK_PREFETCH_MULT, top + 5)
    : top;

  const result = await runHybridSearch({
    adapter: getStorageAdapter(),
    collection,
    query,
    top: requestLimit,
    filters: { sourceFile: source_file, tags },
    settingsService,
    ...(embedQueryOverride ? { embedQuery: embedQueryOverride } : {}),
    ...(cloudEmbedOverride ? { cloudEmbed: cloudEmbedOverride } : {}),
  });
  if (result.error) {
    return `Cannot search "${collection}": ${result.message}`;
  }

  // Pipeline (docs/en/ce-rerank-design.md §4):
  //   runHybridSearch(prefetch N) → [Stage 1: det-rerank] → [Stage 2: CE rerank] → slice(top)
  // When CE follows det-rerank, det-rerank keeps the FULL pool ordering
  // (finalLimit = pool length) so CE receives the complete candidate window.
  // rerankResults()/ceRerank() read the raw snake_case Qdrant point shape —
  // chunkToLegacyPoint() adapts runHybridSearch's Chunk objects for them.
  let results;
  if (RERANK_ENABLED || RERANK_CE_ENABLED) {
    if (!rerankOverride) {
      throw new Error('mcp/tools/search.js: reranking is enabled but no RerankCapability was injected — call setRerank(capability) first (src/mcp/server.js does this at startup), or setRerank(createRerankCapability()) in a test.');
    }
    const { rerankResults, ceRerank, withCETimeout, getCeRerankConfig } = rerankOverride;
    let pool = result.hits.map(chunkToLegacyPoint);

    if (RERANK_ENABLED) {
      pool = rerankResults(pool, query, { finalLimit: RERANK_CE_ENABLED ? pool.length : top }, { settingsService });
    }

    if (RERANK_CE_ENABLED) {
      const preCE = pool;
      const ceTimeoutMs = getCeRerankConfig({ settingsService }).timeoutMs;
      pool = await withCETimeout(
        ceRerank(preCE, query, { finalLimit: top }, { settingsService }),
        ceTimeoutMs,
        () => preCE.slice(0, top),
      );
    }

    results = pool.slice(0, top);
  } else {
    results = result.hits.map(chunkToLegacyPoint);
  }
  if (!results.length) return 'No results found.';

  // Fetch all window chunks in parallel (one request per result instead of N sequential).
  const windowPointsList = window > 0
    ? await Promise.all(results.map(r => {
        const chunkIndex = r.payload.chunk_index;
        return Number.isInteger(chunkIndex)
          ? fetchWindowChunks(collection, r.payload.source_file, chunkIndex, window)
          : Promise.resolve([]);
      }))
    : results.map(() => []);

  const formattedResults = [];
  const seenChunks = new Set();

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const p = r.payload;
    const chunkIndex = Number.isInteger(p.chunk_index) ? p.chunk_index : '?';
    const totalChunks = Number.isInteger(p.total_chunks) ? p.total_chunks : '?';
    const chunkDisplay = Number.isInteger(p.chunk_index) ? p.chunk_index + 1 : '?';

    let windowChunksJSON = null;
    if (window > 0 && chunkIndex !== '?') {
      windowChunksJSON = assembleWindowChunks(windowPointsList[i], chunkIndex, window_format, seenChunks);
    }

    const lines = [
      `### ${p.source_file} > ${p.section || 'intro'} (chunk_index: ${chunkIndex}, chunk: ${chunkDisplay}/${totalChunks}, score: ${r.score.toFixed(3)})`,
      `**Tags:** ${(p.tags || []).join(', ')}`,
      `**Context:** ${p.context || ''}`,
    ];

    // Phase 3X: node_id/node_path/node_type are the anchor identity
    // qdrant_get_content needs to expand this hit into coherent
    // section/file context — the documented contract is all three fields,
    // matching what assembleWindowChunks() already exposes on window
    // chunks (code review: the primary hit line previously omitted
    // node_path, leaving it inconsistent with its own window-chunk
    // sibling). Omitted entirely (never a fabricated/null placeholder) for
    // legacy collections that predate skeleton node identity — anchored
    // assembly is unavailable for those until they are reindexed with
    // skeleton chunking.
    if (p.node_id) {
      const parts = [`node_id=${p.node_id}`];
      if (p.node_path) parts.push(`node_path=${p.node_path}`);
      if (p.node_type) parts.push(`node_type=${p.node_type}`);
      lines.push(`**Node:** ${parts.join(' ')}`);
    }

    if (windowChunksJSON) {
      lines.push(`\n**Window Chunks:**\n~~~~json\n${JSON.stringify({ window_chunks: windowChunksJSON }, null, 2)}\n~~~~`);
    }

    lines.push('');
    lines.push(p.text);

    formattedResults.push(lines.join('\n'));
  }

  return formattedResults.join('\n\n---\n\n');
}
