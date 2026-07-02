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
    searchHybrid: async () => [],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getStructuralNode: async () => null,
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
      const res = await fetch(base + '/api/collections/demo', { method: 'DELETE' });
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
