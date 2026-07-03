// GET /api/collections, GET /api/collections/:name,
// POST /api/collections/:name/sync-schema, DELETE /api/collections/:name
// — StorageAdapter-only.
import { sendJson, badRequest, notFound } from '../http.js';
import { readJsonBody } from '../http.js';

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

  // Destructive — requires the caller to echo the exact collection name
  // back in the body as an explicit confirmation, mirroring the UI's
  // type-to-confirm modal. A bare DELETE with no body could otherwise be
  // triggered accidentally (e.g. a stray browser prefetch or proxy retry).
  router.delete('/api/collections/:name', async ({ req, res, params }) => {
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    const body = await readJsonBody(req);
    if (body?.confirm !== params.name) {
      throw badRequest(`Body field "confirm" must exactly match the collection name "${params.name}"`);
    }

    await adapter.deleteCollection(params.name);
    sendJson(res, 200, { collection: params.name, deleted: true });
  });
}
