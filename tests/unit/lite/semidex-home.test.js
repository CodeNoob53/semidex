import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { defaultSemidexHome, resolveSemidexHomePaths, applySemidexHomeEnv } from '../../../packages/lite/lite-src/semidex-home.js';

describe('defaultSemidexHome()', () => {
  it('windows: uses LOCALAPPDATA', () => {
    const home = defaultSemidexHome({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' } });
    assert.equal(home, join('C:\\Users\\demo\\AppData\\Local', 'semidex-lite'));
  });

  it('darwin: uses ~/Library/Application Support', () => {
    const home = defaultSemidexHome({ platform: 'darwin', env: {} });
    assert.ok(home.endsWith(join('Library', 'Application Support', 'semidex-lite')));
  });

  it('linux: uses XDG_DATA_HOME when set', () => {
    const home = defaultSemidexHome({ platform: 'linux', env: { XDG_DATA_HOME: '/home/demo/.local/share' } });
    assert.equal(home, join('/home/demo/.local/share', 'semidex-lite'));
  });

  it('linux: falls back to ~/.local/share when XDG_DATA_HOME unset', () => {
    const home = defaultSemidexHome({ platform: 'linux', env: {} });
    assert.ok(home.endsWith(join('.local', 'share', 'semidex-lite')));
  });

  it('never collides with a full-Semidex path — always ends in semidex-lite, not semidex', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const home = defaultSemidexHome({ platform, env: {} });
      assert.ok(home.endsWith('semidex-lite'));
    }
  });
});

describe('resolveSemidexHomePaths()', () => {
  it('SEMIDEX_HOME override wins over the platform default', () => {
    const paths = resolveSemidexHomePaths({ env: { SEMIDEX_HOME: '/custom/home' }, platform: 'linux' });
    assert.equal(paths.semidexHome, '/custom/home');
  });

  it('derives config.json/settings.json/cache/tokenizers under the resolved home', () => {
    const paths = resolveSemidexHomePaths({ env: { SEMIDEX_HOME: '/custom/home' }, platform: 'linux' });
    assert.equal(paths.configPath, join('/custom/home', 'config.json'));
    assert.equal(paths.settingsPath, join('/custom/home', 'settings.json'));
    assert.equal(paths.tokenizerCacheDir, join('/custom/home', 'cache', 'tokenizers'));
  });

  it('falls back to the platform default when SEMIDEX_HOME is unset', () => {
    const paths = resolveSemidexHomePaths({ env: {}, platform: 'linux' });
    assert.ok(paths.semidexHome.endsWith('semidex-lite'));
  });
});

describe('applySemidexHomeEnv()', () => {
  it('sets all four env vars in place and returns the same resolved paths', () => {
    const env = { SEMIDEX_HOME: '/custom/home' };
    const paths = applySemidexHomeEnv({ env, platform: 'linux' });
    assert.equal(env.SEMIDEX_HOME, '/custom/home');
    assert.equal(env.SEMIDEX_CONFIG_PATH, paths.configPath);
    assert.equal(env.SEMIDEX_SETTINGS_PATH, paths.settingsPath);
    assert.equal(env.SEMIDEX_TOKENIZER_CACHE_DIR, paths.tokenizerCacheDir);
  });

  it('a caller with SEMIDEX_HOME unset gets a fully derived env, never leaves the three child vars unset', () => {
    const env = {};
    applySemidexHomeEnv({ env, platform: 'linux' });
    assert.ok(env.SEMIDEX_HOME);
    assert.ok(env.SEMIDEX_CONFIG_PATH);
    assert.ok(env.SEMIDEX_SETTINGS_PATH);
    assert.ok(env.SEMIDEX_TOKENIZER_CACHE_DIR);
  });
});
