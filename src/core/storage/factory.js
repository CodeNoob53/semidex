// Storage adapter factory: resolves which StorageAdapter implementation to
// construct, keyed by backend name. Single choke point so callers (the
// Local API, and later the indexer/MCP tools per design doc Phase 4) never
// hardcode `createQdrantStorageAdapter` directly.
import { createQdrantStorageAdapter } from './qdrant-adapter.js';

const BACKENDS = {
  qdrant: createQdrantStorageAdapter,
};

/**
 * @param {{ backend?: string }} [options] - defaults to
 *   process.env.SEMIDEX_STORAGE_BACKEND, then 'qdrant'.
 * @returns {import('./adapter.js').StorageAdapter}
 * @throws {Error} for an unknown backend name
 */
export function createStorageAdapter({ backend = process.env.SEMIDEX_STORAGE_BACKEND ?? 'qdrant' } = {}) {
  const make = BACKENDS[backend];
  if (!make) {
    const known = Object.keys(BACKENDS).join(', ');
    throw new Error(`createStorageAdapter: unknown backend "${backend}" (known backends: ${known})`);
  }
  return make();
}
