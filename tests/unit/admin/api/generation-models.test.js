// Tests for GET /api/generation/models (src/admin/api/generation-models.js)
// — the provider-neutral discovery route wrapping ollama-models.js and
// gemini-models.js behind one response shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer } from '../ui-test-helpers.js';
import { createSettingsService } from '../../../../src/core/settings/service.js';

function tempSettingsPath(dir) {
  return join(dir, 'settings.json');
}

async function httpJson(base, path) {
  const res = await fetch(`${base}${path}`);
  const json = await res.json();
  return { status: res.status, json };
}

describe('GET /api/generation/models', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-generation-models-api-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('backend=ollama delegates to discoverOllamaModelsFn and tags the response with backend:"ollama"', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const discoverOllamaModelsFn = async () => ({
      available: true, reason: null,
      models: [{ name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' }],
    });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/generation/models?backend=ollama');
      assert.equal(status, 200);
      assert.equal(json.backend, 'ollama');
      assert.equal(json.available, true);
      assert.equal(json.models[0].name, 'gemma3:4b');
    }, { settingsService, discoverOllamaModelsFn });
  });

  test('backend=ollama resolves OLLAMA_URL through settingsService.getActiveValue(), not a raw env read', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ OLLAMA_URL: 'http://saved-host:11434' }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedBaseUrl;
    const discoverOllamaModelsFn = async (baseUrl) => { receivedBaseUrl = baseUrl; return { available: true, reason: null, models: [] }; };
    await withServer(async (base) => {
      await httpJson(base, '/api/generation/models?backend=ollama');
    }, { settingsService, discoverOllamaModelsFn });
    assert.equal(receivedBaseUrl, 'http://saved-host:11434');
  });

  test('backend=gemini delegates to discoverGeminiModelsFn and tags the response with backend:"gemini"', async () => {
    const settingsPath = tempSettingsPath(dir);
    const settingsService = createSettingsService({ osEnv: { GEMINI_API_KEY: 'real-key-abc' }, dotenvValues: {}, settingsPath });
    const discoverGeminiModelsFn = async () => ({
      available: true, reason: null,
      models: [{ name: 'models/gemini-2.5-flash', capabilities: ['generateContent'], embeddingDimension: null, parameterSize: null, family: null, inputTokenLimit: 1_000_000 }],
    });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/generation/models?backend=gemini');
      assert.equal(status, 200);
      assert.equal(json.backend, 'gemini');
      assert.equal(json.available, true);
      assert.equal(json.models[0].name, 'models/gemini-2.5-flash');
    }, { settingsService, discoverGeminiModelsFn });
  });

  test('backend=gemini resolves GEMINI_API_KEY through settingsService.getActiveValue(), never a raw env read, and never echoes it in the response', async () => {
    const settingsPath = tempSettingsPath(dir);
    const settingsService = createSettingsService({ osEnv: { GEMINI_API_KEY: 'secret-passthrough-key' }, dotenvValues: {}, settingsPath });
    let receivedApiKey;
    const discoverGeminiModelsFn = async ({ apiKey }) => { receivedApiKey = apiKey; return { available: true, reason: null, models: [] }; };
    await withServer(async (base) => {
      const { json } = await httpJson(base, '/api/generation/models?backend=gemini');
      assert.ok(!JSON.stringify(json).includes('secret-passthrough-key'), 'the API key must never appear in the response body');
    }, { settingsService, discoverGeminiModelsFn });
    assert.equal(receivedApiKey, 'secret-passthrough-key');
  });

  test('backend=gemini always returns 200 even when the key is missing (status-in-body convention, no crash)', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const discoverGeminiModelsFn = async () => ({ available: false, reason: 'GEMINI_API_KEY is not set.', models: [] });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/generation/models?backend=gemini');
      assert.equal(status, 200);
      assert.equal(json.available, false);
      assert.match(json.reason, /GEMINI_API_KEY/);
    }, { settingsService, discoverGeminiModelsFn });
  });

  test('passes refresh=1 through as forceRefresh for both backends', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    let ollamaOptions;
    let geminiOptions;
    const discoverOllamaModelsFn = async (_baseUrl, options) => { ollamaOptions = options; return { available: true, reason: null, models: [] }; };
    const discoverGeminiModelsFn = async ({ forceRefresh }) => { geminiOptions = { forceRefresh }; return { available: true, reason: null, models: [] }; };
    await withServer(async (base) => {
      await httpJson(base, '/api/generation/models?backend=ollama&refresh=1');
      await httpJson(base, '/api/generation/models?backend=gemini&refresh=1');
    }, { settingsService, discoverOllamaModelsFn, discoverGeminiModelsFn });
    assert.deepEqual(ollamaOptions, { forceRefresh: true });
    assert.deepEqual(geminiOptions, { forceRefresh: true });
  });

  test('rejects a missing or unknown backend query parameter with 400', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await withServer(async (base) => {
      const missing = await httpJson(base, '/api/generation/models');
      assert.equal(missing.status, 400);
      const unknown = await httpJson(base, '/api/generation/models?backend=openai');
      assert.equal(unknown.status, 400);
    }, { settingsService });
  });

  test('redacts a secret embedded in the gemini reason string before responding', async () => {
    const settingsPath = tempSettingsPath(dir);
    const settingsService = createSettingsService({ osEnv: { GEMINI_API_KEY: 'leaked-in-error-999' }, dotenvValues: {}, settingsPath });
    const discoverGeminiModelsFn = async () => ({
      available: false, reason: 'Failed to list Gemini models: quota exceeded for key leaked-in-error-999', models: [],
    });
    await withServer(async (base) => {
      const { json } = await httpJson(base, '/api/generation/models?backend=gemini');
      assert.ok(!JSON.stringify(json).includes('leaked-in-error-999'), 'the raw secret must never appear in the response');
    }, { settingsService, discoverGeminiModelsFn });
  });

  test('redacts a QDRANT_KEY secret embedded in either backend\'s reason string (shared safeMessage layer)', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const originalQdrantKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'super-secret-qdrant-value';
    const discoverOllamaModelsFn = async () => ({ available: false, reason: 'leaked super-secret-qdrant-value in error text', models: [] });
    try {
      await withServer(async (base) => {
        const { json } = await httpJson(base, '/api/generation/models?backend=ollama');
        assert.ok(!JSON.stringify(json).includes('super-secret-qdrant-value'));
      }, { settingsService, discoverOllamaModelsFn });
    } finally {
      if (originalQdrantKey === undefined) delete process.env.QDRANT_KEY;
      else process.env.QDRANT_KEY = originalQdrantKey;
    }
  });
});
