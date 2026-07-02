// Migrated from src/smoke/sections/03-invalid-combo-resolve.js
// node:test runs each file in its own process, so env mutation here cannot
// leak into other test files; before/after still restore for hygiene.
import '../../helpers/setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnvProviders } from '../../../src/core/config.js';

const ENV_KEYS = ['DENSE_PROVIDER', 'SPARSE_PROVIDER', 'DENSE_MODEL', 'EMBED_MODEL', 'ONNX_EMBED'];
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
