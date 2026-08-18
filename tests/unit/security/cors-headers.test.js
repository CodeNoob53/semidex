// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md
// Finding P1-1 "No Origin/CSRF enforcement on state-changing routes" AND
// the "Confirmed-safe boundaries" claim that no route ever emits
// Access-Control-Allow-* headers.
//
// register-neutral-routes.js's own header comment (line ~18) states:
// "Design doc §7/§10: JSON-only, localhost-only by default, no CORS, no
// auth (the loopback bind IS the auth boundary for MVP)." core/http/http.js
// (line ~8) repeats: "No CORS headers (§10 of the design doc: same-origin
// only, UI is served by this same process)."
//
// This file characterizes the HEADER/PREFLIGHT half of that picture, for
// BOTH the Full (createApp) and Lite (createLiteApp) compositions — the two
// have different route registration, so the claim has to hold for each
// independently rather than being asserted once against Full and assumed
// for Lite.
//
// Read this together with csrf-state-changing-routes.test.js, which proves
// the EXECUTION half. Note carefully what the absence of ACAO does and does
// not mean:
//   - It BLOCKS a cross-origin attacker page from READING any response.
//     For confidentiality this currently works in Semidex's favour; the
//     missing header is not itself the vulnerability.
//   - It does NOT stop the request from EXECUTING. For the browser-simple
//     request class (POST with a CORS-safelisted content-type, no custom
//     headers) the handler runs server-side regardless of Origin, because
//     nothing consults Origin at all. That is the actual finding.
//   - The absence of an OPTIONS handler incidentally protects the
//     DELETE/PATCH/JSON-bodied routes, since their mandatory preflight
//     fails. That protection is accidental and would be destroyed by a
//     naive "add permissive CORS" change.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from '../admin/ui-test-helpers.js';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';

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

async function serve(app, fn) {
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

async function withApp(fn) {
  await serve(createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) }), fn);
}

// Mirrors lite-full-route-parity.test.js's own Lite boot: createLiteApp()
// needs an explicit jobRegistry (createJobRegistry throws without a
// spawnIndexer), and the fake child is never actually spawned by any
// request this file makes.
async function withLiteApp(fn) {
  const jobRegistry = createJobRegistry({ spawnIndexer: () => makeFakeChildForSpawn(), baseEnv: {} });
  await serve(createLiteApp({
    adapter: makeStubAdapter(),
    embedQuery: async () => ({ dense: [], sparse: {} }),
    jobRegistry,
  }), fn);
}

const CORS_HEADER_NAMES = [
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'access-control-max-age',
  'access-control-expose-headers',
];

function assertNoCorsHeaders(res, context) {
  for (const name of CORS_HEADER_NAMES) {
    assert.equal(res.headers.get(name), null, `${context}: expected no "${name}" header, found ${res.headers.get(name)}`);
  }
}

describe('CORS headers — confirmed-safe-boundary characterization (no server-side CORS enforcement exists)', () => {
  it('GET /api/health from a foreign Origin gets no Access-Control-* headers (no allow-list, no deny either)', async () => {
    await withApp(async (base) => {
      const res = await fetch(base + '/api/health', {
        headers: { Origin: 'https://evil.example.com' },
      });
      assert.equal(res.status, 200);
      assertNoCorsHeaders(res, 'GET /api/health with foreign Origin');
    });
  });

  it('OPTIONS preflight against /api/settings is still NOT specially handled — no preflight approval was introduced by the hardening pass', async () => {
    await withApp(async (base) => {
      const res = await fetch(base + '/api/settings', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.com',
          'Access-Control-Request-Method': 'PATCH',
        },
      });
      // The router registers only GET/POST/PATCH/DELETE handlers, and the
      // security layer rejects this cross-origin OPTIONS before dispatch.
      // Either way it must never be a 2xx preflight approval, and must never
      // carry Access-Control-* headers — that is what keeps DELETE/PATCH
      // unreachable from a cross-origin page.
      assert.ok(res.status === 403 || res.status === 404, `expected 403 or 404, got ${res.status}`);
      assertNoCorsHeaders(res, 'OPTIONS preflight');
    });
  });

  it('a browser-simple POST (text/plain) from a foreign Origin is now rejected 403 before route logic', async () => {
    await withApp(async (base) => {
      const res = await fetch(base + '/api/search', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example.com',
          'Content-Type': 'text/plain',
        },
        body: JSON.stringify({ collection: 'demo', query: 'x' }),
      });
      // Previously this reached the handler and returned a 400 from JSON
      // parsing. It is now refused by the Origin check ahead of dispatch.
      assert.equal(res.status, 403);
      assertNoCorsHeaders(res, 'cross-origin simple POST');
    });
  });
});

// The Lite composition registers a different route set than Full (see
// lite-full-route-parity.test.js), so "no CORS anywhere" has to be
// established against it separately rather than inherited from the Full
// assertions above.
describe('CORS headers — Lite composition (createLiteApp) characterized independently of Full', () => {
  it('GET /api/health from a foreign Origin gets no Access-Control-* headers', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/health', {
        headers: { Origin: 'https://evil.example.com' },
      });
      assert.equal(res.status, 200);
      assertNoCorsHeaders(res, 'Lite: GET /api/health with foreign Origin');
    });
  });

  it('OPTIONS preflight against /api/settings is unhandled in Lite too (no preflight approval)', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/settings', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.com',
          'Access-Control-Request-Method': 'PATCH',
        },
      });
      assert.ok(res.status === 403 || res.status === 404, `expected 403 or 404, got ${res.status}`);
      assertNoCorsHeaders(res, 'Lite: OPTIONS preflight');
    });
  });

  it('a browser-simple cross-origin POST is rejected in the Lite composition too — Full and Lite share one policy', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/search', {
        method: 'POST',
        headers: { Origin: 'https://evil.example.com', 'Content-Type': 'text/plain' },
        body: JSON.stringify({ collection: 'demo', query: 'x' }),
      });
      assert.equal(res.status, 403);
      assertNoCorsHeaders(res, 'Lite: cross-origin simple POST');
    });
  });
});
