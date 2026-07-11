// End-to-end Local API tests over a real node:http server bound to
// 127.0.0.1:0 (OS-assigned free port), driven with a stub StorageAdapter —
// no live Qdrant, no env requirements.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, resolveHostConfig, resolvePortConfig } from '../../../src/admin/server.js';

function makeStubAdapter(overrides = {}) {
  return {
    name: () => 'stub',
    capabilities: () => ({
      namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true,
      aliases: false, snapshots: false, collectionExists: true,
    }),
    ping: async () => ({ ok: true, detail: 'stub reachable' }),
    listCollections: async () => [{ name: 'demo', pointCount: 5 }],
    getCollection: async (name) => (name === 'demo' ? { name: 'demo', pointCount: 5 } : null),
    createCollection: async () => {},
    deleteCollection: async () => {},
    ensureCollectionSchema: async () => ({ repaired: ['index x'], warnings: [] }),
    listSourceDocuments: async () => [],
    getChunk: async () => [],
    getFileChunks: async () => [],
    searchHybrid: async () => [],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getStructuralNode: async () => null,
    getSectionAnchor: async () => null,
    ...overrides,
  };
}

async function withServer(adapter, fn) {
  const app = createApp({ adapter });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const port = app.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

describe('GET /api/health', () => {
  it('reports ok: true for a healthy stub adapter', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/health');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.storage.backend, 'stub');
      assert.equal(body.storage.ok, true);
    });
  });

  it('reports ok: false (still HTTP 200) for a failing stub adapter', async () => {
    const adapter = makeStubAdapter({ ping: async () => ({ ok: false, detail: 'connection refused' }) });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/health');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.storage.detail, 'connection refused');
    });
  });
});

describe('GET /api/capabilities', () => {
  it('returns the adapter backend name and capabilities', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/capabilities');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.backend, 'stub');
      assert.equal(body.capabilities.hybridSearch, true);
      assert.equal(body.capabilities.aliases, false);
    });
  });
});

describe('GET /api/collections', () => {
  it('returns the adapter collection list', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(body.collections, [{ name: 'demo', pointCount: 5 }]);
    });
  });
});

describe('GET /api/collections/:name', () => {
  it('returns collection detail when found', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/demo');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.collection.name, 'demo');
    });
  });

  it('returns a 404 JSON error when not found', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/missing');
      const body = await res.json();
      assert.equal(res.status, 404);
      assert.equal(body.error.code, 'not_found');
      assert.match(body.error.message, /missing/);
    });
  });

  it('URL-decodes a collection name containing special characters', async () => {
    const adapter = makeStubAdapter({
      getCollection: async (name) => (name === 'my collection' ? { name, pointCount: 1 } : null),
    });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/my%20collection');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.collection.name, 'my collection');
    });
  });
});

describe('POST /api/collections/:name/sync-schema', () => {
  it('runs ensureCollectionSchema and returns repaired/warnings', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/demo/sync-schema', { method: 'POST' });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.collection, 'demo');
      assert.deepEqual(body.repaired, ['index x']);
      assert.deepEqual(body.warnings, []);
      // Phase 3S: the task id lets the frontend open the operation modal on
      // this exact repair deterministically (settings-view.js's
      // runSettingsRepair()) instead of guessing "the newest operation in
      // the store."
      assert.equal(typeof body.id, 'string');
      assert.ok(body.id.length > 0);
    });
  });

  it('returns 404 for a missing collection without calling ensureCollectionSchema', async () => {
    let ensureCalled = false;
    const adapter = makeStubAdapter({
      ensureCollectionSchema: async () => { ensureCalled = true; return { repaired: [], warnings: [] }; },
    });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/missing/sync-schema', { method: 'POST' });
      const body = await res.json();
      assert.equal(res.status, 404);
      assert.equal(body.error.code, 'not_found');
      assert.equal(ensureCalled, false);
    });
  });

  // Regression (P1, code review): task-registry.js correctly redacts
  // task.error for GET /api/operations, but ensureCollectionSchema()
  // rejecting is a genuinely UNEXPECTED error from this route's own point
  // of view (not a deliberate HttpError) — it propagates straight to
  // router.js's catch-all 500 handler, bypassing task-registry.js's
  // redaction entirely. This test targets the actual POST /sync-schema
  // HTTP response body directly (settings-view.js's runSettingsRepair()
  // displays err.message from exactly this response verbatim in the
  // settings page's inline error box) — not GET /api/operations, which
  // task-registry.test.js/operations.test.js already cover for the
  // (separately redacted) task.error field.
  it('does not leak a credentialed Qdrant URL/key in the POST /sync-schema response itself when ensureCollectionSchema rejects', async () => {
    const originalKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'sk-super-secret-token';
    try {
      const adapter = makeStubAdapter({
        ensureCollectionSchema: async () => {
          throw new Error('auth failed with key sk-super-secret-token at https://user:pass@qdrant.example.com/x');
        },
      });
      await withServer(adapter, async (base) => {
        const res = await fetch(base + '/api/collections/demo/sync-schema', { method: 'POST' });
        const body = await res.json();
        assert.equal(res.status, 500);
        assert.doesNotMatch(body.error.message, /sk-super-secret-token|user:pass/,
          'the raw key/credentials must never reach the sync-schema POST response, the exact response settings-view.js displays to the user');
        assert.match(body.error.message, /\[REDACTED\]/);
      });
    } finally {
      process.env.QDRANT_KEY = originalKey;
    }
  });
});

describe('DELETE /api/collections/:name', () => {
  it('returns 404 for a missing collection without calling adapter.deleteCollection', async () => {
    let deleteCalled = false;
    const adapter = makeStubAdapter({
      deleteCollection: async () => { deleteCalled = true; },
    });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/missing', { method: 'DELETE' });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'not_found');
      assert.equal(deleteCalled, false);
    });
  });

  it('calls adapter.deleteCollection and returns a clean domain response, no request body required', async () => {
    let deletedWith = null;
    const adapter = makeStubAdapter({
      deleteCollection: async (name) => { deletedWith = name; },
    });
    await withServer(adapter, async (base) => {
      // No body at all — confirmation is a UI-level modal, not an API contract.
      const res = await fetch(base + '/api/collections/demo', { method: 'DELETE' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, { collection: 'demo', deleted: true });
      assert.equal(deletedWith, 'demo');
    });
  });
});

describe('GET /api/collections/:name/documents', () => {
  it('returns docs for an existing collection', async () => {
    const adapter = makeStubAdapter({
      listSourceDocuments: async () => [{ sourceFile: 'a.md', chunkCount: 3, firstSection: 'Intro', tags: [] }],
    });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/documents');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.collection, 'demo');
      assert.equal(body.documents.length, 1);
    });
  });

  it('returns 404 for a missing collection', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/missing/documents');
      assert.equal(res.status, 404);
    });
  });

  it('forwards prefix to the adapter', async () => {
    let received = null;
    const adapter = makeStubAdapter({
      listSourceDocuments: async (name, opts) => { received = opts; return []; },
    });
    await withServer(adapter, async (base) => {
      await fetch(base + '/api/collections/demo/documents?prefix=docs/');
      assert.equal(received.prefix, 'docs/');
    });
  });

  it('defaults limit to 100', async () => {
    let received = null;
    const adapter = makeStubAdapter({
      listSourceDocuments: async (name, opts) => { received = opts; return []; },
    });
    await withServer(adapter, async (base) => {
      await fetch(base + '/api/collections/demo/documents');
      assert.equal(received.limit, 100);
    });
  });

  it('rejects limit < 1 with 400', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/demo/documents?limit=0');
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'bad_request');
    });
  });

  it('clamps limit > 1000 to 1000 rather than rejecting', async () => {
    let received = null;
    const adapter = makeStubAdapter({
      listSourceDocuments: async (name, opts) => { received = opts; return []; },
    });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/documents?limit=5000');
      assert.equal(res.status, 200);
      assert.equal(received.limit, 1000);
    });
  });
});

describe('GET /api/collections/:name/chunks', () => {
  it('returns the chunk list', async () => {
    const adapter = makeStubAdapter({
      getChunk: async (name, sourceFile, chunkIndex) => [{ sourceFile, chunkIndex, text: 'hi' }],
    });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/chunks?sourceFile=a.md&chunkIndex=4');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.sourceFile, 'a.md');
      assert.equal(body.chunkIndex, 4);
      assert.equal(body.window, 0);
      assert.equal(body.chunks.length, 1);
    });
  });

  it('requires sourceFile', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/demo/chunks?chunkIndex=4');
      assert.equal(res.status, 400);
    });
  });

  it('omitting chunkIndex switches to whole-file mode (getFileChunks), not a 400', async () => {
    // Phase 3F: chunkIndex used to be required, forcing every caller
    // (including "open this file fresh, no specific chunk in mind") to
    // approximate "the whole file" as a window centered on chunk 0. It's
    // now optional — omitting it entirely asks for the real, complete
    // chunk list for the file via adapter.getFileChunks(), a distinct
    // adapter method from the windowed adapter.getChunk().
    let receivedSourceFile = null;
    const adapter = makeStubAdapter({
      getFileChunks: async (name, sourceFile) => { receivedSourceFile = sourceFile; return [{ sourceFile, chunkIndex: 0, text: 'hi' }, { sourceFile, chunkIndex: 1, text: 'bye' }]; },
    });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/chunks?sourceFile=a.md');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(receivedSourceFile, 'a.md');
      assert.equal(body.chunkIndex, null, 'chunkIndex is null in whole-file mode, not the requested-but-absent value');
      assert.equal(body.window, null);
      assert.equal(body.chunks.length, 2);
    });
  });

  it('whole-file mode (no chunkIndex) never calls the windowed getChunk adapter method', async () => {
    let getChunkCalled = false;
    const adapter = makeStubAdapter({
      getChunk: async () => { getChunkCalled = true; return []; },
      getFileChunks: async () => [],
    });
    await withServer(adapter, async (base) => {
      await fetch(base + '/api/collections/demo/chunks?sourceFile=a.md');
      assert.equal(getChunkCalled, false, 'whole-file mode must go through getFileChunks, not getChunk');
    });
  });

  it('an explicit chunkIndex still uses the windowed getChunk adapter method, not getFileChunks', async () => {
    let getFileChunksCalled = false;
    const adapter = makeStubAdapter({
      getChunk: async (name, sourceFile, chunkIndex) => [{ sourceFile, chunkIndex, text: 'hi' }],
      getFileChunks: async () => { getFileChunksCalled = true; return []; },
    });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/chunks?sourceFile=a.md&chunkIndex=4');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.chunkIndex, 4, 'an explicit chunkIndex must be echoed back as a real number, unchanged from before');
      assert.equal(getFileChunksCalled, false, 'a windowed request must not also call getFileChunks');
    });
  });

  it('rejects a non-integer chunkIndex', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/demo/chunks?sourceFile=a.md&chunkIndex=abc');
      assert.equal(res.status, 400);
    });
  });

  it('rejects a negative chunkIndex', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/demo/chunks?sourceFile=a.md&chunkIndex=-1');
      assert.equal(res.status, 400);
    });
  });

  it('defaults window to 0', async () => {
    let received = null;
    const adapter = makeStubAdapter({
      getChunk: async (name, sourceFile, chunkIndex, opts) => { received = opts; return []; },
    });
    await withServer(adapter, async (base) => {
      await fetch(base + '/api/collections/demo/chunks?sourceFile=a.md&chunkIndex=0');
      assert.equal(received.window, 0);
    });
  });

  it('rejects a negative window', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/demo/chunks?sourceFile=a.md&chunkIndex=0&window=-1');
      assert.equal(res.status, 400);
    });
  });

  it('rejects a window above the max (5) rather than clamping it', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/demo/chunks?sourceFile=a.md&chunkIndex=0&window=99');
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error.message, /must be <= 5/);
    });
  });

  it('returns 200 with an empty chunks array rather than 404 when the adapter finds nothing', async () => {
    const adapter = makeStubAdapter({ getChunk: async () => [] });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/chunks?sourceFile=missing.md&chunkIndex=0');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(body.chunks, []);
    });
  });
});

describe('GET /api/collections/:name/skeleton', () => {
  it('returns the skeleton root', async () => {
    const adapter = makeStubAdapter({ getSkeletonRoot: async () => ({ nodeType: 'collection', nodeId: 'root' }) });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.skeleton.nodeId, 'root');
    });
  });

  it('returns skeleton: null when the collection has no skeleton layer', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.skeleton, null);
    });
  });

  it('returns 404 for a missing collection', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/missing/skeleton');
      assert.equal(res.status, 404);
    });
  });
});

describe('GET /api/collections/:name/skeleton/node', () => {
  const nodeAdapter = makeStubAdapter({
    getSkeletonNode: async (name, opts) => (opts.nodeId === 'n1' || opts.nodePath === 'p1' ? { nodeType: 'section', ...opts } : null),
  });

  it('works with nodeId', async () => {
    await withServer(nodeAdapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton/node?nodeId=n1');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.node.nodeId, 'n1');
    });
  });

  it('works with nodePath', async () => {
    await withServer(nodeAdapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton/node?nodePath=p1');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.node.nodePath, 'p1');
    });
  });

  it('rejects when neither nodeId nor nodePath is provided', async () => {
    await withServer(nodeAdapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton/node');
      assert.equal(res.status, 400);
    });
  });

  it('rejects when both nodeId and nodePath are provided', async () => {
    await withServer(nodeAdapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton/node?nodeId=n1&nodePath=p1');
      assert.equal(res.status, 400);
    });
  });

  it('returns 404 when the adapter returns null', async () => {
    await withServer(nodeAdapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton/node?nodeId=missing');
      assert.equal(res.status, 404);
    });
  });
});

describe('GET /api/collections/:name/skeleton/children', () => {
  it('works with nodeId', async () => {
    const adapter = makeStubAdapter({ getSkeletonChildren: async (name, opts) => [{ nodeType: 'file', parent: opts.nodeId }] });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton/children?nodeId=n1');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.children[0].parent, 'n1');
    });
  });

  it('works with nodePath', async () => {
    const adapter = makeStubAdapter({ getSkeletonChildren: async (name, opts) => [{ nodeType: 'file', parent: opts.nodePath }] });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton/children?nodePath=p1');
      const body = await res.json();
      assert.equal(body.children[0].parent, 'p1');
    });
  });

  it('defaults limit to 50', async () => {
    let received = null;
    const adapter = makeStubAdapter({ getSkeletonChildren: async (name, opts) => { received = opts; return []; } });
    await withServer(adapter, async (base) => {
      await fetch(base + '/api/collections/demo/skeleton/children?nodeId=n1');
      assert.equal(received.limit, 50);
    });
  });

  it('rejects an invalid limit', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton/children?nodeId=n1&limit=0');
      assert.equal(res.status, 400);
    });
  });

  it('returns a children array', async () => {
    const adapter = makeStubAdapter({ getSkeletonChildren: async () => [{ nodeType: 'file' }, { nodeType: 'file' }] });
    await withServer(adapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/skeleton/children?nodeId=n1');
      const body = await res.json();
      assert.equal(body.children.length, 2);
    });
  });
});

describe('GET /api/collections/:name/node', () => {
  const structAdapter = makeStubAdapter({
    getStructuralNode: async (name, opts) => (opts.nodeId === 'n1' || opts.nodePath === 'p1' ? { nodeType: 'table', ...opts } : null),
  });

  it('works with nodeId', async () => {
    await withServer(structAdapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/node?nodeId=n1');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.node.nodeId, 'n1');
    });
  });

  it('works with nodePath', async () => {
    await withServer(structAdapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/node?nodePath=p1');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.node.nodePath, 'p1');
    });
  });

  it('rejects when neither nodeId nor nodePath is provided', async () => {
    await withServer(structAdapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/node');
      assert.equal(res.status, 400);
    });
  });

  it('rejects when both nodeId and nodePath are provided', async () => {
    await withServer(structAdapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/node?nodeId=n1&nodePath=p1');
      assert.equal(res.status, 400);
    });
  });

  it('returns 404 when the adapter returns null', async () => {
    await withServer(structAdapter, async (base) => {
      const res = await fetch(base + '/api/collections/demo/node?nodeId=missing');
      assert.equal(res.status, 404);
    });
  });
});

describe('unknown routes and methods', () => {
  it('returns 404 with a JSON error envelope for an unknown path', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      const res = await fetch(base + '/api/does-not-exist');
      const body = await res.json();
      assert.equal(res.status, 404);
      assert.equal(body.error.code, 'not_found');
    });
  });

  it('returns 404 for a known path called with an unsupported method (consistent with unknown-route status)', async () => {
    await withServer(makeStubAdapter(), async (base) => {
      // PUT is not registered anywhere in this API (only GET/POST/DELETE are).
      const res = await fetch(base + '/api/collections/demo', { method: 'PUT' });
      const body = await res.json();
      assert.equal(res.status, 404);
      assert.equal(body.error.code, 'not_found');
    });
  });
});

describe('resolveHostConfig', () => {
  it('defaults to 127.0.0.1', () => {
    assert.deepEqual(resolveHostConfig({}), { host: '127.0.0.1', allowRemote: false });
  });

  it('accepts localhost and ::1 as loopback', () => {
    assert.equal(resolveHostConfig({ ADMIN_HOST: 'localhost' }).host, 'localhost');
    assert.equal(resolveHostConfig({ ADMIN_HOST: '::1' }).host, '::1');
  });

  it('rejects a non-loopback host by default', () => {
    assert.throws(() => resolveHostConfig({ ADMIN_HOST: '0.0.0.0' }), /loopback/);
  });

  it('allows a non-loopback host when ADMIN_ALLOW_REMOTE=1', () => {
    const cfg = resolveHostConfig({ ADMIN_HOST: '0.0.0.0', ADMIN_ALLOW_REMOTE: '1' });
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.allowRemote, true);
  });
});

describe('resolvePortConfig', () => {
  it('defaults to 8642', () => {
    assert.equal(resolvePortConfig({}), 8642);
  });

  it('accepts a valid custom port', () => {
    assert.equal(resolvePortConfig({ ADMIN_PORT: '9000' }), 9000);
  });

  it('rejects a non-numeric port', () => {
    assert.throws(() => resolvePortConfig({ ADMIN_PORT: 'abc' }), /not a valid port/);
  });

  it('rejects an out-of-range port', () => {
    assert.throws(() => resolvePortConfig({ ADMIN_PORT: '70000' }), /not a valid port/);
  });
});

describe('layering — src/admin/ never imports Qdrant directly', () => {
  const FORBIDDEN = [
    /from\s+['"][^'"]*core\/qdrant\/store\.js['"]/,
    /from\s+['"]@qdrant\/js-client-rest['"]/,
    /from\s+['"][^'"]*core\/qdrant\/client\.js['"]/,
  ];

  function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (entry.endsWith('.js')) out.push(full);
    }
    return out;
  }

  it('no file under src/admin/ imports the Qdrant store, client, or SDK directly', () => {
    const dir = fileURLToPath(new URL('../../../src/admin/', import.meta.url)).replace(/\/$/, '');
    const offenders = [];
    for (const file of walk(dir)) {
      const content = readFileSync(file, 'utf-8');
      if (FORBIDDEN.some((re) => re.test(content))) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `src/admin/ must depend on StorageAdapter only: ${offenders.join(', ')}`);
  });
});
