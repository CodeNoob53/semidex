// createSemidexClient() input validation — pure, no HTTP.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSemidexClient } from '../../../../packages/lite/lite-src/client/index.js';

const VALID = { baseUrl: 'http://127.0.0.1:8642', apiKey: 'sdx_v1_abcdefghijklmnop_' + 'a'.repeat(43) };

describe('createSemidexClient() — baseUrl validation', () => {
  it('accepts a bare origin', () => {
    assert.doesNotThrow(() => createSemidexClient(VALID));
  });

  it('accepts an origin with a path prefix', () => {
    assert.doesNotThrow(() => createSemidexClient({ ...VALID, baseUrl: 'http://127.0.0.1:8642/prefix' }));
  });

  it('rejects a missing baseUrl', () => {
    assert.throws(() => createSemidexClient({ apiKey: VALID.apiKey }), TypeError);
  });

  it('rejects a non-string baseUrl', () => {
    assert.throws(() => createSemidexClient({ ...VALID, baseUrl: 123 }), TypeError);
  });

  it('rejects a malformed URL', () => {
    assert.throws(() => createSemidexClient({ ...VALID, baseUrl: 'not a url' }), TypeError);
  });

  it('rejects a non-http(s) protocol', () => {
    assert.throws(() => createSemidexClient({ ...VALID, baseUrl: 'ftp://127.0.0.1' }), /http:|https:/);
  });

  it('rejects a baseUrl carrying a query string (credentials-in-query-string guard)', () => {
    assert.throws(() => createSemidexClient({ ...VALID, baseUrl: 'http://127.0.0.1:8642?apiKey=leaked' }), /query string/);
  });

  it('rejects a baseUrl carrying a fragment', () => {
    assert.throws(() => createSemidexClient({ ...VALID, baseUrl: 'http://127.0.0.1:8642#frag' }), /query string|fragment/);
  });

  it('rejects a baseUrl carrying userinfo (user:pass@host)', () => {
    assert.throws(() => createSemidexClient({ ...VALID, baseUrl: 'http://user:pass@127.0.0.1:8642' }), /userinfo/);
  });
});

describe('createSemidexClient() — apiKey validation', () => {
  it('rejects a missing apiKey', () => {
    assert.throws(() => createSemidexClient({ baseUrl: VALID.baseUrl }), TypeError);
  });

  it('rejects an empty/whitespace-only apiKey', () => {
    assert.throws(() => createSemidexClient({ ...VALID, apiKey: '   ' }), TypeError);
  });

  it('rejects an apiKey containing whitespace (header-injection defense)', () => {
    assert.throws(() => createSemidexClient({ ...VALID, apiKey: 'sdx_v1_ abc' }), TypeError);
  });

  it('rejects an apiKey that looks like a pasted query string ("?", "&", "=")', () => {
    for (const bad of ['token=abc', 'a&b', 'a?b']) {
      assert.throws(() => createSemidexClient({ ...VALID, apiKey: bad }), TypeError, `expected "${bad}" to be rejected`);
    }
  });

  it('rejects an apiKey that looks like a pasted full URL', () => {
    assert.throws(() => createSemidexClient({ ...VALID, apiKey: 'http://host/sdx_v1_x' }), TypeError);
  });

  it('rejects an implausibly long apiKey', () => {
    assert.throws(() => createSemidexClient({ ...VALID, apiKey: 'a'.repeat(600) }), TypeError);
  });

  it('accepts a well-formed sdx_v1_ token', () => {
    assert.doesNotThrow(() => createSemidexClient(VALID));
  });
});

describe('createSemidexClient() — timeoutMs validation', () => {
  it('accepts omitted timeoutMs (uses the documented default)', () => {
    assert.doesNotThrow(() => createSemidexClient(VALID));
  });

  it('rejects a non-positive timeoutMs', () => {
    assert.throws(() => createSemidexClient({ ...VALID, timeoutMs: 0 }), TypeError);
    assert.throws(() => createSemidexClient({ ...VALID, timeoutMs: -5 }), TypeError);
  });

  it('rejects a non-finite timeoutMs', () => {
    assert.throws(() => createSemidexClient({ ...VALID, timeoutMs: NaN }), TypeError);
    assert.throws(() => createSemidexClient({ ...VALID, timeoutMs: Infinity }), TypeError);
  });
});

describe('createSemidexClient() — returned surface', () => {
  it('exposes exactly search/askV1/askV2', () => {
    const client = createSemidexClient(VALID);
    assert.deepEqual(Object.keys(client).sort(), ['askV1', 'askV2', 'search']);
    assert.equal(typeof client.search, 'function');
    assert.equal(typeof client.askV1, 'function');
    assert.equal(typeof client.askV2, 'function');
  });

  it('askV1()/askV2() return async generators without making a request until iterated', () => {
    const client = createSemidexClient(VALID);
    const gen = client.askV1({ collection: 'c', question: 'q' });
    assert.equal(typeof gen[Symbol.asyncIterator], 'function');
    assert.equal(typeof gen.next, 'function');
    // Deliberately never iterated — if this made an eager network call, a
    // test suite with no listener at VALID.baseUrl would hang/reject here.
  });
});
