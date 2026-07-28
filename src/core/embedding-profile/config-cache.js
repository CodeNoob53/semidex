// Pure helper: derives a config.json collection entry from an already-
// resolved embedding profile. Used by src/sync.js (npm run sync) so its
// "profile in, config.json entry out" logic is independently unit-testable
// without spinning up the sync.js top-level script (which bootstraps env
// and Qdrant at import time, per its own header comment). config.json is a
// CACHE of the resolved profile — this function never makes an identity
// decision itself, it only projects an already-resolved profile into the
// config.json shape.
export function resolveCollectionConfigEntry(profile, existingEntry) {
  return {
    denseProvider: profile.embedding.dense.provider,
    denseModel: profile.embedding.dense.model,
    sparseProvider: profile.embedding.sparse?.provider ?? null,
    embeddingSchemaVersion: profile.embeddingSchemaVersion,
    vectorSize: profile.embedding.dense.dimensions,
    description: existingEntry?.description ?? '',
  };
}
