// core/settings/settings-store.js — SEMIDEX_SETTINGS_PATH UNSET (fallback)
// scenario, kept in its own file/process for the same reason as its
// override-set sibling (settings-path-override.test.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SEMIDEX_SETTINGS_PATH;

describe('core/settings/settings-store.js — SEMIDEX_SETTINGS_PATH unset (default)', () => {
  it('DEFAULT_SETTINGS_PATH resolves to the exact pre-existing package-relative settings.json path', async () => {
    const { DEFAULT_SETTINGS_PATH } = await import('../../../src/core/settings/settings-store.js');
    assert.ok(/settings\.json$/.test(DEFAULT_SETTINGS_PATH));
    assert.ok(!DEFAULT_SETTINGS_PATH.includes('lite-home'), 'must not accidentally resolve to a Lite path when unset');
  });

  it('readSettingsFile() with no explicit path argument does not throw, regardless of whether a real settings.json exists on disk', async () => {
    const { readSettingsFile } = await import('../../../src/core/settings/settings-store.js');
    const result = readSettingsFile();
    assert.equal(typeof result, 'object');
  });
});
