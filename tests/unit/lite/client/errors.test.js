// Pure unit tests for the client's typed error class/projectors
// (packages/lite/lite-src/client/errors.js). No HTTP.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SemidexApiError, errorFromBody, errorFromPayload } from '../../../../packages/lite/lite-src/client/errors.js';

describe('SemidexApiError', () => {
  it('is a real Error subclass with the documented fields', () => {
    const err = new SemidexApiError('boom', { status: 500, code: 'internal_error', retryable: true, retryAfterSeconds: 3, requestId: 'r1', apiVersion: 'v1' });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof SemidexApiError);
    assert.equal(err.name, 'SemidexApiError');
    assert.equal(err.message, 'boom');
    assert.equal(err.status, 500);
    assert.equal(err.code, 'internal_error');
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterSeconds, 3);
    assert.equal(err.requestId, 'r1');
    assert.equal(err.apiVersion, 'v1');
  });

  it('defaults every optional field to a safe value', () => {
    const err = new SemidexApiError('x');
    assert.equal(err.status, null);
    assert.equal(err.code, null);
    assert.equal(err.retryable, false);
    assert.equal(err.retryAfterSeconds, null);
    assert.equal(err.requestId, null);
    assert.equal(err.apiVersion, null);
  });

  it('never carries an apiKey/authorization field under any name', () => {
    const err = new SemidexApiError('x', { status: 401 });
    const keys = Object.keys(err);
    for (const forbidden of ['apiKey', 'authorization', 'token', 'Authorization']) {
      assert.ok(!keys.includes(forbidden), `SemidexApiError must never carry a "${forbidden}" field`);
    }
  });
});

describe('errorFromBody() — pre-stream JSON `{ error: {...} }` envelope', () => {
  it('extracts every documented field', () => {
    const err = errorFromBody({ error: { apiVersion: 'v1', code: 'not_found', message: 'no such collection', retryable: false } }, { status: 404 });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
    assert.equal(err.message, 'no such collection');
    assert.equal(err.retryable, false);
    assert.equal(err.apiVersion, 'v1');
  });

  it('falls back to a synthetic message for a missing/malformed body rather than throwing', () => {
    for (const body of [null, undefined, {}, 'not an object', 42, { error: 'not an object' }]) {
      const err = errorFromBody(body, { status: 500 });
      assert.ok(err instanceof SemidexApiError);
      assert.match(err.message, /HTTP 500/);
      assert.equal(err.code, null);
    }
  });

  it('prefers Retry-After/requestId passed by the caller (HTTP headers) when the body omits them', () => {
    const err = errorFromBody({ error: { code: 'rate_limited', message: 'slow down' } }, { status: 429, retryAfterSeconds: 7, requestId: 'req-123' });
    assert.equal(err.retryAfterSeconds, 7);
    assert.equal(err.requestId, 'req-123');
  });

  it('prefers a body-level retryAfterSeconds/requestId over the header fallback when both are present', () => {
    const err = errorFromBody(
      { error: { code: 'rate_limited', message: 'slow down', retryAfterSeconds: 2, requestId: 'body-req' } },
      { status: 429, retryAfterSeconds: 99, requestId: 'header-req' },
    );
    assert.equal(err.retryAfterSeconds, 2);
    assert.equal(err.requestId, 'body-req');
  });
});

describe('errorFromPayload() — terminal SSE `error` event payload (already unwrapped)', () => {
  it('extracts every documented field directly (no { error: ... } wrapper)', () => {
    const err = errorFromPayload({ apiVersion: 'v1', code: 'generation_failed', message: 'model unavailable', retryable: true }, { status: 200 });
    assert.equal(err.code, 'generation_failed');
    assert.equal(err.message, 'model unavailable');
    assert.equal(err.retryable, true);
    assert.equal(err.apiVersion, 'v1');
  });

  it('falls back to a synthetic message for a malformed payload rather than throwing', () => {
    const err = errorFromPayload(null, { status: 200 });
    assert.ok(err instanceof SemidexApiError);
    assert.match(err.message, /HTTP 200/);
  });
});
