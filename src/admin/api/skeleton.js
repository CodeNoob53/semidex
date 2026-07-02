// GET /api/collections/:name/skeleton
// GET /api/collections/:name/skeleton/node
// GET /api/collections/:name/skeleton/children
// StorageAdapter-only.
import { sendJson, notFound } from '../http.js';
import { requireExactlyOne, parseIntParam } from './query-params.js';

export function registerSkeletonRoutes(router, adapter) {
  router.get('/api/collections/:name/skeleton', async ({ res, params }) => {
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    // A collection with no skeleton nav layer is not an error — most
    // collections don't have one (SKELETON_CHUNKING is opt-in). Report null.
    const skeleton = await adapter.getSkeletonRoot(params.name);
    sendJson(res, 200, { collection: params.name, skeleton });
  });

  router.get('/api/collections/:name/skeleton/node', async ({ res, params, query }) => {
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    const { key, value } = requireExactlyOne(query, ['nodeId', 'nodePath']);
    const opts = key === 'nodeId' ? { nodeId: value } : { nodePath: value };

    const node = await adapter.getSkeletonNode(params.name, opts);
    if (!node) throw notFound(`Skeleton node not found for ${key}="${value}"`);
    sendJson(res, 200, { collection: params.name, node });
  });

  router.get('/api/collections/:name/skeleton/children', async ({ res, params, query }) => {
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    const { key, value } = requireExactlyOne(query, ['nodeId', 'nodePath']);
    const opts = key === 'nodeId' ? { nodeId: value } : { nodePath: value };
    // limit follows the same reject-below/clamp-above policy as documents'
    // limit; a missing parent (adapter returns []) is not distinguished from
    // "parent exists with zero children" — the adapter doesn't expose that
    // distinction cheaply yet, so this endpoint keeps the adapter's own
    // behavior rather than inventing a 404 the adapter can't back up.
    const limit = parseIntParam(query, 'limit', { defaultValue: 50, min: 1, belowMin: 'reject', max: 500 });

    const children = await adapter.getSkeletonChildren(params.name, { ...opts, limit });
    sendJson(res, 200, { collection: params.name, children });
  });
}
