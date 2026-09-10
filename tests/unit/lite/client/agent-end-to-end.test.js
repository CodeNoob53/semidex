// End-to-end proof for agent mode over REAL HTTP: the packaged client's
// askAgent()/agentStep() against the REAL POST /api/v3/ask route registered
// by createLiteApp(), with the REAL agent runtime, the REAL continuation
// store and the REAL Gemini adapter. Only the @google/genai transport is a
// fake, and a real temp key store enforces real scopes.
//
// This exercises the chain the implementation plan calls mandatory:
//   HTTP client -> route -> core runtime -> Gemini adapter (fake SDK)
//   -> tool result -> continuation -> final answer
//
// A fake model is NOT evidence of live tool calling. It proves the wiring
// and the contract; live characterization is a separate, opt-in script.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createLiteApp } from '../../../../src/admin/composition/lite.js';
import { createJobRegistry } from '../../../../src/shared/admin/jobs/registry.js';
import { createKeyStore } from '../../../../src/core/auth/key-store.js';
import { createIntegrationPolicy } from '../../../../src/core/auth/integration-policy.js';
import { createRateLimiter } from '../../../../src/core/auth/rate-limiter.js';
import { createAgentRuntime } from '../../../../src/core/agent/runtime.js';
import { createGeminiProvider } from '../../../../src/cloud/generation/gemini-provider.js';
import { createSemidexClient, SemidexApiError } from '../../../../packages/lite/lite-src/client/index.js';

const TOOLS = [{
  name: 'lookup_items',
  description: 'Look up available items. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
    required: ['query'],
    additionalProperties: false,
  },
}];

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

function fakeGeminiClient(scripts, seen) {
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

const callChunk = ({ id, name, args, text }) => ({
  candidates: [{
    content: { parts: [...(text ? [{ text }] : []), { functionCall: { id, name, args } }] },
    finishReason: 'STOP',
  }],
});
const textChunk = (text, usage) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  ...(usage ? { usageMetadata: usage } : {}),
});

let dir;
let keyPath;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-agent-e2e-')); keyPath = join(dir, 'integration-keys.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * Boots a real Lite app whose agent runtime is backed by the real Gemini
 * adapter over a fake SDK transport.
 * @param {{ scripts: Array, operations?: string[] }} opts
 */
async function withAgentServer({ scripts = [], operations = ['agent'] }, fn) {
  const seen = [];
  const keyStore = createKeyStore({ path: keyPath });
  const { token } = keyStore.createKey({ name: 'agent-e2e', collections: ['docs-a'], operations });

  const provider = createGeminiProvider({
    apiKey: 'test-key', model: 'gemini-test',
    createClientFn: fakeGeminiClient(scripts, seen),
  });
  const agentRuntime = createAgentRuntime({ generationProvider: provider });

  const adapter = {
    name: () => 'stub',
    capabilities: () => ({ namedVectors: true, sparseVectors: true, hybridSearch: true }),
    ping: async () => ({ ok: true }),
    listCollections: async () => [],
    getCollection: async (name) => (name === 'docs-a' ? { name, pointCount: 5 } : null),
    getEmbeddingProfile: async () => ({ state: 'missing' }),
    getChunk: async () => [],
    searchHybridVectors: async () => [],
  };

  const app = createLiteApp({
    adapter,
    embedQuery: async () => ({ dense: [0.1], sparse: { indices: [1], values: [0.5] } }),
    jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
    agentRuntime,
    integrationPolicy: createIntegrationPolicy({ keyStore, rateLimiter: createRateLimiter(), logger: { warn() {}, error() {} } }),
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    await fn({ base: `http://127.0.0.1:${app.address().port}`, token, seen, agentRuntime });
  } finally {
    await new Promise((r) => app.close(r));
  }
}

describe('packaged client <-> real POST /api/v3/ask', () => {
  it('agentStep(): start -> requires_action -> tool result -> continuation -> completed', async () => {
    const scripts = [
      [callChunk({ id: 'c1', name: 'lookup_items', args: { query: 'milk' }, text: 'Looking...' })],
      [textChunk('There are 2 milk options.', { promptTokenCount: 40, candidatesTokenCount: 8 })],
    ];
    await withAgentServer({ scripts }, async ({ base, token, seen }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });

      const first = await client.agentStep({
        input: 'Find an appropriate milk option',
        systemInstructions: 'Be concise.',
        tools: TOOLS,
      });
      assert.equal(first.status, 'requires_action');
      assert.equal(typeof first.continuationId, 'string');
      assert.deepEqual(first.toolCalls, [{ id: 'c1', name: 'lookup_items', arguments: { query: 'milk' } }]);
      assert.equal(first.text, 'Looking...');
      assert.equal(first.answer, undefined, 'a requires_action step must not expose an "answer"');

      // THE APPLICATION executes the tool — Semidex never does.
      const output = { items: ['oat milk', 'whole milk'], count: 2 };

      const second = await client.agentStep({
        continuationId: first.continuationId,
        toolResults: [{ callId: 'c1', ok: true, output }],
      });
      assert.equal(second.status, 'completed');
      assert.equal(second.answer, 'There are 2 milk options.');
      assert.deepEqual(second.usage, { tokensIn: 40, tokensOut: 8 });

      // The tool output reached the model through Gemini's native
      // functionResponse channel, under an `output` key.
      assert.deepEqual(seen[1].contents.at(-1).parts[0].functionResponse.response, { output });
    });
  });

  it('askAgent() streams answer_delta then exactly one terminal done', async () => {
    await withAgentServer({ scripts: [[textChunk('Hello.')]] }, async ({ base, token }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });
      const events = [];
      for await (const event of client.askAgent({ input: 'hi', tools: TOOLS })) events.push(event);
      assert.deepEqual(events.map((e) => e.type), ['answer_delta', 'done']);
      assert.equal(events[0].text, 'Hello.');
      assert.equal(events[1].status, 'completed');
      assert.equal(events[1].answer, 'Hello.');
    });
  });

  it('SEMIDEX NEVER EXECUTES THE TOOL — the run stops and hands control back', async () => {
    let executed = false;
    const scripts = [[callChunk({ id: 'c1', name: 'lookup_items', args: { query: 'x' } })]];
    await withAgentServer({ scripts }, async ({ base, token, seen }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });
      // The only implementation of lookup_items in this process. Nothing in
      // Semidex can reach it, and nothing must try.
      const executor = () => { executed = true; return {}; };
      const step = await client.agentStep({ input: 'go', tools: TOOLS });
      assert.equal(step.status, 'requires_action');
      assert.equal(executed, false, 'Semidex must never execute a caller-supplied tool');
      assert.equal(typeof executor, 'function');
      assert.equal(seen.length, 1, 'one client call must produce exactly one model step');
    });
  });

  it('a key without the "agent" scope is rejected with a typed 403 and zero generation', async () => {
    // A key scoped to generate+search — i.e. an existing Ask/Search key.
    await withAgentServer({ scripts: [[textChunk('should not run')]], operations: ['generate', 'search'] },
      async ({ base, token, seen }) => {
        const client = createSemidexClient({ baseUrl: base, apiKey: token });
        await assert.rejects(
          () => client.agentStep({ input: 'hi', tools: TOOLS }),
          (err) => {
            assert.ok(err instanceof SemidexApiError);
            assert.equal(err.status, 403);
            return true;
          },
        );
        assert.equal(seen.length, 0, 'an out-of-scope key must never reach the model');
      });
  });

  it('an unsupported JSON Schema keyword is a typed 400 and never reaches the model', async () => {
    await withAgentServer({ scripts: [[textChunk('nope')]] }, async ({ base, token, seen }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });
      await assert.rejects(
        () => client.agentStep({
          input: 'hi',
          tools: [{ name: 'bad', inputSchema: { type: 'object', properties: { a: { type: 'string', format: 'email' } } } }],
        }),
        (err) => {
          assert.equal(err.status, 400);
          assert.equal(err.code, 'unsupported_schema_keyword');
          return true;
        },
      );
      assert.equal(seen.length, 0);
    });
  });

  it('replaying a consumed continuation is a typed 404 and does not re-run generation', async () => {
    const scripts = [
      [callChunk({ id: 'c1', name: 'lookup_items', args: { query: 'x' } })],
      [textChunk('final')],
      [textChunk('MUST NOT HAPPEN')],
    ];
    await withAgentServer({ scripts }, async ({ base, token, seen }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });
      const first = await client.agentStep({ input: 'hi', tools: TOOLS });
      const args = { continuationId: first.continuationId, toolResults: [{ callId: 'c1', ok: true, output: {} }] };

      const done = await client.agentStep(args);
      assert.equal(done.status, 'completed');
      const stepsAfter = seen.length;

      await assert.rejects(() => client.agentStep(args), (err) => {
        assert.equal(err.status, 404);
        assert.equal(err.code, 'run_not_found');
        return true;
      });
      assert.equal(seen.length, stepsAfter, 'a replay must never reach the model again');
    });
  });

  it('the client refuses locally to change instructions/tools on a continuation', async () => {
    await withAgentServer({ scripts: [] }, async ({ base, token, seen }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });
      assert.throws(
        () => client.askAgent({ continuationId: 'x', toolResults: [], systemInstructions: 'new' }),
        TypeError,
      );
      assert.equal(seen.length, 0);
    });
  });

  it('private continuation metadata never crosses the wire', async () => {
    const scripts = [[{
      candidates: [{
        content: { parts: [{ functionCall: { id: 'c1', name: 'lookup_items', args: { query: 'x' } }, thoughtSignature: 'TOP-SECRET-SIG' }] },
        finishReason: 'STOP',
      }],
    }]];
    await withAgentServer({ scripts }, async ({ base, token }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });
      const events = [];
      for await (const event of client.askAgent({ input: 'hi', tools: TOOLS })) events.push(event);
      const serialized = JSON.stringify(events);
      assert.ok(!serialized.includes('TOP-SECRET-SIG'), 'thoughtSignature must never reach the client');
      assert.ok(!serialized.includes('providerState'), 'provider state must never reach the client');
      assert.ok(!serialized.includes('nativeContents'), 'native provider contents must never reach the client');
    });
  });
});
