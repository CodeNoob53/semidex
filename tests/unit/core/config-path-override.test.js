// SEMIDEX_CONFIG_PATH override (production change for the production-path
// benchmark harness — benchmarks/external/production-path/). node:test
// runs each file in its own process, so setting the env var before the
// dynamic import below cannot leak into other test files' already-loaded
// module state.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('config.js — SEMIDEX_CONFIG_PATH override', () => {
  it('uses the overridden path when SEMIDEX_CONFIG_PATH is set, never touching the real repo config.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-config-path-test-'));
    const overridePath = join(dir, 'isolated-config.json');
    process.env.SEMIDEX_CONFIG_PATH = overridePath;
    try {
      const { loadConfig, saveConfig } = await import('../../../src/core/config.js');
      assert.equal(loadConfig().collections && typeof loadConfig().collections, 'object');
      saveConfig({ collections: { 'test-collection': { denseProvider: 'qdrant-cloud' } } });
      assert.ok(existsSync(overridePath), 'expected the isolated config file to be written');
      const written = JSON.parse(readFileSync(overridePath, 'utf-8'));
      assert.deepEqual(written, { collections: { 'test-collection': { denseProvider: 'qdrant-cloud' } } });
    } finally {
      delete process.env.SEMIDEX_CONFIG_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig() returns an empty collections object when the overridden path does not exist yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-config-path-test-'));
    const overridePath = join(dir, 'does-not-exist.json');
    process.env.SEMIDEX_CONFIG_PATH = overridePath;
    try {
      const { loadConfig } = await import('../../../src/core/config.js');
      assert.deepEqual(loadConfig(), { collections: {} });
    } finally {
      delete process.env.SEMIDEX_CONFIG_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the default repo-relative config.json path when SEMIDEX_CONFIG_PATH is unset', async () => {
    delete process.env.SEMIDEX_CONFIG_PATH;
    const { loadConfig } = await import('../../../src/core/config.js');
    // Default behavior is unchanged: loadConfig() must not throw, and must
    // return the same {collections:{...}} shape whether or not a real
    // config.json exists on disk at the default location.
    const result = loadConfig();
    assert.ok(result && typeof result.collections === 'object');
  });
});
