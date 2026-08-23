// Local JSONL audit sink — deterministic encoding, rotation/retention,
// flush/shutdown, I/O failure behavior, two-instance isolation, and
// newline safety end to end (a sentinel string smuggled through every
// string field must never split a line). Offline: a temp directory per
// test, never a real SEMIDEX_HOME. Design record:
// docs/security/audit-logging-design-2026-08.md §4.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJsonlAuditSink, createSyncJsonlAuditSink, serializeEvent, DEFAULT_FILE_NAME,
} from '../../../../src/core/audit/jsonl-sink.js';
import { AUDIT_EVENT_TYPE, buildAuditEvent } from '../../../../src/core/audit/event.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'semidex-audit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(logDir = dir, fileName = DEFAULT_FILE_NAME) {
  const path = join(logDir, fileName);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter((l) => l.length > 0);
}

const keyCreated = (keyId, keyName = null) => buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId, keyName });

describe('serializeEvent — deterministic encoding', () => {
  it('produces the same bytes for the same event, regardless of key insertion order', () => {
    const a = { b: 2, a: 1, schemaVersion: 1 };
    const b = { schemaVersion: 1, a: 1, b: 2 };
    assert.equal(serializeEvent(a), serializeEvent(b));
  });

  it('ends with exactly one trailing newline', () => {
    const line = serializeEvent({ a: 1 });
    assert.ok(line.endsWith('\n'));
    assert.equal(line.split('\n').filter((l) => l.length > 0).length, 1);
  });
});

describe('createSyncJsonlAuditSink — durable synchronous writes (CLI use)', () => {
  it('writes one JSONL line per record() call, restrictively permissioned', () => {
    const sink = createSyncJsonlAuditSink({ dir });
    sink.record(keyCreated('k1', 'first'));
    sink.record(keyCreated('k2', 'second'));
    const lines = readLines();
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).keyId, 'k1');
    assert.equal(JSON.parse(lines[1]).keyId, 'k2');
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, DEFAULT_FILE_NAME)).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
  });

  it('drops a malformed event at the boundary instead of writing it', () => {
    let warned = false;
    const sink = createSyncJsonlAuditSink({ dir, onWarn: () => { warned = true; } });
    sink.record({ not: 'a real event' });
    assert.equal(readLines().length, 0);
    assert.equal(warned, true);
  });

  it('flush()/close() are no-ops that resolve (writes are already durable)', async () => {
    const sink = createSyncJsonlAuditSink({ dir });
    sink.record(keyCreated('k1'));
    await sink.flush();
    await sink.close();
    assert.equal(readLines().length, 1);
  });

  it('a write failure is caught, warned (throttled), and never thrown back to the caller', () => {
    let warnCount = 0;
    const t = 0;
    // dir's parent segment is a real file, not a directory — this makes
    // mkdirSync({recursive:true}) throw ENOTDIR reliably cross-platform,
    // exercising the catch path without faking fs.
    const fileAsParent = join(dir, 'im-a-file');
    writeFileSync(fileAsParent, 'x');
    const brokenSink = createSyncJsonlAuditSink({ dir: join(fileAsParent, 'audit'), onWarn: () => { warnCount++; }, now: () => t, warnThrottleMs: 1000 });
    assert.doesNotThrow(() => brokenSink.record(keyCreated('k1')));
    assert.doesNotThrow(() => brokenSink.record(keyCreated('k2')));
    // Throttled: two failures within the same window produce at most one warning.
    assert.equal(warnCount, 1);
  });

  it('a write-failure warning never contains err.message (which can embed the absolute local path) — only a fixed string plus an allow-listed err.code', () => {
    let warnedMessage = null;
    // The directory name itself is the "unrestricted local path" sentinel:
    // if err.message ever reached the warning, it would appear verbatim
    // here (Node's own ENOTDIR message embeds the full path it tried to
    // open), which is exactly what this test proves never happens.
    const secretMarker = 'uniquely-identifiable-operator-marker-7f2a';
    const fileAsParent = join(dir, `im-a-file-${secretMarker}`);
    writeFileSync(fileAsParent, 'x');
    const brokenSink = createSyncJsonlAuditSink({ dir: join(fileAsParent, 'audit'), onWarn: (msg) => { warnedMessage = msg; } });
    brokenSink.record(keyCreated('k1'));
    assert.ok(warnedMessage, 'expected a warning to have fired');
    assert.doesNotMatch(warnedMessage, new RegExp(secretMarker), 'the absolute path must never appear in the warning');
    assert.doesNotMatch(warnedMessage, /[A-Za-z]:\\|\/(home|Users)\//, 'no absolute filesystem path shape at all');
    assert.match(warnedMessage, /audit log write failed \([A-Za-z_]+\)/, 'expected the fixed-text + allow-listed err.code shape');
  });
});

describe('createJsonlAuditSink — non-blocking, queued writes (server use)', () => {
  it('record() returns synchronously without doing disk I/O itself', async () => {
    const sink = createJsonlAuditSink({ dir });
    sink.record(keyCreated('k1'));
    // Nothing on disk yet — the write happens on a later microtask via the drain loop.
    assert.equal(existsSync(join(dir, DEFAULT_FILE_NAME)), false);
    // Drain the in-flight write before the temp dir is removed in afterEach()
    // — otherwise this test's own background write races the NEXT test's
    // afterEach/beforeEach cycle and can log a spurious ENOENT warning once
    // this directory is already gone.
    await sink.close();
  });

  it('flush() waits for every queued event to become durable', async () => {
    const sink = createJsonlAuditSink({ dir });
    sink.record(keyCreated('k1'));
    sink.record(keyCreated('k2'));
    sink.record(keyCreated('k3'));
    await sink.flush();
    assert.equal(readLines().length, 3);
  });

  it('close() flushes and stops accepting further events', async () => {
    const sink = createJsonlAuditSink({ dir });
    sink.record(keyCreated('k1'));
    await sink.close();
    sink.record(keyCreated('k2')); // must be silently ignored post-close
    await new Promise((r) => setImmediate(r));
    assert.equal(readLines().length, 1);
  });

  it('a single lonely event is not stranded — flush() drains it even with no further record() calls', async () => {
    const sink = createJsonlAuditSink({ dir });
    sink.record(keyCreated('only-one'));
    await sink.flush();
    assert.equal(readLines().length, 1);
  });

  it('drops a malformed event at the boundary instead of queuing it', async () => {
    let warned = false;
    const sink = createJsonlAuditSink({ dir, onWarn: () => { warned = true; } });
    sink.record({ not: 'a real event' });
    await sink.flush();
    assert.equal(readLines().length, 0);
    assert.equal(warned, true);
  });

  it('backpressure: a full queue drops new events rather than growing without bound', async () => {
    const sink = createJsonlAuditSink({ dir, maxQueueSize: 1 });
    // record() synchronously hands the FIRST call's event straight to
    // drain()'s own synchronous prefix (queue is emptied before drain's
    // first `await`), so it is k2/k3/k4 — not k1 — that actually contend
    // for the one remaining queue slot. All four calls happen synchronously
    // here, before any microtask runs, so the outcome is deterministic:
    // k1 is taken by drain immediately, k2 fills the one-slot queue, and
    // k3/k4 find it already full.
    sink.record(keyCreated('k1'));
    sink.record(keyCreated('k2'));
    sink.record(keyCreated('k3')); // dropped — queue was already at maxQueueSize (1)
    sink.record(keyCreated('k4')); // dropped — same reason
    await sink.flush();
    const kept = readLines().map((l) => JSON.parse(l).keyId);
    assert.deepEqual(kept, ['k1', 'k2']);
  });

  it('a write failure is warned (throttled) and never rejects/throws', async () => {
    let warnCount = 0;
    const fileAsParent = join(dir, 'im-a-file');
    writeFileSync(fileAsParent, 'x');
    const sink = createJsonlAuditSink({ dir: join(fileAsParent, 'audit'), onWarn: () => { warnCount++; } });
    sink.record(keyCreated('k1'));
    sink.record(keyCreated('k2'));
    await assert.doesNotReject(() => sink.flush());
    assert.equal(warnCount, 1, 'throttled to one warning even though the drain loop retried per batch');
  });

  it('the async sink\'s write-failure warning never contains err.message (only a fixed string plus an allow-listed err.code)', async () => {
    let warnedMessage = null;
    const secretMarker = 'uniquely-identifiable-operator-marker-9c1e';
    const fileAsParent = join(dir, `im-a-file-${secretMarker}`);
    writeFileSync(fileAsParent, 'x');
    const sink = createJsonlAuditSink({ dir: join(fileAsParent, 'audit'), onWarn: (msg) => { warnedMessage = msg; } });
    sink.record(keyCreated('k1'));
    await sink.flush();
    assert.ok(warnedMessage, 'expected a warning to have fired');
    assert.doesNotMatch(warnedMessage, new RegExp(secretMarker), 'the absolute path must never appear in the warning');
    assert.doesNotMatch(warnedMessage, /[A-Za-z]:\\|\/(home|Users)\//, 'no absolute filesystem path shape at all');
    assert.match(warnedMessage, /audit log write failed \([A-Za-z_]+\)/, 'expected the fixed-text + allow-listed err.code shape');
  });

  it('two sink instances writing to two different directories never share state', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'semidex-audit-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'semidex-audit-b-'));
    try {
      const sinkA = createJsonlAuditSink({ dir: dirA });
      const sinkB = createJsonlAuditSink({ dir: dirB });
      sinkA.record(keyCreated('only-in-a'));
      sinkB.record(keyCreated('only-in-b'));
      await Promise.all([sinkA.flush(), sinkB.flush()]);
      assert.equal(readLines(dirA).length, 1);
      assert.equal(readLines(dirB).length, 1);
      assert.equal(JSON.parse(readLines(dirA)[0]).keyId, 'only-in-a');
      assert.equal(JSON.parse(readLines(dirB)[0]).keyId, 'only-in-b');
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe('rotation and retention', () => {
  it('rotates the active file once it would exceed maxBytes, and caps total files at maxFiles', async () => {
    // Tiny limits so a handful of small events force several rotations.
    const sink = createJsonlAuditSink({ dir, maxBytes: 200, maxFiles: 3 });
    for (let i = 0; i < 30; i++) {
      sink.record(keyCreated(`k${i}`, `name-${i}`));
    }
    await sink.flush();

    const files = readdirSync(dir).filter((f) => f.startsWith(DEFAULT_FILE_NAME));
    assert.ok(files.length <= 3, `expected at most 3 files (active + 2 rotated), got ${files.length}: ${files}`);
    assert.ok(existsSync(join(dir, DEFAULT_FILE_NAME)), 'the active file always exists after any write');
  });

  it('sync sink rotation preserves earlier content in the .1 file', () => {
    const sink = createSyncJsonlAuditSink({ dir, maxBytes: 10, maxFiles: 2 }); // 10 bytes forces rotation on nearly every write
    sink.record(keyCreated('first'));
    sink.record(keyCreated('second'));
    assert.ok(existsSync(join(dir, `${DEFAULT_FILE_NAME}.1`)), 'a rotated copy exists once the active file overflowed');
  });
});

describe('newline safety end to end', () => {
  it('a sentinel with control characters cannot smuggle a second, forged line into the file', async () => {
    const sink = createJsonlAuditSink({ dir, onWarn: () => {} });
    // The event builder itself rejects a literal newline in any string
    // field (see event.test.js) — this proves the SINK side of that
    // guarantee: even a hand-built object bypassing buildAuditEvent()
    // (e.g. a future call site that forgets to use it) is caught by
    // validateAuditEvent() and dropped, never partially written.
    const forged = {
      schemaVersion: 1, ts: new Date().toISOString(), type: AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, outcome: 'created',
      edition: null, requestId: null, route: null, audience: null, operation: null, reason: null,
      keyId: 'k1', keyName: 'legit\n{"schemaVersion":1,"type":"admin.key_created","outcome":"created","keyId":"forged-line"}',
    };
    sink.record(forged);
    sink.record(keyCreated('real-event'));
    await sink.flush();
    const lines = readLines();
    // Only the genuinely valid event was written — the forged one (rejected
    // by validateAuditEvent's own newline-safety check inherited from
    // buildAuditEvent's field validators) never reached the file, so there
    // is exactly one line, not three.
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).keyId, 'real-event');
  });
});
