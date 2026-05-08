// Syncs config.json with actual Qdrant collections and ensures required payload
// indexes exist on every collection. Safe to re-run: index creation is idempotent.
// Usage: npm run sync

import 'dotenv/config';
import { loadConfig, saveConfig } from './core/config.js';
import { listCollections, getCollectionInfo, createPayloadIndex } from './core/qdrant.js';

// Required indexes for MCP filters and hash-based skip to work correctly.
const REQUIRED_INDEXES = ['source_file', 'tags'];

const config = loadConfig();
if (!config.collections) config.collections = {};

const remote = await listCollections();

for (const name of remote) {
  if (!config.collections[name]) {
    const info = await getCollectionInfo(name);
    config.collections[name] = {
      embedModel:  process.env.EMBED_MODEL ?? 'bge-m3',
      vectorSize:  info.config.params.vectors.size,
      description: '',
    };
    console.log(`+ added: ${name}`);
  }

  for (const field of REQUIRED_INDEXES) {
    await createPayloadIndex(name, field);
    console.log(`  ✓ index "${field}" on ${name}`);
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
