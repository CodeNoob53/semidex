import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateStorageAdapter } from '../../../../src/core/storage/adapter.js';
import { createStorageAdapter } from '../../../../src/core/storage/factory.js';

describe('createStorageAdapter', () => {
  it('defaults to the qdrant backend', () => {
    const adapter = createStorageAdapter();
    assert.equal(adapter.name(), 'qdrant');
  });

  it('honors an explicit backend option', () => {
    const adapter = createStorageAdapter({ backend: 'qdrant' });
    assert.equal(adapter.name(), 'qdrant');
  });

  it('honors SEMIDEX_STORAGE_BACKEND when no option is passed', () => {
    process.env.SEMIDEX_STORAGE_BACKEND = 'qdrant';
    try {
      const adapter = createStorageAdapter();
      assert.equal(adapter.name(), 'qdrant');
    } finally {
      delete process.env.SEMIDEX_STORAGE_BACKEND;
    }
  });

  it('throws a clear error for an unknown backend', () => {
    assert.throws(
      () => createStorageAdapter({ backend: 'sqlite' }),
      /unknown backend "sqlite"/,
    );
  });

  it('the returned adapter validates through validateStorageAdapter', () => {
    assert.equal(validateStorageAdapter(createStorageAdapter()), true);
  });
});
