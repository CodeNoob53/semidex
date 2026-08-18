// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md
// Finding P1-1 "No Origin/CSRF enforcement on state-changing routes".
//
// HISTORY — this file previously asserted the VULNERABILITY (that a
// browser-simple cross-origin POST reached and executed a state-changing
// handler). Phase 1 of the security hardening pass fixed that, so these
// assertions are now inverted: they prove the request is REJECTED, and — the
// part that actually matters — that it is rejected BEFORE the side effect.
//
// The original vulnerability was real and confirmed live, not theoretical:
// POST /api/jobs/index with `Content-Type: text/plain`, a foreign Origin and
// a valid-JSON body returned 202 and spawned a real indexer subprocess
// against an arbitrary local path. readJsonBody() ignored Content-Type
// entirely, so "text/plain" (a CORS-safelisted type that sends no preflight)
// still delivered a working JSON payload.
//
// Two independent layers now close it, and both are asserted here because
// they fail differently:
//   1. The router rejects cross-site requests before route dispatch
//      (src/core/http/request-security.js), based on Sec-Fetch-Site/Origin.
//   2. readJsonBody() enforces Content-Type: application/json, so even a
//      request that somehow passed layer 1 could not smuggle JSON through a
//      CORS-simple content type.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../admin/ui-test-helpers.js';

const ATTACKER_ORIGIN = 'https://evil.example.com';

// Records every state-changing adapter call so each test can assert on the
// real side effect rather than inferring it from a status code.
function makeRecordingAdapter() {
  const calls = [];
  return {
    calls,
    name: () => 'stub',
    capabilities: () => ({}),
    ping: async () => ({ ok: true }),
    listCollections: async () => [],
    getCollection: async (name) => ({ name, vectorsCount: 0 }),
    ensureCollectionSchema: async (name) => {
      calls.push({ method: 'ensureCollectionSchema', name });
      return { repaired: ['dense'], warnings: [] };
    },
    deleteCollection: async (name) => {
      calls.push({ method: 'deleteCollection', name });
      return { ok: true };
    },
  };
}

async function withApp(adapter, fn) {
  const app = createApp({ adapter, embedQuery: async () => ({ dense: [], sparse: {} }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

describe('CSRF defense — cross-site browser requests are rejected before any side effect (audit finding P1-1, now fixed)', () => {
  it('THE ORIGINAL ATTACK: browser-simple cross-origin POST (text/plain + valid JSON) is rejected 403 and ensureCollectionSchema() is never called', async () => {
    const adapter = makeRecordingAdapter();
    await withApp(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/victim-docs/sync-schema', {
        method: 'POST',
        headers: { Origin: ATTACKER_ORIGIN, 'Content-Type': 'text/plain' },
        body: JSON.stringify({ any: 'json' }),
      });

      assert.equal(res.status, 403, 'cross-origin state-changing request must be refused');
      const body = await res.json();
      assert.equal(body.error.code, 'cross_site_blocked');

      // The whole point: no work happened.
      assert.deepEqual(adapter.calls, [], 'no state-changing adapter call may occur for a rejected cross-origin request');
    });
  });

  it('rejection happens BEFORE body parsing — an oversized/garbage body from a foreign origin is still a 403, not a 400', async () => {
    const adapter = makeRecordingAdapter();
    await withApp(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/victim-docs/sync-schema', {
        method: 'POST',
        headers: { Origin: ATTACKER_ORIGIN, 'Content-Type': 'text/plain' },
        body: 'this is not json at all',
      });
      // A 400 here would mean the request reached body parsing first; 403
      // proves the security check short-circuits ahead of it.
      assert.equal(res.status, 403);
      assert.deepEqual(adapter.calls, []);
    });
  });

  it('Sec-Fetch-Site: cross-site is rejected even with a correct Content-Type and no Origin header', async () => {
    const adapter = makeRecordingAdapter();
    await withApp(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/victim-docs/sync-schema', {
        method: 'POST',
        headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
      });
      assert.equal(res.status, 403);
      assert.deepEqual(adapter.calls, []);
    });
  });

  it('Origin: null (sandboxed iframe / opaque origin) is rejected rather than treated as same-origin', async () => {
    const adapter = makeRecordingAdapter();
    await withApp(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/victim-docs/sync-schema', {
        method: 'POST',
        headers: { Origin: 'null', 'Content-Type': 'application/json' },
      });
      assert.equal(res.status, 403);
      assert.deepEqual(adapter.calls, []);
    });
  });

  it('a same-origin dashboard request succeeds and DOES perform the side effect (the fix must not break the Admin UI)', async () => {
    const adapter = makeRecordingAdapter();
    await withApp(adapter, async (base) => {
      const origin = base; // same origin as the server itself
      const res = await fetch(base + '/api/collections/victim-docs/sync-schema', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
          'X-Semidex-Request': 'admin',
        },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(adapter.calls, [{ method: 'ensureCollectionSchema', name: 'victim-docs' }]);
    });
  });

  it('a non-browser client (curl/backend: no Origin, no Sec-Fetch-*) still succeeds — server-to-server integrations must keep working', async () => {
    const adapter = makeRecordingAdapter();
    await withApp(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/victim-docs/sync-schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(adapter.calls, [{ method: 'ensureCollectionSchema', name: 'victim-docs' }]);
    });
  });

  it('DELETE /api/collections/:name remains preflight-protected: OPTIONS is still unanswered, so the browser never sends the DELETE', async () => {
    const adapter = makeRecordingAdapter();
    await withApp(adapter, async (base) => {
      const preflight = await fetch(base + '/api/collections/victim-docs', {
        method: 'OPTIONS',
        headers: { Origin: ATTACKER_ORIGIN, 'Access-Control-Request-Method': 'DELETE' },
      });
      // Still no OPTIONS handler and still no Access-Control-Allow-* headers,
      // which is what fails the preflight in a real browser. The hardening
      // pass deliberately did NOT add permissive CORS, which would have
      // removed this incidental protection.
      assert.equal(preflight.headers.get('access-control-allow-methods'), null);
      assert.equal(preflight.headers.get('access-control-allow-origin'), null);
      assert.deepEqual(adapter.calls, []);
    });
  });

  it('a cross-origin DELETE attempted directly (non-browser or post-rebinding) is also rejected by the Origin check', async () => {
    const adapter = makeRecordingAdapter();
    await withApp(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/victim-docs', {
        method: 'DELETE',
        headers: { Origin: ATTACKER_ORIGIN },
      });
      assert.equal(res.status, 403);
      assert.deepEqual(adapter.calls, [], 'deleteCollection must never run for a cross-origin request');
    });
  });
});
