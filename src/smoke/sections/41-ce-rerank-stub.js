// CE reranker smoke tests — stubbed, no network, no model download, no real
// child process. Covers the four cases from docs/en/ce-rerank-design.md §7:
//   1. stub path ordering (CE sort flips candidates by mocked logits)
//   2. timeout fallback (withCETimeout returns pre-CE results fast)
//   3. model load failure fallback (CE disabled for session, logged once)
//   4. numLabels fail-fast (unsupported head layout rejected at load)
//
// Since CE scoring now runs in a persistent CHILD PROCESS
// (core/ce-rerank-worker.js, spawned via node:child_process's fork()) rather
// than in-process, these tests inject a FAKE worker (an EventEmitter-shaped
// stub implementing the same send/on/off/once/kill surface a real
// ChildProcess exposes) via __test.setWorkerFactory() — never a real child
// process, never @huggingface/transformers, never onnxruntime-node.
import { EventEmitter } from 'node:events';

// Builds a fake worker whose scoring behavior is controlled by `scoreFn`
// (query, candidates) => number[] | throws. Mirrors the real
// ce-rerank-worker.js message protocol exactly: posts { kind: 'ready',
// numLabels } once (async, next tick) after construction, then on every
// { kind: 'run', requestId, ... } message replies with { kind: 'done',
// requestId, scores } or { kind: 'error', requestId, error }.
function makeFakeCeWorker({ scoreFn, numLabels = 2, readyDelayMs = 0, failReady = null }) {
  const worker = new EventEmitter();
  worker.send = (msg) => {
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
  worker.kill = () => { queueMicrotask(() => worker.emit('exit', null)); };
  const emitReady = () => {
    if (failReady) worker.emit('message', { kind: 'error', error: failReady });
    else worker.emit('message', { kind: 'ready', numLabels });
  };
  if (readyDelayMs > 0) setTimeout(emitReady, readyDelayMs);
  else queueMicrotask(emitReady);
  return worker;
}

// A fake worker that spawns/loads successfully (emits 'ready' normally) but
// never replies to a 'run' request — used to exercise the per-request
// worker-round-trip timeout distinctly from an outright load failure.
function makeHangingCeWorker({ numLabels = 2 } = {}) {
  const worker = new EventEmitter();
  worker.send = () => {}; // 'run' messages are accepted but never answered
  worker.kill = () => { queueMicrotask(() => worker.emit('exit', null)); };
  queueMicrotask(() => worker.emit('message', { kind: 'ready', numLabels }));
  return worker;
}

export default async function ({ ok }) {
  console.log('\n[41] CE rerank — stubbed worker, timeout, load-failure, numLabels');

  const { ceRerank, loadCEModel, buildPassage, withCETimeout, __test } =
    await import('../../core/ce-rerank.js');

  const cand = (file, text) => ({
    score: 0.03,
    payload: { source_file: file, chunk_index: 0, section: 'sec', text },
  });
  const candidates = [cand('alpha.md', 'alpha text'), cand('beta.md', 'beta text')];

  // Stub scoring: positive score for passages built from candidates whose
  // text mentions "beta", low score otherwise — same behavior the previous
  // in-process stub model encoded.
  const stubScoreFn = (query, batch) => batch.map((r) => (
    buildPassage(r.payload, 'text+meta').includes('beta') ? 0.9 : 0.1
  ));

  // Temporarily capture stderr; returns captured text.
  const captureStderr = async (fn) => {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    try { await fn(); } finally { process.stderr.write = orig; }
    return captured;
  };

  // ── buildPassage formats ─────────────────────────────────────────────────────
  const pay = { source_file: 'a.md', section: 'Install', text: 'body' };
  ok('passage text',         buildPassage(pay, 'text') === 'body');
  ok('passage text+section', buildPassage(pay, 'text+section') === 'Install\nbody');
  ok('passage text+meta',    buildPassage(pay, 'text+meta') === 'a.md Install\nbody');
  ok('passage null payload safe', buildPassage(null, 'text') === '');

  // ── 1. Stub path ordering ────────────────────────────────────────────────────
  __test.reset();
  __test.setWorkerFactory(() => makeFakeCeWorker({ scoreFn: stubScoreFn, numLabels: 2 }));
  await captureStderr(async () => {
    const out = await ceRerank(candidates, 'find beta', { finalLimit: 2 });
    ok('CE flips order by mocked scores', out[0].payload.source_file === 'beta.md');
    ok('CE score attached',               out[0].score > out[1].score);
    ok('numLabels=2 detected',            __test.state().numLabels === 2);
  });

  // numLabels=1 regression head also accepted.
  __test.reset();
  __test.setWorkerFactory(() => makeFakeCeWorker({ scoreFn: stubScoreFn, numLabels: 1 }));
  await captureStderr(async () => {
    const out = await ceRerank(candidates, 'find beta', { finalLimit: 2 });
    ok('numLabels=1 path works', out[0].payload.source_file === 'beta.md');
  });

  // Empty pool short-circuits without spawning a worker.
  __test.reset();
  __test.setWorkerFactory(() => { throw new Error('must not be called'); });
  ok('empty pool → [] without load', (await ceRerank([], 'q', {})).length === 0);

  // ── 2. Timeout fallback (overall-call timeout, withCETimeout) ───────────────
  {
    const keepalive = setTimeout(() => {}, 10000);
    const slow = new Promise(res => {
      const t = setTimeout(() => res(['late']), 20000);
      if (typeof t.unref === 'function') t.unref();
    });
    const t0 = Date.now();
    let fb = null;
    await captureStderr(async () => {
      fb = await withCETimeout(slow, 100, () => candidates.slice(0, 2));
    });
    clearTimeout(keepalive);
    const elapsed = Date.now() - t0;
    ok('timeout resolves fast (<1000ms)',     elapsed < 1000);
    ok('timeout returns pre-CE candidates',   fb.length === 2 && fb[0].payload.source_file === 'alpha.md');
  }
  {
    const fast = Promise.resolve(['ce-result']);
    const out = await withCETimeout(fast, 5000, () => ['fallback']);
    ok('fast path wins the race', out[0] === 'ce-result');
  }

  // ── 3. Model load failure fallback ──────────────────────────────────────────
  __test.reset();
  __test.setWorkerFactory(() => makeFakeCeWorker({ scoreFn: stubScoreFn, failReady: 'network unavailable and model not cached' }));
  {
    const logged = await captureStderr(async () => {
      const out1 = await ceRerank(candidates, 'q', { finalLimit: 2 });
      const out2 = await ceRerank(candidates, 'q', { finalLimit: 2 });
      ok('load failure returns pre-CE list (1st)', out1[0].payload.source_file === 'alpha.md');
      ok('load failure returns pre-CE list (2nd)', out2[0].payload.source_file === 'alpha.md');
    });
    ok('_ceModelFailed set after load failure', __test.state().failed === true);
    const occurrences = logged.split('worker load failed:').length - 1;
    ok('failure logged exactly once (no retry)', occurrences === 1);
  }

  // ── 4. numLabels fail-fast (rejected inside the worker before 'ready') ──────
  __test.reset();
  __test.setWorkerFactory(() => makeFakeCeWorker({ scoreFn: stubScoreFn, failReady: 'unsupported numLabels=3 for "test-model" — expected 1 or 2' }));
  {
    let threw = null;
    await captureStderr(async () => {
      try { await loadCEModel(); } catch (e) { threw = e; }
    });
    ok('numLabels=3 rejected at load',        threw !== null && threw.message.includes('unsupported numLabels=3'));
    ok('_ceModelFailed set on bad numLabels', __test.state().failed === true);
    await captureStderr(async () => {
      const out = await ceRerank(candidates, 'q', { finalLimit: 2 });
      ok('subsequent ceRerank returns pre-CE list', out[0].payload.source_file === 'alpha.md');
    });
  }

  // ── 5. Worker never replies to a run request (per-request round-trip timeout) ──
  __test.reset();
  __test.setWorkerFactory(() => makeHangingCeWorker());
  {
    // The per-request round-trip timer is deliberately unref'd in
    // production (correct for a long-lived MCP/admin server — a pending CE
    // timeout must never keep the process alive) — same caveat
    // withCETimeout's own sentinel timer documents above. In this
    // short-lived script we must keep the event loop alive ourselves or
    // Node exits before the timer fires.
    const keepalive = setTimeout(() => {}, 5000);
    const logged = await captureStderr(async () => {
      // A short synthetic timeoutMs via a settingsService stub keeps this
      // smoke test fast — RERANK_CE_TIMEOUT_MS's own 100ms floor is used
      // here rather than the real 10s default.
      const settingsService = {
        getActiveValue: (key) => ({
          RERANK_CE_INPUT: 'text+meta', RERANK_CE_TOP_N: 40,
          RERANK_CE_TIMEOUT_MS: 100, RERANK_CE_BATCH_SIZE: 16,
        }[key]),
      };
      const out = await ceRerank(candidates, 'q', { finalLimit: 2 }, { settingsService });
      ok('hung worker round-trip falls back to pre-CE for this call', out[0].payload.source_file === 'alpha.md');
    });
    clearTimeout(keepalive);
    // A hung worker is stuck mid-inference, not merely slow — code review
    // finding: dropping only the pending request and clearing the busy
    // flag would let a NEW request pile a second concurrent inference onto
    // the same already-overloaded worker (an OOM risk). A per-request
    // timeout is now treated the same as an unexpected worker exit: kill
    // the child process and disable CE for the rest of the session.
    ok('hung worker IS marked permanently failed (matches the unexpected-exit contract, prevents piling more work onto a stuck worker)', __test.state().failed === true);
    ok('timeout logged', logged.includes('did not respond within'));
  }

  // Restore module state for any later section.
  __test.reset();
}
