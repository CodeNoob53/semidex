// askText() — the convenience wrapper that consumes an askV1()/askV2() SSE
// stream to completion and resolves with one structured result.
//
// Tested against a REAL local HTTP server (node:http), same rule as
// http.test.js/retry.test.js: never a mocked fetch, so the accumulation
// really does run over genuine chunk boundaries and a genuine stream end.
//
// The contract these tests pin: askText() is a PURE CONSUMER of the
// streaming methods — it changes what you receive, never what is sent or
// how failures are reported. Same request bodies, same SemidexApiError, same
// timeout/abort behavior.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSemidexClient, SemidexApiError } from '../../../../packages/lite/lite-src/client/index.js';

const API_KEY = 'sdx_v1_' + 'k'.repeat(16) + '_' + 'a'.repeat(43);

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

function startSse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const SOURCES = [
  { n: 1, sourceFile: 'a.md', chunkIndex: 0, section: 'Returns', snippet: 'within 30 days', truncated: false },
  { n: 2, sourceFile: 'b.md', chunkIndex: 3, section: 'Exceptions', snippet: 'final sale', truncated: false },
];

// A well-formed v1 stream: sources, several deltas, then done.
function writeV1Stream(res, { answer = 'You have 30 days [1].', citations = [1] } = {}) {
  startSse(res);
  writeSseEvent(res, 'sources', { apiVersion: 'v1', searchMode: 'hybrid', sources: SOURCES });
  writeSseEvent(res, 'answer_delta', { apiVersion: 'v1', text: 'You have ' });
  writeSseEvent(res, 'answer_delta', { apiVersion: 'v1', text: '30 days ' });
  writeSseEvent(res, 'answer_delta', { apiVersion: 'v1', text: '[1].' });
  writeSseEvent(res, 'done', {
    apiVersion: 'v1', answer, citations, entityRefs: [], refused: false, refusalReason: null,
    provider: 'gemini', model: 'gemini-2.0-flash',
    usage: { promptTokens: 100, completionTokens: 20 }, timing: { elapsedMs: 500 }, evidenceCount: 2,
  });
  res.end();
}

describe('askText() — Ask v1 success', () => {
  it('returns { answer, sources, citations, done, conversation } from a complete stream', async () => {
    await withFakeServer((req, res) => writeV1Stream(res), async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const result = await client.askText({ collection: 'docs', question: 'return window?' });

      assert.equal(result.answer, 'You have 30 days [1].');
      assert.deepEqual(result.citations, [1]);
      assert.equal(result.sources.length, 2);
      assert.equal(result.sources[0].sourceFile, 'a.md');
      assert.equal(result.done.type, 'done');
      assert.equal(result.done.provider, 'gemini');
      assert.equal(result.done.usage.completionTokens, 20);
      // Ask v1 has no conversation concept at all.
      assert.equal(result.conversation, null);
    });
  });

  it('defaults to v1 and hits /api/v1/ask with the same body askV1() would send', async () => {
    let captured = null;
    await withFakeServer((req, res, body) => {
      captured = { url: req.url, headers: req.headers, body };
      writeV1Stream(res);
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await client.askText({ collection: 'docs', question: 'q', scope: { sourceFile: 'a.md' } });
      assert.equal(captured.url, '/api/v1/ask');
      assert.equal(captured.headers.authorization, `Bearer ${API_KEY}`);
      assert.equal(captured.headers.accept, 'text/event-stream');
      assert.deepEqual(captured.body, { collection: 'docs', question: 'q', scope: { sourceFile: 'a.md' } });
    });
  });

  it('falls back to concatenated answer_delta text when `done` carries no answer field', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      writeSseEvent(res, 'answer_delta', { text: 'alpha ' });
      writeSseEvent(res, 'answer_delta', { text: 'beta' });
      writeSseEvent(res, 'done', { apiVersion: 'v1', citations: [] });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const result = await client.askText({ collection: 'docs', question: 'q' });
      assert.equal(result.answer, 'alpha beta');
    });
  });

  it('handles a stream with no sources and no deltas (a refusal) without inventing fields', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      writeSseEvent(res, 'done', {
        apiVersion: 'v1', answer: '', citations: [], refused: true, refusalReason: 'no_evidence',
      });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const result = await client.askText({ collection: 'docs', question: 'q' });
      assert.equal(result.answer, '');
      assert.deepEqual(result.sources, []);
      assert.deepEqual(result.citations, []);
      assert.equal(result.done.refused, true);
      assert.equal(result.done.refusalReason, 'no_evidence');
    });
  });

  it('reassembles correctly when SSE frames are split across arbitrary chunk boundaries', async () => {
    await withFakeServer(async (req, res) => {
      startSse(res);
      const payload = 'event: sources\ndata: {"sources":[]}\n\n'
        + 'event: answer_delta\ndata: {"text":"chun"}\n\n'
        + 'event: answer_delta\ndata: {"text":"ked"}\n\n'
        + 'event: done\ndata: {"answer":"chunked","citations":[2]}\n\n';
      // One byte at a time — the worst possible framing.
      for (const ch of payload) {
        res.write(ch);
        await new Promise((r) => setImmediate(r));
      }
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const result = await client.askText({ collection: 'docs', question: 'q' });
      assert.equal(result.answer, 'chunked');
      assert.deepEqual(result.citations, [2]);
    });
  });

  it('the returned result is deeply frozen, like every other value this client hands back', async () => {
    await withFakeServer((req, res) => writeV1Stream(res), async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const result = await client.askText({ collection: 'docs', question: 'q' });
      assert.throws(() => { result.answer = 'tampered'; }, TypeError);
      assert.throws(() => { result.sources.push({}); }, TypeError);
      assert.throws(() => { result.citations.push(9); }, TypeError);
    });
  });
});

describe('askText() — Ask v2 conversation', () => {
  it('returns the conversation data from the done event', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      writeSseEvent(res, 'sources', { apiVersion: 'v1', sources: SOURCES });
      writeSseEvent(res, 'answer_delta', { text: 'Except final sale [2].' });
      writeSseEvent(res, 'done', {
        apiVersion: 'v1', answer: 'Except final sale [2].', citations: [2],
        conversation: {
          id: 'conv-123', summaryChanged: true,
          updatedSummary: 'User asked about returns and exceptions.', compactedMessageCount: 4,
        },
      });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const result = await client.askText({
        version: 'v2', collection: 'docs', question: 'exceptions?',
        conversation: { conversationId: 'conv-123', summary: 'prior', recentMessages: [] },
      });

      assert.equal(result.answer, 'Except final sale [2].');
      assert.deepEqual(result.citations, [2]);
      assert.equal(result.conversation.id, 'conv-123');
      assert.equal(result.conversation.summaryChanged, true);
      assert.equal(result.conversation.updatedSummary, 'User asked about returns and exceptions.');
      assert.equal(result.conversation.compactedMessageCount, 4);
    });
  });

  it('sends the v2 wire shape — conversationId maps to conversation.id on /api/v2/ask', async () => {
    let captured = null;
    await withFakeServer((req, res, body) => {
      captured = { url: req.url, body };
      startSse(res);
      writeSseEvent(res, 'done', { answer: 'ok', citations: [] });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await client.askText({
        version: 'v2', collection: 'docs', question: 'q',
        conversation: { conversationId: 'c1', summary: 's', recentMessages: [{ role: 'user', content: 'hi' }] },
      });
      assert.equal(captured.url, '/api/v2/ask');
      assert.deepEqual(captured.body, {
        collection: 'docs', question: 'q',
        conversation: { id: 'c1', summary: 's', recentMessages: [{ role: 'user', content: 'hi' }] },
      });
    });
  });

  it('conversation is null on a v2 turn whose done event carried none (no conversation sent)', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      writeSseEvent(res, 'done', { answer: 'ok', citations: [] });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const result = await client.askText({ version: 'v2', collection: 'docs', question: 'q' });
      assert.equal(result.conversation, null);
    });
  });

  it('rejects an unknown version synchronously rather than guessing an endpoint', async () => {
    const client = createSemidexClient({ baseUrl: 'http://127.0.0.1:1', apiKey: API_KEY });
    await assert.rejects(() => client.askText({ version: 'v3', collection: 'd', question: 'q' }), TypeError);
  });
});

describe('askText() — error propagation', () => {
  it('a terminal SSE `error` event rejects with SemidexApiError, never a partial answer', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      writeSseEvent(res, 'sources', { sources: SOURCES });
      writeSseEvent(res, 'answer_delta', { text: 'I was about to say' });
      writeSseEvent(res, 'error', {
        apiVersion: 'v1', code: 'generation_failed', message: 'The generation provider failed.', retryable: true,
      });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.askText({ collection: 'docs', question: 'q' }),
        (err) => {
          assert.ok(err instanceof SemidexApiError);
          assert.equal(err.code, 'generation_failed');
          assert.equal(err.retryable, true);
          assert.match(err.message, /generation provider failed/);
          return true;
        },
      );
    });
  });

  it('a pre-stream 403 rejects with the same typed error the streaming method throws', async () => {
    await withFakeServer((req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'forbidden', message: 'Key is not scoped to this collection.' } }));
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.askText({ collection: 'other', question: 'q' }),
        (err) => {
          assert.ok(err instanceof SemidexApiError);
          assert.equal(err.status, 403);
          assert.equal(err.code, 'forbidden');
          return true;
        },
      );
    });
  });

  it('a stream that ends with no `done` event is an error, never a silent partial result', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      writeSseEvent(res, 'sources', { sources: SOURCES });
      writeSseEvent(res, 'answer_delta', { text: 'truncated' });
      res.end(); // no done, no error — just a truncated stream
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.askText({ collection: 'docs', question: 'q' }),
        (err) => {
          assert.ok(err instanceof SemidexApiError);
          assert.equal(err.code, 'client_incomplete_stream');
          return true;
        },
      );
    });
  });

  it('a malformed SSE payload rejects with client_parse_error', async () => {
    await withFakeServer((req, res) => {
      startSse(res);
      res.write('event: done\ndata: {broken json\n\n');
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.askText({ collection: 'docs', question: 'q' }),
        (err) => { assert.equal(err.code, 'client_parse_error'); return true; },
      );
    });
  });

  it('never leaks the apiKey into a thrown error', async () => {
    await withFakeServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }));
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.askText({ collection: 'docs', question: 'q' }),
        (err) => {
          assert.ok(!JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(API_KEY));
          return true;
        },
      );
    });
  });
});

describe('askText() — timeout and abort', () => {
  it('a caller AbortSignal rejects with the standard typed abort error', async () => {
    await withFakeServer(async (req, res) => {
      startSse(res);
      writeSseEvent(res, 'answer_delta', { text: 'slow' });
      await new Promise((r) => setTimeout(r, 3000)); // never completes
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const controller = new AbortController();
      const promise = client.askText({ collection: 'docs', question: 'q', signal: controller.signal });
      setTimeout(() => controller.abort(), 40);
      await assert.rejects(promise, (err) => {
        assert.ok(err instanceof SemidexApiError);
        assert.equal(err.code, 'client_timeout_or_abort');
        return true;
      });
    });
  });

  it('a per-call timeoutMs applies to the whole accumulation, not just the first byte', async () => {
    await withFakeServer(async (req, res) => {
      startSse(res);
      writeSseEvent(res, 'answer_delta', { text: 'first' });
      await new Promise((r) => setTimeout(r, 3000));
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const started = Date.now();
      await assert.rejects(
        () => client.askText({ collection: 'docs', question: 'q', timeoutMs: 80 }),
        (err) => { assert.equal(err.code, 'client_timeout_or_abort'); return true; },
      );
      assert.ok(Date.now() - started < 2500, 'the timeout must fire mid-stream, not wait for the server');
    });
  });
});

describe('askText() — retry interaction', () => {
  it('retries a PRE-stream 503 whose body says retryable:true, and then returns the accumulated result', async () => {
    // Ask only trusts a genuinely RECEIVED error body that explicitly marks
    // itself retryable (see retry.js's isRetryablePreStreamAsk()) — without
    // that flag the same 503 would surface after exactly one request.
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      if (requests < 3) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { apiVersion: 'v1', code: 'unavailable', message: 'warming up', retryable: true } }));
        return;
      }
      writeV1Stream(res);
    }, async (base) => {
      const client = createSemidexClient({
        baseUrl: base, apiKey: API_KEY,
        retry: { attempts: 3, initialDelayMs: 1, maxDelayMs: 20, jitter: false },
      });
      const result = await client.askText({ collection: 'docs', question: 'q' });
      assert.equal(requests, 3);
      assert.equal(result.answer, 'You have 30 days [1].');
    });
  });

  it('does NOT retry a terminal error once the stream began, even through askText()', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      startSse(res);
      writeSseEvent(res, 'answer_delta', { text: 'partial' });
      writeSseEvent(res, 'error', { code: 'unavailable', message: 'died', retryable: true });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({
        baseUrl: base, apiKey: API_KEY,
        retry: { attempts: 3, initialDelayMs: 1, maxDelayMs: 20, jitter: false },
      });
      await assert.rejects(() => client.askText({ collection: 'docs', question: 'q' }));
      assert.equal(requests, 1, 'askText() must not weaken the never-retry-a-started-generation rule');
    });
  });
});

describe('askText() — streaming methods are unchanged', () => {
  it('askV1()/askV2() still yield events one at a time alongside askText()', async () => {
    await withFakeServer((req, res) => writeV1Stream(res), async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const types = [];
      for await (const event of client.askV1({ collection: 'docs', question: 'q' })) types.push(event.type);
      assert.deepEqual(types, ['sources', 'answer_delta', 'answer_delta', 'answer_delta', 'done']);
    });
  });
});
