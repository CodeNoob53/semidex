// core/onnx-embed-lazy.js — createOnnxEmbeddingCapability()'s own
// concurrent-first-call safety (code review, P1).
//
// This wrapper defers constructing the REAL underlying local/core/
// onnx-embed.js capability until the first actual method call
// (loadOnnx()/loadOnnxBatch()/shutdown()), per its own header comment.
// ensureInstance() used to memoize only `_instance` — a binding not
// assigned until AFTER `await Promise.all([...])` resolves — so two
// concurrent first calls (e.g. loadOnnx() and loadOnnxBatch() invoked
// back to back with no intervening await, or two concurrent loadOnnx()
// calls) both observed `_instance` still null, both proceeded past the
// guard, and both constructed a real underlying instance: the second
// assignment silently overwrote the first, orphaning its ONNX session
// (no reference to it survives anywhere, so shutdown() can never release
// it). Fixed by memoizing the in-flight PROMISE itself, synchronously,
// before any `await` runs.
//
// These tests exercise onnx-embed-lazy.js's own wrapper directly, using
// its underscore-prefixed `_testOnlyRealFactoryOptions` parameter — a
// deliberate, test-only pass-through straight to the real
// local/core/onnx-embed.js createOnnxEmbeddingCapability()'s own
// `ortFactory`/`loadTokenizerAndModel` DI seams (see that parameter's own
// comment in onnx-embed-lazy.js). Production callers never pass it. This
// keeps the whole file fully hermetic — the wrapper's own real dynamic
// import of local/core/onnx-embed.js still runs for real (proving the
// import itself resolves correctly), but the ONNX session/tokenizer it
// constructs are fakes, so no real 2.3GB model is ever touched.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createOnnxEmbeddingCapability as createLazyCapability } from '../../../src/core/onnx-embed-lazy.js';

function makeFakeSession() {
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

function makeFakeOrt({ createSession, createCalls } = {}) {
  return {
    InferenceSession: {
      async create(modelPath, opts) {
        if (createCalls) createCalls.push({ modelPath, opts });
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
  return {
    encode: () => ({ ids: [0, 5, 6, 7, 2], attention_mask: [1, 1, 1, 1, 1], token_type_ids: [0, 0, 0, 0, 0] }),
  };
}

function hermeticFactoryOptions(ortOverrides = {}) {
  return {
    ortFactory: () => makeFakeOrt(ortOverrides),
    loadTokenizerAndModel: async () => ({ tokenizer: fakeTokenizer() }),
  };
}

// A gated variant: loadTokenizerAndModel() does not resolve until the
// returned `release()` function is called — lets a test genuinely pause
// construction mid-flight, the same way onnx-embed-instance-isolation's
// own gated-session tests prove a real interleaving rather than a
// simulated one.
function gatedHermeticFactoryOptions({ releaseCalls } = {}) {
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const options = {
    ortFactory: () => makeFakeOrt({ createSession: () => ({ ...makeFakeSession(), async release() { if (releaseCalls) releaseCalls.push(true); } }) }),
    loadTokenizerAndModel: async () => { await gate; return { tokenizer: fakeTokenizer() }; },
  };
  return { options, release: () => releaseGate() };
}

describe('core/onnx-embed-lazy.js — createOnnxEmbeddingCapability() concurrent-first-call safety (code review, P1)', () => {
  test('two concurrent loadOnnx() calls on ONE wrapper construct the real underlying instance exactly once', async () => {
    const createCalls = [];
    const wrapper = createLazyCapability(hermeticFactoryOptions({ createCalls }));
    const [embedA, embedB] = await Promise.all([wrapper.loadOnnx(), wrapper.loadOnnx()]);
    assert.equal(embedA, embedB, 'both callers must receive the exact same underlying embed function, proving they share one real instance');
    await embedA('trigger session creation');
    assert.equal(createCalls.length, 1, 'two concurrent first calls must share ONE real underlying instance/session, not construct two and silently drop one');
    await wrapper.shutdown();
  });

  test('a loadOnnx() and a loadOnnxBatch() call issued back to back (no intervening await) share the same real underlying instance', async () => {
    const createCalls = [];
    const wrapper = createLazyCapability(hermeticFactoryOptions({ createCalls }));
    // Deliberately no `await` between these two calls — both run their
    // synchronous prelude (including the `if (!_instancePromise)` guard)
    // before either has a chance to await anything.
    const loadOnnxPromise = wrapper.loadOnnx();
    const loadOnnxBatchPromise = wrapper.loadOnnxBatch();
    const [embedFn, batchResult] = await Promise.all([loadOnnxPromise, loadOnnxBatchPromise]);
    assert.equal(typeof embedFn, 'function');
    assert.equal(typeof batchResult.embedOnnxBatch, 'function');
    await batchResult.embedOnnxBatch(['x']);
    assert.equal(createCalls.length, 1, 'loadOnnx() and loadOnnxBatch() issued concurrently must still construct the real instance/session exactly once');
    await wrapper.shutdown();
  });

  test('a shutdown() racing against a concurrent, still-in-flight first loadOnnx() call waits for it and still releases the real session — never silently no-ops because _instance was not yet assigned', async () => {
    const releaseCalls = [];
    const { options, release } = gatedHermeticFactoryOptions({ releaseCalls });
    const wrapper = createLazyCapability(options);

    const loadPromise = wrapper.loadOnnx().then((embed) => embed('a load still gated mid-flight'));
    await new Promise((resolve) => setTimeout(resolve, 10)); // let loadOnnx()/ensureInstance() genuinely start and reach the gated tokenizer step

    const shutdownPromise = wrapper.shutdown();
    let shutdownResolved = false;
    shutdownPromise.then(() => { shutdownResolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shutdownResolved, false, 'shutdown() must wait for the in-flight construction/load, not return immediately');
    assert.equal(releaseCalls.length, 0, 'no session exists yet to release — construction has not reached InferenceSession.create() yet');

    release(); // let the gated tokenizer load (and therefore the whole construction) proceed
    await shutdownPromise;
    assert.equal(releaseCalls.length, 1, 'the session the in-flight construction eventually produced must be released exactly once');

    await assert.doesNotReject(() => loadPromise.catch(() => {}));
    await assert.doesNotReject(() => wrapper.shutdown());
    assert.equal(releaseCalls.length, 1, 'a second shutdown() call must not release the session a second time');
  });

  test('getOnnxProviderState() during a still-in-flight first construction returns null, not a crash — and reflects the real state once construction settles', async () => {
    const wrapper = createLazyCapability(hermeticFactoryOptions());
    const loadPromise = wrapper.loadOnnx().then((embed) => embed('x'));
    assert.equal(wrapper.getOnnxProviderState(), null, 'construction has not settled yet — must report null, never throw');
    await loadPromise;
    assert.deepEqual(wrapper.getOnnxProviderState(), { requested: 'cpu', effective: 'cpu', fellBackToCpu: false });
    await wrapper.shutdown();
  });

  test('shutdown() before loadOnnx()/loadOnnxBatch() was ever called remains a true no-op', async () => {
    const createCalls = [];
    const wrapper = createLazyCapability(hermeticFactoryOptions({ createCalls }));
    await assert.doesNotReject(() => wrapper.shutdown());
    assert.equal(createCalls.length, 0, 'shutdown() alone must never trigger construction of a real session');
  });

  test('two SEPARATE wrapper objects (two createOnnxEmbeddingCapability() calls) never share an _instancePromise — each constructs its own real instance independently', async () => {
    const createCallsA = [];
    const createCallsB = [];
    const wrapperA = createLazyCapability(hermeticFactoryOptions({ createCalls: createCallsA }));
    const wrapperB = createLazyCapability(hermeticFactoryOptions({ createCalls: createCallsB }));
    const embedA = await wrapperA.loadOnnx();
    const embedB = await wrapperB.loadOnnx();
    await embedA('a');
    await embedB('b');
    assert.equal(createCallsA.length, 1);
    assert.equal(createCallsB.length, 1);
    await wrapperA.shutdown();
    await wrapperB.shutdown();
  });
});
