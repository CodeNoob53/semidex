// Source-level regression guards for src/indexer/run.js's embedding-profile
// wiring (Part E of the native-metadata task) — no live Qdrant/Ollama
// needed, matching this file's existing test convention (run.js's main()/
// stageA/stageC are not exported and require live infra to exercise
// end-to-end; see skeleton-first-invariant.test.js for the same source-
// slicing approach used elsewhere in this test suite).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../../../src/indexer/run.js', import.meta.url)),
  'utf-8',
);

describe('run.js — EMBEDDING_PROFILE is resolved once, module-level, never per-call', () => {
  it('declares EMBEDDING_PROFILE as module-level mutable state, matching the existing VECTOR_SIZE/BATCH_SIZE convention', () => {
    assert.match(src, /let EMBEDDING_PROFILE = null;/);
  });

  it('imports resolveExistingCollectionProfile/resolveNewCollectionProfile from the shared resolver, not a re-implementation', () => {
    assert.match(src, /import\s*\{\s*resolveExistingCollectionProfile,\s*resolveNewCollectionProfile\s*\}\s*from\s*['"]\.\.\/core\/embedding-profile\/resolve\.js['"]/);
  });

  it('no longer imports getEmbeddingConfig from embeddings.js (removed — profile-driven instead)', () => {
    const importLine = src.slice(src.indexOf("from '../core/embeddings.js'") - 200, src.indexOf("from '../core/embeddings.js'"));
    assert.ok(!/getEmbeddingConfig/.test(importLine), 'getEmbeddingConfig must be fully removed from run.js\'s embeddings.js import');
  });
});

describe('run.js — new-collection branch resolves the profile and creates atomically', () => {
  it('calls resolveNewCollectionProfile, then adapter.createCollection with { profile }, never a bare vectorSize-only create', () => {
    const start = src.indexOf('if (!allCollections.includes(COLLECTION)) {');
    const end = src.indexOf('} else {', start);
    const branch = src.slice(start, end);
    assert.match(branch, /EMBEDDING_PROFILE = resolveNewCollectionProfile\(/);
    assert.match(branch, /storageAdapter\.createCollection\(COLLECTION,\s*\{\s*profile:\s*EMBEDDING_PROFILE\s*\}\)/);
  });

  it('writes config.json from the SAME resolved profile object via resolveCollectionConfigEntry, not a second independent resolution', () => {
    const start = src.indexOf('if (!allCollections.includes(COLLECTION)) {');
    const end = src.indexOf('} else {', start);
    const branch = src.slice(start, end);
    assert.match(branch, /resolveCollectionConfigEntry\(EMBEDDING_PROFILE, cfg\.collections\[COLLECTION\]\)/);
  });
});

describe('run.js — existing-collection branch resolves read-only, migrates explicitly, fails fast', () => {
  it('calls resolveExistingCollectionProfile (read-only) before attempting migration', () => {
    const start = src.indexOf('} else {', src.indexOf('if (!allCollections.includes(COLLECTION)) {'));
    const end = src.indexOf('const PRUNE_STALE', start);
    const branch = src.slice(start, end);
    assert.match(branch, /let resolution = await resolveExistingCollectionProfile\(storageAdapter, COLLECTION\)/);
  });

  it('explicitly calls migrateEmbeddingProfile only when the reason is legacy_unmigrated — the sanctioned write-trigger call site', () => {
    const start = src.indexOf('} else {', src.indexOf('if (!allCollections.includes(COLLECTION)) {'));
    const end = src.indexOf('const PRUNE_STALE', start);
    const branch = src.slice(start, end);
    assert.match(branch, /resolution\.reason === 'legacy_unmigrated'/);
    assert.match(branch, /storageAdapter\.migrateEmbeddingProfile\(COLLECTION\)/);
  });

  it('fails fast (process.exit) when the profile still cannot be resolved after migration — never falls back to global/env defaults', () => {
    const start = src.indexOf('} else {', src.indexOf('if (!allCollections.includes(COLLECTION)) {'));
    const end = src.indexOf('const PRUNE_STALE', start);
    const branch = src.slice(start, end);
    assert.match(branch, /if \(!resolution\.resolved\) \{/);
    assert.match(branch, /process\.exit\(1\)/);
    assert.ok(!/resolveEnvProviders\(\)/.test(branch), 'the existing-collection branch must never call resolveEnvProviders() — that would be the exact silent-fallback bug this task fixes');
  });
});

describe('run.js — all 7 embedForIndex/embedForIndexBatch call sites use EMBEDDING_PROFILE, never a bare collection string', () => {
  it('every embedForIndex(...)/embedForIndexBatch(...) call passes EMBEDDING_PROFILE as its first argument', () => {
    const calls = [...src.matchAll(/embedForIndex(?:Batch)?\(([^,)]+)/g)];
    assert.ok(calls.length >= 7, `expected at least 7 embedForIndex/embedForIndexBatch call sites, found ${calls.length}`);
    for (const match of calls) {
      const firstArg = match[1].trim();
      assert.equal(firstArg, 'EMBEDDING_PROFILE', `call site "${match[0]}" must pass EMBEDDING_PROFILE, not "${firstArg}"`);
    }
  });
});

describe('run.js — setIndexingState() is called after a successful run (P2 fix: semidex_indexing_state was declared but never written)', () => {
  it('calls storageAdapter.setIndexingState(COLLECTION, buildIndexingState(...)) before the final "Done." log line', () => {
    const doneLogIndex = src.indexOf("console.log(`\\nDone. ${files.length}");
    assert.ok(doneLogIndex > -1, 'the final Done. log line must exist');
    const precedingBlock = src.slice(Math.max(0, doneLogIndex - 800), doneLogIndex);
    assert.match(precedingBlock, /storageAdapter\.setIndexingState\(COLLECTION,\s*buildIndexingState\(\{/);
    // Topology-aware (code review, P2): indexingSchemaVersion picks between
    // the two topology-specific constants based on whether this collection's
    // profile requires entity splitting, never a single hardcoded constant.
    assert.match(precedingBlock, /indexingSchemaVersion:\s*resolveEmbeddingBudget\(EMBEDDING_PROFILE\)\s*!==\s*null\s*\r?\n?\s*\?\s*INDEXING_SCHEMA_VERSION_SPLIT_ENTITY\s*:\s*INDEXING_SCHEMA_VERSION_BASE/);
    assert.match(precedingBlock, /chunkingSchemaVersion:\s*CHUNKING_SCHEMA_VERSION/);
  });

  it('wraps the setIndexingState call in try/catch — a metadata-write failure must never fail an otherwise-successful indexing run', () => {
    const doneLogIndex = src.indexOf("console.log(`\\nDone. ${files.length}");
    const precedingBlock = src.slice(Math.max(0, doneLogIndex - 800), doneLogIndex);
    const setIndexingStateIndex = precedingBlock.indexOf('storageAdapter.setIndexingState(');
    assert.ok(setIndexingStateIndex > -1);
    assert.match(precedingBlock, /try\s*\{\s*\r?\n\s*await storageAdapter\.setIndexingState\(/, 'setIndexingState must be the first statement inside a try block');
    assert.match(precedingBlock.slice(setIndexingStateIndex), /catch\s*\(err\)\s*\{\s*\r?\n\s*console\.warn\(/);
  });

  it('imports buildIndexingState from the canonical schema.js and the topology-specific version constants from skeleton-payload.js, not a re-implementation', () => {
    assert.match(src, /import\s*\{[^}]*\bbuildIndexingState\b[^}]*\}\s*from\s*['"]\.\.\/core\/embedding-profile\/schema\.js['"]/);
    assert.match(src, /INDEXING_SCHEMA_VERSION_BASE/);
    assert.match(src, /INDEXING_SCHEMA_VERSION_SPLIT_ENTITY/);
    const importLine = src.slice(0, src.indexOf('\n', src.indexOf('INDEXING_SCHEMA_VERSION_BASE')));
    assert.match(importLine, /from\s*['"]\.\/skeleton-payload\.js['"]/);
  });
});

describe('run.js stageD — commit order: canonical entity_raw upsert BEFORE fragment upsert (code review, P2)', () => {
  // stageD is not exported (requires live Qdrant to exercise end to end —
  // see this file's own header comment for why source-slicing is this
  // suite's established approach for run.js's internal stage functions).
  // A fragment's entity_id must never be able to point at a canonical
  // entity_raw point that doesn't exist on the server yet — this requires
  // BOTH the call order (entity_raw upsert issued first) AND a real
  // completion guarantee (upsertPointsWithoutVectors' own wait: true,
  // tested directly in qdrant-store-upsert-without-vectors.test.js) since
  // call order alone says nothing about server-side completion order under
  // wait: false. An earlier version of this function upserted fragments
  // FIRST while its own comment claimed the opposite — this test pins the
  // corrected order structurally so the two can never drift apart again.
  const stageDStart = src.indexOf('async function stageD(');
  const stageDEnd = src.indexOf('\nasync function ', stageDStart + 1);
  const stageDBody = src.slice(stageDStart, stageDEnd > -1 ? stageDEnd : undefined);

  it('stageD exists and was located correctly (fixture sanity check)', () => {
    assert.ok(stageDStart > -1, 'expected to find "async function stageD(" in run.js');
    assert.ok(stageDBody.includes('upsertPointsWithoutVectors'), 'expected stageD to call upsertPointsWithoutVectors');
  });

  it('upsertPointsWithoutVectors (entity_raw) is called BEFORE upsertPoints (fragments) in stageD\'s source order', () => {
    const entityRawCallIndex = stageDBody.indexOf('upsertPointsWithoutVectors(');
    // The FIRST upsertPoints(...) call in stageD's body is the fragments
    // commit (pointsWithDense) — the later one, further down, is nav points.
    const fragmentsCallIndex = stageDBody.indexOf('upsertPoints(collection, points)');
    assert.ok(entityRawCallIndex > -1, 'expected an upsertPointsWithoutVectors call in stageD');
    assert.ok(fragmentsCallIndex > -1, 'expected the fragments upsertPoints(collection, points) call in stageD');
    assert.ok(entityRawCallIndex < fragmentsCallIndex, 'upsertPointsWithoutVectors (canonical entity_raw) must appear BEFORE the fragments upsertPoints call in stageD\'s source');
  });
});
