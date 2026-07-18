// GET /api/generation/models?backend=ollama|gemini — provider-neutral
// generation-model discovery (Stage B1). The UI consumes ONE response
// shape regardless of backend; ollama-models.js and gemini-models.js
// remain separate internal discovery adapters, matching the task's
// "the implementation may use separate internal discovery adapters, but
// the UI must consume one provider-neutral response shape" requirement.
//
// GET /api/ollama-models is kept unmodified for existing callers
// (TAG_MODEL/TAG_ONNX_MODEL/CONTEXT_MODEL/EMBED_MODEL all still use it,
// since those are Ollama-only fields with no cross-backend concept) — this
// route is additive, not a replacement.
import { sendJson, badRequest } from '../http.js';
import { sanitiseErrorMessage } from '../../core/doctor-checks.js';
import { discoverOllamaModels } from '../../core/ollama-models.js';
import { discoverGeminiModels } from '../../core/gemini-models.js';

function safeMessage(message, apiKey) {
  if (message == null) return null;
  return sanitiseErrorMessage(sanitiseErrorMessage(message, process.env.QDRANT_KEY), apiKey);
}

/**
 * @param {Object} router
 * @param {{
 *   settingsService: ReturnType<typeof import('../../core/settings/service.js').createSettingsService>,
 *   discoverOllamaModelsFn?: typeof discoverOllamaModels,
 *   discoverGeminiModelsFn?: typeof discoverGeminiModels,
 * }} deps
 */
export function registerGenerationModelsRoutes(router, {
  settingsService,
  discoverOllamaModelsFn = discoverOllamaModels,
  discoverGeminiModelsFn = discoverGeminiModels,
}) {
  router.get('/api/generation/models', async ({ res, query }) => {
    const backend = query.get('backend');
    const forceRefresh = query.get('refresh') === '1';

    if (backend === 'ollama') {
      const baseUrl = settingsService.getActiveValue('OLLAMA_URL');
      const result = await discoverOllamaModelsFn(baseUrl, { forceRefresh });
      sendJson(res, 200, { backend: 'ollama', ...result, reason: safeMessage(result.reason) });
      return;
    }

    if (backend === 'gemini') {
      const apiKey = settingsService.getActiveValue('GEMINI_API_KEY');
      const result = await discoverGeminiModelsFn({ apiKey, forceRefresh });
      // The API key never appears in the response body — discoverGeminiModelsFn
      // never echoes it back on success, and safeMessage() redacts it from
      // any failure reason as a second, defense-in-depth layer (matching
      // gemini-provider.js's own redaction of the same value).
      sendJson(res, 200, { backend: 'gemini', ...result, reason: safeMessage(result.reason, apiKey) });
      return;
    }

    throw badRequest('Unknown or missing "backend" query parameter. Expected "ollama" or "gemini".');
  });
}
