// Behavioral tests for src/indexer/run.js's exported
// createNewCollectionWithConfigCache() — the ONE remaining collection-
// creation-safety gap after core/qdrant/store.js's own createCollection()
// became self-cleaning for ITS partial-failure window (base create
// succeeding, a payload-index call then failing). This function covers
// createCollectionFn() succeeding but the config.json write
// (loadConfigFn/saveConfigFn) then throwing — a real collection now
// exists with no config.json cache entry. All I/O is injected, so this
// never touches a real Qdrant instance or the real config.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNewCollectionWithConfigCache } from '../../../src/shared/indexer/run.js';

const PROFILE = { embedding: { dense: { model: 'intfloat/multilingual-e5-small' } } };

describe('createNewCollectionWithConfigCache()', () => {
  it('happy path: createCollectionFn then loadConfigFn/resolveCollectionConfigEntryFn/saveConfigFn run in order, deleteCollectionFn is never called', async () => {
    const calls = [];
    await createNewCollectionWithConfigCache({
      collection: 'test-collection',
      profile: PROFILE,
      createCollectionFn: async (name, opts) => { calls.push(['create', name, opts]); },
      deleteCollectionFn: async (name) => { calls.push(['delete', name]); },
      loadConfigFn: () => { calls.push(['load']); return { collections: {} }; },
      saveConfigFn: (cfg) => { calls.push(['save', cfg]); },
      resolveCollectionConfigEntryFn: (profile, existing) => { calls.push(['resolve', profile, existing]); return { profile }; },
    });
    assert.deepEqual(calls.map((c) => c[0]), ['create', 'load', 'resolve', 'save']);
    assert.equal(calls[0][1], 'test-collection');
    assert.deepEqual(calls[0][2], { profile: PROFILE });
  });

  it('createCollectionFn throwing propagates directly — deleteCollectionFn is never called (nothing was created by THIS function to clean up; store.js\'s own createCollection is separately self-cleaning for its own partial-failure window)', async () => {
    let deleteCalled = false;
    await assert.rejects(
      () => createNewCollectionWithConfigCache({
        collection: 'test-collection',
        profile: PROFILE,
        createCollectionFn: async () => { throw new Error('create failed'); },
        deleteCollectionFn: async () => { deleteCalled = true; },
        loadConfigFn: () => ({ collections: {} }),
        saveConfigFn: () => {},
        resolveCollectionConfigEntryFn: (profile) => ({ profile }),
      }),
      /create failed/,
    );
    assert.equal(deleteCalled, false);
  });

  it('createCollectionFn succeeds, saveConfigFn throws → deleteCollectionFn IS called exactly once for the SAME collection, and the ORIGINAL error propagates', async () => {
    let deleteCallCount = 0;
    let deletedName;
    await assert.rejects(
      () => createNewCollectionWithConfigCache({
        collection: 'test-collection',
        profile: PROFILE,
        createCollectionFn: async () => {},
        deleteCollectionFn: async (name) => { deleteCallCount += 1; deletedName = name; },
        loadConfigFn: () => ({ collections: {} }),
        saveConfigFn: () => { throw new Error('disk full writing config.json'); },
        resolveCollectionConfigEntryFn: (profile) => ({ profile }),
      }),
      /disk full writing config\.json/,
    );
    assert.equal(deleteCallCount, 1);
    assert.equal(deletedName, 'test-collection');
  });

  it('createCollectionFn succeeds, loadConfigFn throws → cleanup runs the same way (the failure can happen at load, not just save)', async () => {
    let deleteCalled = false;
    await assert.rejects(
      () => createNewCollectionWithConfigCache({
        collection: 'test-collection',
        profile: PROFILE,
        createCollectionFn: async () => {},
        deleteCollectionFn: async () => { deleteCalled = true; },
        loadConfigFn: () => { throw new Error('config.json is corrupt'); },
        saveConfigFn: () => {},
        resolveCollectionConfigEntryFn: (profile) => ({ profile }),
      }),
      /config\.json is corrupt/,
    );
    assert.equal(deleteCalled, true);
  });

  it('cleanup itself also failing does NOT mask the original config-write error', async () => {
    await assert.rejects(
      () => createNewCollectionWithConfigCache({
        collection: 'test-collection',
        profile: PROFILE,
        createCollectionFn: async () => {},
        deleteCollectionFn: async () => { throw new Error('cleanup also failed: not found'); },
        loadConfigFn: () => ({ collections: {} }),
        saveConfigFn: () => { throw new Error('ORIGINAL: disk full'); },
        resolveCollectionConfigEntryFn: (profile) => ({ profile }),
      }),
      (err) => {
        assert.match(err.message, /ORIGINAL: disk full/);
        assert.ok(!err.message.includes('cleanup also failed'), 'the cleanup failure must never replace/append into the primary error');
        return true;
      },
    );
  });

  it('resolveCollectionConfigEntryFn receives the EXISTING entry for this collection (preserving prior fields), not a blank object', async () => {
    let receivedExisting;
    await createNewCollectionWithConfigCache({
      collection: 'test-collection',
      profile: PROFILE,
      createCollectionFn: async () => {},
      deleteCollectionFn: async () => {},
      loadConfigFn: () => ({ collections: { 'test-collection': { someOldField: 'value' } } }),
      saveConfigFn: () => {},
      resolveCollectionConfigEntryFn: (profile, existing) => { receivedExisting = existing; return { profile }; },
    });
    assert.deepEqual(receivedExisting, { someOldField: 'value' });
  });

  it('a config.json with no `collections` key at all is initialized before writing, not a crash', async () => {
    let savedCfg;
    await createNewCollectionWithConfigCache({
      collection: 'test-collection',
      profile: PROFILE,
      createCollectionFn: async () => {},
      deleteCollectionFn: async () => {},
      loadConfigFn: () => ({}), // no .collections at all
      saveConfigFn: (cfg) => { savedCfg = cfg; },
      resolveCollectionConfigEntryFn: (profile) => ({ profile }),
    });
    assert.ok(savedCfg.collections, 'collections must be initialized');
    assert.deepEqual(savedCfg.collections['test-collection'], { profile: PROFILE });
  });
});
