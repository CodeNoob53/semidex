// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md Finding
// P1-3's Settings UI half — INDEX_ALLOWED_ROOTS is the first (and so far
// only) 'string-array' typed setting; these tests exercise
// global-settings-view.js's generic string-array control, not anything
// INDEX_ALLOWED_ROOTS-specific (the field's own filesystem semantics are
// covered by tests/unit/security/path-containment.test.js and
// tests/unit/security/spawn-indexer-path-validation.test.js instead).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Event } from 'linkedom';
import { loadGlobalSettingsHelpers } from './ui-test-helpers.js';
import { makeEntry, settingsPayload } from './ui-global-settings-fixtures.js';

function stringArrayEntry(overrides = {}) {
  return makeEntry({
    key: 'INDEX_ALLOWED_ROOTS', category: 'system', type: 'string-array',
    label: 'Allowed indexing roots (API)', description: 'Directories the API may index from.',
    default: [], configuredValue: [], activeValue: [], advanced: false, appliesAt: 'immediate',
    ...overrides,
  });
}

describe('renderGlobalSettingsView — string-array control', () => {
  it('renders a textarea (not a text input) with one configured path per line', async () => {
    const settings = [stringArrayEntry({ configuredValue: ['C:\\docs', 'D:\\shared'], activeValue: ['C:\\docs', 'D:\\shared'] })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'system');

    const textarea = document.querySelector('[data-key="INDEX_ALLOWED_ROOTS"]');
    assert.ok(textarea, 'expected a control for INDEX_ALLOWED_ROOTS');
    assert.equal(textarea.tagName.toLowerCase(), 'textarea');
    assert.equal(textarea.value, 'C:\\docs\nD:\\shared');
  });

  it('an empty configured array renders an empty textarea, not the literal text "undefined" or "[]"', async () => {
    const settings = [stringArrayEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'system');

    const textarea = document.querySelector('[data-key="INDEX_ALLOWED_ROOTS"]');
    assert.equal(textarea.value, '');
  });

  it('typing new lines stages an array (blank lines dropped, entries trimmed) and enables Save', async () => {
    const settings = [stringArrayEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'system');

    const textarea = document.querySelector('[data-key="INDEX_ALLOWED_ROOTS"]');
    textarea.value = '  C:\\docs  \n\nD:\\shared\n';
    textarea.dispatchEvent(new Event('input'));

    const saveBtn = document.getElementById('main').querySelector('#gs-save');
    assert.ok(saveBtn, 'expected the save bar to appear for a real change');
    assert.equal(saveBtn.disabled, false);
  });

  it('editing then retyping the exact original content removes the pending change (Save bar disappears)', async () => {
    const settings = [stringArrayEntry({ configuredValue: ['C:\\docs'], activeValue: ['C:\\docs'] })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'system');

    const textarea = document.querySelector('[data-key="INDEX_ALLOWED_ROOTS"]');
    textarea.value = 'C:\\docs\nD:\\shared';
    textarea.dispatchEvent(new Event('input'));
    const main = document.getElementById('main');
    assert.ok(main.querySelector('#gs-save'), 'expected a pending change after editing');

    textarea.value = 'C:\\docs';
    textarea.dispatchEvent(new Event('input'));
    assert.equal(main.querySelector('#gs-save'), null, 'reverting to the original list must clear the pending change, not just re-stage the same array by reference');
  });

  it('Save sends the parsed array (not the raw textarea text) as the PATCH body value', async () => {
    const settings = [stringArrayEntry()];
    const patchCalls = [];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
      apiPatchImpl: async (url, body) => { patchCalls.push({ url, body }); return { settings: [] }; },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'system');

    const textarea = document.querySelector('[data-key="INDEX_ALLOWED_ROOTS"]');
    textarea.value = 'C:\\docs\nD:\\shared';
    textarea.dispatchEvent(new Event('input'));
    document.getElementById('main').querySelector('#gs-save').click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].url, '/api/settings');
    assert.deepEqual(Array.from(patchCalls[0].body.changes.INDEX_ALLOWED_ROOTS), ['C:\\docs', 'D:\\shared']);
  });

  it('a locked (os_env-sourced) field disables the textarea, matching every other field\'s lock behavior', async () => {
    const settings = [stringArrayEntry({ configuredSource: 'os_env', activeSource: 'os_env' })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'system');

    const textarea = document.querySelector('[data-key="INDEX_ALLOWED_ROOTS"]');
    assert.equal(textarea.disabled, true);
  });
});
