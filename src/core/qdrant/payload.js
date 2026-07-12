// Pure payload helpers and payload field constants. No env, no network, no
// SDK import — this module must stay importable from anywhere (smoke tests,
// sync, future semidex lite) without any Qdrant configuration.

// Fields that identify a semidex-managed point. Used by sync to skip foreign
// collections that happen to share a Qdrant instance.
export const SEMIDEX_PAYLOAD_FIELDS = [
  'source_file', 'chunk_index', 'file_hash',
  'dense_provider', 'dense_model', 'sparse_provider',
  'embedding_schema_version', 'vector_size',
  'chunking_schema_version', 'token_count_mode',
];

export function isSemidexPayload(payload) {
  if (typeof payload !== 'object' || payload === null) return false;
  return SEMIDEX_PAYLOAD_FIELDS.every(f => f in payload);
}

// Payload fields returned for skeleton_nav points. Nav lookups never return
// vectors or retrieval text.
export const NAV_PAYLOAD_FIELDS = [
  'point_kind', 'node_type', 'node_id', 'node_path', 'parent_id',
  'summary', 'children', 'source_file', 'heading_path', 'inventory',
  'summary_kind', 'summary_version', 'key_topics', 'notable_terms', 'child_overview',
];

// Payload fields returned for structural content nodes (table, code_block,
// checklist, image, paragraph …). entity_refs is here because getFileChunks/
// getSectionChunks project through this list — without it, prose chunks'
// stored structural references (Phase 3U) would silently never reach the
// adapter's toChunk() mapping, even though toChunk() supports them.
export const CONTENT_NODE_FIELDS = [
  'point_kind', 'node_type', 'node_id', 'node_path', 'parent_id',
  'source_file', 'heading_path', 'chunk_index', 'section',
  'lang', 'context', 'summary', 'text', 'raw_content', 'rawContent',
  'entity_refs',
];
