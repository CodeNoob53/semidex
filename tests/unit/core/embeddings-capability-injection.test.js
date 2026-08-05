// Phase 8B Step 1 — core/embeddings.js's capability-injection seam
// (applyEmbeddingCapabilities). Proves, BEHAVIORALLY (via injected fakes,
// never source-regex), that:
//   1. the client (ollama/onnx) embed dispatch calls through the injected
//      capability, not a hardcoded module-scope import;
//   2. the injected fake receives the exact arguments embeddings.js's own
//      dispatch logic is documented to pass;
//   3. a capability error propagates through embedForSearch/embedForIndex
//      unchanged — same message, same identity, no wrapping/swallowing;
//   4. an invalid (non-conforming) capability is rejected by
//      applyEmbeddingCapabilities() itself, before it can ever be called;
//   5. omitting a capability leaves the other's current binding unchanged
//      (partial application, not "the last full call wins").
// This module never restores the real ollama-lazy.js/onnx-embed-lazy.js
// default explicitly mid-suite — it always ends by re-injecting a fresh
// fake in afterEach so no test can leak a fake into another test file's
// run (tests/unit/core/embeddings.test.js's own real-default tests run
// as a SEPARATE process under node:test's file-per-process model, so
// this is defensive, not strictly required by this repo's runner, but
// costs nothing and matches the existing setLocalEmbedOverrideForTest(null)
// afterEach convention in that sibling file).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { embedForSearch, embedForIndex, applyEmbeddingCapabilities } from '../../../src/core/embeddings.js';
import { REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS } from '../../../src/core/generation/ollama-capability.js';
import { REQUIRED_ONNX_EMBED_CAPABILITY_METHODS } from '../../../src/core/onnx-embed-capability.js';

function fakeOllamaCapability(overrides = {}) {
  const base = {};
  for (const m of REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS) base[m] = async () => { throw new Error(`${m} not stubbed`); };
  return { ...base, ...overrides };
}

function fakeOnnxEmbedCapability(overrides = {}) {
  const base = {};
  for (const m of REQUIRED_ONNX_EMBED_CAPABILITY_METHODS) base[m] = async () => { throw new Error(`${m} not stubbed`); };
  return { ...base, ...overrides };
}

function profile({ denseProvider = 'ollama', sparseProvider = 'hashed-tf' } = {}) {
  return {
    schemaVersion: 1,
    managedBy: 'semidex',
    embedding: {
      dense: { provider: denseProvider, model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
      sparse: sparseProvider === null ? null : { provider: sparseProvider, model: sparseProvider, vectorName: 'sparse', execution: 'client' },
    },
    embeddingSchemaVersion: 2,
  };
}

// Restore a harmless real-shaped default after every test so a rejecting
// stub from one test can never leak into another test in this same file
// (module-scope state, same pattern the sibling embeddings.test.js uses
// for setLocalEmbedOverrideForTest).
afterEach(() => {
  applyEmbeddingCapabilities({
    ollama: fakeOllamaCapability({ embed: async () => [0] }),
    onnxEmbed: fakeOnnxEmbedCapability({ loadOnnx: async () => async () => ({ dense: [0], sparse: {} }) }),
  });
});

describe('applyEmbeddingCapabilities — injected fake receives the dispatch call, with correct arguments', () => {
  it('embedForSearch (ollama+hashed-tf profile) calls the injected ollama.embed(text, model) — exact arguments', async () => {
    let received = null;
    applyEmbeddingCapabilities({
      ollama: fakeOllamaCapability({
        embed: async (text, model) => { received = { text, model }; return [1, 2, 3]; },
      }),
    });
    const result = await embedForSearch(profile(), 'hello world');
    assert.deepEqual(received, { text: 'hello world', model: 'bge-m3' });
    assert.deepEqual(result.dense, [1, 2, 3]);
    assert.ok(result.sparse, 'hashed-tf sparse encoding still runs independently of the injected capability');
  });

  it('embedForIndex (bge-m3-onnx profile) calls the injected onnxEmbed.loadOnnx() and then the returned embed function with the exact text', async () => {
    let loadCalled = false;
    let embedCalledWith = null;
    applyEmbeddingCapabilities({
      onnxEmbed: fakeOnnxEmbedCapability({
        loadOnnx: async () => {
          loadCalled = true;
          return async (text) => { embedCalledWith = text; return { dense: [9, 9], sparse: { indices: [], values: [] } }; };
        },
      }),
    });
    const result = await embedForIndex(profile({ denseProvider: 'bge-m3-onnx', sparseProvider: 'bge-m3-onnx' }), 'index this chunk');
    assert.equal(loadCalled, true);
    assert.equal(embedCalledWith, 'index this chunk');
    assert.deepEqual(result.dense, [9, 9]);
  });
});

describe('applyEmbeddingCapabilities — capability errors propagate unchanged, never wrapped or swallowed', () => {
  it('a rejecting ollama.embed() rejects embedForSearch with the SAME error (identity preserved, not re-thrown as a new Error)', async () => {
    class FakeOllamaDownError extends Error {
      constructor() { super('Ollama connection refused'); this.name = 'FakeOllamaDownError'; this.code = 'econnrefused'; }
    }
    const originalError = new FakeOllamaDownError();
    applyEmbeddingCapabilities({ ollama: fakeOllamaCapability({ embed: async () => { throw originalError; } }) });
    await assert.rejects(() => embedForSearch(profile(), 'q'), (err) => {
      assert.equal(err, originalError, 'the exact same error instance must propagate, not a wrapped/new one');
      assert.equal(err.code, 'econnrefused');
      return true;
    });
  });

  it('a rejecting onnxEmbed.loadOnnx() rejects embedForIndex with the SAME error', async () => {
    const originalError = new Error('onnx runtime failed to initialize');
    applyEmbeddingCapabilities({ onnxEmbed: fakeOnnxEmbedCapability({ loadOnnx: async () => { throw originalError; } }) });
    await assert.rejects(
      () => embedForIndex(profile({ denseProvider: 'bge-m3-onnx', sparseProvider: 'bge-m3-onnx' }), 'x'),
      (err) => { assert.equal(err, originalError); return true; },
    );
  });
});

describe('per-call `capabilities` parameter — the real isolation seam (code review round 3), independent of applyEmbeddingCapabilities()\'s shared module-scope fallback', () => {
  it('embedForSearch\'s own `capabilities` argument is used INSTEAD of the module-scope default set by applyEmbeddingCapabilities() — even when the module default would reject', async () => {
    // Module-scope default set to a REJECTING fake — if per-call
    // `capabilities` were not truly isolated, this would leak through.
    applyEmbeddingCapabilities({ ollama: fakeOllamaCapability({ embed: async () => { throw new Error('must never be reached — this is the WRONG capability for this call'); } }) });

    let received = null;
    const perCallCapability = { ollama: fakeOllamaCapability({ embed: async (text, model) => { received = { text, model }; return [7, 7]; } }) };
    const result = await embedForSearch(profile(), 'isolated query', { capabilities: perCallCapability });
    assert.deepEqual(received, { text: 'isolated query', model: 'bge-m3' });
    assert.deepEqual(result.dense, [7, 7]);
  });

  it('embedForIndex\'s own `capabilities` argument is used for the ONNX lane too, bypassing the module-scope onnxEmbed default', async () => {
    applyEmbeddingCapabilities({ onnxEmbed: fakeOnnxEmbedCapability({ loadOnnx: async () => { throw new Error('must never be reached'); } }) });

    let embedCalledWith = null;
    const perCallCapability = {
      onnxEmbed: fakeOnnxEmbedCapability({
        loadOnnx: async () => async (text) => { embedCalledWith = text; return { dense: [3], sparse: {} }; },
      }),
    };
    const result = await embedForIndex(
      profile({ denseProvider: 'bge-m3-onnx', sparseProvider: 'bge-m3-onnx' }),
      'isolated index text',
      { capabilities: perCallCapability },
    );
    assert.equal(embedCalledWith, 'isolated index text');
    assert.deepEqual(result.dense, [3]);
  });

  it('two concurrent embedForSearch calls with DIFFERENT per-call capabilities never interfere with each other, even though applyEmbeddingCapabilities() was never called between them', async () => {
    // The concrete architectural claim: two "composition roots" (here,
    // just two different capability objects) can safely coexist in one
    // process AT THE SAME TIME as long as each caller passes its own
    // capabilities explicitly — no shared mutable state is consulted by
    // either call.
    const capabilityA = { ollama: fakeOllamaCapability({ embed: async (text) => [`A:${text}`] }) };
    const capabilityB = { ollama: fakeOllamaCapability({ embed: async (text) => [`B:${text}`] }) };

    const [resultA, resultB] = await Promise.all([
      embedForSearch(profile(), 'query-1', { capabilities: capabilityA }),
      embedForSearch(profile(), 'query-2', { capabilities: capabilityB }),
    ]);
    assert.deepEqual(resultA.dense, ['A:query-1']);
    assert.deepEqual(resultB.dense, ['B:query-2']);
  });

  it('omitting `capabilities` entirely still falls back to the module-scope applyEmbeddingCapabilities() default — backward compatible with every pre-existing caller', async () => {
    applyEmbeddingCapabilities({ ollama: fakeOllamaCapability({ embed: async (text) => [`default:${text}`] }) });
    const result = await embedForSearch(profile(), 'no-capabilities-arg');
    assert.deepEqual(result.dense, ['default:no-capabilities-arg']);
  });
});

describe('applyEmbeddingCapabilities — validates before installing, and supports partial application', () => {
  it('rejects an ollama capability missing a required method — the previously-installed capability stays active (not replaced by a broken one)', async () => {
    let goodCallCount = 0;
    applyEmbeddingCapabilities({ ollama: fakeOllamaCapability({ embed: async () => { goodCallCount++; return [1]; } }) });

    const broken = fakeOllamaCapability();
    delete broken.embed;
    assert.throws(() => applyEmbeddingCapabilities({ ollama: broken }), /embed/);

    await embedForSearch(profile(), 'still works');
    assert.equal(goodCallCount, 1, 'the good capability installed before the rejected call must still be active');
  });

  it('omitting onnxEmbed when calling applyEmbeddingCapabilities({ ollama }) leaves the current onnxEmbed binding unchanged', async () => {
    let onnxLoadCalls = 0;
    applyEmbeddingCapabilities({ onnxEmbed: fakeOnnxEmbedCapability({ loadOnnx: async () => { onnxLoadCalls++; return async () => ({ dense: [0], sparse: {} }); } }) });
    // Re-apply ONLY ollama — must not reset onnxEmbed back to any default.
    applyEmbeddingCapabilities({ ollama: fakeOllamaCapability({ embed: async () => [1] }) });

    await embedForIndex(profile({ denseProvider: 'bge-m3-onnx', sparseProvider: 'bge-m3-onnx' }), 'y');
    assert.equal(onnxLoadCalls, 1, 'the onnxEmbed capability installed earlier must still be the one in effect');
  });
});
