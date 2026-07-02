// StorageAdapter contract: JSDoc typedefs (documentation only, not enforced
// by the runtime) plus a small runtime shape validator. No backend imports —
// this file must stay importable with zero configuration and zero SDKs.
//
// See docs/design/admin-ui-and-storage-adapter.md §5 for the full interface
// draft and the domain shapes (Collection, Chunk, SkeletonNode, ...) each
// method returns.

/**
 * @typedef {Object} StorageAdapter
 *
 * @property {() => string} name
 * @property {() => Object} capabilities
 * @property {() => Promise<{ ok: boolean, detail: string }>} ping
 *
 * @property {() => Promise<Object[]>} listCollections
 * @property {(name: string) => Promise<Object|null>} getCollection
 * @property {(name: string, opts: { vectorSize?: number }) => Promise<void>} createCollection
 * @property {(name: string) => Promise<void>} deleteCollection
 * @property {(name: string) => Promise<{ repaired: string[], warnings: string[] }>} ensureCollectionSchema
 *
 * @property {(name: string, opts?: { prefix?: string, limit?: number }) => Promise<Object[]>} listSourceDocuments
 * @property {(name: string, sourceFile: string, chunkIndex: number, opts?: { window?: number }) => Promise<Object[]>} getChunk
 *
 * @property {(name: string, opts: { dense: number[], sparse?: Object, limit?: number, filter?: Object }) => Promise<Object[]>} searchHybrid
 *
 * @property {(name: string) => Promise<Object|null>} getSkeletonRoot
 * @property {(name: string, opts: { nodeId?: string, nodePath?: string }) => Promise<Object|null>} getSkeletonNode
 * @property {(name: string, opts: { nodeId?: string, nodePath?: string, limit?: number }) => Promise<Object[]>} getSkeletonChildren
 * @property {(name: string, opts: { nodeId?: string, nodePath?: string }) => Promise<Object|null>} getStructuralNode
 */

// Every method a conforming StorageAdapter must expose. Kept as a flat list
// (not grouped) so validateStorageAdapter and tests can iterate it directly.
export const REQUIRED_ADAPTER_METHODS = [
  'name',
  'capabilities',
  'ping',
  'listCollections',
  'getCollection',
  'createCollection',
  'deleteCollection',
  'ensureCollectionSchema',
  'listSourceDocuments',
  'getChunk',
  'searchHybrid',
  'getSkeletonRoot',
  'getSkeletonNode',
  'getSkeletonChildren',
  'getStructuralNode',
];

/**
 * Verify an object satisfies the StorageAdapter shape: every required method
 * present and callable, capabilities() returns a plain object. Deliberately
 * shallow — this is a shape check, not a type system. It does not call any
 * adapter method other than capabilities() (which must be synchronous and
 * side-effect free per the contract).
 *
 * @param {Object} adapter
 * @throws {Error} with an actionable message naming the missing/invalid piece
 */
export function validateStorageAdapter(adapter) {
  if (typeof adapter !== 'object' || adapter === null) {
    throw new Error('validateStorageAdapter: adapter must be a non-null object');
  }

  const missing = REQUIRED_ADAPTER_METHODS.filter(m => typeof adapter[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `validateStorageAdapter: adapter is missing required method(s): ${missing.join(', ')}`
    );
  }

  const caps = adapter.capabilities();
  if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
    throw new Error('validateStorageAdapter: capabilities() must return a plain object');
  }

  return true;
}
