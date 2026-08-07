// Idempotent per-collection schema repair: required payload indexes +
// sparse-vector support. Shared by src/sync.js (CLI) and the storage adapter
// (src/core/storage/qdrant-adapter.js) so the repair logic exists once.
//
// Does not touch config.json — that bookkeeping (provider metadata,
// collection list diffing) is sync.js's own concern, not a storage-layer one.
import { getCollectionInfo, createPayloadIndex, addSparseVectorSupport, hasSparseVectors } from './store.js';
import { REQUIRED_PAYLOAD_INDEXES } from './schema.js';
import { classifyVectorSchema } from '../../shared/core/doctor-checks.js';

/**
 * Ensure a single collection has the required payload indexes and sparse
 * vector support. Safe to re-run.
 *
 * @param {string} name
 * @param {{
 *   collectionInfo?: object,   // pass an already-fetched getCollectionInfo()
 *                              // result to avoid a redundant network call
 *                              // when the caller (e.g. sync.js) already
 *                              // needs it for other bookkeeping.
 *   deps?: {                   // injectable store functions — defaults to
 *     getCollectionInfo, createPayloadIndex, addSparseVectorSupport,
 *     hasSparseVectors,        // the real store.js implementations; tests
 *   },                         // pass stubs here to run offline.
 * }} [options]
 * @returns {Promise<{ repaired: string[], warnings: string[] }>}
 */
export async function ensureCollectionSchema(name, options = {}) {
  const deps = {
    getCollectionInfo, createPayloadIndex, addSparseVectorSupport, hasSparseVectors,
    ...options.deps,
  };
  const repaired = [];
  const warnings = [];

  const info = options.collectionInfo ?? await deps.getCollectionInfo(name);
  const vectorsCfg = info.config?.params?.vectors ?? {};
  const vectorSchema = classifyVectorSchema(vectorsCfg);
  const isFlatSchema = vectorSchema === 'flat';

  if (isFlatSchema) {
    warnings.push(
      `LEGACY SCHEMA: "${name}" uses a flat (unnamed) vector — hybrid search unavailable. ` +
      `Cannot repair in-place; delete and reindex the collection.`
    );
  } else if (vectorSchema !== 'named') {
    warnings.push(`FOREIGN SCHEMA: "${name}" has no named 'dense' vector — hybrid search unavailable.`);
  }

  for (const [field, schema] of Object.entries(REQUIRED_PAYLOAD_INDEXES)) {
    await deps.createPayloadIndex(name, field, schema);
    repaired.push(`index "${field}" (${schema})`);
  }

  if (isFlatSchema) {
    warnings.push(`Skipped sparse vector check on "${name}" (legacy flat schema — reindex required).`);
  } else {
    try {
      await deps.addSparseVectorSupport(name);
      repaired.push('sparse vector support');
    } catch {
      // Already present — not a repair action, not an error.
    }

    const hasSparsePts = await deps.hasSparseVectors(name);
    if (!hasSparsePts) {
      warnings.push(
        `"${name}" has no sparse vectors on existing points. Hybrid search will behave as ` +
        `dense-only until you re-index.`
      );
    }
  }

  return { repaired, warnings };
}
