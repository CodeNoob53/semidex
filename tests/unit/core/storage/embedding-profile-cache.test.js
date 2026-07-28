import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createProfileCache } from '../../../../src/core/storage/embedding-profile-cache.js';

describe('createProfileCache', () => {
  it('returns undefined for a name never set', () => {
    const cache = createProfileCache();
    assert.equal(cache.get('missing'), undefined);
  });

  it('get returns exactly what was set', () => {
    const cache = createProfileCache();
    const value = { state: 'valid', profile: { schemaVersion: 1 } };
    cache.set('c1', value);
    assert.equal(cache.get('c1'), value);
  });

  it('entries expire after ttlMs and are re-resolved (return undefined)', () => {
    mock.timers.enable({ apis: ['Date'] });
    try {
      const cache = createProfileCache({ ttlMs: 100 });
      cache.set('c1', { state: 'valid' });
      assert.notEqual(cache.get('c1'), undefined);
      mock.timers.tick(101);
      assert.equal(cache.get('c1'), undefined);
    } finally {
      mock.timers.reset();
    }
  });

  it('invalidate(name) removes only that entry', () => {
    const cache = createProfileCache();
    cache.set('c1', { state: 'valid' });
    cache.set('c2', { state: 'valid' });
    cache.invalidate('c1');
    assert.equal(cache.get('c1'), undefined);
    assert.notEqual(cache.get('c2'), undefined);
  });

  it('invalidateAll() clears every entry', () => {
    const cache = createProfileCache();
    cache.set('c1', { state: 'valid' });
    cache.set('c2', { state: 'valid' });
    cache.invalidateAll();
    assert.equal(cache.get('c1'), undefined);
    assert.equal(cache.get('c2'), undefined);
  });

  it('a non-valid (missing/invalid) result can be cached short-term, and is never permanent — expires like any other entry', () => {
    mock.timers.enable({ apis: ['Date'] });
    try {
      const cache = createProfileCache({ ttlMs: 50 });
      cache.set('broken', { state: 'missing' });
      assert.deepEqual(cache.get('broken'), { state: 'missing' });
      mock.timers.tick(51);
      assert.equal(cache.get('broken'), undefined, 'a missing/invalid result must not be cached permanently');
    } finally {
      mock.timers.reset();
    }
  });

  it('default ttlMs is used when no override is passed', () => {
    const cache = createProfileCache();
    cache.set('c1', { state: 'valid' });
    // Not expired immediately after set — default TTL is well above 0ms.
    assert.notEqual(cache.get('c1'), undefined);
  });
});
