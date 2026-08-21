// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md §10 step
// 10 ("Security headers"). Proves core/http/request-security.js's
// applySecurityResponseHeaders() is actually reaching every response shape
// this process can send — API success, API error, 404, a rejected
// (pre-dispatch) request, and the static UI shell (success and 405/503/404)
// — for BOTH the Full and Lite compositions, not just one of them.
//
// Deliberately does not re-test the CONTENT of Origin/Host rejection logic
// (see request-security-policy.test.js and csrf-state-changing-routes.test.js
// for that) — only that whatever status code comes back, the same header
// set rides along with it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { withServer as withFullApp } from '../admin/ui-test-helpers.js';
import { OPEN_INTEGRATION_POLICY } from './test-integration-policy.js';

function makeStubAdapter() {
  return {
    name: () => 'stub',
    capabilities: () => ({}),
    ping: async () => ({ ok: true }),
    listCollections: async () => [],
    getCollection: async () => null,
  };
}

function makeFakeChildForSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

async function withLiteApp(fn) {
  const jobRegistry = createJobRegistry({
    spawnIndexer: () => makeFakeChildForSpawn(),
    baseEnv: {},
  });
  const app = createLiteApp({
    adapter: makeStubAdapter(),
    embedQuery: async () => ({ dense: [], sparse: {} }),
    jobRegistry,
    integrationPolicy: OPEN_INTEGRATION_POLICY,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

// Asserted against every response regardless of status code or route shape.
function assertSharedSecurityHeaders(res, label) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${label}: X-Content-Type-Options`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY', `${label}: X-Frame-Options`);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${label}: Referrer-Policy`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, `${label}: Content-Security-Policy must be present`);
  assert.match(csp, /frame-ancestors 'none'/, `${label}: CSP must deny framing`);
  assert.match(csp, /default-src 'self'/, `${label}: CSP must default to same-origin`);
  assert.ok(!/unsafe-inline/.test(csp.match(/script-src[^;]*/)?.[0] ?? ''), `${label}: script-src must not allow unsafe-inline`);
}

for (const [label, withApp] of [['Full', withFullApp], ['Lite', withLiteApp]]) {
  describe(`${label} composition — response security headers`, () => {
    it('API success response (GET /api/health)', async () => {
      await withApp(async (base) => {
        const res = await fetch(base + '/api/health');
        assert.equal(res.status, 200);
        assertSharedSecurityHeaders(res, 'API success');
      });
    });

    it('API 404 response (unknown route)', async () => {
      await withApp(async (base) => {
        const res = await fetch(base + '/api/this-route-does-not-exist');
        assert.equal(res.status, 404);
        assertSharedSecurityHeaders(res, 'API 404');
      });
    });

    it('API error response (malformed percent-encoding -> 400)', async () => {
      await withApp(async (base) => {
        const res = await fetch(base + '/api/collections/%E0%A4%A');
        assert.equal(res.status, 400);
        assertSharedSecurityHeaders(res, 'API error');
      });
    });

    it('a request rejected pre-dispatch by the cross-site policy still carries the headers', async () => {
      await withApp(async (base) => {
        const res = await fetch(base + '/api/jobs/index', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://attacker.example',
            'Sec-Fetch-Site': 'cross-site',
          },
          body: JSON.stringify({ collection: 'c', path: '.' }),
        });
        assert.equal(res.status, 403);
        assertSharedSecurityHeaders(res, 'cross-site rejection');
      });
    });

    it('static UI shell (GET /) carries the same headers', async () => {
      await withApp(async (base) => {
        const res = await fetch(base + '/');
        // Either a real dist/admin-ui build (200) or "not built yet" (503) —
        // both are legitimate states for this repo checkout; either way the
        // header policy must be present.
        assert.ok(res.status === 200 || res.status === 503, `unexpected status ${res.status}`);
        assertSharedSecurityHeaders(res, 'static UI');
      });
    });

    it('static UI 404 (unknown asset path) carries the same headers', async () => {
      await withApp(async (base) => {
        const res = await fetch(base + '/no-such-asset.js');
        assert.equal(res.status, 404);
        assertSharedSecurityHeaders(res, 'static 404');
      });
    });

    it('static UI 405 (non-GET method) carries the same headers', async () => {
      await withApp(async (base) => {
        const res = await fetch(base + '/main.js', { method: 'POST' });
        assert.equal(res.status, 405);
        assertSharedSecurityHeaders(res, 'static 405');
      });
    });
  });
}
