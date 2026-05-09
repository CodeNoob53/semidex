import 'dotenv/config';
import { loadGraph } from './graph.js';

function envFloat(name, defaultVal, min, max) {
  const v = parseFloat(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      console.warn(`[rerank] ${name}="${process.env[name]}" is invalid — using default ${defaultVal}`);
    return defaultVal;
  }
  return v;
}

// Tokenize query into lowercase terms for exact-token matching.
function queryTokens(query) {
  return new Set(query.toLowerCase().match(/\b\w+\b/g) ?? []);
}

// Count how many query tokens appear in a string (case-insensitive).
function tokenHits(str, tokens) {
  if (!str) return 0;
  const words = str.toLowerCase().match(/\b\w+\b/g) ?? [];
  return words.filter(w => tokens.has(w)).length;
}

// Diversity penalties: second chunk from same file, third, fourth+.
const DIVERSITY_PENALTIES = [0, 0.05, 0.10, 0.15];

const BOOST_SOURCE_FILE = envFloat('RERANK_BOOST_SOURCE_FILE', 0.08, 0, 10);
const BOOST_SECTION     = envFloat('RERANK_BOOST_SECTION',     0.06, 0, 10);
const BOOST_TAGS        = envFloat('RERANK_BOOST_TAGS',        0.05, 0, 10);
const BOOST_TEXT        = envFloat('RERANK_BOOST_TEXT',        0.03, 0, 10);
const BOOST_BACKLINK    = envFloat('RERANK_BOOST_BACKLINK',    0.04, 0, 10);
const DEBUG             = process.env.RERANK_DEBUG === '1';

/**
 * Rerank results using deterministic signals on top of Qdrant RRF.
 *
 * @param {Array}  results     - Qdrant search results (each with .payload, .score)
 * @param {string} query       - The search query
 * @param {Object} opts
 * @param {number} opts.finalLimit   - How many to return (default: results.length)
 * @param {string} [opts.collection] - Collection name (for backlink graph)
 * @returns {Array} Reranked, trimmed to finalLimit.
 */
export function rerankResults(results, query, { finalLimit, collection } = {}) {
  if (!results.length) return results;
  const limit = finalLimit ?? results.length;
  const tokens = queryTokens(query);

  // Load backlink graph once.
  let graph = {};
  if (collection) {
    try { graph = loadGraph(collection); } catch (_) { /* no graph file is fine */ }
  }

  const seenFiles = new Map(); // source_file → count of chunks already scored above this one

  const scored = results.map((r, rank) => {
    const p = r.payload;

    // Base score from reciprocal rank (provider-agnostic).
    const base = 1 / (rank + 1);

    // Exact token boosts — scaled by hit count but capped per signal.
    const sourceHits   = tokenHits(p.source_file, tokens);
    const sectionHits  = tokenHits(p.section, tokens);
    const tagsHits     = p.tags ? p.tags.reduce((s, t) => s + tokenHits(t, tokens), 0) : 0;
    const textHits     = tokenHits(p.text, tokens);

    const boostSource  = Math.min(sourceHits  * BOOST_SOURCE_FILE, BOOST_SOURCE_FILE  * 3);
    const boostSection = Math.min(sectionHits * BOOST_SECTION,     BOOST_SECTION      * 3);
    const boostTags    = Math.min(tagsHits    * BOOST_TAGS,        BOOST_TAGS         * 3);
    const boostText    = Math.min(textHits    * BOOST_TEXT,        BOOST_TEXT         * 5);

    // Backlink count boost.
    const backlinkCount = graph[p.source_file]?.backlinks?.length ?? 0;
    const boostBacklink = Math.min(backlinkCount * BOOST_BACKLINK, BOOST_BACKLINK * 5);

    // Diversity penalty: penalize later chunks from the same source_file.
    const fileCount = seenFiles.get(p.source_file) ?? 0;
    const penaltyIdx = Math.min(fileCount, DIVERSITY_PENALTIES.length - 1);
    const penalty = DIVERSITY_PENALTIES[penaltyIdx];
    seenFiles.set(p.source_file, fileCount + 1);

    const totalBoost = boostSource + boostSection + boostTags + boostText + boostBacklink;
    const finalScore = base + totalBoost - penalty;

    if (DEBUG) {
      console.error(
        `[rerank] ${p.source_file}›${p.section ?? ''}  ` +
        `rank=${rank + 1} base=${base.toFixed(4)} ` +
        `+src=${boostSource.toFixed(3)} +sec=${boostSection.toFixed(3)} ` +
        `+tags=${boostTags.toFixed(3)} +text=${boostText.toFixed(3)} ` +
        `+bl=${boostBacklink.toFixed(3)} -div=${penalty.toFixed(3)} ` +
        `=> ${finalScore.toFixed(4)}`
      );
    }

    return { result: r, finalScore, rank };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored.slice(0, limit).map(s => s.result);
}
