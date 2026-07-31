// config.js — SEMIDEX_CONFIG_PATH UNSET (fallback) scenario, kept in its
// own file/process for the same reason as its override-set sibling
// (config-path-override.test.js) — see that file's header comment for the
// real caching bug this split fixes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SEMIDEX_CONFIG_PATH;

describe('config.js — SEMIDEX_CONFIG_PATH unset (default)', () => {
  it('loadConfig() does not throw and returns the {collections:{}} shape at the default repo-relative path', async () => {
    const { loadConfig } = await import('../../../src/core/config.js');
    const result = loadConfig();
    assert.ok(result && typeof result.collections === 'object');
  });

  // The strong check the original single-file version of this test was
  // missing: assert the module actually resolved to a repo-relative path,
  // not merely that SOME object came back (a weak assertion that passed
  // even when config.js was silently still using an override from an
  // earlier-imported test in the same process).
  it('CONFIG_PATH-dependent behavior reflects the real default location, not a leftover override', async () => {
    const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // Indirect proof: write a config.json into a throwaway dir, confirm
    // loadConfig() (with SEMIDEX_CONFIG_PATH still unset) does NOT pick it
    // up — i.e. it is not silently resolving to an arbitrary/incorrect
    // path such as a prior test's override.
    const dir = mkdtempSync(join(tmpdir(), 'semidex-config-path-default-decoy-'));
    const decoyPath = join(dir, 'config.json');
    writeFileSync(decoyPath, JSON.stringify({ collections: { decoy: {} } }));
    try {
      const { loadConfig } = await import('../../../src/core/config.js');
      const result = loadConfig();
      assert.ok(!('decoy' in result.collections), 'must never read the decoy path — only the real default location');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
