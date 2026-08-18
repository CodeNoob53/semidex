// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md §10 step 3.
//
// The policy seam is where the NEXT phase attaches bearer keys, collection
// scopes, rate limiting and audit events. This phase adds no authorization —
// these tests pin the seam's CONTRACT so that the next phase can rely on it:
//
//   1. It runs after route match, so it sees the route's declared metadata.
//   2. It runs before the handler.
//   3. It runs before ANY request body is read.
//   4. A rejection reaches no Qdrant call, no Gemini call, no filesystem
//      access and no subprocess spawn.
//   5. It is instance-scoped — no process-global state, no dependence on the
//      order in which Full and Lite servers are constructed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRouter } from '../../../src/shared/admin/router.js';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createApp } from '../../../src/admin/server-full.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { AUDIENCE, OPERATION, COST_CLASS } from '../../../src/core/http/route-audience.js';

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

// Minimal req/res doubles — no HTTP server needed for the ordering assertions.
function fakeReq(method, url, { body = null, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:8642', 'content-type': 'application/json', ...headers };
  req.socket = {};
  // Emits the body only when someone actually subscribes, so "was the body
  // read?" is observable.
  let subscribed = false;
  req.bodyWasRead = () => subscribed;
  const origOn = req.on.bind(req);
  req.on = (event, fn) => {
    if (event === 'data') subscribed = true;
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

// The integration policy is scoped to audience=integration (see
// tests/unit/security/integration-audience-scoping.test.js for that
// boundary). These stage-1 contract tests therefore register their routes as
// INTEGRATION — an admin route would legitimately bypass the policy and the
// assertions below would be testing nothing.
const META = { audience: AUDIENCE.INTEGRATION, operation: OPERATION.GENERATE, costClass: COST_CLASS.LLM };

// Used where the test needs a route the policy must NOT touch.
const ADMIN_META = { audience: AUDIENCE.ADMIN, operation: OPERATION.READ, costClass: COST_CLASS.LOW };

// An integration policy is atomic: authorizeRequest and authorizeCollection
// must be supplied together (see validateIntegrationPolicy — configuring
// authentication without collection authorization is a BOLA bypass and is
// rejected at construction). These stage-1 tests only vary authorizeRequest,
// so this helper supplies a permissive stage-2 half.
function routerWithStage1(authorizeRequest) {
  return createRouter({
    integrationPolicy: { authorizeRequest, authorizeCollection: () => ({ ok: true }) },
  });
}

describe('Part D — policy seam ordering', () => {
  it('is called after route match, and receives the matched route metadata', async () => {
    let seen = null;
    const router = routerWithStage1(({ route }) => { seen = route; return { ok: true }; });
    router.get('/api/collections/:name', () => {}, {
      audience: AUDIENCE.INTEGRATION, operation: OPERATION.READ, costClass: COST_CLASS.QDRANT, resourceType: 'collection',
    });

    await router.handleRequest(fakeReq('GET', '/api/collections/demo'), fakeRes());

    assert.ok(seen, 'authorizeRequest must be invoked');
    assert.equal(seen.path, '/api/collections/:name', 'the seam sees the route PATTERN, not the raw URL');
    assert.equal(seen.audience, AUDIENCE.INTEGRATION);
    assert.equal(seen.operation, OPERATION.READ);
    assert.equal(seen.costClass, COST_CLASS.QDRANT);
  });

  it('receives the decoded route params (the object identifiers a future scope check needs)', async () => {
    let params = null;
    const router = routerWithStage1((ctx) => { params = ctx.params; return { ok: true }; });
    router.get('/api/collections/:name', () => {}, META);

    await router.handleRequest(fakeReq('GET', '/api/collections/my%20collection'), fakeRes());
    assert.deepEqual(params, { name: 'my collection' });
  });

  it('runs BEFORE the handler', async () => {
    const order = [];
    const router = routerWithStage1(() => { order.push('policy'); return { ok: true }; });
    router.get('/api/health', () => { order.push('handler'); }, META);

    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());
    assert.deepEqual(order, ['policy', 'handler']);
  });

  it('a rejection prevents the handler from running at all', async () => {
    let handlerRan = false;
    const router = routerWithStage1(() => ({ ok: false, status: 401, code: 'unauthorized', message: 'nope' }));
    router.get('/api/health', () => { handlerRan = true; }, META);

    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health'), res);

    assert.equal(handlerRan, false);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error.code, 'unauthorized');
  });

  it('a rejection happens BEFORE the request body is read', async () => {
    const router = routerWithStage1(() => ({ ok: false, status: 403, code: 'forbidden', message: 'no' }));
    router.post('/api/search', async ({ req }) => {
      const { readJsonBody } = await import('../../../src/core/http/http.js');
      await readJsonBody(req);
    }, META);

    const req = fakeReq('POST', '/api/search', { body: JSON.stringify({ collection: 'x', query: 'y' }) });
    await router.handleRequest(req, fakeRes());

    assert.equal(req.bodyWasRead(), false,
      'the body must never be consumed for a request policy rejected — this is what keeps a rejection cheap');
  });

  it('ONLY an explicit { ok: true } allows the request', async () => {
    let ran = false;
    const router = routerWithStage1(() => ({ ok: true }));
    router.get('/api/health', () => { ran = true; }, META);
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());
    assert.equal(ran, true);
  });

  // FAIL-CLOSED (review finding, 2026-08-18): the first cut blocked only on
  // an explicit `{ ok: false }`, so a policy that forgot a `return`, typo'd a
  // field, or returned a bare object silently ALLOWED the request. An
  // authorization hook that fails open is worse than none: it reads as
  // protection while providing none.
  it('every non-{ok:true} return value BLOCKS the request', async () => {
    const failOpenCandidates = [
      ['undefined (forgotten return)', undefined],
      ['null', null],
      ['false', false],
      ['empty object', {}],
      ['true (not the object shape)', true],
      ['{ ok: "yes" } (truthy but not ===true)', { ok: 'yes' }],
      ['{ ok: 1 }', { ok: 1 }],
      ['{ allowed: true } (wrong field name)', { allowed: true }],
      ['a string', 'ok'],
      ['an array', []],
    ];
    for (const [label, decision] of failOpenCandidates) {
      let ran = false;
      const router = routerWithStage1(() => decision);
      router.get('/api/health', () => { ran = true; }, META);
      const res = fakeRes();
      await router.handleRequest(fakeReq('GET', '/api/health'), res);
      assert.equal(ran, false, `policy returning ${label} must BLOCK, not allow`);
      assert.equal(res.statusCode, 403, `policy returning ${label} must produce 403`);
    }
  });

  it('a policy that THROWS blocks the request and does not leak the error', async () => {
    let ran = false;
    const router = routerWithStage1(() => { throw new Error('key store unreadable at /home/user/.semidex/keys.json'); });
    router.get('/api/health', () => { ran = true; }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health'), res);

    assert.equal(ran, false, 'a thrown policy must never fall through to the handler');
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'forbidden');
    assert.doesNotMatch(body.error.message, /keys\.json|key store/, 'policy internals must not leak to the client');
  });

  it('a policy that rejects (async throw) also blocks', async () => {
    let ran = false;
    const router = routerWithStage1(async () => { throw new Error('boom'); });
    router.get('/api/health', () => { ran = true; }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health'), res);
    assert.equal(ran, false);
    assert.equal(res.statusCode, 403);
  });

  it('supports an async policy', async () => {
    let ran = false;
    const router = routerWithStage1(async () => { await new Promise((r) => setImmediate(r)); return { ok: false, status: 429, code: 'busy', message: 'slow down' }; });
    router.get('/api/health', () => { ran = true; }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health'), res);
    assert.equal(ran, false);
    assert.equal(res.statusCode, 429);
  });

  it('defaults a rejection with no status/code to 403 forbidden', async () => {
    const router = routerWithStage1(() => ({ ok: false }));
    router.get('/api/health', () => {}, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health'), res);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error.code, 'forbidden');
  });

  it('is not called for an unmatched route (404 short-circuits first)', async () => {
    let called = false;
    const router = routerWithStage1(() => { called = true; });
    router.get('/api/health', () => {}, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/does-not-exist'), res);
    assert.equal(res.statusCode, 404);
    assert.equal(called, false, 'there is no route metadata to authorize against for an unmatched path');
  });

  it('runs AFTER the transport security checks — a bad Host never reaches policy', async () => {
    let called = false;
    const router = routerWithStage1(() => { called = true; });
    router.get('/api/health', () => {}, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health', { headers: { host: 'evil.example.com' } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(called, false, 'transport rejection must short-circuit before policy');
  });
});

describe('Part D — rate-limit stage (checkRateLimit) contract', () => {
  function routerWithStages({ authorizeRequest, checkRateLimit }) {
    return createRouter({
      integrationPolicy: {
        authorizeRequest: authorizeRequest ?? (() => ({ ok: true, principal: { keyId: 'k1' } })),
        authorizeCollection: () => ({ ok: true }),
        ...(checkRateLimit ? { checkRateLimit } : {}),
      },
    });
  }

  it('runs AFTER authorizeRequest succeeds and BEFORE the handler', async () => {
    const order = [];
    const router = routerWithStages({
      authorizeRequest: () => { order.push('auth'); return { ok: true, principal: { keyId: 'k1' } }; },
      checkRateLimit: () => { order.push('rate-limit'); return { ok: true }; },
    });
    router.get('/api/health', () => { order.push('handler'); }, META);
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());
    assert.deepEqual(order, ['auth', 'rate-limit', 'handler']);
  });

  it('is never invoked when authorizeRequest denies (no bucket for an unauthenticated attempt)', async () => {
    let rateLimitCalled = false;
    const router = routerWithStages({
      authorizeRequest: () => ({ ok: false, status: 401, code: 'unauthorized', message: 'no' }),
      checkRateLimit: () => { rateLimitCalled = true; return { ok: true }; },
    });
    router.get('/api/health', () => {}, META);
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());
    assert.equal(rateLimitCalled, false);
  });

  it('receives the authenticated principal and the matched route metadata', async () => {
    let seen = null;
    const router = routerWithStages({
      checkRateLimit: (ctx) => { seen = ctx; return { ok: true }; },
    });
    router.get('/api/health', () => {}, META);
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());
    assert.deepEqual(seen.principal, { keyId: 'k1' });
    assert.equal(seen.route.path, '/api/health');
  });

  it('a denial blocks the handler and responds 429/rate_limited with an integer Retry-After, no WWW-Authenticate', async () => {
    let handlerRan = false;
    const router = routerWithStages({
      checkRateLimit: () => ({ ok: false, status: 429, code: 'rate_limited', message: 'slow down', retryAfterSeconds: 7 }),
    });
    router.get('/api/health', () => { handlerRan = true; }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health'), res);
    assert.equal(handlerRan, false);
    assert.equal(res.statusCode, 429);
    assert.equal(JSON.parse(res.body).error.code, 'rate_limited');
    assert.equal(res.headers['Retry-After'], '7');
    assert.equal(res.headers['www-authenticate'], undefined);
  });

  it('rounds a fractional/missing retryAfterSeconds up to a whole number, minimum 1', async () => {
    const router = routerWithStages({ checkRateLimit: () => ({ ok: false, retryAfterSeconds: 0.2 }) });
    router.get('/api/health', () => {}, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health'), res);
    assert.equal(res.headers['Retry-After'], '1');
  });

  it('defaults a rejection with no status/code to 429/rate_limited', async () => {
    const router = routerWithStages({ checkRateLimit: () => ({ ok: false }) });
    router.get('/api/health', () => {}, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health'), res);
    assert.equal(res.statusCode, 429);
    assert.equal(JSON.parse(res.body).error.code, 'rate_limited');
    assert.equal(res.headers['retry-after'], undefined, 'no Retry-After header when the policy did not supply one');
  });

  it('every non-{ok:true} return value BLOCKS the request (fail-closed, same as the other stages)', async () => {
    for (const decision of [undefined, null, false, {}, true, 'ok']) {
      let ran = false;
      const router = routerWithStages({ checkRateLimit: () => decision });
      router.get('/api/health', () => { ran = true; }, META);
      const res = fakeRes();
      await router.handleRequest(fakeReq('GET', '/api/health'), res);
      assert.equal(ran, false, `checkRateLimit returning ${JSON.stringify(decision)} must block`);
      assert.equal(res.statusCode, 429);
    }
  });

  it('a throwing checkRateLimit blocks with 403 and does not leak the error', async () => {
    const router = routerWithStages({ checkRateLimit: () => { throw new Error('limiter internals: /home/user/.semidex'); } });
    router.get('/api/health', () => {}, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health'), res);
    assert.equal(res.statusCode, 403);
    assert.doesNotMatch(JSON.parse(res.body).error.message, /home\/user|limiter internals/);
  });

  it('a rejection happens BEFORE the request body is read', async () => {
    const router = routerWithStages({ checkRateLimit: () => ({ ok: false }) });
    router.post('/api/v1/ask', async ({ req }) => {
      const { readJsonBody } = await import('../../../src/core/http/http.js');
      await readJsonBody(req);
    }, META);
    const req = fakeReq('POST', '/api/v1/ask', { body: JSON.stringify({ collection: 'x', question: 'y' }) });
    await router.handleRequest(req, fakeRes());
    assert.equal(req.bodyWasRead(), false, 'rate-limit rejection must precede body parsing');
  });

  it('is not invoked for an admin-audience route', async () => {
    let called = false;
    const router = createRouter({
      integrationPolicy: {
        authorizeRequest: () => ({ ok: true, principal: { keyId: 'k1' } }),
        authorizeCollection: () => ({ ok: true }),
        checkRateLimit: () => { called = true; return { ok: true }; },
      },
    });
    router.get('/api/health', () => {}, ADMIN_META);
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());
    assert.equal(called, false);
  });

  it('omitting checkRateLimit preserves current behavior — no rate limiting occurs', async () => {
    let ran = false;
    const router = routerWithStages({ checkRateLimit: undefined });
    router.get('/api/health', () => { ran = true; }, META);
    await router.handleRequest(fakeReq('GET', '/api/health'), fakeRes());
    assert.equal(ran, true);
  });

  it('checkRateLimit supplied WITHOUT authorizeRequest is rejected at construction', () => {
    assert.throws(
      () => createRouter({
        integrationPolicy: { checkRateLimit: () => ({ ok: true }) },
      }),
      /checkRateLimit.*without authorizeRequest/s
    );
  });
});

describe('Part D — policy rejection reaches no external system', () => {
  it('an admin indexing route is NOT gated by the integration policy (it is admin-audience)', async () => {
    let spawned = false;
    const app = createLiteApp({
      adapter: {
        name: () => 'stub', capabilities: () => ({}), ping: async () => ({ ok: true }),
        listCollections: async () => [], getCollection: async (n) => ({ name: n }),
      },
      embedQuery: async () => ({ dense: [], sparse: {} }),
      jobRegistry: createJobRegistry({ spawnIndexer: () => { spawned = true; return fakeChild(); }, baseEnv: {} }),
      integrationPolicy: {
        authorizeRequest: ({ route }) => (route.operation === OPERATION.INDEX
          ? { ok: false, status: 403, code: 'forbidden', message: 'indexing disabled by policy' }
          : { ok: true }),
        authorizeCollection: () => ({ ok: true }),
      },
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'c', path: './docs' }),
      });
      // /api/jobs/index is audience=admin, so the INTEGRATION policy must not
      // touch it — see integration-audience-scoping.test.js. Admin
      // authorization is a separate, future concern.
      assert.equal(res.status, 202, 'admin routes are not gated by the integration policy');
      assert.equal(spawned, true);
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  it('a rejected INTEGRATION request never calls the storage adapter', async () => {
    let adapterCalled = false;
    const app = createLiteApp({
      adapter: {
        name: () => 'stub', capabilities: () => ({}), ping: async () => ({ ok: true }),
        listCollections: async () => { adapterCalled = true; return []; },
        getCollection: async (n) => { adapterCalled = true; return { name: n }; },
      },
      embedQuery: async () => ({ dense: [], sparse: {} }),
      jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
      integrationPolicy: {
        authorizeRequest: () => ({ ok: false, status: 401, code: 'unauthorized', message: 'no' }),
        authorizeCollection: () => ({ ok: true }),
      },
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const res = await fetch(base + '/api/v1/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'c', question: 'q' }),
      });
      assert.equal(res.status, 401);
      assert.equal(adapterCalled, false, 'no Qdrant round-trip may occur for a rejected request');
    } finally {
      await new Promise((r) => app.close(r));
    }
  });
});

describe('Part D — instance-scoped, no process-global state', () => {
  it('two routers with different policies do not affect each other', async () => {
    const permissive = routerWithStage1(() => ({ ok: true }));
    const restrictive = routerWithStage1(() => ({ ok: false, status: 403, code: 'forbidden', message: 'no' }));
    let permissiveRan = false;
    let restrictiveRan = false;
    permissive.get('/api/health', () => { permissiveRan = true; }, META);
    restrictive.get('/api/health', () => { restrictiveRan = true; }, META);

    await permissive.handleRequest(fakeReq('GET', '/api/health'), fakeRes());
    await restrictive.handleRequest(fakeReq('GET', '/api/health'), fakeRes());

    assert.equal(permissiveRan, true);
    assert.equal(restrictiveRan, false);
  });

  it('a router with NO policy behaves exactly as before (this phase changes no public behavior)', async () => {
    let ran = false;
    const router = createRouter();
    router.get('/api/health', () => { ran = true; }, META);
    const res = fakeRes();
    await router.handleRequest(fakeReq('GET', '/api/health'), res);
    assert.equal(ran, true, 'omitting the policy must not block anything — Phase 2 adds authorization, not this one');
  });

  it('Full and Lite accept the same policy contract, and construction order does not matter', async () => {
    const seen = [];
    const mk = (factory) => factory({
      adapter: {
        name: () => 'stub', capabilities: () => ({}), ping: async () => ({ ok: true }),
        listCollections: async () => [], getCollection: async (n) => ({ name: n }),
      },
      embedQuery: async () => ({ dense: [], sparse: {} }),
      jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
      integrationPolicy: {
        authorizeRequest: ({ route }) => { seen.push(route.audience); return { ok: false, status: 403, code: 'forbidden', message: 'x' }; },
        authorizeCollection: () => ({ ok: true }),
      },
    });

    // Interleave construction deliberately: Lite, Full, Lite again.
    const apps = [mk(createLiteApp), mk(createApp), mk(createLiteApp)];
    try {
      for (const app of apps) {
        await new Promise((r) => app.listen(0, '127.0.0.1', r));
        const res = await fetch(`http://127.0.0.1:${app.address().port}/api/v1/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection: 'c', question: 'q' }),
        });
        assert.equal(res.status, 403, 'each instance must honour its own injected policy');
      }
    } finally {
      for (const app of apps) await new Promise((r) => app.close(r));
    }
    assert.equal(seen.length, 3, 'every instance invoked its own policy exactly once');
    assert.ok(seen.every((a) => a === AUDIENCE.INTEGRATION));
  });
});
