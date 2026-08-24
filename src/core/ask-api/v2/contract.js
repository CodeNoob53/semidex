// Ask API v2 — public wire contract (pure, no I/O, no HTTP, no transport).
//
// Mirrors v1's contract.js (src/core/ask-api/v1/contract.js) exactly in
// shape — same SSE event names, same error-payload/done-event structure —
// with one additive extension: the `done` event may carry an optional
// `conversation` block reporting whether/what summary was recomputed. v1's
// own contract.js is completely untouched by this file's existence.
export const API_VERSION = 'v2';
export const ASK_PATH = '/api/v2/ask';

export const SSE_EVENTS = Object.freeze({
  SOURCES: 'sources',
  ANSWER_DELTA: 'answer_delta',
  DONE: 'done',
  ERROR: 'error',
});

// v1's full error-code set, plus four new codes for the conversation-shaped
// validation failures v2's request.js can produce.
export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  NOT_IMPLEMENTED: 'not_implemented',
  BUSY: 'busy',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  EMBEDDING_FAILED: 'embedding_failed',
  EMBEDDING_UNRESOLVED: 'embedding_unresolved',
  EMBEDDING_UNSUPPORTED: 'embedding_unsupported',
  RETRIEVAL_FAILED: 'retrieval_failed',
  GENERATION_FAILED: 'generation_failed',
  STREAM_ABORTED: 'stream_aborted',
  INTERNAL_ERROR: 'internal_error',
  CONTEXT_BUDGET_EXCEEDED: 'context_budget_exceeded',
  // v2-only validation codes (request.js) — a malformed/oversized/invalid
  // `conversation` block never reaches the coordinator at all.
  INVALID_CONVERSATION: 'invalid_conversation',
  INVALID_MESSAGE_ROLE: 'invalid_message_role',
  MESSAGE_TOO_LARGE: 'message_too_large',
  // Spend/token budget ceiling — see v1/contract.js's identical pair for
  // the full reasoning (shared verbatim; v1 and v2 must never diverge on
  // this contract).
  BUDGET_EXCEEDED: 'budget_exceeded',
  BUDGET_LIMIT_EXCEEDED: 'budget_limit_exceeded',
  BUDGET_UNENFORCEABLE: 'budget_unenforceable',
});

const RETRYABLE_CODES = new Set([
  ERROR_CODES.BUSY,
  ERROR_CODES.DEPENDENCY_UNAVAILABLE,
  ERROR_CODES.EMBEDDING_FAILED,
  ERROR_CODES.RETRIEVAL_FAILED,
  ERROR_CODES.GENERATION_FAILED,
  ERROR_CODES.INTERNAL_ERROR,
  ERROR_CODES.BUDGET_EXCEEDED,
]);
// BUDGET_UNENFORCEABLE is deliberately NOT retryable — see v1/contract.js's
// identical note.

export function isRetryableCode(code) {
  return RETRYABLE_CODES.has(code);
}

const STRUCTURAL_NODE_TYPES = new Set(['table', 'code_block', 'checklist']);

/**
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

export function projectSourcesEvent({ searchMode, sources }) {
  return {
    apiVersion: API_VERSION,
    searchMode: searchMode ?? null,
    sources: sources.map(projectSource),
  };
}

export function projectAnswerDeltaEvent(text) {
  return { apiVersion: API_VERSION, text };
}

/**
 * The `done` SSE event payload — identical to v1's shape, plus an optional
 * `conversation` block. When the request had no `conversation` field at all
 * (a first-turn request), `conversation` is OMITTED ENTIRELY from the
 * payload — never present as `null` or `{}` — since there is no correlation
 * id to echo and no summary state to report either way.
 *
 * @param {{
 *   text: string, citations: number[], nodeReferences: string[],
 *   refused: boolean, refusalReason?: string, provider?: string,
 *   model?: string, tokensIn?: number, tokensOut?: number,
 *   evidenceCount: number, elapsedMs: number,
 *   conversationId?: string, summaryChanged?: boolean, updatedSummary?: string,
 *   compactedMessageCount?: number,
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
    ...(result.conversationId !== undefined
      ? {
          conversation: {
            id: result.conversationId,
            summaryChanged: Boolean(result.summaryChanged),
            ...(result.summaryChanged && result.updatedSummary !== undefined ? { updatedSummary: result.updatedSummary } : {}),
            ...(result.summaryChanged && result.compactedMessageCount !== undefined ? { compactedMessageCount: result.compactedMessageCount } : {}),
          },
        }
      : {}),
  };
}

export function projectErrorPayload(code, message) {
  return {
    apiVersion: API_VERSION,
    code,
    message,
    retryable: isRetryableCode(code),
  };
}

export function projectErrorResponseBody(code, message) {
  return { error: projectErrorPayload(code, message) };
}

export function isStructuralNodeType(nodeType) {
  return STRUCTURAL_NODE_TYPES.has(nodeType);
}
