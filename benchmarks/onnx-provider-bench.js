// ONNX execution provider speed benchmark.
// Measures cold session init time and warm embedding throughput for each provider.
// Does NOT use Qdrant. Requires cached ONNX model in ./models/bge-m3-onnx/.
// Usage: npm run bench:onnx-provider
//        $env:PROVIDERS='cpu,dml'; npm run bench:onnx-provider
//        $env:ONNX_BENCH_WORKLOAD='sequential|bucketed|single-batch'
// Default workload mirrors the indexer's DirectML length-bucketed path.

import 'dotenv/config';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { bucketBatches } from '../src/local/core/length-bucket.js';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '../');
const MODEL_DIR = process.env.ONNX_BENCH_MODEL_DIR
  ? join(process.env.ONNX_BENCH_MODEL_DIR)
  : join(ROOT, 'models', 'bge-m3-onnx');
const MODEL_FILE = join(MODEL_DIR, 'model.onnx');
const DATA_FILE  = join(MODEL_DIR, 'model.onnx.data');
const INPUTS_FILE = process.env.ONNX_BENCH_INPUTS
  ? join(process.env.ONNX_BENCH_INPUTS)
  : join(ROOT, '.tmp', 'onnx-provider-inputs.json');
const OUTPUT_NAMES = Object.freeze(['dense_vecs', 'sparse_vecs']);
const require = createRequire(import.meta.url);

function loadRuntime() {
  const customPath = String(process.env.ONNXRUNTIME_NODE_PATH ?? '').trim();
  if (!customPath) {
    return {
      ort: require('onnxruntime-node'),
      version: require('onnxruntime-node/package.json').version,
      runtime: 'project dependency',
    };
  }
  const modulePath = join(customPath);
  return {
    ort: require(modulePath),
    version: require(join(modulePath, 'package.json')).version,
    runtime: modulePath,
  };
}

function resolveBenchProvider(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  if (!['cpu', 'dml', 'cuda'].includes(provider)) {
    throw new Error(`Unsupported provider "${value}". Expected cpu, dml, or cuda.`);
  }
  return provider;
}

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

const WARMUP_RUNS = Number.parseInt(process.env.WARMUP_RUNS ?? '3', 10);
const BENCH_RUNS  = Number.parseInt(process.env.BENCH_RUNS ?? '3', 10);
const BENCH_BATCH_SIZE = Number.parseInt(process.env.ONNX_BENCH_BATCH_SIZE ?? '4', 10);
const BENCH_WORKLOAD = String(process.env.ONNX_BENCH_WORKLOAD ?? 'bucketed')
  .trim()
  .toLowerCase();

if (!['sequential', 'bucketed', 'single-batch'].includes(BENCH_WORKLOAD)) {
  throw new Error(
    `Unsupported ONNX_BENCH_WORKLOAD="${BENCH_WORKLOAD}". ` +
    'Expected sequential, bucketed, or single-batch.',
  );
}
if (!Number.isInteger(BENCH_BATCH_SIZE) || BENCH_BATCH_SIZE < 1) {
  throw new Error('ONNX_BENCH_BATCH_SIZE must be a positive integer.');
}

// ── Core benchmark for one provider ──────────────────────────────────────────

async function benchProvider(ort, providerEnvValue, inputs) {
  const providerList = [resolveBenchProvider(providerEnvValue)];
  const label = providerEnvValue || 'cpu';

  // Cold init
  const t0 = performance.now();
  let session;
  const strictProviderList = [providerList[0]];
  session = await ort.InferenceSession.create(MODEL_FILE, {
    executionProviders: strictProviderList,
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    enableMemPattern: false,
  });
  const initMs = performance.now() - t0;

  // Warmup — not measured
  for (let w = 0; w < WARMUP_RUNS; w++) {
    await runWorkload(ort, session, inputs.slice(0, 5));
  }

  // Measured runs
  const runTimes = [];
  let referenceOutputs = null;
  for (let r = 0; r < BENCH_RUNS; r++) {
    const t1 = performance.now();
    const outputs = await runWorkload(ort, session, inputs);
    runTimes.push(performance.now() - t1);
    if (!referenceOutputs) referenceOutputs = outputs;
  }

  session.release?.();

  const totalMs  = runTimes.reduce((a, b) => a + b, 0) / BENCH_RUNS;
  const avgPerText = totalMs / TEXTS.length;

  return {
    label,
    actualProvider: strictProviderList[0],
    initMs,
    totalMs,
    avgPerText,
    texts: inputs.length,
    outputs: referenceOutputs,
    rssMb: process.memoryUsage().rss / 1024 / 1024,
  };
}

async function runInputBatch(ort, session, inputs) {
  const sequenceLengths = inputs.map(input => input.dims[1]);
  const sequenceLength = Math.max(...sequenceLengths);
  const inputIds = [];
  const attentionMask = [];

  for (const input of inputs) {
    const paddingLength = sequenceLength - input.dims[1];
    inputIds.push(...input.inputIds, ...new Array(paddingLength).fill(1));
    attentionMask.push(...input.attentionMask, ...new Array(paddingLength).fill(0));
  }

  const dims = [inputs.length, sequenceLength];
  const toInt64 = data => new ort.Tensor(
    'int64',
    BigInt64Array.from(data, BigInt),
    dims,
  );
  const outputs = await session.run({
    input_ids: toInt64(inputIds),
    attention_mask: toInt64(attentionMask),
  }, OUTPUT_NAMES);

  const dense = Array.from(outputs.dense_vecs.data, Number);
  const sparse = Array.from(outputs.sparse_vecs.data, Number);
  return inputs.map((_, index) => ({
    dense: dense.slice(index * 1024, (index + 1) * 1024),
    sparse: sparse.slice(
      index * sequenceLength,
      index * sequenceLength + sequenceLengths[index],
    ),
  }));
}

async function runWorkload(ort, session, inputs) {
  if (BENCH_WORKLOAD === 'single-batch') {
    return runInputBatch(ort, session, inputs);
  }

  if (BENCH_WORKLOAD === 'sequential') {
    const results = [];
    for (const input of inputs) {
      results.push(...await runInputBatch(ort, session, [input]));
    }
    return results;
  }

  const batches = bucketBatches(
    inputs.map(input => input.text),
    BENCH_BATCH_SIZE,
  );
  const results = new Array(inputs.length);
  for (const batch of batches) {
    const batchOutputs = await runInputBatch(
      ort,
      session,
      batch.indices.map(index => inputs[index]),
    );
    for (let index = 0; index < batch.indices.length; index += 1) {
      results[batch.indices[index]] = batchOutputs[index];
    }
  }
  return results;
}

async function prepareInputs() {
  const { AutoTokenizer } = await import('@huggingface/transformers');
  const tokenizer = await AutoTokenizer.from_pretrained('aapot/bge-m3-onnx');
  const inputs = [];
  for (const text of TEXTS) {
    const encoded = await tokenizer(text, {
      padding: true,
      truncation: true,
      max_length: 512,
      return_tensors: 'np',
    });
    inputs.push({
      text,
      dims: encoded.input_ids.dims,
      inputIds: Array.from(encoded.input_ids.data, Number),
      attentionMask: Array.from(encoded.attention_mask.data, Number),
      tokenTypeIds: Array.from(
        encoded.token_type_ids?.data ?? new Array(encoded.input_ids.data.length).fill(0),
        Number,
      ),
    });
  }
  mkdirSync(dirname(INPUTS_FILE), { recursive: true });
  writeFileSync(INPUTS_FILE, JSON.stringify({ model: 'aapot/bge-m3-onnx', inputs }));
  console.log(`[bench] prepared ${inputs.length} tokenizer inputs: ${INPUTS_FILE}`);
}

function loadInputs() {
  if (!existsSync(INPUTS_FILE)) {
    throw new Error(
      `Tokenizer fixture is missing: ${INPUTS_FILE}\n` +
      'Run node benchmarks/onnx-provider-bench.js --prepare-inputs first.',
    );
  }
  const parsed = JSON.parse(readFileSync(INPUTS_FILE, 'utf8'));
  if (!Array.isArray(parsed.inputs) || parsed.inputs.length !== TEXTS.length) {
    throw new Error(`Invalid tokenizer fixture: expected ${TEXTS.length} inputs`);
  }
  return parsed.inputs;
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (process.argv.includes('--prepare-inputs')) {
  await prepareInputs();
  process.exit(0);
}

checkCache();
const inputs = loadInputs();
const runtimeInfo = loadRuntime();
const ort = runtimeInfo.ort;

const providersEnv = process.env.PROVIDERS ?? 'cpu';
const providerValues = providersEnv.split(',').map(s => s.trim()).filter(Boolean);

console.log(`Runtime           : onnxruntime-node ${runtimeInfo.version} (${runtimeInfo.runtime})`);
console.log(`Providers to test : ${providerValues.join(', ')}`);
console.log(`Texts per run     : ${TEXTS.length}`);
console.log(`Workload          : ${BENCH_WORKLOAD}`);
console.log(`Batch size        : ${BENCH_BATCH_SIZE}`);
console.log(`Warmup runs       : ${WARMUP_RUNS}`);
console.log(`Measured runs     : ${BENCH_RUNS} (avg reported)\n`);

const results = [];
for (const pv of providerValues) {
  process.stdout.write(`  testing ${pv}...`);
  try {
    const r = await benchProvider(ort, pv, inputs);
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
console.log(`  - Workload = ${BENCH_WORKLOAD}; batch size = ${BENCH_BATCH_SIZE}.`);
console.log(`  - Every provider is strict: this benchmark never falls back to CPU.`);
console.log(`  - Only dense_vecs and sparse_vecs are requested; ColBERT output is excluded.\n`);

const jsonOutput = String(process.env.BENCH_JSON_OUT ?? '').trim();
if (jsonOutput) {
  mkdirSync(dirname(jsonOutput), { recursive: true });
  writeFileSync(jsonOutput, JSON.stringify({
    generatedAt: new Date().toISOString(),
    runtime: {
      version: runtimeInfo.version,
      source: runtimeInfo.runtime,
    },
    modelDir: MODEL_DIR,
    warmupRuns: WARMUP_RUNS,
    benchRuns: BENCH_RUNS,
    workload: BENCH_WORKLOAD,
    batchSize: BENCH_BATCH_SIZE,
    results,
  }));
  console.log(`[bench] JSON written: ${jsonOutput}`);
}
