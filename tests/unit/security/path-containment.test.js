import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { isPathContained, isCaseInsensitivePlatform } from '../../../src/core/security/path-containment.js';
import { resolveAllowedRoots } from '../../../src/core/security/allowed-roots.js';
import { createAllowedRootsGuard } from '../../../src/shared/admin/jobs/allowed-roots-guard.js';

describe('path containment semantics', () => {
  it('handles exact, child, parent, and sibling-prefix POSIX paths', () => {
    const opts = { path: nodePath.posix, caseInsensitive: false };
    assert.equal(isPathContained('/srv/docs', '/srv/docs', opts), true);
    assert.equal(isPathContained('/srv/docs', '/srv/docs/a/file.md', opts), true);
    assert.equal(isPathContained('/srv/docs', '/srv', opts), false);
    assert.equal(isPathContained('/srv/docs', '/srv/docs-private/file.md', opts), false);
  });

  it('keeps POSIX path comparison case-sensitive', () => {
    assert.equal(isPathContained('/srv/docs', '/srv/DOCS/file.md', {
      path: nodePath.posix, caseInsensitive: false,
    }), false);
    assert.equal(isCaseInsensitivePlatform('darwin'), false);
  });

  it('handles Windows case, mixed separators, and drive boundaries', () => {
    const opts = { path: nodePath.win32, caseInsensitive: true };
    assert.equal(isPathContained('C:\\Docs', 'c:\\docs\\A.md', opts), true);
    assert.equal(isPathContained('C:\\Docs', 'C:/Docs/sub/file.md', opts), true);
    assert.equal(isPathContained('C:\\Docs', 'C:\\Docs-private\\file.md', opts), false);
    assert.equal(isPathContained('C:\\Docs', 'D:\\Docs\\file.md', opts), false);
    assert.equal(isCaseInsensitivePlatform('win32'), true);
  });

  it('handles UNC share boundaries', () => {
    const opts = { path: nodePath.win32, caseInsensitive: true };
    assert.equal(isPathContained('\\\\host\\share\\docs', '\\\\HOST\\SHARE\\docs\\a.md', opts), true);
    assert.equal(isPathContained('\\\\host\\share\\docs', '\\\\other\\share\\docs\\a.md', opts), false);
    assert.equal(isPathContained('\\\\host\\share\\docs', '\\\\host\\other\\docs\\a.md', opts), false);
  });
});

function tempTree() {
  const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'semidex-roots-'));
  const root = nodePath.join(base, 'allowed');
  const outside = nodePath.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  return { base, root, outside };
}

function settingsFor(roots) {
  return { getActiveValue: (key) => key === 'INDEX_ALLOWED_ROOTS' ? roots : undefined };
}

describe('allowed-roots guard against a real temporary filesystem', () => {
  it('accepts real files, directories, and relative spellings and returns canonical paths', () => {
    const { base, root } = tempTree();
    try {
      const dir = nodePath.join(root, 'nested');
      const file = nodePath.join(dir, 'file.md');
      fs.mkdirSync(dir);
      fs.writeFileSync(file, 'test');
      const guard = createAllowedRootsGuard({
        settingsService: settingsFor([root]),
        path: { ...nodePath, resolve: (_cwd, value) => nodePath.resolve(root, value) },
        log: () => {},
      });
      assert.deepEqual(guard.checkTarget(dir), { ok: true, canonicalPath: fs.realpathSync(dir), mode: 'allowed_root' });
      assert.deepEqual(guard.checkTarget(file), { ok: true, canonicalPath: fs.realpathSync(file), mode: 'allowed_root' });
      assert.deepEqual(guard.checkTarget('nested/file.md'), { ok: true, canonicalPath: fs.realpathSync(file), mode: 'allowed_root' });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects a symlink escape and a broken symlink with the same generic denial', (t) => {
    const { base, root, outside } = tempTree();
    try {
      const outsideFile = nodePath.join(outside, 'secret.md');
      const link = nodePath.join(root, 'link.md');
      const broken = nodePath.join(root, 'broken.md');
      fs.writeFileSync(outsideFile, 'secret');
      try {
        fs.symlinkSync(outsideFile, link, 'file');
        fs.symlinkSync(nodePath.join(outside, 'missing.md'), broken, 'file');
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EACCES') {
          t.skip(`symlink creation is unavailable: ${err.code}`);
          return;
        }
        throw err;
      }
      const guard = createAllowedRootsGuard({ settingsService: settingsFor([root]), log: () => {} });
      const escaped = guard.checkTarget(link);
      const missing = guard.checkTarget(broken);
      assert.equal(escaped.ok, false);
      assert.equal(missing.ok, false);
      assert.equal(escaped.status, 403);
      assert.equal(missing.status, 403);
      assert.equal(escaped.code, missing.code);
      assert.equal(escaped.message, missing.message);
      assert.equal(
        escaped.message,
        'This path cannot be indexed: it does not exist, is not a file or directory, or is outside the configured allowed indexing roots.',
      );
      assert.doesNotMatch(
        escaped.message,
        /secret\.md|link\.md|broken\.md|missing\.md|semidex-roots-/i,
      );
      for (const sensitivePath of [base, root, outside, outsideFile, link, broken]) {
        assert.equal(escaped.message.includes(sensitivePath), false);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects a Windows directory junction that resolves outside the root', {
    skip: process.platform !== 'win32',
  }, (t) => {
    const { base, root, outside } = tempTree();
    try {
      const junction = nodePath.join(root, 'junction');
      try {
        fs.symlinkSync(outside, junction, 'junction');
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EACCES') {
          t.skip(`junction creation is unavailable: ${err.code}`);
          return;
        }
        throw err;
      }
      const result = createAllowedRootsGuard({
        settingsService: settingsFor([root]), log: () => {},
      }).checkTarget(junction);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'path_not_allowed');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects unsupported filesystem object types without exposing the target', () => {
    const fakeFs = {
      realpathSync: (value) => value,
      statSync: (value) => value === '/allowed'
        ? { isDirectory: () => true, isFile: () => false }
        : { isDirectory: () => false, isFile: () => false },
    };
    const guard = createAllowedRootsGuard({
      settingsService: settingsFor(['/allowed']), fs: fakeFs,
      path: nodePath.posix, platform: 'linux', log: () => {},
    });
    const result = guard.checkTarget('/allowed/device');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'path_not_allowed');
    assert.doesNotMatch(result.message, /device/);
  });

  it('deduplicates roots after canonical resolution', () => {
    const { base, root } = tempTree();
    try {
      const alias = nodePath.join(base, 'alias');
      try {
        fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EACCES') return;
        throw err;
      }
      const resolved = resolveAllowedRoots([root, alias]);
      assert.equal(resolved.roots.length, 1);
      assert.equal(resolved.dropped.length, 1);
      assert.match(resolved.dropped[0].reason, /same real directory/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('fails closed for malformed or relative persisted root values', () => {
    assert.deepEqual(resolveAllowedRoots('.').roots, []);
    assert.deepEqual(resolveAllowedRoots(['.']).roots, []);
    assert.deepEqual(resolveAllowedRoots([null]).roots, []);
    const guard = createAllowedRootsGuard({
      settingsService: settingsFor('.'), log: () => {},
    });
    const result = guard.checkTarget(process.cwd());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'allowed_roots_not_configured');
  });

  it('keeps independently constructed guards isolated', () => {
    const { base, root, outside } = tempTree();
    try {
      const a = createAllowedRootsGuard({ settingsService: settingsFor([root]), log: () => {} });
      const b = createAllowedRootsGuard({ settingsService: settingsFor([outside]), log: () => {} });
      assert.equal(a.checkTarget(root).ok, true);
      assert.equal(a.checkTarget(outside).ok, false);
      assert.equal(b.checkTarget(outside).ok, true);
      assert.equal(b.checkTarget(root).ok, false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('a partially valid roots list (one good, one dropped) uses the valid root and stays strictly contained', () => {
    const { base, root, outside } = tempTree();
    try {
      const deletedRoot = nodePath.join(base, 'never-created-root');
      const guard = createAllowedRootsGuard({ settingsService: settingsFor([root, deletedRoot]), log: () => {} });
      assert.deepEqual(guard.checkTarget(root), { ok: true, canonicalPath: fs.realpathSync(root), mode: 'allowed_root' });
      assert.equal(guard.checkTarget(outside).ok, false, 'a path outside the one surviving root must still be denied');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

// ── empty-roots policy (2026-09 personal-use UX fix) ─────────────────────
// See allowed-roots-guard.js's own header comment for the full design
// record. These pin the three-way policy the task requires:
//   1. truly empty roots is unrestricted ONLY when deploymentPolicy says
//      this deployment is loopback-only (allowRemote: false);
//   2. truly empty roots in remote mode fails closed, before any
//      filesystem access;
//   3. a NON-empty configured value whose every entry gets dropped during
//      canonicalization must NEVER be mistaken for case 1's intentional
//      empty list — it fails closed in EVERY deployment mode.
describe('allowed-roots guard — empty-roots policy (local-only convenience vs. remote fail-closed vs. configured-but-invalid)', () => {
  it('local-only (allowRemote:false) + intentional empty roots accepts an existing file and directory', () => {
    const { base, root } = tempTree();
    try {
      const file = nodePath.join(root, 'file.md');
      fs.writeFileSync(file, 'x');
      const guard = createAllowedRootsGuard({
        settingsService: settingsFor([]), deploymentPolicy: { allowRemote: false }, log: () => {},
      });
      assert.deepEqual(guard.checkTarget(root), { ok: true, canonicalPath: fs.realpathSync(root), mode: 'local_unrestricted' });
      assert.deepEqual(guard.checkTarget(file), { ok: true, canonicalPath: fs.realpathSync(file), mode: 'local_unrestricted' });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('local-only + intentional empty roots generically rejects a missing path — same denial shape a configured-roots miss uses', () => {
    const guard = createAllowedRootsGuard({
      settingsService: settingsFor([]), deploymentPolicy: { allowRemote: false }, log: () => {},
    });
    const result = guard.checkTarget(nodePath.join(os.tmpdir(), `semidex-does-not-exist-${Date.now()}`));
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.code, 'path_not_allowed');
  });

  it('remote (allowRemote:true) + empty roots denies BEFORE any filesystem access to the target', () => {
    let touched = false;
    const fakeFs = {
      realpathSync: () => { touched = true; throw new Error('must not be called'); },
      statSync: () => { touched = true; throw new Error('must not be called'); },
    };
    const guard = createAllowedRootsGuard({
      settingsService: settingsFor([]), fs: fakeFs, deploymentPolicy: { allowRemote: true }, log: () => {},
    });
    const result = guard.checkTarget('/some/existing/path');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'allowed_roots_not_configured');
    assert.equal(touched, false, 'must fail closed before ever touching the filesystem');
  });

  it('a non-empty configured roots list whose every entry is dropped fails closed in BOTH deployment modes — never the intentional-empty-list convenience', () => {
    const { base } = tempTree();
    try {
      const deletedRoot = nodePath.join(base, 'never-created-root');
      for (const allowRemote of [true, false]) {
        const guard = createAllowedRootsGuard({
          settingsService: settingsFor([deletedRoot]), deploymentPolicy: { allowRemote }, log: () => {},
        });
        const result = guard.checkTarget(process.cwd());
        assert.equal(result.ok, false, `allowRemote=${allowRemote} must still fail closed`);
        assert.equal(result.status, 403);
        assert.equal(result.code, 'allowed_roots_not_configured');
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('a malformed (non-array) configured value also fails closed in local-only mode — not just the remote default', () => {
    // Mirrors settings-index-allowed-roots.test.js's "malformed persisted
    // values fail closed" case, but with allowRemote explicitly false: an
    // externally-corrupted settings.json ('.' instead of an array) must not
    // be silently reinterpreted as "operator never configured anything".
    const guard = createAllowedRootsGuard({
      settingsService: settingsFor('.'), deploymentPolicy: { allowRemote: false }, log: () => {},
    });
    const result = guard.checkTarget(process.cwd());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'allowed_roots_not_configured');
  });

  it('defaults deploymentPolicy to allowRemote:true when omitted — a guard constructed without one keeps today\'s fail-closed-on-empty behavior', () => {
    const guard = createAllowedRootsGuard({ settingsService: settingsFor([]), log: () => {} });
    const result = guard.checkTarget(process.cwd());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'allowed_roots_not_configured');
  });
});
