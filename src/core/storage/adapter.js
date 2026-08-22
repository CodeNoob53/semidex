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
 * @property {(name: string, opts?: { checkOllamaLane?: Function, checkOnnxModelCached?: Function }) => Promise<Object|null>} getCollection
 *   opts is optional Part-F availability DI: checkOllamaLane is required only
 *   when the collection's resolved profile has an ollama lane (core/ never
 *   imports Ollama-probing code itself — the caller, e.g. Admin API or MCP,
 *   injects it); checkOnnxModelCached defaults to the safe core-only
 *   onnx-lane.js implementation and rarely needs overriding.
 * @property {(name: string, opts: { profile: Object, vectorSize?: number }) => Promise<void>} createCollection
 *   profile is REQUIRED — every new Semidex collection must be created with
 *   a canonical embedding profile atomically; there is no metadata-less
 *   creation path. vectorSize is optional and, when given, is only used as
 *   a cross-check against profile.embedding.dense.dimensions (throws on
 *   disagreement) — it is never an independent source of truth.
 * @property {(name: string) => Promise<void>} deleteCollection
 * @property {(name: string) => Promise<{ repaired: string[], warnings: string[] }>} ensureCollectionSchema
 *
 * @property {(name: string) => Promise<Object>} getEmbeddingProfile
 * @property {(name: string, profile: Object) => Promise<void>} setEmbeddingProfile
 * @property {(name: string, state: Object) => Promise<void>} setIndexingState
 * @property {(name: string) => Promise<Object>} migrateEmbeddingProfile
 *
 * @property {(name: string, opts?: { prefix?: string, limit?: number }) => Promise<Object[]>} listSourceDocuments
 * @property {(name: string, sourceFile: string, chunkIndex: number, opts?: { window?: number }) => Promise<Object[]>} getChunk
 * @property {(name: string, sourceFile: string) => Promise<Object[]>} getFileChunks
 * @property {(name: string, opts: { nodeId?: string, nodePath?: string }) => Promise<Object[]|null>} getSectionChunks
 *
 * @property {(name: string, opts: { dense: number[], sparse?: Object, limit?: number, filter?: Object }) => Promise<Object[]>} searchHybridVectors
 *   Storage-only: takes REAL vectors already computed by the caller —
 *   never embeds anything itself.
 * @property {(name: string, opts: { denseQuery: {text: string, model: string}, sparseQuery?: {text: string, model: string}|null, limit?: number, filter?: Object }) => Promise<Object[]>} searchHybridInference
 *   Storage-only: takes ALREADY-BUILT {text, model} inference descriptors
 *   (Qdrant Cloud Inference) — never embeds anything itself, never imports
 *   embeddings.js/onnx-embed.js/ollama.js.
 * @property {() => Promise<{ status: 'ok'|'unreachable'|'auth_failed', message?: string }>} checkCloudInferenceReachable
 *   Cheap, routine reachability+auth check for a cloud-inference lane —
 *   never proves inference itself works. Backends with no cloud-inference
 *   concept may return { status: 'ok' } unconditionally.
 * @property {(opts: { profile: Object, sampleText?: string }) => Promise<{ status: string, message?: string }>} probeInference
 *   Provider-neutral: proves a profile's Cloud Inference configuration
 *   ACTUALLY WORKS via one real, minimal round-trip against a disposable
 *   collection — never touches an existing user collection, only ever
 *   called on an explicit user action. A backend/profile combination with
 *   no such capability returns { status: 'unsupported' } rather than
 *   throwing.
 *
 * @property {(name: string) => Promise<Object|null>} getSkeletonRoot
 * @property {(name: string, opts: { nodeId?: string, nodePath?: string }) => Promise<Object|null>} getSkeletonNode
 * @property {(name: string, opts: { nodeId?: string, nodePath?: string, limit?: number }) => Promise<Object[]>} getSkeletonChildren
 * @property {(name: string, opts: { nodeId?: string, nodePath?: string }) => Promise<Object|null>} getContentNode
 * @property {(name: string, opts: { nodeId?: string, nodePath?: string }) => Promise<Object|null>} getSectionAnchor
 *
 * @property {(name: string, opts: { nodeId?: string, parentId?: string|null, sourceFile?: string, chunkIndex?: number, limit?: number }) => Promise<Array<{ chunk: Object, relation: string }>>} [getStructuralNeighbors]
 *   OPTIONAL — graph-expanded retrieval (docs/design/graph-expanded-retrieval.md).
 *   Not in REQUIRED_ADAPTER_METHODS; gated by capabilities().structuralExpansion.
 *   Resolves bounded depth-1 structural neighbors (section siblings via
 *   parent_id, previous/next content chunk via chunk_index) for one
 *   skeleton-aware seed chunk, via indexed lookups only — never an
 *   exhaustive collection scan. Returns real retrieval-content points only,
 *   never a skeleton_nav point. A backend without this capability simply
 *   omits the method; callers must check capabilities().structuralExpansion
 *   (or typeof adapter.getStructuralNeighbors === 'function') before calling.
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
  'getEmbeddingProfile',
  'setEmbeddingProfile',
  'setIndexingState',
  'migrateEmbeddingProfile',
  'listSourceDocuments',
  'getChunk',
  'getFileChunks',
  'getSectionChunks',
  'searchHybridVectors',
  'searchHybridInference',
  'checkCloudInferenceReachable',
  'probeInference',
  'getSkeletonRoot',
  'getSkeletonNode',
  'getSkeletonChildren',
  'getContentNode',
  'getSectionAnchor',
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
