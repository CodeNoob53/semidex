// ONNX tag generation phase.
// Spawns a persistent worker thread (tag-onnx-worker.js) on first call and
// keeps it alive for the duration of the indexer process.
//
// Request/response are matched by a monotonic requestId so concurrent callers
// (OLLAMA_STAGE_CONCURRENCY > 1) each get their own reply without racing.
//
// Exports:
//   isOnnxTagProvider(env?)  — true when TAG_PROVIDER=onnx
//   addTagsOnnxBatch(chunks) — returns chunks with .tags populated

import { Worker } from 'worker_threads';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, '../workers/tag-onnx-worker.js');

export function isOnnxTagProvider(env = process.env) {
  return env.TAG_PROVIDER === 'onnx';
}

// ── Worker singleton + request queue ─────────────────────────────────────────

let _worker      = null;
let _workerReady = false;
let _initPromise = null;
let _nextId      = 1;
// Map<requestId, { resolve, reject }>
const _pending   = new Map();

function resolveWorkerConfig(env = process.env) {
  const ROOT = join(__dirname, '../../../');
  return {
    modelId:       env.TAG_ONNX_MODEL   || 'onnx-community/Qwen2.5-Coder-1.5B-Instruct',
    cacheDir:      join(ROOT, 'models', 'transformers-cache'),
    numThreads:    Math.max(1, parseInt(env.TAG_ONNX_THREADS || '1', 10) || 1),
    allowDownload: env.TAG_ONNX_ALLOW_DOWNLOAD === '1',
  };
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

function onWorkerError(err) {
  // Reject all pending requests — worker is broken.
  for (const { reject } of _pending.values()) reject(err);
  _pending.clear();
}

function onWorkerExit(code) {
  const err = new Error(`tag-onnx worker exited unexpectedly (code ${code})`);
  for (const { reject } of _pending.values()) reject(err);
  _pending.clear();
  _workerReady = false;
  _worker      = null;
  _initPromise = null;
}

async function ensureWorker() {
  if (_workerReady) return;
  if (_initPromise) { await _initPromise; return; }

  _initPromise = (async () => {
    const cfg = resolveWorkerConfig(process.env);
    process.stderr.write(
      `[tag-onnx] starting worker (model=${cfg.modelId} threads=${cfg.numThreads} download=${cfg.allowDownload})\n`
    );
    _worker = new Worker(WORKER_PATH, { workerData: cfg, execArgv: [] });
    _worker.on('message', onWorkerMessage);
    _worker.on('error',   onWorkerError);
    _worker.on('exit',    onWorkerExit);

    // Wait for the initial ready message.
    await new Promise((resolve, reject) => {
      const onReady = msg => {
        if (msg?.kind === 'error') { cleanup(); reject(new Error(msg.error)); }
        else if (msg?.kind === 'ready') { cleanup(); resolve(); }
      };
      const onErr  = err  => { cleanup(); reject(err); };
      const onExit = code => {
        if (code !== 0) { cleanup(); reject(new Error(`tag-onnx worker exited during init (code ${code})`)); }
      };
      const cleanup = () => {
        _worker.off('message', onReady);
        _worker.off('error',   onErr);
        _worker.off('exit',    onExit);
      };
      _worker.once('message', onReady);
      _worker.once('error',   onErr);
      _worker.once('exit',    onExit);
    });

    _workerReady = true;
    process.stderr.write('[tag-onnx] worker ready\n');
  })().catch(e => { _initPromise = null; throw e; });

  await _initPromise;
}

// Terminate the worker — called on process exit to avoid open handles.
export async function shutdownOnnxTagWorker() {
  if (_worker) {
    await _worker.terminate();
    _worker      = null;
    _workerReady = false;
    _initPromise = null;
    _pending.clear();
  }
}

// ── Main API ──────────────────────────────────────────────────────────────────

// Returns chunks array with .tags populated ([] on worker failure; never throws
// for individual chunk errors — per-chunk failures are logged to stderr).
export async function addTagsOnnxBatch(chunks) {
  await ensureWorker();

  const requestId = _nextId++;
  const payload = chunks.map(c => ({
    text:        c.text        ?? '',
    section:     c.section     ?? '',
    source_file: c.source_file ?? '',
  }));

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      _pending.set(requestId, { resolve, reject });
      _worker.postMessage({ kind: 'run', requestId, chunks: payload });
    });
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
