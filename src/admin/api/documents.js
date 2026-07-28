// GET /api/collections/:name/documents — StorageAdapter-only.
import { sendJson, notFound } from '../../core/http/http.js';
import { parseIntParam } from './query-params.js';

export function registerDocumentsRoutes(router, adapter) {
  router.get('/api/collections/:name/documents', async ({ res, params, query }) => {
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    const prefix = query.get('prefix') || undefined;
    // limit < 1 is a client mistake (400, not clamped: silently serving 1
    // result for a negative/zero limit would hide the bug). limit > 1000 is
    // clamped rather than rejected — a large-but-honest request for "all of
    // it" shouldn't hard-fail when a cheap, safe upper bound exists.
    const limit = parseIntParam(query, 'limit', { defaultValue: 100, min: 1, belowMin: 'reject', max: 1000 });

    const documents = await adapter.listSourceDocuments(params.name, { prefix, limit });
    sendJson(res, 200, { collection: params.name, documents });
  });
}
