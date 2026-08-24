// POST /api/v1/ask — offline SSE tests over a real node:http server with a
// stub StorageAdapter, stub embedQuery, and a stub GenerationProvider. No
// Qdrant, no ONNX, no Ollama — createApp() is given a real askCoordinator
// built from these stubs, so this exercises the real route + coordinator +
// evidence + prompt + citation wiring, only the network-touching leaves are
// replaced. Event names/payload shapes here are the versioned v1 public
// contract (src/core/ask-api/v1/contract.js): sources / answer_delta /
// done / error, never the pre-v1 seed's "token" event name.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../src/admin/server-full.js';
import { createAskCoordinator } from '../../../src/core/ask/coordinator.js';
import { REFUSAL_SENTINEL } from '../../../src/core/ask/prompt.js';
import { API_VERSION, ASK_PATH } from '../../../src/core/ask-api/v1/contract.js';
import { OPEN_INTEGRATION_POLICY } from '../security/test-integration-policy.js';

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

function makeStubProvider(overrides = {}) {
  return {
    name: () => 'ollama',
    capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true, hardOutputCap: true }),
    ready: async () => ({ ok: true, model: 'gemma3:4b' }),
    generate: async ({ onToken }) => {
      onToken?.('The value is ');
      onToken?.('42 [1].');
      return { text: 'The value is 42 [1].', tokensIn: 20, tokensOut: 6, aborted: false };
    },
    ...overrides,
  };
}

async function withServer({ adapter = makeStubAdapter(), embedQuery = embedQueryStub, generationProvider = makeStubProvider(), askCoordinator: askCoordinatorOverride } = {}, fn) {
  const askCoordinator = askCoordinatorOverride ?? createAskCoordinator({ adapter, embedQuery, countTokens: countTokensStub, generationProvider });
  const app = createApp({ adapter, embedQuery, askCoordinator, integrationPolicy: OPEN_INTEGRATION_POLICY });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base, { askCoordinator });
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

function post(base, body, { path = ASK_PATH } = {}) {
  return fetch(base + path, {
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

describe('POST /api/v1/ask — request normalization', () => {
  it('the exact minimal shape { collection, question } is accepted and produces one sources source', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'What is the value?' });
      assert.equal(res.status, 200);
      const events = parseSse(await res.text());
      assert.equal(events[0].event, 'sources');
      assert.equal(events[0].data.sources.length, 1);
    });
  });

  it('scope.sourceFile is accepted and forwarded to retrieval as the sourceFile filter', async () => {
    let capturedSourceFile;
    const adapter = makeStubAdapter({
      searchHybridVectors: async (_collection, opts) => { capturedSourceFile = opts?.filter?.sourceFile; return [HIT]; },
    });
    await withServer({ adapter }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q', scope: { sourceFile: 'docs/en/configuration.md' } });
      assert.equal(res.status, 200);
      assert.equal(capturedSourceFile, 'docs/en/configuration.md');
    });
  });

  it('an absent "scope" field is fine — scope is optional', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 200);
    });
  });

  it('scope: {} (no sourceFile) is accepted, equivalent to no scope at all', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q', scope: {} });
      assert.equal(res.status, 200);
    });
  });
});

describe('POST /api/v1/ask — rejects the obsolete pre-v1 contract fields', () => {
  it('root-level "sourceFile" is rejected with 400, not silently accepted as a second contract', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q', sourceFile: 'docs/en/configuration.md' });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'bad_request');
      assert.equal(body.error.apiVersion, API_VERSION);
      assert.equal(body.error.retryable, false);
      assert.match(body.error.message, /sourceFile/);
      assert.match(body.error.message, /scope/);
    });
  });

  it('root-level "top" is rejected with 400 — retrieval count is not a client control', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q', top: 3 });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'bad_request');
      assert.match(body.error.message, /top/);
    });
  });

  it('root-level "sessionId" is rejected with 400 — Ask is stateless, no session field exists', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q', sessionId: 'abc123' });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'bad_request');
      assert.equal(body.error.apiVersion, API_VERSION);
      assert.match(body.error.message, /sessionId/);
    });
  });

  it('both obsolete fields present at once still rejects with 400 (sourceFile checked first)', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q', sourceFile: 'x.md', top: 3 });
      assert.equal(res.status, 400);
    });
  });
});

describe('POST /api/v1/ask — validation (pre-stream, plain JSON)', () => {
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

  it('empty-string collection -> 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: '   ', question: 'q' });
      assert.equal(res.status, 400);
    });
  });

  it('scope that is not an object -> 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q', scope: 'not-an-object' });
      assert.equal(res.status, 400);
    });
  });

  it('scope: null -> 400 — the contract requires scope to be an object when present', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q', scope: null });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error.message, /scope/);
    });
  });

  it('scope with an unsupported key -> 400', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q', scope: { tags: ['x'] } });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error.message, /scope/);
    });
  });

  it('unknown collection -> 404, before any stream', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'missing', question: 'q' });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      const body = await res.json();
      assert.equal(body.error.apiVersion, API_VERSION);
      assert.equal(body.error.code, 'not_found');
      assert.equal(body.error.retryable, false);
    });
  });
});

describe('POST /api/v1/ask — provider unavailable', () => {
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
      const body = await res.json();
      assert.equal(body.error.apiVersion, API_VERSION);
      assert.equal(body.error.code, 'dependency_unavailable');
      assert.equal(body.error.retryable, true);
    });
  });
});

describe('POST /api/v1/ask — SSE happy path (sources -> answer_delta* -> done)', () => {
  it('emits sources first, then answer_delta events, then done with full v1 metadata', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'What is the value?' });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const events = parseSse(await res.text());

      assert.equal(events[0].event, 'sources');
      assert.equal(events[0].data.apiVersion, API_VERSION);
      assert.equal(events[0].data.sources.length, 1);
      assert.equal(events[0].data.sources[0].n, 1);
      assert.equal(events[0].data.sources[0].sourceFile, 'docs/en/configuration.md');
      assert.equal(events[0].data.sources[0].chunkIndex, 4);
      assert.equal(events[0].data.sources[0].section, 'Qdrant');
      assert.equal(events[0].data.sources[0].nodeId, null);
      assert.equal(events[0].data.sources[0].nodePath, null);
      assert.equal(events[0].data.sources[0].nodeType, null);
      assert.equal(typeof events[0].data.sources[0].snippet, 'string');
      assert.equal(typeof events[0].data.sources[0].truncated, 'boolean');

      const deltaEvents = events.filter(e => e.event === 'answer_delta');
      assert.ok(deltaEvents.length > 0);
      for (const e of deltaEvents) assert.equal(e.data.apiVersion, API_VERSION);
      assert.deepEqual(deltaEvents.map(e => e.data.text), ['The value is ', '42 [1].']);

      const doneEvents = events.filter(e => e.event === 'done');
      assert.equal(doneEvents.length, 1);
      const done = doneEvents[0].data;
      assert.equal(done.apiVersion, API_VERSION);
      assert.deepEqual(done.citations, [1]);
      assert.equal(done.refused, false);
      assert.equal(done.refusalReason, null);
      assert.equal(done.provider, 'ollama');
      assert.equal(done.model, 'gemma3:4b');
      assert.deepEqual(done.usage, { promptTokens: 20, completionTokens: 6 });
      assert.equal(typeof done.timing.elapsedMs, 'number');
      assert.equal(done.evidenceCount, 1);
      assert.equal(typeof done.answer, 'string');
      assert.match(done.answer, /42/);

      // sources strictly precedes done, and there is no error event on success.
      assert.ok(events.findIndex(e => e.event === 'sources') < events.findIndex(e => e.event === 'done'));
      assert.equal(events.some(e => e.event === 'error'), false);
      // No legacy "token" event name anywhere in this stream.
      assert.equal(events.some(e => e.event === 'token'), false);
    });
  });
});

describe('POST /api/v1/ask — no internal/debug fields in public payloads', () => {
  it('done never includes invalidCitations or strippedMarkers', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      const events = parseSse(await res.text());
      const done = events.find(e => e.event === 'done').data;
      assert.equal('invalidCitations' in done, false);
      assert.equal('strippedMarkers' in done, false);
    });
  });

  it('sources events never include raw internal fields beyond the documented public shape', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      const events = parseSse(await res.text());
      const sourcesPayload = events.find(e => e.event === 'sources').data;
      const oneSource = sourcesPayload.sources[0];
      assert.deepEqual(
        Object.keys(oneSource).sort(),
        ['chunkIndex', 'n', 'nodeId', 'nodePath', 'nodeType', 'section', 'snippet', 'sourceFile', 'truncated']
      );
    });
  });
});

describe('POST /api/v1/ask — zero evidence', () => {
  it('emits empty sources then refused done, never calls the provider', async () => {
    let generateCalled = false;
    const provider = makeStubProvider({ generate: async () => { generateCalled = true; return { text: '' }; } });
    const adapter = makeStubAdapter({ searchHybridVectors: async () => [] });
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

describe('POST /api/v1/ask — generation failure after streaming starts', () => {
  it('emits sources then a terminal error event, not done', async () => {
    const provider = makeStubProvider({
      generate: async ({ onToken }) => { onToken?.('partial'); throw new Error('model crashed'); },
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 200);
      const events = parseSse(await res.text());
      assert.equal(events[0].event, 'sources');
      assert.ok(events.some(e => e.event === 'answer_delta'));
      const last = events[events.length - 1];
      assert.equal(last.event, 'error');
      assert.equal(last.data.apiVersion, API_VERSION);
      assert.equal(last.data.code, 'generation_failed');
      assert.equal(last.data.retryable, true);
      assert.equal(events.some(e => e.event === 'done'), false);
    });
  });
});

describe('POST /api/v1/ask — retrieval failure before streaming', () => {
  it('embedding failure -> 500, no stream started', async () => {
    const embedQuery = async () => { throw new Error('embed boom'); };
    await withServer({ embedQuery }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      const body = await res.json();
      assert.equal(body.error.apiVersion, API_VERSION);
      assert.ok(typeof body.error.retryable === 'boolean');
    });
  });
});

describe('POST /api/v1/ask — unexpected (non-HttpError) exceptions never bypass the v1 contract', () => {
  it('adapter.getCollection() throwing a plain Error before any stream -> 500 JSON with apiVersion/retryable, not the generic { error: { message, code } } shape', async () => {
    const adapter = makeStubAdapter({
      getCollection: async () => { throw new Error('adapter connection reset'); },
    });
    await withServer({ adapter }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      const body = await res.json();
      assert.equal(body.error.apiVersion, API_VERSION);
      assert.equal(body.error.code, 'internal_error');
      assert.equal(body.error.retryable, true);
    });
  });

  it('askCoordinator.ask() rejecting outright (no HttpError, never caught internally) before any stream -> 500 JSON, not an uncaught exception', async () => {
    const askCoordinator = { ask: async () => { throw new Error('coordinator exploded'); } };
    await withServer({ askCoordinator }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error.apiVersion, API_VERSION);
      assert.equal(body.error.code, 'internal_error');
    });
  });

  it('askCoordinator.ask() rejecting AFTER calling onSources -> a terminal SSE error event, never a second JSON write / ERR_HTTP_HEADERS_SENT', async () => {
    const askCoordinator = {
      ask: async ({ onSources }) => {
        await onSources({ searchMode: 'hybrid', sources: [] });
        throw new Error('coordinator exploded mid-stream');
      },
    };
    await withServer({ askCoordinator }, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const events = parseSse(await res.text());
      assert.equal(events[0].event, 'sources');
      const last = events[events.length - 1];
      assert.equal(last.event, 'error');
      assert.equal(last.data.apiVersion, API_VERSION);
      assert.equal(last.data.code, 'internal_error');
      assert.equal(events.some(e => e.event === 'done'), false);
    });
  });
});

describe('POST /api/v1/ask — busy (concurrent request)', () => {
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
      const secondBody = await second.json();
      assert.equal(secondBody.error.code, 'busy');
      assert.equal(secondBody.error.apiVersion, API_VERSION);
      assert.equal(secondBody.error.retryable, true);

      releaseGenerate();
      const first = await firstPromise;
      assert.equal(first.status, 200);
      const events = parseSse(await first.text());
      assert.equal(events.some(e => e.event === 'done'), true);
    });
  });
});

describe('POST /api/v1/ask — client abort and coordinator lock release', () => {
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
      // post()'s helper shape doesn't accept a signal, so this test drives
      // fetch() directly to pass one through.
      const reqPromise = fetch(base + ASK_PATH, {
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

describe('POST /api/v1/ask — error message redaction', () => {
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

describe('POST /api/v1/ask — structural entity references end to end', () => {
  it('a table hit produces a citable [node: path] the model can reference, validated in done.entityRefs', async () => {
    const tableHit = {
      sourceFile: 'docs/en/config.md', chunkIndex: 2, section: 'Config',
      text: '| a | b |\n|---|---|\n| 1 | 2 |',
      nodeType: 'table', nodeId: 'table-node-1', nodePath: 'docs/en/config.md#config-table',
      score: 0.05,
    };
    const adapter = makeStubAdapter({
      searchHybridVectors: async () => [tableHit],
      // No section structure available -> evidence.js falls back to the
      // hit's own text, but nodeId/nodePath/nodeType must survive untouched.
      getContentNode: async () => null,
      getSkeletonNode: async () => null,
    });
    const provider = makeStubProvider({
      generate: async ({ prompt, onToken }) => {
        // Confirm the USER prompt (evidence/question half — the systemPrompt
        // half carries only the generic [node: <node_path>] instruction
        // template, never a real path) actually told the model the real
        // node path, per the structural-node-reference fix — the model can
        // only cite what it was shown.
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
      // strippedMarkers is internal/debug and must not appear at all (see
      // the "no internal/debug fields" describe block above) — not merely
      // empty.
      assert.equal('strippedMarkers' in done, false);
    });
  });
});

describe('POST /api/v1/ask — whitespace-wrapped refusal never leaks over the wire', () => {
  it('a sentinel wrapped in leading/trailing whitespace, streamed char-by-char, produces zero answer_delta events', async () => {
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
      assert.equal(events.filter(e => e.event === 'answer_delta').length, 0);
      const done = events.find(e => e.event === 'done').data;
      assert.equal(done.refused, true);
    });
  });
});

describe('POST /api/ask (unversioned, pre-v1 seed) is gone', () => {
  it('POST /api/ask returns 404 — no compatibility alias was kept', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' }, { path: '/api/ask' });
      assert.equal(res.status, 404);
    });
  });
});

describe('POST /api/v1/ask is the only Ask route', () => {
  it('GET /api/v1/ask (wrong method) 404s — nothing else responds under this path', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(base + ASK_PATH);
      assert.equal(res.status, 404);
    });
  });

  it('a plausible near-miss path (/api/ask/v1) is not a registered route', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' }, { path: '/api/ask/v1' });
      assert.equal(res.status, 404);
    });
  });

  // The former "/api/v2/ask is not a registered route" near-miss test was
  // removed here: /api/v2/ask now genuinely exists (src/core/ask-api/v2/*)
  // — this file's own withServer() harness happens to never register it
  // (it always passes a v1-only `askCoordinator` override, which per
  // register-neutral-routes.js's DI contract intentionally skips v2
  // registration), so asserting a 404 here would test an incidental
  // consequence of THIS test file's own harness shape, not "v2 doesn't
  // exist." Real v2 route coverage lives in tests/unit/admin/ask-v2.test.js.

  it('only ASK_PATH ("/api/v1/ask") actually succeeds', async () => {
    await withServer({}, async (base) => {
      const res = await post(base, { collection: 'demo', question: 'q' }, { path: ASK_PATH });
      assert.equal(res.status, 200);
      assert.equal(ASK_PATH, '/api/v1/ask');
    });
  });
});
