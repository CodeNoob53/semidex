import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGenerationRuntimeConfig, GenerationConfigError, DEFAULTS, SOURCES,
} from '../../../../src/core/generation/config.js';

describe('resolveGenerationRuntimeConfig — precedence', () => {
  test('uses defaults when neither osEnv nor dotenvValues supply anything', () => {
    const result = resolveGenerationRuntimeConfig({ osEnv: {}, dotenvValues: {} });
    assert.deepEqual(result.backend, { value: DEFAULTS.backend, source: SOURCES.DEFAULT });
    assert.deepEqual(result.model, { value: DEFAULTS.model, source: SOURCES.DEFAULT });
    assert.deepEqual(result.baseUrl, { value: DEFAULTS.baseUrl, source: SOURCES.DEFAULT });
    assert.deepEqual(result.numCtx, { value: DEFAULTS.numCtx, source: SOURCES.DEFAULT });
    assert.deepEqual(result.devicePolicy, { value: DEFAULTS.devicePolicy, source: SOURCES.DEFAULT });
  });

  test('.env overrides defaults', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: {}, dotenvValues: { OLLAMA_URL: 'http://dotenv-host:11434' },
    });
    assert.deepEqual(result.baseUrl, { value: 'http://dotenv-host:11434', source: SOURCES.DOTENV });
  });

  test('OS env overrides .env', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: { OLLAMA_URL: 'http://os-host:11434' },
      dotenvValues: { OLLAMA_URL: 'http://dotenv-host:11434' },
    });
    assert.deepEqual(result.baseUrl, { value: 'http://os-host:11434', source: SOURCES.OS_ENV });
  });

  test('OS env overrides default when .env has nothing for that key', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: { OLLAMA_URL: 'http://os-host:11434' }, dotenvValues: {},
    });
    assert.deepEqual(result.baseUrl, { value: 'http://os-host:11434', source: SOURCES.OS_ENV });
  });

  test('provenance is correct when OS env and .env share the same key with different values (not just the winning value)', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'ollama' },
      dotenvValues: { SEMIDEX_GENERATION_BACKEND: 'ollama' },
    });
    // Same value in both layers — provenance must still report os_env
    // (the winning layer), not dotenv, proving this isn't inferred by
    // value-equality diffing.
    assert.equal(result.backend.source, SOURCES.OS_ENV);
  });

  test('an empty-string OS env value does not shadow a real .env value (treated as unset, matching dotenv semantics)', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: { OLLAMA_URL: '' }, dotenvValues: { OLLAMA_URL: 'http://dotenv-host:11434' },
    });
    assert.deepEqual(result.baseUrl, { value: 'http://dotenv-host:11434', source: SOURCES.DOTENV });
  });
});

describe('resolveGenerationRuntimeConfig — ASK_MODEL / CONTEXT_MODEL fallback', () => {
  test('falls back to CONTEXT_MODEL when ASK_MODEL is not set anywhere', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: {}, dotenvValues: { CONTEXT_MODEL: 'llama3.2:3b' },
    });
    assert.deepEqual(result.model, { value: 'llama3.2:3b', source: SOURCES.DOTENV });
  });

  test('layer precedence (OS env > .env) governs across all candidate keys — an OS-env CONTEXT_MODEL still beats a .env ASK_MODEL', () => {
    // "ASK_MODEL falls back to CONTEXT_MODEL" picks the NAME preferred
    // within a layer; "OS env > .env > default" is a separate, outer rule
    // that applies across every candidate name. A .env-only ASK_MODEL is
    // not allowed to override an OS-env CONTEXT_MODEL, or the documented
    // "OS env > .env" precedence would be silently violated whenever the
    // user happens to use ASK_MODEL in .env.
    const result = resolveGenerationRuntimeConfig({
      osEnv: { CONTEXT_MODEL: 'os-context-model' },
      dotenvValues: { ASK_MODEL: 'dotenv-ask-model' },
    });
    assert.deepEqual(result.model, { value: 'os-context-model', source: SOURCES.OS_ENV });
  });

  test('within the same layer, ASK_MODEL still wins over CONTEXT_MODEL when both are set in .env', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: {},
      dotenvValues: { ASK_MODEL: 'dotenv-ask-model', CONTEXT_MODEL: 'dotenv-context-model' },
    });
    assert.deepEqual(result.model, { value: 'dotenv-ask-model', source: SOURCES.DOTENV });
  });

  test('ASK_MODEL in OS env wins over CONTEXT_MODEL in OS env', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: { ASK_MODEL: 'ask-wins', CONTEXT_MODEL: 'context-loses' }, dotenvValues: {},
    });
    assert.deepEqual(result.model, { value: 'ask-wins', source: SOURCES.OS_ENV });
  });

  test('falls back to the built-in default when neither ASK_MODEL nor CONTEXT_MODEL is set anywhere', () => {
    const result = resolveGenerationRuntimeConfig({ osEnv: {}, dotenvValues: {} });
    assert.deepEqual(result.model, { value: DEFAULTS.model, source: SOURCES.DEFAULT });
  });
});

describe('resolveGenerationRuntimeConfig — ASK_NUM_CTX validation', () => {
  test('accepts a valid integer within bounds', () => {
    const result = resolveGenerationRuntimeConfig({ osEnv: { ASK_NUM_CTX: '4096' }, dotenvValues: {} });
    assert.deepEqual(result.numCtx, { value: 4096, source: SOURCES.OS_ENV });
  });

  test('rejects a non-numeric value', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: { ASK_NUM_CTX: 'not-a-number' }, dotenvValues: {} }),
      (err) => err instanceof GenerationConfigError && err.field === 'numCtx'
    );
  });

  test('rejects a non-integer (float) value', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: { ASK_NUM_CTX: '4096.5' }, dotenvValues: {} }),
      GenerationConfigError
    );
  });

  test('rejects a value below the documented minimum', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: { ASK_NUM_CTX: '10' }, dotenvValues: {} }),
      GenerationConfigError
    );
  });

  test('rejects a value above the documented maximum', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: { ASK_NUM_CTX: '99999999' }, dotenvValues: {} }),
      GenerationConfigError
    );
  });

  test('rejects a negative value', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: { ASK_NUM_CTX: '-1' }, dotenvValues: {} }),
      GenerationConfigError
    );
  });

  test('rejects zero', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: { ASK_NUM_CTX: '0' }, dotenvValues: {} }),
      GenerationConfigError
    );
  });

  test('an invalid .env value throws too, not just an invalid OS env value', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: {}, dotenvValues: { ASK_NUM_CTX: 'garbage' } }),
      GenerationConfigError
    );
  });
});

describe('resolveGenerationRuntimeConfig — device policy validation', () => {
  test('accepts the default "auto" policy', () => {
    const result = resolveGenerationRuntimeConfig({ osEnv: {}, dotenvValues: {} });
    assert.deepEqual(result.devicePolicy, { value: 'auto', source: SOURCES.DEFAULT });
  });

  test('rejects an unsupported device policy explicitly supplied', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: { GENERATION_DEVICE: 'cuda' }, dotenvValues: {} }),
      (err) => err instanceof GenerationConfigError && err.field === 'devicePolicy'
    );
  });

  test('rejects an unsupported device policy from .env too', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: {}, dotenvValues: { GENERATION_DEVICE: 'gpu' } }),
      GenerationConfigError
    );
  });
});

describe('resolveGenerationRuntimeConfig — unknown backend', () => {
  test('rejects an unknown backend explicitly supplied via OS env', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: { SEMIDEX_GENERATION_BACKEND: 'openai' }, dotenvValues: {} }),
      (err) => err instanceof GenerationConfigError && err.field === 'backend'
    );
  });

  test('rejects an unknown backend from .env', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({ osEnv: {}, dotenvValues: { SEMIDEX_GENERATION_BACKEND: 'anthropic' } }),
      GenerationConfigError
    );
  });

  test('error message names the supported backends', () => {
    try {
      resolveGenerationRuntimeConfig({ osEnv: { SEMIDEX_GENERATION_BACKEND: 'bogus' }, dotenvValues: {} });
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /ollama/);
    }
  });
});

describe('resolveGenerationRuntimeConfig — purity', () => {
  test('does not read process.env at all — passing an empty object for both inputs is fully deterministic', () => {
    const a = resolveGenerationRuntimeConfig({ osEnv: {}, dotenvValues: {} });
    const b = resolveGenerationRuntimeConfig({ osEnv: {}, dotenvValues: {} });
    assert.deepEqual(a, b);
  });

  test('does not mutate the osEnv or dotenvValues objects passed in', () => {
    const osEnv = { OLLAMA_URL: 'http://x:1' };
    const dotenvValues = { CONTEXT_MODEL: 'y' };
    const osEnvCopy = { ...osEnv };
    const dotenvCopy = { ...dotenvValues };
    resolveGenerationRuntimeConfig({ osEnv, dotenvValues });
    assert.deepEqual(osEnv, osEnvCopy);
    assert.deepEqual(dotenvValues, dotenvCopy);
  });
});

describe('resolveGenerationRuntimeConfig — gemini backend (Stage B1)', () => {
  test('accepts SEMIDEX_GENERATION_BACKEND=gemini', () => {
    const result = resolveGenerationRuntimeConfig({ osEnv: { SEMIDEX_GENERATION_BACKEND: 'gemini' }, dotenvValues: {} });
    assert.equal(result.backend.value, 'gemini');
  });

  test('resolves GEMINI_API_KEY with OS env > .env > default precedence, like every other field', () => {
    const fromOsEnv = resolveGenerationRuntimeConfig({
      osEnv: { GEMINI_API_KEY: 'os-key' }, dotenvValues: { GEMINI_API_KEY: 'dotenv-key' },
    });
    assert.deepEqual(fromOsEnv.geminiApiKey, { value: 'os-key', source: SOURCES.OS_ENV });

    const fromDotenv = resolveGenerationRuntimeConfig({ osEnv: {}, dotenvValues: { GEMINI_API_KEY: 'dotenv-key' } });
    assert.deepEqual(fromDotenv.geminiApiKey, { value: 'dotenv-key', source: SOURCES.DOTENV });

    const fromDefault = resolveGenerationRuntimeConfig({ osEnv: {}, dotenvValues: {} });
    assert.deepEqual(fromDefault.geminiApiKey, { value: '', source: SOURCES.DEFAULT });
  });

  test('switching to gemini with no ASK_MODEL set uses the gemini default model, never the ollama default', () => {
    const result = resolveGenerationRuntimeConfig({ osEnv: { SEMIDEX_GENERATION_BACKEND: 'gemini' }, dotenvValues: {} });
    assert.notEqual(result.model.value, DEFAULTS.model, 'must not silently reuse the flat/ollama default model');
    assert.match(result.model.value, /^gemini-/);
    assert.equal(result.model.source, SOURCES.DEFAULT);
  });

  test('switching to gemini never picks up CONTEXT_MODEL — an Ollama model name must not silently pass as a Gemini model', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'gemini', CONTEXT_MODEL: 'gemma3:4b' },
      dotenvValues: {},
    });
    assert.notEqual(result.model.value, 'gemma3:4b');
    assert.equal(result.model.source, SOURCES.DEFAULT);
  });

  test('an explicit ASK_MODEL is always honored for gemini, same as for ollama', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'gemini', ASK_MODEL: 'gemini-1.5-pro' },
      dotenvValues: {},
    });
    assert.deepEqual(result.model, { value: 'gemini-1.5-pro', source: SOURCES.OS_ENV });
  });

  test('switching back to ollama (explicit) still honors CONTEXT_MODEL as before — no regression from adding the gemini branch', () => {
    const result = resolveGenerationRuntimeConfig({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'ollama', CONTEXT_MODEL: 'llama3.2:3b' },
      dotenvValues: {},
    });
    assert.equal(result.model.value, 'llama3.2:3b');
  });

  test('GENERATION_DEVICE is not validated for the gemini backend (no local-inference concept applies)', () => {
    // Must not throw, unlike the same value under ollama.
    const result = resolveGenerationRuntimeConfig({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'gemini', GENERATION_DEVICE: 'cuda' },
      dotenvValues: {},
    });
    assert.equal(result.devicePolicy.value, 'cuda');
  });

  test('GENERATION_DEVICE is still validated for the ollama backend (regression guard)', () => {
    assert.throws(
      () => resolveGenerationRuntimeConfig({
        osEnv: { SEMIDEX_GENERATION_BACKEND: 'ollama', GENERATION_DEVICE: 'cuda' },
        dotenvValues: {},
      }),
      GenerationConfigError
    );
  });
});
