// Search API v1 — public wire contract (pure, no I/O, no HTTP, no transport).
//
// This module is the ONLY place that knows the shape of what a client of the
// versioned Search API actually receives. It owns:
//   - the API version string and canonical path;
//   - stable, machine-readable error codes and retryability;
//   - pure projection functions from internal StorageAdapter Chunk shapes
//     (the same Chunk contract src/core/retrieval/search.js and
//     src/mcp/tools/search.js already expose to agents) onto the public
//     response payload.
//
// Mirrors src/core/ask-api/v1/contract.js's structure deliberately — same
// ERROR_CODES/isRetryableCode/projectErrorPayload/projectErrorResponseBody
// shape — so a client already integrating Ask v1 recognizes the same error
// envelope here. Search has no SSE framing (JSON only) and no generation
// budget/provider concerns, so this contract is a strict subset of Ask's
// error vocabulary: only the codes a search request can actually produce.
export const API_VERSION = 'v1';
export const SEARCH_PATH = '/api/v1/search';

// Stable, machine-readable error codes for the public contract. Distinct
// from the internal HttpError `code` values used elsewhere in the admin API
// only in that these are documented as part of the versioned public surface
// and must not change meaning once published.
export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden',
  NOT_IMPLEMENTED: 'not_implemented',
  EMBEDDING_FAILED: 'embedding_failed',
  // Embedding-profile resolution outcomes (src/core/embedding-profile/
  // resolve.js) — EMBEDDING_UNRESOLVED: the collection's own embedding
  // identity could not be determined; EMBEDDING_UNSUPPORTED: the
  // collection's resolved profile declares an execution mode this codebase
  // does not implement yet. Distinct from EMBEDDING_FAILED, which means a
  // resolved, supported profile still failed to actually embed the query.
  EMBEDDING_UNRESOLVED: 'embedding_unresolved',
  EMBEDDING_UNSUPPORTED: 'embedding_unsupported',
  INTERNAL_ERROR: 'internal_error',
});

// Whether a client should consider retrying the SAME request useful. Bad
// input (bad_request), a genuinely missing resource (not_found), and a
// denied collection (forbidden) will fail again unchanged — not retryable.
// A storage backend that structurally does not support hybrid search
// (not_implemented) will not start supporting it on retry either.
// EMBEDDING_UNRESOLVED/EMBEDDING_UNSUPPORTED are deliberately NOT retryable
// — the same collection identity/execution-mode problem will still be there
// on an immediate retry; the collection needs migration/reindex or the
// feature needs to actually be implemented, neither of which a retry alone
// resolves (mirrors Ask v1's own identical reasoning).
const RETRYABLE_CODES = new Set([
  ERROR_CODES.EMBEDDING_FAILED,
  ERROR_CODES.INTERNAL_ERROR,
]);

export function isRetryableCode(code) {
  return RETRYABLE_CODES.has(code);
}

/**
 * Projects one internal StorageAdapter Chunk (sourceFile, chunkIndex,
 * totalChunks, section, text, context, tags, score, nodeId, nodePath,
 * nodeType, isMatch — the same contract src/mcp/tools/search.js already
 * exposes to agents) onto the public result shape. An EXPLICIT field list,
 * not a spread passthrough — a future internal-only field added to the
 * adapter Chunk shape does not silently reach this public contract just
 * because it exists on the object.
 * @param {Object} chunk
 */
export function projectResult(chunk) {
  return {
    sourceFile: chunk.sourceFile ?? null,
    chunkIndex: Number.isInteger(chunk.chunkIndex) ? chunk.chunkIndex : null,
    totalChunks: Number.isInteger(chunk.totalChunks) ? chunk.totalChunks : null,
    section: chunk.section ?? '',
    text: chunk.text ?? null,
    context: chunk.context ?? null,
    tags: Array.isArray(chunk.tags) ? chunk.tags : [],
    score: typeof chunk.score === 'number' ? chunk.score : null,
    nodeId: chunk.nodeId ?? null,
    nodePath: chunk.nodePath ?? null,
    nodeType: chunk.nodeType ?? null,
    isMatch: Boolean(chunk.isMatch),
    ...(Array.isArray(chunk.windowChunks) ? { windowChunks: chunk.windowChunks.map(projectWindowChunk) } : {}),
  };
}

/**
 * Projects one window-expansion chunk (src/core/retrieval/search-request.js
 * toWindowChunk() output — {sourceFile, chunkIndex, section, isMatch,
 * textSnippet?, text?}) onto the public shape. 1:1 passthrough today, kept
 * as an explicit function so the relationship is a testable contract rather
 * than an accident of both shapes matching.
 * @param {{ sourceFile: string, chunkIndex: number, section: string, isMatch: boolean, textSnippet?: string, text?: string|null }} wc
 */
export function projectWindowChunk(wc) {
  return {
    sourceFile: wc.sourceFile,
    chunkIndex: wc.chunkIndex,
    section: wc.section ?? '',
    isMatch: Boolean(wc.isMatch),
    ...('textSnippet' in wc ? { textSnippet: wc.textSnippet } : {}),
    ...('text' in wc ? { text: wc.text } : {}),
  };
}

/**
 * The success response body — the ONE shape POST /api/v1/search returns on
 * 200.
 * @param {{ collection: string, query: string, top: number, window: number, windowFormat: string|null, searchMode: string, results: Object[] }} args
 */
export function projectSearchResponse({ collection, query, top, window, windowFormat, searchMode, results }) {
  return {
    apiVersion: API_VERSION,
    collection,
    query,
    searchMode: searchMode ?? null,
    top,
    window,
    windowFormat,
    results: results.map(projectResult),
  };
}

/**
 * The public `error` payload shape — mirrors Ask v1's identical projector.
 * `message` must already be redacted by the caller before this is called.
 * @param {string} code — one of ERROR_CODES
 * @param {string} message — already-redacted, safe to send to a client
 */
export function projectErrorPayload(code, message) {
  return {
    apiVersion: API_VERSION,
    code,
    message,
    retryable: isRetryableCode(code),
  };
}

/**
 * The pre-response JSON error body — `{ error: projectErrorPayload(...) }`.
 * @param {string} code — one of ERROR_CODES
 * @param {string} message — already-redacted, safe to send to a client
 */
export function projectErrorResponseBody(code, message) {
  return { error: projectErrorPayload(code, message) };
}
