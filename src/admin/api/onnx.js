// POST /api/system/onnx-probe — explicit, user-triggered CUDA/DML/CPU
// verification. Delegates entirely to core/onnx-provider-probe.js, which
// runs the actual ONNX session-creation check in an ISOLATED CHILD
// PROCESS — this route (and the admin server generally) never loads
// onnxruntime-node itself merely to answer this request.
//
// A selected ONNX_EXECUTION_PROVIDER value is never presented as proof
// that provider is active — this endpoint exists specifically to close
// that gap: effectiveProvider/fellBackToCpu/runtimeSource/runtimeVersion
// in the response always come from the child process's real probe result,
// never from the setting alone.
import { sendJson, readJsonBody, badRequest } from '../../core/http/http.js';
import { probeOnnxProvider } from '../../core/onnx-provider-probe.js';

const VALID_PROVIDERS = new Set(['cpu', 'dml', 'cuda']);

/**
 * @param {Object} router
 * @param {{
 *   settingsService: ReturnType<typeof import('../../core/settings/service.js').createSettingsService>,
 *   runProbeFn?: typeof probeOnnxProvider,  // injectable for tests — never
 *                                           // a real child process in a unit test.
 * }} deps
 */
export function registerOnnxRoutes(router, { settingsService, runProbeFn = probeOnnxProvider } = {}) {
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
    // (typed but not yet Saved) provider — so it must also be able to send
    // a staged, not-yet-saved ONNXRUNTIME_NODE_PATH here, otherwise a
    // request testing a newly-staged provider would silently fall back to
    // whatever runtime path was last actually saved, producing a result
    // for a configuration combination the user never asked about (fixed:
    // previously this field ONLY ever read settingsService's configuredValue,
    // with no way to test an unsaved edit). `'runtimePath' in body`
    // distinguishes "not supplied, use configuredValue" from "supplied as
    // '', explicitly test with no custom runtime" — both real, meaningful
    // states, unlike a bare `??` which cannot tell them apart.
    const runtimePathEntry = settingsService.get('ONNXRUNTIME_NODE_PATH');
    const runtimePath = 'runtimePath' in body ? body.runtimePath : runtimePathEntry?.configuredValue;
    const runtimePathIsStaged = 'runtimePath' in body && body.runtimePath !== runtimePathEntry?.configuredValue;
    const probeEnv = { ...process.env };
    if (runtimePath) probeEnv.ONNXRUNTIME_NODE_PATH = runtimePath;
    else delete probeEnv.ONNXRUNTIME_NODE_PATH;

    // True whenever EITHER field's configured value hasn't taken effect in
    // the current process yet — a probe result under either condition
    // reflects the CONFIGURED (or explicitly staged) combination, not
    // necessarily what this process would use without a restart.
    const restartRequired = Boolean(providerEntry?.pendingRestart) || Boolean(runtimePathEntry?.pendingRestart);

    const result = await runProbeFn(provider, { env: probeEnv, secret: process.env.QDRANT_KEY });

    sendJson(res, 200, {
      ok: result.ok,
      requestedProvider: result.requestedProvider,
      effectiveProvider: result.effectiveProvider,
      fellBackToCpu: result.fellBackToCpu,
      runtimeSource: result.runtimeSource,
      runtimeVersion: result.runtimeVersion,
      modelCached: result.modelCached,
      restartRequired,
      // Tells the caller whether the ONNXRUNTIME_NODE_PATH actually used
      // for this probe was an unsaved, staged value rather than what's
      // currently saved to settings.json/env — the Admin UI surfaces this
      // explicitly so a probe result is never mistaken for testing the
      // saved configuration when it in fact tested an in-progress edit.
      testedStagedRuntimePath: runtimePathIsStaged,
      message: result.message,
    });
  });
}
