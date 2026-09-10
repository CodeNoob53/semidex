// Gemini agentStep() native mapping — offline, against a FAKE @google/genai
// client. Never a real network call. Proves the mapping this adapter is
// responsible for: tool declarations out, function calls in, continuation
// metadata (including thoughtSignature) preserved verbatim, and every
// non-completed terminal state surfacing as a typed error rather than a
// silently "successful" answer.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiAgentStep, toGeminiTools, buildGeminiContents } from '../../../../src/cloud/generation/gemini-agent-step.js';
import { AgentStepError } from '../../../../src/core/generation/agent-step.js';
import { validateToolDefinitions } from '../../../../src/core/agent/tool-schema.js';
import { createGeminiProvider } from '../../../../src/cloud/generation/gemini-provider.js';

const TOOLS = validateToolDefinitions([{
  name: 'lookup_items',
  description: 'Read available items',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
    required: ['query'],
    additionalProperties: false,
  },
}]);

/**
 * Builds an agentStep bound to a fake SDK client. `chunks` is the exact
 * stream the fake `generateContentStream` yields; `captured` receives the
 * request object the adapter built.
 */
function makeStep({ chunks, captured = {}, throwOnCall } = {}) {
  const client = {
    models: {
      async generateContentStream(request) {
        captured.request = request;
        if (throwOnCall) throw throwOnCall;
        async function* gen() { for (const c of chunks) yield c; }
        return gen();
      },
    },
  };
  return createGeminiAgentStep({
    getClient: async () => client,
    apiKey: 'test-key',
    defaultModel: 'gemini-test',
  });
}

function textChunk(text, finishReason = 'STOP') {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason }] };
}

describe('toGeminiTools', () => {
  test('maps neutral tools onto functionDeclarations with parametersJsonSchema', () => {
    const mapped = toGeminiTools(TOOLS);
    assert.equal(mapped.length, 1);
    const decl = mapped[0].functionDeclarations[0];
    assert.equal(decl.name, 'lookup_items');
    assert.equal(decl.description, 'Read available items');
    // parametersJsonSchema (plain JSON Schema), NOT the OpenAPI-flavoured
    // `parameters` — the two are documented as mutually exclusive.
    assert.deepEqual(decl.parametersJsonSchema, TOOLS[0].inputSchema);
    assert.equal(decl.parameters, undefined);
  });
});

describe('buildGeminiContents', () => {
  test('replays prior native contents verbatim and appends the new user turn', () => {
    const prior = { nativeContents: [{ role: 'user', parts: [{ text: 'first' }] }] };
    const contents = buildGeminiContents(prior, [{ role: 'user', content: 'second' }]);
    assert.deepEqual(contents, [
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'user', parts: [{ text: 'second' }] },
    ]);
  });

  test('does not alias the stored providerState (a later mutation cannot corrupt the run)', () => {
    const prior = { nativeContents: [{ role: 'model', parts: [{ text: 'a' }] }] };
    const contents = buildGeminiContents(prior, []);
    contents[0].parts[0].text = 'mutated';
    assert.equal(prior.nativeContents[0].parts[0].text, 'a');
  });

  test('tool results become ONE user turn of functionResponse parts, with output/error keys', () => {
    const contents = buildGeminiContents({ nativeContents: [] }, [
      { role: 'tool', toolCallId: 'c1', toolName: 'lookup_items', output: { items: [1] } },
      { role: 'tool', toolCallId: 'c2', toolName: 'lookup_items', error: { message: 'nope' } },
    ]);
    assert.equal(contents.length, 1);
    assert.equal(contents[0].role, 'user');
    assert.deepEqual(contents[0].parts, [
      { functionResponse: { id: 'c1', name: 'lookup_items', response: { output: { items: [1] } } } },
      // An executor failure is sent as a real `error` result — the model is
      // told the truth, never handed a fabricated success.
      { functionResponse: { id: 'c2', name: 'lookup_items', response: { error: { message: 'nope' } } } },
    ]);
  });
});

describe('agentStep() — completed', () => {
  test('returns status completed with text and usage, and no tool calls', async () => {
    const captured = {};
    const step = makeStep({
      captured,
      chunks: [
        { candidates: [{ content: { parts: [{ text: 'hello ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'world' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 } },
      ],
    });
    const deltas = [];
    const result = await step({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, onText: (d) => { deltas.push(d); } });

    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'hello world');
    assert.deepEqual(deltas, ['hello ', 'world']);
    assert.deepEqual(result.toolCalls, []);
    assert.deepEqual(result.usage, { tokensIn: 11, tokensOut: 4 });
    assert.equal(captured.request.model, 'gemini-test');
    assert.equal(captured.request.config.tools[0].functionDeclarations[0].name, 'lookup_items');
  });

  test('systemInstructions reach config.systemInstruction, never the contents array', async () => {
    const captured = {};
    const step = makeStep({ captured, chunks: [textChunk('ok')] });
    await step({ systemInstructions: 'App rules', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    assert.equal(captured.request.config.systemInstruction, 'App rules');
    assert.ok(!JSON.stringify(captured.request.contents).includes('App rules'),
      'system instructions must never be concatenated into user content');
  });

  test('maxOutputTokens is forwarded as Gemini\'s own hard ceiling', async () => {
    const captured = {};
    const step = makeStep({ captured, chunks: [textChunk('ok')] });
    await step({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, maxOutputTokens: 256 });
    assert.equal(captured.request.config.maxOutputTokens, 256);
  });

  test('a thought part is preserved for continuation but never streamed or returned', async () => {
    const step = makeStep({
      chunks: [{
        candidates: [{
          content: { parts: [{ text: 'internal reasoning', thought: true }, { text: 'visible' }] },
          finishReason: 'STOP',
        }],
      }],
    });
    const deltas = [];
    const result = await step({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, onText: (d) => deltas.push(d) });
    assert.equal(result.text, 'visible');
    assert.deepEqual(deltas, ['visible']);
    const modelTurn = result.providerState.nativeContents.at(-1);
    assert.equal(modelTurn.parts[0].thought, true, 'the thought part must survive in providerState for continuation');
  });
});

describe('agentStep() — requires_action', () => {
  test('returns verified tool calls and preserves thoughtSignature in providerState', async () => {
    const step = makeStep({
      chunks: [{
        candidates: [{
          content: {
            parts: [
              { text: 'let me look' },
              { functionCall: { id: 'gem-1', name: 'lookup_items', args: { query: 'milk' } }, thoughtSignature: 'SIG-ABC' },
            ],
          },
          finishReason: 'STOP',
        }],
      }],
    });
    const result = await step({ messages: [{ role: 'user', content: 'find milk' }], tools: TOOLS });

    assert.equal(result.status, 'requires_action');
    assert.equal(result.text, 'let me look');
    assert.deepEqual(result.toolCalls, [{ id: 'gem-1', name: 'lookup_items', arguments: { query: 'milk' } }]);

    const modelTurn = result.providerState.nativeContents.at(-1);
    assert.equal(modelTurn.role, 'model');
    const fcPart = modelTurn.parts.find((p) => p.functionCall);
    assert.equal(fcPart.thoughtSignature, 'SIG-ABC',
      'thoughtSignature must be captured verbatim — the next request is rebuilt from these native parts, not from {name, args}');
  });

  test('multiple calls in one response keep their order and ids', async () => {
    const step = makeStep({
      chunks: [{
        candidates: [{
          content: {
            parts: [
              { functionCall: { id: 'a', name: 'lookup_items', args: { query: 'one' } } },
              { functionCall: { id: 'b', name: 'lookup_items', args: { query: 'two' } } },
            ],
          },
          finishReason: 'STOP',
        }],
      }],
    });
    const result = await step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
    assert.deepEqual(result.toolCalls.map((c) => [c.id, c.arguments.query]), [['a', 'one'], ['b', 'two']]);
  });

  test('a call with no provider id gets a stable synthetic id, stamped onto the native part too', async () => {
    const step = makeStep({
      chunks: [{
        candidates: [{ content: { parts: [{ functionCall: { name: 'lookup_items', args: { query: 'x' } } }] }, finishReason: 'STOP' }],
      }],
    });
    const result = await step({
      messages: [{ role: 'user', content: 'x' }], tools: TOOLS,
      makeCallId: (i) => `synth_${i}`,
    });
    assert.equal(result.toolCalls[0].id, 'synth_0');
    const fcPart = result.providerState.nativeContents.at(-1).parts.find((p) => p.functionCall);
    assert.equal(fcPart.functionCall.id, 'synth_0',
      'the synthesized id must also be stamped on the native part so the continuation\'s functionResponse matches');
  });

  test('a full round trip: requires_action -> tool result -> completed, replaying native parts', async () => {
    const firstCaptured = {};
    const first = makeStep({
      captured: firstCaptured,
      chunks: [{
        candidates: [{
          content: { parts: [{ functionCall: { id: 'c1', name: 'lookup_items', args: { query: 'milk' } }, thoughtSignature: 'SIG' }] },
          finishReason: 'STOP',
        }],
      }],
    });
    const step1 = await first({ messages: [{ role: 'user', content: 'find milk' }], tools: TOOLS });
    assert.equal(step1.status, 'requires_action');

    const secondCaptured = {};
    const second = makeStep({ captured: secondCaptured, chunks: [textChunk('Found 2 items.')] });
    const step2 = await second({
      messages: [{ role: 'tool', toolCallId: 'c1', toolName: 'lookup_items', output: { count: 2 } }],
      tools: TOOLS,
      providerState: step1.providerState,
    });

    assert.equal(step2.status, 'completed');
    assert.equal(step2.text, 'Found 2 items.');

    const sent = secondCaptured.request.contents;
    assert.equal(sent[0].role, 'user');
    assert.equal(sent[1].role, 'model');
    assert.equal(sent[1].parts[0].thoughtSignature, 'SIG', 'the replayed model turn must carry the original thoughtSignature');
    assert.deepEqual(sent[2].parts[0].functionResponse, { id: 'c1', name: 'lookup_items', response: { output: { count: 2 } } });
  });
});

describe('agentStep() — never a silent success', () => {
  async function expectCode(fn, code) {
    try {
      await fn();
      assert.fail(`expected AgentStepError(${code})`);
    } catch (err) {
      assert.ok(err instanceof AgentStepError, `expected AgentStepError, got ${err?.name}: ${err?.message}`);
      assert.equal(err.code, code, err.message);
    }
  }

  test('a safety finish reason is a typed refusal, not a completed answer', async () => {
    const step = makeStep({ chunks: [{ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'SAFETY' }] }] });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'safety_refusal');
  });

  test('MAX_TOKENS is output_limit_reached, not a completed answer', async () => {
    const step = makeStep({ chunks: [{ candidates: [{ content: { parts: [{ text: 'cut off' }] }, finishReason: 'MAX_TOKENS' }] }] });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'output_limit_reached');
  });

  test('MALFORMED_FUNCTION_CALL surfaces as malformed_tool_call and executes nothing', async () => {
    const step = makeStep({ chunks: [{ candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] }] });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'malformed_tool_call');
  });

  test('a stream that ends with no finish reason is interrupted, not completed', async () => {
    const step = makeStep({ chunks: [{ candidates: [{ content: { parts: [{ text: 'half' }] } }] }] });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'stream_interrupted');
  });

  test('an empty stream is interrupted, not an empty successful answer', async () => {
    const step = makeStep({ chunks: [] });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'stream_interrupted');
  });

  test('a mid-stream throw is interrupted', async () => {
    const client = {
      models: {
        async generateContentStream() {
          async function* gen() {
            yield { candidates: [{ content: { parts: [{ text: 'a' }] } }] };
            throw new Error('socket died');
          }
          return gen();
        },
      },
    };
    const step = createGeminiAgentStep({ getClient: async () => client, apiKey: 'k', defaultModel: 'm' });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'stream_interrupted');
  });

  test('a tool name outside the allowlist is refused — nothing is executed', async () => {
    const step = makeStep({
      chunks: [{ candidates: [{ content: { parts: [{ functionCall: { id: 'x', name: 'delete_everything', args: {} } }] }, finishReason: 'STOP' }] }],
    });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'unknown_tool');
  });

  test('arguments that violate the declared schema are refused before any executor sees them', async () => {
    const step = makeStep({
      chunks: [{ candidates: [{ content: { parts: [{ functionCall: { id: 'x', name: 'lookup_items', args: { limit: 3 } } }] }, finishReason: 'STOP' }] }],
    });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'invalid_tool_arguments');
  });

  test('an undeclared extra argument is refused (additionalProperties: false)', async () => {
    const step = makeStep({
      chunks: [{ candidates: [{ content: { parts: [{ functionCall: { id: 'x', name: 'lookup_items', args: { query: 'a', evil: 1 } } }] }, finishReason: 'STOP' }] }],
    });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'invalid_tool_arguments');
  });

  test('a partial (still-streaming) tool call is never executable', async () => {
    const step = makeStep({
      chunks: [{
        candidates: [{
          content: { parts: [{ functionCall: { id: 'x', name: 'lookup_items', args: { query: 'a' }, willContinue: true } }] },
          finishReason: 'STOP',
        }],
      }],
    });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'malformed_tool_call');
  });

  // ── Regression: terminal-state ALLOWLIST (pre-release code review) ──
  // A deny-list treated "not known-bad" as "good". Two consequences, both
  // fixed by requiring an allowlisted finish reason before ANY result is
  // built — text and tool-call responses alike.

  test('a functionCall arriving with NO finishReason is NOT executable (regression: unfinished stream yielded a tool call)', async () => {
    const step = makeStep({
      chunks: [{ candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'lookup_items', args: { query: 'x' } } }] } }] }],
    });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'stream_interrupted');
  });

  test('finishReason OTHER is not a completed answer (regression: fell through the deny-list)', async () => {
    const step = makeStep({ chunks: [{ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'OTHER' }] }] });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'stream_interrupted');
  });

  test('an unrecognized future finish reason fails closed rather than becoming a success', async () => {
    const step = makeStep({ chunks: [{ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SOME_FUTURE_REASON' }] }] });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'stream_interrupted');
  });

  test('FINISH_REASON_UNSPECIFIED is not a success', async () => {
    const step = makeStep({ chunks: [{ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'FINISH_REASON_UNSPECIFIED' }] }] });
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }), 'stream_interrupted');
  });

  test('an already-aborted signal fails before the provider is called at all', async () => {
    const captured = {};
    const step = makeStep({ captured, chunks: [textChunk('never')] });
    const controller = new AbortController();
    controller.abort();
    await expectCode(() => step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, signal: controller.signal }), 'stream_interrupted');
    assert.equal(captured.request, undefined, 'no provider request may be issued for an already-aborted step');
  });

  test('a provider construction failure is a typed provider_error with the API key redacted', async () => {
    const step = makeStep({ chunks: [], throwOnCall: new Error('bad request with key test-key inside') });
    try {
      await step({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
      assert.fail('expected AgentStepError');
    } catch (err) {
      assert.equal(err.code, 'provider_error');
      assert.ok(!err.message.includes('test-key'), 'the API key must never appear in an error message');
      assert.match(err.message, /\[REDACTED\]/);
    }
  });
});

describe('provider integration', () => {
  test('createGeminiProvider exposes agentStep and declares toolCalling', () => {
    const provider = createGeminiProvider({ apiKey: 'k', createClientFn: () => ({ models: {} }) });
    assert.equal(typeof provider.agentStep, 'function');
    assert.equal(provider.capabilities().toolCalling, true);
  });
});
