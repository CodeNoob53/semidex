// GET /api/collections/:name/chunks — StorageAdapter-only.
import { sendJson, notFound } from '../http.js';
import { requireIntParam, parseIntParam, requireStringParam } from './query-params.js';

export function registerChunksRoutes(router, adapter) {
  router.get('/api/collections/:name/chunks', async ({ res, params, query }) => {
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    const sourceFile = requireStringParam(query, 'sourceFile');
    // chunkIndex has no natural upper bound (it's per-file) and no sensible
    // clamp target, so it's required and rejects (never clamps) if negative.
    const chunkIndex = requireIntParam(query, 'chunkIndex', { min: 0, belowMin: 'reject' });
    // window: reject out-of-range on both sides — a silently-clamped window
    // could confuse a caller comparing requested vs. returned chunk counts.
    const window = parseIntParam(query, 'window', {
      defaultValue: 0, min: 0, belowMin: 'reject', max: 5, aboveMax: 'reject',
    });

    const chunks = await adapter.getChunk(params.name, sourceFile, chunkIndex, { window });
    sendJson(res, 200, { collection: params.name, sourceFile, chunkIndex, window, chunks });
  });
}
