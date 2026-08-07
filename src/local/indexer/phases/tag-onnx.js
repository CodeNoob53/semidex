// ONNX tag generation phase.
// Spawns a persistent CHILD PROCESS (tag-onnx-worker.js, via
// node:child_process's fork() — NOT worker_threads) on first call and keeps
// it alive for the duration of the OWNING capability instance (see
// createTagOnnxCapability() below — code review, Phase 8B Step 4, second
// pass).
//
// worker_threads was used here previously and has since been migrated away
// from: a worker_thread is a separate V8 isolate but the SAME OS process,
// so native addons (including ONNX Runtime's own process-global Ort::Env
// singleton) are shared with whatever else the indexer's main process has
// loaded — notably the custom CUDA-enabled onnxruntime-node build
// local/core/onnx-embed.js loads when ONNX_EMBED=1. Two different ORT builds
// sharing one process's native address space is exactly the conflict this
// isolation exists to prevent; only a genuinely separate OS process
// (child_process) provides that boundary. See
// docs/cuda-runtime-verification-2026-07-24.md.
//
// Request/response are matched by a monotonic requestId so concurrent callers
// (OLLAMA_STAGE_CONCURRENCY > 1) each get their own reply without racing —
// the WORKER itself serializes actual model inference via its own internal
// FIFO queue (see tag-onnx-worker.js's own header), so multiple in-flight
// requestIds here never mean concurrent generator() calls in the child.
//
// Timeout/failure contracts (mirrors core/ce-rerank.js's established
// pattern exactly, including the exact reasoning for each choice):
//   - ensureWorker() is bounded by TAG_ONNX_INIT_TIMEOUT_MS — a stuck model
//     load/download cannot hang the caller forever.
//   - Each addTagsOnnxBatch() request is bounded by
//     TAG_ONNX_REQUEST_TIMEOUT_MS — a hung/stuck inference is NOT merely
//     slow; killing the worker and disabling the session (rather than just
//     dropping the pending entry) prevents a new request from piling a
//     second concurrent generation attempt onto an already-stuck worker.
//   - addTagsOnnxBatch() never throws — a worker crash/load failure/
//     timeout disables ONNX tagging for the rest of the session and
//     returns chunks with .tags: [] (per this module's own documented
//     contract), never propagates an exception to the indexer pipeline.
//
// ── Instance-scoped coordinator state (Phase 8B Step 4, second review pass) ──
//
// Code review finding (P1): the first version of this file's physical
// relocation kept every piece of coordinator state — _worker, _pending,
// _dispatchTail, _initPromise, the failure flags, the worker factory — as
// MODULE-SCOPE bindings, exactly as they were before the move. That is a
// real, live isolation gap, not merely latent: index-full.js's own
// `tagOnnx: tagOnnxLazy` (index-full.js) is the SAME cached ES module
// namespace object every `run({ capabilities })` call receives — the
// module cache guarantees this, it is not an edge case. Two run() calls
// executing concurrently in the same process (e.g. two indexing jobs
// launched close together) therefore shared exactly one underlying
// worker/pending-map/dispatch-queue. The first run's own `finally` block
// calling `ctx.tagOnnx.shutdownOnnxTagWorker()` (run.js) would kill the
// SAME worker the second run's still-pending request depended on, and
// reject that second run's pending request outright — the exact
// "cleanup of one run affects another" failure mode Step 3's own
// `ctx`-threading fix was built specifically to eliminate for the other
// five capabilities. A first-draft regression test for this file
// exercised two concurrent addTagsOnnxBatch() CALLS sharing one worker and
// proved request/response correlation worked — a real but much weaker
// claim than "two capability INSTANCES never share worker state"; it
// never actually constructed two independent capabilities or called
// shutdown on one while the other had a pending request, so it could not
// have caught this gap.
//
// The fix: every piece of coordinator state below now lives inside
// createTagOnnxCapability()'s own closure, never at module scope. Each
// call to the factory returns a fresh object with its own independent
// _worker/_pending/_dispatchTail/_initPromise/failure-flags/worker-factory
// — a genuinely separate worker lifecycle, not a shared reference to one
// singleton. Full's composition root calls the factory once, up front
// (index-full.js), and passes the resulting instance in as `tagOnnx`;
// Lite continues to build its own typed-unavailable object per call
// (index-lite.js, unchanged by this fix). Two concurrently-executing
// run({ capabilities }) calls that each construct their OWN capability
// instance (the correct composition pattern for a process expecting real
// concurrency) now have two genuinely independent workers — shutting one
// down never touches the other's pending requests or worker process.
//
// A single process still normally has ONE indexer CLI invocation, one
// composition root, one capability instance, one worker — nothing here
// changes that common case's behavior or performance. What changes is
// that the design is no longer ACCIDENTALLY safe only because concurrent
// composition happens to be rare in today's process topology; it is
// correct by construction now, matching every other capability's own
// Step 3 guarantee.
//
// Exports:
//   isOnnxTagProvider(env?)      — true when TAG_PROVIDER=onnx (module-level, stateless)
//   createTagOnnxCapability()    — returns a fresh { addTagsOnnxBatch, shutdownOnnxTagWorker } instance, own independent worker lifecycle
//   __test                       — test-only helpers (see bottom of file)

import { fork } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// tag-provider.js deliberately stays shared, dependency-free (see its own
// header comment) — physically relocated to src/shared/indexer/phases/
// (Phase 8B Step 7B) — even though this file moved to
// src/local/indexer/phases/ (Phase 8B Step 4) — a local file importing a
// shared one is the normal, allowed direction; only shared -> local is
// forbidden.
import { isOnnxTagProvider } from '../../../shared/indexer/phases/tag-provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, '../workers/tag-onnx-worker.js');

// Re-exported for backward compatibility — isOnnxTagProvider now lives in
// tag-provider.js (see that file's header comment for why). Stateless, so
// it stays a plain module-level export rather than something the factory
// below needs to produce per instance.
export { isOnnxTagProvider };

// Model LOAD timeout (worker startup, including a possible first-time model
// download) — not user-configurable: this bounds a one-time startup step
// against hanging forever, not a tunable performance knob. Mirrors
// core/ce-rerank.js's CE_WORKER_INIT_TIMEOUT_MS exactly.
const TAG_ONNX_INIT_TIMEOUT_MS = 5 * 60 * 1000;

// Per-request timeout (one addTagsOnnxBatch() call's worker round-trip) —
// env-overridable since a batch's size (and therefore total generation
// time) varies with file/chunk count, unlike the CE path's fixed-shape
// per-request round trip.
function resolveRequestTimeoutMs(env = process.env) {
  const parsed = parseInt(env.TAG_ONNX_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(parsed) && parsed >= 1000) return parsed;
  return 120_000; // 2 minutes default — generous for a multi-chunk batch on CPU
}

// Grace period after kill() to actually observe the child's real exit
// before giving up — mirrors core/ce-rerank.js's own shutdown grace period.
const KILL_GRACE_MS = 3_000;

function resolveWorkerConfig(env = process.env) {
  // Phase 8B Step 4 — this file moved from src/indexer/phases/ to
  // src/local/indexer/phases/, one directory level deeper than before, so
  // ROOT needs one more '../' to still resolve to the repo root (verified:
  // join(__dirname, '../../../../') from src/local/indexer/phases/ ===
  // join(__dirname, '../../../') from the old src/indexer/phases/).
  const ROOT = join(__dirname, '../../../../');
  return {
    modelId:       env.TAG_ONNX_MODEL   || 'onnx-community/Qwen2.5-Coder-1.5B-Instruct',
    cacheDir:      join(ROOT, 'models', 'transformers-cache'),
    numThreads:    Math.max(1, parseInt(env.TAG_ONNX_THREADS || '1', 10) || 1),
    allowDownload: env.TAG_ONNX_ALLOW_DOWNLOAD === '1',
  };
}

// The real (production) worker factory — spawns an actual child process.
// This is createTagOnnxCapability()'s own default `workerFactory` — takes
// no closure state of its own, so it is safe to reuse across every
// instance that does not override it via the `workerFactory` test option.
function defaultWorkerFactory(cfg) {
  return fork(WORKER_PATH, [], {
    windowsHide: true,
    env: {
      ...process.env,
      TAG_ONNX_WORKER_MODEL_ID: cfg.modelId,
      TAG_ONNX_WORKER_CACHE_DIR: cfg.cacheDir,
      TAG_ONNX_WORKER_NUM_THREADS: String(cfg.numThreads),
      TAG_ONNX_WORKER_ALLOW_DOWNLOAD: cfg.allowDownload ? '1' : '0',
    },
  });
}

/**
 * Constructs one independent TagOnnxCapability instance — its own worker,
 * own pending-request map, own dispatch queue, own failure state. Call
 * once per composition root (index-full.js calls this exactly once, at
 * startup, and passes the result in as `tagOnnx`); each instance's worker
 * lifecycle is completely independent of any other instance's, including
 * across concurrent `run({ capabilities })` calls that were each given
 * their OWN instance.
 *
 * @param {{ workerFactory?: (cfg: Object) => Object }} [opts] — test-only
 *   override; production callers never pass this.
 * @returns {{ addTagsOnnxBatch: (chunks: Object[]) => Promise<Object[]>, shutdownOnnxTagWorker: () => Promise<void> }}
 */
export function createTagOnnxCapability({ workerFactory = defaultWorkerFactory } = {}) {
  // ── Instance-scoped worker + request queue ──────────────────────────────
  // Every binding below is a closure variable, private to THIS call's own
  // returned capability object — no module-scope binding exists for a
  // second createTagOnnxCapability() call (or a concurrent run() sharing a
  // capability by mistake) to contaminate.
  let _worker         = null;
  let _workerReady    = false;
  let _initPromise    = null;
  let _nextId         = 1;
  let _tagModelFailed = false;
  let _tagFailureLogged = false;
  // Map<requestId, { resolve, reject }>
  const _pending = new Map();
  // Coordinator-side dispatch queue — mirrors the worker's own internal FIFO
  // (tag-onnx-worker.js's queueTail) on THIS side of the IPC boundary. The
  // worker processes 'run' messages strictly one at a time, so if the
  // coordinator sent every request immediately and started each one's
  // per-request timeout at send time, a request queued behind an earlier one
  // would have its timeout clock run down while merely WAITING its turn, not
  // while actually being processed — a real, reproduced bug: two genuinely
  // fast (700ms) requests sent together with a 1000ms timeout caused the
  // second one to spuriously time out at ~1000ms even though the worker
  // only needed 700ms once it actually started that request (queue wait +
  // processing exceeded the timeout, even though processing alone did not).
  // Chaining dispatch through this tail ensures worker.send() — and the
  // timer that starts alongside it — only happen once it is genuinely this
  // request's turn, so the timeout measures actual round-trip time, not
  // queue wait plus round-trip time. The worker's own internal queue (see
  // tag-onnx-worker.js) is kept as a defense-in-depth backstop, not removed —
  // it still protects against any request that reaches the worker out of
  // the order this coordinator-side queue intends, e.g. after a respawn.
  let _dispatchTail = Promise.resolve();
  let _workerFactory = workerFactory;

  function onWorkerMessage(msg) {
    if (msg?.kind === 'ready') return; // handled during init

    const entry = _pending.get(msg?.requestId);
    if (!entry) return; // stale or unknown id — ignore
    _pending.delete(msg.requestId);

    if (msg.kind === 'error') {
      entry.reject(new Error(msg.error));
    } else if (msg.kind === 'done') {
      entry.resolve(msg);
    }
  }

  // Never silently falls back to in-process @huggingface/transformers — a
  // worker crash/exit disables ONNX tagging for the rest of the session (via
  // _tagModelFailed) exactly like a load failure, rather than reopening the
  // isolation boundary this module exists to close.
  function onWorkerError(err) {
    for (const { reject } of _pending.values()) reject(err);
    _pending.clear();
    _tagModelFailed = true;
  }

  function onWorkerExit(code) {
    const err = new Error(`tag-onnx worker exited unexpectedly (code ${code})`);
    for (const { reject } of _pending.values()) reject(err);
    _pending.clear();
    _workerReady = false;
    _worker      = null;
    _initPromise = null;
    // A clean exit (explicit shutdownOnnxTagWorker(), code 0) is not a
    // failure — only an unexpected exit (any other code) marks the session
    // failed. shutdownOnnxTagWorker() removes its own listeners before
    // kill(), so it never reaches this branch at all (see below); this
    // check remains as the correct behavior for a genuine crash.
    if (code !== 0) _tagModelFailed = true;
  }

  async function ensureWorker() {
    if (_workerReady) return;
    if (_initPromise) { await _initPromise; return; }

    _initPromise = (async () => {
      const cfg = resolveWorkerConfig(process.env);
      process.stderr.write(
        `[tag-onnx] starting worker (model=${cfg.modelId} threads=${cfg.numThreads} download=${cfg.allowDownload})\n`
      );
      // Captured in a local const, never re-read from the closure-level
      // _worker below: onWorkerExit() (the instance's own 'exit' listener,
      // registered on the next line) also fires on this same 'exit' event
      // and sets _worker = null — Node EventEmitters invoke every
      // registered listener, not just one, so by the time this init
      // block's own onExit/cleanup runs, _worker may already be null if
      // onWorkerExit happened to run first (the same crash
      // core/ce-rerank.js's own init handler had: "Cannot read properties
      // of null (reading 'off')" when a worker exits during its own init).
      // Using the local `worker` reference throughout this block makes
      // cleanup independent of that ordering.
      const worker = _workerFactory(cfg);
      _worker = worker;
      worker.on('message', onWorkerMessage);
      worker.on('error',   onWorkerError);
      worker.on('exit',    onWorkerExit);

      await new Promise((resolve, reject) => {
        const onReady = msg => {
          if (msg?.kind === 'error') { cleanup(); reject(new Error(msg.error)); }
          else if (msg?.kind === 'ready') { cleanup(); resolve(); }
        };
        const onErr  = err  => { cleanup(); reject(err); };
        // ANY exit before 'ready' is a failure to initialize, including code
        // 0 — a worker that exits cleanly can never post 'ready' afterward
        // (the process is gone), so treating only a non-zero code as failure
        // left a code-0 exit during init unhandled: neither resolve nor
        // reject ever fired, so ensureWorker() hung until the full 5-minute
        // TAG_ONNX_INIT_TIMEOUT_MS elapsed instead of failing immediately.
        const onExit = code => { cleanup(); reject(new Error(`tag-onnx worker exited during init (code ${code})`)); };
        const cleanup = () => {
          clearTimeout(initTimer);
          worker.off('message', onReady);
          worker.off('error',   onErr);
          worker.off('exit',    onExit);
        };
        // A worker that never posts 'ready'/'error' and never exits (stuck
        // model download, hung native load) would otherwise leave this
        // promise — and every ensureWorker() caller awaiting _initPromise —
        // pending forever. kill() drives the same onExit path above.
        const initTimer = setTimeout(() => {
          cleanup();
          try { worker.kill(); } catch { /* best effort */ }
          reject(new Error(`tag-onnx worker did not become ready within ${TAG_ONNX_INIT_TIMEOUT_MS}ms`));
        }, TAG_ONNX_INIT_TIMEOUT_MS);
        if (typeof initTimer.unref === 'function') initTimer.unref();
        worker.once('message', onReady);
        worker.once('error',   onErr);
        worker.once('exit',    onExit);
      });

      _workerReady = true;
      process.stderr.write('[tag-onnx] worker ready\n');
    })().catch(e => { _initPromise = null; throw e; });

    await _initPromise;
  }

  /**
   * Sends one tag-generation request to the worker and awaits its reply,
   * bounded by a per-request timeout so a hung/stuck worker cannot hang the
   * caller forever.
   *
   * A timeout means the worker is stuck mid-inference, not merely slow for
   * this one call — dropping only the pending map entry would let a NEW
   * request pile a second concurrent generation attempt onto the same
   * already-overloaded worker. So a timeout here kills the worker outright,
   * discards worker state, and marks the session failed directly (mirrors
   * core/ce-rerank.js's scoreViaWorker() exactly, including its own reasoning
   * for not depending on a subsequent 'exit' event).
   */
  function dispatchToWorker(requestId, payload, timeoutMs) {
    // Captured at DISPATCH time (once this request reaches the front of
    // _dispatchTail), not at call time — by the time a queued request's turn
    // comes up, an earlier request in the same queue may have already timed
    // out and killed the worker, so re-reading _worker here (rather than
    // capturing it back when runOnWorker() was first called) reflects the
    // worker's actual current state.
    const worker = _worker;
    // ensureWorker() (awaited by the caller before queuing) is async — even
    // its already-ready fast path yields one microtask tick — so a worker
    // crash/exit can land in a gap before this dispatch runs, nulling out
    // _worker. Caught here explicitly (rather than letting a bare
    // worker.send() throw "Cannot read properties of null") so the resulting
    // rejection has an actionable message; either way this rejection is
    // caught by addTagsOnnxBatch()'s own try/catch and never escapes as an
    // unhandled error.
    if (!worker) {
      return Promise.reject(new Error('tag-onnx worker is no longer available (exited or was shut down before this request could be sent)'));
    }
    return new Promise((resolveReq, rejectReq) => {
      let timer = null;
      const settle = (fn, value) => {
        if (timer) clearTimeout(timer);
        _pending.delete(requestId);
        fn(value);
      };
      _pending.set(requestId, {
        resolve: (msg) => settle(resolveReq, msg),
        reject: (err) => settle(rejectReq, err),
      });
      // Timer starts HERE — at actual dispatch, after this request's queue
      // wait has already elapsed — so timeoutMs measures real round-trip
      // time (send -> worker processes -> reply), never queue wait time.
      timer = setTimeout(() => {
        try { worker.kill(); } catch { /* best effort */ }
        if (_worker === worker) { _worker = null; _workerReady = false; _initPromise = null; }
        _tagModelFailed = true;
        const timeoutErr = new Error(`tag-onnx worker did not respond within ${timeoutMs}ms`);
        for (const [id, entry] of _pending) {
          if (id === requestId) settle(rejectReq, timeoutErr);
          else { _pending.delete(id); entry.reject(timeoutErr); }
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      worker.send({ kind: 'run', requestId, chunks: payload });
    });
  }

  /**
   * Sends one tag-generation request to the worker and awaits its reply,
   * bounded by a per-request timeout so a hung/stuck worker cannot hang the
   * caller forever.
   *
   * Requests are dispatched strictly one at a time via _dispatchTail (see its
   * own closure-level comment) — this function's returned promise resolves
   * only once THIS request has actually been sent, processed, and replied to
   * (or timed out from the moment it was actually sent), never counting time
   * spent waiting behind an earlier queued request.
   *
   * A timeout means the worker is stuck mid-inference, not merely slow for
   * this one call — dropping only the pending map entry would let a NEW
   * request pile a second concurrent generation attempt onto the same
   * already-overloaded worker. So a timeout here kills the worker outright,
   * discards worker state, and marks the session failed directly (mirrors
   * core/ce-rerank.js's scoreViaWorker() exactly, including its own reasoning
   * for not depending on a subsequent 'exit' event).
   */
  function runOnWorker(requestId, payload, timeoutMs) {
    const result = _dispatchTail.then(
      () => dispatchToWorker(requestId, payload, timeoutMs),
      () => dispatchToWorker(requestId, payload, timeoutMs), // an earlier request's rejection must not skip this one's turn
    );
    // The tail must always advance to a SETTLED (not rejected) promise, or
    // every subsequent dispatch would immediately reject without ever
    // reaching dispatchToWorker() at all — .catch(() => {}) absorbs this
    // request's own outcome for queue-advancement purposes only; the real
    // result/rejection is still returned to this function's actual caller
    // via `result` below, untouched.
    _dispatchTail = result.catch(() => {});
    return result;
  }

  /**
   * Terminates THIS instance's own tag-onnx worker child process (if
   * running) — never any other createTagOnnxCapability() instance's worker,
   * since each instance's _worker binding lives in its own closure. Call on
   * process shutdown (or, for a single-instance-per-process composition,
   * whenever that instance's owning run() completes) to avoid an open
   * child process keeping the parent alive.
   *
   * A deliberate shutdown must not look like a crash: listeners are removed
   * BEFORE kill() so onWorkerExit() — which treats any non-zero exit code as
   * unexpected and permanently sets _tagModelFailed — never fires for this
   * call. Any request still awaiting a reply is rejected explicitly, not left
   * to hang — clearing _pending without settling its entries would otherwise
   * leave that caller's promise pending forever. Safe to call when no worker
   * was ever spawned (a true no-op) and safe to call more than once
   * (idempotent — _worker is null after the first call, so a second call
   * hits the same guard).
   */
  async function shutdownOnnxTagWorker() {
    if (_worker) {
      const w = _worker;
      w.off('message', onWorkerMessage);
      w.off('error',   onWorkerError);
      w.off('exit',    onWorkerExit);
      _worker      = null;
      _workerReady = false;
      _initPromise = null;
      const err = new Error('tag-onnx worker was shut down');
      for (const { reject } of _pending.values()) reject(err);
      _pending.clear();
      await new Promise((resolveShutdown) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolveShutdown(); } };
        w.once('exit', finish);
        const graceTimer = setTimeout(finish, KILL_GRACE_MS);
        if (typeof graceTimer.unref === 'function') graceTimer.unref();
        try { w.kill(); } catch { finish(); }
      });
    }
  }

  /**
   * Returns chunks array with .tags populated. Never throws — a worker
   * spawn/load failure, crash, or timeout disables ONNX tagging for the rest
   * of the session and returns chunks with .tags: [] instead (matching
   * core/ce-rerank.js's ceRerank() "disable, don't degrade the isolation"
   * contract). Per-chunk generation failures inside a successful batch are
   * handled separately (see tag-onnx-worker.js) and still populate .tags: []
   * only for the failed chunk, not the whole batch.
   */
  async function addTagsOnnxBatch(chunks) {
    if (_tagModelFailed) return chunks.map(c => ({ ...c, tags: [] }));

    try {
      await ensureWorker();
    } catch (err) {
      _tagModelFailed = true;
      if (!_tagFailureLogged) {
        _tagFailureLogged = true;
        process.stderr.write(`[tag-onnx] worker load failed: ${err.message} — ONNX tagging disabled for this session\n`);
      }
      return chunks.map(c => ({ ...c, tags: [] }));
    }

    const requestId = _nextId++;
    const payload = chunks.map(c => ({
      text:        c.text        ?? '',
      section:     c.section     ?? '',
      source_file: c.source_file ?? '',
    }));

    let result;
    try {
      result = await runOnWorker(requestId, payload, resolveRequestTimeoutMs(process.env));
    } catch (err) {
      process.stderr.write(`[tag-onnx] worker run failed: ${err.message} — falling back to empty tags\n`);
      return chunks.map(c => ({ ...c, tags: [] }));
    }

    const tagArrays = result.tagArrays ?? [];

    return chunks.map((chunk, i) => {
      const generated = tagArrays[i] ?? [];
      const existing  = Array.isArray(chunk.meta?.tags)
        ? chunk.meta.tags
        : chunk.meta?.tags ? [chunk.meta.tags] : [];
      const tags = [...new Set([...existing, ...generated])];
      return { ...chunk, tags };
    });
  }

  return {
    addTagsOnnxBatch,
    shutdownOnnxTagWorker,
    // Test-only introspection/override, scoped to THIS instance — never a
    // module-scope seam. tests/unit/indexer/phases/tag-onnx.test.js and the
    // Step 4 architecture test both construct their own
    // createTagOnnxCapability() instance and use its own __test, never a
    // shared one.
    __test: {
      setWorkerFactory(fn) { _workerFactory = fn; },
      state: () => ({ failed: _tagModelFailed, ready: _workerReady, pendingCount: _pending.size }),
    },
  };
}
