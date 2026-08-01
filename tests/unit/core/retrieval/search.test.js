import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHybridSearch, resolveSearchMode } from '../../../../src/core/retrieval/search.js';
import { loadQdrantCloudTokenizer } from '../../../../src/core/embedding-profile/qdrant-cloud-tokenizer.js';

let e5TokenizerAvailable = true;
try {
  await loadQdrantCloudTokenizer('intfloat/multilingual-e5-small', { localFilesOnly: true });
} catch {
  e5TokenizerAvailable = false;
}

const validProfile = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function fakeAdapter({ capabilities, collection, hits, embeddingProfileResult } = {}) {
  return {
    capabilities: () => capabilities ?? { hybridSearch: true, sparseVectors: true },
    getCollection: async (name) => (collection === undefined ? { name } : collection),
    getEmbeddingProfile: async () => embeddingProfileResult ?? { state: 'valid', profile: validProfile },
    searchHybridVectors: async (name, opts) => {
      fakeAdapter.lastCall = { name, opts };
      return hits ?? [];
    },
    searchHybridInference: async (name, opts) => {
      fakeAdapter.lastInferenceCall = { name, opts };
      return hits ?? [];
    },
  };
}

describe('resolveSearchMode', () => {
  test('hybrid when both capabilities present', () => {
    assert.equal(resolveSearchMode({ hybridSearch: true, sparseVectors: true }), 'hybrid');
  });
  test('null when either capability missing', () => {
    assert.equal(resolveSearchMode({ hybridSearch: true, sparseVectors: false }), null);
    assert.equal(resolveSearchMode({ hybridSearch: false, sparseVectors: true }), null);
  });
});

describe('runHybridSearch', () => {
  test('returns not_implemented when adapter lacks hybrid capabilities', async () => {
    const adapter = fakeAdapter({ capabilities: { hybridSearch: false, sparseVectors: false } });
    const result = await runHybridSearch({ adapter, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'not_implemented');
  });

  test('returns collection_not_found when adapter.getCollection resolves null', async () => {
    const adapter = fakeAdapter({ collection: null });
    const result = await runHybridSearch({ adapter, collection: 'missing', query: 'q', top: 5 });
    assert.equal(result.error, 'collection_not_found');
    assert.match(result.message, /missing/);
  });

  test('returns embedding_failed when embedQuery rejects', async () => {
    const adapter = fakeAdapter();
    const embedQuery = async () => { throw new Error('boom'); };
    const result = await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'embedding_failed');
    assert.match(result.message, /boom/);
  });

  test('always sets excludeNav: true on the filter, even with no other filters', async () => {
    const adapter = fakeAdapter();
    const embedQuery = async () => ({ dense: [1, 2], sparse: { indices: [], values: [] } });
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.deepEqual(fakeAdapter.lastCall.opts.filter, { excludeNav: true });
  });

  test('merges sourceFile and tags filters alongside excludeNav', async () => {
    const adapter = fakeAdapter();
    const embedQuery = async () => ({ dense: [1], sparse: {} });
    await runHybridSearch({
      adapter, embedQuery, collection: 'c', query: 'q', top: 5,
      filters: { sourceFile: 'docs/a.md', tags: ['x', 'y'] },
    });
    assert.deepEqual(fakeAdapter.lastCall.opts.filter, {
      sourceFile: 'docs/a.md', tags: ['x', 'y'], excludeNav: true,
    });
  });

  test('passes dense/sparse vectors and limit through to searchHybridVectors, returns hits and searchMode', async () => {
    const hits = [{ sourceFile: 'a.md', chunkIndex: 0, score: 0.9 }];
    const adapter = fakeAdapter({ hits });
    const embedQuery = async () => ({ dense: [0.1, 0.2], sparse: { indices: [1], values: [0.5] } });
    const result = await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 7 });
    assert.equal(result.searchMode, 'hybrid');
    assert.deepEqual(result.hits, hits);
    assert.deepEqual(fakeAdapter.lastCall.opts, {
      dense: [0.1, 0.2], sparse: { indices: [1], values: [0.5] }, limit: 7, filter: { excludeNav: true },
      settingsService: undefined,
    });
  });

  test('forwards a supplied settingsService through to searchHybridVectors (so HYBRID_PREFETCH_LIMIT/RRF_K apply to admin search and Ask, not just MCP)', async () => {
    const adapter = fakeAdapter();
    const embedQuery = async () => ({ dense: [1], sparse: {} });
    const fakeSettingsService = { getActiveValue: () => 42, refreshIfChanged: () => {} };
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5, settingsService: fakeSettingsService });
    assert.equal(fakeAdapter.lastCall.opts.settingsService, fakeSettingsService);
  });

  test('passes the RESOLVED PROFILE (not a bare collection string) to embedQuery', async () => {
    const adapter = fakeAdapter();
    let capturedFirstArg;
    const embedQuery = async (profileArg, query) => { capturedFirstArg = profileArg; return { dense: [1], sparse: {} }; };
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.deepEqual(capturedFirstArg, validProfile);
  });

  test('resolution failure short-circuits BEFORE embedQuery is ever called — never invokes a local default model for an unresolved profile', async () => {
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'missing' } });
    let embedQueryCalled = false;
    const embedQuery = async () => { embedQueryCalled = true; return { dense: [1], sparse: {} }; };
    const result = await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'embedding_unresolved');
    assert.equal(embedQueryCalled, false);
  });

  test('an "invalid" profile state also produces embedding_unresolved, never a silent fallback', async () => {
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'invalid', errors: ['bad'] } });
    const result = await runHybridSearch({ adapter, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'embedding_unresolved');
  });

  test('a profile with a still-unimplemented execution mode (e.g. qdrant-cluster) produces embedding_unsupported, never invoking embedQuery', async () => {
    const clusterProfile = { ...validProfile, embedding: { ...validProfile.embedding, dense: { ...validProfile.embedding.dense, execution: 'qdrant-cluster' } } };
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: clusterProfile } });
    let embedQueryCalled = false;
    const embedQuery = async () => { embedQueryCalled = true; return { dense: [1], sparse: {} }; };
    const result = await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'embedding_unsupported');
    assert.match(result.message, /qdrant-cluster/);
    assert.equal(embedQueryCalled, false);
  });

  // Existing-collection immutability (section 6, second half): if a
  // collection's STORED model is no longer in the catalog (removed, or
  // downgraded from supported to unsupported/planned in a future catalog
  // edit), search must block with a clean, typed error — never a raw
  // Qdrant-side "unrecognized model" failure, and never a silent fallback
  // to some other model. Uses buildCloudQueryInputs's own sibling check
  // (findDenseModel/status==='supported', search.js lines ~104-108) —
  // already implemented before this task; this test pins it down.
  test('a collection whose stored dense model is no longer in the catalog blocks search with a clean embedding_unsupported error, before any inference descriptor is built', async () => {
    const removedModelProfile = {
      ...validProfile,
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'some-model-removed-from-catalog', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
    };
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: removedModelProfile } });
    const result = await runHybridSearch({ adapter, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'embedding_unsupported');
    assert.match(result.message, /some-model-removed-from-catalog/);
    assert.match(result.message, /not a supported Qdrant Cloud model/);
    assert.equal(fakeAdapter.lastInferenceCall, undefined, 'no inference descriptor may ever be built/sent for an unsupported model');
  });

  test('a collection whose stored dense model is status:planned (dedicated-tier, e.g. mxbai) also blocks search the same way — planned is not supported', async () => {
    const plannedModelProfile = {
      ...validProfile,
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'mixedbread-ai/mxbai-embed-large-v1', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
    };
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: plannedModelProfile } });
    const result = await runHybridSearch({ adapter, collection: 'c', query: 'q', top: 5 });
    assert.equal(result.error, 'embedding_unsupported');
    assert.equal(fakeAdapter.lastInferenceCall, undefined);
  });

  test('a qdrant-cloud profile never calls embedQuery, builds inference descriptors, and calls searchHybridInference (not searchHybridVectors)', async () => {
    const cloudProfile = {
      ...validProfile,
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
    };
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: cloudProfile } });
    let embedQueryCalled = false;
    const embedQuery = async () => { embedQueryCalled = true; return { dense: [1], sparse: {} }; };
    const result = await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'ukrainian query', top: 5 });
    assert.equal(embedQueryCalled, false, 'embedQuery (the client-only DI) must never be called for a cloud profile');
    assert.equal(result.searchMode, 'hybrid');
    assert.deepEqual(fakeAdapter.lastInferenceCall.opts.denseQuery, { text: 'ukrainian query', model: 'intfloat/multilingual-e5-small' });
    assert.deepEqual(fakeAdapter.lastInferenceCall.opts.sparseQuery, { text: 'ukrainian query', model: 'qdrant/bm25' });
    assert.ok(!('modifier' in fakeAdapter.lastInferenceCall.opts.sparseQuery), 'sparse inference descriptor must never carry modifier — that is schema-only, set at createCollection time');
    assert.ok(!('options' in fakeAdapter.lastInferenceCall.opts.sparseQuery), 'sparse inference descriptor must never carry options for BM25');
  });

  // Existing-collection immutability (Semidex Lite / model-selection task,
  // section 6): the GLOBAL QDRANT_CLOUD_DENSE_MODEL setting must never
  // leak into a search against an EXISTING collection — only that
  // collection's own stored profile (resolveExistingCollectionProfile())
  // may determine which model embeds the query. A settingsService whose
  // QDRANT_CLOUD_DENSE_MODEL differs from the collection's real stored
  // model, and which THROWS if ever asked for that specific key, proves
  // runHybridSearch() never consults it for model selection at all — the
  // throw would surface as a test failure if this invariant regressed.
  test('a global QDRANT_CLOUD_DENSE_MODEL setting change (e.g. to MiniLM) has ZERO effect on a search against an existing E5 collection', async () => {
    const e5Profile = {
      ...validProfile,
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
    };
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: e5Profile } });
    // A global settings selection that has since moved to MiniLM — if
    // runHybridSearch() ever consulted this for the DENSE MODEL choice
    // (as opposed to its legitimate uses, HYBRID_PREFETCH_LIMIT/RRF_K),
    // this throw would surface as a test failure, not a silent wrong
    // answer — a stronger guarantee than merely asserting the query still
    // used E5 (which a coincidental correct-by-accident implementation
    // could also satisfy).
    const settingsService = {
      getActiveValue(key) {
        if (key === 'QDRANT_CLOUD_DENSE_MODEL') {
          throw new Error('runHybridSearch must never consult the global QDRANT_CLOUD_DENSE_MODEL setting for an EXISTING collection\'s search — only resolveExistingCollectionProfile()\'s stored profile');
        }
        if (key === 'HYBRID_PREFETCH_LIMIT') return 100;
        if (key === 'RRF_K') return 60;
        return undefined;
      },
    };
    const result = await runHybridSearch({ adapter, collection: 'existing-e5-collection', query: 'query text', top: 5, settingsService });
    assert.equal(result.searchMode, 'hybrid');
    assert.equal(fakeAdapter.lastInferenceCall.opts.denseQuery.model, 'intfloat/multilingual-e5-small', 'must use the COLLECTION\'S stored E5 model, never the (hypothetically changed) global default');
  });

  test('same-dimension-different-model is never accepted as compatible: two profiles with equal dimensions but different models are passed through distinctly, never cross-substituted', async () => {
    const profileA = validProfile;
    const profileB = { ...validProfile, embedding: { ...validProfile.embedding, dense: { ...validProfile.embedding.dense, model: 'a-completely-different-model', dimensions: 1024 } } };
    const adapterA = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: profileA } });
    const adapterB = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: profileB } });
    const captured = [];
    const embedQuery = async (profileArg) => { captured.push(profileArg.embedding.dense.model); return { dense: [1], sparse: {} }; };
    await runHybridSearch({ adapter: adapterA, embedQuery, collection: 'c', query: 'q', top: 5 });
    await runHybridSearch({ adapter: adapterB, embedQuery, collection: 'c', query: 'q', top: 5 });
    assert.equal(captured[0], 'bge-m3');
    assert.equal(captured[1], 'a-completely-different-model');
    assert.notEqual(captured[0], captured[1], 'equal dimensions must never cause the two distinct models to be treated as interchangeable');
  });

  test('REGRESSION (P2 fix): an over-long query against a qdrant-cloud profile is rejected with a typed error BEFORE any inference descriptor is sent — never silently truncated by Qdrant', { skip: !e5TokenizerAvailable }, async () => {
    const cloudProfile = {
      ...validProfile,
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
    };
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: cloudProfile } });
    // Dense camelCase-identifier text — same regression fixture shape as
    // qdrant-cloud-catalog.test.js's own checkEmbedInputFits() proof: the
    // heuristic would call this short enough, but the real E5 tokenizer
    // counts well over 512 tokens.
    const chunk = 'resolveEmbeddingProfileFromCollectionInfoConfigMetadataParamsVectorsSparseVectors ';
    let longQuery = '';
    let heuristicEstimate = 0;
    while (heuristicEstimate < 480) {
      longQuery += chunk;
      heuristicEstimate = Math.ceil(longQuery.length / 4);
    }
    fakeAdapter.lastInferenceCall = undefined; // reset the shared static before asserting it stays unset
    const result = await runHybridSearch({ adapter, collection: 'c', query: longQuery, top: 5 });
    assert.equal(result.error, 'embedding_failed');
    assert.match(result.message, /too long/);
    assert.equal(fakeAdapter.lastInferenceCall, undefined, 'searchHybridInference must never be called for a rejected query — no partial/truncated request sent');
  });

  test('a short query against a qdrant-cloud profile still succeeds (the length check does not block normal queries)', { skip: !e5TokenizerAvailable }, async () => {
    const cloudProfile = {
      ...validProfile,
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
    };
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: cloudProfile } });
    const result = await runHybridSearch({ adapter, collection: 'c', query: 'a normal length query', top: 5 });
    assert.equal(result.error, undefined);
    assert.equal(result.searchMode, 'hybrid');
  });
});

describe('runHybridSearch — query-side opt-in benchmark telemetry (SEMIDEX_BENCH_TELEMETRY_PATH)', () => {
  const cloudProfile = {
    ...validProfile,
    embedding: {
      dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
      sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
    },
  };

  let telemetryDir;
  let telemetryPath;

  test.beforeEach(() => {
    telemetryDir = mkdtempSync(join(tmpdir(), 'semidex-search-telemetry-test-'));
    telemetryPath = join(telemetryDir, 'telemetry.jsonl');
  });

  test.afterEach(() => {
    delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
    rmSync(telemetryDir, { recursive: true, force: true });
  });

  function readEvents() {
    if (!existsSync(telemetryPath)) return [];
    return readFileSync(telemetryPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  test('a qdrant-cloud query emits exactly one dense and one sparse phase:"query" event', async () => {
    process.env.SEMIDEX_BENCH_TELEMETRY_PATH = telemetryPath;
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: cloudProfile } });
    await runHybridSearch({ adapter, collection: 'c', query: 'ukrainian query', top: 5 });
    const events = readEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'inference');
    assert.equal(events[0].phase, 'query');
    assert.equal(events[0].lane, 'dense');
    assert.equal(events[0].textLength, 'ukrainian query'.length);
    assert.equal(events[0].model, 'intfloat/multilingual-e5-small');
    assert.equal(events[1].lane, 'sparse');
    assert.equal(events[1].model, 'qdrant/bm25');
  });

  test('a CLIENT-execution (local) profile query emits NO telemetry — query-side cloud telemetry is cloud-only by construction', async () => {
    process.env.SEMIDEX_BENCH_TELEMETRY_PATH = telemetryPath;
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: validProfile } });
    const embedQuery = async () => ({ dense: [1], sparse: {} });
    await runHybridSearch({ adapter, embedQuery, collection: 'c', query: 'a query', top: 5 });
    assert.deepEqual(readEvents(), []);
  });

  test('emits no telemetry when SEMIDEX_BENCH_TELEMETRY_PATH is unset', async () => {
    delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: cloudProfile } });
    await runHybridSearch({ adapter, collection: 'c', query: 'ukrainian query', top: 5 });
    assert.deepEqual(readEvents(), []);
  });

  test('an over-long query rejected before any descriptor is built emits no telemetry', { skip: !e5TokenizerAvailable }, async () => {
    process.env.SEMIDEX_BENCH_TELEMETRY_PATH = telemetryPath;
    const adapter = fakeAdapter({ embeddingProfileResult: { state: 'valid', profile: cloudProfile } });
    const chunk = 'resolveEmbeddingProfileFromCollectionInfoConfigMetadataParamsVectorsSparseVectors ';
    let longQuery = '';
    let heuristicEstimate = 0;
    while (heuristicEstimate < 480) {
      longQuery += chunk;
      heuristicEstimate = Math.ceil(longQuery.length / 4);
    }
    const result = await runHybridSearch({ adapter, collection: 'c', query: longQuery, top: 5 });
    assert.equal(result.error, 'embedding_failed');
    assert.deepEqual(readEvents(), []);
  });
});

describe('storage layering — qdrant-adapter.js never imports embedding-runtime code', () => {
  test('src/core/storage/qdrant-adapter.js never imports embeddings.js/onnx-embed.js/ollama.js — a real source-level layering check, distinct from the banned "proves ONNX wasn\'t called" regex use', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/storage/qdrant-adapter.js', import.meta.url)),
      'utf-8',
    );
    for (const banned of ["'../embeddings.js'", "'../onnx-embed.js'", "'../ollama.js'", '"../embeddings.js"', '"../onnx-embed.js"', '"../ollama.js"']) {
      assert.ok(!src.includes(banned), `qdrant-adapter.js must never import ${banned} — the storage adapter only ever executes storage requests, never decides whether to run a local embed`);
    }
  });

  test('src/core/qdrant/store.js never imports embeddings.js/onnx-embed.js/ollama.js either', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../src/core/qdrant/store.js', import.meta.url)),
      'utf-8',
    );
    for (const banned of ["'../embeddings.js'", "'../onnx-embed.js'", "'../ollama.js'", '"../embeddings.js"', '"../onnx-embed.js"', '"../ollama.js"']) {
      assert.ok(!src.includes(banned), `store.js must never import ${banned}`);
    }
  });
});
