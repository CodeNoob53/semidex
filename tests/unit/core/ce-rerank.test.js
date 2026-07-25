// core/ce-rerank.js — applyCeRerankSettings() (code review fix). Proves
// RERANK_CE_MODEL/RERANK_CE_DEVICE/RERANK_CE_CACHE_DIR are genuinely
// consumed from a SettingsService (next_restart: read once, before the
// first model load), not left permanently reading raw env as an earlier,
// incorrect reading of "next_restart" had it.
//
// Also covers the child-process coordinator layer added when CE scoring
// moved out of this (main/MCP) process into a persistent
// core/ce-rerank-worker.js CHILD PROCESS (node:child_process's fork(), NOT
// worker_threads — a worker_thread shares the OS process, and therefore
// ONNX Runtime's process-global Ort::Env singleton, with the main thread;
// only a genuinely separate process isolates the custom CUDA
// onnxruntime-node build from Transformers.js's own bundled ORT build).
// Every test here injects a FAKE worker (EventEmitter-shaped, never a real
// child process) via __test.setWorkerFactory(), exercising the exact same
// message protocol the real worker uses.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  applyCeRerankSettings, ceRerank, loadCEModel, shutdownCEWorker, buildPassage, __test,
} from '../../../src/core/ce-rerank.js';
import * as ceRerankModule from '../../../src/core/ce-rerank.js';

function fakeSettingsService(values) {
  return { getActiveValue: (key) => values[key] };
}

describe('applyCeRerankSettings — settingsService extraction for next_restart fields', () => {
  test('overwrites RERANK_CE_MODEL/RERANK_CE_DEVICE/RERANK_CE_CACHE_DIR exports', () => {
    const originalModel = ceRerankModule.RERANK_CE_MODEL;
    const originalDevice = ceRerankModule.RERANK_CE_DEVICE;
    const originalCacheDir = ceRerankModule.RERANK_CE_CACHE_DIR;
    try {
      applyCeRerankSettings(fakeSettingsService({
        RERANK_CE_MODEL: 'custom/model-name', RERANK_CE_DEVICE: 'dml', RERANK_CE_CACHE_DIR: '/custom/cache',
      }));
      assert.equal(ceRerankModule.RERANK_CE_MODEL, 'custom/model-name');
      assert.equal(ceRerankModule.RERANK_CE_DEVICE, 'dml');
      assert.equal(ceRerankModule.RERANK_CE_CACHE_DIR, '/custom/cache');
    } finally {
      // Restore for any test that runs after this one in the same process.
      applyCeRerankSettings(fakeSettingsService({
        RERANK_CE_MODEL: originalModel, RERANK_CE_DEVICE: originalDevice, RERANK_CE_CACHE_DIR: originalCacheDir,
      }));
    }
  });
});

// ── Fake worker helpers — shaped like a real node:child_process
// ChildProcess (.send/.on/.off/.once/.kill), mirroring ce-rerank-worker.js's
// real message protocol exactly (kind: 'ready'|'done'|'error', requestId
// matching). kill() emits 'exit' asynchronously (a real child process's
// kill() is synchronous but 'exit' fires later, once the OS confirms
// termination) — tests that need a kill() which never reports exit
// override it explicitly (mirrors onnx-provider-probe.test.js's fake child
// convention for the same real-world asymmetry).
function makeFakeWorker({ scoreFn, numLabels = 2, failReady = null } = {}) {
  const worker = new EventEmitter();
  const posted = [];
  worker.send = (msg) => {
    posted.push(msg);
    if (msg?.kind !== 'run') return;
    queueMicrotask(() => {
      try {
        const scores = scoreFn(msg.query, msg.candidates);
        worker.emit('message', { kind: 'done', requestId: msg.requestId, scores });
      } catch (err) {
        worker.emit('message', { kind: 'error', requestId: msg.requestId, error: err.message });
      }
    });
  };
  worker.kill = () => { worker.killed = true; queueMicrotask(() => worker.emit('exit', null)); };
  worker.posted = posted;
  queueMicrotask(() => {
    if (failReady) worker.emit('message', { kind: 'error', error: failReady });
    else worker.emit('message', { kind: 'ready', numLabels });
  });
  return worker;
}

function makeSilentWorker({ numLabels = 2 } = {}) {
  const worker = new EventEmitter();
  worker.send = () => {}; // never replies to 'run'
  worker.kill = () => { worker.killed = true; queueMicrotask(() => worker.emit('exit', null)); };
  queueMicrotask(() => worker.emit('message', { kind: 'ready', numLabels }));
  return worker;
}

function fixtureCandidates() {
  return [
    { score: 0.03, payload: { source_file: 'alpha.md', chunk_index: 0, section: 'sec', text: 'alpha text' } },
    { score: 0.03, payload: { source_file: 'beta.md', chunk_index: 0, section: 'sec', text: 'beta text' } },
  ];
}

describe('ce-rerank worker coordinator', () => {
  test.beforeEach(() => __test.reset());
  test.afterEach(() => __test.reset());

  test('spawns exactly one worker for concurrent loadCEModel() callers (promise-guarded)', async () => {
    let spawnCount = 0;
    __test.setWorkerFactory(() => { spawnCount += 1; return makeFakeWorker({ scoreFn: () => [0.1, 0.9] }); });
    await Promise.all([loadCEModel(), loadCEModel(), loadCEModel()]);
    assert.equal(spawnCount, 1);
  });

  test('ceRerank sends exactly one run request per call, with query/candidates/input/batchSize', async () => {
    let worker;
    __test.setWorkerFactory(() => { worker = makeFakeWorker({ scoreFn: () => [0.1, 0.9] }); return worker; });
    await ceRerank(fixtureCandidates(), 'my query', { finalLimit: 2 });
    const runMessages = worker.posted.filter((m) => m.kind === 'run');
    assert.equal(runMessages.length, 1);
    assert.equal(runMessages[0].query, 'my query');
    assert.equal(runMessages[0].candidates.length, 2);
    assert.ok('input' in runMessages[0]);
    assert.ok('batchSize' in runMessages[0]);
  });

  test('ceRerank reorders candidates by worker-reported scores, descending', async () => {
    __test.setWorkerFactory(() => makeFakeWorker({ scoreFn: () => [0.1, 0.9] }));
    const out = await ceRerank(fixtureCandidates(), 'q', { finalLimit: 2 });
    assert.equal(out[0].payload.source_file, 'beta.md');
    assert.equal(out[0].score, 0.9);
    assert.equal(out[1].score, 0.1);
  });

  test('empty candidate pool short-circuits without spawning a worker', async () => {
    __test.setWorkerFactory(() => { throw new Error('must not be called'); });
    const out = await ceRerank([], 'q', {});
    assert.deepEqual(out, []);
  });

  test('a worker that fails to reach ready (kind: error) marks the session failed and disables CE, never retrying', async () => {
    __test.setWorkerFactory(() => makeFakeWorker({ failReady: 'boom' }));
    const out1 = await ceRerank(fixtureCandidates(), 'q', { finalLimit: 2 });
    const out2 = await ceRerank(fixtureCandidates(), 'q', { finalLimit: 2 });
    assert.equal(out1[0].payload.source_file, 'alpha.md'); // pre-CE order preserved
    assert.equal(out2[0].payload.source_file, 'alpha.md');
    assert.equal(__test.state().failed, true);
  });

  test('loadCEModel() throws when the worker fails to reach ready', async () => {
    __test.setWorkerFactory(() => makeFakeWorker({ failReady: 'boom' }));
    await assert.rejects(() => loadCEModel(), /boom/);
    assert.equal(__test.state().failed, true);
  });

  test('a worker that exits (non-zero code) DURING its own init is rejected cleanly, not an uncaught TypeError', async () => {
    // Regression test: onWorkerExit() (registered via .on('exit', ...) —
    // the GLOBAL, persistent listener) and ensureWorker()'s own local
    // .once('exit', onExit) init-listener BOTH fire on the same 'exit'
    // event, since EventEmitter invokes every registered listener, not
    // just one. onWorkerExit() runs first (registered first) and sets the
    // module-level _worker to null; the local init handler's cleanup()
    // used to then call _worker.off(...) — a real, reproducible crash
    // ("Cannot read properties of null (reading 'off')") thrown
    // synchronously out of an event handler, uncatchable by loadCEModel()'s
    // own try/catch since it happens inside the 'exit' emit, not inside an
    // awaited promise chain.
    __test.setWorkerFactory(() => {
      const worker = new EventEmitter();
      worker.send = () => {};
      worker.kill = () => {};
      queueMicrotask(() => worker.emit('exit', 1)); // exits before ever posting 'ready'
      return worker;
    });
    await assert.rejects(() => loadCEModel(), /exited during init \(code 1\)/);
    assert.equal(__test.state().failed, true);
  });

  test('a worker that exits with code 0 DURING its own init (before ever posting ready) is rejected immediately, not left hanging until the 5-minute init timeout', async () => {
    // Regression test (P2): the init-phase exit handler only rejected for
    // `code !== 0` — a worker exiting cleanly (code 0) before ever posting
    // 'ready' fell through that check entirely, calling neither resolve
    // nor reject. Since a worker that has already exited can never post
    // 'ready' afterward, this left ensureWorker() (and therefore
    // loadCEModel()) hanging until the full, non-configurable
    // CE_WORKER_INIT_TIMEOUT_MS (5 minutes) elapsed, even though the true
    // outcome (init failed) was already known the instant the process
    // exited.
    const keepalive = setTimeout(() => {}, 2000);
    __test.setWorkerFactory(() => {
      const worker = new EventEmitter();
      worker.send = () => {};
      worker.kill = () => {};
      queueMicrotask(() => worker.emit('exit', 0)); // clean exit, but BEFORE 'ready'
      return worker;
    });
    const t0 = Date.now();
    try {
      await assert.rejects(() => loadCEModel(), /exited during init \(code 0\)/);
      const elapsed = Date.now() - t0;
      assert.equal(__test.state().failed, true, 'a worker that can never become ready must disable CE for this session');
      assert.ok(elapsed < 1000, `must reject immediately on exit, not wait out the 5-minute init timeout (took ${elapsed}ms)`);
    } finally {
      clearTimeout(keepalive);
    }
  });

  test('a second loadCEModel() call after a load failure throws the "previously failed" error without re-spawning', async () => {
    let spawnCount = 0;
    __test.setWorkerFactory(() => { spawnCount += 1; return makeFakeWorker({ failReady: 'boom' }); });
    await assert.rejects(() => loadCEModel());
    await assert.rejects(() => loadCEModel(), /previously failed to load/);
    assert.equal(spawnCount, 1);
  });

  test('an unexpected worker exit (non-zero code) rejects pending requests and marks the session failed', async () => {
    let worker;
    __test.setWorkerFactory(() => { worker = makeFakeWorker({ scoreFn: () => { throw new Error('unused'); } }); return worker; });
    await loadCEModel();
    const pending = ceRerank(fixtureCandidates(), 'q', { finalLimit: 2 });
    // Simulate a crash instead of a real reply. loadCEModel()'s
    // already-ready fast path is still `async`, so ceRerank()'s call above
    // has already yielded control back here (before scoreViaWorker()'s own
    // worker.send() runs) — this line races the exit against that in-flight
    // send.
    worker.emit('exit', 1);
    const out = await pending;
    assert.equal(out[0].payload.source_file, 'alpha.md'); // ceRerank never throws
    assert.equal(__test.state().failed, true);
  });

  test('a worker exiting in the gap between loadCEModel() resolving and this request\'s own worker.send() call produces an informative error, not a raw TypeError', async () => {
    // Regression test (found while writing tag-onnx.js's equivalent
    // suite): loadCEModel()/ensureWorker() are `async`, so even the
    // already-ready fast path yields one microtask tick before the caller
    // resumes — a worker exit landing in that exact gap (after the await,
    // before scoreViaWorker()'s own worker.send() call) used to throw
    // "Cannot read properties of null (reading 'send')" instead of a
    // clean, actionable rejection. Always caught by ceRerank()'s own
    // try/catch either way (never an unhandled crash) — this test's point
    // is specifically the MESSAGE quality.
    let worker;
    __test.setWorkerFactory(() => { worker = makeFakeWorker({ scoreFn: () => [0.1, 0.9] }); return worker; });
    await loadCEModel();

    const originalWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    try {
      const pending = ceRerank(fixtureCandidates(), 'q', { finalLimit: 2 });
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
    __test.setWorkerFactory(() => { worker = makeFakeWorker({ scoreFn: () => [0.1, 0.9] }); return worker; });
    await loadCEModel();
    worker.emit('exit', 0);
    assert.equal(__test.state().failed, false);
  });

  test('busy flag: a second concurrent ceRerank call skips CE and returns pre-CE candidates', async () => {
    let resolveScore;
    __test.setWorkerFactory(() => {
      const worker = new EventEmitter();
      worker.send = (msg) => {
        if (msg.kind !== 'run') return;
        resolveScore = () => worker.emit('message', { kind: 'done', requestId: msg.requestId, scores: [0.1, 0.9] });
      };
      worker.kill = () => {};
      queueMicrotask(() => worker.emit('message', { kind: 'ready', numLabels: 2 }));
      return worker;
    });
    const first = ceRerank(fixtureCandidates(), 'q', { finalLimit: 2 });
    // Give the first call a chance to set the busy flag before the second starts.
    await new Promise((r) => setTimeout(r, 10));
    const second = await ceRerank(fixtureCandidates(), 'q2', { finalLimit: 2 });
    assert.equal(second[0].payload.source_file, 'alpha.md'); // busy-skip: pre-CE order
    resolveScore();
    const out1 = await first;
    assert.equal(out1[0].payload.source_file, 'beta.md'); // first call still completes normally
  });

  test('a worker that never replies to a run request times out, falls back to pre-CE for that call, terminates the worker, and disables CE for the rest of the session', async () => {
    // A hung worker is stuck mid-inference, not merely slow — it is NOT
    // safe to keep accepting new requests against it (that would let a
    // second inference pile onto an already-overloaded/stuck worker,
    // risking OOM). So a per-request timeout is now treated the same as
    // an unexpected worker exit: terminate, disable CE for the rest of
    // this process, exactly like the "unexpected worker exit" test above.
    let killCalls = 0;
    __test.setWorkerFactory(() => {
      const worker = makeSilentWorker();
      const originalKill = worker.kill;
      worker.kill = (...args) => { killCalls += 1; return originalKill(...args); };
      return worker;
    });
    const settingsService = fakeSettingsService({
      RERANK_CE_INPUT: 'text+meta', RERANK_CE_TOP_N: 40, RERANK_CE_TIMEOUT_MS: 50, RERANK_CE_BATCH_SIZE: 16,
    });
    const out = await ceRerank(fixtureCandidates(), 'q', { finalLimit: 2 }, { settingsService });
    assert.equal(out[0].payload.source_file, 'alpha.md', 'the timed-out call itself still returns pre-CE candidates, not a throw');
    assert.equal(killCalls, 1, 'the hung worker must be killed, not left running a stuck inference');
    assert.equal(__test.state().failed, true, 'a hung worker must disable CE for the rest of the session, matching the unexpected-exit contract');

    // A subsequent call must not attempt to reuse the terminated worker —
    // it stays disabled (pre-CE candidates), never throws, never hangs.
    const second = await ceRerank(fixtureCandidates(), 'q2', { finalLimit: 2 }, { settingsService });
    assert.equal(second[0].payload.source_file, 'alpha.md');
  });

  test('shutdownCEWorker() kills the worker and allows a clean respawn afterward', async () => {
    let killCalls = 0;
    __test.setWorkerFactory(() => {
      const worker = makeFakeWorker({ scoreFn: () => [0.1, 0.9] });
      const originalKill = worker.kill;
      worker.kill = (...args) => { killCalls += 1; return originalKill(...args); };
      return worker;
    });
    await loadCEModel();
    await shutdownCEWorker();
    assert.equal(killCalls, 1);
    assert.equal(__test.state().ready, false);
    // Respawns cleanly (not marked permanently failed by the deliberate shutdown).
    await loadCEModel();
    assert.equal(__test.state().ready, true);
  });

  test('buildPassage formats are unaffected by the worker migration (still a pure function)', () => {
    const p = { source_file: 'a.md', section: 'Install', text: 'body' };
    assert.equal(buildPassage(p, 'text'), 'body');
    assert.equal(buildPassage(p, 'text+section'), 'Install\nbody');
    assert.equal(buildPassage(p, 'text+meta'), 'a.md Install\nbody');
    assert.equal(buildPassage(null, 'text'), '');
  });
});
