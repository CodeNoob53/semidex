import { scroll } from '../../core/qdrant.js';
import { loadGraph } from '../../core/graph.js';

export const schema = {
  name: 'qdrant_related',
  description: 'After qdrant_search identifies a high-confidence source_file, traverse its outgoing file-level semantic links from graph.<collection>.json. This is graph navigation, not ranked topical search: results may include noise, so inspect summaries and narrow with qdrant_search or qdrant_get_chunk when needed.',
  inputSchema: {
    type: 'object',
    properties: {
      collection:  { type: 'string', description: 'Collection name' },
      source_file: { type: 'string', description: 'Source file path (relative, as stored)' },
    },
    required: ['collection', 'source_file'],
  },
};

// Pure helper — exposed for smoke testing.
// Zips ordered link names with parallel scroll results, preserving graph order.
// links: string[]  — ordered target file names from node.links
// results: Array<Point[]>  — parallel scroll results, same order as links
// Returns: string[]  — formatted lines, one per link
export function zipOrderedLinks(links, results) {
  return links.map((target, i) => {
    const p    = results[i]?.[0]?.payload;
    const desc = p ? (p.context || p.section || '') : '';
    return `- **${target}**${desc ? ` — ${desc}` : ''}`;
  });
}

export async function handle({ collection, source_file }) {
  const graph = loadGraph(collection);
  const node = graph[source_file];
  if (!node?.links?.length) return `No outgoing links found for ${source_file}.`;

  const results = await Promise.all(node.links.map(target =>
    scroll(collection, {
      must: [{ key: 'source_file', match: { value: target } }],
    }, 1, ['context', 'section', 'tags'])
  ));
  const lines = [`## Related files for \`${source_file}\`\n`, ...zipOrderedLinks(node.links, results)];
  return lines.join('\n');
}
