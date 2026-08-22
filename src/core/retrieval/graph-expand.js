// Graph-expanded retrieval coordinator (docs/design/graph-expanded-retrieval.md,
// docs/tasks/graph-expanded-retrieval-step1.md) — provider-neutral, depth-1
// bounded structural expansion of a hybrid-search seed pool. Called ONLY by
// src/core/retrieval/search.js's runHybridSearch() when
// GRAPH_EXPANSION_ENABLED resolves true, so Admin search, Ask, and MCP all
// see identical expansion behavior from one implementation, exactly like
// they already share one hybrid-search implementation.
//
// This module never imports Qdrant-specific code — it only calls the
// optional, narrow adapter.getStructuralNeighbors() capability (see
// src/core/storage/adapter.js / capabilities.js). An adapter without that
// capability makes expandSeedsWithGraph() a pure passthrough (seed order
// preserved, zero storage calls beyond the seed search already run) —
// "missing/broken graph identity degrades to seed-only retrieval" (design
// doc, Safety and correctness invariants).
//
// Only skeleton-aware seeds (hit.nodeId present) are ever expanded — legacy/
// no-skeleton collections and legacy hits within an otherwise skeleton-aware
// collection are left exactly as returned by hybrid search (design doc
// non-goal: "Expanding legacy collections that have no skeleton node
// identity").

/**
 * Deterministic, retrieval-score-independent total order used ONLY to break
 * ties between expanded candidates that inherit the same seed rank — never
 * used to compare a seed against another seed (seeds always keep their own
 * hybrid-search rank order).
 */
function stableDocumentOrder(a, b) {
  const sf = (a.sourceFile ?? '').localeCompare(b.sourceFile ?? '');
  if (sf !== 0) return sf;
  return (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0);
}

// Dedup key: prefer real node identity; fall back to sourceFile+chunkIndex
// ONLY for a real content point that carries no node identity at all (per
// the design doc's "Deduplicate candidates by nodeId, falling back to
// sourceFile + chunkIndex only for real content points without node
// identity"). A candidate lacking both a nodeId AND sourceFile/chunkIndex
// cannot occur for a real retrieval-content point (toChunk() always
// projects source_file/chunk_index), so this never collapses two distinct
// real chunks onto the same key.
function candidateKey(chunk) {
  return chunk.nodeId ? `node:${chunk.nodeId}` : `pos:${chunk.sourceFile}::${chunk.chunkIndex}`;
}

// Re-applies the caller's original search filter to an expanded candidate —
// "Filters and hard limits cannot be bypassed by expansion" (design doc,
// Mandatory constraints / Safety and correctness invariants). sourceFile is
// already structurally guaranteed for both relation kinds this coordinator
// resolves (a section's siblings and a file's prev/next chunk can never
// cross a source_file boundary — see getStructuralNeighbors()'s own
// contract), but this check stays defense-in-depth rather than an assumed
// invariant. tags are NOT structurally guaranteed to propagate to a
// structural neighbor, so this is the one check that can genuinely reject a
// real candidate.
function passesFilters(chunk, filters) {
  if (filters?.sourceFile && chunk.sourceFile !== filters.sourceFile) return false;
  if (filters?.tags?.length && !filters.tags.some((t) => chunk.tags?.includes(t))) return false;
  return true;
}

/**
 * @param {{
 *   adapter: import('../storage/adapter.js').StorageAdapter,
 *   collection: string,
 *   seeds: Object[],
 *   seedLimit: number,
 *   maxExpandedPerSeed: number,
 *   filters?: { sourceFile?: string, tags?: string[] },
 * }} opts
 * @returns {Promise<Array<{ chunk: Object, retrievalOrigin: 'seed'|'graph', seedRank: number, seedId: string, relationPath: string[], depth: 0|1 }>>}
 *   Ordered per the design doc's deterministic ranking rule: seed candidates
 *   retain their original seed order; each seed's own expanded candidates
 *   are emitted immediately after it (sorted by stable document order among
 *   themselves); a candidate reachable from multiple eligible seeds is kept
 *   under its BEST (lowest/earliest) seed rank only. Callers slice the
 *   result to their own final `top` — this function does not truncate to
 *   `top` itself, only to the seedLimit/maxExpandedPerSeed bounds.
 *
 *   Every entry carries full internal provenance (design doc,
 *   "Provenance"): `seedId` is the normalized identity (same shape as
 *   `candidateKey()` — `node:<nodeId>` or `pos:<sourceFile>::<chunkIndex>`,
 *   never the full seed chunk object) of the ORIGINATING seed a candidate is
 *   attributed to — for a seed entry itself, that's trivially its own
 *   identity; for a graph entry, it's the identity of whichever eligible
 *   seed produced its `seedRank` (the best/lowest-rank seed when reachable
 *   from more than one). `relationPath` is a depth-compatible sequence of
 *   relation hops from that seed to the candidate — `[]` for a seed
 *   (zero hops) and exactly one entry for a depth-1 graph candidate (this
 *   iteration's only supported depth); a future multi-hop implementation
 *   extends this array rather than replacing its shape.
 */
export async function expandSeedsWithGraph({ adapter, collection, seeds, seedLimit, maxExpandedPerSeed, filters = {} }) {
  const seedEntries = seeds.map((chunk, i) => ({
    chunk, retrievalOrigin: 'seed', seedRank: i, seedId: candidateKey(chunk), relationPath: [], depth: 0,
  }));

  const caps = typeof adapter.capabilities === 'function' ? adapter.capabilities() : {};
  if (!caps.structuralExpansion || typeof adapter.getStructuralNeighbors !== 'function') {
    return seedEntries;
  }

  const seedKeys = new Set(seedEntries.map((e) => candidateKey(e.chunk)));
  const eligibleSeeds = seedEntries.slice(0, Math.max(0, seedLimit));

  // key -> { chunk, bestRank, seedId, relationPath, depth } — bestRank is
  // the LOWEST (earliest) seedRank among every eligible seed that reached
  // this candidate, per the design doc's "expanded candidates inherit their
  // best seed rank." seedId/relationPath always describe the path via that
  // SAME best seed, never a mix of the best rank with a different seed's path.
  const graphMap = new Map();

  for (const seedEntry of eligibleSeeds) {
    const { chunk } = seedEntry;
    if (!chunk.nodeId) continue; // only skeleton-aware seeds are ever expanded

    let neighbors;
    try {
      neighbors = await adapter.getStructuralNeighbors(collection, {
        nodeId: chunk.nodeId,
        parentId: chunk.parentId ?? null,
        sourceFile: chunk.sourceFile,
        chunkIndex: chunk.chunkIndex,
        limit: maxExpandedPerSeed,
      });
    } catch {
      // A broken/failing graph lookup degrades to "no expansion for this
      // seed," never a failed search — matches the design doc's "missing/
      // broken graph identity degrades to seed-only retrieval."
      neighbors = [];
    }

    for (const { chunk: neighborChunk, relation } of neighbors ?? []) {
      if (!passesFilters(neighborChunk, filters)) continue;
      const key = candidateKey(neighborChunk);
      if (seedKeys.has(key)) continue; // never re-add a chunk that is already a seed
      const existing = graphMap.get(key);
      if (!existing || seedEntry.seedRank < existing.bestRank) {
        graphMap.set(key, {
          chunk: neighborChunk, bestRank: seedEntry.seedRank, seedId: seedEntry.seedId, relationPath: [relation], depth: 1,
        });
      }
    }
  }

  const graphEntries = [...graphMap.values()]
    .map((e) => ({
      chunk: e.chunk, retrievalOrigin: 'graph', seedRank: e.bestRank, seedId: e.seedId, relationPath: e.relationPath, depth: e.depth,
    }))
    .sort((a, b) => (a.seedRank - b.seedRank) || stableDocumentOrder(a.chunk, b.chunk));

  // Merge: emit every seed in its original order, immediately followed by
  // its own graph-expanded candidates (already globally sorted by seedRank
  // then stable document order, which groups them correctly since seedRank
  // values are unique integers matching seedEntries' own indices).
  const merged = [];
  let gi = 0;
  for (const seedEntry of seedEntries) {
    merged.push(seedEntry);
    while (gi < graphEntries.length && graphEntries[gi].seedRank === seedEntry.seedRank) {
      merged.push(graphEntries[gi]);
      gi++;
    }
  }
  while (gi < graphEntries.length) {
    merged.push(graphEntries[gi]);
    gi++;
  }

  return merged;
}
