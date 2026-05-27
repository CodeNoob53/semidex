import { hybridSearch, fetchWindowChunks } from '../../core/qdrant.js';
import { embedForSearch } from '../../core/embeddings.js';
import { rerankResults } from '../../core/rerank.js';
import { queryEntityTokens, entityOverlap, applyEntityBoost } from '../../core/entity-boost.js';

function envInt(name, defaultVal, min, max) {
  const v = parseInt(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) return defaultVal;
  return v;
}

const RERANK_ENABLED        = process.env.RERANK_ENABLED === '1';
const RERANK_PREFETCH_MULT  = envInt('RERANK_PREFETCH_MULT', 4, 1, 100);
const ENTITY_BOOST_ENABLED  = process.env.ENTITY_BOOST_ENABLED === '1';
const _ebw = parseFloat(process.env.ENTITY_BOOST_WEIGHT ?? '');
const ENTITY_BOOST_WEIGHT   = Number.isFinite(_ebw) ? _ebw : 0.0015;
const ENTITY_BOOST_PREFETCH = envInt('ENTITY_BOOST_PREFETCH', 20, 1, 200);

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
  window = Math.max(0, Math.min(2, parseInt(window) || 0));

  const { dense, sparse } = await embedForSearch(collection, query);

  let filter = null;
  if (source_file || tags?.length) {
    const must = [];
    if (source_file) must.push({ key: 'source_file', match: { value: source_file } });
    if (tags?.length) must.push({ should: tags.map(t => ({ key: 'tags', match: { value: t } })) });
    filter = { must };
  }

  let results;
  if (RERANK_ENABLED) {
    const candidateLimit = Math.max(top * RERANK_PREFETCH_MULT, top + 5);
    const candidates = await hybridSearch(collection, dense, sparse, candidateLimit, filter);
    results = rerankResults(candidates, query, { finalLimit: top, collection });
  } else if (ENTITY_BOOST_ENABLED) {
    const queryTokens = queryEntityTokens(query);
    const baseline = await hybridSearch(collection, dense, sparse, top, filter);
    if (queryTokens.size === 0) {
      results = baseline;
    } else {
      const prefetchLimit = ENTITY_BOOST_PREFETCH > top ? ENTITY_BOOST_PREFETCH : top;
      const candidates = prefetchLimit > top
        ? await hybridSearch(collection, dense, sparse, prefetchLimit, filter)
        : baseline;
      // Check overlap before boosting — if no candidate has entity payload matching
      // the query (e.g. old collection without payload.entities), skip the wide
      // candidates entirely and return the true baseline unchanged.
      const hasOverlap = candidates.some(r => entityOverlap(queryTokens, r.payload) > 0);
      results = hasOverlap
        ? applyEntityBoost(candidates, queryTokens, ENTITY_BOOST_WEIGHT).slice(0, top)
        : baseline;
    }
  } else {
    results = await hybridSearch(collection, dense, sparse, top, filter);
  }
  if (!results.length) return 'No results found.';

  const formattedResults = [];
  const seenChunks = new Set();

  for (const r of results) {
    const p = r.payload;
    const chunkIndex = Number.isInteger(p.chunk_index) ? p.chunk_index : '?';
    const totalChunks = Number.isInteger(p.total_chunks) ? p.total_chunks : '?';
    const chunkDisplay = Number.isInteger(p.chunk_index) ? p.chunk_index + 1 : '?';

    let windowChunksJSON = null;
    if (window > 0 && chunkIndex !== '?') {
      const wPoints = await fetchWindowChunks(collection, p.source_file, chunkIndex, window);
      windowChunksJSON = assembleWindowChunks(wPoints, chunkIndex, window_format, seenChunks);
    }

    const lines = [
      `### ${p.source_file} > ${p.section || 'intro'} (chunk_index: ${chunkIndex}, chunk: ${chunkDisplay}/${totalChunks}, score: ${r.score.toFixed(3)})`,
      `**Tags:** ${(p.tags || []).join(', ')}`,
      `**Context:** ${p.context || ''}`,
    ];

    if (windowChunksJSON) {
      lines.push(`\n**Window Chunks:**\n~~~~json\n${JSON.stringify({ window_chunks: windowChunksJSON }, null, 2)}\n~~~~`);
    }

    lines.push('');
    lines.push(p.text);

    formattedResults.push(lines.join('\n'));
  }

  return formattedResults.join('\n\n---\n\n');
}
