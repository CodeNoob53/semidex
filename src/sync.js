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
// sync.js consumes settings-registry fields via QDRANT_URL (read by
// core/qdrant/client.js) — a settings.json-saved value must be visible to
// `npm run sync` the same way it is to the indexer/admin/MCP.
const { bootstrapEnv } = await import('./shared/core/env-bootstrap.js');
const { osEnv, dotenvValues } = bootstrapEnv();
const { createSettingsService, applyEnvWriteBack } = await import('./core/settings/service.js');
const settingsService = createSettingsService({ osEnv, dotenvValues });
applyEnvWriteBack(settingsService);

const { loadConfig, saveConfig } = await import('./shared/core/config.js');
const { listCollections, getCollectionInfo, ensureCollectionSchema } = await import('./shared/core/qdrant.js');
const { classifyVectorSchema } = await import('./shared/core/doctor-checks.js');
const { createStorageAdapter } = await import('./core/storage/factory.js');
const { resolveCollectionConfigEntry } = await import('./core/embedding-profile/config-cache.js');

const config = loadConfig();
if (!config.collections) config.collections = {};

const remote = await listCollections();

// Embedding-profile-aware adapter — the ONLY sanctioned caller of
// migrateEmbeddingProfile besides the indexer's own preflight (both are
// explicit, user-initiated actions, never a passive read path). Every
// remote collection's config.json entry below is derived from its resolved
// NATIVE profile, never from resolveEnvProviders() (current global/env
// settings) — sync.js only ever reconciles EXISTING remote collections
// (confirmed: no code path here creates a brand-new Qdrant collection), so
// resolveNewCollectionProfile()/resolveEnvProviders() have no legitimate
// call site in this file at all.
const storageAdapter = createStorageAdapter();

const flatSchemaCollections = [];
const unresolvedCollections = [];

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

  // Embedding identity: EVERY remote collection is processed uniformly
  // here, regardless of whether it already has a config.json entry —
  // gating this on "missing from config.json" (the pre-fix behavior)
  // would mean a real pre-existing Semidex collection (which already has
  // a config.json entry today, before native metadata support existed)
  // never gets migrated no matter how many times `npm run sync` runs.
  // config.json is written ONLY as a cache of a profile resolved from
  // native metadata or a verified legacy payload — never from
  // resolveEnvProviders(), which describes CURRENT global/env settings,
  // not this collection's actual indexed identity.
  const profileResult = await storageAdapter.getEmbeddingProfile(name);
  if (profileResult.state === 'valid') {
    config.collections[name] = resolveCollectionConfigEntry(profileResult.profile, config.collections[name]);
  } else if (profileResult.state === 'missing') {
    const migration = await storageAdapter.migrateEmbeddingProfile(name);
    if (migration.status === 'inferred') {
      config.collections[name] = resolveCollectionConfigEntry(migration.profile, config.collections[name]);
      console.log(`  ✓ migrated embedding profile for "${name}" (dense: ${migration.profile.embedding.dense.provider}/${migration.profile.embedding.dense.model}, sparse: ${migration.profile.embedding.sparse?.provider ?? 'none'})`);
    } else {
      unresolvedCollections.push(name);
      console.log(`  ⚠ cannot determine embedding identity for "${name}" (${migration.reason}) — reindex or migrate manually`);
      // Deliberately does NOT touch config.collections[name] — leave
      // whatever was there before untouched. sync must never claim
      // identity it hasn't verified, but also must not destroy a
      // config.json entry that might still be a useful clue for a human,
      // even though it is no longer treated as canonical.
    }
  } else {
    // 'invalid' / 'unsupported_schema_version' — never silently overwrite
    // or reinterpret a profile this codebase doesn't fully understand; it
    // may belong to a newer semidex version. Matches the adapter's own
    // write-once guard, which already refuses to touch these states for
    // exactly this reason.
    unresolvedCollections.push(name);
    console.log(`  ⚠ "${name}" has unrecognized/newer embedding profile metadata (${profileResult.reason ?? profileResult.state}) — leaving it untouched`);
  }

  if (config.collections[name]?.linkDisabled) {
    delete config.collections[name].linkDisabled;
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

if (unresolvedCollections.length > 0) {
  console.log(`\n⚠ COLLECTIONS WITH UNRESOLVED EMBEDDING IDENTITY (semantic/hybrid search unavailable until resolved):`);
  for (const name of unresolvedCollections) {
    console.log(`  ${name}: reindex, or run migration manually once payload identity is unambiguous`);
  }
}
