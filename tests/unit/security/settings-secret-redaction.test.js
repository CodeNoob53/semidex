// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md
// Confirmed-safe-boundary item "GET /api/settings never leaks a secret
// field's raw value" — this is the counterpart to the P1 findings: a
// boundary that IS handled correctly and should not be re-flagged or
// "fixed" by a future auth/rate-limit pass.
//
// src/core/settings/service.js's buildStoredEntry() (line ~182) branches
// on def.secret: a secret field (GEMINI_API_KEY, QDRANT_KEY — see
// definitions.js) NEVER gets `configuredValue`/`activeValue` populated;
// it only ever reports `configured: boolean` (whether SOME non-empty value
// is set at any tier). This holds even though both keys are in Lite's
// exposed allow-list (lite-policy.js: `GEMINI_API_KEY: exposed()`,
// `QDRANT_KEY: exposed()`) — i.e. a Lite client CAN read/write these keys
// through GET/PATCH /api/settings, but can never read the key's actual
// value back out through that same API.
//
// This test proves the boundary holds for a real SettingsService instance
// backed by an in-memory env (no real .env file, no real secret value —
// a synthetic placeholder string only), through both the raw service and
// the Lite allow-list wrapper.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsService } from '../../../src/core/settings/service.js';
import { createLiteSettingsService } from '../../../src/core/settings/service.lite.js';

const FAKE_SECRET = 'sk-fake-placeholder-not-a-real-key-000111222';

function withTempSettingsPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'semidex-settings-secret-test-'));
  const settingsPath = join(dir, 'settings.json');
  try {
    return fn(settingsPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('SettingsService — secret fields never expose their raw value via getAll()/get()', () => {
  it('GEMINI_API_KEY set via os_env reports configured:true but no configuredValue/activeValue field at all', () => {
    withTempSettingsPath((settingsPath) => {
      const osEnv = { GEMINI_API_KEY: FAKE_SECRET };
      const service = createSettingsService({ osEnv, dotenvValues: {}, settingsPath });

      const entry = service.get('GEMINI_API_KEY');
      assert.equal(entry.secret, true);
      assert.equal(entry.configured, true);
      assert.equal('configuredValue' in entry, false, 'secret entry must not carry configuredValue');
      assert.equal('activeValue' in entry, false, 'secret entry must not carry activeValue');

      // getAll() (the real GET /api/settings response body) must show the
      // same non-leaking shape for every secret-flagged entry.
      const all = service.getAll();
      const geminiEntry = all.find((e) => e.key === 'GEMINI_API_KEY');
      assert.equal(geminiEntry.configured, true);
      assert.equal('configuredValue' in geminiEntry, false);
      assert.equal(JSON.stringify(all).includes(FAKE_SECRET), false, 'the fake secret string must not appear anywhere in the serialized getAll() response');
    });
  });

  it('QDRANT_KEY unset reports configured:false, still no value field', () => {
    withTempSettingsPath((settingsPath) => {
      const service = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      const entry = service.get('QDRANT_KEY');
      assert.equal(entry.secret, true);
      assert.equal(entry.configured, false);
      assert.equal('configuredValue' in entry, false);
    });
  });

  it('getActiveValue("GEMINI_API_KEY") still resolves the real value in-process (generation runtime needs it) — the boundary is response serialization, not in-memory access', () => {
    // Important distinction for the audit doc: the redaction happens at the
    // Settings API's OWN serialization layer (buildStoredEntry), not by
    // withholding the value from the rest of the process — the generation
    // runtime legitimately needs the real key to call Gemini. This test
    // documents that getActiveValue() (used internally, never returned by
    // the HTTP route) still returns the real secret, so a future reviewer
    // does not mistake this for "the value is unreadable anywhere."
    withTempSettingsPath((settingsPath) => {
      const osEnv = { GEMINI_API_KEY: FAKE_SECRET };
      const service = createSettingsService({ osEnv, dotenvValues: {}, settingsPath });
      assert.equal(service.getActiveValue('GEMINI_API_KEY'), FAKE_SECRET);
    });
  });

  it('Lite allow-list wrapper (service.lite.js) preserves the same non-leaking shape for GEMINI_API_KEY/QDRANT_KEY, which are both in the Lite-exposed set', () => {
    withTempSettingsPath((settingsPath) => {
      const osEnv = { GEMINI_API_KEY: FAKE_SECRET, QDRANT_KEY: FAKE_SECRET };
      const realService = createSettingsService({ osEnv, dotenvValues: {}, settingsPath });
      const liteService = createLiteSettingsService(realService);

      const all = liteService.getAll();
      const geminiEntry = all.find((e) => e.key === 'GEMINI_API_KEY');
      const qdrantEntry = all.find((e) => e.key === 'QDRANT_KEY');
      assert.ok(geminiEntry, 'GEMINI_API_KEY must be present in the Lite-exposed set');
      assert.ok(qdrantEntry, 'QDRANT_KEY must be present in the Lite-exposed set');
      assert.equal(geminiEntry.configured, true);
      assert.equal(qdrantEntry.configured, true);
      assert.equal('configuredValue' in geminiEntry, false);
      assert.equal('configuredValue' in qdrantEntry, false);
      assert.equal(JSON.stringify(all).includes(FAKE_SECRET), false);
    });
  });
});
