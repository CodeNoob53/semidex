// mcp/tools/search.js — embedding-profile resolution wiring (Part E of the
// native-metadata task). handle() now resolves the collection's own
// embedding profile via resolveExistingCollectionProfile (the SAME
// resolution path admin search and Ask use) before ever calling
// embedForSearch/hybridSearch — this file proves that short-circuit using
// the setStorageAdapter() DI seam, without touching a real Qdrant/embed
// call. handle()'s full happy-path flow (real hybridSearch/embedForSearch)
// still has no offline test harness — this file only covers the
// profile-resolution wiring, consistent with search-settings-service.test.js's
// existing scope boundary for this file.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle, setStorageAdapter } from '../../../src/mcp/tools/search.js';

afterEach(() => { setStorageAdapter(null); });

function fakeAdapter(getEmbeddingProfileResult) {
  return {
    getEmbeddingProfile: async () => getEmbeddingProfileResult,
  };
}

describe('mcp/tools/search.js — handle() resolves the embedding profile before searching', () => {
  it('an unresolved profile (state: missing) returns a graceful message, never throws, never reaches hybridSearch/embedForSearch', async () => {
    setStorageAdapter(fakeAdapter({ state: 'missing' }));
    const result = await handle({ query: 'q', collection: 'c' });
    assert.equal(typeof result, 'string');
    assert.match(result, /Cannot search "c"/);
    assert.match(result, /legacy_unmigrated/);
  });

  it('an "invalid" profile state also returns a graceful message, not a thrown error', async () => {
    setStorageAdapter(fakeAdapter({ state: 'invalid', errors: ['bad'] }));
    const result = await handle({ query: 'q', collection: 'c' });
    assert.match(result, /Cannot search "c"/);
  });

  it('an unsupported execution mode (e.g. qdrant-cloud) returns a graceful message naming the mode, never attempts a local embed', async () => {
    const cloudProfile = {
      schemaVersion: 1, managedBy: 'semidex',
      embedding: {
        dense: { provider: 'e5', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: null,
      },
      embeddingSchemaVersion: 2,
    };
    setStorageAdapter(fakeAdapter({ state: 'valid', profile: cloudProfile }));
    const result = await handle({ query: 'q', collection: 'c' });
    assert.match(result, /qdrant-cloud/);
    assert.match(result, /not yet implemented/);
  });

  it('setStorageAdapter(null) resets to the lazy real-adapter default (does not throw when reset)', () => {
    assert.doesNotThrow(() => setStorageAdapter(null));
  });
});
