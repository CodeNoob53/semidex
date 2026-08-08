// src/local/core/onnx-cuda-installer-logic.js — every pure decision the
// PowerShell installer makes: trust-gate resolution, idempotent-skip
// comparison, and the transactional-swap state machine (BOTH branches:
// reinstall-with-backup and first-install-with-no-backup). No real fs/
// network/process access anywhere in this file — every input is a plain
// argument or an injected fake.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTrustGate,
  shouldSkipRebuild,
  planTransactionalSwapStep,
  assertSameVolume,
  buildManifestDraft,
  applyOrtNodeSecurityPolicy,
  ORT_NODE_SECURITY_POLICY,
  dispatch,
} from '../../../../src/local/core/onnx-cuda-installer-logic.js';

const LOCKED_COMMIT = '8c546c37b43caaca1fa25db430dab94b901cf277';
const LOCKED_SHA256 = '4fa096030ee766b2e590d71fb6676bbd00595c92ab87acf497fe075e98834d8b';
const LOCK_ENTRIES = [{
  ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64',
  sourceCommit: LOCKED_COMMIT,
  runtimeAssetUrl: 'https://github.com/microsoft/onnxruntime/releases/download/v1.26.0/onnxruntime-win-x64-gpu_cuda13-1.26.0.zip',
  runtimeAssetSha256: LOCKED_SHA256,
}];
const CUSTOM_COMMIT = 'a'.repeat(40);
const CUSTOM_SHA256 = 'b'.repeat(64);

describe('applyOrtNodeSecurityPolicy()', () => {
  it('pins the audited direct and transitive dependencies without mutating input', () => {
    const manifest = {
      name: 'onnxruntime-node',
      dependencies: { 'adm-zip': '^0.5.16', long: '^5.2.3' },
      devDependencies: { protobufjs: '^7.2.4', typescript: '^5.0.0' },
      overrides: { existing: '1.0.0' },
    };
    const result = applyOrtNodeSecurityPolicy(manifest, {
      ortVersion: ORT_NODE_SECURITY_POLICY.ortVersion,
      sourceCommit: ORT_NODE_SECURITY_POLICY.sourceCommit,
    });
    assert.equal(result.dependencies['adm-zip'], ORT_NODE_SECURITY_POLICY.admZip);
    assert.equal(result.devDependencies.protobufjs, ORT_NODE_SECURITY_POLICY.protobufjs);
    assert.equal(result.overrides.tar, ORT_NODE_SECURITY_POLICY.tar);
    assert.equal(result.dependencies.long, '^5.2.3');
    assert.equal(result.overrides.existing, '1.0.0');
    assert.equal(manifest.dependencies['adm-zip'], '^0.5.16');
    assert.equal(manifest.overrides.tar, undefined);
  });

  it('rejects a malformed manifest', () => {
    assert.throws(() => applyOrtNodeSecurityPolicy(null), /must be an object/);
    assert.throws(() => applyOrtNodeSecurityPolicy([]), /must be an object/);
  });

  it('rejects unreviewed ORT versions and source commits', () => {
    const manifest = { dependencies: {}, devDependencies: {} };
    assert.throws(
      () => applyOrtNodeSecurityPolicy(manifest, {
        ortVersion: '1.27.0',
        sourceCommit: ORT_NODE_SECURITY_POLICY.sourceCommit,
      }),
      /no reviewed ORT js\/node dependency policy/,
    );
  });
});

describe('resolveTrustGate() — locked combination', () => {
  it('uses the lock entry\'s own commit/checksum, marks checksumTrust "locked"', () => {
    const result = resolveTrustGate({ ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES });
    assert.deepEqual(result, {
      ok: true, checksumTrust: 'locked', sourceCommit: LOCKED_COMMIT,
      runtimeAssetSha256: LOCKED_SHA256,
      runtimeAssetUrl: LOCK_ENTRIES[0].runtimeAssetUrl,
      requiresInteractiveConfirmation: false,
    });
  });

  it('ignores a caller-supplied -ExpectedSourceCommit/-ExpectedSha256 that MATCH the locked values (no conflict, no error)', () => {
    const result = resolveTrustGate({
      ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      expectedSourceCommit: LOCKED_COMMIT, expectedSha256: LOCKED_SHA256,
    });
    assert.equal(result.ok, true);
    assert.equal(result.checksumTrust, 'locked');
  });

  it('rejects a caller-supplied -ExpectedSourceCommit that conflicts with the locked commit — locked entry always wins, never silently overridden', () => {
    const result = resolveTrustGate({
      ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      expectedSourceCommit: CUSTOM_COMMIT,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /conflicts with the locked commit/);
  });

  it('rejects a caller-supplied -ExpectedSha256 that conflicts with the locked checksum', () => {
    const result = resolveTrustGate({
      ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      expectedSha256: CUSTOM_SHA256,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /conflicts with the locked checksum/);
  });
});

describe('resolveTrustGate() — non-locked combination', () => {
  it('hard-errors when -ExpectedSourceCommit is missing, before any other check, regardless of other flags', () => {
    const result = resolveTrustGate({
      ortVersion: '2.0.0', cudaMajor: '12', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      expectedSha256: CUSTOM_SHA256, allowUnverifiedDownload: true, nonInteractive: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /-ExpectedSourceCommit is required/);
  });

  it('-AllowUnverifiedDownload never substitutes for -ExpectedSourceCommit, even with -NonInteractive also set', () => {
    const result = resolveTrustGate({
      ortVersion: '2.0.0', cudaMajor: '12', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      allowUnverifiedDownload: true, nonInteractive: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /-ExpectedSourceCommit is required/);
  });

  it('rejects a malformed (not 40-hex) -ExpectedSourceCommit', () => {
    const result = resolveTrustGate({
      ortVersion: '2.0.0', cudaMajor: '12', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      expectedSourceCommit: 'not-a-commit', expectedSha256: CUSTOM_SHA256,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /40-hex-char git commit SHA/);
  });

  it('with a valid commit AND a valid -ExpectedSha256: resolves ok, checksumTrust "user_confirmed_unverified", no interactive confirmation needed', () => {
    const result = resolveTrustGate({
      ortVersion: '2.0.0', cudaMajor: '12', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      expectedSourceCommit: CUSTOM_COMMIT, expectedSha256: CUSTOM_SHA256,
    });
    assert.deepEqual(result, {
      ok: true, checksumTrust: 'user_confirmed_unverified',
      sourceCommit: CUSTOM_COMMIT, runtimeAssetSha256: CUSTOM_SHA256, runtimeAssetUrl: null,
      requiresInteractiveConfirmation: false,
    });
  });

  it('rejects a malformed (not 64-hex) -ExpectedSha256', () => {
    const result = resolveTrustGate({
      ortVersion: '2.0.0', cudaMajor: '12', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      expectedSourceCommit: CUSTOM_COMMIT, expectedSha256: 'not-a-hash',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /64-hex-char SHA-256/);
  });

  it('with a valid commit but NEITHER -ExpectedSha256 NOR -AllowUnverifiedDownload: hard error, nothing downloaded', () => {
    const result = resolveTrustGate({
      ortVersion: '2.0.0', cudaMajor: '12', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      expectedSourceCommit: CUSTOM_COMMIT,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /-ExpectedSha256|-AllowUnverifiedDownload/);
  });

  it('-AllowUnverifiedDownload without -NonInteractive: ok, but requires an interactive confirmation before downloading', () => {
    const result = resolveTrustGate({
      ortVersion: '2.0.0', cudaMajor: '12', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      expectedSourceCommit: CUSTOM_COMMIT, allowUnverifiedDownload: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.checksumTrust, 'user_confirmed_unverified');
    assert.equal(result.runtimeAssetSha256, null);
    assert.equal(result.requiresInteractiveConfirmation, true);
  });

  it('-AllowUnverifiedDownload WITH -NonInteractive: ok, proceeds without any interactive confirmation', () => {
    const result = resolveTrustGate({
      ortVersion: '2.0.0', cudaMajor: '12', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
      expectedSourceCommit: CUSTOM_COMMIT, allowUnverifiedDownload: true, nonInteractive: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.requiresInteractiveConfirmation, false);
  });
});

describe('shouldSkipRebuild()', () => {
  const requested = {
    ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64',
    sourceCommit: LOCKED_COMMIT, runtimeAssetSha256: LOCKED_SHA256, installerVersion: '2',
  };

  it('no existing manifest -> full rebuild', () => {
    const result = shouldSkipRebuild({
      existingManifest: null, isManifestWellFormedFn: () => true, verifyOnDiskFn: () => ({ ok: true }), requested,
    });
    assert.deepEqual(result, { shouldSkip: false, reason: 'no existing manifest' });
  });

  it('existing manifest not well-formed -> full rebuild', () => {
    const result = shouldSkipRebuild({
      existingManifest: {}, isManifestWellFormedFn: () => false, verifyOnDiskFn: () => ({ ok: true }), requested,
    });
    assert.equal(result.shouldSkip, false);
    assert.match(result.reason, /not well-formed/);
  });

  it('all identity fields match AND on-disk integrity passes -> skip', () => {
    const existingManifest = {
      ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64', installerVersion: '2',
      provenance: { sourceCommit: LOCKED_COMMIT, runtimeAssetSha256: LOCKED_SHA256 },
    };
    const result = shouldSkipRebuild({
      existingManifest, isManifestWellFormedFn: () => true, verifyOnDiskFn: () => ({ ok: true }), requested,
    });
    assert.deepEqual(result, { shouldSkip: true });
  });

  it('a single differing field (e.g. installerVersion) -> full rebuild, even if everything else matches', () => {
    const existingManifest = {
      ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64', installerVersion: '1',
      provenance: { sourceCommit: LOCKED_COMMIT, runtimeAssetSha256: LOCKED_SHA256 },
    };
    const result = shouldSkipRebuild({
      existingManifest, isManifestWellFormedFn: () => true, verifyOnDiskFn: () => ({ ok: true }), requested,
    });
    assert.equal(result.shouldSkip, false);
    assert.match(result.reason, /identity fields differ/);
  });

  it('fields match but the fresh on-disk integrity check fails (post-install corruption) -> full rebuild', () => {
    const existingManifest = {
      ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64', installerVersion: '2',
      provenance: { sourceCommit: LOCKED_COMMIT, runtimeAssetSha256: LOCKED_SHA256 },
    };
    const result = shouldSkipRebuild({
      existingManifest, isManifestWellFormedFn: () => true, verifyOnDiskFn: () => ({ ok: false }), requested,
    });
    assert.equal(result.shouldSkip, false);
    assert.match(result.reason, /integrity check failed/);
  });

  it('an unverified requested install (runtimeAssetSha256: null) is never skip-eligible, even with matching fields', () => {
    const existingManifest = {
      ortVersion: '2.0.0', cudaMajor: '12', platform: 'win32', arch: 'x64', installerVersion: '2',
      provenance: { sourceCommit: CUSTOM_COMMIT, runtimeAssetSha256: 'anything' },
    };
    const unverifiedRequested = { ...requested, ortVersion: '2.0.0', cudaMajor: '12', sourceCommit: CUSTOM_COMMIT, runtimeAssetSha256: null };
    const result = shouldSkipRebuild({
      existingManifest, isManifestWellFormedFn: () => true, verifyOnDiskFn: () => ({ ok: true }), requested: unverifiedRequested,
    });
    assert.equal(result.shouldSkip, false);
  });
});

describe('planTransactionalSwapStep() — before_swap', () => {
  it('reinstall (hadExistingTarget: true): backs up target before renaming installStage in', () => {
    const result = planTransactionalSwapStep('before_swap', { hadExistingTarget: true });
    assert.deepEqual(result, { actions: ['rename_target_to_backup', 'rename_install_stage_to_target'], terminal: null });
  });

  it('first install (hadExistingTarget: false): no backup rename attempted', () => {
    const result = planTransactionalSwapStep('before_swap', { hadExistingTarget: false });
    assert.deepEqual(result, { actions: ['rename_install_stage_to_target'], terminal: null });
  });
});

describe('planTransactionalSwapStep() — after_probe', () => {
  it('reinstall, probe succeeds: deletes backup, terminal success', () => {
    const result = planTransactionalSwapStep('after_probe', { hadExistingTarget: true, probeOk: true });
    assert.deepEqual(result, { actions: ['delete_backup'], terminal: 'success' });
  });

  it('first install, probe succeeds: no backup to delete, terminal success', () => {
    const result = planTransactionalSwapStep('after_probe', { hadExistingTarget: false, probeOk: true });
    assert.deepEqual(result, { actions: [], terminal: 'success' });
  });

  it('reinstall, probe FAILS: renames broken target aside, restores backup, terminal failure', () => {
    const result = planTransactionalSwapStep('after_probe', { hadExistingTarget: true, probeOk: false });
    assert.deepEqual(result, { actions: ['rename_target_to_failed', 'rename_backup_to_target'], terminal: 'failure' });
  });

  it('first install, probe FAILS (no backup exists): renames broken target aside, target left absent, terminal failure', () => {
    const result = planTransactionalSwapStep('after_probe', { hadExistingTarget: false, probeOk: false });
    assert.deepEqual(result, { actions: ['rename_target_to_failed'], terminal: 'failure' });
  });

  it('-SkipProbe, reinstall: completes without rollback (no probe ran to fail), deletes backup, terminal success', () => {
    const result = planTransactionalSwapStep('after_probe', { hadExistingTarget: true, skipProbe: true });
    assert.deepEqual(result, { actions: ['delete_backup'], terminal: 'success' });
  });

  it('-SkipProbe, first install: completes, nothing to delete, terminal success', () => {
    const result = planTransactionalSwapStep('after_probe', { hadExistingTarget: false, skipProbe: true });
    assert.deepEqual(result, { actions: [], terminal: 'success' });
  });
});

describe('planTransactionalSwapStep() — rename_failure', () => {
  it('a rename itself fails, reinstall: restores backup to target if present', () => {
    const result = planTransactionalSwapStep('rename_failure', { hadExistingTarget: true });
    assert.deepEqual(result, { actions: ['rename_backup_to_target_if_present'], terminal: 'failure' });
  });

  it('a rename itself fails, first install: nothing to restore', () => {
    const result = planTransactionalSwapStep('rename_failure', { hadExistingTarget: false });
    assert.deepEqual(result, { actions: [], terminal: 'failure' });
  });
});

describe('planTransactionalSwapStep() — unknown step', () => {
  it('throws for an unrecognized step name rather than silently no-op-ing', () => {
    assert.throws(() => planTransactionalSwapStep('bogus_step', { hadExistingTarget: true }), /unknown transactional swap step/);
  });
});

describe('assertSameVolume()', () => {
  it('same volume root (case-insensitive) -> ok', () => {
    assert.deepEqual(assertSameVolume('C:', 'c:'), { ok: true });
  });

  it('different volume roots -> loud error, not a silent cross-volume rename attempt', () => {
    const result = assertSameVolume('C:', 'D:');
    assert.equal(result.ok, false);
    assert.match(result.reason, /different volumes/);
  });
});

describe('dispatch() — the CLI entry\'s own decode/routing layer, with injected fakes (zero real fs)', () => {
  it('resolveTrustGate: routes input straight through', async () => {
    const result = await dispatch('resolveTrustGate', {
      ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64', lockEntries: LOCK_ENTRIES,
    });
    assert.equal(result.ok, true);
    assert.equal(result.checksumTrust, 'locked');
  });

  it('shouldSkipRebuild: reads the manifest via the injected fake, feeds it through isManifestWellFormedFn/verifyManagedRuntimeOnDiskFn', async () => {
    const existingManifest = {
      ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64', installerVersion: '2',
      provenance: { sourceCommit: LOCKED_COMMIT, runtimeAssetSha256: LOCKED_SHA256 },
    };
    const result = await dispatch('shouldSkipRebuild', {
      requestedRuntimeDir: 'C:\\fake\\1.26.0-cuda13',
      requested: {
        ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64',
        sourceCommit: LOCKED_COMMIT, runtimeAssetSha256: LOCKED_SHA256, installerVersion: '2',
      },
    }, {
      readManagedRuntimeManifestFn: () => ({ ok: true, manifest: existingManifest }),
      isManifestWellFormedFn: () => true,
      verifyManagedRuntimeOnDiskFn: () => ({ ok: true }),
    });
    assert.deepEqual(result, { shouldSkip: true });
  });

  it('shouldSkipRebuild: a "manifest not found" read result correctly maps to existingManifest: null -> full rebuild', async () => {
    const result = await dispatch('shouldSkipRebuild', {
      requestedRuntimeDir: 'C:\\fake\\1.26.0-cuda13',
      requested: { ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64', sourceCommit: LOCKED_COMMIT, runtimeAssetSha256: LOCKED_SHA256, installerVersion: '2' },
    }, {
      readManagedRuntimeManifestFn: () => ({ ok: false, reason: 'not_found' }),
    });
    assert.deepEqual(result, { shouldSkip: false, reason: 'no existing manifest' });
  });

  it('planTransactionalSwapStep: routes step/state straight through', async () => {
    const result = await dispatch('planTransactionalSwapStep', { step: 'before_swap', state: { hadExistingTarget: false } });
    assert.deepEqual(result, { actions: ['rename_install_stage_to_target'], terminal: null });
  });

  it('assertSameVolume: routes straight through', async () => {
    const result = await dispatch('assertSameVolume', { installStageVolumeRoot: 'C:', targetVolumeRoot: 'C:' });
    assert.deepEqual(result, { ok: true });
  });

  it('applyOrtNodeSecurityPolicy: returns the audited manifest through the JSON boundary', async () => {
    const result = await dispatch('applyOrtNodeSecurityPolicy', {
      manifest: { dependencies: { 'adm-zip': '^0.5.16' }, devDependencies: { protobufjs: '^7.2.4' } },
      ortVersion: ORT_NODE_SECURITY_POLICY.ortVersion,
      sourceCommit: ORT_NODE_SECURITY_POLICY.sourceCommit,
    });
    assert.equal(result.dependencies['adm-zip'], ORT_NODE_SECURITY_POLICY.admZip);
    assert.equal(result.devDependencies.protobufjs, ORT_NODE_SECURITY_POLICY.protobufjs);
    assert.equal(result.overrides.tar, ORT_NODE_SECURITY_POLICY.tar);
  });

  it('an unknown decision name throws, rather than silently returning an empty/undefined result', async () => {
    await assert.rejects(() => dispatch('not_a_real_decision', {}), /unknown installer decision/);
  });
});

describe('buildManifestDraft()', () => {
  it('always starts verification.status as "unverified", regardless of checksumTrust', () => {
    const draft = buildManifestDraft({
      ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64',
      sourceRepository: 'https://github.com/microsoft/onnxruntime.git', sourceTag: 'v1.26.0', sourceCommit: LOCKED_COMMIT,
      runtimeAssetUrl: LOCK_ENTRIES[0].runtimeAssetUrl, runtimeAssetSha256: LOCKED_SHA256, checksumTrust: 'locked',
      artifacts: { 'onnxruntime.dll': { sha256: 'a'.repeat(64), bytes: 100 } },
      cudnnBinPath: 'C:\\cudnn\\bin', builtAt: '2026-08-07T00:00:00.000Z', nodeVersion: '25.2.1',
    });
    assert.deepEqual(draft.verification, { status: 'unverified', verifiedAt: null, effectiveProvider: null });
    assert.equal(draft.dependencies.cudnnBinPath, 'C:\\cudnn\\bin');
    assert.equal(draft.provenance.checksumTrust, 'locked');
    assert.equal(draft.installerVersion, '2');
  });
});
