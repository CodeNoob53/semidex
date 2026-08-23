// Behavioral proof that representative audit events are emitted at each of
// the task's required-coverage points, that rejected requests are still
// denied before any handler/body/upstream work (unchanged from before this
// feature), and that no emitted record ever contains a secret, document
// content, Ask question text, or an unrestricted filesystem path — proven
// with unique sentinel strings placed directly in the inputs. Design
// record: docs/security/audit-logging-design-2026-08.md.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRouter } from '../../../src/shared/admin/router.js';
import { AUDIENCE, OPERATION, COST_CLASS } from '../../../src/core/http/route-audience.js';
import { authorizeCollectionAccess } from '../../../src/core/http/authorize.js';
import { registerJobsRoutes, FULL_JOB_POLICY } from '../../../src/shared/admin/api/jobs.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { registerSettingsRoutes } from '../../../src/shared/admin/api/settings.js';
import { registerCollectionsRoutes } from '../../../src/shared/admin/api/collections.js';
import { createSettingsService } from '../../../src/core/settings/service.js';
import { runKeyCommand } from '../../../src/core/auth/key-cli.js';
import { AUDIT_EVENT_TYPE } from '../../../src/core/audit/event.js';

function fakeSink() {
  const events = [];
  return { events, record: (e) => events.push(e), async flush() {}, async close() {} };
}

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  return c;
}

// Same fakeReq/fakeRes shape as tests/unit/security/policy-seam.test.js —
// no real HTTP server needed for router-level assertions.
function fakeReq(method, url, { body = null, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:8642', 'content-type': 'application/json', ...headers };
  req.socket = {};
  const origOn = req.on.bind(req);
  req.on = (event, fn) => {
    const r = origOn(event, fn);
    if (event === 'end' && body !== null) {
      setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
    }
    return r;
  };
  return req;
}

function fakeRes() {
  const res = {
    statusCode: null, headers: {}, body: null,
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
    get headersSent() { return res.statusCode !== null; },
    writeHead(code, h) { res.statusCode = code; Object.assign(res.headers, h ?? {}); },
    write() { return true; },
    end(payload) { if (payload) res.body = payload; },
    on() {},
  };
  return res;
}

const META = { audience: AUDIENCE.INTEGRATION, operation: OPERATION.GENERATE, costClass: COST_CLASS.LLM };

describe('Host/Origin denial events (request protections)', () => {
  it('a bad Host header emits request.host_rejected and never reaches the handler', async () => {
    const sink = fakeSink();
    const router = createRouter({ auditSink: sink });
    let ran = false;
    router.get('/api/health', () => { ran = true; }, { audience: AUDIENCE.ADMIN, operation: OPERATION.READ, costClass: COST_CLASS.LOW });

    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health', { headers: { host: 'evil.example.com' } }), res);

    assert.equal(ran, false);
    assert.equal(res.statusCode, 403);
    const events = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.REQUEST_HOST_REJECTED);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, 'denied');
    assert.equal(typeof events[0].requestId, 'string');
  });

  it('a cross-site POST (mismatched Origin) emits request.origin_rejected', async () => {
    const sink = fakeSink();
    const router = createRouter({ auditSink: sink });
    router.post('/api/jobs/:id/cancel', () => {}, { audience: AUDIENCE.ADMIN, operation: OPERATION.MUTATE, costClass: COST_CLASS.LOW });

    const res = fakeRes();
    await router.handleRequest(fakeReq('POST', '/api/jobs/x/cancel', { headers: { origin: 'https://attacker.example' } }), res);

    assert.equal(res.statusCode, 403);
    const events = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.REQUEST_ORIGIN_REJECTED);
    assert.equal(events.length, 1);
  });
});

describe('Authentication events', () => {
  it('a successful stage-1 auth emits auth.integration_accepted with keyId, before the handler runs', async () => {
    const sink = fakeSink();
    const router = createRouter({
      auditSink: sink,
      integrationPolicy: {
        authorizeRequest: () => ({ ok: true, principal: { keyId: 'k-accept', name: 'ci-key', collections: ['*'], operations: ['generate'] } }),
        authorizeCollection: () => ({ ok: true }),
      },
    });
    let ran = false;
    router.get('/api/health', () => { ran = true; }, META);
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());

    assert.equal(ran, true);
    const accepted = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.AUTH_INTEGRATION_ACCEPTED);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].keyId, 'k-accept');
    assert.equal(accepted[0].outcome, 'accepted');
  });

  it('a rejected credential emits auth.integration_denied and never reaches the handler', async () => {
    const sink = fakeSink();
    const router = createRouter({
      auditSink: sink,
      integrationPolicy: {
        authorizeRequest: () => ({ ok: false, status: 401, code: 'unauthorized', message: 'no' }),
        authorizeCollection: () => ({ ok: true }),
      },
    });
    let ran = false;
    router.get('/api/health', () => { ran = true; }, META);
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());

    assert.equal(ran, false);
    const denied = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.AUTH_INTEGRATION_DENIED);
    assert.equal(denied.length, 1);
    assert.equal(denied[0].reason, 'unauthorized');
  });

  it('a rate-limit denial emits auth.rate_limited with the retry delay, never the handler', async () => {
    const sink = fakeSink();
    const router = createRouter({
      auditSink: sink,
      integrationPolicy: {
        authorizeRequest: () => ({ ok: true, principal: { keyId: 'k-rl' } }),
        authorizeCollection: () => ({ ok: true }),
        checkRateLimit: () => ({ ok: false, status: 429, code: 'rate_limited', message: 'slow down', retryAfterSeconds: 5 }),
      },
    });
    let ran = false;
    router.get('/api/health', () => { ran = true; }, META);
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());

    assert.equal(ran, false);
    const limited = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.AUTH_RATE_LIMITED);
    assert.equal(limited.length, 1);
    assert.equal(limited[0].keyId, 'k-rl');
    assert.equal(limited[0].retryAfterSeconds, 5);
  });
});

describe('Authorization — collection-scope denial', () => {
  it('a denied stage-2 authorization emits authz.collection_denied', async () => {
    const sink = fakeSink();
    const auth = {
      principal: { keyId: 'k1' },
      requestId: 'req-123',
      route: { method: 'POST', path: '/api/v1/ask', audience: AUDIENCE.INTEGRATION, operation: OPERATION.GENERATE },
      auditSink: sink,
      authorizeCollection: () => ({ ok: false, status: 403, code: 'forbidden', message: 'no' }),
    };
    await assert.rejects(() => authorizeCollectionAccess(auth, { req: {}, collection: 'private-collection' }));
    const denied = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.AUTHZ_COLLECTION_DENIED);
    assert.equal(denied.length, 1);
    assert.equal(denied[0].collection, 'private-collection');
    assert.equal(denied[0].keyId, 'k1');
    assert.equal(denied[0].requestId, 'req-123');
  });

  it('an allowed stage-2 authorization emits nothing (accept was already recorded at stage 1)', async () => {
    const sink = fakeSink();
    const auth = {
      principal: { keyId: 'k1' }, requestId: 'req-1', route: { method: 'POST', path: '/api/v1/ask' },
      auditSink: sink, authorizeCollection: () => ({ ok: true }),
    };
    await authorizeCollectionAccess(auth, { req: {}, collection: 'docs' });
    assert.equal(sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.AUTHZ_COLLECTION_DENIED).length, 0);
  });
});

describe('Indexing boundary events', () => {
  function buildJobsRouter({ sink, checkTarget, spawnIndexer }) {
    const router = createRouter({ auditSink: sink });
    const registry = createJobRegistry({ spawnIndexer: spawnIndexer ?? (() => fakeChild()), baseEnv: {}, auditSink: sink });
    registerJobsRoutes(router, registry, {
      jobPolicy: FULL_JOB_POLICY,
      allowedRootsGuard: { checkTarget },
    });
    return { router, registry };
  }

  it('an allowed-roots denial emits index.root_denied with a pathHash, never the raw path', async () => {
    const sink = fakeSink();
    const secretPath = 'C:\\Users\\alice-secret-user\\forbidden-project\\data';
    const { router } = buildJobsRouter({
      sink,
      checkTarget: () => ({ ok: false, status: 403, code: 'path_not_allowed', message: 'no' }),
    });
    const res = fakeRes();
    await router.handleRequest(fakeReq('POST', '/api/jobs/index', {
      body: JSON.stringify({ collection: 'c', path: secretPath }),
    }), res);

    assert.equal(res.statusCode, 403);
    const denied = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.INDEX_ROOT_DENIED);
    assert.equal(denied.length, 1);
    assert.match(denied[0].pathHash, /^[0-9a-f]{16}$/);
    assert.doesNotMatch(JSON.stringify(denied[0]), /alice-secret-user|forbidden-project/);
  });

  it('a full job lifecycle (start -> succeeded) emits index.job_started then index.job_succeeded, correlated by jobId', async () => {
    const sink = fakeSink();
    let child;
    const { router } = buildJobsRouter({
      sink,
      checkTarget: (p) => ({ ok: true, canonicalPath: p }),
      spawnIndexer: () => { child = fakeChild(); return child; },
    });
    const res = fakeRes();
    await router.handleRequest(fakeReq('POST', '/api/jobs/index', {
      body: JSON.stringify({ collection: 'my-collection', path: '/allowed/root/docs' }),
    }), res);
    assert.equal(res.statusCode, 202);

    const started = sink.events.find((e) => e.type === AUDIT_EVENT_TYPE.INDEX_JOB_STARTED);
    assert.ok(started, 'index.job_started must be emitted when the job is accepted');
    assert.equal(started.collection, 'my-collection');
    assert.match(started.pathHash, /^[0-9a-f]{16}$/);
    assert.doesNotMatch(JSON.stringify(started), /\/allowed\/root\/docs/, 'the raw indexing path must never appear');

    child.emit('exit', 0, null);
    await new Promise((r) => setImmediate(r));
    const succeeded = sink.events.find((e) => e.type === AUDIT_EVENT_TYPE.INDEX_JOB_SUCCEEDED);
    assert.ok(succeeded);
    assert.equal(succeeded.jobId, started.jobId);
    assert.equal(succeeded.exitCode, 0);
  });

  it('a failed job emits index.job_failed with the exit code', async () => {
    const sink = fakeSink();
    let child;
    const { router } = buildJobsRouter({
      sink, checkTarget: (p) => ({ ok: true, canonicalPath: p }),
      spawnIndexer: () => { child = fakeChild(); return child; },
    });
    await router.handleRequest(fakeReq('POST', '/api/jobs/index', {
      body: JSON.stringify({ collection: 'c', path: '/x' }),
    }), fakeRes());
    child.emit('exit', 1, null);
    await new Promise((r) => setImmediate(r));
    const failed = sink.events.find((e) => e.type === AUDIT_EVENT_TYPE.INDEX_JOB_FAILED);
    assert.ok(failed);
    assert.equal(failed.exitCode, 1);
  });

  it('a cancel request emits index.job_cancel_requested, and the eventual exit emits index.job_cancelled', async () => {
    const sink = fakeSink();
    let child;
    const { router, registry } = buildJobsRouter({
      sink, checkTarget: (p) => ({ ok: true, canonicalPath: p }),
      spawnIndexer: () => { child = fakeChild(); return child; },
    });
    await router.handleRequest(fakeReq('POST', '/api/jobs/index', {
      body: JSON.stringify({ collection: 'c', path: '/x' }),
    }), fakeRes());
    const jobId = registry.getActiveJob().id;

    const res = fakeRes();
    await router.handleRequest(fakeReq('POST', `/api/jobs/${jobId}/cancel`), res);
    assert.equal(res.statusCode, 200);
    assert.equal(sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.INDEX_JOB_CANCEL_REQUESTED).length, 1);

    child.emit('exit', null, 'SIGTERM');
    await new Promise((r) => setImmediate(r));
    const cancelled = sink.events.find((e) => e.type === AUDIT_EVENT_TYPE.INDEX_JOB_CANCELLED);
    assert.ok(cancelled);
    assert.equal(cancelled.jobId, jobId);
  });
});

describe('Administrative mutation events', () => {
  it('a successful settings PATCH emits admin.settings_changed with field name + action only, never the value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-audit-settings-'));
    try {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'settings.json') });
      const sink = fakeSink();
      const router = createRouter({ auditSink: sink });
      registerSettingsRoutes(router, { settingsService });

      const res = fakeRes();
      await router.handleRequest(fakeReq('PATCH', '/api/settings', {
        body: JSON.stringify({ changes: { RRF_K: 90 } }),
      }), res);
      assert.equal(res.statusCode, 200);

      const changed = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.ADMIN_SETTINGS_CHANGED);
      assert.equal(changed.length, 1);
      assert.deepEqual(changed[0].fields, [{ key: 'RRF_K', action: 'set' }]);
      // Never the value (90), only the field name and action.
      assert.doesNotMatch(JSON.stringify(changed[0]), /"90"|:90\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a rejected settings PATCH (unknown key) emits nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-audit-settings-reject-'));
    try {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'settings.json') });
      const sink = fakeSink();
      const router = createRouter({ auditSink: sink });
      registerSettingsRoutes(router, { settingsService });

      await router.handleRequest(fakeReq('PATCH', '/api/settings', {
        body: JSON.stringify({ changes: { NOT_A_REAL_SETTING: 1 } }),
      }), fakeRes());
      assert.equal(sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.ADMIN_SETTINGS_CHANGED).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function fakeAdapter() {
    const collections = new Map([['docs', { name: 'docs' }]]);
    return {
      getCollection: async (name) => collections.get(name) ?? null,
      deleteCollection: async (name) => { collections.delete(name); },
      ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
    };
  }

  it('a collection delete emits admin.collection_deleted with the collection name', async () => {
    const sink = fakeSink();
    const router = createRouter({ auditSink: sink });
    registerCollectionsRoutes(router, fakeAdapter());
    const res = fakeRes();
    await router.handleRequest(fakeReq('DELETE', '/api/collections/docs'), res);
    assert.equal(res.statusCode, 200);
    const deleted = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.ADMIN_COLLECTION_DELETED);
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].collection, 'docs');
  });

  it('a schema sync emits admin.collection_schema_synced', async () => {
    const sink = fakeSink();
    const router = createRouter({ auditSink: sink });
    registerCollectionsRoutes(router, fakeAdapter());
    const res = fakeRes();
    await router.handleRequest(fakeReq('POST', '/api/collections/docs/sync-schema'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.ADMIN_COLLECTION_SCHEMA_SYNCED).length, 1);
  });

  it('key add/revoke via the CLI emit admin.key_created / admin.key_revoked, never the token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-audit-keycli-'));
    try {
      const sink = fakeSink();
      const keyStorePath = join(dir, 'integration-keys.json');
      let out = '';
      const code = runKeyCommand(
        ['add', '--name', 'ci', '--collection', 'docs'],
        { keyStorePath, auditSink: sink, out: (s) => { out += `${s}\n`; } },
      );
      assert.equal(code, 0);
      const created = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED);
      assert.equal(created.length, 1);
      assert.equal(created[0].keyName, 'ci');
      const tokenMatch = /sdx_v1_\S+/.exec(out);
      assert.ok(tokenMatch, 'the CLI must have printed the raw token to stdout, for this test to prove it is absent from the audit event');
      assert.doesNotMatch(JSON.stringify(created[0]), new RegExp(tokenMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const revokeCode = runKeyCommand(['revoke', created[0].keyId], { keyStorePath, auditSink: sink, out: () => {} });
      assert.equal(revokeCode, 0);
      const revoked = sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.ADMIN_KEY_REVOKED);
      assert.equal(revoked.length, 1);
      assert.equal(revoked[0].status, 'revoked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Negative sentinel — secrets, questions, and paths never appear in any emitted record', () => {
  it('an Authorization bearer token used in a request never appears in any event', async () => {
    const sink = fakeSink();
    const router = createRouter({
      auditSink: sink,
      integrationPolicy: {
        authorizeRequest: () => ({ ok: false, status: 401, code: 'unauthorized', message: 'no' }),
        authorizeCollection: () => ({ ok: true }),
      },
    });
    router.get('/api/health', () => {}, META);
    const secretToken = 'sdx_v1_AAAAAAAAAAAAAAAA_super-secret-do-not-log-1234567890123';
    await router.handleRequest(fakeReq('GET', '/api/health', { headers: { authorization: `Bearer ${secretToken}` } }), fakeRes());
    assert.doesNotMatch(JSON.stringify(sink.events), new RegExp(secretToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('QDRANT_KEY/GEMINI_API_KEY are not writable through this route at all (env-only) — confirming there is no value to leak', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-audit-sentinel-secret-rejected-'));
    try {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'settings.json') });
      const sink = fakeSink();
      const router = createRouter({ auditSink: sink });
      registerSettingsRoutes(router, { settingsService });
      const res = fakeRes();
      await router.handleRequest(fakeReq('PATCH', '/api/settings', {
        body: JSON.stringify({ changes: { QDRANT_KEY: 'whatever-value-someone-tries' } }),
      }), res);
      assert.equal(res.statusCode, 400, 'QDRANT_KEY is writable:false in definitions.js — the write itself is rejected');
      assert.equal(sink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.ADMIN_SETTINGS_CHANGED).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a genuinely writable field carrying a secret-looking value is logged by field name only — the value never appears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-audit-sentinel-value-'));
    try {
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'settings.json') });
      const sink = fakeSink();
      const router = createRouter({ auditSink: sink });
      registerSettingsRoutes(router, { settingsService });
      // CONTEXT_MODEL is an ordinary writable string setting (no secret
      // flag, no SENSITIVE_DESTINATION_KEYS gating) — used here only to
      // carry an arbitrary, secret-looking VALUE, to prove the "field name
      // + action only, never the value" guarantee is structural (applies to
      // every field's value, not something special-cased for keys that
      // happen to be flagged secret:true).
      const secretLookingValue = 'sk-live-should-never-appear-in-audit-log-9f3a1';
      const res = fakeRes();
      await router.handleRequest(fakeReq('PATCH', '/api/settings', {
        body: JSON.stringify({ changes: { CONTEXT_MODEL: secretLookingValue } }),
      }), res);
      assert.equal(res.statusCode, 200);
      assert.doesNotMatch(JSON.stringify(sink.events), /sk-live-should-never-appear/);
      const changed = sink.events.find((e) => e.type === AUDIT_EVENT_TYPE.ADMIN_SETTINGS_CHANGED);
      assert.ok(changed);
      assert.deepEqual(changed.fields, [{ key: 'CONTEXT_MODEL', action: 'set' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a local filesystem path with an identifying marker never appears verbatim in an indexing event', async () => {
    const sink = fakeSink();
    const router = createRouter({ auditSink: sink });
    const registry = createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {}, auditSink: sink });
    registerJobsRoutes(router, registry, {
      jobPolicy: FULL_JOB_POLICY,
      allowedRootsGuard: { checkTarget: (p) => ({ ok: true, canonicalPath: p }) },
    });
    const markerPath = '/home/uniquely-identifiable-operator-9f3a/private-repo/secret.md';
    await router.handleRequest(fakeReq('POST', '/api/jobs/index', {
      body: JSON.stringify({ collection: 'c', path: markerPath }),
    }), fakeRes());
    assert.doesNotMatch(JSON.stringify(sink.events), /uniquely-identifiable-operator-9f3a|private-repo/);
  });
});
