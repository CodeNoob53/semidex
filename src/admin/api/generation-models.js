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
//
// discoverOllamaModelsFn has NO static-import default (Semidex Lite
// composition split) — this module must never statically import
// core/ollama-models.js, since a cloud-only Lite composition root only
// ever registers registerGenerationModelsRoutesGeminiOnly() below, which
// never references it at all. The full composition root (createApp(),
// server.js) imports core/ollama-models.js itself and passes
// discoverOllamaModels in explicitly.
import { sendJson, badRequest } from '../../core/http/http.js';
import { sanitiseErrorMessage } from '../../core/doctor-checks.js';
import { discoverGeminiModels } from '../../core/gemini-models.js';

function safeMessage(message, apiKey) {
  if (message == null) return null;
  return sanitiseErrorMessage(message, [process.env.QDRANT_KEY, apiKey]);
}

async function handleGeminiBackend(res, settingsService, discoverGeminiModelsFn, forceRefresh) {
  const apiKey = settingsService.getActiveValue('GEMINI_API_KEY');
  const result = await discoverGeminiModelsFn({ apiKey, forceRefresh });
  // The API key never appears in the response body — discoverGeminiModelsFn
  // never echoes it back on success, and safeMessage() redacts it from any
  // failure reason as a second, defense-in-depth layer (matching
  // gemini-provider.js's own redaction of the same value).
  sendJson(res, 200, { backend: 'gemini', ...result, reason: safeMessage(result.reason, apiKey) });
}

/**
 * Full-Semidex variant: both Ollama and Gemini backends. discoverOllamaModelsFn
 * has no default — the caller (createApp(), server-full.js) must pass the real
 * one explicitly, since this module itself never imports core/ollama-models.js.
 * @param {Object} router
 * @param {{
 *   settingsService: ReturnType<typeof import('../../core/settings/service.js').createSettingsService>,
 *   discoverOllamaModelsFn: (baseUrl: string, opts?: object) => Promise<object>,
 *   discoverGeminiModelsFn?: typeof discoverGeminiModels,
 * }} deps
 */
export function registerGenerationModelsRoutes(router, {
  settingsService,
  discoverOllamaModelsFn,
  discoverGeminiModelsFn = discoverGeminiModels,
}) {
  router.get('/api/generation/models', async ({ res, query }) => {
    const backend = query.get('backend');
    const forceRefresh = query.get('refresh') === '1';

    if (backend === 'ollama') {
      if (!discoverOllamaModelsFn) {
        throw badRequest('The "ollama" backend is not available in this deployment.');
      }
      const baseUrl = settingsService.getActiveValue('OLLAMA_URL');
      const result = await discoverOllamaModelsFn(baseUrl, { forceRefresh });
      sendJson(res, 200, { backend: 'ollama', ...result, reason: safeMessage(result.reason) });
      return;
    }

    if (backend === 'gemini') {
      await handleGeminiBackend(res, settingsService, discoverGeminiModelsFn, forceRefresh);
      return;
    }

    throw badRequest('Unknown or missing "backend" query parameter. Expected "ollama" or "gemini".');
  });
}

/**
 * Semidex Lite variant: Gemini only. Never references core/ollama-models.js
 * in any way — a `backend=ollama` request gets a clear 400, not a 500 from
 * a missing dependency, and the module import graph itself has no Ollama
 * edge at all (unlike the full variant above, whose Ollama edge is DI-only
 * but whose CALLER still imports the real module).
 * @param {Object} router
 * @param {{
 *   settingsService: ReturnType<typeof import('../../core/settings/service.js').createSettingsService>,
 *   discoverGeminiModelsFn?: typeof discoverGeminiModels,
 * }} deps
 */
export function registerGenerationModelsRoutesGeminiOnly(router, {
  settingsService,
  discoverGeminiModelsFn = discoverGeminiModels,
}) {
  router.get('/api/generation/models', async ({ res, query }) => {
    const backend = query.get('backend');
    const forceRefresh = query.get('refresh') === '1';

    if (backend === 'gemini') {
      await handleGeminiBackend(res, settingsService, discoverGeminiModelsFn, forceRefresh);
      return;
    }

    if (backend === 'ollama') {
      throw badRequest('The "ollama" backend is not available in this deployment.');
    }

    throw badRequest('Unknown or missing "backend" query parameter. Expected "gemini".');
  });
}
