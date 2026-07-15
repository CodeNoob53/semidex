// Syncs config.json with actual Qdrant collections and ensures required payload
// indexes exist on every collection. Safe to re-run: index creation is idempotent.
// Usage: npm run sync

// bootstrapEnv() must run before any import below could transitively load
// .env via a static 'dotenv/config' import — static imports hoist above all
// other code, so dynamic import() is the only way to guarantee this
// ordering (same pattern as src/admin/bootstrap.js / src/mcp/server.js).
// This is not imported by any test (confirmed), so it's safe for this file
// to be a top-level script with no isMainModule guard.
//
// sync.js DOES consume settings-registry fields: resolveEnvProviders()
// below (DENSE_PROVIDER/SPARSE_PROVIDER/DENSE_MODEL/EMBED_MODEL) and every
// Qdrant call (via QDRANT_URL, read by core/qdrant/client.js) — a
// settings.json-saved value for any of these must be visible to `npm run
// sync` the same way it is to the indexer/admin/MCP (code review finding:
// this file previously called resolveEnvProviders() with no SettingsService
// at all, so a settings.json override was silently invisible here even
// though sync.js's whole job is to reconcile config.json against reality).
const { bootstrapEnv } = await import('./core/env-bootstrap.js');
const { osEnv, dotenvValues } = bootstrapEnv();
const { createSettingsService, applyEnvWriteBack } = await import('./core/settings/service.js');
const settingsService = createSettingsService({ osEnv, dotenvValues });
applyEnvWriteBack(settingsService);

const { loadConfig, saveConfig, resolveEnvProviders } = await import('./core/config.js');
const { listCollections, getCollectionInfo, ensureCollectionSchema } = await import('./core/qdrant.js');
const { classifyVectorSchema } = await import('./core/doctor-checks.js');
const { SCHEMA_VERSION } = await import('./core/embeddings.js');

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
  const isFlatSchema = classifyVectorSchema(vectorsCfg) === 'flat';

  // semidex-compatible schema = has a named 'dense' vector (not flat-schema).
  const hasDenseNamed = classifyVectorSchema(vectorsCfg) === 'named';

  if (isFlatSchema) {
    flatSchemaCollections.push(name);
    console.log(`  ⚠ LEGACY SCHEMA: "${name}" uses a flat (unnamed) vector — hybrid search unavailable.`);
    console.log(`    Cannot repair in-place. Delete the collection first, then reindex:`);
    console.log(`    1. Delete via Qdrant dashboard or API: DELETE /collections/${name}`);
    console.log(`    2. COLLECTION=${name} npm run index <original-source-path>`);
    // Still update payload indexes so MCP filters work if someone queries this collection.
  } else if (!hasDenseNamed) {
    console.log(`  ⚠ FOREIGN SCHEMA: "${name}" has no named 'dense' vector — hybrid search unavailable.`);
  }

  if (!config.collections[name]) {
    config.collections[name] = {
      denseProvider,
      denseModel,
      sparseProvider,
      embeddingSchemaVersion: SCHEMA_VERSION,
      vectorSize:  isFlatSchema ? vectorsCfg.size : (vectorsCfg.dense?.size ?? 1024),
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
    if (col.linkDisabled) {
      delete col.linkDisabled;
      changed = true;
    }
    if (changed) {
      console.log(`  ~ backfilled "${name}": dense=${col.denseProvider}/${col.denseModel}, sparse=${col.sparseProvider}`);
    }
  }

  // Pass the already-fetched info to avoid a redundant getCollectionInfo call;
  // ensureCollectionSchema derives the same flat/foreign classification from
  // it, so its own LEGACY/FOREIGN SCHEMA warnings would duplicate the ones
  // already printed above — skip only those two, keep the rest verbatim,
  // except the sparse-vectors-missing warning, where sync.js prints its own
  // CLI-specific remediation command instead of the adapter's generic text
  // (ensureCollectionSchema has no notion of "npm run index", so it can't
  // phrase that instruction itself).
  const { repaired, warnings } = await ensureCollectionSchema(name, { collectionInfo: info });
  for (const action of repaired) {
    console.log(`  ✓ ${action} on ${name}`);
  }
  for (const warning of warnings) {
    if (warning.includes('LEGACY SCHEMA') || warning.includes('FOREIGN SCHEMA')) continue;
    if (warning.includes('has no sparse vectors on existing points')) {
      console.log(`  ⚠ WARNING: "${name}" has no sparse vectors on existing points.`);
      console.log(`    Hybrid search will behave as dense-only until you re-index:`);
      console.log(`    COLLECTION=${name} npm run index <path>`);
      continue;
    }
    console.log(`  ⚠ ${warning}`);
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
