// Storage backend capability flags. Pure constants — no env, no network, no
// backend-specific imports. The Local API / UI gate any backend-specific
// feature (snapshots, aliases, hybrid search) on these flags, never on
// adapter.name() === 'qdrant' (design doc §14 review checklist).

export const DEFAULT_CAPABILITIES = Object.freeze({
  namedVectors:     false,
  sparseVectors:    false,
  hybridSearch:     false,
  payloadIndexes:   false,
  aliases:          false,
  snapshots:        false,
  collectionExists: false,
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
