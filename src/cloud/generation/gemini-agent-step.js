// Gemini's implementation of the AgentStepCapability contract
// (src/core/generation/agent-step.js) — the ONE place neutral agent-step
// input/output is mapped onto @google/genai's native function-calling shape.
//
// VERIFIED AGAINST THE INSTALLED SDK (@google/genai 2.12.0), not from memory:
//   - config.tools: Tool[]; Tool.functionDeclarations?: FunctionDeclaration[]
//   - FunctionDeclaration: { name, description?, parametersJsonSchema? } —
//     parametersJsonSchema is the plain-JSON-Schema field and is documented
//     as MUTUALLY EXCLUSIVE with the OpenAPI-flavoured `parameters`. We send
//     parametersJsonSchema, since the supported subset in
//     core/agent/tool-schema.js already IS plain JSON Schema.
//   - Part.functionCall?: FunctionCall { id?, name?, args? }
//   - Part.functionResponse?: FunctionResponse { id?, name?, response? }
//     ("Use 'output' key to specify function output and 'error' key to
//     specify error details" — followed exactly below.)
//   - Part.thoughtSignature?: string — "An opaque signature for the thought
//     so it can be reused in subsequent requests."
//   - FinishReason enum includes MALFORMED_FUNCTION_CALL, SAFETY,
//     MAX_TOKENS, PROHIBITED_CONTENT, BLOCKLIST, SPII, RECITATION.
//   - FunctionCall.partialArgs / willContinue exist for incremental
//     streaming and are documented "not supported in Gemini API" — a part
//     carrying them is treated as NOT executable (see below).
//
// CONTINUATION FIDELITY
// ---------------------
// The next request's `contents` is rebuilt from the REAL native parts this
// adapter captured (including thoughtSignature), never re-synthesized from
// {name, args, text}. Re-synthesizing would silently drop thought signatures
// and any future part metadata, which the plan calls out explicitly. Those
// native parts live in the returned `providerState`, which the runtime
// stores server-side and never exposes.
import { AgentStepError, AGENT_MESSAGE_ROLE } from '../../core/generation/agent-step.js';
import { validateToolArguments } from '../../core/agent/tool-schema.js';

/** Finish reasons that must NEVER be reported as a completed answer. */
const REFUSAL_FINISH_REASONS = new Set([
  'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY',
]);

// The ONLY finish reasons that may produce a usable result — an ALLOWLIST,
// not a deny-list.
//
// A deny-list was the original design and it was wrong in two ways at once
// (code review, pre-release):
//   1. A stream carrying a functionCall but NO finishReason at all skipped
//      the "no terminal state" check entirely, because that check lived
//      inside the no-tool-calls branch. An unfinished stream could hand
//      back an EXECUTABLE tool call.
//   2. Reasons the deny-list simply didn't enumerate — OTHER, LANGUAGE,
//      FINISH_REASON_UNSPECIFIED, and anything Google adds later — fell
//      through to `completed`.
// Both share one root cause: "not known-bad" was treated as "good". With an
// allowlist, an unrecognized or absent terminal state fails closed, and a
// future FinishReason value cannot silently become a successful answer.
const SUCCESSFUL_FINISH_REASONS = new Set(['STOP']);

function redactApiKeyFromMessage(message, apiKey) {
  if (!message) return message;
  let out = String(message);
  if (apiKey) out = out.split(apiKey).join('[REDACTED]');
  return out;
}

/**
 * Maps neutral tool definitions onto Gemini's Tool[] shape.
 * @param {ReadonlyArray<{name: string, description?: string, inputSchema: Object}>} tools
 */
export function toGeminiTools(tools) {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      // parametersJsonSchema (NOT `parameters`) — the two are documented as
      // mutually exclusive, and our supported subset is already plain JSON
      // Schema, so no lossy OpenAPI conversion is performed.
      parametersJsonSchema: t.inputSchema,
    })),
  }];
}

/**
 * Rebuilds Gemini `contents` for this step.
 *
 * `history` is the run's accumulated NATIVE content list (from prior steps'
 * providerState) — replayed verbatim so thought signatures and any other
 * native part metadata survive. `pendingToolResults` are appended as ONE
 * user-role content of functionResponse parts, which is the shape the SDK
 * documents for returning function results.
 *
 * @param {{ nativeContents?: Array<Object> }} providerState
 * @param {Array<{ role: string, content?: string, toolCallId?: string, toolName?: string, output?: unknown, error?: unknown }>} messages
 */
export function buildGeminiContents(providerState, messages) {
  const contents = Array.isArray(providerState?.nativeContents)
    ? providerState.nativeContents.map((c) => structuredClone(c))
    : [];

  const pendingResponses = [];
  for (const message of messages) {
    if (message.role === AGENT_MESSAGE_ROLE.USER) {
      flushToolResponses(contents, pendingResponses);
      contents.push({ role: 'user', parts: [{ text: String(message.content ?? '') }] });
      continue;
    }
    if (message.role === AGENT_MESSAGE_ROLE.ASSISTANT) {
      flushToolResponses(contents, pendingResponses);
      contents.push({ role: 'model', parts: [{ text: String(message.content ?? '') }] });
      continue;
    }
    if (message.role === AGENT_MESSAGE_ROLE.TOOL) {
      // FunctionResponse.response: "Use 'output' key to specify function
      // output and 'error' key to specify error details (if any)." An
      // executor-reported failure is therefore sent as a real error result,
      // not as a fake successful output — the model is told the truth.
      const response = message.error !== undefined
        ? { error: message.error }
        : { output: message.output };
      pendingResponses.push({
        functionResponse: {
          ...(message.toolCallId ? { id: message.toolCallId } : {}),
          name: message.toolName,
          response,
        },
      });
      continue;
    }
    throw new AgentStepError('provider_error', `Unsupported agent message role "${message.role}".`);
  }
  flushToolResponses(contents, pendingResponses);
  return contents;
}

function flushToolResponses(contents, pending) {
  if (pending.length === 0) return;
  contents.push({ role: 'user', parts: pending.splice(0, pending.length) });
}

/**
 * Creates the Gemini agentStep() implementation, bound to an already-built
 * SDK client getter. Kept as its own factory (rather than inlined into
 * gemini-provider.js) so the mapping above is unit-testable in isolation
 * against a fake SDK.
 *
 * @param {{
 *   getClient: () => Promise<Object|null>,
 *   apiKey: string,
 *   defaultModel: string,
 *   clientInitError?: () => Error|null,
 * }} deps
 */
export function createGeminiAgentStep({ getClient, apiKey, defaultModel, clientInitError = () => null }) {
  /**
   * @param {{
   *   systemInstructions?: string,
   *   messages: Array<Object>,
   *   tools: ReadonlyArray<{name: string, description?: string, inputSchema: Object}>,
   *   providerState?: Object,
   *   model?: string,
   *   maxOutputTokens?: number,
   *   signal?: AbortSignal,
   *   onText?: (delta: string) => void|Promise<void>,
   *   makeCallId?: (index: number) => string,
   * }} args
   * @returns {Promise<import('../../core/generation/agent-step.js').AgentStepResult>}
   */
  return async function agentStep({
    systemInstructions, messages = [], tools = [], providerState,
    model: requestedModel, maxOutputTokens, signal, onText, makeCallId,
  }) {
    if (!apiKey) throw new AgentStepError('provider_error', 'Gemini agentStep() called without a configured GEMINI_API_KEY.');
    const client = await getClient();
    if (!client) {
      throw new AgentStepError('provider_error',
        `Gemini client is not initialized: ${redactApiKeyFromMessage(clientInitError()?.message, apiKey)}`);
    }
    if (signal?.aborted) throw new AgentStepError('stream_interrupted', 'The request was cancelled before generation began.');

    const contents = buildGeminiContents(providerState, messages);
    const allowedTools = new Map(tools.map((t) => [t.name, t]));

    const config = {
      tools: toGeminiTools(tools),
      ...(systemInstructions ? { systemInstruction: systemInstructions } : {}),
      ...(Number.isFinite(maxOutputTokens) ? { maxOutputTokens } : {}),
      ...(signal ? { abortSignal: signal } : {}),
    };

    let stream;
    try {
      stream = await client.models.generateContentStream({
        model: requestedModel ?? defaultModel,
        contents,
        config,
      });
    } catch (err) {
      if (signal?.aborted) throw new AgentStepError('stream_interrupted', 'The request was cancelled.');
      throw new AgentStepError('provider_error',
        `Gemini generateContentStream failed: ${redactApiKeyFromMessage(err?.message, apiKey)}`, { retryable: true });
    }

    let text = '';
    let tokensIn;
    let tokensOut;
    let finishReason = null;
    /** Native model parts, in order, captured verbatim for continuation fidelity. */
    const modelParts = [];
    let sawAnyChunk = false;

    try {
      for await (const chunk of stream) {
        sawAnyChunk = true;
        if (signal?.aborted) throw new AgentStepError('stream_interrupted', 'The request was cancelled mid-stream.');

        const candidate = chunk?.candidates?.[0];
        if (candidate?.finishReason) finishReason = candidate.finishReason;

        for (const part of candidate?.content?.parts ?? []) {
          // Capture EVERY part verbatim (text, functionCall, thought,
          // thoughtSignature carriers) — this array becomes the model turn
          // replayed on the next step.
          modelParts.push(structuredClone(part));
          // A `thought` part is the model's internal reasoning. It is
          // preserved in providerState for continuation but MUST NOT be
          // streamed to the caller or returned in the public result.
          if (typeof part.text === 'string' && part.text.length > 0 && part.thought !== true) {
            text += part.text;
            await onText?.(part.text);
          }
        }

        const usage = chunk?.usageMetadata;
        if (usage) {
          if (typeof usage.promptTokenCount === 'number') tokensIn = usage.promptTokenCount;
          if (typeof usage.candidatesTokenCount === 'number') tokensOut = usage.candidatesTokenCount;
        }
      }
    } catch (err) {
      if (err instanceof AgentStepError) throw err;
      if (signal?.aborted) throw new AgentStepError('stream_interrupted', 'The request was cancelled mid-stream.');
      throw new AgentStepError('stream_interrupted',
        `Gemini stream failed while reading the response: ${redactApiKeyFromMessage(err?.message, apiKey)}`, { retryable: true });
    }

    if (signal?.aborted) throw new AgentStepError('stream_interrupted', 'The request was cancelled.');

    // ── Terminal-state classification. None of these are `completed`. ──
    if (finishReason === 'MALFORMED_FUNCTION_CALL' || finishReason === 'UNEXPECTED_TOOL_CALL') {
      throw new AgentStepError('malformed_tool_call',
        'The model produced an invalid tool call. No tool was executed.');
    }
    if (REFUSAL_FINISH_REASONS.has(finishReason)) {
      throw new AgentStepError('safety_refusal',
        `The model stopped generating (${finishReason}). This is not a completed answer.`);
    }
    if (finishReason === 'MAX_TOKENS') {
      throw new AgentStepError('output_limit_reached',
        'The model reached the configured output-token ceiling before finishing. This is not a completed answer.');
    }
    if (!sawAnyChunk) {
      throw new AgentStepError('stream_interrupted', 'The model returned no content.', { retryable: true });
    }
    // The allowlist gate — applied BEFORE any result shape is built, so it
    // covers a tool-call response exactly as it covers a text response.
    // A missing finishReason means the stream never reached a documented
    // terminal state; anything unrecognized is not proof of success.
    if (!SUCCESSFUL_FINISH_REASONS.has(finishReason)) {
      throw new AgentStepError('stream_interrupted',
        finishReason === null
          ? 'The model stream ended without a terminal finish reason. No tool call from an unfinished stream is executable.'
          : `The model stream ended with an unrecognized finish reason (${finishReason}). This is not a completed result.`,
        { retryable: true });
    }

    const usage = { ...(tokensIn !== undefined ? { tokensIn } : {}), ...(tokensOut !== undefined ? { tokensOut } : {}) };

    // ── Tool calls ────────────────────────────────────────────────────────
    const rawCalls = modelParts
      .map((p) => p.functionCall)
      .filter((fc) => fc !== undefined && fc !== null);

    if (rawCalls.length === 0) {
      // finishReason is guaranteed to be an allowlisted success by now.
      return {
        status: 'completed',
        text,
        toolCalls: [],
        usage,
        providerState: { nativeContents: [...contents, { role: 'model', parts: modelParts }] },
      };
    }

    const toolCalls = [];
    const idByPartIndex = new Map();
    rawCalls.forEach((fc, index) => {
      // Partial/streaming argument fragments are NOT an executable event
      // (the plan's explicit rule). Gemini API does not populate these, but
      // a future/Vertex response could — refuse rather than execute a call
      // whose arguments are still arriving.
      if (fc.willContinue === true || (Array.isArray(fc.partialArgs) && fc.partialArgs.length > 0)) {
        throw new AgentStepError('malformed_tool_call',
          'The model returned a partial (still-streaming) tool call. Partial arguments are never executable.');
      }
      const name = fc.name;
      if (typeof name !== 'string' || name.length === 0) {
        throw new AgentStepError('malformed_tool_call', 'The model returned a tool call with no name.');
      }
      const tool = allowedTools.get(name);
      if (!tool) {
        throw new AgentStepError('unknown_tool',
          `The model requested a tool that is not in this run's allowlist. No tool was executed.`);
      }
      const args = fc.args ?? {};
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new AgentStepError('malformed_tool_call', `Tool call "${name}" produced arguments that are not a JSON object.`);
      }
      const check = validateToolArguments(tool.inputSchema, args);
      if (!check.ok) {
        throw new AgentStepError('invalid_tool_arguments',
          `Tool call "${name}" produced arguments that do not match its declared schema: ${check.message}`);
      }
      // Gemini may omit `id`. A stable synthetic id is generated and mapped
      // back onto the native part, so the continuation's functionResponse
      // carries the SAME id the application echoed to us.
      const id = (typeof fc.id === 'string' && fc.id.length > 0) ? fc.id : (makeCallId?.(index) ?? `call_${index}`);
      idByPartIndex.set(fc, id);
      toolCalls.push({ id, name, arguments: structuredClone(args) });
    });

    // Stamp synthesized ids onto the captured native parts, so the model
    // turn we replay next step matches the ids we handed the application.
    for (const part of modelParts) {
      const fc = part.functionCall;
      if (fc && idByPartIndex.has(fc) && (typeof fc.id !== 'string' || fc.id.length === 0)) {
        fc.id = idByPartIndex.get(fc);
      }
    }

    return {
      status: 'requires_action',
      text,
      toolCalls,
      usage,
      providerState: { nativeContents: [...contents, { role: 'model', parts: modelParts }] },
    };
  };
}
