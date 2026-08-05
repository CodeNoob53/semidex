/**
 * ONNX batch indexing benchmark.
 *
 * Compares three embedding strategies on a real fixture corpus:
 *   1. Sequential  — embedOnnx() called one text at a time
 *   2. Naive batch — embedOnnxBatch() with a fixed batch size (no bucketing)
 *   3. Bucketed    — embedBucketed() using length-bucketed batches
 *
 * Prints: text count, token-length distribution, per-bucket batch counts,
 *         total ms, ms/text, speedup vs sequential, max dense/sparse delta
 *         vs sequential baseline.
 *
 * Usage:
 *   node benchmarks/onnx-batch-indexing-bench.js [--batch-size N] [--naive-batch-size N]
 *
 * Requires ONNX_EMBED=1 in .env (or pass via env directly).
 */

import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(ROOT, 'benchmarks/retrieval/custom-50/fixtures/docs');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : def;
}
const BUCKETED_MAX_BATCH = argVal('--batch-size', 8);
const NAIVE_BATCH_SIZE   = argVal('--naive-batch-size', 8);

// ── Corpus loading ────────────────────────────────────────────────────────────
function loadCorpus() {
  const texts = [];
  const files = readdirSync(DOCS_DIR).filter(f => f.endsWith('.md')).sort();
  for (const file of files) {
    const raw = readFileSync(join(DOCS_DIR, file), 'utf-8');
    // Split on blank lines (same heuristic as paragraph chunker).
    const chunks = raw.split(/\n\n+/).map(s => s.trim()).filter(s => s.length > 0);
    texts.push(...chunks);
    process.stderr.write(`  ${file}: ${chunks.length} chunks\n`);
  }
  return texts;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function maxDelta(dense1, dense2) {
  let max = 0;
  for (let i = 0; i < dense1.length; i++) max = Math.max(max, Math.abs(dense1[i] - dense2[i]));
  return max;
}

function sparseOverlap(s1, s2) {
  const m1 = new Map(s1.indices.map((id, i) => [id, s1.values[i]]));
  const m2 = new Map(s2.indices.map((id, i) => [id, s2.values[i]]));
  const allKeys = new Set([...m1.keys(), ...m2.keys()]);
  let maxDiff = 0;
  for (const k of allKeys) {
    maxDiff = Math.max(maxDiff, Math.abs((m1.get(k) ?? 0) - (m2.get(k) ?? 0)));
  }
  return maxDiff;
}

function tokenLengthDist(texts, estimateTokens) {
  const buckets = { '1-16': 0, '17-32': 0, '33-64': 0, '65-128': 0, '129-256': 0, '>256': 0 };
  for (const t of texts) {
    const tok = estimateTokens(t);
    if      (tok <= 16)  buckets['1-16']++;
    else if (tok <= 32)  buckets['17-32']++;
    else if (tok <= 64)  buckets['33-64']++;
    else if (tok <= 128) buckets['65-128']++;
    else if (tok <= 256) buckets['129-256']++;
    else                 buckets['>256']++;
  }
  return buckets;
}

// ── Timing wrapper ────────────────────────────────────────────────────────────
async function timed(label, fn) {
  process.stderr.write(`\n[bench] running: ${label}...\n`);
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  return { label, ms, result };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.ONNX_EMBED) {
    console.error('[bench] ONNX_EMBED is not set. Set ONNX_EMBED=1 in .env or environment.');
    process.exit(1);
  }

  const { embedOnnx, embedOnnxBatch } = await import('../src/local/core/onnx-embed.js');
  const { estimateTokens, bucketBatches, BUCKET_BOUNDARIES, embedBucketed }
    = await import('./lib/length-bucket.js');

  // ── Load corpus ──
  console.log('\n=== ONNX Batch Indexing Benchmark ===\n');
  console.log('Loading corpus...');
  const texts = loadCorpus();
  const N = texts.length;
  console.log(`\nTotal texts: ${N}`);
  console.log(`Naive batch size: ${NAIVE_BATCH_SIZE}`);
  console.log(`Bucketed max batch size: ${BUCKETED_MAX_BATCH}`);

  // ── Token length distribution ──
  const dist = tokenLengthDist(texts, estimateTokens);
  console.log('\nToken-length distribution (estimated, chars/4):');
  for (const [range, count] of Object.entries(dist)) {
    const pct = ((count / N) * 100).toFixed(1);
    console.log(`  ${range.padEnd(8)} : ${String(count).padStart(4)}  (${pct}%)`);
  }

  // ── Per-bucket batch counts (bucketed strategy) ──
  const batches = bucketBatches(texts, BUCKETED_MAX_BATCH);
  const bucketLabels = ['<=16', '<=32', '<=64', '<=128', '<=256', '>256'];
  const batchesPerBucket = Array(BUCKET_BOUNDARIES.length).fill(0);
  const textsPerBucket   = Array(BUCKET_BOUNDARIES.length).fill(0);
  // Recompute to get per-bucket breakdown.
  {
    const tmpBuckets = Array.from({ length: BUCKET_BOUNDARIES.length }, () => []);
    for (let i = 0; i < texts.length; i++) {
      const tok = estimateTokens(texts[i]);
      let bi = 0;
      for (; bi < BUCKET_BOUNDARIES.length; bi++) if (tok <= BUCKET_BOUNDARIES[bi]) break;
      if (bi >= BUCKET_BOUNDARIES.length) bi = BUCKET_BOUNDARIES.length - 1;
      tmpBuckets[bi].push(i);
    }
    for (let bi = 0; bi < BUCKET_BOUNDARIES.length; bi++) {
      textsPerBucket[bi]   = tmpBuckets[bi].length;
      batchesPerBucket[bi] = Math.ceil(tmpBuckets[bi].length / BUCKETED_MAX_BATCH);
    }
  }
  console.log(`\nBucketed strategy (maxBatch=${BUCKETED_MAX_BATCH}) — batch counts per bucket:`);
  for (let bi = 0; bi < BUCKET_BOUNDARIES.length; bi++) {
    if (textsPerBucket[bi] === 0) continue;
    console.log(`  ${bucketLabels[bi].padEnd(6)} : ${textsPerBucket[bi]} texts → ${batchesPerBucket[bi]} batch(es)`);
  }
  console.log(`  Total batches: ${batches.length}`);

  // ── Warm-up (load ONNX model once) ──
  console.log('\nWarming up ONNX session (first call loads model)...');
  const warmupText = texts[0];
  await embedOnnx(warmupText);
  console.log('Warm-up complete.');

  // ── Run 1: Sequential ──
  const seq = await timed('sequential', async () => {
    const results = [];
    for (const text of texts) results.push(await embedOnnx(text));
    return results;
  });

  // ── Run 2: Naive batching ──
  const naive = await timed(`naive-batch (size=${NAIVE_BATCH_SIZE})`, async () => {
    const results = new Array(N);
    for (let start = 0; start < N; start += NAIVE_BATCH_SIZE) {
      const slice   = texts.slice(start, start + NAIVE_BATCH_SIZE);
      const bResult = await embedOnnxBatch(slice);
      for (let i = 0; i < bResult.length; i++) results[start + i] = bResult[i];
    }
    return results;
  });

  // ── Run 3: Bucketed batching ──
  const bucketed = await timed(`bucketed (maxBatch=${BUCKETED_MAX_BATCH})`, async () => {
    return embedBucketed(texts, embedOnnxBatch, BUCKETED_MAX_BATCH);
  });

  // ── Correctness check vs sequential ──
  function checkDelta(label, results) {
    let maxDense = 0, maxSparse = 0, totalCos = 0;
    for (let i = 0; i < N; i++) {
      maxDense  = Math.max(maxDense,  maxDelta(seq.result[i].dense,   results[i].dense));
      maxSparse = Math.max(maxSparse, sparseOverlap(seq.result[i].sparse, results[i].sparse));
      totalCos += cosineSim(seq.result[i].dense, results[i].dense);
    }
    const avgCos = totalCos / N;
    return { label, maxDense, maxSparse, avgCos };
  }

  const naiveDelta    = checkDelta(`naive-batch (size=${NAIVE_BATCH_SIZE})`, naive.result);
  const bucketedDelta = checkDelta(`bucketed (maxBatch=${BUCKETED_MAX_BATCH})`, bucketed.result);

  // ── Report ──
  console.log('\n' + '─'.repeat(60));
  console.log('TIMING RESULTS');
  console.log('─'.repeat(60));
  const rows = [seq, naive, bucketed];
  for (const r of rows) {
    const msPerText = (r.ms / N).toFixed(1);
    const speedup   = (seq.ms / r.ms).toFixed(2);
    console.log(`  ${r.label}`);
    console.log(`    total: ${r.ms} ms   ms/text: ${msPerText}   speedup: ${speedup}x`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('CORRECTNESS vs SEQUENTIAL');
  console.log('─'.repeat(60));
  for (const d of [naiveDelta, bucketedDelta]) {
    const bitIdentical = d.maxDense === 0 && d.maxSparse === 0;
    console.log(`  ${d.label}`);
    console.log(`    max dense delta:  ${d.maxDense.toExponential(3)}`);
    console.log(`    max sparse delta: ${d.maxSparse.toExponential(3)}`);
    console.log(`    avg cosine sim:   ${d.avgCos.toFixed(6)}`);
    console.log(`    bit-identical:    ${bitIdentical ? 'YES' : 'NO (floating point — expected for different batch padding)'}`);
  }

  console.log('\n' + '─'.repeat(60));
}

main().catch(e => { console.error(e); process.exit(1); });
