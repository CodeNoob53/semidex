// ONNX execution provider speed benchmark.
// Measures cold session init time and warm embedding throughput for each provider.
// Does NOT use Qdrant. Requires cached ONNX model in ./models/bge-m3-onnx/.
// Usage: npm run bench:onnx-provider
//        PROVIDERS=cpu,dml npm run bench:onnx-provider

import 'dotenv/config';
import * as ort from 'onnxruntime-node';
import { AutoTokenizer } from '@huggingface/transformers';
import { existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveOnnxExecutionProviders } from '../src/core/onnx-embed.js';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '../');
const MODEL_DIR = join(ROOT, 'models', 'bge-m3-onnx');
const MODEL_FILE = join(MODEL_DIR, 'model.onnx');
const DATA_FILE  = join(MODEL_DIR, 'model.onnx.data');

// ── Guard: cached model required ─────────────────────────────────────────────

function checkCache() {
  const missing = [MODEL_FILE, DATA_FILE].filter(f => !existsSync(f));
  if (missing.length) {
    console.error('\nONNX model not cached. Run ONNX_EMBED=1 indexing once to download it:');
    console.error('  ONNX_EMBED=1 COLLECTION=any npm run index <any-file>');
    console.error('\nMissing:', missing.map(f => f.replace(ROOT, '')).join(', '));
    process.exit(1);
  }
  const dataSize = (statSync(DATA_FILE).size / 1e9).toFixed(2);
  console.log(`[bench] model cache ok  (data file: ${dataSize} GB)`);
}

// ── Texts ─────────────────────────────────────────────────────────────────────

const TEXTS = [
  // short
  'What is a vector database?',
  'How does hybrid search work?',
  'Explain RRF fusion in one sentence.',
  'What is sparse embedding?',
  'Define context window.',
  'What is BGE-M3?',
  'How does semidex index PDFs?',
  'What is PRUNE_STALE?',
  // medium
  'Explain the difference between dense and sparse embeddings and when each is more useful for retrieval tasks.',
  'What are the trade-offs between overlapping and non-overlapping text chunks in a RAG pipeline?',
  'How does contextual retrieval improve embedding quality for isolated code snippets?',
  'Describe how RRF (Reciprocal Rank Fusion) combines dense and sparse rankings without mixing raw scores.',
  'What are payload indexes in Qdrant and why are source_file, tags, and chunk_index required?',
  // longer
  'Semidex is a local-first RAG memory system that turns documents and notes into a searchable memory layer. It uses Qdrant for vector storage, BGE-M3 for dense and sparse embeddings, and an LLM to generate context summaries before embedding.',
  'The recursive text chunker splits plain text first by paragraph boundaries, then by sentence boundaries for oversized paragraphs, and finally by word boundaries for sentences that still exceed the token budget. This ensures no content is dropped regardless of structure.',
  'When ONNX_EMBED=1 is set, semidex uses bge-m3-onnx for both dense and sparse embedding in a single inference call. The sparse output is BGE-M3 lexical token weighting, not SPLADE vocabulary expansion. This is the recommended production mode.',
  // multilingual / mixed
  'Як працює гібридний пошук у semidex?',
  'Що таке контекстуалізація чанків і навіщо вона потрібна?',
  'BGE-M3 підтримує багатомовні запити через нейронне розріджене зважування токенів.',
  // technical tokens
  'ONNX_EMBED DENSE_PROVIDER SPARSE_PROVIDER embeddingSchemaVersion vectorSize PRUNE_STALE SOURCE_ROOT MAX_CHUNK_TOKENS',
];

const WARMUP_RUNS = 3;
const BENCH_RUNS  = 3;

// ── Core benchmark for one provider ──────────────────────────────────────────

async function benchProvider(providerEnvValue, tokenizer) {
  const providerList = resolveOnnxExecutionProviders(providerEnvValue);
  const label = providerEnvValue || 'cpu';

  // Cold init
  const t0 = performance.now();
  let session;
  let actualProvider = providerList[0];
  try {
    session = await ort.InferenceSession.create(MODEL_FILE, {
      executionProviders: providerList,
      graphOptimizationLevel: 'all',
    });
  } catch (err) {
    if (providerList[0] === 'cuda') {
      process.stderr.write(`[bench] ${label}: CUDA unavailable (${err.message}) — retrying with cpu\n`);
      session = await ort.InferenceSession.create(MODEL_FILE, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      actualProvider = 'cpu (fallback)';
    } else {
      throw err;
    }
  }
  const initMs = performance.now() - t0;

  // Warmup — not measured
  for (let w = 0; w < WARMUP_RUNS; w++) {
    await embedBatch(session, tokenizer, TEXTS.slice(0, 5));
  }

  // Measured runs
  const runTimes = [];
  for (let r = 0; r < BENCH_RUNS; r++) {
    const t1 = performance.now();
    await embedBatch(session, tokenizer, TEXTS);
    runTimes.push(performance.now() - t1);
  }

  session.release?.();

  const totalMs  = runTimes.reduce((a, b) => a + b, 0) / BENCH_RUNS;
  const avgPerText = totalMs / TEXTS.length;

  return { label, actualProvider, initMs, totalMs, avgPerText, texts: TEXTS.length };
}

async function embedBatch(session, tokenizer, texts) {
  for (const text of texts) {
    const encoded = await tokenizer(text, {
      padding: true, truncation: true, max_length: 512, return_tensors: 'np',
    });
    const dims    = encoded.input_ids.dims;
    const toInt64 = d => new ort.Tensor('int64', BigInt64Array.from(Array.from(d).map(BigInt)), dims);
    await session.run({
      input_ids:      toInt64(encoded.input_ids.data),
      attention_mask: toInt64(encoded.attention_mask.data),
      token_type_ids: toInt64(encoded.token_type_ids?.data ?? new Array(encoded.input_ids.data.length).fill(0)),
    });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

checkCache();

const MODEL_ID = 'aapot/bge-m3-onnx';
console.log('[bench] loading tokenizer...');
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
console.log('[bench] tokenizer ready\n');

const providersEnv = process.env.PROVIDERS ?? 'cpu,dml,cuda';
const providerValues = providersEnv.split(',').map(s => s.trim()).filter(Boolean);

console.log(`Providers to test : ${providerValues.join(', ')}`);
console.log(`Texts per run     : ${TEXTS.length}`);
console.log(`Warmup runs       : ${WARMUP_RUNS}`);
console.log(`Measured runs     : ${BENCH_RUNS} (avg reported)\n`);

const results = [];
for (const pv of providerValues) {
  process.stdout.write(`  testing ${pv}...`);
  try {
    const r = await benchProvider(pv, tokenizer);
    results.push(r);
    process.stdout.write(` done (${r.totalMs.toFixed(0)} ms)\n`);
  } catch (err) {
    process.stdout.write(` FAILED: ${err.message}\n`);
    results.push({ label: pv, actualProvider: 'failed', initMs: 0, totalMs: 0, avgPerText: 0, texts: 0, error: err.message });
  }
}

// ── Results table ─────────────────────────────────────────────────────────────

const date = new Date().toISOString().slice(0, 10);
console.log(`\n${'─'.repeat(72)}`);
console.log(`ONNX Execution Provider Benchmark  —  ${date}`);
console.log(`${'─'.repeat(72)}`);
console.log(
  'Provider'.padEnd(8),
  'Actual backend'.padEnd(20),
  'Init (ms)'.padStart(10),
  'Total (ms)'.padStart(12),
  'ms/text'.padStart(9),
  'vs cpu'.padStart(8),
);
console.log('─'.repeat(72));

const cpuResult = results.find(r => r.label === 'cpu' && !r.error);

for (const r of results) {
  if (r.error) {
    console.log(
      r.label.padEnd(8),
      'FAILED'.padEnd(20),
      ''.padStart(10), ''.padStart(12), ''.padStart(9),
      r.error.slice(0, 20).padStart(8),
    );
    continue;
  }
  const vsCol = cpuResult && r.label !== 'cpu' && r.totalMs > 0
    ? `${(cpuResult.totalMs / r.totalMs).toFixed(2)}x`
    : (r.label === 'cpu' ? '(baseline)' : '—');
  console.log(
    r.label.padEnd(8),
    r.actualProvider.padEnd(20),
    r.initMs.toFixed(0).padStart(10),
    r.totalMs.toFixed(0).padStart(12),
    r.avgPerText.toFixed(1).padStart(9),
    vsCol.padStart(8),
  );
}
console.log('─'.repeat(72));
console.log(`\nNotes:`);
console.log(`  - Init time = cold session creation (not amortised over multiple embeds).`);
console.log(`  - Total/avg = average over ${BENCH_RUNS} measured runs of ${TEXTS.length} texts each.`);
console.log(`  - GPU providers are performance-only; embeddings are semantically equivalent.`);
console.log(`  - Switching provider does not require reindexing.`);
console.log(`  - dml fallback: onnxruntime-node includes DirectML on Windows; CPU fallback is automatic.`);
console.log(`  - cuda fallback: not bundled in onnxruntime-node; falls back to CPU automatically.\n`);
