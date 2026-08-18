import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { askV2 } from '../../../packages/lite/examples/ask-v2-sse-client.mjs';

// Builds a ReadableStream<Uint8Array> from an array of raw chunks (strings
// or Uint8Array), simulating exactly how real network reads can split SSE
// frames and multi-byte UTF-8 characters at arbitrary byte boundaries.
function streamFromChunks(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i];
      i += 1;
      controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    },
  });
}

function fakeSseResponse(chunks, { status = 200 } = {}) {
  return {
    status,
    headers: new Map([['content-type', 'text/event-stream; charset=utf-8']]),
    body: streamFromChunks(chunks),
    json: async () => ({}),
  };
}

// node's Headers-like .get() shim over a Map for the fake response above.
function withHeadersGet(map) {
  return { get: (key) => map.get(key.toLowerCase()) ?? null };
}

function sseResponse(chunks, opts) {
  const r = fakeSseResponse(chunks, opts);
  r.headers = withHeadersGet(new Map([['content-type', 'text/event-stream; charset=utf-8']]));
  return r;
}

function jsonErrorResponse(status, body) {
  return {
    status,
    headers: withHeadersGet(new Map([['content-type', 'application/json; charset=utf-8']])),
    body: streamFromChunks([]),
    json: async () => body,
  };
}

let originalFetch;
let capturedFetchArgs;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function frame(event, dataObj) {
  return `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;
}

describe('askV2 SSE client — chunk-boundary correctness', () => {
  test('parses a complete stream delivered as ONE chunk', async () => {
    const full = frame('sources', { sources: [{ n: 1 }] })
      + frame('answer_delta', { text: 'Hello' })
      + frame('answer_delta', { text: ' world' })
      + frame('done', { answer: 'Hello world', citations: [1] });
    globalThis.fetch = async (url, opts) => { capturedFetchArgs = { url, opts }; return sseResponse([full]); };

    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'Hello world');
    assert.deepEqual(result.sources, [{ n: 1 }]);
  });

  test('parses a stream where a single SSE frame is split across MULTIPLE network chunks, mid-line', async () => {
    const full = frame('done', { answer: 'Split works', citations: [] });
    // Split the frame at an arbitrary byte offset, not on a line boundary.
    const mid = Math.floor(full.length / 2);
    const chunks = [full.slice(0, mid), full.slice(mid)];
    globalThis.fetch = async () => sseResponse(chunks);

    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.ok, true);
    assert.equal(result.done.answer, 'Split works');
  });

  test('parses a stream where the blank-line frame terminator itself is split across chunks', async () => {
    const full = frame('done', { answer: 'boundary split', citations: [] });
    // Split exactly between the two '\n' characters of the trailing '\n\n'.
    const splitPoint = full.length - 1;
    const chunks = [full.slice(0, splitPoint), full.slice(splitPoint)];
    globalThis.fetch = async () => sseResponse(chunks);

    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.ok, true);
    assert.equal(result.done.answer, 'boundary split');
  });

  test('parses a stream where a multi-byte UTF-8 character is split across two chunks', async () => {
    // Cyrillic text -- each character is 2 bytes in UTF-8. Split the raw
    // byte buffer in the MIDDLE of one character's own 2-byte encoding.
    const full = frame('done', { answer: 'Привіт світ', citations: [] });
    const bytes = new TextEncoder().encode(full);
    // Find a byte offset that lands inside a multi-byte sequence (a
    // continuation byte has its top bits as 10xxxxxx).
    let splitAt = -1;
    for (let i = 1; i < bytes.length; i += 1) {
      if ((bytes[i] & 0xc0) === 0x80) { splitAt = i; break; }
    }
    assert.ok(splitAt > 0, 'test fixture must contain a multi-byte UTF-8 character to split');
    const chunks = [bytes.slice(0, splitAt), bytes.slice(splitAt)];
    globalThis.fetch = async () => sseResponse(chunks);

    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.ok, true);
    assert.equal(result.done.answer, 'Привіт світ', 'a multi-byte character split across chunks must not be corrupted');
  });

  test('parses many answer_delta events streamed one character at a time (worst-case granularity)', async () => {
    const answer = 'A short answer.';
    const chunks = [];
    for (const ch of answer) chunks.push(frame('answer_delta', { text: ch }));
    chunks.push(frame('done', { answer, citations: [] }));
    globalThis.fetch = async () => sseResponse(chunks);

    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.answer, answer);
    assert.equal(result.ok, true);
  });
});

describe('askV2 SSE client — pre-stream HTTP errors', () => {
  test('a pre-stream 400 JSON error is captured without attempting SSE parsing', async () => {
    globalThis.fetch = async () => jsonErrorResponse(400, { error: { code: 'invalid_message_role', message: 'bad role', retryable: false } });
    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 400);
    assert.equal(result.error.code, 'invalid_message_role');
    assert.equal(result.error.retryable, false);
  });

  test('a pre-stream 404 (collection not found) is captured', async () => {
    globalThis.fetch = async () => jsonErrorResponse(404, { error: { code: 'not_found', message: 'Collection "x" not found', retryable: false } });
    const result = await askV2({ baseUrl: 'http://x', collection: 'x', question: 'q' });
    assert.equal(result.httpStatus, 404);
    assert.equal(result.error.code, 'not_found');
  });

  test('a pre-stream 429 busy is captured as retryable', async () => {
    globalThis.fetch = async () => jsonErrorResponse(429, { error: { code: 'busy', message: 'busy', retryable: true } });
    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.httpStatus, 429);
    assert.equal(result.error.retryable, true);
  });
});

describe('askV2 SSE client — terminal error event mid-stream', () => {
  test('a terminal `error` SSE event (after sources) is captured, ok:false', async () => {
    const chunks = [frame('sources', { sources: [] }), frame('error', { code: 'generation_failed', message: 'boom', retryable: true })];
    globalThis.fetch = async () => sseResponse(chunks);
    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'generation_failed');
  });
});

describe('askV2 SSE client — conversation fields', () => {
  test('extracts conversationId/summaryChanged/updatedSummary/compactedMessageCount from the done event', async () => {
    const chunks = [frame('done', {
      answer: 'ok', citations: [],
      conversation: { id: 'conv1', summaryChanged: true, updatedSummary: 'new summary', compactedMessageCount: 3 },
    })];
    globalThis.fetch = async () => sseResponse(chunks);
    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.conversationId, 'conv1');
    assert.equal(result.summaryChanged, true);
    assert.equal(result.updatedSummary, 'new summary');
    assert.equal(result.compactedMessageCount, 3);
  });

  test('omits conversation fields cleanly (defaults) when done has no conversation block', async () => {
    const chunks = [frame('done', { answer: 'ok', citations: [] })];
    globalThis.fetch = async () => sseResponse(chunks);
    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.conversationId, null);
    assert.equal(result.summaryChanged, false);
    assert.equal(result.updatedSummary, null);
    assert.equal(result.compactedMessageCount, null);
  });

  test('compactedMessageCount defaults to null when summaryChanged:false (server omits it)', async () => {
    const chunks = [frame('done', {
      answer: 'ok', citations: [],
      conversation: { id: 'conv1', summaryChanged: false },
    })];
    globalThis.fetch = async () => sseResponse(chunks);
    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(result.summaryChanged, false);
    assert.equal(result.compactedMessageCount, null);
  });
});

describe('askV2 SSE client — request shape', () => {
  test('sends conversation only when supplied, never a null/empty placeholder', async () => {
    globalThis.fetch = async (url, opts) => { capturedFetchArgs = { url, opts }; return sseResponse([frame('done', { answer: 'ok', citations: [] })]); };
    await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    const body = JSON.parse(capturedFetchArgs.opts.body);
    assert.ok(!('conversation' in body));
  });

  test('sends the exact conversation object when supplied', async () => {
    globalThis.fetch = async (url, opts) => { capturedFetchArgs = { url, opts }; return sseResponse([frame('done', { answer: 'ok', citations: [] })]); };
    const conversation = { id: 'c1', summary: 's', recentMessages: [{ role: 'user', content: 'hi' }] };
    await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q', conversation });
    const body = JSON.parse(capturedFetchArgs.opts.body);
    assert.deepEqual(body.conversation, conversation);
  });

  test('sends no Authorization header when no token is supplied', async () => {
    globalThis.fetch = async (url, opts) => { capturedFetchArgs = { url, opts }; return sseResponse([frame('done', { answer: 'ok', citations: [] })]); };
    await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal('Authorization' in capturedFetchArgs.opts.headers, false, 'must not send a fabricated/empty Authorization header');
  });

  test('sends Authorization: Bearer <token> exactly when a token is supplied', async () => {
    globalThis.fetch = async (url, opts) => { capturedFetchArgs = { url, opts }; return sseResponse([frame('done', { answer: 'ok', citations: [] })]); };
    await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q', token: 'sdx_v1_test_token' });
    assert.equal(capturedFetchArgs.opts.headers.Authorization, 'Bearer sdx_v1_test_token');
  });

  test('the token never reaches the returned result object', async () => {
    globalThis.fetch = async () => sseResponse([frame('done', { answer: 'ok', citations: [] })]);
    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q', token: 'sdx_v1_super_secret' });
    assert.equal(JSON.stringify(result).includes('sdx_v1_super_secret'), false, 'the token must never leak into the returned result');
  });

  test('the token never reaches the request body — Authorization header only', async () => {
    globalThis.fetch = async (url, opts) => { capturedFetchArgs = { url, opts }; return sseResponse([frame('done', { answer: 'ok', citations: [] })]); };
    await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q', token: 'sdx_v1_body_check' });
    assert.equal(capturedFetchArgs.opts.body.includes('sdx_v1_body_check'), false, 'the token must be sent only via the Authorization header, never in the JSON body');
  });
});

describe('askV2 SSE client — abort/timeout', () => {
  test('a short timeoutMs against a hanging stream resolves with a bounded, non-throwing timeout error', async () => {
    // A stream whose body never closes and never sends a done/error frame
    // -- simulates a stalled connection. askV2's own internal timeout must
    // still resolve (never hang forever), via the AbortController it
    // threads into fetch()/the stream reader.
    globalThis.fetch = async (url, opts) => {
      const neverClosingBody = new ReadableStream({
        pull() { /* never enqueues, never closes -- simulates a stall */ },
        cancel() {},
      });
      opts.signal.addEventListener('abort', () => {}); // real fetch would tear down the connection on abort
      return {
        status: 200,
        headers: withHeadersGet(new Map([['content-type', 'text/event-stream; charset=utf-8']])),
        body: neverClosingBody,
        json: async () => ({}),
      };
    };
    const start = Date.now();
    const result = await askV2({ baseUrl: 'http://x', collection: 'c', question: 'q', timeoutMs: 80 });
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false);
    assert.ok(result.error, 'expected a bounded timeout error, not a hang');
    assert.ok(elapsed < 2000, `expected the call to resolve near the timeout bound, took ${elapsed}ms`);
  });

  test('a caller-supplied signal aborting mid-stream is observed and resolves (never hangs)', async () => {
    const callerController = new AbortController();
    globalThis.fetch = async (url, opts) => {
      const neverClosingBody = new ReadableStream({
        pull() {},
        cancel() {},
      });
      return {
        status: 200,
        headers: withHeadersGet(new Map([['content-type', 'text/event-stream; charset=utf-8']])),
        body: neverClosingBody,
        json: async () => ({}),
      };
    };
    const resultPromise = askV2({ baseUrl: 'http://x', collection: 'c', question: 'q', timeoutMs: 60_000, signal: callerController.signal });
    await new Promise((r) => setTimeout(r, 20));
    callerController.abort();
    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });

  test('a long multi-chunk stream never accumulates more than one abort listener on the internal signal', async () => {
    // Regression test for a leak where pumpSseBody's internal read loop
    // created a fresh {once:true} abort listener on every iteration and
    // never removed the ones from iterations reader.read() won (the common
    // case) -- on a long stream this grew one leaked listener per chunk.
    // askV2 builds its own internal AbortController privately, so this test
    // captures the real instance by wrapping the global constructor for the
    // duration of the call, then inspects that exact signal's listener
    // count via node:events' getEventListeners.
    const { getEventListeners } = await import('node:events');
    const OriginalAbortController = globalThis.AbortController;
    let capturedSignal;
    globalThis.AbortController = class extends OriginalAbortController {
      constructor(...args) {
        super(...args);
        capturedSignal = this.signal;
      }
    };
    const CHUNK_COUNT = 25;
    globalThis.fetch = async (url, opts) => {
      let pulls = 0;
      const body = new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls > CHUNK_COUNT) return; // stall after N chunks, never closes -- forces the loop through many iterations without ever hitting `done`
          controller.enqueue(new TextEncoder().encode(frame('answer_delta', { text: `chunk${pulls}` })));
        },
        cancel() {},
      });
      return {
        status: 200,
        headers: withHeadersGet(new Map([['content-type', 'text/event-stream; charset=utf-8']])),
        body,
        json: async () => ({}),
      };
    };
    try {
      const resultPromise = askV2({ baseUrl: 'http://x', collection: 'c', question: 'q', timeoutMs: 300 });
      // Give the reader loop time to pull through all the enqueued chunks,
      // while the stream is still "open" (stalled, not yet timed out).
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(capturedSignal, 'expected askV2 to have constructed its own internal AbortController');
      assert.equal(
        getEventListeners(capturedSignal, 'abort').length,
        1,
        'pumpSseBody must reuse a single abort listener across the whole read loop, not one per chunk',
      );
      // Let the internal timeout (300ms) fire naturally so the call resolves.
      await resultPromise;
    } finally {
      globalThis.AbortController = OriginalAbortController;
    }
  });
});
