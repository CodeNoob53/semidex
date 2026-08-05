// Standalone ONNX provider probe entry point — always run as an ISOLATED
// CHILD PROCESS (spawned by core/onnx-provider-probe.js), never imported
// directly by the admin server or npm run doctor. The admin server and
// doctor must never load either ONNX Runtime build (default npm package or
// a custom CUDA build) themselves merely to report status — this script is
// the only place that actually does.
//
// Reads its single configuration from environment variables (set by the
// parent via `env` passed to child_process.spawn — never CLI args, so
// nothing sensitive is visible in a process listing):
//   ONNX_PROBE_PROVIDER      — the ONNX execution provider to test ('cpu' | 'dml' | 'cuda')
//   ONNXRUNTIME_NODE_PATH    — (optional) custom onnxruntime-node build path,
//                              read the exact same way core/onnx-runtime.js's
//                              resolveOnnxRuntimeModule() does
//
// Writes exactly ONE line of JSON to stdout on completion (success or
// failure) and exits 0. A non-JSON stdout line, a non-zero exit, or no
// output at all is the parent's signal that something went wrong at the
// process level (crash, hang killed by parent timeout, etc.) — the parent
// (core/onnx-provider-probe.js) is responsible for turning that into an
// honest `ok: false` result, never inferring success from a crash.
//
// Uses ONLY the requested provider — never silently appends 'cpu' to a
// CUDA verification (executionProviders: [provider], matching the
// pre-existing probeOnnxProvider() contract this replaces). Never
// downloads the model: if model.onnx/model.onnx.data are not both present
// on disk, reports modelCached: false and stops before ever calling
// InferenceSession.create() — this is a probe, not an indexing run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadOnnxRuntime, resolveOnnxRuntimeModule } from './onnx-runtime.js';
import { getOnnxModelPath, isOnnxModelCached } from './onnx-paths.js';

function readRuntimeVersion(env) {
  const modulePath = resolveOnnxRuntimeModule(env);
  try {
    if (modulePath === 'onnxruntime-node') {
      const pkg = JSON.parse(readFileSync(new URL('../../node_modules/onnxruntime-node/package.json', import.meta.url), 'utf-8'));
      return pkg.version ?? null;
    }
    const pkg = JSON.parse(readFileSync(join(modulePath, 'package.json'), 'utf-8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const requestedProvider = (process.env.ONNX_PROBE_PROVIDER ?? 'cpu').trim().toLowerCase();
  const runtimeSource = process.env.ONNXRUNTIME_NODE_PATH?.trim() ? 'custom' : 'npm';
  const runtimeVersion = readRuntimeVersion(process.env);

  const modelPath = getOnnxModelPath();
  const modelCached = isOnnxModelCached();

  if (!modelCached) {
    process.stdout.write(JSON.stringify({
      ok: false,
      requestedProvider,
      effectiveProvider: null,
      fellBackToCpu: false,
      runtimeSource,
      runtimeVersion,
      modelCached: false,
      message: 'model_not_cached',
    }) + '\n');
    return;
  }

  let ort;
  try {
    ort = loadOnnxRuntime(process.env);
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      requestedProvider,
      effectiveProvider: null,
      fellBackToCpu: false,
      runtimeSource,
      runtimeVersion,
      modelCached: true,
      message: `runtime load failed: ${oneLine(err)}`,
    }) + '\n');
    return;
  }

  // Only the requested provider — never silently appends 'cpu'. A real
  // CUDA verification must fail honestly if CUDA itself isn't available,
  // not quietly succeed on CPU and report as if CUDA had been tested.
  try {
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: [requestedProvider] });
    try { await session.release(); } catch { /* ignore — probe already succeeded */ }
    process.stdout.write(JSON.stringify({
      ok: true,
      requestedProvider,
      effectiveProvider: requestedProvider,
      fellBackToCpu: false,
      runtimeSource,
      runtimeVersion,
      modelCached: true,
      message: `${requestedProvider.toUpperCase()} session created successfully`,
    }) + '\n');
  } catch (err) {
    // Session creation with the REQUESTED provider failed outright. This
    // probe never retries with CPU (unlike core/onnx-embed.js's own
    // non-strict production fallback) — a probe exists specifically to
    // report the truth about the requested provider, so "effective" is
    // reported as null (unknown/failed), never silently substituted with
    // 'cpu', which would misrepresent a CPU session as having been tested.
    process.stdout.write(JSON.stringify({
      ok: false,
      requestedProvider,
      effectiveProvider: null,
      fellBackToCpu: false,
      runtimeSource,
      runtimeVersion,
      modelCached: true,
      message: oneLine(err),
    }) + '\n');
  }
}

function oneLine(err) {
  return String(err?.message ?? err ?? 'unknown error').replace(/\r?\n.*/s, '').trim().slice(0, 300);
}

main().catch((err) => {
  // A truly unexpected failure (bug in this script itself, not an ORT
  // session error) — still emit valid JSON so the parent never has to
  // guess from a crashed/empty stdout.
  process.stdout.write(JSON.stringify({
    ok: false,
    requestedProvider: (process.env.ONNX_PROBE_PROVIDER ?? 'cpu').trim().toLowerCase(),
    effectiveProvider: null,
    fellBackToCpu: false,
    runtimeSource: process.env.ONNXRUNTIME_NODE_PATH?.trim() ? 'custom' : 'npm',
    runtimeVersion: null,
    modelCached: null,
    message: `probe runner crashed: ${oneLine(err)}`,
  }) + '\n');
  process.exitCode = 1;
});
