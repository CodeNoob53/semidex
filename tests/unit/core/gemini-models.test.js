import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discoverGeminiModels } from '../../../src/cloud/generation/gemini-models.js';

function makePager(models) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const model of models) yield model;
    },
  };
}

function stubClient(models) {
  return () => ({
    models: {
      list: async () => makePager(models),
    },
  });
}

describe('discoverGeminiModels', () => {
  it('returns an unavailable result when no API key is configured — never crashes', async () => {
    const result = await discoverGeminiModels({ apiKey: '' });
    assert.equal(result.available, false);
    assert.match(result.reason, /GEMINI_API_KEY is not set/);
    assert.deepEqual(result.models, []);
  });

  it('lists models with capabilities from the real supportedActions field, not a name heuristic', async () => {
    const result = await discoverGeminiModels({
      apiKey: 'unique-key-1',
      createClientFn: stubClient([
        { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent', 'countTokens'], inputTokenLimit: 1_000_000 },
        { name: 'models/text-embedding-004', supportedActions: ['embedContent'], inputTokenLimit: 2048 },
      ]),
    });
    assert.equal(result.available, true);
    // Real models.list() responses are resource names ("models/x") — this
    // discovery adapter normalizes to the bare form (see
    // normalizeModelName()) so a discovered model's name string-equals
    // what generateContentStream()/models.get() actually accept, and what
    // ASK_MODEL/DEFAULT_MODEL_BY_BACKEND already store.
    const byName = Object.fromEntries(result.models.map((m) => [m.name, m]));
    assert.deepEqual(byName['gemini-2.5-flash'].capabilities, ['generateContent', 'countTokens']);
    assert.equal(byName['gemini-2.5-flash'].inputTokenLimit, 1_000_000);
    assert.deepEqual(byName['text-embedding-004'].capabilities, ['embedContent']);
  });

  it('normalizes a real resource-name API response so the default model is never mistaken for "not installed"', async () => {
    // Reproduces the exact code-review finding: the real API returns
    // "models/gemini-2.5-flash", but DEFAULT_MODEL_BY_BACKEND.gemini and
    // every ASK_MODEL comparison site use the bare "gemini-2.5-flash".
    // Without normalization, this discovery result would never match that
    // default, and the Settings UI would render the real default model as
    // "(not installed)" even though it is the exact model the API just
    // listed.
    const result = await discoverGeminiModels({
      apiKey: 'unique-key-normalize',
      createClientFn: stubClient([
        { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'], inputTokenLimit: 1_000_000 },
      ]),
    });
    assert.equal(result.models[0].name, 'gemini-2.5-flash');
    assert.ok(!result.models[0].name.includes('models/'), 'the models/ resource-name prefix must not leak into the discovery result');
  });

  it('reports capabilities:null (never guessed from the name) when supportedActions is absent', async () => {
    const result = await discoverGeminiModels({
      apiKey: 'unique-key-2',
      createClientFn: stubClient([{ name: 'models/some-future-model', inputTokenLimit: 500 }]),
    });
    assert.equal(result.models[0].capabilities, null);
  });

  it('paginates through every page the Pager yields, not just the first', async () => {
    // The real Pager is an AsyncIterable that internally fetches
    // subsequent pages as iteration proceeds — this stub simulates that by
    // yielding items across what would be multiple pages from a single
    // async generator, proving discoverGeminiModels iterates to
    // completion rather than only reading page.length items.
    const manyModels = Array.from({ length: 250 }, (_, i) => ({
      name: `models/model-${i}`,
      supportedActions: ['generateContent'],
    }));
    const result = await discoverGeminiModels({ apiKey: 'unique-key-3', createClientFn: stubClient(manyModels) });
    assert.equal(result.models.length, 250);
  });

  it('surfaces a models.list() failure as an actionable, redacted error without throwing', async () => {
    const result = await discoverGeminiModels({
      apiKey: 'leak-me-not-77',
      createClientFn: () => ({
        models: { list: async () => { throw new Error('quota exceeded for key leak-me-not-77'); } },
      }),
    });
    assert.equal(result.available, false);
    assert.match(result.reason, /Failed to list Gemini models/);
    assert.ok(!result.reason.includes('leak-me-not-77'), 'the API key must never appear in the reason');
    assert.match(result.reason, /\[REDACTED\]/);
  });

  it('surfaces a client-initialization failure as an actionable, redacted error', async () => {
    const result = await discoverGeminiModels({
      apiKey: 'another-secret-99',
      createClientFn: () => { throw new Error('bad client config with another-secret-99'); },
    });
    assert.equal(result.available, false);
    assert.ok(!result.reason.includes('another-secret-99'));
  });

  it('caches a successful result briefly, keyed by API key — avoids repeating the network call', async () => {
    let listCalls = 0;
    const createClientFn = () => ({
      models: {
        list: async () => { listCalls += 1; return makePager([{ name: 'models/x', supportedActions: ['generateContent'] }]); },
      },
    });
    await discoverGeminiModels({ apiKey: 'cache-key-unique-1', createClientFn });
    await discoverGeminiModels({ apiKey: 'cache-key-unique-1', createClientFn });
    assert.equal(listCalls, 1, 'the second call within the cache TTL must not hit the network again');
  });

  it('forceRefresh bypasses the cache', async () => {
    let listCalls = 0;
    const createClientFn = () => ({
      models: {
        list: async () => { listCalls += 1; return makePager([{ name: 'models/x', supportedActions: ['generateContent'] }]); },
      },
    });
    await discoverGeminiModels({ apiKey: 'cache-key-unique-2', createClientFn });
    await discoverGeminiModels({ apiKey: 'cache-key-unique-2', createClientFn, forceRefresh: true });
    assert.equal(listCalls, 2);
  });

  it('a different API key never serves another key\'s cached result', async () => {
    let listCalls = 0;
    const createClientFn = () => ({
      models: {
        list: async () => { listCalls += 1; return makePager([{ name: 'models/x', supportedActions: ['generateContent'] }]); },
      },
    });
    await discoverGeminiModels({ apiKey: 'cache-key-unique-3a', createClientFn });
    await discoverGeminiModels({ apiKey: 'cache-key-unique-3b', createClientFn });
    assert.equal(listCalls, 2);
  });

  it('the API key never appears anywhere in a successful response', async () => {
    const result = await discoverGeminiModels({
      apiKey: 'must-not-leak-key-123',
      createClientFn: stubClient([{ name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] }]),
    });
    const json = JSON.stringify(result);
    assert.ok(!json.includes('must-not-leak-key-123'));
  });
});
