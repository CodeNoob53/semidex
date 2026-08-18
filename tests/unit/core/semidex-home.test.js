// src/local/core/semidex-home.js — Full Semidex's own application-data
// home resolver, used only for the managed CUDA runtimes tree. Delegates
// its platform branching to src/core/app-data-dir.js (tested separately);
// these tests confirm the delegation and the runtimes/managed-runtime-dir
// derivation, not the platform-branching logic itself.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveSemidexHomePaths, resolveManagedRuntimeDir, applySemidexHomeEnv } from '../../../src/local/core/semidex-home.js';

describe('resolveSemidexHomePaths() (Full)', () => {
  it('SEMIDEX_HOME override wins over the platform default', () => {
    const result = resolveSemidexHomePaths({ platform: 'win32', env: { SEMIDEX_HOME: 'C:\\custom\\semidex-home' } });
    assert.equal(result.semidexHome, 'C:\\custom\\semidex-home');
    assert.equal(result.runtimesDir, join('C:\\custom\\semidex-home', 'runtimes'));
  });

  it('falls back to the platform default (via app-data-dir.js) when SEMIDEX_HOME is unset', () => {
    const result = resolveSemidexHomePaths({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' } });
    assert.equal(result.semidexHome, join('C:\\Users\\demo\\AppData\\Local', 'semidex'));
  });

  it('never derives configPath/settingsPath/tokenizerCacheDir — those stay package-relative, untouched by this task', () => {
    const result = resolveSemidexHomePaths({ platform: 'win32', env: { SEMIDEX_HOME: 'C:\\x' } });
    // keyStorePath IS derived here (Integration API bearer keys): it must sit
    // beside the other per-edition application state and specifically NOT in
    // settings.json, which is served to the browser via GET /api/settings.
    assert.deepEqual(Object.keys(result).sort(), ['keyStorePath', 'runtimesDir', 'semidexHome']);
    assert.equal(result.keyStorePath.includes('settings.json'), false);
  });

  it('never collides with Lite\'s own semidex-lite-named home under the same LOCALAPPDATA', () => {
    const result = resolveSemidexHomePaths({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\AppData' } });
    assert.equal(result.semidexHome, join('C:\\AppData', 'semidex'));
    assert.equal(/semidex-lite/.test(result.semidexHome), false);
  });
});

describe('applySemidexHomeEnv() (Full) — closes the bootstrap.js/src/key.js key-store path divergence', () => {
  it('sets SEMIDEX_HOME to the SAME path resolveSemidexHomePaths() (used by src/key.js) resolves, when unset', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' };
    const expected = resolveSemidexHomePaths({ platform: 'win32', env }).semidexHome;
    const returned = applySemidexHomeEnv({ platform: 'win32', env });
    assert.equal(env.SEMIDEX_HOME, expected);
    assert.equal(returned, expected);
  });

  it('never overrides an explicit SEMIDEX_HOME', () => {
    const env = { SEMIDEX_HOME: 'C:\\custom\\semidex-home', LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' };
    const returned = applySemidexHomeEnv({ platform: 'win32', env });
    assert.equal(env.SEMIDEX_HOME, 'C:\\custom\\semidex-home');
    assert.equal(returned, 'C:\\custom\\semidex-home');
  });

  it('once applied, resolveIntegrationPolicy\'s own default key-store path resolution (SEMIDEX_HOME branch) agrees with resolveSemidexHomePaths().keyStorePath', async () => {
    const { resolveKeyStorePath } = await import('../../../src/core/auth/resolve-policy.js');
    const env = { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' };
    applySemidexHomeEnv({ platform: 'win32', env });
    const cliPath = resolveSemidexHomePaths({ platform: 'win32', env }).keyStorePath;
    // resolveKeyStorePath has no platform param (it only reads env), so this
    // only proves the SEMIDEX_HOME branch — the one bootstrap.js's fix makes
    // reachable in production — agrees with the CLI's own path once
    // SEMIDEX_HOME is set the way applySemidexHomeEnv() now sets it.
    assert.equal(resolveKeyStorePath(env), cliPath);
  });
});

describe('resolveManagedRuntimeDir()', () => {
  it('builds the exact <runtimesDir>/onnxruntime-node-cuda/<ortVersion>-cuda<cudaMajor>/ shape', () => {
    const result = resolveManagedRuntimeDir({
      platform: 'win32', env: { SEMIDEX_HOME: 'C:\\semidex-home' },
      ortVersion: '1.26.0', cudaMajor: '13',
    });
    assert.equal(result, join('C:\\semidex-home', 'runtimes', 'onnxruntime-node-cuda', '1.26.0-cuda13'));
  });

  it('different ortVersion/cudaMajor combos produce distinct directories', () => {
    const a = resolveManagedRuntimeDir({ platform: 'win32', env: { SEMIDEX_HOME: 'C:\\h' }, ortVersion: '1.26.0', cudaMajor: '13' });
    const b = resolveManagedRuntimeDir({ platform: 'win32', env: { SEMIDEX_HOME: 'C:\\h' }, ortVersion: '1.27.0', cudaMajor: '13' });
    const c = resolveManagedRuntimeDir({ platform: 'win32', env: { SEMIDEX_HOME: 'C:\\h' }, ortVersion: '1.26.0', cudaMajor: '12' });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.notEqual(b, c);
  });
});
