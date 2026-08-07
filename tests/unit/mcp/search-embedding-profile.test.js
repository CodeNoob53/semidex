// mcp/tools/search.js — handle() now routes through the SAME
// runHybridSearch() service admin search and Ask use (Revision, native
// Qdrant Cloud Inference task), instead of calling
// resolveExistingCollectionProfile + embedForSearch + hybridSearch
// directly. This file proves that unification: handle() calls
// runHybridSearch() with the resolved collection/query/top and surfaces
// its typed errors gracefully, for both a still-unresolved/invalid
// profile AND a still-unimplemented execution mode — using the
// setStorageAdapter() DI seam, without touching a real Qdrant/embed call.
// handle()'s full happy-path flow (real embedding/Qdrant Query API calls)
// still has no offline test harness — this file only covers the
// retrieval-routing wiring, consistent with search-settings-service.test.js's
// existing scope boundary for this file.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle, setStorageAdapter, setCloudEmbed, chunkToLegacyPoint } from '../../../src/mcp/tools/search.js';
import { createCloudEmbeddingCapability } from '../../../src/cloud/embedding/cloud-embedding-provider.js';

afterEach(() => { setStorageAdapter(null); setCloudEmbed(null); });

function fakeAdapter({ getEmbeddingProfileResult, collection = { name: 'c' }, hits } = {}) {
  return {
    capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
    getCollection: async () => collection,
    getEmbeddingProfile: async () => getEmbeddingProfileResult,
    searchHybridVectors: async () => hits ?? [],
    searchHybridInference: async () => hits ?? [],
  };
}

describe('mcp/tools/search.js — handle() routes through runHybridSearch()', () => {
  it('an unresolved profile (state: missing) returns a graceful message, never throws', async () => {
    setStorageAdapter(fakeAdapter({ getEmbeddingProfileResult: { state: 'missing' } }));
    const result = await handle({ query: 'q', collection: 'c' });
    assert.equal(typeof result, 'string');
    assert.match(result, /Cannot search "c"/);
    assert.match(result, /legacy_unmigrated/);
  });

  it('an "invalid" profile state also returns a graceful message, not a thrown error', async () => {
    setStorageAdapter(fakeAdapter({ getEmbeddingProfileResult: { state: 'invalid', errors: ['bad'] } }));
    const result = await handle({ query: 'q', collection: 'c' });
    assert.match(result, /Cannot search "c"/);
  });

  it('a still-unimplemented execution mode (e.g. qdrant-cluster) returns a graceful message naming the mode', async () => {
    const clusterProfile = {
      schemaVersion: 1, managedBy: 'semidex',
      embedding: {
        dense: { provider: 'qdrant-cluster', model: 'some-model', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cluster' },
        sparse: null,
      },
      embeddingSchemaVersion: 2,
    };
    setStorageAdapter(fakeAdapter({ getEmbeddingProfileResult: { state: 'valid', profile: clusterProfile } }));
    const result = await handle({ query: 'q', collection: 'c' });
    assert.match(result, /qdrant-cluster/);
    assert.match(result, /not yet implemented/);
  });

  it('a qdrant-cloud profile is NOT rejected — it now returns "No results found." for a fake adapter\'s empty hits, not an unsupported-execution message', async () => {
    const cloudProfile = {
      schemaVersion: 1, managedBy: 'semidex',
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
      embeddingSchemaVersion: 2,
    };
    setStorageAdapter(fakeAdapter({ getEmbeddingProfileResult: { state: 'valid', profile: cloudProfile }, hits: [] }));
    setCloudEmbed(createCloudEmbeddingCapability());
    const result = await handle({ query: 'q', collection: 'c' });
    assert.equal(result, 'No results found.');
  });

  it('setStorageAdapter(null) resets to the lazy real-adapter default (does not throw when reset)', () => {
    assert.doesNotThrow(() => setStorageAdapter(null));
  });
});

describe('chunkToLegacyPoint() — Chunk -> raw Qdrant point shape for rerankResults()/ceRerank()', () => {
  it('maps every field rerankResults()/ceRerank() actually read', () => {
    const chunk = {
      sourceFile: 'docs/a.md', chunkIndex: 2, totalChunks: 5, section: 'Intro',
      text: 'hello world', tags: ['x', 'y'], context: 'Doc > Intro',
      nodeId: 'n1', nodePath: '/doc/intro', nodeType: 'section', score: 0.42,
    };
    const point = chunkToLegacyPoint(chunk);
    assert.equal(point.score, 0.42);
    assert.deepEqual(point.payload, {
      source_file: 'docs/a.md', chunk_index: 2, total_chunks: 5, section: 'Intro',
      text: 'hello world', tags: ['x', 'y'], context: 'Doc > Intro',
      node_id: 'n1', node_path: '/doc/intro', node_type: 'section',
    });
  });
});
