import { loadGraph } from '../../core/graph.js';

export const schema = {
  name: 'qdrant_backlinks',
  description: 'Get files that link to a given source file (incoming links from graph.<collection>.json).',
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
  const backlinks = graph[source_file]?.backlinks ?? [];
  if (!backlinks.length) return `No backlinks found for ${source_file}.`;
  return `## Backlinks for \`${source_file}\`\n\n` + backlinks.map(f => `- ${f}`).join('\n');
}
