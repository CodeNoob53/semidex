// GET /api/collections, GET /api/collections/:name,
// POST /api/collections/:name/sync-schema, DELETE /api/collections/:name
// — StorageAdapter-only.
import { sendJson, notFound } from '../http.js';

export function registerCollectionsRoutes(router, adapter) {
  router.get('/api/collections', async ({ res }) => {
    const collections = await adapter.listCollections();
    sendJson(res, 200, { collections });
  });

  router.get('/api/collections/:name', async ({ res, params }) => {
    const collection = await adapter.getCollection(params.name);
    if (!collection) throw notFound(`Collection "${params.name}" not found`);
    sendJson(res, 200, { collection });
  });

  router.post('/api/collections/:name/sync-schema', async ({ res, params }) => {
    // getCollection() is the cheapest existence check the adapter exposes —
    // ensureCollectionSchema() itself would otherwise surface a Qdrant-level
    // error for a missing collection instead of a clean 404.
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    const { repaired, warnings } = await adapter.ensureCollectionSchema(params.name);
    sendJson(res, 200, { collection: params.name, repaired, warnings });
  });

  // Destructive. Confirmation is a UI-level concern (a modal the user must
  // click through) — the Local API is loopback-only and single-user, so a
  // typed-confirmation body is not part of this contract. The existence
  // check still runs first so a delete on a name that never existed is a
  // clean 404, not a silent no-op.
  router.delete('/api/collections/:name', async ({ res, params }) => {
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    await adapter.deleteCollection(params.name);
    sendJson(res, 200, { collection: params.name, deleted: true });
  });
}
