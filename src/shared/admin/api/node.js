// GET /api/collections/:name/node — full structural content node
// (table, code_block, checklist, image, ...). StorageAdapter-only.
import { sendJson, notFound } from '../../../core/http/http.js';
import { requireExactlyOne } from './query-params.js';
import { AUDIENCE, OPERATION, COST_CLASS, COLLECTION_SOURCE } from '../../../core/http/route-audience.js';

export function registerNodeRoutes(router, adapter) {
  router.get('/api/collections/:name/node', async ({ res, params, query }) => {
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    const { key, value } = requireExactlyOne(query, ['nodeId', 'nodePath']);
    const opts = key === 'nodeId' ? { nodeId: value } : { nodePath: value };

    const node = await adapter.getContentNode(params.name, opts);
    if (!node) throw notFound(`Content node not found for ${key}="${value}"`);
    sendJson(res, 200, { collection: params.name, node });
  }, { audience: AUDIENCE.ADMIN, operation: OPERATION.READ, resourceType: 'node', collectionSource: COLLECTION_SOURCE.PATH, costClass: COST_CLASS.QDRANT });
}
