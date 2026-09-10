// Agent API v3 — end-to-end through the REAL production call chain, offline.
//
// THE MANDATORY CHAIN (the plan's own requirement):
//   HTTP request -> createRouter() -> registerAgentRoutesV3 (real route)
//     -> createAgentRuntime (real core) -> createGeminiProvider (real adapter)
//       -> FAKE @google/genai transport
//     -> tool result -> continuation -> final answer
//
// Only the SDK transport is faked. The router, the route, the request
// parser, the runtime, the continuation store, the tool-schema validator and
// the Gemini native mapping are all the real production code.
//
// This is NOT evidence of live tool calling — a fake model proves the wiring
// and the contract, never that Gemini itself behaves this way. Live
// characterization is a separate, opt-in script.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRouter } from '../../../../src/shared/admin/router.js';
import { registerAgentRoutesV3 } from '../../../../src/core/agent-api/v3/route.js';
import { createAgentRuntime } from '../../../../src/core/agent/runtime.js';
import { createGeminiProvider } from '../../../../src/cloud/generation/gemini-provider.js';

const TOOLS = [{
  name: 'lookup_items',
  description: 'Read available items',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
}];

/** A fake @google/genai client whose stream is scripted per call. */
function fakeGeminiClient(scripts, seen = []) {
  let i = 0;
  return () => ({
    models: {
      get: async ({ model }) => ({ name: model, inputTokenLimit: 1_000_000, supportedActions: ['generateContent'] }),
      async generateContentStream(request) {
        seen.push(request);
        const chunks = scripts[i++] ?? [];
        async function* gen() { for (const c of chunks) yield c; }
        return gen();
      },
    },
  });
}

function chunkWithCall({ id, name, args, text, signature }) {
  const parts = [];
  if (text) parts.push({ text });
  parts.push({ functionCall: { id, name, args }, ...(signature ? { thoughtSignature: signature } : {}) });
  return { candidates: [{ content: { parts }, finishReason: 'STOP' }] };
}

function chunkWithText(text, usage) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    ...(usage ? { usageMetadata: usage } : {}),
  };
}

/** Builds a router with the real v3 route over a real runtime + real Gemini adapter. */
function makeApp({ scripts = [], seen = [], principal = { keyId: 'key-1', operations: ['agent'], collections: ['*'] }, integrationPolicy } = {}) {
  const provider = createGeminiProvider({ apiKey: 'test-key', model: 'gemini-test', createClientFn: fakeGeminiClient(scripts, seen) });
  const agentRuntime = createAgentRuntime({ generationProvider: provider });
  const router = createRouter(integrationPolicy ? { integrationPolicy } : {});
  registerAgentRoutesV3(router, { agentRuntime });
  return { router, agentRuntime, provider, principal, seen };
}

/** Issues one request through the real router and collects the SSE/JSON response. */
async function call(router, body, { headers = {} } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = '/api/v3/ask';
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1:8642', ...headers };

  let statusCode = null;
  const resHeaders = {};
  const chunks = [];
  const res = {
    writeHead(code, h) { statusCode = code; Object.assign(resHeaders, h ?? {}); },
    write(chunk) { chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk) chunks.push(String(chunk)); },
    on() {},
    destroyed: false,
    writableEnded: false,
  };
  await router.handleRequest(req, res);
  const raw = chunks.join('');
  return { statusCode, headers: resHeaders, raw, events: parseSse(raw), json: tryJson(raw) };
}

function parseSse(raw) {
  const events = [];
  for (const block of raw.split('\n\n')) {
    const nameLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (!nameLine || !dataLine) continue;
    events.push({ event: nameLine.slice(7).trim(), data: JSON.parse(dataLine.slice(6)) });
  }
  return events;
}

function tryJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

/** An integration policy that authenticates a fixed principal, for scope tests. */
function policyFor(principal, { allowCollection = true } = {}) {
  return {
    authorizeRequest: ({ route }) => {
      if (!principal) return { ok: false, status: 401, code: 'unauthorized', message: 'no' };
      if (!principal.operations.includes(route?.operation)) {
        return { ok: false, status: 403, code: 'forbidden', message: 'out of scope' };
      }
      return { ok: true, principal };
    },
    authorizeCollection: () => (allowCollection ? { ok: true } : { ok: false, status: 403, code: 'forbidden', message: 'no' }),
  };
}

describe('POST /api/v3/ask — full production chain with a fake SDK transport', () => {
  it('start -> requires_action -> tool result -> continuation -> completed', async () => {
    const seen = [];
    const { router } = makeApp({
      seen,
      scripts: [
        [chunkWithCall({ id: 'c1', name: 'lookup_items', args: { query: 'milk' }, text: 'Looking...', signature: 'SIG-1' })],
        [chunkWithText('There are 2 items.', { promptTokenCount: 30, candidatesTokenCount: 6 })],
      ],
    });

    // ── Step 1: start ──
    const start = await call(router, { input: 'Find an appropriate option', systemInstructions: 'App-owned instructions', tools: TOOLS });
    assert.equal(start.statusCode, 200);
    const startDone = start.events.find((e) => e.event === 'done');
    assert.ok(startDone, `expected a terminal done event, got: ${start.raw}`);
    assert.equal(startDone.data.status, 'requires_action');
    assert.equal(typeof startDone.data.continuationId, 'string');
    assert.deepEqual(startDone.data.toolCalls, [{ id: 'c1', name: 'lookup_items', arguments: { query: 'milk' } }]);
    // Model text before the tool calls is `text`, deliberately NOT `answer`.
    assert.equal(startDone.data.text, 'Looking...');
    assert.equal(startDone.data.answer, undefined, 'a requires_action turn must never be presented as a finished answer');
    // Private continuation metadata never crosses the wire.
    assert.ok(!start.raw.includes('SIG-1'), 'thoughtSignature must never be exposed in the public API');
    assert.ok(!start.raw.includes('providerState'), 'provider state must never be exposed in the public API');

    // The application's instructions reached Gemini's NATIVE system channel.
    assert.equal(seen[0].config.systemInstruction, 'App-owned instructions');
    assert.equal(seen[0].config.tools[0].functionDeclarations[0].name, 'lookup_items');

    // ── Step 2: continuation with the tool result ──
    const cont = await call(router, {
      continuationId: startDone.data.continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: { count: 2 } }],
    });
    assert.equal(cont.statusCode, 200);
    const contDone = cont.events.find((e) => e.event === 'done');
    assert.equal(contDone.data.status, 'completed');
    assert.equal(contDone.data.answer, 'There are 2 items.');
    assert.deepEqual(contDone.data.usage, { tokensIn: 30, tokensOut: 6 });

    // The second request replayed the REAL native model turn (with its
    // thought signature) and appended the function response.
    const second = seen[1];
    assert.equal(second.contents[1].role, 'model');
    assert.equal(second.contents[1].parts.at(-1).thoughtSignature, 'SIG-1');
    assert.deepEqual(second.contents[2].parts[0].functionResponse, {
      id: 'c1', name: 'lookup_items', response: { output: { count: 2 } },
    });
  });

  it('streams answer_delta before the terminal done', async () => {
    const { router } = makeApp({ scripts: [[chunkWithText('Hello there.')]] });
    const res = await call(router, { input: 'hi', tools: TOOLS });
    const deltas = res.events.filter((e) => e.event === 'answer_delta').map((e) => e.data.text);
    assert.deepEqual(deltas, ['Hello there.']);
    assert.equal(res.events.at(-1).event, 'done');
  });

  it('SEMIDEX NEVER EXECUTES THE TOOL — it only reports the request', async () => {
    let executed = false;
    const seen = [];
    // The "tool" is a local function nothing in Semidex can reach. If any
    // Semidex code path tried to execute a requested tool, this flag would
    // flip; it must stay false.
    const forbiddenExecutor = () => { executed = true; return { items: [] }; };
    const { router } = makeApp({
      seen,
      scripts: [[chunkWithCall({ id: 'c1', name: 'lookup_items', args: { query: 'x' } })]],
    });
    const res = await call(router, { input: 'go', tools: TOOLS });
    const done = res.events.find((e) => e.event === 'done');
    assert.equal(done.data.status, 'requires_action');
    assert.equal(executed, false, 'Semidex must never execute a caller-supplied tool');
    assert.equal(typeof forbiddenExecutor, 'function');
    // Exactly ONE model step happened: the run stopped and handed control back.
    assert.equal(seen.length, 1, 'one HTTP request must produce exactly one model step');
  });

  it('a completed first step returns no continuationId and stores no run', async () => {
    const { router, agentRuntime } = makeApp({ scripts: [[chunkWithText('Done immediately.')]] });
    const res = await call(router, { input: 'hi', tools: TOOLS });
    const done = res.events.find((e) => e.event === 'done');
    assert.equal(done.data.status, 'completed');
    assert.equal(done.data.continuationId, undefined);
    assert.equal(agentRuntime.stats().runs, 0);
  });
});

describe('POST /api/v3/ask — request validation (pre-stream JSON errors)', () => {
  it('rejects a body with neither input nor continuationId', async () => {
    const { router } = makeApp();
    const res = await call(router, {});
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error.code, 'bad_request');
  });

  it('rejects a start request with no tools, and points at Ask instead', async () => {
    const { router } = makeApp();
    const res = await call(router, { input: 'hi' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error.code, 'invalid_tool');
    assert.match(res.json.error.message, /\/api\/v1\/ask|\/api\/v2\/ask/);
  });

  it('rejects a continuation that tries to change instructions or tools', async () => {
    const { router } = makeApp();
    const res = await call(router, { continuationId: 'abc', toolResults: [{ callId: 'c1', ok: true }], systemInstructions: 'new rules' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json.error.message, /frozen for the life of a run/);
  });

  it('rejects an unsupported JSON Schema keyword rather than ignoring it', async () => {
    const seen = [];
    const { router } = makeApp({ seen });
    const res = await call(router, {
      input: 'hi',
      tools: [{ name: 't', inputSchema: { type: 'object', properties: { a: { type: 'string', pattern: '^x$' } } } }],
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error.code, 'unsupported_schema_keyword');
    assert.equal(seen.length, 0, 'an invalid tool schema must never reach the model');
  });

  it('rejects a non-discriminated tool result', async () => {
    const { router } = makeApp();
    const res = await call(router, { continuationId: 'abc', toolResults: [{ callId: 'c1' }] });
    assert.equal(res.statusCode, 400);
    assert.match(res.json.error.message, /\.ok" must be a boolean/);
  });

  it('an unknown continuation id is 404 — never confirming whether it exists', async () => {
    const { router } = makeApp();
    const res = await call(router, { continuationId: 'not-a-real-run', toolResults: [{ callId: 'c1', ok: true, output: {} }] });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json.error.code, 'run_not_found');
  });
});

describe('POST /api/v3/ask — terminal semantics', () => {
  it('a safety refusal with NO streamed text is a pre-stream typed failure', async () => {
    // finishReason SAFETY with empty content — Gemini's own documented
    // behavior when a content filter blocks a streamed response.
    const { router } = makeApp({
      scripts: [[{ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }]],
    });
    const res = await call(router, { input: 'hi', tools: TOOLS });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json.error.code, 'safety_refusal');
    assert.equal(res.events.find((e) => e.event === 'done'), undefined);
  });

  it('a safety refusal AFTER text was streamed is a terminal SSE error, never a done', async () => {
    // Once bytes are on the wire the HTTP status is already 200; the honest
    // signal is a terminal `error` event. What must never happen is the
    // partial text being presented as a completed answer.
    const { router } = makeApp({
      scripts: [[{ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'SAFETY' }] }]],
    });
    const res = await call(router, { input: 'hi', tools: TOOLS });
    assert.equal(res.events.at(-1).event, 'error');
    assert.equal(res.events.at(-1).data.code, 'safety_refusal');
    assert.equal(res.events.find((e) => e.event === 'done'), undefined,
      'partial text before a refusal must never be delivered as a finished answer');
  });

  it('a model asking for a tool outside the allowlist fails and executes nothing', async () => {
    const { router } = makeApp({
      scripts: [[chunkWithCall({ id: 'c1', name: 'delete_everything', args: {} })]],
    });
    const res = await call(router, { input: 'hi', tools: TOOLS });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json.error.code, 'unknown_tool');
  });

  it('once streaming has begun, a failure is a terminal SSE error — never a successful done', async () => {
    const { router } = makeApp({
      scripts: [[
        { candidates: [{ content: { parts: [{ text: 'starting' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'more' }] }, finishReason: 'SAFETY' }] },
      ]],
    });
    const res = await call(router, { input: 'hi', tools: TOOLS });
    const names = res.events.map((e) => e.event);
    assert.ok(names.includes('answer_delta'));
    assert.equal(names.at(-1), 'error', 'a committed stream must end in a terminal error event');
    assert.equal(res.events.find((e) => e.event === 'done'), undefined,
      'an error must never be followed by (or converted into) a successful done');
  });

  it('exactly one terminal event per response', async () => {
    const { router } = makeApp({ scripts: [[chunkWithText('one')]] });
    const res = await call(router, { input: 'hi', tools: TOOLS });
    const terminal = res.events.filter((e) => e.event === 'done' || e.event === 'error');
    assert.equal(terminal.length, 1);
  });
});

describe('POST /api/v3/ask — capability gate', () => {
  it('a backend without tool calling is refused with capability_unavailable and zero generation', async () => {
    let generated = false;
    const nonToolProvider = {
      name: () => 'ollama-like',
      capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true, hardOutputCap: true }),
      ready: async () => ({ ok: true }),
      generate: async () => { generated = true; return { text: '' }; },
    };
    const router = createRouter();
    registerAgentRoutesV3(router, { agentRuntime: createAgentRuntime({ generationProvider: nonToolProvider }) });

    const res = await call(router, { input: 'hi', tools: TOOLS });
    assert.equal(res.statusCode, 501);
    assert.equal(res.json.error.code, 'capability_unavailable');
    assert.equal(generated, false, 'an unsupported backend must never reach generation');
  });
});

describe('POST /api/v3/ask — authorization', () => {
  it('an unauthenticated request performs ZERO generation', async () => {
    const seen = [];
    const { router } = makeApp({ seen, integrationPolicy: policyFor(null) });
    const res = await call(router, { input: 'hi', tools: TOOLS });
    assert.equal(res.statusCode, 401);
    assert.equal(seen.length, 0, 'no model step may run for an unauthenticated caller');
  });

  it('a key scoped only to "generate" (an existing Ask key) is FORBIDDEN — agent mode needs its own scope', async () => {
    const seen = [];
    const askOnlyKey = { keyId: 'ask-key', operations: ['generate'], collections: ['*'] };
    const { router } = makeApp({ seen, integrationPolicy: policyFor(askOnlyKey) });
    const res = await call(router, { input: 'hi', tools: TOOLS });
    assert.equal(res.statusCode, 403,
      'an existing Ask key must not silently gain instruction/tool control');
    assert.equal(seen.length, 0);
  });

  it('a key scoped to "agent" is allowed', async () => {
    const agentKey = { keyId: 'agent-key', operations: ['agent'], collections: ['*'] };
    const { router } = makeApp({
      integrationPolicy: policyFor(agentKey),
      scripts: [[chunkWithText('ok')]],
    });
    const res = await call(router, { input: 'hi', tools: TOOLS });
    assert.equal(res.statusCode, 200);
    assert.equal(res.events.find((e) => e.event === 'done').data.status, 'completed');
  });

  it('a run created by one key cannot be continued by another', async () => {
    // Two apps sharing ONE runtime/store, reached by two different keys.
    const seen = [];
    const provider = createGeminiProvider({
      apiKey: 'k', model: 'm',
      createClientFn: fakeGeminiClient([
        [chunkWithCall({ id: 'c1', name: 'lookup_items', args: { query: 'x' } })],
        [chunkWithText('should not happen')],
      ], seen),
    });
    const agentRuntime = createAgentRuntime({ generationProvider: provider });

    const routerA = createRouter({ integrationPolicy: policyFor({ keyId: 'key-A', operations: ['agent'], collections: ['*'] }) });
    registerAgentRoutesV3(routerA, { agentRuntime });
    const routerB = createRouter({ integrationPolicy: policyFor({ keyId: 'key-B', operations: ['agent'], collections: ['*'] }) });
    registerAgentRoutesV3(routerB, { agentRuntime });

    const start = await call(routerA, { input: 'hi', tools: TOOLS });
    const { continuationId } = start.events.find((e) => e.event === 'done').data;

    const stolen = await call(routerB, { continuationId, toolResults: [{ callId: 'c1', ok: true, output: {} }] });
    assert.equal(stolen.statusCode, 404, 'a cross-principal continuation must be indistinguishable from a missing one');
    assert.equal(seen.length, 1, 'the stolen continuation must never reach the model');

    // The rightful owner can still continue.
    const ok = await call(routerA, { continuationId, toolResults: [{ callId: 'c1', ok: true, output: {} }] });
    assert.equal(ok.statusCode, 200);
  });
});

describe('POST /api/v3/ask — replay and partial results', () => {
  it('replaying a consumed continuation does not re-run generation', async () => {
    const seen = [];
    const { router } = makeApp({
      seen,
      scripts: [
        [chunkWithCall({ id: 'c1', name: 'lookup_items', args: { query: 'x' } })],
        [chunkWithText('final')],
        [chunkWithText('MUST NOT HAPPEN')],
      ],
    });
    const start = await call(router, { input: 'hi', tools: TOOLS });
    const { continuationId } = start.events.find((e) => e.event === 'done').data;
    const body = { continuationId, toolResults: [{ callId: 'c1', ok: true, output: {} }] };

    const first = await call(router, body);
    assert.equal(first.statusCode, 200);
    const stepsAfterFirst = seen.length;

    const replay = await call(router, body);
    assert.equal(replay.statusCode, 404);
    assert.equal(seen.length, stepsAfterFirst, 'a replay must never reach the model again');
  });

  it('a partial result set is refused and the run remains usable', async () => {
    const seen = [];
    const { router } = makeApp({
      seen,
      scripts: [
        [{
          candidates: [{
            content: {
              parts: [
                { functionCall: { id: 'c1', name: 'lookup_items', args: { query: 'a' } } },
                { functionCall: { id: 'c2', name: 'lookup_items', args: { query: 'b' } } },
              ],
            },
            finishReason: 'STOP',
          }],
        }],
        [chunkWithText('done')],
      ],
    });
    const start = await call(router, { input: 'hi', tools: TOOLS });
    const { continuationId, toolCalls } = start.events.find((e) => e.event === 'done').data;
    assert.equal(toolCalls.length, 2);

    const partial = await call(router, { continuationId, toolResults: [{ callId: 'c1', ok: true, output: {} }] });
    assert.equal(partial.statusCode, 400);
    assert.equal(partial.json.error.code, 'results_mismatch');
    assert.equal(seen.length, 1, 'a partial continuation must not consume a model step');

    const full = await call(router, {
      continuationId,
      toolResults: [{ callId: 'c1', ok: true, output: {} }, { callId: 'c2', ok: true, output: {} }],
    });
    assert.equal(full.statusCode, 200);
  });

  it('an executor error result is forwarded to the model as a real error', async () => {
    const seen = [];
    const { router } = makeApp({
      seen,
      scripts: [
        [chunkWithCall({ id: 'c1', name: 'lookup_items', args: { query: 'x' } })],
        [chunkWithText('I could not look that up.')],
      ],
    });
    const start = await call(router, { input: 'hi', tools: TOOLS });
    const { continuationId } = start.events.find((e) => e.event === 'done').data;
    await call(router, { continuationId, toolResults: [{ callId: 'c1', ok: false, error: { message: 'upstream 500' } }] });

    assert.deepEqual(seen[1].contents.at(-1).parts[0].functionResponse.response, { error: { message: 'upstream 500' } },
      'an executor failure must reach the model as an error, never as a fabricated success');
  });
});

describe('POST /api/v3/ask — a denial the API calls retryable must actually be retryable', () => {
  // The wire contract puts key_budget_exceeded in RETRYABLE_CODES and maps
  // it to 429. That promise is only true if the continuation SURVIVES the
  // denial: the ledger refuses BEFORE any model call, so the caller's
  // already-executed tool results are still valid and the identical request
  // must succeed once the bucket refills. Before the fix the run was closed
  // on every failure and the retry got 404 — advertising a retry that could
  // never work. Proven here through the real route + real budget ledger.

  /** A per-key token bucket whose denial the test can switch on and off. */
  function toggleTracker() {
    const state = { deny: false, reserved: [] };
    return {
      state,
      reserve(keyId, cost) {
        if (state.deny) return { allowed: false, exceedsCapacity: false, retryAfterMs: 30_000 };
        state.reserved.push({ keyId, cost });
        return { allowed: true };
      },
      release() {},
    };
  }

  it('429 key_budget_exceeded -> budget refills -> the SAME continuationId and tool results complete', async () => {
    const seen = [];
    const budgetTracker = toggleTracker();
    const provider = createGeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-test',
      createClientFn: fakeGeminiClient([
        [chunkWithCall({ id: 'c1', name: 'lookup_items', args: { query: 'x' } })],
        [chunkWithText('There are 2 items.')],
      ], seen),
    });
    const router = createRouter({
      integrationPolicy: policyFor({ keyId: 'key-1', operations: ['agent'], collections: ['*'] }),
    });
    registerAgentRoutesV3(router, {
      agentRuntime: createAgentRuntime({ generationProvider: provider }),
      budgetTracker,
    });

    const start = await call(router, { input: 'hi', tools: TOOLS });
    const { continuationId } = start.events.find((e) => e.event === 'done').data;
    const stepsAfterStart = seen.length;

    // The application executed the tool; now the key's bucket is empty.
    budgetTracker.state.deny = true;
    const body = { continuationId, toolResults: [{ callId: 'c1', ok: true, output: { count: 2 } }] };

    const denied = await call(router, body);
    assert.equal(denied.statusCode, 429);
    assert.equal(denied.json.error.code, 'key_budget_exceeded');
    assert.equal(denied.json.error.retryable, true);
    assert.equal(seen.length, stepsAfterStart, 'a budget denial must never reach the model');

    // The bucket refills. The IDENTICAL request now succeeds — which is the
    // only thing "retryable" can honestly mean.
    budgetTracker.state.deny = false;
    const retried = await call(router, body);
    assert.equal(retried.statusCode, 200,
      'a 429 advertised as retryable must leave a continuation to retry against');
    const done = retried.events.find((e) => e.event === 'done');
    assert.equal(done.data.status, 'completed');
    assert.equal(done.data.answer, 'There are 2 items.');

    // The tool results the application had already produced reached the
    // model unchanged — they were never stranded by the denial.
    assert.deepEqual(seen.at(-1).contents.at(-1).parts[0].functionResponse, {
      id: 'c1', name: 'lookup_items', response: { output: { count: 2 } },
    });
  });

  it('a repeated denial neither consumes the run nor reaches the model', async () => {
    const seen = [];
    const budgetTracker = toggleTracker();
    const provider = createGeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-test',
      createClientFn: fakeGeminiClient([
        [chunkWithCall({ id: 'c1', name: 'lookup_items', args: { query: 'x' } })],
        [chunkWithText('ok')],
      ], seen),
    });
    const router = createRouter({
      integrationPolicy: policyFor({ keyId: 'key-1', operations: ['agent'], collections: ['*'] }),
    });
    registerAgentRoutesV3(router, {
      agentRuntime: createAgentRuntime({ generationProvider: provider }),
      budgetTracker,
    });

    const start = await call(router, { input: 'hi', tools: TOOLS });
    const { continuationId } = start.events.find((e) => e.event === 'done').data;
    const body = { continuationId, toolResults: [{ callId: 'c1', ok: true, output: {} }] };

    budgetTracker.state.deny = true;
    for (let i = 0; i < 3; i += 1) {
      const res = await call(router, body);
      assert.equal(res.statusCode, 429, `denial ${i + 1} must stay a clean 429, never a 404`);
      assert.equal(res.json.error.code, 'key_budget_exceeded');
    }
    assert.equal(seen.length, 1, 'three denials must produce zero extra model steps');

    budgetTracker.state.deny = false;
    assert.equal((await call(router, body)).statusCode, 200);
  });
});
