// createRouter() unit tests — no HTTP server, fake req/res objects.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../../src/shared/admin/router.js';
import { AUDIENCE, OPERATION, COST_CLASS } from '../../../src/core/http/route-audience.js';

// Route metadata is mandatory since the Admin/Integration split (fail-closed
// registration — see src/core/http/route-audience.js). These tests exercise
// ROUTING MECHANICS (matching, params, error handling), not classification,
// so they all register with the same minimal admin metadata. The
// classification itself is asserted in
// tests/unit/security/route-audience-classification.test.js.
const META = { audience: AUDIENCE.ADMIN, operation: OPERATION.READ, costClass: COST_CLASS.LOW };

// A realistic same-origin request. The router now enforces Host/cross-site
// policy before dispatch (src/core/http/request-security.js), so a fake req
// must carry the headers a real node:http request always would — a missing
// Host is malformed under HTTP/1.1 and is deliberately rejected. Host
// validation itself is covered in tests/unit/security/.
function fakeReq(method, url, headers = {}) {
  return { method, url, headers: { host: '127.0.0.1:8642', ...headers } };
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(code, headers) { res.statusCode = code; res.headers = headers; },
    end(payload) { res.body = payload; },
  };
  return res;
}

describe('createRouter — matching', () => {
  it('dispatches GET to the matching handler', async () => {
    const router = createRouter();
    let called = false;
    router.get('/api/health', () => { called = true; }, META);
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());
    assert.equal(called, true);
  });

  it('extracts and URL-decodes route params', async () => {
    const router = createRouter();
    let received = null;
    router.get('/api/collections/:name', ({ params }) => { received = params; }, META);
    await router.handleRequest(fakeReq('GET', '/api/collections/my%20collection'), fakeRes());
    assert.deepEqual(received, { name: 'my collection' });
  });

  it('parses query string into a URLSearchParams', async () => {
    const router = createRouter();
    let received = null;
    router.get('/api/collections', ({ query }) => { received = query; }, META);
    await router.handleRequest(fakeReq('GET', '/api/collections?limit=5'), fakeRes());
    assert.equal(received.get('limit'), '5');
  });

  it('does not match a path with a different segment count', async () => {
    const router = createRouter();
    let called = false;
    router.get('/api/collections/:name', () => { called = true; }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/collections/a/documents'), res);
    assert.equal(called, false);
    assert.equal(res.statusCode, 404);
  });
});

describe('createRouter — malformed input', () => {
  it('returns 400 bad_request for a malformed percent-encoded route param, without rejecting handleRequest', async () => {
    const router = createRouter();
    let handlerCalled = false;
    router.get('/api/collections/:name', () => { handlerCalled = true; }, META);
    const res = fakeRes();
    // decodeURIComponent('%E0%A4%A') throws URIError: URI malformed.
    await assert.doesNotReject(router.handleRequest(fakeReq('GET', '/api/collections/%E0%A4%A'), res));
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'bad_request');
    assert.equal(handlerCalled, false);
  });
});

describe('createRouter — unknown route / wrong method', () => {
  it('returns 404 with a JSON error envelope for an unknown path', async () => {
    const router = createRouter();
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/nope'), res);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'not_found');
  });

  it('returns 404 (not 405) for a known path with the wrong method — consistent with unknown-route status', async () => {
    const router = createRouter();
    router.get('/api/collections', () => {}, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('POST', '/api/collections'), res);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'not_found');
  });
});

describe('createRouter — error handling', () => {
  it('converts a thrown HttpError into its status/code/message', async () => {
    const router = createRouter();
    const { notFound } = await import('../../../src/core/http/http.js');
    router.get('/api/collections/:name', () => { throw notFound('Collection "x" not found'); }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/collections/x'), res);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'not_found');
    assert.match(body.error.message, /Collection "x" not found/);
  });

  it('converts an unexpected thrown error into a 500 internal_error', async () => {
    const router = createRouter();
    router.get('/api/boom', () => { throw new Error('kaboom'); }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/boom'), res);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'internal_error');
    assert.match(body.error.message, /kaboom/);
  });

  it('converts a rejected async handler into the correct error response', async () => {
    const router = createRouter();
    const { badRequest } = await import('../../../src/core/http/http.js');
    router.get('/api/async-fail', async () => { throw badRequest('nope'); }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/async-fail'), res);
    assert.equal(res.statusCode, 400);
  });

  // Regression (P1, code review): an UNEXPECTED thrown error (not a
  // deliberate HttpError — a raw exception from a StorageAdapter/Qdrant
  // client call, the kind api/collections.js's sync-schema route can
  // surface from ensureCollectionSchema()) reached this 500 handler
  // completely unredacted, even though every other admin-API error path
  // that touches raw Qdrant/process output (jobs/registry.js's
  // appendLine(), task-registry.js's runTracked()) already sanitises at
  // capture time. Confirmed live: a credentialed Qdrant URL or QDRANT_KEY
  // embedded in an unexpected error message would reach the client verbatim
  // through this one path.
  it('redacts a literal QDRANT_KEY occurrence in an unexpected error message before sending it', async () => {
    const originalKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'sk-super-secret-token';
    try {
      const router = createRouter();
      router.get('/api/boom', () => { throw new Error('auth failed with key sk-super-secret-token'); }, META);
      const res = fakeRes();
      await router.handleRequest(fakeReq('GET', '/api/boom'), res);
      assert.equal(res.statusCode, 500);
      const body = JSON.parse(res.body);
      assert.doesNotMatch(body.error.message, /sk-super-secret-token/, 'the raw key must never reach the HTTP response');
      assert.match(body.error.message, /\[REDACTED\]/);
    } finally {
      process.env.QDRANT_KEY = originalKey;
    }
  });

  it('redacts credentials/query string out of a URL embedded in an unexpected error message', async () => {
    const router = createRouter();
    router.get('/api/boom', () => {
      throw new Error('connecting to https://user:pass@qdrant.example.com/collections?api_key=sk-live-abc123');
    }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/boom'), res);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.doesNotMatch(body.error.message, /user:pass|api_key=sk-live-abc123/, 'credentials and query params must not survive in the response');
    assert.match(body.error.message, /https:\/\/qdrant\.example\.com/, 'the host-only form should still be present');
  });

  it('a deliberate HttpError (already-safe, fixed wording) is NOT run through redaction — it has nothing to redact and must reach the client verbatim', async () => {
    // Guards against an overzealous fix: HttpError messages (badRequest/
    // notFound/conflict/etc.) are always static, developer-authored
    // strings, never raw external error text — sanitiseErrorMessage()
    // must only apply to the UNEXPECTED-error branch, not this one, or a
    // legitimate message could be mangled by the URL-credential regex.
    const router = createRouter();
    const { notFound } = await import('../../../src/core/http/http.js');
    router.get('/api/collections/:name', () => { throw notFound('Collection "https://example.com/x" not found'); }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/collections/x'), res);
    const body = JSON.parse(res.body);
    assert.equal(body.error.message, 'Collection "https://example.com/x" not found');
  });
});
