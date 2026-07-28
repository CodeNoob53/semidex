// Ask API v1 — public wire contract (pure, no I/O, no HTTP, no transport).
//
// This module is the ONLY place that knows the shape of what a client of
// the versioned Ask API actually receives. It owns:
//   - the API version string and canonical path;
//   - the SSE event names (sources / answer_delta / done / error);
//   - pure projection functions from internal coordinator/citation shapes
//     (src/core/ask/coordinator.js, src/core/ask/citations.js) onto the
//     public payloads below.
//
// Nothing here imports Qdrant, Ollama, Gemini, a StorageAdapter, or any
// Admin UI module — it only transforms plain objects the coordinator
// already returns. Internal validation/debug fields (invalidCitations,
// strippedMarkers, searchMode internals beyond the one public field, raw
// node internals) are deliberately dropped here, not merely hidden by a
// caller's choice not to read them — a field that never appears in these
// projections can never leak through this contract by omission elsewhere.
export const API_VERSION = 'v1';
export const ASK_PATH = '/api/v1/ask';

export const SSE_EVENTS = Object.freeze({
  SOURCES: 'sources',
  ANSWER_DELTA: 'answer_delta',
  DONE: 'done',
  ERROR: 'error',
});

// Stable, machine-readable error codes for the public contract. Distinct
// from the internal HttpError `code` values used elsewhere in the admin
// API (e.g. 'not_found', 'bad_request') only in that these are documented
// as part of the versioned public surface and must not change meaning
// once published — today they happen to reuse the same short strings
// because there is no reason to invent new ones, but this map is the
// single place that decision is made, not an accident of reuse.
export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  NOT_IMPLEMENTED: 'not_implemented',
  BUSY: 'busy',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  EMBEDDING_FAILED: 'embedding_failed',
  // Embedding-profile resolution outcomes (src/core/embedding-profile/
  // resolve.js) — EMBEDDING_UNRESOLVED: the collection's own embedding
  // identity could not be determined (missing/ambiguous/invalid native
  // metadata); EMBEDDING_UNSUPPORTED: the collection's resolved profile
  // declares an execution mode (e.g. qdrant-cloud) this codebase does not
  // implement yet. Distinct from EMBEDDING_FAILED, which means a resolved,
  // supported profile still failed to actually embed the query/text.
  EMBEDDING_UNRESOLVED: 'embedding_unresolved',
  EMBEDDING_UNSUPPORTED: 'embedding_unsupported',
  RETRIEVAL_FAILED: 'retrieval_failed',
  GENERATION_FAILED: 'generation_failed',
  STREAM_ABORTED: 'stream_aborted',
  INTERNAL_ERROR: 'internal_error',
});

// Whether a client should consider retrying the SAME request useful.
// Bad input (bad_request) and a genuinely missing resource (not_found) will
// fail again unchanged — not retryable. A storage backend that structurally
// does not support hybrid search (not_implemented) will not start
// supporting it on retry either. Everything else reflects transient
// server/provider/capacity state that may succeed on a later attempt.
const RETRYABLE_CODES = new Set([
  ERROR_CODES.BUSY,
  ERROR_CODES.DEPENDENCY_UNAVAILABLE,
  ERROR_CODES.EMBEDDING_FAILED,
  ERROR_CODES.RETRIEVAL_FAILED,
  ERROR_CODES.GENERATION_FAILED,
  ERROR_CODES.INTERNAL_ERROR,
]);
// EMBEDDING_UNRESOLVED/EMBEDDING_UNSUPPORTED are deliberately NOT retryable
// (absent from this set) — the same collection identity/execution-mode
// problem will still be there on an immediate retry; the collection needs
// migration/reindex (unresolved) or the feature needs to actually be
// implemented (unsupported), neither of which a retry alone resolves.
// stream_aborted means the CLIENT cancelled its own request — retrying is
// meaningful only if the client still wants an answer, which is a client
// decision, not a server-detectable transient-failure signal. Treated as
// not retryable here since nothing changed server-side that a retry would
// benefit from.

export function isRetryableCode(code) {
  return RETRYABLE_CODES.has(code);
}

// Only these node types are ever a valid [node: path] structural
// reference — mirrors prompt.js's/citations.js's own STRUCTURAL_NODE_TYPES
// (not re-imported to avoid a dependency from this pure contract module
// onto core/ask/*; duplicated as a literal here is acceptable because it
// is a stable, rarely-changing constant, not logic).
const STRUCTURAL_NODE_TYPES = new Set(['table', 'code_block', 'checklist']);

/**
 * Projects one internal evidence source (src/core/ask/evidence.js's shape:
 * { n, sourceFile, chunkIndex, section, snippet, nodeId, nodePath,
 * nodeType, truncated }) onto the public source shape. Field names/values
 * are a 1:1 passthrough today — this function exists so that relationship
 * is an explicit, testable contract rather than an accident of both
 * shapes currently matching.
 *
 * @param {{ n: number, sourceFile: string|null, chunkIndex: number|null, section: string|null, snippet: string, nodeId: string|null, nodePath: string|null, nodeType: string|null, truncated: boolean }} source
 */
export function projectSource(source) {
  return {
    n: source.n,
    sourceFile: source.sourceFile ?? null,
    chunkIndex: source.chunkIndex ?? null,
    section: source.section ?? null,
    nodeId: source.nodeId ?? null,
    nodePath: source.nodePath ?? null,
    nodeType: source.nodeType ?? null,
    snippet: source.snippet,
    truncated: Boolean(source.truncated),
  };
}

/**
 * The `sources` SSE event payload — always the first event of a streaming
 * response, exactly once.
 *
 * @param {{ searchMode: string|null, sources: Array<Object> }} payload — as
 *   emitted by the coordinator's onSources callback
 */
export function projectSourcesEvent({ searchMode, sources }) {
  return {
    apiVersion: API_VERSION,
    searchMode: searchMode ?? null,
    sources: sources.map(projectSource),
  };
}

/**
 * The `answer_delta` SSE event payload — zero or more per request, each
 * carrying one incremental fragment of the generated answer text.
 *
 * @param {string} text
 */
export function projectAnswerDeltaEvent(text) {
  return { apiVersion: API_VERSION, text };
}

/**
 * The `done` SSE event payload for a successful (possibly refused)
 * generation — exactly one terminal event per request, never alongside an
 * `error` event. Deliberately omits invalidCitations/strippedMarkers
 * (internal validation/debug detail, not part of the public contract) and
 * any raw provider/internal fields beyond the documented set.
 *
 * @param {{
 *   text: string, citations: number[], nodeReferences: string[],
 *   refused: boolean, refusalReason?: string, provider?: string,
 *   model?: string, tokensIn?: number, tokensOut?: number,
 *   evidenceCount: number, elapsedMs: number,
 * }} result
 */
export function projectDoneEvent(result) {
  return {
    apiVersion: API_VERSION,
    answer: result.text ?? '',
    citations: result.citations ?? [],
    entityRefs: result.nodeReferences ?? [],
    refused: Boolean(result.refused),
    refusalReason: result.refusalReason ?? null,
    provider: result.provider ?? null,
    model: result.model ?? null,
    usage: {
      promptTokens: result.tokensIn ?? null,
      completionTokens: result.tokensOut ?? null,
    },
    timing: {
      elapsedMs: result.elapsedMs ?? null,
    },
    evidenceCount: result.evidenceCount ?? 0,
  };
}

/**
 * The public `error` payload — used both for pre-stream JSON error
 * responses (wrapped in the standard { error: {...} } envelope by the
 * caller) and for a mid-stream terminal `error` SSE event. `message` must
 * already be redacted by the caller before this is called — this function
 * does not perform redaction itself (it has no access to the secrets that
 * would need redacting, by design: this module never touches process.env
 * or provider internals).
 *
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
 * The pre-stream JSON error response BODY (status code is set separately
 * by the caller) — `{ error: projectErrorPayload(...) }`. Pre-stream
 * failures (validation, unknown collection, busy, provider unavailable,
 * retrieval failure before any SSE event was written) must carry the same
 * apiVersion/retryable-bearing shape as a mid-stream `error` SSE event, not
 * the generic router-wide `{ error: { message, code } }` envelope every
 * other admin route uses — the versioned contract applies to every error
 * this endpoint can produce, not only the ones that happen to occur after
 * streaming has started.
 *
 * @param {string} code — one of ERROR_CODES
 * @param {string} message — already-redacted, safe to send to a client
 */
export function projectErrorResponseBody(code, message) {
  return { error: projectErrorPayload(code, message) };
}

/**
 * Whether a source is a "structural" entity type — the only kind a
 * [node: path] reference can legitimately point at. Exposed for callers
 * that need the same rule without duplicating the literal set (e.g.
 * request/response tests asserting entity-reference behavior end to end).
 */
export function isStructuralNodeType(nodeType) {
  return STRUCTURAL_NODE_TYPES.has(nodeType);
}
