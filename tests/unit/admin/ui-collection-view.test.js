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

  it('a long collection name still renders the health badge and settings button as sibling elements (Phase 3I wrap fix)', async () => {
    // linkedom has no layout engine, so this can't assert actual pixel
    // wrapping (see the live Playwright check in the Phase 3I report for
    // that) — but it does confirm the long name doesn't break the DOM
    // structure itself, and app.css's source-string check below pins the
    // actual CSS fix (min-width: 0 + overflow-wrap: anywhere on
    // .col-header-top .view-title) as a regression guard.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const longName = 'НадзвичайноДовгаНазваКолекціїБезПробілівЯкаМожеЗламатиМакетГоловноїСторінки';
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: `#/c/${encodeURIComponent(longName)}`,
        apiResponses: {
          [`/api/collections/${encodeURIComponent(longName)}`]: { collection: { pointCount: 1, warnings: [] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const header = helpers.document.getElementById('col-header');
      assert.match(header.querySelector('.view-title').textContent, new RegExp(longName));
      assert.ok(header.querySelector('.badge-ok'), 'the health badge must still render alongside a long name');
      assert.ok(header.querySelector('#col-settings-btn'), 'the settings button must still render alongside a long name');
    });
  });

  it('app.css lets a long collection name wrap instead of pushing the settings button off-screen', () => {
    const js = readUiSource('app.css');
    assert.match(js, /\.col-header-top \.view-title\s*\{[^}]*min-width:\s*0/,
      'the title must be allowed to shrink below its intrinsic width inside the flex row');
    assert.match(js, /\.col-header-top \.view-title\s*\{[^}]*overflow-wrap:\s*anywhere/,
      'a long unbroken name (common in non-Latin scripts) must be allowed to break, not overflow');
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

describe('collection header — summary block (Phase 3G: skeleton overview > config description > quiet empty state)', () => {
  it('shows the skeleton-generated overviewSummary directly under the name when present', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: { pointCount: 1, warnings: [], overviewSummary: 'A library of internal API reference docs.', description: 'stale config text' },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const desc = helpers.document.querySelector('#col-header .col-header-desc');
      assert.ok(desc, 'a summary line must render when overviewSummary is set');
      assert.match(desc.textContent, /A library of internal API reference docs\./);
      assert.doesNotMatch(desc.textContent, /stale config text/, 'overviewSummary must take priority over description');
    });
  });

  it('falls back to the config description when overviewSummary is not set', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [], overviewSummary: null, description: 'Internal API reference docs' } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const desc = helpers.document.querySelector('#col-header .col-header-desc');
      assert.ok(desc, 'a summary line must render from description when overviewSummary is absent');
      assert.match(desc.textContent, /Internal API reference docs/);
    });
  });

  it('shows a quiet empty-state hint (not nothing, not technical noise) when neither summary exists', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [], overviewSummary: null, description: null } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const desc = helpers.document.querySelector('#col-header .col-header-desc');
      assert.ok(desc, 'an empty-state summary element must still render, not be entirely absent');
      assert.match(desc.textContent, /No collection summary yet/);
      assert.ok(desc.classList.contains('col-header-desc-empty'), 'empty state must carry a distinct quiet-styling class');
    });
  });
});

describe('collection header — compact fact chips (Phase 3G: semidex vocabulary, not Qdrant terms)', () => {
  it('always shows a chunks chip, even at zero', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 0, chunkCount: 0, warnings: [] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const facts = helpers.document.querySelector('#col-header .col-header-facts');
      assert.ok(facts, 'a fact-chip row must always render');
      assert.match(facts.textContent, /0 chunks/);
    });
  });

  it('shows chunkCount, not pointCount, in the chunks chip — chunkCount excludes skeleton_nav points, pointCount does not', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          // A collection with skeleton nav on: pointCount (raw Qdrant total)
          // includes nav points, chunkCount (server-side nav-excluded count)
          // does not. If the header ever regresses to pointCount, this test
          // catches it by making the two numbers deliberately different.
          '/api/collections/my-docs': { collection: { pointCount: 1450, chunkCount: 1200, warnings: [], hasSkeleton: true } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const text = helpers.document.querySelector('#col-header .col-header-facts').textContent;
      assert.match(text, /1,200 chunks/, 'the chunks chip must show chunkCount (nav-excluded)');
      assert.doesNotMatch(text, /1,450/, 'the raw nav-inflated pointCount must never appear in the chunks chip');
    });
  });

  it('shows a simplified model/local chip and "hybrid search" when provider data is present', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 42, chunkCount: 42, warnings: [],
              provider: { denseProvider: 'onnx', denseModel: 'bge-m3-onnx', sparseProvider: 'bm25' },
              vectorSchema: { dense: { size: 1024, distance: 'cosine' }, sparse: true },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const text = helpers.document.querySelector('#col-header .col-header-facts').textContent;
      assert.match(text, /bge-m3-onnx/);
      assert.match(text, /local/);
      assert.match(text, /hybrid search/);
    });
  });

  it('shows "dense search" (not "hybrid search") when the collection has no sparse vectors', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 1, chunkCount: 1, warnings: [],
              provider: { denseProvider: 'ollama', denseModel: 'mxbai-embed-large', sparseProvider: null },
              vectorSchema: { dense: { size: 1024, distance: 'cosine' }, sparse: false },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const text = helpers.document.querySelector('#col-header .col-header-facts').textContent;
      assert.match(text, /dense search/);
      assert.doesNotMatch(text, /hybrid search/);
    });
  });

  it('omits the provider/search-mode chips (but still shows chunks + navigation status) when there is no provider data', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 0, chunkCount: 0, warnings: [], hasSkeleton: false,
              provider: { denseProvider: null, denseModel: null, sparseProvider: null },
              vectorSchema: { dense: { size: null, distance: null }, sparse: false },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const text = helpers.document.querySelector('#col-header .col-header-facts').textContent;
      assert.doesNotMatch(text, /hybrid search|dense search/, 'no search-mode chip must render when denseProvider is null');
      assert.match(text, /0 chunks/);
      assert.match(text, /flat file list/);
    });
  });

  it('shows a "skeleton nav" chip reflecting hasSkeleton: true (Phase 3M — consistent with settings-view.js\'s own label for the same concept)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, chunkCount: 1, warnings: [], hasSkeleton: true } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const text = helpers.document.querySelector('#col-header .col-header-facts').textContent;
      assert.match(text, /skeleton nav/);
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

  it('does not throw when the collection detail object is entirely empty (every optional field missing)', async () => {
    // Phase 3I acceptance: "UI does not crash when optional metadata is
    // missing" — exercised here with a completely bare object (not even
    // pointCount/warnings), the most degraded shape a StorageAdapter could
    // plausibly return, rather than a partially-filled fixture like the
    // test above.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: {} },
          '/api/collections?': { collections: [] },
        },
      });
      await assert.doesNotReject(helpers.route());
      const header = helpers.document.getElementById('col-header');
      assert.ok(header.querySelector('.view-title'), 'the header must still render a title element');
      assert.ok(header.querySelector('.badge-ok'), 'an empty warnings array must still read as healthy');
      assert.match(header.querySelector('.col-header-desc').textContent, /No collection summary yet/);
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

describe('collection header — Phase 3I: name and summary are escaped, never parsed as markup', () => {
  it('a collection name containing HTML renders as inert text, never a real element', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: `#/c/${encodeURIComponent(malicious)}`,
        apiResponses: {
          [`/api/collections/${encodeURIComponent(malicious)}`]: { collection: { pointCount: 1, warnings: [] } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const header = helpers.document.getElementById('col-header');
      assert.equal(header.querySelectorAll('img').length, 0, 'malicious markup in the collection name must never be parsed into a real element');
      assert.match(header.querySelector('.view-title').textContent, /<img/,
        'the malicious string must still appear as literal inert text, not be silently stripped');
    });
  });

  it('an overviewSummary containing HTML renders as inert text, never a real element', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': { collection: { pointCount: 1, warnings: [], overviewSummary: malicious } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const header = helpers.document.getElementById('col-header');
      assert.equal(header.querySelectorAll('img').length, 0, 'malicious markup in overviewSummary must never be parsed into a real element');
      assert.match(header.querySelector('.col-header-desc').textContent, /<img/,
        'the malicious string must still appear as literal inert text, not be silently stripped');
    });
  });
});

describe('collection header — Phase 3G library-overview acceptance checks', () => {
  it('never exposes raw snake_case payload fields anywhere in the header, even with a full technical detail object', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/my-docs',
        apiResponses: {
          '/api/collections/my-docs': {
            collection: {
              pointCount: 99, warnings: [], hasSkeleton: true, semidexManaged: true,
              overviewSummary: 'A library of internal API reference docs.',
              provider: { denseProvider: 'onnx', denseModel: 'bge-m3-onnx', sparseProvider: 'bm25' },
              vectorSchema: { dense: { size: 1024, distance: 'cosine' }, sparse: true },
              versions: { embeddingSchema: 2, chunkingSchema: 4, indexingSchema: 4, tokenCountMode: 'bge-m3' },
            },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const header = helpers.document.getElementById('col-header');
      assert.doesNotMatch(header.textContent, /point_kind|node_type|dense_provider|sparse_provider|chunk_index|source_file/,
        'raw Qdrant snake_case payload field names must never leak into the rendered header');
    });
  });

  it('renders correctly for a collection name containing spaces and Cyrillic characters', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const name = 'Курсова робота';
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: `#/c/${encodeURIComponent(name)}`,
        apiResponses: {
          [`/api/collections/${encodeURIComponent(name)}`]: {
            collection: { pointCount: 296, warnings: [], overviewSummary: 'Матеріали курсової роботи.' },
          },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      const header = helpers.document.getElementById('col-header');
      assert.match(header.querySelector('.view-title').textContent, /Курсова робота/);
      assert.match(header.querySelector('.col-header-desc').textContent, /Матеріали курсової роботи\./);
      assert.ok(header.querySelector('#col-settings-btn'), 'settings button must still render');
    });
  });

  it('updates the summary/chips correctly when switching from one collection to another', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadRouteIntegrationHelpers(html, {
        hash: '#/c/docs-a',
        apiResponses: {
          '/api/collections/docs-a': { collection: { pointCount: 10, chunkCount: 10, warnings: [], overviewSummary: 'Docs A summary.' } },
          '/api/collections/docs-b': { collection: { pointCount: 20, chunkCount: 20, warnings: [], overviewSummary: 'Docs B summary.' } },
          '/api/collections?': { collections: [] },
        },
      });
      await helpers.route();
      assert.match(helpers.document.querySelector('#col-header .col-header-desc').textContent, /Docs A summary\./);

      helpers.location.hash = '#/c/docs-b';
      await helpers.route();
      const desc = helpers.document.querySelector('#col-header .col-header-desc').textContent;
      assert.match(desc, /Docs B summary\./);
      assert.doesNotMatch(desc, /Docs A summary/);
      assert.match(helpers.document.querySelector('#col-header .col-header-facts').textContent, /20 chunks/);
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
  it('renders exactly the query input and search button — no top selector, no Advanced disclosure', async () => {
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
      assert.ok(helpers.document.getElementById('q-submit'), 'search button must be present');
      assert.equal(helpers.document.getElementById('q-top'), null, 'the top selector must no longer exist');
      assert.equal(helpers.document.querySelector('#search-panel details.advanced-box'), null,
        'the Advanced disclosure must no longer exist');
    });
  });

  it('does not reintroduce a window/format/top selector or a score opt-in checkbox anywhere in the source', () => {
    const js = readUiSource('search.js');
    assert.ok(!/id="q-window"|id="q-format"|id="q-top"|id="q-show-score"/.test(js),
      'window/format/top selectors and the score checkbox must not be reintroduced — score shows by default now, top is a fixed internal fetch limit');
    assert.ok(!/<details class="advanced-box">/.test(js), 'the Advanced disclosure must not be reintroduced');
  });
});
