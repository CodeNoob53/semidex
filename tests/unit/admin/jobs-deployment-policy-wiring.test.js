// Full/Lite composition-root wiring for the empty-roots policy (2026-09
// personal-use UX fix — see allowed-roots-guard.js's own header comment and
// docs/security/semidex-lite-public-api-audit-2026-08.md's "Indexing allowed
// roots" section). resolveDeploymentPolicy()'s own unit behavior is covered
// by tests/unit/admin/server.test.js; path-containment.test.js covers
// createAllowedRootsGuard()'s policy logic directly against a fake
// settingsService. Neither proves the thing this file proves: that
// server-full.js's createApp() and composition/lite.js's createLiteApp()
// each actually resolve ADMIN_ALLOW_REMOTE through the SAME
// resolveDeploymentPolicy() helper and wire the result into their own
// allowed-roots guard end-to-end (a real settingsService, through a real
// POST /api/jobs/index round trip, no allowedRootsGuard override) — and that
// two composition roots built in the same process (Full+Full, Full+Lite)
// never leak one instance's ADMIN_ALLOW_REMOTE/INDEX_ALLOWED_ROOTS into the
// other's guard.
//
// jobRegistry is always a fake spawnIndexer (never the real
// spawn-indexer-{full,lite}.js) — this file is about the allowed-roots
// guard's accept/deny decision, not about actually indexing anything; a
// real spawn would shell out to a real indexer process and touch real
// embeddings/Qdrant config, which no unit test here needs or wants.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../../../src/admin/server-full.js';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createSettingsService } from '../../../src/core/settings/service.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { makeStubAdapter } from './ui-test-helpers.js';

function fakeJobRegistry() {
  return createJobRegistry({
    spawnIndexer: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { setTimeout(() => child.emit('exit', null, 'SIGTERM'), 1); };
      return child;
    },
  });
}

// A real, temp-backed settingsService (createSettingsService, not a fake
// object) — proves the wiring against the actual settings tier-resolution
// code, exactly as it runs in production, not just an object shaped like
// one. ADMIN_ALLOW_REMOTE is next_restart (fine — it's read once at
// composition-root construction, the same way a real bootstrap would),
// INDEX_ALLOWED_ROOTS is set directly via osEnv so no PATCH round trip is
// needed to seed it.
function realSettings({ allowRemote, indexAllowedRoots } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'semidex-deploy-policy-'));
  const settingsPath = join(dir, 'settings.json');
  const osEnv = {};
  if (allowRemote !== undefined) osEnv.ADMIN_ALLOW_REMOTE = allowRemote ? '1' : '0';
  if (indexAllowedRoots !== undefined) osEnv.INDEX_ALLOWED_ROOTS = JSON.stringify(indexAllowedRoots);
  const service = createSettingsService({ osEnv, dotenvValues: {}, settingsPath });
  return { service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// resolveRequestSecurityPolicy() (a SEPARATE fail-closed rule from the one
// under test here — createRequestSecurityPolicy() in
// core/http/request-security.js) refuses to construct at all when
// ADMIN_ALLOW_REMOTE=1 and ADMIN_ALLOWED_HOSTS is unset, regardless of the
// allowed-roots guard's own policy — and once allowRemote:true, that policy's
// checkHost() requires an EXACT "hostname:port" allow-list match (the
// loopback "accept whatever port this socket actually listens on" fallback
// is explicitly disabled in remote mode — see request-security.js's own
// comment). An ephemeral listen(0) port is therefore unusable for a
// remote-mode instance: the port isn't known until after construction, but
// ADMIN_ALLOWED_HOSTS must be set (as `host:port`) BEFORE construction. Every
// allowRemote:true scenario below listens on one of these fixed, per-test
// ports instead, with ADMIN_ALLOWED_HOSTS scoped to exactly that port.
// (allowRemote:false instances keep using listen(0) — checkHost()'s loopback
// fallback accepts whatever port the socket actually bound to, no
// ADMIN_ALLOWED_HOSTS needed, so an ephemeral port is fine there.)
let nextRemotePort = 41501;
function allocateRemotePort() {
  return nextRemotePort++;
}

async function withAdminAllowedHosts(port, fn) {
  const saved = process.env.ADMIN_ALLOWED_HOSTS;
  process.env.ADMIN_ALLOWED_HOSTS = `127.0.0.1:${port}`;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.ADMIN_ALLOWED_HOSTS;
    else process.env.ADMIN_ALLOWED_HOSTS = saved;
  }
}

async function withApp(buildApp, fn, { port = 0 } = {}) {
  const app = buildApp();
  await new Promise((resolve) => app.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

async function postIndex(base, targetPath) {
  return fetch(base + '/api/jobs/index', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: 'demo', path: targetPath }),
  });
}

describe('createApp() (Full) — resolveDeploymentPolicy wired end-to-end into the real allowed-roots guard, no allowedRootsGuard override', () => {
  it('ADMIN_ALLOW_REMOTE=false + empty INDEX_ALLOWED_ROOTS: an existing real directory is accepted (local_unrestricted)', async () => {
    const { service, cleanup } = realSettings({ allowRemote: false, indexAllowedRoots: [] });
    const target = mkdtempSync(join(tmpdir(), 'semidex-target-'));
    try {
      await withApp(
        () => createApp({ adapter: makeStubAdapter(), settingsService: service, jobRegistry: fakeJobRegistry() }),
        async (base) => {
          const res = await postIndex(base, target);
          assert.equal(res.status, 202);
        },
      );
    } finally {
      cleanup();
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('ADMIN_ALLOW_REMOTE=true + empty INDEX_ALLOWED_ROOTS: the same real directory is denied before any job is spawned', async () => {
    const { service, cleanup } = realSettings({ allowRemote: true, indexAllowedRoots: [] });
    const target = mkdtempSync(join(tmpdir(), 'semidex-target-'));
    const port = allocateRemotePort();
    try {
      await withAdminAllowedHosts(port, () => withApp(
        () => createApp({ adapter: makeStubAdapter(), settingsService: service, jobRegistry: fakeJobRegistry() }),
        async (base) => {
          const res = await postIndex(base, target);
          assert.equal(res.status, 403);
          const body = await res.json();
          assert.equal(body.error.code, 'allowed_roots_not_configured');
        },
        { port },
      ));
    } finally {
      cleanup();
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('createLiteApp() (Lite) — same resolveDeploymentPolicy wiring, mirrored', () => {
  it('ADMIN_ALLOW_REMOTE=false + empty INDEX_ALLOWED_ROOTS: an existing real directory is accepted (local_unrestricted)', async () => {
    const { service, cleanup } = realSettings({ allowRemote: false, indexAllowedRoots: [] });
    const target = mkdtempSync(join(tmpdir(), 'semidex-target-'));
    try {
      await withApp(
        () => createLiteApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }), settingsService: service, jobRegistry: fakeJobRegistry() }),
        async (base) => {
          const res = await postIndex(base, target);
          assert.equal(res.status, 202);
        },
      );
    } finally {
      cleanup();
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('ADMIN_ALLOW_REMOTE=true + empty INDEX_ALLOWED_ROOTS: denied before any job is spawned', async () => {
    const { service, cleanup } = realSettings({ allowRemote: true, indexAllowedRoots: [] });
    const target = mkdtempSync(join(tmpdir(), 'semidex-target-'));
    const port = allocateRemotePort();
    try {
      await withAdminAllowedHosts(port, () => withApp(
        () => createLiteApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }), settingsService: service, jobRegistry: fakeJobRegistry() }),
        async (base) => {
          const res = await postIndex(base, target);
          assert.equal(res.status, 403);
          assert.equal((await res.json()).error.code, 'allowed_roots_not_configured');
        },
        { port },
      ));
    } finally {
      cleanup();
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('instance isolation — two composition roots built in the same process never share deploymentPolicy/guard state', () => {
  it('Full(allowRemote:true) and Full(allowRemote:false) built together: neither leaks its ADMIN_ALLOW_REMOTE into the other', async () => {
    const remote = realSettings({ allowRemote: true, indexAllowedRoots: [] });
    const local = realSettings({ allowRemote: false, indexAllowedRoots: [] });
    const target = mkdtempSync(join(tmpdir(), 'semidex-target-'));
    const remotePort = allocateRemotePort();
    try {
      const remoteApp = await withAdminAllowedHosts(remotePort, () => createApp({ adapter: makeStubAdapter(), settingsService: remote.service, jobRegistry: fakeJobRegistry() }));
      const localApp = createApp({ adapter: makeStubAdapter(), settingsService: local.service, jobRegistry: fakeJobRegistry() });
      await Promise.all([
        new Promise((resolve) => remoteApp.listen(remotePort, '127.0.0.1', resolve)),
        new Promise((resolve) => localApp.listen(0, '127.0.0.1', resolve)),
      ]);
      const remoteBase = `http://127.0.0.1:${remoteApp.address().port}`;
      const localBase = `http://127.0.0.1:${localApp.address().port}`;
      try {
        const remoteRes = await postIndex(remoteBase, target);
        const localRes = await postIndex(localBase, target);
        assert.equal(remoteRes.status, 403, 'the remote-mode instance must still deny an unconfigured empty root');
        assert.equal((await remoteRes.json()).error.code, 'allowed_roots_not_configured', 'the 403 must come from the allowed-roots guard, not an unrelated Host-check rejection');
        assert.equal(localRes.status, 202, 'the local-only instance must still accept it — must not have been flipped to remote by the sibling instance');
      } finally {
        await Promise.all([
          new Promise((resolve) => remoteApp.close(resolve)),
          new Promise((resolve) => localApp.close(resolve)),
        ]);
      }
    } finally {
      remote.cleanup();
      local.cleanup();
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('Full(allowRemote:true) and Lite(allowRemote:false) built together: cross-edition isolation holds too', async () => {
    const fullRemote = realSettings({ allowRemote: true, indexAllowedRoots: [] });
    const liteLocal = realSettings({ allowRemote: false, indexAllowedRoots: [] });
    const target = mkdtempSync(join(tmpdir(), 'semidex-target-'));
    const fullPort = allocateRemotePort();
    try {
      const fullApp = await withAdminAllowedHosts(fullPort, () => createApp({ adapter: makeStubAdapter(), settingsService: fullRemote.service, jobRegistry: fakeJobRegistry() }));
      const liteApp = createLiteApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }), settingsService: liteLocal.service, jobRegistry: fakeJobRegistry() });
      await Promise.all([
        new Promise((resolve) => fullApp.listen(fullPort, '127.0.0.1', resolve)),
        new Promise((resolve) => liteApp.listen(0, '127.0.0.1', resolve)),
      ]);
      const fullBase = `http://127.0.0.1:${fullApp.address().port}`;
      const liteBase = `http://127.0.0.1:${liteApp.address().port}`;
      try {
        const fullRes = await postIndex(fullBase, target);
        const liteRes = await postIndex(liteBase, target);
        assert.equal(fullRes.status, 403, 'Full (remote mode) must still deny');
        assert.equal((await fullRes.json()).error.code, 'allowed_roots_not_configured', 'the 403 must come from the allowed-roots guard, not an unrelated Host-check rejection');
        assert.equal(liteRes.status, 202, 'Lite (local-only) must still accept — Full\'s remote policy must not have leaked across editions');
      } finally {
        await Promise.all([
          new Promise((resolve) => fullApp.close(resolve)),
          new Promise((resolve) => liteApp.close(resolve)),
        ]);
      }
    } finally {
      fullRemote.cleanup();
      liteLocal.cleanup();
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('a real SettingsService-backed regression: a validly-configured root that is later deleted from disk fails closed, never local_unrestricted', () => {
  it('Full: setMany() accepts an existing root, the directory is then removed externally, and indexing (still ADMIN_ALLOW_REMOTE=false) is denied, not treated as the intentional empty-list convenience', async () => {
    const { service, cleanup } = realSettings({ allowRemote: false });
    const root = mkdtempSync(join(tmpdir(), 'semidex-real-root-'));
    try {
      await service.setMany({ INDEX_ALLOWED_ROOTS: [root] });
      assert.deepEqual(service.getActiveValue('INDEX_ALLOWED_ROOTS'), [root]);

      // External deletion after configuration — not a setMany() rejection,
      // not a malformed settings.json: a genuinely valid configured root
      // that stopped existing, exactly like a user unplugging a drive or
      // deleting a folder they'd pointed indexing at.
      rmSync(root, { recursive: true, force: true });

      await withApp(
        () => createApp({ adapter: makeStubAdapter(), settingsService: service, jobRegistry: fakeJobRegistry() }),
        async (base) => {
          const res = await postIndex(base, root);
          assert.equal(res.status, 403, 'a non-empty configured root that no longer canonicalizes to anything must fail closed even though ADMIN_ALLOW_REMOTE is false');
          const body = await res.json();
          assert.equal(body.error.code, 'allowed_roots_not_configured');
        },
      );
    } finally {
      cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
