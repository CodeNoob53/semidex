// Shared entity boost logic — used by src/mcp/tools/search.js and bench scripts.
// No side effects. All functions are pure / deterministic.

import { extractEntities } from '../indexer/phases/entities.js';

/**
 * Extract entity tokens from a query string for overlap comparison.
 * Unions paths, symbols, env_vars, and commands extracted by the same regex
 * extractor used at index time. heading_path and doc_role are not matchable
 * query tokens and are excluded.
 *
 * @param {string} queryText
 * @returns {Set<string>}
 */
export function queryEntityTokens(queryText) {
  const { entities } = extractEntities({
    text: queryText,
    section: '',
    source_file: '',
  });
  return new Set([
    ...entities.paths,
    ...entities.symbols,
    ...entities.env_vars,
    ...entities.commands,
  ]);
}

/**
 * Count overlapping entity tokens between a query token set and a chunk's
 * stored entity payload. Returns 0 if payload.entities is absent (graceful
 * no-op for collections indexed before entity support was added).
 *
 * @param {Set<string>} queryTokens
 * @param {object} chunkPayload  — the Qdrant point payload object
 * @returns {number}
 */
export function entityOverlap(queryTokens, chunkPayload) {
  const e = chunkPayload?.entities;
  if (!e || !queryTokens.size) return 0;
  const chunkTokens = [
    ...(e.paths      ?? []),
    ...(e.symbols    ?? []),
    ...(e.env_vars   ?? []),
    ...(e.commands   ?? []),
  ];
  let count = 0;
  for (const t of chunkTokens) {
    if (queryTokens.has(t)) count++;
  }
  return count;
}

// Score-descending stable sort with deterministic tie-breaks.
// Mirrors the benchmark sort-results.js logic without the cross-boundary import.
function sortByScore(results) {
  return results.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const sfA = a.payload?.source_file ?? '';
    const sfB = b.payload?.source_file ?? '';
    if (sfA !== sfB) return sfA < sfB ? -1 : 1;
    const ciA = a.payload?.chunk_index ?? 0;
    const ciB = b.payload?.chunk_index ?? 0;
    if (ciA !== ciB) return ciA - ciB;
    const idA = String(a.id ?? '');
    const idB = String(b.id ?? '');
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
}

/**
 * Apply entity overlap boost to a candidate list and stable-sort.
 *
 * finalScore = rrfScore + boostWeight × |queryEntities ∩ chunkEntities|
 *
 * Candidates with no entity overlap are unaffected (bonus = 0).
 * Collections without entity payload gracefully produce overlap = 0 for all
 * points, leaving the ranking identical to the unmodified hybridSearch output.
 *
 * @param {object[]} candidates  — Qdrant result points, each with .score and .payload
 * @param {Set<string>} queryTokens
 * @param {number} boostWeight
 * @returns {object[]}  new array; input is not mutated
 */
export function applyEntityBoost(candidates, queryTokens, boostWeight) {
  const boosted = candidates.map(r => {
    const overlap = entityOverlap(queryTokens, r.payload);
    return overlap > 0
      ? { ...r, score: (r.score ?? 0) + boostWeight * overlap }
      : r;
  });
  return sortByScore(boosted);
}
