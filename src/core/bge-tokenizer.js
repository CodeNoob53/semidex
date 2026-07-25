// Shared BGE-M3 tokenizer loader backed by @huggingface/tokenizers — the
// same lower-level, Rust-backed tokenizer library core/onnx-embed.js already
// uses for real embedding inference, never @huggingface/transformers
// (which bundles its own ONNX Runtime build and must never load in a
// process that also loads the custom CUDA-enabled onnxruntime-node build —
// see doctor/onnx-provider-probe.js and core/token-count.js's own module
// header for why). Downloads/caches the exact same tokenizer.json/
// tokenizer_config.json files onnx-embed.js downloads, from the same
// ONNX_DENSE_MODEL_ID repo, into the same cache directory — verified
// byte-for-byte token-count parity against the previous AutoTokenizer-based
// implementation (see tests/unit/core/bge-tokenizer-parity.test.js).
import { Tokenizer } from '@huggingface/tokenizers';
import { existsSync, mkdirSync, createWriteStream, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { ONNX_CACHE_DIR, ONNX_DENSE_MODEL_ID } from './onnx-paths.js';

const HF_BASE = 'https://huggingface.co';
const TOKENIZER_DIR = join(ONNX_CACHE_DIR, ...ONNX_DENSE_MODEL_ID.split('/'));

// Same expected sizes onnx-embed.js uses for its own offline cache
// validation — duplicated rather than imported because onnx-embed.js's
// EXPECTED_SIZES also covers model.onnx/model.onnx.data, which this
// tokenizer-only module must never need to know about (importing
// onnx-embed.js here would pull in onnxruntime-node as a side effect of
// module load, defeating the whole point of this file).
const EXPECTED_SIZES = {
  'tokenizer.json': 17_082_821,
  'tokenizer_config.json': 1_173,
};

async function downloadFile(filename, targetDir) {
  const dest = join(targetDir, filename);
  mkdirSync(targetDir, { recursive: true });

  const existingSize = existsSync(dest) ? statSync(dest).size : 0;
  const expectedSize = EXPECTED_SIZES[filename] ?? 0;
  if (expectedSize > 0 && existingSize >= expectedSize * 0.99) return;

  const url = `${HF_BASE}/${ONNX_DENSE_MODEL_ID}/resolve/main/${filename}`;
  let total = expectedSize;
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    total = parseInt(head.headers.get('content-length') ?? '0') || expectedSize;
  } catch {
    if (existingSize > 0) return; // offline, trust the cache
    throw new Error(`[bge-tokenizer] network unavailable and ${filename} not cached`);
  }
  if (existingSize >= total) return;

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`[bge-tokenizer] download failed (${res.status}): ${filename}`);
  const writer = createWriteStream(dest);
  const reader = res.body.getReader();
  let downloaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await new Promise((ok, fail) => writer.write(value, (e) => (e ? fail(e) : ok())));
    downloaded += value.length;
  }
  await new Promise((ok, fail) => writer.end((e) => (e ? fail(e) : ok())));
  if (total > 0 && downloaded !== total) {
    throw new Error(`[bge-tokenizer] ${filename}: expected ${total} bytes, got ${downloaded} — cache may be corrupt, retry`);
  }
}

let _tokenizerPromise = null;

/**
 * Loads (downloading/caching if needed, unless localFilesOnly) the shared
 * BGE-M3 Tokenizer instance — a promise-guarded singleton per process,
 * mirroring onnx-embed.js's own load()/_loadPromise pattern.
 * @param {{ localFilesOnly?: boolean }} [options]
 * @returns {Promise<Tokenizer>}
 */
export async function loadBgeTokenizer({ localFilesOnly = false } = {}) {
  if (_tokenizerPromise) return _tokenizerPromise;

  _tokenizerPromise = (async () => {
    if (!localFilesOnly) {
      for (const file of ['tokenizer.json', 'tokenizer_config.json']) {
        await downloadFile(file, TOKENIZER_DIR);
      }
    } else {
      for (const file of ['tokenizer.json', 'tokenizer_config.json']) {
        if (!existsSync(join(TOKENIZER_DIR, file))) {
          throw new Error(`[bge-tokenizer] ${file} not cached locally at ${TOKENIZER_DIR}`);
        }
      }
    }
    const tokenizerJson = JSON.parse(readFileSync(join(TOKENIZER_DIR, 'tokenizer.json'), 'utf-8'));
    const tokenizerConfig = JSON.parse(readFileSync(join(TOKENIZER_DIR, 'tokenizer_config.json'), 'utf-8'));
    return new Tokenizer(tokenizerJson, tokenizerConfig);
  })();

  try {
    return await _tokenizerPromise;
  } catch (err) {
    _tokenizerPromise = null;
    throw err;
  }
}

/**
 * Real BGE-M3 token count for one text, including the same special tokens
 * (BOS/EOS) the previous AutoTokenizer-based implementation counted —
 * verified byte-for-byte identical token IDs across empty/short/unicode/
 * long/whitespace fixtures against the prior implementation.
 * @param {Tokenizer} tokenizer
 * @param {string} text
 * @returns {number}
 */
export function bgeTokenCount(tokenizer, text) {
  return tokenizer.encode(text, { return_token_type_ids: false }).ids.length;
}
