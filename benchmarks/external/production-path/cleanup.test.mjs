// core/cleanup.mjs — offline, no network. Fake adapter only, never a real
// Qdrant client. Proves the prefix guard, "not found = success"
// normalization, and the orphan-sweep scan/filter/delete behavior.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupCollection, cleanupAllOwnedCollections } from './core/cleanup.mjs';
import { COLLECTION_PREFIX } from './core/profiles.mjs';

function fakeAdapter({ deleteImpl, collections = [] } = {}) {
  const deleteCalls = [];
  return {
    deleteCalls,
    listCollections: async () => collections,
    deleteCollection: async (name) => {
      deleteCalls.push(name);
      if (deleteImpl) return deleteImpl(name);
    },
  };
}

describe('cleanupCollection() — prefix guard', () => {
  it('throws and never calls adapter.deleteCollection for a name that does not start with the owned prefix', async () => {
    const adapter = fakeAdapter();
    await assert.rejects(() => cleanupCollection(adapter, 'some-other-collection'));
    assert.deepEqual(adapter.deleteCalls, []);
  });

  it('throws for an empty/undefined name', async () => {
    const adapter = fakeAdapter();
    await assert.rejects(() => cleanupCollection(adapter, ''));
    await assert.rejects(() => cleanupCollection(adapter, undefined));
  });

  it('deletes a prefix-owned collection and reports deleted:true', async () => {
    const adapter = fakeAdapter();
    const name = `${COLLECTION_PREFIX}scifact-cloud-abc`;
    const result = await cleanupCollection(adapter, name);
    assert.deepEqual(adapter.deleteCalls, [name]);
    assert.equal(result.attempted, true);
    assert.equal(result.deleted, true);
  });
});

describe('cleanupCollection() — "not found" normalizes to a successful clean state', () => {
  it('treats a "doesn\'t exist" error as deleted:true, not an error', async () => {
    const adapter = fakeAdapter({ deleteImpl: () => { throw new Error('Collection `x` doesn\'t exist!'); } });
    const result = await cleanupCollection(adapter, `${COLLECTION_PREFIX}x`);
    assert.equal(result.deleted, true);
    assert.equal(result.note, 'already absent');
    assert.equal(result.error, undefined);
  });

  it('treats a "not found" error as deleted:true', async () => {
    const adapter = fakeAdapter({ deleteImpl: () => { throw new Error('Not Found (404)'); } });
    const result = await cleanupCollection(adapter, `${COLLECTION_PREFIX}x`);
    assert.equal(result.deleted, true);
  });

  it('a genuinely different error is reported as deleted:false with the error message, never swallowed', async () => {
    const adapter = fakeAdapter({ deleteImpl: () => { throw new Error('connection refused'); } });
    const result = await cleanupCollection(adapter, `${COLLECTION_PREFIX}x`);
    assert.equal(result.deleted, false);
    assert.match(result.error, /connection refused/);
  });
});

describe('cleanupAllOwnedCollections() — orphan sweep', () => {
  it('only deletes collections whose name starts with the owned prefix, ignoring everything else', async () => {
    const collections = [
      { name: `${COLLECTION_PREFIX}scifact-local-1` },
      { name: `${COLLECTION_PREFIX}miracl-ru-cloud-2` },
      { name: 'some-real-user-collection' },
      { name: 'another-unrelated-collection' },
    ];
    const adapter = fakeAdapter({ collections });
    const result = await cleanupAllOwnedCollections(adapter);
    assert.equal(result.scanned, 4);
    assert.deepEqual(result.owned.sort(), [`${COLLECTION_PREFIX}miracl-ru-cloud-2`, `${COLLECTION_PREFIX}scifact-local-1`].sort());
    assert.deepEqual(adapter.deleteCalls.sort(), result.owned.sort());
    assert.equal(result.results.every((r) => r.deleted), true);
  });

  it('an empty collection list scans zero and deletes nothing', async () => {
    const adapter = fakeAdapter({ collections: [] });
    const result = await cleanupAllOwnedCollections(adapter);
    assert.equal(result.scanned, 0);
    assert.deepEqual(result.owned, []);
    assert.deepEqual(adapter.deleteCalls, []);
  });

  it('one failing deletion does not stop the sweep from attempting the rest', async () => {
    const collections = [
      { name: `${COLLECTION_PREFIX}a` },
      { name: `${COLLECTION_PREFIX}b` },
      { name: `${COLLECTION_PREFIX}c` },
    ];
    const adapter = fakeAdapter({
      collections,
      deleteImpl: (name) => { if (name.endsWith('b')) throw new Error('transient failure'); },
    });
    const result = await cleanupAllOwnedCollections(adapter);
    assert.equal(adapter.deleteCalls.length, 3, 'expected all three deletions to be attempted despite one failing');
    const failed = result.results.find((r) => r.name.endsWith('b'));
    assert.equal(failed.deleted, false);
    const succeeded = result.results.filter((r) => r.deleted);
    assert.equal(succeeded.length, 2);
  });
});
