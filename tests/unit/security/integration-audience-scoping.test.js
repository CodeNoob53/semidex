// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md §12d and
// docs/security/integration-api-auth-design-note.md.
//
// Review follow-up round 2 (2026-08-18) — two defects:
//
// P1: the integration policy ran for EVERY matched route, including
//     audience=admin. That contradicts the boundary this phase exists to
//     draw — the Admin API stays loopback-bound and credential-free — and
//     would make the planned "zero keys => 503 integration_auth_not_configured"
//     rule take down the entire dashboard rather than just Ask.
//
// P2: Object.freeze on the auth context was shallow, so the principal and its
//     nested scopes/collections stayed mutable between stage 1 and stage 2.
//     Code between the stages could widen its own authority.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { deepFreeze, assertPlainPrincipal } from '../../../src/core/http/authorize.js';

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

const refusal = () => ({ status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] });

async function withServer(integrationPolicy, fn) {
  const app = createLiteApp({
    adapter: {
      name: () => 'stub',
      capabilities: () => ({}),
      ping: async () => ({ ok: true }),
      listCollections: async () => [],
      getCollection: async (name) => ({ name, vectorsCount: 1 }),
    },
    embedQuery: async () => ({ dense: [], sparse: {} }),
    jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
    askCoordinators: { v1: { ask: async () => refusal() }, v2: { ask: async () => refusal() } },
    integrationPolicy,
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${app.address().port}`);
  } finally {
    await new Promise((r) => app.close(r));
  }
}

const postJson = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const askBody = { collection: 'c', question: 'q' };

// The planned unconfigured-key-store state (design note, row 6).
const ALWAYS_UNAVAILABLE = {
  authorizeRequest: () => ({
    ok: false,
    status: 503,
    code: 'integration_auth_not_configured',
    message: 'Integration API authentication is not configured.',
  }),
  authorizeCollection: () => ({ ok: true }),
};

describe('P1 — the integration policy is scoped to the INTEGRATION audience', () => {
  it('a 503 policy blocks both Ask endpoints', async () => {
    await withServer(ALWAYS_UNAVAILABLE, async (base) => {
      for (const path of ['/api/v1/ask', '/api/v2/ask']) {
        const res = await postJson(base, path, askBody);
        assert.equal(res.status, 503, `${path} must be gated by the integration policy`);
        assert.equal((await res.json()).error.code, 'integration_auth_not_configured');
      }
    });
  });

  it('the SAME policy leaves Admin routes fully working — a missing integration key must not cost local administration', async () => {
    await withServer(ALWAYS_UNAVAILABLE, async (base) => {
      for (const path of ['/api/settings', '/api/collections', '/api/health', '/api/jobs', '/api/capabilities']) {
        const res = await fetch(base + path);
        assert.notEqual(res.status, 503, `${path} is admin and must not be gated by the integration policy`);
        assert.equal(res.status, 200, `${path} should serve normally`);
      }
    });
  });

  it('admin POST routes are ungated too — the scoping is by audience, not by method', async () => {
    await withServer(ALWAYS_UNAVAILABLE, async (base) => {
      const res = await postJson(base, '/api/search', { collection: 'c', query: 'q' });
      // The stub adapter has no hybrid capability, so 501 is the expected
      // handler response. The point is that it REACHED the handler.
      assert.notEqual(res.status, 503, '/api/search is admin and must not be gated');
    });
  });

  it('stage 1 is never invoked for admin traffic, but is for integration traffic', async () => {
    let stage1 = 0;
    await withServer({
      authorizeRequest: () => { stage1++; return { ok: true, principal: null }; },
      authorizeCollection: () => ({ ok: true }),
    }, async (base) => {
      await fetch(base + '/api/health');
      await fetch(base + '/api/settings');
      await fetch(base + '/api/collections');
      assert.equal(stage1, 0, 'the integration policy must not run for admin traffic at all');

      await postJson(base, '/api/v1/ask', askBody);
      assert.equal(stage1, 1, 'but it must run for integration traffic');
    });
  });

  it('stage 2 is never invoked for admin traffic', async () => {
    let stage2 = 0;
    await withServer({
      authorizeRequest: () => ({ ok: true, principal: { keyId: 'k1' } }),
      authorizeCollection: () => { stage2++; return { ok: true }; },
    }, async (base) => {
      const res = await fetch(base + '/api/collections');
      assert.equal(res.status, 200);
      assert.equal(stage2, 0, 'admin routes must never consult the integration stage-2 hook');

      await postJson(base, '/api/v1/ask', askBody);
      assert.equal(stage2, 1, 'integration routes must');
    });
  });
});

describe('P2 — the principal is DEEPLY immutable between stage 1 and stage 2', () => {
  async function askWithPrincipal(principal, authorizeCollection, assertFn) {
    await withServer({
      authorizeRequest: () => ({ ok: true, principal }),
      authorizeCollection,
    }, async (base) => {
      const res = await postJson(base, '/api/v1/ask', { collection: 'denied-B', question: 'q' });
      await assertFn(res);
    });
  }

  it('nested scope arrays cannot be widened before stage 2 evaluates them', async () => {
    let scopesSeen = null;
    await askWithPrincipal(
      { keyId: 'k1', collections: ['allowed-A'] },
      (ctx) => {
        assert.throws(() => ctx.principal.collections.push('denied-B'), TypeError,
          'arrays nested inside the principal must be frozen');
        scopesSeen = [...ctx.principal.collections];
        return ctx.principal.collections.includes(ctx.collection)
          ? { ok: true }
          : { ok: false, status: 403, code: 'forbidden', message: 'out of scope' };
      },
      (res) => {
        assert.equal(res.status, 403, 'the attempted widening must not take effect');
        assert.deepEqual(scopesSeen, ['allowed-A']);
      }
    );
  });

  it('top-level principal fields cannot be reassigned', async () => {
    await askWithPrincipal(
      { keyId: 'k1', collections: ['denied-B'] },
      (ctx) => {
        assert.throws(() => { ctx.principal.keyId = 'forged'; }, TypeError);
        assert.equal(ctx.principal.keyId, 'k1');
        return { ok: true };
      },
      (res) => assert.equal(res.status, 200)
    );
  });

  it('deeply nested structures are frozen, not only the first level', async () => {
    await askWithPrincipal(
      { keyId: 'k1', collections: ['denied-B'], limits: { rate: { perMinute: 10 } } },
      (ctx) => {
        assert.throws(() => { ctx.principal.limits.rate.perMinute = 1e9; }, TypeError);
        assert.equal(ctx.principal.limits.rate.perMinute, 10);
        return { ok: true };
      },
      (res) => assert.equal(res.status, 200)
    );
  });
});

describe('P2 — deepFreeze() unit behavior', () => {
  it('freezes nested objects and arrays', () => {
    const p = deepFreeze({ a: { b: [1, 2] } });
    assert.ok(Object.isFrozen(p));
    assert.ok(Object.isFrozen(p.a));
    assert.ok(Object.isFrozen(p.a.b));
  });

  it('handles a cyclic structure without hanging', () => {
    const cyclic = { keyId: 'k1', collections: ['a'] };
    cyclic.self = cyclic;
    const frozen = deepFreeze(cyclic);
    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.collections));
    assert.equal(frozen.self, frozen);
  });

  it('passes through null and primitives unchanged', () => {
    assert.equal(deepFreeze(null), null);
    assert.equal(deepFreeze(42), 42);
    assert.equal(deepFreeze('s'), 's');
    assert.equal(deepFreeze(undefined), undefined);
  });

  it('does not invoke getters while traversing (a policy must not be able to run code here)', () => {
    let getterCalls = 0;
    const withGetter = { get danger() { getterCalls++; return {}; }, plain: { x: 1 } };
    deepFreeze(withGetter);
    assert.equal(getterCalls, 0, 'only own data properties may be traversed');
  });
});

// ── Review note (2026-08-18): constrain the principal to a plain, JSON-like
// shape ──────────────────────────────────────────────────────────────────────
// deepFreeze() fully protects plain objects and arrays, but Object.freeze is
// not a general immutability primitive. Two failure modes matter:
//
//   - Map/Set: Object.isFrozen reports TRUE while .set()/.add() keep working.
//     A principal holding scopes in a Set would look frozen and be entirely
//     mutable — a FALSE guarantee, the worst of the three outcomes.
//   - Typed arrays: Object.freeze THROWS, which would surface as an opaque
//     403 rather than a clear configuration error.
//
// So the contract is narrowed rather than the freeze broadened: a principal
// must be JSON-like. A key store loads principals from JSON on disk anyway,
// so this costs nothing real and converts a silent hole into a loud error.
describe('Principal contract — only plain JSON-like values are accepted', () => {
  it('demonstrates WHY: a frozen Set still mutates, which is why Set is rejected', () => {
    const s = new Set(['allowed-A']);
    Object.freeze(s);
    assert.equal(Object.isFrozen(s), true, 'Object.freeze claims success...');
    s.add('denied-B');
    assert.deepEqual([...s], ['allowed-A', 'denied-B'], '...but the Set mutated anyway');
    // Hence the guard:
    assert.throws(() => assertPlainPrincipal({ collections: s }), /cannot be reliably frozen/);
  });

  it('rejects the non-freezable container types', () => {
    const cases = [
      ['Set', { collections: new Set(['a']) }],
      ['Map', { scopes: new Map([['a', 1]]) }],
      ['typed array', { buf: new Int32Array([1, 2]) }],
      ['Date', { issuedAt: new Date() }],
      ['class instance', { k: new (class Key { constructor() { this.id = 1; } })() }],
    ];
    for (const [label, principal] of cases) {
      assert.throws(() => assertPlainPrincipal(principal), /cannot be reliably frozen/, `${label} must be rejected`);
    }
  });

  // `undefined` is not JSON-representable, and the two ways it can appear
  // both corrupt the value on a round-trip through a key store:
  //   JSON.stringify({ a: undefined }) -> "{}"      (the key disappears)
  //   JSON.stringify([undefined])      -> "[null]"  (becomes null)
  // In an authorization value that drift is worth refusing outright:
  // `{ collections: undefined }` reads as "no scopes" to one code path and
  // "field missing, apply a default" to another.
  it('rejects undefined wherever it appears — an absent field must be genuinely absent', () => {
    assert.throws(() => assertPlainPrincipal({ collections: undefined }), /principal\.collections is undefined/);
    assert.throws(() => assertPlainPrincipal([undefined]), /principal\[0\] is undefined/);
    assert.throws(() => assertPlainPrincipal({ a: { b: undefined } }), /principal\.a\.b is undefined/);
    assert.throws(() => assertPlainPrincipal(undefined), /principal is undefined/);
  });

  it('demonstrates WHY undefined is refused: it does not survive a JSON round-trip', () => {
    assert.equal(JSON.stringify({ collections: undefined }), '{}', 'the key vanishes entirely');
    assert.equal(JSON.stringify([undefined]), '[null]', 'the element silently becomes null');
  });

  it('the undefined error tells the operator both acceptable alternatives', () => {
    try {
      assertPlainPrincipal({ expiresAt: undefined });
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /Omit the field entirely/);
      assert.match(err.message, /use null/);
    }
  });

  it('still accepts an omitted field and an explicit null (the correct ways to say "absent")', () => {
    assert.doesNotThrow(() => assertPlainPrincipal({ keyId: 'k1' }));
    assert.doesNotThrow(() => assertPlainPrincipal({ keyId: 'k1', expiresAt: null }));
    assert.doesNotThrow(() => assertPlainPrincipal({ collections: [] }));
  });

  it('rejects functions, accessors, symbol keys, non-finite numbers and cycles', () => {
    assert.throws(() => assertPlainPrincipal({ check: () => true }), /unsupported type "function"/);
    assert.throws(
      () => assertPlainPrincipal(Object.defineProperty({}, 'scopes', { get: () => ['a'], enumerable: true })),
      /accessor \(getter\/setter\)/
    );
    assert.throws(() => assertPlainPrincipal({ [Symbol('s')]: 1 }), /symbol key/);
    assert.throws(() => assertPlainPrincipal({ rate: NaN }), /finite number/);
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.throws(() => assertPlainPrincipal(cyclic), /circular structure/);
  });

  it('accepts the shape a real bearer-key principal actually has', () => {
    assert.doesNotThrow(() => assertPlainPrincipal({
      keyId: 'key_1',
      collections: ['docs', 'support'],
      operations: ['generate'],
      limits: { rate: { perMinute: 10 }, burst: 3 },
      revoked: false,
      expiresAt: '2027-01-01T00:00:00Z', // a string, not a Date
    }));
    assert.doesNotThrow(() => assertPlainPrincipal(null));
    assert.doesNotThrow(() => assertPlainPrincipal({ nested: [{ deep: [1, 'x', true, null] }] }));
  });

  it('the error message tells the operator what to use instead', () => {
    try {
      assertPlainPrincipal({ collections: new Set(['a']) });
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /principal\.collections/, 'names the offending path');
      assert.match(err.message, /report as frozen while staying mutable/, 'explains the real hazard');
      assert.match(err.message, /not a Set/, 'suggests the fix');
    }
  });

  it('a policy that OMITS principal entirely still works — it normalizes to null', async () => {
    await withServer({
      authorizeRequest: () => ({ ok: true }), // no principal key at all
      authorizeCollection: (ctx) => {
        assert.equal(ctx.principal, null, 'an omitted principal must arrive as null, not undefined');
        return { ok: true };
      },
    }, async (base) => {
      const res = await postJson(base, '/api/v1/ask', askBody);
      assert.equal(res.status, 200, 'omitting the principal is legitimate and must not deny');
    });
  });

  it('a principal containing undefined DENIES the request', async () => {
    await withServer({
      authorizeRequest: () => ({ ok: true, principal: { keyId: 'k1', collections: undefined } }),
      authorizeCollection: () => ({ ok: true }),
    }, async (base) => {
      const res = await postJson(base, '/api/v1/ask', askBody);
      assert.equal(res.status, 403, 'an unrepresentable principal is a policy bug and must fail closed');
    });
  });

  it('a policy returning an unfreezable principal DENIES the request rather than proceeding', async () => {
    await withServer({
      authorizeRequest: () => ({ ok: true, principal: { collections: new Set(['allowed-A']) } }),
      authorizeCollection: () => ({ ok: true }),
    }, async (base) => {
      const res = await postJson(base, '/api/v1/ask', askBody);
      assert.equal(res.status, 403,
        'an unenforceable immutability guarantee is a policy bug and must fail closed');
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /Set|frozen/,
        'the policy misconfiguration must not be echoed to the caller');
    });
  });
});
