// Tests for src/admin/ui-src/router.js's currentRoute().
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadRouterHelper, readUiSource } from './ui-test-helpers.js';

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
