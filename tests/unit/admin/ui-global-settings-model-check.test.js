// Inline "Check" control for a Gemini generation model (ASK_MODEL).
//
// The behaviour under test exists because the Gemini API gives no
// deprecation signal and models.list() keeps returning retired models — so
// the list is NOT filtered, and the operator verifies on demand instead.
// These tests pin exactly that: never auto-run, never pre-judge, and a
// non-verdict (quota/network) must never be shown as a failure.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Event } from 'linkedom';
import { loadGlobalSettingsHelpers } from './ui-test-helpers.js';
import { makeEntry, settingsPayload } from './ui-global-settings-fixtures.js';

const GEMINI_MODELS = {
  backend: 'gemini', available: true, reason: null,
  models: [
    { name: 'gemini-3.6-flash', capabilities: ['generateContent'], embeddingDimension: null, parameterSize: null, family: null, inputTokenLimit: 1_000_000 },
    { name: 'gemini-2.5-flash', capabilities: ['generateContent'], embeddingDimension: null, parameterSize: null, family: null, inputTokenLimit: 1_000_000 },
  ],
};

const OLLAMA_MODELS = {
  backend: 'ollama', available: true, reason: null,
  models: [{ name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' }],
};

function backendEntry(value) {
  return makeEntry({
    key: 'SEMIDEX_GENERATION_BACKEND', category: 'ai', type: 'enum', advanced: false,
    configuredValue: value, activeValue: value,
    options: [{ value: 'ollama', label: 'Ollama' }, { value: 'gemini', label: 'Gemini' }],
    appliesAt: 'next_restart',
  });
}

function askModelEntry(value, overrides = {}) {
  return makeEntry({
    key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
    configuredValue: value, activeValue: value, allowEmpty: false,
    dynamicOptions: { source: 'generation_models', capability: 'generation' },
    appliesAt: 'next_restart',
    ...overrides,
  });
}

async function renderGemini({ model = 'gemini-3.6-flash', apiPostImpl, askModelOverrides } = {}) {
  const helpers = loadGlobalSettingsHelpers({
    apiResponses: {
      '/api/settings': settingsPayload([backendEntry('gemini'), askModelEntry(model, askModelOverrides)]),
      '/api/generation/models?backend=gemini': GEMINI_MODELS,
    },
    apiPostImpl,
  });
  await helpers.renderGlobalSettingsView(helpers.document.getElementById('main'), 'ai');
  return helpers;
}

/** The handler awaits a fetch then updates the DOM — two microtask turns. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('model Check control — presence', () => {
  it('renders next to a Gemini generation-model select', async () => {
    const { document } = await renderGemini();
    const check = document.querySelector('.gs-model-check');
    assert.ok(check, 'expected a Check control for a Gemini model field');
    assert.ok(check.querySelector('.gs-model-check-button'));
  });

  it('is NOT rendered for the Ollama backend — its own model list is authoritative', async () => {
    const helpers = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([backendEntry('ollama'), askModelEntry('gemma3:4b')]),
        '/api/generation/models?backend=ollama': OLLAMA_MODELS,
      },
    });
    await helpers.renderGlobalSettingsView(helpers.document.getElementById('main'), 'ai');
    assert.equal(helpers.document.querySelector('.gs-model-check'), null);
  });

  it('the status starts blank — an unchecked model must never look verified', async () => {
    const { document } = await renderGemini();
    const status = document.querySelector('.gs-model-check-status');
    assert.equal(status.hidden, true);
    assert.equal(status.textContent, '');
    assert.equal(status.className, 'gs-model-check-status', 'no verdict class before any check');
  });

  it('the model list is NOT filtered — a model that will turn out to be retired is still offered', async () => {
    const { document } = await renderGemini();
    const values = [...document.querySelectorAll('[data-key="ASK_MODEL"] option')].map((o) => o.getAttribute('value'));
    assert.ok(values.includes('gemini-2.5-flash'),
      'the list must stay complete: hiding models by name/generation would be a guess that breaks on the next release');
  });
});

describe('model Check control — probing', () => {
  it('never auto-runs on render; a click posts the model to /api/generation/model-probe', async () => {
    const calls = [];
    const { document } = await renderGemini({
      apiPostImpl: async (url, body) => { calls.push({ url, body }); return { model: body.model, status: 'available', detail: null }; },
    });
    assert.equal(calls.length, 0, 'a billed probe must never run on render');

    document.querySelector('.gs-model-check-button').dispatchEvent(new Event('click'));
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/generation/model-probe');
    assert.equal(calls[0].body.model, 'gemini-3.6-flash');
  });

  it('probes the CURRENT selection, not the value present at render time', async () => {
    const calls = [];
    const { document } = await renderGemini({
      apiPostImpl: async (url, body) => { calls.push(body.model); return { model: body.model, status: 'available', detail: null }; },
    });
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    select.querySelector('option[value="gemini-2.5-flash"]').selected = true;
    select.dispatchEvent(new Event('change'));

    document.querySelector('.gs-model-check-button').dispatchEvent(new Event('click'));
    await settle();

    assert.deepEqual(calls, ['gemini-2.5-flash'],
      'an operator who changes the selection then clicks Check must verify what they can now see');
  });

  it('an available model shows a success status and a success toast', async () => {
    const { document, __toasts } = await renderGemini({
      apiPostImpl: async () => ({ model: 'gemini-3.6-flash', status: 'available', detail: null }),
    });
    document.querySelector('.gs-model-check-button').dispatchEvent(new Event('click'));
    await settle();

    const status = document.querySelector('.gs-model-check-status');
    assert.equal(status.hidden, false);
    assert.ok(status.classList.contains('is-ok'));
    assert.match(status.textContent, /Available/);
    assert.equal(__toasts.at(-1).variant, 'success');
  });

  it('a retired model shows a failure status and surfaces the API message naming the replacement', async () => {
    const detail = 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.6-flash.';
    const { document, __toasts } = await renderGemini({
      model: 'gemini-2.5-flash',
      apiPostImpl: async () => ({ model: 'gemini-2.5-flash', status: 'retired', detail }),
    });
    document.querySelector('.gs-model-check-button').dispatchEvent(new Event('click'));
    await settle();

    const status = document.querySelector('.gs-model-check-status');
    assert.ok(status.classList.contains('is-fail'));
    assert.match(status.textContent, /Not available/);
    const toast = __toasts.at(-1);
    assert.equal(toast.variant, 'error');
    assert.match(toast.message, /gemini-3\.6-flash/,
      'the replacement model named by the API is the single most useful detail — it must reach the operator');
  });

  it('a model on a different API surface is reported as not usable here, not as retired', async () => {
    const { document, __toasts } = await renderGemini({
      apiPostImpl: async () => ({ model: 'deep-research-preview', status: 'unsupported', detail: 'This model only supports Interactions API.' }),
    });
    document.querySelector('.gs-model-check-button').dispatchEvent(new Event('click'));
    await settle();

    assert.match(document.querySelector('.gs-model-check-status').textContent, /Not usable here/);
    assert.match(__toasts.at(-1).message, /Interactions API/);
  });
});

describe('model Check control — a non-verdict is never shown as a failure', () => {
  it('an unknown outcome (quota/transient) shows a warning, never a failure', async () => {
    const { document, __toasts } = await renderGemini({
      apiPostImpl: async () => ({ model: 'gemini-3.6-flash', status: 'unknown', detail: 'Resource has been exhausted (e.g. check quota).' }),
    });
    document.querySelector('.gs-model-check-button').dispatchEvent(new Event('click'));
    await settle();

    const status = document.querySelector('.gs-model-check-status');
    assert.ok(status.classList.contains('is-warn'));
    assert.equal(status.classList.contains('is-fail'), false,
      'a quota error says nothing about the MODEL — reporting it as unavailable would hide a working model');
    assert.match(status.textContent, /Could not verify/);
    assert.equal(__toasts.at(-1).variant, 'warn');
  });

  it('a failed REQUEST is a warning about the check, not a verdict about the model', async () => {
    const { document, __toasts } = await renderGemini({
      apiPostImpl: async () => { throw new Error('network down'); },
    });
    document.querySelector('.gs-model-check-button').dispatchEvent(new Event('click'));
    await settle();

    const status = document.querySelector('.gs-model-check-status');
    assert.ok(status.classList.contains('is-warn'));
    assert.equal(status.classList.contains('is-fail'), false);
    assert.equal(__toasts.at(-1).variant, 'warn');
    assert.match(__toasts.at(-1).message, /Could not check/);
  });

  it('the button is re-enabled after a failure so the operator can retry', async () => {
    const { document } = await renderGemini({
      apiPostImpl: async () => { throw new Error('boom'); },
    });
    const button = document.querySelector('.gs-model-check-button');
    button.dispatchEvent(new Event('click'));
    await settle();
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Check');
  });
});
