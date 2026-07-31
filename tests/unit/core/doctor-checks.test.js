import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseErrorMessage } from '../../../src/core/doctor-checks.js';

test('sanitiseErrorMessage — single secret (string) is redacted, backward compatible', () => {
  const out = sanitiseErrorMessage('request failed: key=sk-abc123 rejected', 'sk-abc123');
  assert.equal(out, 'request failed: key=[REDACTED] rejected');
});

test('sanitiseErrorMessage — two secrets (array) are both redacted in one call', () => {
  const msg = 'Qdrant key sk-qdrant-1 rejected; Gemini key gm-key-2 also rejected';
  const out = sanitiseErrorMessage(msg, ['sk-qdrant-1', 'gm-key-2']);
  assert.equal(out, 'Qdrant key [REDACTED] rejected; Gemini key [REDACTED] also rejected');
  assert.ok(!out.includes('sk-qdrant-1'));
  assert.ok(!out.includes('gm-key-2'));
});

test('sanitiseErrorMessage — array with one secret unset (falsy) skips it without throwing', () => {
  const out = sanitiseErrorMessage('key sk-qdrant-1 present', ['sk-qdrant-1', undefined]);
  assert.equal(out, 'key [REDACTED] present');
});

test('sanitiseErrorMessage — array of all-falsy secrets leaves message unchanged (URL step still applies)', () => {
  const out = sanitiseErrorMessage('plain message, no secrets', [undefined, null, '']);
  assert.equal(out, 'plain message, no secrets');
});

test('sanitiseErrorMessage — still strips credentialed/query URLs after multi-secret redaction', () => {
  const msg = 'failed calling https://user:sk-qdrant-1@cluster.example.com/path?token=gm-key-2';
  const out = sanitiseErrorMessage(msg, ['sk-qdrant-1', 'gm-key-2']);
  assert.equal(out, 'failed calling https://cluster.example.com');
});

test('sanitiseErrorMessage — empty/null message returns empty string regardless of secret shape', () => {
  assert.equal(sanitiseErrorMessage('', ['a', 'b']), '');
  assert.equal(sanitiseErrorMessage(null, ['a', 'b']), '');
  assert.equal(sanitiseErrorMessage(undefined), '');
});
