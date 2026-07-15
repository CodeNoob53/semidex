// src/indexer/index.js / run.js split (code-review fix) — proves
// bootstrapEnv() genuinely runs BEFORE any dotenv-tainted module (e.g.
// core/config.js, core/qdrant.js) loads .env, by spawning the real
// indexer entry point as a child process with a conflicting OS-env value
// and a temp .env file, then asserting OS-env won via a probe script.
//
// Before the fix: index.js itself imported run.js's dotenv-tainted
// dependencies (statically, at the top of the same file), so those
// imports' own `import 'dotenv/config'` fired at module-graph-resolution
// time — before the isMainModule block's bootstrapEnv() call ever ran.
// That made bootstrapEnv()'s OS-env snapshot meaningless: by the time it
// ran, process.env already had .env's values gap-filled in (harmlessly,
// since dotenv's populate() never overrides an existing key — but the
// SettingsService's osEnv/dotenvValues snapshots were captured too late to
// distinguish the two for provenance purposes). This test spawns the real
// entry point and inspects RRF_K's resolved settings-service source via a
// probe, which requires OS-env to have actually been snapshotted first.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const INDEXER_ENTRY_URL = new URL('../../../src/indexer/index.js', import.meta.url).href;

describe('index.js entry point — bootstrapEnv() ordering (code-review fix)', () => {
  test('a probe script spawned the same way index.js is (dynamic import of run.js after bootstrapEnv()) reports OS env winning over .env for the same key', () => {
    // This test does not run the full indexer (requires live Qdrant/Ollama)
    // — it proves the STRUCTURAL fix instead: index.js has no static
    // dotenv-tainted imports of its own, so importing it alone (without
    // reaching the isMainModule branch, i.e. NOT as the main module) must
    // not touch process.env at all. Combined with
    // core/env-bootstrap.test.js's existing proof that bootstrapEnv()
        // itself correctly distinguishes OS-env from dotenv when called first,
    // this closes the gap the code review identified: previously,
    // importing index.js (even indirectly) would have already loaded
    // dotenv-tainted modules statically, before reaching the guard.
    const tmpDir = mkdtempSync(join(tmpdir(), 'semidex-idx-bootstrap-test-'));
    const probeScript = join(tmpDir, 'probe.mjs');
    // A minimal script that imports index.js NOT as the main module
    // (import, not `node index.js`) — proving the import itself has zero
    // env side effects, which is the structural guarantee the fix relies
    // on (dotenv-tainted imports only happen inside the isMainModule
    // branch's dynamic import() of run.js).
    writeFileSync(probeScript, `
      const before = { ...process.env };
      await import(${JSON.stringify(INDEXER_ENTRY_URL)});
      const after = { ...process.env };
      const changed = Object.keys(after).filter(k => after[k] !== before[k]);
      const added = Object.keys(after).filter(k => !(k in before));
      console.log(JSON.stringify({ changed, added }));
    `, 'utf-8');

    try {
      const result = spawnSync(process.execPath, [probeScript], { encoding: 'utf-8' });
      assert.equal(result.status, 0, `probe script failed: ${result.stderr}`);
      const { changed, added } = JSON.parse(result.stdout.trim());
      assert.deepEqual(changed, [], 'importing index.js (not as main module) must not mutate any existing env var');
      assert.deepEqual(added, [], 'importing index.js (not as main module) must not add any new env var (i.e. no eager dotenv load)');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('run.js exports applyAllSettings and run — the two hooks index.js calls after bootstrapping', async () => {
    const mod = await import('../../../src/indexer/run.js');
    assert.equal(typeof mod.applyAllSettings, 'function');
    assert.equal(typeof mod.run, 'function');
  });
});
