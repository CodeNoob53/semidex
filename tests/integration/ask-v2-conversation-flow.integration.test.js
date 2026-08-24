// Ask API v2 — end-to-end integration tests using the REAL, shipped
// ask-v2-sse-client.mjs against a REAL node:http server (createApp()),
// wired to a fully-offline stub adapter/embedQuery/generationProvider — no
// Qdrant, no ONNX, no Ollama, no network beyond loopback. This complements
// tests/unit/admin/ask-v2.test.js (which drives the route/coordinator
// directly via raw fetch + a hand-rolled buffered SSE parser) by instead
// exercising the actual public client artifact examples/ask-v2-sse-client.mjs
// end to end, plus the two scenarios not covered elsewhere: a missing
// collection (404) and a context window too small to answer at all
// (context_budget_exceeded).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/admin/server-full.js';
import { createAskCoordinatorBundle } from '../../src/core/ask/coordinator-v2.js';
import { askV2 } from '../../packages/lite/examples/ask-v2-sse-client.mjs';
import { createConversationManager } from '../../packages/lite/examples/conversation-manager.mjs';
import { OPEN_INTEGRATION_POLICY } from '../unit/security/test-integration-policy.js';
import { createKeyStore } from '../../src/core/auth/key-store.js';
import { createIntegrationPolicy } from '../../src/core/auth/integration-policy.js';

const HIT = {
  sourceFile: 'docs/en/configuration.md', chunkIndex: 4, section: 'Qdrant',
  text: 'QDRANT_URL points at the Qdrant instance.', nodeType: null, nodeId: null, nodePath: null, score: 0.03,
};

const VALID_PROFILE = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function makeStubAdapter(overrides = {}) {
  return {
    name: () => 'stub',
    capabilities: () => ({ namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true }),
    ping: async () => ({ ok: true, detail: 'stub reachable' }),
    listCollections: async () => [{ name: 'demo' }],
    getCollection: async (name) => (name === 'demo' ? { name: 'demo', pointCount: 5 } : null),
    getEmbeddingProfile: async () => ({ state: 'valid', profile: VALID_PROFILE }),
    getFileChunks: async () => [],
    getSectionChunks: async () => null,
    searchHybridVectors: async () => [HIT],
    getSkeletonNode: async () => null,
    getContentNode: async () => null,
    ...overrides,
  };
}

const embedQueryStub = async () => ({ dense: [0.1, 0.2], sparse: { indices: [1], values: [0.5] } });
const countTokensStub = (text) => (text ?? '').split(/\s+/).filter(Boolean).length;

function makeStubProvider(overrides = {}) {
  return {
    name: () => 'ollama',
    capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true, hardOutputCap: true }),
    ready: async () => ({ ok: true, model: 'gemma3:4b', numCtx: 8192 }),
    generate: async ({ onToken, systemPrompt }) => {
      if (systemPrompt?.includes('standalone search query')) return { text: 'rewritten standalone query' };
      if (systemPrompt?.includes('rolling summary')) return { text: 'a fresh bounded summary' };
      onToken?.('The value is ');
      onToken?.('42 [1].');
      return { text: 'The value is 42 [1].', tokensIn: 20, tokensOut: 6, aborted: false };
    },
    ...overrides,
  };
}

async function withServer({
  adapter = makeStubAdapter(), embedQuery = embedQueryStub, generationProvider = makeStubProvider(),
  integrationPolicy = OPEN_INTEGRATION_POLICY,
} = {}, fn) {
  const { v1, v2, gate } = createAskCoordinatorBundle({
    adapter, embedQuery, countTokens: countTokensStub, generationProvider, settingsService: undefined, cloudEmbed: undefined,
  });
  const app = createApp({ adapter, embedQuery, askCoordinators: { v1, v2, gate }, integrationPolicy });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    // A client-aborted fetch() doesn't always tear down its underlying
    // TCP socket in lockstep with the server's own res.end() — plain
    // app.close() waits (up to Node's default ~5s keepAliveTimeout) for
    // any such lingering connection to fully settle, which is pure test
    // teardown latency, not a real correctness signal. closeAllConnections()
    // (Node >= 18.2) force-closes anything still open the instant every
    // test in this file is done issuing requests, so teardown here is fast
    // regardless of client-side abort timing quirks.
    app.closeAllConnections?.();
    await new Promise((resolve) => app.close(resolve));
  }
}

describe('Ask v2 integration — real askV2 client against a real server', () => {
  it('first request without conversation', async () => {
    await withServer({}, async (base) => {
      const result = await askV2({ baseUrl: base, collection: 'demo', question: 'What is the value?' });
      assert.equal(result.ok, true);
      assert.equal(result.answer, 'The value is 42 [1].');
      assert.equal(result.conversationId, null);
    });
  });

  it('follow-up with history-aware rewriting: answer uses the ORIGINAL question, rewritten query is used only for retrieval', async () => {
    let capturedRetrievalQuery;
    const adapter = makeStubAdapter({
      searchHybridVectors: async (_name, opts) => { capturedRetrievalQuery = opts?.queryText; return [HIT]; },
    });
    await withServer({ adapter }, async (base) => {
      const result = await askV2({
        baseUrl: base, collection: 'demo', question: 'what about it?',
        conversation: { id: 'conv1', summary: 'discussed the deployment', recentMessages: [] },
      });
      assert.equal(result.ok, true);
      // The done event's answer is generated FROM the original question —
      // the stub provider always answers "The value is 42 [1]." regardless
      // of retrieval query, so this asserts the request completed using
      // the real coordinator flow (retrieval query rewriting is already
      // unit-tested in query-rewrite.test.js and asserted at the route
      // level in ask-v2.test.js — this test's own value is proving the
      // REAL client/server round trip completes correctly end to end for
      // a follow-up-shaped request).
      assert.equal(result.answer, 'The value is 42 [1].');
    });
  });

  it('two different conversation.id values via the conversation manager never mix data', async () => {
    await withServer({}, async (base) => {
      const manager = createConversationManager();
      const a1 = await manager.ask({ baseUrl: base, collection: 'demo', question: 'Question about A' });
      const b1 = await manager.ask({ baseUrl: base, collection: 'demo', question: 'Question about B' });
      assert.notEqual(a1.conversationId, b1.conversationId);
      const stateA = manager._debugGetState(a1.conversationId);
      const stateB = manager._debugGetState(b1.conversationId);
      assert.ok(!JSON.stringify(stateB).includes('Question about A'));
      assert.ok(!JSON.stringify(stateA).includes('Question about B'));
    });
  });

  it('summary compaction returns updatedSummary at/above the threshold', async () => {
    // Must exceed the default retained-raw-tail cap (ASK_SUMMARY_RETAINED_MESSAGES, 4)
    // -- only messages OLDER than that tail are material a summary can cover.
    const manyMessages = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }));
    await withServer({}, async (base) => {
      const result = await askV2({
        baseUrl: base, collection: 'demo', question: 'q',
        conversation: { id: 'conv1', summary: 'old', recentMessages: manyMessages },
      });
      assert.equal(result.summaryChanged, true);
      assert.equal(result.updatedSummary, 'a fresh bounded summary');
      assert.equal(typeof result.compactedMessageCount, 'number', 'the SSE client must surface compactedMessageCount whenever summaryChanged is true');
      assert.ok(result.compactedMessageCount > 0);
      assert.ok(result.compactedMessageCount < manyMessages.length, 'the retained newest tail must never be reported as compacted');
    });
  });

  it('compaction failure does not break an already-formed answer', async () => {
    const manyMessages = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }));
    const provider = makeStubProvider({
      generate: async ({ onToken, systemPrompt }) => {
        if (systemPrompt?.includes('rolling summary')) throw new Error('compaction provider down');
        if (systemPrompt?.includes('standalone search query')) return { text: 'rewritten' };
        onToken?.('answer [1]');
        return { text: 'answer [1]', aborted: false };
      },
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const result = await askV2({
        baseUrl: base, collection: 'demo', question: 'q',
        conversation: { id: 'conv1', summary: 'old', recentMessages: manyMessages },
      });
      assert.equal(result.ok, true);
      assert.equal(result.answer, 'answer [1]');
      assert.equal(result.summaryChanged, false);
      assert.equal(result.error, null);
    });
  });

  it('query rewrite failure uses the original question, still completes successfully', async () => {
    const provider = makeStubProvider({
      generate: async ({ onToken, systemPrompt }) => {
        if (systemPrompt?.includes('standalone search query')) throw new Error('rewrite provider down');
        onToken?.('answer [1]');
        return { text: 'answer [1]', aborted: false };
      },
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const result = await askV2({
        baseUrl: base, collection: 'demo', question: 'what about it?',
        conversation: { id: 'conv1', summary: 's', recentMessages: [] },
      });
      assert.equal(result.ok, true);
      assert.equal(result.answer, 'answer [1]');
    });
  });

  it('system/developer/tool roles all return invalid_message_role', async () => {
    await withServer({}, async (base) => {
      for (const role of ['system', 'developer', 'tool']) {
        const result = await askV2({
          baseUrl: base, collection: 'demo', question: 'q',
          conversation: { id: 'c', recentMessages: [{ role, content: 'x' }] },
        });
        assert.equal(result.error.code, 'invalid_message_role', `role="${role}" must be rejected`);
      }
    });
  });

  it('an oversized message returns message_too_large', async () => {
    const { PROTOCOL_MAX_MESSAGE_CHARS } = await import('../../src/core/ask-api/v2/request.js');
    await withServer({}, async (base) => {
      const result = await askV2({
        baseUrl: base, collection: 'demo', question: 'q',
        conversation: { id: 'c', recentMessages: [{ role: 'user', content: 'x'.repeat(PROTOCOL_MAX_MESSAGE_CHARS + 1) }] },
      });
      assert.equal(result.error.code, 'message_too_large');
    });
  });

  it('a malformed conversation shape returns invalid_conversation', async () => {
    await withServer({}, async (base) => {
      const result = await askV2({ baseUrl: base, collection: 'demo', question: 'q', conversation: { recentMessages: 'not-an-array' } });
      assert.equal(result.error.code, 'invalid_conversation');
    });
  });

  it('a missing collection returns 404, never starts an SSE stream', async () => {
    await withServer({}, async (base) => {
      const result = await askV2({ baseUrl: base, collection: 'does-not-exist', question: 'q' });
      assert.equal(result.httpStatus, 404);
      assert.equal(result.error.code, 'not_found');
      assert.equal(result.ok, false);
    });
  });

  it('a context window too small to answer at all returns context_budget_exceeded', async () => {
    // numCtx tiny enough that even the bare question cannot fit alongside
    // RESERVED_HEADROOM_TOKENS + MIN_EVIDENCE_RESERVATION_TOKENS — this is
    // conversation-context.js's own genuinely-degenerate error case,
    // reached only when a `conversation` block is present (the check only
    // runs for purpose:'answer' inside budgetConversationContext, invoked
    // by coordinator-v2.js).
    const provider = makeStubProvider({ ready: async () => ({ ok: true, model: 'gemma3:4b', numCtx: 5 }) });
    await withServer({ generationProvider: provider }, async (base) => {
      const result = await askV2({
        baseUrl: base, collection: 'demo',
        question: 'a longer question with enough words to exceed a five token budget',
        conversation: { id: 'c', recentMessages: [] },
      });
      assert.equal(result.error.code, 'context_budget_exceeded');
      assert.equal(result.httpStatus, 422);
    });
  });

  it('a busy first request causes a concurrent second request to receive busy (429)', async () => {
    let releaseFirst;
    const provider = makeStubProvider({
      generate: ({ onToken, systemPrompt }) => new Promise((resolve) => {
        if (systemPrompt?.includes('standalone search query') || systemPrompt?.includes('rolling summary')) { resolve({ text: 'x' }); return; }
        releaseFirst = () => { onToken?.('answer [1]'); resolve({ text: 'answer [1]', aborted: false }); };
      }),
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const firstPromise = askV2({ baseUrl: base, collection: 'demo', question: 'q' });
      await new Promise((r) => setTimeout(r, 30));
      const second = await askV2({ baseUrl: base, collection: 'demo', question: 'q' });
      assert.equal(second.httpStatus, 429);
      assert.equal(second.error.code, 'busy');
      releaseFirst?.();
      await firstPromise;
    });
  });

  it('aborting the client mid-generation stops the stream and releases the shared gate', async () => {
    // Only the FIRST real answer-generation call ever hangs (waiting to be
    // aborted) — every subsequent call (including any follow-up request's
    // own generation) resolves normally. A generate() that hangs
    // unconditionally on every call would make EVERY later request in this
    // test also stall until ITS OWN client-side timeout fires, which
    // manifests as the whole test needing many seconds per attempt and
    // never actually observing a real, immediate gate release — this
    // fixture bug (not an implementation bug) is exactly what turned this
    // test into an accidental 20+ second hang the first time it was written.
    let mainGenerationCallCount = 0;
    const provider = makeStubProvider({
      generate: ({ signal, onToken, systemPrompt }) => {
        if (systemPrompt?.includes('standalone search query') || systemPrompt?.includes('rolling summary')) {
          return Promise.resolve({ text: 'x' });
        }
        mainGenerationCallCount += 1;
        if (mainGenerationCallCount > 1) {
          onToken?.('answer [1]');
          return Promise.resolve({ text: 'answer [1]', aborted: false });
        }
        return new Promise((resolve) => {
          onToken?.('partial');
          if (signal?.aborted) { resolve({ text: 'partial', aborted: true }); return; }
          signal?.addEventListener('abort', () => resolve({ text: 'partial', aborted: true }));
        });
      },
    });
    await withServer({ generationProvider: provider }, async (base) => {
      const controller = new AbortController();
      const resultPromise = askV2({ baseUrl: base, collection: 'demo', question: 'q', signal: controller.signal, timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 40));
      controller.abort();
      const result = await resultPromise;
      assert.equal(result.ok, false);

      // The gate must be released — a fresh, unrelated request right after
      // must succeed normally, not see a stale busy state. The client-side
      // abort (which is what `result` above reflects) and the SERVER's own
      // request-handler settling (which is what actually releases the
      // shared gate, via its res.on('close') -> AbortController -> the
      // coordinator's finally{}) are two independent, asynchronous events
      // — the client's fetch() promise can resolve/reject microtasks
      // before the server has even observed the abort. Retry briefly
      // rather than assume the two are synchronized.
      let followUp;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        followUp = await askV2({ baseUrl: base, collection: 'demo', question: 'q2' });
        if (followUp.ok || followUp.error?.code !== 'busy') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(followUp.ok, true, `expected the gate to be released and the follow-up to succeed, got error: ${JSON.stringify(followUp.error)}`);
    });
  });
});

describe('Ask v2 integration — the shipped client against a REAL, mandatory-auth-enforcing server', () => {
  // Every test above opts OUT of authentication (OPEN_INTEGRATION_POLICY) to
  // isolate conversation-flow behavior from auth. This block proves the
  // OTHER half: the shipped ask-v2-sse-client.mjs/conversation-manager.mjs
  // pair (and, by construction, run-conversation-demo.mjs, which is a thin
  // wrapper over the same two files) actually works end to end against a
  // real key-store-backed policy — the exact configuration `npm run admin`
  // uses in production, where Ask now requires a bearer token.
  let dir;
  let keyPath;

  const setup = () => { dir = mkdtempSync(join(tmpdir(), 'semidex-ask-v2-auth-')); keyPath = join(dir, 'integration-keys.json'); };
  const teardown = () => rmSync(dir, { recursive: true, force: true });

  it('a real token minted via createKeyStore authenticates the shipped client end to end', async () => {
    setup();
    try {
      const keyStore = createKeyStore({ path: keyPath });
      const { token } = keyStore.createKey({ name: 'demo', collections: ['demo'] });
      const integrationPolicy = createIntegrationPolicy({ keyStore, logger: { warn: () => {}, error: () => {} } });
      await withServer({ integrationPolicy }, async (base) => {
        const result = await askV2({ baseUrl: base, collection: 'demo', question: 'What is the value?', token });
        assert.equal(result.ok, true);
        assert.equal(result.answer, 'The value is 42 [1].');
      });
    } finally {
      teardown();
    }
  });

  it('the shipped conversation manager (what run-conversation-demo.mjs drives) works multi-turn with a real token', async () => {
    setup();
    try {
      const keyStore = createKeyStore({ path: keyPath });
      const { token } = keyStore.createKey({ name: 'demo', collections: ['demo'] });
      const integrationPolicy = createIntegrationPolicy({ keyStore, logger: { warn: () => {}, error: () => {} } });
      await withServer({ integrationPolicy }, async (base) => {
        const manager = createConversationManager();
        const turn1 = await manager.ask({ baseUrl: base, collection: 'demo', question: 'Question one', token });
        assert.equal(turn1.ok, true);
        const turn2 = await manager.ask({ baseUrl: base, collection: 'demo', conversationId: turn1.conversationId, question: 'Question two', token });
        assert.equal(turn2.ok, true);
        assert.equal(turn2.conversationId, turn1.conversationId);
      });
    } finally {
      teardown();
    }
  });

  it('without a token, the shipped client observes the real 503/401 the server actually returns — never a silent/incorrect success', async () => {
    setup();
    try {
      const keyStore = createKeyStore({ path: keyPath });
      const integrationPolicy = createIntegrationPolicy({ keyStore, logger: { warn: () => {}, error: () => {} } });
      await withServer({ integrationPolicy }, async (base) => {
        const noKeysYet = await askV2({ baseUrl: base, collection: 'demo', question: 'q' });
        assert.equal(noKeysYet.httpStatus, 503);
        assert.equal(noKeysYet.error.code, 'integration_auth_not_configured');

        keyStore.createKey({ name: 'demo', collections: ['demo'] });
        const missingToken = await askV2({ baseUrl: base, collection: 'demo', question: 'q' });
        assert.equal(missingToken.httpStatus, 401);
      });
    } finally {
      teardown();
    }
  });
});
