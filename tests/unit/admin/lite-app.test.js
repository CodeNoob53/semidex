// createLiteApp() — end-to-end regression coverage for the Lite settings
// wrapper wired into the shared composition root (registerNeutralRoutes).
// Real bug class this guards against: registerSearchRoutes'
// core/qdrant/store.js reads HYBRID_PREFETCH_LIMIT/RRF_K via the SAME
// settingsService instance that backs GET/PATCH /api/settings — if that
// shared instance is the Lite allow-list wrapper and either key is
// missing from LITE_SETTINGS_KEYS, every Lite search throws
// not_available_in_lite instead of returning results (found via static
// call-site audit while wiring serve-lite.js; this test proves it stays
// fixed, not just that the audit was once correct).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createSettingsService } from '../../../src/core/settings/service.js';
import { createLiteSettingsService } from '../../../src/core/settings/service.lite.js';
import { makeStubAdapter } from './ui-test-helpers.js';

// Every test constructs its own isolated temp settings.json — MUST NOT use
// the real (default, package-relative) settingsPath, since a PATCH test in
// this file writes real values and would otherwise corrupt the actual dev
// settings.json on disk (caught once during development of this file).
function withLiteApp(fn, { extraOptions = {}, osEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'semidex-lite-app-test-'));
  const settingsPath = join(dir, 'settings.json');
  const realSettings = createSettingsService({ osEnv, dotenvValues: {}, settingsPath });
  const settingsService = createLiteSettingsService(realSettings);
  return (async () => {
    const app = createLiteApp({
      adapter: makeStubAdapter(),
      embedQuery: async () => ({ dense: [], sparse: {} }),
      settingsService,
      ...extraOptions,
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      return await fn(base, settingsService);
    } finally {
      await new Promise((resolve) => app.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

describe('createLiteApp() + Lite settings wrapper — POST /api/search', () => {
  it('does not throw not_available_in_lite for HYBRID_PREFETCH_LIMIT/RRF_K — search actually runs', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'demo', query: 'test query' }),
      });
      // Stub adapter has no matching collection — a clean 404
      // (collection_not_found) or 200 proves the settings resolution
      // itself succeeded; a 500 from an unhandled not_available_in_lite
      // throw would be the regression this test exists to catch.
      assert.notEqual(res.status, 500);
      const body = await res.json();
      assert.notEqual(body?.error?.code, 'not_available_in_lite');
    });
  });
});

describe('createLiteApp() + Lite settings wrapper — GET /api/settings', () => {
  it('exposes only the Lite allow-list, not the full ~65-key registry', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/settings');
      assert.equal(res.status, 200);
      const body = await res.json();
      const keys = body.settings.map((e) => e.key);
      assert.ok(keys.includes('QDRANT_URL'));
      assert.ok(keys.includes('HYBRID_PREFETCH_LIMIT'));
      assert.ok(!keys.includes('OLLAMA_URL'));
      assert.ok(!keys.includes('ONNX_EXECUTION_PROVIDER'));
      assert.ok(keys.length < 35, 'small subset sanity bound — bumped from 30 to admit the 3 new graph-expansion keys (still far short of the full ~65-key registry)');
    });
  });

  it('PATCH /api/settings rejects a non-Lite key with 400 not_available_in_lite', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { OLLAMA_URL: 'http://localhost:11434' } }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'not_available_in_lite');
    });
  });

  it('PATCH /api/settings accepts a Lite-allowed key', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { RRF_K: 80 } }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.settings[0].configuredValue, 80);
    });
  });
});

describe('createLiteApp() — no local-only routes registered', () => {
  it('GET /api/system/ollama-status is not found (never registered in Lite)', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/system/ollama-status');
      assert.equal(res.status, 404);
    });
  });

  it('GET /api/onnx/probe is not found (never registered in Lite)', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/onnx/probe', { method: 'POST' });
      assert.equal(res.status, 404);
    });
  });

  it('GET /api/generation/models?backend=ollama returns a clean 400, not a crash', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/generation/models?backend=ollama');
      assert.equal(res.status, 400);
    });
  });
});
