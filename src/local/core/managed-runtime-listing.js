// Lists installed managed CUDA runtimes under
// <runtimesDir>/onnxruntime-node-cuda/*/ for the Admin Settings UI's
// dropdown — DISPLAY-ONLY, never the security boundary that decides what
// actually gets loaded. That boundary is
// onnx-runtime-source-resolution.js's resolveEffectiveOnnxRuntimePath(),
// which ALWAYS performs a full, uncached verifyManagedRuntimeOnDisk()
// call for whichever single runtime is actually selected, every time it
// resolves — this module's own cache is never consulted by that path.
//
// Candidate directories are validated the same two ways the resolution
// layer validates a selection (isManifestWellFormed() +
// verifyManagedRuntimeOnDisk()) before being offered as a real option — a
// runtime that's corrupted since install is silently excluded from the
// list, never offered as a broken choice.
//
// Caching is explicitly a UX optimization to avoid re-hashing 200MB+ of
// artifacts on every Settings page render, NOT a security guarantee — a
// fingerprint keyed on {path, size, mtimeMs} for the manifest plus all 4
// artifacts still cannot detect a same-size-same-mtime-different-bytes
// replacement, so an UNCONDITIONAL TTL on top of the fingerprint is the
// actual mitigation for that gap: even an unchanged fingerprint is
// re-verified from scratch once the TTL elapses.
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isValidManagedRuntimeId } from './managed-runtime-id.js';
import { readManagedRuntimeManifest, isManifestWellFormed, verifyManagedRuntimeOnDisk, MANAGED_NATIVE_RELATIVE_DIR } from './managed-onnx-runtime-manifest.js';

const REQUIRED_ARTIFACT_NAMES = [
  'onnxruntime.dll',
  'onnxruntime_binding.node',
  'onnxruntime_providers_cuda.dll',
  'onnxruntime_providers_shared.dll',
];
const DEFAULT_TTL_MS = 60_000;

/**
 * @param {{ ttlMs?: number, nowFn?: () => number }} [opts]
 */
export function createManagedRuntimeListingCache({ ttlMs = DEFAULT_TTL_MS, nowFn = Date.now } = {}) {
  // Map<runtimeId, { fingerprint: string, cachedAt: number, entry: Object }>
  const cache = new Map();

  function computeFingerprint(dirPath, { existsSyncFn, statSyncFn }) {
    const parts = [];
    const manifestPath = join(dirPath, 'manifest.json');
    if (!existsSyncFn(manifestPath)) return null;
    const manifestStat = statSyncFn(manifestPath);
    parts.push(`manifest.json:${manifestStat.size}:${manifestStat.mtimeMs}`);
    // Native artifacts live under MANAGED_NATIVE_RELATIVE_DIR
    // (bin/napi-v6/win32/x64/), never directly under the runtime's own
    // directory — must match verifyManagedRuntimeOnDisk()'s real lookup
    // path (managed-onnx-runtime-manifest.js) exactly, or this fingerprint
    // silently never reflects real artifact changes: every artifact would
    // report "missing" against the wrong path regardless of the real
    // files' actual state, and getEntry()'s own verifyManagedRuntimeOnDisk()
    // call underneath would then be the ONLY thing catching corruption —
    // defeating the fingerprint's entire purpose as a cheap pre-check.
    for (const name of REQUIRED_ARTIFACT_NAMES) {
      const p = join(dirPath, MANAGED_NATIVE_RELATIVE_DIR, name);
      if (!existsSyncFn(p)) { parts.push(`${name}:missing`); continue; }
      const st = statSyncFn(p);
      parts.push(`${name}:${st.size}:${st.mtimeMs}`);
    }
    return parts.join('|');
  }

  /**
   * @param {string} runtimeId
   * @param {string} dirPath
   * @param {{ readFileSyncFn?: Function, existsSyncFn?: Function, statSyncFn?: Function }} [deps]
   * @returns {{ ortVersion: string, cudaMajor: string, verification: Object } | null}
   *   null when the runtime is invalid/corrupt — excluded from the list entirely.
   */
  function getEntry(runtimeId, dirPath, { readFileSyncFn = readFileSync, existsSyncFn = existsSync, statSyncFn = statSync } = {}) {
    const fingerprint = computeFingerprint(dirPath, { existsSyncFn, statSyncFn });
    if (fingerprint === null) return null;

    const cached = cache.get(runtimeId);
    const ttlElapsed = !cached || (nowFn() - cached.cachedAt) >= ttlMs;
    if (cached && cached.fingerprint === fingerprint && !ttlElapsed) {
      return cached.entry;
    }

    const read = readManagedRuntimeManifest(dirPath, { readFileSyncFn, existsSyncFn });
    if (!read.ok || !isManifestWellFormed(read.manifest)) {
      cache.delete(runtimeId);
      return null;
    }
    const verify = verifyManagedRuntimeOnDisk(dirPath, read.manifest, { readFileSyncFn, existsSyncFn });
    if (!verify.ok) {
      cache.delete(runtimeId);
      return null;
    }

    const entry = {
      id: runtimeId,
      ortVersion: read.manifest.ortVersion,
      cudaMajor: read.manifest.cudaMajor,
      verification: {
        status: read.manifest.verification.status,
        verifiedAt: read.manifest.verification.verifiedAt,
        effectiveProvider: read.manifest.verification.effectiveProvider,
      },
    };
    cache.set(runtimeId, { fingerprint, cachedAt: nowFn(), entry });
    return entry;
  }

  /**
   * @param {string} runtimesDir — see semidex-home.js's resolveSemidexHomePaths().
   * @param {{ readdirSyncFn?: Function, readFileSyncFn?: Function, existsSyncFn?: Function, statSyncFn?: Function }} [deps]
   * @returns {Array<{ id: string, ortVersion: string, cudaMajor: string, verification: Object }>}
   */
  function listManagedRuntimes(runtimesDir, {
    readdirSyncFn = readdirSync, readFileSyncFn = readFileSync, existsSyncFn = existsSync, statSyncFn = statSync,
  } = {}) {
    const onnxRuntimeCudaDir = join(runtimesDir, 'onnxruntime-node-cuda');
    if (!existsSyncFn(onnxRuntimeCudaDir)) return [];
    let names;
    try {
      names = readdirSyncFn(onnxRuntimeCudaDir);
    } catch {
      return [];
    }
    const results = [];
    for (const name of names) {
      if (!isValidManagedRuntimeId(name)) continue;
      const dirPath = join(onnxRuntimeCudaDir, name);
      const entry = getEntry(name, dirPath, { readFileSyncFn, existsSyncFn, statSyncFn });
      if (entry) results.push(entry);
    }
    return results;
  }

  return { listManagedRuntimes };
}
