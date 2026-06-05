// ONNX worker/thread budget benchmark.
// Measures whether BGE-M3 embed and Qwen2.5-0.5B-Instruct tag-gen can overlap
// on CPU threads without destructive slowdown.
//
// Usage:
//   node benchmarks/onnx-worker-budget-bench.js
//   EMBED_THREADS=2 TAG_THREADS=2 node benchmarks/onnx-worker-budget-bench.js
//
// Output: markdown report in benchmarks/retrieval/results/<timestamp>-onnx-worker-budget-bench.md
// Verdict: ONNX_WORKER_OVERLAP_ACCEPT | ONNX_WORKER_OVERLAP_NEEDS_TUNING | ONNX_WORKER_OVERLAP_REJECT

import 'dotenv/config';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL_FILE      = join(ROOT, 'models', 'bge-m3-onnx', 'model.onnx');
const DATA_FILE       = join(ROOT, 'models', 'bge-m3-onnx', 'model.onnx.data');
const BGE_TOKENIZER    = join(ROOT, 'models', 'aapot', 'bge-m3-onnx', 'tokenizer.json');
const QWEN_MODEL_FILE  = join(ROOT, 'models', 'transformers-cache', 'onnx-community', 'Qwen2.5-0.5B-Instruct', 'onnx', 'model_q4.onnx');
const BGE_MODEL_ID    = 'aapot/bge-m3-onnx';
const QWEN_MODEL_ID   = 'onnx-community/Qwen2.5-0.5B-Instruct';
const RESULTS_DIR     = join(ROOT, 'benchmarks', 'retrieval', 'results');

const EMBED_TEXTS = [
  'What is a vector database?',
  'How does hybrid search work?',
  'Explain RRF fusion in one sentence.',
  'What is sparse embedding?',
  'Define context window.',
  'What is BGE-M3?',
  'How does semidex index PDFs?',
  'What is PRUNE_STALE?',
  'Explain the difference between dense and sparse embeddings and when each is more useful.',
  'How does contextual retrieval improve embedding quality for isolated code snippets?',
];

const TAG_PROMPTS = [
  'Extract 3-5 tags for: "vector database Qdrant hybrid search dense sparse"',
  'Extract 3-5 tags for: "BGE-M3 ONNX embedding multilingual token weighting"',
  'Extract 3-5 tags for: "pipeline concurrency semaphore serial queue stages"',
  'Extract 3-5 tags for: "RAG retrieval augmented generation chunking context"',
  'Extract 3-5 tags for: "Node.js worker threads CPU parallelism benchmark"',
];

const WARMUP_REPS  = 2;
const BENCH_REPS   = 3;
const MAX_NEW_TOKENS = 32;

// Thread matrix to test
const EMBED_THREAD_OPTIONS = [1, 2, 4];
const TAG_THREAD_OPTIONS   = [1, 2, 4];

// ── Worker thread implementations ────────────────────────────────────────────

// When this file runs as a worker, handle the assigned role and exit.
if (!isMainThread) {
  const { role, intraOpNumThreads, interOpNumThreads, warmupReps, benchReps } = workerData;

  if (role === 'embed') {
    await runEmbedWorker(intraOpNumThreads, interOpNumThreads, warmupReps, benchReps);
  } else if (role === 'tag') {
    await runTagWorker(intraOpNumThreads, warmupReps, benchReps);
  }
  // Keep the worker alive for the ready/run handshake. The main thread terminates
  // it after receiving the measured result.
  await new Promise(() => {});
}

async function runEmbedWorker(intraOp, interOp, warmupReps, benchReps) {
  const ort = await import('onnxruntime-node');
  const { AutoTokenizer, env } = await import('@huggingface/transformers');

  env.cacheDir = join(ROOT, 'models');
  env.allowRemoteModels = false;
  const tokenizer = await AutoTokenizer.from_pretrained(BGE_MODEL_ID, { local_files_only: true });

  const sessionOpts = {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  };
  if (intraOp > 0) sessionOpts.intraOpNumThreads = intraOp;
  if (interOp > 0)  sessionOpts.interOpNumThreads = interOp;

  const session = await ort.default.InferenceSession.create(MODEL_FILE, sessionOpts);

  const embedBatch = async (texts) => {
    for (const text of texts) {
      const enc = await tokenizer(text, { padding: true, truncation: true, max_length: 512, return_tensors: 'np' });
      const dims = enc.input_ids.dims;
      const toI64 = d => new ort.default.Tensor('int64', BigInt64Array.from(Array.from(d).map(BigInt)), dims);
      await session.run({
        input_ids:      toI64(enc.input_ids.data),
        attention_mask: toI64(enc.attention_mask.data),
        token_type_ids: toI64(enc.token_type_ids?.data ?? new Array(enc.input_ids.data.length).fill(0)),
      });
    }
  };

  for (let i = 0; i < warmupReps; i++) await embedBatch(EMBED_TEXTS.slice(0, 3));
  parentPort.postMessage({ role: 'embed', kind: 'ready' });

  parentPort.on('message', async msg => {
    if (msg?.kind !== 'run') return;
    try {
      const runs = [];
      const t0All = performance.now();
      for (let r = 0; r < benchReps; r++) {
        const t0 = performance.now();
        await embedBatch(EMBED_TEXTS);
        runs.push(performance.now() - t0);
      }
      const wallMs = performance.now() - t0All;
      const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
      session.release?.();
      parentPort.postMessage({ role: 'embed', kind: 'done', avgMs: avg, wallMs, runs });
    } catch (err) {
      parentPort.postMessage({ role: 'embed', kind: 'error', error: err.message });
    }
  });
}

async function runTagWorker(intraOp, warmupReps, benchReps) {
  const { pipeline, env } = await import('@huggingface/transformers');

  env.cacheDir = join(ROOT, 'models', 'transformers-cache');
  env.allowRemoteModels = false;
  // Allow WASM multi-threading
  if (intraOp > 1) {
    env.backends.onnx.wasm.numThreads = intraOp;
  }

  const generator = await pipeline('text-generation', QWEN_MODEL_ID, {
    dtype: 'q4',
    device: 'cpu',
  });

  const runPrompts = async (prompts) => {
    for (const p of prompts) {
      await generator(p, { max_new_tokens: MAX_NEW_TOKENS, do_sample: false });
    }
  };

  for (let i = 0; i < warmupReps; i++) await runPrompts(TAG_PROMPTS.slice(0, 1));
  parentPort.postMessage({ role: 'tag', kind: 'ready' });

  parentPort.on('message', async msg => {
    if (msg?.kind !== 'run') return;
    try {
      const runs = [];
      const t0All = performance.now();
      for (let r = 0; r < benchReps; r++) {
        const t0 = performance.now();
        await runPrompts(TAG_PROMPTS);
        runs.push(performance.now() - t0);
      }
      const wallMs = performance.now() - t0All;
      const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
      parentPort.postMessage({ role: 'tag', kind: 'done', avgMs: avg, wallMs, runs });
    } catch (err) {
      parentPort.postMessage({ role: 'tag', kind: 'error', error: err.message });
    }
  });
}

// ── Main orchestrator (runs in main thread only) ──────────────────────────────

function checkCache() {
  const missing = [MODEL_FILE, DATA_FILE, BGE_TOKENIZER, QWEN_MODEL_FILE].filter(f => !existsSync(f));
  if (missing.length) {
    console.error('\n[bench] Required ONNX model files are not cached.');
    console.error('  Run ONNX_EMBED=1 indexing once for BGE-M3, and run the Qwen ONNX probe/download before this benchmark.');
    console.error('  Missing:', missing.map(f => f.replace(ROOT + '/', '')).join(', '));
    process.exit(1);
  }
  const dataSize = (statSync(DATA_FILE).size / 1e9).toFixed(2);
  console.log(`[bench] BGE-M3 model ok (${dataSize} GB)`);
}

function spawnWorker(role, opts) {
  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: { role, ...opts },
  });
  return worker;
}

function waitFor(worker, kind, role) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = msg => {
      if (msg?.kind === 'error') {
        cleanup();
        reject(new Error(`${role} worker failed: ${msg.error}`));
      } else if (msg?.kind === kind) {
        cleanup();
        resolve(msg);
      }
    };
    const onError = err => {
      cleanup();
      reject(err);
    };
    const onExit = code => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`${role} worker exited with code ${code}`));
      }
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

async function startReadyWorker(role, opts) {
  const worker = spawnWorker(role, opts);
  await waitFor(worker, 'ready', role);
  return worker;
}

async function runReadyWorker(worker, role) {
  const done = waitFor(worker, 'done', role);
  worker.postMessage({ kind: 'run' });
  const result = await done;
  await worker.terminate();
  return result;
}

async function measureEmbedOnly(embedThreads) {
  const worker = await startReadyWorker('embed', {
    intraOpNumThreads: embedThreads,
    interOpNumThreads: 1,
    warmupReps: WARMUP_REPS,
    benchReps: BENCH_REPS,
  });
  const result = await runReadyWorker(worker, 'embed');
  return result.avgMs;
}

async function measureTagOnly(tagThreads) {
  const worker = await startReadyWorker('tag', {
    intraOpNumThreads: tagThreads,
    warmupReps: WARMUP_REPS,
    benchReps: BENCH_REPS,
  });
  const result = await runReadyWorker(worker, 'tag');
  return result.avgMs;
}

async function measureConcurrent(embedThreads, tagThreads) {
  const [embedWorker, tagWorker] = await Promise.all([
    startReadyWorker('embed', {
      intraOpNumThreads: embedThreads,
      interOpNumThreads: 1,
      warmupReps: WARMUP_REPS,
      benchReps: BENCH_REPS,
    }),
    startReadyWorker('tag', {
      intraOpNumThreads: tagThreads,
      warmupReps: WARMUP_REPS,
      benchReps: BENCH_REPS,
    }),
  ]);
  const t0 = performance.now();
  const [embedResult, tagResult] = await Promise.all([
    runReadyWorker(embedWorker, 'embed'),
    runReadyWorker(tagWorker, 'tag'),
  ]);
  // Compare average measured work against average solo baselines. The workers
  // each run BENCH_REPS loops internally, so the outer wall clock is a total.
  const wallMs = (performance.now() - t0) / BENCH_REPS;
  return { wallMs, embedMs: embedResult.avgMs, tagMs: tagResult.avgMs };
}

function fmtMs(ms) {
  return ms != null ? ms.toFixed(0) + ' ms' : '—';
}

function verdict(rows) {
  // Degradation = (concurrent wall) / max(embed-only, tag-only) - 1
  // ACCEPT: all concurrent walls < 1.25x the slower solo run
  // ONNX_WORKER_OVERLAP_NEEDS_TUNING: some rows 1.25x–1.75x
  // ONNX_WORKER_OVERLAP_REJECT: any row > 1.75x
  let maxDeg = 0;
  for (const r of rows) {
    if (r.embedOnly == null || r.tagOnly == null || r.concurrentWall == null) continue;
    const baseline = Math.max(r.embedOnly, r.tagOnly);
    const deg = r.concurrentWall / baseline - 1;
    if (deg > maxDeg) maxDeg = deg;
  }
  if (maxDeg <= 0.25) return { label: 'ONNX_WORKER_OVERLAP_ACCEPT', maxDeg };
  if (maxDeg <= 0.75) return { label: 'ONNX_WORKER_OVERLAP_NEEDS_TUNING', maxDeg };
  return { label: 'ONNX_WORKER_OVERLAP_REJECT', maxDeg };
}

function buildMarkdown(rows, verd, cpuCount, date) {
  const lines = [];
  lines.push(`# ONNX Worker/Thread Budget Benchmark`);
  lines.push(``);
  lines.push(`**Date:** ${date}  `);
  lines.push(`**CPU threads:** ${cpuCount}  `);
  lines.push(`**BGE-M3 texts/run:** ${EMBED_TEXTS.length}  `);
  lines.push(`**Qwen2.5 prompts/run:** ${TAG_PROMPTS.length} (max_new_tokens=${MAX_NEW_TOKENS})  `);
  lines.push(`**Warmup reps:** ${WARMUP_REPS} | **Bench reps:** ${BENCH_REPS} (avg reported)`);
  lines.push(``);
  lines.push(`## Results`);
  lines.push(``);
  lines.push(`| embedThreads | tagThreads | embed-only | tag-only | concurrent wall | embed-deg | tag-deg | wall-deg |`);
  lines.push(`|:---:|:---:|---:|---:|---:|---:|---:|---:|`);

  for (const r of rows) {
    const embedDeg = r.embedOnly != null && r.concurrentEmbedMs != null
      ? `+${((r.concurrentEmbedMs / r.embedOnly - 1) * 100).toFixed(0)}%` : '—';
    const tagDeg = r.tagOnly != null && r.concurrentTagMs != null
      ? `+${((r.concurrentTagMs / r.tagOnly - 1) * 100).toFixed(0)}%` : '—';
    const wallDeg = r.embedOnly != null && r.tagOnly != null && r.concurrentWall != null
      ? `+${((r.concurrentWall / Math.max(r.embedOnly, r.tagOnly) - 1) * 100).toFixed(0)}%` : '—';

    lines.push(
      `| ${r.embedThreads} | ${r.tagThreads} | ${fmtMs(r.embedOnly)} | ${fmtMs(r.tagOnly)} | ${fmtMs(r.concurrentWall)} | ${embedDeg} | ${tagDeg} | ${wallDeg} |`
    );
  }

  lines.push(``);
  lines.push(`## Verdict`);
  lines.push(``);
  lines.push(`**${verd.label}**`);
  lines.push(``);
  lines.push(`Max wall degradation vs matching slower solo lane: **+${(verd.maxDeg * 100).toFixed(0)}%**`);
  lines.push(``);
  lines.push(`### Thresholds`);
  lines.push(`- ACCEPT: wall ≤ 1.25× solo baseline (≤ +25% degradation)`);
  lines.push(`- ONNX_WORKER_OVERLAP_NEEDS_TUNING: 1.25× – 1.75× (+25% – +75%)`);
  lines.push(`- ONNX_WORKER_OVERLAP_REJECT: > 1.75× (+75% degradation)`);
  lines.push(``);
  lines.push(`### Notes`);
  lines.push(`- embed-only and tag-only are single-worker baselines (no contention)`);
  lines.push(`- concurrent wall = actual wall clock with both workers running in parallel`);
  lines.push(`- embed-deg / tag-deg = per-worker slowdown vs its own solo baseline`);
  lines.push(`- wall-deg = concurrent wall / max(embed-only, tag-only) − 1`);
  lines.push(`- Tag model: ${QWEN_MODEL_ID} (dtype=q4, device=cpu)`);
  lines.push(`- Embed model: ${BGE_MODEL_ID}`);
  lines.push(``);

  return lines.join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

checkCache();

const cpuCount = (await import('os')).cpus().length;
console.log(`[bench] CPU cores: ${cpuCount}`);
console.log(`[bench] Embed texts: ${EMBED_TEXTS.length}, Tag prompts: ${TAG_PROMPTS.length}`);
console.log(`[bench] Matrix: embedThreads=[${EMBED_THREAD_OPTIONS}] × tagThreads=[${TAG_THREAD_OPTIONS}]`);
console.log(`[bench] Warmup=${WARMUP_REPS}, Measured=${BENCH_REPS} reps each\n`);

const rows = [];

// Baseline: solo runs for each thread count
const embedBaselines = {};
const tagBaselines   = {};

console.log('[bench] --- Solo baselines ---');
for (const et of EMBED_THREAD_OPTIONS) {
  process.stdout.write(`  embed-only threads=${et}... `);
  try {
    const ms = await measureEmbedOnly(et);
    embedBaselines[et] = ms;
    process.stdout.write(`${ms.toFixed(0)} ms\n`);
  } catch (e) {
    process.stdout.write(`FAILED: ${e.message}\n`);
    embedBaselines[et] = null;
  }
}

for (const tt of TAG_THREAD_OPTIONS) {
  process.stdout.write(`  tag-only threads=${tt}... `);
  try {
    const ms = await measureTagOnly(tt);
    tagBaselines[tt] = ms;
    process.stdout.write(`${ms.toFixed(0)} ms\n`);
  } catch (e) {
    process.stdout.write(`FAILED: ${e.message}\n`);
    tagBaselines[tt] = null;
  }
}

console.log('\n[bench] --- Concurrent runs ---');
for (const et of EMBED_THREAD_OPTIONS) {
  for (const tt of TAG_THREAD_OPTIONS) {
    process.stdout.write(`  embed=${et} × tag=${tt}... `);
    let row = {
      embedThreads: et,
      tagThreads: tt,
      embedOnly: embedBaselines[et],
      tagOnly: tagBaselines[tt],
      concurrentWall: null,
      concurrentEmbedMs: null,
      concurrentTagMs: null,
    };
    try {
      const { wallMs, embedMs, tagMs } = await measureConcurrent(et, tt);
      row.concurrentWall    = wallMs;
      row.concurrentEmbedMs = embedMs;
      row.concurrentTagMs   = tagMs;
      process.stdout.write(`wall=${wallMs.toFixed(0)} ms  embed=${embedMs.toFixed(0)} ms  tag=${tagMs.toFixed(0)} ms\n`);
    } catch (e) {
      process.stdout.write(`FAILED: ${e.message}\n`);
    }
    rows.push(row);
  }
}

const verd = verdict(rows);
const date = new Date().toISOString().slice(0, 19).replace('T', ' ');
const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
const md = buildMarkdown(rows, verd, cpuCount, date);

mkdirSync(RESULTS_DIR, { recursive: true });
const reportPath = join(RESULTS_DIR, `${stamp}-onnx-worker-budget-bench.md`);
writeFileSync(reportPath, md, 'utf8');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Verdict: ${verd.label}`);
console.log(`Max wall degradation: +${(verd.maxDeg * 100).toFixed(0)}%`);
console.log(`Report: ${reportPath.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
console.log(`${'─'.repeat(60)}\n`);
