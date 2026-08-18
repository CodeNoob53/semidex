// POST /api/system/onnx-probe — explicit, user-triggered CUDA/DML/CPU
// verification. Delegates entirely to local/core/onnx-provider-probe.js, which
// runs the actual ONNX session-creation check in an ISOLATED CHILD
// PROCESS — this route (and the admin server generally) never loads
// onnxruntime-node itself merely to answer this request.
//
// A selected ONNX_EXECUTION_PROVIDER value is never presented as proof
// that provider is active — this endpoint exists specifically to close
// that gap: effectiveProvider/fellBackToCpu/runtimeSource/runtimeVersion
// in the response always come from the child process's real probe result,
// never from the setting alone.
import { sendJson, readJsonBody, badRequest } from '../../../core/http/http.js';
import { probeOnnxProvider } from '../../core/onnx-provider-probe.js';
import { diagnoseCudaFailure } from '../../core/cuda-diagnosis.js';
import { resolveSemidexHomePaths } from '../../core/semidex-home.js';
import { resolveEffectiveOnnxRuntimePath, prepareOnnxRuntimeProcessEnv } from '../../core/onnx-runtime-source-resolution.js';
import { readManagedRuntimeManifest, computeManifestIdentityFingerprint, writeVerificationResult } from '../../core/managed-onnx-runtime-manifest.js';
import { createManagedRuntimeListingCache } from '../../core/managed-runtime-listing.js';
import { AUDIENCE, OPERATION, COST_CLASS, EDITION } from '../../../core/http/route-audience.js';

const VALID_PROVIDERS = new Set(['cpu', 'dml', 'cuda']);

/**
 * Best-effort, non-secret projection of a managed runtime's manifest for
 * the probe response — only what the Admin UI needs to display
 * (ORT/CUDA versions, verification state), never the full manifest
 * (which includes filesystem paths/build host details not meant for a
 * response body).
 * @param {string} runtimeDir
 * @returns {{ ortVersion: string, cudaMajor: string, verification: Object } | null}
 */
function readManagedRuntimeManifestProjection(runtimeDir) {
  const read = readManagedRuntimeManifest(runtimeDir);
  if (!read.ok) return null;
  return {
    ortVersion: read.manifest.ortVersion,
    cudaMajor: read.manifest.cudaMajor,
    verification: { ...read.manifest.verification },
  };
}

/**
 * @param {Object} router
 * @param {{
 *   settingsService: ReturnType<typeof import('../../../core/settings/service.js').createSettingsService>,
 *   runProbeFn?: typeof probeOnnxProvider,  // injectable for tests — never
 *                                           // a real child process in a unit test.
 *   diagnoseCudaFailureFn?: typeof diagnoseCudaFailure,  // injectable for
 *                                           // tests — never a real
 *                                           // nvidia-smi/filesystem check
 *                                           // in a unit test.
 *   resolveEffectiveOnnxRuntimePathFn?: typeof resolveEffectiveOnnxRuntimePath,
 *   writeVerificationResultFn?: typeof writeVerificationResult,
 *   listingCache?: ReturnType<typeof createManagedRuntimeListingCache>,  // injectable for tests
 * }} deps
 */
export function registerOnnxRoutes(router, {
  settingsService, runProbeFn = probeOnnxProvider, diagnoseCudaFailureFn = diagnoseCudaFailure,
  resolveEffectiveOnnxRuntimePathFn = resolveEffectiveOnnxRuntimePath,
  writeVerificationResultFn = writeVerificationResult,
  listingCache = createManagedRuntimeListingCache(),
} = {}) {
  router.post('/api/system/onnx-probe', async ({ req, res }) => {
    const body = (await readJsonBody(req)) ?? {};

    const providerEntry = settingsService.get('ONNX_EXECUTION_PROVIDER');
    // configuredValue (settings.json/env, NOT frozen) — the value a save
    // just wrote, whether or not this process has restarted to pick it up
    // yet. An explicit body.provider always wins over both.
    const provider = body.provider ?? providerEntry?.configuredValue ?? 'cpu';
    if (!VALID_PROVIDERS.has(provider)) {
      throw badRequest(`provider must be one of: ${[...VALID_PROVIDERS].join(', ')}`);
    }

    // The Admin UI's probe panel deliberately lets a user test a STAGED
    // (typed but not yet Saved) explicit runtime path OR managed
    // selection — so it must also be able to send those as staged,
    // not-yet-saved values here, otherwise a request testing a
    // newly-staged combination would silently fall back to whatever was
    // last actually saved, producing a result for a configuration
    // combination the user never asked about. `'runtimePath' in body`/
    // `'managedRuntimeId' in body` distinguish "not supplied, use
    // configuredValue" from "supplied as '', explicitly test with no
    // custom runtime" — both real, meaningful states, unlike a bare `??`
    // which cannot tell them apart.
    const runtimePathEntry = settingsService.get('ONNXRUNTIME_NODE_PATH');
    const runtimePath = 'runtimePath' in body ? body.runtimePath : runtimePathEntry?.configuredValue;
    const runtimePathIsStaged = 'runtimePath' in body && body.runtimePath !== runtimePathEntry?.configuredValue;

    const managedRuntimeEntry = settingsService.get('ONNX_MANAGED_RUNTIME');
    const managedRuntimeId = 'managedRuntimeId' in body ? body.managedRuntimeId : managedRuntimeEntry?.configuredValue;

    const { runtimesDir } = resolveSemidexHomePaths();
    // provider here is the RESOLVED provider for this probe (staged
    // body.provider, falling back to configured/default — see above), not
    // a raw settings read — this is what makes a staged CUDA->DML switch
    // testable before a restart: the managed CUDA-only runtime is
    // correctly excluded from resolution the moment `provider` is 'dml',
    // even if ONNX_MANAGED_RUNTIME/ONNX_EXECUTION_PROVIDER haven't been
    // saved/restarted into yet. Same resolveEffectiveOnnxRuntimePathFn()
    // production startup (admin/bootstrap.js, indexer, MCP) goes through —
    // this route just supplies its own staged/per-request provider instead
    // of settingsService.getActiveValue('ONNX_EXECUTION_PROVIDER').
    const resolved = resolveEffectiveOnnxRuntimePathFn({
      provider, explicitPath: runtimePath, managedSelection: managedRuntimeId, runtimesDir,
    });

    // This route builds its OWN per-request probeEnv object — it never
    // mutates the real process.env, so testing a staged/unsaved selection
    // can never leak into this (or any other) process's actual runtime
    // resolution. applyOnnxRuntimeEnvPatch() is specifically for patching
    // the real, persistent process.env (indexer/admin startup) — not used
    // here.
    const probeEnv = { ...process.env };
    if (resolved.path) probeEnv.ONNXRUNTIME_NODE_PATH = resolved.path;
    else delete probeEnv.ONNXRUNTIME_NODE_PATH;
    if (resolved.source === 'managed') probeEnv.ONNX_MANAGED_RUNTIME_ACTIVE = resolved.managedId;
    else delete probeEnv.ONNX_MANAGED_RUNTIME_ACTIVE;

    // Never silent: an invalid/corrupt managed selection is surfaced as a
    // diagnosis-shaped warning rather than silently probing npm/CPU as if
    // the user had selected nothing.
    let resolutionWarning = resolved.warning ?? null;

    if (resolved.cudnnBinPath) {
      const prepared = prepareOnnxRuntimeProcessEnv(resolved, { env: probeEnv });
      if (!prepared.ok) resolutionWarning = prepared.reason;
    }

    // True whenever EITHER field's configured value hasn't taken effect in
    // the current process yet — a probe result under either condition
    // reflects the CONFIGURED (or explicitly staged) combination, not
    // necessarily what this process would use without a restart.
    const restartRequired = Boolean(providerEntry?.pendingRestart) || Boolean(runtimePathEntry?.pendingRestart) || Boolean(managedRuntimeEntry?.pendingRestart);

    const result = await runProbeFn(provider, { env: probeEnv, secret: process.env.QDRANT_KEY });

    // Real system checks (nvidia-smi, CUDA_PATH/toolkit dir, cuDNN DLL
    // presence) — only ever run for a FAILED CUDA probe, never on the
    // DML/CPU happy path or a successful CUDA probe. Best-effort
    // enrichment: a diagnosis-side failure must never degrade or replace
    // the probe result itself, so any throw here is swallowed to null.
    //
    // A resolutionWarning (invalid/corrupt managed selection, or a
    // vanished cuDNN path) always WINS over the generic
    // diagnoseCudaFailureFn() narrative — it's the more specific,
    // actionable explanation ("your selected managed runtime is broken"
    // vs. a generic "no custom build in use" that would otherwise be
    // misleading here, since a managed selection WAS made, it just failed
    // resolution before the probe ever ran against it).
    let diagnosis = null;
    if (resolutionWarning) {
      diagnosis = { reason: 'managed_runtime_resolution', details: resolutionWarning, nextSteps: [] };
    } else if (!result.ok && provider === 'cuda') {
      try {
        diagnosis = await diagnoseCudaFailureFn({
          errMessage: result.message, runtimeSource: result.runtimeSource,
        });
      } catch {
        diagnosis = null;
      }
    }

    // managedRuntimeManifest: null unless this probe actually ran against
    // a managed runtime. When it did, a real probe outcome (this route's
    // OWN runProbeFn call above, never inferred from anything else)
    // writes the manifest's verification block back — every manual "Test
    // CUDA configuration" click against a managed runtime keeps its
    // verification state current, not just a one-time install-time
    // snapshot. Best-effort: a write-back failure never degrades or
    // replaces the probe response itself.
    let managedRuntimeManifest = null;
    if (resolved.source === 'managed' && provider === 'cuda') {
      const before = readManagedRuntimeManifest(resolved.path);
      if (before.ok) {
        const expectedManifestFingerprint = computeManifestIdentityFingerprint(before.manifest);
        try {
          writeVerificationResultFn(resolved.path, {
            status: result.ok && result.effectiveProvider === 'cuda' ? 'verified' : 'failed',
            effectiveProvider: result.effectiveProvider ?? null,
            expectedManifestFingerprint,
          });
        } catch {
          // Best-effort — the probe response itself is never blocked by a
          // write-back failure (e.g. a concurrent reinstall).
        }
      }
      managedRuntimeManifest = readManagedRuntimeManifestProjection(resolved.path);
    }

    sendJson(res, 200, {
      ok: result.ok,
      requestedProvider: result.requestedProvider,
      effectiveProvider: result.effectiveProvider,
      fellBackToCpu: result.fellBackToCpu,
      runtimeSource: result.runtimeSource,
      runtimeVersion: result.runtimeVersion,
      modelCached: result.modelCached,
      restartRequired,
      // Tells the caller whether the ONNXRUNTIME_NODE_PATH/ONNX_MANAGED_RUNTIME
      // actually used for this probe was an unsaved, staged value rather
      // than what's currently saved to settings.json/env — the Admin UI
      // surfaces this explicitly so a probe result is never mistaken for
      // testing the saved configuration when it in fact tested an
      // in-progress edit.
      testedStagedRuntimePath: runtimePathIsStaged,
      message: result.message,
      // null unless a CUDA probe just failed or a resolution-layer
      // warning occurred (invalid/corrupt managed selection, vanished
      // cuDNN path — see the resolutionWarning precedence above) —
      // always present as a key so the Admin UI can rely on it, never
      // omitted, never silently swallowed.
      diagnosis,
      // null unless this probe ran against a managed runtime — the real
      // (not just selected) ORT/CUDA versions and verification state,
      // kept current by this same request's own write-back above.
      managedRuntimeManifest,
    });
  }, { audience: AUDIENCE.ADMIN, operation: OPERATION.PROBE, resourceType: 'system', costClass: COST_CLASS.SYSTEM, edition: EDITION.FULL });

  // GET /api/system/onnx-managed-runtimes — lists installed managed CUDA
  // runtimes for the Settings UI's dropdown. DISPLAY-ONLY (see
  // managed-runtime-listing.js's own header) — never the security
  // boundary that decides what actually gets loaded; that's always
  // resolveEffectiveOnnxRuntimePath()'s own full, uncached
  // verifyManagedRuntimeOnDisk() call, both above (this route's own probe
  // handler) and in every real load path (indexer, admin startup).
  router.get('/api/system/onnx-managed-runtimes', async ({ res }) => {
    const { runtimesDir } = resolveSemidexHomePaths();
    const runtimes = listingCache.listManagedRuntimes(runtimesDir);
    sendJson(res, 200, { runtimes });
  }, { audience: AUDIENCE.ADMIN, operation: OPERATION.READ, resourceType: 'system', costClass: COST_CLASS.SYSTEM, edition: EDITION.FULL });
}
