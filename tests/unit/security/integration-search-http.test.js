// POST /api/v1/search — the versioned, bearer-authenticated Integration
// counterpart to the Admin dashboard's own /api/search. Offline: no real
// Qdrant, no ONNX/Ollama — a stub StorageAdapter and a temp key store.
//
// Covers what Admin's own tests/unit/admin/search.test.js does not need to:
// Full/Lite parity, bearer auth (stage 1), operation scope (stage 1),
// collection scope (stage 2), rate limiting (stage 1.5), pre-body/no-work-
// on-denial, and the versioned error-projection contract. Field-level
// validation/window-expansion/capability-failure semantics are exercised
// once, lightly, here (they are exhaustively covered for the SHARED
// implementation by tests/unit/admin/search.test.js already).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createApp } from '../../../src/admin/server-full.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { createKeyStore } from '../../../src/core/auth/key-store.js';
import { createIntegrationPolicy } from '../../../src/core/auth/integration-policy.js';
import { createRateLimiter } from '../../../src/core/auth/rate-limiter.js';

const HIT = {
  sourceFile: 'docs/en/configuration.md', chunkIndex: 4, totalChunks: 10, section: 'Qdrant',
  text: 'QDRANT_URL points at the Qdrant instance. '.repeat(8), context: 'Env var reference.',
  tags: ['configuration'], nodeType: null, nodeId: null, nodePath: null, score: 0.03, isMatch: null,
};

const VALID_PROFILE = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

function makeStubAdapter(overrides = {}) {
  return {
    name: () => 'stub',
    capabilities: () => ({ namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true, aliases: false, snapshots: false, collectionExists: true }),
    ping: async () => ({ ok: true }),
    listCollections: async () => [],
    getCollection: async (name) => (name === 'docs-a' ? { name, pointCount: 5 } : null),
    getEmbeddingProfile: async () => ({ state: 'valid', profile: VALID_PROFILE }),
    getChunk: async () => [],
    searchHybridVectors: async () => [HIT],
    ...overrides,
  };
}

let dir;
let keyPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'semidex-search-v1-http-'));
  keyPath = join(dir, 'integration-keys.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const silentLogger = { warn: () => {}, error: () => {} };

/**
 * Boots a real server (Full or Lite) whose integration policy is backed by
 * a temp key store, and counts every external interaction — the same
 * pattern tests/unit/security/integration-auth-http.test.js uses for Ask.
 */
async function withServer(fn, { factory = createLiteApp, adapterOverrides = {}, embedQuery } = {}) {
  const calls = { getCollection: 0, embed: 0 };
  const keyStore = createKeyStore({ path: keyPath });
  const adapter = makeStubAdapter({
    getCollection: async (name) => { calls.getCollection++; return name === 'docs-a' ? { name, pointCount: 5 } : null; },
    ...adapterOverrides,
  });
  const app = factory({
    adapter,
    embedQuery: embedQuery ?? (async () => { calls.embed++; return { dense: [0.1], sparse: { indices: [1], values: [0.5] } }; }),
    jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
    // A real rate limiter, exactly like production's resolveIntegrationPolicy()
    // always constructs one — per-key requestsPerMinute/burst overrides
    // (key-store.js) are what tests actually tune, not this limiter's own
    // shared defaults (30/min, burst 5).
    integrationPolicy: createIntegrationPolicy({ keyStore, logger: silentLogger, rateLimiter: createRateLimiter() }),
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    await fn({ base: `http://127.0.0.1:${app.address().port}`, calls, keyStore });
  } finally {
    await new Promise((r) => app.close(r));
  }
}

const search = (base, { token, body = { collection: 'docs-a', query: 'auth' } } = {}) => fetch(base + '/api/v1/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

const newSearchKey = (keyStore, over = {}) => keyStore.createKey({ name: 'wrapper-backend', collections: ['docs-a'], operations: ['search'], ...over });

describe('POST /api/v1/search — Full/Lite parity', () => {
  for (const [label, factory] of [['Lite', createLiteApp], ['Full', createApp]]) {
    it(`${label}: reachable, versioned success shape, apiVersion:"v1"`, async () => {
      await withServer(async ({ base, keyStore }) => {
        const { token } = newSearchKey(keyStore);
        const res = await search(base, { token });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.apiVersion, 'v1');
        assert.equal(body.collection, 'docs-a');
        assert.equal(body.searchMode, 'hybrid');
        assert.equal(body.results.length, 1);
        assert.equal(body.results[0].sourceFile, HIT.sourceFile);
      }, { factory });
    });
  }
});

describe('POST /api/v1/search — stage 1: bearer authentication', () => {
  it('no keys configured at all → 503 integration_auth_not_configured, no Qdrant/embed work', async () => {
    await withServer(async ({ base, calls }) => {
      const res = await search(base);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, 'integration_auth_not_configured');
      assert.equal(calls.getCollection, 0);
      assert.equal(calls.embed, 0);
    });
  });

  it('missing Authorization header → 401', async () => {
    await withServer(async ({ base, keyStore, calls }) => {
      newSearchKey(keyStore);
      const res = await search(base);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error.code, 'unauthorized');
      assert.equal(calls.getCollection, 0, 'an unauthenticated request must not touch Qdrant');
    });
  });

  it('malformed/wrong token → 401, same collapsed code as a missing header', async () => {
    await withServer(async ({ base, keyStore }) => {
      newSearchKey(keyStore);
      const res = await search(base, { token: 'not-a-real-token' });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error.code, 'unauthorized');
    });
  });

  it('Admin routes remain unaffected by the same unconfigured key store', async () => {
    await withServer(async ({ base }) => {
      const res = await fetch(base + '/api/health');
      assert.equal(res.status, 200);
    });
  });
});

describe('POST /api/v1/search — stage 1: operation scope', () => {
  it('a generate-only key is FORBIDDEN from search', async () => {
    await withServer(async ({ base, keyStore, calls }) => {
      const { token } = keyStore.createKey({ name: 'ask-only', collections: ['docs-a'], operations: ['generate'] });
      const res = await search(base, { token });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.code, 'forbidden');
      assert.equal(calls.getCollection, 0, 'an out-of-scope-operation request must not touch Qdrant');
    });
  });

  it('a search-only key IS forbidden from Ask (the inverse scoping check)', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = keyStore.createKey({ name: 'search-only', collections: ['docs-a'], operations: ['search'] });
      const res = await fetch(base + '/api/v1/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ collection: 'docs-a', question: 'q' }),
      });
      assert.equal(res.status, 403);
    });
  });

  it('a key scoped to BOTH generate and search may reach both endpoints', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = keyStore.createKey({ name: 'both', collections: ['docs-a'], operations: ['generate', 'search'] });
      const searchRes = await search(base, { token });
      assert.equal(searchRes.status, 200);
    });
  });

  it('an EXISTING generate-default key (no --operation flag, pre-dating search) is never silently widened to cover search', async () => {
    await withServer(async ({ base, keyStore }) => {
      // createKey()'s own default operations list, unchanged by this feature.
      const { token } = keyStore.createKey({ name: 'legacy', collections: ['docs-a'] });
      const res = await search(base, { token });
      assert.equal(res.status, 403, 'a pre-existing generate-only key must not gain search access implicitly');
    });
  });
});

describe('POST /api/v1/search — stage 2: collection authorization (OWASP API1:2023)', () => {
  it('a key scoped to docs-a may search docs-a', async () => {
    await withServer(async ({ base, keyStore, calls }) => {
      const { token } = newSearchKey(keyStore);
      const res = await search(base, { token, body: { collection: 'docs-a', query: 'q' } });
      assert.equal(res.status, 200);
      assert.equal(calls.getCollection, 1);
    });
  });

  it('the same key is FORBIDDEN for an out-of-scope collection, with no Qdrant/embed work', async () => {
    await withServer(async ({ base, keyStore, calls }) => {
      const { token } = newSearchKey(keyStore);
      const res = await search(base, { token, body: { collection: 'someone-elses-notes', query: 'q' } });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error.code, 'forbidden');
      assert.equal(body.error.apiVersion, 'v1', 'stage-2 denials use this endpoint\'s own versioned contract');
      assert.equal(calls.getCollection, 0, 'stage 2 runs BEFORE any adapter call');
      assert.equal(calls.embed, 0);
    });
  });

  it('a wildcard-scoped key may search any collection', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = keyStore.createKey({ name: 'all-access', collections: ['*'], operations: ['search'] });
      const res = await search(base, { token, body: { collection: 'docs-a', query: 'q' } });
      assert.equal(res.status, 200);
    });
  });
});

describe('POST /api/v1/search — stage 1.5: per-key rate limiting', () => {
  // Per-key requestsPerMinute/burst (key-store.js's own stored override)
  // take precedence over the limiter's own construction defaults — see
  // integration-policy.js's checkRateLimit(), which reads
  // principal.requestsPerMinute/burst, not the limiter's constructor
  // options. A tiny burst is set on the KEY itself so the limiter's shared
  // defaults (30/min, burst 5) don't have to be exhausted with five calls.

  it('exceeding burst → 429 rate_limited with Retry-After, no work performed', async () => {
    await withServer(async ({ base, keyStore, calls }) => {
      const { token } = newSearchKey(keyStore, { requestsPerMinute: 60, burst: 1 });
      const first = await search(base, { token });
      assert.equal(first.status, 200);
      const second = await search(base, { token });
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error.code, 'rate_limited');
      assert.ok(second.headers.get('retry-after'));
      assert.equal(calls.getCollection, 1, 'the rate-limited request must not have reached the handler at all');
    });
  });

  it('Search and Ask requests from the SAME key share one bucket (rate limiting is per-key, not per-route)', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = keyStore.createKey({
        name: 'both', collections: ['docs-a'], operations: ['generate', 'search'], requestsPerMinute: 60, burst: 1,
      });
      const searchRes = await search(base, { token });
      assert.equal(searchRes.status, 200);
      const askRes = await fetch(base + '/api/v1/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ collection: 'docs-a', question: 'q' }),
      });
      assert.equal(askRes.status, 429, 'the bucket was already exhausted by the search call above');
    });
  });
});

describe('POST /api/v1/search — validation errors use the versioned v1 contract', () => {
  it('missing collection → 400 bad_request, versioned envelope', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newSearchKey(keyStore);
      const res = await search(base, { token, body: { query: 'q' } });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'bad_request');
      assert.equal(body.error.apiVersion, 'v1');
      assert.equal(body.error.retryable, false);
    });
  });

  it('an unknown field is rejected (public-contract tightening over /api/search)', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newSearchKey(keyStore);
      const res = await search(base, { token, body: { collection: 'docs-a', query: 'q', extra: 1 } });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, /Unknown body field/);
    });
  });

  it('collection not found → 404 not_found, versioned envelope', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = keyStore.createKey({ name: 'k', collections: ['*'], operations: ['search'] });
      const res = await search(base, { token, body: { collection: 'nope', query: 'q' } });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error.code, 'not_found');
      assert.equal(body.error.apiVersion, 'v1');
    });
  });
});

describe('POST /api/v1/search — retrieval/capability failures map to typed, retryable-annotated codes', () => {
  it('adapter without hybrid capability → 501 not_implemented, not retryable', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newSearchKey(keyStore);
      const res = await search(base, { token });
      assert.equal(res.status, 501);
      const body = await res.json();
      assert.equal(body.error.code, 'not_implemented');
      assert.equal(body.error.retryable, false);
    }, { adapterOverrides: { capabilities: () => ({ namedVectors: true, sparseVectors: false, hybridSearch: false }) } });
  });

  it('embedding failure → 500 embedding_failed, retryable, and the response never contains the raw provider error unredacted beyond the intended message', async () => {
    await withServer(async ({ base, keyStore }) => {
      const { token } = newSearchKey(keyStore);
      const res = await search(base, { token });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error.code, 'embedding_failed');
      assert.equal(body.error.retryable, true);
      assert.match(body.error.message, /Ollama unreachable/);
    }, {
      embedQuery: async () => { throw new Error('Ollama unreachable at http://localhost:11434'); },
    });
  });

  it('an unexpected (non-HttpError) failure — e.g. a raw adapter exception — never forwards its message to the client, only a fixed generic one; the raw detail still reaches server-side logging', async () => {
    const SECRET_URL = 'qdrant://admin:s3cr3t-pw@10.0.0.5:6333';
    const SECRET_PATH = 'C:\\Users\\admin\\secrets\\qdrant.json';
    const rawMessage = `connect ECONNREFUSED ${SECRET_URL} (config at ${SECRET_PATH})`;
    const originalConsoleError = console.error;
    const logged = [];
    console.error = (...args) => { logged.push(args.join(' ')); };
    try {
      await withServer(async ({ base, keyStore }) => {
        const { token } = newSearchKey(keyStore);
        const res = await search(base, { token });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.error.code, 'internal_error');
        assert.equal(body.error.retryable, true);
        assert.equal(body.error.message, 'An unexpected internal error occurred. Please try again later.');
        const rawResponseText = JSON.stringify(body);
        assert.ok(!rawResponseText.includes(SECRET_URL), 'the raw connection string must never reach the client');
        assert.ok(!rawResponseText.includes(SECRET_PATH), 'the raw local path must never reach the client');
        assert.ok(!rawResponseText.includes('ECONNREFUSED'), 'no fragment of the raw adapter error must leak through');
      }, {
        adapterOverrides: {
          searchHybridVectors: async () => { throw new Error(rawMessage); },
        },
      });
      assert.ok(logged.some((line) => line.includes(SECRET_URL)), 'the raw error must still be observable server-side (console.error)');
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe('POST /api/v1/search — window expansion (shared implementation smoke test)', () => {
  it('window=1 compact returns windowChunks with the public projection shape', async () => {
    const neighbor = (chunkIndex) => ({ ...HIT, chunkIndex, text: `neighbor ${chunkIndex}`, section: 'Qdrant' });
    await withServer(async ({ base, keyStore }) => {
      const { token } = newSearchKey(keyStore);
      const res = await search(base, { token, body: { collection: 'docs-a', query: 'q', window: 1 } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.windowFormat, 'compact');
      const wc = body.results[0].windowChunks;
      assert.equal(wc.length, 3);
      assert.deepEqual(wc.map((c) => c.isMatch), [false, true, false]);
      for (const c of wc) assert.equal(typeof c.textSnippet, 'string');
    }, {
      adapterOverrides: {
        getChunk: async (_c, _sf, center, { window }) => {
          assert.equal(window, 1);
          return [neighbor(3), { ...HIT }, neighbor(5)];
        },
      },
    });
  });
});
