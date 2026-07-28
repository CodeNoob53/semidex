// ONNX model path/id constants — no side effects, safe to import from
// doctor/tools/the settings registry (unlike onnx-embed.js itself, which
// loads the configured ONNX runtime and tokenizer implementation).
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '../../');
export const ONNX_CACHE_DIR = join(ROOT, 'models');
export const ONNX_MODEL_DIR = join(ONNX_CACHE_DIR, 'bge-m3-onnx');

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
