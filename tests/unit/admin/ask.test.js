// POST /api/ask — offline SSE tests over a real node:http server with a
// stub StorageAdapter, stub embedQuery, and a stub GenerationProvider. No
// Qdrant, no ONNX, no Ollama — createApp() is given a real askCoordinator
// built from these stubs, so this exercises the real route + coordinator +
// evidence + prompt + citation wiring, only the network-touching leaves are
// replaced.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../src/admin/server.js';
import { createAskCoordinator } from '../../../src/core/ask/coordinator.js';
import { REFUSAL_SENTINEL } from '../../../src/core/ask/prompt.js';

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

function makeStubProvider(overrides = {}) {
  return {
    name: () => 'ollama',
    capabilities: () => ({ streaming: true, cancellation: true }),
    ready: async () => ({ ok: true, model: 'gemma3:4b' }),
    generate: async ({ onToken }) => {
      onToken?.('The value is ');
      onToken?.('42 [1].');
      return { text: 'The value is 42 [1].', tokensIn: 20, tokensOut: 6, aborted: false };
    },
    ...overrides,
  };
}

async function withServer({ adapter = makeStubAdapter(), embedQuery = embedQueryStub, generationProvider = makeStubProvider() } = {}, fn) {
  const askCoordinator = createAskCoordinator({ adapter, embedQuery, countTokens: countTokensStub, generationProvider });
  const app = createApp({ adapter, embedQuery, askCoordinator });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base, { askCoordinator });
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

// Parses a fully-consumed SSE response body into an ordered array of
// { event, data } — good enough for these tests since every scenario
// completes (or the client aborts) rather than streaming indefinitely.
function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const eventLine = lines.find(l => l.startsWith('event: '));
    const dataLine = lines.find(l => l.startsWith('data: '));
    if (!eventLine || !dataLine) continue;
    events.push({ event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) });
  }
  return events;
}

describe('POST /api/ask — validation (pre-stream, plain JSON)', () => {
  it('invalid JSON body -> 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, '{not json');
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'bad_request');
    });
  });

  it('missing collection -> 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { question: 'q' });
      assert.equal(res.status, 400);
    });
  });

  it('missing question -> 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo' });
      assert.equal(res.status, 400);
    });
  });

  it('invalid top -> 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q', top: 11 });
      assert.equal(res.status, 400);
    });
  });

  it('unknown collection -> 404, before any stream', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'missing', question: 'q' });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    });
  });
});

describe('POST /api/ask — provider unavailable', () => {
  it('returns 503 before streaming, never calls generate', async () => {
    let generateCalled = false;
    const provider = makeStubProvider({
      ready: async () => ({ ok: false, reason: 'Ollama is not reachable' }),
      generate: async () => { generateCalled = true; return { text: '' }; },
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 503);
      assert.equal(generateCalled, false);
    });
  });
});

describe('POST /api/ask — SSE happy path', () => {
  it('emits sources first, then token events, then done with full metadata', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'What is the value?' });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const events = parseSse(await res.text());

      assert.equal(events[0].event, 'sources');
      assert.equal(events[0].data.sources.length, 1);
      assert.equal(events[0].data.sources[0].n, 1);

      const tokenEvents = events.filter(e => e.event === 'token');
      assert.deepEqual(tokenEvents.map(e => e.data.text), ['The value is ', '42 [1].']);

      const doneEvents = events.filter(e => e.event === 'done');
      assert.equal(doneEvents.length, 1);
      const done = doneEvents[0].data;
      assert.deepEqual(done.citations, [1]);
      assert.deepEqual(done.invalidCitations, []);
      assert.equal(done.refused, false);
      assert.equal(done.provider, 'ollama');
      assert.equal(done.model, 'gemma3:4b');
      assert.equal(done.promptTokens, 20);
      assert.equal(done.completionTokens, 6);
      assert.equal(done.evidenceCount, 1);
      assert.equal(typeof done.elapsedMs, 'number');

      // sources strictly precedes done, and there is no error event on success.
      assert.ok(events.findIndex(e => e.event === 'sources') < events.findIndex(e => e.event === 'done'));
      assert.equal(events.some(e => e.event === 'error'), false);
    });
  });
});

describe('POST /api/ask — zero evidence', () => {
  it('emits empty sources then refused done, never calls the provider', async () => {
    let generateCalled = false;
    const provider = makeStubProvider({ generate: async () => { generateCalled = true; return { text: '' }; } });
    const adapter = makeStubAdapter({ searchHybrid: async () => [] });
    await withServer({ adapter, generationProvider: provider }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 200);
      const events = parseSse(await res.text());
      assert.equal(events[0].event, 'sources');
      assert.deepEqual(events[0].data.sources, []);
      assert.equal(events[1].event, 'done');
      assert.equal(events[1].data.refused, true);
      assert.equal(events[1].data.refusalReason, 'no_evidence');
      assert.equal(generateCalled, false);
    });
  });
});

describe('POST /api/ask — generation failure after streaming starts', () => {
  it('emits sources then a terminal error event, not done', async () => {
    const provider = makeStubProvider({
      generate: async ({ onToken }) => { onToken?.('partial'); throw new Error('model crashed'); },
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 200);
      const events = parseSse(await res.text());
      assert.equal(events[0].event, 'sources');
      assert.ok(events.some(e => e.event === 'token'));
      const last = events[events.length - 1];
      assert.equal(last.event, 'error');
      assert.equal(last.data.code, 'generation_failed');
      assert.equal(events.some(e => e.event === 'done'), false);
    });
  });
});

describe('POST /api/ask — concurrency', () => {
  it('a second concurrent ask returns 429 before streaming', async () => {
    let releaseGenerate;
    const provider = makeStubProvider({
      generate: () => new Promise((resolve) => {
        releaseGenerate = () => resolve({ text: 'ok [1].', aborted: false });
      }),
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const firstPromise = post(base, { collection: 'demo', question: 'q1' });
      // Give the first request time to acquire the coordinator lock and
      // start streaming before firing the second.
      await new Promise((r) => setTimeout(r, 50));

      const second = await post(base, { collection: 'demo', question: 'q2' });
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error.code, 'busy');

      releaseGenerate();
      const first = await firstPromise;
      assert.equal(first.status, 200);
      const events = parseSse(await first.text());
      assert.equal(events.some(e => e.event === 'done'), true);
    });
  });
});

describe('POST /api/ask — client abort', () => {
  it('aborting the client request signals the provider and releases the coordinator lock', async () => {
    let sawAbort = false;
    let releaseGenerate;
    const provider = makeStubProvider({
      generate: ({ signal }) => new Promise((resolve) => {
        signal?.addEventListener('abort', () => { sawAbort = true; resolve({ text: '', aborted: true }); });
        releaseGenerate = () => resolve({ text: 'ok [1].', aborted: false });
      }),
    });
    await withServer({ generationProvider: provider }, async (base, { askCoordinator }) => {
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

      // Give the server-side 'close' handler a tick to fire and the
      // coordinator's finally{} to run.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(sawAbort, true);
      assert.equal(askCoordinator.isBusy(), false);
      releaseGenerate?.();
    });
  });
});

describe('POST /api/ask — retrieval error before streaming', () => {
  it('embedding failure -> 500, no stream started', async () => {
    const embedQuery = async () => { throw new Error('embed boom'); };
    await withServer({ embedQuery }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    });
  });
});

describe('POST /api/ask — error message redaction', () => {
  it('redacts a raw Ollama base URL from a provider_unavailable 503 reason', async () => {
    const provider = makeStubProvider({
      ready: async () => ({
        ok: false,
        reason: 'Ollama is not reachable at http://internal-host:11434/some/path?token=secret. Start it with "ollama serve".',
      }),
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 503);
      const body = await res.json();
      // sanitiseErrorMessage reduces a URL with a path/query to host-only —
      // the credential/query-bearing tail must not reach the client.
      assert.ok(!body.error.message.includes('token=secret'), `leaked query string: ${body.error.message}`);
      assert.ok(!body.error.message.includes('/some/path'), `leaked path: ${body.error.message}`);
    });
  });

  it('redacts a raw error body from a mid-stream generation_failed SSE error event', async () => {
    const provider = makeStubProvider({
      generate: async ({ onToken }) => {
        onToken?.('partial');
        throw new Error('Ollama generate (stream) failed: {"error":"upstream at http://internal-host:11434/api/generate?key=leak-me failed"}');
      },
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      const events = parseSse(await res.text());
      const errorEvent = events.find(e => e.event === 'error');
      assert.ok(errorEvent, 'expected a terminal error event');
      assert.ok(!errorEvent.data.message.includes('key=leak-me'), `leaked query string: ${errorEvent.data.message}`);
    });
  });
});

describe('POST /api/ask — structural node references end to end', () => {
  it('a table hit produces a citable [node: path] the model can reference, validated in done.entityRefs', async () => {
    const tableHit = {
      sourceFile: 'docs/en/config.md', chunkIndex: 2, section: 'Config',
      text: '| a | b |\n|---|---|\n| 1 | 2 |',
      nodeType: 'table', nodeId: 'table-node-1', nodePath: 'docs/en/config.md#config-table',
      score: 0.05,
    };
    const adapter = makeStubAdapter({
      searchHybrid: async () => [tableHit],
      // No section structure available -> evidence.js falls back to the
      // hit's own text, but nodeId/nodePath/nodeType must survive untouched.
      getContentNode: async () => null,
      getSkeletonNode: async () => null,
    });
    const provider = makeStubProvider({
      generate: async ({ prompt, onToken }) => {
        // Confirm the prompt actually told the model the node path, per the
        // structural-node-reference fix — the model can only cite what it
        // was shown.
        assert.match(prompt, /\[node: docs\/en\/config\.md#config-table\]/);
        const answer = 'Here is the table:\n[node: docs/en/config.md#config-table]\n[1]';
        onToken?.(answer);
        return { text: answer, aborted: false };
      },
    });
    await withServer({ adapter, generationProvider: provider }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'Show me the config table' });
      const events = parseSse(await res.text());
      const done = events.find(e => e.event === 'done').data;
      assert.deepEqual(done.entityRefs, ['docs/en/config.md#config-table']);
      assert.deepEqual(done.strippedMarkers, []);
    });
  });
});

describe('POST /api/ask — whitespace-wrapped refusal never leaks over the wire', () => {
  it('a sentinel wrapped in leading/trailing whitespace, streamed char-by-char, produces zero token events', async () => {
    const wrapped = `\n${REFUSAL_SENTINEL}\n`;
    const provider = makeStubProvider({
      generate: async ({ onToken }) => {
        for (const ch of wrapped) onToken?.(ch);
        return { text: wrapped, aborted: false };
      },
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      const events = parseSse(await res.text());
      assert.equal(events.filter(e => e.event === 'token').length, 0);
      const done = events.find(e => e.event === 'done').data;
      assert.equal(done.refused, true);
    });
  });
});
