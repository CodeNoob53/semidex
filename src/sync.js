// Syncs config.json with actual Qdrant collections and ensures required payload
// indexes exist on every collection. Safe to re-run: index creation is idempotent.
// Usage: npm run sync

import 'dotenv/config';
import { loadConfig, saveConfig, resolveEnvProviders } from './core/config.js';
import { listCollections, getCollectionInfo, createPayloadIndex, addSparseVectorSupport, hasSparseVectors, getCollectionSamplePayload, isSemidexPayload } from './core/qdrant.js';
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

const flatSchemaCollections = [];

for (const name of remote) {
  const info = await getCollectionInfo(name);
  const vectorsCfg = info.config?.params?.vectors ?? {};

  // Flat-vector schema: Qdrant stores { size, distance } directly instead of
  // { dense: { size, distance } }. Named vectors are required for hybrid search.
  // This cannot be repaired in-place — the collection must be recreated and reindexed.
  const isFlatSchema = typeof vectorsCfg.size === 'number';

  // Stage 1: semidex-compatible schema = has a named 'dense' vector (not flat-schema).
  // Non-compatible collections are kept in config for bookkeeping but marked linkDisabled.
  const hasDenseNamed = !isFlatSchema && typeof vectorsCfg.dense === 'object' && vectorsCfg.dense !== null;

  if (isFlatSchema) {
    flatSchemaCollections.push(name);
    console.log(`  ⚠ LEGACY SCHEMA: "${name}" uses a flat (unnamed) vector — hybrid search unavailable.`);
    console.log(`    Cannot repair in-place. Delete the collection first, then reindex:`);
    console.log(`    1. Delete via Qdrant dashboard or API: DELETE /collections/${name}`);
    console.log(`    2. COLLECTION=${name} npm run index <original-source-path>`);
    // Still update payload indexes so MCP filters work if someone queries this collection.
  } else if (!hasDenseNamed) {
    console.log(`  ⚠ FOREIGN SCHEMA: "${name}" has no named 'dense' vector — excluded from link targets.`);
  }

  // Stage 2: for schema-compatible collections, sample one point payload to verify
  // semidex provenance. A foreign tool may expose a compatible named-dense schema
  // but its points will lack semidex discriminator fields. Empty collections are
  // treated as semidex-managed (newly created, not yet indexed — don't penalise them).
  // On scroll failure we conservatively disable rather than silently allow.
  let payloadLinkDisabled = false;
  if (hasDenseNamed) {
    let sample;
    try {
      sample = await getCollectionSamplePayload(name);
    } catch (e) {
      // Conservative: unknown payload → disable. sync continues regardless.
      console.log(`  ⚠ WARNING: could not sample payload for "${name}" (${e.message}) — marking linkDisabled as precaution.`);
      payloadLinkDisabled = true;
    }
    if (sample !== undefined) {
      // null  = empty collection → do not disable (newly created semidex collection).
      // {}    = point exists but no/empty payload → isSemidexPayload({}) = false → disable.
      // {...} = check discriminator fields normally.
      if (sample !== null && !isSemidexPayload(sample)) {
        console.log(`  ⚠ FOREIGN PAYLOAD: "${name}" has compatible schema but non-semidex payload — excluded from link targets.`);
        payloadLinkDisabled = true;
      }
    }
  }

  const isLinkDisabled = isFlatSchema || !hasDenseNamed || payloadLinkDisabled;

  if (!config.collections[name]) {
    config.collections[name] = {
      denseProvider,
      denseModel,
      sparseProvider,
      embeddingSchemaVersion: SCHEMA_VERSION,
      vectorSize:  isFlatSchema ? vectorsCfg.size : (vectorsCfg.dense?.size ?? 1024),
      description: '',
      ...(isLinkDisabled ? { linkDisabled: true } : {}),
    };
    console.log(`+ added: ${name} (dense: ${denseProvider}/${denseModel}, sparse: ${sparseProvider}${isLinkDisabled ? ', linkDisabled' : ''})`);
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
    // Sync linkDisabled with current schema compatibility — idempotent.
    if (isLinkDisabled && !col.linkDisabled) {
      col.linkDisabled = true;
      changed = true;
    } else if (!isLinkDisabled && col.linkDisabled) {
      delete col.linkDisabled;
      changed = true;
    }
    if (changed) {
      console.log(`  ~ backfilled "${name}": dense=${col.denseProvider}/${col.denseModel}, sparse=${col.sparseProvider}${col.linkDisabled ? ', linkDisabled' : ''}`);
    }
  }

  for (const [field, schema] of Object.entries(REQUIRED_INDEXES)) {
    await createPayloadIndex(name, field, schema);
    console.log(`  ✓ index "${field}" (${schema}) on ${name}`);
  }

  if (isFlatSchema) {
    console.log(`  ~ skipping sparse vector check on "${name}" (legacy flat schema — reindex required)`);
  } else {
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
}

for (const name of Object.keys(config.collections)) {
  if (!remote.includes(name)) {
    delete config.collections[name];
    console.log(`- removed: ${name}`);
  }
}

saveConfig(config);
console.log(`\nSynced. Collections: ${remote.join(', ')}`);

if (flatSchemaCollections.length > 0) {
  console.log(`\n⚠ LEGACY SCHEMA COLLECTIONS (require reindex to use hybrid search):`);
  for (const name of flatSchemaCollections) {
    console.log(`  ${name}:`);
    console.log(`    1. Delete: DELETE /collections/${name}  (dashboard or Qdrant API)`);
    console.log(`    2. Reindex: COLLECTION=${name} npm run index <original-source-path>`);
  }
}
