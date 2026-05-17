import { search, updatePayload } from '../../core/qdrant.js';
import { addLink, addBacklink } from '../../core/graph.js';
import { embedForSearch } from '../../core/embeddings.js';

const LINK_TOP       = parseInt(process.env.LINK_TOP || '5');
const LINK_MIN_SCORE = parseFloat(process.env.LINK_MIN_SCORE || '0.75');
const LINK_ALLOWLIST = process.env.LINK_COLLECTIONS
  ? new Set(process.env.LINK_COLLECTIONS.split(',').map(s => s.trim()))
  : null;

// Link-decision loop — exported for deterministic testing; not part of the public indexer API.
// Side effect: calls updatePayload when a target's backlinks array is missing the source file.
export async function applyLinkResults(chunk, graph, searchResults, minScore) {
  const links = [...(chunk.links || [])];
  for (const { collection, results } of searchResults) {
    for (const r of results) {
      if (r.score < minScore) continue;
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

// graph is mutated in place — caller owns load/save to avoid race conditions.
// sourceCollection determines which embedding provider to use for the query.
// precomputedDense: if provided, skips the embedForSearch call (phase-4 vector reuse).
export async function buildLinks(chunk, collections, graph, sourceCollection, precomputedDense = null) {
  const dense = precomputedDense !== null
    ? precomputedDense
    : (await embedForSearch(sourceCollection, `${chunk.context}\n\n${chunk.text}`)).dense;
  const vector = { name: 'dense', vector: dense };

  const targets = LINK_ALLOWLIST
    ? collections.filter(c => LINK_ALLOWLIST.has(c))
    : collections;

  const searchResults = [];
  for (const collection of targets) {
    let results;
    try {
      results = await search(collection, vector, LINK_TOP);
    } catch (err) {
      console.warn(`  [link] skipping collection "${collection}": ${err.message}`);
      continue;
    }
    searchResults.push({ collection, results });
  }

  return applyLinkResults(chunk, graph, searchResults, LINK_MIN_SCORE);
}
