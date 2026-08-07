// Pure decision logic for scripts/install-onnxruntime-cuda-windows.ps1 —
// every non-trivial decision the installer makes (trust-gate resolution,
// idempotent-skip comparison, transactional-swap state machine) lives
// here as plain, injectable, side-effect-free functions, NOT inline in
// PowerShell, so it can be unit-tested under node:test the same way every
// other piece of this codebase is (PowerShell itself cannot be driven by
// node:test). The .ps1 script calls this module via a small JSON-in/
// JSON-out CLI contract (mirrors onnx-cuda-prereq-check.js's own
// isolated-process/JSON-stdout convention) for each decision point, then
// performs the actual filesystem/network/process work these decisions
// prescribe. This file itself never touches fs/network/child_process —
// every real path/hash/timestamp value is threaded in as a plain
// argument, so a test can exercise a decision without a single real I/O
// call.
import { pathToFileURL } from 'node:url';
import { computeManifestIdentityFingerprint, MANIFEST_SCHEMA_VERSION } from './managed-onnx-runtime-manifest.js';

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Resolves the trust anchors (source commit + release-asset checksum) an
 * install for `{ortVersion, cudaMajor}` must verify against, and whether
 * the caller is required to confirm an unverified asset checksum before
 * downloading.
 *
 * Precedence, matching the plan's own trust model exactly:
 *  - A lock-file entry for this exact {ortVersion, cudaMajor, platform,
 *    arch} always wins — its own sourceCommit/runtimeAssetSha256 are used,
 *    any caller-supplied -ExpectedSourceCommit/-ExpectedSha256 are
 *    ignored UNLESS they're identical anyway (never silently overridden
 *    by a caller trying to weaken a locked, reference-verified entry).
 *  - No lock entry: -ExpectedSourceCommit is ALWAYS required, unconditionally
 *    — no flag combination bypasses this, ever. Missing it is a hard
 *    error before any network call.
 *  - No lock entry, release-asset checksum: -ExpectedSha256 OR
 *    -AllowUnverifiedDownload is required. Neither present -> hard error.
 *    -AllowUnverifiedDownload without -NonInteractive -> the caller
 *    (the .ps1) must show one interactive confirmation before
 *    downloading; this function reports that requirement via
 *    `requiresInteractiveConfirmation`, it never performs the prompt
 *    itself (this module has no I/O).
 *
 * @param {{
 *   ortVersion: string, cudaMajor: string, platform: string, arch: string,
 *   lockEntries: Array<{ortVersion:string, cudaMajor:string, platform:string, arch:string, sourceCommit:string, runtimeAssetUrl:string, runtimeAssetSha256:string}>,
 *   expectedSourceCommit?: string, expectedSha256?: string,
 *   allowUnverifiedDownload?: boolean, nonInteractive?: boolean,
 * }} opts
 * @returns {
 *   { ok: true, checksumTrust: 'locked'|'user_confirmed_unverified', sourceCommit: string, runtimeAssetSha256: string|null, runtimeAssetUrl: string|null, requiresInteractiveConfirmation: boolean }
 *   | { ok: false, reason: string }
 * }
 */
export function resolveTrustGate({
  ortVersion, cudaMajor, platform, arch, lockEntries = [],
  expectedSourceCommit, expectedSha256, allowUnverifiedDownload = false, nonInteractive = false,
}) {
  const locked = lockEntries.find((e) => (
    e.ortVersion === ortVersion && e.cudaMajor === cudaMajor && e.platform === platform && e.arch === arch
  ));

  if (locked) {
    if (expectedSourceCommit && expectedSourceCommit !== locked.sourceCommit) {
      return { ok: false, reason: `-ExpectedSourceCommit "${expectedSourceCommit}" conflicts with the locked commit "${locked.sourceCommit}" for ${ortVersion}-cuda${cudaMajor} — the locked entry always wins; omit the flag or pass the matching commit.` };
    }
    if (expectedSha256 && expectedSha256 !== locked.runtimeAssetSha256) {
      return { ok: false, reason: `-ExpectedSha256 conflicts with the locked checksum for ${ortVersion}-cuda${cudaMajor} — the locked entry always wins; omit the flag or pass the matching hash.` };
    }
    return {
      ok: true,
      checksumTrust: 'locked',
      sourceCommit: locked.sourceCommit,
      runtimeAssetSha256: locked.runtimeAssetSha256,
      runtimeAssetUrl: locked.runtimeAssetUrl,
      requiresInteractiveConfirmation: false,
    };
  }

  // Not in the lock file — every combination requires an explicit,
  // caller-supplied source commit, unconditionally, before any network
  // call. -AllowUnverifiedDownload governs ONLY the asset-checksum gap
  // below; it never substitutes for this.
  if (!expectedSourceCommit) {
    return { ok: false, reason: `${ortVersion}-cuda${cudaMajor} is not in scripts/onnxruntime-cuda-lock.json — -ExpectedSourceCommit is required (a 40-hex-char git commit SHA, not a tag name) and is never optional, regardless of other flags.` };
  }
  if (!COMMIT_RE.test(expectedSourceCommit)) {
    return { ok: false, reason: `-ExpectedSourceCommit "${expectedSourceCommit}" is not a 40-hex-char git commit SHA.` };
  }

  if (expectedSha256) {
    if (!SHA256_RE.test(expectedSha256)) {
      return { ok: false, reason: `-ExpectedSha256 "${expectedSha256}" is not a 64-hex-char SHA-256 hash.` };
    }
    return {
      ok: true,
      checksumTrust: 'user_confirmed_unverified',
      sourceCommit: expectedSourceCommit,
      runtimeAssetSha256: expectedSha256,
      runtimeAssetUrl: null,
      requiresInteractiveConfirmation: false,
    };
  }

  if (!allowUnverifiedDownload) {
    return { ok: false, reason: `${ortVersion}-cuda${cudaMajor} is not in scripts/onnxruntime-cuda-lock.json and no -ExpectedSha256 was supplied — pass -ExpectedSha256 <hash>, or pass -AllowUnverifiedDownload to proceed without a pre-known checksum (governs only the release-asset checksum gap; -ExpectedSourceCommit is still always required).` };
  }

  return {
    ok: true,
    checksumTrust: 'user_confirmed_unverified',
    sourceCommit: expectedSourceCommit,
    runtimeAssetSha256: null,
    runtimeAssetUrl: null,
    requiresInteractiveConfirmation: !nonInteractive,
  };
}

/**
 * Whether an existing, on-disk target manifest already satisfies the
 * requested install exactly — every identity-relevant field must match,
 * not just ortVersion/cudaMajor, AND the artifacts must still pass a
 * fresh on-disk integrity check (a file can silently corrupt after a
 * valid manifest was written). Any single mismatch means "rebuild".
 * `-Force` bypasses this function entirely — the .ps1 never calls it
 * when -Force is set.
 * @param {{
 *   existingManifest: Object|null,
 *   isManifestWellFormedFn: (m: Object) => boolean,
 *   verifyOnDiskFn: () => { ok: boolean },
 *   requested: { ortVersion: string, cudaMajor: string, platform: string, arch: string, sourceCommit: string, runtimeAssetSha256: string|null, installerVersion: string },
 * }} opts
 * @returns {{ shouldSkip: true } | { shouldSkip: false, reason: string }}
 */
export function shouldSkipRebuild({ existingManifest, isManifestWellFormedFn, verifyOnDiskFn, requested }) {
  if (!existingManifest) return { shouldSkip: false, reason: 'no existing manifest' };
  if (!isManifestWellFormedFn(existingManifest)) return { shouldSkip: false, reason: 'existing manifest is not well-formed' };

  const fieldsMatch = (
    existingManifest.ortVersion === requested.ortVersion
    && existingManifest.cudaMajor === requested.cudaMajor
    && existingManifest.platform === requested.platform
    && existingManifest.arch === requested.arch
    && existingManifest.provenance?.sourceCommit === requested.sourceCommit
    && existingManifest.installerVersion === requested.installerVersion
    // A locked/known asset hash must match exactly; an unverified install
    // (requested.runtimeAssetSha256 === null, i.e. -AllowUnverifiedDownload
    // with no pre-known hash) can never be skip-eligible purely on field
    // comparison — there is nothing trustworthy to compare against, so it
    // always falls through to a full rebuild+re-verify.
    && requested.runtimeAssetSha256 !== null
    && existingManifest.provenance?.runtimeAssetSha256 === requested.runtimeAssetSha256
  );
  if (!fieldsMatch) return { shouldSkip: false, reason: 'identity fields differ from the requested install' };

  const verify = verifyOnDiskFn();
  if (!verify.ok) return { shouldSkip: false, reason: 'on-disk artifact integrity check failed' };

  return { shouldSkip: true };
}

/**
 * The transactional-swap decision for ONE step of the installer's own
 * state machine — pure state transitions, no I/O. The .ps1 script calls
 * this once per step, in order, and performs exactly the filesystem
 * operations `nextActions` prescribes before calling the next step.
 *
 * Steps, in order:
 *  1. 'before_swap'    -> decides whether target must be backed up first.
 *  2. 'after_probe'    -> decides cleanup/rollback given the real probe result.
 *  3. 'rename_failure'  -> decides rollback given a rename step itself failing
 *                          (before the probe ever ran).
 *
 * @param {'before_swap'|'after_probe'|'rename_failure'} step
 * @param {{
 *   hadExistingTarget: boolean,
 *   probeOk?: boolean,
 *   skipProbe?: boolean,
 * }} state
 * @returns {{ actions: string[], terminal: 'success'|'failure'|null }}
 */
export function planTransactionalSwapStep(step, state) {
  const { hadExistingTarget, probeOk, skipProbe } = state;

  if (step === 'before_swap') {
    const actions = [];
    if (hadExistingTarget) actions.push('rename_target_to_backup');
    actions.push('rename_install_stage_to_target');
    return { actions, terminal: null };
  }

  if (step === 'after_probe') {
    if (skipProbe) {
      // -SkipProbe: the swap completes, manifest stays 'unverified'. No
      // rollback path exists for a probe that never ran — that's not a
      // failure, it's an explicit opt-out.
      const actions = hadExistingTarget ? ['delete_backup'] : [];
      return { actions, terminal: 'success' };
    }
    if (probeOk) {
      const actions = hadExistingTarget ? ['delete_backup'] : [];
      return { actions, terminal: 'success' };
    }
    // Probe genuinely ran and failed.
    if (hadExistingTarget) {
      // A prior working runtime exists — restore it. The broken new
      // build is kept on disk (renamed, not deleted) for inspection,
      // never silently discarded.
      return { actions: ['rename_target_to_failed', 'rename_backup_to_target'], terminal: 'failure' };
    }
    // First install, no backup to restore. A broken first install must
    // never be left selectable under the canonical `target` path — it is
    // renamed aside and `target` is left absent.
    return { actions: ['rename_target_to_failed'], terminal: 'failure' };
  }

  if (step === 'rename_failure') {
    // One of the renames in 'before_swap' itself threw, before the probe
    // ever ran. Same rollback shape as a failed probe, triggered earlier.
    if (hadExistingTarget) {
      return { actions: ['rename_backup_to_target_if_present'], terminal: 'failure' };
    }
    return { actions: [], terminal: 'failure' };
  }

  throw new Error(`unknown transactional swap step: ${JSON.stringify(step)}`);
}

/**
 * Asserts installStage and target resolve to the same volume root — a
 * same-directory/same-volume rename is atomic on NTFS; a cross-volume
 * "rename" is not (Node/Windows silently falls back to copy+delete,
 * which is NOT atomic and can leave a half-written target on a crash).
 * Pure string/volume-root comparison — the caller supplies the actual
 * volume root strings (e.g. from a `(Get-Item $path).PSDrive.Name`-style
 * lookup on the PowerShell side); this function makes no filesystem call
 * of its own.
 * @param {string} installStageVolumeRoot
 * @param {string} targetVolumeRoot
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function assertSameVolume(installStageVolumeRoot, targetVolumeRoot) {
  if (installStageVolumeRoot.toLowerCase() !== targetVolumeRoot.toLowerCase()) {
    return {
      ok: false,
      reason: `installStage ("${installStageVolumeRoot}") and target ("${targetVolumeRoot}") are on different volumes — an "atomic" rename between them is not actually atomic on Windows. This is an installer configuration bug (SemidexHome and the build staging area must share a volume), not a runtime condition to silently work around.`,
    };
  }
  return { ok: true };
}

/**
 * Builds the manifest.json content the installer writes, immediately
 * after copying artifacts into installStage — verification.status always
 * starts 'unverified' here; only writeVerificationResult() (called AFTER
 * the real end-of-run probe) can ever change that.
 * @param {{
 *   ortVersion: string, cudaMajor: string, platform: string, arch: string,
 *   sourceRepository: string, sourceTag: string, sourceCommit: string,
 *   runtimeAssetUrl: string|null, runtimeAssetSha256: string, checksumTrust: 'locked'|'user_confirmed_unverified',
 *   artifacts: Record<string, {sha256: string, bytes: number}>,
 *   cudnnBinPath: string, builtAt: string, nodeVersion: string,
 * }} opts
 * @returns {Object}
 */
export function buildManifestDraft({
  ortVersion, cudaMajor, platform, arch,
  sourceRepository, sourceTag, sourceCommit, runtimeAssetUrl, runtimeAssetSha256, checksumTrust,
  artifacts, cudnnBinPath, builtAt, nodeVersion,
}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    ortVersion, cudaMajor, platform, arch,
    provenance: {
      sourceRepository, sourceTag, sourceCommit,
      runtimeAssetUrl, runtimeAssetSha256, checksumTrust,
    },
    artifacts,
    dependencies: { cudnnBinPath },
    builtAt,
    buildHost: { platform, nodeVersion },
    installerVersion: '2',
    verification: { status: 'unverified', verifiedAt: null, effectiveProvider: null },
  };
}

/**
 * Convenience re-export so the installer's own CLI glue can compute a
 * manifest's identity fingerprint (needed for writeVerificationResult()'s
 * expectedManifestFingerprint argument) without a second import path.
 */
export { computeManifestIdentityFingerprint };

// CLI dispatch entry — invoked by the PowerShell installer as
// `node src/local/core/onnx-cuda-installer-logic.js <decision>`, with the
// decision's own JSON input piped to stdin, mirroring
// onnx-cuda-prereq-check.js's isolated-process/JSON-stdout convention.
// Writes exactly one JSON line to stdout and exits non-zero only on a
// genuine bug in this script itself (a decision's own "no" answer is
// still a normal, successful `{ ok: false, reason }`-shaped stdout
// result, never a thrown error / non-zero exit — PowerShell distinguishes
// "the answer is no" from "this script crashed" by reading the JSON, not
// the exit code, for every decision except the two isManifestWellFormed/
// verifyOnDiskFn-backed ones below, which only ever throw for a genuine
// caller contract violation (missing required stdin field).
//
// shouldSkipRebuild's own isManifestWellFormedFn/verifyOnDiskFn callback
// parameters cannot cross the JSON boundary — this CLI wires in the REAL
// isManifestWellFormed()/verifyManagedRuntimeOnDisk() implementations
// from managed-onnx-runtime-manifest.js, reading requestedRuntimeDir from
// stdin, so the installer never re-implements integrity verification
// itself.
async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw ? JSON.parse(raw) : {};
}

/**
 * Exported (not just used by the CLI entry below) so a test can exercise
 * the full dispatch/decode logic — including shouldSkipRebuild's manifest-
 * reading wiring — with injected fake fs functions, never real I/O.
 * @param {string} decision
 * @param {Object} input
 * @param {{
 *   readManagedRuntimeManifestFn?: Function, isManifestWellFormedFn?: Function, verifyManagedRuntimeOnDiskFn?: Function,
 *   readFileSyncFn?: Function, existsSyncFn?: Function,
 * }} [deps]
 */
export async function dispatch(decision, input, deps = {}) {
  switch (decision) {
    case 'resolveTrustGate':
      return resolveTrustGate(input);
    case 'shouldSkipRebuild': {
      const manifestModule = await import('./managed-onnx-runtime-manifest.js');
      const fsModule = await import('node:fs');
      const readManagedRuntimeManifestFn = deps.readManagedRuntimeManifestFn ?? manifestModule.readManagedRuntimeManifest;
      const isManifestWellFormedFn = deps.isManifestWellFormedFn ?? manifestModule.isManifestWellFormed;
      const verifyManagedRuntimeOnDiskFn = deps.verifyManagedRuntimeOnDiskFn ?? manifestModule.verifyManagedRuntimeOnDisk;
      const readFileSyncFn = deps.readFileSyncFn ?? fsModule.readFileSync;
      const existsSyncFn = deps.existsSyncFn ?? fsModule.existsSync;
      const read = readManagedRuntimeManifestFn(input.requestedRuntimeDir, { readFileSyncFn, existsSyncFn });
      const existingManifest = read.ok ? read.manifest : null;
      return shouldSkipRebuild({
        existingManifest,
        isManifestWellFormedFn,
        verifyOnDiskFn: () => (existingManifest ? verifyManagedRuntimeOnDiskFn(input.requestedRuntimeDir, existingManifest, { readFileSyncFn, existsSyncFn }) : { ok: false, mismatches: [] }),
        requested: input.requested,
      });
    }
    case 'planTransactionalSwapStep':
      return planTransactionalSwapStep(input.step, input.state);
    case 'assertSameVolume':
      return assertSameVolume(input.installStageVolumeRoot, input.targetVolumeRoot);
    case 'buildManifestDraft':
      return buildManifestDraft(input);
    default:
      throw new Error(`unknown installer decision: ${JSON.stringify(decision)}`);
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const decision = process.argv[2];
  readStdinJson()
    .then((input) => dispatch(decision, input))
    .then((result) => { process.stdout.write(JSON.stringify(result) + '\n'); })
    .catch((err) => {
      process.stdout.write(JSON.stringify({ error: String(err?.message ?? err) }) + '\n');
      process.exitCode = 1;
    });
}
