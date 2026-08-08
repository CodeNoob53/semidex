// Managed CUDA runtime manifest — reader/validator/writer for the
// manifest.json that lives at the root of a package-shaped managed
// runtime. Its four native artifacts (onnxruntime.dll, onnxruntime_binding.node,
// onnxruntime_providers_cuda.dll, onnxruntime_providers_shared.dll).
//
// Two structurally distinct claims, never conflated:
//   - `artifacts` + checksum verification = "the files on disk are
//     intact and match what the installer wrote" — a pure integrity
//     claim, checkable without ever loading ONNX Runtime.
//   - `verification` = "a real strict CUDA probe actually created a CUDA
//     InferenceSession" — the ONLY thing that can ever set
//     status: 'verified'. Manifest/checksum state is NEVER treated as
//     proof CUDA works; only src/local/core/onnx-provider-probe.js's real
//     session-creation success does.
//
// Both the settings-listing layer (Admin API) and the installer script's
// own Node helpers import this one module — no duplicated JSON logic.
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_SCHEMA_VERSION = 2;
export const MANAGED_NATIVE_RELATIVE_DIR = 'bin/napi-v6/win32/x64';
const REQUIRED_ARTIFACT_NAMES = [
  'onnxruntime.dll',
  'onnxruntime_binding.node',
  'onnxruntime_providers_cuda.dll',
  'onnxruntime_providers_shared.dll',
];
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const VERIFICATION_STATUSES = new Set(['unverified', 'verified', 'failed']);

/**
 * @param {string} dirPath — the managed runtime's own versioned directory.
 * @param {{ readFileSyncFn?: typeof readFileSync, existsSyncFn?: typeof existsSync }} [deps]
 * @returns {{ ok: true, manifest: Object } | { ok: false, reason: 'not_found'|'corrupt'|'schema_mismatch' }}
 */
export function readManagedRuntimeManifest(dirPath, { readFileSyncFn = readFileSync, existsSyncFn = existsSync } = {}) {
  const manifestPath = join(dirPath, 'manifest.json');
  if (!existsSyncFn(manifestPath)) {
    return { ok: false, reason: 'not_found' };
  }
  let raw;
  try {
    raw = readFileSyncFn(manifestPath, 'utf-8');
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  let manifest;
  try {
    // Windows PowerShell 5.1 writes UTF-8 with a BOM by default. New
    // installer manifests are written without one, but tolerate the marker
    // so a valid legacy manifest is not mislabeled as corrupt.
    manifest = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  if (!isManifestWellFormed(manifest)) {
    return { ok: false, reason: 'schema_mismatch' };
  }
  return { ok: true, manifest };
}

/**
 * "Well-formed enough to attempt integrity verification" — NOT "safe to
 * load" and NOT "proven working." Checks schemaVersion, required
 * identity/provenance fields, all 4 artifact entries with valid-shaped
 * checksums, and a valid verification block.
 * @param {unknown} manifest
 * @returns {boolean}
 */
export function isManifestWellFormed(manifest) {
  if (typeof manifest !== 'object' || manifest === null) return false;
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) return false;
  if (typeof manifest.ortVersion !== 'string' || !manifest.ortVersion) return false;
  if (typeof manifest.cudaMajor !== 'string' || !manifest.cudaMajor) return false;
  if (typeof manifest.platform !== 'string' || !manifest.platform) return false;
  if (typeof manifest.arch !== 'string' || !manifest.arch) return false;

  const provenance = manifest.provenance;
  if (typeof provenance !== 'object' || provenance === null) return false;
  if (typeof provenance.sourceCommit !== 'string' || !COMMIT_RE.test(provenance.sourceCommit)) return false;
  if (typeof provenance.runtimeAssetSha256 !== 'string' || !SHA256_RE.test(provenance.runtimeAssetSha256)) return false;
  if (provenance.checksumTrust !== 'locked' && provenance.checksumTrust !== 'user_confirmed_unverified') return false;

  // dependencies.cudnnBinPath (schema v2 addition, per live verification
  // on the reference machine — see docs/en/windows-cuda-onnxruntime-install.md):
  // the exact cuDNN bin directory the installer found and verified at
  // install time. A real CUDA session requires this directory on the
  // PROCESS's own PATH before onnxruntime_binding.node is loaded — the
  // DLL cannot locate its cuDNN dependency otherwise, confirmed live:
  // the probe fails with "Failed to load shared library" without it,
  // succeeds identically to a real production CUDA session with it.
  // Required, absolute path — never optional, since a managed runtime is
  // meaningless without knowing where its own cuDNN dependency lives.
  const dependencies = manifest.dependencies;
  if (typeof dependencies !== 'object' || dependencies === null) return false;
  if (typeof dependencies.cudnnBinPath !== 'string' || !dependencies.cudnnBinPath) return false;

  const artifacts = manifest.artifacts;
  if (typeof artifacts !== 'object' || artifacts === null) return false;
  for (const name of REQUIRED_ARTIFACT_NAMES) {
    const entry = artifacts[name];
    if (typeof entry !== 'object' || entry === null) return false;
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) return false;
    if (typeof entry.bytes !== 'number' || entry.bytes <= 0) return false;
  }

  const verification = manifest.verification;
  if (typeof verification !== 'object' || verification === null) return false;
  if (!VERIFICATION_STATUSES.has(verification.status)) return false;

  return true;
}

function sha256File(path, readFileSyncFn) {
  const buf = readFileSyncFn(path);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Recomputes SHA-256 of all 4 native artifacts in the canonical
 * onnxruntime-node package location and compares to
 * manifest.artifacts. This is the "integrity" gate a runtime must pass
 * before it's even offered as a dropdown option or actually loaded —
 * isManifestWellFormed() alone is NOT enough, since a file can
 * corrupt/truncate after a valid manifest was written.
 * @param {string} dirPath
 * @param {Object} manifest
 * @param {{ readFileSyncFn?: typeof readFileSync, existsSyncFn?: typeof existsSync }} [deps]
 * @returns {{ ok: true } | { ok: false, mismatches: Array<{ name: string, reason: string }> }}
 */
export function verifyManagedRuntimeOnDisk(dirPath, manifest, { readFileSyncFn = readFileSync, existsSyncFn = existsSync } = {}) {
  const mismatches = [];
  for (const name of REQUIRED_ARTIFACT_NAMES) {
    const expected = manifest?.artifacts?.[name];
    const filePath = join(dirPath, MANAGED_NATIVE_RELATIVE_DIR, name);
    if (!expected) {
      mismatches.push({ name, reason: 'missing_from_manifest' });
      continue;
    }
    if (!existsSyncFn(filePath)) {
      mismatches.push({ name, reason: 'file_missing' });
      continue;
    }
    let actualSha256;
    try {
      actualSha256 = sha256File(filePath, readFileSyncFn);
    } catch {
      mismatches.push({ name, reason: 'read_failed' });
      continue;
    }
    if (actualSha256 !== expected.sha256) {
      mismatches.push({ name, reason: 'checksum_mismatch' });
    }
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}

/**
 * Hashes (SHA-256, hex) the JSON-stringified IMMUTABLE identity fields
 * only — schemaVersion, ortVersion, cudaMajor, platform, arch,
 * provenance, artifacts — deliberately excluding the mutable
 * `verification` block itself (which is exactly the thing being updated
 * by writeVerificationResult(), so it can never be part of its own
 * staleness check).
 * @param {Object} manifest
 * @returns {string} 64-hex-char fingerprint.
 */
export function computeManifestIdentityFingerprint(manifest) {
  const identity = {
    schemaVersion: manifest.schemaVersion,
    ortVersion: manifest.ortVersion,
    cudaMajor: manifest.cudaMajor,
    platform: manifest.platform,
    arch: manifest.arch,
    provenance: manifest.provenance,
    artifacts: manifest.artifacts,
    dependencies: manifest.dependencies,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/**
 * Updates only the manifest's `verification` block. Caller contract: read
 * the manifest BEFORE running the real CUDA probe, compute
 * computeManifestIdentityFingerprint(thatManifest), keep the probe
 * running, then pass that SAME fingerprint in as
 * `expectedManifestFingerprint` once the probe completes. This function
 * re-reads the CURRENT on-disk manifest and recomputes its own
 * fingerprint the same way — if they differ (a concurrent
 * reinstall/rebuild replaced the runtime while the probe was in flight),
 * the write is aborted: `{ ok: false, reason: 'manifest_changed_concurrently' }`,
 * nothing written.
 *
 * ATOMIC write: writes the patched JSON to `manifest.json.tmp-<random>`
 * in the SAME directory, then renames it over `manifest.json` — a
 * same-directory rename is atomic on both NTFS and POSIX, so a process
 * crash mid-write can never leave a truncated/corrupt manifest.json.
 *
 * Called by: the installer's own end-of-run probe, AND the Admin API
 * route after every real probe against a managed runtime — so "verified"
 * always reflects the MOST RECENT real probe against the EXACT runtime
 * that was actually probed.
 *
 * @param {string} dirPath
 * @param {{ status: 'unverified'|'verified'|'failed', effectiveProvider: string|null, expectedManifestFingerprint: string }} update
 * @param {{ writeFileSyncFn?: typeof writeFileSync, readFileSyncFn?: typeof readFileSync, existsSyncFn?: typeof existsSync, renameSyncFn?: typeof renameSync }} [deps]
 * @returns {{ ok: true, manifest: Object } | { ok: false, reason: 'manifest_changed_concurrently'|'not_found'|'corrupt'|'schema_mismatch' }}
 */
export function writeVerificationResult(
  dirPath,
  { status, effectiveProvider, expectedManifestFingerprint },
  { writeFileSyncFn = writeFileSync, readFileSyncFn = readFileSync, existsSyncFn = existsSync, renameSyncFn = renameSync } = {},
) {
  const current = readManagedRuntimeManifest(dirPath, { readFileSyncFn, existsSyncFn });
  if (!current.ok) return current;

  const currentFingerprint = computeManifestIdentityFingerprint(current.manifest);
  if (currentFingerprint !== expectedManifestFingerprint) {
    return { ok: false, reason: 'manifest_changed_concurrently' };
  }

  const patched = {
    ...current.manifest,
    verification: {
      status,
      verifiedAt: status !== 'unverified' ? new Date().toISOString() : null,
      effectiveProvider: effectiveProvider ?? null,
    },
  };

  const manifestPath = join(dirPath, 'manifest.json');
  const tmpPath = join(dirPath, `manifest.json.tmp-${randomBytes(6).toString('hex')}`);
  writeFileSyncFn(tmpPath, JSON.stringify(patched, null, 2) + '\n', 'utf-8');
  renameSyncFn(tmpPath, manifestPath);

  return { ok: true, manifest: patched };
}
