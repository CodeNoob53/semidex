// Hand-written response validator for GET /api/health (design plan §5.1,
// §8.2, §15). Field-by-field derived from
// src/shared/admin/api/health.js's registerHealthRoutes() handler, the only
// place this response shape is built:
//
//   { ok: boolean, storage: { backend: string, ok: boolean, detail: string|null } }
//
// Unknown fields are never stripped — a validated response is the SAME
// object the server sent, so a future server-side addition still reaches
// the UI unchanged (forward compatibility).
import { ApiError } from '../client.js';

function contractError(message) {
  return new ApiError({ kind: 'contract', message });
}

/**
 * Validates a GET /api/health response body. Throws
 * ApiError{kind:'contract'} on any malformed required field. Returns the
 * same body object on success.
 */
export function validateHealthResponse(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw contractError('GET /api/health response must be an object');
  }
  if (typeof body.ok !== 'boolean') {
    throw contractError('GET /api/health response field "ok" must be a boolean');
  }
  const storage = body.storage;
  if (typeof storage !== 'object' || storage === null || Array.isArray(storage)) {
    throw contractError('GET /api/health response field "storage" must be an object');
  }
  if (typeof storage.backend !== 'string' || storage.backend === '') {
    throw contractError('storage.backend must be a non-empty string');
  }
  if (typeof storage.ok !== 'boolean') {
    throw contractError('storage.ok must be a boolean');
  }
  if (storage.detail !== null && typeof storage.detail !== 'string') {
    throw contractError('storage.detail must be a string or null');
  }
  return body;
}
