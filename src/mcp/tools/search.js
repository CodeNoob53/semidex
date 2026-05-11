import { hybridSearch, fetchWindowChunks } from '../../core/qdrant.js';
import { embedForSearch } from '../../core/embeddings.js';
import { rerankResults } from '../../core/rerank.js';

function envInt(name, defaultVal, min, max) {
  const v = parseInt(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) return defaultVal;
  return v;
}

const RERANK_ENABLED = process.env.RERANK_ENABLED === '1';
const RERANK_PREFETCH_MULT = envInt('RERANK_PREFETCH_MULT', 4, 1, 100);

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
    },
    required: ['query', 'collection'],
  },
};

export async function handle({ query, collection, top = 5, tags, source_file, window = 0 }) {
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
  } else {
    results = await hybridSearch(collection, dense, sparse, top, filter);
  }
  if (!results.length) return 'No results found.';

  const formattedResults = await Promise.all(results.map(async r => {
    const p = r.payload;
    const chunkIndex = Number.isInteger(p.chunk_index) ? p.chunk_index : '?';
    const totalChunks = Number.isInteger(p.total_chunks) ? p.total_chunks : '?';
    const chunkDisplay = Number.isInteger(p.chunk_index) ? p.chunk_index + 1 : '?';

    let windowChunksJSON = null;
    if (window > 0 && chunkIndex !== '?') {
      const wPoints = await fetchWindowChunks(collection, p.source_file, chunkIndex, window);
      windowChunksJSON = wPoints.map(wp => ({
        chunk_index: wp.payload.chunk_index,
        text: wp.payload.text,
        section: wp.payload.section || '',
        is_match: wp.payload.chunk_index === chunkIndex
      }));
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

    return lines.join('\n');
  }));

  return formattedResults.join('\n\n---\n\n');
}
