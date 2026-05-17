// ONNX true-batching feasibility probe for bge-m3-onnx.
//
// Tests whether batch_size > 1 is safe for the model's three outputs:
//   dense_vecs, sparse_vecs, colbert_vecs
// and whether batched output is numerically equivalent to sequential output.
//
// Usage: ONNX_EMBED=1 node benchmarks/onnx-batch-probe.js
//
// NOT part of npm run smoke. Requires ONNX model cached (~2.3 GB in ./models/).

import 'dotenv/config';
import { env, AutoTokenizer } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'models');
const MODEL_ID  = 'aapot/bge-m3-onnx';
const MODEL_DIR = join(CACHE_DIR, 'bge-m3-onnx');

env.cacheDir = CACHE_DIR;
mkdirSync(CACHE_DIR, { recursive: true });

const SPECIAL_TOKENS = new Set([0, 1, 2, 3, 250001]);

// ── corpus ────────────────────────────────────────────────────────────────────

const TEXTS = [
  // short English
  'Graph cache',
  // medium English
  'The indexer embeds each chunk using BGE-M3 ONNX and upserts points to Qdrant.',
  // technical tokens
  'embedForSearch() calls session.run() with input_ids attention_mask token_type_ids.',
  // Ukrainian short
  'Конфігурація середовища',
  // Ukrainian medium
  'Семантичний пошук по документах з використанням векторних ембеджингів та розрідженого пошуку.',
  // long English (~200 tokens)
  'BGE-M3 is a versatile embedding model supporting dense retrieval, lexical matching via sparse vectors, '
  + 'and multi-vector colbert-style interaction. It supports over 100 languages and can handle sequences '
  + 'up to 8192 tokens. The ONNX export provides three output heads: dense_vecs for semantic similarity, '
  + 'sparse_vecs for token-level lexical weights compatible with Qdrant sparse vectors, '
  + 'and colbert_vecs for late-interaction multi-vector scoring.',
];

// ── helpers ───────────────────────────────────────────────────────────────────

function toInt64Batch(data, dims) {
  return new ort.Tensor('int64', BigInt64Array.from(Array.from(data).map(BigInt)), dims);
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function maxAbsDelta(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

function processSparse(tokenWeights, inputIds, attnMask) {
  const best = new Map();
  for (let i = 0; i < inputIds.length; i++) {
    const id = inputIds[i], val = tokenWeights[i];
    if (attnMask[i] === 0 || SPECIAL_TOKENS.has(id) || val <= 0) continue;
    if (!best.has(id) || val > best.get(id)) best.set(id, val);
  }
  return { indices: [...best.keys()], values: [...best.values()] };
}

function sparseMaxDelta(a, b) {
  const mapA = new Map(a.indices.map((id, i) => [id, a.values[i]]));
  const mapB = new Map(b.indices.map((id, i) => [id, b.values[i]]));
  const all  = new Set([...mapA.keys(), ...mapB.keys()]);
  let max = 0;
  for (const id of all) max = Math.max(max, Math.abs((mapA.get(id) ?? 0) - (mapB.get(id) ?? 0)));
  return max;
}

// ── session ───────────────────────────────────────────────────────────────────

async function loadSession() {
  process.stderr.write('[probe] loading tokenizer...\n');
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);

  const modelPath = join(MODEL_DIR, 'model.onnx');
  process.stderr.write('[probe] creating inference session...\n');
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  process.stderr.write(`[probe] ready. outputs: ${session.outputNames}\n`);
  return { tokenizer, session };
}

// ── sequential (batch=1) baseline ────────────────────────────────────────────

async function runSequential(tokenizer, session, texts) {
  const results = [];
  for (const text of texts) {
    const enc = await tokenizer(text, { padding: true, truncation: true, max_length: 8192, return_tensors: 'np' });
    const dims = enc.input_ids.dims; // [1, seq_len]

    const feeds = {
      input_ids:      toInt64Batch(enc.input_ids.data,      dims),
      attention_mask: toInt64Batch(enc.attention_mask.data,  dims),
      token_type_ids: toInt64Batch(enc.token_type_ids?.data ?? new Array(enc.input_ids.data.length).fill(0), dims),
    };

    const outputs   = await session.run(feeds);
    const names     = session.outputNames;
    const seqLen    = dims[1];

    const denseRaw  = Array.from(outputs[names[0]].data);  // [1024]
    const sparseRaw = Array.from(outputs[names[1]].data).map(Number); // [seq_len] or [seq_len,1]
    const inputIds  = Array.from(enc.input_ids.data).map(Number);
    const attnMask  = Array.from(enc.attention_mask.data).map(Number);

    // colbert_vecs: [1, colbertSeqLen, 1024] where colbertSeqLen = seqLen - 1
    const colbertRaw     = outputs[names[2]];
    const colbertShape   = colbertRaw.dims; // [1, colbertSeqLen, 1024]
    const colbertFirst   = Array.from(colbertRaw.data).slice(0, 1024); // first token vector

    results.push({
      text,
      seqLen,
      colbertSeqLen: colbertShape[1],
      dense:         denseRaw,
      sparse:        processSparse(sparseRaw, inputIds, attnMask),
      colbertShape,
      colbertFirst,
    });
  }
  return results;
}

// ── batched ───────────────────────────────────────────────────────────────────

async function runBatched(tokenizer, session, texts) {
  // Tokenize all texts with padding to max seq_len in batch
  const enc = await tokenizer(texts, { padding: true, truncation: true, max_length: 8192, return_tensors: 'np' });
  const dims = enc.input_ids.dims; // [batchSize, seq_len]
  const [batchSize, seqLen] = dims;

  const feeds = {
    input_ids:      toInt64Batch(enc.input_ids.data,      dims),
    attention_mask: toInt64Batch(enc.attention_mask.data,  dims),
    token_type_ids: toInt64Batch(enc.token_type_ids?.data ?? new Array(enc.input_ids.data.length).fill(0), dims),
  };

  const outputs = await session.run(feeds);
  const names   = session.outputNames;

  // dense_vecs: [batchSize, 1024]
  const denseAll    = Array.from(outputs[names[0]].data);
  // sparse_vecs: [batchSize, seqLen, 1] — flat layout [batchSize * seqLen]
  const sparseAll   = Array.from(outputs[names[1]].data).map(Number);
  // colbert_vecs: [batchSize, colbertSeqLen, 1024] where colbertSeqLen = seqLen - 1
  const colbertAll      = outputs[names[2]];
  const colbertSeqLen   = colbertAll.dims[1]; // NOT the same as input seqLen
  const colbertData     = Array.from(colbertAll.data);

  const results = [];
  for (let b = 0; b < batchSize; b++) {
    const dense  = denseAll.slice(b * 1024, (b + 1) * 1024);

    // sparse slice: b * seqLen … (b+1) * seqLen (input seqLen, not colbert's)
    const sparseSlice = sparseAll.slice(b * seqLen, (b + 1) * seqLen);
    const inputIds    = Array.from(enc.input_ids.data).slice(b * seqLen, (b + 1) * seqLen).map(Number);
    const attnMask    = Array.from(enc.attention_mask.data).slice(b * seqLen, (b + 1) * seqLen).map(Number);
    const sparse      = processSparse(sparseSlice, inputIds, attnMask);

    // colbert: stride is colbertSeqLen * 1024, NOT seqLen * 1024
    const colbertOffset = b * colbertSeqLen * 1024;
    const colbertFirst  = colbertData.slice(colbertOffset, colbertOffset + 1024);
    const colbertShape  = colbertAll.dims; // [batchSize, colbertSeqLen, 1024]

    results.push({ text: texts[b], seqLen, dense, sparse, colbertShape, colbertFirst });
  }
  return results;
}

// ── timing helper ─────────────────────────────────────────────────────────────

async function timeRun(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  return { label, ms, result };
}

// ── main ──────────────────────────────────────────────────────────────────────

const initT0 = performance.now();
const { tokenizer, session } = await loadSession();
const initMs = performance.now() - initT0;

console.log(`\n${'='.repeat(70)}`);
console.log('ONNX True-Batching Feasibility Probe — bge-m3-onnx');
console.log('='.repeat(70));
console.log(`init time : ${initMs.toFixed(0)} ms`);
console.log(`texts     : ${TEXTS.length}`);
console.log(`outputs   : ${session.outputNames.join(', ')}`);
console.log('');

// ── 1. Sequential baseline ────────────────────────────────────────────────────
console.log('── 1. Sequential (batch=1) baseline ──────────────────────────────');
const seq = await timeRun('sequential', () => runSequential(tokenizer, session, TEXTS));
console.log(`total     : ${seq.ms.toFixed(0)} ms`);
console.log(`ms/text   : ${(seq.ms / TEXTS.length).toFixed(0)} ms`);
for (const r of seq.result) {
  console.log(`  [${r.seqLen.toString().padStart(4)} tok / ${r.colbertSeqLen} colbert] dense[0]=${r.dense[0].toFixed(5)}  sparse=${r.sparse.indices.length} tokens  colbert=${r.colbertShape.join('×')}`);
}

// ── 2. Batched runs ───────────────────────────────────────────────────────────
const BATCH_SIZES = [2, 4, TEXTS.length];

for (const bs of BATCH_SIZES) {
  const batchTexts = TEXTS.slice(0, bs);
  console.log(`\n── 2. Batched batch_size=${bs} ${'─'.repeat(40)}`);

  let batchResult;
  let error = null;
  const batchTimed = await timeRun(`batch=${bs}`, async () => {
    try {
      batchResult = await runBatched(tokenizer, session, batchTexts);
      return batchResult;
    } catch (e) {
      error = e;
      return null;
    }
  });

  if (error) {
    console.log(`  ERROR: ${error.message}`);
    console.log(`  Verdict for batch=${bs}: BLOCKED (runtime error)`);
    continue;
  }

  console.log(`total     : ${batchTimed.ms.toFixed(0)} ms`);
  console.log(`ms/text   : ${(batchTimed.ms / bs).toFixed(0)} ms`);
  const speedup = (seq.ms / TEXTS.length) / (batchTimed.ms / bs);
  console.log(`speedup vs sequential: ${speedup.toFixed(2)}×`);

  // ── equivalence checks ──────────────────────────────────────────────────────
  console.log('  equivalence checks:');
  let allOk = true;
  for (let i = 0; i < bs; i++) {
    const s = seq.result[i];
    const b = batchResult[i];

    const denseCos   = cosineSim(s.dense, b.dense);
    const denseMax   = maxAbsDelta(s.dense, b.dense);
    const sparseDelta = sparseMaxDelta(s.sparse, b.sparse);
    const colbertCos  = cosineSim(s.colbertFirst, b.colbertFirst);
    const colbertMax  = maxAbsDelta(s.colbertFirst, b.colbertFirst);

    const denseOk   = denseCos > 0.9999 && denseMax < 1e-4;
    const sparseOk  = sparseDelta < 1e-4;
    const colbertOk = colbertCos > 0.9999 && colbertMax < 1e-4;
    const rowOk     = denseOk && sparseOk && colbertOk;
    if (!rowOk) allOk = false;

    const mark = (ok) => ok ? '✓' : '✗';
    console.log(`    [${i}] dense: cos=${denseCos.toFixed(6)} maxΔ=${denseMax.toExponential(2)} ${mark(denseOk)}` +
                `  sparse: maxΔ=${sparseDelta.toExponential(2)} ${mark(sparseOk)}` +
                `  colbert: cos=${colbertCos.toFixed(6)} maxΔ=${colbertMax.toExponential(2)} ${mark(colbertOk)}`);
  }
  console.log(`  batch=${bs} equivalence: ${allOk ? 'PASS' : 'FAIL'}`);
}

// ── 3. Output shape summary ───────────────────────────────────────────────────
console.log('\n── 3. Output shape notes ─────────────────────────────────────────');
{
  const enc = await tokenizer(TEXTS, { padding: true, truncation: true, max_length: 8192, return_tensors: 'np' });
  const dims = enc.input_ids.dims;
  const feeds = {
    input_ids:      toInt64Batch(enc.input_ids.data,      dims),
    attention_mask: toInt64Batch(enc.attention_mask.data,  dims),
    token_type_ids: toInt64Batch(enc.token_type_ids?.data ?? new Array(enc.input_ids.data.length).fill(0), dims),
  };
  const outputs = await session.run(feeds);
  const names   = session.outputNames;
  for (const name of names) {
    const t = outputs[name];
    console.log(`  ${name}: dims=[${t.dims.join(', ')}] dtype=${t.type}`);
  }
  console.log(`  input batch dims: [${dims.join(', ')}]`);
}

// ── 4. Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(70)}`);
console.log('Summary');
console.log('='.repeat(70));
console.log('Sequential (batch=1):');
console.log(`  total=${seq.ms.toFixed(0)} ms  ms/text=${(seq.ms / TEXTS.length).toFixed(0)} ms`);
console.log('');
console.log('Dense slice:        denseAll.slice(b*1024, (b+1)*1024)                    — stride=1024');
console.log('Sparse slice:       sparseAll.slice(b*seqLen, (b+1)*seqLen)               — stride=seqLen (input dims[1])');
console.log('ColBERT slice:      colbertData.slice(b*colbertSeqLen*1024, ...)           — stride=colbertSeqLen*1024 (colbert dims[1], NOT seqLen)');
console.log('');
console.log('See benchmarks/retrieval/results/ for the written report.');
