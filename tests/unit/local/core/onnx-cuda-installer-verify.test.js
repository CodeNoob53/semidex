// src/local/core/onnx-cuda-installer-verify.js — the installer's
// end-of-run verification step: read manifest -> fingerprint -> prepare
// PATH -> real probe (injected fake) -> write verification result back,
// atomically, with the concurrent-modification guard intact.
//
// Code review correction: an earlier version of this file used a fake,
// in-memory fs keyed by hardcoded 'C:\...' string literals — but
// managed-onnx-runtime-manifest.js (the module runInstallerVerification()
// delegates read/write to) uses OS-native node:path.join() on dirPath,
// since dirPath is always a REAL, already-OS-native path in production
// (resolved by semidex-home.js's resolveSemidexHomePaths({ platform:
// process.platform })). On Linux CI, OS-native join() is posix.join(),
// which never matches a literal 'C:\...\manifest.json' Map key built with
// a hardcoded backslash — every read/write silently missed the fake
// "file." Fixed by using a REAL temp directory (mkdtempSync) and REAL
// fs read/write for the manifest, exactly like tests/unit/admin/api/
// onnx.test.js's own real-manifest-on-disk tests. Only ONNXRUNTIME_NODE_PATH/
// env.PATH and the cuDNN bin directory below stay Windows-shaped literals
// on purpose — those are the actual subject under test here (this
// installer only ever targets Windows CUDA runtimes), never a proxy for
// "where does this test happen to run."
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync as realExistsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_SCHEMA_VERSION, MANAGED_NATIVE_RELATIVE_DIR } from '../../../../src/local/core/managed-onnx-runtime-manifest.js';
import { runInstallerVerification } from '../../../../src/local/core/onnx-cuda-installer-verify.js';

// cuDNN bin path stays a Windows-literal on purpose (see header comment) —
// it is passed straight through to env.PATH, never touched by node:path
// join() at all, so it is not sensitive to host OS path semantics; it IS
// the actual subject of the "cuDNN PATH preparation" tests below.
const CUDNN_BIN = 'C:\\Program Files\\NVIDIA\\CUDNN\\v9.25\\bin\\13.4\\x64';
const SHA = 'a'.repeat(64);
const COMMIT = '8c546c37b43caaca1fa25db430dab94b901cf277';

function makeManifest(overrides = {}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64',
    provenance: {
      sourceRepository: 'https://github.com/microsoft/onnxruntime.git', sourceTag: 'v1.26.0', sourceCommit: COMMIT,
      runtimeAssetUrl: 'https://example.com/x.zip', runtimeAssetSha256: SHA, checksumTrust: 'locked',
    },
    artifacts: {
      'onnxruntime.dll': { sha256: SHA, bytes: 100 },
      'onnxruntime_binding.node': { sha256: SHA, bytes: 100 },
      'onnxruntime_providers_cuda.dll': { sha256: SHA, bytes: 100 },
      'onnxruntime_providers_shared.dll': { sha256: SHA, bytes: 100 },
    },
    dependencies: { cudnnBinPath: CUDNN_BIN },
    builtAt: '2026-08-07T00:00:00.000Z',
    buildHost: { platform: 'win32', nodeVersion: '25.2.1' },
    installerVersion: '2',
    verification: { status: 'unverified', verifiedAt: null, effectiveProvider: null },
    ...overrides,
  };
}

// Builds a REAL temp directory shaped like a managed runtime's own
// versioned directory (manifest.json at its root — the manifest read/
// write path is what managed-onnx-runtime-manifest.js's OS-native
// join() actually touches, and the whole reason this rewrite exists).
// The cuDNN bin directory (CUDNN_BIN, a real 'C:\Program Files\...'
// literal — see its own header comment) is deliberately NEVER created on
// real disk: on a genuine Windows host that path requires admin rights
// to write to (and this repo's own dev machine may already have a REAL
// NVIDIA cuDNN install living there — writing into it would be actively
// dangerous), and on any other host it means nothing at all.
//
// runInstallerVerification() threads the SAME existsSyncFn/readdirSyncFn
// into BOTH the manifest read/write path and the cuDNN check (it has no
// separate parameter for each) — so this fixture returns one COMPOSITE
// existsSyncFn/readdirSyncFn: real fs delegation for any path actually
// inside runtimeDir (the manifest), fake, in-memory answers for
// CUDNN_BIN specifically — cudnnDllPresent: false simulates BOTH "the
// directory itself vanished" (existsSyncFn) and "it exists but has no
// DLL in it" would be a separate, distinguishable case if a test needed
// it; every current test only needs the coarser "vanished entirely"
// shape, matching prepareOnnxRuntimeProcessEnv()'s own first check.
// Returns { runtimeDir, existsSyncFn, readdirSyncFn, cleanup() }.
function makeRealRuntimeFixture({ manifest, cudnnDllPresent = true } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'semidex-cuda-installer-verify-'));
  writeFileSync(join(runtimeDir, 'manifest.json'), JSON.stringify(manifest ?? makeManifest()), 'utf-8');
  return {
    runtimeDir,
    existsSyncFn: (p) => (p === CUDNN_BIN ? cudnnDllPresent : realExistsSync(p)),
    readdirSyncFn: (p) => (p === CUDNN_BIN ? (cudnnDllPresent ? ['cudnn64_9.dll'] : []) : []),
    cleanup() {
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

describe('runInstallerVerification()', () => {
  it('a successful CUDA probe writes verification.status "verified" with the real effectiveProvider', async () => {
    const manifest = makeManifest();
    const { runtimeDir, existsSyncFn, readdirSyncFn, cleanup } = makeRealRuntimeFixture({ manifest });
    try {
      const env = { PATH: 'C:\\Windows\\System32' };
      const probeOnnxProviderFn = async (provider, opts) => {
        assert.equal(provider, 'cuda');
        assert.equal(opts.env.ONNXRUNTIME_NODE_PATH, runtimeDir);
        assert.equal(opts.env.ONNX_MANAGED_RUNTIME_ACTIVE, '1.26.0-cuda13');
        return { ok: true, effectiveProvider: 'cuda', message: 'CUDA session created successfully' };
      };
      const result = await runInstallerVerification({ runtimeDir }, { probeOnnxProviderFn, env, existsSyncFn, readdirSyncFn });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'verified');
      assert.equal(result.effectiveProvider, 'cuda');
      assert.equal(env.PATH.includes(CUDNN_BIN), true);

      const written = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf-8'));
      assert.equal(written.verification.status, 'verified');
      assert.equal(written.verification.effectiveProvider, 'cuda');
      assert.notEqual(written.verification.verifiedAt, null);
    } finally {
      cleanup();
    }
  });

  it('a failed CUDA probe writes verification.status "failed", ok:false — probe ran, but CUDA did not work', async () => {
    const manifest = makeManifest();
    const { runtimeDir, existsSyncFn, readdirSyncFn, cleanup } = makeRealRuntimeFixture({ manifest });
    try {
      const probeOnnxProviderFn = async () => ({ ok: false, effectiveProvider: null, message: 'CUDA session creation failed' });
      const result = await runInstallerVerification({ runtimeDir }, { probeOnnxProviderFn, env: { PATH: '' }, existsSyncFn, readdirSyncFn });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      const written = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf-8'));
      assert.equal(written.verification.status, 'failed');
    } finally {
      cleanup();
    }
  });

  it('never silently fallback: a vanished cuDNN directory aborts BEFORE the probe ever runs, with a clear reason', async () => {
    const manifest = makeManifest();
    // cudnnDllPresent: false — the manifest still RECORDS a cudnnBinPath,
    // but that directory genuinely does not exist on disk this time.
    const { runtimeDir, existsSyncFn, readdirSyncFn, cleanup } = makeRealRuntimeFixture({ manifest, cudnnDllPresent: false });
    try {
      let probeCalled = false;
      const probeOnnxProviderFn = async () => { probeCalled = true; return { ok: true, effectiveProvider: 'cuda', message: 'x' }; };
      const result = await runInstallerVerification({ runtimeDir }, { probeOnnxProviderFn, env: { PATH: '' }, existsSyncFn, readdirSyncFn });
      assert.equal(result.ok, false);
      assert.match(result.reason, /cuDNN PATH preparation failed/);
      assert.equal(probeCalled, false);
    } finally {
      cleanup();
    }
  });

  it('a missing manifest aborts with a clear reason, never attempts a probe', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'semidex-cuda-installer-verify-'));
    try {
      let probeCalled = false;
      const probeOnnxProviderFn = async () => { probeCalled = true; return { ok: true, effectiveProvider: 'cuda', message: 'x' }; };
      // No manifest.json written into this real, empty directory.
      const result = await runInstallerVerification({ runtimeDir }, { probeOnnxProviderFn, env: { PATH: '' } });
      assert.equal(result.ok, false);
      assert.match(result.reason, /cannot read manifest/);
      assert.equal(probeCalled, false);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('a manifest that changed concurrently (fingerprint mismatch) between fingerprinting and the write-back aborts, never overwrites', async () => {
    const manifest = makeManifest();
    const { runtimeDir, existsSyncFn, readdirSyncFn, cleanup } = makeRealRuntimeFixture({ manifest });
    try {
      // Simulate a concurrent reinstall mutating the on-disk manifest's
      // identity (a different artifact hash) AFTER this function already
      // read+fingerprinted it, but before writeVerificationResult()'s own
      // re-read — achieved by rewriting the REAL file on disk from inside
      // the injected probeOnnxProviderFn, which runs strictly between
      // runInstallerVerification()'s own fingerprint read and its
      // write-back re-read.
      const probeOnnxProviderFn = async () => {
        const mutated = { ...manifest, artifacts: { ...manifest.artifacts, 'onnxruntime.dll': { sha256: 'b'.repeat(64), bytes: 999 } } };
        writeFileSync(join(runtimeDir, 'manifest.json'), JSON.stringify(mutated), 'utf-8');
        return { ok: true, effectiveProvider: 'cuda', message: 'x' };
      };
      const result = await runInstallerVerification({ runtimeDir }, { probeOnnxProviderFn, env: { PATH: '' }, existsSyncFn, readdirSyncFn });
      assert.equal(result.ok, false);
      assert.match(result.reason, /manifest_changed_concurrently/);
    } finally {
      cleanup();
    }
  });
});
