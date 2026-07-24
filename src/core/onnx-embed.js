// ONNX-based embedding for bge-m3 — produces dense + sparse vectors in one call.
// Downloads model from HuggingFace on first run (~2.3 GB), cached in ./models/ after.
// Activated by setting ONNX_EMBED=1 in .env — replaces Ollama for dense+sparse embed.
// Note: sparse output is BGE-M3 lexical token weighting, not SPLADE vocabulary expansion.

import { Tokenizer } from '@huggingface/tokenizers';
import { existsSync, mkdirSync, createWriteStream, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { ONNX_CACHE_DIR as CACHE_DIR, ONNX_MODEL_DIR as MODEL_DIR, ONNX_DENSE_MODEL_ID } from './onnx-paths.js';
import { isCudaStrict, buildCudaStrictError } from './doctor-checks.js';
import { loadOnnxRuntime } from './onnx-runtime.js';

// Re-exported for backward compatibility — the canonical declaration now
// lives in onnx-paths.js (a dependency-free module), so consumers that
// don't need this file's heavy onnxruntime-node/@huggingface/transformers
// imports (e.g. the settings registry) can import the id without them.
export { ONNX_DENSE_MODEL_ID };
const HF_BASE   = 'https://huggingface.co';
const ort = loadOnnxRuntime();
const TOKENIZER_DIR = join(CACHE_DIR, ...ONNX_DENSE_MODEL_ID.split('/'));

// bge-m3 sentencepiece special token ids
const SPECIAL_TOKENS = new Set([0, 1, 2, 3, 250001]); // pad, bos, eos, unk, mask

let tokenizer    = null;
let session      = null;
let _loadPromise = null;

// Expected file sizes from HF repo (used for offline cache validation).
const EXPECTED_SIZES = {
  'model.onnx':      109_000,       // ~109 kB
  'model.onnx.data': 2_270_000_000, // ~2.27 GB
  'tokenizer.json':  17_082_821,
  'tokenizer_config.json': 1_173,
};

async function downloadFile(filename, targetDir = MODEL_DIR) {
  const dest = join(targetDir, filename);
  mkdirSync(targetDir, { recursive: true });

  const existingSize = existsSync(dest) ? statSync(dest).size : 0;
  const expectedSize = EXPECTED_SIZES[filename] ?? 0;

  // If file exists and is within 1% of expected size — trust the cache, no network needed.
  if (expectedSize > 0 && existingSize >= expectedSize * 0.99) {
    process.stderr.write(`[onnx] cached: ${filename} (${(existingSize / 1e6).toFixed(0)} MB)\n`);
    return;
  }

  // Try HEAD to get exact size; fall back to offline trust if network is unavailable.
  const url = `${HF_BASE}/${ONNX_DENSE_MODEL_ID}/resolve/main/${filename}`;
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
  const url     = `${HF_BASE}/${ONNX_DENSE_MODEL_ID}/resolve/main/${filename}`;
  const headers = from > 0 ? { Range: `bytes=${from}-` } : {};
  const res     = await fetch(url, { redirect: 'follow', headers });
  if (!res.ok && res.status !== 206) throw new Error(`Download failed: ${res.status} ${filename}`);

  // Server ignored Range header and returned the full file — restart from scratch.
  let actualFrom = from;
  if (from > 0 && res.status === 200) {
    process.stderr.write(`[onnx] server returned 200 instead of 206 for ${filename} — restarting download\n`);
    actualFrom = 0;
  }

  let downloaded = actualFrom;
  const writer   = createWriteStream(dest, { flags: actualFrom > 0 ? 'a' : 'w' });
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

  if (total > 0 && downloaded !== total) {
    throw new Error(`[onnx] ${filename}: expected ${total} bytes, got ${downloaded} — cache may be corrupt, retry`);
  }
}

const VALID_PROVIDERS = new Set(['cpu', 'dml', 'cuda']);
const RETRIEVAL_OUTPUT_NAMES = Object.freeze(['dense_vecs', 'sparse_vecs']);
const MAX_SEQUENCE_LENGTH = 8192;
const PAD_TOKEN_ID = 1;
const EOS_TOKEN_ID = 2;

export function truncateTokenizerEncoding(encoding, maxLength = MAX_SEQUENCE_LENGTH) {
  const ids = Array.from(encoding.ids, Number);
  const attentionMask = Array.from(encoding.attention_mask ?? new Array(ids.length).fill(1), Number);
  const tokenTypeIds = Array.from(encoding.token_type_ids ?? new Array(ids.length).fill(0), Number);

  if (ids.length <= maxLength) {
    return { ids, attentionMask, tokenTypeIds };
  }

  const truncatedIds = ids.slice(0, maxLength);
  const truncatedAttentionMask = attentionMask.slice(0, maxLength);
  const truncatedTokenTypeIds = tokenTypeIds.slice(0, maxLength);
  if (ids.at(-1) === EOS_TOKEN_ID) {
    truncatedIds[maxLength - 1] = EOS_TOKEN_ID;
    truncatedAttentionMask[maxLength - 1] = 1;
    truncatedTokenTypeIds[maxLength - 1] = tokenTypeIds.at(-1) ?? 0;
  }
  return {
    ids: truncatedIds,
    attentionMask: truncatedAttentionMask,
    tokenTypeIds: truncatedTokenTypeIds,
  };
}

export function buildTokenizerBatch(encodings, maxLength = MAX_SEQUENCE_LENGTH) {
  const normalized = encodings.map((encoding) => truncateTokenizerEncoding(encoding, maxLength));
  const sequenceLength = Math.max(...normalized.map((encoding) => encoding.ids.length));
  const inputIds = [];
  const attentionMask = [];
  const tokenTypeIds = [];

  for (const encoding of normalized) {
    const paddingLength = sequenceLength - encoding.ids.length;
    inputIds.push(...encoding.ids, ...new Array(paddingLength).fill(PAD_TOKEN_ID));
    attentionMask.push(...encoding.attentionMask, ...new Array(paddingLength).fill(0));
    tokenTypeIds.push(...encoding.tokenTypeIds, ...new Array(paddingLength).fill(0));
  }

  return {
    dims: [normalized.length, sequenceLength],
    inputIds,
    attentionMask,
    tokenTypeIds,
  };
}

function encodeTexts(texts) {
  return buildTokenizerBatch(
    texts.map((text) => tokenizer.encode(text, { return_token_type_ids: true })),
  );
}

// Resolve ONNX execution provider list from env value.
// Returns an array suitable for onnxruntime executionProviders option.
// - unset / 'cpu'  → ['cpu']
// - 'dml'          → ['dml', 'cpu']  (DirectML with CPU fallback)
// - 'cuda'         → ['cuda']        (caller handles retry on failure)
// - anything else  → ['cpu'] + stderr warning
export function resolveOnnxExecutionProviders(envValue) {
  const val = (envValue ?? '').trim().toLowerCase();
  if (!val || val === 'cpu') return ['cpu'];
  if (!VALID_PROVIDERS.has(val)) {
    process.stderr.write(`[onnx] ONNX_EXECUTION_PROVIDER="${envValue}" is not recognised — falling back to cpu\n`);
    return ['cpu'];
  }
  if (val === 'dml') return ['dml', 'cpu'];
  if (val === 'cuda') return ['cuda'];
  return ['cpu'];
}

async function _doLoad() {
  mkdirSync(CACHE_DIR, { recursive: true });
  process.stderr.write('[onnx] loading tokenizer...\n');
  for (const file of ['tokenizer.json', 'tokenizer_config.json']) {
    await downloadFile(file, TOKENIZER_DIR);
  }
  tokenizer = new Tokenizer(
    JSON.parse(readFileSync(join(TOKENIZER_DIR, 'tokenizer.json'), 'utf-8')),
    JSON.parse(readFileSync(join(TOKENIZER_DIR, 'tokenizer_config.json'), 'utf-8')),
  );

  for (const file of ['model.onnx', 'model.onnx.data']) await downloadFile(file);

  const modelPath = join(MODEL_DIR, 'model.onnx');
  const providers = resolveOnnxExecutionProviders(process.env.ONNX_EXECUTION_PROVIDER);
  process.stderr.write(`[onnx] creating inference session (providers: ${providers.join(', ')})...\n`);

  try {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    });
  } catch (err) {
    // CUDA is not bundled in onnxruntime-node — retry with CPU, or hard-fail in strict mode.
    if (providers[0] === 'cuda') {
      const rawMsg = String(err?.message ?? '').replace(/\r?\n.*/s, '').trim().slice(0, 120);
      if (isCudaStrict(process.env)) {
        throw new Error(buildCudaStrictError(rawMsg, process.platform));
      }
      process.stderr.write(`[onnx] CUDA provider unavailable (${rawMsg}) — retrying with cpu\n`);
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      process.stderr.write('[onnx] session created with cpu fallback\n');
    } else {
      throw err;
    }
  }

  const missingOutputs = RETRIEVAL_OUTPUT_NAMES.filter((name) => !session.outputNames.includes(name));
  if (missingOutputs.length > 0) {
    throw new Error(`[onnx] model is missing required retrieval outputs: ${missingOutputs.join(', ')}`);
  }
  process.stderr.write(`[onnx] ready. outputs: ${session.outputNames}\n`);
}

async function load() {
  if (!_loadPromise) _loadPromise = _doLoad().catch(e => { _loadPromise = null; throw e; });
  return _loadPromise;
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

  const encoded = encodeTexts([text]);

  const dims    = encoded.dims;
  const toInt64 = (data) => new ort.Tensor('int64',
    BigInt64Array.from(Array.from(data).map(BigInt)), dims);

  const feeds = {
    input_ids:      toInt64(encoded.inputIds),
    attention_mask: toInt64(encoded.attentionMask),
    token_type_ids: toInt64(encoded.tokenTypeIds),
  };

  // Fetch only retrieval outputs. BGE-M3's ColBERT tensor is
  // [batch, sequence, 1024] and can consume gigabytes for long inputs.
  const outputs = await session.run(feeds, RETRIEVAL_OUTPUT_NAMES);

  const dense     = Array.from(outputs.dense_vecs.data);           // dense_vecs [1, 1024]
  const sparseRaw = Array.from(outputs.sparse_vecs.data).map(Number); // sparse_vecs [1, seq_len, 1]
  const inputIds  = encoded.inputIds;
  const attnMask  = encoded.attentionMask;

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

/**
 * Embed a batch of texts using bge-m3 ONNX in one inference call.
 * Returns an array aligned to the input order.
 * dense stride  : 1024
 * sparse stride : input seqLen (dims[1])
 *
 * Not used by the production indexer by default. Benchmark/opt-in only.
 *
 * @param {string[]} texts — non-empty array
 * @returns {Promise<Array<{ dense: number[], sparse: { indices: number[], values: number[] } }>>}
 */
export async function embedOnnxBatch(texts) {
  if (!texts.length) throw new Error('embedOnnxBatch: texts must be non-empty');
  await load();

  const encoded = encodeTexts(texts);

  const dims    = encoded.dims;      // [batchSize, seqLen]
  const [batchSize, seqLen] = dims;
  const toInt64 = (data) => new ort.Tensor('int64',
    BigInt64Array.from(Array.from(data).map(BigInt)), dims);

  const feeds = {
    input_ids:      toInt64(encoded.inputIds),
    attention_mask: toInt64(encoded.attentionMask),
    token_type_ids: toInt64(encoded.tokenTypeIds),
  };

  // Do not materialize colbert_vecs: its size grows with both batch and
  // sequence length, while this API only returns dense+sparse retrieval.
  const outputs = await session.run(feeds, RETRIEVAL_OUTPUT_NAMES);

  const denseAll  = Array.from(outputs.dense_vecs.data);              // [batchSize * 1024]
  const sparseAll = Array.from(outputs.sparse_vecs.data).map(Number); // [batchSize * seqLen]

  const inputIdsAll = encoded.inputIds;
  const attnMaskAll = encoded.attentionMask;

  const results = [];
  for (let b = 0; b < batchSize; b++) {
    const dense      = denseAll.slice(b * 1024, (b + 1) * 1024);
    const sparseSlice = sparseAll.slice(b * seqLen, (b + 1) * seqLen);
    const inputIds    = inputIdsAll.slice(b * seqLen, (b + 1) * seqLen);
    const attnMask    = attnMaskAll.slice(b * seqLen, (b + 1) * seqLen);
    results.push({ dense, sparse: processSparse(sparseSlice, inputIds, attnMask) });
  }
  return results;
}

// CLI: node src/core/onnx-embed.js "your text here"
const _isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_isMain && process.argv[2]) {
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
