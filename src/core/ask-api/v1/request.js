// Ask API v1 — public request parsing/validation (pure, no I/O).
//
// The public request shape is deliberately narrower than the internal
// coordinator's own parameters: `collection` and `question` are the only
// required fields, `scope.sourceFile` is the only supported scope
// narrowing, and retrieval count / RRF parameters / evidence budgets /
// model prompts are NOT public client controls — they stay internal
// Semidex configuration (see resolveGenerationRuntimeConfig,
// DEFAULT_TOP in core/ask/evidence.js). A client sending the OBSOLETE
// root-level `sourceFile` or `top` fields from the pre-v1 seed contract is
// rejected outright, not silently accepted as a second, undocumented
// contract alongside the real one.
import { badRequest } from '../../http/http.js';

/**
 * @param {unknown} body — parsed JSON request body
 * @returns {{ collection: string, question: string, sourceFile?: string }}
 * @throws {HttpError} 400 bad_request for any shape violation
 */
export function parseAskRequestV1(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  const { collection, question, scope, sourceFile, top } = body;

  if (sourceFile !== undefined) {
    throw badRequest(
      'Body field "sourceFile" is not part of the v1 Ask API — use "scope": { "sourceFile": "..." } instead'
    );
  }
  if (top !== undefined) {
    throw badRequest(
      'Body field "top" is not part of the v1 Ask API — retrieval count is an internal Semidex setting, not a client control'
    );
  }

  // Ask is documented as stateless — silently accepting an unknown field
  // (e.g. a client-supplied "sessionId") would let a second, undocumented
  // contract grow beside this one. Reject anything outside the known root
  // field set instead of just ignoring it.
  const KNOWN_ROOT_KEYS = new Set(['collection', 'question', 'scope']);
  const unknownKeys = Object.keys(body).filter((k) => !KNOWN_ROOT_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw badRequest(`Unknown body field(s): ${unknownKeys.join(', ')}. The v1 Ask API accepts only "collection", "question", and "scope".`);
  }

  if (typeof collection !== 'string' || collection.trim() === '') {
    throw badRequest('Body field "collection" is required and must be a non-empty string');
  }
  if (typeof question !== 'string' || question.trim() === '') {
    throw badRequest('Body field "question" is required and must be a non-empty string');
  }

  let scopeSourceFile;
  if (scope !== undefined) {
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
      throw badRequest('Body field "scope" must be an object when provided');
    }
    const extraKeys = Object.keys(scope).filter((k) => k !== 'sourceFile');
    if (extraKeys.length > 0) {
      throw badRequest(`Body field "scope" has unsupported key(s): ${extraKeys.join(', ')}. Only "scope.sourceFile" is currently supported.`);
    }
    if (scope.sourceFile !== undefined) {
      if (typeof scope.sourceFile !== 'string' || scope.sourceFile.trim() === '') {
        throw badRequest('Body field "scope.sourceFile" must be a non-empty string when provided');
      }
      scopeSourceFile = scope.sourceFile;
    }
  }

  return {
    collection,
    question,
    ...(scopeSourceFile !== undefined ? { sourceFile: scopeSourceFile } : {}),
  };
}
