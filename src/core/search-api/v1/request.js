// Search API v1 — public request parsing/validation (pure, no I/O).
//
// Field-level validation (types, bounds, defaults for collection/query/top/
// window/windowFormat/sourceFile/tags) is NOT reimplemented here — it is
// shared with the Admin dashboard's unversioned /api/search via
// src/core/retrieval/search-request.js's parseSearchRequest(), so the two
// surfaces can never quietly drift on bounds or defaults (see that module's
// own header comment).
//
// This module adds exactly one thing on top of the shared parser: rejecting
// any unknown root field. That is a deliberate PUBLIC-CONTRACT-only
// tightening (mirroring src/core/ask-api/v1/request.js's identical
// "reject anything outside the known root field set" rule) — the Admin
// route stays lenient (unchanged behavior, unchanged tests); the public v1
// contract is explicit about its entire accepted shape from day one.
import { badRequest } from '../../http/http.js';
import { parseSearchRequest as parseSharedSearchRequest } from '../../retrieval/search-request.js';

const KNOWN_ROOT_KEYS = new Set(['collection', 'query', 'top', 'window', 'windowFormat', 'sourceFile', 'tags']);

/**
 * @param {unknown} body — parsed JSON request body
 * @returns {{ collection: string, query: string, top: number, window: number, windowFormat: 'compact'|'full'|null, sourceFile: string|null, tags: string[]|null }}
 * @throws {import('../../http/http.js').HttpError} 400 bad_request
 */
export function parseSearchRequestV1(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  const unknownKeys = Object.keys(body).filter((k) => !KNOWN_ROOT_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw badRequest(`Unknown body field(s): ${unknownKeys.join(', ')}. The v1 Search API accepts only ${[...KNOWN_ROOT_KEYS].map((k) => `"${k}"`).join(', ')}.`);
  }

  return parseSharedSearchRequest(body);
}
