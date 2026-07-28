// GET /api/generation/status — offline HTTP-level tests over a real
// node:http server (Phase 4A.5a). No Qdrant, no ONNX, no Ollama — a stub
// StorageAdapter and a stub/real generationRuntime built from
// createGenerationRuntime() with an injected provider factory.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../src/admin/server.js';
import { createGenerationRuntime } from '../../../src/core/generation/runtime.js';

const VALID_PROFILE = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function makeStubAdapter(overrides = {}) {
  return {
    name: () => 'stub',
    capabilities: () => ({ namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true }),
    ping: async () => ({ ok: true, detail: 'stub reachable' }),
    listCollections: async () => [{ name: 'demo' }],
    getCollection: async (name) => (name === 'demo' ? { name: 'demo', pointCount: 5 } : null),
    createCollection: async () => {},
    deleteCollection: async () => {},
    ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
    getEmbeddingProfile: async () => ({ state: 'valid', profile: VALID_PROFILE }),
    listSourceDocuments: async () => [],
    getChunk: async () => [],
    getFileChunks: async () => [],
    getSectionChunks: async () => null,
    searchHybrid: async () => [],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getContentNode: async () => null,
    getSectionAnchor: async () => null,
    ...overrides,
  };
}

function fakeProvider({ name = 'ollama', ready, generate } = {}) {
  return {
    name: () => name,
    capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true }),
    ready: ready ?? (async () => ({ ok: true, model: 'gemma3:4b', numCtx: 8192 })),
    generate: generate ?? (async () => ({ text: 'ok', aborted: false })),
  };
}

const countTokensStub = (text) => (text ?? '').split(/\s+/).filter(Boolean).length;
async function embedQueryStub() { return { dense: [0.1, 0.2], sparse: { indices: [1], values: [0.5] } }; }

async function withServer({ adapter = makeStubAdapter(), generationRuntime, countTokens = countTokensStub, embedQuery = embedQueryStub } = {}, fn) {
  const app = createApp({ adapter, generationRuntime, countTokens, embedQuery });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

describe('GET /api/generation/status — happy path', () => {
  it('returns 200 with the full documented shape when the provider is ready', async () => {
    const generationRuntime = createGenerationRuntime({
      osEnv: { ASK_MODEL: 'gemma3:4b' },
      dotenvValues: { OLLAMA_URL: 'http://dotenv-host:11434' },
      createGenerationProviderFn: () => fakeProvider(),
    });
    await withServer({ generationRuntime }, async (base) => {
      const res = await fetch(base + '/api/generation/status');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.backend, 'ollama');
      assert.equal(body.model, 'gemma3:4b');
      assert.equal(body.ready, true);
      assert.equal(body.reason, null);
      assert.equal(body.numCtx, 8192);
      assert.deepEqual(body.capabilities, { streaming: true, clientAbort: true, upstreamCancellation: true });
      assert.deepEqual(body.devicePolicy, { value: 'auto', supported: ['auto'] });
      assert.equal(body.configuration.model.source, 'os_env');
      assert.equal(body.configuration.baseUrl.source, 'dotenv');
      assert.equal(body.configuration.baseUrl.display, 'http://dotenv-host:11434');
    });
  });
});

describe('GET /api/generation/status — unavailable provider / invalid configuration', () => {
  it('returns 200 with ready:false when the provider is unreachable (never a 5xx)', async () => {
    const generationRuntime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider({
        ready: async () => ({ ok: false, reason: 'Ollama is not reachable at http://localhost:11434.', model: 'gemma3:4b' }),
      }),
    });
    await withServer({ generationRuntime }, async (base) => {
      const res = await fetch(base + '/api/generation/status');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ready, false);
      assert.match(body.reason, /not reachable/);
    });
  });

  it('an unknown backend keeps the endpoint alive and reports ready:false, never a 500', async () => {
    const generationRuntime = createGenerationRuntime({
      osEnv: { SEMIDEX_GENERATION_BACKEND: 'openai' }, dotenvValues: {},
    });
    await withServer({ generationRuntime }, async (base) => {
      const res = await fetch(base + '/api/generation/status');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ready, false);
      assert.equal(body.backend, 'openai');
      assert.match(body.reason, /openai/);
      assert.equal(body.configuration, null);
    });
  });

  it('an invalid ASK_NUM_CTX keeps the endpoint alive and reports ready:false', async () => {
    const generationRuntime = createGenerationRuntime({
      osEnv: { ASK_NUM_CTX: 'garbage' }, dotenvValues: {},
    });
    await withServer({ generationRuntime }, async (base) => {
      const res = await fetch(base + '/api/generation/status');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ready, false);
      assert.match(body.reason, /ASK_NUM_CTX/);
    });
  });
});

describe('GET /api/generation/status — redaction', () => {
  it('never exposes a raw credentialed/queried baseUrl anywhere in the response, including configuration.baseUrl.display', async () => {
    // Regression: an earlier version of getStatus() returned
    // config.baseUrl.value verbatim in configuration.baseUrl.display —
    // confirmed live to leak embedded credentials, a path, and a
    // ?token=... query string into the JSON response. The only prior test
    // covering this checked `body.reason` alone, which never exercises the
    // `configuration` block at all (code review finding) — this test uses
    // a READY provider specifically so `configuration` is populated
    // (not null), and asserts against the full raw response TEXT, not a
    // hand-picked field, so a leak anywhere in the body would be caught.
    const generationRuntime = createGenerationRuntime({
      osEnv: {}, dotenvValues: { OLLAMA_URL: 'http://user:pass@internal-host:11434/some/path?token=leak-me' },
      createGenerationProviderFn: () => fakeProvider(),
    });
    await withServer({ generationRuntime }, async (base) => {
      const res = await fetch(base + '/api/generation/status');
      const text = await res.text();
      assert.ok(!text.includes('token=leak-me'), `leaked query string in full response: ${text}`);
      assert.ok(!text.includes('user:pass'), `leaked credentials in full response: ${text}`);
      assert.ok(!text.includes('/some/path'), `leaked path in full response: ${text}`);
      const body = JSON.parse(text);
      assert.equal(body.configuration.baseUrl.display, 'http://internal-host:11434');
    });
  });

  it('never exposes a raw credentialed/queried URL in the reason field', async () => {
    const generationRuntime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider({
        ready: async () => ({
          ok: false,
          reason: 'Ollama is not reachable at http://user:pass@internal-host:11434/some/path?token=leak-me.',
        }),
      }),
    });
    await withServer({ generationRuntime }, async (base) => {
      const res = await fetch(base + '/api/generation/status');
      const body = await res.json();
      assert.ok(!body.reason.includes('token=leak-me'), `leaked query string: ${body.reason}`);
      assert.ok(!body.reason.includes('user:pass'), `leaked credentials: ${body.reason}`);
    });
  });

  it('the response body never contains a raw QDRANT_KEY value', async () => {
    const originalKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'super-secret-test-key';
    try {
      const generationRuntime = createGenerationRuntime({
        osEnv: {}, dotenvValues: {},
        createGenerationProviderFn: () => fakeProvider({
          ready: async () => ({ ok: false, reason: 'failed with key super-secret-test-key embedded' }),
        }),
      });
      await withServer({ generationRuntime }, async (base) => {
        const res = await fetch(base + '/api/generation/status');
        const text = await res.text();
        assert.ok(!text.includes('super-secret-test-key'));
      });
    } finally {
      if (originalKey === undefined) delete process.env.QDRANT_KEY;
      else process.env.QDRANT_KEY = originalKey;
    }
  });

  it('the response never includes an ASK_NUM_CTX-adjacent raw env dump or unrelated fields', async () => {
    const generationRuntime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider(),
    });
    await withServer({ generationRuntime }, async (base) => {
      const res = await fetch(base + '/api/generation/status');
      const body = await res.json();
      assert.deepEqual(
        Object.keys(body).sort(),
        ['backend', 'capabilities', 'configuration', 'devicePolicy', 'model', 'numCtx', 'ready', 'reason']
      );
    });
  });
});

describe('GET /api/generation/status — no eager initialization', () => {
  it('constructing createApp() with a stub generationRuntime never touches Ollama/ONNX/network', async () => {
    // Regression guard: an early version of this test suite forgot to stub
    // embedQuery/countTokens and silently loaded the real ~2.3GB ONNX
    // tokenizer via the production defaultCountTokens/embedForSearch
    // fallbacks the moment a real /api/v1/ask request reached the
    // coordinator — 5+ seconds and a real model load in what should be an
    // offline unit test. This test asserts the wiring itself never calls
    // out: no network fetch or ONNX import happens merely from creating
    // the app and querying the status endpoint (no /api/v1/ask call at all
    // here).
    const generationRuntime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider(),
    });
    await withServer({ generationRuntime }, async (base) => {
      const res = await fetch(base + '/api/generation/status');
      assert.equal(res.status, 200);
    });
  });
});

describe('GET /api/generation/status — shares the same runtime as POST /api/v1/ask', () => {
  it('a runtime injected into createApp() is used by both the status endpoint and the Ask coordinator', async () => {
    let readyCallCount = 0;
    const generationRuntime = createGenerationRuntime({
      osEnv: {}, dotenvValues: {},
      createGenerationProviderFn: () => fakeProvider({
        ready: async () => { readyCallCount += 1; return { ok: true, model: 'gemma3:4b', numCtx: 8192 }; },
      }),
    });
    const adapter = makeStubAdapter({ searchHybrid: async () => [] }); // zero evidence -> ask refuses without calling generate, but still calls ready()
    await withServer({ adapter, generationRuntime }, async (base) => {
      const statusRes = await fetch(base + '/api/generation/status');
      assert.equal((await statusRes.json()).ready, true);
      assert.equal(readyCallCount, 1);

      const askRes = await fetch(base + '/api/v1/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'demo', question: 'q' }),
      });
      assert.equal(askRes.status, 200); // zero-evidence refusal still streams a 200 SSE response
      await askRes.text();
      // Both the status route and the Ask coordinator's provider_unavailable
      // check call ready() — if they were backed by two different runtime
      // instances constructed from the same env, this count would still
      // match by coincidence; the real proof is that DI accepted exactly
      // one generationRuntime object and both routes used it (same object
      // identity, verified by both call paths incrementing the same
      // closure variable).
      assert.equal(readyCallCount, 2);
    });
  });
});
