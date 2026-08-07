// core/profiles.mjs — offline, no network. Confirms every
// DETERMINISTIC_INDEXING_ENV_BASE key is pinned identically for both
// profiles (never relying on ambient env absence), SOURCE_ROOT is always
// set explicitly, CUDA only appears when requested for the local
// profile, and provider-combo strings match src/core/env.js's own
// VALID_PROVIDER_COMBOS (imported directly, never a hardcoded copy).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DETERMINISTIC_INDEXING_ENV_BASE, LOCAL_PROFILE, CLOUD_PROFILE,
  buildIndexEnv, collectionName, applyDeterministicHarnessEnv, restoreHarnessEnv,
  COLLECTION_PREFIX,
} from './core/profiles.mjs';
import { VALID_PROVIDER_COMBOS } from '../../../src/shared/core/env.js';

describe('DETERMINISTIC_INDEXING_ENV_BASE — every key pinned, never relying on ambient absence', () => {
  const expectedKeys = [
    'TAG_GEN', 'SKELETON_SUMMARY', 'PIPELINE_MODE', 'STAGEA_CONCURRENCY',
    'OLLAMA_STAGE_CONCURRENCY', 'EMBED_STAGE_CONCURRENCY', 'MAX_CHUNK_TOKENS',
    'MIN_CHUNK_TOKENS', 'CHUNK_OVERLAP_TOKENS', 'SKELETON_CARRYOVER_CHARS',
    'HYBRID_PREFETCH_LIMIT', 'RRF_K', 'PRUNE_STALE', 'COMBINED_LLM',
    'FORCE_REINDEX', 'ONNX_EXECUTION_PROVIDER', 'ONNX_CUDA_STRICT',
  ];

  it('declares exactly the expected set of keys', () => {
    assert.deepEqual(Object.keys(DETERMINISTIC_INDEXING_ENV_BASE).sort(), expectedKeys.sort());
  });

  it('every value is a string (env vars are always strings)', () => {
    for (const value of Object.values(DETERMINISTIC_INDEXING_ENV_BASE)) {
      assert.equal(typeof value, 'string');
    }
  });

  it('ONNX_EXECUTION_PROVIDER defaults to cpu, ONNX_CUDA_STRICT to 0 — CUDA is never the ambient/default baseline', () => {
    assert.equal(DETERMINISTIC_INDEXING_ENV_BASE.ONNX_EXECUTION_PROVIDER, 'cpu');
    assert.equal(DETERMINISTIC_INDEXING_ENV_BASE.ONNX_CUDA_STRICT, '0');
  });
});

describe('buildIndexEnv() — both profiles get the full deterministic block + explicit SOURCE_ROOT', () => {
  const runCtx = { materializedDir: '/abs/path/to/materialized' };

  it('local profile env contains every pinned key with its exact value, plus provider selection', () => {
    const env = buildIndexEnv(LOCAL_PROFILE, 'my-collection', runCtx);
    for (const [key, value] of Object.entries(DETERMINISTIC_INDEXING_ENV_BASE)) {
      if (key === 'ONNX_EXECUTION_PROVIDER' || key === 'ONNX_CUDA_STRICT') continue; // asserted separately below
      assert.equal(env[key], value, `expected pinned value for ${key}`);
    }
    assert.equal(env.DENSE_PROVIDER, 'bge-m3-onnx');
    assert.equal(env.SPARSE_PROVIDER, 'bge-m3-onnx');
    assert.equal(env.COLLECTION, 'my-collection');
    assert.equal(env.SOURCE_ROOT, '/abs/path/to/materialized');
  });

  it('cloud profile env contains every pinned key, plus provider selection and dense model', () => {
    const env = buildIndexEnv(CLOUD_PROFILE, 'my-collection', runCtx);
    for (const [key, value] of Object.entries(DETERMINISTIC_INDEXING_ENV_BASE)) {
      assert.equal(env[key], value, `expected pinned value for ${key}`);
    }
    assert.equal(env.DENSE_PROVIDER, 'qdrant-cloud');
    assert.equal(env.SPARSE_PROVIDER, 'qdrant-cloud');
    assert.equal(env.QDRANT_CLOUD_DENSE_MODEL, 'intfloat/multilingual-e5-small');
  });

  it('SOURCE_ROOT is always the exact materializedDir passed in — never left unset for CWD-relative resolution', () => {
    const env = buildIndexEnv(LOCAL_PROFILE, 'c', { materializedDir: '/some/other/dir' });
    assert.equal(env.SOURCE_ROOT, '/some/other/dir');
  });

  it('CUDA env only appears when cuda:true AND profile is local — never for cloud, never by default', () => {
    const localNoCuda = buildIndexEnv(LOCAL_PROFILE, 'c', runCtx);
    assert.equal(localNoCuda.ONNX_EXECUTION_PROVIDER, 'cpu');
    assert.equal(localNoCuda.ONNX_CUDA_STRICT, '0');

    const localCuda = buildIndexEnv(LOCAL_PROFILE, 'c', runCtx, { cuda: true });
    assert.equal(localCuda.ONNX_EXECUTION_PROVIDER, 'cuda');
    assert.equal(localCuda.ONNX_CUDA_STRICT, '1');

    const cloudCuda = buildIndexEnv(CLOUD_PROFILE, 'c', runCtx, { cuda: true });
    assert.equal(cloudCuda.ONNX_EXECUTION_PROVIDER, 'cpu', 'cuda:true must be a no-op for the cloud profile — it has no local ONNX execution at all');
    assert.equal(cloudCuda.ONNX_CUDA_STRICT, '0');
  });
});

describe('applyDeterministicHarnessEnv() / restoreHarnessEnv() — harness process env for in-process query calls', () => {
  it('sets HYBRID_PREFETCH_LIMIT/RRF_K on process.env and restores the exact prior value afterward', () => {
    const savedPrefetch = process.env.HYBRID_PREFETCH_LIMIT;
    const savedRrfK = process.env.RRF_K;
    try {
      delete process.env.HYBRID_PREFETCH_LIMIT;
      process.env.RRF_K = '99';
      const restoreState = applyDeterministicHarnessEnv();
      assert.equal(process.env.HYBRID_PREFETCH_LIMIT, '2');
      assert.equal(process.env.RRF_K, '60');
      restoreHarnessEnv(restoreState);
      assert.equal(process.env.HYBRID_PREFETCH_LIMIT, undefined);
      assert.equal(process.env.RRF_K, '99');
    } finally {
      if (savedPrefetch === undefined) delete process.env.HYBRID_PREFETCH_LIMIT;
      else process.env.HYBRID_PREFETCH_LIMIT = savedPrefetch;
      if (savedRrfK === undefined) delete process.env.RRF_K;
      else process.env.RRF_K = savedRrfK;
    }
  });
});

describe('collectionName() — deterministic, owned-prefix collection naming', () => {
  it('builds a name starting with COLLECTION_PREFIX, embedding suite/profile/runSuffix', () => {
    const name = collectionName('scifact', 'cloud', 'abc123');
    assert.ok(name.startsWith(COLLECTION_PREFIX));
    assert.match(name, /scifact/);
    assert.match(name, /cloud/);
    assert.match(name, /abc123/);
  });

  it('is a pure function — same inputs always produce the same name (needed for resume to relocate a prior run\'s collection)', () => {
    assert.equal(collectionName('miracl-ru', 'local', 'xyz'), collectionName('miracl-ru', 'local', 'xyz'));
  });
});

describe('provider-combo strings match src/core/env.js\'s own VALID_PROVIDER_COMBOS', () => {
  it('local profile combo is valid', () => {
    assert.ok(VALID_PROVIDER_COMBOS.has(`${LOCAL_PROFILE.env.DENSE_PROVIDER}:${LOCAL_PROFILE.env.SPARSE_PROVIDER}`));
  });
  it('cloud profile combo is valid', () => {
    assert.ok(VALID_PROVIDER_COMBOS.has(`${CLOUD_PROFILE.env.DENSE_PROVIDER}:${CLOUD_PROFILE.env.SPARSE_PROVIDER}`));
  });
});
