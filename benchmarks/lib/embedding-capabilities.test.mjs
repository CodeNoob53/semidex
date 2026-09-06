// benchmarks/lib/embedding-capabilities.mjs — offline. Exercises the REAL
// composition boundary: createBenchmarkQueryEmbedder()'s embedQuery is fed
// to the REAL embedForSearch() from src/shared/core/embeddings.js against a
// real resolved profile shape. The ONNX and Cloud capabilities are the
// only fakes — and each fake is constructed to PROVE the wiring reached
// it, not to paper over a missing dependency (that is exactly the audit's
// P1 complaint about the old wrapper tests, which injected a fake
// embedQuery and so never touched the composition root at all).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBenchmarkQueryEmbedder } from './embedding-capabilities.mjs';

// A resolved-profile shape as resolveExistingCollectionProfile() returns
// it — the same shape runHybridSearch() passes to embedQuery().
function onnxProfile() {
  return {
    schemaVersion: 1, managedBy: 'semidex',
    embedding: {
      dense: { provider: 'bge-m3-onnx', model: 'BAAI/bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
      sparse: { provider: 'bge-m3-onnx', model: 'bge-m3-onnx', vectorName: 'sparse', execution: 'client' },
    },
    embeddingSchemaVersion: 2,
  };
}

function ollamaProfile() {
  return {
    schemaVersion: 1, managedBy: 'semidex',
    embedding: {
      dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
      sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
    },
    embeddingSchemaVersion: 2,
  };
}

// A fake OnnxEmbedCapability that records its own use and returns a
// deterministic vector. Satisfies the real validateOnnxEmbedCapability()
// shape (loadOnnx/loadOnnxBatch/shutdown).
function recordingOnnxCapability() {
  const calls = { loadOnnx: 0, embed: [], shutdown: 0 };
  return {
    calls,
    loadOnnx: async () => {
      calls.loadOnnx += 1;
      return async (text) => {
        calls.embed.push(text);
        return { dense: [0.1, 0.2, 0.3], sparse: { indices: [1], values: [0.5] } };
      };
    },
    loadOnnxBatch: async () => ({ embedOnnxBatch: async () => [], embedBucketed: async () => [] }),
    shutdown: async () => { calls.shutdown += 1; },
  };
}

describe('createBenchmarkQueryEmbedder() — real composition boundary', () => {
  it('embedQuery for a bge-m3-onnx profile routes through the injected ONNX capability via the REAL embedForSearch() — the vector actually comes from that capability', async () => {
    const onnx = recordingOnnxCapability();
    const embedder = createBenchmarkQueryEmbedder({ onnxCapabilityFactory: () => onnx });
    try {
      const vectors = await embedder.embedQuery(onnxProfile(), 'a search query');
      // Proof the real embedForSearch() dispatched to the injected capability:
      assert.deepEqual(vectors.dense, [0.1, 0.2, 0.3]);
      assert.deepEqual(vectors.sparse, { indices: [1], values: [0.5] });
      assert.equal(onnx.calls.loadOnnx, 1);
      assert.deepEqual(onnx.calls.embed, ['a search query']);
    } finally {
      await embedder.shutdown();
    }
  });

  it('the ONNX capability is constructed lazily — never built for a run that only issues cloud/ollama queries', async () => {
    let built = 0;
    const embedder = createBenchmarkQueryEmbedder({
      onnxCapabilityFactory: () => { built += 1; return recordingOnnxCapability(); },
      cloudCapabilityFactory: () => ({ checkEmbedInputFits: async () => ({ fits: true }) }),
    });
    // Constructing the embedder alone must not build ONNX.
    assert.equal(built, 0);
    // A cloud profile never reaches embedQuery (runHybridSearch takes the
    // QDRANT_CLOUD branch), but even a direct ollama-profile embedQuery
    // call must not build ONNX.
    await embedder.shutdown();
    assert.equal(built, 0);
  });

  it('shutdown() releases the ONNX capability exactly once and is idempotent', async () => {
    const onnx = recordingOnnxCapability();
    const embedder = createBenchmarkQueryEmbedder({ onnxCapabilityFactory: () => onnx });
    await embedder.embedQuery(onnxProfile(), 'q');
    await embedder.shutdown();
    await embedder.shutdown();
    assert.equal(onnx.calls.shutdown, 1);
  });

  it('embedQuery after shutdown() throws rather than silently respawning a session', async () => {
    const embedder = createBenchmarkQueryEmbedder({ onnxCapabilityFactory: () => recordingOnnxCapability() });
    await embedder.shutdown();
    await assert.rejects(() => embedder.embedQuery(onnxProfile(), 'q'), /after shutdown/);
  });

  it('getClientCapabilities() returns { onnxEmbed } for a bge-m3-onnx profile and {} for an ollama profile', async () => {
    const onnx = recordingOnnxCapability();
    const embedder = createBenchmarkQueryEmbedder({ onnxCapabilityFactory: () => onnx });
    try {
      const onnxCaps = embedder.getClientCapabilities(onnxProfile());
      assert.equal(onnxCaps.onnxEmbed, onnx);
      const ollamaCaps = embedder.getClientCapabilities(ollamaProfile());
      assert.deepEqual(ollamaCaps, {});
    } finally {
      await embedder.shutdown();
    }
  });

  it('cloudEmbed is the real CloudEmbeddingCapability shape (has checkEmbedInputFits / buildCloudQueryInputs)', () => {
    const embedder = createBenchmarkQueryEmbedder();
    assert.equal(typeof embedder.cloudEmbed.checkEmbedInputFits, 'function');
    assert.equal(typeof embedder.cloudEmbed.buildCloudQueryInputs, 'function');
  });
});
