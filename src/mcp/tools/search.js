import { hybridSearch } from '../../core/qdrant.js';
import { embedForSearch } from '../../core/embeddings.js';

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
    },
    required: ['query', 'collection'],
  },
};

export async function handle({ query, collection, top = 5, tags, source_file }) {
  const { dense, sparse } = await embedForSearch(collection, query);

  let filter = null;
  if (source_file || tags?.length) {
    const must = [];
    if (source_file) must.push({ key: 'source_file', match: { value: source_file } });
    if (tags?.length) must.push({ should: tags.map(t => ({ key: 'tags', match: { value: t } })) });
    filter = { must };
  }

  const results = await hybridSearch(collection, dense, sparse, top, filter);
  if (!results.length) return 'No results found.';

  return results.map(r => {
    const p = r.payload;
    return [
      `### ${p.source_file} › ${p.section || 'intro'} (score: ${r.score.toFixed(3)})`,
      `**Tags:** ${(p.tags || []).join(', ')}`,
      `**Context:** ${p.context || ''}`,
      '',
      p.text,
    ].join('\n');
  }).join('\n\n---\n\n');
}
