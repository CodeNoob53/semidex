// Tests for skeletonPayloadFields()'s entity_refs handling (Phase 3U) —
// separate from tests/unit/core/storage/qdrant-adapter.test.js's coverage
// of the READ side (payload -> domain Chunk.entityRefs); this file covers
// the WRITE side (chunk.entity_refs -> Qdrant payload field).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { skeletonPayloadFields, INDEXING_SCHEMA_VERSION_BASE } from '../../../src/shared/indexer/skeleton-payload.js';

const BASE_SKELETON_CHUNK = {
  chunking_model: 'skeleton-v1',
  point_kind: 'retrieval_content',
  node_type: 'paragraph',
  node_id: 'n1',
  node_path: 'a.md#setup/paragraph-1',
  raw_content: 'Configuration options below.',
};

describe('skeletonPayloadFields — entity_refs (Phase 3U)', () => {
  it('writes entity_refs when the chunk carries one or more references', () => {
    const refs = [{ node_id: 'nt1', node_path: 'a.md#setup/table-1', node_type: 'table', placeholder: '[table node: a.md#setup/table-1 — A | B]' }];
    const fields = skeletonPayloadFields({ ...BASE_SKELETON_CHUNK, entity_refs: refs });
    assert.deepEqual(fields.entity_refs, refs);
  });

  it('omits the entity_refs key entirely when the chunk has none (not an empty array)', () => {
    const fields = skeletonPayloadFields({ ...BASE_SKELETON_CHUNK });
    assert.equal('entity_refs' in fields, false, 'entity_refs must be absent, not present-and-empty, for a chunk with no references');
  });

  it('omits entity_refs when the chunk explicitly carries an empty array', () => {
    const fields = skeletonPayloadFields({ ...BASE_SKELETON_CHUNK, entity_refs: [] });
    assert.equal('entity_refs' in fields, false);
  });

  it('a structural (table/code_block/checklist) chunk never carries entity_refs, and skeletonPayloadFields reflects that absence', () => {
    const fields = skeletonPayloadFields({ ...BASE_SKELETON_CHUNK, node_type: 'table' });
    assert.equal('entity_refs' in fields, false);
  });

  it('a legacy (non-skeleton) chunk gets no fields at all, entity_refs included', () => {
    const fields = skeletonPayloadFields({ node_type: 'paragraph', entity_refs: [{ node_id: 'x' }] });
    assert.deepEqual(fields, {});
  });

  it('entity_refs presence/absence never changes which INDEXING_SCHEMA_VERSION a chunk is stamped with — it is additive payload metadata, not a schema-bumping change (see Schema Decision)', () => {
    const withRefs = skeletonPayloadFields({
      ...BASE_SKELETON_CHUNK,
      entity_refs: [{ node_id: 'nt1', node_path: 'a.md#setup/table-1', node_type: 'table', placeholder: '[table node: a.md#setup/table-1 — A | B]' }],
    });
    const withoutRefs = skeletonPayloadFields({ ...BASE_SKELETON_CHUNK });
    assert.equal(withRefs.indexing_schema_version, INDEXING_SCHEMA_VERSION_BASE);
    assert.equal(withoutRefs.indexing_schema_version, INDEXING_SCHEMA_VERSION_BASE);
  });
});
