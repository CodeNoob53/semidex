import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPABILITIES, mergeCapabilities } from '../../../../src/core/storage/capabilities.js';

describe('DEFAULT_CAPABILITIES', () => {
  it('is frozen and cannot be mutated', () => {
    assert.throws(() => { DEFAULT_CAPABILITIES.namedVectors = true; }, TypeError);
  });

  it('has every capability false by default', () => {
    for (const value of Object.values(DEFAULT_CAPABILITIES)) {
      assert.equal(value, false);
    }
  });
});

describe('mergeCapabilities', () => {
  it('returns all defaults when called with no arguments', () => {
    assert.deepEqual(mergeCapabilities(), DEFAULT_CAPABILITIES);
  });

  it('overrides known keys', () => {
    const merged = mergeCapabilities({ hybridSearch: true, aliases: true });
    assert.equal(merged.hybridSearch, true);
    assert.equal(merged.aliases, true);
    assert.equal(merged.snapshots, false);
  });

  it('does not mutate DEFAULT_CAPABILITIES', () => {
    mergeCapabilities({ namedVectors: true });
    assert.equal(DEFAULT_CAPABILITIES.namedVectors, false);
  });

  it('ignores unknown capability keys rather than throwing', () => {
    const merged = mergeCapabilities({ someFutureFlag: true });
    assert.equal(merged.someFutureFlag, undefined);
    assert.deepEqual(Object.keys(merged).sort(), Object.keys(DEFAULT_CAPABILITIES).sort());
  });

  it('returns a fresh object each call (no shared reference)', () => {
    const a = mergeCapabilities({ aliases: true });
    const b = mergeCapabilities();
    a.aliases = false;
    assert.equal(b.aliases, false);
    assert.notEqual(a, b);
  });
});
