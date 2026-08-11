// src/local/core/managed-runtime-listing.js — the DISPLAY-ONLY listing
// cache for the Settings UI's managed-runtime dropdown. Explicitly
// proves: (1) a valid/intact runtime is listed, (2) a corrupt/invalid one
// is silently excluded, (3) the fingerprint cache avoids re-verification
// when nothing changed, (4) a changed fingerprint forces re-verification,
// (5) an unconditional TTL forces re-verification even with an UNCHANGED
// fingerprint (the actual mitigation for the same-size-same-mtime-
// different-bytes gap a fingerprint alone cannot catch).
//
// Code review correction: an earlier version of this file used a fake,
// in-memory fs keyed by hardcoded 'C:\...' string literals — but
// managed-onnx-runtime-manifest.js/managed-runtime-listing.js both use
// OS-native node:path.join() on their directory arguments, since those
// arguments are always REAL, already-OS-native paths in production
// (resolved by semidex-home.js's resolveSemidexHomePaths({ platform:
// process.platform })). On Linux CI, join() is posix.join(), which never
// matches a literal 'C:\...\manifest.json' Map key built with a
// hardcoded backslash — every lookup silently missed the fake "file."
// Fixed by using a REAL temp directory tree (mkdtempSync/mkdirSync/
// writeFileSync/statSync) instead — the listing logic itself has nothing
// to do with Windows specifically (it never inspects path separators),
// so there is no reason for its own test fixture to hardcode any.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_SCHEMA_VERSION, MANAGED_NATIVE_RELATIVE_DIR } from '../../../../src/local/core/managed-onnx-runtime-manifest.js';
import { createManagedRuntimeListingCache } from '../../../../src/local/core/managed-runtime-listing.js';

const RUNTIME_ID = '1.26.0-cuda13';
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
      // A real Windows-only path recorded INSIDE the manifest's own JSON
      // content — this is data, never touched by node:path itself, so it
      // stays a literal on purpose (mirrors what a real manifest written
      // by the Windows-only installer would actually contain).
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

// Builds a REAL temp directory tree shaped like <runtimesDir>/onnxruntime-node-cuda/<id>/,
// with a real manifest.json and (optionally) real native artifact files
// under MANAGED_NATIVE_RELATIVE_DIR — matching verifyManagedRuntimeOnDisk()'s
// real lookup path. runtimeDirs: { [runtimeId]: { manifest, buffers } | null
// (directory exists but carries no valid manifest) }.
// Returns { runtimesDir, cleanup() }.
function makeRealFixture(runtimeDirs) {
  const runtimesDir = mkdtempSync(join(tmpdir(), 'semidex-managed-listing-'));
  const onnxRuntimeCudaDir = join(runtimesDir, 'onnxruntime-node-cuda');
  mkdirSync(onnxRuntimeCudaDir, { recursive: true });
  for (const [id, data] of Object.entries(runtimeDirs)) {
    const dir = join(onnxRuntimeCudaDir, id);
    mkdirSync(dir, { recursive: true });
    if (!data) continue;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(data.manifest), 'utf-8');
    const nativeDir = join(dir, ...MANAGED_NATIVE_RELATIVE_DIR.split('/'));
    mkdirSync(nativeDir, { recursive: true });
    for (const [name, buf] of Object.entries(data.buffers)) {
      writeFileSync(join(nativeDir, name), buf);
    }
  }
  return {
    runtimesDir,
    cleanup() { rmSync(runtimesDir, { recursive: true, force: true }); },
  };
}

// Real mtime bump — real fs.statSync()-backed fingerprinting needs a real
// mtime change to actually differ; utimesSync() with a fresh Date object
// is the standard way to force that deterministically in a test, rather
// than sleeping for real wall-clock time.
function touchNewer(filePath) {
  const future = new Date(Date.now() + 60_000);
  utimesSync(filePath, future, future);
}

describe('createManagedRuntimeListingCache().listManagedRuntimes()', () => {
  it('lists a valid, intact managed runtime', () => {
    const { manifest, buffers } = makeManifest();
    const { runtimesDir, cleanup } = makeRealFixture({ [RUNTIME_ID]: { manifest, buffers } });
    try {
      const { listManagedRuntimes } = createManagedRuntimeListingCache();
      const result = listManagedRuntimes(runtimesDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].id, RUNTIME_ID);
      assert.equal(result[0].ortVersion, '1.26.0');
      assert.equal(result[0].verification.status, 'verified');
    } finally {
      cleanup();
    }
  });

  it('excludes a directory whose id does not match the validated managed-runtime-id format', () => {
    const { manifest, buffers } = makeManifest();
    const { runtimesDir, cleanup } = makeRealFixture({ 'not-a-valid-id': { manifest, buffers }, [RUNTIME_ID]: { manifest, buffers } });
    try {
      const { listManagedRuntimes } = createManagedRuntimeListingCache();
      const result = listManagedRuntimes(runtimesDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].id, RUNTIME_ID);
    } finally {
      cleanup();
    }
  });

  it('excludes a directory with no manifest at all', () => {
    const { runtimesDir, cleanup } = makeRealFixture({ [RUNTIME_ID]: null });
    try {
      const { listManagedRuntimes } = createManagedRuntimeListingCache();
      const result = listManagedRuntimes(runtimesDir);
      assert.deepEqual(result, []);
    } finally {
      cleanup();
    }
  });

  it('excludes a runtime whose manifest is not well-formed (silently, not as a broken choice)', () => {
    const { manifest, buffers } = makeManifest({ dependencies: undefined });
    const { runtimesDir, cleanup } = makeRealFixture({ [RUNTIME_ID]: { manifest, buffers } });
    try {
      const { listManagedRuntimes } = createManagedRuntimeListingCache();
      const result = listManagedRuntimes(runtimesDir);
      assert.deepEqual(result, []);
    } finally {
      cleanup();
    }
  });

  it('excludes a runtime that fails the on-disk integrity check (well-formed manifest, corrupted artifact bytes)', () => {
    const { manifest, buffers } = makeManifest();
    const corruptedBuffers = { ...buffers, 'onnxruntime.dll': Buffer.from('corrupted') };
    const { runtimesDir, cleanup } = makeRealFixture({ [RUNTIME_ID]: { manifest, buffers: corruptedBuffers } });
    try {
      const { listManagedRuntimes } = createManagedRuntimeListingCache();
      const result = listManagedRuntimes(runtimesDir);
      assert.deepEqual(result, []);
    } finally {
      cleanup();
    }
  });

  it('a non-existent onnxruntime-node-cuda directory returns an empty list, never throws', () => {
    const runtimesDir = mkdtempSync(join(tmpdir(), 'semidex-managed-listing-empty-'));
    try {
      const { listManagedRuntimes } = createManagedRuntimeListingCache();
      assert.deepEqual(listManagedRuntimes(runtimesDir), []);
    } finally {
      rmSync(runtimesDir, { recursive: true, force: true });
    }
  });
});

describe('createManagedRuntimeListingCache() — caching behavior (display-only, never a security boundary)', () => {
  it('an unchanged fingerprint within the TTL window reuses the cached entry, never re-reads the manifest', () => {
    const { manifest, buffers } = makeManifest();
    const { runtimesDir, cleanup } = makeRealFixture({ [RUNTIME_ID]: { manifest, buffers } });
    try {
      // computeFingerprint() itself always touches existsSyncFn/statSyncFn
      // on disk (real fs calls stay real for those) — the thing the cache
      // actually promises to skip on an unchanged fingerprint is the
      // manifest CONTENT read (readFileSyncFn), so that is the one call
      // counted here via a real-fs-backed counting wrapper.
      let readCount = 0;
      const countingReadFileSyncFn = (...args) => { readCount += 1; return readFileSync(...args); };

      const { listManagedRuntimes } = createManagedRuntimeListingCache({ ttlMs: 60_000, nowFn: () => 1000 });
      const first = listManagedRuntimes(runtimesDir, { readFileSyncFn: countingReadFileSyncFn });
      assert.equal(first.length, 1);
      const firstReadCount = readCount;
      assert.ok(firstReadCount > 0);

      const second = listManagedRuntimes(runtimesDir, { readFileSyncFn: countingReadFileSyncFn });
      assert.equal(second.length, 1);
      assert.equal(readCount, firstReadCount, 'second call within TTL with an unchanged fingerprint must not re-read the manifest/artifacts');
    } finally {
      cleanup();
    }
  });

  it('a changed fingerprint (mtime bump) forces re-verification even within the TTL window', () => {
    const { manifest, buffers } = makeManifest();
    const { runtimesDir, cleanup } = makeRealFixture({ [RUNTIME_ID]: { manifest, buffers } });
    try {
      const { listManagedRuntimes } = createManagedRuntimeListingCache({ ttlMs: 60_000, nowFn: () => 1000 });
      const first = listManagedRuntimes(runtimesDir);
      assert.equal(first.length, 1);
      assert.equal(first[0].verification.effectiveProvider, 'cuda');

      // Real content change, same file still present — rewrites the
      // manifest with a genuinely different verification.effectiveProvider
      // and bumps mtime, mirroring a real re-verification event on disk.
      const manifestPath = join(runtimesDir, 'onnxruntime-node-cuda', RUNTIME_ID, 'manifest.json');
      const updated = { ...manifest, verification: { ...manifest.verification, effectiveProvider: 'dml' } };
      writeFileSync(manifestPath, JSON.stringify(updated), 'utf-8');
      touchNewer(manifestPath);

      const result = listManagedRuntimes(runtimesDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].verification.effectiveProvider, 'dml', 'a changed fingerprint must trigger a fresh read that picks up the real new content');
    } finally {
      cleanup();
    }
  });

  it('an UNCONDITIONAL TTL forces re-verification even with an UNCHANGED fingerprint — the real mitigation for a same-size-same-mtime-different-bytes replacement', () => {
    const { manifest, buffers } = makeManifest();
    const { runtimesDir, cleanup } = makeRealFixture({ [RUNTIME_ID]: { manifest, buffers } });
    try {
      let now = 1000;
      const { listManagedRuntimes } = createManagedRuntimeListingCache({ ttlMs: 5000, nowFn: () => now });
      assert.equal(listManagedRuntimes(runtimesDir).length, 1);

      now += 5001; // past the TTL, fingerprint unchanged on disk
      // Delete the manifest WITHOUT bumping its mtime — the file's
      // stat (size/mtime) alone can't distinguish "gone" from "same size/
      // mtime, different bytes" either way; what THIS test actually
      // proves is that an elapsed TTL alone (fingerprint otherwise
      // unchanged) is enough to force a fresh disk check at all, which a
      // TTL-blind cache would skip entirely and keep serving the stale
      // cached entry forever.
      rmSync(join(runtimesDir, 'onnxruntime-node-cuda', RUNTIME_ID, 'manifest.json'));
      const result = listManagedRuntimes(runtimesDir);
      assert.deepEqual(result, [], 'an elapsed TTL must force a fresh read even when the fingerprint looks unchanged');
    } finally {
      cleanup();
    }
  });

  it('a runtime that becomes corrupt between calls is evicted from the cache and excluded from subsequent listings', () => {
    const { manifest, buffers } = makeManifest();
    const { runtimesDir, cleanup } = makeRealFixture({ [RUNTIME_ID]: { manifest, buffers } });
    try {
      const { listManagedRuntimes } = createManagedRuntimeListingCache({ ttlMs: 60_000, nowFn: () => 1000 });
      assert.equal(listManagedRuntimes(runtimesDir).length, 1);

      const dllPath = join(runtimesDir, 'onnxruntime-node-cuda', RUNTIME_ID, ...MANAGED_NATIVE_RELATIVE_DIR.split('/'), 'onnxruntime.dll');
      writeFileSync(dllPath, Buffer.from('corrupted'));
      touchNewer(dllPath); // fingerprint must change to trigger re-check
      assert.deepEqual(listManagedRuntimes(runtimesDir), []);
    } finally {
      cleanup();
    }
  });
});
