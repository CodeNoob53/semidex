// Retry policy for semidex-lite/client — the pure delay/classification unit
// (retry.js) plus the end-to-end behavior against a REAL local HTTP server
// (node:http), matching http.test.js's own "never a mocked fetch" rule.
//
// The invariant these tests exist to protect: a retry may only ever happen
// BEFORE an SSE stream has started. Every "no retry" case below asserts on
// the SERVER's own request count, not just on the shape of the thrown error
// — a client that silently sent a second generation request would still
// throw the same error, so counting requests is the only assertion that
// actually proves the spend was not duplicated.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSemidexClient, SemidexApiError } from '../../../../packages/lite/lite-src/client/index.js';
import {
  DEFAULT_RETRY, normalizeRetryOptions, isRetryablePreStreamSearch, isRetryablePreStreamAsk, computeDelayMs, sleepUnlessAborted,
} from '../../../../packages/lite/lite-src/client/retry.js';

const API_KEY = 'sdx_v1_' + 'k'.repeat(16) + '_' + 'a'.repeat(43);

// Fast, deterministic retry settings — these tests assert on COUNTS and
// ORDERING, never on real wall-clock backoff duration.
const FAST_RETRY = { attempts: 3, initialDelayMs: 1, maxDelayMs: 20, jitter: false };

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

function jsonRes(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function searchOk(res) {
  jsonRes(res, 200, {
    apiVersion: 'v1', collection: 'docs', query: 'q', searchMode: 'hybrid',
    top: 3, window: 0, windowFormat: null, results: [],
  });
}

function startSse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function drain(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

// ── Pure policy unit ────────────────────────────────────────────────────────

describe('retry policy — defaults are conservative', () => {
  it('defaults to a single attempt: retries are opt-in, never silently enabled by upgrading', () => {
    assert.equal(DEFAULT_RETRY.attempts, 1);
  });

  it('a client with no retry option sends exactly ONE request for a retryable 503', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      jsonRes(res, 503, { error: { code: 'unavailable', message: 'down', retryable: true } });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(() => client.search({ collection: 'docs', query: 'q' }));
      assert.equal(requests, 1, 'default configuration must not retry at all');
    });
  });
});

describe('normalizeRetryOptions()', () => {
  it('layers a per-call bag onto the client-level one rather than replacing it', () => {
    const clientLevel = normalizeRetryOptions({ attempts: 4, initialDelayMs: 10, maxDelayMs: 99 }, 'client');
    const perCall = normalizeRetryOptions({ attempts: 2 }, 'call', clientLevel);
    assert.equal(perCall.attempts, 2);
    assert.equal(perCall.initialDelayMs, 10, 'unspecified keys inherit from the client-level bag');
    assert.equal(perCall.maxDelayMs, 99);
  });

  it('returns the base unchanged for undefined input', () => {
    assert.equal(normalizeRetryOptions(undefined, 'x'), DEFAULT_RETRY);
  });

  it('throws TypeError synchronously for malformed values', () => {
    assert.throws(() => normalizeRetryOptions({ attempts: 0 }, 'x'), TypeError);
    assert.throws(() => normalizeRetryOptions({ attempts: 11 }, 'x'), TypeError);
    assert.throws(() => normalizeRetryOptions({ attempts: 1.5 }, 'x'), TypeError);
    assert.throws(() => normalizeRetryOptions({ initialDelayMs: -1 }, 'x'), TypeError);
    assert.throws(() => normalizeRetryOptions({ backoffFactor: 0.5 }, 'x'), TypeError);
    assert.throws(() => normalizeRetryOptions({ jitter: 'yes' }, 'x'), TypeError);
    assert.throws(() => normalizeRetryOptions({ onRetry: 'nope' }, 'x'), TypeError);
    assert.throws(() => normalizeRetryOptions([], 'x'), TypeError);
    assert.throws(() => normalizeRetryOptions({ initialDelayMs: 500, maxDelayMs: 100 }, 'x'), TypeError);
  });
});

describe('isRetryablePreStreamSearch() — search() is read-only, network failures are safe', () => {
  const err = (status, code) => new SemidexApiError('x', { status, code });

  it('retries 429/502/503/504', () => {
    for (const status of [429, 502, 503, 504]) {
      assert.equal(isRetryablePreStreamSearch(err(status, 'x')), true, `status ${status} must be retryable`);
    }
  });

  it('never retries 400/401/403/404 — deterministic, caller-fixable failures', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      assert.equal(isRetryablePreStreamSearch(err(status, 'x')), false, `status ${status} must NOT be retryable`);
    }
  });

  it('never retries an unqualified 500', () => {
    assert.equal(isRetryablePreStreamSearch(err(500, 'internal')), false);
  });

  it('retries a transport failure with no HTTP response, but never a timeout/abort', () => {
    assert.equal(isRetryablePreStreamSearch(new SemidexApiError('boom', { code: 'client_request_failed', retryable: true })), true);
    assert.equal(isRetryablePreStreamSearch(new SemidexApiError('t', { code: 'client_timeout_or_abort', retryable: true })), false);
  });

  it('does NOT trust a server-sent retryable flag on an otherwise non-retryable status', () => {
    // A future server marking a 400 `retryable: true` must not be able to
    // turn a validation bug into a client-side retry storm.
    assert.equal(isRetryablePreStreamSearch(new SemidexApiError('x', { status: 400, retryable: true })), false);
  });

  it('ignores non-SemidexApiError values', () => {
    assert.equal(isRetryablePreStreamSearch(new Error('plain')), false);
    assert.equal(isRetryablePreStreamSearch(null), false);
  });
});

describe('isRetryablePreStreamAsk() — Ask is not idempotent, network failures are never safe', () => {
  const err = (status, code, extra) => new SemidexApiError('x', { status, code, ...extra });

  it('NEVER retries a bare network failure (no HTTP response at all) — the request may already have started a generation server-side', () => {
    assert.equal(isRetryablePreStreamAsk(new SemidexApiError('boom', { code: 'client_request_failed', retryable: true })), false);
  });

  it('never retries a timeout/abort', () => {
    assert.equal(isRetryablePreStreamAsk(new SemidexApiError('t', { code: 'client_timeout_or_abort', retryable: true })), false);
  });

  it('retries a recognized Semidex Ask envelope whose payload explicitly says retryable:true, at ANY status', () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 504]) {
      assert.equal(isRetryablePreStreamAsk(err(status, 'x', { apiVersion: 'v2', retryable: true })), true, `status ${status} with a recognized envelope and explicit retryable:true must be retryable`);
    }
  });

  it('does NOT trust retryable:true without a recognized Ask apiVersion', () => {
    assert.equal(isRetryablePreStreamAsk(err(503, 'x', { retryable: true })), false);
    assert.equal(isRetryablePreStreamAsk(err(503, 'x', { apiVersion: 'future', retryable: true })), false);
  });

  it('does NOT retry a received error whose payload has no retryable flag — a generic proxy 502/504 does not qualify', () => {
    for (const status of [429, 502, 503, 504]) {
      assert.equal(isRetryablePreStreamAsk(err(status, 'x')), false, `status ${status} without an explicit retryable:true must NOT be retryable`);
    }
  });

  it('ignores non-SemidexApiError values', () => {
    assert.equal(isRetryablePreStreamAsk(new Error('plain')), false);
    assert.equal(isRetryablePreStreamAsk(null), false);
  });
});

describe('computeDelayMs() — bounded exponential backoff with jitter', () => {
  const opts = { initialDelayMs: 100, maxDelayMs: 5000, backoffFactor: 2, jitter: false };

  it('grows exponentially and clamps at maxDelayMs', () => {
    assert.equal(computeDelayMs(0, null, opts).delayMs, 100);
    assert.equal(computeDelayMs(1, null, opts).delayMs, 200);
    assert.equal(computeDelayMs(2, null, opts).delayMs, 400);
    assert.equal(computeDelayMs(10, null, opts).delayMs, 5000, 'never exceeds maxDelayMs');
  });

  it('jitter stays within [half, full] of the exponential value — a real floor, never near-zero', () => {
    const jittered = { ...opts, jitter: true };
    assert.equal(computeDelayMs(0, null, jittered, () => 0).delayMs, 50);
    assert.equal(computeDelayMs(0, null, jittered, () => 1).delayMs, 100);
    for (let i = 0; i < 200; i += 1) {
      const { delayMs } = computeDelayMs(2, null, jittered);
      assert.ok(delayMs >= 200 && delayMs <= 400, `jittered delay ${delayMs} out of [200,400]`);
    }
  });

  it('a valid Retry-After acts as a FLOOR and wins over a shorter computed backoff', () => {
    const { delayMs, source } = computeDelayMs(0, 2, opts); // 2s vs 100ms backoff
    assert.equal(delayMs, 2000);
    assert.equal(source, 'retry-after');
  });

  it('a Retry-After shorter than the computed backoff does not shrink the wait', () => {
    const { delayMs, source } = computeDelayMs(3, 0.05, opts); // 50ms vs 800ms backoff
    assert.equal(delayMs, 800);
    assert.equal(source, 'backoff');
  });

  it('a Retry-After longer than maxDelayMs is reported as exceeding the cap, never slept', () => {
    const { delayMs, exceedsMaxDelay } = computeDelayMs(0, 3600, opts);
    assert.equal(exceedsMaxDelay, true);
    assert.equal(delayMs, opts.maxDelayMs, 'the reported delay is still clamped, never the raw 3600s');
  });

  it('ignores a malformed/hostile Retry-After and falls back to the backoff schedule', () => {
    for (const bad of [NaN, -5, Infinity, 999_999]) {
      const { delayMs, source } = computeDelayMs(0, bad, opts);
      assert.equal(source, 'backoff', `Retry-After ${bad} must be ignored`);
      assert.equal(delayMs, 100);
    }
  });
});

describe('sleepUnlessAborted()', () => {
  it('resolves "slept" when the delay elapses', async () => {
    assert.equal(await sleepUnlessAborted(5, new AbortController().signal), 'slept');
  });

  it('resolves "aborted" immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    assert.equal(await sleepUnlessAborted(5000, controller.signal), 'aborted');
    assert.ok(Date.now() - started < 500, 'must not wait out the delay');
  });

  it('resolves "aborted" when the signal fires mid-sleep, well before the delay elapses', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const started = Date.now();
    assert.equal(await sleepUnlessAborted(5000, controller.signal), 'aborted');
    assert.ok(Date.now() - started < 500, 'must cancel the pending backoff, not wait it out');
  });
});

// ── End-to-end against a real server ────────────────────────────────────────

describe('search() — retry on transient statuses', () => {
  it('retries a 429 and succeeds on a later attempt', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      if (requests < 3) { jsonRes(res, 429, { error: { code: 'rate_limited', message: 'slow down' } }); return; }
      searchOk(res);
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      const result = await client.search({ collection: 'docs', query: 'q' });
      assert.equal(requests, 3);
      assert.equal(result.apiVersion, 'v1');
      assert.equal(result.retries, 2, 'the successful result reports how many retries it cost');
    });
  });

  it('retries a 503 and surfaces the LAST error once attempts are exhausted', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      jsonRes(res, 503, { error: { code: 'unavailable', message: 'still down' } });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => {
          assert.ok(err instanceof SemidexApiError);
          assert.equal(err.status, 503);
          assert.equal(err.retries, 2, 'the thrown error reports the retries spent');
          return true;
        },
      );
      assert.equal(requests, 3, 'attempts:3 means exactly 3 total requests, never more');
    });
  });

  it('a per-call retry overrides the client-level default', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      jsonRes(res, 503, { error: { code: 'unavailable', message: 'down' } });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY }); // attempts: 1
      await assert.rejects(() => client.search({
        collection: 'docs', query: 'q', retry: { attempts: 2, initialDelayMs: 1, maxDelayMs: 5, jitter: false },
      }));
      assert.equal(requests, 2);
    });
  });

  it('the successful result keeps its exact wire shape — `retries` is non-enumerable', async () => {
    await withFakeServer((req, res) => searchOk(res), async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      const result = await client.search({ collection: 'docs', query: 'q' });
      assert.equal(result.retries, 0);
      assert.ok(!Object.keys(result).includes('retries'), 'must not appear in Object.keys()');
      assert.ok(!JSON.stringify(result).includes('retries'), 'must not appear in the serialized body');
    });
  });
});

describe('search()/ask() — statuses that must NEVER be retried', () => {
  for (const status of [400, 401, 403, 404]) {
    it(`a ${status} is surfaced immediately after exactly one request`, async () => {
      let requests = 0;
      await withFakeServer((req, res) => {
        requests += 1;
        jsonRes(res, status, { error: { code: `code_${status}`, message: 'nope' } });
      }, async (base) => {
        const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
        await assert.rejects(
          () => client.search({ collection: 'docs', query: 'q' }),
          (err) => { assert.equal(err.status, status); return true; },
        );
        assert.equal(requests, 1, `a ${status} must not be retried — retrying only burns budget and delays the real error`);
      });
    });
  }

  it('a 401 on askV1() is not retried either — no duplicate generation request', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      jsonRes(res, 401, { error: { code: 'unauthorized', message: 'bad token' } });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      await assert.rejects(
        drain(client.askV1({ collection: 'docs', question: 'q' })),
        (err) => { assert.equal(err.status, 401); return true; },
      );
      assert.equal(requests, 1);
    });
  });

  it('a retried error never leaks the apiKey', async () => {
    await withFakeServer((req, res) => {
      jsonRes(res, 429, { error: { code: 'rate_limited', message: 'slow down' } });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
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
});

describe('Retry-After handling over the wire', () => {
  it('honors a short Retry-After header and still retries', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      if (requests === 1) { jsonRes(res, 429, { error: { code: 'rate_limited', message: 'wait' } }, { 'Retry-After': '0.01' }); return; }
      searchOk(res);
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: { attempts: 2, initialDelayMs: 1, maxDelayMs: 1000, jitter: false } });
      const result = await client.search({ collection: 'docs', query: 'q' });
      assert.equal(requests, 2);
      assert.equal(result.retries, 1);
    });
  });

  it('a Retry-After beyond maxDelayMs stops the retry loop instead of sleeping — the error surfaces at once', async () => {
    let requests = 0;
    const started = Date.now();
    await withFakeServer((req, res) => {
      requests += 1;
      jsonRes(res, 429, { error: { code: 'rate_limited', message: 'come back in an hour' } }, { 'Retry-After': '3600' });
    }, async (base) => {
      const client = createSemidexClient({
        baseUrl: base, apiKey: API_KEY,
        retry: { attempts: 4, initialDelayMs: 1, maxDelayMs: 50, jitter: false },
      });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => {
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterSeconds, 3600, 'the caller still receives the server hint to reschedule with');
          return true;
        },
      );
      assert.equal(requests, 1, 'a Retry-After past the client cap must not be retried at all');
      assert.ok(Date.now() - started < 3000, 'must never actually sleep the server-requested hour');
    });
  });
});

describe('retry observability (onRetry)', () => {
  it('reports each retry with safe fields only — never the token', async () => {
    const seen = [];
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      if (requests < 3) { jsonRes(res, 503, { error: { code: 'unavailable', message: 'down' } }, { 'Retry-After': '0.01' }); return; }
      searchOk(res);
    }, async (base) => {
      const client = createSemidexClient({
        baseUrl: base, apiKey: API_KEY,
        retry: { ...FAST_RETRY, onRetry: (info) => seen.push(info) },
      });
      await client.search({ collection: 'docs', query: 'q' });
      assert.equal(seen.length, 2, 'one callback per retry, not per attempt');
      assert.equal(seen[0].attempt, 1);
      assert.equal(seen[0].nextAttempt, 2);
      assert.equal(seen[0].status, 503);
      assert.equal(seen[0].code, 'unavailable');
      assert.ok(typeof seen[0].delayMs === 'number' && seen[0].delayMs >= 0);
      const serialized = JSON.stringify(seen);
      assert.ok(!serialized.includes(API_KEY), 'the retry record must never carry the bearer token');
      assert.ok(!serialized.toLowerCase().includes('authorization'));
    });
  });

  it('a throwing onRetry never breaks the retry loop or replaces the real error', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      if (requests < 2) { jsonRes(res, 503, { error: { code: 'unavailable', message: 'down' } }); return; }
      searchOk(res);
    }, async (base) => {
      const client = createSemidexClient({
        baseUrl: base, apiKey: API_KEY,
        retry: { ...FAST_RETRY, onRetry: () => { throw new Error('observer bug'); } },
      });
      const result = await client.search({ collection: 'docs', query: 'q' });
      assert.equal(result.apiVersion, 'v1');
      assert.equal(requests, 2);
    });
  });
});

describe('ask() — no retry once the SSE stream has begun', () => {
  it('a terminal SSE `error` event is NEVER retried — the generation is not re-run', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      startSse(res);
      writeSseEvent(res, 'sources', { apiVersion: 'v1', sources: [] });
      // A 503-shaped, "retryable" terminal error: retryable-LOOKING, but it
      // arrives after the stream started, so it must still never be retried.
      writeSseEvent(res, 'error', { code: 'unavailable', message: 'generation backend died', retryable: true });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      await assert.rejects(
        drain(client.askV1({ collection: 'docs', question: 'q' })),
        (err) => {
          assert.ok(err instanceof SemidexApiError);
          assert.equal(err.code, 'unavailable');
          return true;
        },
      );
      assert.equal(requests, 1, 'a started generation must never be re-requested');
    });
  });

  it('a malformed SSE payload mid-stream is NEVER retried', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      startSse(res);
      res.write('event: sources\ndata: {not json\n\n');
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      await assert.rejects(
        drain(client.askV1({ collection: 'docs', question: 'q' })),
        (err) => { assert.equal(err.code, 'client_parse_error'); return true; },
      );
      assert.equal(requests, 1);
    });
  });

  it('a stream that dies mid-answer is NEVER retried, even though the socket error looks transient', async () => {
    let requests = 0;
    const delivered = [];
    await withFakeServer((req, res) => {
      requests += 1;
      startSse(res);
      writeSseEvent(res, 'answer_delta', { apiVersion: 'v1', text: 'partial' });
      // Destroy the socket without a terminal event: a transport-level
      // failure AFTER bytes have genuinely reached the client. The delay
      // matters — destroying in the same tick would kill the connection
      // before the response headers ever flush, which is the PRE-stream
      // connection-drop case covered by its own test below (and, for Ask,
      // is now NEVER retried either — see retry.js), not the mid-stream
      // case this test is about.
      setTimeout(() => res.socket.destroy(), 60);
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      await assert.rejects((async () => {
        for await (const event of client.askV1({ collection: 'docs', question: 'q' })) delivered.push(event);
      })());
      assert.deepEqual(delivered.map((e) => e.type), ['answer_delta'], 'the stream really did start before dying');
      assert.equal(requests, 1, 'bytes were already on the wire — re-running the generation would double-spend');
    });
  });

  it('a connection dropped BEFORE any response headers is a pre-stream failure for Ask, and is NEVER retried — the ambiguity is resolved against retrying', async () => {
    // The mirror image of the equivalent search() test elsewhere in this
    // file: for Ask, a socket dropped before headers cannot be told apart
    // from "the server already started generating", so retry.js resolves
    // that ambiguity by never retrying it, no matter how many attempts are
    // configured. Exactly one request is the assertion that actually proves
    // no duplicate generation was risked.
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      res.socket.destroy();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      await assert.rejects(
        drain(client.askV1({ collection: 'docs', question: 'q' })),
        (err) => {
          assert.ok(err instanceof SemidexApiError);
          assert.equal(err.code, 'client_request_failed');
          return true;
        },
      );
      assert.equal(requests, 1, 'a pre-header network failure on Ask must not be retried, ever');
    });
  });

  it('a PRE-stream 503 on askV2() whose body explicitly says retryable:true IS retried, and the retry count rides on the first event', async () => {
    // Unlike the network-failure case above, a genuinely RECEIVED JSON error
    // body that the server itself marks `retryable: true` is the one case
    // isRetryablePreStreamAsk() trusts — Semidex is vouching that it replied
    // without ever starting a stream.
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      if (requests < 3) { jsonRes(res, 503, { error: { apiVersion: 'v2', code: 'unavailable', message: 'warming up', retryable: true } }); return; }
      startSse(res);
      writeSseEvent(res, 'sources', { apiVersion: 'v1', sources: [] });
      writeSseEvent(res, 'done', { apiVersion: 'v1', answer: 'ok', citations: [] });
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      const events = await drain(client.askV2({ collection: 'docs', question: 'q' }));
      assert.equal(requests, 3);
      assert.equal(events[0].retries, 2);
      assert.ok(!Object.keys(events[0]).includes('retries'), 'observability must not alter the event wire shape');
    });
  });

  it('a PRE-stream 503 on askV2() WITHOUT an explicit retryable:true is surfaced after exactly one request — a generic proxy error does not qualify', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      jsonRes(res, 503, { error: { code: 'unavailable', message: 'warming up' } });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      await assert.rejects(
        drain(client.askV2({ collection: 'docs', question: 'q' })),
        (err) => { assert.equal(err.status, 503); return true; },
      );
      assert.equal(requests, 1, 'a 503 with no explicit retryable flag must not be retried on Ask');
    });
  });
});

describe('retry — abort and timeout during backoff', () => {
  it('a caller AbortSignal fired during backoff ends the call promptly with the standard typed error', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      jsonRes(res, 503, { error: { code: 'unavailable', message: 'down' } });
    }, async (base) => {
      const client = createSemidexClient({
        baseUrl: base, apiKey: API_KEY,
        // A long backoff the abort must cut through, not wait out.
        retry: { attempts: 5, initialDelayMs: 5000, maxDelayMs: 5000, jitter: false },
      });
      const controller = new AbortController();
      const started = Date.now();
      const promise = client.search({ collection: 'docs', query: 'q', signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(promise, (err) => {
        assert.ok(err instanceof SemidexApiError);
        assert.equal(err.code, 'client_timeout_or_abort', 'an abort during backoff is the SAME error as an abort during the HTTP leg');
        return true;
      });
      assert.ok(Date.now() - started < 4000, 'the pending backoff must be cancelled, not waited out');
      assert.equal(requests, 1, 'no further attempt is made after the abort');
    });
  });

  it('the call timeout is a TOTAL budget across attempts and backoff, not a per-attempt one', async () => {
    let requests = 0;
    await withFakeServer((req, res) => {
      requests += 1;
      jsonRes(res, 503, { error: { code: 'unavailable', message: 'down' } });
    }, async (base) => {
      const client = createSemidexClient({
        baseUrl: base, apiKey: API_KEY, timeoutMs: 150,
        retry: { attempts: 5, initialDelayMs: 5000, maxDelayMs: 5000, jitter: false },
      });
      const started = Date.now();
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => { assert.equal(err.code, 'client_timeout_or_abort'); return true; },
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 4000, `retries must never extend a call past its timeout budget (took ${elapsed}ms)`);
      assert.equal(requests, 1);
    });
  });

  it('an already-aborted signal never issues a request at all, retries configured or not', async () => {
    let requests = 0;
    await withFakeServer((req, res) => { requests += 1; searchOk(res); }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY, retry: FAST_RETRY });
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q', signal: controller.signal }),
        (err) => { assert.equal(err.code, 'client_timeout_or_abort'); return true; },
      );
      assert.equal(requests, 0);
    });
  });
});
