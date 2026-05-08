import { search, updatePayload } from '../../core/qdrant.js';
import { embed } from '../../core/ollama.js';
import { addLink, addBacklink } from '../../core/graph.js';

const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3';
const LINK_TOP = parseInt(process.env.LINK_TOP || '5');
const LINK_MIN_SCORE = parseFloat(process.env.LINK_MIN_SCORE || '0.75');
const LINK_ALLOWLIST = process.env.LINK_COLLECTIONS
  ? new Set(process.env.LINK_COLLECTIONS.split(',').map(s => s.trim()))
  : null;

// graph is mutated in place — caller owns load/save to avoid race conditions.
export async function buildLinks(chunk, collections, graph) {
  const vector = await embed(chunk.context + '\n' + chunk.text, EMBED_MODEL);
  const links = [...(chunk.links || [])];

  const targets = LINK_ALLOWLIST
    ? collections.filter(c => LINK_ALLOWLIST.has(c))
    : collections;

  for (const collection of targets) {
    let results;
    try {
      results = await search(collection, vector, LINK_TOP);
    } catch (err) {
      console.warn(`  [link] skipping collection "${collection}": ${err.message}`);
      continue;
    }
    for (const r of results) {
      if (r.score < LINK_MIN_SCORE) continue;
      const targetFile = r.payload?.source_file;
      if (!targetFile || targetFile === chunk.source_file) continue;

      if (!links.includes(targetFile)) links.push(targetFile);

      const targetBacklinks = r.payload?.backlinks || [];
      if (!targetBacklinks.includes(chunk.source_file)) {
        await updatePayload(collection, r.id, {
          backlinks: [...targetBacklinks, chunk.source_file],
        });
      }

      addLink(graph, chunk.source_file, targetFile);
      addBacklink(graph, targetFile, chunk.source_file);
    }
  }

  return { ...chunk, links };
}
