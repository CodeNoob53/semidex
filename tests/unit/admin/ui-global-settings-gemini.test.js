// Gemini backend selection, provider-neutral ASK_MODEL discovery, and
// backend-switch invalid-model handling (Stage B1). Companion to
// ui-global-settings-providers.test.js, split into its own file to keep
// each settings test file under the established ~600-line ceiling.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Event } from 'linkedom';
import { loadGlobalSettingsHelpers } from './ui-test-helpers.js';
import { makeEntry, settingsPayload } from './ui-global-settings-fixtures.js';

// linkedom's <select> has no `.value` setter (confirmed against the
// existing ui-global-settings-providers.test.js pattern) — select the
// target <option> directly and toggle it, matching how that file's own
// TAG_PROVIDER-switch tests already do this.
function selectOptionByValue(select, value) {
  select.querySelector(`option[value="${value}"]`).selected = true;
  select.dispatchEvent(new Event('change'));
}

const OLLAMA_MODELS = {
  available: true, reason: null,
  models: [
    { name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' },
    { name: 'llama3.2:3b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '3.2B', family: 'llama' },
  ],
};

const GEMINI_MODELS = {
  backend: 'gemini', available: true, reason: null,
  models: [
    { name: 'gemini-2.5-flash', capabilities: ['generateContent'], embeddingDimension: null, parameterSize: null, family: null, inputTokenLimit: 1_000_000 },
    { name: 'gemini-1.5-pro', capabilities: ['generateContent'], embeddingDimension: null, parameterSize: null, family: null, inputTokenLimit: 2_000_000 },
    { name: 'text-embedding-004', capabilities: ['embedContent'], embeddingDimension: null, parameterSize: null, family: null, inputTokenLimit: 2048 },
  ],
};

const GEMINI_UNAVAILABLE = { backend: 'gemini', available: false, reason: 'GEMINI_API_KEY is not set. Model discovery is unavailable until it is configured.', models: [] };

function backendEntry(overrides = {}) {
  return makeEntry({
    key: 'SEMIDEX_GENERATION_BACKEND', category: 'ai', type: 'enum', advanced: false,
    configuredValue: 'ollama', activeValue: 'ollama',
    options: [{ value: 'ollama', label: 'Ollama' }, { value: 'gemini', label: 'Gemini' }],
    appliesAt: 'next_restart',
    ...overrides,
  });
}

function askModelEntry(overrides = {}) {
  return makeEntry({
    key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
    configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
    dynamicOptions: { source: 'generation_models', capability: 'generation' },
    appliesAt: 'next_restart',
    ...overrides,
  });
}

function ollamaUrlEntry(overrides = {}) {
  return makeEntry({
    key: 'OLLAMA_URL', category: 'ai', type: 'string', advanced: false,
    configuredValue: 'http://localhost:11434', activeValue: 'http://localhost:11434', allowEmpty: false,
    visibleWhen: { key: 'SEMIDEX_GENERATION_BACKEND', equals: 'ollama' },
    appliesAt: 'next_restart',
    ...overrides,
  });
}

function generationDeviceEntry(overrides = {}) {
  return makeEntry({
    key: 'GENERATION_DEVICE', category: 'ai', type: 'enum', advanced: true,
    configuredValue: 'auto', activeValue: 'auto',
    options: [{ value: 'auto', label: 'auto' }],
    visibleWhen: { key: 'SEMIDEX_GENERATION_BACKEND', equals: 'ollama' },
    appliesAt: 'next_restart',
    ...overrides,
  });
}

function geminiApiKeyEntry(overrides = {}) {
  return makeEntry({
    key: 'GEMINI_API_KEY', category: 'ai', type: 'secret', advanced: false,
    secret: true, configured: false, writable: false,
    readOnlyReason: 'Secrets are environment-only and never persisted or displayed.',
    visibleWhen: { key: 'SEMIDEX_GENERATION_BACKEND', equals: 'gemini' },
    appliesAt: 'next_restart',
    ...overrides,
  });
}

describe('SEMIDEX_GENERATION_BACKEND — selectable, real Gemini option', () => {
  it('renders as a writable select offering both ollama and gemini', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([backendEntry(), askModelEntry()]), '/api/generation/models?backend=ollama': OLLAMA_MODELS },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="SEMIDEX_GENERATION_BACKEND"]');
    assert.equal(select.tagName.toLowerCase(), 'select');
    assert.equal(select.disabled, false);
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.deepEqual(values.sort(), ['gemini', 'ollama']);
  });
});

describe('OLLAMA_URL / GENERATION_DEVICE — hidden for gemini, visible for ollama', () => {
  it('backend=ollama (last-fetched): both fields are visible', async () => {
    const settings = [backendEntry(), askModelEntry(), ollamaUrlEntry(), generationDeviceEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/generation/models?backend=ollama': OLLAMA_MODELS },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.ok(document.querySelector('[data-key="OLLAMA_URL"]'));
    assert.ok(document.querySelector('[data-key="GENERATION_DEVICE"]'));
  });

  it('backend=gemini (last-fetched): both fields are absent, GEMINI_API_KEY is shown instead', async () => {
    const settings = [
      backendEntry({ configuredValue: 'gemini', activeValue: 'gemini' }),
      askModelEntry({ configuredValue: 'gemini-2.5-flash', activeValue: 'gemini-2.5-flash' }),
      ollamaUrlEntry(), generationDeviceEntry(), geminiApiKeyEntry({ configured: true }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/generation/models?backend=gemini': GEMINI_MODELS },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.equal(document.querySelector('[data-key="OLLAMA_URL"]'), null);
    assert.equal(document.querySelector('[data-key="GENERATION_DEVICE"]'), null);
    const secretRow = document.querySelector('[data-field="GEMINI_API_KEY"]');
    assert.ok(secretRow, 'GEMINI_API_KEY row must be present when backend=gemini');
  });

  it('switching backend to gemini in a staged (unsaved) edit hides OLLAMA_URL/GENERATION_DEVICE immediately, no Save needed', async () => {
    const settings = [backendEntry(), askModelEntry(), ollamaUrlEntry(), generationDeviceEntry(), geminiApiKeyEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload(settings),
        '/api/generation/models?backend=ollama': OLLAMA_MODELS,
        '/api/generation/models?backend=gemini': GEMINI_MODELS,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.ok(document.querySelector('[data-key="OLLAMA_URL"]'));

    const select = document.querySelector('[data-key="SEMIDEX_GENERATION_BACKEND"]');
    selectOptionByValue(select, 'gemini');

    assert.equal(document.querySelector('[data-key="OLLAMA_URL"]'), null);
    assert.equal(document.querySelector('[data-key="GENERATION_DEVICE"]'), null);
    assert.ok(document.querySelector('[data-field="GEMINI_API_KEY"]'));
  });
});

describe('ASK_MODEL — provider-neutral generation_models discovery', () => {
  it('backend=ollama: ASK_MODEL renders only Ollama generation-capable models', async () => {
    const settings = [backendEntry(), askModelEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/generation/models?backend=ollama': OLLAMA_MODELS },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    assert.equal(select.tagName.toLowerCase(), 'select');
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.deepEqual(values.sort(), ['gemma3:4b', 'llama3.2:3b']);
  });

  it('backend=gemini: ASK_MODEL renders only Gemini generateContent-capable models, never an Ollama model name', async () => {
    const settings = [
      backendEntry({ configuredValue: 'gemini', activeValue: 'gemini' }),
      askModelEntry({ configuredValue: 'gemini-2.5-flash', activeValue: 'gemini-2.5-flash' }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/generation/models?backend=gemini': GEMINI_MODELS },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.deepEqual(values.sort(), ['gemini-1.5-pro', 'gemini-2.5-flash']);
    assert.ok(!values.includes('text-embedding-004'), 'an embedding-only Gemini model must not appear in a generation selector');
    assert.ok(!values.some((v) => v.includes('gemma') || v.includes('llama')), 'no Ollama model name may ever appear for the gemini backend');
  });

  it('backend=gemini, Gemini unreachable/unconfigured: shows an explicit unavailable state, never an empty select', async () => {
    const settings = [
      backendEntry({ configuredValue: 'gemini', activeValue: 'gemini' }),
      askModelEntry({ configuredValue: 'gemini-2.5-flash', activeValue: 'gemini-2.5-flash' }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/generation/models?backend=gemini': GEMINI_UNAVAILABLE },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    assert.equal(select.disabled, true);
    assert.ok(select.querySelectorAll('option').length > 0, 'must never render as an empty, native-broken-looking select');
    assert.match(document.getElementById('gs-content').textContent, /GEMINI_API_KEY is not set/);
  });

  it('switching from ollama to gemini (staged) re-fetches and swaps ASK_MODEL\'s options to the Gemini list', async () => {
    const settings = [backendEntry(), askModelEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload(settings),
        '/api/generation/models?backend=ollama': OLLAMA_MODELS,
        '/api/generation/models?backend=gemini': GEMINI_MODELS,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    let select = document.querySelector('[data-key="ASK_MODEL"]');
    let values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.ok(values.includes('gemma3:4b'));

    const backendSelect = document.querySelector('[data-key="SEMIDEX_GENERATION_BACKEND"]');
    selectOptionByValue(backendSelect, 'gemini');
    // The re-fetch for the new backend is async — flush enough microtask
    // ticks for refreshGenerationModels()'s awaited api() call and its
    // subsequent re-render to settle before asserting on the options.
    for (let i = 0; i < 8; i++) await Promise.resolve();

    select = document.querySelector('[data-key="ASK_MODEL"]');
    values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.ok(values.some((v) => v.startsWith('gemini-')), 'options must now come from the Gemini list');
  });
});

describe('backend switch invalidates a stale ASK_MODEL — Save is blocked until a valid model is chosen', () => {
  it('switching SEMIDEX_GENERATION_BACKEND marks ASK_MODEL invalid and disables Save', async () => {
    const settings = [backendEntry(), askModelEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload(settings),
        '/api/generation/models?backend=ollama': OLLAMA_MODELS,
        '/api/generation/models?backend=gemini': GEMINI_MODELS,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const backendSelect = document.querySelector('[data-key="SEMIDEX_GENERATION_BACKEND"]');
    selectOptionByValue(backendSelect, 'gemini');

    const saveBtn = document.getElementById('gs-save');
    assert.ok(saveBtn, 'a save bar must appear once the backend is staged as changed');
    assert.equal(saveBtn.disabled, true, 'Save must stay disabled — an Ollama model name is not a valid Gemini model');
    assert.match(document.querySelector('.gs-save-invalid')?.textContent ?? '', /./, 'an invalid-state message must be visible');
  });

  it('the stale model value is preserved (not silently replaced) as a selected, labeled-unavailable option', async () => {
    const settings = [backendEntry(), askModelEntry({ configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b' })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload(settings),
        '/api/generation/models?backend=ollama': OLLAMA_MODELS,
        '/api/generation/models?backend=gemini': GEMINI_MODELS,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const backendSelect = document.querySelector('[data-key="SEMIDEX_GENERATION_BACKEND"]');
    selectOptionByValue(backendSelect, 'gemini');

    const askModelSelect = document.querySelector('[data-key="ASK_MODEL"]');
    const selectedOption = [...askModelSelect.querySelectorAll('option')].find((o) => o.hasAttribute('selected'));
    assert.equal(selectedOption?.getAttribute('value'), 'gemma3:4b');
  });

  it('explicitly choosing a valid Gemini model clears the invalid flag and re-enables Save', async () => {
    const settings = [backendEntry(), askModelEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload(settings),
        '/api/generation/models?backend=ollama': OLLAMA_MODELS,
        '/api/generation/models?backend=gemini': GEMINI_MODELS,
      },
      apiPatchImpl: async () => ({ settings: [] }),
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const backendSelect = document.querySelector('[data-key="SEMIDEX_GENERATION_BACKEND"]');
    selectOptionByValue(backendSelect, 'gemini');
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const askModelSelect = document.querySelector('[data-key="ASK_MODEL"]');
    selectOptionByValue(askModelSelect, 'gemini-2.5-flash');

    const saveBtn = document.getElementById('gs-save');
    assert.equal(saveBtn.disabled, false, 'Save re-enables once a real, valid model for the new backend is explicitly chosen');
  });
});

describe('Refresh models — works for the gemini backend too', () => {
  it('clicking Refresh models re-fetches /api/generation/models for the currently staged backend', async () => {
    let callCount = 0;
    const { document, renderGlobalSettingsView, __apiCalls } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([
          backendEntry({ configuredValue: 'gemini', activeValue: 'gemini' }),
          askModelEntry({ configuredValue: 'gemini-2.5-flash', activeValue: 'gemini-2.5-flash' }),
        ]),
        '/api/generation/models?backend=gemini': () => { callCount += 1; return GEMINI_MODELS; },
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const before = callCount;
    const refreshBtn = document.getElementById('gs-refresh-models');
    assert.ok(refreshBtn, 'a refresh-models control must render for a generation_models-backed category');
    refreshBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(callCount > before, 'refresh must trigger another /api/generation/models call');
    assert.ok(__apiCalls.some((u) => u.includes('backend=gemini&refresh=1') || u.includes('backend=gemini') && u.includes('refresh=1')));
  });
});

describe('GEMINI_API_KEY — secret display contract', () => {
  it('shows "Configured"/"Not configured", never the key value', async () => {
    const settings = [
      backendEntry({ configuredValue: 'gemini', activeValue: 'gemini' }),
      askModelEntry({ configuredValue: 'gemini-2.5-flash', activeValue: 'gemini-2.5-flash' }),
      geminiApiKeyEntry({ configured: true }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/generation/models?backend=gemini': GEMINI_MODELS },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const row = document.querySelector('[data-field="GEMINI_API_KEY"]');
    assert.match(row.textContent, /Configured/);
    assert.ok(!row.textContent.includes('AIza'), 'a real-looking key prefix must never appear');
  });

  it('shows "Not configured" when the key is missing', async () => {
    const settings = [
      backendEntry({ configuredValue: 'gemini', activeValue: 'gemini' }),
      askModelEntry({ configuredValue: 'gemini-2.5-flash', activeValue: 'gemini-2.5-flash' }),
      geminiApiKeyEntry({ configured: false }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/generation/models?backend=gemini': GEMINI_UNAVAILABLE },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const row = document.querySelector('[data-field="GEMINI_API_KEY"]');
    assert.match(row.textContent, /Not configured/);
  });

  it('never renders an editable control for GEMINI_API_KEY (secret fields are never writable)', async () => {
    const settings = [
      backendEntry({ configuredValue: 'gemini', activeValue: 'gemini' }),
      askModelEntry({ configuredValue: 'gemini-2.5-flash', activeValue: 'gemini-2.5-flash' }),
      geminiApiKeyEntry({ configured: true }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/generation/models?backend=gemini': GEMINI_MODELS },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.equal(document.querySelector('[data-key="GEMINI_API_KEY"]'), null, 'secret fields render as a read-only badge row, never an editable control');
  });
});
