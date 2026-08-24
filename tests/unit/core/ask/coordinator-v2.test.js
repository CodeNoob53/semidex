import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAskCoordinatorBundle } from '../../../../src/core/ask/coordinator-v2.js';

const countTokens = (text) => (text ?? '').split(/\s+/).filter(Boolean).length;

const VALID_PROFILE = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function fakeAdapter(overrides = {}) {
  return {
    capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
    getCollection: async (name) => ({ name }),
    getEmbeddingProfile: async () => ({ state: 'valid', profile: VALID_PROFILE }),
    searchHybridVectors: async () => [{ sourceFile: 'a.md', chunkIndex: 0, section: 'S', text: 'evidence text', nodeId: null }],
    getContentNode: async () => null,
    getSkeletonNode: async () => null,
    getSectionChunks: async () => [],
    getFileChunks: async () => [],
    ...overrides,
  };
}

const embedQuery = async () => ({ dense: [0.1], sparse: {} });

describe('createAskCoordinatorV2 — generationProvider.ready() call count', () => {
  test('calls ready() exactly once per v2 request, not once for budgeting and again inside core()', async () => {
    // Code review finding (P1): the v2 coordinator resolved readiness once
    // to budget conversation history against the real numCtx, but then
    // called core() (coordinator.js's askCore) WITHOUT passing that
    // readiness through — askCore(), receiving no `readiness` param,
    // resolved its own SECOND, independent readiness. If the provider's
    // readiness genuinely changed between the two calls (a settings
    // change, a provider restart, or simply a non-deterministic ready()
    // implementation), history would be trimmed against one numCtx/model
    // while evidence/generation ran against a different one. Fixed by
    // threading the ONE resolved readiness object through core()'s own
    // optional `readiness` parameter.
    let readyCallCount = 0;
    const generationProvider = {
      name: () => 'ollama',
      capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true, hardOutputCap: true }),
      ready: async () => { readyCallCount += 1; return { ok: true, model: 'gemma3:4b', numCtx: 8192 }; },
      generate: async ({ onToken, systemPrompt }) => {
        if (systemPrompt?.includes('standalone search query') || systemPrompt?.includes('rolling summary')) {
          return { text: 'x' };
        }
        onToken?.('answer [1]');
        return { text: 'answer [1]', tokensIn: 5, tokensOut: 2, aborted: false };
      },
    };
    const { v2 } = createAskCoordinatorBundle({
      adapter: fakeAdapter(), embedQuery, countTokens, generationProvider, settingsService: undefined, cloudEmbed: undefined,
    });

    const result = await v2.ask({
      collection: 'c', question: 'what about it?',
      conversation: { id: 'conv1', summary: 'discussed something', recentMessages: [] },
      onSources: () => {}, onToken: () => {},
    });

    assert.equal(result.status, 'done');
    assert.equal(readyCallCount, 1, `expected generationProvider.ready() to be called exactly once per request, got ${readyCallCount}`);
  });

  test('the SAME readiness object (same numCtx/model) is used for history budgeting, evidence fitting, and generation — a mid-request readiness change is never observed twice', async () => {
    // A provider whose ready() call genuinely returns something DIFFERENT
    // on a second call (simulating a settings change mid-request) — if
    // askCore() resolved its own second readiness, evidence/generation
    // would silently run against numCtx=99999 while history was trimmed
    // against numCtx=8192, an internally inconsistent budget decision.
    let readyCallCount = 0;
    let capturedGenerateNumCtx;
    const generationProvider = {
      name: () => 'ollama',
      capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true, hardOutputCap: true }),
      ready: async () => {
        readyCallCount += 1;
        // If called twice, the second call would return a DIFFERENT numCtx
        // -- proving (if generate() ever observed it) that a second,
        // independent ready() call happened.
        return { ok: true, model: 'gemma3:4b', numCtx: readyCallCount === 1 ? 8192 : 99999 };
      },
      generate: async ({ onToken, systemPrompt, options }) => {
        if (systemPrompt?.includes('standalone search query') || systemPrompt?.includes('rolling summary')) {
          return { text: 'x' };
        }
        capturedGenerateNumCtx = options?.num_ctx;
        onToken?.('answer [1]');
        return { text: 'answer [1]', tokensIn: 5, tokensOut: 2, aborted: false };
      },
    };
    const { v2 } = createAskCoordinatorBundle({
      adapter: fakeAdapter(), embedQuery, countTokens, generationProvider, settingsService: undefined, cloudEmbed: undefined,
    });

    await v2.ask({
      collection: 'c', question: 'q',
      conversation: { id: 'conv1', recentMessages: [] },
      onSources: () => {}, onToken: () => {},
    });

    assert.equal(readyCallCount, 1);
    assert.equal(capturedGenerateNumCtx, 8192, 'generate() must observe the SAME numCtx history was budgeted against, never a second, independently-resolved one');
  });
});
