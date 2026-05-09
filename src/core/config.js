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

/**
 * Resolve provider config from env variables (ONNX_EMBED, DENSE_PROVIDER,
 * SPARSE_PROVIDER, EMBED_MODEL). Used by sync and indexer when creating new
 * collection entries.
 */
const VALID_PROVIDER_COMBOS = new Set(['ollama:hashed-tf', 'bge-m3-onnx:bge-m3-onnx']);

function assertProviderCombo(denseProvider, sparseProvider) {
  if (!VALID_PROVIDER_COMBOS.has(`${denseProvider}:${sparseProvider}`)) {
    throw new Error(
      `Invalid provider combination: DENSE_PROVIDER="${denseProvider}", SPARSE_PROVIDER="${sparseProvider}". ` +
      `Valid combinations: ollama+hashed-tf, bge-m3-onnx+bge-m3-onnx.`
    );
  }
}

export function resolveEnvProviders() {
  // Explicit new-style env vars take precedence
  if (process.env.DENSE_PROVIDER) {
    const denseProvider  = process.env.DENSE_PROVIDER;
    const sparseProvider = process.env.SPARSE_PROVIDER ?? 'hashed-tf';
    const denseModel     = denseProvider === 'bge-m3-onnx'
      ? 'aapot/bge-m3-onnx'
      : (process.env.DENSE_MODEL ?? process.env.EMBED_MODEL ?? 'bge-m3');
    assertProviderCombo(denseProvider, sparseProvider);
    return { denseProvider, denseModel, sparseProvider };
  }

  // Legacy ONNX_EMBED=1 shorthand
  if (process.env.ONNX_EMBED === '1') {
    return {
      denseProvider:  'bge-m3-onnx',
      denseModel:     'aapot/bge-m3-onnx',
      sparseProvider: 'bge-m3-onnx',
    };
  }

  // Default: ollama + hashed-tf
  return {
    denseProvider:  'ollama',
    denseModel:     process.env.EMBED_MODEL ?? 'bge-m3',
    sparseProvider: 'hashed-tf',
  };
}

// --- per-collection accessors ---

export function getDenseProvider(collection) {
  const col = loadConfig().collections?.[collection];
  if (col?.denseProvider) return col.denseProvider;
  // backwards-compat: infer from old sparseProvider field
  if (col?.sparseProvider === 'bge-m3-onnx') return 'bge-m3-onnx';
  return resolveEnvProviders().denseProvider;
}

export function getDenseModel(collection) {
  const col = loadConfig().collections?.[collection];
  if (col?.denseModel) return col.denseModel;
  // backwards-compat: embedModel field
  if (col?.embedModel) return col.embedModel;
  return resolveEnvProviders().denseModel;
}

export function getSparseProvider(collection) {
  const col = loadConfig().collections?.[collection];
  if (col?.sparseProvider) return col.sparseProvider;
  return resolveEnvProviders().sparseProvider;
}

// Kept for backwards-compat (used by collections.js display, external callers).
export function getEmbedModel(collection) {
  return getDenseModel(collection);
}
