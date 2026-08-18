// mcp/tools/collections.js — qdrant_collection_info's availability suffix
// (Part G of the native-metadata task). handle() now resolves each
// collection's availability via the SAME resolveExistingCollectionProfile +
// resolveAvailability path admin/search/Ask use, replacing the old
// duplicated inline denseProvider/sparse ?? envProv fallback logic. This
// file proves the suffix wiring using the setStorageAdapter() DI seam,
// without touching a real Qdrant/Ollama/ONNX call.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle, setAvailabilityChecks, setStorageAdapter } from '../../../src/mcp/tools/collections.js';
import { LANE_STATUS, resetLaneAvailabilityCache } from '../../../src/core/embedding-profile/availability.js';

afterEach(() => {
  setStorageAdapter(null);
  setAvailabilityChecks(null);
  resetLaneAvailabilityCache();
});

function fakeAdapter({ listCollectionsResult, getEmbeddingProfileResult, checkCloudInferenceReachable }) {
  return {
    listCollections: async () => listCollectionsResult,
    getEmbeddingProfile: async () => getEmbeddingProfileResult,
    ...(checkCloudInferenceReachable ? { checkCloudInferenceReachable } : {}),
  };
}

const validProfile = (overrides = {}) => ({
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'dense', dimensions: 512, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client', modifier: null },
    ...overrides,
  },
  embeddingSchemaVersion: 2,
});

describe('mcp/tools/collections.js — qdrant_collection_info availability suffix', () => {
  it('reports ", search: available" for a fully resolved, fully available profile', async () => {
    setStorageAdapter(fakeAdapter({
      listCollectionsResult: [{ name: 'c1', pointCount: 5, provider: { denseProvider: 'hashed-tf', denseModel: 'hashed-tf', sparseProvider: 'hashed-tf' }, description: null }],
      getEmbeddingProfileResult: { state: 'valid', profile: validProfile() },
    }));
    const result = await handle();
    assert.match(result, /\*\*c1\*\*/);
    assert.match(result, /, search: available/);
  });

  it('reports an unavailable reason (never a false "hybrid" or "dense-only available" claim) when sparse is null', async () => {
    setStorageAdapter(fakeAdapter({
      listCollectionsResult: [{ name: 'c1', pointCount: 5, provider: { denseProvider: 'hashed-tf', denseModel: 'hashed-tf', sparseProvider: null }, description: null }],
      getEmbeddingProfileResult: { state: 'valid', profile: validProfile({ sparse: null }) },
    }));
    const result = await handle();
    assert.match(result, /, search: unavailable \(no sparse lane configured\)/);
    assert.doesNotMatch(result, /search: available/);
  });

  it('reports "model cached, runtime not verified" for an ONNX MODEL_CACHED lane — never "available"', async () => {
    setAvailabilityChecks({
      checkOnnxModelCached: async () => ({ status: LANE_STATUS.MODEL_CACHED }),
    });
    setStorageAdapter(fakeAdapter({
      listCollectionsResult: [{ name: 'c1', pointCount: 5, provider: { denseProvider: 'bge-m3-onnx', denseModel: 'aapot/bge-m3-onnx', sparseProvider: 'bge-m3-onnx' }, description: null }],
      getEmbeddingProfileResult: {
        state: 'valid',
        profile: validProfile({
          dense: { provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
          sparse: { provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', vectorName: 'sparse', execution: 'client', modifier: null },
        }),
      },
    }));
    const result = await handle();
    assert.match(result, /, search: model cached, runtime not verified/);
    assert.doesNotMatch(result, /search: available/);
  });

  it('reports a legacy_unmigrated collection as unavailable with the reason named', async () => {
    setStorageAdapter(fakeAdapter({
      listCollectionsResult: [{ name: 'c1', pointCount: 5, provider: { denseProvider: null, denseModel: null, sparseProvider: null }, description: null }],
      getEmbeddingProfileResult: { state: 'missing' },
    }));
    const result = await handle();
    assert.match(result, /, search: unavailable \(legacy_unmigrated\)/);
  });

  it('multiple collections each get their own availability suffix', async () => {
    setStorageAdapter(fakeAdapter({
      listCollectionsResult: [
        { name: 'c1', pointCount: 1, provider: { denseProvider: 'hashed-tf', denseModel: 'hashed-tf', sparseProvider: 'hashed-tf' }, description: null },
        { name: 'c2', pointCount: 2, provider: { denseProvider: null, denseModel: null, sparseProvider: null }, description: null },
      ],
      getEmbeddingProfileResult: { state: 'missing' },
    }));
    const result = await handle();
    assert.match(result, /\*\*c1\*\*/);
    assert.match(result, /\*\*c2\*\*/);
  });

  it('setStorageAdapter(null) resets to the lazy real-adapter default (does not throw when reset)', () => {
    assert.doesNotThrow(() => setStorageAdapter(null));
  });
});

describe('mcp/tools/collections.js — qdrant-cloud lane availability (regression: checkQdrantReachable DI)', () => {
  // Regression test: resolveLaneAvailability() throws
  // "checkQdrantReachable is required for a qdrant-cloud lane" for any
  // qdrant-cloud profile unless a checkQdrantReachable DI is supplied.
  // handle() previously built availabilityChecks with only
  // { checkOllamaLane, checkOnnxModelCached } — omitting it entirely — so a
  // real qdrant-cloud-backed collection made qdrant_collection_info throw
  // uncaught, while qdrant_search (which never resolves availability) kept
  // working fine for the exact same collection.
  const qdrantCloudProfile = validProfile({
    dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
    sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
  });

  it('never throws for a qdrant-cloud lane, and reports availability using the adapter-derived checkQdrantReachable', async () => {
    setStorageAdapter(fakeAdapter({
      listCollectionsResult: [{ name: 'c1', pointCount: 5, provider: { denseProvider: 'qdrant-cloud', denseModel: 'intfloat/multilingual-e5-small', sparseProvider: 'qdrant-cloud' }, description: null }],
      getEmbeddingProfileResult: { state: 'valid', profile: qdrantCloudProfile },
      checkCloudInferenceReachable: async () => ({ status: 'ok' }),
    }));
    const result = await handle();
    assert.match(result, /\*\*c1\*\*/);
    // Tier 1 (checkQdrantReachable) can only ever prove reachability, never
    // inference itself — its ceiling is LANE_STATUS.INFERENCE_UNVERIFIED,
    // never AVAILABLE (see availability.js's own comment on that value),
    // which resolveAvailability maps to the collection-level
    // RUNTIME_UNVERIFIED status — never a false "search: available".
    assert.match(result, /, search: model cached, runtime not verified/);
    assert.doesNotMatch(result, /search: available/);
  });

  it('reports Qdrant unreachable via the SAME adapter method, distinguishing it from an auth failure', async () => {
    setStorageAdapter(fakeAdapter({
      listCollectionsResult: [{ name: 'c1', pointCount: 5, provider: { denseProvider: 'qdrant-cloud', denseModel: 'intfloat/multilingual-e5-small', sparseProvider: 'qdrant-cloud' }, description: null }],
      getEmbeddingProfileResult: { state: 'valid', profile: qdrantCloudProfile },
      checkCloudInferenceReachable: async () => ({ status: 'unreachable', message: 'ECONNREFUSED' }),
    }));
    const result = await handle();
    assert.match(result, /search: unavailable \(ECONNREFUSED\)/);
  });

  it('reports an auth failure distinctly from unreachable', async () => {
    setStorageAdapter(fakeAdapter({
      listCollectionsResult: [{ name: 'c1', pointCount: 5, provider: { denseProvider: 'qdrant-cloud', denseModel: 'intfloat/multilingual-e5-small', sparseProvider: 'qdrant-cloud' }, description: null }],
      getEmbeddingProfileResult: { state: 'valid', profile: qdrantCloudProfile },
      checkCloudInferenceReachable: async () => ({ status: 'auth_failed', message: 'invalid api key' }),
    }));
    const result = await handle();
    assert.match(result, /search: unavailable \(invalid api key\)/);
  });
});
