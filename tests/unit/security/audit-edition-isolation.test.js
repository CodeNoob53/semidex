// createApp()/createLiteApp() must enforce their own edition even when the
// CALLER injects a raw/plain AuditSink — not just when the caller already
// called resolveAuditSink({ edition }) first. This file replaces an earlier
// version that only ever handed each composition root a sink it had ALREADY
// pre-tagged itself (via resolveAuditSink({ edition })), which proved the
// wrapper mechanism worked but never proved createApp()/createLiteApp()
// themselves apply it — a no-op composition root would have passed that
// version of this test too (review finding). Every test below hands a
// composition root a genuinely raw sink (or one deliberately pre-tagged with
// the WRONG edition) and asserts the events THAT SAME composition root
// records carry the correct edition — proving the enforcement lives in
// createApp()/createLiteApp() (ensureEditionTag(), src/core/audit/sink.js),
// not in whatever the caller happened to do beforehand.
//
// All sinks here are plain in-memory objects — no JSONL/disk sink, and in
// particular no two independent rotating JSONL sinks ever write to the same
// file (a real, unguarded race — see docs/security/
// audit-logging-design-2026-08.md §9). Where two composition roots need to
// converge on one destination (the "no cross-contamination" tests), that
// destination is a shared in-memory array, which has no rotation and no
// file-handle coordination problem to begin with.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../../src/admin/server-full.js';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createSettingsService } from '../../../src/core/settings/service.js';
import { ensureEditionTag } from '../../../src/core/audit/sink.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { makeStubAdapter, makeFakeChildForSpawn } from '../admin/ui-test-helpers.js';

function rawCaptureSink() {
  const sink = { events: [] };
  sink.record = (e) => sink.events.push(e);
  sink.flush = async () => {};
  sink.close = async () => {};
  return sink;
}

// A fake allowedRootsGuard — the real one requires the target path to exist
// on disk and be under an operator-configured allowed root (fail-closed by
// design, docs/security/semidex-lite-public-api-audit-2026-08.md Finding
// P1-3), which is irrelevant to what these tests prove (edition tagging, not
// path containment) and would otherwise turn a job start into
// index.root_denied instead of index.job_started.
const allowedRootsGuard = { checkTarget: (p) => ({ ok: true, canonicalPath: p }) };

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'semidex-audit-edition-'));
  return (async () => {
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

async function listen(app) {
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.address().port}`;
}

async function close(app) {
  await new Promise((resolve) => app.close(resolve));
}

describe('createApp()/createLiteApp() enforce their own edition on a raw, untagged injected sink', () => {
  it('createApp({ auditSink: rawCaptureSink }) tags a router-level and a handler-level event edition:"full", with no pre-tagging by the caller', () => withTmpDir(async (dir) => {
    const sink = rawCaptureSink();
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'settings.json') });
    const app = createApp({
      adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }),
      auditSink: sink, settingsService, allowedRootsGuard,
    });
    const base = await listen(app);
    try {
      // Router-level: a cross-site POST with a foreign Origin, rejected
      // before route dispatch (same real-HTTP pattern proven safe in
      // tests/unit/security/csrf-state-changing-routes.test.js).
      await fetch(`${base}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: JSON.stringify({ changes: {} }),
      });
      // Handler-level: a real settings mutation.
      await fetch(`${base}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { RRF_K: 77 } }),
      });

      const originRejected = sink.events.find((e) => e.type === 'request.origin_rejected');
      const settingsChanged = sink.events.find((e) => e.type === 'admin.settings_changed');
      assert.ok(originRejected, 'expected a router-level request.origin_rejected event');
      assert.equal(originRejected.edition, 'full');
      assert.ok(settingsChanged, 'expected a handler-level admin.settings_changed event');
      assert.equal(settingsChanged.edition, 'full');
    } finally {
      await close(app);
    }
  }));

  it('createLiteApp({ auditSink: rawCaptureSink }) tags a router-level and a handler-level event edition:"lite", with no pre-tagging by the caller', () => withTmpDir(async (dir) => {
    const sink = rawCaptureSink();
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'settings.json') });
    const app = createLiteApp({
      adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }),
      auditSink: sink, settingsService, allowedRootsGuard,
    });
    const base = await listen(app);
    try {
      await fetch(`${base}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: JSON.stringify({ changes: {} }),
      });
      await fetch(`${base}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { RRF_K: 88 } }),
      });

      const originRejected = sink.events.find((e) => e.type === 'request.origin_rejected');
      const settingsChanged = sink.events.find((e) => e.type === 'admin.settings_changed');
      assert.ok(originRejected, 'expected a router-level request.origin_rejected event');
      assert.equal(originRejected.edition, 'lite');
      assert.ok(settingsChanged, 'expected a handler-level admin.settings_changed event');
      assert.equal(settingsChanged.edition, 'lite');
    } finally {
      await close(app);
    }
  }));
});

describe('createApp()/createLiteApp() cannot be spoofed into the opposite edition by a pre-tagged sink', () => {
  it('createLiteApp() given a sink another composition root already tagged edition:"full" still records edition:"lite"', () => withTmpDir(async (dir) => {
    const raw = rawCaptureSink();
    const spoofed = ensureEditionTag(raw, 'full'); // simulates a caller passing Full's own resolved sink into Lite
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'settings.json') });
    const app = createLiteApp({
      adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }),
      auditSink: spoofed, settingsService, allowedRootsGuard,
    });
    const base = await listen(app);
    try {
      await fetch(`${base}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: JSON.stringify({ changes: {} }),
      });
      const rejected = raw.events.find((e) => e.type === 'request.origin_rejected');
      assert.ok(rejected);
      assert.equal(rejected.edition, 'lite', 'createLiteApp() must win over a caller-supplied "full" tag');
    } finally {
      await close(app);
    }
  }));

  it('createApp() given a sink another composition root already tagged edition:"lite" still records edition:"full"', () => withTmpDir(async (dir) => {
    const raw = rawCaptureSink();
    const spoofed = ensureEditionTag(raw, 'lite'); // simulates a caller passing Lite's own resolved sink into Full
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'settings.json') });
    const app = createApp({
      adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }),
      auditSink: spoofed, settingsService, allowedRootsGuard,
    });
    const base = await listen(app);
    try {
      await fetch(`${base}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: JSON.stringify({ changes: {} }),
      });
      const rejected = raw.events.find((e) => e.type === 'request.origin_rejected');
      assert.ok(rejected);
      assert.equal(rejected.edition, 'full', 'createApp() must win over a caller-supplied "lite" tag');
    } finally {
      await close(app);
    }
  }));
});

describe('createApp()/createLiteApp() edition-tag job-registry lifecycle events, sharing one instance with the router (the startLite() sharing pattern)', () => {
  it('Full: an externally-constructed job registry sharing the pre-tagged sink records index.job_started as edition:"full"', () => withTmpDir(async (dir) => {
    const raw = rawCaptureSink();
    // Mirrors packages/lite/lite-src/serve-lite.js's own pattern for sharing
    // one sink between a caller-built job registry and the composition
    // root: tag once via the same ensureEditionTag() the composition root
    // itself uses, then pass the SAME instance to both.
    const tagged = ensureEditionTag(raw, 'full');
    const jobRegistry = createJobRegistry({ spawnIndexer: () => makeFakeChildForSpawn(), baseEnv: {}, auditSink: tagged });
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'settings.json') });
    const app = createApp({
      adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }),
      jobRegistry, auditSink: tagged, settingsService, allowedRootsGuard,
    });
    const base = await listen(app);
    try {
      await fetch(`${base}/api/jobs/index`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'full-edition-test', path: '/tmp/full' }),
      });
      const started = raw.events.find((e) => e.type === 'index.job_started' && e.collection === 'full-edition-test');
      assert.ok(started, 'expected an index.job_started event');
      assert.equal(started.edition, 'full');
    } finally {
      await close(app);
    }
  }));

  it('Lite: an externally-constructed job registry sharing the pre-tagged sink records index.job_started as edition:"lite"', () => withTmpDir(async (dir) => {
    const raw = rawCaptureSink();
    const tagged = ensureEditionTag(raw, 'lite');
    const jobRegistry = createJobRegistry({ spawnIndexer: () => makeFakeChildForSpawn(), baseEnv: {}, auditSink: tagged });
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'settings.json') });
    const app = createLiteApp({
      adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }),
      jobRegistry, auditSink: tagged, settingsService, allowedRootsGuard,
    });
    const base = await listen(app);
    try {
      await fetch(`${base}/api/jobs/index`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'lite-edition-test', path: '/tmp/lite' }),
      });
      const started = raw.events.find((e) => e.type === 'index.job_started' && e.collection === 'lite-edition-test');
      assert.ok(started, 'expected an index.job_started event');
      assert.equal(started.edition, 'lite');
    } finally {
      await close(app);
    }
  }));
});

describe('Full + Lite composition roots converging on one shared (in-memory) sink never cross-contaminate', () => {
  it('createApp() and createLiteApp(), each given the SAME raw sink directly, tag every event with their own edition — never the other\'s', () => withTmpDir(async (dir) => {
    const shared = rawCaptureSink();
    const fullSettings = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'full-settings.json') });
    const liteSettings = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: join(dir, 'lite-settings.json') });

    // Each composition root wraps the SAME raw sink independently — two
    // separate wrapper instances, one true base sink. No file, no rotation,
    // no cross-instance coordination problem: this is just a shared JS array.
    const fullApp = createApp({
      adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }),
      auditSink: shared, settingsService: fullSettings, allowedRootsGuard,
    });
    const liteApp = createLiteApp({
      adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }),
      auditSink: shared, settingsService: liteSettings, allowedRootsGuard,
    });

    const fullBase = await listen(fullApp);
    const liteBase = await listen(liteApp);
    try {
      await fetch(`${fullBase}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: JSON.stringify({ changes: {} }),
      });
      await fetch(`${liteBase}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: JSON.stringify({ changes: {} }),
      });
      await fetch(`${fullBase}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { RRF_K: 11 } }),
      });
      await fetch(`${liteBase}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { RRF_K: 22 } }),
      });

      const fullOriginRejected = shared.events.filter((e) => e.type === 'request.origin_rejected' && e.edition === 'full');
      const liteOriginRejected = shared.events.filter((e) => e.type === 'request.origin_rejected' && e.edition === 'lite');
      assert.ok(fullOriginRejected.length >= 1, 'expected at least one edition:"full" request.origin_rejected event');
      assert.ok(liteOriginRejected.length >= 1, 'expected at least one edition:"lite" request.origin_rejected event');

      const settingsChanged = shared.events.filter((e) => e.type === 'admin.settings_changed');
      assert.ok(settingsChanged.some((e) => e.edition === 'full'), 'expected an edition:"full" admin.settings_changed event');
      assert.ok(settingsChanged.some((e) => e.edition === 'lite'), 'expected an edition:"lite" admin.settings_changed event');

      for (const e of shared.events) assert.ok(e.edition === 'full' || e.edition === 'lite', `unexpected edition value: ${e.edition}`);
    } finally {
      await Promise.all([close(fullApp), close(liteApp)]);
    }
  }));
});
