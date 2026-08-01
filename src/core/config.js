import 'dotenv/config';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { assertProviderCombo, resolveEffectiveEmbeddingBackend } from './env.js';
import { ONNX_DENSE_MODEL_ID } from './onnx-paths.js';
import { QDRANT_CLOUD_DENSE_MODELS, QDRANT_CLOUD_SPARSE_MODELS } from './embedding-profile/qdrant-cloud-catalog.js';

// SEMIDEX_CONFIG_PATH lets a caller (e.g. an external benchmark harness
// spawning the indexer as a subprocess) redirect config.json to an
// isolated path instead of the real repo config — prevents a disposable
// benchmark collection from polluting the user's real collections
// registry. Additive: every caller that doesn't set this env var is
// unaffected.
const CONFIG_PATH = process.env.SEMIDEX_CONFIG_PATH
  ? resolve(process.env.SEMIDEX_CONFIG_PATH)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../config.json');

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { collections: {} };
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

export function saveConfig(config) {
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tmp, CONFIG_PATH);
}

/**
 * Resolve provider config from env variables (ONNX_EMBED, DENSE_PROVIDER,
 * SPARSE_PROVIDER, EMBED_MODEL). Used by sync and indexer when creating new
 * collection entries.
 */

export function resolveEnvProviders() {
  const { denseProvider, sparseProvider } = resolveEffectiveEmbeddingBackend(
    (name) => process.env[name]
  );
  if (denseProvider === 'bge-m3-onnx') {
    assertProviderCombo(denseProvider, sparseProvider);
    return { denseProvider, denseModel: ONNX_DENSE_MODEL_ID, sparseProvider };
  }
  if (denseProvider === 'qdrant-cloud') {
    assertProviderCombo(denseProvider, sparseProvider);
    const denseModel = process.env.QDRANT_CLOUD_DENSE_MODEL ?? QDRANT_CLOUD_DENSE_MODELS.find((m) => m.status === 'supported')?.id;
    // sparseModel mirrors denseModel's own env-then-catalog-default
    // resolution — previously absent entirely, which meant
    // resolveNewCollectionProfile() had no way to receive anything but
    // its own hardcoded 'qdrant/bm25' fallback for a NEW collection
    // created via the real indexer CLI path. Currently a no-op in
    // practice (qdrant/bm25 is still the only status:'supported' sparse
    // model), but the contract is now correct ahead of a second sparse
    // model landing.
    const sparseModel = process.env.QDRANT_SPARSE_MODEL ?? QDRANT_CLOUD_SPARSE_MODELS.find((m) => m.status === 'supported')?.id;
    return { denseProvider, denseModel, sparseProvider, sparseModel };
  }
  // ollama: EMBED_MODEL is the canonical setting; DENSE_MODEL is a legacy
  // alias, consulted only when EMBED_MODEL itself is unset (code review
  // fix — DENSE_MODEL used to win regardless, so a stale DENSE_MODEL
  // silently shadowed a value the Settings UI's EMBED_MODEL control had
  // just saved, since the UI now presents EMBED_MODEL as the one editable
  // model field for this backend).
  const denseModel = process.env.EMBED_MODEL ?? process.env.DENSE_MODEL ?? 'bge-m3';
  assertProviderCombo(denseProvider, sparseProvider);
  return { denseProvider, denseModel, sparseProvider };
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
