// Child process for cross-encoder reranking. Spawned once per host process
// (MCP server, admin server) via ce-rerank.js and kept alive; receives
// query+candidate batches over IPC, returns CE scores aligned to input order.
//
// This is the ONLY place @huggingface/transformers loads for CE reranking —
// deliberately isolated in its own OS-level CHILD PROCESS (child_process.fork,
// NOT worker_threads) so Transformers.js's bundled ONNX Runtime build never
// shares a process with the custom CUDA-enabled onnxruntime-node build
// local/core/onnx-embed.js loads for dense/sparse embedding.
//
// worker_threads was tried first and rejected: a worker_thread is a separate
// V8 isolate but the SAME OS process — native addons (including ONNX
// Runtime's own process-global Ort::Env singleton) are loaded once per
// process and shared across every thread in it, worker or main. Two
// different ORT builds sharing one process's native address space is
// exactly the conflict this isolation exists to prevent; only a genuinely
// separate OS process (child_process) gives each build its own address
// space and its own Ort::Env. See docs/cuda-runtime-verification-2026-07-24.md.
//
// Configuration arrives via environment variables (set by ce-rerank.js's
// fork() call), never IPC — the model/device/cacheDir never change for this
// process's lifetime (next_restart settings), so there is no need for a
// config message.
//
// Protocol (IPC messages via process.send()/process.on('message')):
//   spawn → worker loads the model immediately, posts { kind: 'ready',
//           numLabels } on success, or { kind: 'error', error } + exit(1)
//           on failure.
//   run   → parent sends { kind: 'run', requestId, query, candidates, input, batchSize }
//           worker replies { kind: 'done', requestId, scores: number[] }
//             or { kind: 'error', requestId, error: string }
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const RERANK_CE_MODEL    = process.env.CE_WORKER_MODEL;
const RERANK_CE_DEVICE   = process.env.CE_WORKER_DEVICE;
const RERANK_CE_CACHE_DIR = process.env.CE_WORKER_CACHE_DIR;

// ── Passage construction — exact port of ce-rerank.js's buildPassage(),
// duplicated here (not imported) because this file must never import
// anything that could pull in onnxruntime-node — see the module header. ──
function buildPassage(payload, inputMode) {
  const p = payload ?? {};
  if (inputMode === 'text+section') return `${p.section ?? ''}\n${p.text ?? ''}`;
  if (inputMode === 'text+meta') return `${p.source_file ?? ''} ${p.section ?? ''}\n${p.text ?? ''}`;
  return p.text ?? '';
}

let tokenizer;
let model;
let numLabels;

async function loadModel() {
  const { AutoTokenizer, AutoModelForSequenceClassification, env: hfEnv } =
    await import('@huggingface/transformers');

  const cacheDir = resolve(RERANK_CE_CACHE_DIR);
  mkdirSync(cacheDir, { recursive: true });
  hfEnv.cacheDir = cacheDir;

  const tok = await AutoTokenizer.from_pretrained(RERANK_CE_MODEL);

  const opts = { dtype: 'fp32' };
  let mdl;
  if (RERANK_CE_DEVICE !== 'cpu') {
    try {
      mdl = await AutoModelForSequenceClassification.from_pretrained(
        RERANK_CE_MODEL, { ...opts, device: RERANK_CE_DEVICE });
    } catch (err) {
      const oneLine = String(err?.message ?? err).replace(/\r?\n.*/s, '').trim().slice(0, 120);
      process.stderr.write(
        `[ce-rerank-worker] device "${RERANK_CE_DEVICE}" unavailable (${oneLine}) — falling back to cpu\n`
      );
    }
  }
  if (!mdl) {
    mdl = await AutoModelForSequenceClassification.from_pretrained(RERANK_CE_MODEL, opts);
  }

  const probe = tok(['probe'], { text_pair: ['probe'], truncation: true, max_length: 16, return_tensors: 'pt', padding: true });
  const { logits: probeLogits } = await mdl(probe);
  const labels = probeLogits.dims[1];
  if (labels !== 1 && labels !== 2) {
    throw new Error(`unsupported numLabels=${labels} for "${RERANK_CE_MODEL}" — expected 1 or 2`);
  }

  tokenizer = tok;
  model = mdl;
  numLabels = labels;
}

function extractScores(logits, batchSize) {
  const data = logits.data;
  if (data.length !== batchSize * numLabels) {
    throw new Error(`logits.data length ${data.length} !== batchSize(${batchSize}) x numLabels(${numLabels})`);
  }
  const col = numLabels === 2 ? 1 : 0;
  const scores = [];
  for (let row = 0; row < batchSize; row++) scores.push(data[row * numLabels + col]);
  return scores;
}

async function scoreAll(query, candidates, { input, batchSize }) {
  const rawScores = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const passages = batch.map((r) => buildPassage(r.payload, input));
    const queries = Array(batch.length).fill(query);
    const inputs = tokenizer(queries, {
      text_pair: passages, truncation: true, max_length: 512,
      return_tensors: 'pt', padding: true,
    });
    const { logits } = await model(inputs);
    for (const v of extractScores(logits, batch.length)) rawScores.push(v);
  }
  return rawScores;
}

try {
  await loadModel();
  process.send({ kind: 'ready', numLabels });
} catch (err) {
  process.send({ kind: 'error', error: err.message });
  process.exit(1);
}

process.on('message', async (msg) => {
  if (msg?.kind !== 'run') return;
  const { requestId, query, candidates, input, batchSize } = msg;
  try {
    const scores = await scoreAll(query, candidates, { input, batchSize });
    process.send({ kind: 'done', requestId, scores });
  } catch (err) {
    process.send({ kind: 'error', requestId, error: err.message });
  }
});
