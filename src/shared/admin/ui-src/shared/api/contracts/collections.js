// Hand-written response validator for GET /api/collections (design plan
// §5.1, §5.2, §8.2, §15). Field-by-field derived from
// src/core/storage/qdrant-adapter.js's listCollections() — the function
// that builds every element of the `collections` array:
//
//   { collections: [ { name: string, pointCount: number,
//     vectorSchema: string, provider: { denseProvider: string|null,
//     denseModel: string|null, sparseProvider: string|null },
//     embeddingProfileState: string, description: string|null } ] }
//
// `vectorSchema` is a free-form classifier string (classifyVectorSchema()'s
// return value, e.g. 'named'/'flat'/'empty' today) — validated as a
// non-empty string rather than a fixed enum, so a new classification value
// added server-side is forward-compatible, not a contract break.
// `embeddingProfileState` is resolveEmbeddingProfileFromInfo()'s `.state`
// value (e.g. 'valid'/'missing'/'invalid'/'schema_mismatch'/
// 'unsupported_schema_version') — same non-empty-string treatment for the
// same forward-compatibility reason. Unknown fields are never stripped.
import { ApiError } from '../client.js';

function contractError(message) {
  return new ApiError({ kind: 'contract', message });
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function validateCollectionShape(col, path) {
  if (typeof col !== 'object' || col === null || Array.isArray(col)) {
    throw contractError(`${path} must be an object`);
  }
  if (typeof col.name !== 'string' || col.name === '') {
    throw contractError(`${path}.name must be a non-empty string`);
  }
  if (typeof col.pointCount !== 'number' || !Number.isFinite(col.pointCount)) {
    throw contractError(`${path}.pointCount must be a finite number`);
  }
  if (typeof col.vectorSchema !== 'string' || col.vectorSchema === '') {
    throw contractError(`${path}.vectorSchema must be a non-empty string`);
  }
  const provider = col.provider;
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
    throw contractError(`${path}.provider must be an object`);
  }
  if (!isNullableString(provider.denseProvider)) throw contractError(`${path}.provider.denseProvider must be a string or null`);
  if (!isNullableString(provider.denseModel)) throw contractError(`${path}.provider.denseModel must be a string or null`);
  if (!isNullableString(provider.sparseProvider)) throw contractError(`${path}.provider.sparseProvider must be a string or null`);
  if (typeof col.embeddingProfileState !== 'string' || col.embeddingProfileState === '') {
    throw contractError(`${path}.embeddingProfileState must be a non-empty string`);
  }
  if (!isNullableString(col.description)) {
    throw contractError(`${path}.description must be a string or null`);
  }
  return col;
}

/**
 * Validates a GET /api/collections response body: `{ collections: [...] }`.
 * Throws ApiError{kind:'contract'} on any malformed required field. Returns
 * the same body object on success.
 */
export function validateCollectionsListResponse(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw contractError('GET /api/collections response must be an object');
  }
  if (!Array.isArray(body.collections)) {
    throw contractError('GET /api/collections response field "collections" must be an array');
  }
  body.collections.forEach((col, index) => validateCollectionShape(col, `collections[${index}]`));
  return body;
}
