// Agent runtime — offline. The generation provider is a FAKE implementing
// the AgentStepCapability contract; no network, no real SDK, no HTTP.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime, AGENT_RUN_LIMITS } from '../../../../src/core/agent/runtime.js';
import { createContinuationStore } from '../../../../src/core/agent/continuation-store.js';
import { AgentStepError } from '../../../../src/core/generation/agent-step.js';

const TOOLS = [{
  name: 'lookup_items',
  description: 'Read items',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
}];

/**
 * A fake tool-calling provider. `script` is consumed one entry per step; an
 * entry is either an AgentStepResult or an Error to throw.
 */
function fakeProvider(script, { calls = [] } = {}) {
  let i = 0;
  return {
    name: () => 'fake',
    capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: false, hardOutputCap: true, toolCalling: true }),
    ready: async () => ({ ok: true }),
    generate: async () => ({ text: '' }),
    async agentStep(args) {
      calls.push(args);
      const entry = script[i++];
      if (entry === undefined) throw new Error('fake provider script exhausted');
      if (entry instanceof Error) throw entry;
      return {
        status: entry.status,
        text: entry.text ?? '',
        toolCalls: entry.toolCalls ?? [],
        usage: entry.usage ?? {},
        providerState: entry.providerState ?? { nativeContents: nativeFor(entry.toolCalls ?? []) },
      };
    },
  };
}

/** Native contents shaped the way the runtime reads call names back out of providerState. */
function nativeFor(toolCalls) {
  return [{ role: 'model', parts: toolCalls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.arguments } })) }];
}

function nonToolProvider() {
  return {
    name: () => 'ollama-like',
    capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true, hardOutputCap: true }),
    ready: async () => ({ ok: true }),
    generate: async () => ({ text: 'plain' }),
  };
}

describe('capability gate', () => {
  test('a backend without tool calling is refused BEFORE any generation', async () => {
    const provider = nonToolProvider();
    let generated = false;
    provider.generate = async () => { generated = true; return { text: '' }; };
    const runtime = createAgentRuntime({ generationProvider: provider });
    await assert.rejects(
      () => runtime.start({ identity: 'k', input: 'hi', tools: TOOLS }),
      (err) => err.code === 'capability_unavailable',
    );
    assert.equal(generated, false, 'no generation may be attempted on an unsupported backend');
  });

  test('continue() is refused the same way', async () => {
    const runtime = createAgentRuntime({ generationProvider: nonToolProvider() });
    await assert.rejects(
      () => runtime.continue({ identity: 'k', continuationId: 'x', toolResults: [{ callId: 'a', ok: true, output: {} }] }),
      (err) => err.code === 'capability_unavailable',
    );
  });
});

describe('start()', () => {
  test('a completed first step returns text and stores NO run', async () => {
    const runtime = createAgentRuntime({ generationProvider: fakeProvider([{ status: 'completed', text: 'done' }]) });
    const result = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'done');
    assert.equal(result.continuationId, undefined);
    assert.equal(runtime.stats().runs, 0, 'a completed step must not allocate a continuation');
  });

  test('requires_action returns a continuationId and the verified calls', async () => {
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{
        status: 'requires_action', text: 'looking',
        toolCalls: [{ id: 'c1', name: 'lookup_items', arguments: { query: 'x' } }],
      }]),
    });
    const result = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    assert.equal(result.status, 'requires_action');
    assert.equal(typeof result.continuationId, 'string');
    assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'lookup_items', arguments: { query: 'x' } }]);
    assert.equal(runtime.stats().runs, 1);
  });

  test('systemInstructions and tools reach the provider unchanged', async () => {
    const calls = [];
    const runtime = createAgentRuntime({ generationProvider: fakeProvider([{ status: 'completed', text: 'x' }], { calls }) });
    await runtime.start({ identity: 'k', input: 'hi', systemInstructions: 'App rules', tools: TOOLS });
    assert.equal(calls[0].systemInstructions, 'App rules');
    assert.equal(calls[0].tools[0].name, 'lookup_items');
    assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'hi' }]);
  });

  test('an invalid tool definition is rejected before the provider is called', async () => {
    const calls = [];
    const runtime = createAgentRuntime({ generationProvider: fakeProvider([{ status: 'completed' }], { calls }) });
    await assert.rejects(
      () => runtime.start({ identity: 'k', input: 'hi', tools: [{ name: 'bad', inputSchema: { type: 'object', properties: { a: { type: 'string', pattern: 'x' } } } }] }),
      (err) => err.code === 'unsupported_schema_keyword',
    );
    assert.equal(calls.length, 0);
  });

  test('rejects missing/oversized input and oversized instructions', async () => {
    const runtime = createAgentRuntime({ generationProvider: fakeProvider([{ status: 'completed' }]) });
    await assert.rejects(() => runtime.start({ identity: 'k', input: '', tools: TOOLS }), (e) => e.code === 'bad_request');
    await assert.rejects(() => runtime.start({ identity: 'k', input: 'x'.repeat(AGENT_RUN_LIMITS.maxInputChars + 1), tools: TOOLS }), (e) => e.code === 'bad_request');
    await assert.rejects(() => runtime.start({
      identity: 'k', input: 'hi', tools: TOOLS,
      systemInstructions: 'x'.repeat(AGENT_RUN_LIMITS.maxInstructionsChars + 1),
    }), (e) => e.code === 'bad_request');
  });

  test('a client may LOWER an operator ceiling but never raise it', async () => {
    const calls = [];
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'x' }], { calls }),
      limits: { maxOutputTokensPerStep: 100 },
    });
    await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS, maxOutputTokens: 9999 });
    assert.equal(calls[0].maxOutputTokens, 100, 'a client must not be able to raise the operator ceiling');

    const calls2 = [];
    const runtime2 = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'x' }], { calls: calls2 }),
      limits: { maxOutputTokensPerStep: 100 },
    });
    await runtime2.start({ identity: 'k', input: 'hi', tools: TOOLS, maxOutputTokens: 50 });
    assert.equal(calls2[0].maxOutputTokens, 50);
  });
});

describe('continue()', () => {
  async function startedRun(script) {
    const calls = [];
    const runtime = createAgentRuntime({ generationProvider: fakeProvider(script, { calls }) });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    return { runtime, started, calls };
  }

  const REQUIRES = {
    status: 'requires_action', text: 'looking',
    toolCalls: [{ id: 'c1', name: 'lookup_items', arguments: { query: 'x' } }],
  };

  test('a full round trip: requires_action -> results -> completed, and the run is freed', async () => {
    const { runtime, started, calls } = await startedRun([REQUIRES, { status: 'completed', text: 'Found it.' }]);
    const result = await runtime.continue({
      identity: 'k', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: { count: 2 } }],
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Found it.');
    assert.equal(result.steps, 2);
    assert.equal(runtime.stats().runs, 0, 'a completed run must free its memory');
    assert.deepEqual(calls[1].messages, [
      { role: 'tool', toolCallId: 'c1', toolName: 'lookup_items', output: { count: 2 } },
    ]);
  });

  test('an executor error result is forwarded as a real error, never a fabricated success', async () => {
    const { runtime, started, calls } = await startedRun([REQUIRES, { status: 'completed', text: 'ok' }]);
    await runtime.continue({
      identity: 'k', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: false, error: { message: 'upstream 500' } }],
    });
    assert.deepEqual(calls[1].messages, [
      { role: 'tool', toolCallId: 'c1', toolName: 'lookup_items', error: { message: 'upstream 500' } },
    ]);
  });

  test('the frozen providerState is threaded to the next step', async () => {
    const { runtime, started, calls } = await startedRun([REQUIRES, { status: 'completed', text: 'ok' }]);
    await runtime.continue({
      identity: 'k', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: {} }],
    });
    assert.deepEqual(calls[1].providerState, { nativeContents: nativeFor(REQUIRES.toolCalls) });
  });

  test('a replayed continuation does not re-run generation', async () => {
    const { runtime, started, calls } = await startedRun([REQUIRES, { status: 'completed', text: 'ok' }]);
    const args = { identity: 'k', continuationId: started.continuationId, toolResults: [{ callId: 'c1', ok: true, output: {} }] };
    await runtime.continue(args);
    const before = calls.length;
    await assert.rejects(() => runtime.continue(args), (err) => err.code === 'run_not_found');
    assert.equal(calls.length, before, 'a replay must never reach the provider again');
  });

  test('a cross-principal continuation is not found and does not generate', async () => {
    const { runtime, started, calls } = await startedRun([REQUIRES, { status: 'completed', text: 'ok' }]);
    const before = calls.length;
    await assert.rejects(() => runtime.continue({
      identity: 'other-key', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: {} }],
    }), (err) => err.code === 'run_not_found');
    assert.equal(calls.length, before);
  });

  test('malformed results are rejected WITHOUT consuming tokens or the run', async () => {
    const { runtime, started, calls } = await startedRun([REQUIRES, { status: 'completed', text: 'ok' }]);
    const before = calls.length;
    for (const bad of [
      [{ callId: 'c1' }],                                    // missing ok
      [{ callId: 'c1', ok: true, error: { x: 1 } }],         // ok:true with an error
      [{ callId: 'c1', ok: false }],                         // ok:false with no error
      [{ ok: true, output: {} }],                            // missing callId
    ]) {
      await assert.rejects(() => runtime.continue({
        identity: 'k', continuationId: started.continuationId, toolResults: bad,
      }), (err) => err.code === 'bad_request');
    }
    assert.equal(calls.length, before, 'no malformed continuation may reach the provider');
    // The run survives — the caller may correct the payload and retry.
    const ok = await runtime.continue({
      identity: 'k', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: {} }],
    });
    assert.equal(ok.status, 'completed');
  });

  test('a partial result set is refused and the run stays usable', async () => {
    const calls = [];
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([
        { status: 'requires_action', toolCalls: [
          { id: 'c1', name: 'lookup_items', arguments: { query: 'a' } },
          { id: 'c2', name: 'lookup_items', arguments: { query: 'b' } },
        ] },
        { status: 'completed', text: 'ok' },
      ], { calls }),
    });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    await assert.rejects(() => runtime.continue({
      identity: 'k', continuationId: started.continuationId, toolResults: [{ callId: 'c1', ok: true, output: {} }],
    }), (err) => err.code === 'results_mismatch');
    assert.equal(calls.length, 1);

    const done = await runtime.continue({
      identity: 'k', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: {} }, { callId: 'c2', ok: true, output: {} }],
    });
    assert.equal(done.status, 'completed');
  });

  test('an oversized tool result is refused and never truncated', async () => {
    const { runtime, started, calls } = await startedRun([REQUIRES, { status: 'completed', text: 'ok' }]);
    const before = calls.length;
    await assert.rejects(() => runtime.continue({
      identity: 'k', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: { blob: 'x'.repeat(AGENT_RUN_LIMITS.maxToolResultBytes + 10) } }],
    }), (err) => err.code === 'tool_result_too_large');
    assert.equal(calls.length, before);
  });

  test('a failed model step closes the run rather than leaving it claimable', async () => {
    const { runtime, started } = await startedRun([REQUIRES, new AgentStepError('safety_refusal', 'refused')]);
    await assert.rejects(() => runtime.continue({
      identity: 'k', continuationId: started.continuationId, toolResults: [{ callId: 'c1', ok: true, output: {} }],
    }), (err) => err.code === 'safety_refusal');
    assert.equal(runtime.stats().runs, 0, 'a failed step must free the run, never leave stale state');
  });
});

describe('aggregate limits', () => {
  test('the model-step ceiling ends a run rather than looping forever', async () => {
    const requires = (n) => ({ status: 'requires_action', toolCalls: [{ id: `c${n}`, name: 'lookup_items', arguments: { query: 'x' } }] });
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([requires(1), requires(2), requires(3)]),
      limits: { maxModelSteps: 2 },
    });
    const s1 = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    const s2 = await runtime.continue({ identity: 'k', continuationId: s1.continuationId, toolResults: [{ callId: 'c1', ok: true, output: {} }] });
    assert.equal(s2.status, 'requires_action');
    await assert.rejects(
      () => runtime.continue({ identity: 'k', continuationId: s2.continuationId, toolResults: [{ callId: 'c2', ok: true, output: {} }] }),
      (err) => err.code === 'run_step_limit_exceeded',
    );
  });

  test('the tool-call ceiling is enforced across the whole run', async () => {
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{
        status: 'requires_action',
        toolCalls: [
          { id: 'a', name: 'lookup_items', arguments: { query: '1' } },
          { id: 'b', name: 'lookup_items', arguments: { query: '2' } },
          { id: 'c', name: 'lookup_items', arguments: { query: '3' } },
        ],
      }]),
      limits: { maxToolCallsPerRun: 2 },
    });
    await assert.rejects(() => runtime.start({ identity: 'k', input: 'hi', tools: TOOLS }),
      (err) => err.code === 'run_tool_call_limit_exceeded');
  });

  test('context_budget_exceeded is reported rather than truncating results', async () => {
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'x' }]),
    });
    await assert.rejects(() => runtime.start({
      identity: 'k', input: 'hi', tools: TOOLS, maxContextTokens: 1,
    }), (err) => err.code === 'context_budget_exceeded');
  });
});

describe('budget ledger integration', () => {
  function fakeBudget({ allow = true, code = 'key_budget_exceeded' } = {}) {
    const reserved = [];
    const reconciled = [];
    return {
      reserved, reconciled,
      reserve(args) {
        reserved.push(args);
        return allow
          ? { ok: true, reservationId: reserved.length, maxOutputTokens: args.maxOutputTokens }
          : { ok: false, code, message: 'denied', retryAfterSeconds: 7 };
      },
      reconcile(id, usage) { reconciled.push({ id, usage }); },
    };
  }

  test('reserve happens BEFORE the provider call; a denial never invokes the provider', async () => {
    const calls = [];
    const budget = fakeBudget({ allow: false });
    const runtime = createAgentRuntime({ generationProvider: fakeProvider([{ status: 'completed' }], { calls }) });
    await assert.rejects(() => runtime.start({ identity: 'k', input: 'hi', tools: TOOLS, budget }),
      (err) => err.code === 'key_budget_exceeded' && err.retryAfterSeconds === 7);
    assert.equal(budget.reserved.length, 1);
    assert.equal(calls.length, 0, 'a denied reservation must never reach the provider');
  });

  test('a successful step reconciles reported usage', async () => {
    const budget = fakeBudget();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'x', usage: { tokensIn: 5, tokensOut: 2 } }]),
    });
    await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS, budget });
    assert.equal(budget.reconciled.length, 1);
    assert.deepEqual(budget.reconciled[0].usage, { tokensIn: 5, tokensOut: 2 });
  });

  test('every model step in a run is reserved — the initial step counts too', async () => {
    const budget = fakeBudget();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([
        { status: 'requires_action', toolCalls: [{ id: 'c1', name: 'lookup_items', arguments: { query: 'x' } }] },
        { status: 'completed', text: 'ok' },
      ]),
    });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS, budget });
    await runtime.continue({
      identity: 'k', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: {} }], budget,
    });
    assert.equal(budget.reserved.length, 2, 'both the initial and the continuation step must be reserved');
  });
});

describe('lifecycle', () => {
  test('close() frees a pending run', async () => {
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'requires_action', toolCalls: [{ id: 'c1', name: 'lookup_items', arguments: { query: 'x' } }] }]),
    });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    assert.equal(runtime.close({ identity: 'k', continuationId: started.continuationId }), true);
    assert.equal(runtime.stats().runs, 0);
  });

  test('an injected store is used (instance isolation, no shared module state)', async () => {
    const store = createContinuationStore();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'requires_action', toolCalls: [{ id: 'c1', name: 'lookup_items', arguments: { query: 'x' } }] }]),
      store,
    });
    await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    assert.equal(store.stats().runs, 1);
  });
});

// -- Pre-release code-review regressions --------------------------------
// Each block below pins a bug that was reproduced against the shipped code.

describe('regression: aggregate run token ceiling is actually enforced', () => {
  const requires = (n) => ({
    status: 'requires_action',
    toolCalls: [{ id: `c${n}`, name: 'lookup_items', arguments: { query: 'x' } }],
  });

  test('a run that exhausts its aggregate token budget is stopped, and the provider is never called again', async () => {
    const calls = [];
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([requires(1), requires(2)], { calls }),
      limits: { maxReservedTokensPerRun: 3000, maxOutputTokensPerStep: 1000 },
    });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    const callsAfterStart = calls.length;

    await assert.rejects(
      () => runtime.continue({
        identity: 'k', continuationId: started.continuationId,
        toolResults: [{ callId: 'c1', ok: true, output: { blob: 'y'.repeat(9000) } }],
      }),
      (err) => err.code === 'run_token_ceiling_exceeded',
    );
    assert.equal(calls.length, callsAfterStart,
      'a run over its aggregate budget must never reach the provider');
  });

  test('a client may lower the aggregate ceiling but never raise it above the operator value', async () => {
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'x' }]),
      limits: { maxReservedTokensPerRun: 5000 },
    });
    await assert.rejects(
      () => runtime.start({ identity: 'k', input: 'hi', tools: TOOLS, maxReservedTokens: 1 }),
      (err) => err.code === 'run_token_ceiling_exceeded',
    );
  });

  test('a per-step context ceiling now has a real production default (was always null)', async () => {
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'x' }]),
      limits: { maxContextTokens: 10 },
    });
    await assert.rejects(
      () => runtime.start({ identity: 'k', input: 'hi', tools: TOOLS }),
      (err) => err.code === 'context_budget_exceeded',
    );
  });
});

describe('regression: the core is provider-neutral (no Gemini shape in the runtime)', () => {
  test('a provider whose opaque state is NOT Gemini-shaped still completes a continuation', async () => {
    // providerState here is deliberately an opaque blob with no
    // nativeContents/parts/functionCall anywhere. The runtime used to
    // recover tool NAMES from that Gemini-specific shape, so this run
    // started fine and then failed every continuation with
    // results_mismatch. Tool names now come from the store's own neutral
    // {id, name} record.
    const calls = [];
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([
        {
          status: 'requires_action',
          toolCalls: [{ id: 'c1', name: 'lookup_items', arguments: { query: 'x' } }],
          providerState: { opaqueVendorBlob: 'AAAA', turn: 1 },
        },
        { status: 'completed', text: 'done' },
      ], { calls }),
    });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    const result = await runtime.continue({
      identity: 'k', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: { ok: true } }],
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(calls[1].messages, [
      { role: 'tool', toolCallId: 'c1', toolName: 'lookup_items', output: { ok: true } },
    ], 'the tool name must be recovered from the neutral pending-call record');
    assert.deepEqual(calls[1].providerState, { opaqueVendorBlob: 'AAAA', turn: 1 },
      'the opaque state is threaded through untouched and never parsed');
  });

  test('a results_mismatch releases the run instead of leaving it wedged IN_FLIGHT', async () => {
    const store = createContinuationStore();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'x' }]),
      store,
    });
    const runId = store.create({
      identity: 'k',
      context: Object.freeze({
        tools: [{ name: 'lookup_items', inputSchema: { type: 'object', properties: {} } }],
        maxModelSteps: 8, maxToolCallsPerRun: 32, maxOutputTokensPerStep: 100,
        maxReservedTokensPerRun: 100000, maxContextTokens: 100000, runSeed: 's',
      }),
      providerState: { opaque: true },
      pendingCalls: [{ id: 'c1', name: 'a_tool_not_in_this_run' }],
      usage: { modelSteps: 1, toolCalls: 1, reservedTokens: 10 },
    });

    await assert.rejects(
      () => runtime.continue({ identity: 'k', continuationId: runId, toolResults: [{ callId: 'c1', ok: true, output: {} }] }),
      (err) => err.code === 'results_mismatch',
    );
    assert.equal(store.stats().runs, 0, 'the run must be released, never left IN_FLIGHT forever');
  });
});

describe('regression: the shared generation gate covers agent mode', () => {
  // Mirrors the REAL createSingleFlightGate() contract, including
  // tryAcquire() — agent mode needs an explicitly-held slot so a `busy`
  // refusal happens before any claim or reservation.
  function countingGate() {
    let busy = false;
    return {
      isBusy: () => busy,
      async run(fn) {
        if (busy) return { ok: false };
        busy = true;
        try {
          return { ok: true, value: await fn() };
        } finally {
          busy = false;
        }
      },
      tryAcquire() {
        if (busy) return null;
        busy = true;
        let released = false;
        return () => { if (!released) { released = true; busy = false; } };
      },
    };
  }

  test('two concurrent starts never run two generations at once', async () => {
    const gate = countingGate();
    let inFlight = 0;
    let observedParallel = 0;
    const provider = {
      name: () => 'fake',
      capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: false, hardOutputCap: true, toolCalling: true }),
      ready: async () => ({ ok: true }),
      generate: async () => ({ text: '' }),
      async agentStep() {
        inFlight += 1;
        observedParallel = Math.max(observedParallel, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { status: 'completed', text: 'ok', toolCalls: [], usage: {}, providerState: {} };
      },
    };
    const runtime = createAgentRuntime({ generationProvider: provider, gate });

    const [a, b] = await Promise.allSettled([
      runtime.start({ identity: 'k', input: 'one', tools: TOOLS }),
      runtime.start({ identity: 'k', input: 'two', tools: TOOLS }),
    ]);

    assert.equal(observedParallel, 1, 'two real generations must never overlap');
    const outcomes = [a, b].map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason.code));
    assert.ok(outcomes.includes('ok'), 'one call must succeed');
    assert.ok(outcomes.includes('busy'), 'the other must be told the gate is held');
  });

  test('the gate is RELEASED while a run waits for tool results', async () => {
    const gate = countingGate();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([
        { status: 'requires_action', toolCalls: [{ id: 'c1', name: 'lookup_items', arguments: { query: 'x' } }] },
        { status: 'completed', text: 'done' },
      ]),
      gate,
    });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    assert.equal(gate.isBusy(), false,
      'a run that may idle for minutes between HTTP requests must not hold a process-wide lock');

    const done = await runtime.continue({
      identity: 'k', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: {} }],
    });
    assert.equal(done.status, 'completed');
    assert.equal(gate.isBusy(), false);
  });

  test('without a gate the runtime still works (gate is optional DI)', async () => {
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'ok' }]),
    });
    const result = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    assert.equal(result.status, 'completed');
  });
});

// -- Second-round code-review regressions -------------------------------
// The gate fix itself introduced these. Each was reproduced first.

describe('regression: a busy refusal is guaranteed-no-work', () => {
  /** A gate whose held/free state the test controls. Mirrors the real contract. */
  function toggleGate(initiallyHeld) {
    let held = initiallyHeld;
    return {
      hold: (v) => { held = v; },
      isBusy: () => held,
      async run(fn) {
        if (held) return { ok: false };
        held = true;
        try { return { ok: true, value: await fn() }; } finally { held = false; }
      },
      tryAcquire() {
        if (held) return null;
        held = true;
        let released = false;
        return () => { if (!released) { released = true; held = false; } };
      },
    };
  }

  function countingBudget() {
    const reserved = [];
    const reconciled = [];
    return {
      reserved,
      reconciled,
      reserve(args) { reserved.push(args); return { ok: true, reservationId: reserved.length, maxOutputTokens: args.maxOutputTokens }; },
      reconcile(id, usage) { reconciled.push({ id, usage }); },
    };
  }

  test('a continuation refused as busy keeps the run alive, so already-executed tool results stay deliverable', async () => {
    // Reproduction: first attempt -> busy, retry after the gate frees ->
    // run_not_found. The tool had ALREADY run; its result could then never
    // be delivered to the model. A refusal must leave the run untouched.
    const gate = toggleGate(false);
    const store = createContinuationStore();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([
        { status: 'requires_action', toolCalls: [{ id: 'c1', name: 'lookup_items', arguments: { query: 'x' } }] },
        { status: 'completed', text: 'delivered' },
      ]),
      store,
      gate,
    });

    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });
    assert.equal(started.status, 'requires_action');

    // The application executes the tool, then races another generation.
    gate.hold(true);
    await assert.rejects(
      () => runtime.continue({
        identity: 'k', continuationId: started.continuationId,
        toolResults: [{ callId: 'c1', ok: true, output: { done: true } }],
      }),
      (err) => err.code === 'busy',
    );
    assert.equal(store.stats().runs, 1, 'a busy refusal must NOT destroy the continuation');

    // Gate frees; the SAME results are delivered on an unchanged retry.
    gate.hold(false);
    const done = await runtime.continue({
      identity: 'k', continuationId: started.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: { done: true } }],
    });
    assert.equal(done.status, 'completed');
    assert.equal(done.text, 'delivered');
  });

  test('a busy refusal spends NO token budget (zero generations must cost zero)', async () => {
    const budget = countingBudget();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'never' }]),
      gate: toggleGate(true),
    });
    await assert.rejects(
      () => runtime.start({ identity: 'k', input: 'hi', tools: TOOLS, budget }),
      (err) => err.code === 'busy',
    );
    assert.equal(budget.reserved.length, 0,
      'the reservation must happen inside the held slot — a refused request runs no generation and must spend nothing');
    assert.equal(budget.reconciled.length, 0);
  });

  test('a busy refusal never reaches the provider and is marked retryable', async () => {
    const calls = [];
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'never' }], { calls }),
      gate: toggleGate(true),
    });
    await assert.rejects(
      () => runtime.start({ identity: 'k', input: 'hi', tools: TOOLS }),
      (err) => err.code === 'busy' && err.retryable === true,
    );
    assert.equal(calls.length, 0);
  });

  test('the slot is released after a completed step, so the next request is not falsely busy', async () => {
    const gate = toggleGate(false);
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([
        { status: 'completed', text: 'one' },
        { status: 'completed', text: 'two' },
      ]),
      gate,
    });
    await runtime.start({ identity: 'k', input: 'a', tools: TOOLS });
    assert.equal(gate.isBusy(), false, 'the slot must be released once the step ends');
    const second = await runtime.start({ identity: 'k', input: 'b', tools: TOOLS });
    assert.equal(second.status, 'completed');
  });

  test('the slot is released even when the model step throws', async () => {
    const gate = toggleGate(false);
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([new AgentStepError('safety_refusal', 'refused')]),
      gate,
    });
    await assert.rejects(() => runtime.start({ identity: 'k', input: 'a', tools: TOOLS }));
    assert.equal(gate.isBusy(), false, 'a thrown step must not leak the generation slot');
  });
});

// -- Third-round regression: a guaranteed-no-work failure must PRESERVE the run --
//
// continue()'s catch closed the run for EVERY failure, including ones raised
// before the model was ever called. Reproduced: continuation ->
// key_budget_exceeded (zero generations) -> budget refills -> retry ->
// run_not_found. The API advertises that denial as retryable, yet there was
// nothing left to retry against and the caller's already-executed tool
// results were stranded permanently.

describe('regression: a pre-generation failure preserves the continuation', () => {
  /** A ledger whose denial the test can switch on and off. */
  function toggleBudget() {
    const state = { deny: false, reserved: [], reconciled: [] };
    return {
      state,
      reserve(args) {
        if (state.deny) {
          return { ok: false, code: 'key_budget_exceeded', message: 'This key has exhausted its token budget.', retryAfterSeconds: 30 };
        }
        state.reserved.push(args);
        return { ok: true, reservationId: state.reserved.length, maxOutputTokens: args.maxOutputTokens };
      },
      reconcile(id, usage) { state.reconciled.push({ id, usage }); },
    };
  }

  const REQUIRES = {
    status: 'requires_action',
    toolCalls: [{ id: 'c1', name: 'lookup_items', arguments: { query: 'x' } }],
  };

  test('key_budget_exceeded -> budget restored -> the SAME id and tool results complete the run', async () => {
    const calls = [];
    const store = createContinuationStore();
    const budget = toggleBudget();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([REQUIRES, { status: 'completed', text: 'delivered' }], { calls }),
      store,
    });

    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS, budget });
    assert.equal(started.status, 'requires_action');
    const callsAfterStart = calls.length;

    // The application executes the tool, then the key's budget runs out.
    budget.state.deny = true;
    const toolResults = [{ callId: 'c1', ok: true, output: { done: true } }];

    await assert.rejects(
      () => runtime.continue({ identity: 'k', continuationId: started.continuationId, toolResults, budget }),
      (err) => err.code === 'key_budget_exceeded' && err.retryable === true,
    );
    assert.equal(calls.length, callsAfterStart, 'a budget denial must never reach the provider');
    assert.equal(store.stats().runs, 1,
      'a denial raised BEFORE the model call must not destroy the continuation');

    // Budget refills; the identical retry succeeds.
    budget.state.deny = false;
    const done = await runtime.continue({
      identity: 'k', continuationId: started.continuationId, toolResults, budget,
    });
    assert.equal(done.status, 'completed');
    assert.equal(done.text, 'delivered');
    assert.deepEqual(calls[1].messages, [
      { role: 'tool', toolCallId: 'c1', toolName: 'lookup_items', output: { done: true } },
    ], 'the already-executed tool results must reach the model unchanged');
  });

  test('the preserved run is claimable again — not left IN_FLIGHT by the denial', async () => {
    const store = createContinuationStore();
    const budget = toggleBudget();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([REQUIRES, { status: 'completed', text: 'ok' }]),
      store,
    });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS, budget });

    budget.state.deny = true;
    await assert.rejects(
      () => runtime.continue({
        identity: 'k', continuationId: started.continuationId,
        toolResults: [{ callId: 'c1', ok: true, output: {} }], budget,
      }),
      (err) => err.code === 'key_budget_exceeded',
    );

    const peeked = store.peek({ runId: started.continuationId, identity: 'k' });
    assert.equal(peeked.status, 'ready', 'the run must return to READY, never stay IN_FLIGHT');
    assert.deepEqual(peeked.pendingCalls, [{ id: 'c1', name: 'lookup_items' }],
      'the pending calls must be unchanged, so the same results still match');
  });

  test('a run-scoped ceiling also preserves the run (the caller may inspect or abandon it)', async () => {
    // run_token_ceiling_exceeded is permanent for the run, but it too is
    // raised before any generation — the run must not vanish mid-request.
    const store = createContinuationStore();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([REQUIRES, { status: 'completed', text: 'ok' }]),
      store,
      limits: { maxReservedTokensPerRun: 3000, maxOutputTokensPerStep: 1000 },
    });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });

    await assert.rejects(
      () => runtime.continue({
        identity: 'k', continuationId: started.continuationId,
        toolResults: [{ callId: 'c1', ok: true, output: { blob: 'y'.repeat(9000) } }],
      }),
      (err) => err.code === 'run_token_ceiling_exceeded',
    );
    assert.equal(store.stats().runs, 1, 'a pre-generation ceiling must not destroy the run');
    assert.equal(store.peek({ runId: started.continuationId, identity: 'k' }).status, 'ready');
  });

  test('a failure AT the model call still closes the run — the fix must not preserve untrustworthy state', async () => {
    const store = createContinuationStore();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([REQUIRES, new AgentStepError('safety_refusal', 'refused')]),
      store,
    });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS });

    await assert.rejects(
      () => runtime.continue({
        identity: 'k', continuationId: started.continuationId,
        toolResults: [{ callId: 'c1', ok: true, output: {} }],
      }),
      (err) => err.code === 'safety_refusal',
    );
    assert.equal(store.stats().runs, 0,
      'once the model has been invoked the provider state is no longer trustworthy — that run must still close');
  });

  test('results_mismatch still closes the run — retrying it could never succeed', async () => {
    const store = createContinuationStore();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([{ status: 'completed', text: 'x' }]),
      store,
    });
    const runId = store.create({
      identity: 'k',
      context: Object.freeze({
        tools: [{ name: 'lookup_items', inputSchema: { type: 'object', properties: {} } }],
        maxModelSteps: 8, maxToolCallsPerRun: 32, maxOutputTokensPerStep: 100,
        maxReservedTokensPerRun: 100000, maxContextTokens: 100000, runSeed: 's',
      }),
      providerState: { opaque: true },
      pendingCalls: [{ id: 'c1', name: 'a_tool_not_in_this_run' }],
      usage: { modelSteps: 1, toolCalls: 1, reservedTokens: 10 },
    });

    await assert.rejects(
      () => runtime.continue({ identity: 'k', continuationId: runId, toolResults: [{ callId: 'c1', ok: true, output: {} }] }),
      (err) => err.code === 'results_mismatch',
    );
    assert.equal(store.stats().runs, 0, 'inconsistent stored state is not worth preserving');
  });

  test('preserving a run does not leak memory accounting', async () => {
    const store = createContinuationStore();
    const budget = toggleBudget();
    const runtime = createAgentRuntime({
      generationProvider: fakeProvider([REQUIRES, { status: 'completed', text: 'ok' }]),
      store,
    });
    const started = await runtime.start({ identity: 'k', input: 'hi', tools: TOOLS, budget });
    const bytesBefore = store.stats().totalBytes;

    budget.state.deny = true;
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => runtime.continue({
        identity: 'k', continuationId: started.continuationId,
        toolResults: [{ callId: 'c1', ok: true, output: {} }], budget,
      }), (err) => err.code === 'key_budget_exceeded');
    }
    assert.equal(store.stats().totalBytes, bytesBefore,
      'repeated denials must not grow or shrink the byte pool');
    assert.equal(store.stats().runs, 1);
  });
});
