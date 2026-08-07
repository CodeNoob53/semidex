// CUDA guided-setup diagnostic — runs REAL system checks (nvidia-smi,
// CUDA_PATH/toolkit-directory presence, cuDNN DLL presence) to explain
// WHY a CUDA ONNX provider probe failed, beyond the raw ORT error string
// (e.g. "no available backend found. ERR: [cuda] backend not found.").
// Diagnosis + instructions only — never downloads/installs anything, never
// scans for and auto-fills ONNXRUNTIME_NODE_PATH.
//
// Runs in the PARENT process (doctor.js / the Admin API route handler),
// never inside onnx-probe-runner.js's isolated child. nvidia-smi and
// filesystem checks need no ONNX Runtime and no model file — there is no
// "must isolate from the caller" concern here the way there is for
// InferenceSession.create(). Keeping this separate from the probe's own
// child process also means a diagnosis-side spawn/fs issue can never
// disturb onnx-provider-probe.js's own carefully-tuned kill-grace/timeout
// bookkeeping for the ORT session-creation child.
//
// Only ever called AFTER a CUDA probe has already failed (see doctor.js's
// "[F] ONNX / GPU" section and admin/api/onnx.js's registerOnnxRoutes()) —
// never on the DML/CPU happy path, never before/instead of the real probe.
//
// diagnoseCudaFailure() itself NEVER throws/rejects — every internal check
// degrades independently to an "unknown" signal on its own failure (spawn
// ENOENT, fs permission error, timeout), and a truly unexpected error still
// resolves to `{ reason: 'unknown', nextSteps: [] }` rather than rejecting.
// Callers treat this as a pure, always-resolving enrichment of an
// already-failed probe result, never a new failure mode of their own.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform as osPlatform } from 'node:os';

const NVIDIA_SMI_TIMEOUT_MS = 5_000;

function makeChildResult({ available, reason, driverVersion, gpuName }) {
  return available
    ? { available: true, driverVersion, gpuName }
    : { available: false, reason };
}

/**
 * Spawns `nvidia-smi` (a quick one-shot CLI call — not a long-running
 * child, so this mirrors folder-picker.js's pickFolder() spawn shape, not
 * onnx-provider-probe.js's heavier kill-grace/'close'-event pattern, which
 * exists specifically for a longer-lived child).
 *
 * Exported (additive, no behavior change) so the managed-runtime
 * installer's own prereq-check helper (src/local/core/
 * onnx-cuda-prereq-check.js) can reuse this exact detection logic instead
 * of re-implementing GPU-stack checks in PowerShell — avoiding two
 * languages' worth of detection code that could silently drift apart.
 *
 * @returns {Promise<{available: true, driverVersion: string, gpuName: string}
 *   | {available: false, reason: 'not_found'|'no_gpu'|'timeout'|'error'}>}
 */
export function checkNvidiaSmi({ spawnFn = spawn, timeoutMs = NVIDIA_SMI_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(makeChildResult(result));
    };

    let child;
    try {
      child = spawnFn('nvidia-smi', ['--query-gpu=driver_version,name', '--format=csv,noheader'], { windowsHide: true });
    } catch {
      finish({ available: false, reason: 'not_found' });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish({ available: false, reason: 'timeout' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
    child.stderr?.on('data', () => {}); // drained, never inspected — exit code + stdout are enough

    child.on('error', () => {
      clearTimeout(timer);
      finish({ available: false, reason: 'not_found' });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish({ available: false, reason: 'no_gpu' });
        return;
      }
      const line = stdout.trim().split('\n')[0] ?? '';
      const [driverVersion, ...rest] = line.split(',').map((s) => s.trim());
      if (!driverVersion) {
        // nvidia-smi ran and exited 0 but reported no rows — a real,
        // explicit "zero GPUs" signal, distinct from the command not
        // existing at all.
        finish({ available: false, reason: 'no_gpu' });
        return;
      }
      finish({ available: true, driverVersion, gpuName: rest.join(',') || 'unknown' });
    });
  });
}

const WINDOWS_TOOLKIT_ROOT = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
const LINUX_TOOLKIT_ROOTS = ['/usr/local'];

/**
 * Exported (additive, no behavior change) — see checkNvidiaSmi()'s own
 * header comment for why.
 * @returns {{found: true, path: string, version: string|null} | {found: false}}
 */
export function checkCudaToolkit({ env = process.env, existsSyncFn = existsSync, readdirSyncFn = readdirSync, platform = osPlatform() } = {}) {
  const cudaPathEnv = String(env.CUDA_PATH ?? '').trim();
  if (cudaPathEnv) {
    try {
      if (existsSyncFn(cudaPathEnv)) {
        return { found: true, path: cudaPathEnv, version: null };
      }
    } catch { /* fall through to directory scan */ }
  }

  if (platform === 'win32') {
    try {
      if (!existsSyncFn(WINDOWS_TOOLKIT_ROOT)) return { found: false };
      const entries = readdirSyncFn(WINDOWS_TOOLKIT_ROOT);
      // CUDA Toolkit installs as e.g. "v12.4" under this root — pick the
      // first version-shaped entry found, never guessing beyond what's
      // actually on disk.
      const versionDir = entries.find((e) => /^v\d/.test(e));
      if (!versionDir) return { found: false };
      return { found: true, path: join(WINDOWS_TOOLKIT_ROOT, versionDir), version: versionDir.replace(/^v/, '') };
    } catch {
      return { found: false };
    }
  }

  for (const root of LINUX_TOOLKIT_ROOTS) {
    try {
      const entries = readdirSyncFn(root);
      const versionDir = entries.find((e) => /^cuda(-\d)?/.test(e));
      if (versionDir) {
        const versionMatch = versionDir.match(/^cuda-(\d[\d.]*)/);
        return { found: true, path: join(root, versionDir), version: versionMatch ? versionMatch[1] : null };
      }
    } catch { /* try the next root */ }
  }
  return { found: false };
}

const WINDOWS_CUDNN_ROOT = 'C:\\Program Files\\NVIDIA\\CUDNN';

function dirHasCudnnDll(dir, existsSyncFn, readdirSyncFn, platform) {
  try {
    if (!existsSyncFn(dir)) return false;
    const entries = readdirSyncFn(dir);
    return platform === 'win32'
      ? entries.some((e) => /^cudnn64_\d+\.dll$/i.test(e))
      : entries.some((e) => /^libcudnn\.so/.test(e));
  } catch {
    return false;
  }
}

/**
 * cuDNN ships two real install shapes, both checked here:
 *   1. Copied directly into the CUDA Toolkit's own bin/ (an officially
 *      documented manual-install option — NVIDIA's cuDNN docs call this
 *      out explicitly as an alternative to the installer).
 *   2. The NVIDIA cuDNN Windows INSTALLER's actual default layout (what a
 *      normal "run the installer" setup produces) — a SEPARATE directory
 *      tree, C:\Program Files\NVIDIA\CUDNN\v<version>\bin\<cuda-major.minor>\x64\,
 *      never inside the CUDA Toolkit directory at all. Confirmed against a
 *      real installed machine: v9.25\bin\13.4\x64\cudnn64_9.dll — a
 *      version-mismatched CUDA_PATH lookup alone would have reported
 *      "not found" even though cuDNN genuinely IS installed.
 * Exported (additive, no behavior change) — see checkNvidiaSmi()'s own
 * header comment for why.
 * @returns {{found: true} | {found: false} | {found: 'unknown'}}
 */
export function checkCudnn({ cudaToolkitPath, existsSyncFn = existsSync, readdirSyncFn = readdirSync, platform = osPlatform() } = {}) {
  if (!cudaToolkitPath) return { found: 'unknown' };

  const toolkitBinDir = platform === 'win32' ? join(cudaToolkitPath, 'bin') : join(cudaToolkitPath, 'lib64');
  if (dirHasCudnnDll(toolkitBinDir, existsSyncFn, readdirSyncFn, platform)) return { found: true };

  if (platform !== 'win32') return { found: false };

  // Search every C:\Program Files\NVIDIA\CUDNN\v*\bin\*\x64\ directory —
  // the installer names both the cuDNN version and the CUDA-compatibility
  // subfolder, neither of which this function can predict in advance.
  try {
    if (!existsSyncFn(WINDOWS_CUDNN_ROOT)) return { found: false };
    for (const versionDir of readdirSyncFn(WINDOWS_CUDNN_ROOT)) {
      const versionBin = join(WINDOWS_CUDNN_ROOT, versionDir, 'bin');
      if (!existsSyncFn(versionBin)) continue;
      for (const cudaCompatDir of readdirSyncFn(versionBin)) {
        const x64Dir = join(versionBin, cudaCompatDir, 'x64');
        if (dirHasCudnnDll(x64Dir, existsSyncFn, readdirSyncFn, platform)) return { found: true };
      }
    }
    return { found: false };
  } catch {
    return { found: 'unknown' };
  }
}

// Pattern-matches known ORT failure strings to bias reason selection when
// the mechanical system checks alone are ambiguous (e.g. distinguishing a
// genuine version mismatch from an otherwise-unexplained failure once
// GPU+driver+toolkit+cuDNN+custom-build all check out).
function classifyOrtError(errMessage) {
  const msg = String(errMessage ?? '');
  if (/version|CUDA_ERROR_UNSUPPORTED|cudnn.*version|does not match/i.test(msg)) return 'version_mismatch';
  return null;
}

/**
 * @param {{
 *   errMessage?: string,           // the probe's own sanitised message
 *   runtimeSource?: 'npm'|'custom'|'managed'|null,
 *   platform?: string,             // process.platform, injectable
 *   env?: NodeJS.ProcessEnv,
 *   spawnFn?: typeof spawn,        // injectable — never a real nvidia-smi in a test
 *   existsSyncFn?: typeof existsSync,
 *   readdirSyncFn?: typeof readdirSync,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<{
 *   reason: 'no_gpu'|'no_driver'|'no_cuda_toolkit'|'no_cudnn'
 *           |'no_custom_build'|'version_mismatch'|'unknown',
 *   details: string, nextSteps: string[],
 * }>}
 */
export async function diagnoseCudaFailure({
  errMessage = '', runtimeSource = null, platform = osPlatform(), env = process.env,
  spawnFn = spawn, existsSyncFn = existsSync, readdirSyncFn = readdirSync,
  timeoutMs = NVIDIA_SMI_TIMEOUT_MS,
} = {}) {
  try {
    const gpu = await checkNvidiaSmi({ spawnFn, timeoutMs });

    if (!gpu.available) {
      if (gpu.reason === 'no_gpu') {
        return {
          reason: 'no_gpu',
          details: 'nvidia-smi ran successfully but reported zero NVIDIA GPUs on this machine.',
          nextSteps: [
            'CUDA requires a physical NVIDIA GPU — none was detected.',
            'Use ONNX_EXECUTION_PROVIDER=dml (DirectML, Windows-only) or ONNX_EXECUTION_PROVIDER=cpu instead.',
          ],
        };
      }
      return {
        reason: 'no_driver',
        details: gpu.reason === 'timeout'
          ? 'nvidia-smi did not respond within the timeout — the NVIDIA driver may be missing or malfunctioning.'
          : 'nvidia-smi was not found on PATH — no NVIDIA driver appears to be installed.',
        nextSteps: [
          'Install the NVIDIA driver for your GPU (nvidia-smi ships with it).',
          'After installing, restart and re-run this test.',
          'Without an NVIDIA driver, use ONNX_EXECUTION_PROVIDER=dml or ONNX_EXECUTION_PROVIDER=cpu instead.',
        ],
      };
    }

    const toolkit = checkCudaToolkit({ env, existsSyncFn, readdirSyncFn, platform });
    if (!toolkit.found) {
      return {
        reason: 'no_cuda_toolkit',
        details: `GPU driver ${gpu.driverVersion} detected (${gpu.gpuName}); CUDA_PATH is not set and no install was found under the default NVIDIA GPU Computing Toolkit directory.`,
        nextSteps: [
          'Install the NVIDIA CUDA Toolkit (12.x) from developer.nvidia.com/cuda-downloads.',
          'Ensure CUDA_PATH is set to the install directory (the installer usually does this automatically).',
          'See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER',
        ],
      };
    }

    const cudnn = checkCudnn({ cudaToolkitPath: toolkit.path, existsSyncFn, readdirSyncFn, platform });
    if (cudnn.found === false) {
      return {
        reason: 'no_cudnn',
        details: `CUDA Toolkit found at ${toolkit.path}${toolkit.version ? ` (v${toolkit.version})` : ''}, but no cuDNN library was found alongside it.`,
        nextSteps: [
          'Download cuDNN 9.x for your CUDA version from developer.nvidia.com/cudnn.',
          'Install the cuDNN files into the CUDA Toolkit directory (or wherever your custom onnxruntime-node build expects them).',
          'See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER',
        ],
      };
    }

    if (runtimeSource !== 'custom' && runtimeSource !== 'managed') {
      return {
        reason: 'no_custom_build',
        details: `GPU, driver, CUDA Toolkit${cudnn.found === true ? ', and cuDNN' : ''} are all present, but the currently loaded onnxruntime-node is the default npm package, which has no CUDA execution provider.`,
        nextSteps: [
          'The npm-installed onnxruntime-node package is CPU/DirectML-only — CUDA requires a separately-obtained, compatible custom build.',
          'Run scripts/install-onnxruntime-cuda-windows.ps1 to install a managed CUDA build automatically, or set ONNXRUNTIME_NODE_PATH to a custom build\'s path in Global Settings.',
          'See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER',
        ],
      };
    }

    if (classifyOrtError(errMessage) === 'version_mismatch') {
      const buildKind = runtimeSource === 'managed' ? 'managed' : 'custom';
      return {
        reason: 'version_mismatch',
        details: `GPU, driver, CUDA Toolkit, cuDNN, and a ${buildKind} onnxruntime-node build are all present, but the session still failed — this usually means the ${buildKind} build expects a different CUDA/cuDNN version than what is installed.`,
        nextSteps: runtimeSource === 'managed'
          ? [
              'Re-run scripts/install-onnxruntime-cuda-windows.ps1 to rebuild the managed runtime against the currently installed CUDA/cuDNN version.',
              `Installed CUDA Toolkit: ${toolkit.version ?? 'unknown version'} at ${toolkit.path}.`,
              'See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER',
            ]
          : [
              'Check the compatibility matrix for your custom onnxruntime-node build\'s expected CUDA/cuDNN versions.',
              `Installed CUDA Toolkit: ${toolkit.version ?? 'unknown version'} at ${toolkit.path}.`,
              'See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER',
            ],
      };
    }

    return {
      reason: 'unknown',
      details: `GPU, driver, CUDA Toolkit, cuDNN, and a custom onnxruntime-node build all appear present, but the session still failed: ${errMessage || '(no error message)'}`,
      nextSteps: [],
    };
  } catch {
    return { reason: 'unknown', details: 'The CUDA diagnostic itself could not complete.', nextSteps: [] };
  }
}
