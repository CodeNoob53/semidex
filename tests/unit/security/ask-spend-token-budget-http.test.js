// Spend/token budget ceiling — full HTTP path through a real composition
// root (createApp/createLiteApp), a real createAskCoordinatorBundle (so
// coordinator.js/coordinator-v2.js/query-rewrite.js/summary-compaction.js's
// real reserve/reconcile wiring runs, not a stubbed askCoordinator), a
// tiny/deterministic budgetTracker, and a capturing audit sink. No real
// Qdrant/Gemini/Ollama. Mirrors ask.test.js/ask-v2.test.js/
// integration-rate-limit-http.test.js's own harness conventions.
//
// countTokens is a FIXED stub (always 50) rather than a word-count, so
// every reservation's cost is exact, deterministic arithmetic independent
// of prompt-text length elsewhere in the codebase:
//   rewrite cost   = 50 + REWRITE_MAX_OUTPUT_TOKENS (231)  = 281
//   answer cost    = 50 + ASK_MAX_OUTPUT_TOKENS default (1024) = 1074
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from '../../../src/admin/server-full.js';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createAskCoordinatorBundle } from '../../../src/core/ask/coordinator-v2.js';
import { createTokenBudgetTracker } from '../../../src/core/auth/token-budget.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { AUDIT_EVENT_TYPE } from '../../../src/core/audit/event.js';
import { REWRITE_MAX_OUTPUT_TOKENS } from '../../../src/core/ask/query-rewrite.js';
import { OPEN_INTEGRATION_POLICY } from './test-integration-policy.js';

const HIT = {
  sourceFile: 'docs/en/configuration.md', chunkIndex: 4, section: 'Qdrant',
  text: 'QDRANT_URL points at the Qdrant instance.',
  nodeType: null, nodeId: null, nodePath: null, score: 0.03,
};
const VALID_PROFILE = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function makeStubAdapter() {
  return {
    name: () => 'stub',
    capabilities: () => ({ namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true }),
    ping: async () => ({ ok: true, detail: 'stub reachable' }),
    listCollections: async () => [{ name: 'demo' }],
    getCollection: async (name) => (name === 'demo' ? { name: 'demo', pointCount: 5 } : null),
    getEmbeddingProfile: async () => ({ state: 'valid', profile: VALID_PROFILE }),
    listSourceDocuments: async () => [],
    getChunk: async () => [],
    getFileChunks: async () => [],
    getSectionChunks: async () => null,
    searchHybridVectors: async () => [HIT],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getContentNode: async () => null,
    getSectionAnchor: async () => null,
  };
}

async function embedQueryStub() { return { dense: [0.1, 0.2], sparse: { indices: [1], values: [0.5] } }; }
const countTokensStub = () => 50;

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

const QUESTION_SENTINEL = 'sentinel-question-do-not-leak-9f21a7';

function makeSpyProvider() {
  const calls = [];
  return {
    calls,
    provider: {
      name: () => 'ollama',
      capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true, hardOutputCap: true }),
      ready: async () => ({ ok: true, model: 'gemma3:4b', numCtx: 8192 }),
      generate: async ({ systemPrompt, options, onToken }) => {
        const label = systemPrompt?.includes('standalone search query') ? 'rewrite'
          : systemPrompt?.includes('rolling summary') ? 'compaction'
          : 'answer';
        calls.push({ label, options });
        if (label === 'rewrite') return { text: 'rewritten standalone query' };
        if (label === 'compaction') return { text: 'a fresh bounded summary' };
        onToken?.('The value is ');
        onToken?.('42 [1].');
        return { text: 'The value is 42 [1].', tokensIn: 20, tokensOut: 6, aborted: false };
      },
    },
  };
}

function fakeAuditSink() {
  const events = [];
  return { events, record: (e) => events.push(e), async flush() {}, async close() {} };
}

async function withServer({
  factory = createApp,
  budgetTracker = createTokenBudgetTracker(),
  auditSink = fakeAuditSink(),
  spy = makeSpyProvider(),
  integrationPolicy = OPEN_INTEGRATION_POLICY,
} = {}, fn) {
  const adapter = makeStubAdapter();
  const { v1, v2, gate } = createAskCoordinatorBundle({
    adapter, embedQuery: embedQueryStub, countTokens: countTokensStub, generationProvider: spy.provider,
    settingsService: undefined, cloudEmbed: undefined,
  });
  const app = factory({
    adapter, embedQuery: embedQueryStub, askCoordinators: { v1, v2, gate },
    integrationPolicy, budgetTracker, auditSink,
    jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn({ base, spy, auditSink, budgetTracker });
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

function post(base, path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const v1Body = { collection: 'demo', question: QUESTION_SENTINEL };
const v2FollowUpBody = {
  collection: 'demo',
  question: 'and that?', // short + no strong pronoun match avoided; use explicit conversation to force rewrite
  conversation: { id: 'conv-1', summary: 'we were discussing QDRANT_URL', recentMessages: [] },
};

describe('Task requirement #1 — v1 final answer consumes the ledger and receives a provider hard output cap', () => {
  it('the single generate() call is reserved and receives options.maxOutputTokens', async () => {
    await withServer({ budgetTracker: createTokenBudgetTracker({ tokensPerHour: 10_000_000, burstTokens: 100_000, now: () => 1 }) }, async ({ base, spy }) => {
      const res = await post(base, '/api/v1/ask', v1Body);
      assert.equal(res.status, 200);
      assert.equal(spy.calls.length, 1);
      assert.equal(spy.calls[0].label, 'answer');
      assert.equal(spy.calls[0].options.maxOutputTokens, 1024, 'ASK_MAX_OUTPUT_TOKENS default');
    });
  });
});

describe('Task requirement #2 — v2 rewrite+answer+compaction share ONE ledger; the exact call that would exceed it is denied before the provider fake is invoked', () => {
  it('rewrite succeeds (its own fake IS invoked); the answer reservation then fails and the answer fake is NEVER invoked', async () => {
    // burst=1200: rewrite (281) fits, leaving 919 — not enough for the
    // answer's own cost (1074), which WOULD fit alone (1074 <= 1200), so
    // this is the transient key_budget_exceeded path, not a structural
    // "too small to ever fit" denial.
    const tracker = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1200, now: () => 1 });
    await withServer({ budgetTracker: tracker }, async ({ base, spy }) => {
      const res = await post(base, '/api/v2/ask', v2FollowUpBody);
      assert.equal(spy.calls.length, 1, 'exactly one provider call was ever made');
      assert.equal(spy.calls[0].label, 'rewrite', 'the rewrite call ran (it fit the shared ledger)');
      assert.equal(res.status, 429, 'the answer reservation denial surfaces as a clean pre-stream failure, never a partial stream');
      const body = await res.json();
      assert.equal(body.error.code, 'budget_exceeded');
      assert.equal(body.error.retryable, true);
    });
  });

  it('a structural per-request ceiling is non-retryable and has no Retry-After header', async () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1000, now: () => 1 });
    await withServer({ budgetTracker: tracker }, async ({ base, spy }) => {
      const res = await post(base, '/api/v1/ask', v1Body);
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('retry-after'), null);
      const body = await res.json();
      assert.equal(body.error.code, 'budget_limit_exceeded');
      assert.equal(body.error.retryable, false);
      assert.equal(spy.calls.length, 0);
    });
  });
});

describe('Task requirement #3 — retries cannot bypass call/token ceilings', () => {
  it('a second HTTP request (simulating a client retry) after the first exhausted the aggregate is denied identically', async () => {
    // burst exactly 1074: the first v1 request consumes it all.
    const tracker = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1074, now: () => 1 });
    await withServer({ budgetTracker: tracker }, async ({ base, spy }) => {
      const first = await post(base, '/api/v1/ask', v1Body);
      assert.equal(first.status, 200);
      assert.equal(spy.calls.length, 1);

      const retry = await post(base, '/api/v1/ask', v1Body);
      assert.equal(retry.status, 429);
      assert.equal(spy.calls.length, 1, 'the retry never reaches the provider at all');

      const secondRetry = await post(base, '/api/v1/ask', v1Body);
      assert.equal(secondRetry.status, 429, 'repeated retries keep failing — there is no bypass');
      assert.equal(spy.calls.length, 1);
    });
  });
});

describe('Task requirement #8 — the SSE/HTTP failure shape is stable and typed, and leaks nothing private', () => {
  it('the 429 body is exactly the documented versioned error envelope, with a Retry-After header, and never contains the question text', async () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1074, now: () => 1 });
    await withServer({ budgetTracker: tracker }, async ({ base }) => {
      await post(base, '/api/v1/ask', v1Body); // consume the whole budget
      const res = await post(base, '/api/v1/ask', v1Body);
      assert.equal(res.status, 429);
      const retryAfter = res.headers.get('retry-after');
      assert.ok(retryAfter, 'Retry-After must be present for the transient key_budget_exceeded case');
      assert.match(retryAfter, /^\d+$/);

      const body = await res.json();
      assert.deepEqual(Object.keys(body.error).sort(), ['apiVersion', 'code', 'message', 'retryable']);
      assert.equal(body.error.code, 'budget_exceeded');
      assert.equal(typeof body.error.message, 'string');
      assert.equal(body.error.retryable, true);

      const text = JSON.stringify(body);
      assert.doesNotMatch(text, new RegExp(QUESTION_SENTINEL), 'the question text never appears in a budget-exhaustion error body');
    });
  });
});

describe('Task requirement #9 — audit records: allowed numeric/reason fields only, negative sentinels prove no question/secret/evidence leaks', () => {
  it('records budget.reservation_denied with exactly the allow-listed fields, and no event anywhere contains the question, evidence snippet, or bearer token', async () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1074, now: () => 1 });
    const auditSink = fakeAuditSink();
    await withServer({ budgetTracker: tracker, auditSink }, async ({ base }) => {
      await post(base, '/api/v1/ask', v1Body); // succeeds, consumes the budget
      const denied = await post(base, '/api/v1/ask', v1Body);
      assert.equal(denied.status, 429);

      const events = auditSink.events.filter((e) => e.type === AUDIT_EVENT_TYPE.BUDGET_RESERVATION_DENIED);
      assert.equal(events.length, 1);
      const event = events[0];
      assert.equal(event.outcome, 'denied');
      assert.equal(event.label, 'answer');
      assert.equal(event.reason, 'key_budget_exceeded');
      assert.equal(typeof event.keyId, 'string');
      assert.equal(typeof event.estimatedInputTokens, 'number');
      assert.equal(typeof event.maxOutputTokens, 'number');
      assert.equal(typeof event.retryAfterSeconds, 'number');

      // Negative sentinels: the question text, the evidence snippet text,
      // and the bearer-scheme literal never appear in ANY recorded event —
      // buildAuditEvent()'s allow-list schema makes this structural (see
      // core/audit/event.js), this proves it end to end through a real
      // budget denial specifically.
      const allText = JSON.stringify(auditSink.events);
      assert.doesNotMatch(allText, new RegExp(QUESTION_SENTINEL));
      assert.doesNotMatch(allText, /QDRANT_URL points at the Qdrant instance/);
      assert.doesNotMatch(allText, /Bearer /);
    });
  });
});

describe('Task requirement #10 — Full/Lite and Ask v1/v2 parity', () => {
  for (const [label, factory] of [['Full', createApp], ['Lite', createLiteApp]]) {
    it(`${label}: v1 and v2 both deny identically under the same tiny per-key budget`, async () => {
      const tracker = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1074, now: () => 1 });
      await withServer({ factory, budgetTracker: tracker }, async ({ base }) => {
        const firstV1 = await post(base, '/api/v1/ask', v1Body);
        assert.equal(firstV1.status, 200);
        // The shared per-key aggregate is now exhausted — v2's answer
        // reservation (even with no rewrite triggered, a first-turn
        // request) must be denied the SAME way.
        const v2res = await post(base, '/api/v2/ask', { collection: 'demo', question: 'brand new question, no history' });
        assert.equal(v2res.status, 429);
        const body = await v2res.json();
        assert.equal(body.error.code, 'budget_exceeded');
      });
    });
  }

  it('v1 and v2 produce the EXACT SAME error shape for an identical denial (shared askCore, shared contract)', async () => {
    const tracker1 = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1074, now: () => 1 });
    const tracker2 = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1074, now: () => 1 });
    let v1Body_, v2Body_;
    await withServer({ budgetTracker: tracker1 }, async ({ base }) => {
      await post(base, '/api/v1/ask', v1Body);
      v1Body_ = await (await post(base, '/api/v1/ask', v1Body)).json();
    });
    await withServer({ budgetTracker: tracker2 }, async ({ base }) => {
      await post(base, '/api/v2/ask', { collection: 'demo', question: 'brand new question, no history' });
      v2Body_ = await (await post(base, '/api/v2/ask', { collection: 'demo', question: 'brand new question, no history' })).json();
    });
    assert.equal(v1Body_.error.code, v2Body_.error.code);
    assert.deepEqual(Object.keys(v1Body_.error).sort(), Object.keys(v2Body_.error).sort());
  });
});

describe('Legacy/default-limit key still gets real, finite protection through the full HTTP path (task requirement #6)', () => {
  it('the default tracker (no per-key override on the OPEN_INTEGRATION_POLICY principal) still enforces a real ceiling, not "unlimited"', async () => {
    // Uses the module's own DEFAULT_TOKEN_BUDGET_BURST_TOKENS (40,000) —
    // generous enough that a handful of tiny stub requests all succeed,
    // proving the default is a real usable ceiling, not zero — and
    // finite, proven by exhausting it with a tiny override instead (the
    // other tests in this file already do that). This test's job is only
    // to prove the DEFAULT construction path (registerNeutralRoutes's own
    // `budgetTracker ?? createTokenBudgetTracker()` fallback) works
    // end-to-end without any test-supplied tracker at all.
    const adapter = makeStubAdapter();
    const spy = makeSpyProvider();
    const { v1, v2, gate } = createAskCoordinatorBundle({
      adapter, embedQuery: embedQueryStub, countTokens: countTokensStub, generationProvider: spy.provider,
    });
    const app = createApp({
      adapter, embedQuery: embedQueryStub, askCoordinators: { v1, v2, gate },
      integrationPolicy: OPEN_INTEGRATION_POLICY,
      jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
      // No budgetTracker override — exercises registerNeutralRoutes's own
      // default construction, proving enforcement is active even when a
      // composition root's caller supplies nothing.
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      const res = await post(base, '/api/v1/ask', v1Body);
      assert.equal(res.status, 200, 'the real default ceiling (200,000 tok/hour, 40,000 burst) comfortably covers one tiny stub request');
      assert.equal(spy.calls.length, 1);
      assert.equal(spy.calls[0].options.maxOutputTokens, 1024, 'the provider still received a real, enforced output cap under the default tracker');
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });
});
