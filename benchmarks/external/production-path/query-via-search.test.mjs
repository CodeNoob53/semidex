// core/query-via-search.mjs — offline. A fake adapter stands in for the
// real storage adapter (never a real Qdrant/network call) — runHybridSearch()
// itself is the real production function, exercised against the fake
// adapter exactly like tests/unit/core/retrieval/search.test.js already
// does for the production code itself.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryOne, checkDepthSufficient, CHUNK_CANDIDATE_LIMIT, DOCUMENT_METRIC_DEPTH } from './core/query-via-search.mjs';

const validProfile = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function fakeAdapter({ hits, embeddingProfileResult } = {}) {
  return {
    capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
    getCollection: async (name) => ({ name }),
    getEmbeddingProfile: async () => embeddingProfileResult ?? { state: 'valid', profile: validProfile },
    searchHybridVectors: async () => hits ?? [],
    searchHybridInference: async () => hits ?? [],
  };
}

describe('queryOne()', () => {
  it('normalizes a successful runHybridSearch() result to {ok:true, hits, ms, error:null}', async () => {
    const adapter = fakeAdapter({ hits: [{ id: 1, score: 0.9 }] });
    const embedQuery = async () => ({ dense: [1], sparse: {} });
    const result = await queryOne({ adapter, embedQuery, collection: 'c', query: 'q' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.hits, [{ id: 1, score: 0.9 }]);
    assert.equal(result.error, null);
    assert.equal(typeof result.ms, 'number');
    assert.ok(result.ms >= 0);
  });

  it('normalizes an {error} result to {ok:false, hits:[], error:{...}} — never treated as an empty ranking silently', async () => {
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'missing' } });
    const result = await queryOne({ adapter, collection: 'c', query: 'q' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.hits, []);
    assert.equal(result.error.error, 'embedding_unresolved');
    assert.equal(typeof result.error.message, 'string');
  });

  it('threads embedQuery through to runHybridSearch() on a CLIENT-execution profile — the vectors actually come from the passed embedQuery', async () => {
    let capturedOpts;
    const adapter = {
      capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
      getCollection: async () => ({ name: 'c' }),
      getEmbeddingProfile: async () => ({ state: 'valid', profile: validProfile }),
      searchHybridVectors: async (name, opts) => { capturedOpts = opts; return []; },
    };
    const embedQuery = async () => ({ dense: [7, 7, 7], sparse: { indices: [3], values: [0.9] } });
    const result = await queryOne({ adapter, embedQuery, collection: 'c', query: 'q' });
    assert.equal(result.ok, true);
    assert.deepEqual(capturedOpts.dense, [7, 7, 7]);
    assert.deepEqual(capturedOpts.sparse, { indices: [3], values: [0.9] });
  });

  it('threads cloudEmbed through to runHybridSearch() so a qdrant-cloud profile no longer fails with "no cloudEmbed capability was supplied" (audit 2026-09-06, P1)', async () => {
    const cloudProfile = {
      schemaVersion: 1, managedBy: 'semidex',
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
      embeddingSchemaVersion: 2,
    };
    let inferenceOpts;
    const adapter = {
      capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
      getCollection: async () => ({ name: 'c' }),
      getEmbeddingProfile: async () => ({ state: 'valid', profile: cloudProfile }),
      searchHybridInference: async (name, opts) => { inferenceOpts = opts; return []; },
    };
    // Minimal CloudEmbeddingCapability fake — only the two methods the
    // QDRANT_CLOUD branch of runHybridSearch() actually calls.
    const cloudEmbed = {
      checkEmbedInputFits: async () => ({ fits: true }),
      buildCloudQueryInputs: () => ({
        denseQuery: { text: 'q', model: 'intfloat/multilingual-e5-small' },
        sparseQuery: { text: 'q', model: 'qdrant/bm25' },
      }),
    };
    const result = await queryOne({ adapter, cloudEmbed, collection: 'c', query: 'q' });
    assert.equal(result.ok, true, result.error && JSON.stringify(result.error));
    assert.ok(inferenceOpts, 'searchHybridInference must have been reached (no cloudEmbed error)');
  });

  it('without cloudEmbed, a qdrant-cloud profile still surfaces the typed "no cloudEmbed capability" error as {ok:false} — never a silent empty ranking', async () => {
    const cloudProfile = {
      schemaVersion: 1, managedBy: 'semidex',
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
      embeddingSchemaVersion: 2,
    };
    const adapter = {
      capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
      getCollection: async () => ({ name: 'c' }),
      getEmbeddingProfile: async () => ({ state: 'valid', profile: cloudProfile }),
      searchHybridInference: async () => [],
    };
    const result = await queryOne({ adapter, collection: 'c', query: 'q' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.hits, []);
    assert.match(result.error.message, /no cloudEmbed capability/);
  });

  it('defaults top to CHUNK_CANDIDATE_LIMIT when not explicitly overridden', async () => {
    let capturedOpts;
    const adapter = {
      capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
      getCollection: async () => ({ name: 'c' }),
      getEmbeddingProfile: async () => ({ state: 'valid', profile: validProfile }),
      searchHybridVectors: async (name, opts) => { capturedOpts = opts; return []; },
    };
    const embedQuery = async () => ({ dense: [1], sparse: {} });
    await queryOne({ adapter, embedQuery, collection: 'c', query: 'q' });
    assert.equal(capturedOpts.limit, CHUNK_CANDIDATE_LIMIT);
  });
});

describe('checkDepthSufficient()', () => {
  it('true when rankedDocs reaches DOCUMENT_METRIC_DEPTH against a large corpus', () => {
    const rankedDocs = Array.from({ length: DOCUMENT_METRIC_DEPTH }, (_, i) => ({ docId: `d${i}` }));
    assert.equal(checkDepthSufficient(rankedDocs, 5000), true);
  });

  it('false when rankedDocs falls short of DOCUMENT_METRIC_DEPTH against a large corpus', () => {
    const rankedDocs = Array.from({ length: 50 }, (_, i) => ({ docId: `d${i}` }));
    assert.equal(checkDepthSufficient(rankedDocs, 5000), false);
  });

  it('true when the corpus itself is smaller than DOCUMENT_METRIC_DEPTH and rankedDocs covers the whole corpus — never a false depth failure for a small corpus', () => {
    const rankedDocs = Array.from({ length: 5 }, (_, i) => ({ docId: `d${i}` }));
    assert.equal(checkDepthSufficient(rankedDocs, 5), true);
  });

  it('false when even a small corpus is under-covered', () => {
    const rankedDocs = Array.from({ length: 2 }, (_, i) => ({ docId: `d${i}` }));
    assert.equal(checkDepthSufficient(rankedDocs, 5), false);
  });
});
