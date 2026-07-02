import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_ADAPTER_METHODS, validateStorageAdapter } from '../../../../src/core/storage/adapter.js';

function makeValidAdapter(overrides = {}) {
  const base = {};
  for (const method of REQUIRED_ADAPTER_METHODS) {
    base[method] = method === 'capabilities' ? () => ({}) : async () => null;
  }
  return { ...base, ...overrides };
}

describe('REQUIRED_ADAPTER_METHODS', () => {
  it('is a non-empty array of method names', () => {
    assert.ok(Array.isArray(REQUIRED_ADAPTER_METHODS));
    assert.ok(REQUIRED_ADAPTER_METHODS.length > 0);
    assert.ok(REQUIRED_ADAPTER_METHODS.includes('capabilities'));
    assert.ok(REQUIRED_ADAPTER_METHODS.includes('searchHybrid'));
  });
});

describe('validateStorageAdapter — success', () => {
  it('accepts an object implementing every required method', () => {
    assert.equal(validateStorageAdapter(makeValidAdapter()), true);
  });
});

describe('validateStorageAdapter — failure', () => {
  it('rejects null', () => {
    assert.throws(() => validateStorageAdapter(null), /non-null object/);
  });

  it('rejects a non-object', () => {
    assert.throws(() => validateStorageAdapter('qdrant'), /non-null object/);
  });

  it('rejects an adapter missing a required method', () => {
    const adapter = makeValidAdapter();
    delete adapter.deleteCollection;
    assert.throws(() => validateStorageAdapter(adapter), /missing required method\(s\).*deleteCollection/);
  });

  it('rejects an adapter with a non-function in place of a required method', () => {
    const adapter = makeValidAdapter({ ping: 'not a function' });
    assert.throws(() => validateStorageAdapter(adapter), /missing required method\(s\).*ping/);
  });

  it('lists every missing method in the error message', () => {
    const adapter = makeValidAdapter();
    delete adapter.name;
    delete adapter.ping;
    assert.throws(() => validateStorageAdapter(adapter), /name.*ping|ping.*name/);
  });

  it('rejects when capabilities() does not return a plain object', () => {
    const adapter = makeValidAdapter({ capabilities: () => null });
    assert.throws(() => validateStorageAdapter(adapter), /capabilities\(\) must return a plain object/);
  });

  it('rejects when capabilities() returns an array', () => {
    const adapter = makeValidAdapter({ capabilities: () => [] });
    assert.throws(() => validateStorageAdapter(adapter), /capabilities\(\) must return a plain object/);
  });

  it('rejects when capabilities() returns a primitive', () => {
    const adapter = makeValidAdapter({ capabilities: () => 'qdrant' });
    assert.throws(() => validateStorageAdapter(adapter), /capabilities\(\) must return a plain object/);
  });
});
