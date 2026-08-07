// Review finding (P2): createLiteApp()/createApp() build
// resolvedGenerationRuntime with the RAW settingsService parameter, not
// the fallback SettingsService each function constructs for its own
// routes when the caller doesn't supply one. createGenerationRuntime()'s
// applySettingsServiceTier() treats an undefined settingsService as "no
// settings.json tier at all" (src/core/generation/runtime.js) — so a
// default (no-DI) construction previously left the generation runtime
// blind to settings.json while GET/PATCH /api/settings and every other
// route saw the real fallback service, a silent divergence between what
// the UI shows as configured and what Ask actually uses. Fixed by
// resolving `const settings = settingsService ?? createSettingsService(...)`
// BEFORE building resolvedGenerationRuntime, and passing `settings`
// (never the raw parameter) into createGenerationRuntime().
//
// This test proves the fix at the one level that can actually observe
// it: settings.json is a real on-disk file, read by
// core/settings/settings-store.js's DEFAULT_SETTINGS_PATH constant,
// which is evaluated ONCE at module import time from
// process.env.SEMIDEX_SETTINGS_PATH (see that file's own header
// comment: "Read fresh at import; a caller that needs to redirect it
// sets the env var before this module is first imported."). So this
// file sets SEMIDEX_SETTINGS_PATH to an isolated temp path and seeds a
// config-only ASK_MODEL value BEFORE importing createLiteApp/createApp
// (both of which transitively import settings-store.js), then
// constructs each app with ZERO explicit settingsService DI — the exact
// default-construction path the review finding targeted — and asserts
// the generation runtime's own status reflects the settings.json value,
// not just the untouched env/dotenv default.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG_ONLY_ASK_MODEL = 'config-json-only-ask-model';

let tempDir;
let settingsPath;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'semidex-default-settings-fallback-test-'));
  settingsPath = join(tempDir, 'settings.json');
  // backend is pinned to gemini (config-only, same as model): gemini's
  // ready() returns { ok: false } for a missing apiKey rather than
  // throwing (unlike the default 'ollama' backend's isOllamaReachableFn,
  // which is only wired to a real implementation by admin/bootstrap.js,
  // not by createLiteApp()/createApp() themselves) — this keeps the test
  // free of any real network dependency while still exercising the exact
  // default-construction code path the review finding targeted.
  writeFileSync(settingsPath, JSON.stringify({ SEMIDEX_GENERATION_BACKEND: 'gemini', ASK_MODEL: CONFIG_ONLY_ASK_MODEL }), 'utf-8');
  process.env.SEMIDEX_SETTINGS_PATH = settingsPath;
});

after(() => {
  delete process.env.SEMIDEX_SETTINGS_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('createLiteApp()/createApp() default construction — generation runtime sees settings.json (review finding, P2)', () => {
  it('createLiteApp() with no explicit settingsService still resolves ASK_MODEL from settings.json in the generation runtime status', async () => {
    const { createLiteApp } = await import('../../../src/admin/composition/lite.js');
    const { makeStubAdapter } = await import('./ui-test-helpers.js');
    const app = createLiteApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      const res = await fetch(`${base}/api/generation/status`);
      const text = await res.text();
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
      const body = JSON.parse(text);
      assert.equal(body?.model, CONFIG_ONLY_ASK_MODEL, `expected the generation runtime's own status to reflect settings.json's ASK_MODEL, got: ${JSON.stringify(body)}`);
      assert.equal(body?.configuration?.model?.source, 'config_json', 'the model must be attributed to settings.json (config_json), not env/dotenv/default — proves the fallback settingsService actually reached the generation runtime');
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });

  it('createApp() (Full) with no explicit settingsService still resolves ASK_MODEL from settings.json in the generation runtime status', async () => {
    const { createApp } = await import('../../../src/admin/server-full.js');
    const { makeStubAdapter } = await import('./ui-test-helpers.js');
    const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      const res = await fetch(`${base}/api/generation/status`);
      const text = await res.text();
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
      const body = JSON.parse(text);
      assert.equal(body?.model, CONFIG_ONLY_ASK_MODEL, `expected the generation runtime's own status to reflect settings.json's ASK_MODEL, got: ${JSON.stringify(body)}`);
      assert.equal(body?.configuration?.model?.source, 'config_json', 'the model must be attributed to settings.json (config_json), not env/dotenv/default — proves the fallback settingsService actually reached the generation runtime');
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });
});
