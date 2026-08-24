import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationRuntime } from '../../../../src/core/generation/runtime.js';
import { validateGenerationProvider } from '../../../../src/core/generation/provider.js';

function fakeProvider({ name = 'ollama', ready, generate } = {}) {
  return {
    name: () => name,
    capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true, hardOutputCap: true }),
    ready: ready ?? (async () => ({ ok: true, model: 'gemma3:4b', numCtx: 8192 })),
    generate: generate ?? (async () => ({ text: 'ok', aborted: false })),
  };
}

describe('createGenerationRuntime — happy path, conforms to GenerationProvider', () => {
  test('conforms to the GenerationProvider shape', () => {
    const runtime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider(),
    });
    assert.equal(validateGenerationProvider(runtime), true);
  });

  test('delegates ready()/generate()/name()/capabilities() to the constructed provider', async () => {
    let capturedOptions;
    const runtime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: (opts) => { capturedOptions = opts; return fakeProvider(); },
    });
    assert.equal(runtime.name(), 'ollama');
    assert.deepEqual(runtime.capabilities(), { streaming: true, clientAbort: true, upstreamCancellation: true, hardOutputCap: true });
    const readiness = await runtime.ready();
    assert.deepEqual(readiness, { ok: true, model: 'gemma3:4b', numCtx: 8192 });
    const genResult = await runtime.generate({ prompt: 'hi' });
    assert.deepEqual(genResult, { text: 'ok', aborted: false });
    assert.equal(capturedOptions.backend, 'ollama');
  });

  test('generate() forwards systemPrompt through to the underlying provider unchanged (runtime is a pure pass-through)', async () => {
    let capturedGenerateOpts;
    const runtime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider({
        generate: async (opts) => { capturedGenerateOpts = opts; return { text: 'ok', aborted: false }; },
      }),
    });
    await runtime.generate({ systemPrompt: 'Answer using only the evidence.', prompt: 'Evidence:\n...\n\nQuestion: q' });
    assert.equal(capturedGenerateOpts.systemPrompt, 'Answer using only the evidence.');
    assert.equal(capturedGenerateOpts.prompt, 'Evidence:\n...\n\nQuestion: q');
  });

  test('passes resolved model/baseUrl/askNumCtx into the provider factory options', () => {
    let capturedOptions;
    createGenerationRuntime({
      osEnv: { ASK_MODEL: 'custom:1b', OLLAMA_URL: 'http://x:1', ASK_NUM_CTX: '4096' },
      dotenvValues: {},
      createGenerationProviderFn: (opts) => { capturedOptions = opts; return fakeProvider(); },
    });
    assert.deepEqual(capturedOptions, {
      backend: 'ollama',
      options: { model: 'custom:1b', baseUrl: 'http://x:1', askNumCtx: 4096 },
    });
  });
});

describe('createGenerationRuntime — invalid configuration never crashes construction', () => {
  test('an unknown backend produces a not-ready runtime instead of throwing', () => {
    assert.doesNotThrow(() => {
      const runtime = createGenerationRuntime({
        osEnv: { SEMIDEX_GENERATION_BACKEND: 'openai' }, dotenvValues: {},
      });
      assert.equal(typeof runtime.ready, 'function');
    });
  });

  test('ready() reports ok:false with the configuration error message for an unknown backend', async () => {
    const runtime = createGenerationRuntime({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'openai' }, dotenvValues: {},
    });
    const readiness = await runtime.ready();
    assert.equal(readiness.ok, false);
    assert.match(readiness.reason, /openai/);
  });

  test('an invalid ASK_NUM_CTX produces a not-ready runtime, never throws at construction', async () => {
    const runtime = createGenerationRuntime({
      osEnv: { ASK_NUM_CTX: 'not-a-number' }, dotenvValues: {},
    });
    const readiness = await runtime.ready();
    assert.equal(readiness.ok, false);
    assert.match(readiness.reason, /ASK_NUM_CTX/);
  });

  test('an unsupported device policy produces a not-ready runtime', async () => {
    const runtime = createGenerationRuntime({
      osEnv: { GENERATION_DEVICE: 'cuda' }, dotenvValues: {},
    });
    const readiness = await runtime.ready();
    assert.equal(readiness.ok, false);
    assert.match(readiness.reason, /cuda/);
  });

  test('generate() rejects clearly (never silently attempts a request) when configuration is invalid', async () => {
    const runtime = createGenerationRuntime({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'bogus' }, dotenvValues: {},
    });
    await assert.rejects(() => runtime.generate({ prompt: 'hi' }), /not configured correctly/);
  });

  test('a misconfigured runtime never calls the provider factory at all', () => {
    let called = false;
    createGenerationRuntime({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'openai' }, dotenvValues: {},
      createGenerationProviderFn: () => { called = true; return fakeProvider(); },
    });
    assert.equal(called, false);
  });

  test('an unexpected (non-config) error from the provider factory is not swallowed', () => {
    assert.throws(
      () => createGenerationRuntime({
        osEnv: {}, dotenvValues: {},
        createGenerationProviderFn: () => { throw new Error('unrelated bug, e.g. a TypeError from bad wiring'); },
      }),
      /unrelated bug/
    );
  });
});

describe('createGenerationRuntime — getStatus()', () => {
  test('reports ready:true with full configuration provenance when everything resolves', async () => {
    const runtime = createGenerationRuntime({
      osEnv: { ASK_MODEL: 'gemma3:4b' },
      dotenvValues: { OLLAMA_URL: 'http://dotenv-host:11434' },
      createGenerationProviderFn: () => fakeProvider(),
    });
    const status = await runtime.getStatus();
    assert.equal(status.backend, 'ollama');
    assert.equal(status.model, 'gemma3:4b');
    assert.equal(status.ready, true);
    assert.equal(status.reason, null);
    assert.equal(status.numCtx, 8192);
    assert.deepEqual(status.capabilities, { streaming: true, clientAbort: true, upstreamCancellation: true, hardOutputCap: true });
    assert.deepEqual(status.devicePolicy, { value: 'auto', supported: ['auto'] });
    assert.equal(status.configuration.backend.source, 'default');
    assert.equal(status.configuration.model.source, 'os_env');
    assert.equal(status.configuration.baseUrl.source, 'dotenv');
    assert.equal(status.configuration.baseUrl.display, 'http://dotenv-host:11434');
  });

  test('reports ready:false with a reason, but never crashes, when the provider itself is unready', async () => {
    const runtime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider({
        ready: async () => ({ ok: false, reason: 'Ollama is not reachable at http://localhost:11434.', model: 'gemma3:4b' }),
      }),
    });
    const status = await runtime.getStatus();
    assert.equal(status.ready, false);
    assert.match(status.reason, /not reachable/);
    assert.equal(status.numCtx, null);
  });

  test('reports ready:false with a configuration-shaped reason for invalid config, configuration block null', async () => {
    const runtime = createGenerationRuntime({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'openai' }, dotenvValues: {},
    });
    const status = await runtime.getStatus();
    assert.equal(status.ready, false);
    assert.equal(status.backend, 'openai');
    assert.equal(status.model, null);
    assert.equal(status.numCtx, null);
    assert.equal(status.configuration, null);
    assert.deepEqual(status.devicePolicy.supported, ['auto']);
  });

  test('redacts credentials, path, and query string out of configuration.baseUrl.display', async () => {
    // Regression: getStatus() used to return config.baseUrl.value verbatim
    // — confirmed live to leak embedded credentials, a path, and a
    // ?token=... query string straight into the JSON response (code review
    // finding). getStatus() itself must redact baseUrl.display via
    // redactUrl() — this is not delegated to the HTTP layer, since
    // generation.js's route only ever redacted `reason`, never
    // `configuration`, and a caller of getStatus() other than the HTTP
    // route (e.g. a future in-process caller) must get a safe value too.
    const runtime = createGenerationRuntime({
      osEnv: {}, dotenvValues: { OLLAMA_URL: 'http://user:pass@internal-host:11434/path?token=secret' },
      createGenerationProviderFn: () => fakeProvider(),
    });
    const status = await runtime.getStatus();
    assert.equal(status.configuration.baseUrl.display, 'http://internal-host:11434');
    const json = JSON.stringify(status);
    assert.ok(!json.includes('user:pass'), `leaked credentials: ${json}`);
    assert.ok(!json.includes('/path'), `leaked path: ${json}`);
    assert.ok(!json.includes('token=secret'), `leaked query string: ${json}`);
  });

  test('does not add any extra unsafe fields beyond the resolved config values (no raw env object, no unrelated process fields)', async () => {
    const runtime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider(),
    });
    const status = await runtime.getStatus();
    const json = JSON.stringify(status);
    assert.ok(!json.includes('QDRANT_KEY'));
    assert.equal(Object.keys(status).sort().join(','), 'backend,capabilities,configuration,devicePolicy,model,numCtx,ready,reason');
  });
});

describe('createGenerationRuntime — gemini backend (Stage B1)', () => {
  test('passes only Gemini-relevant options into the provider factory (apiKey/model/askNumCtx — never baseUrl)', () => {
    let capturedOptions;
    createGenerationRuntime({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'gemini', GEMINI_API_KEY: 'the-key', ASK_MODEL: 'gemini-2.5-flash', ASK_NUM_CTX: '4096' },
      dotenvValues: {},
      createGenerationProviderFn: (opts) => { capturedOptions = opts; return fakeProvider({ name: 'gemini' }); },
    });
    assert.deepEqual(capturedOptions, {
      backend: 'gemini',
      options: { apiKey: 'the-key', model: 'gemini-2.5-flash', askNumCtx: 4096 },
    });
    assert.ok(!('baseUrl' in capturedOptions.options), 'the ollama-only baseUrl option must never reach the gemini provider factory');
  });

  test('the ollama backend still receives only baseUrl-shaped options, never apiKey (regression guard)', () => {
    let capturedOptions;
    createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: (opts) => { capturedOptions = opts; return fakeProvider(); },
    });
    assert.ok(!('apiKey' in capturedOptions.options), 'the gemini-only apiKey option must never reach the ollama provider factory');
  });

  test('getStatus() reports geminiApiKey.configured (never the raw key) and omits baseUrl/devicePolicy for the gemini backend', async () => {
    const runtime = createGenerationRuntime({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'gemini', GEMINI_API_KEY: 'super-secret-key-value', ASK_MODEL: 'gemini-2.5-flash' },
      dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider({ name: 'gemini', ready: async () => ({ ok: true, model: 'gemini-2.5-flash', numCtx: 8192 }) }),
    });
    const status = await runtime.getStatus();
    assert.equal(status.backend, 'gemini');
    assert.deepEqual(status.configuration.geminiApiKey, { configured: true, source: 'os_env' });
    assert.ok(!('baseUrl' in status.configuration), 'baseUrl is an Ollama-only concept and must not appear for the gemini backend');
    assert.ok(!('devicePolicy' in status.configuration), 'devicePolicy is a local-inference-only concept and must not appear for the gemini backend');
    const json = JSON.stringify(status);
    assert.ok(!json.includes('super-secret-key-value'), `leaked the raw API key: ${json}`);
  });

  test('getStatus() reports geminiApiKey.configured:false when GEMINI_API_KEY is unset — never crashes', async () => {
    const runtime = createGenerationRuntime({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'gemini' }, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider({
        name: 'gemini',
        ready: async () => ({ ok: false, reason: 'GEMINI_API_KEY is not set.', model: 'gemini-2.5-flash' }),
      }),
    });
    const status = await runtime.getStatus();
    assert.equal(status.ready, false);
    assert.deepEqual(status.configuration.geminiApiKey, { configured: false, source: 'default' });
  });

  test('the ollama backend keeps reporting baseUrl/devicePolicy and omits geminiApiKey (regression guard)', async () => {
    const runtime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider(),
    });
    const status = await runtime.getStatus();
    assert.ok('baseUrl' in status.configuration);
    assert.ok('devicePolicy' in status.configuration);
    assert.ok(!('geminiApiKey' in status.configuration));
  });
});

describe('createGenerationRuntime — no eager network/module initialization', () => {
  test('constructing a runtime does not itself call ready() or generate()', () => {
    let readyCalled = false;
    let generateCalled = false;
    createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider({
        ready: async () => { readyCalled = true; return { ok: true, model: 'x' }; },
        generate: async () => { generateCalled = true; return { text: '' }; },
      }),
    });
    assert.equal(readyCalled, false);
    assert.equal(generateCalled, false);
  });
});
