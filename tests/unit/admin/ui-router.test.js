// Tests for src/admin/ui-src/router.js's currentRoute().
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadRouterHelper, readUiSource, loadRouteIntegrationHelpers, withServer } from './ui-test-helpers.js';

describe('router — currentRoute() (ui-src/router.js source, evaluated behavior)', () => {
  it('parses collection home: #/c/:name', () => {
    const { currentRoute } = loadRouterHelper();
    assert.deepEqual(currentRoute('#/c/my-docs'), { view: 'collection', name: 'my-docs' });
  });

  it('parses file view: #/c/:name/f/:sourceFile, including an encoded slash in the path', () => {
    const { currentRoute } = loadRouterHelper();
    const r = currentRoute(`#/c/my-docs/f/${encodeURIComponent('sub/dir/readme.md')}`);
    assert.deepEqual(r, { view: 'collection', name: 'my-docs', openFile: 'sub/dir/readme.md' });
  });

  it('parses section/node view: #/c/:name/n/:nodePath', () => {
    const { currentRoute } = loadRouterHelper();
    const r = currentRoute(`#/c/my-docs/n/${encodeURIComponent('readme.md#intro')}`);
    assert.deepEqual(r, { view: 'collection', name: 'my-docs', openNodePath: 'readme.md#intro' });
  });

  it('parses settings: #/c/:name/settings', () => {
    const { currentRoute } = loadRouterHelper();
    assert.deepEqual(currentRoute('#/c/my-docs/settings'), { view: 'settings', name: 'my-docs' });
  });

  it('parses the indexing view and falls back to overview for everything else', () => {
    const { currentRoute } = loadRouterHelper();
    assert.deepEqual(currentRoute('#/index'), { view: 'index' });
    assert.deepEqual(currentRoute('#/'), { view: 'overview' });
    assert.deepEqual(currentRoute(''), { view: 'overview' });
  });

  it('decodes a URI-encoded Cyrillic collection name', () => {
    const { currentRoute } = loadRouterHelper();
    const r = currentRoute(`#/c/${encodeURIComponent('Основи Node.js')}`);
    assert.deepEqual(r, { view: 'collection', name: 'Основи Node.js' });
  });

  it('no longer recognizes the old #/collections/:name scheme (falls through to overview)', () => {
    const { currentRoute } = loadRouterHelper();
    assert.deepEqual(currentRoute('#/collections/my-docs'), { view: 'overview' });
  });
});

// ── Phase 3B: search-state query string on top of the collection route ─────
describe('currentRoute() — search permalink query string (?q=&top=&window=&format=&file=)', () => {
  it('parses q/top/window/format off a bare collection route', () => {
    const { currentRoute } = loadRouterHelper();
    const r = currentRoute('#/c/my-docs?q=refund&top=5&window=1&format=full');
    assert.deepEqual(r, {
      view: 'collection', name: 'my-docs',
      search: { q: 'refund', top: 5, window: 1, format: 'full' },
    });
  });

  it('parses the query string alongside an open file (?q= after /f/:sourceFile)', () => {
    const { currentRoute } = loadRouterHelper();
    const r = currentRoute('#/c/my-docs/f/readme.md?q=install');
    assert.deepEqual(r, {
      view: 'collection', name: 'my-docs', openFile: 'readme.md',
      search: { q: 'install' },
    });
  });

  it('the file-filter query param decodes into search.sourceFile, distinct from an open file path segment', () => {
    const { currentRoute } = loadRouterHelper();
    const r = currentRoute('#/c/my-docs?q=refund&file=other.md');
    assert.deepEqual(r, { view: 'collection', name: 'my-docs', search: { q: 'refund', sourceFile: 'other.md' } });
  });

  it('a route with no query string has no `search` key at all (not an empty object)', () => {
    const { currentRoute } = loadRouterHelper();
    const r = currentRoute('#/c/my-docs');
    assert.ok(!('search' in r), 'search must be omitted, not {}, when there is no query string');
  });

  it('an empty query string (trailing "?" with nothing after) also omits `search`', () => {
    const { currentRoute } = loadRouterHelper();
    const r = currentRoute('#/c/my-docs?');
    assert.ok(!('search' in r));
  });

  it('top/window parse as numbers, not strings', () => {
    const { currentRoute } = loadRouterHelper();
    const r = currentRoute('#/c/my-docs?q=x&top=10&window=2');
    assert.equal(typeof r.search.top, 'number');
    assert.equal(typeof r.search.window, 'number');
  });
});

// ── Phase 3B follow-up: search-state sync must not clobber file/section views ─
describe('route() search-state sync (applySearchStateFromUrl vs syncSearchStateFromUrl)', () => {
  it('applySearchStateFromUrl (form-only, never runs a search) is called for both openFile and openNodePath branches', () => {
    const js = readUiSource('router.js');
    const start = js.indexOf('else if (r.view === \'collection\')');
    const end = js.indexOf('} else if (r.view === \'index\')');
    const branch = js.slice(start, end);
    assert.match(branch, /openFileView\(r\.name, r\.openFile\);[\s\S]{0,400}applySearchStateFromUrl\(r\.name\)/,
      'the openFile branch must call applySearchStateFromUrl (form sync only), not syncSearchStateFromUrl (which would re-run a search and hide the file view)');
    assert.match(branch, /openNodeFromPath\(r\.name, r\.openNodePath\);[\s\S]{0,400}applySearchStateFromUrl\(r\.name\)/,
      'the openNodePath branch must call applySearchStateFromUrl for the same reason');
  });

  it('syncSearchStateFromUrl (which can run a search) is reserved for the bare-collection else branch', () => {
    const js = readUiSource('router.js');
    const start = js.indexOf('else if (r.view === \'collection\')');
    const end = js.indexOf('} else if (r.view === \'index\')');
    const branch = js.slice(start, end);
    const elseBranch = branch.slice(branch.lastIndexOf('} else {'));
    assert.match(elseBranch, /syncSearchStateFromUrl\(r\.name\)/);
    assert.ok(!/openFileView|openNodeFromPath/.test(elseBranch),
      'syncSearchStateFromUrl must only be reachable when neither openFile nor openNodePath is set');
  });
});

// ── Real end-to-end route() behavior (not source-regex) ─────────────────────
// The source-regex tests above only see router.js's own text — they can't
// catch a bug that lives in a DIFFERENT module in the call chain (e.g.
// initSearchPanel() itself calling syncSearchStateFromUrl(), which
// bypassed router.js's apply-vs-sync split entirely on a route's first
// visit). These evaluate the real route()/renderCollection()/
// openFileView()/initSearchPanel() graph together via
// loadRouteIntegrationHelpers, so they exercise the actual flow a URL
// navigation triggers, across module boundaries.
describe('route() end-to-end: navigating straight to a file route with ?q= (first visit, no prior mount)', () => {
  it('updates the search form from ?q= but does NOT call /api/search', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs/f/readme.md?q=dogs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [] } },
          '/api/collections?': { collections: [] },
          '/chunks?': { chunks: [{ chunkIndex: 0, text: 'hi', totalChunks: 1 }] },
        },
      });
      await helpers.route();
      assert.equal(helpers.document.querySelector('#q-input').value, 'dogs',
        'the search form must reflect ?q= even on the very first visit to this file route');
      assert.ok(!helpers.__apiCalls.some(url => url.includes('/api/search')),
        `opening a file route must never call /api/search — calls were: ${helpers.__apiCalls.join(', ')}`);
    });
  });

  it('actually opens the file view (content-title reflects the file, not "Results")', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs/f/readme.md?q=dogs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [] } },
          '/api/collections?': { collections: [] },
          '/chunks?': { chunks: [{ chunkIndex: 0, text: 'hi', totalChunks: 1 }] },
        },
      });
      await helpers.route();
      assert.match(helpers.document.querySelector('#content-title').textContent, /readme\.md/,
        'the file view must actually be showing, not clobbered by a spurious search run');
    });
  });

  it('a bare collection route with ?q= DOES call /api/search (contrast case — sync is not disabled entirely)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs?q=dogs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      assert.ok(helpers.__apiCalls.some(url => url.includes('/api/search')),
        'a bare collection route with ?q= must still run the search — only file/section routes are protected');
    });
  });
});

// ── import-cycle guard ────────────────────────────────────────────────────
// router.js depends on sidebar.js and jobs-view.js (for markActive/
// renderIndexingView) — currentRoute() lives in the leaf module routes.js
// specifically so neither of them needs to import router.js back. This
// guard catches a regression to the old sidebar.js<->router.js (and
// equally, jobs-view.js<->router.js) circular import.
describe('router.js / sidebar.js / jobs-view.js — no circular import', () => {
  const importsOf = (file) => {
    const src = readUiSource(file);
    return [...src.matchAll(/^import\s+.*\sfrom\s+'\.\/([\w-]+)\.js'/gm)].map(m => m[1]);
  };

  it('sidebar.js does not import from router.js', () => {
    assert.ok(!importsOf('sidebar.js').includes('router'),
      'sidebar.js must not import router.js — that would recreate the sidebar<->router cycle');
  });

  it('jobs-view.js does not import from router.js', () => {
    assert.ok(!importsOf('jobs-view.js').includes('router'),
      'jobs-view.js must not import router.js — that would recreate a jobs-view<->router cycle');
  });

  it('routes.js (home of currentRoute) has no local imports of its own', () => {
    assert.deepEqual(importsOf('routes.js'), [],
      'routes.js must stay a dependency-free leaf so it can never participate in a cycle');
  });
});
