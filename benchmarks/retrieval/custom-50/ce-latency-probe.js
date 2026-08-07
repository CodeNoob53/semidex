// Clean single-process CE latency probe.
// Reports: model load time, pure CE inference time for N pairs, full query p50/p95.
//
// Requires: bench-retrieval-custom-50 collection already indexed (run cross-encoder-bench.js first,
//           or set BENCH_SKIP_INDEX=1 if collection exists).
//
// Run: ONNX_EMBED=1 CE_DTYPE=q4 CE_MODEL=ONNX-community/bge-reranker-v2-m3-ONNX
//      node benchmarks/retrieval/custom-50/ce-latency-probe.js

import 'dotenv/config';
import { AutoTokenizer, AutoModelForSequenceClassification, env as hfEnv } from '@huggingface/transformers';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hybridSearch } from '../../../src/shared/core/qdrant.js';
import { embedForSearch } from '../../../src/shared/core/embeddings.js';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { resolveBenchProfile } from '../../lib/resolve-profile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
hfEnv.cacheDir = resolve(__dirname, '../../../models');

const COLLECTION = 'bench-retrieval-custom-50';
const CE_MODEL   = process.env.CE_MODEL ?? 'ONNX-community/bge-reranker-v2-m3-ONNX';
const CE_DTYPE   = process.env.CE_DTYPE ?? 'q4';
const CE_INPUT   = process.env.CE_INPUT ?? 'text+meta';
const TOP_K      = 10;
const MULT       = 4;
const CANDIDATE_N = TOP_K * MULT; // 40
const WARMUP_REPS = 2;
const MEASURE_REPS = 8;

// Representative queries covering different types
const PROBE_QUERIES = [
  'як увімкнути bge-m3-onnx без Ollama',
  'chunkFile splitSentences parseMarkdown location in source',
  'HYBRID_PREFETCH_LIMIT prefetch per RRF leg',
  'що таке SOURCE_ROOT і навіщо він потрібен при індексації',
  'MRR@10 chunkRecall benchmark v3',
];

function buildPassage(p) {
  if (CE_INPUT === 'text+section') return `${p.section ?? ''}\n${p.text ?? ''}`;
  if (CE_INPUT === 'text+meta')    return `${p.source_file ?? ''} ${p.section ?? ''}\n${p.text ?? ''}`;
  return p.text ?? '';
}

// ── 1. Model load ─────────────────────────────────────────────────────────────

process.stdout.write(`\n=== CE latency probe ===\n`);
process.stdout.write(`CE_MODEL  : ${CE_MODEL}\n`);
process.stdout.write(`CE_DTYPE  : ${CE_DTYPE}\n`);
process.stdout.write(`CE_INPUT  : ${CE_INPUT}\n`);
process.stdout.write(`Candidates: ${CANDIDATE_N}\n\n`);

process.stdout.write('[1/4] Loading tokenizer...\n');
const t0 = Date.now();
const tokenizer = await AutoTokenizer.from_pretrained(CE_MODEL);
const tokMs = Date.now() - t0;
process.stdout.write(`  tokenizer: ${tokMs}ms\n`);

process.stdout.write(`[2/4] Loading model (dtype=${CE_DTYPE})...\n`);
const t1 = Date.now();
const model = await AutoModelForSequenceClassification.from_pretrained(CE_MODEL, { dtype: CE_DTYPE });
const modelMs = Date.now() - t1;
process.stdout.write(`  model    : ${modelMs}ms\n`);
process.stdout.write(`  total load: ${tokMs + modelMs}ms\n`);

const probe = tokenizer(['q'], { text_pair: ['p'], truncation: true, max_length: 16, return_tensors: 'pt', padding: true });
const { logits: pl } = await model(probe);
const numLabels = pl.dims[1];
process.stdout.write(`  numLabels: ${numLabels}\n`);

// ── 2. Embed all probe queries (done once, not counted in CE latency) ─────────

process.stdout.write('\nResolving embedding profile...\n');
const storageAdapter = createStorageAdapter();
const PROFILE = await resolveBenchProfile(storageAdapter, COLLECTION, { vectorSize: 1024 });

process.stdout.write('\n[3/4] Embedding probe queries (ONNX embedder)...\n');
const embeds = [];
for (const q of PROBE_QUERIES) {
  const t = Date.now();
  const emb = await embedForSearch(PROFILE, q);
  embeds.push({ query: q, ...emb });
  process.stdout.write(`  "${q.slice(0,50)}"  ${Date.now()-t}ms\n`);
}

// Fetch candidate pools for all queries
process.stdout.write('\n  Fetching candidate pools from Qdrant...\n');
const pools = [];
for (const e of embeds) {
  const candidates = await hybridSearch(COLLECTION, e.dense, e.sparse, CANDIDATE_N);
  pools.push({ query: e.query, candidates });
  process.stdout.write(`  "${e.query.slice(0,40)}" → ${candidates.length} candidates\n`);
}

// ── 3. Pure CE inference timing ───────────────────────────────────────────────

process.stdout.write('\n[4/4] Timing CE inference...\n');

async function inferOnce(query, candidates) {
  const BATCH = 16;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch    = candidates.slice(i, i + BATCH);
    const queries  = batch.map(() => query);
    const passages = batch.map(r => buildPassage(r.payload));
    const inputs   = tokenizer(queries, {
      text_pair: passages, truncation: true, max_length: 512,
      return_tensors: 'pt', padding: true,
    });
    await model(inputs);
  }
}

// Warmup
process.stdout.write(`  Warmup (${WARMUP_REPS} reps)...\n`);
for (let r = 0; r < WARMUP_REPS; r++) {
  const { query, candidates } = pools[r % pools.length];
  await inferOnce(query, candidates);
}

// Measurement: cycle through all queries
process.stdout.write(`  Measuring (${MEASURE_REPS} reps)...\n`);
const inferTimes = [];
for (let r = 0; r < MEASURE_REPS; r++) {
  const { query, candidates } = pools[r % pools.length];
  const t = Date.now();
  await inferOnce(query, candidates);
  inferTimes.push(Date.now() - t);
  process.stdout.write(`    rep ${r+1}: ${inferTimes.at(-1)}ms\n`);
}

inferTimes.sort((a, b) => a - b);
const p50inf = inferTimes[Math.floor(inferTimes.length * 0.50)];
const p95inf = inferTimes[Math.floor(inferTimes.length * 0.95)];
const avgInf = Math.round(inferTimes.reduce((s, v) => s + v, 0) / inferTimes.length);
process.stdout.write(`\n  CE-inference-only p50=${p50inf}ms  p95=${p95inf}ms  avg=${avgInf}ms  (${CANDIDATE_N} candidates)\n`);

// ── 4. Full query round-trip (embed + Qdrant + CE) ────────────────────────────

process.stdout.write('\n  Full round-trip (embed + Qdrant + CE)...\n');
const roundTripTimes = [];
for (const { query } of pools) {
  const t = Date.now();
  const emb = await embedForSearch(PROFILE, query);
  const candidates = await hybridSearch(COLLECTION, emb.dense, emb.sparse, CANDIDATE_N);
  await inferOnce(query, candidates);
  roundTripTimes.push(Date.now() - t);
  process.stdout.write(`  "${query.slice(0,45)}"  ${roundTripTimes.at(-1)}ms\n`);
}

roundTripTimes.sort((a, b) => a - b);
const p50rt = roundTripTimes[Math.floor(roundTripTimes.length * 0.50)];
const p95rt = roundTripTimes[Math.floor(roundTripTimes.length * 0.95)];

process.stdout.write(`\n=== SUMMARY ===\n`);
process.stdout.write(`Model load (tok + model)  : ${tokMs + modelMs}ms\n`);
process.stdout.write(`CE inference only  p50    : ${p50inf}ms  (${CANDIDATE_N} candidates, ${MEASURE_REPS} reps)\n`);
process.stdout.write(`CE inference only  p95    : ${p95inf}ms\n`);
process.stdout.write(`Full round-trip    p50    : ${p50rt}ms  (embed + Qdrant + CE, ${pools.length} queries)\n`);
process.stdout.write(`Full round-trip    p95    : ${p95rt}ms\n`);
process.stdout.write(`CE_MODEL  : ${CE_MODEL}  dtype=${CE_DTYPE}\n`);
process.stdout.write(`CE_INPUT  : ${CE_INPUT}\n`);
