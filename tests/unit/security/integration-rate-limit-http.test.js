// Instance-scoped per-key rate limiting for the Integration API — the full
// HTTP path through a real composition root (createLiteApp/createApp),
// wired the same way production does via resolveIntegrationPolicy(), with a
// temp key store and an injected fake clock so refill timing is exact and
// instant (no real sleeping). Offline: no real Qdrant, no Gemini.
//
// integration-auth-http.test.js already covers 401/403/503/200 without rate
// limiting (its policy omits checkRateLimit, deliberately unaffected by
// this phase). This file is specifically about the rate-limit stage.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createApp } from '../../../src/admin/server-full.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { createKeyStore } from '../../../src/core/auth/key-store.js';
import { createIntegrationPolicy } from '../../../src/core/auth/integration-policy.js';
import { createRateLimiter } from '../../../src/core/auth/rate-limiter.js';

let dir;
let keyPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'semidex-rate-limit-http-'));
  keyPath = join(dir, 'integration-keys.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  return now;
}

const silentLogger = { warn: () => {}, error: () => {} };

/**
 * Boots a real server wired the same way production does: a key store and a
 * rate limiter both constructed independently here (so the test controls
 * the clock), fed into createIntegrationPolicy() exactly like
 * resolve-policy.js does. Counts every external interaction so a rejection
 * can be proven to reach nothing downstream.
 */
async function withServer(fn, { factory = createLiteApp, now = fakeClock(), rateLimiter, keyStorePath = keyPath, limiterOpts } = {}) {
  const calls = { qdrant: 0, gemini: 0, embed: 0 };
  const keyStore = createKeyStore({ path: keyStorePath });
  const limiter = rateLimiter ?? createRateLimiter({ now, ...limiterOpts });
  const app = factory({
    adapter: {
      name: () => 'stub',
      capabilities: () => ({}),
      ping: async () => ({ ok: true }),
      listCollections: async () => [],
      getCollection: async (name) => { calls.qdrant++; return { name, vectorsCount: 1 }; },
    },
    embedQuery: async () => { calls.embed++; return { dense: [], sparse: {} }; },
    jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
    askCoordinators: {
      v1: { ask: async () => { calls.gemini++; return { status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] }; } },
      v2: { ask: async () => { calls.gemini++; return { status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] }; } },
    },
    integrationPolicy: createIntegrationPolicy({ keyStore, rateLimiter: limiter, logger: silentLogger }),
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    await fn({ base: `http://127.0.0.1:${app.address().port}`, calls, keyStore, limiter, now });
  } finally {
    await new Promise((r) => app.close(r));
  }
}

const ask = (base, { token, collection = 'docs-a', path = '/api/v1/ask', rawBody } = {}) => fetch(base + path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: rawBody ?? JSON.stringify({ collection, question: 'what is here?' }),
});

const newKey = (keyStore, over = {}) => keyStore.createKey({ name: 'assistant', collections: ['docs-a', 'docs-b'], ...over });

describe('Basic 429 shape', () => {
  it('exceeding the burst returns 429/rate_limited with an integer Retry-After, no WWW-Authenticate', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newKey(keyStore, { requestsPerMinute: 60, burst: 2 });
      assert.equal((await ask(base, { token })).status, 200);
      assert.equal((await ask(base, { token })).status, 200);
      const res = await ask(base, { token });
      assert.equal(res.status, 429);
      const body = await res.json();
      assert.equal(body.error.code, 'rate_limited');
      assert.equal(res.headers.get('www-authenticate'), null);
      const retryAfter = res.headers.get('retry-after');
      assert.ok(retryAfter, 'Retry-After must be present');
      assert.match(retryAfter, /^\d+$/, 'Retry-After must be a bare integer');
      assert.ok(Number(retryAfter) >= 1);
    }, { limiterOpts: {} });
  });

  it('the 429 body leaks no identity or configured-limit detail', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newKey(keyStore, { requestsPerMinute: 60, burst: 1 });
      await ask(base, { token });
      const res = await ask(base, { token });
      const body = await res.json();
      const text = JSON.stringify(body);
      assert.doesNotMatch(text, /keyId|assistant|docs-a/i);
      assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
    });
  });
});

describe('Refill over time', () => {
  it('after ~100-150ms at 600rpm/burst2, exactly one more request succeeds', async () => {
    await withServer(async ({ base, keyStore, now }) => {
      const { token } = newKey(keyStore, { requestsPerMinute: 600, burst: 2 });
      assert.equal((await ask(base, { token })).status, 200);
      assert.equal((await ask(base, { token })).status, 200);
      assert.equal((await ask(base, { token })).status, 429);

      now.advance(120);
      assert.equal((await ask(base, { token })).status, 200, 'one token refilled after ~120ms at 600rpm');
      assert.equal((await ask(base, { token })).status, 429, 'and only one — the bucket is empty again');
    });
  });
});

describe('Per-key isolation', () => {
  it('two keys on the same server have independent buckets', async () => {
    await withServer(async ({ base, keyStore }) => {
      const a = newKey(keyStore, { name: 'a', requestsPerMinute: 60, burst: 1 });
      const b = newKey(keyStore, { name: 'b', requestsPerMinute: 60, burst: 1 });
      assert.equal((await ask(base, { token: a.token })).status, 200);
      assert.equal((await ask(base, { token: a.token })).status, 429, 'a is exhausted');
      assert.equal((await ask(base, { token: b.token })).status, 200, 'b is unaffected by a');
    });
  });
});

describe('Bad/absent authentication never creates limiter state', () => {
  it('a missing, malformed, unknown, revoked or expired credential is 401 and consumes no bucket', async () => {
    await withServer(async ({ base, keyStore, limiter }) => {
      const { token: goodToken, key } = newKey(keyStore, { requestsPerMinute: 60, burst: 1 });
      const revoked = newKey(keyStore, { name: 'rev', requestsPerMinute: 60, burst: 1 });
      keyStore.revokeKey(revoked.key.id);
      const expired = newKey(keyStore, {
        name: 'exp',
        requestsPerMinute: 60,
        burst: 1,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const attempts = [undefined, 'garbage-token', `sdx_v1_${'q'.repeat(16)}_${'z'.repeat(43)}`, revoked.token, expired.token];
      for (const token of attempts) {
        const res = await ask(base, { token });
        assert.equal(res.status, 401);
      }
      assert.equal(limiter.size(), 0, 'no bucket was ever created for any failed authentication attempt');

      // Proves it independently: the good key's own bucket is still fully
      // intact (burst=1) after all those failed attempts on OTHER credentials.
      assert.equal((await ask(base, { token: goodToken })).status, 200);
      assert.equal((await ask(base, { token: goodToken })).status, 429, 'exactly one token was available, as configured');
    });
  });

  it('a 503 (no keys configured) creates no limiter state either', async () => {
    await withServer(async ({ base, limiter }) => {
      const res = await ask(base);
      assert.equal(res.status, 503);
      assert.equal(limiter.size(), 0);
    });
  });
});

describe('Admin routes are unaffected', () => {
  it('admin routes never consult the rate limiter, regardless of call volume', async () => {
    await withServer(async ({ base, limiter }) => {
      for (let i = 0; i < 20; i++) {
        const res = await fetch(base + '/api/health');
        assert.equal(res.status, 200);
      }
      assert.equal(limiter.size(), 0, 'admin traffic must never touch the integration rate limiter');
    });
  });
});

describe('v1/v2 parity', () => {
  it('the two versions share ONE bucket per key (rate limiting is per-key, not per-route)', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newKey(keyStore, { requestsPerMinute: 60, burst: 2 });
      assert.equal((await ask(base, { token, path: '/api/v1/ask' })).status, 200);
      assert.equal((await ask(base, { token, path: '/api/v2/ask' })).status, 200);
      assert.equal((await ask(base, { token, path: '/api/v1/ask' })).status, 429, 'the shared bucket is now empty');
      assert.equal((await ask(base, { token, path: '/api/v2/ask' })).status, 429);
    });
  });
});

describe('Rejection ordering — consumed BEFORE body parse, collection check, storage, and generation', () => {
  it('a rate-limited request never reaches the adapter or generation', async () => {
    await withServer(async ({ base, keyStore, calls }) => {
      const { token } = newKey(keyStore, { requestsPerMinute: 60, burst: 1 });
      await ask(base, { token }); // consumes the only token
      const before = { ...calls };
      const res = await ask(base, { token });
      assert.equal(res.status, 429);
      assert.deepEqual(calls, before, 'a rate-limited request performs no additional Qdrant/Gemini/embed work');
    });
  });

  it('a malformed body still consumes exactly one token (rate limit precedes body parse)', async () => {
    await withServer(async ({ base, keyStore, limiter }) => {
      const { token, key } = newKey(keyStore, { requestsPerMinute: 60, burst: 2 });
      const res = await ask(base, { token, rawBody: '{ not valid json' });
      assert.equal(res.status, 400, 'the malformed body is still rejected, just AFTER the token was spent');

      const first = limiter.consume(key.id, { requestsPerMinute: 60, burst: 2 });
      assert.equal(first.allowed, true, 'exactly one of the two burst tokens remains');
      const second = limiter.consume(key.id, { requestsPerMinute: 60, burst: 2 });
      assert.equal(second.allowed, false, 'confirms only one token was left before this probe consumed it');
    });
  });

  it('an out-of-scope collection still consumes exactly one token', async () => {
    await withServer(async ({ base, keyStore, calls }) => {
      const { token } = newKey(keyStore, { collections: ['docs-a'], requestsPerMinute: 60, burst: 2 });
      const denied = await ask(base, { token, collection: 'not-in-scope' });
      assert.equal(denied.status, 403);
      assert.deepEqual(calls, { qdrant: 0, gemini: 0, embed: 0 }, 'stage 2 denial still costs no external work');

      // Only one burst token remains: one call, one token consumed.
      assert.equal((await ask(base, { token, collection: 'docs-a' })).status, 200);
      assert.equal((await ask(base, { token, collection: 'docs-a' })).status, 429);
    });
  });
});

describe('Legacy keys receive the documented default', () => {
  it('a key record with no requestsPerMinute/burst field is limited at 30/min burst 5', async () => {
    // Simulate a key created before this field existed.
    const store = createKeyStore({ path: keyPath });
    const { token, key } = store.createKey({ name: 'legacy', collections: ['docs-a'] });
    const raw = JSON.parse(readFileSync(keyPath, 'utf-8'));
    delete raw.keys.find((k) => k.id === key.id).requestsPerMinute;
    delete raw.keys.find((k) => k.id === key.id).burst;
    writeFileSync(keyPath, JSON.stringify(raw), 'utf-8');

    await withServer(async ({ base }) => {
      let allowed = 0;
      for (let i = 0; i < 6; i++) {
        if ((await ask(base, { token })).status === 200) allowed++;
      }
      assert.equal(allowed, 5, 'legacy key uses the documented default burst of 5');
    });
  });
});

describe('Corrupt key store still fails closed with rate limiting wired in', () => {
  it('a corrupt store returns 503 and never touches the rate limiter', async () => {
    writeFileSync(keyPath, '{ not json', 'utf-8');
    await withServer(async ({ base, limiter }) => {
      const res = await ask(base);
      assert.equal(res.status, 503);
      assert.equal(limiter.size(), 0);
    });
  });
});

describe('Two composition roots are fully independent', () => {
  it('Full and Lite, each with their own key store and rate limiter, never share bucket state', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'semidex-rate-limit-http-2-'));
    const otherKeyPath = join(otherDir, 'integration-keys.json');
    try {
      const now = fakeClock();
      await withServer(async ({ base: baseLite, keyStore: storeLite }) => {
        const { token: tokenLite } = newKey(storeLite, { requestsPerMinute: 60, burst: 1 });
        await withServer(async ({ base: baseFull, keyStore: storeFull }) => {
          const { token: tokenFull } = newKey(storeFull, { requestsPerMinute: 60, burst: 1 });

          assert.equal((await ask(baseLite, { token: tokenLite })).status, 200);
          assert.equal((await ask(baseLite, { token: tokenLite })).status, 429, 'Lite exhausted its own bucket');
          // Full's own key, on Full's own server, is completely unaffected.
          assert.equal((await ask(baseFull, { token: tokenFull })).status, 200);
        }, { factory: createApp, now, keyStorePath: otherKeyPath });
      }, { now, keyStorePath: keyPath });
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('two servers built from the SAME factory in one process still get independent limiters', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'semidex-rate-limit-http-3-'));
    const otherKeyPath = join(otherDir, 'integration-keys.json');
    try {
      await withServer(async ({ base: base1, keyStore: store1 }) => {
        const { token: token1 } = newKey(store1, { requestsPerMinute: 60, burst: 1 });
        await withServer(async ({ base: base2, keyStore: store2 }) => {
          const { token: token2 } = newKey(store2, { requestsPerMinute: 60, burst: 1 });
          assert.equal((await ask(base1, { token: token1 })).status, 200);
          assert.equal((await ask(base1, { token: token1 })).status, 429);
          assert.equal((await ask(base2, { token: token2 })).status, 200, 'server 2 has its own untouched bucket');
        }, { keyStorePath: otherKeyPath });
      });
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe('CLI-configured per-key limits are honored end-to-end', () => {
  it('a key created via the CLI (requestsPerMinute/burst persisted) is limited accordingly over HTTP', async () => {
    const store = createKeyStore({ path: keyPath });
    const { runKeyCommand } = await import('../../../src/core/auth/key-cli.js');
    const stdout = [];
    runKeyCommand(['add', '--name', 'cli-key', '--collection', 'docs-a', '--requests-per-minute', '60', '--burst', '2'], {
      keyStorePath: keyPath,
      out: (m) => stdout.push(String(m)),
      err: () => {},
    });
    const token = stdout.join('\n').match(/sdx_v1_[A-Za-z0-9_-]+/)[0];

    await withServer(async ({ base }) => {
      assert.equal((await ask(base, { token })).status, 200);
      assert.equal((await ask(base, { token })).status, 200);
      assert.equal((await ask(base, { token })).status, 429, 'the CLI-configured burst of 2 is enforced');
    });
  });
});

describe('Malformed per-key limits fail closed at the HTTP layer (defense in depth)', () => {
  it('a principal carrying an out-of-range burst is rejected 403 by the rate-limit stage and creates no bucket', async () => {
    // The real key store already validates persisted requestsPerMinute/burst
    // at load time, so a malformed value can never reach checkRateLimit via
    // the normal auth path in production (see key-store.js's validateRecord
    // and integration-rate-limit-http.test.js's other tests for that path).
    // This test proves the NEXT layer down — rate-limiter.js's own
    // consume() contract — fails closed on its own, by stubbing
    // authorizeRequest to hand checkRateLimit a principal the key store
    // would never actually produce.
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 5 });
    const realPolicy = createIntegrationPolicy({ keyStore: {}, rateLimiter: limiter, logger: silentLogger });
    const policy = {
      authorizeRequest: () => ({
        ok: true,
        principal: { keyId: 'malformed-key', operations: ['generate'], collections: ['docs-a'], requestsPerMinute: 60, burst: -1 },
      }),
      authorizeCollection: () => ({ ok: true }),
      checkRateLimit: realPolicy.checkRateLimit,
    };
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
      askCoordinators: {
        v1: { ask: async () => ({ status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] }) },
        v2: { ask: async () => ({ status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] }) },
      },
      integrationPolicy: policy,
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      const res = await ask(base, { token: 'irrelevant-stub-ignores-it' });
      assert.equal(res.status, 403, 'a thrown fail-closed rejection from the rate limiter surfaces as 403, never 200 or 500');
      assert.equal(limiter.size(), 0, 'the malformed-limit consume() call threw before ever creating a bucket');
    } finally {
      await new Promise((r) => app.close(r));
    }
  });
});
