// Hand-written response validator for GET /api/capabilities (design plan
// §6, §8.2, §15). Field-by-field derived from
// src/shared/admin/api/health.js's registerHealthRoutes() handler (the
// route lives in health.js, not a separate capabilities.js — see that
// file's own registerHealthRoutes()):
//
//   { backend: string, capabilities: { [key: string]: boolean } }
//
// `capabilities` is StorageAdapter.capabilities()'s own return value
// (src/core/storage/adapter.js's validateStorageAdapter() already requires
// it to be a plain object at the adapter layer) — every value observed
// across adapters (qdrant-adapter.js's QDRANT_CAPABILITIES, the stub
// adapter in tests/unit/admin/ui-test-helpers.js) is a boolean, so this
// validator requires that shape rather than accepting arbitrary values,
// while still tolerating an adapter that reports a capability key this
// module has never heard of (no fixed key allowlist).
import { ApiError } from '../client.js';

function contractError(message) {
  return new ApiError({ kind: 'contract', message });
}

/**
 * Validates a GET /api/capabilities response body. Throws
 * ApiError{kind:'contract'} on any malformed required field. Returns the
 * same body object on success.
 */
export function validateCapabilitiesResponse(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw contractError('GET /api/capabilities response must be an object');
  }
  if (typeof body.backend !== 'string' || body.backend === '') {
    throw contractError('GET /api/capabilities response field "backend" must be a non-empty string');
  }
  const capabilities = body.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    throw contractError('GET /api/capabilities response field "capabilities" must be an object');
  }
  for (const [key, value] of Object.entries(capabilities)) {
    if (typeof value !== 'boolean') {
      throw contractError(`capabilities.${key} must be a boolean`);
    }
  }
  return body;
}
