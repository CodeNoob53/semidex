// Behavioral tests for src/core/qdrant/store.js's createCollection() —
// specifically the self-cleanup logic added for collection-creation
// safety (Qdrant Cloud model-selection task, section 7). Uses the same
// QdrantClient.prototype monkey-patch pattern as
// qdrant-store-probe-inference.test.js — getQdrantClient() only
// constructs the client lazily and never calls the network itself, so
// this never touches a real Qdrant instance.
//
// The core invariant under test: createCollection() is the ONLY function
// that can safely decide to clean up a partially-created collection,
// because it is the one caller that knows — by direct causality of its
// own preceding `await` succeeding — that IT just created this
// collection. A listCollections()-before-create check (considered and
// rejected during planning) would have a TOCTOU race: a concurrent
// process could create a same-named collection in the gap between the
// check and the create call, and a cleanup keyed off a stale check could
// then delete a collection this call never created.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createCollection } from '../../../src/core/qdrant/store.js';
import { resetQdrantClientCache } from '../../../src/core/qdrant/client.js';

let originalApi, originalCreatePayloadIndex, originalDeleteCollection;

beforeEach(() => {
  process.env.QDRANT_URL = 'http://localhost:6333';
  resetQdrantClientCache();
  originalApi = QdrantClient.prototype.api;
  originalCreatePayloadIndex = QdrantClient.prototype.createPayloadIndex;
  originalDeleteCollection = QdrantClient.prototype.deleteCollection;
});

afterEach(() => {
  QdrantClient.prototype.api = originalApi;
  QdrantClient.prototype.createPayloadIndex = originalCreatePayloadIndex;
  QdrantClient.prototype.deleteCollection = originalDeleteCollection;
  resetQdrantClientCache();
});

const VECTOR_SCHEMA = { vectors: { dense: { size: 384, distance: 'Cosine' } } };

describe('createCollection() — self-cleanup on partial creation', () => {
  it('the base create call itself failing (e.g. a conflict/already-exists response) never triggers cleanup — nothing was created to clean up', async () => {
    QdrantClient.prototype.api = () => ({
      createCollection: () => Promise.reject(new Error('Conflict: collection already exists')),
    });
    let deleteCalled = false;
    QdrantClient.prototype.deleteCollection = () => { deleteCalled = true; return Promise.resolve(true); };

    await assert.rejects(
      () => createCollection('semidex-test-collection', 384, undefined, VECTOR_SCHEMA),
      /Create collection failed.*already exists/,
    );
    assert.equal(deleteCalled, false, 'deleteCollection must never be called when the base create itself failed');
  });

  it('base create succeeds, a createPayloadIndex() call fails → deleteCollection IS called exactly once for that name, and the ORIGINAL error propagates', async () => {
    let createBody;
    QdrantClient.prototype.api = () => ({
      createCollection: (body) => { createBody = body; return Promise.resolve({ result: true }); },
    });
    QdrantClient.prototype.createPayloadIndex = () => Promise.reject(new Error('payload index creation failed: disk full'));
    let deleteCallCount = 0;
    let deletedName;
    QdrantClient.prototype.deleteCollection = (name) => {
      deleteCallCount += 1;
      deletedName = name;
      return Promise.resolve(true);
    };

    await assert.rejects(
      () => createCollection('semidex-test-collection', 384, undefined, VECTOR_SCHEMA),
      /Create index failed.*disk full/,
    );
    assert.equal(deleteCallCount, 1, 'deleteCollection must be called exactly once');
    assert.equal(deletedName, 'semidex-test-collection', 'must delete the SAME collection this call just created');
    assert.equal(createBody.collection_name, 'semidex-test-collection');
  });

  it('cleanup itself also failing does NOT mask the original payload-index error', async () => {
    QdrantClient.prototype.api = () => ({
      createCollection: () => Promise.resolve({ result: true }),
    });
    QdrantClient.prototype.createPayloadIndex = () => Promise.reject(new Error('ORIGINAL: payload index failed'));
    QdrantClient.prototype.deleteCollection = () => Promise.reject(new Error('cleanup also failed: collection not found'));

    await assert.rejects(
      () => createCollection('semidex-test-collection', 384, undefined, VECTOR_SCHEMA),
      (err) => {
        assert.match(err.message, /ORIGINAL: payload index failed/, 'the ORIGINAL error must propagate, not the cleanup error');
        assert.ok(!err.message.includes('cleanup also failed'), 'the cleanup failure must never replace/append into the primary error');
        return true;
      },
    );
  });

  it('a successful create (base call + all payload indexes) never calls deleteCollection at all', async () => {
    QdrantClient.prototype.api = () => ({
      createCollection: () => Promise.resolve({ result: true }),
    });
    QdrantClient.prototype.createPayloadIndex = () => Promise.resolve({ result: true });
    let deleteCalled = false;
    QdrantClient.prototype.deleteCollection = () => { deleteCalled = true; return Promise.resolve(true); };

    await createCollection('semidex-test-collection', 384, undefined, VECTOR_SCHEMA);
    assert.equal(deleteCalled, false, 'a fully successful create must never touch deleteCollection');
  });
});
