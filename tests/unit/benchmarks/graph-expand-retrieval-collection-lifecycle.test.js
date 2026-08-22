// Offline regression tests for the graph-expanded-retrieval live benchmark's
// collection ownership/cleanup safety logic
// (benchmarks/graph-expand-retrieval/collection-lifecycle.js). No live
// Qdrant, no network — a mock adapter stands in for the real one.
//
// P0 invariant under test: run-live.mjs creates ONE disposable collection
// and deletes it in `finally`, but must NEVER delete a collection it did
// not itself create. These tests drive the exact three-step sequence
// run-live.mjs uses (assertCollectionAvailable -> confirmOwnership ->
// cleanupOwnedCollection) end to end for each unsafe/safe scenario, rather
// than testing cleanupOwnedCollection's `owned` gate in isolation, so a
// regression in how `ownsCollection` gets computed upstream would also
// fail this test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCollectionAvailable, confirmOwnership, cleanupOwnedCollection,
} from '../../../benchmarks/graph-expand-retrieval/collection-lifecycle.js';

// existsAfterCreateAttempt: whether adapter.getCollection() should report
// the collection as present once the (simulated) creation step has run —
// lets each scenario control what confirmOwnership() observes.
function mockAdapter({ existsBeforeCreate = false, existsAfterCreateAttempt = false } = {}) {
  let exists = existsBeforeCreate;
  const deleteCalls = [];
  return {
    deleteCalls,
    simulateCreateAttempt() { exists = existsAfterCreateAttempt; },
    async getCollection(name) {
      return exists ? { name } : null;
    },
    async deleteCollection(name) {
      deleteCalls.push(name);
    },
  };
}

describe('collection-lifecycle: ownership-gated cleanup', () => {
  it('collision: assertCollectionAvailable throws and cleanup never deletes', async () => {
    const adapter = mockAdapter({ existsBeforeCreate: true });
    let ownsCollection = false;

    await assert.rejects(() => assertCollectionAvailable(adapter, 'graph-expand-live-abc'));
    // run-live.mjs never reaches confirmOwnership() on this path — the
    // collision throw is caught and rethrown before indexing starts.

    const result = await cleanupOwnedCollection({ adapter, collection: 'graph-expand-live-abc', owned: ownsCollection });
    assert.equal(result.attempted, false);
    assert.deepEqual(adapter.deleteCalls, []);
  });

  it('pre-create failure: collection never actually gets created, cleanup never deletes', async () => {
    // No collision, but the indexing step that was supposed to create the
    // collection fails before creating anything — getCollection() still
    // reports absent afterward.
    const adapter = mockAdapter({ existsBeforeCreate: false, existsAfterCreateAttempt: false });

    await assertCollectionAvailable(adapter, 'graph-expand-live-def'); // passes, no throw

    // Simulate the indexing job failing before it created the collection
    // (e.g. it never started, or crashed before its create step).
    const ownsCollection = await confirmOwnership(adapter, 'graph-expand-live-def');
    assert.equal(ownsCollection, false);

    const result = await cleanupOwnedCollection({ adapter, collection: 'graph-expand-live-def', owned: ownsCollection });
    assert.equal(result.attempted, false);
    assert.deepEqual(adapter.deleteCalls, []);
  });

  it('successfully owned collection: creation confirmed, then a LATER failure still deletes it', async () => {
    const adapter = mockAdapter({ existsBeforeCreate: false, existsAfterCreateAttempt: true });

    await assertCollectionAvailable(adapter, 'graph-expand-live-ghi'); // passes, no throw

    // Simulate the indexing job actually creating the collection.
    adapter.simulateCreateAttempt();
    const ownsCollection = await confirmOwnership(adapter, 'graph-expand-live-ghi');
    assert.equal(ownsCollection, true);

    // Simulate some later step (a query, a sanity check) throwing — cleanup
    // in `finally` still runs with the ownership flag captured above.
    const result = await cleanupOwnedCollection({ adapter, collection: 'graph-expand-live-ghi', owned: ownsCollection });
    assert.equal(result.attempted, true);
    assert.deepEqual(adapter.deleteCalls, ['graph-expand-live-ghi']);
  });

  it('cleanupOwnedCollection never calls adapter.deleteCollection when owned is false, regardless of collection name', async () => {
    const adapter = mockAdapter();
    const result = await cleanupOwnedCollection({ adapter, collection: 'graph-expand-live-anything', owned: false });
    assert.equal(result.attempted, false);
    assert.deepEqual(adapter.deleteCalls, []);
  });
});
