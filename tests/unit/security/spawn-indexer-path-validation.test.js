// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md
// Finding P1-3 "POST /api/jobs/index accepts an arbitrary local filesystem
// path with no traversal/scope restriction — the indexer will read
// whatever path is supplied, subject only to OS file permissions of the
// process."
//
// src/shared/admin/api/jobs.js's requireLocalPathField() (the only
// validation `path` goes through before reaching
// registry.js's startIndexJob()) rejects a URL-scheme string
// (scheme://...) but performs NO other check: no traversal guard, no
// "must be inside an allowed root" restriction, no absolute-vs-relative
// distinction. registry.js's startIndexJob() (src/shared/admin/jobs/
// registry.js) passes `path` straight into
// `spawnIndexer({ args: [path], env })` with no validation of its own
// either (confirmed by reading the file — buildJobEnv() only ever touches
// `collection` and the boolean options, never `path`). spawn-indexer-lite.js/
// spawn-indexer-full.js both spawn `node <indexer-entry> <path>` verbatim —
// there is no shell involved (node:child_process spawn() with an argv
// array, not a shell string), so this is NOT a shell-injection vector, but
// it IS an arbitrary-local-path-read vector: any path the OS-level process
// can read (e.g. "C:\\Users\\<other-user>\\Documents", "../../../etc",
// an absolute path to a completely unrelated directory) is accepted and
// indexed into Qdrant Cloud, from where it becomes retrievable via
// Ask/search to anyone who can reach this same collection.
//
// This test proves requireLocalPathField()/parseIndexJobRequest() accept
// traversal and arbitrary-absolute paths unchanged, and that
// createJobRegistry()'s startIndexJob() forwards whatever path it was
// given to spawnIndexer with no additional check — i.e. the ABSENCE of a
// scope/allow-list guard at both layers this request actually passes
// through.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndexJobRequest, FULL_JOB_POLICY } from '../../../src/shared/admin/api/jobs.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { EventEmitter } from 'node:events';

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('parseIndexJobRequest — path field has no traversal/scope guard (confirmed-absence characterization)', () => {
  it('accepts a "../../../" traversal-shaped relative path unchanged', () => {
    const { path } = parseIndexJobRequest({ collection: 'c', path: '../../../etc' }, FULL_JOB_POLICY);
    assert.equal(path, '../../../etc');
  });

  it('accepts an arbitrary absolute Windows path outside any project directory unchanged', () => {
    const { path } = parseIndexJobRequest({ collection: 'c', path: 'C:\\Users\\someone-else\\Documents\\Private' }, FULL_JOB_POLICY);
    assert.equal(path, 'C:\\Users\\someone-else\\Documents\\Private');
  });

  it('accepts an arbitrary absolute POSIX path (e.g. /etc, a system directory) unchanged', () => {
    const { path } = parseIndexJobRequest({ collection: 'c', path: '/etc' }, FULL_JOB_POLICY);
    assert.equal(path, '/etc');
  });

  it('rejects only a URL-scheme-shaped string — that is the ONE real validation this field has', () => {
    assert.throws(
      () => parseIndexJobRequest({ collection: 'c', path: 'https://example.com/payload' }, FULL_JOB_POLICY),
      /must be a local filesystem path, not a URL/,
    );
  });
});

describe('createJobRegistry().startIndexJob() — forwards path to spawnIndexer with no additional validation', () => {
  it('an arbitrary traversal-shaped path reaches spawnIndexer verbatim as args[0]', () => {
    let seenArgs = null;
    const spawnIndexer = ({ args, env }) => { seenArgs = args; return makeFakeChild(); };
    const registry = createJobRegistry({ spawnIndexer, baseEnv: {} });

    registry.startIndexJob({ collection: 'c', path: '../../../etc/shadow-equivalent', options: {} });

    assert.deepEqual(seenArgs, ['../../../etc/shadow-equivalent']);
  });

  it('an arbitrary absolute path outside any conventional "documents root" reaches spawnIndexer verbatim', () => {
    let seenArgs = null;
    const spawnIndexer = ({ args }) => { seenArgs = args; return makeFakeChild(); };
    const registry = createJobRegistry({ spawnIndexer, baseEnv: {} });

    registry.startIndexJob({ collection: 'c', path: 'C:\\Windows\\System32\\config', options: {} });

    assert.deepEqual(seenArgs, ['C:\\Windows\\System32\\config']);
  });

  it('spawnIndexer receives an argv array (not a shell string) — confirms this is a path-scope gap, not a shell-injection vector', () => {
    // Documents the boundary precisely: spawn-indexer-lite.js/-full.js call
    // node:child_process's spawn(execPath, [entry, ...args], opts) — an
    // argv array, never a concatenated shell command string — so a path
    // containing shell metacharacters (e.g. "; rm -rf ~") is passed as one
    // literal argv element, not interpreted by a shell. This test asserts
    // that same argv-array shape holds through the registry layer.
    let seenArgs = null;
    const spawnIndexer = ({ args }) => { seenArgs = args; return makeFakeChild(); };
    const registry = createJobRegistry({ spawnIndexer, baseEnv: {} });

    const shellLikePath = '/tmp/foo; rm -rf ~';
    registry.startIndexJob({ collection: 'c', path: shellLikePath, options: {} });

    assert.equal(Array.isArray(seenArgs), true);
    assert.equal(seenArgs.length, 1);
    assert.equal(seenArgs[0], shellLikePath); // one literal element, unsplit/uninterpreted
  });
});
