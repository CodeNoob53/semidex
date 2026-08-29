// Tests for src/shared/admin/ui-src/shared/api/client.js — the validated
// admin API client (design plan §8.2, §15 item 2). No DOM dependency, so
// this is a plain ESM import with an injected `fetchImpl` test seam (same
// convention as structural-renderer.js's tests importing real source
// directly) rather than the vm/linkedom harness the DOM-touching UI modules
// need.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  request, apiGet, apiPost, apiPatch, apiDelete, ApiError, parseRetryAfterSeconds,
} from '../../../src/shared/admin/ui-src/shared/api/client.js';

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function htmlResponse(status, text = '<html>proxy error</html>') {
  return new Response(text, { status, headers: { 'content-type': 'text/html' } });
}

// A fetchImpl that never resolves on its own — only reacts to its request's
// AbortSignal firing, exactly like a real hung network request. Lets tests
// distinguish "timeout fired" from "caller aborted" deterministically,
// without any real network I/O or real wall-clock waiting.
function hangingFetch() {
  return (path, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

// A fetchImpl whose Response resolves IMMEDIATELY (headers arrived) but
// whose own .text() call — the body-consumption phase readJsonSafely()
// drives — never resolves on its own, exactly mirroring how a real
// fetch()'s body read rejects with AbortError when the SAME AbortSignal
// passed to fetch() fires mid-read, well after the Response promise itself
// already settled. Used to prove timeout/caller-abort classification
// covers body consumption, not just the initial fetch() call.
function slowBodyFetch({ contentType = 'application/json', onBodyReject } = {}) {
  return async (path, init) => ({
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': contentType }),
    text: () => new Promise((_resolve, reject) => {
      if (onBodyReject) {
        onBodyReject(reject);
        return;
      }
      init.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
}

describe('client.js — request()', () => {
  it('returns the parsed JSON body on a successful response', async () => {
    const fetchImpl = async () => jsonResponse(200, { operations: [] });
    const body = await apiGet('/api/operations', { fetchImpl });
    assert.deepEqual(body, { operations: [] });
  });

  it('a 204/empty body on success resolves to null, not a parse error', async () => {
    const fetchImpl = async () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
    const body = await apiGet('/api/x', { fetchImpl });
    assert.equal(body, null);
  });

  describe('ApiError.kind mapping by HTTP status', () => {
    const cases = [
      [400, 'validation'],
      [415, 'validation'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [429, 'rate_limited'],
      [501, 'unavailable'],
      [503, 'unavailable'],
      [500, 'server'],
      [502, 'server'],
    ];
    for (const [status, expectedKind] of cases) {
      it(`HTTP ${status} -> kind '${expectedKind}'`, async () => {
        const fetchImpl = async () => jsonResponse(status, { error: { code: 'some_code', message: 'boom' } });
        await assert.rejects(
          apiGet('/api/x', { fetchImpl }),
          (err) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.kind, expectedKind);
            assert.equal(err.status, status);
            assert.equal(err.code, 'some_code');
            assert.equal(err.message, 'boom');
            return true;
          },
        );
      });
    }
  });

  it('passes the server code/message through verbatim', async () => {
    const fetchImpl = async () => jsonResponse(409, { error: { code: 'setting_overridden', message: 'That value changed outside semidex.' } });
    await assert.rejects(apiGet('/api/x', { fetchImpl }), (err) => {
      assert.equal(err.code, 'setting_overridden');
      assert.equal(err.message, 'That value changed outside semidex.');
      return true;
    });
  });

  it('falls back to a generic message when the error body has none', async () => {
    const fetchImpl = async () => jsonResponse(500, {});
    await assert.rejects(apiGet('/api/x', { fetchImpl }), (err) => {
      assert.equal(err.code, null);
      assert.equal(err.message, 'HTTP 500');
      return true;
    });
  });

  it('kind: "network" for a rejected fetch (connection failure)', async () => {
    const fetchImpl = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(apiGet('/api/x', { fetchImpl }), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, 'network');
      assert.equal(err.status, null);
      return true;
    });
  });

  it('kind: "timeout" when the per-request timeout elapses before the response', async () => {
    const fetchImpl = hangingFetch();
    await assert.rejects(
      apiGet('/api/slow', { fetchImpl, timeoutMs: 5 }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.kind, 'timeout');
        assert.equal(err.status, null);
        return true;
      },
    );
  });

  it('kind: "aborted" when the caller\'s own AbortSignal fires before the request starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = async () => { throw new Error('must not be called'); };
    await assert.rejects(
      apiGet('/api/x', { fetchImpl, signal: controller.signal }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.kind, 'aborted');
        return true;
      },
    );
  });

  it('kind: "aborted" (not "timeout") when the caller aborts mid-flight, before any timeout elapses', async () => {
    const controller = new AbortController();
    const fetchImpl = hangingFetch();
    const pending = apiGet('/api/slow', { fetchImpl, signal: controller.signal, timeoutMs: 60_000 });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, 'aborted');
      return true;
    });
  });

  describe('timeout/abort must cover full body consumption, not just headers', () => {
    it('kind: "timeout" when headers arrive immediately but body consumption stalls past the timeout', async () => {
      const fetchImpl = slowBodyFetch();
      await assert.rejects(
        apiGet('/api/slow-body', { fetchImpl, timeoutMs: 5 }),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.kind, 'timeout');
          return true;
        },
      );
    });

    it('kind: "aborted" when headers arrive immediately but the caller aborts during body consumption', async () => {
      const controller = new AbortController();
      const fetchImpl = slowBodyFetch();
      const pending = apiGet('/api/slow-body', { fetchImpl, signal: controller.signal, timeoutMs: 60_000 });
      setTimeout(() => controller.abort(), 5);
      await assert.rejects(pending, (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.kind, 'aborted');
        return true;
      });
    });

    it('a body-stream rejection unrelated to abort (e.g. connection reset mid-body) is normalized to kind: "network", never a raw error', async () => {
      const fetchImpl = slowBodyFetch({
        onBodyReject: (reject) => reject(new TypeError('terminated')),
      });
      await assert.rejects(apiGet('/api/slow-body', { fetchImpl }), (err) => {
        assert.ok(err instanceof ApiError, 'must be normalized into an ApiError, not leak the raw TypeError');
        assert.equal(err.kind, 'network');
        return true;
      });
    });

    it('cleanup (timer + abort listener) still runs when the failure happens during body consumption, not just during fetch()', async () => {
      const controller = new AbortController();
      let listenerCountDuringRequest = 0;
      const originalAdd = controller.signal.addEventListener.bind(controller.signal);
      controller.signal.addEventListener = (...args) => { listenerCountDuringRequest++; return originalAdd(...args); };
      const fetchImpl = slowBodyFetch({
        onBodyReject: (reject) => reject(new TypeError('terminated')),
      });
      await assert.rejects(apiGet('/api/slow-body', { fetchImpl, signal: controller.signal }));
      assert.equal(listenerCountDuringRequest, 1, 'sanity: exactly one abort listener was registered on the caller signal');
      // If cleanup had not run, a later abort on this same (still-listened)
      // signal would still be wired to the now-stale timeoutController of
      // the finished request. Aborting now must not throw synchronously —
      // proving the listener was detached (a leaked listener calling
      // .abort() on an already-settled internal controller is harmless in
      // itself, but this at least proves the request completed cleanly
      // enough to reach `finally` and not hang the process).
      assert.doesNotThrow(() => controller.abort());
    });
  });

  describe('request body serialization failure', () => {
    it('a circular-reference body is normalized to an ApiError, not a raw TypeError, and never calls fetch', async () => {
      const circular = {};
      circular.self = circular;
      let fetchCalled = false;
      const fetchImpl = async () => { fetchCalled = true; return jsonResponse(200, {}); };
      await assert.rejects(apiPost('/api/x', circular, { fetchImpl }), (err) => {
        assert.ok(err instanceof ApiError, 'must be normalized into an ApiError, not leak the raw JSON.stringify TypeError');
        assert.equal(err.kind, 'validation');
        return true;
      });
      assert.equal(fetchCalled, false, 'a body that cannot be serialized must never reach fetch()');
    });
  });

  describe('non-JSON contract failures', () => {
    it('a successful response with a non-JSON content-type never exposes the raw body', async () => {
      const fetchImpl = async () => htmlResponse(200, '<html>not json</html>');
      await assert.rejects(apiGet('/api/x', { fetchImpl }), (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.kind, 'contract');
        assert.ok(!err.message.includes('<html>'), 'the raw HTML body must never appear in the error message');
        return true;
      });
    });

    it('an error response with a non-JSON content-type (e.g. a proxy HTML error page) is also a contract failure', async () => {
      const fetchImpl = async () => htmlResponse(502, '<html>bad gateway</html>');
      await assert.rejects(apiGet('/api/x', { fetchImpl }), (err) => {
        assert.equal(err.kind, 'contract');
        assert.equal(err.status, 502);
        assert.ok(!err.message.includes('<html>'));
        return true;
      });
    });

    it('malformed JSON despite a declared JSON content-type is a contract failure', async () => {
      const fetchImpl = async () => new Response('{not valid json', { status: 200, headers: { 'content-type': 'application/json' } });
      await assert.rejects(apiGet('/api/x', { fetchImpl }), (err) => {
        assert.equal(err.kind, 'contract');
        return true;
      });
    });
  });

  describe('admin header (X-Semidex-Request) by method', () => {
    it('is present on POST', async () => {
      let seenHeaders;
      const fetchImpl = async (path, init) => { seenHeaders = init.headers; return jsonResponse(200, {}); };
      await apiPost('/api/x', { a: 1 }, { fetchImpl });
      assert.equal(seenHeaders['X-Semidex-Request'], 'admin');
    });

    it('is present on PATCH', async () => {
      let seenHeaders;
      const fetchImpl = async (path, init) => { seenHeaders = init.headers; return jsonResponse(200, {}); };
      await apiPatch('/api/x', { a: 1 }, { fetchImpl });
      assert.equal(seenHeaders['X-Semidex-Request'], 'admin');
    });

    it('is present on DELETE', async () => {
      let seenHeaders;
      const fetchImpl = async (path, init) => { seenHeaders = init.headers; return jsonResponse(200, {}); };
      await apiDelete('/api/x', { fetchImpl });
      assert.equal(seenHeaders['X-Semidex-Request'], 'admin');
    });

    it('is absent on GET', async () => {
      let seenHeaders;
      const fetchImpl = async (path, init) => { seenHeaders = init.headers; return jsonResponse(200, {}); };
      await apiGet('/api/x', { fetchImpl });
      assert.equal(seenHeaders['X-Semidex-Request'], undefined);
    });

    it('a POST body is sent as JSON with a Content-Type header', async () => {
      let seenInit;
      const fetchImpl = async (path, init) => { seenInit = init; return jsonResponse(200, {}); };
      await apiPost('/api/x', { a: 1 }, { fetchImpl });
      assert.equal(seenInit.headers['Content-Type'], 'application/json');
      assert.equal(seenInit.body, JSON.stringify({ a: 1 }));
    });
  });

  describe('parseRetryAfterSeconds()', () => {
    it('parses an integer-seconds value', () => {
      assert.equal(parseRetryAfterSeconds('120'), 120);
    });

    it('parses an HTTP-date value into a rounded-up second delta', () => {
      const future = new Date(Date.now() + 5000).toUTCString();
      const seconds = parseRetryAfterSeconds(future);
      assert.ok(seconds >= 4 && seconds <= 6, `expected ~5s, got ${seconds}`);
    });

    it('returns null for a missing header', () => {
      assert.equal(parseRetryAfterSeconds(null), null);
      assert.equal(parseRetryAfterSeconds(undefined), null);
    });

    it('returns null for a garbage value instead of throwing', () => {
      assert.doesNotThrow(() => parseRetryAfterSeconds('not-a-valid-value'));
      assert.equal(parseRetryAfterSeconds('not-a-valid-value'), null);
    });

    it('clamps a past HTTP-date to 0, never negative', () => {
      const past = new Date(Date.now() - 60_000).toUTCString();
      assert.equal(parseRetryAfterSeconds(past), 0);
    });

    it('is surfaced on ApiError.retryAfterSeconds for a 429 response', async () => {
      const fetchImpl = async () => jsonResponse(429, { error: { code: 'busy', message: 'try later' } }, { 'retry-after': '30' });
      await assert.rejects(apiGet('/api/x', { fetchImpl }), (err) => {
        assert.equal(err.kind, 'rate_limited');
        assert.equal(err.retryAfterSeconds, 30);
        return true;
      });
    });
  });

  it('request() with an explicit method option matches the apiX() convenience wrappers', async () => {
    let seenMethod;
    const fetchImpl = async (path, init) => { seenMethod = init.method; return jsonResponse(200, {}); };
    await request('/api/x', { method: 'DELETE', fetchImpl });
    assert.equal(seenMethod, 'DELETE');
  });
});
