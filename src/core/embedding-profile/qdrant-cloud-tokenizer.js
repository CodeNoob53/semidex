// Per-model tokenizer loader for Qdrant Cloud Inference dense models —
// mirrors src/core/bge-tokenizer.js's shape exactly (same
// @huggingface/tokenizers import, never @huggingface/transformers, which
// bundles its own ONNX Runtime build and must not load in a process that
// may also load the custom CUDA-enabled onnxruntime-node build). Downloads
// and caches ONLY tokenizer.json/tokenizer_config.json for a given cloud
// model ID — never model weights, never an ONNX graph, never the
// Transformers.js runtime. This is what makes checkEmbedInputFits()
// (qdrant-cloud-catalog.js) an exact per-embed-time check instead of the
// English-biased heuristicTokenCount() char/4 estimate: Ukrainian/
// Cyrillic/code/dense identifiers can tokenize far denser than 4
// chars/token, so a heuristic-only gate could report `fits: true` on an
// input Qdrant Cloud Inference then silently truncates.
import { Tokenizer } from '@huggingface/tokenizers';
import { existsSync, mkdirSync, createWriteStream, readFileSync, statSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

import { TOKENIZER_CACHE_DIR } from '../onnx-paths.js';

const HF_BASE = 'https://huggingface.co';

function tokenizerDir(modelId) {
  return join(TOKENIZER_CACHE_DIR, ...modelId.split('/'));
}

// Downloads to a per-attempt temp file, then atomically renames onto the
// final destination only after a fully successful, verified download.
// This is what makes "the file exists at dest" mean "a complete download
// finished" — before this fix, a process kill or network drop mid-stream
// could leave a non-empty but truncated file AT THE FINAL PATH, and
// existsSync(dest) && statSync(dest).size > 0 would treat that as
// permanently cached forever, with no path to ever re-download it.
// fs.rename is atomic on the same filesystem (both temp and dest live
// under the same modelId cache directory here), so a reader can never
// observe a partially-written file at `dest`. Exported for direct testing
// against a throwaway target directory — never the real model cache.
export async function downloadFile(modelId, filename, targetDir) {
  const dest = join(targetDir, filename);
  mkdirSync(targetDir, { recursive: true });
  if (existsSync(dest) && statSync(dest).size > 0) return;

  const tmpDest = join(targetDir, `.${filename}.${randomBytes(6).toString('hex')}.tmp`);
  const url = `${HF_BASE}/${modelId}/resolve/main/${filename}`;
  let writer = null;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`[qdrant-cloud-tokenizer] download failed (${res.status}): ${modelId}/${filename}`);
    writer = createWriteStream(tmpDest);
    const reader = res.body.getReader();
    let downloaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((ok, fail) => writer.write(value, (e) => (e ? fail(e) : ok())));
      downloaded += value.length;
    }
    await new Promise((ok, fail) => writer.end((e) => (e ? fail(e) : ok())));
    writer = null; // closed cleanly — the finally block below must not double-close it
    if (downloaded === 0) {
      throw new Error(`[qdrant-cloud-tokenizer] ${modelId}/${filename}: downloaded 0 bytes`);
    }
    renameSync(tmpDest, dest);
  } finally {
    // If the read/write loop threw before writer.end() ran (network drop,
    // a read()/write() rejection), the stream is still open with a
    // dangling file handle. destroy() is asynchronous (it schedules the
    // underlying fd close) — on Windows in particular, an unlink attempted
    // before that close actually lands can fail (the OS still holds an
    // exclusive handle), so this awaits the stream's own 'close' event
    // before ever touching the temp file, rather than racing it.
    if (writer !== null) {
      await new Promise((resolve) => {
        writer.once('close', resolve);
        writer.destroy();
      });
    }
    // Best-effort cleanup of a failed/incomplete attempt's temp file — the
    // successful path already moved it via renameSync above, so this is a
    // no-op then; unlinkSync only ever removes a leftover PARTIAL file,
    // never the completed `dest`.
    try { if (existsSync(tmpDest)) unlinkSync(tmpDest); } catch { /* best-effort */ }
  }
}

// Parses a cached tokenizer file, deleting and returning false if it
// fails to parse (corrupt/truncated despite passing the non-empty check —
// e.g. a file that predates the atomic-rename fix above, or filesystem-level
// corruption) so the NEXT call re-downloads instead of failing forever.
// Exported for direct testing.
export function readJsonOrEvict(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf-8')) };
  } catch (err) {
    try { unlinkSync(path); } catch { /* best-effort */ }
    return { ok: false, error: err };
  }
}

// Promise-guarded singleton cache, keyed per model ID — mirrors
// bge-tokenizer.js's own _tokenizerPromise pattern, generalized to more
// than one model so a future second dense model in the catalog can't
// collide with E5's cached tokenizer.
const _tokenizerPromises = new Map();

/**
 * Loads (downloading/caching if needed, unless localFilesOnly) the shared
 * Tokenizer instance for one Qdrant Cloud dense model ID.
 * @param {string} modelId
 * @param {{ localFilesOnly?: boolean }} [options]
 * @returns {Promise<Tokenizer>}
 */
export async function loadQdrantCloudTokenizer(modelId, { localFilesOnly = false } = {}) {
  if (_tokenizerPromises.has(modelId)) return _tokenizerPromises.get(modelId);

  const FILES = ['tokenizer.json', 'tokenizer_config.json'];

  const promise = (async () => {
    const dir = tokenizerDir(modelId);
    if (!localFilesOnly) {
      for (const file of FILES) {
        await downloadFile(modelId, file, dir);
      }
    } else {
      for (const file of FILES) {
        if (!existsSync(join(dir, file))) {
          throw new Error(`[qdrant-cloud-tokenizer] ${file} not cached locally for ${modelId} at ${dir}`);
        }
      }
    }

    let parsed = FILES.map((file) => readJsonOrEvict(join(dir, file)));
    if (parsed.some((p) => !p.ok)) {
      // A cached file that passed the non-empty check still failed to
      // parse — readJsonOrEvict() already deleted it. In network mode,
      // re-download the evicted file(s) once and retry the parse; a
      // second failure is a real, non-recoverable error, never silently
      // swallowed. In localFilesOnly mode there is nothing to re-download,
      // so the original parse error surfaces immediately.
      if (localFilesOnly) {
        const failed = parsed.find((p) => !p.ok);
        throw new Error(`[qdrant-cloud-tokenizer] cached tokenizer file for ${modelId} is corrupt and localFilesOnly is set (no network retry): ${failed.error.message}`);
      }
      for (let i = 0; i < FILES.length; i++) {
        if (!parsed[i].ok) await downloadFile(modelId, FILES[i], dir);
      }
      parsed = FILES.map((file) => readJsonOrEvict(join(dir, file)));
      const stillFailed = parsed.find((p) => !p.ok);
      if (stillFailed) {
        throw new Error(`[qdrant-cloud-tokenizer] tokenizer file for ${modelId} is corrupt even after a fresh re-download: ${stillFailed.error.message}`);
      }
    }

    const [tokenizerJson, tokenizerConfig] = parsed.map((p) => p.value);
    return new Tokenizer(tokenizerJson, tokenizerConfig);
  })();

  _tokenizerPromises.set(modelId, promise);
  try {
    return await promise;
  } catch (err) {
    _tokenizerPromises.delete(modelId);
    throw err;
  }
}

/**
 * Real token count for one text against a loaded model tokenizer,
 * including special tokens — mirrors bge-tokenizer.js's bgeTokenCount().
 * @param {Tokenizer} tokenizer
 * @param {string} text
 * @returns {number}
 */
export function qdrantCloudTokenCount(tokenizer, text) {
  return tokenizer.encode(text, { return_token_type_ids: false }).ids.length;
}
