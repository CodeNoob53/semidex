// Tests for src/admin/ui-src/collection-view.js (renderOverview,
// renderCollection, renderCollectionHeader) and general regression guards
// that the old flat technical panels stay removed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, loadRouteIntegrationHelpers, withServer } from './ui-test-helpers.js';

// ── Phase 3E: collection header redesign — user-facing overview, not a debug
// dump. Top line (name/health/settings) -> optional description ->
// compact fact chips -> collapsed Details for the technical facts.
describe('collection header — top line (always visible)', () => {
  it('renders name, health badge, and a settings button', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 42, warnings: [] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const header = helpers.document.getElementById('col-header');
      assert.match(header.querySelector('.view-title').textContent, /my-docs/);
      assert.ok(header.querySelector('.badge-ok'), 'a healthy collection must show the ok badge');
      assert.match(header.querySelector('.badge-ok').textContent, /healthy/);
      assert.ok(header.querySelector('#col-settings-btn'), 'settings button must be present');
    });
  });

  it('shows a warning badge (not "healthy") when the collection has warnings', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: ['legacy flat vector schema'] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const badge = helpers.document.querySelector('#col-header .badge-warn');
      assert.ok(badge, 'a warning badge must render when warnings exist');
      assert.match(badge.textContent, /1 warning/);
    });
  });

  it('has a settings button that navigates to the settings route using the #/c/ URL scheme', () => {
    const js = readUiSource('collection-view.js');
    assert.match(js, /col-settings-btn/);
    assert.match(js, /#\/c\/\$\{encodeURIComponent\(name\)\}\/settings/);
  });

  it('settings button click sets location.hash to the settings route', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      helpers.document.getElementById('col-settings-btn').click();
      assert.equal(helpers.location.hash, '#/c/my-docs/settings');
    });
  });
});

describe('collection header — description line', () => {
  it('shows the collection description directly under the name when present', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [], description: 'Internal API reference docs' } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const desc = helpers.document.querySelector('#col-header .col-header-desc');
      assert.ok(desc, 'a description line must render when detail.description is set');
      assert.match(desc.textContent, /Internal API reference docs/);
    });
  });

  it('omits the description line entirely (no filler text) when description is not set', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [], description: null } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      assert.equal(helpers.document.querySelector('#col-header .col-header-desc'), null,
        'no description element (not even an empty one) must render when there is no description');
    });
  });
});

describe('collection header — compact fact chips', () => {
  it('always shows a points chip, even at zero', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 0, warnings: [] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const facts = helpers.document.querySelector('#col-header .col-header-facts');
      assert.ok(facts, 'a fact-chip row must always render');
      assert.match(facts.textContent, /0 points/);
    });
  });

  it('shows provider/model and hybrid status chips when provider data is present', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 42, warnings: [],
              provider: { denseProvider: 'onnx', denseModel: 'bge-m3-onnx', sparseProvider: 'bm25' },
              vectorSchema: { dense: { size: 1024, distance: 'cosine' }, sparse: true },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const text = helpers.document.querySelector('#col-header .col-header-facts').textContent;
      assert.match(text, /onnx/);
      assert.match(text, /bge-m3-onnx/);
      assert.match(text, /hybrid/);
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
      const text = helpers.document.querySelector('#col-header .col-header-facts').textContent;
      assert.match(text, /dense-only/);
      assert.doesNotMatch(text, /hybrid/);
    });
  });

  it('omits the provider/hybrid chips (but still shows points + skeleton status) when there is no provider data', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 0, warnings: [], hasSkeleton: false,
              provider: { denseProvider: null, denseModel: null, sparseProvider: null },
              vectorSchema: { dense: { size: null, distance: null }, sparse: false },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const text = helpers.document.querySelector('#col-header .col-header-facts').textContent;
      assert.doesNotMatch(text, /hybrid|dense-only/, 'no provider chip must render when denseProvider is null');
      assert.match(text, /0 points/);
      assert.match(text, /flat file list/);
    });
  });

  it('shows a skeleton-navigation status chip reflecting hasSkeleton', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [], hasSkeleton: true } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const text = helpers.document.querySelector('#col-header .col-header-facts').textContent;
      assert.match(text, /skeleton nav on/);
    });
  });

  it('does not render "undefined", "null", or a bare "?" anywhere in the visible header when optional fields are missing', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          // Deliberately sparse — no description, no provider, no vectorSchema.
          '/api/collections/my-docs': { collection: { pointCount: 0, warnings: [] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const header = helpers.document.getElementById('col-header');
      assert.doesNotMatch(header.textContent, /\bundefined\b/);
      assert.doesNotMatch(header.textContent, /\bnull\b/);
      assert.doesNotMatch(header.textContent, /(?<![\w-])\?(?![\w-])/, 'no bare "?" placeholder in the visible header');
    });
  });
});

describe('collection header — Details disclosure (collapsed, technical facts only)', () => {
  it('renders a <details> panel that is collapsed by default (no "open" attribute)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const details = helpers.document.querySelector('#col-header details.advanced-panel');
      assert.ok(details, 'a Details disclosure must render');
      assert.equal(details.hasAttribute('open'), false, 'Details must be collapsed by default');
    });
  });

  it('Details contains the technical facts: dense/sparse schema, both providers, schema versions, semidex-managed', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 99, warnings: [], hasSkeleton: true, semidexManaged: true,
              provider: { denseProvider: 'onnx', denseModel: 'bge-m3-onnx', sparseProvider: 'bm25' },
              vectorSchema: { dense: { size: 1024, distance: 'cosine' }, sparse: true },
              versions: { embeddingSchema: 2, chunkingSchema: 4, indexingSchema: 4, tokenCountMode: 'bge-m3' },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const text = helpers.document.querySelector('#col-header details.advanced-panel').textContent;
      assert.match(text, /1024d/);
      assert.match(text, /cosine/);
      assert.match(text, /bge-m3-onnx/);
      assert.match(text, /bm25/);
      assert.match(text, /semidex-managedyes/); // semidex-managed: yes
      assert.match(text, /skeleton navigationenabled/); // skeleton navigation: enabled
    });
  });

  it('the header top line and settings button sit outside/above the Details disclosure, not inside it', () => {
    const js = readUiSource('collection-view.js');
    const start = js.indexOf('function renderCollectionHeader');
    const fn = js.slice(start, js.indexOf('export {', start));
    const detailsCallIndex = fn.indexOf('collectionDetailsPanel(detail)');
    assert.ok(detailsCallIndex > -1, 'renderCollectionHeader must render the Details panel');
    assert.ok(fn.indexOf('col-header-top') < detailsCallIndex, 'the top line must render before the Details panel');
    assert.ok(fn.indexOf('col-settings-btn') < detailsCallIndex, 'the settings button must render before the Details panel');
  });

  it('the header itself (outside Details) never renders schema-version fields', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 1, warnings: [],
              versions: { embeddingSchema: 2, chunkingSchema: 4, indexingSchema: 4, tokenCountMode: 'bge-m3' },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const header = helpers.document.getElementById('col-header');
      // Remove the collapsed Details subtree's own text, then check what's left.
      const details = header.querySelector('details.advanced-panel');
      const outsideDetailsText = [...header.childNodes]
        .filter(n => n !== details)
        .map(n => n.textContent ?? '').join(' ');
      assert.doesNotMatch(outsideDetailsText, /embeddingSchema|chunkingSchema|indexingSchema|tokenCountMode|bge-m3\b/,
        'schema-version internals must only appear inside the collapsed Details panel');
    });
  });
});

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

  it('there is exactly one Details/metadata disclosure in the header — not a separate Metadata AND Maintenance block', () => {
    const js = readUiSource('collection-view.js');
    const matches = js.match(/<details class="panel advanced-panel"/g) ?? [];
    assert.equal(matches.length, 1, 'renderCollectionHeader must build exactly one Details panel, not duplicated ones');
  });
});

describe('search panel stays present and default-simple alongside the redesigned header', () => {
  it('renders the query input, top selector, search button, and an Advanced disclosure', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      assert.ok(helpers.document.getElementById('q-input'), 'query input must be present');
      assert.ok(helpers.document.getElementById('q-top'), 'top selector must be present');
      assert.ok(helpers.document.getElementById('q-submit'), 'search button must be present');
      assert.ok(helpers.document.querySelector('#search-panel details.advanced-box'), 'Advanced disclosure must be present');
    });
  });

  it('does not reintroduce a window/format selector or a default-visible score/source-file input', () => {
    const js = readUiSource('search.js');
    assert.ok(!/id="q-window"|id="q-format"/.test(js), 'window/format selectors must not be reintroduced');
    // q-show-score/q-file-chip may exist, but only inside the Advanced disclosure.
    const advStart = js.indexOf("<details class=\"advanced-box\">");
    const advEnd = js.indexOf('</details>', advStart);
    assert.ok(advStart > -1 && advEnd > advStart, 'Advanced disclosure markup must exist');
    const beforeAdvanced = js.slice(js.indexOf('function initSearchPanel'), advStart);
    assert.ok(!/id="q-show-score"|id="q-file-chip"/.test(beforeAdvanced),
      'score checkbox and file-filter chip must live inside Advanced, not the default-visible row');
  });
});
