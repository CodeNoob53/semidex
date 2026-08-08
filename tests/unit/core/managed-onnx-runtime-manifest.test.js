// src/local/core/managed-onnx-runtime-manifest.js — reader/validator/
// atomic writer for the manifest.json alongside a managed CUDA runtime.
// Every test injects fake fs functions — zero real filesystem access,
// zero real I/O anywhere in this file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MANAGED_NATIVE_RELATIVE_DIR,
  MANIFEST_SCHEMA_VERSION,
  readManagedRuntimeManifest,
  isManifestWellFormed,
  verifyManagedRuntimeOnDisk,
  computeManifestIdentityFingerprint,
  writeVerificationResult,
} from '../../../src/local/core/managed-onnx-runtime-manifest.js';

const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const SHA256_C = 'c'.repeat(64);
const SHA256_D = 'd'.repeat(64);
const COMMIT = '8c546c37b43caaca1fa25db430dab94b901cf277';

function makeValidManifest(overrides = {}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    ortVersion: '1.26.0',
    cudaMajor: '13',
    platform: 'win32',
    arch: 'x64',
    provenance: {
      sourceRepository: 'https://github.com/microsoft/onnxruntime.git',
      sourceTag: 'v1.26.0',
      sourceCommit: COMMIT,
      runtimeAssetUrl: 'https://github.com/microsoft/onnxruntime/releases/download/v1.26.0/onnxruntime-win-x64-gpu_cuda13-1.26.0.zip',
      runtimeAssetSha256: SHA256_A,
      checksumTrust: 'locked',
    },
    artifacts: {
      'onnxruntime.dll': { sha256: SHA256_A, bytes: 15336248 },
      'onnxruntime_binding.node': { sha256: SHA256_B, bytes: 144896 },
      'onnxruntime_providers_cuda.dll': { sha256: SHA256_C, bytes: 229324600 },
      'onnxruntime_providers_shared.dll': { sha256: SHA256_D, bytes: 21816 },
    },
    dependencies: {
      cudnnBinPath: 'C:\\Program Files\\NVIDIA\\CUDNN\\v9.25\\bin\\13.4\\x64',
    },
    builtAt: '2026-08-06T00:00:00.000Z',
    buildHost: { platform: 'win32', nodeVersion: '25.2.1' },
    installerVersion: '2',
    verification: { status: 'unverified', verifiedAt: null, effectiveProvider: null },
    ...overrides,
  };
}

describe('isManifestWellFormed()', () => {
  it('accepts a fully valid manifest', () => {
    assert.equal(isManifestWellFormed(makeValidManifest()), true);
  });

  it('rejects non-object input', () => {
    assert.equal(isManifestWellFormed(null), false);
    assert.equal(isManifestWellFormed('a string'), false);
    assert.equal(isManifestWellFormed(42), false);
  });

  it('rejects a wrong schemaVersion', () => {
    assert.equal(isManifestWellFormed(makeValidManifest({ schemaVersion: 1 })), false);
  });

  it('rejects a missing/invalid sourceCommit (not 40 hex chars)', () => {
    const m = makeValidManifest();
    m.provenance = { ...m.provenance, sourceCommit: 'not-a-commit' };
    assert.equal(isManifestWellFormed(m), false);
  });

  it('rejects a missing artifact entry', () => {
    const m = makeValidManifest();
    delete m.artifacts['onnxruntime.dll'];
    assert.equal(isManifestWellFormed(m), false);
  });

  it('rejects an artifact with a malformed sha256', () => {
    const m = makeValidManifest();
    m.artifacts['onnxruntime.dll'] = { sha256: 'too-short', bytes: 100 };
    assert.equal(isManifestWellFormed(m), false);
  });

  it('rejects a missing dependencies.cudnnBinPath', () => {
    const m = makeValidManifest();
    delete m.dependencies;
    assert.equal(isManifestWellFormed(m), false);
  });

  it('rejects an empty dependencies.cudnnBinPath', () => {
    const m = makeValidManifest();
    m.dependencies = { cudnnBinPath: '' };
    assert.equal(isManifestWellFormed(m), false);
  });

  it('rejects an invalid verification.status', () => {
    const m = makeValidManifest();
    m.verification = { status: 'bogus', verifiedAt: null, effectiveProvider: null };
    assert.equal(isManifestWellFormed(m), false);
  });

  it('accepts all three valid verification statuses', () => {
    for (const status of ['unverified', 'verified', 'failed']) {
      assert.equal(isManifestWellFormed(makeValidManifest({ verification: { status, verifiedAt: null, effectiveProvider: null } })), true);
    }
  });
});

describe('readManagedRuntimeManifest()', () => {
  it('reports not_found when the manifest file does not exist', () => {
    const result = readManagedRuntimeManifest('/fake/dir', { existsSyncFn: () => false });
    assert.deepEqual(result, { ok: false, reason: 'not_found' });
  });

  it('reports corrupt for invalid JSON', () => {
    const result = readManagedRuntimeManifest('/fake/dir', {
      existsSyncFn: () => true,
      readFileSyncFn: () => '{not valid json',
    });
    assert.deepEqual(result, { ok: false, reason: 'corrupt' });
  });

  it('reports schema_mismatch for well-formed JSON that fails isManifestWellFormed', () => {
    const result = readManagedRuntimeManifest('/fake/dir', {
      existsSyncFn: () => true,
      readFileSyncFn: () => JSON.stringify({ schemaVersion: 1 }),
    });
    assert.deepEqual(result, { ok: false, reason: 'schema_mismatch' });
  });

  it('returns ok:true with the parsed manifest for a valid file', () => {
    const manifest = makeValidManifest();
    const result = readManagedRuntimeManifest('/fake/dir', {
      existsSyncFn: () => true,
      readFileSyncFn: () => JSON.stringify(manifest),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.manifest, manifest);
  });

  it('accepts a valid manifest prefixed with a UTF-8 BOM', () => {
    const manifest = makeValidManifest();
    const result = readManagedRuntimeManifest('/fake/dir', {
      existsSyncFn: () => true,
      readFileSyncFn: () => `\uFEFF${JSON.stringify(manifest)}`,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.manifest, manifest);
  });
});

describe('verifyManagedRuntimeOnDisk()', () => {
  function fakeFileBuffer(content) {
    return Buffer.from(content, 'utf-8');
  }

  it('reports ok:true when every artifact\'s recomputed hash matches the manifest', () => {
    // Build a manifest whose sha256 values genuinely match fake file contents.
    const contents = {
      'onnxruntime.dll': 'content-A',
      'onnxruntime_binding.node': 'content-B',
      'onnxruntime_providers_cuda.dll': 'content-C',
      'onnxruntime_providers_shared.dll': 'content-D',
    };
    const manifest = makeValidManifest();
    for (const [name, content] of Object.entries(contents)) {
      manifest.artifacts[name] = {
        sha256: createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex'),
        bytes: content.length,
      };
    }
    const result = verifyManagedRuntimeOnDisk('/fake/dir', manifest, {
      existsSyncFn: () => true,
      readFileSyncFn: (p) => fakeFileBuffer(contents[p.split(/[\\/]/).pop()]),
    });
    assert.deepEqual(result, { ok: true });
  });

  it('verifies artifacts at the canonical onnxruntime-node native package path', () => {
    const seen = [];
    const manifest = makeValidManifest();
    verifyManagedRuntimeOnDisk('/managed/runtime', manifest, {
      existsSyncFn: (p) => { seen.push(p); return false; },
      readFileSyncFn: () => { throw new Error('should not read missing files'); },
    });
    assert.equal(seen.length, 4);
    assert.ok(seen.every((p) => p.replaceAll('\\', '/').includes(`/${MANAGED_NATIVE_RELATIVE_DIR}/`)));
  });

  it('explicit case: well-formed manifest + corrupted artifact bytes still fails integrity', () => {
    const manifest = makeValidManifest(); // has fixed, non-matching sha256 placeholders
    const result = verifyManagedRuntimeOnDisk('/fake/dir', manifest, {
      existsSyncFn: () => true,
      readFileSyncFn: () => Buffer.from('genuinely different bytes', 'utf-8'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.mismatches.length, 4);
    assert.ok(result.mismatches.every((m) => m.reason === 'checksum_mismatch'));
  });

  it('reports file_missing when an artifact does not exist on disk', () => {
    const manifest = makeValidManifest();
    const result = verifyManagedRuntimeOnDisk('/fake/dir', manifest, {
      existsSyncFn: () => false,
      readFileSyncFn: () => { throw new Error('should not be called'); },
    });
    assert.equal(result.ok, false);
    assert.ok(result.mismatches.every((m) => m.reason === 'file_missing'));
  });
});

describe('computeManifestIdentityFingerprint()', () => {
  it('is deterministic — same immutable fields produce the same fingerprint', () => {
    const a = computeManifestIdentityFingerprint(makeValidManifest());
    const b = computeManifestIdentityFingerprint(makeValidManifest());
    assert.equal(a, b);
  });

  it('is unaffected by the mutable verification block\'s contents', () => {
    const a = computeManifestIdentityFingerprint(makeValidManifest({ verification: { status: 'unverified', verifiedAt: null, effectiveProvider: null } }));
    const b = computeManifestIdentityFingerprint(makeValidManifest({ verification: { status: 'verified', verifiedAt: '2026-01-01T00:00:00.000Z', effectiveProvider: 'cuda' } }));
    assert.equal(a, b);
  });

  it('changes when an artifacts entry changes', () => {
    const a = computeManifestIdentityFingerprint(makeValidManifest());
    const m = makeValidManifest();
    m.artifacts['onnxruntime.dll'] = { sha256: 'f'.repeat(64), bytes: 999 };
    const b = computeManifestIdentityFingerprint(m);
    assert.notEqual(a, b);
  });

  it('changes when dependencies.cudnnBinPath changes', () => {
    const a = computeManifestIdentityFingerprint(makeValidManifest());
    const m = makeValidManifest();
    m.dependencies = { cudnnBinPath: 'C:\\different\\path' };
    const b = computeManifestIdentityFingerprint(m);
    assert.notEqual(a, b);
  });
});

describe('writeVerificationResult()', () => {
  it('atomically writes: temp file created, then renamed over manifest.json, exactly once', () => {
    const manifest = makeValidManifest();
    const fingerprint = computeManifestIdentityFingerprint(manifest);
    const writeCalls = [];
    const renameCalls = [];
    const result = writeVerificationResult(
      '/fake/dir',
      { status: 'verified', effectiveProvider: 'cuda', expectedManifestFingerprint: fingerprint },
      {
        existsSyncFn: () => true,
        readFileSyncFn: () => JSON.stringify(manifest),
        writeFileSyncFn: (p, content) => writeCalls.push({ path: p, content }),
        renameSyncFn: (from, to) => renameCalls.push({ from, to }),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(writeCalls.length, 1);
    assert.match(writeCalls[0].path, /manifest\.json\.tmp-/);
    assert.equal(renameCalls.length, 1);
    assert.equal(renameCalls[0].from, writeCalls[0].path);
    assert.match(renameCalls[0].to, /manifest\.json$/);
    assert.equal(result.manifest.verification.status, 'verified');
    assert.equal(result.manifest.verification.effectiveProvider, 'cuda');
    assert.ok(result.manifest.verification.verifiedAt);
  });

  it('stamps verifiedAt = null for status unverified', () => {
    const manifest = makeValidManifest();
    const fingerprint = computeManifestIdentityFingerprint(manifest);
    const result = writeVerificationResult(
      '/fake/dir',
      { status: 'unverified', effectiveProvider: null, expectedManifestFingerprint: fingerprint },
      { existsSyncFn: () => true, readFileSyncFn: () => JSON.stringify(manifest), writeFileSyncFn: () => {}, renameSyncFn: () => {} },
    );
    assert.equal(result.manifest.verification.verifiedAt, null);
  });

  it('never touches artifacts/provenance/dependencies — only the verification block changes', () => {
    const manifest = makeValidManifest();
    const fingerprint = computeManifestIdentityFingerprint(manifest);
    const result = writeVerificationResult(
      '/fake/dir',
      { status: 'failed', effectiveProvider: null, expectedManifestFingerprint: fingerprint },
      { existsSyncFn: () => true, readFileSyncFn: () => JSON.stringify(manifest), writeFileSyncFn: () => {}, renameSyncFn: () => {} },
    );
    assert.deepEqual(result.manifest.artifacts, manifest.artifacts);
    assert.deepEqual(result.manifest.provenance, manifest.provenance);
    assert.deepEqual(result.manifest.dependencies, manifest.dependencies);
  });

  it('concurrent-modification guard: a fingerprint mismatch aborts the write, writes nothing', () => {
    const manifest = makeValidManifest();
    const writeCalls = [];
    const result = writeVerificationResult(
      '/fake/dir',
      { status: 'verified', effectiveProvider: 'cuda', expectedManifestFingerprint: 'stale-fingerprint-from-before-a-reinstall' },
      {
        existsSyncFn: () => true,
        readFileSyncFn: () => JSON.stringify(manifest), // the CURRENT on-disk manifest has a different real fingerprint
        writeFileSyncFn: (p, c) => writeCalls.push({ p, c }),
        renameSyncFn: () => { throw new Error('must not be called'); },
      },
    );
    assert.deepEqual(result, { ok: false, reason: 'manifest_changed_concurrently' });
    assert.equal(writeCalls.length, 0);
  });

  it('a matching fingerprint proceeds and writes normally', () => {
    const manifest = makeValidManifest();
    const fingerprint = computeManifestIdentityFingerprint(manifest);
    const result = writeVerificationResult(
      '/fake/dir',
      { status: 'verified', effectiveProvider: 'cuda', expectedManifestFingerprint: fingerprint },
      { existsSyncFn: () => true, readFileSyncFn: () => JSON.stringify(manifest), writeFileSyncFn: () => {}, renameSyncFn: () => {} },
    );
    assert.equal(result.ok, true);
  });

  it('propagates a not_found/corrupt read failure without attempting a write', () => {
    const writeCalls = [];
    const result = writeVerificationResult(
      '/fake/dir',
      { status: 'verified', effectiveProvider: 'cuda', expectedManifestFingerprint: 'anything' },
      { existsSyncFn: () => false, readFileSyncFn: () => { throw new Error('should not be called'); }, writeFileSyncFn: (p, c) => writeCalls.push({ p, c }), renameSyncFn: () => {} },
    );
    assert.deepEqual(result, { ok: false, reason: 'not_found' });
    assert.equal(writeCalls.length, 0);
  });
});
