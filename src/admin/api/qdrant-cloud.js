// POST /api/system/qdrant-cloud-probe — explicit, user-triggered Qdrant
// Cloud Inference verification. Delegates entirely to
// admin/system/qdrant-cloud.js's probeQdrantCloudInference() (Tier 2) —
// the ONLY code path that ever calls it. Routine Settings rendering and
// collection browsing both stay on Tier 1 (checkQdrantReachable(), wired
// into core/embedding-profile/availability.js) until a user explicitly
// clicks the "Test Cloud Inference" button that hits this route.
//
// No secret ever reaches the response body — probeQdrantCloudInference()
// already redacts QDRANT_KEY/URL via sanitiseErrorMessage() before
// returning; this route does not need its own redaction pass.
import { sendJson, readJsonBody, badRequest } from '../../core/http/http.js';
import { probeQdrantCloudInference } from '../system/qdrant-cloud.js';
import { findDenseModel } from '../../core/embedding-profile/qdrant-cloud-catalog.js';
import { resolveNewCollectionProfile } from '../../core/embedding-profile/resolve.js';

/**
 * @param {Object} router
 * @param {{
 *   settingsService: ReturnType<typeof import('../../core/settings/service.js').createSettingsService>,
 *   runProbeFn?: typeof probeQdrantCloudInference,  // injectable for tests — never
 *                                                    // a real Qdrant round-trip in a unit test.
 * }} deps
 */
export function registerQdrantCloudRoutes(router, { settingsService, runProbeFn = probeQdrantCloudInference } = {}) {
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

    // The SAME profile-building path a real new collection would use
    // (Part A) — probeInference() then builds its schema from this profile
    // via buildQdrantVectorSchemaFromProfile(), never a hand-rolled shape.
    const profile = resolveNewCollectionProfile(
      { denseProvider: 'qdrant-cloud', denseModel, sparseProvider: 'qdrant-cloud' },
      { embeddingSchemaVersion: 2 },
    );

    const result = await runProbeFn({ profile });
    sendJson(res, 200, result);
  });
}
