// Shared embedding-profile resolution for benchmark scripts — mirrors
// src/indexer/run.js's own new-vs-existing-collection resolution exactly,
// so every benchmark gets a real resolved profile object instead of a bare
// collection name string. embedForIndex/embedForIndexBatch/embedForSearch
// (src/core/embeddings.js) require a resolved profile as their first
// argument, not a collection name — passing a name silently reads
// `undefined.dense` deep inside embeddings.js.
//
// Usage in a benchmark script:
//   import { resolveBenchProfile } from '../../lib/resolve-profile.js';
//   const profile = await resolveBenchProfile(adapter, COLLECTION, { vectorSize: 1024 });
//   const { dense, sparse, meta } = await embedForIndex(profile, chunk.text);
//   const { dense, sparse } = await embedForSearch(profile, queryText);
import { resolveExistingCollectionProfile, resolveNewCollectionProfile } from '../../src/core/embedding-profile/resolve.js';
import { resolveEnvProviders } from '../../src/shared/core/config.js';
import { SCHEMA_VERSION } from '../../src/shared/core/embeddings.js';

/**
 * Resolves (or creates) the embedding profile for a benchmark collection.
 *
 * - If the collection already exists with a valid native profile, that
 *   profile is reused as-is (never re-derived from current env — a
 *   benchmark re-run must query with the SAME model the collection was
 *   actually indexed with, exactly like production indexing/search).
 * - If the collection doesn't exist yet, a fresh profile is resolved from
 *   the current env (honoring BENCH_PROVIDER's process.env.ONNX_EMBED
 *   override, applied by the caller before this runs) and the collection is
 *   created with that profile via adapter.createCollection().
 * - If the collection exists but has no valid profile (legacy/unmigrated —
 *   should not happen for benchmark-owned collections, which are always
 *   created through this helper), this throws rather than guessing, same
 *   as the indexer's own fail-fast behavior.
 *
 * @param {import('../../src/core/storage/adapter.js').StorageAdapter} adapter
 * @param {string} collection
 * @param {{ vectorSize: number }} opts
 * @returns {Promise<Object>} a resolved embedding profile
 */
export async function resolveBenchProfile(adapter, collection, { vectorSize }) {
  const existing = await adapter.getCollection(collection);
  if (!existing) {
    const profile = resolveNewCollectionProfile(resolveEnvProviders(), {
      vectorSize,
      embeddingSchemaVersion: SCHEMA_VERSION,
    });
    await adapter.createCollection(collection, { profile });
    return profile;
  }

  const resolution = await resolveExistingCollectionProfile(adapter, collection);
  if (!resolution.resolved) {
    throw new Error(
      `resolveBenchProfile: collection "${collection}" exists but has no resolvable embedding profile ` +
      `(reason: ${resolution.reason}). Benchmark collections are expected to always carry a valid profile ` +
      `since they're only ever created through this helper — delete the collection and re-run to recreate it cleanly.`
    );
  }
  return resolution.profile;
}
