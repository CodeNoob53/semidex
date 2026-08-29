import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

const API_KEY = `sdx_v1_${'k'.repeat(16)}_${'a'.repeat(43)}`;
const observations = [];

const upstream = createServer((_req, res) => {
  const observation = observations.shift();
  assert.ok(observation, 'every upstream request must belong to an active test');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: sources\ndata: {"apiVersion":"v2","searchMode":"hybrid","sources":[]}\n\n');
  observation.started();
  res.once('close', () => {
    if (!res.writableEnded) observation.closedEarly();
  });
});

upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamPort = upstream.address().port;

process.env.SEMIDEX_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
process.env.SEMIDEX_TOKEN = API_KEY;
process.env.SEMIDEX_DOCS_COLLECTION = 'test-docs';
process.env.SEMIDEX_SUPPORT_COLLECTION = 'test-docs';

const [{ requestHandler: jsonHandler }, { requestHandler: streamingHandler }] = await Promise.all([
  import('../../../../packages/lite/examples/backend-chat-server.mjs'),
  import('../../../../packages/lite/examples/backend-integration-server.mjs'),
]);

after(async () => {
  upstream.close();
  await once(upstream, 'close');
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function observeNextUpstreamRequest() {
  const started = deferred();
  const closedEarly = deferred();
  observations.push({ started: started.resolve, closedEarly: closedEarly.resolve });
  return { started: started.promise, closedEarly: closedEarly.promise };
}

async function withBackend(handler, fn) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function within(promise, label, timeoutMs = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function proveDisconnectAbortsUpstream(handler, path, body) {
  await withBackend(handler, async (baseUrl) => {
    const observation = observeNextUpstreamRequest();
    const controller = new AbortController();
    const downstream = fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    await within(observation.started, 'the upstream Ask request to start');
    controller.abort();
    await downstream.catch(() => {});
    await within(observation.closedEarly, 'the upstream response to close early');
  });
}

describe('backend examples — downstream disconnect cancellation', () => {
  it('the askText JSON backend aborts its upstream Ask request', async () => {
    await proveDisconnectAbortsUpstream(jsonHandler, '/chat', {
      assistantId: 'support',
      question: 'Keep this request open.',
    });
  });

  it('the streaming backend aborts its upstream Ask request', async () => {
    await proveDisconnectAbortsUpstream(streamingHandler, '/api/chat', {
      assistantId: 'docs',
      question: 'Keep this request open.',
    });
  });
});
