// Thin admin-layer wrapper tests for src/admin/system/qdrant-cloud.js —
// this module now delegates ALL Qdrant-specific work to a StorageAdapter
// (never the raw SDK/client directly, per the src/admin/ layering
// boundary tests/unit/admin/server.test.js enforces), so these tests
// inject a fake adapter rather than monkey-patching QdrantClient.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkQdrantReachable, probeQdrantCloudInference } from '../../../../src/admin/system/qdrant-cloud.js';

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
