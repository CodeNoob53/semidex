// Adapter-structure contract: pure submodule stays pure, facade re-exports
// the full public surface, client cache is resettable for tests.
// Deliberately does NOT import tests/helpers/setup.js — payload.js and the
// facade must be importable with no Qdrant env at all.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.QDRANT_URL;
delete process.env.QDRANT_KEY;

// payload.js must be pure: no dotenv, no SDK, no env reads.
const payload = await import('../../../src/core/qdrant/payload.js');
const schema = await import('../../../src/core/qdrant/schema.js');
const facade = await import('../../../src/shared/core/qdrant.js');

describe('payload.js is pure', () => {
  it('isSemidexPayload works with no env at all', () => {
    assert.equal(payload.isSemidexPayload({}), false);
    assert.equal(payload.isSemidexPayload(null), false);
  });

  it('exports the payload field constants', () => {
    assert.ok(payload.SEMIDEX_PAYLOAD_FIELDS.includes('source_file'));
    assert.ok(payload.NAV_PAYLOAD_FIELDS.includes('node_path'));
    assert.ok(payload.CONTENT_NODE_FIELDS.includes('raw_content'));
  });
});

describe('schema.js is the single source of truth', () => {
  it('required payload indexes match the semidex data model', () => {
    assert.deepEqual(schema.REQUIRED_PAYLOAD_INDEXES, {
      source_file: 'keyword',
      tags:        'keyword',
      chunk_index: 'integer',
      point_kind:  'keyword',
      node_type:   'keyword',
      node_id:     'keyword',
      node_path:   'keyword',
      parent_id:   'keyword',
    });
  });

  it('vector schema uses named dense/sparse vectors', () => {
    const s = schema.collectionVectorSchema(1024);
    assert.equal(s.vectors.dense.size, 1024);
    assert.equal(s.vectors.dense.distance, 'Cosine');
    assert.ok(s.sparse_vectors.sparse);
  });
});

describe('facade re-exports the full public surface', () => {
  const expected = [
    // client
    'getQdrantClient', 'resetQdrantClientCache',
    // store
    'listCollections', 'getCollectionInfo', 'createCollection', 'deleteCollection', 'createPayloadIndex',
    'addSparseVectorSupport', 'hasSparseVectors', 'upsertPoints', 'updatePayload',
    'deleteBySourceFile', 'deleteByFilter', 'deleteTrailingChunks',
    'search', 'hybridSearch', 'mmrSearch', 'scroll', 'getStoredMeta',
    'listSourceFiles', 'scrollAllPoints', 'fetchWindowChunks', 'getFileChunks',
    'getCollectionSkeletonNode', 'getSkeletonNodeById', 'getSkeletonNodeByPath',
    'getSkeletonChildren', 'getContentNodeById', 'getContentNodeByPath',
    'getAnyNodeById', 'getAnyNodeByPath',
    // ensure-schema
    'ensureCollectionSchema',
    // payload
    'isSemidexPayload',
  ];
  for (const name of expected) {
    it(`exports ${name}`, () => {
      assert.equal(typeof facade[name], 'function', `${name} missing from facade`);
    });
  }

  it('exports schema constants', () => {
    assert.ok(facade.REQUIRED_PAYLOAD_INDEXES);
    assert.ok(facade.SEMIDEX_PAYLOAD_FIELDS);
  });
});

describe('client cache reset', () => {
  it('resetQdrantClientCache forces a fresh instance', () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    try {
      const first = facade.getQdrantClient();
      assert.equal(facade.getQdrantClient(), first, 'cache should return same instance');
      facade.resetQdrantClientCache();
      assert.notEqual(facade.getQdrantClient(), first, 'reset should rebuild the client');
    } finally {
      delete process.env.QDRANT_URL;
      facade.resetQdrantClientCache();
    }
  });
});
