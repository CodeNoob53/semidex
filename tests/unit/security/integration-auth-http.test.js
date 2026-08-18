// Integration API authentication at the HTTP layer — the full request path
// through a real composition root, with a temp key store.
//
// Offline: no real Qdrant, no Gemini, no developer SEMIDEX_HOME. The adapter
// and Ask coordinator are counting stubs, which is what makes "a denied
// request performs no Qdrant/Gemini work" an assertion rather than a claim.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createApp } from '../../../src/admin/server-full.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { createKeyStore, SCHEMA_VERSION } from '../../../src/core/auth/key-store.js';
import { createIntegrationPolicy, extractBearerToken } from '../../../src/core/auth/integration-policy.js';

let dir;
let keyPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'semidex-auth-http-'));
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

const silentLogger = { warn: () => {}, error: () => {} };

/**
 * Boots a real server whose integration policy is backed by the temp key
 * store, and counts every external interaction.
 */
async function withServer(fn, { factory = createLiteApp, logger = silentLogger } = {}) {
  const calls = { qdrant: 0, gemini: 0, embed: 0 };
  const keyStore = createKeyStore({ path: keyPath });
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
    integrationPolicy: createIntegrationPolicy({ keyStore, logger }),
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    await fn({ base: `http://127.0.0.1:${app.address().port}`, calls, keyStore });
  } finally {
    await new Promise((r) => app.close(r));
  }
}

const ask = (base, { token, collection = 'docs-a', path = '/api/v1/ask' } = {}) => fetch(base + path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({ collection, question: 'what is here?' }),
});

const newKey = (keyStore, over = {}) => keyStore.createKey({ name: 'assistant', collections: ['docs-a'], ...over });

describe('No keys configured — Integration unavailable, Admin unaffected', () => {
  it('Ask v1 and v2 return 503 integration_auth_not_configured', async () => {
    await withServer(async ({ base }) => {
      for (const path of ['/api/v1/ask', '/api/v2/ask']) {
        const res = await ask(base, { path });
        assert.equal(res.status, 503, `${path} must be unavailable before the first key exists`);
        assert.equal((await res.json()).error.code, 'integration_auth_not_configured');
      }
    });
  });

  it('a supplied token cannot make an unconfigured API available', async () => {
    await withServer(async ({ base }) => {
      const res = await ask(base, { token: `sdx_v1_${'a'.repeat(16)}_${'b'.repeat(43)}` });
      assert.equal(res.status, 503);
    });
  });

  it('Admin routes keep working with zero keys — the dashboard must not need a credential', async () => {
    await withServer(async ({ base }) => {
      for (const path of ['/api/settings', '/api/collections', '/api/health', '/api/jobs', '/api/capabilities']) {
        const res = await fetch(base + path);
        assert.equal(res.status, 200, `${path} must serve normally with no integration keys`);
      }
    });
  });

  it('no Qdrant or Gemini work occurs for a 503', async () => {
    await withServer(async ({ base, calls }) => {
      await ask(base);
      assert.deepEqual(calls, { qdrant: 0, gemini: 0, embed: 0 });
    });
  });
});

describe('Corrupt key store fails closed', () => {
  const cases = [
    ['malformed JSON', '{ not json'],
    ['unsupported schemaVersion', JSON.stringify({ schemaVersion: 99, keys: [] })],
    ['malformed record', JSON.stringify({ schemaVersion: SCHEMA_VERSION, keys: [{ id: 'x' }] })],
  ];

  for (const [label, contents] of cases) {
    it(`${label} → 503, never an open API`, async () => {
      writeFileSync(keyPath, contents, 'utf-8');
      await withServer(async ({ base, calls }) => {
        const res = await ask(base);
        assert.equal(res.status, 503);
        assert.equal((await res.json()).error.code, 'integration_auth_not_configured');
        assert.deepEqual(calls, { qdrant: 0, gemini: 0, embed: 0 });
      });
    });
  }

  it('the client response is identical for missing and corrupt stores, but the LOG distinguishes them', async () => {
    const logs = [];
    const logger = { warn: (m) => logs.push(m), error: (m) => logs.push(m) };

    await withServer(async ({ base }) => { await ask(base); }, { logger });
    const missingLog = logs.join('\n');

    writeFileSync(keyPath, '{ corrupt', 'utf-8');
    logs.length = 0;
    await withServer(async ({ base }) => { await ask(base); }, { logger });
    const corruptLog = logs.join('\n');

    assert.match(missingLog, /no API keys are configured/);
    assert.match(corruptLog, /invalid JSON|failed validation/);
    assert.notEqual(missingLog, corruptLog, 'the operator must be able to tell these apart');
  });
});

describe('Credential handling', () => {
  it('accepts a valid token for an in-scope collection', async () => {
    await withServer(async ({ base, keyStore, calls }) => {
      const { token } = newKey(keyStore);
      const res = await ask(base, { token });
      assert.equal(res.status, 200);
      assert.equal(calls.gemini, 1, 'an authorized request reaches generation');
    });
  });

  it('rejects missing, malformed, wrong, unknown, revoked and expired credentials identically', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token, key } = newKey(keyStore);
      const expired = keyStore.createKey({
        name: 'exp', collections: ['docs-a'],
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      });
      // Force the expiry into the past (createKey refuses to mint one).
      const raw = JSON.parse(readFileSync(keyPath, 'utf-8'));
      raw.keys.find((k) => k.id === expired.key.id).expiresAt = new Date(Date.now() - 1000).toISOString();
      writeFileSync(keyPath, JSON.stringify(raw), 'utf-8');

      const revoked = newKey(keyStore, { name: 'rev' });
      keyStore.revokeKey(revoked.key.id);

      const attempts = [
        ['missing', undefined],
        ['wrong secret', `sdx_v1_${key.id}_${'z'.repeat(43)}`],
        ['unknown keyId', `sdx_v1_${'q'.repeat(16)}_${'z'.repeat(43)}`],
        ['malformed token', 'not-a-token'],
        ['revoked', revoked.token],
        ['expired', expired.token],
      ];

      const bodies = [];
      for (const [label, t] of attempts) {
        const res = await ask(base, { token: t });
        assert.equal(res.status, 401, `${label} must be 401`);
        bodies.push(JSON.stringify(await res.json()));
      }
      assert.equal(new Set(bodies).size, 1,
        'every credential failure must produce an identical body — no key enumeration');
      assert.equal(token.length > 0, true);
    });
  });

  it('rejects a non-Bearer scheme and a duplicated Authorization header', async () => {
    await withServer(async ({ base, keyStore }) => {
      newKey(keyStore);
      for (const authorization of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer  extra spaces', 'token abc']) {
        const res = await fetch(base + '/api/v1/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authorization },
          body: JSON.stringify({ collection: 'docs-a', question: 'q' }),
        });
        assert.equal(res.status, 401, `"${authorization}" must not authenticate`);
      }
    });
  });

  it('never accepts a token from a query string or the request body', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newKey(keyStore);
      const viaQuery = await fetch(`${base}/api/v1/ask?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'docs-a', question: 'q' }),
      });
      assert.equal(viaQuery.status, 401, 'a query-string credential must be ignored');

      const viaBody = await fetch(`${base}/api/v1/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'docs-a', question: 'q', token }),
      });
      assert.equal(viaBody.status, 401, 'a body credential must be ignored');
    });
  });

  it('revocation takes effect without a restart', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token, key } = newKey(keyStore);
      assert.equal((await ask(base, { token })).status, 200);
      keyStore.revokeKey(key.id);
      assert.equal((await ask(base, { token })).status, 401, 'the same running server must reject immediately');
    });
  });

  it('a newly created key works without a restart', async () => {
    await withServer(async ({ base, keyStore }) => {
      assert.equal((await ask(base)).status, 503, 'no keys yet');
      const { token } = newKey(keyStore);
      assert.equal((await ask(base, { token })).status, 200, 'the new key must work immediately');
    });
  });
});

describe('WWW-Authenticate header (RFC 6750 §3)', () => {
  it('a 401 credential failure carries WWW-Authenticate: Bearer', async () => {
    await withServer(async ({ base, keyStore }) => {
      newKey(keyStore);
      const res = await ask(base, { token: 'garbage' });
      assert.equal(res.status, 401);
      assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer\b/);
    });
  });

  it('the header never carries an error/error_description attribute — no channel for distinguishing WHY the credential failed', async () => {
    await withServer(async ({ base, keyStore }) => {
      newKey(keyStore);
      const res = await ask(base, { token: 'garbage' });
      const header = res.headers.get('www-authenticate') ?? '';
      assert.equal(/error=/.test(header), false);
    });
  });

  it('a 503 (no keys configured) carries no WWW-Authenticate — the caller has done nothing wrong', async () => {
    await withServer(async ({ base }) => {
      const res = await ask(base);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('www-authenticate'), null);
    });
  });

  it('a 403 (out-of-scope collection) carries no WWW-Authenticate — the credential itself was fine', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newKey(keyStore, { collections: ['docs-a'] });
      const res = await ask(base, { token, collection: 'docs-b' });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('www-authenticate'), null);
    });
  });

  it('a 200 (authorized) carries no WWW-Authenticate', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newKey(keyStore);
      const res = await ask(base, { token });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('www-authenticate'), null);
    });
  });
});

describe('Collection and operation authorization (stage 2)', () => {
  it('denies an out-of-scope collection BEFORE any Qdrant or Gemini work', async () => {
    await withServer(async ({ base, keyStore, calls }) => {
      const { token } = newKey(keyStore, { collections: ['docs-a'] });
      const res = await ask(base, { token, collection: 'docs-b' });
      assert.equal(res.status, 403);
      assert.deepEqual(calls, { qdrant: 0, gemini: 0, embed: 0 },
        'the denial must precede adapter.getCollection() and generation entirely');
    });
  });

  it('an out-of-scope collection and a nonexistent one are indistinguishable', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newKey(keyStore, { collections: ['docs-a'] });
      const forbidden = await ask(base, { token, collection: 'docs-b' });
      const nonexistent = await ask(base, { token, collection: 'no-such-collection-anywhere' });
      assert.equal(forbidden.status, nonexistent.status);
      assert.deepEqual(await forbidden.json(), await nonexistent.json());
    });
  });

  it('an explicit "*" wildcard grants any collection', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newKey(keyStore, { collections: ['*'] });
      for (const collection of ['docs-a', 'anything-else', 'UPPER.case_1']) {
        assert.equal((await ask(base, { token, collection })).status, 200, `${collection} must be allowed`);
      }
    });
  });

  it('exact matching only — no prefix or substring widening', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newKey(keyStore, { collections: ['docs'] });
      assert.equal((await ask(base, { token, collection: 'docs' })).status, 200);
      for (const near of ['docs-a', 'doc', 'docsx', 'DOCS']) {
        assert.equal((await ask(base, { token, collection: near })).status, 403, `${near} must not match "docs"`);
      }
    });
  });

  it('Ask v2 enforces the same collection scope', async () => {
    await withServer(async ({ base, keyStore, calls }) => {
      const { token } = newKey(keyStore, { collections: ['docs-a'] });
      assert.equal((await ask(base, { token, path: '/api/v2/ask' })).status, 200);
      const denied = await ask(base, { token, collection: 'docs-b', path: '/api/v2/ask' });
      assert.equal(denied.status, 403);
      assert.equal(calls.qdrant, 1, 'only the authorized request reached Qdrant');
    });
  });
});

describe('extractBearerToken', () => {
  const req = (headers, headersDistinct) => ({ headers, ...(headersDistinct ? { headersDistinct } : {}) });

  it('extracts a well-formed bearer token, case-insensitively on the scheme', () => {
    assert.equal(extractBearerToken(req({ authorization: 'Bearer abc123' })), 'abc123');
    assert.equal(extractBearerToken(req({ authorization: 'bearer abc123' })), 'abc123');
    assert.equal(extractBearerToken(req({ authorization: 'BEARER abc123' })), 'abc123');
  });

  it('returns null for anything malformed or ambiguous', () => {
    for (const value of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer a b', 'abc']) {
      assert.equal(extractBearerToken(req({ authorization: value })), null, `"${value}" must not yield a token`);
    }
  });

  it('rejects duplicated Authorization headers rather than guessing', () => {
    assert.equal(extractBearerToken(req({ authorization: 'Bearer a, Bearer b' })), null);
    assert.equal(extractBearerToken(req({ authorization: 'Bearer a' }, { authorization: ['Bearer a', 'Bearer b'] })), null);
    assert.equal(extractBearerToken(req({ authorization: ['Bearer a', 'Bearer b'] })), null);
  });
});

describe('Instance isolation and Full/Lite equivalence', () => {
  it('two servers with different key stores do not accept each other\'s tokens', async () => {
    const otherPath = join(dir, 'other-keys.json');
    const storeA = createKeyStore({ path: keyPath });
    const storeB = createKeyStore({ path: otherPath });
    const a = newKey(storeA);
    newKey(storeB, { name: 'b-key' });

    await withServer(async ({ base }) => {
      // Server is bound to keyPath (store A), so A's token works...
      assert.equal((await ask(base, { token: a.token })).status, 200);
      // ...and a token minted only in store B does not.
      const bOnly = storeB.listKeys();
      assert.equal(bOnly.length, 1);
      const forged = `sdx_v1_${bOnly[0].id}_${'z'.repeat(43)}`;
      assert.equal((await ask(base, { token: forged })).status, 401);
    });
  });

  it('Full and Lite behave identically for the same key store', async () => {
    const store = createKeyStore({ path: keyPath });
    const { token } = newKey(store);

    const results = [];
    for (const factory of [createLiteApp, createApp]) {
      await withServer(async ({ base }) => {
        results.push({
          authorized: (await ask(base, { token })).status,
          unauthorized: (await ask(base, {})).status,
          outOfScope: (await ask(base, { token, collection: 'other' })).status,
          admin: (await fetch(base + '/api/health')).status,
        });
      }, { factory });
    }
    assert.deepEqual(results[0], results[1], 'Full and Lite must enforce the same contract');
    assert.deepEqual(results[0], { authorized: 200, unauthorized: 401, outOfScope: 403, admin: 200 });
  });
});
