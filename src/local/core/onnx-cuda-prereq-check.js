// Managed CUDA runtime installer prerequisite check — composes
// cuda-diagnosis.js's already-existing, already-tested GPU-stack checks
// (nvidia-smi, CUDA Toolkit, cuDNN) into one result, and exposes a
// JSON-on-stdout CLI entry for the PowerShell installer
// (scripts/install-onnxruntime-cuda-windows.ps1) to invoke and parse —
// mirroring onnx-probe-runner.js's own isolated-process/JSON-stdout
// contract exactly. PowerShell handles Windows/Node/npm/CMake/VS Build
// Tools detection itself (outside cuda-diagnosis.js's GPU-stack scope,
// no existing Node logic to duplicate there).
//
// Never re-implements GPU-stack detection — reuses cuda-diagnosis.js's
// exported checkNvidiaSmi/checkCudaToolkit/checkCudnn directly, so the
// installer's own prerequisite check can never silently drift from the
// Admin UI's/doctor's own diagnosis logic.
import { pathToFileURL } from 'node:url';
import { checkNvidiaSmi, checkCudaToolkit, checkCudnn } from './cuda-diagnosis.js';

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: string,
 *   spawnFn?: Function,
 *   existsSyncFn?: Function,
 *   readdirSyncFn?: Function,
 * }} [options]
 * @returns {Promise<{
 *   nvidiaDriver: Awaited<ReturnType<typeof checkNvidiaSmi>>,
 *   cudaToolkit: ReturnType<typeof checkCudaToolkit>,
 *   cudnn: {found: true} | {found: false} | {found: 'unknown'},
 * }>}
 */
export async function checkPrerequisites({
  env = process.env, platform = process.platform,
  spawnFn, existsSyncFn, readdirSyncFn,
} = {}) {
  const nvidiaDriver = await checkNvidiaSmi({ spawnFn, timeoutMs: undefined });
  const cudaToolkit = checkCudaToolkit({ env, existsSyncFn, readdirSyncFn, platform });
  const cudnn = checkCudnn({
    cudaToolkitPath: cudaToolkit.found ? cudaToolkit.path : null,
    existsSyncFn, readdirSyncFn, platform,
  });
  return { nvidiaDriver, cudaToolkit, cudnn };
}

// CLI entry — invoked by the PowerShell installer as
// `node src/local/core/onnx-cuda-prereq-check.js`, which parses the
// single JSON line this writes to stdout. Never runs as an import-time
// side effect (guarded the same way every other real CLI entry point in
// this codebase gates its own work — importing this module for testing
// never touches a real spawn/fs call).
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  checkPrerequisites().then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch((err) => {
    process.stdout.write(JSON.stringify({ error: String(err?.message ?? err) }) + '\n');
    process.exitCode = 1;
  });
}
