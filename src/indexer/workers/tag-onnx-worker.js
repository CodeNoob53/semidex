// Worker thread for ONNX-based tag generation.
// Loaded once per indexer process via tag-onnx.js; receives chunk payloads,
// returns tags aligned to input order.
//
// Protocol (messages in/out over parentPort):
//   init → main sends { kind: 'init' }  (not needed — model loads on spawn)
//   run  → main sends { kind: 'run', chunks: [{text, section, source_file}] }
//          worker replies { kind: 'done', tagArrays: string[][] }
//            or { kind: 'error', error: string }

import { parentPort, workerData } from 'worker_threads';
import { join } from 'path';
import { existsSync } from 'fs';

const { modelId, cacheDir, numThreads, allowDownload } = workerData;

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
    // Inter-op parallelism: 1 keeps operator scheduling simple on a dedicated worker.
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
  parentPort.postMessage({ kind: 'ready' });
} catch (err) {
  parentPort.postMessage({ kind: 'error', error: err.message });
  process.exit(1);
}

parentPort.on('message', async msg => {
  if (msg?.kind !== 'run') return;

  const { requestId, chunks } = msg;
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
    parentPort.postMessage({ kind: 'done', requestId, tagArrays });
  } catch (err) {
    parentPort.postMessage({ kind: 'error', requestId, error: err.message });
  }
});
