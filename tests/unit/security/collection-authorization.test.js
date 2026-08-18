// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md — the
// two-stage authorization model, stage 2 (object-level authorization).
//
// WHY A SECOND STAGE EXISTS (review finding, 2026-08-18)
// -----------------------------------------------------
// OWASP API1:2023 requires authorizing access to the object identifier the
// CLIENT supplied. For Ask v1/v2 that identifier is `body.collection` — it is
// not in the URL, path params, or any header.
//
// The router's pre-body seam therefore CANNOT perform this check: a request
// body is a single-use stream, so a hook that consumed it there would leave
// the handler with nothing to parse. The original design note wrongly claimed
// the pre-body seam was the single attachment point for collection scopes.
// It is not, and these tests pin the corrected contract:
//
//   Stage 1 (router, pre-body):   authentication + coarse rate limiting.
//   Stage 2 (here, post-parse):   collection/operation authorization, run
//                                 BEFORE adapter.getCollection() so a denied
//                                 request costs no Qdrant and no Gemini work.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { authorizeCollectionAccess, deepFreeze } from '../../../src/core/http/authorize.js';

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

// A key scoped to exactly one collection — the shape row 5 of the design
// note recommends (exact list, no implicit wildcard).
const KEY_SCOPED_TO_A = { id: 'key_1', collections: ['allowed-A'], operations: ['generate'] };

function scopedAuthorizer(key) {
  return ({ collection, operation }) => {
    if (!key.collections.includes(collection)) {
      return { ok: false, status: 403, code: 'forbidden', message: 'Collection is not in this key\'s scope.' };
    }
    if (operation && !key.operations.includes(operation)) {
      return { ok: false, status: 403, code: 'forbidden', message: 'Operation is not in this key\'s scope.' };
    }
    return { ok: true };
  };
}

/**
 * Boots a real Lite server and records every external interaction, so a
 * denial can be asserted to have reached NONE of them.
 */
async function withAskServer({ authorizeCollection, authorizeRequest, principal }, fn) {
  const calls = { getCollection: [], ask: 0, embed: 0 };
  const app = createLiteApp({
    adapter: {
      name: () => 'stub',
      capabilities: () => ({}),
      ping: async () => ({ ok: true }),
      listCollections: async () => [],
      getCollection: async (name) => { calls.getCollection.push(name); return { name, vectorsCount: 1 }; },
    },
    embedQuery: async () => { calls.embed++; return { dense: [], sparse: {} }; },
    jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
    // askCoordinators (the { v1, v2, gate } bundle) rather than the singular
    // askCoordinator, so BOTH /api/v1/ask and /api/v2/ask are registered —
    // passing only the singular form registers v1 alone.
    askCoordinators: {
      v1: { ask: async () => { calls.ask++; return { status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] }; } },
      v2: { ask: async () => { calls.ask++; return { status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] }; } },
    },
    // Atomic policy: both halves together, or neither. `principal` is what
    // stage 1 returns; it must reach stage 2 explicitly, never via a mutated
    // request object.
    integrationPolicy: authorizeCollection
      ? {
        authorizeRequest: authorizeRequest ?? (() => ({ ok: true, principal: principal ?? null })),
        authorizeCollection,
      }
      : undefined,
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn({ base, calls });
  } finally {
    await new Promise((r) => app.close(r));
  }
}

const askV1 = (base, collection) => fetch(`${base}/api/v1/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ collection, question: 'what is in here?' }),
});

describe('Stage 2 — collection authorization on Ask v1 (OWASP API1:2023)', () => {
  it('a key scoped to collection A can reach collection A', async () => {
    await withAskServer({ authorizeCollection: scopedAuthorizer(KEY_SCOPED_TO_A) }, async ({ base, calls }) => {
      const res = await askV1(base, 'allowed-A');
      assert.equal(res.status, 200, 'an in-scope collection must be served normally');
      assert.deepEqual(calls.getCollection, ['allowed-A']);
      assert.equal(calls.ask, 1);
    });
  });

  it('the same key is REFUSED for collection B — with no Qdrant and no Gemini work', async () => {
    await withAskServer({ authorizeCollection: scopedAuthorizer(KEY_SCOPED_TO_A) }, async ({ base, calls }) => {
      const res = await askV1(base, 'denied-B');
      assert.equal(res.status, 403);
      // The versioned Ask error envelope nests under `error`, and carries
      // apiVersion — the denial must use this endpoint's own contract rather
      // than the generic admin error shape.
      const body = await res.json();
      assert.equal(body.error.code, 'forbidden');
      assert.equal(body.error.apiVersion, 'v1');

      // The point of running stage 2 before adapter.getCollection():
      assert.deepEqual(calls.getCollection, [], 'a denied request must not touch Qdrant');
      assert.equal(calls.ask, 0, 'a denied request must not reach the Ask coordinator (no Gemini call)');
      assert.equal(calls.embed, 0, 'a denied request must not embed the query');
    });
  });

  it('denial does not leak whether the collection actually exists', async () => {
    await withAskServer({ authorizeCollection: scopedAuthorizer(KEY_SCOPED_TO_A) }, async ({ base }) => {
      const existing = await askV1(base, 'denied-B');
      const nonexistent = await askV1(base, 'does-not-exist-at-all');
      assert.equal(existing.status, nonexistent.status,
        'an out-of-scope existing collection and a nonexistent one must be indistinguishable');
      assert.deepEqual(await existing.json(), await nonexistent.json());
    });
  });

  it('an operation outside the key\'s scope is refused even for an in-scope collection', async () => {
    const readOnlyKey = { id: 'key_2', collections: ['allowed-A'], operations: ['search'] };
    await withAskServer({ authorizeCollection: scopedAuthorizer(readOnlyKey) }, async ({ base, calls }) => {
      const res = await askV1(base, 'allowed-A');
      assert.equal(res.status, 403, 'Ask is a generate operation; a search-only key must not reach it');
      assert.equal(calls.ask, 0);
    });
  });

  it('the hook receives the client-supplied collection and the route operation', async () => {
    const seen = [];
    await withAskServer({
      authorizeCollection: (ctx) => { seen.push({ collection: ctx.collection, operation: ctx.operation }); return { ok: true }; },
    }, async ({ base }) => {
      await askV1(base, 'some-collection');
    });
    assert.deepEqual(seen, [{ collection: 'some-collection', operation: 'generate' }]);
  });

  it('with NO hook configured, behavior is unchanged (this phase adds no authorization)', async () => {
    await withAskServer({ authorizeCollection: undefined }, async ({ base, calls }) => {
      const res = await askV1(base, 'anything-at-all');
      assert.equal(res.status, 200);
      assert.equal(calls.ask, 1);
    });
  });
});

describe('Stage 2 — Ask v2 enforces the same contract', () => {
  const askV2 = (base, collection) => fetch(`${base}/api/v2/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection, question: 'follow-up?' }),
  });

  it('refuses an out-of-scope collection before any Qdrant call', async () => {
    await withAskServer({ authorizeCollection: scopedAuthorizer(KEY_SCOPED_TO_A) }, async ({ base, calls }) => {
      const res = await askV2(base, 'denied-B');
      assert.equal(res.status, 403);
      assert.deepEqual(calls.getCollection, []);
      assert.equal(calls.ask, 0);
    });
  });

  it('allows an in-scope collection', async () => {
    await withAskServer({ authorizeCollection: scopedAuthorizer(KEY_SCOPED_TO_A) }, async ({ base, calls }) => {
      const res = await askV2(base, 'allowed-A');
      assert.equal(res.status, 200);
      assert.deepEqual(calls.getCollection, ['allowed-A']);
    });
  });
});

describe('Stage 2 — authorizeCollectionAccess() is fail-closed', () => {
  const ctx = { req: {}, collection: 'c' };
  const authWith = (hook) => ({ principal: null, route: { operation: 'generate' }, authorizeCollection: hook });

  it('allows when no hook is configured', async () => {
    await assert.doesNotReject(() => authorizeCollectionAccess(undefined, ctx));
    await assert.doesNotReject(() => authorizeCollectionAccess(null, ctx));
  });

  it('allows ONLY on an explicit { ok: true }', async () => {
    await assert.doesNotReject(() => authorizeCollectionAccess(authWith(() => ({ ok: true })), ctx));
  });

  it('every non-{ok:true} return value denies', async () => {
    for (const decision of [undefined, null, false, {}, true, { ok: 'yes' }, { ok: 1 }, { allowed: true }, 'ok', []]) {
      await assert.rejects(
        () => authorizeCollectionAccess(authWith(() => decision), ctx),
        (err) => err.statusCode === 403,
        `returning ${JSON.stringify(decision)} must deny`
      );
    }
  });

  it('a throwing hook denies without leaking its message', async () => {
    await assert.rejects(
      () => authorizeCollectionAccess(authWith(() => { throw new Error('key store at /secret/path is corrupt'); }), ctx),
      (err) => err.statusCode === 403 && !/secret\/path/.test(err.message)
    );
  });

  it('a denial may carry a custom status/code (e.g. 401 for an unauthenticated caller)', async () => {
    await assert.rejects(
      () => authorizeCollectionAccess(authWith(() => ({ ok: false, status: 401, code: 'unauthorized', message: 'no key' })), ctx),
      (err) => err.statusCode === 401 && err.code === 'unauthorized'
    );
  });
});

// ── Review follow-up (2026-08-18) ────────────────────────────────────────────
// Three defects fixed together, all about how the two stages connect:
//   1. The principal travelled via an undeclared `req.semidexPrincipal`
//      mutation — an implicit side channel no contract described.
//   2. authorizeRequest/authorizeCollection were independent optional params,
//      so configuring authentication alone shipped a BOLA bypass that looked
//      correctly configured.
//   3. Stage 2 re-declared `operation: 'generate'` as a literal instead of
//      reading the route registry, so the two could silently drift apart.
describe('Review follow-up — explicit principal, atomic policy, route-derived operation', () => {
  it('the principal returned by stage 1 reaches stage 2 unchanged', async () => {
    const principal = { keyId: 'key_1', scopes: ['allowed-A'], nested: { tier: 'paid' } };
    let received;
    await withAskServer({
      principal,
      authorizeCollection: (ctx) => { received = ctx.principal; return { ok: true }; },
    }, async ({ base }) => { await askV1(base, 'allowed-A'); });

    assert.deepEqual(received, principal, 'stage 2 must observe exactly what stage 1 returned');
  });

  it('the principal is NOT smuggled through a mutated IncomingMessage', async () => {
    let reqSeenByStage2 = null;
    await withAskServer({
      principal: { keyId: 'key_1' },
      authorizeCollection: (ctx) => { reqSeenByStage2 = ctx.req; return { ok: true }; },
    }, async ({ base }) => { await askV1(base, 'anything'); });

    assert.ok(reqSeenByStage2, 'stage 2 still receives the request for transport-level facts');
    assert.equal(reqSeenByStage2.semidexPrincipal, undefined,
      'the request object must carry no principal property — the auth context is the only channel');
  });

  it('stage 2 receives the operation from ROUTE METADATA, not a hardcoded literal', async () => {
    let ctxSeen = null;
    await withAskServer({
      authorizeCollection: (ctx) => { ctxSeen = ctx; return { ok: true }; },
    }, async ({ base }) => { await askV1(base, 'c'); });

    // Registered as OPERATION.GENERATE in src/core/ask-api/v1/route.js.
    assert.equal(ctxSeen.operation, 'generate');
    assert.equal(ctxSeen.route.operation, 'generate', 'the full validated route metadata is available');
    assert.equal(ctxSeen.route.path, '/api/v1/ask');
    assert.equal(ctxSeen.route.audience, 'integration');
    assert.ok(Object.isFrozen(ctxSeen.route), 'route metadata must not be mutable by a policy');
  });

  it('a stage-1 denial never invokes stage 2', async () => {
    let stage2Called = false;
    await withAskServer({
      authorizeRequest: () => ({ ok: false, status: 401, code: 'unauthorized', message: 'no key' }),
      authorizeCollection: () => { stage2Called = true; return { ok: true }; },
    }, async ({ base, calls }) => {
      const res = await askV1(base, 'allowed-A');
      assert.equal(res.status, 401);
      assert.equal(stage2Called, false, 'stage 2 must not run once stage 1 has denied');
      assert.deepEqual(calls.getCollection, []);
      assert.equal(calls.ask, 0);
    });
  });

  it('two app instances keep independent principals and policies', async () => {
    const seenA = [];
    const seenB = [];
    await withAskServer({
      principal: { keyId: 'A' },
      authorizeCollection: (ctx) => { seenA.push(ctx.principal.keyId); return { ok: true }; },
    }, async ({ base: baseA }) => {
      await withAskServer({
        principal: { keyId: 'B' },
        authorizeCollection: (ctx) => { seenB.push(ctx.principal.keyId); return { ok: false, status: 403, code: 'forbidden', message: 'B denies' }; },
      }, async ({ base: baseB }) => {
        // Interleave so a shared global would be observable.
        const ra1 = await askV1(baseA, 'x');
        const rb1 = await askV1(baseB, 'x');
        const ra2 = await askV1(baseA, 'x');
        assert.equal(ra1.status, 200);
        assert.equal(rb1.status, 403);
        assert.equal(ra2.status, 200, 'instance A must be unaffected by instance B');
      });
    });
    assert.deepEqual(seenA, ['A', 'A']);
    assert.deepEqual(seenB, ['B']);
  });
});

describe('Review follow-up — an incomplete integrationPolicy is rejected at construction', () => {
  const base = {
    adapter: {
      name: () => 'stub', capabilities: () => ({}), ping: async () => ({ ok: true }),
      listCollections: async () => [], getCollection: async (n) => ({ name: n }),
    },
    embedQuery: async () => ({ dense: [], sparse: {} }),
  };
  const build = (integrationPolicy) => createLiteApp({
    ...base,
    jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
    integrationPolicy,
  });

  it('authentication WITHOUT collection authorization refuses to start (the BOLA bypass)', () => {
    assert.throws(
      () => build({ authorizeRequest: () => ({ ok: true, principal: {} }) }),
      /incomplete.*authorizeRequest.*without.*authorizeCollection/s
    );
  });

  it('collection authorization WITHOUT authentication also refuses to start', () => {
    assert.throws(
      () => build({ authorizeCollection: () => ({ ok: true }) }),
      /incomplete.*authorizeCollection.*without.*authorizeRequest/s
    );
  });

  it('the error explains why the halves are inseparable', () => {
    try {
      build({ authorizeRequest: () => ({ ok: true }) });
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /broken-object-level-authorization|OWASP API1/i);
      assert.match(err.message, /omit integrationPolicy entirely/i);
    }
  });

  it('a complete policy constructs fine', () => {
    assert.doesNotThrow(() => build({
      authorizeRequest: () => ({ ok: true, principal: {} }),
      authorizeCollection: () => ({ ok: true }),
    }));
  });

  it('omitting the policy entirely is allowed (unchanged behavior this phase)', () => {
    assert.doesNotThrow(() => build(undefined));
  });

  it('a non-function half is rejected with a clear type error', () => {
    assert.throws(
      () => build({ authorizeRequest: 'yes', authorizeCollection: () => ({ ok: true }) }),
      /authorizeRequest must be a function/
    );
  });
});
