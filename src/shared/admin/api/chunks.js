// GET /api/collections/:name/chunks — StorageAdapter-only.
import { sendJson, notFound } from '../../../core/http/http.js';
import { parseIntParam, requireStringParam } from './query-params.js';
import { AUDIENCE, OPERATION, COST_CLASS, COLLECTION_SOURCE } from '../../../core/http/route-audience.js';

export function registerChunksRoutes(router, adapter) {
  router.get('/api/collections/:name/chunks', async ({ res, params, query }) => {
    const existing = await adapter.getCollection(params.name);
    if (!existing) throw notFound(`Collection "${params.name}" not found`);

    const sourceFile = requireStringParam(query, 'sourceFile');
    // chunkIndex has no natural upper bound (it's per-file) and no sensible
    // clamp target, so when present it rejects (never clamps) if negative.
    // Omitting it entirely switches this endpoint to "give me the whole
    // file" mode (getFileChunks) — the admin UI's file view needs the real,
    // complete chunk list for a file it just opened, not an approximation
    // built from a retrieval-context window centered on chunk 0. Windowed
    // mode (an explicit chunkIndex + optional window) is unchanged and
    // still what section-anchor / "load more" callers use.
    const chunkIndex = parseIntParam(query, 'chunkIndex', { min: 0, belowMin: 'reject' });
    if (chunkIndex === undefined) {
      const chunks = await adapter.getFileChunks(params.name, sourceFile);
      sendJson(res, 200, { collection: params.name, sourceFile, chunkIndex: null, window: null, chunks });
      return;
    }

    // window: reject out-of-range on both sides — a silently-clamped window
    // could confuse a caller comparing requested vs. returned chunk counts.
    const window = parseIntParam(query, 'window', {
      defaultValue: 0, min: 0, belowMin: 'reject', max: 5, aboveMax: 'reject',
    });

    const chunks = await adapter.getChunk(params.name, sourceFile, chunkIndex, { window });
    sendJson(res, 200, { collection: params.name, sourceFile, chunkIndex, window, chunks });
  }, { audience: AUDIENCE.ADMIN, operation: OPERATION.READ, resourceType: 'chunk', collectionSource: COLLECTION_SOURCE.PATH, costClass: COST_CLASS.QDRANT });
}
