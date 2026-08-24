// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md
// ("Cache-Control: no-store" — tracked there as open, closed by
// core/http/cache-policy.js). Proves the route-aware Cache-Control policy
// actually reaches every response shape this process can send — not just
// that the helper functions in cache-policy.js return the right string in
// isolation, but that the real HTTP path (router.js, static.js,
// register-neutral-routes.js, sse.js) wires them in correctly, fail-safe,
// for BOTH the Full and Lite compositions.
//
// Static-asset fixtures are deterministic temp directories built per test
// (see makeUiFixture/makeEmptyUiDir below), never the real dist/admin-ui —
// that build output may or may not exist in a given checkout, and even
// when it does, its actual hashed filenames change on every rebuild. Both
// createApp() and createLiteApp() accept an optional `uiDir` DI parameter
// (added alongside this policy) specifically so this suite does not have
// to depend on either.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../../src/admin/server-full.js';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { createAskCoordinatorBundle } from '../../../src/core/ask/coordinator-v2.js';
import { ASK_PATH } from '../../../src/core/ask-api/v2/contract.js';
import { withServer as withFullApp } from '../admin/ui-test-helpers.js';
import { OPEN_INTEGRATION_POLICY } from './test-integration-policy.js';

function makeStubAdapter() {
  return {
    name: () => 'stub',
    capabilities: () => ({}),
    ping: async () => ({ ok: true }),
    listCollections: async () => [],
    getCollection: async () => null,
  };
}

function makeFakeChildForSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

async function withLiteApp(fn, extraOptions = {}) {
  const jobRegistry = createJobRegistry({
    spawnIndexer: () => makeFakeChildForSpawn(),
    baseEnv: {},
  });
  const app = createLiteApp({
    adapter: makeStubAdapter(),
    embedQuery: async () => ({ dense: [], sparse: {} }),
    jobRegistry,
    integrationPolicy: OPEN_INTEGRATION_POLICY,
    ...extraOptions,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A real, built-looking UI dir: an HTML shell, a fingerprinted JS+CSS pair
// (the exact `assets/<name>-<hash>.<ext>` shape Vite's default output uses
// — see cache-policy.js's own FINGERPRINTED_ASSET_PATTERN comment), a
// non-fingerprinted asset (logo.svg, plausible unhashed favicon-style
// file), and a plain non-fingerprinted top-level script (main.js) used only
// to exercise the 405 branch.
function makeUiFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'semidex-cache-policy-ui-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>fixture shell</body></html>');
  writeFileSync(join(dir, 'main.js'), 'console.log("unfingerprinted");');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'index-ABCDEFGH.js'), 'console.log("fixture bundle");');
  writeFileSync(join(dir, 'assets', 'index-ABCDEFGH.css'), 'body { color: red; }');
  writeFileSync(join(dir, 'assets', 'logo.svg'), '<svg></svg>');
  return dir;
}

// No index.html at all -> handleStatic()'s "UI not built" 503 branch.
function makeEmptyUiDir() {
  const dir = mkdtempSync(join(tmpdir(), 'semidex-cache-policy-empty-ui-'));
  tempDirs.push(dir);
  return dir;
}

function assertNoStore(res, label) {
  assert.equal(res.headers.get('cache-control'), 'no-store', `${label}: Cache-Control must be exactly "no-store"`);
}

function assertImmutable(res, label) {
  const cc = res.headers.get('cache-control') ?? '';
  assert.match(cc, /\bpublic\b/, `${label}: must be public`);
  assert.match(cc, /\bimmutable\b/, `${label}: must be immutable`);
  assert.match(cc, /max-age=31536000/, `${label}: must carry a long max-age`);
}

// Applies regardless of which branch produced the response — the
// pre-existing security-header policy (request-security.js) must never
// regress while this cache policy is layered on top of it, and no CORS
// header should ever appear (no route in this app answers OPTIONS or sets
// Access-Control-Allow-Origin).
function assertBaselineSecurityHeaders(res, label) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${label}: X-Content-Type-Options`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY', `${label}: X-Frame-Options`);
  assert.equal(res.headers.get('access-control-allow-origin'), null, `${label}: must not set CORS`);
}

for (const [label, withApp] of [['Full', withFullApp], ['Lite', withLiteApp]]) {
  describe(`${label} composition — Cache-Control policy`, () => {
    describe('API surface (/api/**) — always no-store', () => {
      it('success response (GET /api/health)', async () => {
        await withApp(async (base) => {
          const res = await fetch(base + '/api/health');
          assert.equal(res.status, 200);
          assertNoStore(res, 'API success');
          assertBaselineSecurityHeaders(res, 'API success');
        });
      });

      it('404 response (unknown route)', async () => {
        await withApp(async (base) => {
          const res = await fetch(base + '/api/this-route-does-not-exist');
          assert.equal(res.status, 404);
          assertNoStore(res, 'API 404');
        });
      });

      it('malformed request error (bad percent-encoding -> 400)', async () => {
        await withApp(async (base) => {
          const res = await fetch(base + '/api/collections/%E0%A4%A');
          assert.equal(res.status, 400);
          assertNoStore(res, 'API malformed request');
        });
      });

      it('pre-dispatch rejection (cross-site POST -> 403) still carries no-store', async () => {
        await withApp(async (base) => {
          const res = await fetch(base + '/api/jobs/index', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: 'https://attacker.example',
              'Sec-Fetch-Site': 'cross-site',
            },
            body: JSON.stringify({ collection: 'c', path: '.' }),
          });
          assert.equal(res.status, 403);
          assertNoStore(res, 'API cross-site rejection');
        });
      });
    });

    describe('static Admin UI — conservative default, immutable only for real fingerprinted assets', () => {
      it('HTML shell (GET /) is not stored', async () => {
        const uiDir = makeUiFixture();
        await withApp(async (base) => {
          const res = await fetch(base + '/');
          assert.equal(res.status, 200);
          assertNoStore(res, 'HTML shell');
          assertBaselineSecurityHeaders(res, 'HTML shell');
        }, { uiDir });
      });

      it('fingerprinted JS asset gets long-lived immutable caching', async () => {
        const uiDir = makeUiFixture();
        await withApp(async (base) => {
          const res = await fetch(base + '/assets/index-ABCDEFGH.js');
          assert.equal(res.status, 200);
          assertImmutable(res, 'fingerprinted JS');
          assertBaselineSecurityHeaders(res, 'fingerprinted JS');
        }, { uiDir });
      });

      it('fingerprinted CSS asset gets long-lived immutable caching', async () => {
        const uiDir = makeUiFixture();
        await withApp(async (base) => {
          const res = await fetch(base + '/assets/index-ABCDEFGH.css');
          assert.equal(res.status, 200);
          assertImmutable(res, 'fingerprinted CSS');
        }, { uiDir });
      });

      it('non-fingerprinted static asset (logo.svg) is NOT immutable', async () => {
        const uiDir = makeUiFixture();
        await withApp(async (base) => {
          const res = await fetch(base + '/assets/logo.svg');
          assert.equal(res.status, 200);
          assertNoStore(res, 'non-fingerprinted asset');
        }, { uiDir });
      });

      it('static 404 (unknown asset path) is not immutable', async () => {
        const uiDir = makeUiFixture();
        await withApp(async (base) => {
          const res = await fetch(base + '/no-such-asset.js');
          assert.equal(res.status, 404);
          assertNoStore(res, 'static 404');
        }, { uiDir });
      });

      it('a 404 for a PATH THAT LOOKS FINGERPRINTED but names no real file stays no-store', async () => {
        // The critical fail-safe case: matching the /assets/<name>-<hash>.js
        // SHAPE is not enough on its own — cache-policy.js's immutable
        // branch only fires after static.js has actually read a real file
        // from disk. A nonexistent asset at a plausible-looking hashed path
        // must never be cached for a year as a 404.
        const uiDir = makeUiFixture();
        await withApp(async (base) => {
          const res = await fetch(base + '/assets/index-NOTAREALFILE.js');
          assert.equal(res.status, 404);
          assertNoStore(res, 'fake-fingerprinted 404');
        }, { uiDir });
      });

      it('static 405 (non-GET method) is not immutable', async () => {
        const uiDir = makeUiFixture();
        await withApp(async (base) => {
          const res = await fetch(base + '/main.js', { method: 'POST' });
          assert.equal(res.status, 405);
          assertNoStore(res, 'static 405');
        }, { uiDir });
      });

      it('static 503 (UI not built) is not immutable', async () => {
        const uiDir = makeEmptyUiDir();
        await withApp(async (base) => {
          const res = await fetch(base + '/');
          assert.equal(res.status, 503);
          assertNoStore(res, 'static 503 (not built)');
        }, { uiDir });
      });

      it('HEAD matches GET for the HTML shell', async () => {
        const uiDir = makeUiFixture();
        await withApp(async (base) => {
          const getRes = await fetch(base + '/');
          const headRes = await fetch(base + '/', { method: 'HEAD' });
          assert.equal(headRes.status, getRes.status);
          assert.equal(headRes.headers.get('cache-control'), getRes.headers.get('cache-control'));
          assert.equal(headRes.headers.get('content-type'), getRes.headers.get('content-type'));
        }, { uiDir });
      });

      it('HEAD matches GET for a fingerprinted asset', async () => {
        const uiDir = makeUiFixture();
        await withApp(async (base) => {
          const getRes = await fetch(base + '/assets/index-ABCDEFGH.js');
          const headRes = await fetch(base + '/assets/index-ABCDEFGH.js', { method: 'HEAD' });
          assert.equal(headRes.status, getRes.status);
          assert.equal(headRes.headers.get('cache-control'), getRes.headers.get('cache-control'));
          assertImmutable(headRes, 'HEAD fingerprinted JS');
          assert.equal(headRes.headers.get('content-type'), getRes.headers.get('content-type'));
        }, { uiDir });
      });
    });
  });
}

// Dedicated regression test for the SSE Ask stream (POST /api/v1|v2/ask):
// sse.js's startSse() sets its own Cache-Control via res.writeHead(), and
// writeHead's headers argument REPLACES rather than merges with a
// same-named header already set via res.setHeader() — so it was possible
// for a streamed Ask response to silently drop the router's no-store and
// carry only the SSE-specific `no-cache, no-transform` instead. This proves
// the streamed success path, not just the JSON success path, satisfies
// "every /api/** response carries no-store" (requirement 1's "success"
// case). Full only: v1/v2/route.js is shared with Lite via the same
// registerNeutralRoutes()/coordinator-v2.js wiring, so this is not a
// Full-vs-Lite behavior split, just one composition root's worth of
// end-to-end proof.
describe('Ask SSE stream (POST /api/v2/ask) — success also carries no-store', () => {
  const VALID_PROFILE = {
    schemaVersion: 1, managedBy: 'semidex',
    embedding: {
      dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
      sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
    },
    embeddingSchemaVersion: 2,
  };
  const HIT = {
    sourceFile: 'docs/en/configuration.md', chunkIndex: 4, section: 'Qdrant',
    text: 'QDRANT_URL points at the Qdrant instance.',
    nodeType: null, nodeId: null, nodePath: null, score: 0.03,
  };

  function makeAskStubAdapter() {
    return {
      name: () => 'stub',
      capabilities: () => ({ namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true }),
      ping: async () => ({ ok: true, detail: 'stub reachable' }),
      listCollections: async () => [{ name: 'demo' }],
      getCollection: async (name) => (name === 'demo' ? { name: 'demo', pointCount: 5 } : null),
      createCollection: async () => {},
      deleteCollection: async () => {},
      ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
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

  function makeAskStubProvider() {
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
    };
  }

  it('a real streamed answer response carries Cache-Control: no-store', async () => {
    const adapter = makeAskStubAdapter();
    const embedQuery = async () => ({ dense: [0.1, 0.2], sparse: { indices: [1], values: [0.5] } });
    const countTokens = (text) => (text ?? '').split(/\s+/).filter(Boolean).length;
    const { v1, v2, gate } = createAskCoordinatorBundle({
      adapter, embedQuery, countTokens, generationProvider: makeAskStubProvider(),
      settingsService: undefined, cloudEmbed: undefined,
    });
    const app = createApp({
      adapter, embedQuery, askCoordinators: { v1, v2, gate }, integrationPolicy: OPEN_INTEGRATION_POLICY,
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      const res = await fetch(base + ASK_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'demo', question: 'What is the value?' }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      const cc = res.headers.get('cache-control') ?? '';
      assert.match(cc, /\bno-store\b/, `Ask SSE stream: Cache-Control ("${cc}") must include no-store`);
      await res.text(); // drain the stream before closing the server
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });
});
