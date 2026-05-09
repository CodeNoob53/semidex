import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../config.json');

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { collections: {} };
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

export function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// per-collection embed model, falls back to EMBED_MODEL env
export function getEmbedModel(collection) {
  return loadConfig().collections?.[collection]?.embedModel
    ?? process.env.EMBED_MODEL
    ?? 'bge-m3';
}

// per-collection sparse encoder, falls back to ONNX_EMBED env
export function getSparseProvider(collection) {
  return loadConfig().collections?.[collection]?.sparseProvider
    ?? (process.env.ONNX_EMBED === '1' ? 'bge-m3-onnx' : 'hashed-tf');
}
