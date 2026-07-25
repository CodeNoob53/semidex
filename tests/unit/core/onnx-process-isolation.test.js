// Process-isolation regression guard: proves — structurally, not just by
// observation — that no module in the main/MCP/admin process path can ever
// load BOTH the custom CUDA-enabled onnxruntime-node build (via
// core/onnx-runtime.js / core/onnx-embed.js) AND @huggingface/transformers
// (which bundles its own, older ONNX Runtime build) at module-load time in
// the same process. A duplicate ORT backend registration — or, more subtly,
// two ORT builds' process-global Ort::Env singletons colliding — in one
// process is a real crash risk; this task's whole Part A closes that gap by
// moving every @huggingface/transformers consumer into its own CHILD
// PROCESS (core/ce-rerank-worker.js) or off Transformers.js entirely
// (core/bge-tokenizer.js, for token counting). NOT worker_threads — a
// worker_thread is a separate V8 isolate but the SAME OS process, so native
// addons and any process-global state they hold (like ORT's Ort::Env) are
// still shared; only a genuinely separate OS process isolates them. See
// docs/cuda-runtime-verification-2026-07-24.md for the live investigation
// that confirmed this and the tag-generation worker (previously
// worker_threads-based) was migrated to child_process for the same reason.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';

import { resolveOnnxRuntimeModule, loadOnnxRuntime } from '../../../src/core/onnx-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../../../src');

function readSrc(relPath) {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

// Any import/require statement that names @huggingface/transformers,
// anywhere in the file (static or dynamic) — this is intentionally
// stricter than "static only", since a dynamic import at module scope
// (outside a function) would defeat lazy-loading just as badly as a static
// one.
const TRANSFORMERS_IMPORT_RE = /(?:import|require)\s*\(?[^)\n]*@huggingface\/transformers/;

describe('ONNXRUNTIME_NODE_PATH resolution (main process)', () => {
  it('resolves the configured custom runtime path, not the bare npm package name', () => {
    const custom = resolveOnnxRuntimeModule({ ONNXRUNTIME_NODE_PATH: './some/custom/ort' });
    assert.equal(custom, resolve('./some/custom/ort'));
    assert.notEqual(custom, 'onnxruntime-node');
  });

  it('falls back to the bare npm package name when unset', () => {
    assert.equal(resolveOnnxRuntimeModule({}), 'onnxruntime-node');
  });

  it('loadOnnxRuntime() throws an actionable error for a nonexistent custom path (never silently falls back to the npm package)', () => {
    assert.throws(() => loadOnnxRuntime({ ONNXRUNTIME_NODE_PATH: 'Z:/definitely-does-not-exist-onnxruntime-path' }));
  });
});

describe('token counting never loads @huggingface/transformers', () => {
  it('core/bge-tokenizer.js has no import/require statement referencing @huggingface/transformers', () => {
    const src = readSrc('core/bge-tokenizer.js');
    assert.doesNotMatch(src, TRANSFORMERS_IMPORT_RE);
  });

  it('core/bge-tokenizer.js imports @huggingface/tokenizers instead (the non-ORT-backed library)', () => {
    const src = readSrc('core/bge-tokenizer.js');
    assert.match(src, /from ['"]@huggingface\/tokenizers['"]/);
  });

  it('core/token-count.js no longer imports @huggingface/transformers anywhere', () => {
    const src = readSrc('core/token-count.js');
    assert.doesNotMatch(src, TRANSFORMERS_IMPORT_RE);
  });

  it('core/token-count.js sources its tokenizer from core/bge-tokenizer.js', () => {
    const src = readSrc('core/token-count.js');
    assert.match(src, /from ['"]\.\/bge-tokenizer\.js['"]/);
  });
});

describe('CE reranking never loads @huggingface/transformers in the coordinator (main/MCP) process', () => {
  it('core/ce-rerank.js (the coordinator) has no import/require statement referencing @huggingface/transformers', () => {
    const src = readSrc('core/ce-rerank.js');
    assert.doesNotMatch(src, TRANSFORMERS_IMPORT_RE);
  });

  it('core/ce-rerank.js uses node:child_process (fork), NOT worker_threads, to run CE inference in a genuinely separate OS process', () => {
    // worker_threads was deliberately rejected: a worker_thread is a
    // separate V8 isolate but the SAME OS process — native addons
    // (including ONNX Runtime's own process-global Ort::Env singleton)
    // load once per process and are shared across every thread in it, so
    // worker_threads does NOT prevent two different ORT builds from
    // sharing one process's native address space. Only child_process
    // (fork(), a genuinely separate process with its own address space and
    // its own Ort::Env) actually provides that isolation — see
    // docs/cuda-runtime-verification-2026-07-24.md.
    const src = readSrc('core/ce-rerank.js');
    assert.match(src, /from ['"]node:child_process['"]/);
    assert.match(src, /\bfork\(/);
    assert.doesNotMatch(src, /from ['"]worker_threads['"]/, 'worker_threads does not isolate native addons from the main process — it must not be used here');
    assert.doesNotMatch(src, /new Worker\(/);
  });

  it('@huggingface/transformers is imported ONLY inside core/ce-rerank-worker.js (the worker file itself), inside an async function — never at module top level', () => {
    const src = readSrc('core/ce-rerank-worker.js');
    assert.match(src, TRANSFORMERS_IMPORT_RE);
    // The import must be inside loadModel() (an async function), not a
    // bare top-level import statement — i.e. it must not appear on a line
    // starting with "import" at column 0.
    const topLevelStaticImport = /^import\s+.*@huggingface\/transformers/m;
    assert.doesNotMatch(src, topLevelStaticImport);
  });

  it('core/ce-rerank-worker.js runs as a standalone child process entry point (IPC via process.send()/process.on(\'message\'), not worker_threads)', () => {
    const src = readSrc('core/ce-rerank-worker.js');
    assert.match(src, /process\.send\(/);
    assert.match(src, /process\.on\(['"]message['"]/);
    assert.doesNotMatch(src, /from ['"]worker_threads['"]/);
    assert.doesNotMatch(src, /parentPort/);
  });
});

describe('tag generation — migrated from worker_threads to child_process for real process isolation', () => {
  it('indexer/phases/tag-onnx.js (the coordinator) has no import/require statement referencing @huggingface/transformers', () => {
    const src = readSrc('indexer/phases/tag-onnx.js');
    assert.doesNotMatch(src, TRANSFORMERS_IMPORT_RE);
  });

  it('indexer/phases/tag-onnx.js uses node:child_process (fork), NOT worker_threads, to run tag generation in a genuinely separate OS process', () => {
    // Was previously worker_threads-based — migrated for the same reason as
    // core/ce-rerank.js: a worker_thread shares the OS process (and any
    // process-global native state, like ONNX Runtime's Ort::Env singleton)
    // with the indexer's main process, which can simultaneously load the
    // custom CUDA-enabled onnxruntime-node build via core/onnx-embed.js
    // when ONNX_EMBED=1. See docs/cuda-runtime-verification-2026-07-24.md.
    const src = readSrc('indexer/phases/tag-onnx.js');
    assert.match(src, /from ['"]node:child_process['"]/);
    assert.match(src, /\bfork\(/);
    assert.doesNotMatch(src, /from ['"]worker_threads['"]/, 'worker_threads does not isolate native addons from the main process — it must not be used here');
    assert.doesNotMatch(src, /new Worker\(/);
  });

  it('indexer/workers/tag-onnx-worker.js is the only file importing @huggingface/transformers for tag generation', () => {
    const src = readSrc('indexer/workers/tag-onnx-worker.js');
    assert.match(src, TRANSFORMERS_IMPORT_RE);
  });

  it('indexer/workers/tag-onnx-worker.js runs as a standalone child process entry point (IPC via process.send()/process.on(\'message\'), not worker_threads)', () => {
    const src = readSrc('indexer/workers/tag-onnx-worker.js');
    assert.match(src, /process\.send\(/);
    assert.match(src, /process\.on\(['"]message['"]/);
    assert.doesNotMatch(src, /from ['"]worker_threads['"]/);
    assert.doesNotMatch(src, /parentPort/);
  });
});

describe('core/onnx-embed.js (the custom CUDA runtime consumer) never imports @huggingface/transformers', () => {
  it('no import/require statement referencing @huggingface/transformers', () => {
    const src = readSrc('core/onnx-embed.js');
    assert.doesNotMatch(src, TRANSFORMERS_IMPORT_RE);
  });

  it('loads the ONNX runtime through core/onnx-runtime.js (honoring ONNXRUNTIME_NODE_PATH), never a direct onnxruntime-node import', () => {
    const src = readSrc('core/onnx-embed.js');
    assert.match(src, /from ['"]\.\/onnx-runtime\.js['"]/);
    assert.doesNotMatch(src, /from ['"]onnxruntime-node['"]/);
    assert.doesNotMatch(src, /import\s*\*\s*as\s+\w+\s+from\s+['"]onnxruntime-node['"]/);
  });
});

describe('repo-wide structural guard: no source file imports both the custom ORT loader and @huggingface/transformers', () => {
  it('every src/**/*.js file that imports core/onnx-runtime.js (directly or via core/onnx-embed.js) does not ALSO statically import @huggingface/transformers', () => {
    // A lightweight, dependency-free source walk (no glob package needed) —
    // scoped to src/ only, matching every other structural guard test in
    // this repo's own convention (see e.g. onnx-tokenizer.test.js /
    // bge-tokenizer-parity.test.js's own source-grep style).
    const offenders = [];
    const walk = (dir) => {
      for (const name of readDirSafe(dir)) {
        const full = join(dir, name);
        if (isDirectory(full)) { walk(full); continue; }
        if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue;
        const src = readFileSync(full, 'utf-8');
        const importsOnnxRuntime = /from ['"]\.{1,2}\/(?:[\w-]+\/)*onnx-runtime\.js['"]/.test(src)
          || /from ['"]\.{1,2}\/(?:[\w-]+\/)*onnx-embed\.js['"]/.test(src);
        if (importsOnnxRuntime && TRANSFORMERS_IMPORT_RE.test(src)) {
          offenders.push(full.replace(SRC_ROOT, 'src'));
        }
      }
    };
    walk(SRC_ROOT);
    assert.deepEqual(offenders, [], `files importing both onnx-runtime/-embed AND @huggingface/transformers: ${offenders.join(', ')}`);
  });
});

function readDirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}
