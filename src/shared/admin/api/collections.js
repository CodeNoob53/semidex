// GET /api/collections, GET /api/collections/:name,
// POST /api/collections/:name/sync-schema, DELETE /api/collections/:name
// — StorageAdapter-only.
import { sendJson, notFound } from '../../../core/http/http.js';

// taskRegistry is optional DI, same convention as jobRegistry in
// api/jobs.js — tests that don't care about operation tracking can omit it
// entirely and this route falls back to a plain unwrapped adapter call.
export function registerCollectionsRoutes(router, adapter, { taskRegistry } = {}) {
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

    // Repair (a handful of Qdrant round-trips, typically well under a
    // second) keeps its original synchronous 200-with-result contract —
    // changing this to fire-and-forget would break every existing caller
    // for a task that doesn't actually run long enough to need it. What's
    // new (Phase 3S) is that the SAME call is also tracked in the shared
    // task registry (when provided) for the duration it runs, so the
    // operation modal/topbar chip can show it as a real operation (state:
    // running, then succeeded/failed) instead of the UI having to fake an
    // entry just because this endpoint responds quickly — "truthful
    // states," not a synthetic progress bar.
    if (!taskRegistry) {
      const { repaired, warnings } = await adapter.ensureCollectionSchema(params.name);
      sendJson(res, 200, { collection: params.name, repaired, warnings });
      return;
    }

    const { id, done } = taskRegistry.runTracked({
      kind: 'repair',
      collection: params.name,
      fn: () => adapter.ensureCollectionSchema(params.name),
    });
    // The task id is returned on the SUCCESS response body so the frontend
    // can open the operation modal on this exact task deterministically
    // (rather than guessing "the newest operation in the store," which
    // races against the store's own next poll). The failure path keeps the
    // existing error envelope/500 status untouched (no contract change for
    // the many places that already treat this endpoint's rejection as a
    // normal thrown HttpError) — the frontend locates a failed repair via
    // the store's own collection+kind+recency instead; see
    // settings-view.js's runSettingsRepair().
    const { repaired, warnings } = await done;
    sendJson(res, 200, { id, collection: params.name, repaired, warnings });
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
