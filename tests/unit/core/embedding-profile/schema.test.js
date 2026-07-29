// Pure unit tests for the provider-neutral embedding profile domain
// contract (src/core/embedding-profile/schema.js). No Qdrant-shaped
// fixture appears anywhere in this file — only the domain shapes
// themselves are constructed/validated, confirming schema.js never needs
// to know about Qdrant response shapes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBEDDING_PROFILE_SCHEMA_VERSION, MANAGED_BY, EXECUTION,
  METADATA_KEY_EMBEDDING_PROFILE, METADATA_KEY_INDEXING_STATE,
  buildEmbeddingProfile, validateEmbeddingProfile,
  buildIndexingState, validateIndexingState,
} from '../../../../src/core/embedding-profile/schema.js';

function validDense(overrides = {}) {
  return {
    provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', vectorName: 'dense',
    dimensions: 1024, distance: 'Cosine', execution: EXECUTION.CLIENT,
    ...overrides,
  };
}

function validSparse(overrides = {}) {
  return {
    provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', vectorName: 'sparse',
    execution: EXECUTION.CLIENT,
    ...overrides,
  };
}

describe('embedding-profile/schema — constants', () => {
  it('METADATA_KEY_EMBEDDING_PROFILE and METADATA_KEY_INDEXING_STATE are distinct keys', () => {
    assert.notEqual(METADATA_KEY_EMBEDDING_PROFILE, METADATA_KEY_INDEXING_STATE);
    assert.equal(METADATA_KEY_EMBEDDING_PROFILE, 'semidex_embedding_profile');
    assert.equal(METADATA_KEY_INDEXING_STATE, 'semidex_indexing_state');
  });

  it('EXECUTION has exactly client, qdrant-cluster, qdrant-cloud', () => {
    assert.deepEqual(Object.values(EXECUTION).sort(), ['client', 'qdrant-cloud', 'qdrant-cluster']);
  });
});

describe('buildEmbeddingProfile + validateEmbeddingProfile — valid shapes', () => {
  it('builds and validates a dense+sparse profile', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), sparse: validSparse(), embeddingSchemaVersion: 2 });
    assert.equal(profile.schemaVersion, EMBEDDING_PROFILE_SCHEMA_VERSION);
    assert.equal(profile.managedBy, MANAGED_BY);
    assert.equal(profile.embedding.dense.dimensions, 1024);
    assert.equal(profile.embedding.sparse.vectorName, 'sparse');
    assert.equal(profile.embeddingSchemaVersion, 2);
    assert.deepEqual(validateEmbeddingProfile(profile), { valid: true });
  });

  it('builds and validates a dense-only profile (sparse: null is valid, not a fake object)', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), sparse: null, embeddingSchemaVersion: 2 });
    assert.equal(profile.embedding.sparse, null);
    assert.deepEqual(validateEmbeddingProfile(profile), { valid: true });
  });

  it('defaults sparse to null when omitted entirely', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), embeddingSchemaVersion: 2 });
    assert.equal(profile.embedding.sparse, null);
  });

  it('options: null and options: {} are both accepted on dense and sparse', () => {
    const p1 = buildEmbeddingProfile({ dense: validDense({ options: null }), sparse: validSparse({ options: {} }), embeddingSchemaVersion: 2 });
    assert.deepEqual(validateEmbeddingProfile(p1), { valid: true });
  });

  it('an arbitrary non-secret options object is accepted and round-trips unchanged', () => {
    const opts = { tokenizer: 'multilingual', stemming: false };
    const profile = buildEmbeddingProfile({ dense: validDense({ options: opts }), sparse: null, embeddingSchemaVersion: 2 });
    assert.deepEqual(profile.embedding.dense.options, opts);
    assert.deepEqual(validateEmbeddingProfile(profile), { valid: true });
  });

  it('sparse.modifier "idf" is accepted and distinct from options', () => {
    const profile = buildEmbeddingProfile({
      dense: validDense(),
      sparse: validSparse({ modifier: 'idf', options: { tokenizer: 'multilingual' } }),
      embeddingSchemaVersion: 2,
    });
    assert.equal(profile.embedding.sparse.modifier, 'idf');
    assert.deepEqual(profile.embedding.sparse.options, { tokenizer: 'multilingual' });
    assert.deepEqual(validateEmbeddingProfile(profile), { valid: true });
  });

  it('sparse.modifier defaults to null when omitted', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), sparse: validSparse(), embeddingSchemaVersion: 2 });
    assert.equal(profile.embedding.sparse.modifier, null);
  });
});

describe('validateEmbeddingProfile — rejected shapes', () => {
  it('rejects a non-object profile', () => {
    assert.equal(validateEmbeddingProfile(null).valid, false);
    assert.equal(validateEmbeddingProfile('nope').valid, false);
    assert.equal(validateEmbeddingProfile([1, 2]).valid, false);
  });

  it('rejects an unknown top-level key', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), embeddingSchemaVersion: 2 });
    profile.extraField = 'nope';
    const result = validateEmbeddingProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('extraField')));
  });

  it('rejects wrong schemaVersion', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), embeddingSchemaVersion: 2 });
    profile.schemaVersion = 99;
    assert.equal(validateEmbeddingProfile(profile).valid, false);
  });

  it('rejects wrong managedBy', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), embeddingSchemaVersion: 2 });
    profile.managedBy = 'someone-else';
    assert.equal(validateEmbeddingProfile(profile).valid, false);
  });

  it('rejects a dense lane with an invalid execution value', () => {
    const profile = buildEmbeddingProfile({ dense: validDense({ execution: 'made-up' }), embeddingSchemaVersion: 2 });
    assert.equal(validateEmbeddingProfile(profile).valid, false);
  });

  it('REGRESSION: rejects a profile whose dense and sparse lanes declare DIFFERENT execution modes — schema-shape-valid but no implemented runtime path can execute it correctly', () => {
    const profile = buildEmbeddingProfile({
      dense: validDense({ execution: EXECUTION.CLIENT }),
      sparse: validSparse({ execution: EXECUTION.QDRANT_CLOUD }),
      embeddingSchemaVersion: 2,
    });
    const result = validateEmbeddingProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('execution') && e.includes('must match')));
  });

  it('the reverse mismatch (dense=qdrant-cloud, sparse=client) is also rejected', () => {
    const profile = buildEmbeddingProfile({
      dense: validDense({ execution: EXECUTION.QDRANT_CLOUD, provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small' }),
      sparse: validSparse({ execution: EXECUTION.CLIENT }),
      embeddingSchemaVersion: 2,
    });
    assert.equal(validateEmbeddingProfile(profile).valid, false);
  });

  it('matching execution across both lanes (client:client, or qdrant-cloud:qdrant-cloud) is still accepted', () => {
    const clientBoth = buildEmbeddingProfile({ dense: validDense(), sparse: validSparse(), embeddingSchemaVersion: 2 });
    assert.equal(validateEmbeddingProfile(clientBoth).valid, true);

    const cloudBoth = buildEmbeddingProfile({
      dense: validDense({ execution: EXECUTION.QDRANT_CLOUD, provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', dimensions: 384 }),
      sparse: validSparse({ execution: EXECUTION.QDRANT_CLOUD, provider: 'qdrant-cloud', model: 'qdrant/bm25' }),
      embeddingSchemaVersion: 2,
    });
    assert.equal(validateEmbeddingProfile(cloudBoth).valid, true);
  });

  it('a dense-only profile (sparse: null) is unaffected by the cross-lane execution check — nothing to mismatch against', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), sparse: null, embeddingSchemaVersion: 2 });
    assert.equal(validateEmbeddingProfile(profile).valid, true);
  });

  it('rejects a dense lane with non-positive dimensions', () => {
    const profile = buildEmbeddingProfile({ dense: validDense({ dimensions: 0 }), embeddingSchemaVersion: 2 });
    assert.equal(validateEmbeddingProfile(profile).valid, false);
  });

  it('rejects a sparse lane that is present but not an object', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), embeddingSchemaVersion: 2 });
    profile.embedding.sparse = 'not-an-object';
    assert.equal(validateEmbeddingProfile(profile).valid, false);
  });

  it('rejects an unknown key inside the dense lane', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), embeddingSchemaVersion: 2 });
    profile.embedding.dense.bogus = true;
    const result = validateEmbeddingProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('bogus')));
  });

  it('rejects a secret-shaped top-level key', () => {
    const profile = buildEmbeddingProfile({ dense: validDense(), embeddingSchemaVersion: 2 });
    profile.apiKey = 'sk-should-never-be-here';
    const result = validateEmbeddingProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.toLowerCase().includes('secret-shaped')));
  });

  it('rejects a secret-shaped key nested inside dense.options (not shallow/top-level-only)', () => {
    const profile = buildEmbeddingProfile({ dense: validDense({ options: { apiKey: 'x' } }), embeddingSchemaVersion: 2 });
    const result = validateEmbeddingProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('apiKey')));
  });

  it('rejects a secret-shaped key nested inside sparse.options', () => {
    const profile = buildEmbeddingProfile({
      dense: validDense(),
      sparse: validSparse({ options: { credential: 'x' } }),
      embeddingSchemaVersion: 2,
    });
    const result = validateEmbeddingProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('credential')));
  });

  it('rejects various secret-shaped key name patterns (token, password, secret)', () => {
    for (const key of ['authToken', 'password', 'clientSecret']) {
      const profile = buildEmbeddingProfile({ dense: validDense(), embeddingSchemaVersion: 2 });
      profile.embedding.dense.options = { [key]: 'x' };
      const result = validateEmbeddingProfile(profile);
      assert.equal(result.valid, false, `expected "${key}" to be rejected`);
    }
  });
});

describe('buildIndexingState + validateIndexingState', () => {
  it('builds and validates a valid state', () => {
    const state = buildIndexingState({ indexingSchemaVersion: 4, chunkingSchemaVersion: 4 });
    assert.deepEqual(state, { indexingSchemaVersion: 4, chunkingSchemaVersion: 4 });
    assert.deepEqual(validateIndexingState(state), { valid: true });
  });

  it('rejects a non-object state', () => {
    assert.equal(validateIndexingState(null).valid, false);
    assert.equal(validateIndexingState('nope').valid, false);
  });

  it('rejects an unknown key', () => {
    const state = buildIndexingState({ indexingSchemaVersion: 4, chunkingSchemaVersion: 4 });
    state.extra = true;
    assert.equal(validateIndexingState(state).valid, false);
  });

  it('rejects a secret-shaped key', () => {
    const state = buildIndexingState({ indexingSchemaVersion: 4, chunkingSchemaVersion: 4 });
    state.apiSecret = 'x';
    assert.equal(validateIndexingState(state).valid, false);
  });

  it('rejects non-numeric version fields', () => {
    assert.equal(validateIndexingState({ indexingSchemaVersion: '4', chunkingSchemaVersion: 4 }).valid, false);
    assert.equal(validateIndexingState({ indexingSchemaVersion: 4, chunkingSchemaVersion: null }).valid, false);
  });
});
