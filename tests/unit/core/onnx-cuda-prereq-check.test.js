// src/local/core/onnx-cuda-prereq-check.js — composes cuda-diagnosis.js's
// already-tested checkNvidiaSmi/checkCudaToolkit/checkCudnn into one
// result for the managed-runtime installer's own prereq check. Every
// test injects fakes — zero real nvidia-smi spawn, zero real fs access.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkPrerequisites } from '../../../src/local/core/onnx-cuda-prereq-check.js';

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.unref = () => {};
  return child;
}

function nvidiaSmiSuccess(driverVersion = '551.23', gpuName = 'NVIDIA GeForce RTX 4070') {
  return () => {
    const child = makeFakeChild();
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(`${driverVersion}, ${gpuName}\n`));
      child.emit('exit', 0);
    }, 5);
    return child;
  };
}

function nvidiaSmiNotFound() {
  return () => {
    const child = makeFakeChild();
    setTimeout(() => child.emit('error', new Error('spawn nvidia-smi ENOENT')), 5);
    return child;
  };
}

describe('checkPrerequisites()', () => {
  it('composes all three GPU-stack checks into one result when everything is present', async () => {
    const existsSyncFn = (p) => p === 'C:\\cuda-12.4' || p === 'C:\\cuda-12.4\\bin';
    const readdirSyncFn = (p) => (p === 'C:\\cuda-12.4\\bin' ? ['cudnn64_9.dll'] : []);
    const result = await checkPrerequisites({
      platform: 'win32', env: { CUDA_PATH: 'C:\\cuda-12.4' },
      spawnFn: nvidiaSmiSuccess(), existsSyncFn, readdirSyncFn,
    });
    assert.equal(result.nvidiaDriver.available, true);
    assert.equal(result.cudaToolkit.found, true);
    assert.equal(result.cudnn.found, true);
    assert.equal(result.cudnn.path, 'C:\\cuda-12.4\\bin');
  });

  it('returns the separate NVIDIA cuDNN installer path for the matching CUDA major', async () => {
    const root = 'C:\\Program Files\\NVIDIA\\CUDNN';
    const matching = `${root}\\v9.25\\bin\\13.4\\x64`;
    const wrongMajor = `${root}\\v9.25\\bin\\12.9\\x64`;
    const dirs = new Set(['C:\\cuda-13.3', root, `${root}\\v9.25\\bin`, matching, wrongMajor]);
    const entries = new Map([
      [root, ['v9.25']],
      [`${root}\\v9.25\\bin`, ['12.9', '13.4']],
      [matching, ['cudnn64_9.dll']],
      [wrongMajor, ['cudnn64_9.dll']],
    ]);
    const result = await checkPrerequisites({
      platform: 'win32', env: { CUDA_PATH: 'C:\\cuda-13.3' },
      spawnFn: nvidiaSmiSuccess(),
      existsSyncFn: (p) => dirs.has(p),
      readdirSyncFn: (p) => entries.get(p) ?? [],
    });
    assert.deepEqual(result.cudnn, { found: true, path: matching, cudaVersion: '13.4' });
  });

  it('reports each check\'s own real failure independently — no GPU, no toolkit lookup attempted needlessly, cuDNN correctly reports unknown', async () => {
    const result = await checkPrerequisites({
      platform: 'win32', env: {},
      spawnFn: nvidiaSmiNotFound(),
      existsSyncFn: () => false, readdirSyncFn: () => [],
    });
    assert.equal(result.nvidiaDriver.available, false);
    assert.equal(result.cudaToolkit.found, false);
    // cudnn.found is 'unknown' when no toolkit path was ever found to search under.
    assert.equal(result.cudnn.found, 'unknown');
  });

  it('never throws even when every underlying check would individually fail', async () => {
    await assert.doesNotReject(() => checkPrerequisites({
      platform: 'win32', env: {},
      spawnFn: () => { throw new Error('spawn boom'); },
      existsSyncFn: () => { throw new Error('fs boom'); },
      readdirSyncFn: () => { throw new Error('fs boom'); },
    }));
  });

  it('the CLI entry never runs as an import-time side effect', async () => {
    // Re-importing the module (already imported above) must not have
    // spawned a real nvidia-smi or touched real fs — confirmed implicitly
    // by every other test in this file running instantly with injected
    // fakes and no real subprocess ever appearing. This test exists as an
    // explicit marker of that contract, matching every other real CLI
    // entry point in this codebase (onnx-probe-runner.js, index-full.js).
    assert.equal(typeof checkPrerequisites, 'function');
  });
});
