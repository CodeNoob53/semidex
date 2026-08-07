// Migrated from src/smoke/sections/03-invalid-combo-resolve.js
// node:test runs each file in its own process, so env mutation here cannot
// leak into other test files; before/after still restore for hygiene.
import '../../helpers/setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnvProviders } from '../../../src/shared/core/config.js';

const ENV_KEYS = ['DENSE_PROVIDER', 'SPARSE_PROVIDER', 'DENSE_MODEL', 'EMBED_MODEL', 'ONNX_EMBED', 'QDRANT_CLOUD_DENSE_MODEL', 'QDRANT_SPARSE_MODEL'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveEnvProviders — invalid combinations are rejected', () => {
  it('ollama dense + bge-m3-onnx sparse throws', () => {
    process.env.DENSE_PROVIDER = 'ollama';
    process.env.SPARSE_PROVIDER = 'bge-m3-onnx';
    assert.throws(() => resolveEnvProviders(), /Invalid provider combination/);
  });

  it('bge-m3-onnx dense + hashed-tf sparse throws', () => {
    process.env.DENSE_PROVIDER = 'bge-m3-onnx';
    process.env.SPARSE_PROVIDER = 'hashed-tf';
    assert.throws(() => resolveEnvProviders(), /Invalid provider combination/);
  });

  it('unknown dense provider throws', () => {
    process.env.DENSE_PROVIDER = 'unknown-provider';
    process.env.SPARSE_PROVIDER = 'hashed-tf';
    assert.throws(() => resolveEnvProviders(), /Invalid provider combination/);
  });
});

describe('resolveEnvProviders — valid resolutions', () => {
  it('no env → ollama + hashed-tf default', () => {
    assert.deepEqual(resolveEnvProviders(), {
      denseProvider: 'ollama',
      denseModel: 'bge-m3',
      sparseProvider: 'hashed-tf',
    });
  });

  it('ONNX_EMBED=1 shorthand → bge-m3-onnx for dense and sparse', () => {
    process.env.ONNX_EMBED = '1';
    assert.deepEqual(resolveEnvProviders(), {
      denseProvider: 'bge-m3-onnx',
      denseModel: 'aapot/bge-m3-onnx',
      sparseProvider: 'bge-m3-onnx',
    });
  });

  it('explicit DENSE_PROVIDER=bge-m3-onnx pins the ONNX model', () => {
    process.env.DENSE_PROVIDER = 'bge-m3-onnx';
    process.env.SPARSE_PROVIDER = 'bge-m3-onnx';
    const r = resolveEnvProviders();
    assert.equal(r.denseModel, 'aapot/bge-m3-onnx');
  });
});

// Code review finding: resolveEnvProviders() previously returned no
// sparseModel field at all for the qdrant-cloud case, so
// resolveNewCollectionProfile() (the real indexer CLI path) had no way
// to ever receive anything but its own hardcoded 'qdrant/bm25' fallback.
// These tests pin the fixed contract — mirrors denseModel's own
// env-then-catalog-default resolution.
describe('resolveEnvProviders — qdrant-cloud sparseModel resolution (code review fix)', () => {
  it('DENSE_PROVIDER/SPARSE_PROVIDER=qdrant-cloud with no QDRANT_SPARSE_MODEL set falls back to the first status:supported sparse catalog entry (qdrant/bm25)', () => {
    process.env.DENSE_PROVIDER = 'qdrant-cloud';
    process.env.SPARSE_PROVIDER = 'qdrant-cloud';
    process.env.QDRANT_CLOUD_DENSE_MODEL = 'intfloat/multilingual-e5-small';
    const r = resolveEnvProviders();
    assert.equal(r.denseProvider, 'qdrant-cloud');
    assert.equal(r.sparseProvider, 'qdrant-cloud');
    assert.equal(r.sparseModel, 'qdrant/bm25');
  });

  it('an explicit QDRANT_SPARSE_MODEL env var is honored', () => {
    process.env.DENSE_PROVIDER = 'qdrant-cloud';
    process.env.SPARSE_PROVIDER = 'qdrant-cloud';
    process.env.QDRANT_CLOUD_DENSE_MODEL = 'intfloat/multilingual-e5-small';
    process.env.QDRANT_SPARSE_MODEL = 'qdrant/bm25';
    const r = resolveEnvProviders();
    assert.equal(r.sparseModel, 'qdrant/bm25');
  });

  it('a non-qdrant-cloud provider combination carries no sparseModel field at all (unaffected by this fix)', () => {
    const r = resolveEnvProviders();
    assert.equal('sparseModel' in r, false);
  });
});
