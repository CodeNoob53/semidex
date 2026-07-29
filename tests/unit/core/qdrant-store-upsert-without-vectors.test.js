// Behavioral test for src/core/qdrant/store.js's upsertPointsWithoutVectors()
// — captures the EXACT request body via a monkey-patched Qdrant SDK client
// (getQdrantClient() only constructs the client lazily and never calls the
// network itself, so this never touches a real Qdrant instance).
//
// Proves two contracts (code review, P2 — the ordering guarantee for
// canonical entity_raw points, entity-split.js):
//   1. every point is upserted with vector: {} regardless of what vector
//      field (if any) the caller passed in — never dense-only, sparse-only,
//      or a zero/dummy vector;
//   2. wait: true is set — unlike upsertPoints' own wait: false — so a
//      caller awaiting this call is guaranteed the write has genuinely
//      landed on the server, not merely been queued, before doing anything
//      that assumes the point already exists (e.g. upserting a fragment
//      whose entity_id references it).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient } from '@qdrant/js-client-rest';
import { upsertPointsWithoutVectors, upsertPoints } from '../../../src/core/qdrant/store.js';
import { resetQdrantClientCache } from '../../../src/core/qdrant/client.js';

let originalUpsert;
let captured;

beforeEach(() => {
  process.env.QDRANT_URL = 'http://localhost:6333';
  resetQdrantClientCache();
  captured = null;
  originalUpsert = QdrantClient.prototype.upsert;
  QdrantClient.prototype.upsert = function (collection, body) {
    captured = { collection, body };
    return Promise.resolve({ status: 'completed' });
  };
});

afterEach(() => {
  QdrantClient.prototype.upsert = originalUpsert;
  resetQdrantClientCache();
});

describe('upsertPointsWithoutVectors()', () => {
  it('upserts every point with vector: {} — even when the input point carried no vector field at all', async () => {
    await upsertPointsWithoutVectors('my-collection', [{ id: 'a', payload: { point_kind: 'entity_raw' } }]);
    assert.equal(captured.collection, 'my-collection');
    assert.equal(captured.body.points.length, 1);
    assert.deepEqual(captured.body.points[0].vector, {});
  });

  it('overwrites a real vector field if the caller mistakenly passed one — vector: {} always wins, never dense-only/sparse-only/zero-vector', async () => {
    await upsertPointsWithoutVectors('c', [{ id: 'a', vector: { dense: [1, 2, 3] }, payload: {} }]);
    assert.deepEqual(captured.body.points[0].vector, {});
  });

  it('sets wait: true — unlike upsertPoints, which sets wait: false', async () => {
    await upsertPointsWithoutVectors('c', [{ id: 'a', payload: {} }]);
    assert.equal(captured.body.wait, true);
  });

  it('preserves the point id and payload unchanged', async () => {
    const payload = { point_kind: 'entity_raw', node_id: 'n1', raw_content: 'full content' };
    await upsertPointsWithoutVectors('c', [{ id: 'canonical-uuid', payload }]);
    assert.equal(captured.body.points[0].id, 'canonical-uuid');
    assert.deepEqual(captured.body.points[0].payload, payload);
  });

  it('multiple points all get vector: {}', async () => {
    await upsertPointsWithoutVectors('c', [
      { id: 'a', payload: {} },
      { id: 'b', payload: {} },
    ]);
    assert.equal(captured.body.points.length, 2);
    assert.ok(captured.body.points.every((p) => Object.keys(p.vector).length === 0));
  });
});

describe('upsertPoints() — contrast: wait: false (unchanged from before entity_raw existed)', () => {
  it('sets wait: false, not wait: true', async () => {
    await upsertPoints('c', [{ id: 'a', vector: { dense: [1, 2, 3] }, payload: {} }]);
    assert.equal(captured.body.wait, false);
  });

  it('leaves a real vector field untouched — never overwritten to {}', async () => {
    await upsertPoints('c', [{ id: 'a', vector: { dense: [1, 2, 3] }, payload: {} }]);
    assert.deepEqual(captured.body.points[0].vector, { dense: [1, 2, 3] });
  });
});
