import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseErrorMessage, formatCudaDiagnosis } from '../../../src/shared/core/doctor-checks.js';

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

// formatCudaDiagnosis() — renders local/core/cuda-diagnosis.js's own
// { reason, details, nextSteps } shape into a doctor detail string. This
// file stays pure/zero-I/O (per its own header comment) — the real
// nvidia-smi/filesystem checks live in cuda-diagnosis.js, never here.

test('formatCudaDiagnosis — a full diagnosis renders details plus each nextSteps entry as an indented bullet', () => {
  const diagnosis = {
    reason: 'no_cuda_toolkit',
    details: 'GPU driver 551.23 detected (RTX 4070); CUDA_PATH not set.',
    nextSteps: ['Install the CUDA Toolkit.', 'Set CUDA_PATH.'],
  };
  const out = formatCudaDiagnosis(diagnosis);
  assert.match(out, /GPU driver 551\.23 detected \(RTX 4070\); CUDA_PATH not set\./);
  assert.match(out, /- Install the CUDA Toolkit\./);
  assert.match(out, /- Set CUDA_PATH\./);
  // Indentation matches formatResult()'s own convention (13 spaces before
  // the continuation, mirroring formatCudaProbeFailure()'s existing shape).
  assert.match(out, /\n {13}- Install the CUDA Toolkit\./);
});

test('formatCudaDiagnosis — an empty nextSteps array (the unknown-reason case) still includes details, no stray bullet artifacts', () => {
  const diagnosis = { reason: 'unknown', details: 'Everything checked out but the probe still failed.', nextSteps: [] };
  const out = formatCudaDiagnosis(diagnosis);
  assert.equal(out, 'Everything checked out but the probe still failed.');
  assert.ok(!out.includes('- '), 'no stray bullet marker when nextSteps is empty');
});

test('formatCudaDiagnosis — null/undefined diagnosis returns an empty string, so callers fall back to formatCudaProbeFailure()', () => {
  assert.equal(formatCudaDiagnosis(null), '');
  assert.equal(formatCudaDiagnosis(undefined), '');
});
