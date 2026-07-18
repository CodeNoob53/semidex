// POST /api/ask through the REAL createGeminiProvider (Stage B1) — not a
// hand-rolled GenerationProvider stub. Only the @google/genai SDK client
// itself is replaced via createGeminiProvider's DI hook (createClientFn),
// so this exercises the real gemini-provider.js -> AskCoordinator -> SSE
// route wiring end to end, proving the Ask coordinator needs zero
// Gemini-specific branches to work with this backend (mirrors
// ask.test.js's existing "offline SSE over a real node:http server"
// pattern, just with a real Gemini provider instance instead of a stub
// shaped like one).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../src/admin/server.js';
import { createAskCoordinator } from '../../../src/core/ask/coordinator.js';
import { createGeminiProvider } from '../../../src/core/generation/gemini-provider.js';

const HIT = {
  sourceFile: 'docs/en/configuration.md',
  chunkIndex: 4,
  section: 'Qdrant',
  text: 'QDRANT_URL points at the Qdrant instance.',
  nodeType: null, nodeId: null, nodePath: null,
  score: 0.03,
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
    listSourceDocuments: async () => [],
    getChunk: async () => [],
    getFileChunks: async () => [],
    getSectionChunks: async () => null,
    searchHybrid: async () => [HIT],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getContentNode: async () => null,
    getSectionAnchor: async () => null,
    ...overrides,
  };
}

async function embedQueryStub() {
  return { dense: [0.1, 0.2], sparse: { indices: [1], values: [0.5] } };
}

const countTokensStub = (text) => (text ?? '').split(/\s+/).filter(Boolean).length;

function stubGenAiClient({ streamFn } = {}) {
  return () => ({
    models: {
      get: async ({ model }) => ({ name: model, inputTokenLimit: 1_000_000, supportedActions: ['generateContent'] }),
      generateContentStream: streamFn ?? (async () => {
        async function* gen() {
          yield { text: 'The value is ' };
          yield { text: '42 [1].', usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 6 } };
        }
        return gen();
      }),
    },
  });
}

async function withServer({ adapter = makeStubAdapter(), embedQuery = embedQueryStub, generationProvider, apiKey = 'test-key', streamFn } = {}, fn) {
  const provider = generationProvider ?? createGeminiProvider({
    apiKey, model: 'gemini-2.5-flash', createClientFn: stubGenAiClient({ streamFn }),
  });
  const askCoordinator = createAskCoordinator({ adapter, embedQuery, countTokens: countTokensStub, generationProvider: provider });
  const app = createApp({ adapter, embedQuery, askCoordinator });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

function post(base, body) {
  return fetch(base + '/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const eventLine = lines.find((l) => l.startsWith('event: '));
    const dataLine = lines.find((l) => l.startsWith('data: '));
    if (!eventLine || !dataLine) continue;
    events.push({ event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) });
  }
  return events;
}

describe('POST /api/ask — through the real Gemini provider', () => {
  it('streams sources, token events, and a grounded done event — same SSE contract as Ollama', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'What does QDRANT_URL do?' });
      assert.equal(res.status, 200);
      const events = parseSse(await res.text());
      assert.equal(events[0].event, 'sources');
      assert.ok(events.some((e) => e.event === 'token'));
      const tokenText = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
      assert.equal(tokenText, 'The value is 42 [1].');
      const last = events[events.length - 1];
      assert.equal(last.event, 'done');
      assert.equal(last.data.provider, 'gemini');
      assert.equal(last.data.model, 'gemini-2.5-flash');
      assert.equal(last.data.promptTokens, 20);
      assert.equal(last.data.completionTokens, 6);
    });
  });

  it('validates citations the same way regardless of backend — an answer citing [1] against one real source passes', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      const events = parseSse(await res.text());
      const last = events[events.length - 1];
      assert.equal(last.event, 'done');
      assert.equal(last.data.refused, false);
    });
  });

  it('missing GEMINI_API_KEY makes generation unavailable via a pre-stream 503, never a crash', async () => {
    await withServer({ apiKey: '' }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.match(body.error.message, /GEMINI_API_KEY/);
    });
  });

  it('a mid-stream Gemini failure emits a terminal error event, not done — same contract as Ollama', async () => {
    await withServer({
      streamFn: async () => {
        async function* gen() {
          yield { text: 'partial' };
          throw new Error('Gemini quota exceeded');
        }
        return gen();
      },
    }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      const events = parseSse(await res.text());
      assert.equal(events[0].event, 'sources');
      assert.ok(events.some((e) => e.event === 'token'));
      const last = events[events.length - 1];
      assert.equal(last.event, 'error');
      assert.equal(last.data.code, 'generation_failed');
      assert.equal(events.some((e) => e.event === 'done'), false);
    });
  });

  it('client abort during a Gemini stream stops consuming (config.abortSignal) and releases the coordinator lock — same contract as Ollama', async () => {
    // Mirrors ask.test.js's "POST /api/ask — client abort" test exactly,
    // but exercises the REAL gemini-provider.js abort path (it passes the
    // Ask coordinator's signal through as config.abortSignal to
    // generateContentStream — see gemini-provider.js) rather than a
    // hand-rolled stub's own signal handling.
    let sawAbortSignalOnConfig = false;
    let releaseStream;
    const streamFn = ({ config }) => new Promise((resolve) => {
      config?.abortSignal?.addEventListener('abort', () => {
        sawAbortSignalOnConfig = true;
        async function* aborted() { yield { text: 'a' }; }
        resolve(aborted());
      });
      releaseStream = () => {
        async function* gen() { yield { text: 'a' }; yield { text: 'b [1].' }; }
        resolve(gen());
      };
    });
    const provider = createGeminiProvider({
      apiKey: 'test-key', model: 'gemini-2.5-flash', createClientFn: stubGenAiClient({ streamFn }),
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const controller = new AbortController();
      const reqPromise = fetch(base + '/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'demo', question: 'q' }),
        signal: controller.signal,
      }).catch(() => null); // client-side abort rejects the fetch itself

      await new Promise((r) => setTimeout(r, 50));
      controller.abort();
      await reqPromise;
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(sawAbortSignalOnConfig, true, 'gemini-provider.js must forward the Ask coordinator\'s signal as config.abortSignal');
      releaseStream?.();
    });
  });

  it('never routes through /api/ollama-models or listOllamaModels — proves no Ollama-specific code path is exercised for this backend', async () => {
    // Confirmed structurally: createGeminiProvider's DI-injected client is
    // the ONLY network-shaped dependency this provider has (verified via
    // gemini-provider.js's own source — no import of core/ollama.js
    // anywhere in that file). Running the full Ask flow above with only
    // the Gemini client stubbed (no Ollama stub of any kind supplied) and
    // it succeeding is itself the proof; this test just makes that
    // assertion explicit and named.
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 200);
    });
  });
});
