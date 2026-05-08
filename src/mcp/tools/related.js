import { scroll } from '../../core/qdrant.js';
import { loadGraph } from '../../core/graph.js';

export const schema = {
  name: 'qdrant_related',
  description: 'Get files semantically linked to a source file (outgoing links from graph.<collection>.json).',
  inputSchema: {
    type: 'object',
    properties: {
      collection:  { type: 'string', description: 'Collection name' },
      source_file: { type: 'string', description: 'Source file path (relative, as stored)' },
    },
    required: ['collection', 'source_file'],
  },
};

export async function handle({ collection, source_file }) {
  const graph = loadGraph(collection);
  const node = graph[source_file];
  if (!node?.links?.length) return `No outgoing links found for ${source_file}.`;

  const lines = [`## Related files for \`${source_file}\`\n`];
  for (const target of node.links) {
    const points = await scroll(collection, {
      must: [{ key: 'source_file', match: { value: target } }],
    }, 1, ['context', 'section', 'tags']);
    const p = points[0]?.payload;
    lines.push(`- **${target}**${p ? ` — ${p.context || p.section || ''}` : ''}`);
  }
  return lines.join('\n');
}
