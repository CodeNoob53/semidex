// Agent runtime — the transport-neutral core of agent mode.
//
// ONE HTTP REQUEST == ONE MODEL STEP. The application owns the execution
// loop: it receives `requires_action` with verified tool calls, runs them
// itself (Semidex never does), and continues the run with their results.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
// -----------------------------------------
//  - It does not import HTTP, Admin, CLI, or a concrete provider. The route
//    (src/core/agent-api/v3/route.js) authorizes, validates and projects
//    events; this file decides and executes. That is what makes the same
//    runtime reusable by a future embedded SDK with no HTTP at all.
//  - It NEVER executes a tool. `requires_action` is the end of Semidex's
//    involvement in that step. Whether a tool is allowed to have side
//    effects is the executor's decision, not ours.
//  - It runs NO hidden retrieval. Retrieval reaches an agent run only when
//    the application declares a tool for it and calls it; every such call
//    goes through the ordinary Search/Content API and its own collection
//    authorization. Tool-result text is application data, never a
//    Semidex-verified citation from the index.
//
// TRUST BOUNDARY FOR TOOL RESULTS
// -------------------------------
// A tool result is EXTERNAL DATA, not instructions. It is placed in the
// conversation as a function response (the provider's own native channel for
// that), never merged into systemInstructions. Validating that a result is
// well-formed JSON says nothing about whether it is true — the executor owns
// its truthfulness.
import { AgentStepError, supportsAgentStep, AGENT_MESSAGE_ROLE } from '../generation/agent-step.js';
import { validateToolDefinitions } from './tool-schema.js';
import { createContinuationStore, ContinuationError, RUN_STATUS } from './continuation-store.js';

/** Per-run ceilings the OPERATOR sets. A client may only ever lower these. */
export const AGENT_RUN_LIMITS = Object.freeze({
  maxModelSteps: 8,
  maxToolCallsPerRun: 32,
  maxOutputTokensPerStep: 2048,
  // AGGREGATE ceiling across every model step of ONE run. Previously
  // `usage.reservedTokens` was accumulated and never compared to anything,
  // so a run had no token budget of its own: HTTP builds a fresh
  // per-request ledger per step, which preserves the PER-KEY aggregate but
  // means a single long run could keep spending step after step. This is
  // the run-scoped budget that was claimed but not enforced.
  maxReservedTokensPerRun: 120_000,
  // Default context ceiling for one step. Previously only settable by a
  // caller and therefore always null in production, so the
  // context_budget_exceeded path was unreachable over HTTP.
  maxContextTokens: 200_000,
  maxInstructionsChars: 20_000,
  maxInputChars: 20_000,
  maxToolResultBytes: 128 * 1024,
  maxTotalToolResultBytes: 512 * 1024,
});

export class AgentRuntimeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ retryable?: boolean, noWorkPerformed?: boolean }} [opts]
   *   `noWorkPerformed` marks a failure raised BEFORE the generation
   *   provider was ever invoked. It is the single fact `continue()` needs to
   *   decide whether the run's state is still trustworthy: if the model was
   *   never called, the stored providerState and pending calls are exactly
   *   as they were, so the run MUST survive and the caller may retry with
   *   the same continuationId and the same already-executed tool results.
   *   Deciding this from the error CODE instead would be fragile — a new
   *   pre-provider check added later would be silently misclassified as a
   *   post-generation failure and would destroy a valid continuation.
   */
  constructor(code, message, { retryable = false, noWorkPerformed = false } = {}) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
    this.retryable = retryable;
    this.noWorkPerformed = noWorkPerformed;
  }
}

/**
 * Conservative input-token estimate for the budget reservation, from the
 * characters this step will actually send. Deliberately pessimistic (3 chars
 * per token, denser than the 4-char heuristic elsewhere) so a reservation is
 * never smaller than reality — reserve-before, reconcile-after.
 */
function estimateInputTokens({ systemInstructions, tools, history, messages }) {
  let chars = (systemInstructions?.length ?? 0);
  try {
    chars += JSON.stringify(tools ?? []).length;
    chars += JSON.stringify(history ?? []).length;
    chars += JSON.stringify(messages ?? []).length;
  } catch {
    chars += 100_000; // unserializable — assume the worst rather than under-reserve
  }
  return Math.ceil(chars / 3);
}

/**
 * @param {{
 *   generationProvider: Object,
 *   store?: ReturnType<typeof createContinuationStore>,
 *   limits?: Partial<typeof AGENT_RUN_LIMITS>,
 *   makeCallId?: (runSeed: string, index: number) => string,
 *   gate?: ReturnType<typeof import('../ask/single-flight-gate.js').createSingleFlightGate>,
 *     The SHARED single-flight generation gate — the SAME instance Ask
 *     v1/v2 contend on. Without it, agent mode ran generations completely
 *     outside the process's one-generation-at-a-time policy (reproduced:
 *     two concurrent start() calls ran two real generations at once).
 *     Held ONLY for the duration of a model step and released before the
 *     run goes back to waiting for tool results — a run that may sit idle
 *     for minutes must never hold a process-wide lock across HTTP requests.
 * }} deps
 */
export function createAgentRuntime({ generationProvider, store, limits = {}, makeCallId, gate } = {}) {
  if (!generationProvider) {
    throw new TypeError('createAgentRuntime requires a generationProvider.');
  }
  const cfg = { ...AGENT_RUN_LIMITS, ...limits };
  const runs = store ?? createContinuationStore();
  let callSeq = 0;
  const nextCallId = makeCallId ?? ((_seed, index) => `call_${Date.now().toString(36)}_${(callSeq += 1).toString(36)}_${index}`);

  /**
   * Refuses BEFORE any retrieval or billed generation when the active
   * backend cannot do tool calling at all — the plan's explicit ordering
   * requirement ("повертають capability_unavailable до retrieval/генерації").
   */
  function assertCapability() {
    if (!supportsAgentStep(generationProvider)) {
      throw new AgentRuntimeError('capability_unavailable',
        'The configured generation backend does not support tool calling. Agent mode requires a tool-calling capable provider.');
    }
  }

  /**
   * Acquires the shared generation slot BEFORE anything destructive happens.
   *
   * ORDERING IS THE WHOLE POINT (code review, second round). The gate used
   * to be taken around the provider call itself, i.e. AFTER the run had been
   * claimed and AFTER tokens had been reserved. That made a `busy` refusal
   * destructive in two ways at once:
   *   - the claimed continuation was closed by the error path, so a caller
   *     that retried after the gate freed got run_not_found — its tool
   *     results had already been executed and could never be delivered;
   *   - the reservation was already taken, and reconcile(id, undefined)
   *     deliberately retains the full conservative reservation, so a
   *     refused request that ran ZERO generations still spent budget.
   * Refusing here — before claim, before reserve — makes `busy` a
   * guaranteed-no-work outcome: nothing is consumed and the run is untouched,
   * so the caller may simply retry with the same continuationId.
   *
   * Returns a release function the caller MUST invoke in a finally.
   */
  function acquireGenerationSlot() {
    if (!gate) return () => {};
    if (!gate.tryAcquire) {
      // A gate without tryAcquire cannot be held across an await boundary
      // safely; treat it as absent rather than guessing at its semantics.
      return () => {};
    }
    const release = gate.tryAcquire();
    if (!release) {
      throw new AgentRuntimeError('busy',
        'Another generation is already in progress. Only one generation may run at a time. '
        + 'No work was performed: retry this request unchanged.',
        { retryable: true, noWorkPerformed: true });
    }
    return release;
  }

  /**
   * Runs ONE model step and converts its outcome into a transport-neutral
   * result. Shared by start() and continue().
   */
  async function runStep({ context, providerState, messages, usage, budget, signal, onText }) {
    if (usage.modelSteps >= context.maxModelSteps) {
      throw new AgentRuntimeError('run_step_limit_exceeded',
        `This agent run reached its maximum of ${context.maxModelSteps} model steps.`,
        { noWorkPerformed: true });
    }

    const estimatedInputTokens = estimateInputTokens({
      systemInstructions: context.systemInstructions,
      tools: context.tools,
      history: providerState,
      messages,
    });
    const maxOutputTokens = context.maxOutputTokensPerStep;

    // AGGREGATE run budget — checked BEFORE the per-step context ceiling and
    // before any reservation, so a run that has already spent its budget
    // never reaches the provider at all.
    const projectedReserved = usage.reservedTokens + estimatedInputTokens + maxOutputTokens;
    if (projectedReserved > context.maxReservedTokensPerRun) {
      throw new AgentRuntimeError('run_token_ceiling_exceeded',
        `This agent run would exceed its maximum of ${context.maxReservedTokensPerRun} reserved tokens `
        + 'across all model steps. Start a new run rather than continuing this one.',
        { noWorkPerformed: true });
    }

    // Context ceiling — never silently truncate arguments/results or drop an
    // unfinished call/result pair; report it (the plan's explicit rule).
    if (context.maxContextTokens !== null && estimatedInputTokens + maxOutputTokens > context.maxContextTokens) {
      throw new AgentRuntimeError('context_budget_exceeded',
        'This agent run no longer fits the model context budget. Start a new run rather than continuing this one; '
        + 'tool results are never silently truncated to make room.',
        { noWorkPerformed: true });
    }

    // RESERVE BEFORE the provider call — a denial means the provider is
    // never invoked at all, so a run that would blow its ceiling costs
    // nothing. Reuses the SAME per-request ledger Ask v1/v2 use.
    let reservation = null;
    if (budget) {
      reservation = budget.reserve({ label: 'answer', estimatedInputTokens, maxOutputTokens });
      if (!reservation.ok) {
        // A budget denial happens BEFORE the provider call, so no generation
        // ran and the reservation was never granted. The API already marks
        // key_budget_exceeded retryable; destroying the continuation would
        // make that promise a lie, since the caller would have nothing left
        // to retry against.
        const denial = new AgentRuntimeError(reservation.code, reservation.message,
          { retryable: reservation.code === 'key_budget_exceeded', noWorkPerformed: true });
        if (Number.isFinite(reservation.retryAfterSeconds)) denial.retryAfterSeconds = reservation.retryAfterSeconds;
        throw denial;
      }
    }

    let step;
    try {
      // The generation slot is already held by the caller (see
      // acquireGenerationSlot()) — never acquired here, so a refusal can
      // never happen after a claim or a reservation.
      step = await generationProvider.agentStep({
        systemInstructions: context.systemInstructions,
        messages,
        tools: context.tools,
        providerState,
        model: context.model,
        maxOutputTokens: reservation?.maxOutputTokens ?? maxOutputTokens,
        signal,
        onText,
        makeCallId: (index) => nextCallId(context.runSeed, index),
      });
    } catch (err) {
      if (err instanceof AgentStepError) {
        throw new AgentRuntimeError(err.code, err.message, { retryable: err.retryable });
      }
      throw err;
    } finally {
      // Reconcile even on failure: a call that reached the provider may have
      // produced usage. reconcile() only ever refunds.
      if (reservation?.ok) budget.reconcile(reservation.reservationId, step?.usage);
    }

    const nextUsage = {
      modelSteps: usage.modelSteps + 1,
      toolCalls: usage.toolCalls + step.toolCalls.length,
      reservedTokens: usage.reservedTokens + estimatedInputTokens + maxOutputTokens,
    };

    if (step.status === 'requires_action' && nextUsage.toolCalls > context.maxToolCallsPerRun) {
      throw new AgentRuntimeError('run_tool_call_limit_exceeded',
        `This agent run reached its maximum of ${context.maxToolCallsPerRun} tool calls.`);
    }

    return { step, nextUsage };
  }

  return {
    /**
     * Starts a run. Returns either a completed answer (no run is stored) or
     * `requires_action` with a continuationId and verified tool calls.
     *
     * @param {{
     *   identity: string,
     *   input: string,
     *   systemInstructions?: string,
     *   tools: unknown,
     *   model?: string,
     *   maxModelSteps?: number, maxToolCalls?: number, maxOutputTokens?: number,
     *   maxContextTokens?: number, maxReservedTokens?: number,
     *   budget?: Object, signal?: AbortSignal, onText?: Function,
     * }} args
     */
    async start({
      identity, input, systemInstructions, tools, model,
      maxModelSteps, maxToolCalls, maxOutputTokens, maxContextTokens, maxReservedTokens,
      budget, signal, onText,
    }) {
      assertCapability();

      if (typeof input !== 'string' || input.trim().length === 0) {
        throw new AgentRuntimeError('bad_request', 'input is required and must be a non-empty string.');
      }
      if (input.length > cfg.maxInputChars) {
        throw new AgentRuntimeError('bad_request', `input exceeds the maximum of ${cfg.maxInputChars} characters.`);
      }
      if (systemInstructions !== undefined) {
        if (typeof systemInstructions !== 'string') {
          throw new AgentRuntimeError('bad_request', 'systemInstructions must be a string when provided.');
        }
        if (systemInstructions.length > cfg.maxInstructionsChars) {
          throw new AgentRuntimeError('bad_request', `systemInstructions exceeds the maximum of ${cfg.maxInstructionsChars} characters.`);
        }
      }

      const validatedTools = validateToolDefinitions(tools);

      // A client may only ever LOWER an operator ceiling, never raise it.
      const context = Object.freeze({
        systemInstructions: systemInstructions ?? undefined,
        tools: validatedTools,
        model: model ?? undefined,
        maxModelSteps: Math.min(cfg.maxModelSteps, Number.isFinite(maxModelSteps) ? maxModelSteps : cfg.maxModelSteps),
        maxToolCallsPerRun: Math.min(cfg.maxToolCallsPerRun, Number.isFinite(maxToolCalls) ? maxToolCalls : cfg.maxToolCallsPerRun),
        maxOutputTokensPerStep: Math.min(cfg.maxOutputTokensPerStep, Number.isFinite(maxOutputTokens) ? maxOutputTokens : cfg.maxOutputTokensPerStep),
        // Both aggregate ceilings resolve like every other limit: the
        // operator's value unless the client asked for a SMALLER one.
        maxReservedTokensPerRun: Math.min(
          cfg.maxReservedTokensPerRun,
          Number.isFinite(maxReservedTokens) ? maxReservedTokens : cfg.maxReservedTokensPerRun,
        ),
        maxContextTokens: Math.min(
          cfg.maxContextTokens,
          Number.isFinite(maxContextTokens) ? maxContextTokens : cfg.maxContextTokens,
        ),
        runSeed: `${Date.now().toString(36)}`,
      });

      // Slot first: a `busy` refusal must cost nothing (see
      // acquireGenerationSlot()). Released as soon as the model step ends —
      // a start() that returns requires_action holds nothing while the
      // application executes tools.
      const releaseSlot = acquireGenerationSlot();
      let step;
      let nextUsage;
      try {
        ({ step, nextUsage } = await runStep({
          context,
          providerState: undefined,
          messages: [{ role: AGENT_MESSAGE_ROLE.USER, content: input }],
          usage: { modelSteps: 0, toolCalls: 0, reservedTokens: 0 },
          budget, signal, onText,
        }));
      } finally {
        releaseSlot();
      }

      if (step.status === 'completed') {
        return { status: 'completed', text: step.text, usage: step.usage, steps: nextUsage.modelSteps };
      }

      const continuationId = runs.create({
        identity,
        context,
        providerState: step.providerState,
        pendingCalls: step.toolCalls.map((c) => ({ id: c.id, name: c.name })),
        usage: nextUsage,
      });

      return {
        status: 'requires_action',
        continuationId,
        text: step.text,
        toolCalls: step.toolCalls,
        usage: step.usage,
        steps: nextUsage.modelSteps,
      };
    },

    /**
     * Continues a run with the COMPLETE set of results for its pending calls.
     * Instructions, tools, model and budget are frozen — a continuation may
     * not change them (a new task is a new run).
     *
     * @param {{
     *   identity: string, continuationId: string,
     *   toolResults: Array<{ callId: string, ok: boolean, output?: unknown, error?: unknown }>,
     *   budget?: Object, signal?: AbortSignal, onText?: Function,
     * }} args
     */
    async continue({ identity, continuationId, toolResults, budget, signal, onText }) {
      assertCapability();

      if (typeof continuationId !== 'string' || continuationId.length === 0) {
        throw new AgentRuntimeError('bad_request', 'continuationId is required.');
      }
      if (!Array.isArray(toolResults) || toolResults.length === 0) {
        throw new AgentRuntimeError('bad_request', 'toolResults must be a non-empty array.');
      }

      // Size-bound the results BEFORE claiming, so an oversized payload does
      // not burn the run — the caller may correct it and retry.
      let totalBytes = 0;
      for (const [i, result] of toolResults.entries()) {
        if (typeof result?.callId !== 'string' || result.callId.length === 0) {
          throw new AgentRuntimeError('bad_request', `toolResults[${i}].callId is required.`);
        }
        if (typeof result.ok !== 'boolean') {
          throw new AgentRuntimeError('bad_request', `toolResults[${i}].ok must be a boolean (a discriminated success/error result).`);
        }
        if (result.ok && result.error !== undefined) {
          throw new AgentRuntimeError('bad_request', `toolResults[${i}] declares ok:true but also carries an error.`);
        }
        if (!result.ok && result.error === undefined) {
          throw new AgentRuntimeError('bad_request', `toolResults[${i}] declares ok:false and must carry an error.`);
        }
        let bytes;
        try {
          bytes = Buffer.byteLength(JSON.stringify(result.ok ? result.output ?? null : result.error) ?? 'null', 'utf8');
        } catch {
          throw new AgentRuntimeError('bad_request', `toolResults[${i}] payload must be JSON-serializable.`);
        }
        if (bytes > cfg.maxToolResultBytes) {
          throw new AgentRuntimeError('tool_result_too_large',
            `toolResults[${i}] exceeds the maximum of ${cfg.maxToolResultBytes} bytes. Results are never silently truncated.`);
        }
        totalBytes += bytes;
      }
      if (totalBytes > cfg.maxTotalToolResultBytes) {
        throw new AgentRuntimeError('tool_result_too_large',
          `The supplied tool results exceed the combined maximum of ${cfg.maxTotalToolResultBytes} bytes.`);
      }

      // Slot BEFORE claim. If the generation slot is busy this throws
      // without touching the run, so the caller's already-executed tool
      // results stay deliverable on a retry with the SAME continuationId.
      // Acquiring after the claim (the original order) meant a `busy`
      // refusal ran the error path, which closed the run — the results
      // could then never be delivered at all.
      const releaseSlot = acquireGenerationSlot();

      let claimed;
      try {
        claimed = runs.claim({ runId: continuationId, identity, results: toolResults });
      } catch (err) {
        releaseSlot();
        if (err instanceof ContinuationError) throw new AgentRuntimeError(err.code, err.message);
        throw err;
      }

      const { context, providerState, usage, pendingCalls } = claimed;
      const knownTools = new Set(context.tools.map((t) => t.name));
      // Tool names come from the store's own NEUTRAL {id, name} record —
      // never from the opaque providerState. Reading Gemini's
      // nativeContents[].parts[].functionCall here is what made this
      // "transport-neutral" module provider-specific in practice.
      const pendingNames = new Map(pendingCalls.map((c) => [c.id, c.name]));

      let step;
      let nextUsage;
      try {
        const messages = toolResults.map((result) => {
          const toolName = pendingNames.get(result.callId);
          if (!toolName || !knownTools.has(toolName)) {
            // The store already matched call ids, so reaching here means the
            // stored pending list and the run's tools disagree — never
            // guessed past. Thrown INSIDE this try so the run is released
            // rather than left IN_FLIGHT forever (it previously threw above
            // the cleanup block, permanently wedging the run).
            // Deliberately NOT noWorkPerformed: the stored pending list and the
          // run's own tools disagree, so the run's state is inconsistent and
          // retrying the identical request could never succeed. Closing it is
          // correct — unlike a budget/gate refusal, which leaves valid state.
          throw new AgentRuntimeError('results_mismatch', 'A tool result does not correspond to a known call in this run.');
          }
          return {
            role: AGENT_MESSAGE_ROLE.TOOL,
            toolCallId: result.callId,
            toolName,
            ...(result.ok ? { output: result.output ?? null } : { error: result.error }),
          };
        });
        ({ step, nextUsage } = await runStep({ context, providerState, messages, usage, budget, signal, onText }));
      } catch (err) {
        if (err?.noWorkPerformed === true) {
          // The model was never invoked, so the run's stored providerState
          // and pending calls are untouched and still correct. PRESERVE the
          // continuation: closing it here made a documented-retryable
          // failure permanently unrecoverable — reproduced as
          // key_budget_exceeded -> (budget refills) -> run_not_found, with
          // the caller's already-executed tool results stranded.
          //
          // release(READY) with the SAME state returns the run to claimable
          // without advancing it, so the identical retry — same
          // continuationId, same toolResults — succeeds.
          claimed.release({
            status: RUN_STATUS.READY,
            providerState,
            pendingCalls,
            usage,
          });
          throw err;
        }
        // A failure at or after the model call closes the run: its provider
        // state is no longer a trustworthy basis for continuation, and
        // holding it would leak memory.
        claimed.release({ status: RUN_STATUS.CLOSED });
        throw err;
      } finally {
        releaseSlot();
      }

      if (step.status === 'completed') {
        claimed.release({ status: RUN_STATUS.COMPLETED });
        return { status: 'completed', text: step.text, usage: step.usage, steps: nextUsage.modelSteps };
      }

      claimed.release({
        status: RUN_STATUS.READY,
        providerState: step.providerState,
        pendingCalls: step.toolCalls.map((c) => ({ id: c.id, name: c.name })),
        usage: nextUsage,
      });

      return {
        status: 'requires_action',
        continuationId,
        text: step.text,
        toolCalls: step.toolCalls,
        usage: step.usage,
        steps: nextUsage.modelSteps,
      };
    },

    /** Frees a run's memory (abort/disconnect). Never throws for an unknown id. */
    close({ identity, continuationId }) {
      if (typeof continuationId !== 'string' || continuationId.length === 0) return false;
      return runs.close({ runId: continuationId, identity });
    },

    /** Test/diagnostic hook. */
    stats() {
      return runs.stats();
    },
  };
}
