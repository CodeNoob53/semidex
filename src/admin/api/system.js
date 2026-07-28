// POST /api/system/pick-folder, GET /api/system/ollama-status — local OS/
// process integrations for the admin UI. No StorageAdapter involvement
// (neither is a storage concern) — same reasoning as jobs.js not touching
// the adapter.
import { sendJson, badRequest } from '../../core/http/http.js';
import { pickFolder } from '../system/folder-picker.js';
import { checkOllama } from '../system/ollama.js';

const PICKER_ERROR_STATUS = {
  UNSUPPORTED_PLATFORM: 501,
  PICKER_UNAVAILABLE: 501,
  PICKER_TIMEOUT: 504,
  PICKER_FAILED: 502,
};

const DEFAULT_CONTEXT_MODEL = process.env.CONTEXT_MODEL || 'gemma3:4b';

export function registerSystemRoutes(router, { pickFolderFn = pickFolder, checkOllamaFn = checkOllama } = {}) {
  router.post('/api/system/pick-folder', async ({ res }) => {
    try {
      const { path, cancelled } = await pickFolderFn();
      sendJson(res, 200, { path, cancelled });
    } catch (err) {
      const status = PICKER_ERROR_STATUS[err.code] ?? 500;
      if (status >= 500) {
        sendJson(res, status, { error: { message: err.message, code: err.code ?? 'internal_error' } });
        return;
      }
      throw badRequest(err.message);
    }
  });

  // Read-only status check — never starts Ollama. Lets the UI show
  // "LLM summaries require Ollama: <status>" before the user even submits
  // the indexing form.
  router.get('/api/system/ollama-status', async ({ res }) => {
    const result = await checkOllamaFn({ requiredModel: DEFAULT_CONTEXT_MODEL });
    sendJson(res, 200, result);
  });
}
