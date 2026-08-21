import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsService } from '../../../src/core/settings/service.js';
import { createAllowedRootsGuard } from '../../../src/shared/admin/jobs/allowed-roots-guard.js';

function fixture(settings = undefined, osEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'semidex-settings-roots-'));
  const settingsPath = path.join(home, 'settings.json');
  if (settings !== undefined) fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const service = createSettingsService({ osEnv, dotenvValues: {}, settingsPath });
  return { home, settingsPath, service };
}

describe('INDEX_ALLOWED_ROOTS settings contract', () => {
  it('malformed environment JSON resolves to an empty, fail-closed list', () => {
    const { home, service } = fixture(undefined, { INDEX_ALLOWED_ROOTS: 'not-json' });
    try {
      assert.deepEqual(service.getActiveValue('INDEX_ALLOWED_ROOTS'), []);
      const result = createAllowedRootsGuard({ settingsService: service, log: () => {} }).checkTarget(process.cwd());
      assert.equal(result.ok, false);
      assert.equal(result.code, 'allowed_roots_not_configured');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('malformed persisted values fail closed instead of being iterated as paths', () => {
    const { home, service } = fixture({ INDEX_ALLOWED_ROOTS: '.' });
    try {
      const result = createAllowedRootsGuard({ settingsService: service, log: () => {} }).checkTarget(process.cwd());
      assert.equal(result.ok, false);
      assert.equal(result.code, 'allowed_roots_not_configured');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects nonexistent and non-directory roots on write', async () => {
    const { home, service } = fixture();
    try {
      const file = path.join(home, 'file.md');
      fs.writeFileSync(file, 'x');
      await assert.rejects(
        () => service.setMany({ INDEX_ALLOWED_ROOTS: [path.join(home, 'missing')] }),
        (err) => err.code === 'invalid_value' && err.invalidKey === 'INDEX_ALLOWED_ROOTS',
      );
      await assert.rejects(
        () => service.setMany({ INDEX_ALLOWED_ROOTS: [file] }),
        (err) => err.code === 'invalid_value' && err.invalidKey === 'INDEX_ALLOWED_ROOTS',
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('applies a valid change immediately to an already-constructed guard', async () => {
    const { home, service } = fixture();
    try {
      const root = path.join(home, 'root');
      fs.mkdirSync(root);
      const guard = createAllowedRootsGuard({ settingsService: service, log: () => {} });
      assert.equal(guard.checkTarget(root).ok, false);
      await service.setMany({ INDEX_ALLOWED_ROOTS: [root] });
      assert.equal(guard.checkTarget(root).ok, true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('OS environment retains precedence and locks out persisted writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semidex-env-root-'));
    const { home, service } = fixture(undefined, { INDEX_ALLOWED_ROOTS: JSON.stringify([root]) });
    try {
      assert.deepEqual(service.getActiveValue('INDEX_ALLOWED_ROOTS'), [root]);
      await assert.rejects(
        () => service.setMany({ INDEX_ALLOWED_ROOTS: [] }),
        (err) => err.code === 'setting_overridden'
          && err.overriddenKey === 'INDEX_ALLOWED_ROOTS'
          && err.overriddenSource === 'os_env',
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
