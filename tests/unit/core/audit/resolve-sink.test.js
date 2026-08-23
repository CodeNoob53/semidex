// resolveAuditSink() — env resolution, disable switch, dir/size/count
// overrides. Mirrors resolve-policy.js's own instance-scoping contract.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuditSink, resolveAuditLogDir } from '../../../../src/core/audit/resolve-sink.js';
import { AUDIT_EVENT_TYPE, buildAuditEvent } from '../../../../src/core/audit/event.js';

describe('resolveAuditLogDir', () => {
  it('defaults to SEMIDEX_HOME/audit', () => {
    assert.equal(resolveAuditLogDir({ SEMIDEX_HOME: '/home/op/.semidex' }), join('/home/op/.semidex', 'audit'));
  });

  it('returns null when neither SEMIDEX_HOME nor SEMIDEX_AUDIT_LOG_DIR is set — deliberately NOT a cwd fallback (see the function\'s own header comment)', () => {
    assert.equal(resolveAuditLogDir({}), null);
  });

  it('SEMIDEX_AUDIT_LOG_DIR overrides both', () => {
    assert.equal(resolveAuditLogDir({ SEMIDEX_HOME: '/x', SEMIDEX_AUDIT_LOG_DIR: '/custom/audit' }), '/custom/audit');
  });
});

describe('resolveAuditSink', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-audit-resolve-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('with no SEMIDEX_HOME and no explicit dir, resolveAuditSink() is a no-op — it must never guess process.cwd()', async () => {
    // Regression test: an earlier version of resolveAuditLogDir() fell back
    // to process.cwd() here, which meant every existing test in this
    // codebase that constructs createApp()/createLiteApp() without
    // overriding auditSink (the overwhelming majority — this parameter is
    // new) silently wrote a real audit/audit.log into the REPO ROOT during
    // `npm test`. Caught by `git status` after a full test run showing an
    // untracked `audit/` directory.
    const originalCwd = process.cwd();
    const sink = resolveAuditSink({ env: {} });
    sink.record(buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'k1' }));
    await sink.flush();
    assert.equal(existsSync(join(originalCwd, 'audit')), false, 'must never create audit/ under the process cwd');
  });

  it('SEMIDEX_AUDIT_LOG_DISABLED=1 returns a no-op sink regardless of other config', async () => {
    const sink = resolveAuditSink({ env: { SEMIDEX_AUDIT_LOG_DISABLED: '1', SEMIDEX_HOME: dir } });
    sink.record(buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'k1' }));
    await sink.flush();
    assert.equal(existsSync(join(dir, 'audit')), false);
  });

  it('a real sink writes under the resolved dir', async () => {
    const sink = resolveAuditSink({ env: { SEMIDEX_HOME: dir } });
    sink.record(buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'k1' }));
    await sink.flush();
    assert.ok(existsSync(join(dir, 'audit', 'audit.log')));
  });

  it('sync:true returns a synchronously-durable sink', () => {
    const sink = resolveAuditSink({ env: { SEMIDEX_HOME: dir }, sync: true });
    sink.record(buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'k1' }));
    assert.ok(existsSync(join(dir, 'audit', 'audit.log')), 'a sync sink is durable immediately, before any flush');
  });

  it('an explicit dir overrides SEMIDEX_HOME-derived resolution', async () => {
    const explicit = mkdtempSync(join(tmpdir(), 'semidex-audit-explicit-'));
    try {
      const sink = resolveAuditSink({ env: { SEMIDEX_HOME: dir }, dir: explicit });
      sink.record(buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'k1' }));
      await sink.flush();
      assert.ok(existsSync(join(explicit, 'audit.log')));
      assert.equal(existsSync(join(dir, 'audit')), false);
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }
  });

  it('an invalid SEMIDEX_AUDIT_LOG_MAX_BYTES falls back to the default rather than throwing', () => {
    assert.doesNotThrow(() => resolveAuditSink({
      env: { SEMIDEX_HOME: dir, SEMIDEX_AUDIT_LOG_MAX_BYTES: 'not-a-number' },
      logger: { warn() {}, error() {} },
    }));
  });

  it('edition, when given, is stamped onto every recorded event — the fix for edition being previously dead configuration', async () => {
    const sink = resolveAuditSink({ env: { SEMIDEX_HOME: dir }, edition: 'full' });
    // buildAuditEvent() itself never sets edition (no call site passes it —
    // see docs/security/audit-logging-design-2026-08.md §7) so every real
    // event arrives with edition: null; the sink must override that, not
    // just fill it in when absent.
    const event = buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'k1' });
    assert.equal(event.edition, null, 'sanity: buildAuditEvent() itself never sets edition');
    sink.record(event);
    await sink.flush();
    const line = JSON.parse(readFileSync(join(dir, 'audit', 'audit.log'), 'utf-8').trim());
    assert.equal(line.edition, 'full');
  });

  it('the original event object passed to record() is never mutated by edition tagging', async () => {
    const sink = resolveAuditSink({ env: { SEMIDEX_HOME: dir }, edition: 'lite' });
    const event = buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'k1' });
    assert.ok(Object.isFrozen(event));
    sink.record(event);
    await sink.flush();
    assert.equal(event.edition, null, 'the caller-owned, frozen event must remain untouched');
  });

  it('edition: null (the default) leaves buildAuditEvent()\'s own null unchanged — no wrapping at all', async () => {
    const sink = resolveAuditSink({ env: { SEMIDEX_HOME: dir } });
    sink.record(buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'k1' }));
    await sink.flush();
    const line = JSON.parse(readFileSync(join(dir, 'audit', 'audit.log'), 'utf-8').trim());
    assert.equal(line.edition, null);
  });

  it('an invalid edition value throws at construction rather than silently mis-tagging every event', () => {
    assert.throws(() => resolveAuditSink({ env: { SEMIDEX_HOME: dir }, edition: 'staging' }), TypeError);
  });

  it('a disabled (no-op) sink still accepts edition without throwing', () => {
    assert.doesNotThrow(() => {
      const sink = resolveAuditSink({ env: { SEMIDEX_HOME: dir, SEMIDEX_AUDIT_LOG_DISABLED: '1' }, edition: 'full' });
      sink.record(buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'k1' }));
    });
  });

  it('two edition-tagged sinks writing to the SAME dir never cross-tag each other\'s events', async () => {
    const fullSink = resolveAuditSink({ env: { SEMIDEX_HOME: dir }, edition: 'full' });
    const liteSink = resolveAuditSink({ env: { SEMIDEX_HOME: dir }, edition: 'lite' });
    fullSink.record(buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'full-key' }));
    liteSink.record(buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'lite-key' }));
    await Promise.all([fullSink.flush(), liteSink.flush()]);
    const lines = readFileSync(join(dir, 'audit', 'audit.log'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const full = lines.find((l) => l.keyId === 'full-key');
    const lite = lines.find((l) => l.keyId === 'lite-key');
    assert.equal(full.edition, 'full');
    assert.equal(lite.edition, 'lite');
  });

  it('two calls with different dirs never share sink state', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'semidex-audit-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'semidex-audit-b-'));
    try {
      const sinkA = resolveAuditSink({ env: { SEMIDEX_HOME: dirA } });
      const sinkB = resolveAuditSink({ env: { SEMIDEX_HOME: dirB } });
      sinkA.record(buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'only-a' }));
      await sinkA.flush();
      await sinkB.flush();
      assert.ok(existsSync(join(dirA, 'audit', 'audit.log')));
      assert.equal(existsSync(join(dirB, 'audit', 'audit.log')), false);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
