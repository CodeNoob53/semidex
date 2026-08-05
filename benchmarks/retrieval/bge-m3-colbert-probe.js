// BGE-M3 ColBERT-head probe — benchmark-only, no production changes.
// Extracts colbert_vecs from the existing bge-m3-onnx model and measures:
//   - output shape (batch, seq_len, dim)
//   - live token count after mask + special-token filtering
//   - whether vectors are already L2-normalised
//   - MaxSim score between a query and a set of candidate chunks
//   - per-chunk latency at N=1, N=10, N=40
//
// Usage:
//   BENCH_PROVIDER=onnx node benchmarks/retrieval/bge-m3-colbert-probe.js
//
// Requires the ONNX model to already be cached (run ONNX_EMBED=1 indexing first).

import 'dotenv/config';
import * as ort from 'onnxruntime-node';
import { AutoTokenizer } from '@huggingface/transformers';
import { existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveOnnxExecutionProviders } from '../../src/local/core/onnx-embed.js';
import { l2Norm, maxSimScore, extractTokenVecsBGE } from './lib/colbert-math.js';

const ROOT       = join(dirname(fileURLToPath(import.meta.url)), '../../');
const MODEL_DIR  = join(ROOT, 'models', 'bge-m3-onnx');
const MODEL_FILE = join(MODEL_DIR, 'model.onnx');
const DATA_FILE  = join(MODEL_DIR, 'model.onnx.data');
const MODEL_ID   = 'aapot/bge-m3-onnx';

// ── Guard ──────────────────────────────────────────────────────────────────────

function checkCache() {
  const missing = [MODEL_FILE, DATA_FILE].filter(f => !existsSync(f));
  if (missing.length) {
    console.error('\nONNX model not cached. Run ONNX_EMBED=1 indexing once to download it.');
    console.error('  ONNX_EMBED=1 COLLECTION=any npm run index <any-file>');
    console.error('\nMissing:', missing.map(f => f.replace(ROOT, '')).join(', '));
    process.exit(1);
  }
  const dataGB = (statSync(DATA_FILE).size / 1e9).toFixed(2);
  console.log(`[probe] model cache ok  (data: ${dataGB} GB)\n`);
}

// ── Tokenise + run ─────────────────────────────────────────────────────────────

async function encode(session, tokenizer, text) {
  const encoded = await tokenizer(text, {
    padding: true,
    truncation: true,
    max_length: 8192,
    return_tensors: 'np',
  });

  const dims    = encoded.input_ids.dims;
  const toInt64 = d => new ort.Tensor('int64',
    BigInt64Array.from(Array.from(d).map(BigInt)), dims);

  const feeds = {
    input_ids:      toInt64(encoded.input_ids.data),
    attention_mask: toInt64(encoded.attention_mask.data),
    token_type_ids: toInt64(
      encoded.token_type_ids?.data ?? new Array(encoded.input_ids.data.length).fill(0)
    ),
  };

  const t0      = performance.now();
  const outputs = await session.run(feeds);
  const ms      = performance.now() - t0;

  const inputIds = Array.from(encoded.input_ids.data).map(Number);
  const attnMask = Array.from(encoded.attention_mask.data).map(Number);

  // Look up colbert_vecs by name so output-order changes don't silently break the probe.
  const colbertTensor = outputs['colbert_vecs'];
  if (!colbertTensor) {
    console.error(`[probe] BLOCKED: 'colbert_vecs' not found in model outputs.`);
    console.error(`         Available: ${session.outputNames.join(', ')}`);
    process.exit(1);
  }

  return { colbertTensor, inputIds, attnMask, ms };
}

// ── Shape / normalisation diagnostics ─────────────────────────────────────────

function checkNormalised(vecs, sampleSize = 5) {
  const sample = vecs.slice(0, sampleSize);
  const norms  = sample.map(l2Norm);
  const allOne = norms.every(n => Math.abs(n - 1.0) < 0.01);
  return { norms, allOne };
}

// ── Main probe ─────────────────────────────────────────────────────────────────

checkCache();

console.log('[probe] loading tokenizer...');
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
console.log('[probe] tokenizer ready\n');

const providers = resolveOnnxExecutionProviders(process.env.ONNX_EXECUTION_PROVIDER);
console.log(`[probe] creating session (providers: ${providers.join(', ')})...`);
const t0sess = performance.now();
const session = await ort.InferenceSession.create(MODEL_FILE, {
  executionProviders: providers,
  graphOptimizationLevel: 'all',
});
const sessionMs = performance.now() - t0sess;
console.log(`[probe] session ready in ${sessionMs.toFixed(0)} ms`);
console.log(`[probe] output names: ${session.outputNames.join(', ')}\n`);

if (!session.outputNames.includes('colbert_vecs')) {
  console.error("[probe] BLOCKED: 'colbert_vecs' not in session.outputNames");
  console.error(`         Found: ${session.outputNames.join(', ')}`);
  process.exit(1);
}

// ── 1. Shape probe ─────────────────────────────────────────────────────────────

console.log('═══ 1. Output shape & token alignment ══════════════════════════════════════');

const TOKEN_POLICY = process.env.COLBERT_TOKEN_POLICY ?? 'official';
const QUERY = 'How does semidex index documents with ONNX embeddings?';
const { colbertTensor, inputIds, attnMask, ms: queryMs } = await encode(session, tokenizer, QUERY);

const [batchSize, seqLen, colbertDim] = colbertTensor.dims;
const offset = inputIds.length - seqLen;
console.log(`Query : "${QUERY}"`);
console.log(`input_ids length   : ${inputIds.length}`);
console.log(`attention_mask sum : ${attnMask.reduce((s, v) => s + v, 0)}`);
console.log(`colbert seq_len    : ${seqLen}`);
console.log(`inferred offset    : ${offset}  (${offset === 1 ? 'CLS stripped by model' : offset === 0 ? 'no stripping' : 'UNEXPECTED'})`);
console.log(`first token IDs    : [${inputIds.slice(0, 5).join(', ')}]  (CLS=0)`);
console.log(`mapped IDs (off+1) : [${inputIds.slice(1, 6).join(', ')}]`);
console.log(`last mapped ID     : ${inputIds[inputIds.length - 1]}  (EOS=2)`);
console.log(`Shape              : [batch=${batchSize}, seq_len=${seqLen}, dim=${colbertDim}]`);
console.log(`Token policy       : ${TOKEN_POLICY}  (COLBERT_TOKEN_POLICY env)`);
console.log(`Inference ms       : ${queryMs.toFixed(1)}`);

const queryVecs = extractTokenVecsBGE(colbertTensor, inputIds, attnMask, TOKEN_POLICY);
console.log(`Tokens after policy filtering: ${queryVecs.length} / ${seqLen}`);

const { norms, allOne } = checkNormalised(queryVecs);
console.log(`L2 norms (first ${norms.length} tokens): [${norms.map(n => n.toFixed(4)).join(', ')}]`);
console.log(`Vectors already L2-normalised: ${allOne}`);
console.log();

// ── 2. MaxSim scores ──────────────────────────────────────────────────────────

console.log('═══ 2. MaxSim scores ════════════════════════════════════════════════════════');

const CHUNKS = [
  // relevant
  'semidex uses ONNX for both dense and sparse embedding. When ONNX_EMBED=1 is set, bge-m3-onnx runs locally and produces dense 1024-dim and sparse lexical vectors in a single inference call.',
  // partially relevant
  'Qdrant stores vector embeddings and provides hybrid search via RRF fusion of dense and sparse results. The collection schema requires payload indexes for source_file, tags, and chunk_index.',
  // off-topic
  'BGE-M3 supports three retrieval modes: dense, sparse, and ColBERT. The ColBERT head produces per-token vectors of dimension 1024 that enable late-interaction scoring.',
];

const chunkResults = [];
for (let i = 0; i < CHUNKS.length; i++) {
  const { colbertTensor: ct, inputIds: cIds, attnMask: cMask } = await encode(session, tokenizer, CHUNKS[i]);
  const docVecs = extractTokenVecsBGE(ct, cIds, cMask, TOKEN_POLICY);
  const score   = maxSimScore(queryVecs, docVecs, allOne);
  chunkResults.push({ i, score, tokens: docVecs.length });
  console.log(`Chunk ${i}: MaxSim=${score.toFixed(4)}  tokens=${docVecs.length}  "${CHUNKS[i].slice(0, 55)}..."`);
}
console.log();

const sorted = [...chunkResults].sort((a, b) => b.score - a.score);
console.log('Ranking by MaxSim:');
for (const r of sorted) {
  console.log(`  #${sorted.findIndex(x => x.i === r.i) + 1}  chunk${r.i}  ${r.score.toFixed(4)}`);
}
console.log();

// ── 3. Latency at N = 1, 10, 40 ──────────────────────────────────────────────

console.log('═══ 3. Latency (query + N chunk reranking) ══════════════════════════════════');

const BENCH_CHUNK = CHUNKS[0];

for (const N of [1, 10, 40]) {
  const t1 = performance.now();
  const { colbertTensor: qt, inputIds: qIds, attnMask: qMask } = await encode(session, tokenizer, QUERY);
  const qVecs = extractTokenVecsBGE(qt, qIds, qMask, TOKEN_POLICY);

  for (let n = 0; n < N; n++) {
    const { colbertTensor: ct, inputIds: cIds, attnMask: cMask } = await encode(session, tokenizer, BENCH_CHUNK);
    const dVecs = extractTokenVecsBGE(ct, cIds, cMask, TOKEN_POLICY);
    maxSimScore(qVecs, dVecs, allOne);
  }
  const total = performance.now() - t1;
  console.log(`N=${String(N).padStart(2)}: total=${total.toFixed(0).padStart(5)} ms  per-chunk=${(total / (N + 1)).toFixed(1).padStart(6)} ms`);
}
console.log();

// ── 4. Summary ────────────────────────────────────────────────────────────────

console.log('═══ 4. Summary ══════════════════════════════════════════════════════════════');
console.log(`colbert_vecs present       : yes (named output)`);
console.log(`Shape                      : [batch, seq_len, ${colbertDim}]`);
console.log(`CLS offset                 : ${offset}  (${offset === 1 ? 'CLS stripped by model output' : 'no stripping'})`);
console.log(`Token policy               : ${TOKEN_POLICY}`);
console.log(`Live query tokens (example): ${queryVecs.length}`);
console.log(`Vectors pre-normalised     : ${allOne}`);
console.log(`MaxSim ordering correct    : chunk0 scored highest → ${sorted[0].i === 0}`);
console.log();
console.log('Run ONNX_EXECUTION_PROVIDER=dml npm run bench:colbert-probe to test DirectML.');

session.release?.();
