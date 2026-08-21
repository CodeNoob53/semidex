// A write to either destination-changing setting is accepted only from a direct
// loopback connection to this process, independent of ADMIN_ALLOW_REMOTE,
// and regardless of whether something in front of this process (a reverse
// proxy, a wrapper backend's own HTTP client) makes the connection LOOK
// loopback-originated at the TCP layer while relaying a remote caller.
//
// Two layers of proof:
//   1. Pure req-level unit tests against evaluateDirectLoopbackConnection()
//      directly — covers a genuinely non-loopback remoteAddress, which a
//      real same-process fetch() cannot produce.
//   2. Real HTTP server + real fetch() tests against PATCH /api/settings —
//      covers the actual route wiring, the "proxy on the same host" shape
//      (physically loopback, but carrying a forwarding header — the one
//      real client fetch() CAN simulate), and that unrelated settings and
//      two independent app instances are both unaffected.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateDirectLoopbackConnection } from '../../../src/core/security/direct-loopback-request.js';
import { createSettingsService } from '../../../src/core/settings/service.js';
import { withServer } from '../admin/ui-test-helpers.js';

function tempSettingsPath(dir) {
  return join(dir, 'settings.json');
}

async function httpJson(base, path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe('evaluateDirectLoopbackConnection() — pure req-level check', () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

  it('loopback IPv4, no headers -> ok', () => {
    assert.deepEqual(evaluateDirectLoopbackConnection(req('127.0.0.1')), { ok: true });
  });

  it('loopback IPv6 (::1), no headers -> ok', () => {
    assert.deepEqual(evaluateDirectLoopbackConnection(req('::1')), { ok: true });
  });

  it('IPv4-mapped IPv6 loopback (dual-stack listener), no headers -> ok', () => {
    assert.deepEqual(evaluateDirectLoopbackConnection(req('::ffff:127.0.0.1')), { ok: true });
  });

  it('a genuinely remote/LAN address is rejected regardless of headers', () => {
    assert.deepEqual(evaluateDirectLoopbackConnection(req('192.168.1.50')), { ok: false, reason: 'not_loopback' });
  });

  it('a public internet address is rejected', () => {
    // 203.0.113.0/24 is IANA TEST-NET-3 (RFC 5737) — reserved for
    // documentation, never a real loopback/private address.
    assert.deepEqual(evaluateDirectLoopbackConnection(req('203.0.113.5')), { ok: false, reason: 'not_loopback' });
  });

  it('a loopback remoteAddress carrying X-Forwarded-For is rejected — the same-host reverse-proxy shape', () => {
    assert.deepEqual(
      evaluateDirectLoopbackConnection(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })),
      { ok: false, reason: 'forwarding_headers_present' },
    );
  });

  it('a loopback remoteAddress carrying Forwarded is rejected', () => {
    assert.deepEqual(
      evaluateDirectLoopbackConnection(req('127.0.0.1', { forwarded: 'for=203.0.113.5' })),
      { ok: false, reason: 'forwarding_headers_present' },
    );
  });

  it('a loopback remoteAddress carrying X-Real-IP is rejected', () => {
    assert.deepEqual(
      evaluateDirectLoopbackConnection(req('127.0.0.1', { 'x-real-ip': '203.0.113.5' })),
      { ok: false, reason: 'forwarding_headers_present' },
    );
  });

  it('a forwarding header wins over a loopback remoteAddress even when the header value itself LOOKS loopback (presence, not value, is what disqualifies)', () => {
    assert.deepEqual(
      evaluateDirectLoopbackConnection(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })),
      { ok: false, reason: 'forwarding_headers_present' },
    );
  });

  it('an empty forwarding header value still disqualifies — presence, not truthiness, is what this checks (fail closed)', () => {
    assert.deepEqual(
      evaluateDirectLoopbackConnection(req('127.0.0.1', { 'x-forwarded-for': '' })),
      { ok: false, reason: 'forwarding_headers_present' },
    );
  });

  it('a string-array header value (Node\'s own dedup shape for a repeated header) disqualifies — the value is never inspected, only own-property presence', () => {
    assert.deepEqual(
      evaluateDirectLoopbackConnection(req('127.0.0.1', { 'x-forwarded-for': ['203.0.113.5', '198.51.100.1'] })),
      { ok: false, reason: 'forwarding_headers_present' },
    );
  });

  it('an empty string-array header value disqualifies too', () => {
    assert.deepEqual(
      evaluateDirectLoopbackConnection(req('127.0.0.1', { 'x-forwarded-for': [] })),
      { ok: false, reason: 'forwarding_headers_present' },
    );
  });

  it('a header value that is present but null/undefined still disqualifies — own-property existence is the whole check, never a truthiness check on the value', () => {
    assert.deepEqual(
      evaluateDirectLoopbackConnection(req('127.0.0.1', { 'x-real-ip': undefined })),
      { ok: false, reason: 'forwarding_headers_present' },
    );
    assert.deepEqual(
      evaluateDirectLoopbackConnection(req('127.0.0.1', { via: null })),
      { ok: false, reason: 'forwarding_headers_present' },
    );
  });

  it('a whitespace-only forwarding header value disqualifies (not just non-empty non-whitespace values)', () => {
    assert.deepEqual(
      evaluateDirectLoopbackConnection(req('127.0.0.1', { 'cf-connecting-ip': '   ' })),
      { ok: false, reason: 'forwarding_headers_present' },
    );
  });

  it('a request with no headers object at all still evaluates loopback correctly (no crash on missing headers)', () => {
    assert.deepEqual(
      evaluateDirectLoopbackConnection({ socket: { remoteAddress: '127.0.0.1' } }),
      { ok: true },
    );
  });
});

describe('PATCH /api/settings — direct loopback succeeds for destination-changing settings', () => {
  let dir;
  it('a direct loopback write to QDRANT_URL succeeds and persists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'semidex-loopback-boundary-test-'));
    try {
      const settingsPath = tempSettingsPath(dir);
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      await withServer(async (base) => {
        const { status, json } = await httpJson(base, '/api/settings', {
          method: 'PATCH',
          body: { changes: { QDRANT_URL: 'https://my-cluster.qdrant.example.com:6333' } },
        });
        assert.equal(status, 200);
        assert.equal(json.settings[0].configuredValue, 'https://my-cluster.qdrant.example.com:6333');
        const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        assert.equal(onDisk.QDRANT_URL, 'https://my-cluster.qdrant.example.com:6333');
      }, { settingsService });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a direct loopback write to OLLAMA_URL succeeds and persists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'semidex-loopback-boundary-test-'));
    try {
      const settingsPath = tempSettingsPath(dir);
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      await withServer(async (base) => {
        const { status, json } = await httpJson(base, '/api/settings', {
          method: 'PATCH',
          body: { changes: { OLLAMA_URL: 'http://192.168.1.20:11434' } },
        });
        assert.equal(status, 200);
        assert.equal(json.settings[0].configuredValue, 'http://192.168.1.20:11434');
        const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        assert.equal(onDisk.OLLAMA_URL, 'http://192.168.1.20:11434');
      }, { settingsService });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PATCH /api/settings — a same-host reverse-proxy-shaped request cannot write QDRANT_URL/OLLAMA_URL', () => {
  let dir;

  it('a physically-loopback request carrying X-Forwarded-For is rejected 403 loopback_required, and the write never applies', async () => {
    dir = mkdtempSync(join(tmpdir(), 'semidex-loopback-boundary-test-'));
    try {
      const settingsPath = tempSettingsPath(dir);
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      await withServer(async (base) => {
        const { status, json } = await httpJson(base, '/api/settings', {
          method: 'PATCH',
          headers: { 'X-Forwarded-For': '203.0.113.5' },
          body: { changes: { QDRANT_URL: 'https://attacker.example.com:6333' } },
        });
        assert.equal(status, 403);
        assert.equal(json.error.code, 'loopback_required');
        // The whole point: no file write happened at all, not even a
        // partial one — settings.json must not exist yet (nothing was ever
        // written to it in this test).
        assert.throws(() => readFileSync(settingsPath, 'utf-8'));
      }, { settingsService });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejected regardless of ADMIN_ALLOW_REMOTE-style intent — the boundary applies even to a caller relayed through a same-host proxy, not just to a genuinely remote socket', async () => {
    // This app is still bound to and reached over 127.0.0.1 (withServer's
    // own default) — the point is that the FORWARDING HEADER alone, not the
    // remote address, is what this deployment shape hinges on: a same-host
    // reverse proxy relaying a LAN/remote caller connects to this process
    // over ITS OWN loopback socket, so remoteAddress alone could never
    // catch this. See direct-loopback-request.js's own header comment.
    dir = mkdtempSync(join(tmpdir(), 'semidex-loopback-boundary-test-'));
    try {
      const settingsPath = tempSettingsPath(dir);
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      await withServer(async (base) => {
        const { status, json } = await httpJson(base, '/api/settings', {
          method: 'PATCH',
          headers: { Forwarded: 'for=203.0.113.5;proto=https' },
          body: { changes: { OLLAMA_URL: 'http://attacker.example.com:11434' } },
        });
        assert.equal(status, 403);
        assert.equal(json.error.code, 'loopback_required');
      }, { settingsService });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a null-value deletion (revert to default) of QDRANT_URL is gated the same way as a real value change', async () => {
    dir = mkdtempSync(join(tmpdir(), 'semidex-loopback-boundary-test-'));
    try {
      const settingsPath = tempSettingsPath(dir);
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      await withServer(async (base) => {
        const { status, json } = await httpJson(base, '/api/settings', {
          method: 'PATCH',
          headers: { 'X-Forwarded-For': '203.0.113.5' },
          body: { changes: { QDRANT_URL: null } },
        });
        assert.equal(status, 403);
        assert.equal(json.error.code, 'loopback_required');
      }, { settingsService });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a batch mixing a sensitive key with an unrelated key is rejected as a whole (all-or-nothing) — the unrelated key is not applied either', async () => {
    dir = mkdtempSync(join(tmpdir(), 'semidex-loopback-boundary-test-'));
    try {
      const settingsPath = tempSettingsPath(dir);
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      await withServer(async (base) => {
        const { status, json } = await httpJson(base, '/api/settings', {
          method: 'PATCH',
          headers: { 'X-Forwarded-For': '203.0.113.5' },
          body: { changes: { RRF_K: 90, QDRANT_URL: 'https://attacker.example.com:6333' } },
        });
        assert.equal(status, 403);
        assert.equal(json.error.code, 'loopback_required');
        assert.throws(() => readFileSync(settingsPath, 'utf-8'), 'RRF_K must not have been written either — the whole batch is rejected');
      }, { settingsService });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PATCH /api/settings — unrelated settings keep today\'s behavior unchanged', () => {
  let dir;

  it('a proxy-shaped request (forwarding header present) can still write an unrelated setting (RRF_K) — the boundary is narrow, not a general Admin-auth wall', async () => {
    dir = mkdtempSync(join(tmpdir(), 'semidex-loopback-boundary-test-'));
    try {
      const settingsPath = tempSettingsPath(dir);
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      await withServer(async (base) => {
        const { status, json } = await httpJson(base, '/api/settings', {
          method: 'PATCH',
          headers: { 'X-Forwarded-For': '203.0.113.5' },
          body: { changes: { RRF_K: 90 } },
        });
        assert.equal(status, 200);
        assert.equal(json.settings[0].configuredValue, 90);
        const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        assert.equal(onDisk.RRF_K, 90);
      }, { settingsService });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a direct loopback request updating an unrelated setting still works exactly as before this change', async () => {
    dir = mkdtempSync(join(tmpdir(), 'semidex-loopback-boundary-test-'));
    try {
      const settingsPath = tempSettingsPath(dir);
      const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      await withServer(async (base) => {
        const { status, json } = await httpJson(base, '/api/settings', {
          method: 'PATCH',
          body: { changes: { HYBRID_PREFETCH_LIMIT: 5 } },
        });
        assert.equal(status, 200);
        assert.equal(json.settings[0].configuredValue, 5);
      }, { settingsService });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PATCH /api/settings — two app instances do not share loopback-boundary policy state', () => {
  it('a rejected proxy-shaped write on instance A and an accepted direct-loopback write on instance B run independently, with no cross-instance leakage', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'semidex-loopback-boundary-test-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'semidex-loopback-boundary-test-b-'));
    try {
      const settingsServiceA = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dirA) });
      const settingsServiceB = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dirB) });

      await withServer(async (baseA) => {
        await withServer(async (baseB) => {
          // Interleaved: instance A's rejected write must not somehow
          // "consume" or otherwise affect instance B's independent
          // evaluation of its own, unrelated, legitimate request.
          const rejectedOnA = await httpJson(baseA, '/api/settings', {
            method: 'PATCH',
            headers: { 'X-Forwarded-For': '203.0.113.5' },
            body: { changes: { QDRANT_URL: 'https://attacker.example.com:6333' } },
          });
          const acceptedOnB = await httpJson(baseB, '/api/settings', {
            method: 'PATCH',
            body: { changes: { QDRANT_URL: 'https://legit-cluster.qdrant.example.com:6333' } },
          });
          const rejectedOnAAgain = await httpJson(baseA, '/api/settings', {
            method: 'PATCH',
            headers: { 'X-Forwarded-For': '203.0.113.5' },
            body: { changes: { QDRANT_URL: 'https://attacker.example.com:6333' } },
          });

          assert.equal(rejectedOnA.status, 403);
          assert.equal(rejectedOnA.json.error.code, 'loopback_required');
          assert.equal(acceptedOnB.status, 200);
          assert.equal(acceptedOnB.json.settings[0].configuredValue, 'https://legit-cluster.qdrant.example.com:6333');
          assert.equal(rejectedOnAAgain.status, 403, 'instance A must still reject after instance B\'s successful write — no shared state leaked permission across instances');

          let onDiskARaw = '{}';
          try {
            onDiskARaw = readFileSync(tempSettingsPath(dirA), 'utf-8');
          } catch {
            // Expected: instance A's write was rejected before any file was
            // ever created, so settings.json legitimately does not exist.
          }
          const onDiskA = JSON.parse(onDiskARaw);
          assert.equal(onDiskA.QDRANT_URL, undefined, 'instance A\'s settings.json must never have been written');
          const onDiskB = JSON.parse(readFileSync(tempSettingsPath(dirB), 'utf-8'));
          assert.equal(onDiskB.QDRANT_URL, 'https://legit-cluster.qdrant.example.com:6333');
        }, { settingsService: settingsServiceB });
      }, { settingsService: settingsServiceA });
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
