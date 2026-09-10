// Agent API v3 — public wire contract (pure: no I/O, no HTTP, no transport).
//
// RELATIONSHIP TO ASK v1/v2
// -------------------------
// This is a SEPARATE endpoint, not an extension of Ask. Ask v1/v2 keep their
// exact request/SSE/grounding/citation/refusal contracts, and no tool/system
// role is added to their conversation schema. Agent mode is a different
// product surface: application-controlled tools, application-owned execution
// loop, no automatic grounding of every claim.
//
// SSE TERMINAL SEMANTICS
// ----------------------
// A stream ends in EXACTLY ONE of:
//   done  { status: 'completed',       answer, ... }
//   done  { status: 'requires_action', continuationId, toolCalls, ... }
//   error { code, message, retryable }
// Once streaming has begun, an error is a terminal `error` event — it NEVER
// becomes a successful `done`. Only `done(requires_action)` carries tool
// calls, and those are always fully verified (name in the allowlist,
// arguments schema-checked) before they are emitted.
//
// Model text produced BEFORE a requires_action is emitted as answer_delta
// and echoed on the terminal event as `text`. It is deliberately NOT called
// `answer`: it is not a finished answer, and naming it one would invite a
// caller to render it as final.
export const API_VERSION = 'v3';
export const AGENT_PATH = '/api/v3/ask';

export const SSE_EVENTS = Object.freeze({
  ANSWER_DELTA: 'answer_delta',
  DONE: 'done',
  ERROR: 'error',
});

export const AGENT_STATUS = Object.freeze({
  COMPLETED: 'completed',
  REQUIRES_ACTION: 'requires_action',
});

export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_IMPLEMENTED: 'not_implemented',
  BUSY: 'busy',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  GENERATION_FAILED: 'generation_failed',
  STREAM_ABORTED: 'stream_aborted',
  INTERNAL_ERROR: 'internal_error',

  // Capability
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',

  // Tool/schema validation (core/agent/tool-schema.js)
  INVALID_TOOL: 'invalid_tool',
  INVALID_SCHEMA: 'invalid_schema',
  UNSUPPORTED_SCHEMA_KEYWORD: 'unsupported_schema_keyword',
  UNSUPPORTED_SCHEMA_TYPE: 'unsupported_schema_type',
  SCHEMA_TOO_DEEP: 'schema_too_deep',
  SCHEMA_TOO_LARGE: 'schema_too_large',
  TOO_MANY_TOOLS: 'too_many_tools',
  DUPLICATE_TOOL_NAME: 'duplicate_tool_name',

  // Model-step outcomes that are NOT a completed answer
  SAFETY_REFUSAL: 'safety_refusal',
  STREAM_INTERRUPTED: 'stream_interrupted',
  OUTPUT_LIMIT_REACHED: 'output_limit_reached',
  MALFORMED_TOOL_CALL: 'malformed_tool_call',
  UNKNOWN_TOOL: 'unknown_tool',
  INVALID_TOOL_ARGUMENTS: 'invalid_tool_arguments',
  PROVIDER_ERROR: 'provider_error',

  // Continuation store
  RUN_NOT_FOUND: 'run_not_found',
  RUN_GONE: 'run_gone',
  RUN_BUSY: 'run_busy',
  RESULTS_MISMATCH: 'results_mismatch',
  STORE_FULL: 'store_full',
  RUN_TOO_LARGE: 'run_too_large',
  TOOL_RESULT_TOO_LARGE: 'tool_result_too_large',

  // Run ceilings
  RUN_STEP_LIMIT_EXCEEDED: 'run_step_limit_exceeded',
  RUN_TOOL_CALL_LIMIT_EXCEEDED: 'run_tool_call_limit_exceeded',
  RUN_TOKEN_CEILING_EXCEEDED: 'run_token_ceiling_exceeded',
  CONTEXT_BUDGET_EXCEEDED: 'context_budget_exceeded',

  // Spend/token ceiling — shared verbatim with Ask v1/v2's own codes.
  BUDGET_EXCEEDED: 'key_budget_exceeded',
  BUDGET_LIMIT_TOO_SMALL: 'key_budget_ceiling_too_small',
  REQUEST_CALL_CEILING: 'request_call_ceiling_exceeded',
  REQUEST_TOKEN_CEILING: 'request_token_ceiling_exceeded',
});

// Retryable means "the same request may succeed later, unchanged". A
// validation failure, a capability gap, a consumed run, or an exhausted
// per-run ceiling are all permanent for THIS request and are never retried
// automatically. Note the client never auto-retries a committed stream at
// all (see the client's own note) — this flag is advisory for a caller.
const RETRYABLE_CODES = new Set([
  ERROR_CODES.BUSY,
  ERROR_CODES.DEPENDENCY_UNAVAILABLE,
  ERROR_CODES.GENERATION_FAILED,
  ERROR_CODES.INTERNAL_ERROR,
  ERROR_CODES.STORE_FULL,
  ERROR_CODES.RUN_BUSY,
  ERROR_CODES.BUDGET_EXCEEDED,
]);

export function isRetryableCode(code) {
  return RETRYABLE_CODES.has(code);
}

/** HTTP status for a pre-stream failure. */
export const ERROR_STATUS = Object.freeze({
  [ERROR_CODES.BAD_REQUEST]: 400,
  [ERROR_CODES.UNAUTHORIZED]: 401,
  [ERROR_CODES.FORBIDDEN]: 403,
  [ERROR_CODES.NOT_IMPLEMENTED]: 501,
  [ERROR_CODES.BUSY]: 429,
  [ERROR_CODES.DEPENDENCY_UNAVAILABLE]: 503,
  [ERROR_CODES.CAPABILITY_UNAVAILABLE]: 501,

  [ERROR_CODES.INVALID_TOOL]: 400,
  [ERROR_CODES.INVALID_SCHEMA]: 400,
  [ERROR_CODES.UNSUPPORTED_SCHEMA_KEYWORD]: 400,
  [ERROR_CODES.UNSUPPORTED_SCHEMA_TYPE]: 400,
  [ERROR_CODES.SCHEMA_TOO_DEEP]: 400,
  [ERROR_CODES.SCHEMA_TOO_LARGE]: 413,
  [ERROR_CODES.TOO_MANY_TOOLS]: 400,
  [ERROR_CODES.DUPLICATE_TOOL_NAME]: 400,

  [ERROR_CODES.SAFETY_REFUSAL]: 422,
  [ERROR_CODES.STREAM_INTERRUPTED]: 502,
  [ERROR_CODES.OUTPUT_LIMIT_REACHED]: 422,
  [ERROR_CODES.MALFORMED_TOOL_CALL]: 502,
  [ERROR_CODES.UNKNOWN_TOOL]: 502,
  [ERROR_CODES.INVALID_TOOL_ARGUMENTS]: 502,
  [ERROR_CODES.PROVIDER_ERROR]: 502,

  // A continuation id that is unknown, expired, or belongs to someone else
  // is 404 — deliberately indistinguishable, so the response never confirms
  // that an id exists to a caller who should not know it.
  [ERROR_CODES.RUN_NOT_FOUND]: 404,
  [ERROR_CODES.RUN_GONE]: 410,
  [ERROR_CODES.RUN_BUSY]: 409,
  [ERROR_CODES.RESULTS_MISMATCH]: 400,
  [ERROR_CODES.STORE_FULL]: 503,
  [ERROR_CODES.RUN_TOO_LARGE]: 413,
  [ERROR_CODES.TOOL_RESULT_TOO_LARGE]: 413,

  [ERROR_CODES.RUN_STEP_LIMIT_EXCEEDED]: 422,
  [ERROR_CODES.RUN_TOOL_CALL_LIMIT_EXCEEDED]: 422,
  // The run exhausted its own aggregate token budget. 422, not 429: this is
  // permanent for THIS run (a retry cannot help), unlike a per-key budget
  // denial which becomes retryable once the bucket refills.
  [ERROR_CODES.RUN_TOKEN_CEILING_EXCEEDED]: 422,
  [ERROR_CODES.CONTEXT_BUDGET_EXCEEDED]: 422,

  [ERROR_CODES.BUDGET_EXCEEDED]: 429,
  [ERROR_CODES.BUDGET_LIMIT_TOO_SMALL]: 429,
  [ERROR_CODES.REQUEST_CALL_CEILING]: 429,
  [ERROR_CODES.REQUEST_TOKEN_CEILING]: 429,
});

export function statusForCode(code) {
  return ERROR_STATUS[code] ?? 500;
}

export function projectAnswerDeltaEvent(text) {
  return { text };
}

/**
 * The ONE terminal success event. `status` discriminates the two outcomes;
 * `toolCalls`/`continuationId` appear only for requires_action, and `answer`
 * only for completed — a caller can never read a half-finished turn as an
 * answer because the field simply is not there.
 *
 * `providerState` is NEVER projected here. It is private continuation
 * metadata (Gemini thought signatures and native parts) held server-side.
 */
export function projectDoneEvent(result) {
  if (result.status === AGENT_STATUS.REQUIRES_ACTION) {
    return {
      status: AGENT_STATUS.REQUIRES_ACTION,
      continuationId: result.continuationId,
      // Model text produced before the tool calls. NOT an answer.
      text: result.text ?? '',
      toolCalls: (result.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      steps: result.steps ?? null,
      usage: projectUsage(result.usage),
    };
  }
  return {
    status: AGENT_STATUS.COMPLETED,
    answer: result.text ?? '',
    steps: result.steps ?? null,
    usage: projectUsage(result.usage),
  };
}

function projectUsage(usage) {
  return {
    tokensIn: Number.isFinite(usage?.tokensIn) ? usage.tokensIn : null,
    tokensOut: Number.isFinite(usage?.tokensOut) ? usage.tokensOut : null,
  };
}

export function projectErrorPayload(code, message) {
  return { code, message, retryable: isRetryableCode(code) };
}

export function projectErrorResponseBody(code, message) {
  return { error: { code, message, retryable: isRetryableCode(code) } };
}
