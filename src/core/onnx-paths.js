// ONNX model path constants — no side effects, safe to import from doctor/tools.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '../../');
export const ONNX_CACHE_DIR = join(ROOT, 'models');
export const ONNX_MODEL_DIR = join(ONNX_CACHE_DIR, 'bge-m3-onnx');

export function getOnnxModelPath() { return join(ONNX_MODEL_DIR, 'model.onnx'); }
