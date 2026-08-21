// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md finding
// P2-2 (settings.json written with default OS file permissions). Loosely
// modeled on core/auth/key-store.js's own "Atomic writes and file
// permissions" test shape (tests/unit/security/integration-key-store.test.js)
// but writeSettingsFileAtomic() is intentionally STRICTER: tmp file + write +
// chmod(tmp) + rename + chmod(target), where the PRE-rename chmod(tmp) is
// FAIL-CLOSED on POSIX (a chmod failure there blocks the rename and re-throws
// the chmod error — see settings-store.js's own doc comment for why: a tmp
// file's mode option is only honored by the OS when the tmp path is actually
// created, not when a stale tmp file from an earlier crash already exists) and
// best-effort only on Windows (injected via `platform`, never dependent on the
// host OS this suite happens to run on). The POST-rename chmod(target) stays
// best-effort on every platform — rename() does not change permissions, so a
// tmp inode that already passed the pre-rename chmod keeps its mode across it.
//
// settings.json holds QDRANT_KEY/GEMINI_API_KEY whenever they were set
// through the Settings API rather than .env — this is the same secret class
// integration-keys.json protects, just a different file.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSettingsFileAtomic, readSettingsFile } from '../../../src/core/settings/settings-store.js';

let dir;
let path;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'semidex-settings-store-'));
  path = join(dir, 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeSettingsFileAtomic — injected fs operations (deterministic, no real filesystem)', () => {
  it('writes through a temp file then renames (a crash cannot truncate the live file)', () => {
    const order = [];
    writeSettingsFileAtomic({ a: 1 }, path, {
      writeFileSyncFn: (p) => { order.push(`write:${p.endsWith('.tmp') ? 'tmp' : 'target'}`); },
      chmodSyncFn: () => { order.push('chmod'); },
      renameSyncFn: () => { order.push('rename'); },
      existsSyncFn: () => false,
      unlinkSyncFn: () => {},
    });
    assert.deepEqual(order, ['write:tmp', 'chmod', 'rename', 'chmod'],
      'must write the temp file, chmod it, rename over the target, then chmod the target');
  });

  it('writes JSON with 2-space indentation and mode: 0o600 via writeFileSync itself', () => {
    let written;
    writeSettingsFileAtomic({ FOO: 'bar' }, path, {
      writeFileSyncFn: (_p, data, opts) => { written = { data, opts }; },
      chmodSyncFn: () => {},
      renameSyncFn: () => {},
      existsSyncFn: () => false,
      unlinkSyncFn: () => {},
    });
    assert.equal(written.data, JSON.stringify({ FOO: 'bar' }, null, 2));
    assert.equal(written.opts.mode, 0o600);
    assert.equal(written.opts.encoding, 'utf-8');
  });

  it('attempts chmod 0o600 on both the temp file and the final path', () => {
    const modes = [];
    const paths = [];
    writeSettingsFileAtomic({}, path, {
      writeFileSyncFn: () => {},
      chmodSyncFn: (p, mode) => { paths.push(p); modes.push(mode); },
      renameSyncFn: () => {},
      existsSyncFn: () => false,
      unlinkSyncFn: () => {},
    });
    assert.equal(modes.length, 2, 'chmod must be attempted twice: tmp file, then final path');
    assert.ok(modes.every((m) => m === 0o600), `expected every chmod to request 0o600, got ${modes.map((m) => m.toString(8))}`);
    assert.ok(paths[0].endsWith('.tmp'), 'first chmod targets the temp file');
    assert.equal(paths[1], path, 'second chmod targets the final path');
  });

  it('POSIX: a pre-rename chmod failure blocks the rename, cleans up the temp file, and re-throws the ORIGINAL chmod error unchanged', () => {
    let renamed = false;
    let unlinked = null;
    const chmodError = new Error('EPERM: chmod not permitted');
    assert.throws(() => {
      writeSettingsFileAtomic({}, path, {
        writeFileSyncFn: () => {},
        chmodSyncFn: () => { throw chmodError; },
        renameSyncFn: () => { renamed = true; },
        existsSyncFn: () => true,
        unlinkSyncFn: (p) => { unlinked = p; },
        platform: 'linux',
      });
    }, (err) => err === chmodError);
    assert.equal(renamed, false, 'rename must never run when this process could not verify/force the tmp file to 0600 on POSIX');
    assert.ok(unlinked && unlinked.endsWith('.tmp'), 'the un-hardened temp file must still be cleaned up');
  });

  it('Windows: a pre-rename chmod failure does NOT block the rename (chmod never provided a real guarantee there)', () => {
    let renamed = false;
    assert.doesNotThrow(() => {
      writeSettingsFileAtomic({}, path, {
        writeFileSyncFn: () => {},
        chmodSyncFn: () => { throw new Error('chmod not supported on this platform'); },
        renameSyncFn: () => { renamed = true; },
        existsSyncFn: () => false,
        unlinkSyncFn: () => {},
        platform: 'win32',
      });
    });
    assert.equal(renamed, true, 'the rename must still happen on Windows even when the best-effort chmod fails');
  });

  it('POSIX: a POST-rename chmod failure does NOT abort — only the pre-rename chmod is fail-closed', () => {
    let calls = 0;
    let renamed = false;
    assert.doesNotThrow(() => {
      writeSettingsFileAtomic({}, path, {
        writeFileSyncFn: () => {},
        chmodSyncFn: () => {
          calls += 1;
          if (calls === 2) throw new Error('EPERM: post-rename chmod not permitted');
        },
        renameSyncFn: () => { renamed = true; },
        existsSyncFn: () => false,
        unlinkSyncFn: () => {},
        platform: 'linux',
      });
    });
    assert.equal(renamed, true, 'rename already happened before the second (post-rename) chmod, so its failure cannot un-happen it');
    assert.equal(calls, 2, 'both chmod attempts (tmp, then target) must have run');
  });

  it('cleans up the temp file and re-throws when writeFileSync itself fails', () => {
    let unlinked = null;
    assert.throws(() => {
      writeSettingsFileAtomic({}, path, {
        writeFileSyncFn: () => { throw new Error('ENOSPC: no space left on device'); },
        chmodSyncFn: () => {},
        renameSyncFn: () => { throw new Error('must not be reached'); },
        existsSyncFn: () => true,
        unlinkSyncFn: (p) => { unlinked = p; },
      });
    }, /ENOSPC/);
    assert.ok(unlinked && unlinked.endsWith('.tmp'), 'the stale temp file must be removed after a failed write');
  });

  it('cleans up the temp file and re-throws when rename fails (e.g. cross-device rename)', () => {
    let unlinked = null;
    assert.throws(() => {
      writeSettingsFileAtomic({}, path, {
        writeFileSyncFn: () => {},
        chmodSyncFn: () => {},
        renameSyncFn: () => { throw new Error('EXDEV: cross-device link not permitted'); },
        existsSyncFn: () => true,
        unlinkSyncFn: (p) => { unlinked = p; },
      });
    }, /EXDEV/);
    assert.ok(unlinked && unlinked.endsWith('.tmp'));
  });

  it('a failed cleanup (unlink also throws) does not mask the original error', () => {
    assert.throws(() => {
      writeSettingsFileAtomic({}, path, {
        writeFileSyncFn: () => { throw new Error('original failure'); },
        chmodSyncFn: () => {},
        renameSyncFn: () => {},
        existsSyncFn: () => true,
        unlinkSyncFn: () => { throw new Error('cleanup also failed'); },
      });
    }, /original failure/);
  });

  it('does not attempt cleanup when the temp file was never created (existsSyncFn: false)', () => {
    let unlinkCalled = false;
    assert.throws(() => {
      writeSettingsFileAtomic({}, path, {
        writeFileSyncFn: () => { throw new Error('boom'); },
        chmodSyncFn: () => {},
        renameSyncFn: () => {},
        existsSyncFn: () => false,
        unlinkSyncFn: () => { unlinkCalled = true; },
      });
    }, /boom/);
    assert.equal(unlinkCalled, false);
  });
});

describe('writeSettingsFileAtomic — real filesystem (portable across platforms)', () => {
  it('leaves no .tmp file behind after a successful write, and the content round-trips', () => {
    writeSettingsFileAtomic({ QDRANT_KEY: 'shh' }, path);
    assert.equal(existsSync(`${path}.tmp`), false, 'the temp file must be renamed, not left in place');
    assert.equal(existsSync(path), true);
    assert.deepEqual(readSettingsFile(path), { QDRANT_KEY: 'shh' });
  });

  it('a second write replaces the file atomically and still leaves no stale temp file', () => {
    writeSettingsFileAtomic({ a: 1 }, path);
    writeSettingsFileAtomic({ a: 2 }, path);
    assert.equal(existsSync(`${path}.tmp`), false);
    assert.deepEqual(readSettingsFile(path), { a: 2 });
  });
});

describe('writeSettingsFileAtomic — real filesystem, POSIX file mode (skipped on win32: chmod there only toggles the read-only attribute, not POSIX group/other bits or a Windows ACL)', () => {
  it('creates settings.json with mode 0o600', { skip: process.platform === 'win32' }, () => {
    writeSettingsFileAtomic({ a: 1 }, path);
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 0600, got 0${mode.toString(8)}`);
  });

  it('replaces a pre-existing, permissively-mode file with 0o600 — not just new files', { skip: process.platform === 'win32' }, () => {
    writeFileSync(path, JSON.stringify({ old: true }), 'utf-8');
    chmodSync(path, 0o644);
    assert.equal(statSync(path).mode & 0o777, 0o644, 'precondition: the pre-existing file is permissive');

    writeSettingsFileAtomic({ new: true }, path);

    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected the replaced file to be 0600, got 0${mode.toString(8)}`);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), { new: true });
  });

  it('hardens a stale, pre-existing permissive .tmp file before renaming it into place', { skip: process.platform === 'win32' }, () => {
    // Simulates an earlier crashed write: a tmp file exists already, with a
    // permissive mode from whatever created it. writeFileSync's `mode`
    // option is only honored by the OS when open() actually CREATES the
    // file — since this tmp file already exists, writeFileSync just
    // truncates and rewrites it, leaving the stale 0o644 mode untouched.
    // The explicit chmodSync() call is what actually fixes it before the
    // rename — this is the concrete scenario the fail-closed pre-rename
    // chmod exists to protect against.
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ stale: true }), 'utf-8');
    chmodSync(tmpPath, 0o644);
    assert.equal(statSync(tmpPath).mode & 0o777, 0o644, 'precondition: the stale tmp file is permissive');

    writeSettingsFileAtomic({ fresh: true }, path);

    assert.equal(existsSync(tmpPath), false, 'the tmp file must be renamed away, not left in place');
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected the hardened tmp file to become 0600 after rename, got 0${mode.toString(8)}`);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), { fresh: true });
  });
});
