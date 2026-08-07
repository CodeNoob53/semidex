// src/local/core/onnx-cuda-installer-verify.js — the installer's
// end-of-run verification step: read manifest -> fingerprint -> prepare
// PATH -> real probe (injected fake) -> write verification result back,
// atomically, with the concurrent-modification guard intact. Every test
// injects fake fs/probe functions — zero real filesystem/subprocess
// access anywhere in this file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MANIFEST_SCHEMA_VERSION } from '../../../../src/local/core/managed-onnx-runtime-manifest.js';
import { runInstallerVerification } from '../../../../src/local/core/onnx-cuda-installer-verify.js';

const RUNTIME_DIR = 'C:\\fake\\runtimes\\onnxruntime-node-cuda\\1.26.0-cuda13';
const CUDNN_BIN = 'C:\\Program Files\\NVIDIA\\CUDNN\\v9.25\\bin\\13.4\\x64';
const SHA = 'a'.repeat(64);
const COMMIT = '8c546c37b43caaca1fa25db430dab94b901cf277';

function makeManifest() {
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
  };
}

function makeFakeFs({ manifest, cudnnDllPresent = true }) {
  const manifestPath = `${RUNTIME_DIR}\\manifest.json`;
  const files = new Map([[manifestPath, JSON.stringify(manifest)]]);
  const writes = [];
  const renames = [];
  return {
    readFileSyncFn: (p, enc) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return enc === 'utf-8' ? files.get(p) : Buffer.from(files.get(p));
    },
    existsSyncFn: (p) => p === manifestPath || p === CUDNN_BIN,
    readdirSyncFn: (p) => (p === CUDNN_BIN ? (cudnnDllPresent ? ['cudnn64_9.dll'] : []) : []),
    writeFileSyncFn: (p, content) => { files.set(p, content); writes.push(p); },
    renameSyncFn: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
      renames.push([from, to]);
    },
    files, writes, renames,
  };
}

describe('runInstallerVerification()', () => {
  it('a successful CUDA probe writes verification.status "verified" with the real effectiveProvider', async () => {
    const manifest = makeManifest();
    const fs = makeFakeFs({ manifest });
    const env = { PATH: 'C:\\Windows\\System32' };
    const probeOnnxProviderFn = async (provider, opts) => {
      assert.equal(provider, 'cuda');
      assert.equal(opts.env.ONNXRUNTIME_NODE_PATH, RUNTIME_DIR);
      assert.equal(opts.env.ONNX_MANAGED_RUNTIME_ACTIVE, '1.26.0-cuda13');
      return { ok: true, effectiveProvider: 'cuda', message: 'CUDA session created successfully' };
    };
    const result = await runInstallerVerification({ runtimeDir: RUNTIME_DIR }, { ...fs, probeOnnxProviderFn, env });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'verified');
    assert.equal(result.effectiveProvider, 'cuda');
    assert.equal(env.PATH.includes(CUDNN_BIN), true);

    const [renameFrom, renameTo] = fs.renames.at(-1);
    assert.match(renameFrom, /manifest\.json\.tmp-/);
    assert.equal(renameTo, `${RUNTIME_DIR}\\manifest.json`);
    const written = JSON.parse(fs.files.get(`${RUNTIME_DIR}\\manifest.json`));
    assert.equal(written.verification.status, 'verified');
    assert.equal(written.verification.effectiveProvider, 'cuda');
    assert.notEqual(written.verification.verifiedAt, null);
  });

  it('a failed CUDA probe writes verification.status "failed", ok:false — probe ran, but CUDA did not work', async () => {
    const manifest = makeManifest();
    const fs = makeFakeFs({ manifest });
    const probeOnnxProviderFn = async () => ({ ok: false, effectiveProvider: null, message: 'CUDA session creation failed' });
    const result = await runInstallerVerification({ runtimeDir: RUNTIME_DIR }, { ...fs, probeOnnxProviderFn, env: { PATH: '' } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    const written = JSON.parse(fs.files.get(`${RUNTIME_DIR}\\manifest.json`));
    assert.equal(written.verification.status, 'failed');
  });

  it('never silently fallback: a vanished cuDNN directory aborts BEFORE the probe ever runs, with a clear reason', async () => {
    const manifest = makeManifest();
    const fs = makeFakeFs({ manifest });
    fs.existsSyncFn = (p) => p === `${RUNTIME_DIR}\\manifest.json`; // cuDNN dir now missing
    let probeCalled = false;
    const probeOnnxProviderFn = async () => { probeCalled = true; return { ok: true, effectiveProvider: 'cuda', message: 'x' }; };
    const result = await runInstallerVerification({ runtimeDir: RUNTIME_DIR }, { ...fs, probeOnnxProviderFn, env: { PATH: '' } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /cuDNN PATH preparation failed/);
    assert.equal(probeCalled, false);
  });

  it('a missing manifest aborts with a clear reason, never attempts a probe', async () => {
    let probeCalled = false;
    const probeOnnxProviderFn = async () => { probeCalled = true; return { ok: true, effectiveProvider: 'cuda', message: 'x' }; };
    const result = await runInstallerVerification({ runtimeDir: RUNTIME_DIR }, {
      readFileSyncFn: () => { throw new Error('ENOENT'); },
      existsSyncFn: () => false,
      probeOnnxProviderFn,
      env: { PATH: '' },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /cannot read manifest/);
    assert.equal(probeCalled, false);
  });

  it('a manifest that changed concurrently (fingerprint mismatch) between fingerprinting and the write-back aborts, never overwrites', async () => {
    const manifest = makeManifest();
    const fs = makeFakeFs({ manifest });
    // Simulate a concurrent reinstall mutating the on-disk manifest's
    // identity (a different artifact hash) AFTER this function already
    // read+fingerprinted it, but before writeVerificationResult()'s own
    // re-read — achieved by swapping the manifest content out from under
    // readFileSyncFn on the SECOND call (writeVerificationResult() reads
    // the manifest a second time internally).
    let readCount = 0;
    const originalRead = fs.readFileSyncFn;
    fs.readFileSyncFn = (p, enc) => {
      if (p.endsWith('manifest.json') && !p.includes('.tmp-')) {
        readCount += 1;
        if (readCount === 2) {
          const mutated = { ...manifest, artifacts: { ...manifest.artifacts, 'onnxruntime.dll': { sha256: 'b'.repeat(64), bytes: 999 } } };
          return JSON.stringify(mutated);
        }
      }
      return originalRead(p, enc);
    };
    const probeOnnxProviderFn = async () => ({ ok: true, effectiveProvider: 'cuda', message: 'x' });
    const result = await runInstallerVerification({ runtimeDir: RUNTIME_DIR }, { ...fs, probeOnnxProviderFn, env: { PATH: '' } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /manifest_changed_concurrently/);
  });
});
