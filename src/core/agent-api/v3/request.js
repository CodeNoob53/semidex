// Agent API v3 — request parsing/validation (pure, no I/O, no DI).
//
// TWO MUTUALLY EXCLUSIVE REQUEST SHAPES
// -------------------------------------
//   START:        { input, systemInstructions?, tools, ...limits? }
//   CONTINUATION: { continuationId, toolResults }
//
// A continuation may carry NOTHING else. Instructions, tools, model and
// budget are frozen for the life of a run: a request that tries to change
// them mid-run is rejected outright rather than silently ignored, because
// silently ignoring them would let a caller believe it had swapped the
// model's instructions when it had not. A new task is a new run.
//
// Tool DEFINITION validation deliberately does NOT happen here — it lives in
// core/agent/tool-schema.js so the identical rules apply to a future
// embedded-SDK caller that never touches HTTP. This file checks the request
// envelope; the runtime checks the tools.
import { badRequest, HttpError } from '../../http/http.js';
import { ERROR_CODES } from './contract.js';

// Fixed, non-configurable structural protocol ceilings — a parse-time DoS
// bound, distinct from the operator-tunable run limits in
// core/agent/runtime.js. Both exist on purpose: this one bounds what may be
// PARSED, that one bounds what may be SPENT.
export const PROTOCOL_LIMITS = Object.freeze({
  maxInputChars: 20_000,
  maxInstructionsChars: 20_000,
  maxContinuationIdChars: 256,
  maxToolResults: 32,
  maxCallIdChars: 256,
});

const KNOWN_START_KEYS = new Set([
  'input', 'systemInstructions', 'tools', 'model',
  'maxModelSteps', 'maxToolCalls', 'maxOutputTokens',
]);
const KNOWN_CONTINUE_KEYS = new Set(['continuationId', 'toolResults']);
const KNOWN_RESULT_KEYS = new Set(['callId', 'ok', 'output', 'error']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw badRequest(`Body field "${field}" must be a positive integer when provided`);
  }
  return value;
}

/**
 * @param {unknown} body
 * @returns {{ kind: 'start', input: string, systemInstructions?: string, tools: unknown, model?: string,
 *             maxModelSteps?: number, maxToolCalls?: number, maxOutputTokens?: number }
 *          | { kind: 'continue', continuationId: string, toolResults: Array<Object> }}
 */
export function parseAgentRequestV3(body) {
  if (!isPlainObject(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  const isContinuation = Object.hasOwn(body, 'continuationId');
  const looksLikeStart = Object.hasOwn(body, 'input') || Object.hasOwn(body, 'tools');

  if (isContinuation && looksLikeStart) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST,
      'A continuation request carries only "continuationId" and "toolResults". '
      + 'Instructions, tools, model and budget are frozen for the life of a run — start a new run for a new task.');
  }

  return isContinuation ? parseContinue(body) : parseStart(body);
}

function parseStart(body) {
  const unknown = Object.keys(body).filter((k) => !KNOWN_START_KEYS.has(k));
  if (unknown.length > 0) {
    throw badRequest(`Request body has unknown key(s): ${unknown.join(', ')}`);
  }

  const { input, systemInstructions, tools, model } = body;

  if (typeof input !== 'string' || input.trim().length === 0) {
    throw badRequest('Body field "input" is required and must be a non-empty string');
  }
  if (input.length > PROTOCOL_LIMITS.maxInputChars) {
    throw badRequest(`Body field "input" exceeds the maximum of ${PROTOCOL_LIMITS.maxInputChars} characters`);
  }

  if (systemInstructions !== undefined) {
    if (typeof systemInstructions !== 'string') {
      throw badRequest('Body field "systemInstructions" must be a string when provided');
    }
    if (systemInstructions.length > PROTOCOL_LIMITS.maxInstructionsChars) {
      throw badRequest(`Body field "systemInstructions" exceeds the maximum of ${PROTOCOL_LIMITS.maxInstructionsChars} characters`);
    }
  }

  if (tools === undefined) {
    throw new HttpError(400, ERROR_CODES.INVALID_TOOL,
      'Body field "tools" is required. Agent mode exists to let the model request YOUR tools; '
      + 'use POST /api/v1/ask or /api/v2/ask for grounded question answering with no tools.');
  }

  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
    throw badRequest('Body field "model" must be a non-empty string when provided');
  }

  return {
    kind: 'start',
    input,
    ...(systemInstructions !== undefined ? { systemInstructions } : {}),
    tools,
    ...(model !== undefined ? { model } : {}),
    ...(optionalPositiveInt(body.maxModelSteps, 'maxModelSteps') !== undefined ? { maxModelSteps: body.maxModelSteps } : {}),
    ...(optionalPositiveInt(body.maxToolCalls, 'maxToolCalls') !== undefined ? { maxToolCalls: body.maxToolCalls } : {}),
    ...(optionalPositiveInt(body.maxOutputTokens, 'maxOutputTokens') !== undefined ? { maxOutputTokens: body.maxOutputTokens } : {}),
  };
}

function parseContinue(body) {
  const unknown = Object.keys(body).filter((k) => !KNOWN_CONTINUE_KEYS.has(k));
  if (unknown.length > 0) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST,
      `A continuation request carries only "continuationId" and "toolResults"; received also: ${unknown.join(', ')}. `
      + 'Instructions, tools, model and budget are frozen for the life of a run.');
  }

  const { continuationId, toolResults } = body;

  if (typeof continuationId !== 'string' || continuationId.length === 0) {
    throw badRequest('Body field "continuationId" must be a non-empty string');
  }
  if (continuationId.length > PROTOCOL_LIMITS.maxContinuationIdChars) {
    throw badRequest(`Body field "continuationId" exceeds the maximum of ${PROTOCOL_LIMITS.maxContinuationIdChars} characters`);
  }

  if (!Array.isArray(toolResults) || toolResults.length === 0) {
    throw badRequest('Body field "toolResults" must be a non-empty array');
  }
  if (toolResults.length > PROTOCOL_LIMITS.maxToolResults) {
    throw badRequest(`Body field "toolResults" exceeds the maximum of ${PROTOCOL_LIMITS.maxToolResults} entries`);
  }

  const parsed = toolResults.map((result, i) => {
    if (!isPlainObject(result)) {
      throw badRequest(`Body field "toolResults[${i}]" must be an object`);
    }
    const unknownResultKeys = Object.keys(result).filter((k) => !KNOWN_RESULT_KEYS.has(k));
    if (unknownResultKeys.length > 0) {
      throw badRequest(`Body field "toolResults[${i}]" has unknown key(s): ${unknownResultKeys.join(', ')}`);
    }
    const { callId, ok } = result;
    if (typeof callId !== 'string' || callId.length === 0) {
      throw badRequest(`Body field "toolResults[${i}].callId" must be a non-empty string`);
    }
    if (callId.length > PROTOCOL_LIMITS.maxCallIdChars) {
      throw badRequest(`Body field "toolResults[${i}].callId" exceeds the maximum of ${PROTOCOL_LIMITS.maxCallIdChars} characters`);
    }
    // A DISCRIMINATED result: `ok` is mandatory and decides which payload
    // field is legal. This is what stops an executor failure from reaching
    // the model dressed up as a successful output.
    if (typeof ok !== 'boolean') {
      throw badRequest(`Body field "toolResults[${i}].ok" must be a boolean (true for a successful result, false for an error)`);
    }
    if (ok && Object.hasOwn(result, 'error')) {
      throw badRequest(`Body field "toolResults[${i}]" declares ok:true but also carries "error"`);
    }
    if (!ok && !Object.hasOwn(result, 'error')) {
      throw badRequest(`Body field "toolResults[${i}]" declares ok:false and must carry "error"`);
    }
    if (!ok && Object.hasOwn(result, 'output')) {
      throw badRequest(`Body field "toolResults[${i}]" declares ok:false but also carries "output"`);
    }
    return {
      callId,
      ok,
      ...(ok ? { output: Object.hasOwn(result, 'output') ? result.output : null } : { error: result.error }),
    };
  });

  const seen = new Set();
  for (const [i, result] of parsed.entries()) {
    if (seen.has(result.callId)) {
      throw new HttpError(400, ERROR_CODES.RESULTS_MISMATCH,
        `Body field "toolResults[${i}]" repeats callId "${result.callId}"`);
    }
    seen.add(result.callId);
  }

  return { kind: 'continue', continuationId, toolResults: parsed };
}
