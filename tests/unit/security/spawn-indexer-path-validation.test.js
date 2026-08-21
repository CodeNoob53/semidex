// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md
// Finding P1-3 — STATUS: FIXED (see the audit doc's "Indexing allowed
// roots" section). This file used to characterize the documented ABSENCE
// of a path-scope guard: parseIndexJobRequest() (src/shared/admin/api/
// jobs.js) and createJobRegistry().startIndexJob() (src/shared/admin/jobs/
// registry.js) both forwarded any caller-supplied `path` unchanged, with no
// traversal/scope restriction at either layer. That absence is now closed
// — but at the HTTP ROUTE layer specifically
// (src/shared/admin/api/jobs.js's registerJobsRoutes(), via
// src/shared/admin/jobs/allowed-roots-guard.js's createAllowedRootsGuard()),
// not inside parseIndexJobRequest()/registry.js themselves. This file now
// proves the fix, not the gap it used to document.
//
// Architecture note (why parseIndexJobRequest()/registry.js are still
// path-scope-agnostic, and must stay that way): both are shared with the
// direct CLI indexing entry point (`semidex-lite index <path>` / Full's
// equivalent — see packages/lite/lite-src/index-lite.js), which has no HTTP
// boundary at all and runs as the trusted local operator who already has
// whatever filesystem access the CLI grants by other means (task
// requirement — CLI indexing must remain usable without the Admin
// allowed-roots setting). Baking the guard into registry.js would
// accidentally impose an HTTP-only concern on that CLI path. The first
// describe block below pins this as an intentional, unchanged architecture
// decision; the second is the real proof of the fix.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIndexJobRequest, FULL_JOB_POLICY, registerJobsRoutes } from '../../../src/shared/admin/api/jobs.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { createAllowedRootsGuard } from '../../../src/shared/admin/jobs/allowed-roots-guard.js';
import { createSettingsService } from '../../../src/core/settings/service.js';
import { createRouter } from '../../../src/shared/admin/router.js';
import { createHttpServer } from '../../../src/shared/admin/register-neutral-routes.js';

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('Architecture note — parseIndexJobRequest()/registry.js remain path-scope-agnostic BY DESIGN (shared with the CLI, which has no HTTP boundary)', () => {
  it('parseIndexJobRequest() itself performs no traversal/scope check — the guard lives one layer up, in registerJobsRoutes()', () => {
    const { path: parsedPath } = parseIndexJobRequest({ collection: 'c', path: '../../../etc' }, FULL_JOB_POLICY);
    assert.equal(parsedPath, '../../../etc');
  });

  it('createJobRegistry().startIndexJob() forwards whatever path it is given to spawnIndexer unchanged — the CLI (semidex-lite index) calls this directly with no HTTP layer at all, and must keep working exactly as before', () => {
    let seenArgs = null;
    const registry = createJobRegistry({ spawnIndexer: ({ args }) => { seenArgs = args; return makeFakeChild(); }, baseEnv: {} });
    registry.startIndexJob({ collection: 'c', path: '/any/path/at/all', options: {} });
    assert.deepEqual(seenArgs, ['/any/path/at/all']);
  });

  it('spawnIndexer still receives an argv array (not a shell string) — this fix does not change the pre-existing not-a-shell-injection-vector shape', () => {
    let seenArgs = null;
    const registry = createJobRegistry({ spawnIndexer: ({ args }) => { seenArgs = args; return makeFakeChild(); }, baseEnv: {} });
    const shellLikePath = '/tmp/foo; rm -rf ~';
    registry.startIndexJob({ collection: 'c', path: shellLikePath, options: {} });
    assert.ok(Array.isArray(seenArgs));
    assert.equal(seenArgs.length, 1);
    assert.equal(seenArgs[0], shellLikePath);
  });
});

// Builds a real router + real createAllowedRootsGuard (backed by a real,
// isolated settings.json in a temp dir) + a fake registry that records
// whether startIndexJob()/spawnIndexer was ever reached — proves the HTTP
// route itself denies an out-of-scope request BEFORE any of that runs.
function withGuardedJobsRoute({ allowedRoots }, fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-spawn-guard-'));
  const settingsPath = path.join(tmpHome, 'settings.json');
  if (allowedRoots) fs.writeFileSync(settingsPath, JSON.stringify({ INDEX_ALLOWED_ROOTS: allowedRoots }));
  const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
  const allowedRootsGuard = createAllowedRootsGuard({ settingsService, log: () => {} });

  const startCalls = [];
  const spawnCalls = [];
  const registry = createJobRegistry({
    spawnIndexer: ({ args }) => { spawnCalls.push(args); return makeFakeChild(); },
  });
  const realStartIndexJob = registry.startIndexJob;
  registry.startIndexJob = (params) => { startCalls.push(params); return realStartIndexJob(params); };

  const router = createRouter();
  registerJobsRoutes(router, registry, { jobPolicy: FULL_JOB_POLICY, allowedRootsGuard });
  const server = createHttpServer(router);

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        await fn({ base, startCalls, spawnCalls, tmpHome });
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });
}

describe('POST /api/jobs/index — a path outside the configured allowed roots is rejected before startIndexJob()/spawnIndexer is ever called (the fix)', () => {
  it('with no allowed roots configured at all, a request for a real, existing directory is denied 403 before startIndexJob() — fail closed, not "unrestricted"', async () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-spawn-guard-target-'));
    try {
      await withGuardedJobsRoute({ allowedRoots: null }, async ({ base, startCalls, spawnCalls }) => {
        const res = await fetch(base + '/api/jobs/index', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection: 'c', path: realDir }),
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error.code, 'allowed_roots_not_configured');
        assert.equal(startCalls.length, 0, 'registry.startIndexJob() must never be reached');
        assert.equal(spawnCalls.length, 0, 'spawnIndexer must never be reached');
      });
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });

  it('a "../../../"-shaped traversal path is denied — it resolves outside the configured root', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-spawn-guard-root-'));
    try {
      const inside = path.join(tmpRoot, 'inside');
      fs.mkdirSync(inside);
      await withGuardedJobsRoute({ allowedRoots: [inside] }, async ({ base, startCalls, spawnCalls }) => {
        const traversal = path.join(inside, '..', '..');
        const res = await fetch(base + '/api/jobs/index', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection: 'c', path: traversal }),
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error.code, 'path_not_allowed');
        assert.equal(startCalls.length, 0);
        assert.equal(spawnCalls.length, 0);
      });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('an arbitrary absolute path outside every configured root is denied, never reaching startIndexJob()/spawnIndexer', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-spawn-guard-root-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-spawn-guard-elsewhere-'));
    try {
      await withGuardedJobsRoute({ allowedRoots: [tmpRoot] }, async ({ base, startCalls, spawnCalls }) => {
        const res = await fetch(base + '/api/jobs/index', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection: 'c', path: elsewhere }),
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error.code, 'path_not_allowed');
        assert.equal(startCalls.length, 0);
        assert.equal(spawnCalls.length, 0);
      });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('a request for a path genuinely inside the configured root is accepted (202), and startIndexJob()/spawnIndexer receive the canonical resolved path', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-spawn-guard-root-'));
    try {
      const target = path.join(tmpRoot, 'docs');
      fs.mkdirSync(target);
      await withGuardedJobsRoute({ allowedRoots: [tmpRoot] }, async ({ base, startCalls, spawnCalls }) => {
        const res = await fetch(base + '/api/jobs/index', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection: 'c', path: target }),
        });
        assert.equal(res.status, 202);
        assert.equal(startCalls.length, 1);
        assert.equal(startCalls[0].path, fs.realpathSync(target));
        assert.deepEqual(spawnCalls[0], [fs.realpathSync(target)]);
      });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('a nonexistent path under an otherwise-allowed root is denied with the SAME generic code as an out-of-scope path (no existence oracle)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-spawn-guard-root-'));
    try {
      await withGuardedJobsRoute({ allowedRoots: [tmpRoot] }, async ({ base, startCalls }) => {
        const res = await fetch(base + '/api/jobs/index', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection: 'c', path: path.join(tmpRoot, 'does-not-exist') }),
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error.code, 'path_not_allowed');
        assert.equal(startCalls.length, 0);
      });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
