// GET /api/health, GET /api/capabilities — StorageAdapter-only, no direct
// Qdrant/store access.
import { sendJson } from '../http.js';

export function registerHealthRoutes(router, adapter) {
  router.get('/api/health', async ({ res }) => {
    const storagePing = await adapter.ping();
    sendJson(res, 200, {
      ok: storagePing.ok,
      storage: {
        backend: adapter.name(),
        ok: storagePing.ok,
        detail: storagePing.detail,
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
