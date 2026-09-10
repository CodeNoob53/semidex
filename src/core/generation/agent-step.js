// AgentStepCapability — the provider-neutral contract for ONE structured
// model step that may return tool calls instead of (or before) a final
// answer. Sits ALONGSIDE GenerationProvider.generate() (provider.js), never
// replacing it: an ordinary text Ask keeps using generate() unchanged.
//
// WHY A SEPARATE CAPABILITY RATHER THAN A generate() OPTION
// --------------------------------------------------------
// generate() has one honest return shape: text plus usage. A step that can
// end in "the model wants these tools called" is a genuinely different
// outcome, not a variant of text. Folding it into generate() would force
// every existing caller to start handling a shape it never asked for, and
// would make `capabilities().hardOutputCap`-style honesty harder, not
// easier. A provider that cannot do tool calling declares
// `capabilities().toolCalling === false` and simply does not implement
// agentStep(); the runtime then refuses BEFORE any retrieval or generation
// (capability_unavailable), rather than discovering it mid-stream.
//
// THE TWO TERMINAL OUTCOMES
// -------------------------
//   { status: 'completed',       text, usage, providerState }
//   { status: 'requires_action', text, toolCalls, usage, providerState }
//
// Anything else is an error, not a quiet third state. Specifically NOT
// `completed`: a safety refusal, a truncated/interrupted stream, hitting the
// output-token ceiling, or a malformed function call. Those surface as a
// thrown AgentStepError with a typed code so a caller can never mistake an
// aborted generation for a finished answer.
//
// providerState is OPAQUE, PRIVATE continuation metadata (for Gemini: the
// real native parts, including thoughtSignature, needed to continue the
// conversation correctly). It is stored server-side by the runtime and is
// NEVER exposed through the public HTTP/client API — reconstructing the next
// request from only {name, args, text} would silently drop provider metadata
// the model needs, which is exactly the failure this field exists to prevent.

/**
 * @typedef {Object} AgentToolCall
 * @property {string} id      unique within this step; stable for the matching tool result
 * @property {string} name    a tool name from the caller's allowlist (already verified)
 * @property {Object} arguments a JSON object (already schema-validated)
 */

/**
 * @typedef {Object} AgentStepResult
 * @property {'completed'|'requires_action'} status
 * @property {string} text                      model text produced in this step (may be empty)
 * @property {AgentToolCall[]} toolCalls        empty for 'completed'
 * @property {{ tokensIn?: number, tokensOut?: number }} usage
 * @property {unknown} providerState            opaque continuation metadata; never leaves the server
 */

/**
 * Typed failure for one agent step. `code` is provider-neutral so the HTTP
 * layer maps it without knowing which backend produced it.
 */
export class AgentStepError extends Error {
  /**
   * @param {'capability_unavailable'|'safety_refusal'|'stream_interrupted'|'output_limit_reached'|'malformed_tool_call'|'unknown_tool'|'invalid_tool_arguments'|'provider_error'} code
   * @param {string} message
   * @param {{ retryable?: boolean }} [opts]
   */
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'AgentStepError';
    this.code = code;
    this.retryable = retryable;
  }
}

export const AGENT_STEP_ERROR_CODES = Object.freeze({
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  SAFETY_REFUSAL: 'safety_refusal',
  STREAM_INTERRUPTED: 'stream_interrupted',
  OUTPUT_LIMIT_REACHED: 'output_limit_reached',
  MALFORMED_TOOL_CALL: 'malformed_tool_call',
  UNKNOWN_TOOL: 'unknown_tool',
  INVALID_TOOL_ARGUMENTS: 'invalid_tool_arguments',
  PROVIDER_ERROR: 'provider_error',
});

/** Message roles a caller may put in an agent step's `messages` array. */
export const AGENT_MESSAGE_ROLE = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
});

/**
 * True when this provider genuinely implements agentStep(). Checked by the
 * runtime BEFORE any retrieval or generation work, so an unsupported backend
 * costs nothing.
 * @param {Object} provider
 */
export function supportsAgentStep(provider) {
  return Boolean(provider)
    && typeof provider.agentStep === 'function'
    && provider.capabilities?.()?.toolCalling === true;
}

/**
 * Shape validator for a provider claiming toolCalling — mirrors
 * validateGenerationProvider()'s shallow style.
 * @param {Object} provider
 * @throws {TypeError}
 */
export function assertAgentStepProvider(provider) {
  if (!supportsAgentStep(provider)) {
    throw new TypeError(
      'assertAgentStepProvider: provider does not implement agentStep() with capabilities().toolCalling === true.'
    );
  }
  return true;
}
