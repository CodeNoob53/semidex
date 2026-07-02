// Static UI shell serving — offline tests over a real node:http server with
// a stub StorageAdapter. Verifies content types, 404s, traversal guard, and
// that /api routes keep working with static serving enabled.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../src/admin/server.js';
import { resolveStaticPath } from '../../../src/admin/static.js';

function makeStubAdapter() {
  return {
    name: () => 'stub',
    capabilities: () => ({
      namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true,
      aliases: false, snapshots: false, collectionExists: true,
    }),
    ping: async () => ({ ok: true, detail: 'stub reachable' }),
    listCollections: async () => [],
    getCollection: async () => null,
    createCollection: async () => {},
    deleteCollection: async () => {},
    ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
    listSourceDocuments: async () => [],
    getChunk: async () => [],
    searchHybrid: async () => [],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getStructuralNode: async () => null,
  };
}

async function withServer(fn) {
  const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

describe('static UI serving', () => {
  it('GET / returns the HTML shell', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/html/);
      const html = await res.text();
      assert.match(html, /semidex/);
      assert.match(html, /app\.js/);
    });
  });

  it('GET /app.js returns JavaScript with the right content type', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.js');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/javascript/);
      assert.match(await res.text(), /api\/health/);
    });
  });

  it('GET /app.css returns CSS with the right content type', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.css');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/css/);
    });
  });

  it('unknown static path returns 404 with the JSON error envelope', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/no-such-file.js');
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'not_found');
    });
  });

  it('paths without a known extension return 404 (no directory listing)', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/ui');
      assert.equal(res.status, 404);
    });
  });

  it('non-GET methods on static paths return 405', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.js', { method: 'POST' });
      assert.equal(res.status, 405);
      assert.equal((await res.json()).error.code, 'method_not_allowed');
    });
  });

  it('API routes still work with static serving enabled', async () => {
    await withServer(async (base) => {
      const health = await fetch(base + '/api/health');
      assert.equal(health.status, 200);
      assert.equal((await health.json()).storage.backend, 'stub');

      const missing = await fetch(base + '/api/no-such-route');
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, 'not_found');
    });
  });
});

describe('resolveStaticPath — traversal guard', () => {
  it('/ resolves to index.html inside the UI dir', () => {
    const p = resolveStaticPath('/');
    assert.ok(p !== null && p.endsWith('index.html'));
  });

  it('rejects .. traversal out of the UI dir', () => {
    assert.equal(resolveStaticPath('/../server.js'), null);
    assert.equal(resolveStaticPath('/../../core/qdrant.js'), null);
    assert.equal(resolveStaticPath('/..%2F..%2Fserver.js'.replaceAll('%2F', '/')), null);
  });

  it('rejects unknown extensions', () => {
    assert.equal(resolveStaticPath('/app.wasm'), null);
    assert.equal(resolveStaticPath('/data.json5'), null);
  });
});
