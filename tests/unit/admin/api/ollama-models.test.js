// Tests for GET /api/ollama-models (src/admin/api/ollama-models.js) — the
// admin route wiring around core/ollama-models.js's discoverOllamaModels().
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

describe('GET /api/ollama-models', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-ollama-models-api-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('always returns 200, never a 5xx, when Ollama is unreachable (status-in-body convention)', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const discoverOllamaModelsFn = async () => ({ available: false, reason: 'Ollama is not reachable at http://localhost:11434. Start it with "ollama serve".', models: [] });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/ollama-models');
      assert.equal(status, 200);
      assert.equal(json.available, false);
      assert.match(json.reason, /not reachable/);
      assert.deepEqual(json.models, []);
    }, { settingsService, discoverOllamaModelsFn });
  });

  test('resolves OLLAMA_URL through settingsService.getActiveValue(), not a raw env read', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ OLLAMA_URL: 'http://saved-host:11434' }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedBaseUrl;
    const discoverOllamaModelsFn = async (baseUrl) => {
      receivedBaseUrl = baseUrl;
      return { available: true, reason: null, models: [] };
    };
    await withServer(async (base) => {
      await httpJson(base, '/api/ollama-models');
    }, { settingsService, discoverOllamaModelsFn });
    assert.equal(receivedBaseUrl, 'http://saved-host:11434');
  });

  test('passes through a reachable result with classified models unchanged', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const discoverOllamaModelsFn = async () => ({
      available: true, reason: null,
      models: [{
        name: 'gemma3:4b',
        capabilities: ['completion'],
        embeddingDimension: null,
        parameterSize: '4.3B',
        family: 'gemma3',
      }],
    });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/ollama-models');
      assert.equal(status, 200);
      assert.equal(json.available, true);
      assert.deepEqual(json.models, [{
        name: 'gemma3:4b',
        capabilities: ['completion'],
        embeddingDimension: null,
        parameterSize: '4.3B',
        family: 'gemma3',
      }]);
    }, { settingsService, discoverOllamaModelsFn });
  });

  test('passes refresh=1 to discovery so the UI can bypass successful /api/show cache entries', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    let receivedOptions;
    const discoverOllamaModelsFn = async (_baseUrl, options) => {
      receivedOptions = options;
      return { available: true, reason: null, models: [] };
    };
    await withServer(async (base) => {
      await httpJson(base, '/api/ollama-models?refresh=1');
    }, { settingsService, discoverOllamaModelsFn });
    assert.deepEqual(receivedOptions, { forceRefresh: true });
  });

  test('redacts a secret embedded in the reason string before responding', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const originalQdrantKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'super-secret-value';
    const discoverOllamaModelsFn = async () => ({
      available: false, reason: 'Failed to list Ollama models: leaked super-secret-value in error text', models: [],
    });
    try {
      await withServer(async (base) => {
        const { json } = await httpJson(base, '/api/ollama-models');
        assert.equal(JSON.stringify(json).includes('super-secret-value'), false, 'the raw secret must never appear in the response');
      }, { settingsService, discoverOllamaModelsFn });
    } finally {
      if (originalQdrantKey === undefined) delete process.env.QDRANT_KEY;
      else process.env.QDRANT_KEY = originalQdrantKey;
    }
  });

  test('defaults to the real discoverOllamaModels() when no override is injected (wiring smoke test)', async () => {
    // OLLAMA_URL points at a real, guaranteed-unused port rather than
    // stubbing globalThis.fetch — a global fetch stub would also break
    // withServer()'s own HTTP calls against the local test server, since
    // both go through the same fetch() function.
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ OLLAMA_URL: 'http://127.0.0.1:1' }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/ollama-models');
      assert.equal(status, 200);
      assert.equal(json.available, false);
    }, { settingsService });
  });
});
