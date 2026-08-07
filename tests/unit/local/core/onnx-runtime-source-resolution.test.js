// src/local/core/onnx-runtime-source-resolution.js — explicit > managed >
// npm precedence, the symmetric env-patch contract, and
// prepareOnnxRuntimeProcessEnv()'s own PATH-prep/no-silent-fallback
// behavior. Every test injects fake fs functions and a fake env object —
// zero real filesystem access anywhere in this file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MANIFEST_SCHEMA_VERSION } from '../../../../src/local/core/managed-onnx-runtime-manifest.js';
import {
  resolveEffectiveOnnxRuntimePath,
  prepareOnnxRuntimeProcessEnv,
  applyOnnxRuntimeEnvPatch,
  resolveOnnxRuntimeForProcess,
} from '../../../../src/local/core/onnx-runtime-source-resolution.js';

const RUNTIMES_DIR = 'C:\\Users\\test\\AppData\\Local\\semidex\\runtimes';
const RUNTIME_ID = '1.26.0-cuda13';
const RUNTIME_DIR = `${RUNTIMES_DIR}\\onnxruntime-node-cuda\\${RUNTIME_ID}`;
const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const SHA256_C = 'c'.repeat(64);
const SHA256_D = 'd'.repeat(64);
const COMMIT = '8c546c37b43caaca1fa25db430dab94b901cf277';
const CUDNN_BIN = 'C:\\Program Files\\NVIDIA\\CUDNN\\v9.25\\bin\\13.4\\x64';

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
      'onnxruntime.dll': { sha256: SHA256_A, bytes: 100 },
      'onnxruntime_binding.node': { sha256: SHA256_B, bytes: 100 },
      'onnxruntime_providers_cuda.dll': { sha256: SHA256_C, bytes: 100 },
      'onnxruntime_providers_shared.dll': { sha256: SHA256_D, bytes: 100 },
    },
    dependencies: { cudnnBinPath: CUDNN_BIN },
    builtAt: '2026-08-06T00:00:00.000Z',
    buildHost: { platform: 'win32', nodeVersion: '25.2.1' },
    installerVersion: '2',
    verification: { status: 'unverified', verifiedAt: null, effectiveProvider: null },
    ...overrides,
  };
}

// A fake filesystem: manifest.json contents + a fixed sha256 per artifact
// file, keyed by absolute path — verifyManagedRuntimeOnDisk() hashes real
// bytes via readFileSyncFn, so artifactsMatchingManifest() below builds
// real buffers and rewrites the manifest's own sha256 fields to match.
import { createHash } from 'node:crypto';

function makeFakeFs({ manifest, artifactBytes = {}, cudnnDllPresent = true, cudnnDirExists = true } = {}) {
  const manifestPath = `${RUNTIME_DIR}\\manifest.json`;
  const files = new Map();
  if (manifest) files.set(manifestPath, JSON.stringify(manifest));
  for (const [name, buf] of Object.entries(artifactBytes)) {
    files.set(`${RUNTIME_DIR}\\${name}`, buf);
  }

  const existsSyncFn = (p) => {
    if (p === manifestPath) return files.has(p);
    if (p === CUDNN_BIN) return cudnnDirExists;
    return files.has(p);
  };
  const readFileSyncFn = (p, enc) => {
    if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
    const v = files.get(p);
    return enc === 'utf-8' && Buffer.isBuffer(v) ? v.toString('utf-8') : v;
  };
  const readdirSyncFn = (p) => {
    if (p === CUDNN_BIN) return cudnnDllPresent ? ['cudnn64_9.dll', 'other.dll'] : ['other.dll'];
    return [];
  };
  return { existsSyncFn, readFileSyncFn, readdirSyncFn };
}

function artifactsMatchingManifest(manifest) {
  // Build real buffers and rewrite the manifest's own sha256 fields to
  // match those buffers exactly, so verifyManagedRuntimeOnDisk() (real
  // sha256 over the injected readFileSyncFn's bytes) passes.
  const names = Object.keys(manifest.artifacts);
  const buffers = {};
  const artifacts = {};
  for (const name of names) {
    const buf = Buffer.from(`content-of-${name}`);
    buffers[name] = buf;
    artifacts[name] = { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  }
  return { buffers, manifest: { ...manifest, artifacts } };
}

describe('resolveEffectiveOnnxRuntimePath()', () => {
  it('explicit path wins over everything, even a valid managed selection', () => {
    const resolved = resolveEffectiveOnnxRuntimePath({
      explicitPath: 'D:\\custom\\onnxruntime-node',
      managedSelection: RUNTIME_ID,
      runtimesDir: RUNTIMES_DIR,
    });
    assert.deepEqual(resolved, {
      path: 'D:\\custom\\onnxruntime-node', source: 'explicit', managedId: null, cudnnBinPath: null,
    });
  });

  it('trims whitespace-only explicit path and treats it as unset', () => {
    const { manifest, buffers } = artifactsMatchingManifest(makeValidManifest());
    const fs = makeFakeFs({ manifest, artifactBytes: buffers });
    const resolved = resolveEffectiveOnnxRuntimePath({
      explicitPath: '   ',
      managedSelection: RUNTIME_ID,
      runtimesDir: RUNTIMES_DIR,
      ...fs,
    });
    assert.equal(resolved.source, 'managed');
  });

  it('falls through to npm when neither explicit nor managed is set — resolutionFailed must be absent, not just falsy, to distinguish this from a broken explicit selection', () => {
    const resolved = resolveEffectiveOnnxRuntimePath({
      explicitPath: '', managedSelection: '', runtimesDir: RUNTIMES_DIR,
    });
    assert.deepEqual(resolved, { path: '', source: 'npm', managedId: null, cudnnBinPath: null });
    assert.equal('resolutionFailed' in resolved, false);
  });

  it('a valid, intact managed selection resolves to the runtime dir with its cudnnBinPath', () => {
    const { manifest, buffers } = artifactsMatchingManifest(makeValidManifest());
    const fs = makeFakeFs({ manifest, artifactBytes: buffers });
    const resolved = resolveEffectiveOnnxRuntimePath({
      explicitPath: '', managedSelection: RUNTIME_ID, runtimesDir: RUNTIMES_DIR, ...fs,
    });
    assert.deepEqual(resolved, {
      path: RUNTIME_DIR, source: 'managed', managedId: RUNTIME_ID, cudnnBinPath: CUDNN_BIN,
    });
  });

  it('an invalid managed-runtime id format falls back to npm with a loud warning AND resolutionFailed:true — never silently (review finding, P1)', () => {
    const resolved = resolveEffectiveOnnxRuntimePath({
      explicitPath: '', managedSelection: 'not-a-valid-id', runtimesDir: RUNTIMES_DIR,
    });
    assert.equal(resolved.source, 'npm');
    assert.equal(resolved.path, '');
    assert.equal(resolved.managedId, null);
    assert.match(resolved.warning, /invalid\/corrupt/);
    assert.equal(resolved.resolutionFailed, true);
  });

  it('a missing manifest falls back to npm with a warning AND resolutionFailed:true', () => {
    const fs = makeFakeFs({ manifest: null });
    const resolved = resolveEffectiveOnnxRuntimePath({
      explicitPath: '', managedSelection: RUNTIME_ID, runtimesDir: RUNTIMES_DIR, ...fs,
    });
    assert.equal(resolved.source, 'npm');
    assert.match(resolved.warning, /invalid\/corrupt/);
    assert.equal(resolved.resolutionFailed, true);
  });

  it('a well-formed manifest with corrupted artifact bytes fails the integrity check, falls back to npm, and sets resolutionFailed:true', () => {
    const { manifest, buffers } = artifactsMatchingManifest(makeValidManifest());
    // Corrupt one artifact's on-disk bytes after the manifest was written
    // to record the ORIGINAL (correct) hash — simulates post-install disk
    // corruption/truncation.
    const corrupted = { ...buffers, 'onnxruntime.dll': Buffer.from('corrupted-bytes') };
    const fs = makeFakeFs({ manifest, artifactBytes: corrupted });
    const resolved = resolveEffectiveOnnxRuntimePath({
      explicitPath: '', managedSelection: RUNTIME_ID, runtimesDir: RUNTIMES_DIR, ...fs,
    });
    assert.equal(resolved.source, 'npm');
    assert.match(resolved.warning, /integrity check failed/);
    assert.match(resolved.warning, /checksum_mismatch/);
    assert.equal(resolved.resolutionFailed, true);
  });

  it('a schema-mismatched manifest (missing dependencies.cudnnBinPath) falls back to npm with resolutionFailed:true', () => {
    const badManifest = makeValidManifest();
    delete badManifest.dependencies;
    const fs = makeFakeFs({ manifest: badManifest });
    const resolved = resolveEffectiveOnnxRuntimePath({
      explicitPath: '', managedSelection: RUNTIME_ID, runtimesDir: RUNTIMES_DIR, ...fs,
    });
    assert.equal(resolved.source, 'npm');
    assert.match(resolved.warning, /schema_mismatch/);
    assert.equal(resolved.resolutionFailed, true);
  });
});

describe('prepareOnnxRuntimeProcessEnv()', () => {
  it('no-ops (ok:true) when resolved.cudnnBinPath is null (npm/explicit-without-cuDNN-dependency)', () => {
    const env = { PATH: 'C:\\Windows\\System32' };
    const result = prepareOnnxRuntimeProcessEnv({ path: '', cudnnBinPath: null }, { env });
    assert.deepEqual(result, { ok: true });
    assert.equal(env.PATH, 'C:\\Windows\\System32');
  });

  it('adds the cuDNN bin directory to env.PATH once, prepended, when everything checks out', () => {
    const env = { PATH: 'C:\\Windows\\System32' };
    const fs = makeFakeFs({ cudnnDirExists: true, cudnnDllPresent: true });
    const result = prepareOnnxRuntimeProcessEnv(
      { path: RUNTIME_DIR, cudnnBinPath: CUDNN_BIN },
      { env, existsSyncFn: fs.existsSyncFn, readdirSyncFn: fs.readdirSyncFn },
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(env.PATH, `${CUDNN_BIN};C:\\Windows\\System32`);
  });

  it('does not duplicate the cuDNN dir on a second call, case-insensitively', () => {
    const env = { PATH: 'C:\\Windows\\System32' };
    const fs = makeFakeFs({ cudnnDirExists: true, cudnnDllPresent: true });
    const deps = { env, existsSyncFn: fs.existsSyncFn, readdirSyncFn: fs.readdirSyncFn };
    prepareOnnxRuntimeProcessEnv({ path: RUNTIME_DIR, cudnnBinPath: CUDNN_BIN }, deps);
    prepareOnnxRuntimeProcessEnv({ path: RUNTIME_DIR, cudnnBinPath: CUDNN_BIN.toLowerCase() }, deps);
    const entries = env.PATH.split(';').filter((p) => p.toLowerCase() === CUDNN_BIN.toLowerCase());
    assert.equal(entries.length, 1);
  });

  it('rejects a non-absolute recorded cudnnBinPath with a clear diagnostic, never silently', () => {
    const env = { PATH: 'C:\\Windows\\System32' };
    const result = prepareOnnxRuntimeProcessEnv({ path: RUNTIME_DIR, cudnnBinPath: 'relative\\path' }, { env });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not an absolute path/);
    assert.equal(env.PATH, 'C:\\Windows\\System32');
  });

  it('returns a clear diagnostic (no silent fallback) when the recorded cuDNN directory no longer exists', () => {
    const env = { PATH: 'C:\\Windows\\System32' };
    const fs = makeFakeFs({ cudnnDirExists: false });
    const result = prepareOnnxRuntimeProcessEnv(
      { path: RUNTIME_DIR, cudnnBinPath: CUDNN_BIN },
      { env, existsSyncFn: fs.existsSyncFn, readdirSyncFn: fs.readdirSyncFn },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /no longer exists on disk/);
    assert.match(result.reason, /re-run the installer/);
    assert.equal(env.PATH, 'C:\\Windows\\System32');
  });

  it('returns a clear diagnostic when the cuDNN directory exists but has no cudnn64_*.dll', () => {
    const env = { PATH: 'C:\\Windows\\System32' };
    const fs = makeFakeFs({ cudnnDirExists: true, cudnnDllPresent: false });
    const result = prepareOnnxRuntimeProcessEnv(
      { path: RUNTIME_DIR, cudnnBinPath: CUDNN_BIN },
      { env, existsSyncFn: fs.existsSyncFn, readdirSyncFn: fs.readdirSyncFn },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /no longer contains a cudnn64_\*\.dll/);
  });

  it('propagates a readdir failure as a clear diagnostic instead of throwing', () => {
    const env = { PATH: 'C:\\Windows\\System32' };
    const result = prepareOnnxRuntimeProcessEnv(
      { path: RUNTIME_DIR, cudnnBinPath: CUDNN_BIN },
      { env, existsSyncFn: () => true, readdirSyncFn: () => { throw new Error('EACCES'); } },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /could not list the recorded cuDNN directory/);
  });
});

describe('applyOnnxRuntimeEnvPatch()', () => {
  it('sets both ONNXRUNTIME_NODE_PATH and ONNX_MANAGED_RUNTIME_ACTIVE for a managed resolution', () => {
    const env = {};
    applyOnnxRuntimeEnvPatch({ path: RUNTIME_DIR, source: 'managed', managedId: RUNTIME_ID }, { env });
    assert.equal(env.ONNXRUNTIME_NODE_PATH, RUNTIME_DIR);
    assert.equal(env.ONNX_MANAGED_RUNTIME_ACTIVE, RUNTIME_ID);
  });

  it('sets ONNXRUNTIME_NODE_PATH but NOT ONNX_MANAGED_RUNTIME_ACTIVE for an explicit resolution', () => {
    const env = {};
    applyOnnxRuntimeEnvPatch({ path: 'D:\\custom', source: 'explicit', managedId: null }, { env });
    assert.equal(env.ONNXRUNTIME_NODE_PATH, 'D:\\custom');
    assert.equal('ONNX_MANAGED_RUNTIME_ACTIVE' in env, false);
  });

  it('deletes both keys for an npm resolution, never leaving a stale value from a prior call', () => {
    const env = { ONNXRUNTIME_NODE_PATH: 'D:\\stale', ONNX_MANAGED_RUNTIME_ACTIVE: 'stale-id' };
    applyOnnxRuntimeEnvPatch({ path: '', source: 'npm', managedId: null }, { env });
    assert.equal('ONNXRUNTIME_NODE_PATH' in env, false);
    assert.equal('ONNX_MANAGED_RUNTIME_ACTIVE' in env, false);
  });

  it('a genuinely-explicit resolution re-writes the identical value it read rather than deleting it', () => {
    const env = { ONNXRUNTIME_NODE_PATH: 'D:\\already-set' };
    applyOnnxRuntimeEnvPatch({ path: 'D:\\already-set', source: 'explicit', managedId: null }, { env });
    assert.equal(env.ONNXRUNTIME_NODE_PATH, 'D:\\already-set');
  });

  it('switching from managed to npm across two calls on the same env object clears the stale managed id', () => {
    const env = {};
    applyOnnxRuntimeEnvPatch({ path: RUNTIME_DIR, source: 'managed', managedId: RUNTIME_ID }, { env });
    applyOnnxRuntimeEnvPatch({ path: '', source: 'npm', managedId: null }, { env });
    assert.equal('ONNXRUNTIME_NODE_PATH' in env, false);
    assert.equal('ONNX_MANAGED_RUNTIME_ACTIVE' in env, false);
  });
});

// resolveOnnxRuntimeForProcess() — review finding (P1): every real
// composition root (indexer, Admin, and — the actual bug — MCP) must go
// through the EXACT same read-settings -> resolve -> apply -> prepare
// sequence, so a managed CUDA selection can never silently have no
// effect in one process while working in another. These tests prove the
// function's own composition (which sub-functions it calls, with which
// arguments, in what order) using fully injected fakes — no real fs,
// no real settingsService, no real env.
describe('resolveOnnxRuntimeForProcess()', () => {
  function fakeSettingsService(values) {
    return { getActiveValue: (key) => values[key] ?? '' };
  }

  it('reads ONNXRUNTIME_NODE_PATH and ONNX_MANAGED_RUNTIME from settingsService.getActiveValue(), never a raw env read', () => {
    const calls = [];
    const settingsService = {
      getActiveValue: (key) => { calls.push(key); return ''; },
    };
    resolveOnnxRuntimeForProcess({
      settingsService, env: {},
      resolveSemidexHomePathsFn: () => ({ runtimesDir: 'C:\\fake\\runtimes' }),
    });
    assert.ok(calls.includes('ONNXRUNTIME_NODE_PATH'));
    assert.ok(calls.includes('ONNX_MANAGED_RUNTIME'));
  });

  it('threads explicitPath/managedSelection/runtimesDir into resolveEffectiveOnnxRuntimePathFn exactly as read', () => {
    const settingsService = fakeSettingsService({ ONNXRUNTIME_NODE_PATH: 'D:\\explicit-path', ONNX_MANAGED_RUNTIME: '1.26.0-cuda13' });
    let receivedArgs = null;
    resolveOnnxRuntimeForProcess({
      settingsService, env: {},
      resolveSemidexHomePathsFn: () => ({ runtimesDir: 'C:\\fake\\runtimes' }),
      resolveEffectiveOnnxRuntimePathFn: (args) => { receivedArgs = args; return { path: '', source: 'npm', managedId: null, cudnnBinPath: null }; },
    });
    assert.equal(receivedArgs.explicitPath, 'D:\\explicit-path');
    assert.equal(receivedArgs.managedSelection, '1.26.0-cuda13');
    assert.equal(receivedArgs.runtimesDir, 'C:\\fake\\runtimes');
  });

  it('always calls applyOnnxRuntimeEnvPatchFn with the resolved result and the SAME env object it was given', () => {
    const settingsService = fakeSettingsService({});
    const env = { PATH: 'C:\\Windows' };
    let patchedResolved = null;
    let patchedEnv = null;
    const resolved = { path: RUNTIME_DIR, source: 'managed', managedId: RUNTIME_ID, cudnnBinPath: null };
    resolveOnnxRuntimeForProcess({
      settingsService, env,
      resolveSemidexHomePathsFn: () => ({ runtimesDir: RUNTIMES_DIR }),
      resolveEffectiveOnnxRuntimePathFn: () => resolved,
      applyOnnxRuntimeEnvPatchFn: (r, opts) => { patchedResolved = r; patchedEnv = opts.env; },
      prepareOnnxRuntimeProcessEnvFn: () => ({ ok: true }),
    });
    assert.equal(patchedResolved, resolved);
    assert.equal(patchedEnv, env);
  });

  it('always calls prepareOnnxRuntimeProcessEnvFn with the resolved result and returns its outcome verbatim as `prepared`', () => {
    const settingsService = fakeSettingsService({});
    const preparedResult = { ok: false, reason: 'recorded cuDNN directory no longer exists' };
    const result = resolveOnnxRuntimeForProcess({
      settingsService, env: {},
      resolveSemidexHomePathsFn: () => ({ runtimesDir: RUNTIMES_DIR }),
      resolveEffectiveOnnxRuntimePathFn: () => ({ path: RUNTIME_DIR, source: 'managed', managedId: RUNTIME_ID, cudnnBinPath: CUDNN_BIN }),
      applyOnnxRuntimeEnvPatchFn: () => {},
      prepareOnnxRuntimeProcessEnvFn: () => preparedResult,
    });
    assert.equal(result.prepared, preparedResult);
  });

  it('surfaces resolved.warning as resolutionWarning, and null when there is none', () => {
    const settingsService = fakeSettingsService({});
    const withWarning = resolveOnnxRuntimeForProcess({
      settingsService, env: {},
      resolveSemidexHomePathsFn: () => ({ runtimesDir: RUNTIMES_DIR }),
      resolveEffectiveOnnxRuntimePathFn: () => ({ path: '', source: 'npm', managedId: null, cudnnBinPath: null, warning: 'managed runtime selected but invalid/corrupt: x' }),
      applyOnnxRuntimeEnvPatchFn: () => {},
      prepareOnnxRuntimeProcessEnvFn: () => ({ ok: true }),
    });
    assert.equal(withWarning.resolutionWarning, 'managed runtime selected but invalid/corrupt: x');

    const withoutWarning = resolveOnnxRuntimeForProcess({
      settingsService, env: {},
      resolveSemidexHomePathsFn: () => ({ runtimesDir: RUNTIMES_DIR }),
      resolveEffectiveOnnxRuntimePathFn: () => ({ path: '', source: 'npm', managedId: null, cudnnBinPath: null }),
      applyOnnxRuntimeEnvPatchFn: () => {},
      prepareOnnxRuntimeProcessEnvFn: () => ({ ok: true }),
    });
    assert.equal(withoutWarning.resolutionWarning, null);
  });

  it('end-to-end with the REAL sub-functions (no fakes for resolve/apply/prepare): an explicitly selected managed runtime that fails integrity verification (corrupt artifacts) produces prepared.ok=false — review finding (P1): never silently falls back to npm/CPU as if the failure were healthy', () => {
    const settingsService = fakeSettingsService({ ONNX_MANAGED_RUNTIME: RUNTIME_ID });
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION, ortVersion: '1.26.0', cudaMajor: '13', platform: 'win32', arch: 'x64',
      provenance: { sourceRepository: 'x', sourceTag: 'v1.26.0', sourceCommit: COMMIT, runtimeAssetUrl: 'x', runtimeAssetSha256: SHA256_A, checksumTrust: 'locked' },
      artifacts: {
        'onnxruntime.dll': { sha256: SHA256_A, bytes: 1 }, 'onnxruntime_binding.node': { sha256: SHA256_B, bytes: 1 },
        'onnxruntime_providers_cuda.dll': { sha256: SHA256_C, bytes: 1 }, 'onnxruntime_providers_shared.dll': { sha256: SHA256_D, bytes: 1 },
      },
      dependencies: { cudnnBinPath: CUDNN_BIN },
      builtAt: 'x', buildHost: { platform: 'win32', nodeVersion: 'x' }, installerVersion: '2',
      verification: { status: 'unverified', verifiedAt: null, effectiveProvider: null },
    };
    const manifestPath = `${RUNTIME_DIR}\\manifest.json`;
    // manifest exists but no artifact files exist on this fake disk (an
    // integrity-check failure — corrupt/missing artifacts), never reached
    // far enough to check the cuDNN dir at all.
    const existsSyncFn = (p) => p === manifestPath;
    const readFileSyncFn = (p, enc) => (p === manifestPath ? (enc === 'utf-8' ? JSON.stringify(manifest) : Buffer.from(JSON.stringify(manifest))) : (() => { throw new Error('ENOENT'); })());
    const result = resolveOnnxRuntimeForProcess({
      settingsService, env: { PATH: 'C:\\Windows' },
      resolveSemidexHomePathsFn: () => ({ runtimesDir: RUNTIMES_DIR }),
      resolveEffectiveOnnxRuntimePathFn: (args) => resolveEffectiveOnnxRuntimePath({ ...args, readFileSyncFn, existsSyncFn }),
      prepareOnnxRuntimeProcessEnvFn: (resolved, opts) => prepareOnnxRuntimeProcessEnv(resolved, { ...opts, existsSyncFn }),
    });
    assert.equal(result.resolved.source, 'npm', 'the artifact-integrity failure means resolveEffectiveOnnxRuntimePath() itself reports source: npm as its OWN internal bookkeeping');
    assert.match(result.resolutionWarning, /invalid\/corrupt/);
    // The actual review finding: prepared.ok must be false here — an
    // explicit managed selection that failed resolution must never be
    // treated as equivalent to "no selection made, plain npm is fine".
    assert.equal(result.prepared.ok, false, 'an explicitly selected but broken managed runtime must produce prepared.ok:false, not a silent healthy npm fallback');
    assert.match(result.prepared.reason, /invalid\/corrupt/);
  });

  it('resolved.resolutionFailed folds into prepared.ok:false — the exact mechanism that closes the silent-fallback gap (review finding, P1)', () => {
    const settingsService = fakeSettingsService({ ONNX_MANAGED_RUNTIME: 'not-a-valid-id' });
    let prepareFnCalled = false;
    const result = resolveOnnxRuntimeForProcess({
      settingsService, env: {},
      resolveSemidexHomePathsFn: () => ({ runtimesDir: RUNTIMES_DIR }),
      resolveEffectiveOnnxRuntimePathFn: () => ({
        path: '', source: 'npm', managedId: null, cudnnBinPath: null, resolutionFailed: true,
        warning: 'managed runtime selected but invalid/corrupt: invalid managed runtime id "not-a-valid-id"',
      }),
      applyOnnxRuntimeEnvPatchFn: () => {},
      // Must NOT be called at all — resolutionFailed short-circuits
      // straight to prepared:{ok:false}, since there is nothing
      // meaningful left to "prepare" for a selection that never resolved
      // to a real runtime in the first place.
      prepareOnnxRuntimeProcessEnvFn: () => { prepareFnCalled = true; return { ok: true }; },
    });
    assert.equal(result.prepared.ok, false);
    assert.equal(result.prepared.reason, 'managed runtime selected but invalid/corrupt: invalid managed runtime id "not-a-valid-id"');
    assert.equal(prepareFnCalled, false, 'prepareOnnxRuntimeProcessEnvFn must be skipped entirely once resolutionFailed is true');
  });

  it('a genuine "no managed runtime selected" npm default (resolutionFailed absent) still resolves prepared.ok:true — this fix must not turn EVERY npm resolution into a failure', () => {
    const settingsService = fakeSettingsService({}); // no ONNX_MANAGED_RUNTIME set at all
    const result = resolveOnnxRuntimeForProcess({
      settingsService, env: {},
      resolveSemidexHomePathsFn: () => ({ runtimesDir: RUNTIMES_DIR }),
      resolveEffectiveOnnxRuntimePathFn: () => ({ path: '', source: 'npm', managedId: null, cudnnBinPath: null }),
      applyOnnxRuntimeEnvPatchFn: () => {},
      prepareOnnxRuntimeProcessEnvFn: () => ({ ok: true }),
    });
    assert.equal(result.prepared.ok, true);
    assert.equal(result.resolutionWarning, null);
  });
});
