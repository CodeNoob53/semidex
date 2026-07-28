import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCollectionConfigEntry } from '../../../../src/core/embedding-profile/config-cache.js';
import { buildEmbeddingProfile } from '../../../../src/core/embedding-profile/schema.js';

function profile(overrides = {}) {
  return buildEmbeddingProfile({
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
    embeddingSchemaVersion: 2,
    ...overrides,
  });
}

describe('resolveCollectionConfigEntry — profile in, config.json entry out (pure)', () => {
  it('derives every field from the resolved profile, refreshing an existing entry', () => {
    const entry = resolveCollectionConfigEntry(profile(), { denseProvider: 'stale', description: 'my collection' });
    assert.deepEqual(entry, {
      denseProvider: 'ollama',
      denseModel: 'bge-m3',
      sparseProvider: 'hashed-tf',
      embeddingSchemaVersion: 2,
      vectorSize: 1024,
      description: 'my collection',
    });
  });

  it('a dense-only profile (sparse: null) produces sparseProvider: null, not a fabricated value', () => {
    const p = buildEmbeddingProfile({
      dense: { provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
      sparse: null,
      embeddingSchemaVersion: 2,
    });
    const entry = resolveCollectionConfigEntry(p, undefined);
    assert.equal(entry.sparseProvider, null);
  });

  it('description defaults to empty string when no existing entry is present (brand-new cache write)', () => {
    const entry = resolveCollectionConfigEntry(profile(), undefined);
    assert.equal(entry.description, '');
  });

  it('description is preserved from the existing entry even when the profile itself changes (e.g. after migration)', () => {
    const entry = resolveCollectionConfigEntry(profile(), { description: 'kept description' });
    assert.equal(entry.description, 'kept description');
  });
});
