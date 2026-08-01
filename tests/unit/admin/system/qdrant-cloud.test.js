// Thin admin-layer wrapper tests for src/admin/system/qdrant-cloud.js —
// this module now delegates ALL Qdrant-specific work to a StorageAdapter
// (never the raw SDK/client directly, per the src/admin/ layering
// boundary tests/unit/admin/server.test.js enforces), so these tests
// inject a fake adapter rather than monkey-patching QdrantClient.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkQdrantReachable, probeQdrantCloudInference,
  classifyInferenceProbeError, probeModelAvailability,
} from '../../../../src/admin/system/qdrant-cloud.js';

const cloudProfile = {
  embedding: {
    dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
    sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
  },
};

describe('checkQdrantReachable() — thin wrapper over adapter.checkCloudInferenceReachable()', () => {
  it('passes the adapter result through unchanged on success', async () => {
    const adapter = { checkCloudInferenceReachable: async () => ({ status: 'ok' }) };
    const result = await checkQdrantReachable({ adapter });
    assert.deepEqual(result, { status: 'ok' });
  });

  it('redacts QDRANT_KEY from any error message the adapter returns', async () => {
    const originalKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'super-secret-key';
    try {
      const adapter = { checkCloudInferenceReachable: async () => ({ status: 'unreachable', message: 'failed with key super-secret-key' }) };
      const result = await checkQdrantReachable({ adapter });
      assert.ok(!result.message.includes('super-secret-key'));
      assert.match(result.message, /REDACTED/);
    } finally {
      if (originalKey === undefined) delete process.env.QDRANT_KEY; else process.env.QDRANT_KEY = originalKey;
    }
  });

  it('never calls anything Qdrant-SDK-shaped itself — only the injected adapter', async () => {
    let called = false;
    const adapter = { checkCloudInferenceReachable: async () => { called = true; return { status: 'ok' }; } };
    await checkQdrantReachable({ adapter });
    assert.equal(called, true);
  });
});

describe('probeQdrantCloudInference() — thin wrapper over adapter.probeInference()', () => {
  it('passes the profile straight through to adapter.probeInference()', async () => {
    let received;
    const adapter = { probeInference: async (opts) => { received = opts; return { status: 'inference_available' }; } };
    const result = await probeQdrantCloudInference({ profile: cloudProfile, adapter });
    assert.deepEqual(result, { status: 'inference_available' });
    assert.deepEqual(received.profile, cloudProfile);
  });

  it('redacts QDRANT_KEY from an inference_disabled_or_model_unavailable message', async () => {
    const originalKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'super-secret-key';
    try {
      const adapter = { probeInference: async () => ({ status: 'inference_disabled_or_model_unavailable', message: 'key=super-secret-key model not found' }) };
      const result = await probeQdrantCloudInference({ profile: cloudProfile, adapter });
      assert.ok(!result.message.includes('super-secret-key'));
    } finally {
      if (originalKey === undefined) delete process.env.QDRANT_KEY; else process.env.QDRANT_KEY = originalKey;
    }
  });

  it('surfaces { status: "unsupported" } from an adapter with no cloud-inference capability, without special-casing it', async () => {
    const adapter = { probeInference: async () => ({ status: 'unsupported', message: 'not a qdrant-cloud profile' }) };
    const result = await probeQdrantCloudInference({ profile: cloudProfile, adapter });
    assert.equal(result.status, 'unsupported');
  });

  it('this module never imports the Qdrant SDK/client/store directly — only createStorageAdapter and sanitiseErrorMessage', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../../src/admin/system/qdrant-cloud.js', import.meta.url)), 'utf-8');
    assert.ok(!/@qdrant\/js-client-rest/.test(src));
    assert.ok(!/core\/qdrant\/(client|store)\.js/.test(src));
  });
});

// classifyInferenceProbeError()/probeModelAvailability() — the settings-
// time (not existing-collection) 4-status availability classification.
// The exact input message shapes below are taken verbatim from a live
// probe against a real Qdrant Cloud cluster on 2026-08-01 (see
// docs/design/qdrant-cloud-inference-model-research-2026-08-01.md) — not
// invented strings.
describe('classifyInferenceProbeError() — 4-status classification', () => {
  it('a successful inference_available result classifies as available, with no message', () => {
    const result = classifyInferenceProbeError({ result: { status: 'inference_available' } });
    assert.deepEqual(result, { status: 'available', message: null });
  });

  it('a live-observed tier-gated 401 (rethrown Error, never a typed probeInference() result) classifies as unavailable_for_cluster', () => {
    const error = new Error('Service internal error: Authentication failed for inference service (401 Unauthorized): {"error":"This model: mixedbread-ai/mxbai-embed-large-v1 is not allowed in free tier"}');
    const result = classifyInferenceProbeError({ error });
    assert.equal(result.status, 'unavailable_for_cluster');
    assert.match(result.message, /not allowed in free tier/);
  });

  it('a live-observed "Unsupported model" 400 classifies as unsupported_by_semidex, whether typed-returned or thrown', () => {
    const typed = classifyInferenceProbeError({
      result: { status: 'inference_disabled_or_model_unavailable', message: 'Bad request: Inference request validation failed: Unsupported model: qdrant/splade_pp_en_v1' },
    });
    assert.equal(typed.status, 'unsupported_by_semidex');

    const thrown = classifyInferenceProbeError({
      error: new Error('Bad request: Inference request validation failed: Unsupported model: qdrant/splade_pp_en_v1'),
    });
    assert.equal(thrown.status, 'unsupported_by_semidex');
  });

  it('an unrelated network/auth failure classifies as unverified, never guessed as one of the two specific statuses', () => {
    const result = classifyInferenceProbeError({ error: new Error('ECONNREFUSED: connection refused') });
    assert.equal(result.status, 'unverified');
  });

  it('a typed inference_disabled_or_model_unavailable result whose message matches neither specific pattern classifies as unverified, not a guess', () => {
    const result = classifyInferenceProbeError({
      result: { status: 'inference_disabled_or_model_unavailable', message: 'some unrelated inference failure text' },
    });
    assert.equal(result.status, 'unverified');
  });

  it('"tier" appearing in an unrelated sense does not falsely trigger unavailable_for_cluster (pattern requires the exact "not allowed in <word> tier" shape)', () => {
    const result = classifyInferenceProbeError({ error: new Error('rate limit tier exceeded, please retry later') });
    assert.notEqual(result.status, 'unavailable_for_cluster');
  });

  it('QDRANT_KEY is redacted from a thrown error message, matching the typed-result redaction path', () => {
    const originalKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'super-secret-key';
    try {
      const result = classifyInferenceProbeError({ error: new Error('failed with key super-secret-key') });
      assert.ok(!result.message.includes('super-secret-key'));
    } finally {
      if (originalKey === undefined) delete process.env.QDRANT_KEY; else process.env.QDRANT_KEY = originalKey;
    }
  });
});

describe('probeModelAvailability() — settings-time probe, no collection yet', () => {
  it('classifies a successful adapter round-trip as available', async () => {
    const adapter = { probeInference: async () => ({ status: 'inference_available' }) };
    const result = await probeModelAvailability({ profile: cloudProfile, adapter });
    assert.deepEqual(result, { status: 'available', message: null });
  });

  it('classifies an adapter THROW (not just a typed return) via the same 4-status logic — the tier-gated case genuinely throws', async () => {
    const adapter = { probeInference: async () => { throw new Error('This model: x is not allowed in free tier'); } };
    const result = await probeModelAvailability({ profile: cloudProfile, adapter });
    assert.equal(result.status, 'unavailable_for_cluster');
  });

  it('never throws itself — always resolves to a typed { status, message } result', async () => {
    const adapter = { probeInference: async () => { throw new Error('anything at all'); } };
    await assert.doesNotReject(() => probeModelAvailability({ profile: cloudProfile, adapter }));
  });
});
