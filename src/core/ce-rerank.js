// Cross-encoder reranker — production integration of the benchmark-validated
// CE path (docs/en/ce-rerank-design.md). Opt-in via RERANK_CE_ENABLED=1.
//
// Model: cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 (multilingual, ~120 MB).
// Gate results (custom-50, 2026-05-15): MRR@10 0.760 vs hybrid 0.665,
// chunkRecall@5 95.9%, zero regressions — but ~3.5 s p50 on CPU for 40
// candidates. Interactive use requires GPU (RERANK_CE_DEVICE=dml) or an
// explicit latency acceptance. See design §6.
//
// Process isolation: all actual @huggingface/transformers inference runs in
// a persistent CHILD PROCESS (ce-rerank-worker.js, spawned via
// node:child_process's fork() — NOT worker_threads), never in this
// (main/MCP) process. This module is the coordinator: it lazily spawns the
// child on first use, keeps it alive afterward, and exchanges requests/
// responses over IPC (child.send()/child.on('message')) using a
// requestId-keyed protocol. Transformers.js bundles its own ONNX Runtime
// build, which must never share a process with the custom CUDA-enabled
// onnxruntime-node build core/onnx-embed.js loads for embedding — that is
// the entire reason this module no longer calls @huggingface/transformers
// directly.
//
// worker_threads was tried first and rejected after live testing: a
// worker_thread is a separate V8 isolate but the SAME OS process — native
// addons (including ONNX Runtime's own process-global Ort::Env singleton)
// load once per process and are shared across every thread in it. Two
// different ORT builds in one process's native address space is exactly
// the conflict this isolation exists to prevent, and worker_threads does
// not provide that boundary; only a genuinely separate OS process does.
//
// Design contracts implemented here:
//   - Lazy, promise-guarded worker spawn; no work at import time (§3).
//   - ceRerank never throws: load/worker failure disables CE for the
//     session and returns pre-CE candidates (§5 "Model load failure").
//     The worker is never silently replaced by an in-process fallback —
//     on failure, CE is disabled outright, matching the design's own
//     "disable, don't degrade the isolation" contract.
//   - Busy flag: one CE inference in flight at a time; concurrent queries
//     skip CE and return pre-CE results (§5 "Compute cancellation caveat").
//   - Timeout is the CALLER's job via withCETimeout() (§5) for the overall
//     call; a SEPARATE, shorter per-request worker-round-trip timeout
//     (bounded by RERANK_CE_TIMEOUT_MS) guards against a hung/crashed
//     worker never replying at all.
//   - Passage construction ports the exact benchmark-validated format from
//     benchmarks/retrieval/custom-50/cross-encoder-bench.js (gate parity) —
//     duplicated in the worker file (see ce-rerank-worker.js) since this
//     coordinator must never import anything that could pull in
//     onnxruntime-node.
//
// Test hooks (__test) allow smoke tests and unit tests to inject a stub
// worker factory (an EventEmitter-shaped fake, never a real child process)
// so CE behavior — scoring, timeout, load failure, numLabels rejection,
// busy-skip — can be exercised without any network access or real model
// load (src/smoke/sections/41-ce-rerank-stub.js,
// tests/unit/core/ce-rerank.test.js).

import { fork } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'ce-rerank-worker.js');

// ── Env knobs (design §2) ─────────────────────────────────────────────────────

function envInt(name, defaultVal, min, max) {
  const v = parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      process.stderr.write(`[ce-rerank] ${name}="${process.env[name]}" is invalid — using default ${defaultVal}\n`);
    return defaultVal;
  }
  return v;
}

function envEnum(name, defaultVal, allowed) {
  const v = process.env[name];
  if (v === undefined) return defaultVal;
  if (!allowed.includes(v)) {
    process.stderr.write(`[ce-rerank] ${name}="${v}" is invalid — using default ${defaultVal}\n`);
    return defaultVal;
  }
  return v;
}

// RERANK_CE_MODEL/RERANK_CE_DEVICE/RERANK_CE_CACHE_DIR are next_restart
// settings (core/settings/definitions.js): read once, at process startup,
// via a SettingsService — see applyCeRerankSettings() below. `let` (not
// const) so it can re-resolve them from a SettingsService before the first
// real worker spawn.
let RERANK_CE_MODEL      = process.env.RERANK_CE_MODEL || 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1';
let RERANK_CE_DEVICE     = envEnum('RERANK_CE_DEVICE', 'cpu', ['cpu', 'dml', 'cuda']);
let RERANK_CE_CACHE_DIR  = process.env.RERANK_CE_CACHE_DIR || './models';
export const RERANK_CE_INPUT      = envEnum('RERANK_CE_INPUT', 'text+meta', ['text', 'text+section', 'text+meta']);
export const RERANK_CE_TOP_N      = envInt('RERANK_CE_TOP_N', 40, 1, 500);
export const RERANK_CE_TIMEOUT_MS = envInt('RERANK_CE_TIMEOUT_MS', 10000, 100, 120000);
export const RERANK_CE_BATCH_SIZE = envInt('RERANK_CE_BATCH_SIZE', 16, 1, 256);
const DEBUG = process.env.RERANK_CE_DEBUG === '1';

// Model LOAD timeout (worker startup, including a possible first-time model
// download) — deliberately separate from and much longer than
// RERANK_CE_TIMEOUT_MS (a per-request inference round-trip cap, max 120s).
// Not user-configurable: this bounds a one-time startup step against
// hanging forever, not a tunable performance knob.
const CE_WORKER_INIT_TIMEOUT_MS = 5 * 60 * 1000;

export { RERANK_CE_MODEL, RERANK_CE_DEVICE, RERANK_CE_CACHE_DIR };

/**
 * Re-resolves RERANK_CE_MODEL/RERANK_CE_DEVICE/RERANK_CE_CACHE_DIR from a
 * SettingsService. Must be called BEFORE the first loadCEModel() call for
 * the new values to take effect — once the worker is spawned, these are
 * fixed for the worker's lifetime (passed as env vars only at fork()),
 * matching their next_restart classification exactly. Real entry points
 * (MCP server's warmup branch, admin bootstrap) call this once, right
 * after constructing their SettingsService.
 * @param {Object} settingsService
 */
export function applyCeRerankSettings(settingsService) {
  RERANK_CE_MODEL = settingsService.getActiveValue('RERANK_CE_MODEL');
  RERANK_CE_DEVICE = settingsService.getActiveValue('RERANK_CE_DEVICE');
  RERANK_CE_CACHE_DIR = settingsService.getActiveValue('RERANK_CE_CACHE_DIR');
}

function debug(msg) {
  if (DEBUG) process.stderr.write(`[ce-rerank] ${msg}\n`);
}

/**
 * Resolves the per-call CE config (input format, top-N cap, timeout,
 * batch size) — falls back to this module's own env-derived exports
 * unchanged when no settingsService is supplied.
 * @param {{ settingsService?: Object }} [opts]
 */
export function getCeRerankConfig({ settingsService } = {}) {
  if (!settingsService) {
    return { input: RERANK_CE_INPUT, topN: RERANK_CE_TOP_N, timeoutMs: RERANK_CE_TIMEOUT_MS, batchSize: RERANK_CE_BATCH_SIZE };
  }
  return {
    input: settingsService.getActiveValue('RERANK_CE_INPUT'),
    topN: settingsService.getActiveValue('RERANK_CE_TOP_N'),
    timeoutMs: settingsService.getActiveValue('RERANK_CE_TIMEOUT_MS'),
    batchSize: settingsService.getActiveValue('RERANK_CE_BATCH_SIZE'),
  };
}

// ── Passage construction (exact port of the benchmark-validated format) ──────
// Duplicated in ce-rerank-worker.js (the worker never imports THIS file, to
// keep the child process's own module graph free of anything this
// coordinator imports) — both copies are covered by tests/unit's passage
// tests.

export function buildPassage(payload, inputMode = RERANK_CE_INPUT) {
  const p = payload ?? {};
  if (inputMode === 'text+section') return `${p.section ?? ''}\n${p.text ?? ''}`;
  if (inputMode === 'text+meta')    return `${p.source_file ?? ''} ${p.section ?? ''}\n${p.text ?? ''}`;
  return p.text ?? '';
}

// ── Worker singleton + request queue (mirrors indexer/phases/tag-onnx.js) ────

let _worker        = null;
let _workerReady   = false;
let _workerNumLabels = null;
let _initPromise   = null;
let _nextId        = 1;
let _ceModelFailed = false;
let _ceFailureLogged = false;
let _ceInFlight     = false;
// Map<requestId, { resolve, reject }>
const _pending = new Map();

// Overridable worker factory — replaced by tests via __test.setWorkerFactory.
// Must return an object shaped like a node:child_process ChildProcess:
// .send(msg), .on(event, fn), .off(event, fn), .once(event, fn), .kill().
// Config travels via environment variables (never IPC, never CLI args —
// same convention core/onnx-provider-probe.js uses) since the model/device/
// cacheDir are next_restart settings that never change for this child
// process's lifetime.
let _workerFactory = (cfg) => fork(WORKER_PATH, [], {
  windowsHide: true,
  env: { ...process.env, CE_WORKER_MODEL: cfg.model, CE_WORKER_DEVICE: cfg.device, CE_WORKER_CACHE_DIR: cfg.cacheDir },
});

function resolveWorkerConfig() {
  return { model: RERANK_CE_MODEL, device: RERANK_CE_DEVICE, cacheDir: RERANK_CE_CACHE_DIR };
}

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

// Never silently falls back to in-process Transformers.js — a worker
// crash/exit disables CE for the rest of the session (via _ceModelFailed)
// exactly like a load failure, rather than reopening the isolation boundary
// this module exists to close.
function onWorkerError(err) {
  for (const { reject } of _pending.values()) reject(err);
  _pending.clear();
  _ceModelFailed = true;
}

function onWorkerExit(code) {
  const err = new Error(`ce-rerank worker exited unexpectedly (code ${code})`);
  for (const { reject } of _pending.values()) reject(err);
  _pending.clear();
  _workerReady = false;
  _worker      = null;
  _initPromise = null;
  // A clean exit (explicit shutdownCEWorker(), code 0) is not a failure —
  // only an unexpected exit (any other code) marks the session failed.
  // shutdownCEWorker() never sets _ceModelFailed itself, so a deliberate
  // shutdown followed by a fresh ensureWorker() call can still respawn
  // cleanly.
  if (code !== 0) _ceModelFailed = true;
}

async function ensureWorker() {
  if (_workerReady) return;
  if (_initPromise) { await _initPromise; return; }

  _initPromise = (async () => {
    const cfg = resolveWorkerConfig();
    process.stderr.write(`[ce-rerank] starting worker (model=${cfg.model} device=${cfg.device})...\n`);
    // Captured in a local const, never re-read from the module-level
    // _worker below: onWorkerExit() (the GLOBAL 'exit' listener, registered
    // on the next line) also fires on this same 'exit' event and sets
    // _worker = null — Node EventEmitters invoke every registered listener,
    // not just one, so by the time this init block's own onExit/cleanup
    // runs, _worker may already be null if onWorkerExit happened to run
    // first (a real, reproducible crash: "Cannot read properties of null
    // (reading 'off')" when a worker exits during its own init). Using the
    // local `worker` reference throughout this block makes cleanup
    // independent of that ordering.
    const worker = _workerFactory(cfg);
    _worker = worker;
    worker.on('message', onWorkerMessage);
    worker.on('error',   onWorkerError);
    worker.on('exit',    onWorkerExit);

    await new Promise((resolveInit, rejectInit) => {
      const onReady = (msg) => {
        if (msg?.kind === 'error') { cleanup(); rejectInit(new Error(msg.error)); }
        else if (msg?.kind === 'ready') { cleanup(); _workerNumLabels = msg.numLabels ?? null; resolveInit(); }
      };
      const onErr  = (err)  => { cleanup(); rejectInit(err); };
      // ANY exit before 'ready' is a failure to initialize, including code
      // 0 — a worker that exits cleanly can never post 'ready' afterward
      // (the process is gone), so treating only a non-zero code as failure
      // left a code-0 exit during init unhandled: neither resolve nor
      // reject ever fired, so ensureWorker() hung until the full 5-minute
      // CE_WORKER_INIT_TIMEOUT_MS elapsed instead of failing immediately.
      const onExit = (code) => { cleanup(); rejectInit(new Error(`ce-rerank worker exited during init (code ${code})`)); };
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
        rejectInit(new Error(`ce-rerank worker did not become ready within ${CE_WORKER_INIT_TIMEOUT_MS}ms`));
      }, CE_WORKER_INIT_TIMEOUT_MS);
      if (typeof initTimer.unref === 'function') initTimer.unref();
      worker.once('message', onReady);
      worker.once('error',   onErr);
      worker.once('exit',    onExit);
    });

    _workerReady = true;
    process.stderr.write('[ce-rerank] worker ready\n');
  })().catch((e) => { _initPromise = null; throw e; });

  await _initPromise;
}

/**
 * Sends one scoring request to the worker and awaits its reply, bounded by
 * a per-request timeout (RERANK_CE_TIMEOUT_MS by default) so a hung/crashed
 * worker that never replies cannot hang the caller forever — separate from
 * withCETimeout()'s own caller-facing overall-call timeout.
 *
 * A timeout means the worker is stuck mid-inference, not merely slow for
 * this one call — dropping only the pending map entry (the previous
 * behavior) would let _ceInFlight clear and a NEW request pile a second
 * concurrent inference onto the same already-overloaded worker (the exact
 * OOM risk this guard exists to prevent). So a timeout here:
 *   1. Kills the worker outright (kill() is synchronous and best-effort —
 *      a worker that ALSO ignores it cannot extend this timeout).
 *   2. Discards the current _worker/_workerReady state and marks the
 *      session failed directly, rather than relying on a subsequent
 *      'exit' event to do it — a real child process always fires 'exit'
 *      after kill(), but this must not depend on that, because a worker
 *      (real or otherwise) that fails to report its own exit would
 *      otherwise leave this promise unsettled forever.
 *   3. Rejects this request directly. If 'exit' does fire afterward,
 *      onWorkerExit() will find _pending already empty and _worker already
 *      null — a harmless no-op, not a second rejection (the promise is
 *      already settled).
 */
async function scoreViaWorker(query, candidates, { input, batchSize, timeoutMs }) {
  const requestId = _nextId++;
  const worker = _worker;
  // loadCEModel()/ensureWorker() are async — even the already-ready fast
  // path yields one microtask tick before the caller resumes — so a worker
  // crash/exit can theoretically land in that gap, nulling out _worker
  // before this function's own worker.send() call below. Caught here
  // explicitly (rather than letting a bare worker.send() throw "Cannot
  // read properties of null") so the resulting rejection has an actionable
  // message; either way it's caught by ceRerank()'s own try/catch and
  // never escapes as an unhandled error.
  if (!worker) {
    throw new Error('ce-rerank worker is no longer available (exited or was shut down before this request could be sent)');
  }
  return new Promise((resolveReq, rejectReq) => {
    let timer = null;
    const settle = (fn, value) => {
      if (timer) clearTimeout(timer);
      _pending.delete(requestId);
      fn(value);
    };
    _pending.set(requestId, {
      resolve: (msg) => settle(resolveReq, msg.scores),
      reject: (err) => settle(rejectReq, err),
    });
    timer = setTimeout(() => {
      try { worker.kill(); } catch { /* best effort */ }
      if (_worker === worker) { _worker = null; _workerReady = false; _initPromise = null; }
      _ceModelFailed = true;
      const timeoutErr = new Error(`ce-rerank worker did not respond within ${timeoutMs}ms`);
      // In normal use _ceInFlight guarantees only this one request is ever
      // pending on a given worker — but reject any other stale entries too
      // (defensive; costs nothing when _pending is already just this one).
      for (const [id, entry] of _pending) {
        if (id === requestId) settle(rejectReq, timeoutErr);
        else { _pending.delete(id); entry.reject(timeoutErr); }
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    _worker.send({ kind: 'run', requestId, query, candidates, input, batchSize });
  });
}

/**
 * Ensures the CE worker is spawned and ready. Idempotent and
 * promise-guarded: concurrent callers share one spawn; a settled ready
 * worker returns immediately.
 * Throws on failure (worker crash, model load failure inside the worker)
 * — and marks the session failed so subsequent calls do not retry.
 * ceRerank() catches this internally; warmup callers must handle the throw.
 */
export async function loadCEModel() {
  if (_workerReady) return;
  if (_ceModelFailed) throw new Error('CE worker previously failed to load — disabled for this session');
  try {
    await ensureWorker();
  } catch (err) {
    _ceModelFailed = true;
    throw err;
  }
}

/**
 * Terminates the CE worker child process (if running) — call on process
 * shutdown to avoid an open child process keeping the parent alive.
 *
 * A deliberate shutdown must not look like a crash: listeners are removed
 * BEFORE kill() so onWorkerExit() — which treats any non-zero exit code as
 * unexpected and permanently sets _ceModelFailed — never fires for this
 * call. (A killed child process's exit code is signal-dependent and not
 * reliably 0, so relying on onWorkerExit()'s own code-0-is-clean check here
 * would incorrectly disable CE for the rest of the session after every
 * deliberate shutdown.) Any request still awaiting a reply is rejected
 * explicitly, not left to hang — clearing _pending without settling its
 * entries would otherwise leave that caller's promise pending forever.
 *
 * kill() itself is synchronous and does not wait for the process to
 * actually exit (unlike worker_threads' terminate(), which returned a
 * Promise) — a bounded wait for the real 'exit' event follows, so this
 * still resolves only once the child is confirmed gone, or after a grace
 * period if it ignores the signal entirely (mirrors
 * core/onnx-provider-probe.js's own kill-then-wait pattern).
 */
const SHUTDOWN_KILL_GRACE_MS = 3_000;

export async function shutdownCEWorker() {
  if (_worker) {
    const w = _worker;
    w.off('message', onWorkerMessage);
    w.off('error',   onWorkerError);
    w.off('exit',    onWorkerExit);
    _worker = null;
    _workerReady = false;
    _initPromise = null;
    const err = new Error('ce-rerank worker was shut down');
    for (const { reject } of _pending.values()) reject(err);
    _pending.clear();
    await new Promise((resolveShutdown) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolveShutdown(); } };
      w.once('exit', finish);
      const graceTimer = setTimeout(finish, SHUTDOWN_KILL_GRACE_MS);
      if (typeof graceTimer.unref === 'function') graceTimer.unref();
      try { w.kill(); } catch { finish(); }
    });
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Score and reorder candidates using cross-encoder logits computed in the
 * persistent CE worker thread.
 * Returns candidates sliced to finalLimit, sorted by CE score descending,
 * with `.score` replaced by the CE logit.
 *
 * Never throws:
 *   - empty input → []
 *   - worker spawn/load failure → pre-CE candidates, CE disabled for the
 *     session (never falls back to loading Transformers.js in-process)
 *   - another CE call in flight → pre-CE candidates (busy skip)
 *   - a single request that the worker doesn't answer within
 *     RERANK_CE_TIMEOUT_MS → pre-CE candidates for that call only (the
 *     worker itself is not necessarily dead — see onWorkerError/onWorkerExit
 *     for what actually disables the session)
 *
 * No internal deadline for the OVERALL call — callers wanting an overall
 * timeout use withCETimeout(); this function's own per-request worker
 * round-trip timeout is a narrower, worker-hang-specific safety net.
 *
 * @param {Array}  candidates — hybrid/det-rerank results (with .payload)
 * @param {string} query
 * @param {{ finalLimit?: number }} opts
 * @param {{ settingsService?: Object }} [depsOpts] — see getCeRerankConfig()
 */
export async function ceRerank(candidates, query, { finalLimit } = {}, { settingsService } = {}) {
  const limit = finalLimit ?? candidates.length;
  const { input, topN, batchSize, timeoutMs } = getCeRerankConfig({ settingsService });

  if (!candidates.length) {
    debug('empty candidate pool — skipping CE inference');
    return [];
  }
  if (_ceModelFailed) return candidates.slice(0, limit);

  if (_ceInFlight) {
    process.stderr.write('[ce-rerank] busy — skipping CE for this query\n');
    return candidates.slice(0, limit);
  }

  _ceInFlight = true;
  try {
    try {
      await loadCEModel();
    } catch (err) {
      if (!_ceFailureLogged) {
        _ceFailureLogged = true;
        process.stderr.write(`[ce-rerank] worker load failed: ${err.message} — CE disabled for this session\n`);
      }
      return candidates.slice(0, limit);
    }

    let pool = candidates;
    if (pool.length > topN) {
      debug(`truncated pool from ${pool.length} to ${topN} candidates (RERANK_CE_TOP_N cap)`);
      pool = pool.slice(0, topN);
    }
    if (pool.length < limit) {
      debug(`pool size ${pool.length} < top=${limit} — returning all scored candidates`);
    }

    let scores;
    try {
      scores = await scoreViaWorker(query, pool, { input, batchSize, timeoutMs: timeoutMs ?? RERANK_CE_TIMEOUT_MS });
    } catch (err) {
      process.stderr.write(`[ce-rerank] worker request failed: ${err.message} — returning pre-CE results for this call\n`);
      return candidates.slice(0, limit);
    }
    if (DEBUG) {
      pool.forEach((r, i) => debug(
        `${r.payload?.source_file}#${r.payload?.chunk_index}  ce=${scores[i].toFixed(4)}`));
    }

    return pool
      .map((r, i) => ({ ...r, score: scores[i] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } finally {
    _ceInFlight = false;
  }
}

/**
 * Response-fallback timeout wrapper (design §5). Races `promise` against a
 * deadline; on expiry returns `fallback()` instead. The in-flight inference
 * is NOT cancelled (no mechanism in JS) — the busy flag in ceRerank prevents
 * pile-up while it drains.
 *
 * @param {Promise} promise
 * @param {number} ms
 * @param {() => any} fallback — invoked only on timeout
 * @param {{ label?: string }} [opts] — label for the timeout log line
 */
export async function withCETimeout(promise, ms, fallback, { label = 'ce-rerank' } = {}) {
  let timer;
  const sentinel = new Promise(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout('__ce_timeout__'), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const winner = await Promise.race([promise, sentinel]);
    if (winner === '__ce_timeout__') {
      const fb = fallback();
      process.stderr.write(`[${label}] timeout after ${ms}ms — returning pre-CE results (${fb?.length ?? 0} candidates)\n`);
      return fb;
    }
    return winner;
  } finally {
    clearTimeout(timer);
  }
}

// ── Test hooks — smoke/unit tests only, never used by production code ────────

export const __test = {
  reset() {
    _worker = null; _workerReady = false; _workerNumLabels = null;
    _initPromise = null; _nextId = 1;
    _ceModelFailed = false; _ceFailureLogged = false; _ceInFlight = false;
    _pending.clear();
    _workerFactory = (cfg) => fork(WORKER_PATH, [], {
      windowsHide: true,
      env: { ...process.env, CE_WORKER_MODEL: cfg.model, CE_WORKER_DEVICE: cfg.device, CE_WORKER_CACHE_DIR: cfg.cacheDir },
    });
  },
  // Injects a fake worker factory — tests supply an EventEmitter-shaped
  // stub (never a real child process) implementing .send/.on/.off/.once/
  // .kill, exercising the exact same message protocol the real worker uses
  // (see ce-rerank-worker.js's own module header).
  setWorkerFactory(fn) { _workerFactory = fn; },
  state: () => ({ failed: _ceModelFailed, ready: _workerReady, numLabels: _workerNumLabels, pendingCount: _pending.size }),
};
