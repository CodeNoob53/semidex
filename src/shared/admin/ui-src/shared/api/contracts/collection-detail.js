// Hand-written response validator for GET /api/collections/:name (design
// plan §5.3, §8.2, §15). Field-by-field derived from
// src/core/storage/qdrant-adapter.js's getCollection() — the function that
// builds the `collection` object returned by src/shared/admin/api/
// collections.js's GET /api/collections/:name route:
//
//   { collection: { name, pointCount, chunkCount, semidexManaged,
//     hasSkeleton, warnings: string[], description, overviewSummary,
//     vectorSchema: { dense: { size, distance }|null-ish, sparse: boolean },
//     provider: { denseProvider, denseModel, sparseProvider },
//     embeddingProfile: { state, profile? },
//     versions: { embeddingSchema, chunkingSchema, indexingSchema, tokenCountMode },
//     availability: { status, dense?, sparse? } } }
//
// Only validates the fields features/collection-home/view.js actually
// consumes (same convention as ./collections.js's list validator) — every
// other field getCollection() returns (legacyDetectedProvider,
// indexingState, availability.aggregate, ...) is passed through unvalidated
// and unstripped, so adding a new adapter field is never a contract break.
import { ApiError } from '../client.js';

function contractError(message) {
  return new ApiError({ kind: 'contract', message });
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function requireObject(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw contractError(`${path} must be an object`);
  }
  return value;
}

function validateVectorSchema(vectorSchema, path) {
  requireObject(vectorSchema, path);
  const dense = requireObject(vectorSchema.dense, `${path}.dense`);
  if (dense.size !== null && !(typeof dense.size === 'number' && Number.isFinite(dense.size))) {
    throw contractError(`${path}.dense.size must be a finite number or null`);
  }
  if (!isNullableString(dense.distance)) throw contractError(`${path}.dense.distance must be a string or null`);
  if (typeof vectorSchema.sparse !== 'boolean') throw contractError(`${path}.sparse must be a boolean`);
}

function validateProvider(provider, path) {
  requireObject(provider, path);
  if (!isNullableString(provider.denseProvider)) throw contractError(`${path}.denseProvider must be a string or null`);
  if (!isNullableString(provider.denseModel)) throw contractError(`${path}.denseModel must be a string or null`);
  if (!isNullableString(provider.sparseProvider)) throw contractError(`${path}.sparseProvider must be a string or null`);
}

// embeddingProfile.profile is only present/meaningful when state === 'valid'
// (resolveEmbeddingProfileFromInfo()'s other states — missing/invalid/
// schema_mismatch/unsupported_schema_version — carry no usable profile).
// Validated loosely: only the fields the Details panel actually reads
// (embedding.dense.vectorName/execution, embedding.sparse.vectorName).
function validateEmbeddingProfile(embeddingProfile, path) {
  requireObject(embeddingProfile, path);
  if (typeof embeddingProfile.state !== 'string' || embeddingProfile.state === '') {
    throw contractError(`${path}.state must be a non-empty string`);
  }
  if (embeddingProfile.state !== 'valid') return;
  const profile = requireObject(embeddingProfile.profile, `${path}.profile`);
  const embedding = requireObject(profile.embedding, `${path}.profile.embedding`);
  const dense = requireObject(embedding.dense, `${path}.profile.embedding.dense`);
  if (typeof dense.vectorName !== 'string' || dense.vectorName === '') {
    throw contractError(`${path}.profile.embedding.dense.vectorName must be a non-empty string`);
  }
  if (!isNullableString(dense.execution)) {
    throw contractError(`${path}.profile.embedding.dense.execution must be a string or null`);
  }
  if (embedding.sparse !== undefined && embedding.sparse !== null) {
    const sparse = requireObject(embedding.sparse, `${path}.profile.embedding.sparse`);
    if (typeof sparse.vectorName !== 'string' || sparse.vectorName === '') {
      throw contractError(`${path}.profile.embedding.sparse.vectorName must be a non-empty string`);
    }
  }
}

// embeddingSchema/chunkingSchema/indexingSchema are the raw numeric schema
// version constants (CHUNKING_SCHEMA_VERSION, INDEXING_SCHEMA_VERSION_*,
// profile.embeddingSchemaVersion — src/shared/core/token-count.js,
// src/shared/indexer/skeleton-payload.js), never strings — validating them
// as isNullableString here would reject every real collection's actual
// response. tokenCountMode (resolveTokenCountMode()) is the one field in
// this group that is genuinely a string (e.g. "bge-m3", "heuristic", or a
// "qdrant-cloud:<model>" identity) or null.
function validateVersions(versions, path) {
  requireObject(versions, path);
  for (const field of ['embeddingSchema', 'chunkingSchema', 'indexingSchema']) {
    if (!isNullableNumber(versions[field])) throw contractError(`${path}.${field} must be a finite number or null`);
  }
  if (!isNullableString(versions.tokenCountMode)) throw contractError(`${path}.tokenCountMode must be a string or null`);
}

function validateAvailability(availability, path) {
  requireObject(availability, path);
  if (typeof availability.status !== 'string' || availability.status === '') {
    throw contractError(`${path}.status must be a non-empty string`);
  }
  for (const field of ['dense', 'sparse']) {
    const value = availability[field];
    if (value === undefined || value === null) continue;
    const reasonPath = `${path}.${field}.reason`;
    if (typeof value !== 'object' || Array.isArray(value)) throw contractError(`${path}.${field} must be an object, string, or null`);
    if (value.reason !== undefined && !isNullableString(value.reason)) throw contractError(`${reasonPath} must be a string or null`);
  }
}

/**
 * Validates a GET /api/collections/:name response body: `{ collection: {...} }`.
 * Throws ApiError{kind:'contract'} on any malformed required field. Returns
 * the same body object on success.
 */
export function validateCollectionDetailResponse(body) {
  requireObject(body, 'GET /api/collections/:name response');
  const collection = requireObject(body.collection, 'collection');

  if (typeof collection.name !== 'string' || collection.name === '') {
    throw contractError('collection.name must be a non-empty string');
  }
  if (typeof collection.pointCount !== 'number' || !Number.isFinite(collection.pointCount)) {
    throw contractError('collection.pointCount must be a finite number');
  }
  if (typeof collection.chunkCount !== 'number' || !Number.isFinite(collection.chunkCount)) {
    throw contractError('collection.chunkCount must be a finite number');
  }
  if (typeof collection.semidexManaged !== 'boolean') throw contractError('collection.semidexManaged must be a boolean');
  if (typeof collection.hasSkeleton !== 'boolean') throw contractError('collection.hasSkeleton must be a boolean');
  if (!Array.isArray(collection.warnings) || collection.warnings.some((w) => typeof w !== 'string')) {
    throw contractError('collection.warnings must be an array of strings');
  }
  if (!isNullableString(collection.description)) throw contractError('collection.description must be a string or null');
  if (!isNullableString(collection.overviewSummary)) throw contractError('collection.overviewSummary must be a string or null');

  validateVectorSchema(collection.vectorSchema, 'collection.vectorSchema');
  validateProvider(collection.provider, 'collection.provider');
  validateEmbeddingProfile(collection.embeddingProfile, 'collection.embeddingProfile');
  validateVersions(collection.versions, 'collection.versions');
  validateAvailability(collection.availability, 'collection.availability');

  return body;
}
