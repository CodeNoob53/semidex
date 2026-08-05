// Child process for ONNX-based tag generation.
// Spawned once per indexer process via tag-onnx.js; receives chunk
// payloads over IPC, returns tags aligned to input order.
//
// Runs in a genuinely separate OS process (node:child_process's fork(), NOT
// worker_threads) — a worker_thread is a separate V8 isolate but the SAME
// OS process, so native addons (including ONNX Runtime's own process-global
// Ort::Env singleton) are still shared with whatever the indexer's main
// process has loaded (e.g. the custom CUDA-enabled onnxruntime-node build
// via local/core/onnx-embed.js, when ONNX_EMBED=1). Only a genuinely separate
// process gives @huggingface/transformers' own bundled ORT build its own
// address space and its own Ort::Env. See
// docs/cuda-runtime-verification-2026-07-24.md.
//
// Configuration arrives via environment variables (set by tag-onnx.js's
// fork() call), never IPC — modelId/cacheDir/numThreads/allowDownload never
// change for this process's lifetime.
//
// Protocol (IPC messages via process.send()/process.on('message')):
//   run → parent sends { kind: 'run', requestId, chunks: [{text, section, source_file}] }
//         worker replies { kind: 'done', requestId, tagArrays: string[][] }
//           or { kind: 'error', requestId, error: string }
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const modelId       = process.env.TAG_ONNX_WORKER_MODEL_ID;
const cacheDir       = process.env.TAG_ONNX_WORKER_CACHE_DIR;
const numThreads     = parseInt(process.env.TAG_ONNX_WORKER_NUM_THREADS ?? '1', 10) || 1;
const allowDownload  = process.env.TAG_ONNX_WORKER_ALLOW_DOWNLOAD === '1';

const MAX_NEW_TOKENS = 28;
const PROMPT_TEXT_LIMIT = 600;

function buildPrompt(chunk) {
  const text = (chunk.text ?? '').slice(0, PROMPT_TEXT_LIMIT);
  return [
    {
      role: 'system',
      content:
        'You are a document tagger. Generate 3-6 concise lowercase hyphenated tags. ' +
        'Tags should describe the topic, technology, or concept. ' +
        'Output only comma-separated tags. No explanation.',
    },
    {
      role: 'user',
      content:
        `Generate 3-6 tags for this chunk.\n` +
        `Text:\n${text}`,
    },
  ];
}

function parseTags(raw) {
  // Trim leakage suffix that appears after valid tags (e.g. "\n\nExplanation:" or "Note:").
  const clean = String(raw ?? '').split(/\n\n|\bExplanation\b|\bNote\b/i)[0];
  // Normalise to lowercase-hyphenated. This is intentional: qdrant_find_by_tag uses
  // Qdrant match.value which is exact/case-sensitive, so all tags must arrive in a
  // consistent form regardless of model output casing (QDRANT_URL → qdrant-url).
  // Callers searching by tag must use the same normalised form.
  const tags = clean
    .split(/[,\n;#]|\s+\/\s+/)
    .map(t => t.replace(/^[-*•\d.)\s]+/, '').trim().toLowerCase())
    .map(t => t.replace(/[_\s]+/g, '-').replace(/[^a-z0-9\-]/g, ''))
    .map(t => t.replace(/-+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(t => t.length > 1 && t.length < 40);
  return [...new Set(tags)].slice(0, 6);
}

function extractGeneratedText(output) {
  const generated = output?.[0]?.generated_text;
  if (Array.isArray(generated)) {
    const assistant = [...generated].reverse().find(m => m?.role === 'assistant');
    return assistant?.content ?? '';
  }
  return String(generated ?? '');
}

async function loadModel() {
  const { pipeline, env } = await import('@huggingface/transformers');

  env.cacheDir = cacheDir;
  env.allowRemoteModels = Boolean(allowDownload);

  if (!allowDownload) {
    const modelFileRel = join(...modelId.split('/'), 'onnx', 'model_q4.onnx');
    const modelFile = join(cacheDir, modelFileRel);
    if (!existsSync(modelFile)) {
      throw new Error(
        `[tag-onnx] ONNX tag model not cached at ${modelFileRel}\n` +
        `  Set TAG_ONNX_ALLOW_DOWNLOAD=1 to download on first use, or\n` +
        `  run the benchmark once (bench:onnx-worker-budget) to populate the cache.`
      );
    }
  }

  // @huggingface/transformers on Node.js uses onnxruntime-node (not WASM).
  // Thread count is passed through ORT env vars before session creation.
  // wasm.numThreads is a no-op in the Node ORT backend — set ORT vars instead.
  if (numThreads >= 1) {
    env.backends.onnx.wasm.numThreads = numThreads; // kept for WASM fallback environments
    // ORT intra-op thread count for the Node native backend.
    process.env.ORT_NUM_THREADS     = String(numThreads);
    // Inter-op parallelism: 1 keeps operator scheduling simple on a dedicated process.
    process.env.ORT_INTER_OP_THREADS = '1';
  }

  const generator = await pipeline('text-generation', modelId, {
    dtype: 'q4',
    device: 'cpu',
  });

  // Warm up with one short prompt to amortise model JIT/load cost.
  await generator('warm up', { max_new_tokens: 4, do_sample: false });

  return generator;
}

let generator;
try {
  generator = await loadModel();
  process.send({ kind: 'ready' });
} catch (err) {
  process.send({ kind: 'error', error: err.message });
  process.exit(1);
}

// FIFO run queue — a single Qwen2.5-Coder-1.5B generator instance must
// never process two batches concurrently. process.on('message', async ...)
// spawns an independent async invocation per incoming IPC message with no
// serialization of its own; in pipeline mode (STAGEA_CONCURRENCY, default
// 4) multiple files can each call addTagsOnnxBatch() around the same time,
// so without an explicit queue here, two 'run' messages arriving close
// together would both call generator(...) concurrently on the same model —
// a real OOM risk for a 1.5B model, not just a slowdown.
let queueTail = Promise.resolve();

async function runOne(requestId, chunks) {
  const tagArrays = [];
  try {
    for (const chunk of chunks) {
      const prompt = buildPrompt(chunk);
      let raw = '';
      try {
        const output = await generator(prompt, {
          max_new_tokens: MAX_NEW_TOKENS,
          do_sample: false,
          repetition_penalty: 1.3,
          return_full_text: false,
        });
        raw = extractGeneratedText(output).trim();
      } catch (genErr) {
        // Per-chunk failure: store empty tags, don't abort the whole batch.
        process.stderr.write(`[tag-onnx] chunk generate failed: ${genErr.message}\n`);
      }
      tagArrays.push(parseTags(raw));
    }
    process.send({ kind: 'done', requestId, tagArrays });
  } catch (err) {
    process.send({ kind: 'error', requestId, error: err.message });
  }
}

process.on('message', (msg) => {
  if (msg?.kind !== 'run') return;
  const { requestId, chunks } = msg;
  // Chain onto the queue tail regardless of the previous entry's outcome —
  // runOne() itself never throws (both its try/catch branches always
  // process.send() and return normally), but .catch(() => {}) is kept as a
  // defensive backstop so one runaway rejection can never wedge every
  // subsequent queued request behind a permanently-rejected tail promise.
  queueTail = queueTail.then(() => runOne(requestId, chunks)).catch(() => {});
});
