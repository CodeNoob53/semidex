import 'dotenv/config';

// Bootstrap semidex's own documentation into a reserved `semidex-docs` collection.
// Usage: npm run bootstrap:docs
//
// Sets ONNX_EMBED=1, COLLECTION=semidex-docs, SOURCE_ROOT=<repo root> in env,
// then spawns the indexer as a child process for each source path.
// Safe to re-run: unchanged files are skipped by the indexer's hash check.

import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadConfig, saveConfig, resolveEnvProviders } from './core/config.js';
import { listCollections } from './core/qdrant.js';
import { SCHEMA_VERSION } from './core/embeddings.js';

const COLLECTION = 'semidex-docs';
const DESCRIPTION = 'semidex usage docs: providers, indexing, retrieval, MCP tools, troubleshooting, architecture';

export function resolveRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function getBootstrapSources(repoRoot) {
  return [
    join(repoRoot, 'README.md'),
    join(repoRoot, 'AGENTS.md'),
    join(repoRoot, 'docs', 'en'),
  ];
}

export function buildIndexerEnv(baseEnv = process.env, repoRoot = resolveRepoRoot()) {
  return {
    ...baseEnv,
    ONNX_EMBED: baseEnv.ONNX_EMBED ?? '1',
    COLLECTION,
    SOURCE_ROOT: repoRoot,
  };
}

function resolveProvidersFromEnv(env) {
  const keys = ['ONNX_EMBED', 'DENSE_PROVIDER', 'SPARSE_PROVIDER', 'DENSE_MODEL', 'EMBED_MODEL'];
  const saved = new Map(keys.map(k => [k, process.env[k]]));
  for (const key of keys) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return resolveEnvProviders();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function applyManagedConfig(config, env = process.env) {
  const cfg = {
    ...config,
    collections: { ...(config.collections ?? {}) },
  };
  const entry = { ...(cfg.collections[COLLECTION] ?? {}) };
  const { denseProvider, denseModel, sparseProvider } = resolveProvidersFromEnv(env);
  cfg.collections[COLLECTION] = {
    ...entry,
    denseProvider,
    denseModel,
    sparseProvider,
    embeddingSchemaVersion: SCHEMA_VERSION,
    vectorSize: parseInt(env.VECTOR_SIZE || '1024', 10),
    semidexManaged: true,
    description: DESCRIPTION,
  };
  return cfg;
}

// Returns null if safe to proceed, or an error string if the existing
// collection was not created by bootstrap:docs and would be clobbered.
export function checkCollisionGuard(existsInQdrant, config) {
  if (!existsInQdrant) return null;
  const entry = config.collections?.[COLLECTION];
  if (entry?.semidexManaged === true) return null;
  return (
    `Collection "${COLLECTION}" already exists in Qdrant but was not created by bootstrap:docs ` +
    `(semidexManaged flag missing in config.json). ` +
    `Rename your collection or remove it manually before running bootstrap:docs.`
  );
}

function runIndexer(sourcePath, env) {
  const repoRoot = resolveRepoRoot();
  const indexerPath = join(repoRoot, 'src', 'indexer', 'index.js');
  const result = spawnSync(process.execPath, [indexerPath, sourcePath], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Indexer exited with code ${result.status} for path: ${sourcePath}`);
  }
}

async function main() {
  const repoRoot = resolveRepoRoot();
  const sources  = getBootstrapSources(repoRoot);

  // Validate all source paths exist before touching Qdrant.
  for (const src of sources) {
    if (!existsSync(src)) {
      console.error(`bootstrap:docs: source path not found: ${src}`);
      process.exit(1);
    }
  }

  // Collision guard: if collection exists and is not semidex-managed, refuse.
  let allCollections;
  try {
    allCollections = await listCollections();
  } catch (e) {
    console.error(`bootstrap:docs: cannot reach Qdrant — ${e.message}`);
    console.error('Start Qdrant and retry.');
    process.exit(1);
  }

  const existsInQdrant = allCollections.includes(COLLECTION);
  const env = buildIndexerEnv(process.env, repoRoot);
  const config = loadConfig();
  const collisionError = checkCollisionGuard(existsInQdrant, config);
  if (collisionError) {
    console.error(`\nbootstrap:docs: ${collisionError}`);
    process.exit(1);
  }

  // Mark the reserved collection before indexing. If indexing is interrupted
  // after Qdrant collection creation, a retry will still be allowed.
  saveConfig(applyManagedConfig(config, env));

  console.log(`\nbootstrap:docs: indexing ${sources.length} source(s) into "${COLLECTION}"...`);
  console.log(`  provider: ${env.ONNX_EMBED === '1' ? 'bge-m3-onnx (ONNX_EMBED=1)' : 'ollama/hashed-tf (ONNX_EMBED=0)'}`);
  console.log(`  source root: ${repoRoot}\n`);

  for (const src of sources) {
    runIndexer(src, env);
  }

  // Re-apply metadata in case the indexer updated provider fields.
  saveConfig(applyManagedConfig(loadConfig(), env));

  console.log(`\nbootstrap:docs: done. "${COLLECTION}" is ready.`);
  console.log(`  semidexManaged: true written to config.json`);
  console.log(`  Agents can now query: qdrant_search("<question>", "${COLLECTION}")`);
}

if (process.argv[1] && (process.argv[1].endsWith('bootstrap-docs.js') || process.argv[1].endsWith('bootstrap-docs'))) {
  main().catch(err => { console.error(err); process.exit(1); });
}
