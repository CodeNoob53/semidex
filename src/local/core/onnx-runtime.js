import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

export function resolveOnnxRuntimeModule(env = process.env) {
  const customPath = String(env.ONNXRUNTIME_NODE_PATH ?? '').trim();
  return customPath ? resolve(customPath) : 'onnxruntime-node';
}

export function loadOnnxRuntime(env = process.env) {
  return require(resolveOnnxRuntimeModule(env));
}

