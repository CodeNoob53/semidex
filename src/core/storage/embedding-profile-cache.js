// Dedicated resolved-profile cache for the Qdrant storage adapter's
// getEmbeddingProfile() — deliberately NOT a cache of the whole
// getCollection() response, and deliberately a fixed internal TTL constant
// in this task (not an env-configurable knob; see createQdrantStorageAdapter).
//
// Caches only the typed resolved-profile RESULT (valid/missing/invalid/
// unsupported_schema_version) — a short TTL entry for a non-'valid' result
// is fine (avoids hammering Qdrant on every query against a broken
// collection) but always re-resolves after expiry; never a permanent
// negative cache.
const DEFAULT_TTL_MS = 20_000;

export function createProfileCache({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const entries = new Map();

  return {
    get(name) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      if (Date.now() >= entry.expiresAt) {
        entries.delete(name);
        return undefined;
      }
      return entry.value;
    },
    set(name, value) {
      entries.set(name, { value, expiresAt: Date.now() + ttlMs });
    },
    invalidate(name) {
      entries.delete(name);
    },
    invalidateAll() {
      entries.clear();
    },
  };
}
