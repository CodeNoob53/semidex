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

// Tokenize query into lowercase terms for exact-token matching (Unicode-aware).
function queryTokens(query) {
  return new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

// Count how many query tokens appear in a string (case-insensitive, Unicode-aware).
function tokenHits(str, tokens) {
  if (!str) return 0;
  const words = str.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.filter(w => tokens.has(w)).length;
}

// Diversity penalty applied during greedy selection: 1st reuse, 2nd reuse, 3rd+ reuse.
const DIVERSITY_PENALTIES = [0.05, 0.10, 0.15];

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

  // Phase 1: score each candidate (base + boosts, no diversity yet).
  const scored = results.map((r, rank) => {
    const p = r.payload;

    const base = 1 / (rank + 1);

    const sourceHits   = tokenHits(p.source_file, tokens);
    const sectionHits  = tokenHits(p.section, tokens);
    const tagsHits     = p.tags ? p.tags.reduce((s, t) => s + tokenHits(t, tokens), 0) : 0;
    const textHits     = tokenHits(p.text, tokens);

    const boostSource  = Math.min(sourceHits  * BOOST_SOURCE_FILE, BOOST_SOURCE_FILE  * 3);
    const boostSection = Math.min(sectionHits * BOOST_SECTION,     BOOST_SECTION      * 3);
    const boostTags    = Math.min(tagsHits    * BOOST_TAGS,        BOOST_TAGS         * 3);
    const boostText    = Math.min(textHits    * BOOST_TEXT,        BOOST_TEXT         * 5);

    const backlinkCount = graph[p.source_file]?.backlinks?.length ?? 0;
    const boostBacklink = Math.min(backlinkCount * BOOST_BACKLINK, BOOST_BACKLINK * 5);

    const baseScore = base + boostSource + boostSection + boostTags + boostText + boostBacklink;

    if (DEBUG) {
      console.error(
        `[rerank] ${p.source_file}›${p.section ?? ''}  ` +
        `rank=${rank + 1} base=${base.toFixed(4)} ` +
        `+src=${boostSource.toFixed(3)} +sec=${boostSection.toFixed(3)} ` +
        `+tags=${boostTags.toFixed(3)} +text=${boostText.toFixed(3)} ` +
        `+bl=${boostBacklink.toFixed(3)} => baseScore=${baseScore.toFixed(4)}`
      );
    }

    return { result: r, baseScore, rank };
  });

  // Phase 2: greedy selection with diversity penalty applied to each pick's effective score.
  // At each step we pick the candidate with the highest (baseScore - diversityPenalty),
  // where the penalty depends on how many chunks from that file are already selected.
  scored.sort((a, b) => b.baseScore - a.baseScore);
  const selected = [];
  const pickedFileCounts = new Map(); // source_file → count selected so far
  const remaining = [...scored];

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestEffective = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const { result, baseScore } = remaining[i];
      const sf = result.payload?.source_file;
      const alreadyPicked = pickedFileCounts.get(sf) ?? 0;
      const penaltyIdx = Math.min(alreadyPicked, DIVERSITY_PENALTIES.length) - 1;
      const penalty = alreadyPicked > 0 ? DIVERSITY_PENALTIES[penaltyIdx] : 0;
      const effective = baseScore - penalty;
      if (effective > bestEffective) { bestEffective = effective; bestIdx = i; }
    }

    const { result } = remaining[bestIdx];
    const sf = result.payload?.source_file;
    pickedFileCounts.set(sf, (pickedFileCounts.get(sf) ?? 0) + 1);

    if (DEBUG) {
      console.error(`[rerank] selected #${selected.length + 1}: ${sf} effective=${bestEffective.toFixed(4)}`);
    }

    selected.push({ result, finalScore: bestEffective });
    remaining.splice(bestIdx, 1);
  }

  return selected.map(s => ({ ...s.result, score: s.finalScore }));
}
