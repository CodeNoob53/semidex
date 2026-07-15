// GET /api/health, GET /api/capabilities — StorageAdapter-only, no direct
// Qdrant/store access.
import { sendJson } from '../http.js';
import { sanitiseErrorMessage } from '../../core/doctor-checks.js';

// adapter.ping()'s `detail` on failure is a raw err.message from the
// underlying store client (e.g. qdrant-adapter.js's ping() catch block) —
// a network/auth failure message can embed the full request URL, which for
// a Qdrant Cloud cluster may carry credentials or an API key, and this
// route is not behind the router's uncaught-exception catch-all (it never
// throws), so it must redact explicitly before responding. Same helper/
// pattern as api/ask.js and api/generation.js's own safeMessage() (code
// review finding: this endpoint was the one remaining raw-detail path —
// the new #/settings screen surfaces this text directly to the user).
function safeMessage(message) {
  return message == null ? null : sanitiseErrorMessage(message, process.env.QDRANT_KEY);
}

export function registerHealthRoutes(router, adapter) {
  router.get('/api/health', async ({ res }) => {
    const storagePing = await adapter.ping();
    sendJson(res, 200, {
      ok: storagePing.ok,
      storage: {
        backend: adapter.name(),
        ok: storagePing.ok,
        detail: safeMessage(storagePing.detail),
      },
    });
  });

  router.get('/api/capabilities', ({ res }) => {
    sendJson(res, 200, {
      backend: adapter.name(),
      capabilities: adapter.capabilities(),
    });
  });
}
