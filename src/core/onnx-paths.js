// ONNX model path/id constants — no side effects, safe to import from
// doctor/tools/the settings registry (unlike onnx-embed.js itself, which
// loads the configured ONNX runtime and tokenizer implementation).
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '../../');
export const ONNX_CACHE_DIR = join(ROOT, 'models');
export const ONNX_MODEL_DIR = join(ONNX_CACHE_DIR, 'bge-m3-onnx');

// Root directory for cached tokenizer files (tokenizer.json /
// tokenizer_config.json — the tokenizer-only download the Qdrant Cloud
// input-budget validator needs, NEVER model weights). Distinct from the
// ONNX MODEL cache above so a cloud-only deployment (Semidex Lite) can
// redirect tokenizer writes to a writable application home
// (SEMIDEX_HOME/cache/tokenizers) without moving the local ONNX model
// cache. Backward compatible: when SEMIDEX_TOKENIZER_CACHE_DIR is unset it
// falls back to ONNX_CACHE_DIR — the exact package-relative location full
// Semidex has always written tokenizers to — so a checked-out repo is
// unchanged. Read fresh from process.env at import time; a caller (the
// Lite CLI) that needs to redirect it MUST set the env var before this
// module is first imported (the Lite bin does this before any runtime
// import, and the spawned indexer child inherits the env var).
export const TOKENIZER_CACHE_DIR = process.env.SEMIDEX_TOKENIZER_CACHE_DIR
  ? process.env.SEMIDEX_TOKENIZER_CACHE_DIR
  : ONNX_CACHE_DIR;

// The single source of truth for the ONNX dense-embedding model's HF repo
// id — every consumer (onnx-embed.js, config.js's resolveEnvProviders(),
// sync.js, token-count.js, the settings registry's DENSE_MODEL
// derivedWhen metadata) imports this instead of re-hardcoding the literal
// string.
export const ONNX_DENSE_MODEL_ID = 'aapot/bge-m3-onnx';

export function getOnnxModelPath() { return join(ONNX_MODEL_DIR, 'model.onnx'); }

// The single source of truth for "is the BGE-M3 ONNX model actually on
// disk" — BOTH model.onnx and model.onnx.data must be present (the model
// is split across two files; onnx-embed.js's real load path downloads both
// via downloadFile() before creating an inference session). Used by
// onnx-probe-runner.js (the one place that decides whether to attempt a
// real InferenceSession.create()) AND src/core/embedding-profile/
// onnx-lane.js (the routine, cheap availability check, which must NEVER
// load the model itself) — one definition, not two independently-written
// checks that happen to agree today but could silently drift apart.
export function isOnnxModelCached() {
  const modelPath = getOnnxModelPath();
  return existsSync(modelPath) && existsSync(`${modelPath}.data`);
}
