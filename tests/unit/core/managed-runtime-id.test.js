// src/local/core/managed-runtime-id.js — strict managed-runtime ID
// validation and path-traversal-safe resolution. No real fs access
// anywhere here; every case operates purely on strings/paths.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// managed-runtime-id.js deliberately uses the OS-native node:path
// (join/resolve/relative/isAbsolute) — its real callers resolve
// runtimesDir via semidex-home.js's resolveSemidexHomePaths(), which is
// itself platform-aware (accepts an explicit `platform`, derives the app
// data dir accordingly for whichever OS Node actually runs on), so this
// module must correctly join/resolve whatever absolute-path SHAPE the
// current OS produces — never assume Windows specifically. These tests
// therefore use `join`/`resolve`/`sep` from the OS-native node:path too
// (never path.win32), and build runtimesDir with `resolve()` rather than
// a literal 'C:' drive prefix: 'C:' is only an absolute-path root under
// win32 semantics — under posix semantics (e.g. a Linux CI runner) it is
// just a relative directory NAMED "C:", so a literal 'C:' fixture used to
// silently produce a DIFFERENT relative, cwd-anchored path with each
// OS-native join() consistently, on both sides of every assertion (the
// module and the test call the identical join()/resolve() from the same
// node:path import) — the bug this fixture change closes was purely that
// 'C:' doesn't mean the same thing on both platforms, not any
// join/resolve mismatch between the module and the test.
import { join, resolve as resolvePath, sep } from 'node:path';
import {
  isValidManagedRuntimeId,
  resolveManagedRuntimePathSafe,
  resolveManagedRuntimeChildPathSafe,
} from '../../../src/local/core/managed-runtime-id.js';

describe('isValidManagedRuntimeId()', () => {
  it('accepts the exact <ortVersion>-cuda<cudaMajor> shape', () => {
    assert.equal(isValidManagedRuntimeId('1.26.0-cuda13'), true);
    assert.equal(isValidManagedRuntimeId('2.0.1-cuda12'), true);
  });

  it('rejects a bare tag/version with no cuda suffix', () => {
    assert.equal(isValidManagedRuntimeId('1.26.0'), false);
  });

  it('rejects embedded path separators', () => {
    assert.equal(isValidManagedRuntimeId('1.26.0-cuda13/../../etc'), false);
    assert.equal(isValidManagedRuntimeId('1.26.0-cuda13\\..\\..\\etc'), false);
  });

  it('rejects a traversal-only payload disguised with a valid-looking prefix', () => {
    assert.equal(isValidManagedRuntimeId('1.0.0-cuda1/../../../etc'), false);
  });

  it('rejects non-string input without throwing', () => {
    assert.equal(isValidManagedRuntimeId(null), false);
    assert.equal(isValidManagedRuntimeId(undefined), false);
    assert.equal(isValidManagedRuntimeId(42), false);
    assert.equal(isValidManagedRuntimeId({}), false);
  });

  it('rejects an empty string', () => {
    assert.equal(isValidManagedRuntimeId(''), false);
  });
});

describe('resolveManagedRuntimePathSafe()', () => {
  const runtimesDir = resolvePath(join('semidex-home', 'runtimes'));

  it('resolves a valid id to the expected path', () => {
    const result = resolveManagedRuntimePathSafe(runtimesDir, '1.26.0-cuda13');
    assert.equal(result, join(runtimesDir, 'onnxruntime-node-cuda', '1.26.0-cuda13'));
  });

  it('throws for an invalid id (format alone)', () => {
    assert.throws(() => resolveManagedRuntimePathSafe(runtimesDir, 'not-an-id'), /invalid managed runtime id/);
  });

  it('throws for a traversal-shaped id even though the regex should already reject it (defense in depth)', () => {
    assert.throws(() => resolveManagedRuntimePathSafe(runtimesDir, '1.0.0-cuda1/../../../etc'), /invalid managed runtime id/);
  });

  it('never resolves outside the onnxruntime-node-cuda tree for any valid-format id', () => {
    const result = resolveManagedRuntimePathSafe(runtimesDir, '1.26.0-cuda13');
    assert.ok(result.startsWith(join(runtimesDir, 'onnxruntime-node-cuda') + sep));
  });
});

describe('resolveManagedRuntimeChildPathSafe()', () => {
  const runtimesDir = resolvePath(join('semidex-home', 'runtimes'));

  it('accepts a valid installStage name', () => {
    const result = resolveManagedRuntimeChildPathSafe(runtimesDir, 'install-stage-1234567890', 'installStage');
    assert.equal(result, join(runtimesDir, 'onnxruntime-node-cuda', 'install-stage-1234567890'));
  });

  it('accepts a valid backup name', () => {
    const result = resolveManagedRuntimeChildPathSafe(runtimesDir, '1.26.0-cuda13.backup-1234567890', 'backup');
    assert.equal(result, join(runtimesDir, 'onnxruntime-node-cuda', '1.26.0-cuda13.backup-1234567890'));
  });

  it('accepts a valid failed name', () => {
    const result = resolveManagedRuntimeChildPathSafe(runtimesDir, '1.26.0-cuda13.failed-1234567890', 'failed');
    assert.equal(result, join(runtimesDir, 'onnxruntime-node-cuda', '1.26.0-cuda13.failed-1234567890'));
  });

  it('rejects a name that does not match the requested kind\'s pattern', () => {
    assert.throws(() => resolveManagedRuntimeChildPathSafe(runtimesDir, '1.26.0-cuda13.backup-123', 'installStage'), /invalid managed runtime child path/);
    assert.throws(() => resolveManagedRuntimeChildPathSafe(runtimesDir, 'install-stage-123', 'backup'), /invalid managed runtime child path/);
  });

  it('rejects an unknown kind', () => {
    assert.throws(() => resolveManagedRuntimeChildPathSafe(runtimesDir, 'install-stage-123', 'bogus'), /unknown managed runtime child path kind/);
  });

  it('rejects a traversal attempt even if it superficially matched a pattern shape', () => {
    assert.throws(() => resolveManagedRuntimeChildPathSafe(runtimesDir, 'install-stage-123/../../etc', 'installStage'), /invalid managed runtime child path/);
  });

  it('never resolves outside the onnxruntime-node-cuda tree', () => {
    const result = resolveManagedRuntimeChildPathSafe(runtimesDir, 'install-stage-999', 'installStage');
    assert.ok(result.startsWith(join(runtimesDir, 'onnxruntime-node-cuda') + sep));
  });
});
