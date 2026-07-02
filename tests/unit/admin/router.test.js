// createRouter() unit tests — no HTTP server, fake req/res objects.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../../src/admin/router.js';

function fakeReq(method, url) {
  return { method, url };
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
    router.get('/api/health', () => { called = true; });
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());
    assert.equal(called, true);
  });

  it('extracts and URL-decodes route params', async () => {
    const router = createRouter();
    let received = null;
    router.get('/api/collections/:name', ({ params }) => { received = params; });
    await router.handleRequest(fakeReq('GET', '/api/collections/my%20collection'), fakeRes());
    assert.deepEqual(received, { name: 'my collection' });
  });

  it('parses query string into a URLSearchParams', async () => {
    const router = createRouter();
    let received = null;
    router.get('/api/collections', ({ query }) => { received = query; });
    await router.handleRequest(fakeReq('GET', '/api/collections?limit=5'), fakeRes());
    assert.equal(received.get('limit'), '5');
  });

  it('does not match a path with a different segment count', async () => {
    const router = createRouter();
    let called = false;
    router.get('/api/collections/:name', () => { called = true; });
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
    router.get('/api/collections/:name', () => { handlerCalled = true; });
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
    router.get('/api/collections', () => {});
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
    const { notFound } = await import('../../../src/admin/http.js');
    router.get('/api/collections/:name', () => { throw notFound('Collection "x" not found'); });
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/collections/x'), res);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'not_found');
    assert.match(body.error.message, /Collection "x" not found/);
  });

  it('converts an unexpected thrown error into a 500 internal_error', async () => {
    const router = createRouter();
    router.get('/api/boom', () => { throw new Error('kaboom'); });
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/boom'), res);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'internal_error');
    assert.match(body.error.message, /kaboom/);
  });

  it('converts a rejected async handler into the correct error response', async () => {
    const router = createRouter();
    const { badRequest } = await import('../../../src/admin/http.js');
    router.get('/api/async-fail', async () => { throw badRequest('nope'); });
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/async-fail'), res);
    assert.equal(res.statusCode, 400);
  });
});
