// Tests for src/admin/ui-src/settings-view.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, readUiModuleWithPartial } from './ui-test-helpers.js';

describe('collection settings (ui-src/settings-view.js + settings-shell.html source)', () => {
  it('renders a settings view with reindex, repair, diagnostics, and delete', () => {
    const js = readUiModuleWithPartial('settings-view.js', 'full/settings-shell.html'); // "Advanced diagnostics" heading lives in settings-shell.html
    assert.match(js, /async function renderSettingsView/);
    assert.match(js, /Advanced diagnostics/);
  });

  it('starts a reindex job with the current collection name, no separate retyped field', () => {
    const js = readUiSource('settings-view.js');
    assert.match(js, /runSettingsReindex/);
    assert.match(js, /collection:\s*name,[\s\S]{0,80}path,/);
  });

  it('reindex options are grouped and include LLM summaries', () => {
    const js = readUiModuleWithPartial('settings-view.js', 'full/settings-shell.html'); // opt-group-label markup lives in settings-shell.html
    assert.match(js, /opt-group-label">Quality/);
    assert.match(js, /opt-llm-summaries/);
  });

  it('sends no skeletonChunking/skeletonNav reindex options — skeleton-first indexing is unconditional architecture, not a per-job choice', () => {
    const js = readUiModuleWithPartial('settings-view.js', 'full/settings-shell.html');
    assert.ok(!/skeletonChunking/.test(js));
    assert.ok(!/skeletonNav/.test(js));
    assert.ok(!js.includes('id="opt-skel-chunk"'));
    assert.ok(!js.includes('id="opt-skel-nav"'));
  });

  it('offers a recent-source-path selector with a manual fallback, not only a plain path input', () => {
    const js = readUiSource('settings-view.js');
    assert.match(js, /function renderSourcePathField/);
    assert.match(js, /settings-path-recent/);
    assert.match(js, /settings-path-manual/);
  });

  it('the manual source-path input has no HTML "required" attribute (JS-level validation only)', () => {
    // A `required` attribute on an input that can be hidden via display:none
    // (when a recent-path <select> is shown instead) risks blocking form
    // submission on native constraint validation before the JS handler ever
    // runs. Validation is done entirely by runSettingsReindex's own
    // "Source path is required" check instead. renderSourcePathField()
    // builds this input as a template string inside settings-view.js itself
    // (not a static partial), so plain ui-src source already has it.
    const js = readUiSource('settings-view.js');
    const inputTag = js.slice(js.indexOf('id="settings-path-manual"') - 60, js.indexOf('id="settings-path-manual"') + 150);
    assert.ok(!/\brequired\b/.test(inputTag), `manual path input must not have "required": ${inputTag}`);
  });

  it('requires a source path before starting a reindex', () => {
    const js = readUiSource('settings-view.js');
    assert.match(js, /Source path is required/);
  });

  it('renames sync-schema to "Repair collection compatibility" with an explanatory tooltip', () => {
    const js = readUiModuleWithPartial('settings-view.js', 'full/settings-shell.html'); // button label/tooltip live in settings-shell.html
    assert.match(js, /Repair collection compatibility/);
    assert.match(js, /Checks and repairs semidex metadata, vector names, and payload indexes/);
    assert.ok(!/>sync schema</i.test(js), 'old unexplained "sync schema" label must not remain verbatim');
  });

  it('keeps the reindex/prune-stale safety copy', () => {
    const js = readUiModuleWithPartial('settings-view.js', 'full/settings-shell.html'); // safety copy lives in settings-shell.html
    assert.match(js, /Reindex starts a background job and writes to this collection/);
    assert.match(js, /Use prune stale only with the full source root/);
  });

  it('delete uses a modal confirmation, not a typed-name text input', () => {
    const js = readUiSource('settings-view.js');
    assert.match(js, /delete-modal-backdrop/);
    assert.match(js, /openDeleteModal/);
    assert.ok(!/maint-delete-confirm/.test(js), 'old type-to-confirm text input must be gone');
    assert.ok(!/confirmInput/.test(js), 'old type-to-confirm input reference must be gone');
  });

  it('the delete modal calls DELETE with no request body', () => {
    const js = readUiSource('settings-view.js') + readUiSource('api.js');
    assert.match(js, /async function apiDelete\(path\)/, 'apiDelete must take no payload parameter');
    assert.match(js, /apiDelete\(`\/api\/collections\/\$\{encodeURIComponent\(name\)\}`\)/);
  });

  it('navigates away from the deleted collection after a successful delete', () => {
    const js = readUiSource('settings-view.js');
    assert.match(js, /async function runDeleteCollection\(name\)/);
    assert.match(js, /location\.hash = ["']#\/["']/);
  });

  it('advanced diagnostics (dense/sparse vector, provider, schema versions) are collapsed by default', () => {
    const js = readUiModuleWithPartial('settings-view.js', 'full/settings-shell.html'); // <details class="panel advanced-panel"> lives in settings-shell.html
    assert.match(js, /<details class="panel advanced-panel">/);
    assert.match(js, /function renderAdvancedDiagnostics/);
  });
});
