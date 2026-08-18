// POST /api/system/qdrant-cloud-probe — explicit, user-triggered Qdrant
// Cloud Inference verification. Delegates entirely to
// qdrant-cloud-system.js's probeQdrantCloudInference() (Tier 2) —
// the ONLY code path that ever calls it. Routine Settings rendering and
// collection browsing both stay on Tier 1 (checkQdrantReachable(), wired
// into core/embedding-profile/availability.js) until a user explicitly
// clicks the "Test Cloud Inference" button that hits this route.
//
// No secret ever reaches the response body — probeQdrantCloudInference()
// already redacts QDRANT_KEY/URL via sanitiseErrorMessage() before
// returning; this route does not need its own redaction pass.
import { sendJson, readJsonBody, badRequest } from '../../core/http/http.js';
import { probeQdrantCloudInference, classifyInferenceProbeError } from './qdrant-cloud-system.js';
import { findDenseModel, findSparseModel } from '../embedding/qdrant-cloud-catalog.js';
import { resolveNewCollectionProfile } from '../../core/embedding-profile/resolve.js';
import { AUDIENCE, OPERATION, COST_CLASS } from '../../core/http/route-audience.js';

/**
 * @param {Object} router
 * @param {{
 *   settingsService: ReturnType<typeof import('../../core/settings/service.js').createSettingsService>,
 *   runProbeFn?: typeof probeQdrantCloudInference,  // injectable for tests — never
 *                                                    // a real Qdrant round-trip in a unit test.
 *   resolveNewCollectionProfileFn?: typeof resolveNewCollectionProfile,  // injectable
 *     // for tests — lets a test prove the EXACT sparseModel value this
 *     // route received actually reaches the resolver call, independent of
 *     // what the real catalog's current default sparse model happens to
 *     // be (a test that only ever sends 'qdrant/bm25' — today's sole
 *     // supported sparse model AND the resolver's own fallback default —
 *     // cannot distinguish "passed through" from "silently dropped and
 *     // defaulted"; code review finding).
 * }} deps
 */
export function registerQdrantCloudRoutes(router, {
  settingsService, runProbeFn = probeQdrantCloudInference,
  resolveNewCollectionProfileFn = resolveNewCollectionProfile,
} = {}) {
  router.post('/api/system/qdrant-cloud-probe', async ({ req, res }) => {
    const body = (await readJsonBody(req)) ?? {};

    const denseModelEntry = settingsService.get('QDRANT_CLOUD_DENSE_MODEL');
    // Same "test a STAGED, not-yet-saved value" discipline as the ONNX
    // probe route (src/admin/api/onnx.js) — an explicit body field always
    // wins over both configuredValue (settings.json/env, not yet
    // restarted into) and any default.
    const denseModel = body.denseModel ?? denseModelEntry?.configuredValue;
    if (!denseModel) {
      throw badRequest('denseModel is required (either in the request body or via QDRANT_CLOUD_DENSE_MODEL)');
    }
    if (!findDenseModel(denseModel) || findDenseModel(denseModel).status !== 'supported') {
      throw badRequest(`"${denseModel}" is not a supported Qdrant Cloud dense model`);
    }

    // sparseModel is optional and additive — every existing caller that
    // never sent it keeps getting the exact same dense-only-probe
    // behavior as before (resolveNewCollectionProfile's own sparseModel
    // param stays unset, matching the original hardcoded qdrant/bm25
    // default path this route always used). When provided, it's validated
    // the same way denseModel is: must be a real, status:'supported'
    // catalog entry — never silently ignored if invalid.
    const sparseModel = body.sparseModel;
    if (sparseModel !== undefined) {
      if (!findSparseModel(sparseModel) || findSparseModel(sparseModel).status !== 'supported') {
        throw badRequest(`"${sparseModel}" is not a supported Qdrant Cloud sparse model`);
      }
    }

    // The SAME profile-building path a real new collection would use
    // (Part A) — probeInference() then builds its schema from this profile
    // via buildQdrantVectorSchemaFromProfile(), never a hand-rolled shape.
    // sparseModel is passed through unchanged when provided — previously
    // validated above (line ~50) but silently dropped here, so a caller
    // testing a non-default sparse model was actually always probing BM25
    // regardless of what it asked for. When omitted, resolveNewCollectionProfile()
    // falls back to 'qdrant/bm25' exactly as before — no behavior change
    // for any existing caller.
    const profile = resolveNewCollectionProfileFn(
      { denseProvider: 'qdrant-cloud', denseModel, sparseProvider: 'qdrant-cloud', sparseModel },
      { embeddingSchemaVersion: 2 },
    );

    let result;
    let thrownError = null;
    try {
      result = await runProbeFn({ profile });
    } catch (err) {
      thrownError = err;
    }
    // availability is the NEW, normalized 4-status classification
    // (available/unavailable_for_cluster/unsupported_by_semidex/
    // unverified) — added alongside the ORIGINAL response shape
    // (status/message, still exactly `inference_available`/
    // `inference_disabled_or_model_unavailable`/etc., unchanged), not a
    // replacement for it — every existing caller (UI, tests) reading
    // `result.status`/`result.message` keeps working unmodified.
    const availability = thrownError
      ? classifyInferenceProbeError({ error: thrownError })
      : classifyInferenceProbeError({ result });
    if (thrownError && !result) {
      // The underlying probe threw (e.g. the tier-gated case, which
      // store.js's own INFERENCE_ERROR_PATTERN doesn't recognize and
      // rethrows as a bare Error) — this route has always returned 200
      // with a typed status/message for every OTHER probe failure shape
      // (never a 5xx for "the model doesn't work"), so a thrown error is
      // normalized into that exact same convention here too, rather than
      // leaking a 500.
      sendJson(res, 200, { status: 'inference_disabled_or_model_unavailable', message: availability.message, availability });
      return;
    }
    sendJson(res, 200, { ...result, availability });
  }, { audience: AUDIENCE.ADMIN, operation: OPERATION.PROBE, resourceType: 'system', costClass: COST_CLASS.QDRANT });
}
