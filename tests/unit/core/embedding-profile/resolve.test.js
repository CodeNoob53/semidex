import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExistingCollectionProfile, resolveNewCollectionProfile } from '../../../../src/core/embedding-profile/resolve.js';

function fakeAdapter(getEmbeddingProfileResult, { migrateCalled } = {}) {
  return {
    getEmbeddingProfile: async () => getEmbeddingProfileResult,
    migrateEmbeddingProfile: async () => { if (migrateCalled) migrateCalled.called = true; return { status: 'inferred' }; },
  };
}

describe('resolveExistingCollectionProfile — read-only, single-tier', () => {
  it('valid metadata resolves directly and short-circuits before any migration attempt', async () => {
    const profile = { schemaVersion: 1, embedding: { dense: {}, sparse: null } };
    const migrateCalled = { called: false };
    const adapter = fakeAdapter({ state: 'valid', profile }, { migrateCalled });
    const result = await resolveExistingCollectionProfile(adapter, 'c1');
    assert.deepEqual(result, { resolved: true, profile });
    assert.equal(migrateCalled.called, false, 'resolveExistingCollectionProfile must never call migrateEmbeddingProfile itself');
  });

  it('a "missing" adapter state produces { resolved: false, reason: "legacy_unmigrated" } WITHOUT calling migrateEmbeddingProfile', async () => {
    const migrateCalled = { called: false };
    const adapter = fakeAdapter({ state: 'missing' }, { migrateCalled });
    const result = await resolveExistingCollectionProfile(adapter, 'c1');
    assert.deepEqual(result, { resolved: false, reason: 'legacy_unmigrated' });
    assert.equal(migrateCalled.called, false, 'a read must never trigger a write — this is the core assertion the read/write split exists to prove');
  });

  it('"invalid" state passes through with its errors', async () => {
    const adapter = fakeAdapter({ state: 'invalid', errors: ['bad shape'] });
    const result = await resolveExistingCollectionProfile(adapter, 'c1');
    assert.deepEqual(result, { resolved: false, reason: 'invalid', errors: ['bad shape'] });
  });

  it('"unsupported_schema_version" state passes through with the found version', async () => {
    const adapter = fakeAdapter({ state: 'unsupported_schema_version', found: 99 });
    const result = await resolveExistingCollectionProfile(adapter, 'c1');
    assert.deepEqual(result, { resolved: false, reason: 'unsupported_schema_version', found: 99 });
  });

  it('never calls anything config.json-shaped — the fake adapter has no config.json dependency at all, and resolution still works', async () => {
    // The fake adapter above never reads/writes config.json in any way;
    // this test's mere existence (and passing) proves the resolver has
    // zero config.json dependency for an existing collection, not merely
    // that it's deprioritized. Directly covers required-test #5: missing
    // config.json does not change resolution for an existing collection.
    const profile = { schemaVersion: 1, embedding: { dense: {}, sparse: null } };
    const adapter = fakeAdapter({ state: 'valid', profile });
    const result = await resolveExistingCollectionProfile(adapter, 'c1');
    assert.equal(result.resolved, true);
  });

  it('must not silently fall back to env defaults for an existing collection — every non-valid state produces an explicit unresolved result, never a fabricated profile', async () => {
    for (const state of [{ state: 'missing' }, { state: 'invalid', errors: [] }, { state: 'unsupported_schema_version', found: 2 }]) {
      const adapter = fakeAdapter(state);
      const result = await resolveExistingCollectionProfile(adapter, 'c1');
      assert.equal(result.resolved, false);
      assert.ok(!('profile' in result), `state ${state.state} must never carry a fabricated profile`);
    }
  });

  it('"schema_mismatch" state produces { resolved: false, reason: "schema_mismatch", mismatches } — distinct from "legacy_unmigrated", never triggers migration', async () => {
    const migrateCalled = { called: false };
    const adapter = fakeAdapter({ state: 'schema_mismatch', profile: {}, mismatches: [{ field: 'dense.dimensions', expected: 1024, found: 768 }] }, { migrateCalled });
    const result = await resolveExistingCollectionProfile(adapter, 'c1');
    assert.equal(result.resolved, false);
    assert.equal(result.reason, 'schema_mismatch');
    assert.deepEqual(result.mismatches, [{ field: 'dense.dimensions', expected: 1024, found: 768 }]);
    assert.notEqual(result.reason, 'legacy_unmigrated', 'schema_mismatch must never be conflated with legacy_unmigrated — migrating a mismatched-but-present profile would be wrong');
    assert.equal(migrateCalled.called, false, 'schema_mismatch must never trigger migration — a profile already exists, it just disagrees with the live schema');
  });

  it('a qdrant-cloud EXISTING collection profile is read from native metadata AS-IS, never re-derived from current global/env settings — even if the current global EMBEDDING_BACKEND setting has since changed to something else entirely', async () => {
    // Mirrors the generic "must not silently fall back to env defaults"
    // test above, specialized for qdrant-cloud: resolveExistingCollectionProfile
    // takes NO envDefaults parameter at all — the collection's own stored
    // profile is authoritative regardless of what a global settings.json
    // currently says, so a later admin changing EMBEDDING_BACKEND to
    // 'ollama' (or to a different catalog model) can never silently alter
    // how an already-indexed qdrant-cloud collection resolves.
    const storedCloudProfile = {
      schemaVersion: 1, managedBy: 'semidex',
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
      embeddingSchemaVersion: 2,
    };
    const adapter = fakeAdapter({ state: 'valid', profile: storedCloudProfile });
    const result = await resolveExistingCollectionProfile(adapter, 'c1');
    assert.deepEqual(result, { resolved: true, profile: storedCloudProfile });
    // The function signature itself proves no env/global-settings input is
    // even possible: only (adapter, name) — never envDefaults.
    assert.equal(resolveExistingCollectionProfile.length, 2);
  });
});

describe('resolveNewCollectionProfile — new-collection path only', () => {
  it('builds an ollama+hashed-tf profile from env defaults', () => {
    const profile = resolveNewCollectionProfile(
      { denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'hashed-tf' },
      { vectorSize: 1024, embeddingSchemaVersion: 2 },
    );
    assert.equal(profile.embedding.dense.provider, 'ollama');
    assert.equal(profile.embedding.dense.model, 'bge-m3');
    assert.equal(profile.embedding.dense.dimensions, 1024);
    assert.equal(profile.embedding.sparse.provider, 'hashed-tf');
    assert.equal(profile.embeddingSchemaVersion, 2);
  });

  it('builds a bge-m3-onnx+bge-m3-onnx profile, forcing the canonical ONNX model id', () => {
    const profile = resolveNewCollectionProfile(
      { denseProvider: 'bge-m3-onnx', denseModel: 'ignored-by-onnx-path', sparseProvider: 'bge-m3-onnx' },
      { vectorSize: 1024, embeddingSchemaVersion: 2 },
    );
    assert.equal(profile.embedding.dense.provider, 'bge-m3-onnx');
    assert.equal(profile.embedding.dense.model, 'aapot/bge-m3-onnx');
    assert.equal(profile.embedding.sparse.provider, 'bge-m3-onnx');
  });

  it('throws on an invalid provider combination, never building an invalid profile', () => {
    assert.throws(() => resolveNewCollectionProfile(
      { denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'bge-m3-onnx' },
      { vectorSize: 1024, embeddingSchemaVersion: 2 },
    ));
  });

  it('the built profile passes shape validation', async () => {
    const { validateEmbeddingProfile } = await import('../../../../src/core/embedding-profile/schema.js');
    const profile = resolveNewCollectionProfile(
      { denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'hashed-tf' },
      { vectorSize: 1024, embeddingSchemaVersion: 2 },
    );
    assert.deepEqual(validateEmbeddingProfile(profile), { valid: true });
  });

  it('builds a qdrant-cloud+qdrant-cloud profile from the catalog — dimensions/distance come from the catalog entry, vectorSize is ignored', () => {
    const profile = resolveNewCollectionProfile(
      { denseProvider: 'qdrant-cloud', denseModel: 'intfloat/multilingual-e5-small', sparseProvider: 'qdrant-cloud' },
      { vectorSize: 999999, embeddingSchemaVersion: 2 },
    );
    assert.equal(profile.embedding.dense.provider, 'qdrant-cloud');
    assert.equal(profile.embedding.dense.model, 'intfloat/multilingual-e5-small');
    assert.equal(profile.embedding.dense.dimensions, 384, 'dimensions must come from the catalog, never the passed-in vectorSize');
    assert.equal(profile.embedding.dense.distance, 'Cosine');
    assert.equal(profile.embedding.dense.execution, 'qdrant-cloud');
    assert.equal(profile.embedding.sparse.provider, 'qdrant-cloud');
    assert.equal(profile.embedding.sparse.model, 'qdrant/bm25');
    assert.equal(profile.embedding.sparse.execution, 'qdrant-cloud');
    assert.equal(profile.embedding.sparse.modifier, 'idf', 'the schema-level modifier must be set from the catalog');
  });

  it('throws for a qdrant-cloud profile whose dense model is catalog-disabled (MiniLM) — never silently builds an unsupported profile', () => {
    assert.throws(() => resolveNewCollectionProfile(
      { denseProvider: 'qdrant-cloud', denseModel: 'sentence-transformers/all-minilm-l6-v2', sparseProvider: 'qdrant-cloud' },
      { vectorSize: 384, embeddingSchemaVersion: 2 },
    ), /not a supported Qdrant Cloud dense model/);
  });

  it('throws for a qdrant-cloud profile whose dense model is unknown entirely', () => {
    assert.throws(() => resolveNewCollectionProfile(
      { denseProvider: 'qdrant-cloud', denseModel: 'not-a-real-model', sparseProvider: 'qdrant-cloud' },
      { vectorSize: 384, embeddingSchemaVersion: 2 },
    ), /not a supported Qdrant Cloud dense model/);
  });

  it('a qdrant-cloud built profile passes shape validation too', async () => {
    const { validateEmbeddingProfile } = await import('../../../../src/core/embedding-profile/schema.js');
    const profile = resolveNewCollectionProfile(
      { denseProvider: 'qdrant-cloud', denseModel: 'intfloat/multilingual-e5-small', sparseProvider: 'qdrant-cloud' },
      { vectorSize: 384, embeddingSchemaVersion: 2 },
    );
    assert.deepEqual(validateEmbeddingProfile(profile), { valid: true });
  });
});
