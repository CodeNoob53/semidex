// Canonical semidex collection schema. Pure constants — no env, no network.
//
// Single source of truth for the vector schema and required payload indexes.
// Used by store.createCollection (new collections) and by sync.js (idempotent
// backfill onto existing collections). Do not duplicate these lists elsewhere.

/**
 * DEFAULT named-vector schema for a semidex collection (Cosine distance,
 * dense+sparse, no sparse modifier) — used only when store.createCollection()
 * is called WITHOUT a profile-derived vectorSchema (a bare-size call, e.g.
 * from a test fixture). The real, profile-driven creation path
 * (src/core/storage/qdrant-adapter.js's buildQdrantVectorSchemaFromProfile())
 * builds the schema from the collection's own resolved embedding profile
 * instead of this hardcoded default, so a profile with a non-Cosine
 * distance, no sparse lane, or a sparse modifier is honored exactly as
 * declared, not silently overridden by this default.
 */
export function collectionVectorSchema(size = 1024) {
  return {
    vectors: { dense: { size, distance: 'Cosine' } },
    sparse_vectors: { sparse: { index: { on_disk: false } } },
  };
}

/** Sparse-vector schema alone — used when patching sparse support onto an
 *  older dense-only collection. */
export const SPARSE_VECTOR_SCHEMA = { sparse: { index: { on_disk: false } } };

/** Required payload indexes for MCP filters, hash-based skip, and skeleton
 *  navigation. field → field_schema. */
export const REQUIRED_PAYLOAD_INDEXES = {
  source_file: 'keyword',
  tags:        'keyword',
  chunk_index: 'integer',
  // Skeleton-first (impl spec §5) — idempotent backfill onto existing collections.
  point_kind:  'keyword',
  node_type:   'keyword',
  node_id:     'keyword',
  node_path:   'keyword',
  // Admin UI (Phase 2E): resolving a section nav node to its first content
  // chunk (getFirstContentChunkByParent) filters by parent_id — without an
  // index this degrades to a full collection scan on every sidebar click.
  parent_id:   'keyword',
};
