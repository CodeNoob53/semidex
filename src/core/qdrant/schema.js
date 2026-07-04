// Canonical semidex collection schema. Pure constants — no env, no network.
//
// Single source of truth for the vector schema and required payload indexes.
// Used by store.createCollection (new collections) and by sync.js (idempotent
// backfill onto existing collections). Do not duplicate these lists elsewhere.

/** Named-vector schema for a semidex collection. */
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
