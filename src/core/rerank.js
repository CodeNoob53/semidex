import 'dotenv/config';
import { envInt } from './env.js';

function envFloat(name, defaultVal, min, max) {
  const v = parseFloat(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      console.warn(`[rerank] ${name}="${process.env[name]}" is invalid — using default ${defaultVal}`);
    return defaultVal;
  }
  return v;
}

// Common function words that carry no discriminative signal across documents.
const STOPWORDS = new Set([
  // Ukrainian
  'як', 'що', 'чому', 'коли', 'де', 'без', 'на', 'у', 'в', 'з', 'для', 'про',
  'це', 'та', 'і', 'або', 'але', 'якщо', 'то', 'не', 'по', 'до', 'від', 'при',
  // English
  'how', 'what', 'why', 'when', 'where', 'without', 'with', 'in', 'on', 'for',
  'to', 'the', 'a', 'an', 'of', 'and', 'or', 'but', 'if', 'is', 'are', 'was',
  'be', 'by', 'at', 'from', 'not', 'no', 'it', 'its', 'as', 'this', 'that',
]);

// A token is "technical" if it looks like an identifier rather than a prose word.
// Technical tokens get higher weight in text/section/tags boosts.
function isTechnical(token) {
  return (
    token.includes('_') ||           // snake_case: ONNX_EMBED, source_file
    /[A-Z]{2,}/.test(token) ||       // uppercase acronym: RRF, MRR, ONNX
    /[a-z][A-Z]/.test(token) ||      // camelCase: denseProvider, splitSentences
    token.length >= 8                 // long tokens are rarely stop-words
  );
}

// Tokenize query: Unicode-aware, stopwords removed, each token tagged as technical or not.
function queryTokens(query) {
  const raw = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const result = new Map(); // token → isTechnical
  for (const t of raw) {
    const lower = t.toLowerCase();
    if (!STOPWORDS.has(lower)) result.set(lower, isTechnical(t));
  }
  return result;
}

// Count weighted token hits in a string: technical tokens score TECH_MULT times more.
const TECH_MULT = 3;

function tokenHits(str, tokens) {
  if (!str || !tokens.size) return 0;
  const words = str.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  let score = 0;
  for (const w of words) {
    const tech = tokens.get(w);
    if (tech !== undefined) score += tech ? TECH_MULT : 1;
  }
  return score;
}

// Diversity penalty applied during greedy selection: 1st reuse, 2nd reuse, 3rd+ reuse.
const DIVERSITY_PENALTIES = [0.05, 0.10, 0.15];

const BOOST_SOURCE_FILE  = envFloat('RERANK_BOOST_SOURCE_FILE', 0.08, 0, 10);
const BOOST_SECTION      = envFloat('RERANK_BOOST_SECTION',     0.06, 0, 10);
const BOOST_TAGS         = envFloat('RERANK_BOOST_TAGS',        0.05, 0, 10);
const BOOST_TEXT         = envFloat('RERANK_BOOST_TEXT',        0.01, 0, 10);
const BASE_WEIGHT        = envFloat('RERANK_BASE_WEIGHT',       1.00, 0, 10);
// Minimum score advantage rerank must gain over rank-1 to displace it.
const PROTECT_TOP1_DELTA = envFloat('RERANK_PROTECT_TOP1_DELTA', 0.05, 0, 10);
// Experimental: bonus when ≥1 non-stopword query token (technical ones weighted higher) appears
// in first TEXT_LEAD_CHARS of chunk text. Rewards chunks that answer the query up-front.
const BOOST_TEXT_LEAD    = envFloat('RERANK_BOOST_TEXT_LEAD',   0.00, 0, 10);
const TEXT_LEAD_CHARS    = envInt('RERANK_TEXT_LEAD_CHARS',     200,  1, 10000, '[rerank] ');
// Experimental: small penalty for chunk_index=0 when query has ≥2 technical tokens.
// Discourages overview/intro chunks from ranking above specific content for technical queries.
const PENALTY_INTRO_CHUNK  = envFloat('RERANK_PENALTY_INTRO_CHUNK',  0.02, 0, 10);
const INTRO_CHUNK_TECH_MIN = envInt('RERANK_INTRO_CHUNK_TECH_MIN',   2,    1, 100, '[rerank] ');
const DEBUG              = process.env.RERANK_DEBUG === '1';

/**
 * Rerank results using deterministic signals on top of Qdrant RRF.
 *
 * @param {Array}  results     - Qdrant search results (each with .payload, .score)
 * @param {string} query       - The search query
 * @param {Object} opts
 * @param {number} opts.finalLimit   - How many to return (default: results.length)
 * @returns {Array} Reranked, trimmed to finalLimit.
 */
export function rerankResults(results, query, { finalLimit } = {}) {
  if (!results.length) return results;
  const limit = finalLimit ?? results.length;
  const tokens = queryTokens(query); // Map<lowerToken, isTechnical>

  // Phase 1: score each candidate (base + boosts, no diversity yet).
  const scored = results.map((r, rank) => {
    const p = r.payload;

    const base = BASE_WEIGHT * (1 / (rank + 1));

    const sourceHits   = tokenHits(p.source_file, tokens);
    const sectionHits  = tokenHits(p.section, tokens);
    const tagsHits     = p.tags ? p.tags.reduce((s, t) => s + tokenHits(t, tokens), 0) : 0;
    const textHits     = tokenHits(p.text, tokens);

    const boostSource  = Math.min(sourceHits  * BOOST_SOURCE_FILE, BOOST_SOURCE_FILE  * 3);
    const boostSection = Math.min(sectionHits * BOOST_SECTION,     BOOST_SECTION      * 3);
    const boostTags    = Math.min(tagsHits    * BOOST_TAGS,        BOOST_TAGS         * 3);
    const boostText    = Math.min(textHits    * BOOST_TEXT,        BOOST_TEXT         * 5);

    // Experimental: text-lead boost — reward early appearance of non-stopword query tokens
    // (technical tokens weighted higher via tokenHits).
    let boostTextLead = 0;
    if (BOOST_TEXT_LEAD > 0 && p.text && tokens.size) {
      const lead = p.text.slice(0, TEXT_LEAD_CHARS);
      const leadHits = tokenHits(lead, tokens);
      if (leadHits > 0) boostTextLead = Math.min(leadHits * BOOST_TEXT_LEAD, BOOST_TEXT_LEAD * 3);
    }

    // Experimental: intro-chunk penalty — demote chunk_index=0 for specific technical queries.
    let penaltyIntroChunk = 0;
    if (PENALTY_INTRO_CHUNK > 0) {
      const techCount = [...tokens.values()].filter(Boolean).length;
      if (p.chunk_index === 0 && techCount >= INTRO_CHUNK_TECH_MIN) {
        penaltyIntroChunk = PENALTY_INTRO_CHUNK;
      }
    }

    const baseScore = base + boostSource + boostSection + boostTags + boostText +
      boostTextLead - penaltyIntroChunk;

    if (DEBUG) {
      console.error(
        `[rerank] ${p.source_file}›${p.section ?? ''}  ` +
        `rank=${rank + 1} base=${base.toFixed(4)} ` +
        `+src=${boostSource.toFixed(3)} +sec=${boostSection.toFixed(3)} ` +
        `+tags=${boostTags.toFixed(3)} +text=${boostText.toFixed(3)} ` +
        `+lead=${boostTextLead.toFixed(3)} ` +
        `-intro=${penaltyIntroChunk.toFixed(3)} => baseScore=${baseScore.toFixed(4)}`
      );
    }

    return { result: r, baseScore, rank };
  });

  // Phase 2: greedy selection with diversity penalty applied to each pick's effective score.

  // Capture original RRF rank-0 by identity BEFORE sort, so protection targets the
  // actual Qdrant top result, not whoever won the rerank scoring pass.
  const originalTop = scored.find(s => s.rank === 0);

  scored.sort((a, b) => b.baseScore - a.baseScore);

  // Top-1 protection: only allow displacing the original RRF rank-0 result when the
  // rerank challenger's advantage exceeds PROTECT_TOP1_DELTA. Compared by object
  // identity (not source_file) so a different chunk from the same file doesn't
  // accidentally satisfy the protection.
  const challenger = scored.find(s => s !== originalTop);
  const top1Protected =
    PROTECT_TOP1_DELTA > 0 &&
    originalTop !== undefined &&
    challenger !== undefined &&
    challenger.baseScore - originalTop.baseScore < PROTECT_TOP1_DELTA;

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
      // Force the original RRF #1 result into position 0 when protection is active.
      const forcedPenalty = (top1Protected && selected.length === 0 && remaining[i] !== originalTop) ? 1e9 : 0;
      const effective = baseScore - penalty - forcedPenalty;
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
