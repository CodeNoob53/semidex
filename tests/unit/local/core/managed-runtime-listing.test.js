// src/local/core/managed-runtime-listing.js — the DISPLAY-ONLY listing
// cache for the Settings UI's managed-runtime dropdown. Every test
// injects fake fs functions — zero real filesystem access. Explicitly
// proves: (1) a valid/intact runtime is listed, (2) a corrupt/invalid one
// is silently excluded, (3) the fingerprint cache avoids re-verification
// when nothing changed, (4) a changed fingerprint forces re-verification,
// (5) an unconditional TTL forces re-verification even with an UNCHANGED
// fingerprint (the actual mitigation for the same-size-same-mtime-
// different-bytes gap a fingerprint alone cannot catch).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MANIFEST_SCHEMA_VERSION } from '../../../../src/local/core/managed-onnx-runtime-manifest.js';
import { createManagedRuntimeListingCache } from '../../../../src/local/core/managed-runtime-listing.js';

const RUNTIMES_DIR = 'C:\\fake\\semidex\\runtimes';
const RUNTIME_ID = '1.26.0-cuda13';
const RUNTIME_DIR = `${RUNTIMES_DIR}\\onnxruntime-node-cuda\\${RUNTIME_ID}`;
const COMMIT = '8c546c37b43caaca1fa25db430dab94b901cf277';

function makeManifest(overrides = {}) {
  const buffers = {};
  const artifacts = {};
  for (const name of ['onnxruntime.dll', 'onnxruntime_binding.node', 'onnxruntime_providers_cuda.dll', 'onnxruntime_providers_shared.dll']) {
    const buf = Buffer.from(`content-of-${name}`);
    buffers[name] = buf;
    artifacts[name] = { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  }
  return {
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64',
      provenance: {
        sourceRepository: 'https://github.com/microsoft/onnxruntime.git', sourceTag: 'v1.26.0', sourceCommit: COMMIT,
        runtimeAssetUrl: 'https://example.com/x.zip', runtimeAssetSha256: artifacts['onnxruntime.dll'].sha256, checksumTrust: 'locked',
      },
      artifacts,
      dependencies: { cudnnBinPath: 'C:\\cudnn\\bin' },
      builtAt: '2026-08-07T00:00:00.000Z',
      buildHost: { platform: 'win32', nodeVersion: '25.2.1' },
      installerVersion: '2',
      verification: { status: 'verified', verifiedAt: '2026-08-07T00:05:00.000Z', effectiveProvider: 'cuda' },
      ...overrides,
    },
    buffers,
  };
}

function makeFakeFs({ runtimeDirs }) {
  // runtimeDirs: { [runtimeId]: { manifest, buffers } | null (dir exists but no valid manifest) }
  const files = new Map();
  const stats = new Map();
  let time = 1_000_000;
  for (const [id, data] of Object.entries(runtimeDirs)) {
    const dir = `${RUNTIMES_DIR}\\onnxruntime-node-cuda\\${id}`;
    if (!data) continue;
    const manifestPath = `${dir}\\manifest.json`;
    const manifestJson = JSON.stringify(data.manifest);
    files.set(manifestPath, manifestJson);
    stats.set(manifestPath, { size: manifestJson.length, mtimeMs: time });
    for (const [name, buf] of Object.entries(data.buffers)) {
      const p = `${dir}\\${name}`;
      files.set(p, buf);
      stats.set(p, { size: buf.length, mtimeMs: time });
    }
  }
  const onnxRuntimeCudaDir = `${RUNTIMES_DIR}\\onnxruntime-node-cuda`;
  return {
    readdirSyncFn: () => Object.keys(runtimeDirs),
    existsSyncFn: (p) => p === onnxRuntimeCudaDir || files.has(p),
    statSyncFn: (p) => stats.get(p),
    readFileSyncFn: (p, enc) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return enc === 'utf-8' && Buffer.isBuffer(v) ? v.toString('utf-8') : v;
    },
    files, stats,
    touch: (p, newTime) => { const s = stats.get(p); if (s) stats.set(p, { ...s, mtimeMs: newTime }); },
  };
}

describe('createManagedRuntimeListingCache().listManagedRuntimes()', () => {
  it('lists a valid, intact managed runtime', () => {
    const { manifest, buffers } = makeManifest();
    const fs = makeFakeFs({ runtimeDirs: { [RUNTIME_ID]: { manifest, buffers } } });
    const { listManagedRuntimes } = createManagedRuntimeListingCache();
    const result = listManagedRuntimes(RUNTIMES_DIR, fs);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, RUNTIME_ID);
    assert.equal(result[0].ortVersion, '1.26.0');
    assert.equal(result[0].verification.status, 'verified');
  });

  it('excludes a directory whose id does not match the validated managed-runtime-id format', () => {
    const { manifest, buffers } = makeManifest();
    const fs = makeFakeFs({ runtimeDirs: { 'not-a-valid-id': { manifest, buffers }, [RUNTIME_ID]: { manifest, buffers } } });
    const { listManagedRuntimes } = createManagedRuntimeListingCache();
    const result = listManagedRuntimes(RUNTIMES_DIR, fs);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, RUNTIME_ID);
  });

  it('excludes a directory with no manifest at all', () => {
    const fs = makeFakeFs({ runtimeDirs: { [RUNTIME_ID]: null } });
    const { listManagedRuntimes } = createManagedRuntimeListingCache();
    const result = listManagedRuntimes(RUNTIMES_DIR, fs);
    assert.deepEqual(result, []);
  });

  it('excludes a runtime whose manifest is not well-formed (silently, not as a broken choice)', () => {
    const { manifest, buffers } = makeManifest({ dependencies: undefined });
    const fs = makeFakeFs({ runtimeDirs: { [RUNTIME_ID]: { manifest, buffers } } });
    const { listManagedRuntimes } = createManagedRuntimeListingCache();
    const result = listManagedRuntimes(RUNTIMES_DIR, fs);
    assert.deepEqual(result, []);
  });

  it('excludes a runtime that fails the on-disk integrity check (well-formed manifest, corrupted artifact bytes)', () => {
    const { manifest, buffers } = makeManifest();
    const corruptedBuffers = { ...buffers, 'onnxruntime.dll': Buffer.from('corrupted') };
    const fs = makeFakeFs({ runtimeDirs: { [RUNTIME_ID]: { manifest, buffers: corruptedBuffers } } });
    const { listManagedRuntimes } = createManagedRuntimeListingCache();
    const result = listManagedRuntimes(RUNTIMES_DIR, fs);
    assert.deepEqual(result, []);
  });

  it('a non-existent onnxruntime-node-cuda directory returns an empty list, never throws', () => {
    const fs = { existsSyncFn: () => false, readdirSyncFn: () => { throw new Error('should not be called'); }, readFileSyncFn: () => { throw new Error('x'); }, statSyncFn: () => { throw new Error('x'); } };
    const { listManagedRuntimes } = createManagedRuntimeListingCache();
    assert.deepEqual(listManagedRuntimes(RUNTIMES_DIR, fs), []);
  });
});

describe('createManagedRuntimeListingCache() — caching behavior (display-only, never a security boundary)', () => {
  it('an unchanged fingerprint within the TTL window reuses the cached entry, never re-reads the manifest', () => {
    const { manifest, buffers } = makeManifest();
    const fs = makeFakeFs({ runtimeDirs: { [RUNTIME_ID]: { manifest, buffers } } });
    let readCount = 0;
    const countingReadFileSyncFn = (...args) => { readCount += 1; return fs.readFileSyncFn(...args); };

    const { listManagedRuntimes } = createManagedRuntimeListingCache({ ttlMs: 60_000, nowFn: () => 1000 });
    listManagedRuntimes(RUNTIMES_DIR, { ...fs, readFileSyncFn: countingReadFileSyncFn });
    const firstReadCount = readCount;
    assert.ok(firstReadCount > 0);

    listManagedRuntimes(RUNTIMES_DIR, { ...fs, readFileSyncFn: countingReadFileSyncFn });
    assert.equal(readCount, firstReadCount, 'second call within TTL with an unchanged fingerprint must not re-read the manifest/artifacts');
  });

  it('a changed fingerprint (mtime bump) forces re-verification even within the TTL window', () => {
    const { manifest, buffers } = makeManifest();
    const fs = makeFakeFs({ runtimeDirs: { [RUNTIME_ID]: { manifest, buffers } } });
    let readCount = 0;
    const countingReadFileSyncFn = (...args) => { readCount += 1; return fs.readFileSyncFn(...args); };

    const { listManagedRuntimes } = createManagedRuntimeListingCache({ ttlMs: 60_000, nowFn: () => 1000 });
    listManagedRuntimes(RUNTIMES_DIR, { ...fs, readFileSyncFn: countingReadFileSyncFn });
    const firstReadCount = readCount;

    fs.touch(`${RUNTIME_DIR}\\manifest.json`, 999_999);
    listManagedRuntimes(RUNTIMES_DIR, { ...fs, readFileSyncFn: countingReadFileSyncFn });
    assert.ok(readCount > firstReadCount, 'a changed fingerprint must trigger a fresh read');
  });

  it('an UNCONDITIONAL TTL forces re-verification even with an UNCHANGED fingerprint — the real mitigation for a same-size-same-mtime-different-bytes replacement', () => {
    const { manifest, buffers } = makeManifest();
    const fs = makeFakeFs({ runtimeDirs: { [RUNTIME_ID]: { manifest, buffers } } });
    let readCount = 0;
    const countingReadFileSyncFn = (...args) => { readCount += 1; return fs.readFileSyncFn(...args); };

    let now = 1000;
    const { listManagedRuntimes } = createManagedRuntimeListingCache({ ttlMs: 5000, nowFn: () => now });
    listManagedRuntimes(RUNTIMES_DIR, { ...fs, readFileSyncFn: countingReadFileSyncFn });
    const firstReadCount = readCount;

    now += 5001; // past the TTL, fingerprint unchanged
    listManagedRuntimes(RUNTIMES_DIR, { ...fs, readFileSyncFn: countingReadFileSyncFn });
    assert.ok(readCount > firstReadCount, 'an elapsed TTL must force a fresh read even when the fingerprint looks unchanged');
  });

  it('a runtime that becomes corrupt between calls is evicted from the cache and excluded from subsequent listings', () => {
    const { manifest, buffers } = makeManifest();
    const fs = makeFakeFs({ runtimeDirs: { [RUNTIME_ID]: { manifest, buffers } } });
    const { listManagedRuntimes } = createManagedRuntimeListingCache({ ttlMs: 60_000, nowFn: () => 1000 });
    assert.equal(listManagedRuntimes(RUNTIMES_DIR, fs).length, 1);

    fs.files.set(`${RUNTIME_DIR}\\onnxruntime.dll`, Buffer.from('corrupted'));
    fs.touch(`${RUNTIME_DIR}\\onnxruntime.dll`, 999_999); // fingerprint must change to trigger re-check
    assert.deepEqual(listManagedRuntimes(RUNTIMES_DIR, fs), []);
  });
});
