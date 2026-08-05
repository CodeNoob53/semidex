// Phase 8B Step 1 — proves, BEHAVIORALLY, that Full and Lite composition
// each explicitly supply the right embedding-capability implementation to
// their OWN request path, via a per-call `embedQuery` closure bound at
// construction time — never via core/embeddings.js's shared module-scope
// applyEmbeddingCapabilities() singleton.
//
// History (why this file no longer tests applyEmbeddingCapabilities()
// mutation at all): rounds 1-2 of this fix had createApp()/createLiteApp()
// each unconditionally CALL applyEmbeddingCapabilities() with their own
// capability every time they ran, so that whichever composition root ran
// LAST in a shared process is what the shared singleton reflected —
// "last call wins," not real isolation. Round 3 introduced the actual
// fix: each composition root builds its own `resolvedEmbedQuery` closure,
// bound to its own capability at construction time, and passes it
// explicitly into registerSearchRoutes() — so a composition root's own
// request path never consults the shared singleton at all, regardless of
// what any other composition root does with it. Round 4 (code review)
// removed the now-redundant applyEmbeddingCapabilities() calls from
// createApp()/createLiteApp()/mcp/server.js entirely — the shared
// singleton is untouched by every production composition root today; it
// remains in embeddings.js purely as a fallback default for a caller that
// hasn't been updated to pass capabilities explicitly (e.g. a smoke-test
// script).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsService } from '../../../src/core/settings/service.js';

describe('createApp()/createLiteApp() never mutate core/embeddings.js\'s shared module-scope capability (code review, round 4)', () => {
  it('neither composition root imports applyEmbeddingCapabilities from core/embeddings.js', async () => {
    const { readFileSync } = await import('node:fs');
    const serverFullSrc = readFileSync(new URL('../../../src/admin/server-full.js', import.meta.url), 'utf-8');
    const liteSrc = readFileSync(new URL('../../../src/admin/composition/lite.js', import.meta.url), 'utf-8');
    const mcpSrc = readFileSync(new URL('../../../src/mcp/server.js', import.meta.url), 'utf-8');
    for (const [name, src] of [['server-full.js', serverFullSrc], ['composition/lite.js', liteSrc], ['mcp/server.js', mcpSrc]]) {
      // Doesn't just grep for the bare identifier — the header comments
      // deliberately explain, in prose, WHY applyEmbeddingCapabilities()
      // is no longer called (the word itself legitimately appears there).
      // What must be absent is an actual import of it or a call to it.
      assert.doesNotMatch(src, /import\s*\{[^}]*\bapplyEmbeddingCapabilities\b[^}]*\}/, `${name} must not import applyEmbeddingCapabilities`);
      assert.doesNotMatch(src, /(?<!\/\/[^\n]*)\bapplyEmbeddingCapabilities\s*\(/, `${name} must not call applyEmbeddingCapabilities()`);
    }
  });

  it('constructing createLiteApp() then createApp() in the same process leaves embeddings.js\'s own module-scope fallback untouched by either — a caller relying on the bare fallback still gets the same "no capability injected" error before and after both constructions', async () => {
    const embeddings = await import('../../../src/core/embeddings.js?fallback-untouched-check');
    const profile = {
      schemaVersion: 1, managedBy: 'semidex', embeddingSchemaVersion: 2,
      embedding: {
        dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
        sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
      },
    };
    // Baseline: no composition root has run yet against THIS module
    // instance (cache-busted query string) — embeddings.js's own fallback
    // is unset, so a bare call with no per-call capabilities throws its
    // own clear "no capability injected" error.
    await assert.rejects(
      () => embeddings.embedForSearch(profile, 'q'),
      (err) => { assert.match(err.message, /no ollama capability available/); return true; },
    );

    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {} });
    const { createLiteApp } = await import('../../../src/admin/composition/lite.js?fallback-untouched-check');
    const liteServer = createLiteApp({ settingsService });
    liteServer.close();
    const { createApp } = await import('../../../src/admin/server-full.js?fallback-untouched-check');
    const fullServer = createApp({ settingsService });
    fullServer.close();

    // After BOTH composition roots have constructed a real app, the same
    // bare call against embeddings.js's own module-scope fallback still
    // throws the identical error — neither composition root's own
    // construction mutated it in either direction.
    await assert.rejects(
      () => embeddings.embedForSearch(profile, 'q'),
      (err) => { assert.match(err.message, /no ollama capability available/); return true; },
    );
  });
});

describe('Real per-call isolation (code review round 3) — each composition root\'s OWN bound embedQuery is correct regardless of the shared embeddings.js singleton\'s state', () => {
  // This is the actual architectural fix: admin/server-full.js's
  // createApp() and admin/composition/lite.js's createLiteApp() each build
  // their OWN embedQuery closure (unless the caller overrides it), bound
  // to their own resolved capability AT CONSTRUCTION TIME, and pass it
  // into registerNeutralRoutes() -> registerSearchRoutes() — never leaving
  // their own request path dependent on embeddings.js's module-scope
  // fallback at request time. Proven here over REAL HTTP, against each
  // app's own real router (no embedQuery override from this test — the
  // whole point is to observe each factory's own internally-built
  // default), by constructing Lite first, then Full — then calling LITE's
  // OWN, already-constructed server's /api/search and confirming it STILL
  // behaves like Lite (typed-unavailable), regardless of what Full's later
  // construction did or didn't do to any shared state.
  function collectionFoundAdapter() {
    return {
      name: () => 'stub',
      capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
      getCollection: async () => ({ name: 'test-collection' }),
      getEmbeddingProfile: async () => ({
        state: 'valid',
        profile: {
          schemaVersion: 1, managedBy: 'semidex',
          embedding: {
            dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
            sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
          },
          embeddingSchemaVersion: 2,
        },
      }),
      searchHybridVectors: async () => [],
    };
  }

  it('Lite\'s own already-running server keeps rejecting with typed not_available_in_lite on /api/search, even after Full\'s createApp() is constructed afterward in the same process', async () => {
    const { createLiteApp } = await import('../../../src/admin/composition/lite.js?http-isolation-check');
    const { createApp } = await import('../../../src/admin/server-full.js?http-isolation-check');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {} });

    // Step 1: construct and start Lite's real server (no embedQuery
    // override — exercising its own internally-built default).
    const liteServer = createLiteApp({ adapter: collectionFoundAdapter(), settingsService });
    await new Promise((resolve) => liteServer.listen(0, '127.0.0.1', resolve));
    const liteBase = `http://127.0.0.1:${liteServer.address().port}`;

    try {
      // Step 2: construct Full's server SECOND, in the same process.
      const fullServer = createApp({ adapter: collectionFoundAdapter(), settingsService });
      fullServer.close();

      // Step 3: Lite's server, constructed and started BEFORE Full ever
      // ran, must still behave like Lite on a real request — its own
      // bound embedQuery closure was captured at construction time.
      const res = await fetch(`${liteBase}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'test-collection', query: 'q' }),
      });
      const body = await res.json();
      assert.equal(res.status, 500, `expected the typed embedding_failed 500 Lite's disabled capability produces, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.error?.code, 'embedding_failed');
      assert.match(body.error?.message ?? '', /not available in Semidex Lite/);
    } finally {
      await new Promise((resolve) => liteServer.close(resolve));
    }
  });

  it('Full\'s own already-running server keeps using its own real-capability embedQuery on /api/search, even after Lite\'s createLiteApp() is constructed afterward in the same process (the mirror-image ordering)', async () => {
    const { createApp } = await import('../../../src/admin/server-full.js?http-isolation-check-2');
    const { createLiteApp } = await import('../../../src/admin/composition/lite.js?http-isolation-check-2');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {} });

    // Step 1: construct and start Full's real server FIRST this time —
    // proves the isolation holds in both construction orders, not just
    // Lite-then-Full. realFetch is captured BEFORE stubbing globalThis.fetch
    // — this test's OWN HTTP call to the local test server must use the
    // real network stack; only ollama.js's internal embed() call (reached
    // through the app under test) should observe the stub.
    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    let fetchCalledWithUrl = null;
    globalThis.fetch = async (url) => {
      fetchCalled = true;
      fetchCalledWithUrl = String(url);
      throw new Error('STUBBED_FETCH_MARKER: no real network call is made by this test');
    };

    const fullServer = createApp({ adapter: collectionFoundAdapter(), settingsService });
    await new Promise((resolve) => fullServer.listen(0, '127.0.0.1', resolve));
    const fullBase = `http://127.0.0.1:${fullServer.address().port}`;

    try {
      // Step 2: construct Lite's server SECOND, in the same process.
      const liteServer = createLiteApp({ adapter: collectionFoundAdapter(), settingsService });
      liteServer.close();

      // Step 3: Full's server, constructed and started BEFORE Lite ever
      // ran, must still attempt the REAL ollama-lazy.js embed path (proven
      // by the stubbed fetch actually being reached) on a real request —
      // this test's OWN call to the local server uses realFetch, captured
      // above, never the stub.
      const res = await realFetch(`${fullBase}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'test-collection', query: 'q' }),
      });
      assert.equal(res.status, 500);
      assert.ok(fetchCalled, 'expected Full\'s own embedQuery to reach the real ollama.js embed() path (and therefore fetch()), not a typed-unavailable rejection');
      assert.ok(fetchCalledWithUrl?.includes('/api/embed'), `expected the real ollama.js embed() to call fetch on /api/embed, got: ${fetchCalledWithUrl}`);
    } finally {
      globalThis.fetch = realFetch;
      await new Promise((resolve) => fullServer.close(resolve));
    }
  });
});
