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

const HEALTH_OK = { ok: true, storage: { backend: 'qdrant', ok: true, detail: 'reachable' } };
const HEALTH_FAIL = { ok: false, storage: { backend: 'qdrant', ok: false, detail: 'connection refused' } };

const GENERATION_READY = {
  backend: 'ollama', model: 'gemma3:4b', ready: true, reason: null, numCtx: 8192,
  capabilities: { streaming: true, cancellation: true },
  devicePolicy: { value: 'auto', supported: ['auto'] },
  configuration: {
    backend: { source: 'default' }, model: { source: 'os_env' },
    baseUrl: { source: 'dotenv', display: 'http://localhost:11434' },
    numCtx: { source: 'default' }, devicePolicy: { source: 'default' },
  },
};

const GENERATION_UNAVAILABLE = {
  backend: 'ollama', model: 'gemma3:4b', ready: false,
  reason: 'Ollama is not reachable at http://localhost:11434. Start it with "ollama serve".',
  numCtx: null, capabilities: { streaming: true, cancellation: true },
  devicePolicy: { value: 'auto', supported: ['auto'] },
  configuration: {
    backend: { source: 'default' }, model: { source: 'dotenv' },
    baseUrl: { source: 'dotenv', display: 'http://localhost:11434' },
    numCtx: { source: 'default' }, devicePolicy: { source: 'default' },
  },
};

const CATEGORIES = [
  { id: 'status', label: 'Runtime status' },
  { id: 'storage', label: 'Storage & databases' },
  { id: 'ai', label: 'AI providers' },
  { id: 'embeddings', label: 'Embeddings & hardware' },
  { id: 'indexing', label: 'Indexing & document processing' },
  { id: 'retrieval', label: 'Retrieval & ranking' },
  { id: 'system', label: 'System & diagnostics' },
];

function makeEntry(overrides = {}) {
  return {
    key: 'RRF_K', category: 'retrieval', label: 'RRF K constant', type: 'number',
    description: 'Smoothing constant for RRF.', advanced: true,
    min: 1, max: 10000,
    default: 60,
    configuredValue: 60, activeValue: 60,
    configuredSource: 'default', activeSource: 'default', source: 'default',
    writable: true, secret: false, hasLocalOverride: false, pendingRestart: false,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    readOnlyReason: null,
    ...overrides,
  };
}

function settingsPayload(settings) {
  return { categories: CATEGORIES, settings };
}

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
    const templates = readUiSource('partials/templates/global-settings.html');

    assert.match(index, /<load src="partials\/templates\/global-settings\.html"\s*\/>/);
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

describe('renderGlobalSettingsView — type-correct editable controls', () => {
  it('boolean -> checkbox, enum -> select with exact options, number -> input with min/max, string -> text input', async () => {
    const settings = [
      makeEntry({ key: 'TAG_GEN', type: 'boolean', configuredValue: true, activeValue: true, advanced: false }),
      makeEntry({
        key: 'TAG_PROVIDER', type: 'enum', configuredValue: 'ollama', activeValue: 'ollama',
        options: [{ value: 'ollama', label: 'ollama' }, { value: 'onnx', label: 'onnx' }], advanced: false,
      }),
      makeEntry({ key: 'MAX_CHUNK_TOKENS', type: 'number', configuredValue: 512, activeValue: 512, min: 1, max: 100000, advanced: false }),
      makeEntry({ key: 'ASK_MODEL', category: 'ai', type: 'string', configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false, advanced: false, appliesAt: 'next_restart' }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');

    const checkbox = document.querySelector('[data-key="TAG_GEN"]');
    assert.equal(checkbox.type, 'checkbox');
    assert.equal(checkbox.checked, true);

    const select = document.querySelector('[data-key="TAG_PROVIDER"]');
    assert.equal(select.tagName.toLowerCase(), 'select');
    assert.deepEqual([...select.options].map((o) => o.value), ['ollama', 'onnx']);

    const numberInput = document.querySelector('[data-key="MAX_CHUNK_TOKENS"]');
    assert.equal(numberInput.type, 'number');
    assert.equal(numberInput.getAttribute('min'), '1');
    assert.equal(numberInput.getAttribute('max'), '100000');
  });
});

describe('renderGlobalSettingsView — advanced disclosure', () => {
  it('primary fields render directly; advanced fields render inside a closed <details>', async () => {
    const settings = [
      makeEntry({ key: 'RERANK_ENABLED', type: 'boolean', configuredValue: false, activeValue: false, advanced: false }),
      makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 60, activeValue: 60, advanced: true }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');

    const details = document.querySelector('.gs-advanced');
    assert.ok(details, 'expected a .gs-advanced <details> element');
    assert.equal(details.tagName.toLowerCase(), 'details');
    assert.equal(details.hasAttribute('open'), false);
    assert.ok(details.querySelector('[data-key="RRF_K"]'));
    assert.ok(!details.contains(document.querySelector('[data-key="RERANK_ENABLED"]')));
  });
});

describe('renderGlobalSettingsView — numeric validation', () => {
  it('a value outside min/max is excluded from pending and disables Save', async () => {
    const settings = [makeEntry({ key: 'MAX_CHUNK_TOKENS', type: 'number', configuredValue: 512, activeValue: 512, min: 1, max: 100000, advanced: false })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');

    const input = document.querySelector('[data-key="MAX_CHUNK_TOKENS"]');
    input.value = '999999999';
    input.dispatchEvent(new Event('input'));

    const saveBtn = document.getElementById('gs-save');
    assert.ok(saveBtn, 'Save bar should appear once the field is touched');
    assert.equal(saveBtn.disabled, true);
  });

  it('clearing a number field to empty excludes it from pending and disables Save', async () => {
    const settings = [makeEntry({ key: 'MAX_CHUNK_TOKENS', type: 'number', configuredValue: 512, activeValue: 512, min: 1, max: 100000, advanced: false })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');

    const input = document.querySelector('[data-key="MAX_CHUNK_TOKENS"]');
    input.value = '700';
    input.dispatchEvent(new Event('input'));
    assert.equal(document.getElementById('gs-save').disabled, false);

    document.querySelector('[data-key="MAX_CHUNK_TOKENS"]').value = '';
    document.querySelector('[data-key="MAX_CHUNK_TOKENS"]').dispatchEvent(new Event('input'));
    assert.equal(document.getElementById('gs-save').disabled, true);
  });

  it('a value back within range re-enables Save', async () => {
    const settings = [makeEntry({ key: 'MAX_CHUNK_TOKENS', type: 'number', configuredValue: 512, activeValue: 512, min: 1, max: 100000, advanced: false })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('[data-key="MAX_CHUNK_TOKENS"]').value = '999999999';
    document.querySelector('[data-key="MAX_CHUNK_TOKENS"]').dispatchEvent(new Event('input'));
    assert.equal(document.getElementById('gs-save').disabled, true);

    document.querySelector('[data-key="MAX_CHUNK_TOKENS"]').value = '700';
    document.querySelector('[data-key="MAX_CHUNK_TOKENS"]').dispatchEvent(new Event('input'));
    assert.equal(document.getElementById('gs-save').disabled, false);
  });

  it('typing updates validation without replacing the active input element', async () => {
    const settings = [makeEntry({ key: 'MAX_CHUNK_TOKENS', type: 'number', configuredValue: 512, activeValue: 512, min: 1, max: 100000, advanced: false })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    const input = document.querySelector('[data-key="MAX_CHUNK_TOKENS"]');
    input.value = '700';
    input.dispatchEvent(new Event('input'));
    assert.equal(document.querySelector('[data-key="MAX_CHUNK_TOKENS"]'), input,
      'input events must not rebuild and replace the field being edited');
  });
});

describe('renderGlobalSettingsView — allowEmpty respected for string fields', () => {
  it('allowEmpty: false — clearing to empty marks the field invalid, excludes it from pending', async () => {
    const settings = [makeEntry({ key: 'SUMMARY_LANG', category: 'indexing', type: 'string', configuredValue: 'auto', activeValue: 'auto', allowEmpty: false, advanced: true })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'indexing');
    const input = document.querySelector('[data-key="SUMMARY_LANG"]');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    assert.equal(document.getElementById('gs-save').disabled, true);
  });

  it('allowEmpty: true — clearing to empty stages a valid pending change', async () => {
    const settings = [makeEntry({ key: 'ADMIN_HOST', category: 'system', type: 'string', configuredValue: '127.0.0.1', activeValue: '127.0.0.1', allowEmpty: true, advanced: true })];
    const { document, renderGlobalSettingsView, __patchCalls } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
      apiPatchImpl: async (url, body) => { __patchCalls.push({ url, body }); return {}; },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'system');
    const details = document.querySelector('.gs-advanced');
    if (details) details.open = true;
    const input = document.querySelector('[data-key="ADMIN_HOST"]');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    assert.equal(document.getElementById('gs-save').disabled, false);
  });
});

describe('renderGlobalSettingsView — dirty tracking and batch save', () => {
  it('editing one field reveals Save/Cancel; PATCH body omits untouched fields', async () => {
    const settings = [
      makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 60, activeValue: 60, advanced: true }),
      makeEntry({ key: 'HYBRID_PREFETCH_LIMIT', type: 'number', configuredValue: 2, activeValue: 2, min: 1, max: 100, advanced: true }),
    ];
    const patchCalls = [];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
      apiPatchImpl: async (url, body) => { patchCalls.push({ url, body }); return {}; },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').setAttribute('open', '');

    document.querySelector('[data-key="RRF_K"]').value = '90';
    document.querySelector('[data-key="RRF_K"]').dispatchEvent(new Event('input'));

    assert.ok(document.getElementById('gs-save'));
    document.getElementById('gs-save').click();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(patchCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(patchCalls[0].body)), { changes: { RRF_K: 90 } });
  });

  it('on save success, refetches GET and clears pending for that category', async () => {
    const settings = [makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 60, activeValue: 60, advanced: true })];
    const refetched = settingsPayload([makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 90, activeValue: 90, configuredSource: 'config_json', activeSource: 'config_json', advanced: true })]);
    let getCallCount = 0;
    const { document, renderGlobalSettingsView, __apiCalls } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': () => { getCallCount += 1; return getCallCount === 1 ? settingsPayload(settings) : refetched; },
      },
      apiPatchImpl: async () => ({}),
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').setAttribute('open', '');
    document.querySelector('[data-key="RRF_K"]').value = '90';
    document.querySelector('[data-key="RRF_K"]').dispatchEvent(new Event('input'));
    document.getElementById('gs-save').click();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(__apiCalls.filter((u) => u === '/api/settings').length, 2, 'expected an initial GET plus a refetch after save');
    // Dirty bar gone — pending cleared for this category.
    assert.equal(document.getElementById('gs-save'), null);
  });

  it('disables category controls while a save request is in flight', async () => {
    const settings = [makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 60, activeValue: 60, advanced: true })];
    let resolvePatch;
    const patchPromise = new Promise((resolve) => { resolvePatch = resolve; });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
      apiPatchImpl: () => patchPromise,
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').setAttribute('open', '');
    const input = document.querySelector('[data-key="RRF_K"]');
    input.value = '90';
    input.dispatchEvent(new Event('input'));
    document.getElementById('gs-save').click();
    assert.equal(input.disabled, true);
    assert.equal(document.getElementById('gs-cancel').disabled, true);
    resolvePatch({ settings: [{ ...settings[0], configuredValue: 90, activeValue: 90 }] });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  });
});

describe('renderGlobalSettingsView — persistent pending across category switches', () => {
  it('an edit in one category survives navigating to another category and back', async () => {
    const retrievalSettings = [makeEntry({ key: 'RRF_K', category: 'retrieval', type: 'number', configuredValue: 60, activeValue: 60, advanced: true })];
    const aiSettings = [makeEntry({ key: 'ASK_MODEL', category: 'ai', type: 'string', configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false, advanced: false, appliesAt: 'next_restart' })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([...retrievalSettings, ...aiSettings]) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').setAttribute('open', '');
    document.querySelector('[data-key="RRF_K"]').value = '90';
    document.querySelector('[data-key="RRF_K"]').dispatchEvent(new Event('input'));
    assert.ok(document.getElementById('gs-save'));

    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.equal(document.getElementById('gs-save'), null, 'ai category itself has no pending edits yet');

    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').setAttribute('open', '');
    assert.equal(document.querySelector('[data-key="RRF_K"]').value, '90', 'the unsaved edit is restored');
    assert.ok(document.getElementById('gs-save'), 'Save/Cancel bar is still visible');
  });

  it('a beforeunload guard is registered while any category has pending edits and removed once empty', async () => {
    const settings = [makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 60, activeValue: 60, advanced: true })];
    const { document, renderGlobalSettingsView, __fireBeforeUnload, __beforeUnloadListenerCount } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    assert.equal(__beforeUnloadListenerCount(), 0);

    document.querySelector('.gs-advanced').open = true;
    document.querySelector('[data-key="RRF_K"]').value = '90';
    document.querySelector('[data-key="RRF_K"]').dispatchEvent(new Event('input'));
    assert.equal(__beforeUnloadListenerCount(), 1);
    const e = __fireBeforeUnload();
    assert.equal(e.defaultPrevented, true);

    document.getElementById('gs-cancel').click();
    assert.equal(__beforeUnloadListenerCount(), 0);
  });

  it('invalidating an in-flight Settings render never mutates location.hash', () => {
    const { location, invalidateGlobalSettingsRender } = loadGlobalSettingsHelpers({ hash: '#/c/my-docs' });
    const before = location.hash;
    invalidateGlobalSettingsRender();
    assert.equal(location.hash, before);
  });
});

describe('renderGlobalSettingsView — async race guards', () => {
  it('a slower earlier category response does not overwrite a faster later one', async () => {
    let resolveFirstRequest;
    const firstResponse = new Promise((resolve) => { resolveFirstRequest = resolve; });
    let requestCount = 0;
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': () => {
          requestCount += 1;
          return requestCount === 1 ? firstResponse : settingsPayload([]);
        },
      },
    });
    // First navigation starts immediately, but its HTTP response is held.
    const aiRenderPromise = renderGlobalSettingsView(document.getElementById('main'), 'ai');
    await Promise.resolve();
    // Second navigation (retrieval) — resolves immediately.
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    const activeAfterRetrieval = document.querySelector('#settings-nav-list a.active')?.dataset.category;
    assert.equal(activeAfterRetrieval, 'retrieval');

    // Now let the stale ai navigation resolve.
    resolveFirstRequest(settingsPayload([]));
    await aiRenderPromise;
    // The stale response must not have repainted over retrieval.
    const activeAfter = document.querySelector('#settings-nav-list a.active')?.dataset.category;
    assert.equal(activeAfter, 'retrieval', 'a stale ai response must not overwrite the active retrieval render');
  });

  it('invalidateGlobalSettingsRender() stops a stale settings response from repainting after navigating away', async () => {
    let resolveSettings;
    const settingsPromise = new Promise((resolve) => { resolveSettings = resolve; });
    const { document, renderGlobalSettingsView, invalidateGlobalSettingsRender } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': async () => { await settingsPromise; return settingsPayload([]); },
      },
    });
    const renderPromise = renderGlobalSettingsView(document.getElementById('main'), 'ai');
    // Simulate the router leaving the settings route before the slow GET resolves.
    invalidateGlobalSettingsRender();
    document.getElementById('main').innerHTML = '<div id="marker">collection view</div>';
    resolveSettings();
    await renderPromise;
    assert.ok(document.getElementById('marker'), 'the collection view content must survive the stale settings response');
  });
});

describe('renderGlobalSettingsView — override locking and reset', () => {
  it('a configuredSource os_env/dotenv entry renders a disabled control with an explanatory (non-"semidex can edit") message', async () => {
    const settings = [makeEntry({
      key: 'RRF_K', type: 'number', configuredValue: 50, activeValue: 50,
      configuredSource: 'os_env', activeSource: 'os_env', advanced: true,
    })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').open = true;
    const input = document.querySelector('[data-key="RRF_K"]');
    assert.equal(input.disabled, true);
    const field = input.closest('.gs-field');
    assert.match(field.textContent, /semidex cannot change this/);
    assert.doesNotMatch(field.textContent, /semidex can change/i);
  });

  it('"Use inherited value" is available even while the main control is locked by an env override', async () => {
    const settings = [makeEntry({
      key: 'RRF_K', type: 'number', configuredValue: 50, activeValue: 50,
      configuredSource: 'os_env', activeSource: 'os_env', hasLocalOverride: true, advanced: true,
    })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').open = true;
    const resetBtn = document.querySelector('.gs-field-reset[data-key="RRF_K"]');
    assert.ok(resetBtn);
    assert.equal(resetBtn.disabled, false);
  });

  it('clicking "Use inherited value" stages null, included in the next Save PATCH body', async () => {
    const settings = [makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 90, activeValue: 90, configuredSource: 'config_json', activeSource: 'config_json', hasLocalOverride: true, advanced: true })];
    const patchCalls = [];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
      apiPatchImpl: async (url, body) => { patchCalls.push({ url, body }); return {}; },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').open = true;
    document.querySelector('.gs-field-reset[data-key="RRF_K"]').click();
    assert.equal(document.querySelector('[data-key="RRF_K"]').value, '60',
      'reset previews the inherited default instead of rendering null');
    document.getElementById('gs-save').click();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(patchCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(patchCalls[0].body)), { changes: { RRF_K: null } });
  });
});

describe('renderGlobalSettingsView — pendingRestart + configured/active split', () => {
  it('shows configuredValue in the control and a distinct line naming the still-active old value', async () => {
    const settings = [makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', appliesAt: 'next_restart',
      configuredValue: 'llama3', activeValue: 'gemma3:4b',
      configuredSource: 'config_json', activeSource: 'default',
      pendingRestart: true, allowEmpty: false, advanced: false,
    })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const input = document.querySelector('[data-key="ASK_MODEL"]');
    assert.equal(input.value, 'llama3');
    const field = input.closest('.gs-field');
    assert.match(field.textContent, /still using the previous value/);
    assert.match(field.textContent, /gemma3:4b/);
  });
});

describe('renderGlobalSettingsView — missing configuredValue (unset field)', () => {
  it('an unset string field renders an empty control, no literal "undefined" text, and is not pending until edited', async () => {
    const settings = [makeEntry({
      key: 'QDRANT_URL', category: 'storage', type: 'string',
      configuredValue: undefined, activeValue: undefined,
      configuredSource: 'default', activeSource: 'default', allowEmpty: false, advanced: false,
    })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'storage');
    const input = document.querySelector('[data-key="QDRANT_URL"]');
    assert.equal(input.value, '');
    assert.doesNotMatch(document.getElementById('gs-content').textContent, /undefined/);
    assert.equal(document.getElementById('gs-save'), null, 'no pending change until the user edits the field');
  });
});

describe('renderGlobalSettingsView — combined impact toast', () => {
  it('saving two fields with requiresReindex fires ONE toast mentioning both, not two', async () => {
    const settings = [
      makeEntry({ key: 'MAX_CHUNK_TOKENS', category: 'indexing', type: 'number', configuredValue: 512, activeValue: 512, min: 1, max: 100000, requiresReindex: true, appliesAt: 'next_index_job', advanced: false }),
      makeEntry({ key: 'MIN_CHUNK_TOKENS', category: 'indexing', type: 'number', configuredValue: 160, activeValue: 160, min: 0, max: 100000, requiresReindex: true, appliesAt: 'next_index_job', advanced: true }),
    ];
    const refetched = settingsPayload(settings.map((s) => ({ ...s })));
    let getCallCount = 0;
    const { document, renderGlobalSettingsView, __toasts } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': () => { getCallCount += 1; return getCallCount === 1 ? settingsPayload(settings) : refetched; },
      },
      apiPatchImpl: async () => ({}),
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'indexing');
    document.querySelector('[data-key="MAX_CHUNK_TOKENS"]').value = '600';
    document.querySelector('[data-key="MAX_CHUNK_TOKENS"]').dispatchEvent(new Event('input'));
    document.querySelector('.gs-advanced').open = true;
    document.querySelector('[data-key="MIN_CHUNK_TOKENS"]').value = '200';
    document.querySelector('[data-key="MIN_CHUNK_TOKENS"]').dispatchEvent(new Event('input'));

    document.getElementById('gs-save').click();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const successToasts = __toasts.filter((t) => t.variant === 'success');
    assert.equal(successToasts.length, 1);
    assert.match(successToasts[0].message, /2 settings/);
  });
});

describe('renderGlobalSettingsView — secrets never rendered', () => {
  it('a QDRANT_KEY-shaped fixture never puts a value in the DOM, only Configured/Not configured', async () => {
    const settings = [{
      key: 'QDRANT_KEY', category: 'storage', label: 'Qdrant API key', type: 'secret',
      description: 'API key.', advanced: false, configured: true,
      writable: false, secret: true, hasLocalOverride: false, pendingRestart: false,
      appliesAt: null, requiresReindex: false, requiresBackfill: false,
      readOnlyReason: 'Secrets are environment-only and never persisted or displayed.',
    }];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'storage');
    const html = document.getElementById('gs-content').innerHTML;
    assert.ok(!/input/.test(html));
    assert.match(html, /Configured/);
  });
});

describe('renderGlobalSettingsView — API error handling', () => {
  for (const code of ['setting_overridden', 'invalid_value', 'not_writable', 'unknown_key']) {
    it(`code ${code} produces an error toast and leaves pending untouched for that category`, async () => {
      const settings = [makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 60, activeValue: 60, advanced: true })];
      const { document, renderGlobalSettingsView, __toasts } = loadGlobalSettingsHelpers({
        apiResponses: { '/api/settings': settingsPayload(settings) },
        apiPatchImpl: async () => { const err = new Error('failed'); err.code = code; throw err; },
      });
      await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
      document.querySelector('.gs-advanced').open = true;
      document.querySelector('[data-key="RRF_K"]').value = '90';
      document.querySelector('[data-key="RRF_K"]').dispatchEvent(new Event('input'));
      document.getElementById('gs-save').click();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const errorToasts = __toasts.filter((t) => t.variant === 'error');
      assert.equal(errorToasts.length, 1);
      // Pending is untouched — the Save bar (and the edited value) survive.
      assert.ok(document.getElementById('gs-save'));
      document.querySelector('.gs-advanced').open = true;
      assert.equal(document.querySelector('[data-key="RRF_K"]').value, '90');
    });
  }

  it('a failed PATCH leaves no row looking saved (DOM still shows pre-save value)', async () => {
    const settings = [makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 60, activeValue: 60, advanced: true })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
      apiPatchImpl: async () => { const err = new Error('failed'); err.code = 'invalid_value'; throw err; },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').open = true;
    document.querySelector('[data-key="RRF_K"]').value = '90';
    document.querySelector('[data-key="RRF_K"]').dispatchEvent(new Event('input'));
    document.getElementById('gs-save').click();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // configuredValue in the fixture (60) is what a real refetch would show
    // absent success — the control still reflects the staged (unsaved) 90,
    // never a silently "saved-looking" state with the Save bar gone.
    assert.ok(document.getElementById('gs-save'), 'the dirty state must survive a failed save');
  });

  it('a successful PATCH followed by a failed refresh stays saved and uses the PATCH response', async () => {
    const initial = makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 60, activeValue: 60, advanced: true });
    const updated = { ...initial, configuredValue: 90, activeValue: 90, configuredSource: 'config_json', activeSource: 'config_json', hasLocalOverride: true };
    let getCount = 0;
    const { document, renderGlobalSettingsView, __toasts, __beforeUnloadListenerCount } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': () => {
          getCount += 1;
          if (getCount > 1) throw new Error('refresh failed');
          return settingsPayload([initial]);
        },
      },
      apiPatchImpl: async () => ({ settings: [updated] }),
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').open = true;
    document.querySelector('[data-key="RRF_K"]').value = '90';
    document.querySelector('[data-key="RRF_K"]').dispatchEvent(new Event('input'));
    document.getElementById('gs-save').click();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(document.getElementById('gs-save'), null, 'persisted data must not remain dirty');
    document.querySelector('.gs-advanced').open = true;
    assert.equal(document.querySelector('[data-key="RRF_K"]').value, '90');
    assert.equal(__beforeUnloadListenerCount(), 0);
    assert.equal(__toasts.filter((toast) => toast.variant === 'warn').length, 1);
  });
});

describe('renderGlobalSettingsView — cancel', () => {
  it('reverts the DOM to last-fetched values for the current category, clears dirty state, no extra network call', async () => {
    const settings = [makeEntry({ key: 'RRF_K', type: 'number', configuredValue: 60, activeValue: 60, advanced: true })];
    const { document, renderGlobalSettingsView, __apiCalls } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    document.querySelector('.gs-advanced').open = true;
    document.querySelector('[data-key="RRF_K"]').value = '90';
    document.querySelector('[data-key="RRF_K"]').dispatchEvent(new Event('input'));
    const callsBeforeCancel = __apiCalls.length;

    document.getElementById('gs-cancel').click();
    document.querySelector('.gs-advanced').open = true;
    assert.equal(document.querySelector('[data-key="RRF_K"]').value, '60');
    assert.equal(document.getElementById('gs-save'), null);
    assert.equal(__apiCalls.length, callsBeforeCancel, 'Cancel must not make a network call');
  });
});

describe('renderGlobalSettingsView — future provider placeholders', () => {
  it('the ai category placeholder has zero interactive elements', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([]) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const placeholder = document.querySelector('.gs-placeholder');
    assert.ok(placeholder);
    assert.equal(placeholder.querySelectorAll('button, input, a').length, 0);
    assert.match(placeholder.textContent, /Ollama/);
    assert.match(placeholder.textContent, /Cloud providers are planned/);
  });

  it('the storage category placeholder has zero interactive elements', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([]) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'storage');
    const placeholder = document.querySelector('.gs-placeholder');
    assert.ok(placeholder);
    assert.equal(placeholder.querySelectorAll('button, input, a').length, 0);
    assert.match(placeholder.textContent, /Qdrant/);
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

// ── Provider-aware model discovery (visibleWhen/dynamicOptions/derivedWhen) ─

const OLLAMA_MODELS_MIXED = {
  available: true, reason: null,
  models: [
    { name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' },
    { name: 'llama3.2:3b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '3.2B', family: 'llama' },
    { name: 'nomic-embed-text', capabilities: ['embedding'], embeddingDimension: 768, parameterSize: '137M', family: 'nomic-bert' },
  ],
};

const OLLAMA_MODELS_UNREACHABLE = {
  available: false, reason: 'Ollama is not reachable at http://localhost:11434. Start it with "ollama serve".', models: [],
};

function tagProviderEntry(overrides = {}) {
  return makeEntry({
    key: 'TAG_PROVIDER', category: 'ai', type: 'enum', advanced: false,
    configuredValue: 'ollama', activeValue: 'ollama',
    options: [{ value: 'ollama', label: 'ollama' }, { value: 'onnx', label: 'onnx' }],
    appliesAt: 'next_index_job', requiresBackfill: true,
    ...overrides,
  });
}

function tagModelEntry(overrides = {}) {
  return makeEntry({
    key: 'TAG_MODEL', category: 'ai', type: 'string', advanced: true,
    configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
    visibleWhen: { key: 'TAG_PROVIDER', equals: 'ollama' },
    dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    appliesAt: 'next_index_job', requiresBackfill: true,
    ...overrides,
  });
}

function tagOnnxModelEntry(overrides = {}) {
  return makeEntry({
    key: 'TAG_ONNX_MODEL', category: 'ai', type: 'string', advanced: true,
    configuredValue: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct', activeValue: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct',
    allowEmpty: false,
    visibleWhen: { key: 'TAG_PROVIDER', equals: 'onnx' },
    appliesAt: 'next_index_job', requiresBackfill: true,
    ...overrides,
  });
}

function embeddingBackendEntry(overrides = {}) {
  return makeEntry({
    key: 'EMBEDDING_BACKEND', category: 'embeddings', type: 'enum', advanced: false,
    configuredValue: 'ollama', activeValue: 'ollama',
    options: [{ value: 'ollama', label: 'Ollama' }, { value: 'bge-m3-onnx', label: 'BGE-M3 (ONNX)' }],
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function embedModelEntry(overrides = {}) {
  return makeEntry({
    key: 'EMBED_MODEL', category: 'embeddings', type: 'string', advanced: false,
    configuredValue: 'bge-m3', activeValue: 'bge-m3', allowEmpty: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'ollama' },
    dynamicOptions: { source: 'ollama_models', capability: 'embedding' },
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function denseModelEntry(overrides = {}) {
  return makeEntry({
    key: 'DENSE_MODEL', category: 'embeddings', type: 'string', advanced: true,
    configuredValue: 'bge-m3', activeValue: 'bge-m3', allowEmpty: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
    derivedWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx', value: 'aapot/bge-m3-onnx' },
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function vectorSizeEntry(overrides = {}) {
  return makeEntry({
    key: 'VECTOR_SIZE', category: 'embeddings', type: 'number', advanced: true,
    configuredValue: 1024, activeValue: 1024, min: 1, max: 100000,
    derivedWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx', value: 1024 },
    dynamicDerived: {
      key: 'EMBEDDING_BACKEND', equals: 'ollama', source: 'ollama_models',
      modelKey: 'EMBED_MODEL', property: 'embeddingDimension',
    },
    writable: false,
    readOnlyReason: 'Detected from the embedding model.',
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function onnxExecutionProviderEntry(overrides = {}) {
  return makeEntry({
    key: 'ONNX_EXECUTION_PROVIDER', category: 'embeddings', type: 'enum', advanced: true,
    configuredValue: 'cpu', activeValue: 'cpu',
    options: [{ value: 'cpu', label: 'cpu' }, { value: 'dml', label: 'dml' }, { value: 'cuda', label: 'cuda' }],
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
    appliesAt: 'next_restart',
    ...overrides,
  });
}

describe('visibleWhen — TAG_PROVIDER drives TAG_MODEL/TAG_ONNX_MODEL', () => {
  it('TAG_PROVIDER=ollama (last-fetched): shows TAG_MODEL, hides TAG_ONNX_MODEL', async () => {
    const settings = [tagProviderEntry(), tagModelEntry(), tagOnnxModelEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.ok(document.querySelector('[data-key="TAG_MODEL"]'));
    assert.equal(document.querySelector('[data-key="TAG_ONNX_MODEL"]'), null);
  });

  it('TAG_PROVIDER=onnx (last-fetched): shows TAG_ONNX_MODEL, hides TAG_MODEL', async () => {
    const settings = [tagProviderEntry({ configuredValue: 'onnx', activeValue: 'onnx' }), tagModelEntry(), tagOnnxModelEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.ok(document.querySelector('[data-key="TAG_ONNX_MODEL"]'));
    assert.equal(document.querySelector('[data-key="TAG_MODEL"]'), null);
  });

  it('switching TAG_PROVIDER via a STAGED (unsaved) change immediately swaps visibility, no Save round trip', async () => {
    const settings = [tagProviderEntry(), tagModelEntry(), tagOnnxModelEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.ok(document.querySelector('[data-key="TAG_MODEL"]'));

    document.querySelector('.gs-advanced').open = true;
    const providerSelect = document.querySelector('[data-key="TAG_PROVIDER"]');
    providerSelect.querySelector('option[value="onnx"]').selected = true;
    providerSelect.dispatchEvent(new Event('change'));

    document.querySelector('.gs-advanced')?.setAttribute('open', '');
    assert.equal(document.querySelector('[data-key="TAG_MODEL"]'), null, 'TAG_MODEL must disappear immediately after the staged change');
    assert.ok(document.querySelector('[data-key="TAG_ONNX_MODEL"]'), 'TAG_ONNX_MODEL must appear immediately after the staged change');
  });
});

describe('visibleWhen/derivedWhen — EMBEDDING_BACKEND drives embeddings fields', () => {
  it('EMBEDDING_BACKEND=ollama: EMBED_MODEL is editable and VECTOR_SIZE is detected read-only', async () => {
    const settings = [
      embeddingBackendEntry(),
      embedModelEntry({ configuredValue: 'nomic-embed-text', activeValue: 'nomic-embed-text' }),
      denseModelEntry(),
      vectorSizeEntry(),
      onnxExecutionProviderEntry(),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');

    assert.ok(document.querySelector('[data-key="EMBED_MODEL"]'), 'EMBED_MODEL must be visible for the ollama backend');
    assert.equal(document.querySelector('[data-key="DENSE_MODEL"]'), null, 'DENSE_MODEL must be entirely hidden for the ollama backend');
    assert.equal(document.querySelector('[data-key="ONNX_EXECUTION_PROVIDER"]'), null);

    assert.equal(document.querySelector('[data-key="VECTOR_SIZE"]'), null,
      'VECTOR_SIZE must not be a manually editable control');
    assert.match(document.querySelector('[data-field="VECTOR_SIZE"]').textContent, /768/);
  });

  it('EMBEDDING_BACKEND=bge-m3-onnx: EMBED_MODEL hidden, DENSE_MODEL/VECTOR_SIZE read-only-derived, ONNX fields visible', async () => {
    const settings = [
      embeddingBackendEntry({ configuredValue: 'bge-m3-onnx', activeValue: 'bge-m3-onnx' }),
      embedModelEntry(), denseModelEntry(), vectorSizeEntry(), onnxExecutionProviderEntry(),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');

    assert.equal(document.querySelector('[data-key="EMBED_MODEL"]'), null, 'EMBED_MODEL ("Embedding model (Ollama)") must be absent when ONNX is active');

    document.querySelector('.gs-advanced').open = true;
    assert.equal(document.querySelector('[data-key="DENSE_MODEL"]'), null, 'DENSE_MODEL renders as read-only info, not an editable control, for ONNX');
    assert.match(document.getElementById('gs-content').textContent, /aapot\/bge-m3-onnx/);

    assert.equal(document.querySelector('[data-key="VECTOR_SIZE"]'), null, 'VECTOR_SIZE renders as read-only info, not an editable control, for ONNX');
    assert.match(document.getElementById('gs-content').textContent, /1024/);

    assert.ok(document.querySelector('[data-key="ONNX_EXECUTION_PROVIDER"]'), 'ONNX-only fields become visible');
  });

  it('switching EMBEDDING_BACKEND via a STAGED change immediately hides EMBED_MODEL and switches VECTOR_SIZE to read-only, without Save', async () => {
    const settings = [embeddingBackendEntry(), embedModelEntry(), denseModelEntry(), vectorSizeEntry(), onnxExecutionProviderEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    assert.ok(document.querySelector('[data-key="EMBED_MODEL"]'));

    const backendSelect = document.querySelector('[data-key="EMBEDDING_BACKEND"]');
    backendSelect.querySelector('option[value="bge-m3-onnx"]').selected = true;
    backendSelect.dispatchEvent(new Event('change'));

    assert.equal(document.querySelector('[data-key="EMBED_MODEL"]'), null, 'EMBED_MODEL disappears immediately');
    assert.equal(document.querySelector('input[data-key="VECTOR_SIZE"]'), null, 'VECTOR_SIZE is no longer an editable input');
  });
});

describe('dynamicOptions — Ollama model selects', () => {
  it('ASK_MODEL renders as a select containing only generation-capable installed models', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    assert.equal(select.tagName.toLowerCase(), 'select');
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.deepEqual(values.sort(), ['gemma3:4b', 'llama3.2:3b'].sort());
    assert.ok(!values.includes('nomic-embed-text'), 'embedding-capability models must not appear in a generation selector');
  });

  it('EMBED_MODEL renders as a select containing only embedding-capable installed models', async () => {
    // configuredValue matches an installed embedding model exactly, so no
    // "(not installed)" preserved-value option is added — isolates this
    // test to the capability-filter behavior alone (the preserved-value
    // case is covered separately below).
    const settings = [embeddingBackendEntry(), embedModelEntry({ configuredValue: 'nomic-embed-text', activeValue: 'nomic-embed-text' })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    const select = document.querySelector('[data-key="EMBED_MODEL"]');
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.deepEqual(values, ['nomic-embed-text']);
    assert.ok(!values.includes('gemma3:4b'), 'generation-capability models must not appear in an embedding selector');
  });

  it('configured model missing from the installed list is preserved as a distinct, selected, labeled-unavailable option', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'not-installed-model:9b', activeValue: 'not-installed-model:9b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    const selected = select.querySelector('option[selected]');
    assert.equal(selected.getAttribute('value'), 'not-installed-model:9b');
    assert.match(selected.textContent, /not installed/);
  });

  it('Ollama unreachable: the select shows the reachability reason, never renders empty, control is disabled not silently broken', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': OLLAMA_MODELS_UNREACHABLE },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    assert.ok(select, 'a control must still render, never vanish entirely');
    assert.ok(select.querySelectorAll('option').length > 0, 'must never render an empty <select>');
    assert.match(document.getElementById('gs-content').textContent, /not reachable/);
  });

  it('no installed models of the required capability (Ollama reachable): renders one disabled placeholder option, not an empty select', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: undefined, activeValue: undefined, allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([askModel]),
        '/api/ollama-models': { available: true, reason: null, models: [{ name: 'nomic-embed-text', capabilities: ['embedding'], embeddingDimension: 768, parameterSize: '137M', family: 'nomic-bert' }] },
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    assert.ok(select.querySelectorAll('option').length > 0);
    assert.match(select.textContent, /No installed models found/);
  });

  it('"Refresh models" re-fetches /api/ollama-models and updates the select options', async () => {
    let call = 0;
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView, __apiCalls } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([askModel]),
        '/api/ollama-models': () => {
          call += 1;
          return { available: true, reason: null, models: [{ name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' }] };
        },
        '/api/ollama-models?refresh=1': () => ({
          available: true,
          reason: null,
          models: [
            { name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' },
            { name: 'phi4:14b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '14B', family: 'phi' },
          ],
        }),
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const callsBefore = __apiCalls.filter((u) => u === '/api/ollama-models').length;
    assert.equal(callsBefore, 1);

    document.getElementById('gs-refresh-models').click();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(__apiCalls.filter((u) => u === '/api/ollama-models?refresh=1').length, 1);
    const values = [...document.querySelector('[data-key="ASK_MODEL"]').querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.ok(values.includes('phi4:14b'), 'the newly-installed model must appear after refresh');
  });

  it('a category with no dynamicOptions fields never fetches /api/ollama-models', async () => {
    const settings = [makeEntry({ key: 'RRF_K', category: 'retrieval', type: 'number', configuredValue: 60, activeValue: 60, advanced: true })];
    const { document, renderGlobalSettingsView, __apiCalls } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    assert.equal(__apiCalls.filter((u) => u === '/api/ollama-models').length, 0);
  });
});

function denseProviderEntry(overrides = {}) {
  return makeEntry({
    key: 'DENSE_PROVIDER', category: 'embeddings', type: 'enum', advanced: true, uiHidden: true,
    configuredValue: 'ollama', activeValue: 'ollama',
    options: [{ value: 'ollama', label: 'ollama' }, { value: 'bge-m3-onnx', label: 'bge-m3-onnx' }],
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function sparseProviderEntry(overrides = {}) {
  return makeEntry({
    key: 'SPARSE_PROVIDER', category: 'embeddings', type: 'enum', advanced: true, uiHidden: true,
    configuredValue: 'hashed-tf', activeValue: 'hashed-tf',
    options: [{ value: 'hashed-tf', label: 'hashed-tf' }, { value: 'bge-m3-onnx', label: 'bge-m3-onnx' }],
    appliesAt: 'new_collection',
    ...overrides,
  });
}

describe('EMBEDDING_BACKEND save — never produces an invalid dense/sparse combination', () => {
  it('saving after switching EMBEDDING_BACKEND sends only EMBEDDING_BACKEND in the PATCH body — the server-side expansion (tested in service.test.js) is what turns it into a matched DENSE_PROVIDER/SPARSE_PROVIDER pair', async () => {
    const settings = [embeddingBackendEntry()];
    const patchCalls = [];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
      apiPatchImpl: async (url, body) => { patchCalls.push({ url, body }); return { settings: [] }; },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    const backendSelect = document.querySelector('[data-key="EMBEDDING_BACKEND"]');
    backendSelect.querySelector('option[value="bge-m3-onnx"]').selected = true;
    backendSelect.dispatchEvent(new Event('change'));

    document.getElementById('gs-save').click();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(patchCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(patchCalls[0].body)), { changes: { EMBEDDING_BACKEND: 'bge-m3-onnx' } });
    // The UI never independently stages DENSE_PROVIDER/SPARSE_PROVIDER —
    // there is structurally no code path in this view that could produce a
    // mismatched pair, since DENSE_PROVIDER/SPARSE_PROVIDER aren't rendered
    // as separate controls reachable from this one selector's category flow.
    assert.ok(!('DENSE_PROVIDER' in patchCalls[0].body.changes));
    assert.ok(!('SPARSE_PROVIDER' in patchCalls[0].body.changes));
  });

  it('code review fix (P1): DENSE_PROVIDER/SPARSE_PROVIDER are genuinely absent from the DOM even when present in the real GET /api/settings response — regression test with the fixture the original test omitted', async () => {
    // The original version of this test only ever put EMBEDDING_BACKEND in
    // the fixture, so it could not observe that DENSE_PROVIDER/
    // SPARSE_PROVIDER render as real, independently-editable controls
    // elsewhere in the same category (under "Advanced settings") — a user
    // could open Advanced and set them to an invalid pair directly,
    // making the "structurally impossible" claim false as shipped. This
    // fixture includes both real entries the real API response would
    // carry, uiHidden: true and all, and asserts they truly never appear.
    const settings = [embeddingBackendEntry(), denseProviderEntry(), sparseProviderEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    // Open Advanced settings too, in case a regression renders them there
    // instead of hiding them outright.
    document.querySelector('.gs-advanced')?.setAttribute('open', '');
    assert.equal(document.querySelector('[data-key="DENSE_PROVIDER"]'), null, 'DENSE_PROVIDER must never render as a control, even inside Advanced settings');
    assert.equal(document.querySelector('[data-key="SPARSE_PROVIDER"]'), null, 'SPARSE_PROVIDER must never render as a control, even inside Advanced settings');
    assert.doesNotMatch(document.getElementById('gs-content').textContent, /Dense provider/);
    assert.doesNotMatch(document.getElementById('gs-content').textContent, /Sparse provider/);
  });
});

describe('dynamicOptions — env-locked field handling', () => {
  it('a configuredSource:os_env dynamicOptions field renders a disabled select showing the real configured value, not blank', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      configuredSource: 'os_env', activeSource: 'os_env',
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    assert.equal(select.hasAttribute('disabled'), true);
    const selected = select.querySelector('option[selected]');
    assert.equal(selected.getAttribute('value'), 'gemma3:4b');
  });
});

describe('EMBED_MODEL shadowedBy — legacy DENSE_MODEL override warning', () => {
  it('shows a warning line when a legacy DENSE_MODEL override is what is actually winning', async () => {
    const settings = [
      embeddingBackendEntry(),
      embedModelEntry({
        configuredValue: undefined, activeValue: undefined,
        shadowedBy: { key: 'DENSE_MODEL', value: 'legacy-model-name', source: 'os_env' },
      }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    const field = document.querySelector('[data-key="EMBED_MODEL"]').closest('.gs-field');
    assert.match(field.textContent, /legacy-model-name/);
    assert.match(field.textContent, /Operating system environment/);
  });

  it('no warning when EMBED_MODEL has its own value (shadowedBy: null)', async () => {
    const settings = [embeddingBackendEntry(), embedModelEntry({ shadowedBy: null })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    const field = document.querySelector('[data-key="EMBED_MODEL"]').closest('.gs-field');
    assert.doesNotMatch(field.textContent, /legacy/i);
  });
});

describe('dynamicOptions — unverified ("unknown") capability handling', () => {
  it('a model /api/show could not classify is still offered, visibly marked unverified, not silently hidden', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const modelsWithUnknown = {
      available: true, reason: null,
      models: [
        { name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' },
        { name: 'mystery-model:7b', capabilities: null, embeddingDimension: null, parameterSize: null, family: null },
      ],
    };
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': modelsWithUnknown },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.ok(values.includes('mystery-model:7b'), 'an unverified model must still be offered, not hidden');
    const unverifiedOption = [...select.querySelectorAll('option')].find((o) => o.getAttribute('value') === 'mystery-model:7b');
    assert.match(unverifiedOption.textContent, /unverified/);
  });
});

describe('embedding model dimension safety', () => {
  it('updates the read-only vector size when the selected model changes', async () => {
    const models = {
      available: true,
      reason: null,
      models: [
        { name: 'embed-384', capabilities: ['embedding'], embeddingDimension: 384, parameterSize: null, family: null },
        { name: 'embed-768', capabilities: ['embedding'], embeddingDimension: 768, parameterSize: null, family: null },
      ],
    };
    const settings = [
      embeddingBackendEntry(),
      embedModelEntry({ configuredValue: 'embed-384', activeValue: 'embed-384' }),
      vectorSizeEntry(),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': models },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    assert.match(document.querySelector('[data-field="VECTOR_SIZE"]').textContent, /384/);

    const select = document.querySelector('[data-key="EMBED_MODEL"]');
    select.querySelector('option[value="embed-768"]').selected = true;
    select.dispatchEvent(new Event('change'));
    assert.match(document.querySelector('[data-field="VECTOR_SIZE"]').textContent, /768/);
    assert.equal(document.getElementById('gs-save').disabled, false);
  });

  it('blocks saving an embedding model whose dimension is unknown', async () => {
    const models = {
      available: true,
      reason: null,
      models: [
        { name: 'embed-384', capabilities: ['embedding'], embeddingDimension: 384, parameterSize: null, family: null },
        { name: 'unknown-dimension', capabilities: ['embedding'], embeddingDimension: null, parameterSize: null, family: null },
      ],
    };
    const settings = [
      embeddingBackendEntry(),
      embedModelEntry({ configuredValue: 'embed-384', activeValue: 'embed-384' }),
      vectorSizeEntry(),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': models },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');

    const select = document.querySelector('[data-key="EMBED_MODEL"]');
    select.querySelector('option[value="unknown-dimension"]').selected = true;
    select.dispatchEvent(new Event('change'));
    assert.match(document.querySelector('[data-field="VECTOR_SIZE"]').textContent, /Unknown/);
    assert.equal(document.getElementById('gs-save').disabled, true);
  });
});

describe('invalid embedding provider configuration', () => {
  it('shows the raw invalid value and runtime validation error instead of pretending Ollama is active', async () => {
    const settings = [
      embeddingBackendEntry({
        configuredValue: 'broken-provider',
        activeValue: 'broken-provider',
        configuredSource: 'os_env',
        activeSource: 'os_env',
        invalidConfiguration: 'Invalid provider combination: denseProvider="broken-provider", sparseProvider="hashed-tf".',
      }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    const select = document.querySelector('[data-key="EMBEDDING_BACKEND"]');
    assert.equal(select.value, 'broken-provider');
    assert.equal(select.disabled, true);
    assert.match(document.getElementById('gs-content').textContent, /Invalid provider combination/);
  });
});
