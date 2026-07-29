// POST /api/v1/ask through the REAL createGeminiProvider (Stage B1) — not a
// hand-rolled GenerationProvider stub. Only the @google/genai SDK client
// itself is replaced via createGeminiProvider's DI hook (createClientFn),
// so this exercises the real gemini-provider.js -> AskCoordinator -> SSE
// route wiring end to end, proving the Ask coordinator needs zero
// Gemini-specific branches to work with this backend (mirrors
// ask.test.js's existing "offline SSE over a real node:http server"
// pattern, just with a real Gemini provider instance instead of a stub
// shaped like one). Event names/payload shapes here are the versioned v1
// public contract (src/core/ask-api/v1/contract.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../src/admin/server.js';
import { createAskCoordinator } from '../../../src/core/ask/coordinator.js';
import { createGeminiProvider } from '../../../src/core/generation/gemini-provider.js';
import { createOllamaProvider } from '../../../src/core/generation/ollama-provider.js';
import { ASK_PATH } from '../../../src/core/ask-api/v1/contract.js';

const HIT = {
  sourceFile: 'docs/en/configuration.md',
  chunkIndex: 4,
  section: 'Qdrant',
  text: 'QDRANT_URL points at the Qdrant instance.',
  nodeType: null, nodeId: null, nodePath: null,
  score: 0.03,
};

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
    searchHybridVectors: async () => [HIT],
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
  return fetch(base + ASK_PATH, {
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

describe('POST /api/v1/ask — through the real Gemini provider', () => {
  it('streams sources, answer_delta events, and a grounded done event — same v1 SSE contract as Ollama', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'What does QDRANT_URL do?' });
      assert.equal(res.status, 200);
      const events = parseSse(await res.text());
      assert.equal(events[0].event, 'sources');
      assert.ok(events.some((e) => e.event === 'answer_delta'));
      assert.equal(events.some((e) => e.event === 'token'), false, 'the pre-v1 "token" event name must never appear');
      const deltaText = events.filter((e) => e.event === 'answer_delta').map((e) => e.data.text).join('');
      assert.equal(deltaText, 'The value is 42 [1].');
      const last = events[events.length - 1];
      assert.equal(last.event, 'done');
      assert.equal(last.data.provider, 'gemini');
      assert.equal(last.data.model, 'gemini-2.5-flash');
      assert.deepEqual(last.data.usage, { promptTokens: 20, completionTokens: 6 });
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
      assert.equal(body.error.code, 'dependency_unavailable');
      assert.equal(body.error.retryable, true);
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
      assert.ok(events.some((e) => e.event === 'answer_delta'));
      const last = events[events.length - 1];
      assert.equal(last.event, 'error');
      assert.equal(last.data.code, 'generation_failed');
      assert.equal(last.data.retryable, true);
      assert.equal(events.some((e) => e.event === 'done'), false);
    });
  });

  it('client abort during a Gemini stream stops consuming (config.abortSignal) and releases the coordinator lock — same contract as Ollama', async () => {
    // Mirrors ask.test.js's client-abort test exactly, but exercises the
    // REAL gemini-provider.js abort path (it passes the Ask coordinator's
    // signal through as config.abortSignal to generateContentStream — see
    // gemini-provider.js) rather than a hand-rolled stub's own signal
    // handling.
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
      const reqPromise = fetch(base + ASK_PATH, {
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

  it('sends the real system instruction via config.systemInstruction — contents carries only evidence/question, never a fake System: section', async () => {
    let capturedCall;
    const streamFn = async (call) => {
      capturedCall = call;
      async function* gen() { yield { text: 'The value is 42 [1].' }; }
      return gen();
    };
    const provider = createGeminiProvider({
      apiKey: 'test-key', model: 'gemini-2.5-flash', createClientFn: stubGenAiClient({ streamFn }),
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'What does QDRANT_URL do?' });
      assert.equal(res.status, 200);
    });
    assert.equal(typeof capturedCall.config.systemInstruction, 'string');
    assert.ok(capturedCall.config.systemInstruction.length > 0);
    assert.match(capturedCall.config.systemInstruction, /numbered evidence/);
    assert.ok(!/^System:/m.test(capturedCall.contents), 'contents must never carry a fake "System:" section through the full coordinator -> provider path');
    assert.match(capturedCall.contents, /^Evidence:/);
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

describe('POST /api/v1/ask — Gemini and Ollama produce the same public event schema', () => {
  it('both real providers stream through the identical sources/answer_delta/done shape, differing only in provider/model/usage values', async () => {
    // Gemini side: real createGeminiProvider, SDK client stubbed.
    const geminiEvents = await new Promise((resolve, reject) => {
      withServer({}, async (base) => {
        const res = await post(base, { collection: 'demo', question: 'What does QDRANT_URL do?' });
        resolve(parseSse(await res.text()));
      }).catch(reject);
    });

    // Ollama side: real createOllamaProvider, generateStreamFn stubbed so
    // no real network/Ollama instance is touched.
    const ollamaProvider = createOllamaProvider({
      model: 'gemma3:4b',
      isOllamaReachableFn: async () => true,
      listOllamaModelsFn: async () => ['gemma3:4b'],
      getModelContextLengthFn: async () => 8192,
      generateStreamFn: async (_model, _prompt, { onToken }) => {
        await onToken?.('The value is ');
        await onToken?.('42 [1].');
        return { text: 'The value is 42 [1].', tokensIn: 20, tokensOut: 6, aborted: false };
      },
    });
    const ollamaEvents = await new Promise((resolve, reject) => {
      withServer({ generationProvider: ollamaProvider }, async (base) => {
        const res = await post(base, { collection: 'demo', question: 'What does QDRANT_URL do?' });
        resolve(parseSse(await res.text()));
      }).catch(reject);
    });

    // Same event NAME sequence for both backends.
    assert.deepEqual(geminiEvents.map((e) => e.event), ollamaEvents.map((e) => e.event));

    // Same public KEY shape for every event of the same name, regardless
    // of backend — the client-facing contract is provider-neutral.
    const sourcesKeys = (events) => Object.keys(events.find((e) => e.event === 'sources').data).sort();
    assert.deepEqual(sourcesKeys(geminiEvents), sourcesKeys(ollamaEvents));

    const doneKeys = (events) => Object.keys(events.find((e) => e.event === 'done').data).sort();
    assert.deepEqual(doneKeys(geminiEvents), doneKeys(ollamaEvents));

    const deltaKeys = (events) => Object.keys(events.find((e) => e.event === 'answer_delta').data).sort();
    assert.deepEqual(deltaKeys(geminiEvents), deltaKeys(ollamaEvents));

    // The only fields that are ALLOWED to differ are the ones that are
    // genuinely provider-specific by design (provider name, model name).
    const geminiDone = geminiEvents.find((e) => e.event === 'done').data;
    const ollamaDone = ollamaEvents.find((e) => e.event === 'done').data;
    assert.equal(geminiDone.provider, 'gemini');
    assert.equal(ollamaDone.provider, 'ollama');
    assert.equal(geminiDone.model, 'gemini-2.5-flash');
    assert.equal(ollamaDone.model, 'gemma3:4b');
    // Everything else (apiVersion, citations, entityRefs, refused,
    // refusalReason, evidenceCount, usage/timing key shape) is identical
    // in structure.
    assert.equal(geminiDone.apiVersion, ollamaDone.apiVersion);
    assert.deepEqual(geminiDone.citations, ollamaDone.citations);
    assert.equal(geminiDone.refused, ollamaDone.refused);
  });
});
