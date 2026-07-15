import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

  test('passes options through to the backend factory unchanged (Phase 4A.5a)', async () => {
    // Regression: createGenerationProvider() used to select a backend but
    // never forward any provider-specific configuration into its factory —
    // model/baseUrl/numCtx had no clean path from resolved config into the
    // actual provider. Verified via the real ollama-provider's ready(),
    // which surfaces baseUrl in an unreachable reason and model verbatim.
    const provider = createGenerationProvider({
      backend: 'ollama',
      options: {
        model: 'custom-model:1b',
        baseUrl: 'http://registry-passthrough-check:11434',
        isOllamaReachableFn: async () => false,
      },
    });
    const readiness = await provider.ready();
    assert.equal(readiness.model, 'custom-model:1b');
    assert.match(readiness.reason, /registry-passthrough-check:11434/);
  });

  test('registry.js source never reads process.env — backend/options are caller-supplied only', async () => {
    // A cloud-neutral registry must not assume any env var names, so a
    // future cloud provider's registration never depends on this file
    // knowing what those names are — enforced at the source level, since a
    // behavioral test can't prove an absence of reads that happen not to
    // matter for a specific call's inputs.
    const src = await readFile(new URL('../../../../src/core/generation/registry.js', import.meta.url), 'utf-8');
    // Matches an actual property read (process.env.SOMETHING), not prose
    // mentioning "process.env" in a comment explaining the constraint.
    assert.ok(!/process\.env\./.test(src), 'registry.js must not read any process.env.* value');
  });
});
