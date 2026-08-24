// createSemidexClient() against a REAL local fake HTTP server (node:http) —
// not a mocked fetch. Covers request shapes (Search/Ask), auth header,
// typed failures, fragmented SSE over an actual socket, abort/timeout, and
// the immutability/ownership contract on returned values.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSemidexClient, SemidexApiError } from '../../../../packages/lite/lite-src/client/index.js';

const API_KEY = 'sdx_v1_' + 'k'.repeat(16) + '_' + 'a'.repeat(43);

/**
 * @param {(req, res, body) => void|Promise<void>} handler — body is the
 *   parsed JSON request body (or {} for an empty body).
 */
async function withFakeServer(handler, fn) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = {};
      if (chunks.length > 0) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { body = null; }
      }
      try {
        await handler(req, res, body);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err?.stack ?? err));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonRes(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function startSse(res, extraHeaders = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...extraHeaders });
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Search ────────────────────────────────────────────────────────────────

describe('search() — request shape', () => {
  it('sends the Authorization/Content-Type/Accept headers and a well-formed JSON body', async () => {
    let captured = null;
    await withFakeServer((req, res, body) => {
      captured = { url: req.url, method: req.method, headers: req.headers, body };
      jsonRes(res, 200, { apiVersion: 'v1', collection: body.collection, query: body.query, searchMode: 'hybrid', top: 3, window: 0, windowFormat: null, results: [] });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await client.search({ collection: 'docs', query: 'auth' });
      assert.equal(captured.method, 'POST');
      assert.equal(captured.url, '/api/v1/search');
      assert.equal(captured.headers.authorization, `Bearer ${API_KEY}`);
      assert.equal(captured.headers['content-type'], 'application/json');
      assert.equal(captured.headers.accept, 'application/json');
      assert.deepEqual(captured.body, { collection: 'docs', query: 'auth' });
    });
  });

  it('omits optional fields entirely when not provided, includes them when provided', async () => {
    let captured = null;
    await withFakeServer((req, res, body) => {
      captured = body;
      jsonRes(res, 200, { apiVersion: 'v1', collection: 'docs', query: 'q', searchMode: 'hybrid', top: 5, window: 1, windowFormat: 'full', results: [] });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await client.search({ collection: 'docs', query: 'q', top: 5, window: 1, windowFormat: 'full', sourceFile: 'a.md', tags: ['x'] });
      assert.deepEqual(captured, { collection: 'docs', query: 'q', top: 5, window: 1, windowFormat: 'full', sourceFile: 'a.md', tags: ['x'] });
    });
  });

  it('resolves with the parsed response body on 200', async () => {
    await withFakeServer((req, res) => {
      jsonRes(res, 200, { apiVersion: 'v1', collection: 'docs', query: 'q', searchMode: 'hybrid', top: 3, window: 0, windowFormat: null, results: [{ sourceFile: 'a.md', chunkIndex: 0, isMatch: true }] });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const result = await client.search({ collection: 'docs', query: 'q' });
      assert.equal(result.apiVersion, 'v1');
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].sourceFile, 'a.md');
    });
  });

  it('the returned response is deeply frozen — mutation throws, and a second call returns a fresh, independent object', async () => {
    await withFakeServer((req, res) => {
      jsonRes(res, 200, { apiVersion: 'v1', collection: 'docs', query: 'q', searchMode: 'hybrid', top: 3, window: 0, windowFormat: null, results: [{ sourceFile: 'a.md', chunkIndex: 0, isMatch: true }] });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const first = await client.search({ collection: 'docs', query: 'q' });
      assert.throws(() => { first.collection = 'other'; }, TypeError);
      assert.throws(() => { first.results.push({}); }, TypeError);
      assert.throws(() => { first.results[0].sourceFile = 'x'; }, TypeError);
      const second = await client.search({ collection: 'docs', query: 'q' });
      assert.notEqual(first, second);
      assert.notEqual(first.results, second.results);
    });
  });
});

describe('search() — typed failures', () => {
  it('a 400 response becomes a SemidexApiError with status/code/message/retryable', async () => {
    await withFakeServer((req, res) => {
      jsonRes(res, 400, { error: { apiVersion: 'v1', code: 'bad_request', message: 'Body field "collection" is required', retryable: false } });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => {
          assert.ok(err instanceof SemidexApiError);
          assert.equal(err.status, 400);
          assert.equal(err.code, 'bad_request');
          assert.equal(err.retryable, false);
          assert.match(err.message, /required/);
          return true;
        },
      );
    });
  });

  it('a 429 with a Retry-After header surfaces retryAfterSeconds', async () => {
    await withFakeServer((req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' });
      res.end(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }));
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => { assert.equal(err.status, 429); assert.equal(err.retryAfterSeconds, 7); return true; },
      );
    });
  });

  it('a 401 never leaks the apiKey into the thrown error', async () => {
    await withFakeServer((req, res) => {
      jsonRes(res, 401, { error: { code: 'unauthorized', message: 'A valid Integration API bearer token is required.' } });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => {
          const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.ok(!serialized.includes(API_KEY));
          return true;
        },
      );
    });
  });

  it('a malformed (non-JSON) error body still produces a usable typed error', async () => {
    await withFakeServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('internal server explosion, not json');
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => { assert.ok(err instanceof SemidexApiError); assert.equal(err.status, 500); return true; },
      );
    });
  });
});

describe('search()/askV1() — redirect fail-closed policy', () => {
  // A 302 (or any 3xx) from the configured origin is a fail-closed case, not
  // a fail-open one: this proves the fetch-level `redirect: 'error'` policy
  // actually rejects rather than silently following, over a REAL redirect
  // response from a real local HTTP server — a comment-only claim ("requests
  // can never leave the configured origin") is not the same as an enforced
  // one, which is exactly what these tests exist to close the gap on.

  it('search(): a 302 pointing at a second origin is rejected before ever being followed — the second origin never receives a request', async () => {
    let secondaryHit = null;
    let primaryCaptured = null;
    await withFakeServer((req, res) => {
      secondaryHit = { headers: req.headers, url: req.url };
      jsonRes(res, 200, { apiVersion: 'v1', collection: 'docs', query: 'q', searchMode: 'hybrid', top: 3, window: 0, windowFormat: null, results: [] });
    }, async (secondaryBase) => {
      await withFakeServer((req, res) => {
        primaryCaptured = { headers: req.headers, url: req.url };
        res.writeHead(302, { Location: `${secondaryBase}/api/v1/search` });
        res.end();
      }, async (base) => {
        const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
        await assert.rejects(
          () => client.search({ collection: 'docs', query: 'q' }),
          (err) => {
            assert.ok(err instanceof SemidexApiError);
            assert.equal(err.retryable, true);
            return true;
          },
        );
        assert.ok(primaryCaptured, 'the configured origin itself must still receive the original request');
        assert.equal(primaryCaptured.headers.authorization, `Bearer ${API_KEY}`);
        assert.equal(secondaryHit, null, 'a redirected-to endpoint must NEVER receive a request — no Authorization, no body, nothing');
      });
    });
  });

  it('search(): a same-origin redirect (different path) is also rejected, not silently followed', async () => {
    let requestCount = 0;
    await withFakeServer((req, res) => {
      requestCount += 1;
      if (req.url === '/api/v1/search') {
        res.writeHead(302, { Location: '/elsewhere' });
        res.end();
        return;
      }
      jsonRes(res, 200, { apiVersion: 'v1', collection: 'docs', query: 'q', searchMode: 'hybrid', top: 3, window: 0, windowFormat: null, results: [] });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => { assert.ok(err instanceof SemidexApiError); assert.equal(err.retryable, true); return true; },
      );
      assert.equal(requestCount, 1, 'the redirect target must never be requested, even on the same origin');
    });
  });

  it('askV1(): a 302 pointing at a second origin is rejected before ever being followed — the second origin never receives a request', async () => {
    let secondaryHit = null;
    let primaryCaptured = null;
    await withFakeServer((req, res) => {
      secondaryHit = { headers: req.headers, url: req.url };
      startSse(res);
      res.end();
    }, async (secondaryBase) => {
      await withFakeServer((req, res) => {
        primaryCaptured = { headers: req.headers, url: req.url };
        res.writeHead(302, { Location: `${secondaryBase}/api/v1/ask` });
        res.end();
      }, async (base) => {
        const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
        await assert.rejects(
          (async () => { for await (const _event of client.askV1({ collection: 'docs', question: 'q' })) { /* noop */ } })(),
          (err) => {
            assert.ok(err instanceof SemidexApiError);
            assert.equal(err.retryable, true);
            return true;
          },
        );
        assert.ok(primaryCaptured, 'the configured origin itself must still receive the original request');
        assert.equal(primaryCaptured.headers.authorization, `Bearer ${API_KEY}`);
        assert.equal(secondaryHit, null, 'a redirected-to endpoint must NEVER receive a request — no Authorization, no body, nothing');
      });
    });
  });
});

describe('search() — abort and timeout', () => {
  it('a caller AbortSignal aborts the in-flight request with a typed, retryable error', async () => {
    await withFakeServer(async (req, res) => {
      await new Promise((r) => setTimeout(r, 2000)); // never actually reached — the client aborts first
      jsonRes(res, 200, {});
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const controller = new AbortController();
      const promise = client.search({ collection: 'docs', query: 'q', signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(promise, (err) => {
        assert.ok(err instanceof SemidexApiError);
        assert.equal(err.code, 'client_timeout_or_abort');
        assert.equal(err.retryable, true);
        return true;
      });
    });
  });

  it('a short timeoutMs aborts the request on its own', async () => {
    await withFakeServer(async (req, res) => {
      await new Promise((r) => setTimeout(r, 2000));
      jsonRes(res, 200, {});
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, timeoutMs: 30 });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => { assert.equal(err.code, 'client_timeout_or_abort'); return true; },
      );
    });
  });

  it('the internal timeout timer does not leak/fire after a request completes normally (no unhandled abort after success)', async () => {
    await withFakeServer((req, res) => {
      jsonRes(res, 200, { apiVersion: 'v1', collection: 'docs', query: 'q', searchMode: 'hybrid', top: 3, window: 0, windowFormat: null, results: [] });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, timeoutMs: 50 });
      await client.search({ collection: 'docs', query: 'q' });
      // If the timer leaked, it would fire ~50ms later — nothing observes
      // that directly, but waiting past it and completing cleanly (no
      // process warning, no dangling handle keeping this test alive) is
      // the practical proof; combined with the explicit clearTimeout in
      // index.js's `finally`, this documents the expectation.
      await new Promise((r) => setTimeout(r, 80));
    });
  });
});

// ── Ask v1/v2 (SSE) ──────────────────────────────────────────────────────────

describe('askV1() — request shape and event stream', () => {
  it('sends Accept: text/event-stream and the documented body shape', async () => {
    let captured = null;
    await withFakeServer((req, res, body) => {
      captured = { url: req.url, headers: req.headers, body };
      startSse(res);
      writeSseEvent(res, 'sources', { apiVersion: 'v1', searchMode: 'hybrid', sources: [] });
      writeSseEvent(res, 'done', { apiVersion: 'v1', answer: 'hi', citations: [], entityRefs: [], refused: false, refusalReason: null, evidenceCount: 0 });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      for await (const event of client.askV1({ collection: 'docs', question: 'how does auth work?' })) events.push(event);
      assert.equal(captured.url, '/api/v1/ask');
      assert.equal(captured.headers.accept, 'text/event-stream');
      assert.equal(captured.headers.authorization, `Bearer ${API_KEY}`);
      assert.deepEqual(captured.body, { collection: 'docs', question: 'how does auth work?' });
      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'sources');
      assert.equal(events[1].type, 'done');
      assert.equal(events[1].answer, 'hi');
    });
  });

  it('includes scope.sourceFile when provided', async () => {
    let captured = null;
    await withFakeServer((req, res, body) => {
      captured = body;
      startSse(res);
      writeSseEvent(res, 'done', { answer: '', citations: [], entityRefs: [], refused: true, evidenceCount: 0 });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      for await (const event of client.askV1({ collection: 'docs', question: 'q', scope: { sourceFile: 'readme.md' } })) events.push(event);
      assert.deepEqual(captured, { collection: 'docs', question: 'q', scope: { sourceFile: 'readme.md' } });
    });
  });

  it('reassembles a fragmented SSE stream delivered in small delayed writes over a real socket', async () => {
    await withFakeServer(async (req, res) => {
      startSse(res);
      const frame = 'event: sources\ndata: {"apiVersion":"v1","searchMode":"hybrid","sources":[]}\n\n'
        + 'event: answer_delta\ndata: {"text":"Hello "}\n\n'
        + 'event: answer_delta\ndata: {"text":"world"}\n\n'
        + 'event: done\ndata: {"answer":"Hello world","citations":[],"entityRefs":[],"refused":false,"evidenceCount":1}\n\n';
      // Write in small, arbitrarily-boundaried pieces (mid-line, mid-frame)
      // with real event-loop turns between them, to force genuine TCP-level
      // fragmentation across multiple `data` events on the client's own
      // response.body reader — not just a single synchronous write.
      for (let i = 0; i < frame.length; i += 7) {
        res.write(frame.slice(i, i + 7));
        await new Promise((r) => setImmediate(r));
      }
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      for await (const event of client.askV1({ collection: 'docs', question: 'q' })) events.push(event);
      assert.equal(events.length, 4);
      assert.equal(events[0].type, 'sources');
      assert.equal(events[1].type, 'answer_delta');
      assert.equal(events[1].text, 'Hello ');
      assert.equal(events[2].text, 'world');
      assert.equal(events[3].type, 'done');
      assert.equal(events[3].answer, 'Hello world');
    });
  });

  it('a terminal SSE `error` event throws a typed error and does NOT also yield a done/success event', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      writeSseEvent(res, 'sources', { apiVersion: 'v1', searchMode: null, sources: [] });
      writeSseEvent(res, 'error', { apiVersion: 'v1', code: 'generation_failed', message: 'provider exploded', retryable: true });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      await assert.rejects(
        (async () => {
          for await (const event of client.askV1({ collection: 'docs', question: 'q' })) events.push(event);
        })(),
        (err) => {
          assert.ok(err instanceof SemidexApiError);
          assert.equal(err.code, 'generation_failed');
          assert.equal(err.retryable, true);
          assert.match(err.message, /provider exploded/);
          return true;
        },
      );
      assert.deepEqual(events.map((e) => e.type), ['sources'], 'only the pre-error events were yielded — no done/success event follows the error');
    });
  });

  it('a pre-stream JSON error (e.g. 404 collection not found) throws before yielding any event', async () => {
    await withFakeServer((req, res) => {
      jsonRes(res, 404, { error: { apiVersion: 'v1', code: 'not_found', message: 'Collection "docs" not found', retryable: false } });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      await assert.rejects(
        (async () => { for await (const event of client.askV1({ collection: 'docs', question: 'q' })) events.push(event); })(),
        (err) => { assert.equal(err.status, 404); assert.equal(err.code, 'not_found'); return true; },
      );
      assert.deepEqual(events, []);
    });
  });

  it('a malformed SSE data payload throws a clear, typed client_parse_error', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      res.write('event: done\ndata: {not valid json\n\n');
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        (async () => { for await (const _event of client.askV1({ collection: 'docs', question: 'q' })) { /* noop */ } })(),
        (err) => { assert.ok(err instanceof SemidexApiError); assert.equal(err.code, 'client_parse_error'); return true; },
      );
    });
  });

  it('an unknown future event type/field is yielded through, not dropped or rejected', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      writeSseEvent(res, 'progress', { apiVersion: 'v1', percent: 42, futureField: 'x' });
      writeSseEvent(res, 'done', { answer: 'ok', citations: [], entityRefs: [], refused: false, evidenceCount: 1, aBrandNewField: true });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      for await (const event of client.askV1({ collection: 'docs', question: 'q' })) events.push(event);
      assert.equal(events[0].type, 'progress');
      assert.equal(events[0].percent, 42);
      assert.equal(events[0].futureField, 'x');
      assert.equal(events[1].aBrandNewField, true);
    });
  });

  it('CRLF-terminated SSE lines are parsed identically to LF over a real socket', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      res.write('event: sources\r\ndata: {"apiVersion":"v1","searchMode":null,"sources":[]}\r\n\r\n');
      res.write('event: done\r\ndata: {"answer":"ok","citations":[],"entityRefs":[],"refused":false,"evidenceCount":0}\r\n\r\n');
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      for await (const event of client.askV1({ collection: 'docs', question: 'q' })) events.push(event);
      assert.equal(events.length, 2);
      assert.equal(events[1].answer, 'ok');
    });
  });

  it('caller abort mid-stream throws a typed, retryable error after any already-yielded events', async () => {
    let serverSawClose = false;
    await withFakeServer(async (req, res) => {
      startSse(res);
      writeSseEvent(res, 'sources', { apiVersion: 'v1', searchMode: null, sources: [] });
      // Keep the stream open indefinitely — the client must abort rather
      // than hang forever waiting for a `done` that never comes.
      req.on('close', () => { serverSawClose = true; });
      await new Promise(() => {}); // never resolves
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const controller = new AbortController();
      const events = [];
      const iterate = (async () => {
        for await (const event of client.askV1({ collection: 'docs', question: 'q', signal: controller.signal })) events.push(event);
      })();
      await new Promise((r) => setTimeout(r, 30));
      controller.abort();
      await assert.rejects(iterate, (err) => {
        assert.ok(err instanceof SemidexApiError);
        assert.equal(err.code, 'client_timeout_or_abort');
        assert.equal(err.retryable, true);
        return true;
      });
      assert.deepEqual(events.map((e) => e.type), ['sources'], 'events yielded before the abort are preserved');
      // Give the server's own 'close' listener a tick to fire.
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(serverSawClose, true, 'aborting the client signal must actually tear down the underlying connection');
    });
  });
});

describe('askV2() — request shape and conversation mapping', () => {
  it('maps conversationId -> wire "id", and omits conversation entirely on a first turn', async () => {
    let captured = null;
    await withFakeServer((req, res, body) => {
      captured = { url: req.url, body };
      startSse(res);
      writeSseEvent(res, 'done', { answer: 'ok', citations: [], entityRefs: [], refused: false, evidenceCount: 1 });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      for await (const event of client.askV2({ collection: 'docs', question: 'first turn' })) events.push(event);
      assert.equal(captured.url, '/api/v2/ask');
      assert.deepEqual(captured.body, { collection: 'docs', question: 'first turn' });
    });
  });

  it('sends conversation.id/summary/recentMessages on a follow-up turn', async () => {
    let captured = null;
    await withFakeServer((req, res, body) => {
      captured = body;
      startSse(res);
      writeSseEvent(res, 'done', {
        answer: 'ok', citations: [], entityRefs: [], refused: false, evidenceCount: 1,
        conversation: { id: 'conv-1', summaryChanged: true, updatedSummary: 'new summary', compactedMessageCount: 2 },
      });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      for await (const event of client.askV2({
        collection: 'docs', question: 'follow up',
        conversation: { conversationId: 'conv-1', summary: 'prior summary', recentMessages: [{ role: 'user', content: 'hi' }] },
      })) events.push(event);
      assert.deepEqual(captured.conversation, { id: 'conv-1', summary: 'prior summary', recentMessages: [{ role: 'user', content: 'hi' }] });
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.conversation.id, 'conv-1');
      assert.equal(done.conversation.summaryChanged, true);
      assert.equal(done.conversation.updatedSummary, 'new summary');
    });
  });
});
