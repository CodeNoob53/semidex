import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, REGIME, collectionName, COLLECTION_PREFIX } from './miracl-profiles.mjs';

describe('miracl-profiles', () => {
  test('exactly two profiles: local and cloud', () => {
    assert.equal(PROFILES.length, 2);
    assert.deepEqual(PROFILES.map((p) => p.id).sort(), ['cloud', 'local']);
  });

  test('BOTH profiles carry both RRF k=2 and k=60 (unlike the BEIR harness, where only cloud got both)', () => {
    for (const profile of PROFILES) {
      assert.deepEqual([...profile.rrfKs].sort((a, b) => a - b), [2, 60]);
    }
  });

  test('only the common-512 regime is defined for this first MIRACL run', () => {
    assert.equal(REGIME, 'common-512');
  });

  test('local profile uses the shared ONNX_DENSE_MODEL_ID, not a re-hardcoded literal', () => {
    const local = PROFILES.find((p) => p.id === 'local');
    assert.equal(local.denseModelId, 'aapot/bge-m3-onnx');
    assert.equal(local.denseSize, 1024);
  });

  test('cloud profile uses E5-small (384-dim) dense + qdrant/bm25 sparse', () => {
    const cloud = PROFILES.find((p) => p.id === 'cloud');
    assert.equal(cloud.denseModelId, 'intfloat/multilingual-e5-small');
    assert.equal(cloud.denseSize, 384);
    assert.equal(cloud.sparseModelId, 'qdrant/bm25');
  });

  test('collectionName always starts with the guarded MIRACL prefix', () => {
    const name = collectionName('local', 'abc123');
    assert.ok(name.startsWith(COLLECTION_PREFIX));
    assert.equal(name, 'semidex-miracl-ru-local-abc123');
  });
});
