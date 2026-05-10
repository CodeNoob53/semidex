// ONNX-based embedding for bge-m3 — produces dense + sparse vectors in one call.
// Downloads model from HuggingFace on first run (~2.3 GB), cached in ./models/ after.
// Activated by setting ONNX_EMBED=1 in .env — replaces Ollama for dense+sparse embed.
// Note: sparse output is BGE-M3 lexical token weighting, not SPLADE vocabulary expansion.

import { env, AutoTokenizer } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';
import { existsSync, mkdirSync, createWriteStream, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '../../');
const CACHE_DIR = join(ROOT, 'models');
const MODEL_ID  = 'aapot/bge-m3-onnx';
const MODEL_DIR = join(CACHE_DIR, 'bge-m3-onnx');
const HF_BASE   = 'https://huggingface.co';

// bge-m3 sentencepiece special token ids
const SPECIAL_TOKENS = new Set([0, 1, 2, 3, 250001]); // pad, bos, eos, unk, mask

env.cacheDir = CACHE_DIR;
mkdirSync(CACHE_DIR, { recursive: true });

let tokenizer = null;
let session   = null;

// Expected file sizes from HF repo (used for offline cache validation).
const EXPECTED_SIZES = {
  'model.onnx':      109_000,       // ~109 kB
  'model.onnx.data': 2_270_000_000, // ~2.27 GB
};

async function downloadFile(filename) {
  const dest = join(MODEL_DIR, filename);
  mkdirSync(MODEL_DIR, { recursive: true });

  const existingSize = existsSync(dest) ? statSync(dest).size : 0;
  const expectedSize = EXPECTED_SIZES[filename] ?? 0;

  // If file exists and is within 1% of expected size — trust the cache, no network needed.
  if (expectedSize > 0 && existingSize >= expectedSize * 0.99) {
    process.stderr.write(`[onnx] cached: ${filename} (${(existingSize / 1e6).toFixed(0)} MB)\n`);
    return;
  }

  // Try HEAD to get exact size; fall back to offline trust if network is unavailable.
  const url = `${HF_BASE}/${MODEL_ID}/resolve/main/${filename}`;
  let total = expectedSize;
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    total = parseInt(head.headers.get('content-length') ?? '0') || expectedSize;
  } catch (_) {
    if (existingSize > 0) {
      process.stderr.write(`[onnx] offline, trusting cache: ${filename} (${(existingSize / 1e6).toFixed(0)} MB)\n`);
      return;
    }
    throw new Error(`[onnx] network unavailable and ${filename} not cached`);
  }

  if (existingSize >= total) {
    process.stderr.write(`[onnx] cached: ${filename} (${(total / 1e6).toFixed(0)} MB)\n`);
    return;
  }

  if (existingSize > 0) {
    process.stderr.write(`[onnx] resuming ${filename} (${(existingSize / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)...\n`);
  } else {
    process.stderr.write(`[onnx] downloading ${filename} (${(total / 1e6).toFixed(0)} MB)...\n`);
  }
  await fetchRange(filename, dest, existingSize, total);
}

async function fetchRange(filename, dest, from, total) {
  const url     = `${HF_BASE}/${MODEL_ID}/resolve/main/${filename}`;
  const headers = from > 0 ? { Range: `bytes=${from}-` } : {};
  const res     = await fetch(url, { redirect: 'follow', headers });
  if (!res.ok && res.status !== 206) throw new Error(`Download failed: ${res.status} ${filename}`);

  let downloaded = from;
  const writer   = createWriteStream(dest, { flags: from > 0 ? 'a' : 'w' });
  const reader   = res.body.getReader();
  const write    = (chunk) => new Promise((ok, fail) => writer.write(chunk, e => e ? fail(e) : ok()));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await write(value);
    downloaded += value.length;
    if (total) process.stderr.write(`\r  ${(downloaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
  }
  await new Promise((ok, fail) => writer.end(e => e ? fail(e) : ok()));
  process.stderr.write(`\n[onnx] saved: ${filename}\n`);
}

async function load() {
  if (tokenizer && session) return;

  process.stderr.write('[onnx] loading tokenizer...\n');
  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);

  for (const file of ['model.onnx', 'model.onnx.data']) await downloadFile(file);

  const modelPath = join(MODEL_DIR, 'model.onnx');
  process.stderr.write('[onnx] creating inference session...\n');
  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  process.stderr.write(`[onnx] ready. outputs: ${session.outputNames}\n`);
}

/**
 * Embed text using bge-m3 ONNX.
 * Returns dense [1024-dim] + sparse {indices, values} in one inference call.
 * Sparse output is BGE-M3 lexical token weighting (not SPLADE expansion).
 *
 * @param {string} text
 * @returns {Promise<{ dense: number[], sparse: { indices: number[], values: number[] } }>}
 */
export async function embedOnnx(text) {
  await load();

  const encoded = await tokenizer(text, {
    padding: true,
    truncation: true,
    max_length: 8192,
    return_tensors: 'np',
  });

  const dims    = encoded.input_ids.dims;
  const toInt64 = (data) => new ort.Tensor('int64',
    BigInt64Array.from(Array.from(data).map(BigInt)), dims);

  const feeds = {
    input_ids:      toInt64(encoded.input_ids.data),
    attention_mask: toInt64(encoded.attention_mask.data),
    token_type_ids: toInt64(
      encoded.token_type_ids?.data ?? new Array(encoded.input_ids.data.length).fill(0)
    ),
  };

  const outputs = await session.run(feeds);
  const names   = session.outputNames;

  const dense     = Array.from(outputs[names[0]].data);           // dense_vecs [1, 1024]
  const sparseRaw = Array.from(outputs[names[1]].data).map(Number); // sparse_vecs [1, seq_len, 1]
  const inputIds  = Array.from(encoded.input_ids.data).map(Number);
  const attnMask  = Array.from(encoded.attention_mask.data).map(Number);

  return { dense, sparse: processSparse(sparseRaw, inputIds, attnMask) };
}

// Convert per-token weights → Qdrant sparse {indices, values}.
// Uses attention_mask to skip padding positions.
// Keeps max weight per token_id to collapse subword duplicates.
function processSparse(tokenWeights, inputIds, attnMask) {
  const best = new Map();
  for (let i = 0; i < inputIds.length; i++) {
    const id  = inputIds[i];
    const val = tokenWeights[i];
    if (attnMask[i] === 0) continue;          // padding position
    if (SPECIAL_TOKENS.has(id)) continue;     // cls, sep, pad, unk, mask
    if (val <= 0) continue;
    if (!best.has(id) || val > best.get(id)) best.set(id, val);
  }
  return { indices: [...best.keys()], values: [...best.values()] };
}

// CLI: node src/core/onnx-embed.js "your text here"
if (process.argv[2]) {
  const text = process.argv[2];
  console.log(`\nTest: "${text}"\n`);
  try {
    const { dense, sparse } = await embedOnnx(text);
    console.log(`Dense:  ${dense.length}-dim | first 5: [${dense.slice(0, 5).map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`Sparse: ${sparse.indices.length} non-zero tokens`);
    console.log(`Top-5:`, sparse.indices
      .map((idx, i) => ({ token_id: idx, weight: +sparse.values[i].toFixed(4) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)
    );
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
