// Syncs config.json with actual Qdrant collections and ensures required payload
// indexes exist on every collection. Safe to re-run: index creation is idempotent.
// Usage: npm run sync

import 'dotenv/config';
import { loadConfig, saveConfig, resolveEnvProviders } from './core/config.js';
import { listCollections, getCollectionInfo, createPayloadIndex, addSparseVectorSupport, hasSparseVectors } from './core/qdrant.js';
import { SCHEMA_VERSION } from './core/embeddings.js';

// Required indexes for MCP filters and hash-based skip to work correctly.
const REQUIRED_INDEXES = {
  'source_file': 'keyword',
  'tags': 'keyword',
  'chunk_index': 'integer'
};

const config = loadConfig();
if (!config.collections) config.collections = {};

const remote = await listCollections();
const { denseProvider, denseModel, sparseProvider } = resolveEnvProviders();

for (const name of remote) {
  if (!config.collections[name]) {
    const info = await getCollectionInfo(name);
    config.collections[name] = {
      denseProvider,
      denseModel,
      sparseProvider,
      embeddingSchemaVersion: SCHEMA_VERSION,
      vectorSize:  info.config.params.vectors.size,
      description: '',
    };
    console.log(`+ added: ${name} (dense: ${denseProvider}/${denseModel}, sparse: ${sparseProvider})`);
  } else {
    // Backfill any missing provider fields on existing entries.
    const col = config.collections[name];
    let changed = false;

    if (!col.denseProvider) {
      // Infer from legacy sparseProvider field if present, otherwise use env.
      col.denseProvider = col.sparseProvider === 'bge-m3-onnx' ? 'bge-m3-onnx' : denseProvider;
      changed = true;
    }
    if (!col.denseModel) {
      col.denseModel = col.denseProvider === 'bge-m3-onnx' ? 'aapot/bge-m3-onnx' : (col.embedModel ?? denseModel);
      changed = true;
    }
    if (!col.sparseProvider) {
      col.sparseProvider = col.denseProvider === 'bge-m3-onnx' ? 'bge-m3-onnx' : sparseProvider;
      changed = true;
    }
    if (!col.embeddingSchemaVersion) {
      col.embeddingSchemaVersion = SCHEMA_VERSION;
      changed = true;
    }
    if (changed) {
      console.log(`  ~ backfilled "${name}": dense=${col.denseProvider}/${col.denseModel}, sparse=${col.sparseProvider}`);
    }
  }

  for (const [field, schema] of Object.entries(REQUIRED_INDEXES)) {
    await createPayloadIndex(name, field, schema);
    console.log(`  ✓ index "${field}" (${schema}) on ${name}`);
  }

  try {
    await addSparseVectorSupport(name);
    console.log(`  ✓ sparse vector support on ${name}`);
  } catch (e) {
    console.log(`  ~ sparse vector already exists on ${name}`);
  }

  const hasSparsePts = await hasSparseVectors(name);
  if (!hasSparsePts) {
    console.log(`  ⚠ WARNING: "${name}" has no sparse vectors on existing points.`);
    console.log(`    Hybrid search will behave as dense-only until you re-index:`);
    console.log(`    COLLECTION=${name} npm run index <path>`);
  }
}

for (const name of Object.keys(config.collections)) {
  if (!remote.includes(name)) {
    delete config.collections[name];
    console.log(`- removed: ${name}`);
  }
}

saveConfig(config);
console.log(`\nSynced. Collections: ${remote.join(', ')}`);
