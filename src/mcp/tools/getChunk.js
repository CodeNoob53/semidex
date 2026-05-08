import { scroll } from '../../core/qdrant.js';

export const schema = {
  name: 'qdrant_get_chunk',
  description: 'Retrieve a specific chunk by source file and chunk index, with optional surrounding window.',
  inputSchema: {
    type: 'object',
    properties: {
      collection:  { type: 'string',  description: 'Collection name' },
      source_file: { type: 'string',  description: 'Source file path (relative, as stored)' },
      chunk_index: { type: 'integer', description: 'Chunk index (0-based)' },
      window:      { type: 'integer', description: 'Extra chunks before/after to include (default 0)', default: 0 },
    },
    required: ['collection', 'source_file', 'chunk_index'],
  },
};

export async function handle({ collection, source_file, chunk_index, window = 0 }) {
  const from = Math.max(0, chunk_index - window);
  const to = chunk_index + window;

  const points = await scroll(collection, {
    must: [
      { key: 'source_file', match: { value: source_file } },
      { key: 'chunk_index', range: { gte: from, lte: to } },
    ],
  }, to - from + 1);

  if (!points.length) return `No chunks found for ${source_file} around index ${chunk_index}.`;

  points.sort((a, b) => a.payload.chunk_index - b.payload.chunk_index);

  return points.map(p => {
    const pay = p.payload;
    return [
      `### Chunk ${pay.chunk_index + 1}/${pay.total_chunks} — ${pay.section || 'intro'}`,
      `**Context:** ${pay.context || ''}`,
      '',
      pay.text,
    ].join('\n');
  }).join('\n\n---\n\n');
}
