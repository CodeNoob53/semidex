// Storage backend capability flags. Pure constants — no env, no network, no
// backend-specific imports. The Local API / UI gate any backend-specific
// feature (snapshots, aliases, hybrid search) on these flags, never on
// adapter.name() === 'qdrant' (design doc §14 review checklist).

export const DEFAULT_CAPABILITIES = Object.freeze({
  namedVectors:         false,
  sparseVectors:        false,
  hybridSearch:         false,
  payloadIndexes:       false,
  aliases:              false,
  snapshots:            false,
  collectionExists:     false,
  // Optional: adapter.getStructuralNeighbors() exists and resolves bounded
  // depth-1 structural neighbors (section siblings, previous/next content
  // node) for a skeleton-aware chunk via indexed lookups — never an
  // exhaustive scan. Consulted only by src/core/retrieval/graph-expand.js
  // when GRAPH_EXPANSION_ENABLED is true; an adapter reporting false here
  // (the default) is simply never asked, and ordinary hybrid retrieval is
  // unaffected either way (graph-expanded-retrieval.md's "adapter that does
  // not support structural expansion ... must not break ordinary hybrid
  // retrieval").
  structuralExpansion: false,
});

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CAPABILITIES));

/**
 * Merge capability overrides onto the defaults. Unknown keys are ignored
 * (deliberately, not rejected): a StorageAdapter written against a newer
 * capability set than the currently-installed semidex version should not
 * crash callers on older semidex builds — it should just not see the new
 * flag. Never mutates DEFAULT_CAPABILITIES.
 *
 * @param {Object} [overrides]
 * @returns {Object} a new capabilities object
 */
export function mergeCapabilities(overrides = {}) {
  const merged = { ...DEFAULT_CAPABILITIES };
  for (const [key, value] of Object.entries(overrides)) {
    if (KNOWN_KEYS.has(key)) merged[key] = value;
  }
  return merged;
}
