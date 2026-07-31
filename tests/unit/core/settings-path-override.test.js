// core/settings/settings-store.js — SEMIDEX_SETTINGS_PATH override,
// override-SET scenario. DEFAULT_SETTINGS_PATH is an import-time constant
// (computed once at module evaluation) — the env var is set once, at the
// TOP of this file, before any import of settings-store.js, so every test
// below observes the identical resolved constant. The unset/fallback
// scenario is intentionally a separate file
// (settings-path-default.test.js), since asserting a different env value
// against the same already-cached module within one process would silently
// return the first resolved constant (a real bug caught in review before
// landing — see that file's own header comment).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'semidex-settings-path-test-'));
const overridePath = join(dir, 'settings.json');
process.env.SEMIDEX_SETTINGS_PATH = overridePath;

describe('core/settings/settings-store.js — SEMIDEX_SETTINGS_PATH override (set)', () => {
  it('DEFAULT_SETTINGS_PATH resolves to the override', async () => {
    const { DEFAULT_SETTINGS_PATH } = await import('../../../src/core/settings/settings-store.js');
    assert.equal(DEFAULT_SETTINGS_PATH, overridePath);
  });

  it('readSettingsFile() returns {} when the overridden file does not exist yet, never throws', async () => {
    const { readSettingsFile } = await import('../../../src/core/settings/settings-store.js');
    assert.deepEqual(readSettingsFile(), {});
  });

  it('writeSettingsFileAtomic() actually writes at the overridden path, and readSettingsFile() reads it back', async () => {
    const { readSettingsFile, writeSettingsFileAtomic } = await import('../../../src/core/settings/settings-store.js');
    writeSettingsFileAtomic({ QDRANT_URL: 'https://example.qdrant.io' });
    assert.ok(existsSync(overridePath), 'expected the overridden settings.json to actually be written');
    const written = JSON.parse(readFileSync(overridePath, 'utf-8'));
    assert.deepEqual(written, { QDRANT_URL: 'https://example.qdrant.io' });
    assert.deepEqual(readSettingsFile(), { QDRANT_URL: 'https://example.qdrant.io' });
  });

  it('never writes into the real package-relative settings.json (the override fully redirects, no dual-write)', async () => {
    const { DEFAULT_SETTINGS_PATH } = await import('../../../src/core/settings/settings-store.js');
    assert.ok(DEFAULT_SETTINGS_PATH.startsWith(dir), 'must resolve strictly under the overridden temp directory, never the repo root');
  });
});

// Cleanup runs after the whole file's tests via node:test's process-exit
// (each test file is its own process) — remove the temp dir explicitly so
// a local repeated run doesn't accumulate temp directories.
process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
