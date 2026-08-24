// End-to-end proof that packages/lite/lite-src/client's wire assumptions
// match the REAL src/core/search-api/v1 and src/core/ask-api/v1/v2 routes
// registered by createLiteApp() — not just a hand-rolled fake server that
// happens to agree with the client's own expectations. Offline: stub
// adapter/embedQuery/askCoordinators, a real temp key store.
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
import { createSemidexClient, SemidexApiError } from '../../../../packages/lite/lite-src/client/index.js';

const VALID_PROFILE = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

let dir;
let keyPath;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-client-e2e-')); keyPath = join(dir, 'integration-keys.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function withServer(fn) {
  const keyStore = createKeyStore({ path: keyPath });
  const { token } = keyStore.createKey({ name: 'client-e2e', collections: ['docs-a'], operations: ['search', 'generate'] });
  const adapter = {
    name: () => 'stub',
    capabilities: () => ({ namedVectors: true, sparseVectors: true, hybridSearch: true }),
    ping: async () => ({ ok: true }),
    listCollections: async () => [],
    getCollection: async (name) => (name === 'docs-a' ? { name, pointCount: 5 } : null),
    getEmbeddingProfile: async () => ({ state: 'valid', profile: VALID_PROFILE }),
    getChunk: async () => [],
    searchHybridVectors: async () => [{
      sourceFile: 'docs/en/configuration.md', chunkIndex: 0, totalChunks: 3, section: 'Auth',
      text: 'Authorization uses bearer tokens.', context: null, tags: [], score: 0.02,
      nodeType: null, nodeId: null, nodePath: null, isMatch: null,
    }],
  };
  const app = createLiteApp({
    adapter,
    embedQuery: async () => ({ dense: [0.1], sparse: { indices: [1], values: [0.5] } }),
    jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
    askCoordinators: {
      v1: {
        ask: async ({ onSources, onToken }) => {
          await onSources({ searchMode: 'hybrid', sources: [] });
          await onToken('The answer ');
          await onToken('is 42.');
          return { status: 'done', text: 'The answer is 42.', citations: [], nodeReferences: [], refused: false, provider: 'stub', model: 'stub', tokensIn: 1, tokensOut: 2, evidenceCount: 1, elapsedMs: 1 };
        },
      },
      v2: {
        ask: async ({ onSources, onToken, conversation }) => {
          await onSources({ searchMode: 'hybrid', sources: [] });
          await onToken('ok');
          return {
            status: 'done', text: 'ok', citations: [], nodeReferences: [], refused: false, provider: 'stub', model: 'stub',
            tokensIn: 1, tokensOut: 1, evidenceCount: 1, elapsedMs: 1,
            summaryChanged: Boolean(conversation), updatedSummary: conversation ? 'updated' : null, compactedMessageCount: conversation ? 1 : null,
          };
        },
      },
    },
    integrationPolicy: createIntegrationPolicy({ keyStore, rateLimiter: createRateLimiter(), logger: { warn() {}, error() {} } }),
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    await fn({ base: `http://127.0.0.1:${app.address().port}`, token });
  } finally {
    await new Promise((r) => app.close(r));
  }
}

describe('client <-> real POST /api/v1/search', () => {
  it('search() round-trips against the real route and projected result shape', async () => {
    await withServer(async ({ base, token }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });
      const result = await client.search({ collection: 'docs-a', query: 'how does auth work?' });
      assert.equal(result.apiVersion, 'v1');
      assert.equal(result.searchMode, 'hybrid');
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].sourceFile, 'docs/en/configuration.md');
      assert.equal(result.results[0].text, 'Authorization uses bearer tokens.');
    });
  });

  it('an out-of-scope collection surfaces as a typed 403 SemidexApiError', async () => {
    await withServer(async ({ base, token }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });
      await assert.rejects(
        () => client.search({ collection: 'not-mine', query: 'q' }),
        (err) => { assert.ok(err instanceof SemidexApiError); assert.equal(err.status, 403); assert.equal(err.code, 'forbidden'); return true; },
      );
    });
  });
});

describe('client <-> real POST /api/v1/ask', () => {
  it('askV1() round-trips sources/answer_delta/done against the real SSE route', async () => {
    await withServer(async ({ base, token }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });
      const events = [];
      for await (const event of client.askV1({ collection: 'docs-a', question: 'what is the answer?' })) events.push(event);
      assert.equal(events[0].type, 'sources');
      assert.equal(events[1].type, 'answer_delta');
      assert.equal(events[1].text, 'The answer ');
      assert.equal(events[2].text, 'is 42.');
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.answer, 'The answer is 42.');
    });
  });
});

describe('client <-> real POST /api/v2/ask', () => {
  it('askV2() round-trips a conversation turn against the real SSE route', async () => {
    await withServer(async ({ base, token }) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: token });
      const events = [];
      for await (const event of client.askV2({
        collection: 'docs-a', question: 'follow-up',
        conversation: { conversationId: 'c1', summary: 'prior', recentMessages: [{ role: 'user', content: 'hi' }] },
      })) events.push(event);
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.answer, 'ok');
      assert.equal(done.conversation.summaryChanged, true);
      assert.equal(done.conversation.updatedSummary, 'updated');
    });
  });
});
