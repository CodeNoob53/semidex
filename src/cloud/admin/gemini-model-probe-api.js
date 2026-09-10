// POST /api/generation/model-probe — explicit, user-triggered verification
// that a Gemini model is actually callable right now.
//
// WHY A SEPARATE, EXPLICIT ROUTE
// ------------------------------
// GET /api/generation/models (models.list) is cheap, read-only and safe to
// run on every Settings render. This route makes a REAL, billed
// generateContent call, so it must never run automatically — same discipline
// as POST /api/system/qdrant-cloud-probe, which stays untouched by routine
// rendering until a user clicks "Test".
//
// It exists because the Gemini API provides no other way to know: the Model
// resource has no deprecation/lifecycle field (confirmed against the
// official docs, 2026-09-10) and models.list() keeps returning models that
// return 404 "no longer available to new users" when actually called. See
// src/cloud/generation/gemini-model-probe.js's header for the full evidence.
//
// Never a 5xx for "this model does not work": every probe outcome —
// including a retired model — is a 200 with a typed status, exactly like
// the Qdrant Cloud probe route. A 5xx here would mean "Semidex broke",
// which is a different claim.
import { sendJson, readJsonBody, badRequest } from '../../core/http/http.js';
import { probeGeminiModel } from '../generation/gemini-model-probe.js';
import { AUDIENCE, OPERATION, COST_CLASS } from '../../core/http/route-audience.js';

/**
 * @param {Object} router
 * @param {{
 *   settingsService: ReturnType<typeof import('../../core/settings/service.js').createSettingsService>,
 *   probeModelFn?: typeof probeGeminiModel,  // DI for tests — never a real
 *                                            // billed API call in a unit test.
 * }} deps
 */
export function registerGeminiModelProbeRoutes(router, { settingsService, probeModelFn = probeGeminiModel } = {}) {
  router.post('/api/generation/model-probe', async ({ req, res }) => {
    const body = (await readJsonBody(req)) ?? {};
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      throw badRequest('model is required.');
    }

    // The key is read here and never echoed back. probeGeminiModel()
    // redacts it from any surfaced detail as a second layer.
    const apiKey = settingsService.getActiveValue('GEMINI_API_KEY');
    const result = await probeModelFn({ apiKey, model });
    sendJson(res, 200, result);
  }, { audience: AUDIENCE.ADMIN, operation: OPERATION.PROBE, resourceType: 'system', costClass: COST_CLASS.LLM });
}
