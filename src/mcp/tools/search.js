import { hybridSearch, fetchWindowChunks } from '../../core/qdrant.js';
import { embedForSearch } from '../../core/embeddings.js';
import { rerankResults } from '../../core/rerank.js';
import { ceRerank, withCETimeout, RERANK_CE_TIMEOUT_MS } from '../../core/ce-rerank.js';
import { withNavExcluded } from './filters.js';

import { envInt } from '../../core/env.js';

const RERANK_ENABLED        = process.env.RERANK_ENABLED === '1';
const RERANK_CE_ENABLED     = process.env.RERANK_CE_ENABLED === '1';
const RERANK_PREFETCH_MULT  = envInt('RERANK_PREFETCH_MULT', 4, 1, 100, '[search] ');

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
  top = Math.min(Math.max(1, parseInt(top) || 5), 20);
  window = Math.max(0, Math.min(2, parseInt(window) || 0));

  const { dense, sparse } = await embedForSearch(collection, query);

  let filter = null;
  if (source_file || tags?.length) {
    const must = [];
    if (source_file) must.push({ key: 'source_file', match: { value: source_file } });
    if (tags?.length) must.push({ should: tags.map(t => ({ key: 'tags', match: { value: t } })) });
    filter = { must };
  }
  // skeleton_nav points never appear in search (impl spec task 5);
  // a no-op for legacy collections — the field does not exist there.
  filter = withNavExcluded(filter);

  // Pipeline (docs/en/ce-rerank-design.md §4):
  //   hybridSearch(prefetch N) → [Stage 1: det-rerank] → [Stage 2: CE rerank] → slice(top)
  // When CE follows det-rerank, det-rerank keeps the FULL pool ordering
  // (finalLimit = pool length) so CE receives the complete candidate window.
  let results;
  if (RERANK_ENABLED || RERANK_CE_ENABLED) {
    const candidateLimit = Math.max(top * RERANK_PREFETCH_MULT, top + 5);
    let pool = await hybridSearch(collection, dense, sparse, candidateLimit, filter);

    if (RERANK_ENABLED) {
      pool = rerankResults(pool, query, { finalLimit: RERANK_CE_ENABLED ? pool.length : top });
    }

    if (RERANK_CE_ENABLED) {
      const preCE = pool;
      pool = await withCETimeout(
        ceRerank(preCE, query, { finalLimit: top }),
        RERANK_CE_TIMEOUT_MS,
        () => preCE.slice(0, top),
      );
    }

    results = pool.slice(0, top);
  } else {
    results = await hybridSearch(collection, dense, sparse, top, filter);
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
