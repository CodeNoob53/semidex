// Provider-neutral embedding profile domain contract — pure, no I/O, no
// Qdrant shapes. This module is the ONE canonical schema definition and
// validator for a collection's embedding identity (Part A of the native
// Qdrant collection metadata task). It never reads or knows anything about
// Qdrant's CollectionInfo/config.metadata/config.params.vectors response
// shapes — that knowledge lives entirely in src/core/storage/qdrant-adapter.js
// (Part B), which normalizes Qdrant's shape into a small domain-shaped
// vector-schema summary before ever calling into this module's validators.
//
// Two separate, independently-versioned documents, not one:
//   - the embedding PROFILE (this file's primary export) is immutable/
//     write-once — it identifies a vector space (provider, model, vector
//     name, dimensions, distance, execution mode) and must never silently
//     change once a collection has vectors written against it.
//   - the indexing STATE (indexingSchemaVersion/chunkingSchemaVersion) is
//     mutable — it changes whenever the chunker/indexer is upgraded, with
//     no relation to the embedding model at all. Bundling both under one
//     write-once profile would make a normal indexer upgrade illegally
//     require "rewriting an immutable profile." Kept as two distinct Qdrant
//     top-level metadata keys (METADATA_KEY_EMBEDDING_PROFILE /
//     METADATA_KEY_INDEXING_STATE) so an indexing-state update can never
//     touch the embedding profile key, and vice versa — this also plays
//     correctly with Qdrant's updateCollection() shallow top-level merge,
//     which merges across distinct top-level keys, not within one.
export const EMBEDDING_PROFILE_SCHEMA_VERSION = 1;
export const MANAGED_BY = 'semidex';

// Qdrant metadata key names — the ONLY place these two string literals are
// defined. src/core/storage/qdrant-adapter.js imports them rather than
// repeating the literals, but never interprets Qdrant response shapes here.
export const METADATA_KEY_EMBEDDING_PROFILE = 'semidex_embedding_profile';
export const METADATA_KEY_INDEXING_STATE = 'semidex_indexing_state';

// CLIENT: embedded by this process (ONNX/Ollama). QDRANT_CLUSTER: computed
// server-side by the connected Qdrant cluster itself (e.g. a built-in
// sparse model like qdrant/bm25) — distinct from QDRANT_CLOUD, which is
// Qdrant Cloud's separately billed Inference API. Collapsing the latter two
// would make a future dense=e5(qdrant-cloud) + sparse=bm25(qdrant-cluster)
// profile unrepresentable.
export const EXECUTION = Object.freeze({
  CLIENT: 'client',
  QDRANT_CLUSTER: 'qdrant-cluster',
  QDRANT_CLOUD: 'qdrant-cloud',
});

const VALID_EXECUTIONS = new Set(Object.values(EXECUTION));

// Secret-shaped key guard — applied recursively to every object in a
// profile/state, including nested `options` bags. No credential field is
// defined anywhere in this contract (per task non-goals); this is defense
// in depth against ever accidentally smuggling one into Qdrant metadata.
const SECRET_KEY_PATTERN = /(key|secret|token|password|credential)$/i;

function findSecretShapedKey(value, path = '') {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findSecretShapedKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (SECRET_KEY_PATTERN.test(key)) return fullPath;
    const found = findSecretShapedKey(value[key], fullPath);
    if (found) return found;
  }
  return null;
}

const DENSE_LANE_KEYS = new Set([
  'provider', 'model', 'vectorName', 'dimensions', 'distance', 'execution', 'options',
]);
const SPARSE_LANE_KEYS = new Set([
  'provider', 'model', 'vectorName', 'execution', 'modifier', 'options',
]);
const PROFILE_TOP_KEYS = new Set(['schemaVersion', 'managedBy', 'embedding', 'embeddingSchemaVersion']);
const EMBEDDING_KEYS = new Set(['dense', 'sparse']);

function unknownKey(allowed, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function isPlainObjectOrNull(value) {
  return value === null || (typeof value === 'object' && !Array.isArray(value));
}

/**
 * Validates a dense lane object. Returns an array of error strings (empty
 * when valid) — never throws itself, so callers can decide how to surface
 * validation failures (e.g. Part B's typed 'invalid' state).
 */
function validateDenseLane(dense, errors, pathPrefix) {
  if (dense === null || typeof dense !== 'object' || Array.isArray(dense)) {
    errors.push(`${pathPrefix} must be an object`);
    return;
  }
  const badKey = unknownKey(DENSE_LANE_KEYS, dense);
  if (badKey) errors.push(`${pathPrefix} has unknown key "${badKey}"`);
  if (typeof dense.provider !== 'string' || dense.provider === '') errors.push(`${pathPrefix}.provider must be a non-empty string`);
  if (typeof dense.model !== 'string' || dense.model === '') errors.push(`${pathPrefix}.model must be a non-empty string`);
  if (typeof dense.vectorName !== 'string' || dense.vectorName === '') errors.push(`${pathPrefix}.vectorName must be a non-empty string`);
  if (!Number.isFinite(dense.dimensions) || dense.dimensions <= 0) errors.push(`${pathPrefix}.dimensions must be a positive number`);
  if (typeof dense.distance !== 'string' || dense.distance === '') errors.push(`${pathPrefix}.distance must be a non-empty string`);
  if (!VALID_EXECUTIONS.has(dense.execution)) errors.push(`${pathPrefix}.execution must be one of ${[...VALID_EXECUTIONS].join(', ')}`);
  if (dense.options !== undefined && !isPlainObjectOrNull(dense.options)) errors.push(`${pathPrefix}.options must be an object or null`);
}

function validateSparseLane(sparse, errors, pathPrefix) {
  if (sparse === null) return; // sparse: null is a valid, real state (dense-only collection)
  if (typeof sparse !== 'object' || Array.isArray(sparse)) {
    errors.push(`${pathPrefix} must be an object or null`);
    return;
  }
  const badKey = unknownKey(SPARSE_LANE_KEYS, sparse);
  if (badKey) errors.push(`${pathPrefix} has unknown key "${badKey}"`);
  if (typeof sparse.provider !== 'string' || sparse.provider === '') errors.push(`${pathPrefix}.provider must be a non-empty string`);
  if (typeof sparse.model !== 'string' || sparse.model === '') errors.push(`${pathPrefix}.model must be a non-empty string`);
  if (typeof sparse.vectorName !== 'string' || sparse.vectorName === '') errors.push(`${pathPrefix}.vectorName must be a non-empty string`);
  if (!VALID_EXECUTIONS.has(sparse.execution)) errors.push(`${pathPrefix}.execution must be one of ${[...VALID_EXECUTIONS].join(', ')}`);
  // modifier is a Qdrant sparse VECTOR SCHEMA parameter (e.g. 'idf' for
  // BM25-style scoring), distinct from `options` (inference-side settings
  // like tokenizer/stemming) — kept separate so validateProfileAgainstSchema
  // (Part B) can verify it against the live Qdrant sparse_vectors config,
  // exactly like vectorName/dimensions/distance already are.
  if (sparse.modifier !== undefined && sparse.modifier !== null && typeof sparse.modifier !== 'string') {
    errors.push(`${pathPrefix}.modifier must be a string or null`);
  }
  if (sparse.options !== undefined && !isPlainObjectOrNull(sparse.options)) errors.push(`${pathPrefix}.options must be an object or null`);
}

/**
 * Builds the immutable embedding profile shape:
 * {
 *   schemaVersion, managedBy,
 *   embedding: {
 *     dense: { provider, model, vectorName, dimensions, distance, execution, options },
 *     sparse: { provider, model, vectorName, execution, modifier, options } | null,
 *   },
 *   embeddingSchemaVersion,
 * }
 *
 * `dense`/`sparse` inputs are the caller's already-resolved lane values —
 * this function only stamps the constant/versioned envelope fields, it does
 * not resolve provider defaults itself (that's Part C's job).
 *
 * @param {{ dense: object, sparse: object|null, embeddingSchemaVersion?: number }} params
 */
export function buildEmbeddingProfile({ dense, sparse = null, embeddingSchemaVersion }) {
  return {
    schemaVersion: EMBEDDING_PROFILE_SCHEMA_VERSION,
    managedBy: MANAGED_BY,
    embedding: {
      dense: {
        provider: dense.provider,
        model: dense.model,
        vectorName: dense.vectorName,
        dimensions: dense.dimensions,
        distance: dense.distance,
        execution: dense.execution,
        options: dense.options ?? null,
      },
      sparse: sparse === null ? null : {
        provider: sparse.provider,
        model: sparse.model,
        vectorName: sparse.vectorName,
        execution: sparse.execution,
        modifier: sparse.modifier ?? null,
        options: sparse.options ?? null,
      },
    },
    embeddingSchemaVersion,
  };
}

/**
 * Validates a profile's shape. Returns `{ valid: true }` or
 * `{ valid: false, errors: string[] }` — never throws. Checks: required
 * top-level/nested fields present with correct types, no unknown keys at
 * any level (including inside `options`), and no secret-shaped key
 * anywhere in the tree (top-level or nested, including inside `options`).
 *
 * @param {unknown} profile
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
export function validateEmbeddingProfile(profile) {
  const errors = [];

  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    return { valid: false, errors: ['profile must be an object'] };
  }

  const secretKey = findSecretShapedKey(profile);
  if (secretKey) errors.push(`profile contains a secret-shaped key: "${secretKey}"`);

  const badTopKey = unknownKey(PROFILE_TOP_KEYS, profile);
  if (badTopKey) errors.push(`profile has unknown top-level key "${badTopKey}"`);

  if (profile.schemaVersion !== EMBEDDING_PROFILE_SCHEMA_VERSION) {
    errors.push(`profile.schemaVersion must be ${EMBEDDING_PROFILE_SCHEMA_VERSION}, got ${JSON.stringify(profile.schemaVersion)}`);
  }
  if (profile.managedBy !== MANAGED_BY) {
    errors.push(`profile.managedBy must be "${MANAGED_BY}", got ${JSON.stringify(profile.managedBy)}`);
  }
  if (!Number.isFinite(profile.embeddingSchemaVersion)) {
    errors.push('profile.embeddingSchemaVersion must be a number');
  }

  if (profile.embedding === null || typeof profile.embedding !== 'object' || Array.isArray(profile.embedding)) {
    errors.push('profile.embedding must be an object');
  } else {
    const badEmbeddingKey = unknownKey(EMBEDDING_KEYS, profile.embedding);
    if (badEmbeddingKey) errors.push(`profile.embedding has unknown key "${badEmbeddingKey}"`);
    validateDenseLane(profile.embedding.dense, errors, 'profile.embedding.dense');
    validateSparseLane(profile.embedding.sparse, errors, 'profile.embedding.sparse');
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

const INDEXING_STATE_KEYS = new Set(['indexingSchemaVersion', 'chunkingSchemaVersion']);

/**
 * Builds the mutable indexing-state shape:
 * { indexingSchemaVersion, chunkingSchemaVersion }
 * Updated freely by any indexing job — never subject to a write-once guard.
 */
export function buildIndexingState({ indexingSchemaVersion, chunkingSchemaVersion }) {
  return { indexingSchemaVersion, chunkingSchemaVersion };
}

/**
 * Validates an indexing-state shape. Same allow-list/secret-guard
 * discipline as validateEmbeddingProfile, applied to the much smaller
 * mutable-state shape.
 */
export function validateIndexingState(state) {
  const errors = [];

  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return { valid: false, errors: ['state must be an object'] };
  }

  const secretKey = findSecretShapedKey(state);
  if (secretKey) errors.push(`state contains a secret-shaped key: "${secretKey}"`);

  const badKey = unknownKey(INDEXING_STATE_KEYS, state);
  if (badKey) errors.push(`state has unknown key "${badKey}"`);

  if (!Number.isFinite(state.indexingSchemaVersion)) errors.push('state.indexingSchemaVersion must be a number');
  if (!Number.isFinite(state.chunkingSchemaVersion)) errors.push('state.chunkingSchemaVersion must be a number');

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
