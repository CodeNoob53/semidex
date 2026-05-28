// Entity-boost experiment helpers for custom-50 benchmark only.
// This is not production retrieval code.

import { extractEntities } from '../../../src/indexer/phases/entities.js';

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

export function entityOverlap(queryTokens, chunkPayload) {
  const e = chunkPayload?.entities;
  if (!e || !queryTokens.size) return 0;
  const chunkTokens = [
    ...(e.paths ?? []),
    ...(e.symbols ?? []),
    ...(e.env_vars ?? []),
    ...(e.commands ?? []),
  ];
  let count = 0;
  for (const t of chunkTokens) {
    if (queryTokens.has(t)) count++;
  }
  return count;
}

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

export function applyEntityBoost(candidates, queryTokens, boostWeight) {
  const boosted = candidates.map(r => {
    const overlap = entityOverlap(queryTokens, r.payload);
    return overlap > 0
      ? { ...r, score: (r.score ?? 0) + boostWeight * overlap }
      : r;
  });
  return sortByScore(boosted);
}
