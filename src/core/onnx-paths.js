// ONNX model path/id constants — no side effects, safe to import from
// doctor/tools/the settings registry (unlike onnx-embed.js itself, which
// loads the configured ONNX runtime and tokenizer implementation).
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
