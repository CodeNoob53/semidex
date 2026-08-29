// createSemidexClient({ fetch }) — dependency injection for the HTTP call.
//
// THE CENTRAL PROOF in this file: several suites below DELETE
// `globalThis.fetch` entirely for the duration of a call. That is the only
// assertion that actually proves the injected function is used — a spy that
// merely counts its own calls cannot distinguish "the client called my
// function" from "the client called my function AND also fell back to the
// global one", and it cannot catch a future refactor that reintroduces a
// bare `fetch(...)` on some error path. With no global to fall back to, any
// such path throws a ReferenceError/TypeError instead of silently working.
//
// The second thing proven here: injection changes only WHO performs the
// request. Every option the client wraps around the call — `redirect:
// 'error'`, the composed AbortSignal, the auth header, the JSON body — is
// still handed to the injected function unchanged, and timeout/abort still
// behave identically.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSemidexClient, SemidexApiError } from '../../../../packages/lite/lite-src/client/index.js';

const API_KEY = 'sdx_v1_' + 'k'.repeat(16) + '_' + 'a'.repeat(43);
const BASE = 'http://127.0.0.1:9';   // never actually connected to by the injected-fetch suites

/**
 * Runs `fn` with `globalThis.fetch` REMOVED, restoring it afterwards. Any
 * use of the global fetch inside `fn` therefore throws rather than working.
 */
async function withoutGlobalFetch(fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  delete globalThis.fetch;
  assert.equal(typeof globalThis.fetch, 'undefined', 'sanity: the global must actually be gone');
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
  }
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function sseResponse(text, { status = 200, headers = {} } = {}) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', ...headers },
  });
}

const SEARCH_BODY = {
  apiVersion: 'v1', collection: 'docs', query: 'q', searchMode: 'hybrid',
  top: 3, window: 0, windowFormat: null, results: [],
};

const ASK_STREAM = 'event: sources\ndata: {"sources":[]}\n\n'
  + 'event: answer_delta\ndata: {"text":"hi"}\n\n'
  + 'event: done\ndata: {"answer":"hi","citations":[]}\n\n';

async function drain(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

// ── Validation ──────────────────────────────────────────────────────────────

describe('createSemidexClient({ fetch }) — validation', () => {
  const VALID = { baseUrl: BASE, apiKey: API_KEY };

  it('accepts any callable', () => {
    for (const fn of [() => {}, async () => {}, function named() {}, Object.assign(() => {}, { extra: 1 })]) {
      assert.doesNotThrow(() => createSemidexClient({ ...VALID, fetch: fn }));
    }
  });

  it('rejects a non-callable synchronously with TypeError — never a rejected Promise', () => {
    for (const bad of [null, 0, 42, '', 'fetch', {}, [], true, Symbol('x')]) {
      assert.throws(
        () => createSemidexClient({ ...VALID, fetch: bad }),
        TypeError,
        `fetch: ${String(bad)} must be rejected`,
      );
    }
  });

  it('rejects null explicitly rather than silently falling back to the global', () => {
    // `null` is a bug (an unresolved config value), not a request for the
    // default — only `undefined`/absence means "use the platform fetch".
    assert.throws(() => createSemidexClient({ ...VALID, fetch: null }), TypeError);
  });

  it('omitting fetch entirely uses the platform default', () => {
    assert.doesNotThrow(() => createSemidexClient(VALID));
    assert.doesNotThrow(() => createSemidexClient({ ...VALID, fetch: undefined }));
  });

  it('throws a clear TypeError when no fetch is injected AND the runtime has none', async () => {
    await withoutGlobalFetch(() => {
      assert.throws(
        () => createSemidexClient(VALID),
        (err) => {
          assert.ok(err instanceof TypeError);
          assert.match(err.message, /createSemidexClient\(\{ fetch \}\)/);
          return true;
        },
      );
    });
  });

  it('a client constructed with an injected fetch needs no global fetch at all', async () => {
    await withoutGlobalFetch(() => {
      assert.doesNotThrow(() => createSemidexClient({ ...VALID, fetch: async () => jsonResponse(SEARCH_BODY) }));
    });
  });
});

// ── The global is never used ────────────────────────────────────────────────

describe('injected fetch — the global is never used', () => {
  it('search() works with the global deleted', async () => {
    await withoutGlobalFetch(async () => {
      let calls = 0;
      const client = createSemidexClient({
        baseUrl: BASE, apiKey: API_KEY,
        fetch: async () => { calls += 1; return jsonResponse(SEARCH_BODY); },
      });
      const result = await client.search({ collection: 'docs', query: 'q' });
      assert.equal(calls, 1);
      assert.equal(result.apiVersion, 'v1');
    });
  });

  it('askV1() works with the global deleted', async () => {
    await withoutGlobalFetch(async () => {
      let calls = 0;
      const client = createSemidexClient({
        baseUrl: BASE, apiKey: API_KEY,
        fetch: async () => { calls += 1; return sseResponse(ASK_STREAM); },
      });
      const events = await drain(client.askV1({ collection: 'docs', question: 'q' }));
      assert.equal(calls, 1);
      assert.deepEqual(events.map((e) => e.type), ['sources', 'answer_delta', 'done']);
    });
  });

  it('askV2() works with the global deleted', async () => {
    await withoutGlobalFetch(async () => {
      const client = createSemidexClient({
        baseUrl: BASE, apiKey: API_KEY,
        fetch: async () => sseResponse(ASK_STREAM),
      });
      const events = await drain(client.askV2({ collection: 'docs', question: 'q' }));
      assert.equal(events.at(-1).answer, 'hi');
    });
  });

  it('askText() works with the global deleted', async () => {
    await withoutGlobalFetch(async () => {
      const client = createSemidexClient({
        baseUrl: BASE, apiKey: API_KEY,
        fetch: async () => sseResponse(ASK_STREAM),
      });
      const result = await client.askText({ collection: 'docs', question: 'q' });
      assert.equal(result.answer, 'hi');
    });
  });

  it('the ERROR paths also work with the global deleted (no bare fetch on a failure branch)', async () => {
    await withoutGlobalFetch(async () => {
      const client = createSemidexClient({
        baseUrl: BASE, apiKey: API_KEY,
        fetch: async () => jsonResponse({ error: { code: 'forbidden', message: 'no' } }, { status: 403 }),
      });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => { assert.ok(err instanceof SemidexApiError); assert.equal(err.status, 403); return true; },
      );
      await assert.rejects(drain(client.askV1({ collection: 'docs', question: 'q' })));
    });
  });

  it('the RETRY path also works with the global deleted', async () => {
    await withoutGlobalFetch(async () => {
      let calls = 0;
      const client = createSemidexClient({
        baseUrl: BASE, apiKey: API_KEY,
        retry: { attempts: 3, initialDelayMs: 1, maxDelayMs: 10, jitter: false },
        fetch: async () => {
          calls += 1;
          if (calls < 3) return jsonResponse({ error: { code: 'unavailable', message: 'down' } }, { status: 503 });
          return jsonResponse(SEARCH_BODY);
        },
      });
      const result = await client.search({ collection: 'docs', query: 'q' });
      assert.equal(calls, 3, 'every retry attempt goes through the injected fetch');
      assert.equal(result.retries, 2);
    });
  });

  it('a client keeps its injected fetch even if globalThis.fetch is later replaced', async () => {
    let injectedCalls = 0;
    let globalCalls = 0;
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY,
      fetch: async () => { injectedCalls += 1; return jsonResponse(SEARCH_BODY); },
    });
    try {
      globalThis.fetch = async () => { globalCalls += 1; return jsonResponse(SEARCH_BODY); };
      await client.search({ collection: 'docs', query: 'q' });
      assert.equal(injectedCalls, 1);
      assert.equal(globalCalls, 0, 'a hijacked global must never receive the request');
    } finally {
      if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    }
  });

  it('a DEFAULT client captures the global at construction, immune to later reassignment', async () => {
    let hijackCalls = 0;
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    // Construct while a legitimate global is in place.
    const client = createSemidexClient({ baseUrl: BASE, apiKey: API_KEY });
    try {
      globalThis.fetch = async () => { hijackCalls += 1; return jsonResponse(SEARCH_BODY); };
      // The real global will fail to connect to port 9 — that is fine; what
      // matters is that the HIJACK never ran.
      await client.search({ collection: 'docs', query: 'q', timeoutMs: 300 }).catch(() => {});
      assert.equal(hijackCalls, 0, 'the reassigned global must not be picked up by an existing client');
    } finally {
      if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    }
  });
});

// ── The client's own options are preserved ──────────────────────────────────

describe('injected fetch — receives the same request the default path would send', () => {
  it('search(): url, method, headers, body and redirect are all handed through', async () => {
    let captured = null;
    const client = createSemidexClient({
      baseUrl: 'http://example.test/prefix', apiKey: API_KEY,
      fetch: async (url, init) => { captured = { url, init }; return jsonResponse(SEARCH_BODY); },
    });
    await client.search({ collection: 'docs', query: 'auth', top: 5 });

    assert.equal(captured.url, 'http://example.test/prefix/api/v1/search');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(captured.init.headers['Content-Type'], 'application/json');
    assert.equal(captured.init.headers.Accept, 'application/json');
    assert.deepEqual(JSON.parse(captured.init.body), { collection: 'docs', query: 'auth', top: 5 });
    assert.equal(captured.init.redirect, 'error', 'redirect protection must never be dropped for a custom fetch');
    assert.ok(captured.init.signal instanceof AbortSignal);
  });

  it('askV1()/askV2(): SSE Accept header, correct paths, and redirect protection', async () => {
    const seen = [];
    const client = createSemidexClient({
      baseUrl: 'http://example.test', apiKey: API_KEY,
      fetch: async (url, init) => { seen.push({ url, init }); return sseResponse(ASK_STREAM); },
    });
    await drain(client.askV1({ collection: 'docs', question: 'q' }));
    await drain(client.askV2({ collection: 'docs', question: 'q', conversation: { conversationId: 'c1' } }));

    assert.equal(seen[0].url, 'http://example.test/api/v1/ask');
    assert.equal(seen[1].url, 'http://example.test/api/v2/ask');
    for (const { init } of seen) {
      assert.equal(init.headers.Accept, 'text/event-stream');
      assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
      assert.equal(init.redirect, 'error', 'redirect protection must never be dropped for a custom fetch');
      assert.ok(init.signal instanceof AbortSignal);
    }
    // v2 still maps conversationId -> conversation.id on the wire.
    assert.deepEqual(JSON.parse(seen[1].init.body).conversation, { id: 'c1' });
  });

  it('the injected function is called with no meaningful `this` rebinding by the client', async () => {
    // An injected bound method must keep its own binding — the client must
    // not call it with `this` forced to globalThis.
    class Agent {
      constructor() { this.calls = 0; }
      async request() { this.calls += 1; return jsonResponse(SEARCH_BODY); }
    }
    const agent = new Agent();
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY, fetch: agent.request.bind(agent),
    });
    await client.search({ collection: 'docs', query: 'q' });
    assert.equal(agent.calls, 1, 'a bound method keeps its receiver');
  });
});

// ── Timeout / abort behavior is preserved ───────────────────────────────────

describe('injected fetch — timeout and abort still behave identically', () => {
  it('the composed signal is passed to the injected fetch and aborts it', async () => {
    let sawAbort = false;
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY,
      fetch: (url, init) => new Promise((resolve, reject) => {
        // A well-behaved fetch rejects when its signal aborts.
        init.signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }),
    });
    const controller = new AbortController();
    const promise = client.search({ collection: 'docs', query: 'q', signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof SemidexApiError);
      assert.equal(err.code, 'client_timeout_or_abort');
      return true;
    });
    assert.equal(sawAbort, true, 'the injected fetch must actually receive the abort');
  });

  it('a per-call timeoutMs aborts an injected fetch that never resolves', async () => {
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY,
      fetch: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }),
    });
    const started = Date.now();
    await assert.rejects(
      () => client.search({ collection: 'docs', query: 'q', timeoutMs: 60 }),
      (err) => { assert.equal(err.code, 'client_timeout_or_abort'); return true; },
    );
    assert.ok(Date.now() - started < 2000);
  });

  it('an already-aborted caller signal is handed to the injected fetch as an aborted signal', async () => {
    // The client composes the caller's signal into the one it passes down;
    // it does NOT pre-empt the call itself. A conforming fetch (including
    // the platform one) rejects immediately when handed an already-aborted
    // signal, which is what produces the typed error on the default path —
    // so what this test pins is that the injected function really does
    // receive an already-aborted signal to act on.
    let seenSignalAborted = null;
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY,
      fetch: async (url, init) => {
        seenSignalAborted = init.signal.aborted;
        // Model a conforming fetch.
        if (init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return jsonResponse(SEARCH_BODY);
      },
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => client.search({ collection: 'docs', query: 'q', signal: controller.signal }),
      (err) => { assert.equal(err.code, 'client_timeout_or_abort'); return true; },
    );
    assert.equal(seenSignalAborted, true, 'the injected fetch must receive an already-aborted signal');
  });

  it('a timeout mid-Ask-stream aborts the signal the injected fetch was given', async () => {
    // NOTE on the fixture: a hand-rolled ReadableStream does not observe the
    // request signal the way a real network body does, so the pump ends
    // cleanly rather than throwing when the timeout fires. That is a
    // property of the stub, not of the client — the default path over a
    // real socket rejects with `client_timeout_or_abort` (proved by
    // http.test.js). What is asserted here is the part injection is
    // actually responsible for: the signal handed to the injected fetch is
    // genuinely aborted when the deadline passes, and iteration stops
    // rather than hanging.
    let signalFromFetch = null;
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY,
      fetch: async (url, init) => {
        signalFromFetch = init.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: answer_delta\ndata: {"text":"partial"}\n\n'));
              // never closes
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
    });

    const started = Date.now();
    const events = await drain(client.askV1({ collection: 'docs', question: 'q', timeoutMs: 80 }));
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 2000, `iteration must stop at the deadline, not hang (took ${elapsed}ms)`);
    assert.deepEqual(events.map((e) => e.type), ['answer_delta'], 'the delta that did arrive is still delivered');
    assert.equal(signalFromFetch.aborted, true, 'the timeout must abort the signal the injected fetch received');
  });

  it('an injected fetch that rejects on abort produces the typed error, exactly like the default path', async () => {
    // The counterpart to the test above, with a fetch that behaves like a
    // real one: rejecting the body read on abort yields the same
    // `client_timeout_or_abort` the default path produces.
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY,
      fetch: async (url, init) => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: answer_delta\ndata: {"text":"partial"}\n\n'));
            init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    });
    await assert.rejects(
      drain(client.askV1({ collection: 'docs', question: 'q', timeoutMs: 80 })),
      (err) => {
        assert.ok(err instanceof SemidexApiError);
        assert.equal(err.code, 'client_timeout_or_abort');
        return true;
      },
    );
  });
});

// ── Failure modes of the injected function itself ───────────────────────────

describe('injected fetch — its own failures are projected to SemidexApiError', () => {
  it('a rejecting injected fetch becomes a typed network error, never a raw throw', async () => {
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY,
      fetch: async () => { throw new Error('proxy tunnel refused'); },
    });
    await assert.rejects(
      () => client.search({ collection: 'docs', query: 'q' }),
      (err) => {
        assert.ok(err instanceof SemidexApiError);
        assert.equal(err.code, 'client_request_failed');
        assert.match(err.message, /proxy tunnel refused/);
        return true;
      },
    );
  });

  it('a synchronously throwing injected fetch is also projected, not leaked', async () => {
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY,
      fetch: () => { throw new Error('sync explosion'); },
    });
    await assert.rejects(
      () => client.search({ collection: 'docs', query: 'q' }),
      (err) => { assert.ok(err instanceof SemidexApiError); return true; },
    );
  });

  it('a rejecting injected fetch is retried like any other transport failure', async () => {
    let calls = 0;
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY,
      retry: { attempts: 3, initialDelayMs: 1, maxDelayMs: 10, jitter: false },
      fetch: async () => {
        calls += 1;
        if (calls < 3) throw new Error('connection reset');
        return jsonResponse(SEARCH_BODY);
      },
    });
    const result = await client.search({ collection: 'docs', query: 'q' });
    assert.equal(calls, 3);
    assert.equal(result.apiVersion, 'v1');
  });

  it('an injected fetch never receives, and cannot leak, anything beyond the request it is given', async () => {
    let captured = null;
    const client = createSemidexClient({
      baseUrl: BASE, apiKey: API_KEY,
      fetch: async (url, init) => { captured = { url, init }; return jsonResponse(SEARCH_BODY); },
    });
    await client.search({ collection: 'docs', query: 'q' });
    // The Authorization header is necessarily present (it IS the request),
    // but nothing else about the client's internals is handed over.
    assert.deepEqual(Object.keys(captured.init).sort(), ['body', 'headers', 'method', 'redirect', 'signal']);
  });
});

// ── Against a real server, to prove nothing about transport changed ─────────

describe('injected fetch — a pass-through wrapper behaves exactly like the default', () => {
  it('a logging wrapper around the real fetch still yields correct results over a real socket', async () => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/api/v1/search') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(SEARCH_BODY));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(ASK_STREAM);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const log = [];
    try {
      const client = createSemidexClient({
        baseUrl: base, apiKey: API_KEY,
        fetch: async (url, init) => {
          log.push(`${init.method} ${new URL(url).pathname}`);
          return globalThis.fetch(url, init);
        },
      });
      const searched = await client.search({ collection: 'docs', query: 'q' });
      const asked = await client.askText({ collection: 'docs', question: 'q' });
      assert.equal(searched.apiVersion, 'v1');
      assert.equal(asked.answer, 'hi');
      assert.deepEqual(log, ['POST /api/v1/search', 'POST /api/v1/ask']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('redirect protection survives a pass-through wrapper — a 302 is still rejected', async () => {
    let secondaryHit = false;
    const secondary = createServer((req, res) => { secondaryHit = true; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
    await new Promise((resolve) => secondary.listen(0, '127.0.0.1', resolve));
    const secondaryBase = `http://127.0.0.1:${secondary.address().port}`;

    const primary = createServer((req, res) => {
      res.writeHead(302, { Location: `${secondaryBase}/api/v1/search` });
      res.end();
    });
    await new Promise((resolve) => primary.listen(0, '127.0.0.1', resolve));
    const primaryBase = `http://127.0.0.1:${primary.address().port}`;

    try {
      const client = createSemidexClient({
        baseUrl: primaryBase, apiKey: API_KEY,
        // A wrapper that forwards init verbatim keeps redirect: 'error'.
        fetch: (url, init) => globalThis.fetch(url, init),
      });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => { assert.ok(err instanceof SemidexApiError); return true; },
      );
      assert.equal(secondaryHit, false, 'the redirect target must never receive the credential');
    } finally {
      await new Promise((resolve) => primary.close(resolve));
      await new Promise((resolve) => secondary.close(resolve));
    }
  });
});
