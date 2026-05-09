// Syncs config.json with actual Qdrant collections and ensures required payload
// indexes exist on every collection. Safe to re-run: index creation is idempotent.
// Usage: npm run sync

import 'dotenv/config';
import { loadConfig, saveConfig } from './core/config.js';
import { listCollections, getCollectionInfo, createPayloadIndex, addSparseVectorSupport, hasSparseVectors } from './core/qdrant.js';

// Required indexes for MCP filters and hash-based skip to work correctly.
const REQUIRED_INDEXES = ['source_file', 'tags'];

const config = loadConfig();
if (!config.collections) config.collections = {};

const remote = await listCollections();

for (const name of remote) {
  if (!config.collections[name]) {
    const info = await getCollectionInfo(name);
    const newSparse = process.env.ONNX_EMBED === '1' ? 'bge-m3-onnx' : 'hashed-tf';
    const newDense  = newSparse === 'bge-m3-onnx' ? 'aapot/bge-m3-onnx' : (process.env.EMBED_MODEL ?? 'bge-m3');
    config.collections[name] = {
      embedModel:    newDense,
      sparseProvider: newSparse,
      vectorSize:    info.config.params.vectors.size,
      description:   '',
    };
    console.log(`+ added: ${name} (embedModel: ${newDense}, sparseProvider: ${newSparse})`);
  } else if (!config.collections[name].sparseProvider) {
    const newSparse = process.env.ONNX_EMBED === '1' ? 'bge-m3-onnx' : 'hashed-tf';
    const newDense  = newSparse === 'bge-m3-onnx' ? 'aapot/bge-m3-onnx' : (process.env.EMBED_MODEL ?? 'bge-m3');
    config.collections[name].sparseProvider = newSparse;
    config.collections[name].embedModel     = newDense;
    console.log(`  ~ backfilled "${name}": embedModel=${newDense}, sparseProvider=${newSparse}`);
  }

  for (const field of REQUIRED_INDEXES) {
    await createPayloadIndex(name, field);
    console.log(`  ✓ index "${field}" on ${name}`);
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
