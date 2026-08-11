// createOnnxEmbeddingCapability()'s getResourceIdentity() — the relocated
// ONNX embedding device-classification logic (formerly
// resolveEmbeddingResourceIdentity() in the now fully-provider-agnostic
// device/resource-identity.js). Fully hermetic — fake ONNX Runtime + fake
// tokenizer, same pattern as
// tests/unit/core/onnx-embed-instance-isolation.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createOnnxEmbeddingCapability } from '../../../../src/local/core/onnx-embed.js';

function makeFakeSession({ createSession } = {}) {
  return {
    outputNames: ['dense_vecs', 'sparse_vecs'],
    async run(feeds) {
      const seqLen = feeds.input_ids.dims[1];
      const batchSize = feeds.input_ids.dims[0];
      return {
        dense_vecs: { data: new Float32Array(batchSize * 1024).fill(0.1) },
        sparse_vecs: { data: new Float32Array(batchSize * seqLen).fill(0.2) },
      };
    },
    async release() {},
  };
}

function makeFakeOrt({ createSession } = {}) {
  return {
    InferenceSession: {
      async create(modelPath, opts) {
        if (createSession) return createSession(modelPath, opts);
        return makeFakeSession();
      },
    },
    Tensor: class FakeTensor {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    },
  };
}

function fakeTokenizer() {
  return { encode: () => ({ ids: [0, 5, 6, 7, 2], attention_mask: [1, 1, 1, 1, 1], token_type_ids: [0, 0, 0, 0, 0] }) };
}

function hermeticCapabilityOptions(ortOverrides = {}) {
  return {
    ortFactory: () => makeFakeOrt(ortOverrides),
    loadTokenizerAndModel: async () => ({ tokenizer: fakeTokenizer() }),
  };
}

describe('createOnnxEmbeddingCapability() — getResourceIdentity()', () => {
  test('before any embed call (no session yet) -> unverified cpu default, ONNX_EXECUTION_PROVIDER unset', async () => {
    const savedProvider = process.env.ONNX_EXECUTION_PROVIDER;
    delete process.env.ONNX_EXECUTION_PROVIDER;
    try {
      const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
      const result = cap.getResourceIdentity();
      assert.deepEqual(result, { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: false, source: 'manual' });
    } finally {
      if (savedProvider === undefined) delete process.env.ONNX_EXECUTION_PROVIDER; else process.env.ONNX_EXECUTION_PROVIDER = savedProvider;
    }
  });

  test('before any embed call, ONNX_EXECUTION_PROVIDER=dml -> unverified gpu (settings intent, not yet confirmed)', async () => {
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    const result = cap.getResourceIdentity({ env: { ONNX_EXECUTION_PROVIDER: 'dml' } });
    assert.deepEqual(result, { kind: 'gpu', backend: 'onnx-dml', deviceId: null, verified: false, source: 'manual' });
  });

  test('before any embed call, ONNX_EXECUTION_PROVIDER=cuda -> unverified gpu', async () => {
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    const result = cap.getResourceIdentity({ env: { ONNX_EXECUTION_PROVIDER: 'cuda' } });
    assert.deepEqual(result, { kind: 'gpu', backend: 'onnx-cuda', deviceId: null, verified: false, source: 'manual' });
  });

  test('after a real embed call (session created, cpu provider) -> verified cpu', async () => {
    const savedProvider = process.env.ONNX_EXECUTION_PROVIDER;
    delete process.env.ONNX_EXECUTION_PROVIDER;
    try {
      const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
      const embedFn = await cap.loadOnnx();
      await embedFn('some text');
      const result = cap.getResourceIdentity();
      assert.deepEqual(result, { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' });
    } finally {
      if (savedProvider === undefined) delete process.env.ONNX_EXECUTION_PROVIDER; else process.env.ONNX_EXECUTION_PROVIDER = savedProvider;
    }
  });

  test('after a real embed call with CUDA fallback to CPU -> verified cpu (the REAL effective provider, not the request)', async () => {
    const savedProvider = process.env.ONNX_EXECUTION_PROVIDER;
    process.env.ONNX_EXECUTION_PROVIDER = 'cuda';
    try {
      let callCount = 0;
      const cap = createOnnxEmbeddingCapability({
        ...hermeticCapabilityOptions(),
        ortFactory: () => makeFakeOrt({
          createSession: async (modelPath, opts) => {
            callCount += 1;
            if (opts?.executionProviders?.[0] === 'cuda') throw new Error('CUDA not available in test');
            return makeFakeSession();
          },
        }),
      });
      const embedFn = await cap.loadOnnx();
      await embedFn('some text');
      const result = cap.getResourceIdentity();
      assert.deepEqual(result, { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' });
    } finally {
      if (savedProvider === undefined) delete process.env.ONNX_EXECUTION_PROVIDER; else process.env.ONNX_EXECUTION_PROVIDER = savedProvider;
    }
  });

  test('two independently-constructed instances never share getResourceIdentity() state', async () => {
    const capA = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    const capB = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    const embedFnA = await capA.loadOnnx();
    await embedFnA('text');
    // capA has a real session now; capB never embedded anything.
    assert.equal(capA.getResourceIdentity({ env: {} }).verified, true);
    assert.equal(capB.getResourceIdentity({ env: {} }).verified, false);
  });
});
