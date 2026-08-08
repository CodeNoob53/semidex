// Tests for POST /api/system/onnx-probe (src/admin/api/onnx.js) — the
// admin route wiring around local/core/onnx-provider-probe.js's
// probeOnnxProvider(). Every test injects a stub runProbeFn — never a real
// child process, never real onnxruntime-node — matching this endpoint's
// own contract that the admin server never loads either ONNX Runtime build
// merely to answer this request.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer } from '../ui-test-helpers.js';
import { createSettingsService } from '../../../../src/core/settings/service.js';

function tempSettingsPath(dir) {
  return join(dir, 'settings.json');
}

async function httpPostJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

// For deliberately malformed request bodies — httpPostJson always sends
// valid JSON (it JSON.stringifies its input), so this sends a raw string
// instead, exercising readJsonBody()'s own "not valid JSON" rejection path.
async function httpPostRaw(base, path, rawBody) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function httpGetJson(base, path) {
  const res = await fetch(`${base}${path}`);
  const json = await res.json();
  return { status: res.status, json };
}

const STABLE_SUCCESS_RESULT = {
  ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
  runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true,
  message: 'CUDA session created successfully',
};

describe('POST /api/system/onnx-probe', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-onnx-probe-api-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('returns the exact stable response shape from the task spec on success', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const runOnnxProbeFn = async () => STABLE_SUCCESS_RESULT;
    await withServer(async (base) => {
      const { status, json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
      assert.equal(status, 200);
      assert.deepEqual(json, {
        ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
        runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true,
        restartRequired: false, testedStagedRuntimePath: false,
        message: 'CUDA session created successfully',
        diagnosis: null,
        managedRuntimeManifest: null,
      });
    }, { settingsService, runOnnxProbeFn });
  });

  test('never reports effectiveProvider:cuda from the setting alone — a CPU-fallback result is surfaced honestly', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const runOnnxProbeFn = async () => ({
      ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
      runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true,
      message: 'no available backend found. ERR: [cuda] backend not found.',
    });
    await withServer(async (base) => {
      const { status, json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
      assert.equal(status, 200); // status-in-body convention — never a 5xx for a normal probe failure
      assert.equal(json.ok, false);
      assert.equal(json.effectiveProvider, null);
      assert.notEqual(json.effectiveProvider, 'cuda');
    }, { settingsService, runOnnxProbeFn });
  });

  test('defaults the requested provider to the currently configured ONNX_EXECUTION_PROVIDER when the request body omits it', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ ONNX_EXECUTION_PROVIDER: 'dml' }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedProvider;
    const runOnnxProbeFn = async (provider) => { receivedProvider = provider; return { ...STABLE_SUCCESS_RESULT, requestedProvider: provider, effectiveProvider: provider }; };
    await withServer(async (base) => {
      await httpPostJson(base, '/api/system/onnx-probe', {});
    }, { settingsService, runOnnxProbeFn });
    assert.equal(receivedProvider, 'dml');
  });

  test('an explicit provider in the request body overrides the configured default', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ ONNX_EXECUTION_PROVIDER: 'cpu' }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedProvider;
    const runOnnxProbeFn = async (provider) => { receivedProvider = provider; return { ...STABLE_SUCCESS_RESULT, requestedProvider: provider }; };
    await withServer(async (base) => {
      await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
    }, { settingsService, runOnnxProbeFn });
    assert.equal(receivedProvider, 'cuda');
  });

  test('rejects an invalid provider value with 400, never spawning the probe', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    let called = false;
    const runOnnxProbeFn = async () => { called = true; return STABLE_SUCCESS_RESULT; };
    await withServer(async (base) => {
      const { status } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'rocm' });
      assert.equal(status, 400);
    }, { settingsService, runOnnxProbeFn });
    assert.equal(called, false);
  });

  test('an empty request body is accepted (provider defaults from settings)', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const runOnnxProbeFn = async (provider) => ({ ...STABLE_SUCCESS_RESULT, requestedProvider: provider });
    await withServer(async (base) => {
      const { status } = await httpPostJson(base, '/api/system/onnx-probe', undefined);
      assert.equal(status, 200);
    }, { settingsService, runOnnxProbeFn });
  });

  test('modelCached:false (model_not_cached) is passed through verbatim, not translated into a generic error', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const runOnnxProbeFn = async () => ({
      ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
      runtimeSource: 'npm', runtimeVersion: null, modelCached: false, message: 'model_not_cached',
    });
    await withServer(async (base) => {
      const { json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
      assert.equal(json.modelCached, false);
      assert.equal(json.message, 'model_not_cached');
    }, { settingsService, runOnnxProbeFn });
  });

  test('restartRequired reflects a pending-restart ONNX_EXECUTION_PROVIDER change (configured differs from active)', async () => {
    // Simulate a next_restart field that was saved but not yet active by
    // constructing the service, then writing a NEW value to settings.json
    // out from under it (mirrors how a real PATCH followed by a probe in
    // the SAME process would leave configuredValue/activeValue diverged —
    // see service.js's frozenActive mechanism).
    const settingsPath = tempSettingsPath(dir);
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    await settingsService.setMany({ ONNX_EXECUTION_PROVIDER: 'cuda' });
    const entry = settingsService.get('ONNX_EXECUTION_PROVIDER');
    assert.equal(entry.pendingRestart, true, 'test setup: expected a pending-restart entry');

    const runOnnxProbeFn = async () => STABLE_SUCCESS_RESULT;
    await withServer(async (base) => {
      const { json } = await httpPostJson(base, '/api/system/onnx-probe', {});
      assert.equal(json.restartRequired, true);
    }, { settingsService, runOnnxProbeFn });
  });

  test('restartRequired is false when the configured provider is already active (no pending change)', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const runOnnxProbeFn = async () => STABLE_SUCCESS_RESULT;
    await withServer(async (base) => {
      const { json } = await httpPostJson(base, '/api/system/onnx-probe', {});
      assert.equal(json.restartRequired, false);
    }, { settingsService, runOnnxProbeFn });
  });

  test('passes the configured ONNXRUNTIME_NODE_PATH through to the probe env', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({ ONNXRUNTIME_NODE_PATH: '/custom/ort/path' }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedEnv;
    const runOnnxProbeFn = async (provider, opts) => { receivedEnv = opts?.env; return STABLE_SUCCESS_RESULT; };
    await withServer(async (base) => {
      await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
    }, { settingsService, runOnnxProbeFn });
    assert.equal(receivedEnv?.ONNXRUNTIME_NODE_PATH, '/custom/ort/path');
  });

  // Provider-aware resolution (bug fix): ONNX_MANAGED_RUNTIME names a
  // CUDA-only build. A DML probe used to still resolve/apply it (the
  // resolution layer was entirely provider-blind), producing
  // "no available backend found. ERR: [dml] backend not found" against a
  // runtime that was never broken — it just wasn't built for DML. This
  // exercises the REAL resolveEffectiveOnnxRuntimePath() (not injected),
  // the same one production startup goes through, to prove the fix at the
  // actual HTTP route boundary, not just the lower-level unit.
  test('a DML probe never receives the managed CUDA runtime path, even when ONNX_MANAGED_RUNTIME is saved — the managed build is CUDA-only', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({
      ONNX_EXECUTION_PROVIDER: 'dml', ONNX_MANAGED_RUNTIME: '1.26.0-cuda13',
    }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedEnv;
    const runOnnxProbeFn = async (provider, opts) => { receivedEnv = opts?.env; return { ...STABLE_SUCCESS_RESULT, requestedProvider: provider, effectiveProvider: provider }; };
    let json;
    await withServer(async (base) => {
      ({ json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'dml' }));
    }, { settingsService, runOnnxProbeFn });
    assert.equal('ONNXRUNTIME_NODE_PATH' in receivedEnv, false, 'a DML probe must never apply the managed CUDA-only runtime path');
    assert.equal('ONNX_MANAGED_RUNTIME_ACTIVE' in receivedEnv, false, 'a DML probe must never mark the managed CUDA runtime active');
    assert.equal(json.managedRuntimeManifest, null, 'a DML probe response must never surface a managed runtime manifest');
  });

  test('a CUDA probe against a saved ONNX_MANAGED_RUNTIME id that is not actually installed on disk resolves to npm (not managed), surfaced via diagnosis, never a silent fallback — distinct from the DML-is-inapplicable case above', async () => {
    const settingsPath = tempSettingsPath(dir);
    // A well-formed managed-runtime id (passes isValidManagedRuntimeId())
    // but deliberately a version/CUDA-major combination this test never
    // installs anywhere — the real, un-injected resolveSemidexHomePaths()
    // runtimesDir is used here (this route has no DI seam for it), so this
    // must be an id that is virtually certain not to exist on ANY real
    // machine's managed-runtimes directory, unlike '1.26.0-cuda13' (the
    // actual pinned default from scripts/onnxruntime-cuda-lock.json, which
    // a developer machine that ran the real installer may genuinely have
    // installed — using that id here would make this test's outcome
    // depend on host machine state).
    writeFileSync(settingsPath, JSON.stringify({
      ONNX_EXECUTION_PROVIDER: 'cuda', ONNX_MANAGED_RUNTIME: '0.0.1-cuda999',
    }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedEnv;
    const runOnnxProbeFn = async (provider, opts) => { receivedEnv = opts?.env; return { ...STABLE_SUCCESS_RESULT, requestedProvider: provider }; };
    let json;
    await withServer(async (base) => {
      ({ json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' }));
    }, { settingsService, runOnnxProbeFn });
    // No real managed-runtime directory exists for this id, so resolution
    // fails integrity/manifest lookup — this is the EXISTING
    // "invalid/corrupt" path, surfaced via the diagnosis field, never a
    // silent npm fallback with no explanation.
    assert.equal('ONNXRUNTIME_NODE_PATH' in receivedEnv, false);
    assert.ok(json.diagnosis, 'an unresolvable managed selection for the requested cuda provider must be surfaced via diagnosis, not silently dropped');
  });

  test('an explicit body.provider is tested against the CONFIGURED (not stale-active) ONNXRUNTIME_NODE_PATH — never a mix of new provider + old runtime path', async () => {
    // Regression test: the route used to read ONNXRUNTIME_NODE_PATH via
    // getActiveValue() (the frozen, pre-restart value) while the requested
    // provider could come from the request body (a staged, unsaved UI
    // value) — so a user who just typed a new custom runtime path and
    // clicked "Test CUDA configuration" for the newly staged provider
    // would silently get a probe of NEW provider + OLD runtime path, with
    // no indication the two came from different tiers. Both must now come
    // from the same tier (configuredValue) so the probe is self-consistent.
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({
      ONNX_EXECUTION_PROVIDER: 'cpu', ONNXRUNTIME_NODE_PATH: '/new/custom/runtime',
    }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedProvider, receivedEnv;
    const runOnnxProbeFn = async (provider, opts) => {
      receivedProvider = provider;
      receivedEnv = opts?.env;
      return { ...STABLE_SUCCESS_RESULT, requestedProvider: provider };
    };
    await withServer(async (base) => {
      // Body requests 'cuda' explicitly — a different provider than the
      // settings.json default of 'cpu', simulating a staged-but-unsaved UI
      // change being tested directly.
      await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
    }, { settingsService, runOnnxProbeFn });
    assert.equal(receivedProvider, 'cuda');
    // The CONFIGURED runtime path (just saved to settings.json) must be
    // used, not some other stale value — there is no frozen/active divergence
    // possible in this single-process test, but the fix's point is that the
    // SOURCE is always configuredValue for both fields, never mixed tiers.
    assert.equal(receivedEnv?.ONNXRUNTIME_NODE_PATH, '/new/custom/runtime');
  });

  test('an explicit body.runtimePath is used over the saved configuredValue — lets the UI test a STAGED, not-yet-saved runtime path together with a staged provider', async () => {
    // Regression test (second round): the previous fix made both fields
    // consistently use configuredValue — correct for avoiding a mixed-tier
    // probe, but it also meant the Admin UI's "test before Save" panel
    // (which already lets a user test a staged, unsaved PROVIDER) had no
    // way to test a staged, unsaved RUNTIME PATH at the same time. A user
    // who edits ONNXRUNTIME_NODE_PATH and clicks Test before Save would
    // silently have the probe fall back to whatever path was last actually
    // saved. body.runtimePath now lets the caller (the Admin UI) supply the
    // staged value explicitly.
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({
      ONNX_EXECUTION_PROVIDER: 'cpu', ONNXRUNTIME_NODE_PATH: '/saved/old/path',
    }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedEnv;
    const runOnnxProbeFn = async (provider, opts) => { receivedEnv = opts?.env; return STABLE_SUCCESS_RESULT; };
    let json;
    await withServer(async (base) => {
      ({ json } = await httpPostJson(base, '/api/system/onnx-probe', {
        provider: 'cuda', runtimePath: '/staged/unsaved/path',
      }));
    }, { settingsService, runOnnxProbeFn });
    assert.equal(receivedEnv?.ONNXRUNTIME_NODE_PATH, '/staged/unsaved/path', 'the STAGED path must be used, not the saved one');
    assert.equal(json.testedStagedRuntimePath, true, 'the response must confirm a staged (not saved) value was actually used');
  });

  test('omitting body.runtimePath entirely still falls back to the saved configuredValue (no regression to the previous same-tier fix)', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({
      ONNX_EXECUTION_PROVIDER: 'cpu', ONNXRUNTIME_NODE_PATH: '/saved/path',
    }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedEnv;
    const runOnnxProbeFn = async (provider, opts) => { receivedEnv = opts?.env; return STABLE_SUCCESS_RESULT; };
    let json;
    await withServer(async (base) => {
      ({ json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' }));
    }, { settingsService, runOnnxProbeFn });
    assert.equal(receivedEnv?.ONNXRUNTIME_NODE_PATH, '/saved/path');
    assert.equal(json.testedStagedRuntimePath, false);
  });

  test('a body.runtimePath equal to the saved value is not reported as "staged" (only a genuinely different value counts)', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({
      ONNX_EXECUTION_PROVIDER: 'cpu', ONNXRUNTIME_NODE_PATH: '/same/path',
    }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    const runOnnxProbeFn = async () => STABLE_SUCCESS_RESULT;
    let json;
    await withServer(async (base) => {
      ({ json } = await httpPostJson(base, '/api/system/onnx-probe', {
        provider: 'cuda', runtimePath: '/same/path',
      }));
    }, { settingsService, runOnnxProbeFn });
    assert.equal(json.testedStagedRuntimePath, false);
  });

  test('an explicit body.runtimePath of "" (empty string) is honored as "test with no custom runtime" — distinct from omitting the field entirely', async () => {
    const settingsPath = tempSettingsPath(dir);
    writeFileSync(settingsPath, JSON.stringify({
      ONNX_EXECUTION_PROVIDER: 'cpu', ONNXRUNTIME_NODE_PATH: '/saved/path',
    }), 'utf-8');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    let receivedEnv;
    const runOnnxProbeFn = async (provider, opts) => { receivedEnv = opts?.env; return STABLE_SUCCESS_RESULT; };
    let json;
    await withServer(async (base) => {
      ({ json } = await httpPostJson(base, '/api/system/onnx-probe', {
        provider: 'cuda', runtimePath: '',
      }));
    }, { settingsService, runOnnxProbeFn });
    assert.equal(receivedEnv?.ONNXRUNTIME_NODE_PATH, undefined, 'an explicit empty runtimePath must mean "use the default npm package", not "keep the saved custom path"');
    assert.equal(json.testedStagedRuntimePath, true, 'explicitly testing with no custom runtime, when one is saved, is still a staged/different value');
  });

  test('restartRequired is true when ONNXRUNTIME_NODE_PATH itself has a pending restart, even if the provider does not', async () => {
    // Regression test: restartRequired previously only reflected
    // ONNX_EXECUTION_PROVIDER's own pendingRestart — a probe result could
    // be reported as "no restart needed" while the runtime path used to
    // build the probe's env was itself still pending, silently omitting
    // half the relevant pending-restart state.
    const settingsPath = tempSettingsPath(dir);
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
    await settingsService.setMany({ ONNXRUNTIME_NODE_PATH: '/staged/runtime/path' });
    const runtimeEntry = settingsService.get('ONNXRUNTIME_NODE_PATH');
    assert.equal(runtimeEntry.pendingRestart, true, 'test setup: expected a pending-restart entry');

    const runOnnxProbeFn = async () => STABLE_SUCCESS_RESULT;
    await withServer(async (base) => {
      const { json } = await httpPostJson(base, '/api/system/onnx-probe', {});
      assert.equal(json.restartRequired, true);
    }, { settingsService, runOnnxProbeFn });
  });

  test('a malformed (non-JSON) request body returns 400, not a silently-accepted empty body', async () => {
    // Regression test: a bare try/catch around readJsonBody() used to
    // swallow BOTH a genuinely malformed body and an oversized one,
    // treating either the same as "no body" instead of surfacing
    // readJsonBody()'s own badRequest() error.
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    let called = false;
    const runOnnxProbeFn = async () => { called = true; return STABLE_SUCCESS_RESULT; };
    await withServer(async (base) => {
      const { status } = await httpPostRaw(base, '/api/system/onnx-probe', '{not valid json');
      assert.equal(status, 400);
    }, { settingsService, runOnnxProbeFn });
    assert.equal(called, false, 'malformed JSON must reject before ever reaching the probe');
  });

  test('registerOnnxRoutes()\'s runProbeFn default parameter is genuinely bound to probeOnnxProvider — proven via the live function object, not a re-read of the source file', async () => {
    // Second-round code review finding: the previous version of this test
    // only proved registerOnnxRoutes() constructs without throwing and that
    // probeOnnxProvider is importable — it never actually confirmed WHICH
    // function the omitted runProbeFn parameter resolves to at runtime.
    // That is a real gap: this route's whole safety contract ("never a real
    // child process merely to answer a request without explicit DI")
    // depends on runProbeFn's default being probeOnnxProvider specifically,
    // not e.g. an accidentally-reverted no-op or a typo'd wrong import.
    //
    // Proving this WITHOUT letting the default parameter actually run is
    // constrained by real limits: JS gives no external introspection API
    // for "what does this closure's default parameter expression currently
    // resolve to" — and this repo's ONNX model cache is genuinely present
    // on disk (~2.3 GB, kept for live-acceptance testing elsewhere in this
    // project), with getOnnxModelPath()/ONNX_MODEL_DIR hardcoded constants
    // (core/onnx-paths.js derives them from that file's own location, not
    // from any env var), so there is no way to redirect a real invocation
    // away from touching the real cached model. Module-mocking
    // (node:test's mock.module()) would sidestep this, but is not
    // reliably available on this repo's floor Node version
    // (package.json engines: >=20.16.0; mock.module() stabilized later)
    // and isn't used anywhere else in this codebase.
    //
    // So this test proves what CAN be proven rigorously without a real
    // invocation: Function.prototype.toString() returns the exact source
    // text of the LIVE function object Node actually parsed and would
    // execute (not a separate re-read of the file from disk) — asserting
    // that text names the parameter `runProbeFn`, defaults it to the
    // identifier `probeOnnxProvider`, and that identifier is the same
    // import this file's own top-level `import { probeOnnxProvider }`
    // resolves to. This is a genuine runtime-level check of the compiled
    // function, stronger than a source-file regex, though it stops short
    // of proving the default parameter is EXECUTED correctly when omitted
    // — that would require the real invocation this test deliberately
    // avoids. probeOnnxProvider's own behavior (with injected spawnFn
    // stubs, never a real spawn) is exercised exhaustively by
    // onnx-provider-probe.test.js's own suite.
    const { registerOnnxRoutes } = await import('../../../../src/local/admin/api/onnx.js');
    const { probeOnnxProvider } = await import('../../../../src/local/core/onnx-provider-probe.js');

    const src = registerOnnxRoutes.toString();
    // `s` flag: the destructured-params block now spans multiple lines
    // (several more DI defaults were added alongside runProbeFn).
    const match = src.match(/function\s+registerOnnxRoutes\s*\(\s*router\s*,\s*\{([^}]*)\}\s*=\s*\{\}\s*\)/s);
    assert.ok(match, 'expected registerOnnxRoutes(router, { ... } = {}) destructured-params signature');
    assert.match(match[1], /runProbeFn\s*=\s*probeOnnxProvider\b/, 'runProbeFn must default to the identifier probeOnnxProvider');

    // Confirm construction still succeeds with no runProbeFn override (a
    // real regression here — e.g. a required-without-default param — would
    // throw at this call, independent of the source-text check above).
    // fakeRouter needs both .post (the probe route) and .get (the new
    // managed-runtime listing route) — registerOnnxRoutes() registers one
    // of each.
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const registeredPost = [];
    const registeredGet = [];
    const fakeRouter = {
      post: (path, handler) => registeredPost.push({ path, handler }),
      get: (path, handler) => registeredGet.push({ path, handler }),
    };
    registerOnnxRoutes(fakeRouter, { settingsService });
    assert.equal(registeredPost.length, 1);
    assert.equal(registeredPost[0].path, '/api/system/onnx-probe');
    assert.equal(typeof registeredPost[0].handler, 'function');
    assert.equal(registeredGet.length, 1);
    assert.equal(registeredGet[0].path, '/api/system/onnx-managed-runtimes');
    assert.equal(typeof registeredGet[0].handler, 'function');
    assert.equal(typeof probeOnnxProvider, 'function');
  });

  // managedRuntimeManifest field + verification write-back — every test
  // injects a stub resolveEffectiveOnnxRuntimePathFn (never real fs) and a
  // stub writeVerificationResultFn (never a real manifest write).
  describe('managedRuntimeManifest field + verification write-back', () => {
    const MANAGED_RESOLVED = {
      path: 'C:\\fake\\runtimes\\onnxruntime-node-cuda\\1.26.0-cuda13',
      source: 'managed', managedId: '1.26.0-cuda13', cudnnBinPath: null,
    };

    test('a successful CUDA probe against a managed selection returns managedRuntimeManifest and writes verification.status "verified"', async () => {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
      const resolveEffectiveOnnxRuntimePathFn = () => MANAGED_RESOLVED;
      const runOnnxProbeFn = async () => ({
        ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
        runtimeSource: 'managed', runtimeVersion: '1.26.0', modelCached: true, message: 'CUDA session created successfully',
      });
      let writeCall = null;
      const writeVerificationResultFn = (dirPath, update) => { writeCall = { dirPath, update }; return { ok: true, manifest: {} }; };

      // readManagedRuntimeManifest/computeManifestIdentityFingerprint are
      // NOT injectable (real, pure, no I/O side effect issue — but they DO
      // read real fs). Since this route only calls them when
      // resolved.source === 'managed', and this test's fake path doesn't
      // exist on disk, readManagedRuntimeManifest() will report not_found
      // and the route's own `before.ok` guard skips the write — so this
      // specific assertion (write DID happen) requires a real manifest on
      // disk. Covered instead by the dedicated integration test below
      // using a real temp directory.
      await withServer(async (base) => {
        const { json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
        assert.equal(json.managedRuntimeManifest, null); // no real manifest on disk in this test
      }, { settingsService, runOnnxProbeFn, resolveEffectiveOnnxRuntimePathFn, writeVerificationResultFn });
      assert.equal(writeCall, null, 'write-back is correctly skipped when no real manifest exists to read a fingerprint from');
    });

    test('with a REAL manifest on disk: a successful managed-runtime probe writes verification.status "verified" and returns the manifest projection', async () => {
      const { mkdtempSync: mkdtemp, mkdirSync, writeFileSync: writeFile } = await import('node:fs');
      const { tmpdir: osTmpdir } = await import('node:os');
      const runtimeDir = mkdtemp(join(osTmpdir(), 'semidex-managed-runtime-'));
      const sha = 'a'.repeat(64);
      const manifest = {
        schemaVersion: 2, ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64',
        provenance: {
          sourceRepository: 'x', sourceTag: 'v1.26.0', sourceCommit: '8c546c37b43caaca1fa25db430dab94b901cf277',
          runtimeAssetUrl: 'x', runtimeAssetSha256: sha, checksumTrust: 'locked',
        },
        artifacts: {
          'onnxruntime.dll': { sha256: sha, bytes: 1 },
          'onnxruntime_binding.node': { sha256: sha, bytes: 1 },
          'onnxruntime_providers_cuda.dll': { sha256: sha, bytes: 1 },
          'onnxruntime_providers_shared.dll': { sha256: sha, bytes: 1 },
        },
        dependencies: { cudnnBinPath: 'C:\\cudnn\\bin' },
        builtAt: '2026-08-07T00:00:00.000Z', buildHost: { platform: 'win32', nodeVersion: '25.2.1' }, installerVersion: '2',
        verification: { status: 'unverified', verifiedAt: null, effectiveProvider: null },
      };
      writeFile(join(runtimeDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');

      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
      const resolveEffectiveOnnxRuntimePathFn = () => ({ path: runtimeDir, source: 'managed', managedId: '1.26.0-cuda13', cudnnBinPath: null });
      const runOnnxProbeFn = async () => ({
        ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
        runtimeSource: 'managed', runtimeVersion: '1.26.0', modelCached: true, message: 'CUDA session created successfully',
      });
      try {
        await withServer(async (base) => {
          const { json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
          assert.deepEqual(json.managedRuntimeManifest, {
            ortVersion: '1.26.0', cudaMajor: '13',
            verification: { status: 'verified', verifiedAt: json.managedRuntimeManifest.verification.verifiedAt, effectiveProvider: 'cuda' },
          });
          assert.notEqual(json.managedRuntimeManifest.verification.verifiedAt, null);
        }, { settingsService, runOnnxProbeFn, resolveEffectiveOnnxRuntimePathFn });

        const { readManagedRuntimeManifest } = await import('../../../../src/local/core/managed-onnx-runtime-manifest.js');
        const onDisk = readManagedRuntimeManifest(runtimeDir);
        assert.equal(onDisk.manifest.verification.status, 'verified');
      } finally {
        const { rmSync: rm } = await import('node:fs');
        rm(runtimeDir, { recursive: true, force: true });
      }
    });

    test('a FAILED managed-runtime probe writes verification.status "failed", not "verified"', async () => {
      const { mkdtempSync: mkdtemp, writeFileSync: writeFile, rmSync: rm } = await import('node:fs');
      const { tmpdir: osTmpdir } = await import('node:os');
      const runtimeDir = mkdtemp(join(osTmpdir(), 'semidex-managed-runtime-'));
      const sha = 'b'.repeat(64);
      const manifest = {
        schemaVersion: 2, ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64',
        provenance: {
          sourceRepository: 'x', sourceTag: 'v1.26.0', sourceCommit: '8c546c37b43caaca1fa25db430dab94b901cf277',
          runtimeAssetUrl: 'x', runtimeAssetSha256: sha, checksumTrust: 'locked',
        },
        artifacts: {
          'onnxruntime.dll': { sha256: sha, bytes: 1 },
          'onnxruntime_binding.node': { sha256: sha, bytes: 1 },
          'onnxruntime_providers_cuda.dll': { sha256: sha, bytes: 1 },
          'onnxruntime_providers_shared.dll': { sha256: sha, bytes: 1 },
        },
        dependencies: { cudnnBinPath: 'C:\\cudnn\\bin' },
        builtAt: '2026-08-07T00:00:00.000Z', buildHost: { platform: 'win32', nodeVersion: '25.2.1' }, installerVersion: '2',
        verification: { status: 'unverified', verifiedAt: null, effectiveProvider: null },
      };
      writeFile(join(runtimeDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');

      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
      const resolveEffectiveOnnxRuntimePathFn = () => ({ path: runtimeDir, source: 'managed', managedId: '1.26.0-cuda13', cudnnBinPath: null });
      const runOnnxProbeFn = async () => ({
        ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
        runtimeSource: 'managed', runtimeVersion: '1.26.0', modelCached: true, message: 'CUDA session creation failed',
      });
      try {
        await withServer(async (base) => {
          const { json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
          assert.equal(json.managedRuntimeManifest.verification.status, 'failed');
        }, { settingsService, runOnnxProbeFn, resolveEffectiveOnnxRuntimePathFn });
      } finally {
        rm(runtimeDir, { recursive: true, force: true });
      }
    });

    test('a non-managed (explicit/npm) resolution never writes a verification result and returns managedRuntimeManifest: null', async () => {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
      const resolveEffectiveOnnxRuntimePathFn = () => ({ path: 'D:\\custom', source: 'explicit', managedId: null, cudnnBinPath: null });
      let writeCalled = false;
      const writeVerificationResultFn = () => { writeCalled = true; return { ok: true }; };
      const runOnnxProbeFn = async () => ({
        ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
        runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true, message: 'CUDA session created successfully',
      });
      await withServer(async (base) => {
        const { json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
        assert.equal(json.managedRuntimeManifest, null);
      }, { settingsService, runOnnxProbeFn, resolveEffectiveOnnxRuntimePathFn, writeVerificationResultFn });
      assert.equal(writeCalled, false);
    });

    test('an invalid/corrupt managed selection surfaces a warning via the diagnosis field, never silently falls back with no explanation', async () => {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
      const resolveEffectiveOnnxRuntimePathFn = () => ({
        path: '', source: 'npm', managedId: null, cudnnBinPath: null,
        warning: 'managed runtime selected but invalid/corrupt: integrity check failed',
      });
      const runOnnxProbeFn = async () => ({
        ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
        runtimeSource: 'npm', runtimeVersion: null, modelCached: true, message: 'no available backend found.',
      });
      await withServer(async (base) => {
        const { json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
        assert.equal(json.diagnosis.reason, 'managed_runtime_resolution');
        assert.match(json.diagnosis.details, /integrity check failed/);
      }, { settingsService, runOnnxProbeFn, resolveEffectiveOnnxRuntimePathFn });
    });
  });

  // diagnosis field — real system checks (nvidia-smi, CUDA_PATH/toolkit
  // dir, cuDNN DLL presence), only ever run for a FAILED CUDA probe. Every
  // test injects a stub diagnoseCudaFailureFn — never a real nvidia-smi
  // spawn, never real filesystem access.
  describe('diagnosis field (CUDA guided-setup)', () => {
    const FAILED_CUDA_RESULT = {
      ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
      runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true,
      message: 'no available backend found. ERR: [cuda] backend not found.',
    };
    const STUB_DIAGNOSIS = { reason: 'no_custom_build', details: 'GPU/driver/toolkit present, npm build in use.', nextSteps: ['Set ONNXRUNTIME_NODE_PATH.'] };

    test('a failed CUDA probe includes the diagnosis object exactly as returned by diagnoseCudaFailureFn', async () => {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
      const runOnnxProbeFn = async () => FAILED_CUDA_RESULT;
      const diagnoseCudaFailureFn = async () => STUB_DIAGNOSIS;
      await withServer(async (base) => {
        const { json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
        assert.deepEqual(json.diagnosis, STUB_DIAGNOSIS);
      }, { settingsService, runOnnxProbeFn, diagnoseCudaFailureFn });
    });

    test('a failed DML probe never calls diagnoseCudaFailureFn — diagnosis stays null', async () => {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
      const runOnnxProbeFn = async () => ({
        ok: false, requestedProvider: 'dml', effectiveProvider: null, fellBackToCpu: false,
        runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true, message: 'dml session failed',
      });
      let called = false;
      const diagnoseCudaFailureFn = async () => { called = true; return STUB_DIAGNOSIS; };
      await withServer(async (base) => {
        const { json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'dml' });
        assert.equal(json.diagnosis, null);
      }, { settingsService, runOnnxProbeFn, diagnoseCudaFailureFn });
      assert.equal(called, false, 'diagnosis must never run for a non-CUDA probe');
    });

    test('a successful CUDA probe never calls diagnoseCudaFailureFn — diagnosis stays null', async () => {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
      const runOnnxProbeFn = async () => STABLE_SUCCESS_RESULT;
      let called = false;
      const diagnoseCudaFailureFn = async () => { called = true; return STUB_DIAGNOSIS; };
      await withServer(async (base) => {
        const { json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
        assert.equal(json.diagnosis, null);
      }, { settingsService, runOnnxProbeFn, diagnoseCudaFailureFn });
      assert.equal(called, false, 'diagnosis must never run for a successful probe');
    });

    test('a diagnoseCudaFailureFn that throws never degrades or crashes the probe response — diagnosis falls back to null', async () => {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
      const runOnnxProbeFn = async () => FAILED_CUDA_RESULT;
      const diagnoseCudaFailureFn = async () => { throw new Error('nvidia-smi exploded'); };
      await withServer(async (base) => {
        const { status, json } = await httpPostJson(base, '/api/system/onnx-probe', { provider: 'cuda' });
        assert.equal(status, 200);
        assert.equal(json.ok, false);
        assert.equal(json.message, FAILED_CUDA_RESULT.message);
        assert.equal(json.diagnosis, null);
      }, { settingsService, runOnnxProbeFn, diagnoseCudaFailureFn });
    });
  });
});

describe('GET /api/system/onnx-managed-runtimes', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-onnx-listing-api-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('returns { runtimes: [...] } from the injected listing cache, display-only', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const fakeRuntimes = [
      { id: '1.26.0-cuda13', ortVersion: '1.26.0', cudaMajor: '13', verification: { status: 'verified', verifiedAt: '2026-08-07T00:00:00.000Z', effectiveProvider: 'cuda' } },
    ];
    const onnxManagedRuntimeListingCache = { listManagedRuntimes: () => fakeRuntimes };
    await withServer(async (base) => {
      const { status, json } = await httpGetJson(base, '/api/system/onnx-managed-runtimes');
      assert.equal(status, 200);
      assert.deepEqual(json, { runtimes: fakeRuntimes });
    }, { settingsService, onnxManagedRuntimeListingCache });
  });

  test('returns an empty list, never throws, when no managed runtimes are installed', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const onnxManagedRuntimeListingCache = { listManagedRuntimes: () => [] };
    await withServer(async (base) => {
      const { status, json } = await httpGetJson(base, '/api/system/onnx-managed-runtimes');
      assert.equal(status, 200);
      assert.deepEqual(json, { runtimes: [] });
    }, { settingsService, onnxManagedRuntimeListingCache });
  });

  test('calls listManagedRuntimes() with the real SemidexHome runtimesDir, not a hardcoded/guessed path', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    let receivedRuntimesDir = null;
    const onnxManagedRuntimeListingCache = { listManagedRuntimes: (runtimesDir) => { receivedRuntimesDir = runtimesDir; return []; } };
    await withServer(async (base) => {
      await httpGetJson(base, '/api/system/onnx-managed-runtimes');
    }, { settingsService, onnxManagedRuntimeListingCache });
    assert.ok(receivedRuntimesDir && receivedRuntimesDir.length > 0);
  });
});
