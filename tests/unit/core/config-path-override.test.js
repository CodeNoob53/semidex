// SEMIDEX_CONFIG_PATH override (production change for the production-path
// benchmark harness — benchmarks/external/production-path/ — and now also
// the Semidex Lite writable-storage foundation). CONFIG_PATH is an
// import-time constant (computed once when config.js is first evaluated) —
// this file only ever sets SEMIDEX_CONFIG_PATH to override values, never
// leaves it unset, so every dynamic import() below observes the identical
// resolved constant. The unset/fallback scenario is intentionally a
// SEPARATE file (config-path-default.test.js), not a third test here: an
// earlier version of this file asserted the fallback case in the same
// process as the override tests, using only a weak "returns an object"
// assertion — which passed even though config.js's module cache meant it
// was silently re-observing the FIRST test's already-resolved override
// path, not the real unset-fallback path at all (caught by strengthening
// the assertion to check the actual resolved path, in review). node:test
// runs each file in its own process, so the split below is what actually
// gives each scenario a fresh module evaluation.
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
});
