// Installer end-of-run verification step — one JSON-in/JSON-out CLI call
// that scripts/install-onnxruntime-cuda-windows.ps1 invokes as
// `node src/local/core/onnx-cuda-installer-verify.js` (stdin: { runtimeDir }),
// composing: read the just-installed manifest -> compute its identity
// fingerprint (BEFORE the probe runs, per managed-onnx-runtime-manifest.js's
// own writeVerificationResult() contract) -> prepare this process's own
// PATH for the managed runtime's cuDNN dependency -> run a REAL strict
// CUDA InferenceSession probe against the runtime now live at
// `runtimeDir` -> write the real outcome back into the manifest's
// `verification` block, atomically, only if the manifest hasn't changed
// concurrently since the fingerprint was taken.
//
// This is the ONLY place the installer proves CUDA actually works — never
// inferred from "the files copied successfully" or "the manifest parses."
// A `-SkipProbe` install never calls this script at all; the manifest
// then correctly stays `verification.status: 'unverified'`.
import { pathToFileURL } from 'node:url';
import { readManagedRuntimeManifest, computeManifestIdentityFingerprint, writeVerificationResult } from './managed-onnx-runtime-manifest.js';
import { prepareOnnxRuntimeProcessEnv, applyOnnxRuntimeEnvPatch } from './onnx-runtime-source-resolution.js';

/**
 * @param {{ runtimeDir: string }} input
 * @param {{ probeOnnxProviderFn?: Function, readFileSyncFn?: Function, existsSyncFn?: Function, readdirSyncFn?: Function, writeFileSyncFn?: Function, renameSyncFn?: Function, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {Promise<{ ok: boolean, status: 'verified'|'failed', effectiveProvider: string|null, message: string } | { ok: false, reason: string }>}
 */
export async function runInstallerVerification({ runtimeDir }, deps = {}) {
  const {
    probeOnnxProviderFn, readFileSyncFn, existsSyncFn, readdirSyncFn, writeFileSyncFn, renameSyncFn,
    env = process.env,
  } = deps;

  const read = readManagedRuntimeManifest(runtimeDir, { readFileSyncFn, existsSyncFn });
  if (!read.ok) return { ok: false, reason: `cannot read manifest at ${runtimeDir}: ${read.reason}` };

  const expectedManifestFingerprint = computeManifestIdentityFingerprint(read.manifest);

  const resolved = {
    path: runtimeDir, source: 'managed', managedId: `${read.manifest.ortVersion}-cuda${read.manifest.cudaMajor}`,
    cudnnBinPath: read.manifest.dependencies.cudnnBinPath,
  };
  const prepared = prepareOnnxRuntimeProcessEnv(resolved, { env, existsSyncFn, readdirSyncFn });
  if (!prepared.ok) return { ok: false, reason: `cuDNN PATH preparation failed: ${prepared.reason}` };
  applyOnnxRuntimeEnvPatch(resolved, { env });

  const { probeOnnxProvider } = await import('./onnx-provider-probe.js');
  const probeFn = probeOnnxProviderFn ?? probeOnnxProvider;
  const probeResult = await probeFn('cuda', { env });

  const status = probeResult.ok && probeResult.effectiveProvider === 'cuda' ? 'verified' : 'failed';
  const written = writeVerificationResult(
    runtimeDir,
    { status, effectiveProvider: probeResult.effectiveProvider ?? null, expectedManifestFingerprint },
    { writeFileSyncFn, readFileSyncFn, existsSyncFn, renameSyncFn },
  );
  if (!written.ok) return { ok: false, reason: `probe ran (status: ${status}) but writing the result back failed: ${written.reason}` };

  return { ok: status === 'verified', status, effectiveProvider: probeResult.effectiveProvider ?? null, message: probeResult.message };
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf-8').trim() || '{}');
    return runInstallerVerification(input);
  })()
    .then((result) => { process.stdout.write(JSON.stringify(result) + '\n'); })
    .catch((err) => {
      process.stdout.write(JSON.stringify({ ok: false, reason: `installer verification crashed: ${String(err?.message ?? err)}` }) + '\n');
      process.exitCode = 1;
    });
}
