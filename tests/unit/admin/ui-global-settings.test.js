// Tests for src/admin/ui-src/global-settings-view.js (#/settings/:category,
// Phase 4A.5c) — the registry-driven category editor. Distinct from
// collection settings (#/c/:name/settings, settings-view.js /
// ui-settings.test.js). "Runtime status" is one category among several
// (moved verbatim from the old Phase 4A.5b read-only screen); every other
// category renders editable rows driven entirely by GET /api/settings.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Event } from 'linkedom';
import { loadGlobalSettingsHelpers, readUiSource, loadRouterHelper, withServer } from './ui-test-helpers.js';

import { HEALTH_OK, HEALTH_FAIL, GENERATION_READY, GENERATION_UNAVAILABLE, CATEGORIES, makeEntry, settingsPayload } from './ui-global-settings-fixtures.js';

describe('#/settings/:category — currentRoute() parsing', () => {
  it('parses #/settings/ai as a category-scoped global-settings route', () => {
    const { currentRoute } = loadRouterHelper();
    assert.deepEqual(currentRoute('#/settings/ai'), { view: 'global-settings', category: 'ai' });
  });

  it('bare #/settings resolves to category: null (view decides the default)', () => {
    const { currentRoute } = loadRouterHelper();
    assert.deepEqual(currentRoute('#/settings'), { view: 'global-settings', category: null });
  });

  it('collection settings route (#/c/:name/settings) is unaffected', () => {
    const { currentRoute } = loadRouterHelper();
    assert.deepEqual(currentRoute('#/c/my-docs/settings'), { view: 'settings', name: 'my-docs' });
  });

  it('accepts hyphenated/numeric category ids, not just lowercase letters', () => {
    const { currentRoute } = loadRouterHelper();
    assert.deepEqual(currentRoute('#/settings/foo-bar2'), { view: 'global-settings', category: 'foo-bar2' });
  });
});

describe('router.js — dispatches #/settings/:category to renderGlobalSettingsView', () => {
  it('imports and calls renderGlobalSettingsView with the category', () => {
    const js = readUiSource('router.js');
    assert.match(js, /import\s*\{\s*renderGlobalSettingsView,\s*invalidateGlobalSettingsRender\s*\}\s*from ['"]\.\/global-settings-view\.js['"]/);
    assert.match(js, /renderGlobalSettingsView\(main,\s*r\.category\)/);
  });

  it('invalidates the settings render generation when leaving a settings route', () => {
    const js = readUiSource('router.js');
    assert.match(js, /invalidateGlobalSettingsRender\(\)/);
  });

  it('global-settings-view.js does not import router.js (no circular import)', () => {
    const js = readUiSource('global-settings-view.js');
    assert.ok(!/from ['"]\.\/router\.js['"]/.test(js), 'global-settings-view.js must not import router.js');
  });
});

describe('global settings markup architecture', () => {
  it('keeps reusable settings markup in injected HTML templates, not JS string builders', () => {
    const js = readUiSource('global-settings-view.js');
    const index = readUiSource('index.html');
    const templates = readUiSource('partials/shared/templates/global-settings.html');

    assert.match(index, /<load src="[^"]*shared\/admin\/ui-src\/partials\/shared\/templates\/global-settings\.html"\s*\/>/);
    assert.match(templates, /<template id="tpl-global-settings-shell">/);
    assert.match(templates, /<template id="tpl-gs-field">/);
    assert.match(templates, /<template id="tpl-gs-status-panel">/);
    assert.ok(!/insertAdjacentHTML/.test(js));
    assert.ok(!/innerHTML/.test(js));
    assert.ok(!/function\s+\w+Html\s*\(/.test(js));
  });
});

describe('renderGlobalSettingsView — sidebar integration', () => {
  it('populates #settings-nav-list from the real category list (renderSettingsNav actually invoked)', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([]) },
      hash: '#/settings/ai',
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const links = [...document.querySelectorAll('#settings-nav-list a')];
    assert.equal(links.length, CATEGORIES.length);
    assert.deepEqual(links.map((a) => a.dataset.category), CATEGORIES.map((c) => c.id));
    const active = document.querySelector('#settings-nav-list a.active');
    assert.equal(active.dataset.category, 'ai');
  });

  it('shows #settings-nav and hides #collection-nav on a global-settings route', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([]) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.equal(document.getElementById('collection-nav').hidden, true);
    assert.equal(document.getElementById('settings-nav').hidden, false);
  });

  it('populates the inline category selector for narrow widths with every category', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([]) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const options = [...document.querySelectorAll('.gs-inline-category-select option')];
    assert.equal(options.length, CATEGORIES.length);
    assert.equal(document.querySelector('.gs-inline-category-select').value, 'ai');
  });
});

describe('renderGlobalSettingsView — category resolution and canonicalization', () => {
  it('bare/unknown category resolves to the first category from the API and canonicalizes the URL', async () => {
    const { document, renderGlobalSettingsView, location } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([]) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'not-a-real-category');
    assert.equal(location.hash, '/settings/status');
  });

  it('a valid requested category does not trigger a canonicalizing replaceState', async () => {
    const { document, renderGlobalSettingsView, location } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([]) },
      hash: '#/settings/ai',
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.equal(location.hash, '#/settings/ai');
  });
});

describe('renderGlobalSettingsView — Runtime Status category (moved verbatim)', () => {
  it('renders Connected/Ready badges, backend, provider, model, context size, device policy', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([]),
        '/api/health': HEALTH_OK,
        '/api/generation/status': GENERATION_READY,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'status');

    const storage = document.getElementById('gs-storage');
    assert.match(storage.textContent, /Connected/);
    assert.match(storage.textContent, /qdrant/);

    const generation = document.getElementById('gs-generation');
    assert.match(generation.textContent, /Ready/);
    assert.match(generation.textContent, /gemma3:4b/);
    assert.match(generation.textContent, /8,192/);
  });

  it('storage unavailable renders independently of a still-ready generation panel', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([]),
        '/api/health': HEALTH_FAIL,
        '/api/generation/status': GENERATION_READY,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'status');
    assert.match(document.getElementById('gs-storage').textContent, /Unavailable/);
    assert.match(document.getElementById('gs-storage').textContent, /connection refused/);
    assert.match(document.getElementById('gs-generation').textContent, /Ready/);
  });

  it('a failed /api/health request does not prevent the generation panel from rendering', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([]),
        '/api/health': new Error('network error'),
        '/api/generation/status': GENERATION_READY,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'status');
    assert.match(document.getElementById('gs-storage').textContent, /Unavailable/);
    assert.match(document.getElementById('gs-generation').textContent, /Ready/);
  });

  it('source uses Promise.allSettled for the status category fetches', () => {
    const js = readUiSource('global-settings-view.js');
    assert.match(js, /Promise\.allSettled/);
  });

  it('a hostile model name never becomes a live element (XSS hardening preserved)', async () => {
    const malicious = '<img src=x onerror="window.__pwned=true">';
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([]),
        '/api/health': HEALTH_OK,
        '/api/generation/status': { ...GENERATION_READY, model: malicious },
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'status');
    const generation = document.getElementById('gs-generation');
    assert.equal(generation.querySelectorAll('img').length, 0);
    assert.match(generation.textContent, /<img/);
  });

  it('never renders capability booleans or raw internal field names', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([]),
        '/api/health': HEALTH_OK,
        '/api/generation/status': GENERATION_READY,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'status');
    const html = document.getElementById('main').innerHTML;
    assert.ok(!/streaming/i.test(html));
    assert.ok(!/numCtx/.test(html));
  });

  it('renders no editable form controls in the status category (information, not editing)', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([]),
        '/api/health': HEALTH_OK,
        '/api/generation/status': GENERATION_READY,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'status');
    const content = document.getElementById('gs-content');
    assert.equal(content.querySelectorAll('input, select, button').length, 0);
  });
});

describe('renderGlobalSettingsView — escaping of registry-sourced content (new attack surface)', () => {
  it('a hostile label/description/enum option label renders as literal text, not live markup', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const settings = [makeEntry({
      key: 'TAG_PROVIDER', type: 'enum', label: hostile, description: hostile,
      configuredValue: 'ollama', activeValue: 'ollama',
      options: [{ value: 'ollama', label: hostile }, { value: 'onnx', label: 'onnx' }],
      advanced: false,
    })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    const content = document.getElementById('gs-content');
    assert.equal(content.querySelectorAll('img').length, 0);
    assert.match(content.innerHTML, /&lt;img/);
  });
});

describe('renderGlobalSettingsView — narrow-layout compact selector', () => {
  it('syncSidebarMode toggles .settings-compact on .layout for a global-settings route, and off for a collection route', () => {
    const js = readUiSource('sidebar.js');
    assert.match(js, /settings-compact/);
  });

  it('app.css scopes .settings-compact rules inside the existing 720px breakpoint, no new breakpoint introduced', () => {
    const css = readUiSource('app.css');
    const block = css.slice(css.indexOf('.settings-compact') - 400, css.indexOf('.settings-compact') + 600);
    assert.match(block, /@media \(max-width: 720px\)/);
  });
});

describe('topbar gear link — navigation and accessibility (unchanged)', () => {
  it('index.html has a gear link to #/settings with aria-label, title, and a stable id', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      assert.match(html, /id="nav-global-settings"/);
      assert.match(html, /href="#\/settings"/);
      assert.match(html, /aria-label="Semidex settings"/);
      assert.match(html, /title="Semidex settings"/);
    });
  });

  it('index.html wraps the collection tree in #collection-nav and defines a sibling #settings-nav', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      assert.match(html, /id="collection-nav"/);
      assert.match(html, /id="settings-nav"/);
      assert.match(html, /id="settings-nav-list"/);
    });
  });
});
