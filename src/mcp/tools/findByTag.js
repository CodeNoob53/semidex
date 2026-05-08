import { scroll } from '../../core/qdrant.js';

export const schema = {
  name: 'qdrant_find_by_tag',
  description: 'Find all chunks that have a specific tag.',
  inputSchema: {
    type: 'object',
    properties: {
      collection: { type: 'string',  description: 'Collection name' },
      tag:        { type: 'string',  description: 'Tag to search for' },
      limit:      { type: 'integer', description: 'Max results (default 20)', default: 20 },
    },
    required: ['collection', 'tag'],
  },
};

export async function handle({ collection, tag, limit = 20 }) {
  const points = await scroll(collection, {
    must: [{ key: 'tags', match: { value: tag } }],
  }, limit);

  if (!points.length) return `No chunks found with tag "${tag}".`;

  const byFile = {};
  for (const p of points) {
    const f = p.payload.source_file;
    if (!byFile[f]) byFile[f] = [];
    byFile[f].push(p.payload.section || 'intro');
  }

  const lines = [`## Chunks tagged \`${tag}\`\n`];
  for (const [file, sections] of Object.entries(byFile)) {
    lines.push(`- **${file}** — ${[...new Set(sections)].join(', ')}`);
  }
  return lines.join('\n');
}
