// Behavioral tests for src/core/qdrant/store.js's checkQdrantReachable()
// and probeInference() — the real Qdrant-facing primitives behind
// StorageAdapter.checkCloudInferenceReachable()/probeInference()
// (src/core/storage/qdrant-adapter.js). Uses a real Qdrant SDK client
// whose prototype methods are monkey-patched to record call args / return
// canned responses instead of making a network call (getQdrantClient()
// only constructs the client lazily and never calls the network itself,
// so this never touches a real Qdrant instance).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { checkQdrantReachable, probeInference } from '../../../src/core/qdrant/store.js';
import { resetQdrantClientCache } from '../../../src/core/qdrant/client.js';

let originalApi, originalUpsert, originalDeleteCollection, originalGetCollections;

beforeEach(() => {
  process.env.QDRANT_URL = 'http://localhost:6333';
  resetQdrantClientCache();
  originalApi = QdrantClient.prototype.api;
  originalUpsert = QdrantClient.prototype.upsert;
  originalDeleteCollection = QdrantClient.prototype.deleteCollection;
  originalGetCollections = QdrantClient.prototype.getCollections;
});

afterEach(() => {
  QdrantClient.prototype.api = originalApi;
  QdrantClient.prototype.upsert = originalUpsert;
  QdrantClient.prototype.deleteCollection = originalDeleteCollection;
  QdrantClient.prototype.getCollections = originalGetCollections;
  resetQdrantClientCache();
});

function stubCreateCollection(capture) {
  QdrantClient.prototype.api = function () {
    return {
      createCollection: (body) => { capture.createBody = body; return Promise.resolve({ result: true }); },
    };
  };
}

const VECTOR_SCHEMA = { vectors: { dense: { size: 384, distance: 'Cosine' } }, sparse_vectors: { sparse: { index: { on_disk: false }, modifier: 'idf' } } };
const DENSE_QUERY = { text: 'semidex cloud inference probe', model: 'intfloat/multilingual-e5-small' };
const SPARSE_QUERY = { text: 'semidex cloud inference probe', model: 'qdrant/bm25' };

describe('probeInference() — real minimal inference round-trip', () => {
  it('a successful upsert against the probe collection returns { status: "inference_available" }', async () => {
    const capture = {};
    stubCreateCollection(capture);
    QdrantClient.prototype.upsert = (name, body) => { capture.upsertName = name; capture.upsertBody = body; return Promise.resolve({}); };
    let deletedName;
    QdrantClient.prototype.deleteCollection = (name) => { deletedName = name; return Promise.resolve(true); };

    const result = await probeInference({ vectorSchema: VECTOR_SCHEMA, denseQuery: DENSE_QUERY, sparseQuery: SPARSE_QUERY });
    assert.deepEqual(result, { status: 'inference_available' });
    assert.ok(capture.createBody.collection_name.startsWith('semidex-cloud-inference-probe-'));
    assert.deepEqual(capture.createBody.vectors, VECTOR_SCHEMA.vectors);
    assert.deepEqual(capture.createBody.sparse_vectors, VECTOR_SCHEMA.sparse_vectors);
    assert.deepEqual(capture.upsertBody.points[0].vector.dense, DENSE_QUERY);
    assert.deepEqual(capture.upsertBody.points[0].vector.sparse, SPARSE_QUERY);
    assert.equal(deletedName, capture.createBody.collection_name, 'must delete the SAME collection it created');
  });

  it('an inference-specific error maps to inference_disabled_or_model_unavailable, cleanup still runs', async () => {
    const capture = {};
    stubCreateCollection(capture);
    QdrantClient.prototype.upsert = () => Promise.reject(new Error('Inference error: model not found'));
    let deletedName;
    QdrantClient.prototype.deleteCollection = (name) => { deletedName = name; return Promise.resolve(true); };

    const result = await probeInference({ vectorSchema: VECTOR_SCHEMA, denseQuery: DENSE_QUERY, sparseQuery: SPARSE_QUERY });
    assert.equal(result.status, 'inference_disabled_or_model_unavailable');
    assert.match(result.message, /model not found/);
    assert.equal(deletedName, capture.createBody.collection_name);
  });

  it('a non-inference error is re-thrown, not mislabeled', async () => {
    stubCreateCollection({});
    QdrantClient.prototype.upsert = () => Promise.reject(new Error('ECONNRESET'));
    QdrantClient.prototype.deleteCollection = () => Promise.resolve(true);

    await assert.rejects(
      () => probeInference({ vectorSchema: VECTOR_SCHEMA, denseQuery: DENSE_QUERY, sparseQuery: SPARSE_QUERY }),
      /ECONNRESET/,
    );
  });

  it('with no sparseQuery, no sparse field is sent on the point vector', async () => {
    const capture = {};
    stubCreateCollection(capture);
    QdrantClient.prototype.upsert = (name, body) => { capture.upsertBody = body; return Promise.resolve({}); };
    QdrantClient.prototype.deleteCollection = () => Promise.resolve(true);

    await probeInference({ vectorSchema: { vectors: { dense: { size: 384, distance: 'Cosine' } } }, denseQuery: DENSE_QUERY, sparseQuery: null });
    assert.ok(!('sparse' in capture.upsertBody.points[0].vector));
  });

  it('cleanup is attempted in finally even when the inference call failed', async () => {
    stubCreateCollection({});
    QdrantClient.prototype.upsert = () => Promise.reject(new Error('inference unavailable'));
    let deleteCalled = false;
    QdrantClient.prototype.deleteCollection = () => { deleteCalled = true; return Promise.resolve(true); };

    await probeInference({ vectorSchema: VECTOR_SCHEMA, denseQuery: DENSE_QUERY, sparseQuery: SPARSE_QUERY });
    assert.equal(deleteCalled, true);
  });

  it('the probe collection name is uniquely generated per call, always with the declared prefix', async () => {
    const capture1 = {}; const capture2 = {};
    QdrantClient.prototype.upsert = () => Promise.resolve({});
    QdrantClient.prototype.deleteCollection = () => Promise.resolve(true);

    QdrantClient.prototype.api = function () { return { createCollection: (body) => { capture1.name = body.collection_name; return Promise.resolve({}); } }; };
    await probeInference({ vectorSchema: VECTOR_SCHEMA, denseQuery: DENSE_QUERY, sparseQuery: SPARSE_QUERY });

    QdrantClient.prototype.api = function () { return { createCollection: (body) => { capture2.name = body.collection_name; return Promise.resolve({}); } }; };
    await probeInference({ vectorSchema: VECTOR_SCHEMA, denseQuery: DENSE_QUERY, sparseQuery: SPARSE_QUERY });

    assert.notEqual(capture1.name, capture2.name);
    assert.ok(capture1.name.startsWith('semidex-cloud-inference-probe-'));
  });
});

describe('checkQdrantReachable() — cheap, never proves inference', () => {
  it('a successful getCollections() call reports status: "ok"', async () => {
    QdrantClient.prototype.getCollections = () => Promise.resolve({ collections: [] });
    const result = await checkQdrantReachable();
    assert.deepEqual(result, { status: 'ok' });
  });

  it('an auth-shaped error reports status: "auth_failed"', async () => {
    QdrantClient.prototype.getCollections = () => Promise.reject(new Error('401 Unauthorized: invalid api key'));
    const result = await checkQdrantReachable();
    assert.equal(result.status, 'auth_failed');
  });

  it('any other error reports status: "unreachable"', async () => {
    QdrantClient.prototype.getCollections = () => Promise.reject(new Error('ECONNREFUSED'));
    const result = await checkQdrantReachable();
    assert.equal(result.status, 'unreachable');
  });
});
