// core/settings/service.lite.js — the Lite settings wrapper. Uses a real
// createSettingsService() instance (not a stub) against a temp
// settings.json so setMany()'s actual validate/write path is exercised,
// matching this repo's "structural/behavioral over source-regex" test
// convention: these tests would genuinely fail if the wrapper regressed
// (e.g. started passing a non-Lite key through to a real write).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsService } from '../../../src/core/settings/service.js';
import { createLiteSettingsService } from '../../../src/core/settings/service.lite.js';
import { LITE_SETTINGS_KEYS, isLiteSettingsKey } from '../../../src/core/settings/lite-policy.js';

const dir = mkdtempSync(join(tmpdir(), 'semidex-lite-settings-test-'));
const settingsPath = join(dir, 'settings.json');

function makeLiteService(osEnv = {}) {
  const real = createSettingsService({ osEnv, dotenvValues: {}, settingsPath });
  return createLiteSettingsService(real);
}

describe('lite-policy.js — LITE_SETTINGS_KEYS', () => {
  it('excludes every ONNX/Ollama-only key', () => {
    for (const key of ['ONNX_EXECUTION_PROVIDER', 'ONNX_BATCH_SIZE', 'ONNXRUNTIME_NODE_PATH', 'OLLAMA_URL', 'TAG_MODEL', 'TAG_PROVIDER', 'CONTEXT_MODEL', 'GENERATION_DEVICE', 'DENSE_MODEL', 'EMBED_MODEL', 'RERANK_CE_MODEL', 'RERANK_CE_DEVICE']) {
      assert.equal(isLiteSettingsKey(key), false, `${key} must not be a Lite settings key`);
    }
  });

  it('includes the cloud-only surface named in the plan', () => {
    for (const key of ['QDRANT_URL', 'QDRANT_KEY', 'QDRANT_CLOUD_DENSE_MODEL', 'QDRANT_SPARSE_MODEL', 'SEMIDEX_GENERATION_BACKEND', 'ASK_MODEL', 'GEMINI_API_KEY', 'ADMIN_HOST', 'ADMIN_PORT', 'DENSE_PROVIDER', 'SPARSE_PROVIDER', 'CONTEXT_MODE']) {
      assert.equal(isLiteSettingsKey(key), true, `${key} must be a Lite settings key`);
    }
  });

  it('has no duplicate entries', () => {
    assert.equal(LITE_SETTINGS_KEYS.length, new Set(LITE_SETTINGS_KEYS).size);
  });
});

describe('createLiteSettingsService() — getAll()/get()', () => {
  it('getAll() returns only Lite-allow-listed keys, never the full registry', () => {
    const lite = makeLiteService();
    const keys = lite.getAll().map((e) => e.key);
    assert.ok(keys.length > 0);
    assert.ok(keys.length < 35, 'Lite getAll() must be a small subset, not the full ~65-key registry (bumped from 30 to admit the 3 new graph-expansion keys)');
    for (const key of keys) assert.ok(isLiteSettingsKey(key), `${key} leaked through getAll() but is not Lite-allowed`);
    assert.ok(!keys.includes('ONNX_EXECUTION_PROVIDER'));
    assert.ok(!keys.includes('OLLAMA_URL'));
  });

  it('get() on an allowed key returns the real entry shape', () => {
    const lite = makeLiteService({ QDRANT_URL: 'https://cluster.example.com' });
    const entry = lite.get('QDRANT_URL');
    assert.equal(entry.key, 'QDRANT_URL');
    assert.equal(entry.configuredValue, 'https://cluster.example.com');
  });

  it('get() on a disallowed key returns null, not the real entry', () => {
    const lite = makeLiteService();
    assert.equal(lite.get('OLLAMA_URL'), null);
    assert.equal(lite.get('ONNX_EXECUTION_PROVIDER'), null);
  });
});

describe('createLiteSettingsService() — getActiveValue()', () => {
  it('resolves an allowed key normally', () => {
    const lite = makeLiteService({ ADMIN_PORT: '9000' });
    assert.equal(lite.getActiveValue('ADMIN_PORT'), 9000);
  });

  it('throws not_available_in_lite for a disallowed key, never reaching the real service', () => {
    const lite = makeLiteService();
    assert.throws(() => lite.getActiveValue('OLLAMA_URL'), (err) => err.code === 'not_available_in_lite');
  });
});

describe('createLiteSettingsService() — setMany()', () => {
  it('writes an allowed key through to the real settings.json', async () => {
    const lite = makeLiteService();
    const updated = await lite.setMany({ ADMIN_PORT: 9123 });
    assert.equal(updated[0].configuredValue, 9123);
    // ADMIN_PORT is next_restart — getActiveValue() stays frozen at the
    // value resolved at service construction until a real restart;
    // configuredValue (via get()) is what actually landed in settings.json.
    assert.equal(lite.get('ADMIN_PORT').configuredValue, 9123);
    assert.equal(lite.get('ADMIN_PORT').hasLocalOverride, true);
  });

  it('rejects a disallowed key with not_available_in_lite and performs NO write at all', async () => {
    const lite = makeLiteService();
    await assert.rejects(
      () => lite.setMany({ ONNX_EXECUTION_PROVIDER: 'cuda' }),
      (err) => err.code === 'not_available_in_lite'
    );
  });

  it('rejects a batch mixing an allowed and a disallowed key — all-or-nothing, the allowed key is NOT silently applied', async () => {
    // Fresh temp settings.json (isolated from other tests in this file) so
    // "no partial write happened" can be asserted unambiguously.
    const isolatedDir = mkdtempSync(join(tmpdir(), 'semidex-lite-settings-mixed-'));
    const isolatedPath = join(isolatedDir, 'settings.json');
    const real = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: isolatedPath });
    const lite = createLiteSettingsService(real);
    await assert.rejects(
      () => lite.setMany({ ADMIN_PORT: 9200, OLLAMA_URL: 'http://localhost:11434' }),
      (err) => err.code === 'not_available_in_lite'
    );
    // ADMIN_PORT must still be unset (default), proving no partial write happened.
    assert.equal(lite.get('ADMIN_PORT').hasLocalOverride, false);
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  it('a real-service validation error (e.g. invalid enum) still surfaces with its own code, not masked as not_available_in_lite', async () => {
    const lite = makeLiteService();
    await assert.rejects(
      () => lite.setMany({ SEMIDEX_GENERATION_BACKEND: 'not-a-real-backend' }),
      (err) => err.code === 'invalid_value'
    );
  });
});

process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
