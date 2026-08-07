// GET /api/ollama-models — installed-model discovery for the Settings UI's
// provider-aware model selectors (ASK_MODEL/CONTEXT_MODEL/TAG_MODEL/
// EMBED_MODEL). Read-only, never starts Ollama. Always 200 with status
// embedded in the body — matches api/generation.js's established
// "probe/status endpoint" convention, since an unreachable Ollama is a
// normal state to report, not a server error.
import { sendJson } from '../../core/http/http.js';
import { sanitiseErrorMessage } from '../../shared/core/doctor-checks.js';
import { discoverOllamaModels } from '../../local/core/ollama-models.js';

// Same redaction pattern as api/generation.js's safeMessage() — the
// reason string can embed a raw configured OLLAMA_URL, and this route
// isn't behind the router's uncaught-exception catch-all (it never throws).
function safeMessage(message) {
  return message == null ? null : sanitiseErrorMessage(message, process.env.QDRANT_KEY);
}

/**
 * @param {Object} router
 * @param {{ settingsService: ReturnType<typeof import('../../core/settings/service.js').createSettingsService>, discoverOllamaModelsFn?: typeof discoverOllamaModels }} deps
 */
export function registerOllamaModelsRoutes(router, { settingsService, discoverOllamaModelsFn = discoverOllamaModels }) {
  router.get('/api/ollama-models', async ({ res, query }) => {
    const baseUrl = settingsService.getActiveValue('OLLAMA_URL');
    const result = await discoverOllamaModelsFn(baseUrl, { forceRefresh: query.get('refresh') === '1' });
    sendJson(res, 200, { ...result, reason: safeMessage(result.reason) });
  });
}
