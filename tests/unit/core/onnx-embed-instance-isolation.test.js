// src/local/core/onnx-embed.js — createOnnxEmbeddingCapability(), the
// instance-scoped ONNX embedding session/tokenizer factory (code review
// parity with Phase 8B Step 4's tag-onnx.js fix: this file used to hold
// its session/tokenizer/in-flight-load-promise/provider-fallback state as
// module-scope bindings, shared by every caller in the process —
// index-full.js/admin/server-full.js/mcp/server.js each passed the SAME
// cached onnx-embed-lazy.js module namespace object as their own
// "capability," so two independently-composed callers actually shared one
// ONNX InferenceSession. Fixed by moving every mutable binding into
// createOnnxEmbeddingCapability()'s own closure).
//
// Every test here injects a FAKE ONNX Runtime module (via the `ortFactory`
// option) and, where real tokenization behavior is not the point of the
// test, a fake tokenizer too (via `loadTokenizerAndModel`) — never the
// real 2.3GB model. This keeps the whole suite fast (milliseconds) and
// network/disk-cache-independent, per this task's own explicit
// instruction to avoid loading the real model in unit tests. A SEPARATE,
// smaller set of tests deliberately uses the REAL tokenizer (already
// cached locally) with only the ONNX session faked, to prove the real
// tokenizer integration path still produces correctly-shaped output after
// the refactor — see the "real tokenizer, fake session" describe block.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createOnnxEmbeddingCapability } from '../../../src/local/core/onnx-embed.js';

// ── Fake ONNX Runtime + tokenizer helpers ───────────────────────────────────

function makeFakeSession({ denseFill = 0.1, sparseFill = 0.2, onRun, releaseCalls } = {}) {
  return {
    outputNames: ['dense_vecs', 'sparse_vecs'],
    async run(feeds, names) {
      if (onRun) onRun(feeds, names);
      const seqLen = feeds.input_ids.dims[1];
      const batchSize = feeds.input_ids.dims[0];
      return {
        dense_vecs: { data: new Float32Array(batchSize * 1024).fill(denseFill) },
        sparse_vecs: { data: new Float32Array(batchSize * seqLen).fill(sparseFill) },
      };
    },
    async release() { if (releaseCalls) releaseCalls.push(true); },
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

// Fake tokenizer: fixed-length token ids regardless of input text, so
// output shapes are deterministic and never depend on the real BGE-M3
// vocabulary. Real tokenizer correctness is covered by
// tests/unit/core/onnx-tokenizer.test.js (buildTokenizerBatch/
// truncateTokenizerEncoding, already pure functions independent of any
// instance) and by this file's own "real tokenizer, fake session" block.
function fakeTokenizer() {
  return {
    encode: () => ({ ids: [0, 5, 6, 7, 2], attention_mask: [1, 1, 1, 1, 1], token_type_ids: [0, 0, 0, 0, 0] }),
  };
}

function hermeticCapabilityOptions(ortOverrides = {}) {
  return {
    ortFactory: () => makeFakeOrt(ortOverrides),
    loadTokenizerAndModel: async () => ({ tokenizer: fakeTokenizer() }),
  };
}

describe('createOnnxEmbeddingCapability() — basic behavior (fully hermetic — fake session AND fake tokenizer, no real model/tokenizer files touched)', () => {
  test('loadOnnx() resolves to a function that returns { dense, sparse } shaped output', async () => {
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    const embed = await cap.loadOnnx();
    const result = await embed('hello world');
    assert.equal(result.dense.length, 1024);
    assert.ok(Array.isArray(result.sparse.indices));
    assert.ok(Array.isArray(result.sparse.values));
    await cap.shutdown();
  });

  test('loadOnnxBatch() resolves to { embedOnnxBatch } aligned to input order', async () => {
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    const { embedOnnxBatch } = await cap.loadOnnxBatch();
    const results = await embedOnnxBatch(['alpha', 'beta', 'gamma']);
    assert.equal(results.length, 3);
    for (const r of results) {
      assert.equal(r.dense.length, 1024);
      assert.ok(Array.isArray(r.sparse.indices));
    }
    await cap.shutdown();
  });

  test('embedOnnxBatch() rejects on an empty array (documented contract, unaffected by the refactor)', async () => {
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    const { embedOnnxBatch } = await cap.loadOnnxBatch();
    await assert.rejects(() => embedOnnxBatch([]), /must be non-empty/);
    await cap.shutdown();
  });

  test('the session is created lazily — not touched until the first real loadOnnx()/loadOnnxBatch() call', async () => {
    const createCalls = [];
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions({ createCalls }));
    // Constructing the capability, and even calling loadOnnx() itself
    // (which only returns a function reference), must not create a
    // session yet.
    const embed = await cap.loadOnnx();
    assert.equal(createCalls.length, 0, 'loadOnnx() itself must not trigger session creation — only actually calling the returned embed function does');
    await embed('trigger it now');
    assert.equal(createCalls.length, 1);
    await cap.shutdown();
  });

  test('a second embed call after the first reuses the same session — no redundant InferenceSession.create() calls', async () => {
    const createCalls = [];
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions({ createCalls }));
    const embed = await cap.loadOnnx();
    await embed('first');
    await embed('second');
    assert.equal(createCalls.length, 1, 'the session must be created exactly once and reused for subsequent calls');
    await cap.shutdown();
  });

  test('concurrent embed calls on one instance all resolve correctly without racing session creation (promise-guarded, like tag-onnx.js\'s own ensureWorker())', async () => {
    const createCalls = [];
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions({ createCalls }));
    const embed = await cap.loadOnnx();
    const [r1, r2, r3] = await Promise.all([embed('a'), embed('b'), embed('c')]);
    assert.equal(createCalls.length, 1, 'concurrent calls before the session exists must still create exactly one session, not one per caller');
    for (const r of [r1, r2, r3]) assert.equal(r.dense.length, 1024);
    await cap.shutdown();
  });
});

describe('createOnnxEmbeddingCapability() — provider state and CUDA fallback (fully hermetic)', () => {
  test('getOnnxProviderState() returns null before any embed call — no session yet', async () => {
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    assert.equal(cap.getOnnxProviderState(), null);
    await cap.shutdown();
  });

  test('getOnnxProviderState() reports the CPU provider when no ONNX_EXECUTION_PROVIDER override is set', async () => {
    const original = process.env.ONNX_EXECUTION_PROVIDER;
    delete process.env.ONNX_EXECUTION_PROVIDER;
    try {
      const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
      const embed = await cap.loadOnnx();
      await embed('x');
      assert.deepEqual(cap.getOnnxProviderState(), { requested: 'cpu', effective: 'cpu', fellBackToCpu: false });
      await cap.shutdown();
    } finally {
      if (original === undefined) delete process.env.ONNX_EXECUTION_PROVIDER; else process.env.ONNX_EXECUTION_PROVIDER = original;
    }
  });

  test('a CUDA session creation failure retries with CPU and records fellBackToCpu: true (non-strict mode)', async () => {
    const original = process.env.ONNX_EXECUTION_PROVIDER;
    const originalStrict = process.env.ONNX_CUDA_STRICT;
    process.env.ONNX_EXECUTION_PROVIDER = 'cuda';
    delete process.env.ONNX_CUDA_STRICT;
    try {
      let callCount = 0;
      const cap = createOnnxEmbeddingCapability({
        ...hermeticCapabilityOptions(),
        ortFactory: () => makeFakeOrt({
          createSession: (modelPath, opts) => {
            callCount += 1;
            if (opts.executionProviders[0] === 'cuda') throw new Error('CUDA execution provider is not supported in this build');
            return makeFakeSession();
          },
        }),
      });
      const embed = await cap.loadOnnx();
      const result = await embed('x');
      assert.equal(result.dense.length, 1024, 'the retried CPU session must still produce valid output');
      assert.equal(callCount, 2, 'expected exactly two InferenceSession.create() attempts: cuda (failed), then cpu (succeeded)');
      assert.deepEqual(cap.getOnnxProviderState(), { requested: 'cuda', effective: 'cpu', fellBackToCpu: true });
      await cap.shutdown();
    } finally {
      if (original === undefined) delete process.env.ONNX_EXECUTION_PROVIDER; else process.env.ONNX_EXECUTION_PROVIDER = original;
      if (originalStrict === undefined) delete process.env.ONNX_CUDA_STRICT; else process.env.ONNX_CUDA_STRICT = originalStrict;
    }
  });
});

describe('createOnnxEmbeddingCapability() — shutdown lifecycle (fully hermetic)', () => {
  test('shutdown() before any session was ever created is a safe no-op (does not throw, does not hang)', async () => {
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    await assert.doesNotReject(() => cap.shutdown());
  });

  test('repeated shutdown (call it twice in a row, no session ever created) is safe — idempotent, not merely non-throwing the first time', async () => {
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    await assert.doesNotReject(() => cap.shutdown());
    await assert.doesNotReject(() => cap.shutdown());
  });

  test('shutdown() after a real session was created calls session.release() exactly once, even if shutdown() is itself called twice', async () => {
    const releaseCalls = [];
    const cap = createOnnxEmbeddingCapability({
      ...hermeticCapabilityOptions(),
      ortFactory: () => makeFakeOrt({ createSession: () => makeFakeSession({ releaseCalls }) }),
    });
    const embed = await cap.loadOnnx();
    await embed('warm up the session');
    await cap.shutdown();
    await cap.shutdown();
    assert.equal(releaseCalls.length, 1, 'session.release() must be called exactly once, not once per shutdown() call');
  });

  test('after shutdown(), a subsequent loadOnnx()/embed call throws instead of silently respawning a session', async () => {
    const cap = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    const embed = await cap.loadOnnx();
    await embed('one call before shutdown');
    await cap.shutdown();
    const embedAgain = await cap.loadOnnx();
    await assert.rejects(() => embedAgain('should be rejected'), /already been shut down|construct a new instance/i);
  });

  test('code review (P1): shutdown() called WHILE _doLoad() is still in flight waits for it, then releases the session it produced — never leaks a session created after shutdown() had already returned', async () => {
    const releaseCalls = [];
    // loadTokenizerAndModel is the first `await` inside _doLoad() — gate it
    // so shutdown() can genuinely be called while a load is mid-flight, not
    // merely "called right after load() was invoked" (a real interleaving,
    // same rigor as the cross-instance in-flight-request test above).
    let releaseTokenizerLoad;
    const tokenizerLoadGate = new Promise((resolve) => { releaseTokenizerLoad = resolve; });
    const cap = createOnnxEmbeddingCapability({
      ortFactory: () => makeFakeOrt({ createSession: () => makeFakeSession({ releaseCalls }) }),
      loadTokenizerAndModel: async () => { await tokenizerLoadGate; return { tokenizer: fakeTokenizer() }; },
    });

    const embed = await cap.loadOnnx();
    const embedPending = embed('a load that will still be in flight when shutdown() is called');
    await new Promise((resolve) => setTimeout(resolve, 10)); // let load() genuinely start and reach the gated tokenizer step

    const shutdownPending = cap.shutdown();
    // shutdown() must not resolve while _doLoad() is still gated — prove it
    // is genuinely still waiting, not racing ahead of the in-flight load.
    let shutdownResolved = false;
    shutdownPending.then(() => { shutdownResolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shutdownResolved, false, 'shutdown() must wait for the in-flight load, not return immediately while it is still running');
    assert.equal(releaseCalls.length, 0, 'no session exists yet to release — the load has not reached InferenceSession.create() yet');

    releaseTokenizerLoad(); // let the gated load proceed to completion
    await shutdownPending;
    assert.equal(releaseCalls.length, 1, 'the session the in-flight load eventually produced must be released exactly once, by this very shutdown() call');

    // The embed() call that triggered the load must still resolve — either
    // with a real (now-immediately-released) result, or with a rejection —
    // but it must never hang forever waiting on a load shutdown() silently
    // abandoned.
    await assert.doesNotReject(() => embedPending.catch(() => {}));

    // A second shutdown() call afterward must remain a safe no-op, not a
    // second real release() call.
    await assert.doesNotReject(() => cap.shutdown());
    assert.equal(releaseCalls.length, 1, 'a second shutdown() call must not release the session a second time');
  });
});

describe('createOnnxEmbeddingCapability() — TWO independently-constructed instances have genuinely independent state (the core isolation requirement)', () => {
  test('two instances never share the same session — each gets its own InferenceSession.create() call', async () => {
    const createCallsA = [];
    const createCallsB = [];
    const capA = createOnnxEmbeddingCapability({ ...hermeticCapabilityOptions(), ortFactory: () => makeFakeOrt({ createCalls: createCallsA }) });
    const capB = createOnnxEmbeddingCapability({ ...hermeticCapabilityOptions(), ortFactory: () => makeFakeOrt({ createCalls: createCallsB }) });

    const embedA = await capA.loadOnnx();
    const embedB = await capB.loadOnnx();
    await embedA('from A');
    await embedB('from B');

    assert.equal(createCallsA.length, 1);
    assert.equal(createCallsB.length, 1);
    await capA.shutdown();
    await capB.shutdown();
  });

  test('shutting down instance A never kills instance B\'s session, and B\'s genuinely in-flight request still completes successfully', async () => {
    const releaseCallsA = [];
    const releaseCallsB = [];
    // B's own fake session.run() deliberately blocks on this gate — B's
    // embed call is genuinely still in flight (not yet resolved) at the
    // moment A is shut down, proving isolation under a REAL interleaving.
    let releaseBRun;
    const bRunGate = new Promise((resolve) => { releaseBRun = resolve; });

    const capA = createOnnxEmbeddingCapability({
      ...hermeticCapabilityOptions(),
      ortFactory: () => makeFakeOrt({ createSession: () => makeFakeSession({ releaseCalls: releaseCallsA }) }),
    });
    const capB = createOnnxEmbeddingCapability({
      ...hermeticCapabilityOptions(),
      ortFactory: () => makeFakeOrt({
        createSession: () => {
          const session = makeFakeSession({ releaseCalls: releaseCallsB });
          const realRun = session.run.bind(session);
          session.run = async (...args) => { await bRunGate; return realRun(...args); };
          return session;
        },
      }),
    });

    const embedA = await capA.loadOnnx();
    const embedB = await capB.loadOnnx();

    // Warm up A's own session first, so A genuinely has a live session for
    // its own shutdown() to release (proving the release call itself is
    // real, not merely "nothing existed to release").
    await embedA('warm up A');

    const bPending = embedB('B in-flight request, started before A\'s shutdown');
    await new Promise((resolve) => setTimeout(resolve, 10)); // let B's request actually reach its own (gated) session.run()

    await capA.shutdown();
    assert.equal(releaseCallsA.length, 1, 'A\'s own session was released by A\'s own shutdown');
    assert.equal(releaseCallsB.length, 0, 'B\'s session must NOT have been released by A\'s shutdown, while B\'s own request is still genuinely in flight');

    releaseBRun();
    const bResult = await bPending;
    assert.equal(bResult.dense.length, 1024, 'B\'s own in-flight request must still complete successfully, unaffected by A\'s shutdown');
    assert.equal(releaseCallsB.length, 0, 'B\'s session still must never have been released');

    await capB.shutdown();
    assert.equal(releaseCallsB.length, 1, 'B\'s own shutdown, called explicitly and separately, releases exactly its own session');
  });

  test('independent provider-fallback state — a CUDA fallback in instance A does not affect instance B\'s own provider state', async () => {
    process.env.ONNX_EXECUTION_PROVIDER = 'cuda';
    const originalStrict = process.env.ONNX_CUDA_STRICT;
    delete process.env.ONNX_CUDA_STRICT;
    try {
      const capA = createOnnxEmbeddingCapability({
        ...hermeticCapabilityOptions(),
        ortFactory: () => makeFakeOrt({
          createSession: (modelPath, opts) => {
            if (opts.executionProviders[0] === 'cuda') throw new Error('CUDA not available');
            return makeFakeSession();
          },
        }),
      });
      const capB = createOnnxEmbeddingCapability({
        ...hermeticCapabilityOptions(),
        ortFactory: () => makeFakeOrt({ createSession: () => makeFakeSession() }), // B's CUDA request "succeeds" (fake never rejects)
      });

      const embedA = await capA.loadOnnx();
      const embedB = await capB.loadOnnx();
      await embedA('a');
      await embedB('b');

      assert.deepEqual(capA.getOnnxProviderState(), { requested: 'cuda', effective: 'cpu', fellBackToCpu: true });
      assert.deepEqual(capB.getOnnxProviderState(), { requested: 'cuda', effective: 'cuda', fellBackToCpu: false });

      await capA.shutdown();
      await capB.shutdown();
    } finally {
      delete process.env.ONNX_EXECUTION_PROVIDER;
      if (originalStrict === undefined) delete process.env.ONNX_CUDA_STRICT; else process.env.ONNX_CUDA_STRICT = originalStrict;
    }
  });

  test('repeated shutdown is safe per-instance, independently — shutting A down twice never affects B', async () => {
    const releaseCallsB = [];
    const capA = createOnnxEmbeddingCapability(hermeticCapabilityOptions());
    const capB = createOnnxEmbeddingCapability({
      ...hermeticCapabilityOptions(),
      ortFactory: () => makeFakeOrt({ createSession: () => makeFakeSession({ releaseCalls: releaseCallsB }) }),
    });

    const embedA = await capA.loadOnnx();
    const embedB = await capB.loadOnnx();
    await embedA('a');
    await embedB('b');

    await assert.doesNotReject(() => capA.shutdown());
    await assert.doesNotReject(() => capA.shutdown());
    assert.equal(releaseCallsB.length, 0, 'B\'s session must still be untouched after A was shut down twice');

    await assert.doesNotReject(() => capB.shutdown());
    assert.equal(releaseCallsB.length, 1);
  });
});

describe('createOnnxEmbeddingCapability() — real tokenizer, fake session (proves the real BGE-M3 tokenizer integration still works after the refactor, without loading the real 2.3GB model)', () => {
  test('a real tokenizer encode + a fake session produces correctly dense/sparse-shaped output', async () => {
    const cap = createOnnxEmbeddingCapability({ ortFactory: () => makeFakeOrt() }); // real (cached, offline) tokenizer, fake session
    const embed = await cap.loadOnnx();
    const result = await embed('hello world, this is a real tokenizer integration check');
    assert.equal(result.dense.length, 1024);
    assert.ok(result.sparse.indices.length > 0, 'the real tokenizer must produce real, non-empty token ids for the fake session to weight');
    await cap.shutdown();
  });
});
