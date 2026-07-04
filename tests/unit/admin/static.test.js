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
    getSectionAnchor: async () => null,
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

// ── Phase 2E: "Search this collection" (renamed from Search playground) ─────
// Browser-level tests are out of scope (no DOM runner in the toolchain);
// these assert the served app.js wires search to the right endpoint, keeps
// the evidence-vs-navigation copy, and defaults to the human-readable "full"
// window format with advanced controls collapsed. Behavior of /api/search
// itself is covered in search.test.js.
describe('search this collection (served app.js)', () => {
  it('app.js posts to /api/search and renders a search panel', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.js');
      assert.equal(res.status, 200);
      const js = await res.text();
      assert.match(js, /apiPost\('\/api\/search'/, 'search must call POST /api/search');
      assert.match(js, /search-panel/, 'collection view must render the search panel container');
      assert.match(js, /windowFormat/, 'search must send windowFormat');
      assert.match(js, /sourceFile/, 'search must support the file filter');
    });
  });

  it('is labeled "Search this collection", not "Search playground"', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Search this collection/);
      assert.ok(!/Search playground/.test(js), 'old "Search playground" label must not remain');
    });
  });

  it('defaults the window format to full, not compact', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /data-v="full" class="on"/, 'full must be the default-selected segmented option');
      assert.ok(!/data-v="compact" class="on"/.test(js), 'compact must not be the default');
    });
  });

  it('defaults the score display to off (an advanced/debug opt-in, not shown by default)', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const checkboxTag = js.slice(js.indexOf('id="q-show-score"') - 40, js.indexOf('id="q-show-score"') + 30);
      assert.ok(!/\bchecked\b/.test(checkboxTag), `score checkbox must not be checked by default: ${checkboxTag}`);
    });
  });

  it('hides advanced controls (window, format, score, file filter) behind a collapsible disclosure', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /<details class="advanced-box">/);
      assert.match(js, /<summary>Advanced<\/summary>/);
    });
  });

  it('the default visible controls are just query, top-k, and submit', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /search-main-row/);
      assert.match(js, /id="q-top"/);
    });
  });

  it('app.js keeps evidence-vs-navigation copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /retrieval evidence/i, 'results must be framed as evidence');
      assert.match(js, /navigation only/i, 'sidebar tree must be framed as navigation');
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

  it('app.js posts to /api/jobs/index with the six typed options', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /apiPost\('\/api\/jobs\/index'/, 'must POST to /api/jobs/index');
      assert.match(js, /onnxEmbed/);
      assert.match(js, /llmSummaries/);
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

// ── Phase 2E: navigation-first dashboard redesign ────────────────────────────
// Same served-file-level approach: no DOM runner, so these assert the served
// app.js wires the sidebar tree, collection header, file/section view, and
// collection settings correctly, and that the old flat panels/type-to-confirm
// UI are gone. API behavior is covered in server.test.js/jobs.test.js.
describe('sidebar navigation tree (served app.js)', () => {
  it('renders collections as an expandable tree, not a flat link list', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /function renderSidebarList/);
      assert.match(js, /tree-collection-row/);
      assert.match(js, /tree-children/);
    });
  });

  it('loads the skeleton tree for a selected collection, falling back to a flat file list', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /async function loadSidebarTree/);
      assert.match(js, /hasSkeleton/);
      assert.match(js, /async function loadSidebarFileList/);
      assert.match(js, /\/documents\?limit=/);
    });
  });

  it('drills into skeleton children via /api/collections/:name/skeleton/children', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /\/skeleton\/children\?/);
    });
  });

  it('clicking a file/section opens the file view, not a separate route', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /openFileView/);
    });
  });

  it('an empty section (404 from skeleton/anchor) does not auto-open chunk 0 — it requires an explicit click', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const start = js.indexOf('async function openSectionView');
      assert.ok(start !== -1, 'openSectionView should be defined');
      const end = js.indexOf('\nasync function openFileView');
      assert.ok(end !== -1 && end > start, 'openFileView should follow openSectionView');
      const fn = js.slice(start, end);
      assert.match(fn, /section-open-file-start/);
      assert.match(fn, /addEventListener\('click', \(\) => openFileView/);
      assert.ok(!/return openFileView\(name, node\.sourceFile, node\.nodePath, 0\);/.test(fn),
        'a 404 from skeleton/anchor must not automatically open chunk 0 of the file');
    });
  });
});

describe('collection header (served app.js)', () => {
  it('renders name, summary, health badge, and point count — no dense/sparse/provider strings', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /function renderCollectionHeader/);
      const fn = js.slice(js.indexOf('function renderCollectionHeader'), js.indexOf('function renderCollectionHeader') + 1200);
      assert.ok(!/dense vector|sparse vector|denseProvider|chunkingSchema/.test(fn),
        'collection header must not render technical vector/provider/schema details');
    });
  });

  it('has a settings button that navigates to the settings route', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /col-settings-btn/);
      assert.match(js, /\/settings`/);
    });
  });
});

describe('old flat technical panels are removed (served app.js)', () => {
  it('no longer renders a separate Documents card', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/col-docs/.test(js), 'old standalone Documents panel container must be gone');
      assert.ok(!/async function loadDocuments/.test(js), 'old loadDocuments() must be removed');
    });
  });

  it('no longer renders skeleton navigation as its own main-panel card', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/col-skel/.test(js), 'old standalone skeleton-nav panel container must be gone');
    });
  });

  it('the Metadata panel is not duplicated as a separate technical card in the collection view', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/col-meta/.test(js), 'old standalone Metadata panel container must be gone');
    });
  });
});

describe('collection settings (served app.js)', () => {
  it('renders a settings view with reindex, repair, diagnostics, and delete', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /async function renderSettingsView/);
      assert.match(js, /Advanced diagnostics/);
    });
  });

  it('starts a reindex job with the current collection name, no separate retyped field', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /runSettingsReindex/);
      assert.match(js, /collection:\s*name,[\s\S]{0,80}path,/);
    });
  });

  it('reindex options are grouped and include LLM summaries', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /opt-group-label">Quality/);
      assert.match(js, /opt-group-label">Structure/);
      assert.match(js, /opt-llm-summaries/);
    });
  });

  it('offers a recent-source-path selector with a manual fallback, not only a plain path input', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /function renderSourcePathField/);
      assert.match(js, /settings-path-recent/);
      assert.match(js, /settings-path-manual/);
    });
  });

  it('the manual source-path input has no HTML "required" attribute (JS-level validation only)', async () => {
    // A `required` attribute on an input that can be hidden via display:none
    // (when a recent-path <select> is shown instead) risks blocking form
    // submission on native constraint validation before the JS handler ever
    // runs. Validation is done entirely by runSettingsReindex's own
    // "Source path is required" check instead.
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const inputTag = js.slice(js.indexOf('id="settings-path-manual"') - 60, js.indexOf('id="settings-path-manual"') + 150);
      assert.ok(!/\brequired\b/.test(inputTag), `manual path input must not have "required": ${inputTag}`);
    });
  });

  it('requires a source path before starting a reindex', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Source path is required/);
    });
  });

  it('renames sync-schema to "Repair collection compatibility" with an explanatory tooltip', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Repair collection compatibility/);
      assert.match(js, /Checks and repairs semidex metadata, vector names, and payload indexes/);
      assert.ok(!/>sync schema</i.test(js), 'old unexplained "sync schema" label must not remain verbatim');
    });
  });

  it('keeps the reindex/prune-stale safety copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Reindex starts a background job and writes to this collection/);
      assert.match(js, /Use prune stale only with the full source root/);
    });
  });

  it('delete uses a modal confirmation, not a typed-name text input', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /delete-modal-backdrop/);
      assert.match(js, /openDeleteModal/);
      assert.ok(!/maint-delete-confirm/.test(js), 'old type-to-confirm text input must be gone');
      assert.ok(!/confirmInput/.test(js), 'old type-to-confirm input reference must be gone');
    });
  });

  it('the delete modal calls DELETE with no request body', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /async function apiDelete\(path\)/, 'apiDelete must take no payload parameter');
      assert.match(js, /apiDelete\(`\/api\/collections\/\$\{encodeURIComponent\(name\)\}`\)/);
    });
  });

  it('navigates away from the deleted collection after a successful delete', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /runDeleteCollection[\s\S]{0,600}location\.hash = '#\/'/);
    });
  });

  it('advanced diagnostics (dense/sparse vector, provider, schema versions) are collapsed by default', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /<details class="panel advanced-panel">/);
      assert.match(js, /function renderAdvancedDiagnostics/);
    });
  });
});
