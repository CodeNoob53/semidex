// local/core/cuda-diagnosis.js — diagnoseCudaFailure() runs real system
// checks (nvidia-smi, CUDA_PATH/toolkit dir, cuDNN DLL presence) to explain
// WHY a CUDA ONNX probe failed. Every test injects a fake `spawnFn`
// (EventEmitter-shaped, mirroring tests/unit/admin/system.test.js's
// pickFolder() pattern — a quick one-shot CLI call, not a long-running
// child) and stubbed existsSyncFn/readdirSyncFn — never a real nvidia-smi
// spawn, never real filesystem access.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { diagnoseCudaFailure, checkCudaToolkit, checkCudnn } from '../../../src/local/core/cuda-diagnosis.js';

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

function nvidiaSmiNoGpu() {
  return () => {
    const child = makeFakeChild();
    setTimeout(() => child.emit('exit', 1), 5);
    return child;
  };
}

const NO_TOOLKIT_FS = { existsSyncFn: () => false, readdirSyncFn: () => [] };

describe('diagnoseCudaFailure', () => {
  it('nvidia-smi ENOENT (not on PATH at all) -> reason no_driver', async () => {
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiNotFound(), platform: 'win32', env: {}, ...NO_TOOLKIT_FS,
    });
    assert.equal(result.reason, 'no_driver');
    assert.match(result.details, /not found on PATH/);
    assert.ok(result.nextSteps.length > 0);
  });

  it('nvidia-smi runs but reports zero GPUs (non-zero exit) -> reason no_gpu', async () => {
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiNoGpu(), platform: 'win32', env: {}, ...NO_TOOLKIT_FS,
    });
    assert.equal(result.reason, 'no_gpu');
    assert.match(result.details, /zero NVIDIA GPUs/);
    assert.ok(result.nextSteps.length > 0);
  });

  it('nvidia-smi times out -> reason no_driver, details mention timeout, never throws', async () => {
    const neverEmits = () => makeFakeChild(); // never emits exit/error/data
    const result = await diagnoseCudaFailure({
      spawnFn: neverEmits, platform: 'win32', env: {}, timeoutMs: 20, ...NO_TOOLKIT_FS,
    });
    assert.equal(result.reason, 'no_driver');
    assert.match(result.details, /timeout|did not respond/);
  });

  it('GPU+driver present, CUDA_PATH unset and no toolkit dir found -> reason no_cuda_toolkit', async () => {
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiSuccess(), platform: 'win32', env: {},
      existsSyncFn: () => false, readdirSyncFn: () => [],
    });
    assert.equal(result.reason, 'no_cuda_toolkit');
    assert.match(result.details, /551\.23/);
    assert.match(result.details, /RTX 4070/);
  });

  it('toolkit dir found via CUDA_PATH env, cuDNN DLL absent -> reason no_cudnn', async () => {
    const existsSyncFn = (p) => p === 'C:\\cuda-12.4' || p === 'C:\\cuda-12.4\\bin';
    const readdirSyncFn = (p) => (p === 'C:\\cuda-12.4\\bin' ? ['cudart64_124.dll'] : []);
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiSuccess(), platform: 'win32', env: { CUDA_PATH: 'C:\\cuda-12.4' },
      existsSyncFn, readdirSyncFn,
    });
    assert.equal(result.reason, 'no_cudnn');
    assert.match(result.details, /C:\\cuda-12\.4/);
  });

  it('cuDNN absent from the toolkit dir but present under the separate NVIDIA cuDNN installer layout -> still detected, reason no_custom_build not no_cudnn', async () => {
    // Regression: NVIDIA's cuDNN Windows installer does NOT copy the DLL
    // into the CUDA Toolkit's own bin/ — it installs into a completely
    // separate tree, C:\Program Files\NVIDIA\CUDNN\v<version>\bin\
    // <cuda-major.minor>\x64\cudnn64_9.dll (confirmed against a real
    // installed machine: v9.25\bin\13.4\x64\). A check that only looks
    // inside the toolkit directory reports a false "no_cudnn" even when
    // cuDNN genuinely is installed.
    const cudnnRoot = 'C:\\Program Files\\NVIDIA\\CUDNN';
    const existsSyncFn = (p) => (
      p === 'C:\\cuda-13.3'
      || p === cudnnRoot
      || p === `${cudnnRoot}\\v9.25\\bin`
      || p === `${cudnnRoot}\\v9.25\\bin\\13.4\\x64`
    );
    const readdirSyncFn = (p) => {
      if (p === 'C:\\cuda-13.3\\bin') return []; // toolkit's own bin/ — genuinely empty
      if (p === cudnnRoot) return ['v9.25'];
      if (p === `${cudnnRoot}\\v9.25\\bin`) return ['12.9', '13.4'];
      if (p === `${cudnnRoot}\\v9.25\\bin\\13.4\\x64`) return ['cudnn64_9.dll'];
      return [];
    };
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiSuccess(), platform: 'win32', env: { CUDA_PATH: 'C:\\cuda-13.3' },
      existsSyncFn, readdirSyncFn, runtimeSource: 'npm',
    });
    assert.equal(result.reason, 'no_custom_build', 'cuDNN found under the real installer layout must clear the no_cudnn branch entirely');
  });

  it('toolkit + cuDNN present, runtimeSource npm (default package) -> reason no_custom_build', async () => {
    const existsSyncFn = (p) => p === 'C:\\cuda-12.4' || p === 'C:\\cuda-12.4\\bin';
    const readdirSyncFn = (p) => (p === 'C:\\cuda-12.4\\bin' ? ['cudnn64_9.dll'] : []);
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiSuccess(), platform: 'win32', env: { CUDA_PATH: 'C:\\cuda-12.4' },
      existsSyncFn, readdirSyncFn, runtimeSource: 'npm',
    });
    assert.equal(result.reason, 'no_custom_build');
    assert.ok(result.nextSteps.some((s) => /ONNXRUNTIME_NODE_PATH/.test(s)));
  });

  it('toolkit + cuDNN present, runtimeSource managed -> does NOT report no_custom_build (a managed build clears this branch just like custom)', async () => {
    const existsSyncFn = (p) => p === 'C:\\cuda-12.4' || p === 'C:\\cuda-12.4\\bin';
    const readdirSyncFn = (p) => (p === 'C:\\cuda-12.4\\bin' ? ['cudnn64_9.dll'] : []);
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiSuccess(), platform: 'win32', env: { CUDA_PATH: 'C:\\cuda-12.4' },
      existsSyncFn, readdirSyncFn, runtimeSource: 'managed',
      errMessage: 'some genuinely unrecognized failure',
    });
    assert.notEqual(result.reason, 'no_custom_build');
    assert.equal(result.reason, 'unknown');
  });

  it('toolkit + cuDNN + managed build all present, version-shaped ORT error -> reason version_mismatch, nextSteps point at re-running the installer, not "check your custom build"', async () => {
    const existsSyncFn = (p) => p === 'C:\\cuda-12.4' || p === 'C:\\cuda-12.4\\bin';
    const readdirSyncFn = (p) => (p === 'C:\\cuda-12.4\\bin' ? ['cudnn64_9.dll'] : []);
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiSuccess(), platform: 'win32', env: { CUDA_PATH: 'C:\\cuda-12.4' },
      existsSyncFn, readdirSyncFn, runtimeSource: 'managed',
      errMessage: 'cuDNN version 8 does not match the version this build expects',
    });
    assert.equal(result.reason, 'version_mismatch');
    assert.ok(result.nextSteps.some((s) => /install-onnxruntime-cuda-windows\.ps1/.test(s)));
  });

  it('toolkit + cuDNN + custom build all present, version-shaped ORT error -> reason version_mismatch', async () => {
    const existsSyncFn = (p) => p === 'C:\\cuda-12.4' || p === 'C:\\cuda-12.4\\bin';
    const readdirSyncFn = (p) => (p === 'C:\\cuda-12.4\\bin' ? ['cudnn64_9.dll'] : []);
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiSuccess(), platform: 'win32', env: { CUDA_PATH: 'C:\\cuda-12.4' },
      existsSyncFn, readdirSyncFn, runtimeSource: 'custom',
      errMessage: 'cuDNN version 8 does not match the version this build expects',
    });
    assert.equal(result.reason, 'version_mismatch');
  });

  it('toolkit + cuDNN + custom build present, no recognizable ORT error pattern -> reason unknown, empty nextSteps', async () => {
    const existsSyncFn = (p) => p === 'C:\\cuda-12.4' || p === 'C:\\cuda-12.4\\bin';
    const readdirSyncFn = (p) => (p === 'C:\\cuda-12.4\\bin' ? ['cudnn64_9.dll'] : []);
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiSuccess(), platform: 'win32', env: { CUDA_PATH: 'C:\\cuda-12.4' },
      existsSyncFn, readdirSyncFn, runtimeSource: 'custom',
      errMessage: 'some genuinely unrecognized failure',
    });
    assert.equal(result.reason, 'unknown');
    assert.deepEqual(result.nextSteps, []);
    assert.ok(result.details.length > 0, 'unknown must still report the raw gathered signal, never an empty details string');
  });

  it('never fabricates nextSteps for reason unknown even when every check individually throws', async () => {
    const throwingSpawn = () => { throw new Error('spawn boom'); };
    const throwingExists = () => { throw new Error('fs boom'); };
    const throwingReaddir = () => { throw new Error('fs boom'); };
    const result = await diagnoseCudaFailure({
      spawnFn: throwingSpawn, platform: 'win32', env: {},
      existsSyncFn: throwingExists, readdirSyncFn: throwingReaddir,
    });
    // A throwing spawnFn for nvidia-smi is itself caught and degrades to
    // no_driver (a known, meaningful reason) — not "unknown" — proving the
    // per-check isolation contract: one check's crash never aborts the
    // whole diagnosis or the caller's await.
    assert.equal(result.reason, 'no_driver');
    assert.ok(Array.isArray(result.nextSteps));
  });

  it('never throws or rejects on a non-Windows platform — stays total, unlike pickFolder()\'s UNSUPPORTED_PLATFORM reject', async () => {
    await assert.doesNotReject(() => diagnoseCudaFailure({
      spawnFn: nvidiaSmiSuccess(), platform: 'linux', env: {},
      existsSyncFn: () => false, readdirSyncFn: () => { throw new Error('ENOENT'); },
    }));
    const result = await diagnoseCudaFailure({
      spawnFn: nvidiaSmiSuccess(), platform: 'linux', env: {},
      existsSyncFn: () => false, readdirSyncFn: () => { throw new Error('ENOENT'); },
    });
    assert.equal(result.reason, 'no_cuda_toolkit');
  });

  it('a catastrophic unexpected error anywhere in the pipeline resolves to reason unknown, never rejects', async () => {
    // errMessage as a non-string forces classifyOrtError's internal
    // String() coercion path to still behave, but this test's real intent
    // is documented in the module's own outer try/catch — asserting the
    // outer contract directly via a spawnFn that returns something
    // shaped incorrectly enough to throw during property access.
    const brokenChild = null;
    const spawnFn = () => brokenChild;
    await assert.doesNotReject(() => diagnoseCudaFailure({ spawnFn, platform: 'win32', env: {} }));
  });

  it('spawns nvidia-smi with windowsHide: true and the expected query args', async () => {
    const calls = [];
    const spawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const child = makeFakeChild();
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('551.23, NVIDIA GeForce RTX 4070\n'));
        child.emit('exit', 0);
      }, 5);
      return child;
    };
    await diagnoseCudaFailure({ spawnFn, platform: 'win32', env: {}, ...NO_TOOLKIT_FS });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'nvidia-smi');
    assert.equal(calls[0].opts?.windowsHide, true);
    assert.ok(calls[0].args.some((a) => /query-gpu/.test(a)));
  });

  it('respects a bounded timeoutMs for the nvidia-smi spawn', async () => {
    const start = Date.now();
    const neverEmits = () => makeFakeChild();
    await diagnoseCudaFailure({ spawnFn: neverEmits, platform: 'win32', env: {}, timeoutMs: 30, ...NO_TOOLKIT_FS });
    assert.ok(Date.now() - start < 1000, 'must resolve quickly once the bounded timeout elapses, not hang');
  });
});

// Code review finding: checkCudaToolkit()/checkCudnn() take `platform` as
// an explicit PARAMETER (defaulted to os.platform(), but always
// overridable — every test above passes platform: 'win32' regardless of
// the actual host OS, since CI runs ubuntu-latest — see
// .github/workflows/*.yml). The module used to call the OS-native
// node:path join() unconditionally; on a Linux CI runner, joining
// 'C:\Program Files\NVIDIA\CUDNN' (a literal, backslash-containing string
// — WINDOWS_CUDNN_ROOT/WINDOWS_TOOLKIT_ROOT) with posix.join() produces a
// mixed-separator path like '...CUDNN/v9.25/bin' that never matches a
// real Windows path shape — so existsSyncFn()/readdirSyncFn() checks
// (and the fake ones these tests inject) silently fail to find files that
// genuinely "exist" in the fake filesystem, exactly the same bug class
// already fixed in managed-runtime-id.js/managed-onnx-runtime-manifest.js/
// onnx-runtime-source-resolution.js earlier in this codebase's history.
// These tests call the lower-level functions DIRECTLY (not through
// diagnoseCudaFailure()) and assert on the exact returned `path` string,
// which is the one place a wrong join() separator would be directly
// observable regardless of which OS actually runs the test.
describe('checkCudaToolkit() / checkCudnn() — platform-parameter-driven path joining, independent of the actual host OS', () => {
  it('checkCudaToolkit(platform: "win32") returns a backslash-joined Windows path, never a mixed-separator one', () => {
    const existsSyncFn = (p) => p === 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
    const readdirSyncFn = (p) => (p === 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA' ? ['v12.4'] : []);
    const result = checkCudaToolkit({ env: {}, existsSyncFn, readdirSyncFn, platform: 'win32' });
    assert.equal(result.found, true);
    assert.equal(result.path, 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.4');
    assert.doesNotMatch(result.path, /\//, 'a win32-platform result must never contain a forward slash from an accidental posix join()');
  });

  it('checkCudaToolkit(platform: "linux") returns a forward-slash-joined Linux path', () => {
    const existsSyncFn = (p) => p === '/usr/local/cuda-12.4';
    const readdirSyncFn = (p) => (p === '/usr/local' ? ['cuda-12.4'] : []);
    const result = checkCudaToolkit({ env: {}, existsSyncFn, readdirSyncFn, platform: 'linux' });
    assert.equal(result.found, true);
    assert.equal(result.path, '/usr/local/cuda-12.4');
    assert.doesNotMatch(result.path, /\\/, 'a linux-platform result must never contain a backslash');
  });

  it('checkCudnn(platform: "win32") — toolkit-directory-relative path is a real backslash-joined Windows path', () => {
    const existsSyncFn = (p) => p === 'C:\\cuda-12.4\\bin';
    const readdirSyncFn = (p) => (p === 'C:\\cuda-12.4\\bin' ? ['cudnn64_9.dll'] : []);
    const result = checkCudnn({ cudaToolkitPath: 'C:\\cuda-12.4', existsSyncFn, readdirSyncFn, platform: 'win32' });
    assert.equal(result.found, true);
    assert.equal(result.path, 'C:\\cuda-12.4\\bin');
  });

  it('checkCudnn(platform: "win32") — the separate NVIDIA cuDNN installer layout resolves through THREE nested win32 joins, each one correctly backslash-separated', () => {
    // The exact scenario the reason-classification test above (line ~100)
    // exercises indirectly through diagnoseCudaFailure() — this test
    // isolates checkCudnn() itself and asserts on the literal path string,
    // which a broken join() would have silently produced with forward
    // slashes on any non-Windows host, causing every existsSyncFn/
    // readdirSyncFn lookup below the first join() to miss.
    const cudnnRoot = 'C:\\Program Files\\NVIDIA\\CUDNN';
    const existsSyncFn = (p) => (
      p === 'C:\\cuda-13.3\\bin'
      || p === cudnnRoot
      || p === `${cudnnRoot}\\v9.25\\bin`
      || p === `${cudnnRoot}\\v9.25\\bin\\13.4\\x64`
    );
    const readdirSyncFn = (p) => {
      if (p === 'C:\\cuda-13.3\\bin') return [];
      if (p === cudnnRoot) return ['v9.25'];
      if (p === `${cudnnRoot}\\v9.25\\bin`) return ['13.4'];
      if (p === `${cudnnRoot}\\v9.25\\bin\\13.4\\x64`) return ['cudnn64_9.dll'];
      return [];
    };
    const result = checkCudnn({ cudaToolkitPath: 'C:\\cuda-13.3', existsSyncFn, readdirSyncFn, platform: 'win32' });
    assert.equal(result.found, true);
    assert.equal(result.path, `${cudnnRoot}\\v9.25\\bin\\13.4\\x64`);
    assert.doesNotMatch(result.path, /\//, 'every join() in this three-level nested lookup must stay win32-separated, regardless of host OS');
  });

  it('checkCudnn(platform: "linux") — toolkit-directory-relative lib64 path is forward-slash-joined', () => {
    const existsSyncFn = (p) => p === '/usr/local/cuda-12.4/lib64';
    const readdirSyncFn = (p) => (p === '/usr/local/cuda-12.4/lib64' ? ['libcudnn.so.9'] : []);
    const result = checkCudnn({ cudaToolkitPath: '/usr/local/cuda-12.4', existsSyncFn, readdirSyncFn, platform: 'linux' });
    assert.equal(result.found, true);
    assert.equal(result.path, '/usr/local/cuda-12.4/lib64');
  });
});
