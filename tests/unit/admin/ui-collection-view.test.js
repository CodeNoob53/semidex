// Tests for src/admin/ui-src/collection-view.js (renderOverview,
// renderCollection, renderCollectionHeader) and general regression guards
// that the old flat technical panels stay removed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, loadRouteIntegrationHelpers, withServer } from './ui-test-helpers.js';

describe('collection header (ui-src/collection-view.js source)', () => {
  it('renders name, summary, health badge, and point count; keeps schema-version fields out of the header entirely', () => {
    const js = readUiSource('collection-view.js');
    assert.match(js, /function renderCollectionHeader/);
    const fn = js.slice(js.indexOf('function renderCollectionHeader'), js.indexOf('function renderCollectionHeader') + 1200);
    // Phase 3C added a compact provider/schema chip row (collectionMetaRow),
    // so denseProvider/dense vector are now expected here — but the more
    // detailed version fields (chunkingSchema etc.) must still never surface
    // in the header, only inside Collection settings' Advanced diagnostics.
    assert.ok(!/chunkingSchema|embeddingSchema|indexingSchema|tokenCountMode/.test(fn),
      'collection header must not render schema-version fields — those stay in Collection settings');
  });

  it('has a settings button that navigates to the settings route using the #/c/ URL scheme', () => {
    const js = readUiSource('collection-view.js');
    assert.match(js, /col-settings-btn/);
    assert.match(js, /#\/c\/\$\{encodeURIComponent\(name\)\}\/settings/);
  });

  it('keeps name, health badge, and settings button always visible; collapses description/point-count/warnings behind a "Details" disclosure', () => {
    const js = readUiSource('collection-view.js');
    const start = js.indexOf('function renderCollectionHeader');
    const fn = js.slice(start, start + 1200);
    const topLineEnd = fn.indexOf('col-header-top');
    const detailsStart = fn.indexOf('<details class="panel advanced-panel"');
    assert.ok(detailsStart > -1, 'collection header must have a collapsible Details panel');
    assert.ok(fn.indexOf('col-settings-btn') < detailsStart, 'settings button must be outside/above the disclosure');
    assert.ok(fn.indexOf('healthBadge') < detailsStart || topLineEnd < detailsStart,
      'health badge must render on the always-visible top line, not inside the disclosure');
    const inside = fn.slice(detailsStart);
    assert.match(inside, /pointCount/, 'point count must be inside the collapsed Details panel');
  });
});

// ── Phase 3C: compact provider/schema secondary row ─────────────────────────
describe('collection header — provider/schema secondary row (Phase 3C)', () => {
  it('renders a compact provider/schema chip row when detail.provider.denseProvider is present', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 42,
              warnings: [],
              provider: { denseProvider: 'onnx', denseModel: 'bge-m3-onnx', sparseProvider: 'bm25' },
              vectorSchema: { dense: { size: 1024, distance: 'cosine' }, sparse: true },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const row = helpers.document.querySelector('.col-header-meta-row');
      assert.ok(row, 'a provider/schema row must render when provider data is present');
      assert.match(row.textContent, /onnx/);
      assert.match(row.textContent, /bge-m3-onnx/);
      assert.match(row.textContent, /1024d/);
      assert.match(row.textContent, /hybrid/);
    });
  });

  it('shows "dense-only" (not "hybrid") when the collection has no sparse vectors', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 1, warnings: [],
              provider: { denseProvider: 'ollama', denseModel: 'mxbai-embed-large', sparseProvider: null },
              vectorSchema: { dense: { size: 1024, distance: 'cosine' }, sparse: false },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const row = helpers.document.querySelector('.col-header-meta-row');
      assert.match(row.textContent, /dense-only/);
      assert.doesNotMatch(row.textContent, /hybrid/);
    });
  });

  it('omits the row entirely when denseProvider is null (never-indexed or legacy collection)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 0, warnings: [],
              provider: { denseProvider: null, denseModel: null, sparseProvider: null },
              vectorSchema: { dense: { size: null, distance: null }, sparse: false },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      assert.equal(helpers.document.querySelector('.col-header-meta-row'), null,
        'no row (not even an empty one) must render when there is no provider data');
    });
  });
});

// ── Phase 2E: navigation-first dashboard redesign — old flat panels removed ─
describe('old flat technical panels are removed (ui-src source)', () => {
  it('no longer renders a separate Documents card', () => {
    const js = readUiSource('sidebar.js') + readUiSource('collection-view.js');
    assert.ok(!/col-docs/.test(js), 'old standalone Documents panel container must be gone');
    assert.ok(!/async function loadDocuments/.test(js), 'old loadDocuments() must be removed');
  });

  it('no longer uses the old #/collections/ URL scheme anywhere in the source', () => {
    const js = readUiSource('app.js') + readUiSource('router.js') + readUiSource('sidebar.js')
      + readUiSource('collection-view.js') + readUiSource('settings-view.js');
    assert.ok(!/#\/collections\//.test(js), 'old #/collections/ URL scheme must be fully removed');
  });

  it('no longer renders skeleton navigation as its own main-panel card', () => {
    const js = readUiSource('sidebar.js') + readUiSource('collection-view.js');
    assert.ok(!/col-skel/.test(js), 'old standalone skeleton-nav panel container must be gone');
  });

  it('the Metadata panel is not duplicated as a separate technical card in the collection view', () => {
    const js = readUiSource('collection-view.js');
    assert.ok(!/col-meta/.test(js), 'old standalone Metadata panel container must be gone');
  });
});
