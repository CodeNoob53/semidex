import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateGenerationProvider, REQUIRED_PROVIDER_METHODS } from '../../../../src/core/generation/provider.js';

function validProvider() {
  return {
    name: () => 'fake',
    capabilities: () => ({ streaming: true, cancellation: true }),
    ready: async () => ({ ok: true }),
    generate: async () => ({ text: 'x' }),
  };
}

describe('validateGenerationProvider', () => {
  test('accepts a conforming provider', () => {
    assert.equal(validateGenerationProvider(validProvider()), true);
  });

  test('rejects non-object input', () => {
    assert.throws(() => validateGenerationProvider(null), /non-null object/);
    assert.throws(() => validateGenerationProvider('nope'), /non-null object/);
  });

  test('rejects a provider missing required methods', () => {
    for (const method of REQUIRED_PROVIDER_METHODS) {
      const p = validProvider();
      delete p[method];
      assert.throws(() => validateGenerationProvider(p), new RegExp(method));
    }
  });

  test('rejects a provider whose capabilities() is not a plain object', () => {
    const p = validProvider();
    p.capabilities = () => null;
    assert.throws(() => validateGenerationProvider(p), /plain object/);
    p.capabilities = () => [1, 2];
    assert.throws(() => validateGenerationProvider(p), /plain object/);
  });
});
