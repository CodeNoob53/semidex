// src/admin/bootstrap.js — the real npm run admin entry point. The pure
// env-snapshot/load helpers (snapshotOsEnv/loadDotenvValues/
// applyDotenvValues/bootstrapEnv) were relocated to src/core/env-bootstrap.js
// during the Global Settings phase and are tested there
// (tests/unit/core/env-bootstrap.test.js); this file only re-exports them
// for backwards compatibility, tested here, plus the isMainModule
// self-start guard — exercised live (npm run admin), not in this test file,
// since importing bootstrap.js in a test must never itself start a server
// or touch a real .env file on disk (import.meta.url !== the test runner's
// entry script, so the guard already prevents that).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshotOsEnv, loadDotenvValues, applyDotenvValues, bootstrapEnv,
} from '../../../src/admin/bootstrap.js';
import * as envBootstrap from '../../../src/shared/core/env-bootstrap.js';

const BOOTSTRAP_ENTRY_URL = new URL('../../../src/admin/bootstrap.js', import.meta.url).href;

describe('bootstrap.js — re-exports env-bootstrap.js unchanged', () => {
  test('snapshotOsEnv/loadDotenvValues/applyDotenvValues/bootstrapEnv are the same functions as core/env-bootstrap.js', () => {
    assert.equal(snapshotOsEnv, envBootstrap.snapshotOsEnv);
    assert.equal(loadDotenvValues, envBootstrap.loadDotenvValues);
    assert.equal(applyDotenvValues, envBootstrap.applyDotenvValues);
    assert.equal(bootstrapEnv, envBootstrap.bootstrapEnv);
  });
});

describe('bootstrap.js — resolves the effective ONNX CUDA runtime before applyEnvWriteBack()', () => {
  const src = readFileSync(new URL('../../../src/admin/bootstrap.js', import.meta.url), 'utf-8');

  // Structural wiring only — bootstrap.js is a self-starting isMainModule
  // script with no exported composition function (unlike
  // indexer/index-full.js's own runFullIndexerComposition()), so it
  // cannot be called directly with injected fakes in a test. The
  // resolution/typed-unavailable-capability BEHAVIOR itself has full
  // behavioral coverage elsewhere: resolveOnnxRuntimeForProcess() in
  // tests/unit/local/core/onnx-runtime-source-resolution.test.js, and
  // createOnnxRuntimeUnavailableCapability() in
  // tests/unit/local/core/onnx-runtime-unavailable-capability.test.js.
  test('resolves via the shared resolveOnnxRuntimeForProcess() INSIDE the isMainModule guard, right after settingsService is constructed and before applyEnvWriteBack()', () => {
    const guardStart = src.indexOf('if (isMainModule)');
    const settingsServiceLine = src.indexOf('createSettingsService({ osEnv, dotenvValues })');
    const resolveCall = src.indexOf('resolveOnnxRuntimeForProcess({ settingsService, env: process.env })');
    const writeBackCall = src.indexOf('applyEnvWriteBack(settingsService)');
    const createAppCall = src.indexOf('createApp({ generationRuntime, settingsService, jobBaseEnv, onnxEmbedCapability })');
    assert.ok(guardStart >= 0);
    assert.ok(settingsServiceLine > guardStart);
    assert.ok(resolveCall > settingsServiceLine, 'resolution must run after settingsService is constructed');
    assert.ok(writeBackCall > resolveCall, 'resolution must run before applyEnvWriteBack()');
    assert.ok(createAppCall > resolveCall, 'the resolved onnxEmbedCapability must reach createApp()');
  });

  test('a non-ok prepared result builds a typed-unavailable onnxEmbedCapability via createOnnxRuntimeUnavailableCapability(), passed into createApp() — never throws/crashes admin startup', () => {
    assert.match(src, /import \{ createOnnxRuntimeUnavailableCapability \} from '\.\.\/local\/core\/onnx-runtime-unavailable-capability\.js'/);
    assert.match(src, /const onnxEmbedCapability = onnxRuntimeResolution\.prepared\.ok\s*\n\s*\? undefined\s*\n\s*: createOnnxRuntimeUnavailableCapability\(onnxRuntimeResolution\.prepared\.reason\);/);
  });

  // Code review finding (P1): local/core/ollama-capability.js must be
  // DYNAMICALLY imported, inside the isMainModule guard, after
  // bootstrapEnv()/applyEnvWriteBack() — never a static top-level import.
  // local/core/ollama.js (which ollama-capability.js statically imports)
  // has its own top-level `import 'dotenv/config'` AND captures
  // `OLLAMA_URL` from `process.env.OLLAMA_URL` into a module-scope
  // constant at import time. A static import chain here would let dotenv
  // gap-fill process.env and freeze OLLAMA_URL into that constant BEFORE
  // this file's own bootstrapEnv() call ever ran — silently misclassifying
  // a .env value as a genuine OS-env value, and making a settings.json
  // -saved OLLAMA_URL (applied via applyEnvWriteBack()) never actually
  // reach the real Ollama runtime, since OLLAMA_URL would already be
  // frozen by the time the write-back ran.
  test('imports local/core/ollama-capability.js dynamically (not statically) and only after applyEnvWriteBack()', () => {
    assert.doesNotMatch(src, /^import\s*\{[^}]*\}\s*from\s*['"]\.\.\/local\/core\/ollama-capability\.js['"]/m, 'must not statically import local/core/ollama-capability.js at the top of the file');
    const writeBackCall = src.indexOf('applyEnvWriteBack(settingsService)');
    const ollamaCapabilityImport = src.indexOf("await import('../local/core/ollama-capability.js')");
    assert.ok(writeBackCall >= 0, 'expected a real applyEnvWriteBack(settingsService) call');
    assert.ok(ollamaCapabilityImport > writeBackCall, 'the dynamic import of ollama-capability.js must come after applyEnvWriteBack()');
  });
});

describe('admin/bootstrap.js entry point — bootstrapEnv() ordering (code-review fix, P1 — mirrors indexer/index-bootstrap-ordering.test.js\'s own proof for the indexer entry point)', () => {
  test('a probe script that imports bootstrap.js NOT as the main module (no server start) reports zero env mutations — proves no dotenv-tainted module (local/core/ollama.js via ollama-capability.js) loads eagerly at import time', () => {
    // This test does not start the real admin server (which would require
    // a live Qdrant) — it proves the STRUCTURAL fix instead: bootstrap.js
    // has no static dotenv-tainted imports of its own (onnx-runtime-
    // source-resolution.js/onnx-runtime-unavailable-capability.js are both
    // confirmed dotenv-free — see their own imports), so importing it
    // alone, without process.argv[1] matching its own path (i.e. NOT as
    // the main module), must not touch process.env at all. If
    // local/core/ollama-capability.js were ever reintroduced as a static
    // top-level import, this test would fail: local/core/ollama.js's own
    // `import 'dotenv/config'` would fire at module-graph-resolution time,
    // gap-filling process.env from any .env file present in the probe's
    // own working directory.
    const tmpDir = mkdtempSync(join(tmpdir(), 'semidex-admin-bootstrap-test-'));
    const probeScript = join(tmpDir, 'probe.mjs');
    // A conflicting .env file in the probe's own cwd — if dotenv ever
    // loads eagerly (the exact bug class this test guards against), this
    // key would appear in process.env after the import, even though
    // bootstrap.js was never run as the main module.
    writeFileSync(join(tmpDir, '.env'), 'SEMIDEX_ADMIN_BOOTSTRAP_PROBE_KEY=from-dotenv\n', 'utf-8');
    writeFileSync(probeScript, `
      const before = { ...process.env };
      await import(${JSON.stringify(BOOTSTRAP_ENTRY_URL)});
      const after = { ...process.env };
      const changed = Object.keys(after).filter(k => after[k] !== before[k]);
      const added = Object.keys(after).filter(k => !(k in before));
      console.log(JSON.stringify({ changed, added }));
    `, 'utf-8');

    try {
      const result = spawnSync(process.execPath, [probeScript], { encoding: 'utf-8', cwd: tmpDir });
      assert.equal(result.status, 0, `probe script failed: ${result.stderr}`);
      const { changed, added } = JSON.parse(result.stdout.trim());
      assert.deepEqual(changed, [], 'importing bootstrap.js (not as main module) must not mutate any existing env var');
      assert.deepEqual(added, [], 'importing bootstrap.js (not as main module) must not add any new env var (i.e. no eager dotenv load)');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('OLLAMA_URL resolved from settings (via applyEnvWriteBack()) reaches local/core/ollama-capability.js\'s real functions when imported AFTER the write-back — proves the ordering fix is not just structural but actually delivers the right runtime value', async () => {
    // Simulates bootstrap.js's own real sequence in miniature: construct a
    // SettingsService whose active OLLAMA_URL resolves from osEnv (the
    // os_env tier — the highest-priority tier, so it is guaranteed to be
    // the ACTIVE value regardless of settings.json's own state on this
    // machine), write it back into process.env, THEN dynamically import
    // ollama-capability.js — mirroring bootstrap.js's own real ordering.
    // local/core/ollama.js's OLLAMA_URL constant is captured from
    // process.env at import time, so this test mutates the REAL
    // process.env (restored in `finally`) rather than a fake object, since
    // only the real process.env is what ollama.js's own module-scope
    // constant reads from.
    const { createSettingsService, applyEnvWriteBack } = await import('../../../src/core/settings/service.js');
    const originalOllamaUrl = process.env.OLLAMA_URL;
    try {
      const settingsService = createSettingsService({
        osEnv: { OLLAMA_URL: 'http://settings-configured-host:11500' }, dotenvValues: {},
      });
      assert.equal(settingsService.getActiveValue('OLLAMA_URL'), 'http://settings-configured-host:11500', 'sanity: the settings service itself must resolve OLLAMA_URL to the os_env-tier value');
      applyEnvWriteBack(settingsService);
      assert.equal(process.env.OLLAMA_URL, 'http://settings-configured-host:11500', 'sanity: applyEnvWriteBack() must have written the configured value into process.env before ollama-capability.js is ever imported');

      const { createOllamaDiscoveryCapability } = await import(`../../../src/local/core/ollama-capability.js?bootstrap-write-back-order-check-${Date.now()}`);
      const capability = createOllamaDiscoveryCapability();
      const savedFetch = globalThis.fetch;
      let calledUrl = null;
      globalThis.fetch = async (url) => { calledUrl = url; return { ok: true }; };
      try {
        await capability.isOllamaReachable();
      } finally {
        globalThis.fetch = savedFetch;
      }
      assert.match(calledUrl, /^http:\/\/settings-configured-host:11500\//, 'expected isOllamaReachable() (called with no explicit baseUrl) to default to the settings-configured OLLAMA_URL, proving the write-back reached the real runtime, not a stale pre-bootstrap value');
    } finally {
      if (originalOllamaUrl === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = originalOllamaUrl;
    }
  });
});

describe('bootstrap.js — import safety', () => {
  test('importing this module does not start a server or bind a port (isMainModule guard holds under the test runner)', async () => {
    // If the guard were broken, importing this file from the test runner
    // (whose process.argv[1] is the test runner's own entry, not
    // bootstrap.js) would attempt server.listen() and this import would
    // either throw (port already bound by another test) or leave a
    // dangling listener. A clean, silent import is the proof.
    await import('../../../src/admin/bootstrap.js');
    // No assertion needed beyond "did not throw and did not hang" — a
    // hidden server.listen() call would manifest as an unclosed handle
    // that the test runner would flag separately.
  });
});
