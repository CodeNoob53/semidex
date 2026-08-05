import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { discoverOllamaModels } from '../../../src/local/core/ollama-models.js';

describe('discoverOllamaModels', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns an unavailable result when Ollama is unreachable', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const result = await discoverOllamaModels('http://localhost:11001');
    assert.equal(result.available, false);
    assert.match(result.reason, /not reachable/);
    assert.deepEqual(result.models, []);
  });

  it('reports /api/tags failures without throwing', async () => {
    globalThis.fetch = async (url) => {
      if (url.endsWith('/api/version')) return { ok: true };
      if (url.endsWith('/api/tags')) return { ok: false, status: 503 };
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await discoverOllamaModels('http://localhost:11002');
    assert.equal(result.available, false);
    assert.match(result.reason, /Failed to list Ollama models/);
  });

  it('preserves full capabilities and exposes embedding dimensions', async () => {
    globalThis.fetch = async (url, opts) => {
      if (url.endsWith('/api/version')) return { ok: true };
      if (url.endsWith('/api/tags')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: 'gemma3:4b', details: { family: 'gemma3', parameter_size: '4.3B' } },
              { name: 'nomic-embed-text', details: { family: 'nomic-bert', parameter_size: '137M' } },
            ],
          }),
        };
      }
      if (url.endsWith('/api/show')) {
        const { name } = JSON.parse(opts.body);
        if (name === 'nomic-embed-text') {
          return {
            ok: true,
            json: async () => ({
              capabilities: ['completion', 'embedding'],
              model_info: {
                'general.architecture': 'nomic-bert',
                'nomic-bert.embedding_length': 768,
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            capabilities: ['completion'],
            model_info: {
              'general.architecture': 'gemma3',
              'gemma3.embedding_length': 2560,
            },
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const result = await discoverOllamaModels('http://localhost:11003');
    const byName = Object.fromEntries(result.models.map((model) => [model.name, model]));
    assert.deepEqual(byName['gemma3:4b'].capabilities, ['completion']);
    assert.equal(byName['gemma3:4b'].embeddingDimension, null);
    assert.deepEqual(byName['nomic-embed-text'].capabilities, ['completion', 'embedding']);
    assert.equal(byName['nomic-embed-text'].embeddingDimension, 768);
  });

  it('keeps a model unverified when /api/show omits capabilities', async () => {
    globalThis.fetch = async (url) => {
      if (url.endsWith('/api/version')) return { ok: true };
      if (url.endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'weird-embed-name:1b', details: {} }] }) };
      }
      if (url.endsWith('/api/show')) return { ok: true, json: async () => ({}) };
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await discoverOllamaModels('http://localhost:11004');
    assert.equal(result.models[0].capabilities, null);
    assert.equal(result.models[0].embeddingDimension, null);
  });

  it('does not cache a failed /api/show result forever', async () => {
    let showCalls = 0;
    globalThis.fetch = async (url) => {
      if (url.endsWith('/api/version')) return { ok: true };
      if (url.endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'recovering-embed', details: {} }] }) };
      }
      if (url.endsWith('/api/show')) {
        showCalls += 1;
        if (showCalls === 1) return { ok: false, status: 503 };
        return {
          ok: true,
          json: async () => ({
            capabilities: ['embedding'],
            model_info: {
              'general.architecture': 'bert',
              'bert.embedding_length': 384,
            },
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const first = await discoverOllamaModels('http://localhost:11005');
    const second = await discoverOllamaModels('http://localhost:11005');
    assert.equal(first.models[0].capabilities, null);
    assert.deepEqual(second.models[0].capabilities, ['embedding']);
    assert.equal(second.models[0].embeddingDimension, 384);
    assert.equal(showCalls, 2);
  });

  it('forceRefresh bypasses a successful /api/show cache entry', async () => {
    let showCalls = 0;
    globalThis.fetch = async (url) => {
      if (url.endsWith('/api/version')) return { ok: true };
      if (url.endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'changing-model', details: {} }] }) };
      }
      if (url.endsWith('/api/show')) {
        showCalls += 1;
        return { ok: true, json: async () => ({ capabilities: showCalls === 1 ? ['completion'] : ['embedding'] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    await discoverOllamaModels('http://localhost:11006');
    const cached = await discoverOllamaModels('http://localhost:11006');
    const refreshed = await discoverOllamaModels('http://localhost:11006', { forceRefresh: true });
    assert.deepEqual(cached.models[0].capabilities, ['completion']);
    assert.deepEqual(refreshed.models[0].capabilities, ['embedding']);
    assert.equal(showCalls, 2);
  });

  it('bounds /api/show concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.fetch = async (url) => {
      if (url.endsWith('/api/version')) return { ok: true };
      if (url.endsWith('/api/tags')) {
        return {
          ok: true,
          json: async () => ({
            models: Array.from({ length: 10 }, (_, index) => ({ name: `model-${index}`, details: {} })),
          }),
        };
      }
      if (url.endsWith('/api/show')) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return { ok: true, json: async () => ({ capabilities: ['completion'] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    await discoverOllamaModels('http://localhost:11007');
    assert.ok(maxInFlight <= 4);
    assert.ok(maxInFlight > 1);
  });

  it('does not start Ollama or call model execution endpoints', async () => {
    const calledUrls = [];
    globalThis.fetch = async (url) => {
      calledUrls.push(url);
      if (url.endsWith('/api/version')) return { ok: true };
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
      throw new Error(`unexpected fetch ${url}`);
    };
    await discoverOllamaModels('http://localhost:11008');
    assert.ok(calledUrls.every((url) => /\/api\/(version|tags|show)$/.test(url)));
  });
});
