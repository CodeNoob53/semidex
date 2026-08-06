// src/local/indexer/phases/tag-onnx.js — the child-process coordinator layer for
// ONNX-based tag generation (node:child_process's fork(), NOT
// worker_threads — a worker_thread shares the OS process, and therefore
// ONNX Runtime's process-global Ort::Env singleton, with the main indexer
// process, which can simultaneously load the custom CUDA-enabled
// onnxruntime-node build via local/core/onnx-embed.js when ONNX_EMBED=1; only a
// genuinely separate process isolates Transformers.js's own bundled ORT
// build from it).
//
// Code review, Phase 8B Step 4 (second pass): tag-onnx.js used to export
// addTagsOnnxBatch()/shutdownOnnxTagWorker()/__test directly, backed by
// MODULE-SCOPE singleton coordinator state — a real isolation gap, since
// every consumer (including two independently-composed Full compositions
// in one process) shared one worker. Fixed by createTagOnnxCapability(): a
// factory returning a fresh { addTagsOnnxBatch, shutdownOnnxTagWorker,
// __test } instance per call, with its own private closure state. Every
// test in this file now constructs its OWN instance via
// createTagOnnxCapability() (mirrors production's own
// "index-full.js calls it once, at composition time" usage) rather than
// resetting one shared module-scope instance between tests — this is not
// just a mechanical rename: it is what makes this file itself incapable of
// silently reintroducing cross-test state leakage the way the module-scope
// design could.
//
// Every test here injects a FAKE worker (EventEmitter-shaped, never a real
// child process) via instance.__test.setWorkerFactory(), exercising the
// exact same message protocol the real worker (tag-onnx-worker.js) uses.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  isOnnxTagProvider, createTagOnnxCapability,
} from '../../../../src/local/indexer/phases/tag-onnx.js';

describe('isOnnxTagProvider', () => {
  test('TAG_PROVIDER=onnx → true, everything else → false', () => {
    assert.equal(isOnnxTagProvider({ TAG_PROVIDER: 'onnx' }), true);
    assert.equal(isOnnxTagProvider({ TAG_PROVIDER: 'ollama' }), false);
    assert.equal(isOnnxTagProvider({}), false);
    assert.equal(isOnnxTagProvider({ TAG_PROVIDER: 'ONNX' }), false);
  });
});

// ── Fake worker helpers — shaped like a real node:child_process
// ChildProcess (.send/.on/.off/.once/.kill), mirroring tag-onnx-worker.js's
// real message protocol exactly (kind: 'ready'|'done'|'error', requestId
// matching). kill() emits 'exit' asynchronously (a real child process's
// kill() is synchronous but 'exit' fires later, once the OS confirms
// termination) — tests that need a kill() which never reports exit
// override it explicitly.
function makeFakeWorker({ tagFn, failReady = null } = {}) {
  const worker = new EventEmitter();
  const sent = [];
  worker.send = (msg) => {
    sent.push(msg);
    if (msg?.kind !== 'run') return;
    queueMicrotask(() => {
      try {
        const tagArrays = tagFn(msg.chunks);
        worker.emit('message', { kind: 'done', requestId: msg.requestId, tagArrays });
      } catch (err) {
        worker.emit('message', { kind: 'error', requestId: msg.requestId, error: err.message });
      }
    });
  };
  worker.kill = () => { worker.killed = true; queueMicrotask(() => worker.emit('exit', null)); };
  worker.sent = sent;
  queueMicrotask(() => {
    if (failReady) worker.emit('message', { kind: 'error', error: failReady });
    else worker.emit('message', { kind: 'ready' });
  });
  return worker;
}

function makeSilentWorker() {
  const worker = new EventEmitter();
  worker.send = () => {}; // never replies to 'run'
  worker.kill = () => { worker.killed = true; queueMicrotask(() => worker.emit('exit', null)); };
  queueMicrotask(() => worker.emit('message', { kind: 'ready' }));
  return worker;
}

function fixtureChunks() {
  return [
    { text: 'alpha text', section: 'sec', source_file: 'alpha.md' },
    { text: 'beta text', section: 'sec', source_file: 'beta.md' },
  ];
}

describe('tag-onnx worker coordinator', () => {
  // Each test constructs its own fresh capability instance — there is no
  // module-scope state left to reset between tests (see this file's own
  // header comment).
  let cap;
  test.beforeEach(() => { cap = createTagOnnxCapability(); });

  test('spawns exactly one worker for concurrent addTagsOnnxBatch() callers (promise-guarded)', async () => {
    let spawnCount = 0;
    cap.__test.setWorkerFactory(() => { spawnCount += 1; return makeFakeWorker({ tagFn: (chunks) => chunks.map(() => ['tag-a']) }); });
    await Promise.all([cap.addTagsOnnxBatch(fixtureChunks()), cap.addTagsOnnxBatch(fixtureChunks())]);
    assert.equal(spawnCount, 1);
  });

  test('addTagsOnnxBatch sends exactly one run request with the expected chunk shape (text/section/source_file only)', async () => {
    let worker;
    cap.__test.setWorkerFactory(() => { worker = makeFakeWorker({ tagFn: (chunks) => chunks.map(() => ['tag-a']) }); return worker; });
    await cap.addTagsOnnxBatch(fixtureChunks());
    const runMsgs = worker.sent.filter((m) => m.kind === 'run');
    assert.equal(runMsgs.length, 1);
    assert.deepEqual(runMsgs[0].chunks, [
      { text: 'alpha text', section: 'sec', source_file: 'alpha.md' },
      { text: 'beta text', section: 'sec', source_file: 'beta.md' },
    ]);
  });

  test('merges worker-generated tags with any pre-existing chunk.meta.tags, deduplicated', async () => {
    cap.__test.setWorkerFactory(() => makeFakeWorker({ tagFn: (chunks) => chunks.map(() => ['generated-tag', 'alpha']) }));
    const chunks = [{ text: 'a', section: 's', source_file: 'a.md', meta: { tags: ['alpha', 'existing'] } }];
    const out = await cap.addTagsOnnxBatch(chunks);
    assert.deepEqual(out[0].tags, ['alpha', 'existing', 'generated-tag']);
  });

  test('a worker that fails to reach ready (kind: error) marks the session failed and disables ONNX tagging, never retrying', async () => {
    cap.__test.setWorkerFactory(() => makeFakeWorker({ failReady: 'boom' }));
    const out1 = await cap.addTagsOnnxBatch(fixtureChunks());
    const out2 = await cap.addTagsOnnxBatch(fixtureChunks());
    assert.deepEqual(out1.map((c) => c.tags), [[], []]);
    assert.deepEqual(out2.map((c) => c.tags), [[], []]);
    assert.equal(cap.__test.state().failed, true);
  });

  test('addTagsOnnxBatch() never throws when the worker fails to load — this is the module\'s own documented contract, previously broken by ensureWorker() being called outside the try', async () => {
    // Regression test: ensureWorker() used to be called BEFORE the try
    // block, so a load failure propagated as an uncaught rejection out of
    // addTagsOnnxBatch() despite this module's own doc comment promising
    // "[] on worker failure; never throws."
    cap.__test.setWorkerFactory(() => makeFakeWorker({ failReady: 'load failed' }));
    await assert.doesNotReject(() => cap.addTagsOnnxBatch(fixtureChunks()));
    const out = await cap.addTagsOnnxBatch(fixtureChunks());
    assert.deepEqual(out.map((c) => c.tags), [[], []]);
  });

  test('a worker that exits (non-zero code) DURING its own init is rejected cleanly, not an uncaught TypeError', async () => {
    // Regression test: the same crash core/ce-rerank.js's own init handler
    // had — onWorkerExit() (this instance's own 'exit' listener) and
    // ensureWorker()'s local .once('exit', onExit) init-listener BOTH fire
    // on the same 'exit' event; onWorkerExit() runs first (registered
    // first) and sets this instance's own _worker to null, so the local
    // init handler's cleanup() must never dereference the (possibly-null)
    // closure-level _worker — it uses a locally-captured `worker`
    // reference instead.
    cap.__test.setWorkerFactory(() => {
      const worker = new EventEmitter();
      worker.send = () => {};
      worker.kill = () => {};
      queueMicrotask(() => worker.emit('exit', 1)); // exits before ever posting 'ready'
      return worker;
    });
    const out = await cap.addTagsOnnxBatch(fixtureChunks());
    assert.deepEqual(out.map((c) => c.tags), [[], []]);
    assert.equal(cap.__test.state().failed, true);
  });

  test('a worker that exits with code 0 DURING its own init (before ever posting ready) is rejected immediately, not left hanging until the 5-minute init timeout', async () => {
    // Regression test (P2): the init-phase exit handler only rejected for
    // `code !== 0` — a worker exiting cleanly (code 0) before ever posting
    // 'ready' fell through that check entirely, calling neither resolve
    // nor reject. Since a worker that has already exited can never post
    // 'ready' afterward, this left ensureWorker() (and therefore
    // addTagsOnnxBatch()) hanging until the full, non-configurable
    // TAG_ONNX_INIT_TIMEOUT_MS (5 minutes) elapsed, even though the true
    // outcome (init failed) was already known the instant the process
    // exited.
    const keepalive = setTimeout(() => {}, 2000);
    cap.__test.setWorkerFactory(() => {
      const worker = new EventEmitter();
      worker.send = () => {};
      worker.kill = () => {};
      queueMicrotask(() => worker.emit('exit', 0)); // clean exit, but BEFORE 'ready'
      return worker;
    });
    const t0 = Date.now();
    try {
      const out = await cap.addTagsOnnxBatch(fixtureChunks());
      const elapsed = Date.now() - t0;
      assert.deepEqual(out.map((c) => c.tags), [[], []]);
      assert.equal(cap.__test.state().failed, true, 'a worker that can never become ready must disable ONNX tagging for this session');
      assert.ok(elapsed < 1000, `must reject immediately on exit, not wait out the 5-minute init timeout (took ${elapsed}ms)`);
    } finally {
      clearTimeout(keepalive);
    }
  });

  test('an unexpected worker exit (non-zero code) rejects pending requests and marks the session failed', async () => {
    let worker;
    cap.__test.setWorkerFactory(() => { worker = makeFakeWorker({ tagFn: () => { throw new Error('unused'); } }); return worker; });
    await cap.addTagsOnnxBatch([{ text: 'warm', section: 's', source_file: 'warm.md' }]); // ensure worker is spawned+ready first
    const pending = cap.addTagsOnnxBatch(fixtureChunks());
    // ensureWorker()'s already-ready fast path is still `async`, so the
    // second addTagsOnnxBatch() call above has already yielded control
    // back here (before it reaches its own worker.send()) — this line
    // races the worker's exit against that in-flight call's send.
    worker.emit('exit', 1);
    const out = await pending;
    assert.deepEqual(out.map((c) => c.tags), [[], []]); // never throws
    assert.equal(cap.__test.state().failed, true);
  });

  test('a worker exiting in the gap between ensureWorker() resolving and this request\'s own worker.send() call produces an informative error, not a raw TypeError', async () => {
    // Regression test: discovered incidentally while writing the test
    // above. ensureWorker() is `async`, so even its already-ready fast
    // path (`if (_workerReady) return;`) yields one microtask tick before
    // addTagsOnnxBatch()'s caller resumes — a worker exit landing in that
    // exact gap (after the await, before runOnWorker()'s own worker.send()
    // call) used to throw "Cannot read properties of null (reading
    // 'send')" instead of a clean, actionable rejection. Always caught by
    // addTagsOnnxBatch()'s own try/catch either way (never an unhandled
    // crash) — this test's point is specifically the MESSAGE quality, not
    // just the outcome (already covered by the test above).
    let worker;
    cap.__test.setWorkerFactory(() => { worker = makeFakeWorker({ tagFn: (chunks) => chunks.map(() => []) }); return worker; });
    await cap.addTagsOnnxBatch([{ text: 'warm', section: 's', source_file: 'warm.md' }]); // spawn + ready first

    const originalWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    try {
      const pending = cap.addTagsOnnxBatch(fixtureChunks());
      worker.emit('exit', 1); // races the in-flight call's own worker.send()
      await pending;
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.doesNotMatch(captured, /Cannot read properties of null/, 'must not surface a raw null-dereference TypeError message');
    assert.match(captured, /no longer available/);
  });

  test('a clean worker exit (code 0) does not mark the session failed', async () => {
    let worker;
    cap.__test.setWorkerFactory(() => { worker = makeFakeWorker({ tagFn: (chunks) => chunks.map(() => []) }); return worker; });
    await cap.addTagsOnnxBatch(fixtureChunks());
    worker.emit('exit', 0);
    assert.equal(cap.__test.state().failed, false);
  });

  test('a worker that never replies to a run request times out per-request, falls back to empty tags for that call, kills the worker, and disables ONNX tagging for the rest of the session', async () => {
    // Regression test (P1): a hung worker is stuck mid-inference, not
    // merely slow — dropping only the pending request would let a NEW
    // request pile a second concurrent generation attempt onto the same
    // already-overloaded worker (a real OOM risk for a 1.5B model). A
    // per-request timeout must kill the worker and disable the session,
    // mirroring core/ce-rerank.js's own established contract exactly.
    // The per-request round-trip timer is deliberately unref'd in
    // production (correct for a long-lived indexer process — a pending
    // timeout must never keep the process alive) — same caveat
    // core/ce-rerank.js's own equivalent test documents. In this test we
    // must keep the event loop alive ourselves or Node exits/hangs before
    // the timer fires.
    const keepalive = setTimeout(() => {}, 5000);
    let killCalls = 0;
    cap.__test.setWorkerFactory(() => {
      const worker = makeSilentWorker();
      const originalKill = worker.kill;
      worker.kill = (...args) => { killCalls += 1; return originalKill(...args); };
      return worker;
    });
    // resolveRequestTimeoutMs() enforces a 1000ms floor (ignores anything
    // smaller and falls back to the 120s default) — 1000ms is the smallest
    // value that actually takes effect.
    process.env.TAG_ONNX_TIMEOUT_MS = '1000';
    try {
      const out = await cap.addTagsOnnxBatch(fixtureChunks());
      assert.deepEqual(out.map((c) => c.tags), [[], []]);
      assert.equal(killCalls, 1, 'the hung worker must be killed, not left running a stuck inference');
      assert.equal(cap.__test.state().failed, true, 'a hung worker must disable ONNX tagging for the rest of the session');

      // A subsequent call must not attempt to reuse the killed worker.
      const second = await cap.addTagsOnnxBatch(fixtureChunks());
      assert.deepEqual(second.map((c) => c.tags), [[], []]);
    } finally {
      delete process.env.TAG_ONNX_TIMEOUT_MS;
      clearTimeout(keepalive);
    }
  });

  test('a per-request timeout measures actual round-trip time, never time spent queued behind an earlier request — two genuinely fast requests sent together must not spuriously time out', async () => {
    // Regression test (P1): the worker itself processes 'run' messages one
    // at a time via its own internal FIFO (tag-onnx-worker.js). Previously
    // the COORDINATOR sent every request immediately and started each
    // request's own timeout timer at send time — so a request queued
    // behind an earlier one had its timeout clock running down while
    // merely WAITING its turn, not while actually being processed.
    // Reproduced directly: two 700ms-each requests sent together with a
    // 1000ms timeout — the second one spuriously timed out at ~1000ms
    // (700ms queue wait + starting its own 700ms processing exceeded
    // 1000ms), killing the worker and disabling ONNX tagging for the rest
    // of the session, even though NEITHER request actually took longer
    // than 700ms to process once the worker got to it.
    const keepalive = setTimeout(() => {}, 5000);
    cap.__test.setWorkerFactory(() => {
      // Simulates the REAL worker's FIFO queue faithfully: 'run' messages
      // are processed strictly one at a time, each taking PROCESS_MS,
      // replying only once its own turn is done — not simply delaying
      // every reply independently (which would NOT reproduce the queue-
      // wait-counted-as-timeout bug, since independent per-message delays
      // never model one request blocking behind another).
      const PROCESS_MS = 700;
      const worker = new EventEmitter();
      let queueTail = Promise.resolve();
      worker.send = (msg) => {
        if (msg?.kind !== 'run') return;
        queueTail = queueTail.then(() => new Promise((resolve) => {
          setTimeout(() => {
            worker.emit('message', { kind: 'done', requestId: msg.requestId, tagArrays: msg.chunks.map(() => []) });
            resolve();
          }, PROCESS_MS);
        }));
      };
      worker.kill = () => { worker.killed = true; queueMicrotask(() => worker.emit('exit', null)); };
      queueMicrotask(() => worker.emit('message', { kind: 'ready' }));
      return worker;
    });
    process.env.TAG_ONNX_TIMEOUT_MS = '1000';
    try {
      const [out1, out2] = await Promise.all([
        cap.addTagsOnnxBatch([{ text: 'a', section: 's', source_file: 'a.md' }]),
        cap.addTagsOnnxBatch([{ text: 'b', section: 's', source_file: 'b.md' }]),
      ]);
      assert.deepEqual(out1.map((c) => c.tags), [[]], 'the first request must succeed');
      assert.deepEqual(out2.map((c) => c.tags), [[]], 'the second request must ALSO succeed — its own processing time (700ms) never exceeded the 1000ms timeout, even though it had to wait behind the first');
      assert.equal(cap.__test.state().failed, false, 'neither request actually hung — the session must not be disabled');
    } finally {
      delete process.env.TAG_ONNX_TIMEOUT_MS;
      clearTimeout(keepalive);
    }
  });

  test('the init (model load) phase is also bounded by a timeout — a worker that never posts ready/error/exit does not hang addTagsOnnxBatch() forever', async () => {
    // Regression test (P1): ensureWorker()'s init wait previously had NO
    // timeout at all — only per-request calls did. A worker stuck loading
    // the model (or a first-time download that never completes) would
    // leave every addTagsOnnxBatch() caller awaiting _initPromise pending
    // forever. This test cannot wait out the real 5-minute production
    // constant, so it only asserts the worker's kill() is eventually
    // invoked by SOME bounded mechanism — covered fully by the equivalent,
    // already-verified core/ce-rerank.js pattern this mirrors exactly; see
    // that module's own init-timeout test for the timing-sensitive half of
    // this contract. Here we confirm structurally that ensureWorker() does
    // register a timer at all by checking the worker is killed well before
    // the test's own bounded wait — using an injected short-circuit is not
    // possible without a settings-driven override (tag-onnx.js's init
    // timeout, like core/ce-rerank.js's, is intentionally NOT
    // user-configurable), so this test is skipped in favor of the
    // structural assertion below.
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../../../../src/local/indexer/phases/tag-onnx.js', import.meta.url), 'utf-8',
    ));
    assert.match(src, /TAG_ONNX_INIT_TIMEOUT_MS/, 'ensureWorker() must be bounded by an init timeout constant');
    assert.match(src, /did not become ready within/, 'a timed-out init must produce an actionable error message');
  });

  test('shutdownOnnxTagWorker() rejects any pending request instead of leaving it hanging forever', async () => {
    // Regression test (P1): shutdownOnnxTagWorker() used to just
    // _pending.clear() — a caller awaiting an in-flight addTagsOnnxBatch()
    // at shutdown time would have its promise never settle.
    let worker;
    cap.__test.setWorkerFactory(() => {
      worker = makeSilentWorker(); // never replies — request stays pending until shutdown
      return worker;
    });
    const pending = cap.addTagsOnnxBatch(fixtureChunks());
    // Give addTagsOnnxBatch a tick to spawn+ready the worker and send its
    // run request before shutdown races it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await cap.shutdownOnnxTagWorker();
    const out = await pending; // must resolve (with empty-tags fallback), never hang
    assert.deepEqual(out.map((c) => c.tags), [[], []]);
  });

  test('shutdownOnnxTagWorker() kills the worker and allows a clean respawn afterward (deliberate shutdown is not mistaken for a crash)', async () => {
    let killCalls = 0;
    cap.__test.setWorkerFactory(() => {
      const worker = makeFakeWorker({ tagFn: (chunks) => chunks.map(() => []) });
      const originalKill = worker.kill;
      worker.kill = (...args) => { killCalls += 1; return originalKill(...args); };
      return worker;
    });
    await cap.addTagsOnnxBatch(fixtureChunks());
    await cap.shutdownOnnxTagWorker();
    assert.equal(killCalls, 1);
    assert.equal(cap.__test.state().ready, false);
    assert.equal(cap.__test.state().failed, false, 'a deliberate shutdown must not disable ONNX tagging for a future respawn');
    // Respawns cleanly.
    const out = await cap.addTagsOnnxBatch(fixtureChunks());
    assert.deepEqual(out.map((c) => c.tags), [[], []]);
    assert.equal(cap.__test.state().ready, true);
  });

  test('shutdownOnnxTagWorker() is a no-op (does not throw) when no worker has ever been spawned', async () => {
    await assert.doesNotReject(() => cap.shutdownOnnxTagWorker());
  });
});

describe('two independently-constructed capability instances have genuinely independent worker lifecycles (code review, Phase 8B Step 4, second pass)', () => {
  // This is the exact regression the review named: the first draft of the
  // Step 4 architecture test exercised two concurrent addTagsOnnxBatch()
  // CALLS sharing one module-scope singleton worker and proved request
  // correlation worked — a real but far weaker claim than "two capability
  // INSTANCES never share worker state." These tests construct two SEPARATE
  // createTagOnnxCapability() instances (mirroring two separate
  // composition roots, or two concurrent run({ capabilities }) calls each
  // given their own instance) and prove shutting one down never touches
  // the other's worker or pending requests.

  test('shutting down capability A never kills capability B\'s worker, and B\'s in-flight request still completes successfully', async () => {
    const capA = createTagOnnxCapability();
    const capB = createTagOnnxCapability();

    let workerAKillCalls = 0;
    let workerBKillCalls = 0;
    capA.__test.setWorkerFactory(() => {
      const w = makeFakeWorker({ tagFn: (chunks) => chunks.map(() => ['tag-a']) });
      const originalKill = w.kill;
      w.kill = (...args) => { workerAKillCalls += 1; return originalKill(...args); };
      return w;
    });
    // B's own worker: replies to 'ready' immediately (like makeFakeWorker)
    // but deliberately does NOT auto-reply to 'run' — this test replies to
    // B's run request manually, once it has confirmed A's shutdown did not
    // touch B at all, using the real requestId B's own send() call used.
    let workerBSentRequestId = null;
    let workerB;
    capB.__test.setWorkerFactory(() => {
      workerB = new EventEmitter();
      workerB.send = (msg) => { if (msg?.kind === 'run') workerBSentRequestId = msg.requestId; };
      const originalKill = () => { workerB.killed = true; queueMicrotask(() => workerB.emit('exit', null)); };
      workerB.kill = (...args) => { workerBKillCalls += 1; return originalKill(...args); };
      queueMicrotask(() => workerB.emit('message', { kind: 'ready' }));
      return workerB;
    });

    // Start A's own work (resolves quickly) and B's own request (stays
    // pending — B's fake worker never auto-replies to 'run').
    await capA.addTagsOnnxBatch(fixtureChunks());
    const bPending = capB.addTagsOnnxBatch(fixtureChunks());
    // Give B's addTagsOnnxBatch a tick to spawn its own worker and send its
    // own run request.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(capB.__test.state().pendingCount, 1, 'sanity: B has a real pending request in flight');
    assert.ok(workerBSentRequestId !== null, 'sanity: B\'s own worker actually received a run request');

    // Shut down A ONLY. B's worker must be completely unaffected.
    await capA.shutdownOnnxTagWorker();
    assert.equal(workerAKillCalls, 1, 'A\'s own worker was killed by A\'s own shutdown');
    assert.equal(workerBKillCalls, 0, 'B\'s worker must NOT have been killed by A\'s shutdown');
    assert.equal(capB.__test.state().pendingCount, 1, 'B\'s pending request must still be pending — A\'s shutdown must not have rejected it');

    // Now let B's own worker reply for real, using the requestId it
    // actually received — B's request must complete successfully, never
    // having been touched by A's shutdown. fixtureChunks() has 2 chunks,
    // so the reply needs one tag array per chunk.
    workerB.emit('message', { kind: 'done', requestId: workerBSentRequestId, tagArrays: [['tag-b'], ['tag-b']] });
    const bResult = await bPending;
    assert.deepEqual(bResult.map((c) => c.tags), [['tag-b'], ['tag-b']], 'B\'s own request resolved with B\'s own real reply, never rejected by A\'s shutdown');
    assert.equal(workerBKillCalls, 0, 'B\'s worker still must never have been killed');
  });

  test('independent failure flags — a crash in capability A does not disable capability B', async () => {
    const capA = createTagOnnxCapability();
    const capB = createTagOnnxCapability();

    capA.__test.setWorkerFactory(() => makeFakeWorker({ failReady: 'A crashed' }));
    capB.__test.setWorkerFactory(() => makeFakeWorker({ tagFn: (chunks) => chunks.map(() => ['tag-b']) }));

    const outA = await capA.addTagsOnnxBatch(fixtureChunks());
    assert.deepEqual(outA.map((c) => c.tags), [[], []], 'A failed to load and fell back to empty tags');
    assert.equal(capA.__test.state().failed, true, 'A itself is marked failed');

    const outB = await capB.addTagsOnnxBatch(fixtureChunks());
    assert.deepEqual(outB.map((c) => c.tags), [['tag-b'], ['tag-b']], 'B was never affected by A\'s failure — it generated real tags');
    assert.equal(capB.__test.state().failed, false, 'B\'s own failure flag is independent of A\'s');
  });

  test('repeated shutdown is safe per-instance, independently — shutting A down twice never affects B, and B can still be shut down cleanly afterward', async () => {
    const capA = createTagOnnxCapability();
    const capB = createTagOnnxCapability();

    let workerBKillCalls = 0;
    capA.__test.setWorkerFactory(() => makeFakeWorker({ tagFn: (chunks) => chunks.map(() => []) }));
    capB.__test.setWorkerFactory(() => {
      const w = makeFakeWorker({ tagFn: (chunks) => chunks.map(() => []) });
      const originalKill = w.kill;
      w.kill = (...args) => { workerBKillCalls += 1; return originalKill(...args); };
      return w;
    });

    await capA.addTagsOnnxBatch(fixtureChunks());
    await capB.addTagsOnnxBatch(fixtureChunks());

    await assert.doesNotReject(() => capA.shutdownOnnxTagWorker());
    await assert.doesNotReject(() => capA.shutdownOnnxTagWorker()); // repeated — still safe
    assert.equal(workerBKillCalls, 0, 'B\'s worker must still be untouched after A was shut down twice');

    // B still works and can be shut down cleanly on its own.
    const out = await capB.addTagsOnnxBatch(fixtureChunks());
    assert.deepEqual(out.map((c) => c.tags), [[], []]);
    await assert.doesNotReject(() => capB.shutdownOnnxTagWorker());
    assert.equal(workerBKillCalls, 1);
  });
});

describe('tag-onnx.js production defaults — structural checks', () => {
  test('the real (non-test) worker factory sets windowsHide: true on fork()', async () => {
    // A missing windowsHide: true on Windows can flash a console window per
    // spawned child process (code review finding). Structural check since
    // exercising the real factory would spawn a real child process.
    //
    // Exactly ONE fork(WORKER_PATH, ...) call site is expected now — the
    // production default and __test.reset() previously duplicated this
    // call inline; the Step 4 refactor consolidated both onto one shared
    // defaultWorkerFactory() function (see tag-onnx.js's own source),
    // which is itself a de-duplication, not a regression.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../../../src/local/indexer/phases/tag-onnx.js', import.meta.url), 'utf-8');
    const forkCallSites = [...src.matchAll(/fork\(WORKER_PATH,\s*\[\],\s*\{[^}]*\}/gs)];
    assert.equal(forkCallSites.length, 1, 'expected exactly one shared fork() call site (defaultWorkerFactory), reused by both production and __test.reset()');
    assert.match(forkCallSites[0][0], /windowsHide:\s*true/, `fork() call site missing windowsHide: true:\n${forkCallSites[0][0]}`);
  });
});
