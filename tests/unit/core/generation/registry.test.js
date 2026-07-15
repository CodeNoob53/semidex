import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationProvider } from '../../../../src/core/generation/registry.js';
import { validateGenerationProvider } from '../../../../src/core/generation/provider.js';

describe('createGenerationProvider', () => {
  test('defaults to the ollama backend', () => {
    const provider = createGenerationProvider();
    assert.equal(provider.name(), 'ollama');
    assert.equal(validateGenerationProvider(provider), true);
  });

  test('throws an actionable error for an unknown backend', () => {
    assert.throws(
      () => createGenerationProvider({ backend: 'nonexistent' }),
      /unknown backend "nonexistent".*known backends: ollama/
    );
  });
});
