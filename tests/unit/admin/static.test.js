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

// ── Phase 2B: search playground presence ────────────────────────────────────
// Browser-level tests are out of scope (no DOM runner in the toolchain);
// these assert the served app.js wires the playground to the right endpoint
// and keeps the evidence-vs-navigation copy. Behavior of /api/search itself
// is covered in search.test.js.
describe('search playground (served app.js)', () => {
  it('app.js posts to /api/search and renders a search panel', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.js');
      assert.equal(res.status, 200);
      const js = await res.text();
      assert.match(js, /apiPost\('\/api\/search'/, 'playground must call POST /api/search');
      assert.match(js, /search-panel/, 'collection view must render the search panel container');
      assert.match(js, /windowFormat/, 'playground must send windowFormat');
      assert.match(js, /sourceFile/, 'playground must support the file filter');
    });
  });

  it('app.js keeps evidence-vs-navigation copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /retrieval evidence/i, 'results must be framed as evidence');
      assert.match(js, /navigation (only|map)/i, 'skeleton summaries must be framed as navigation');
    });
  });

  it('app.js escapes rendered strings (esc used on result fields)', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /esc\(r\.sourceFile/, 'result sourceFile must go through esc()');
      assert.match(js, /esc\(r\.text/, 'result text must go through esc()');
      assert.match(js, /esc\(w\.textSnippet/, 'window snippets must go through esc()');
    });
  });
});

// ── Phase 2C: indexing jobs UI presence ──────────────────────────────────────
// Same served-file-level approach as Phase 2B: no DOM runner in this
// toolchain, so these assert the served app.js/index.html wire the indexing
// view to the right endpoints and keep the required safety copy. Job
// manager/API behavior itself is covered in jobs.test.js.
describe('indexing jobs view (served app.js / index.html)', () => {
  it('index.html links to the indexing view', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      assert.match(html, /#\/index/, 'sidebar must link to the indexing view');
    });
  });

  it('app.js posts to /api/jobs/index with the five typed options', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /apiPost\('\/api\/jobs\/index'/, 'must POST to /api/jobs/index');
      assert.match(js, /onnxEmbed/);
      assert.match(js, /skeletonChunking/);
      assert.match(js, /skeletonNav/);
      assert.match(js, /pruneStale/);
      assert.match(js, /tagGen/);
    });
  });

  it('app.js fetches the job list and a single job\'s detail/log', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /api\('\/api\/jobs'\)/, 'must GET the job list');
      assert.match(js, /\/api\/jobs\/\$\{/, 'must GET a single job by id');
    });
  });

  it('app.js supports cancelling a job via POST /api/jobs/:id/cancel', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /\/cancel/);
    });
  });

  it('app.js keeps the required safety copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Indexing writes to the selected collection/);
      assert.match(js, /Prune stale should be used only with the full source root/);
    });
  });

  it('app.js refreshes the sidebar after a job succeeds', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /loadSidebar\(\)/);
    });
  });
});

// ── Phase 2D: collection maintenance panel presence ──────────────────────────
// Same served-file-level approach: no DOM runner, so these assert the served
// app.js wires the maintenance panel to the right endpoints and keeps the
// required safety behavior/copy. API behavior is covered in server.test.js.
describe('collection maintenance panel (served app.js)', () => {
  it('collection detail view renders a maintenance panel container', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /col-maint/, 'collection detail must render a maintenance panel container');
      assert.match(js, /initMaintenancePanel/);
    });
  });

  it('app.js posts to /api/collections/:name/sync-schema from the maintenance panel', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /apiPost\(`\/api\/collections\/\$\{encodeURIComponent\(name\)\}\/sync-schema`/);
    });
  });

  it('app.js can start /api/jobs/index from maintenance with the current collection name prefilled', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /runMaintenanceReindex/);
      // collection is taken from the current view's `name`, never a second
      // text input the user would have to retype.
      assert.match(js, /collection:\s*name,[\s\S]{0,80}path,/);
    });
  });

  it('app.js requires a source path before starting a maintenance reindex', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Source path is required/);
    });
  });

  it('app.js requires exact collection-name confirmation before enabling delete', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /deleteBtn\.disabled = confirmInput\.value !== name/);
    });
  });

  it('app.js calls DELETE /api/collections/:name with the typed confirmation, not the known collection name', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /method:\s*'DELETE'/);
      assert.match(js, /apiDelete\(`\/api\/collections\/\$\{encodeURIComponent\(name\)\}`/);
      // The confirm value sent to the server must come from what the user
      // actually typed into the input, not be silently substituted with the
      // already-known-good collection name — otherwise a wrongly-enabled
      // button would still send a valid confirm regardless of input content.
      assert.match(js, /const confirm = \$\('#maint-delete-confirm'\)\.value/);
      assert.match(js, /apiDelete\(`\/api\/collections\/\$\{encodeURIComponent\(name\)\}`,\s*\{\s*confirm\s*\}\)/);
      assert.ok(!/\{\s*confirm:\s*name\s*\}/.test(js), 'must not send the known collection name as confirm instead of the typed value');
    });
  });

  it('app.js keeps the required reindex/prune-stale safety copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Reindex starts a background job and writes to this collection/);
      assert.match(js, /Use prune stale only with the full source root/);
    });
  });

  it('app.js navigates away from the deleted collection after a successful delete', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /runDeleteCollection[\s\S]{0,800}location\.hash = '#\/'/);
    });
  });
});
