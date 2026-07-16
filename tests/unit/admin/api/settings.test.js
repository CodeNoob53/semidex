import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer } from '../ui-test-helpers.js';
import { createSettingsService } from '../../../../src/core/settings/service.js';

function tempSettingsPath(dir) {
  return join(dir, 'settings.json');
}

async function httpJson(base, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe('GET /api/settings', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-settings-api-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('returns categories and settings with the expected shape', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/settings');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.categories));
      assert.ok(json.categories.some((c) => c.id === 'retrieval'));
      assert.ok(Array.isArray(json.settings));
      const rrfK = json.settings.find((s) => s.key === 'RRF_K');
      assert.ok(rrfK);
      assert.equal(rrfK.category, 'retrieval');
      assert.equal(rrfK.activeValue, 60);
      assert.equal(rrfK.configuredValue, 60);
      assert.equal(rrfK.source, 'default');
      assert.equal(rrfK.writable, true);
      assert.equal(rrfK.hasLocalOverride, false);
      assert.equal(rrfK.pendingRestart, false);
      assert.equal(rrfK.appliesAt, 'next_search');
      assert.equal(rrfK.requiresReindex, false);
    }, { settingsService });
  });

  test('secret entries omit configuredValue/activeValue and expose only "configured"', async () => {
    const settingsService = createSettingsService({ osEnv: { QDRANT_KEY: 'super-secret-value' }, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await withServer(async (base) => {
      const { json } = await httpJson(base, '/api/settings');
      const qdrantKey = json.settings.find((s) => s.key === 'QDRANT_KEY');
      assert.ok(qdrantKey);
      assert.equal('configuredValue' in qdrantKey, false);
      assert.equal('activeValue' in qdrantKey, false);
      assert.equal(qdrantKey.configured, true);
      assert.equal(JSON.stringify(json).includes('super-secret-value'), false, 'raw secret value must never appear in the response');
    }, { settingsService });
  });

  test('a representative entry carries the widened UI metadata shape (min/max/description/advanced/configuredSource/activeSource)', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await withServer(async (base) => {
      const { json } = await httpJson(base, '/api/settings');
      const maxChunk = json.settings.find((s) => s.key === 'MAX_CHUNK_TOKENS');
      assert.equal(maxChunk.min, 1);
      assert.equal(maxChunk.max, 100000);
      assert.equal(typeof maxChunk.description, 'string');
      assert.ok(maxChunk.description.length > 0);
      assert.equal(maxChunk.advanced, false);
      assert.equal(maxChunk.configuredSource, 'default');
      assert.equal(maxChunk.activeSource, 'default');

      const tagProvider = json.settings.find((s) => s.key === 'TAG_PROVIDER');
      assert.deepEqual(tagProvider.options, [{ value: 'ollama', label: 'ollama' }, { value: 'onnx', label: 'onnx' }]);
    }, { settingsService });
  });

  test('an env-overridden key with a hidden local fallback shows source=os_env AND hasLocalOverride=true together', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 90 }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: { RRF_K: '50' }, dotenvValues: {}, settingsPath });
    await withServer(async (base) => {
      const { json } = await httpJson(base, '/api/settings');
      const rrfK = json.settings.find((s) => s.key === 'RRF_K');
      assert.equal(rrfK.source, 'os_env');
      assert.equal(rrfK.hasLocalOverride, true);
      assert.equal(rrfK.activeValue, 50);
    }, { settingsService });
  });
});

describe('PATCH /api/settings', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-settings-api-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('batch success: writes multiple keys atomically, returns updated entries', async () => {
    const settingsPath = tempSettingsPath(dir);
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/settings', {
        method: 'PATCH',
        body: { changes: { RRF_K: 90, HYBRID_PREFETCH_LIMIT: 5 } },
      });
      assert.equal(status, 200);
      assert.equal(json.settings.length, 2);
      const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      assert.equal(onDisk.RRF_K, 90);
      assert.equal(onDisk.HYBRID_PREFETCH_LIMIT, 5);
    }, { settingsService });
  });

  test('409 on an overridden key, with machine-readable code setting_overridden', async () => {
    const settingsService = createSettingsService({ osEnv: { RRF_K: '99' }, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/settings', {
        method: 'PATCH',
        body: { changes: { RRF_K: 70 } },
      });
      assert.equal(status, 409);
      assert.equal(json.error.code, 'setting_overridden');
    }, { settingsService });
  });

  test('400 on an invalid value, code invalid_value', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/settings', {
        method: 'PATCH',
        body: { changes: { MAX_CHUNK_TOKENS: 999999999 } },
      });
      assert.equal(status, 400);
      assert.equal(json.error.code, 'invalid_value');
    }, { settingsService });
  });

  test('400 on an unknown key, code unknown_key', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/settings', {
        method: 'PATCH',
        body: { changes: { NOT_A_REAL_KEY: 1 } },
      });
      assert.equal(status, 400);
      assert.equal(json.error.code, 'unknown_key');
    }, { settingsService });
  });

  test('400 on a non-writable key, code not_writable', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await withServer(async (base) => {
      const { status, json } = await httpJson(base, '/api/settings', {
        method: 'PATCH',
        body: { changes: { QDRANT_KEY: 'attempted-value' } },
      });
      assert.equal(status, 400);
      assert.equal(json.error.code, 'not_writable');
    }, { settingsService });
  });

  test('400 on a malformed body (missing changes)', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    await withServer(async (base) => {
      const { status } = await httpJson(base, '/api/settings', { method: 'PATCH', body: {} });
      assert.equal(status, 400);
    }, { settingsService });
  });

  test('reset (null) on an env-overridden key with a hidden local fallback succeeds (200, not 409)', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ RRF_K: 90 }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: { RRF_K: '50' }, dotenvValues: {}, settingsPath });
    await withServer(async (base) => {
      const { status } = await httpJson(base, '/api/settings', {
        method: 'PATCH',
        body: { changes: { RRF_K: null } },
      });
      assert.equal(status, 200);
      const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      assert.equal('RRF_K' in onDisk, false);

      const { json } = await httpJson(base, '/api/settings');
      const rrfK = json.settings.find((s) => s.key === 'RRF_K');
      assert.equal(rrfK.activeValue, 50, 'active value unchanged — still the env value throughout');
      assert.equal(rrfK.source, 'os_env');
      assert.equal(rrfK.hasLocalOverride, false);
    }, { settingsService });
  });
});
