/**
 * Deterministic tie-break sort for custom-50 benchmark result lists.
 *
 * Qdrant RRF scores for near-equal points can swap adjacent ranks between
 * runs on the same byte-identical index (search-ordering noise). Sorting
 * after retrieval removes this source of MRR/nDCG variance.
 *
 * Sort order:
 *   1. score descending       (primary — preserves retrieval ranking)
 *   2. source_file ascending  (secondary — alphabetic tie-break)
 *   3. chunk_index ascending  (tertiary — earlier chunk wins)
 *   4. point id ascending     (quaternary — UUID string order, last resort)
 *
 * This is benchmark-only. Production MCP result ordering is unchanged.
 */
export function stableSortResults(results) {
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
