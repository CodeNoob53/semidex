// src/core/app-data-dir.js — the neutral, edition-agnostic per-user
// application-data directory resolver both Full (src/local/core/
// semidex-home.js) and Lite (packages/lite/lite-src/semidex-home.js)
// delegate to. No real fs access, no real env — every case injects
// platform/env explicitly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveAppDataDir } from '../../../src/core/app-data-dir.js';

describe('resolveAppDataDir()', () => {
  it('windows: uses LOCALAPPDATA when set', () => {
    const result = resolveAppDataDir('myapp', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' } });
    assert.equal(result, join('C:\\Users\\demo\\AppData\\Local', 'myapp'));
  });

  it('windows: falls back to homedir()/AppData/Local when LOCALAPPDATA is unset', () => {
    const result = resolveAppDataDir('myapp', { platform: 'win32', env: {} });
    assert.equal(result, join(homedir(), 'AppData', 'Local', 'myapp'));
  });

  it('darwin: uses ~/Library/Application Support, ignores env entirely', () => {
    const result = resolveAppDataDir('myapp', { platform: 'darwin', env: { LOCALAPPDATA: 'irrelevant', XDG_DATA_HOME: 'irrelevant' } });
    assert.equal(result, join(homedir(), 'Library', 'Application Support', 'myapp'));
  });

  it('linux: uses XDG_DATA_HOME when set', () => {
    const result = resolveAppDataDir('myapp', { platform: 'linux', env: { XDG_DATA_HOME: '/home/demo/.data' } });
    assert.equal(result, join('/home/demo/.data', 'myapp'));
  });

  it('linux: falls back to ~/.local/share when XDG_DATA_HOME is unset', () => {
    const result = resolveAppDataDir('myapp', { platform: 'linux', env: {} });
    assert.equal(result, join(homedir(), '.local', 'share', 'myapp'));
  });

  it('is a pure function of its inputs — no default parameter reads real process.env/process.platform unless omitted', () => {
    const a = resolveAppDataDir('a', { platform: 'win32', env: { LOCALAPPDATA: 'X' } });
    const b = resolveAppDataDir('a', { platform: 'win32', env: { LOCALAPPDATA: 'X' } });
    assert.equal(a, b);
  });

  it('two different app names never collide under the same platform/env', () => {
    const a = resolveAppDataDir('semidex', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\AppData' } });
    const b = resolveAppDataDir('semidex-lite', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\AppData' } });
    assert.notEqual(a, b);
    assert.equal(a, join('C:\\AppData', 'semidex'));
    assert.equal(b, join('C:\\AppData', 'semidex-lite'));
  });
});
