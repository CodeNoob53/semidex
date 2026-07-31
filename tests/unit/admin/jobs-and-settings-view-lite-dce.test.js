// jobs-view.js / settings-view.js — the IS_LITE guards protecting the two
// SEPARATE indexing/reindex forms (collection-creation vs per-collection
// reindex) from referencing DOM elements vite.config.lite.js's
// stripHtmlMarkers plugin removes from the Lite build. See
// global-settings-view-lite-dce.test.js's own header comment for why this
// is a structural (source-level) test, not a build-output test, and what
// the real behavioral proof actually is (a real `vite build` pair,
// confirmed manually: full build content-hash unchanged in the parts that
// matter, Lite build has zero occurrences of every local-only marker).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('jobs-view.js — IS_LITE guards', () => {
  const src = readFileSync(new URL('../../../src/admin/ui-src/jobs-view.js', import.meta.url), 'utf-8');

  it('declares IS_LITE with the typeof guard (never throws when SEMIDEX_LITE is undeclared)', () => {
    assert.match(src, /const IS_LITE = typeof SEMIDEX_LITE !== 'undefined' && SEMIDEX_LITE;/);
  });

  it('loadOllamaStatus() starts with an IS_LITE guard', () => {
    const sigIndex = src.indexOf('async function loadOllamaStatus() {');
    assert.ok(sigIndex !== -1);
    const body = src.slice(sigIndex, sigIndex + 200);
    assert.match(body, /async function loadOllamaStatus\(\) \{\s*if \(IS_LITE\) return;/);
  });

  it('the #opt-llm-summaries change listener is only registered when !IS_LITE', () => {
    assert.match(src, /if \(!IS_LITE\) \{\s*\$\('#opt-llm-summaries'\)\.addEventListener/);
  });

  it('startIndexJob()\'s options object branches on IS_LITE — Lite sends ONLY pruneStale', () => {
    const sigIndex = src.indexOf('async function startIndexJob() {');
    assert.ok(sigIndex !== -1);
    const body = src.slice(sigIndex, sigIndex + 1200);
    assert.match(body, /options: IS_LITE\s*\?\s*\{\s*pruneStale: \$\('#opt-prune'\)\.checked\s*\}/);
  });
});

describe('settings-view.js — IS_LITE guards (reindex form)', () => {
  const src = readFileSync(new URL('../../../src/admin/ui-src/settings-view.js', import.meta.url), 'utf-8');

  it('declares IS_LITE with the typeof guard', () => {
    assert.match(src, /const IS_LITE = typeof SEMIDEX_LITE !== 'undefined' && SEMIDEX_LITE;/);
  });

  it('runSettingsReindex()\'s options object branches on IS_LITE — Lite sends ONLY pruneStale', () => {
    const sigIndex = src.indexOf('async function runSettingsReindex(name) {');
    assert.ok(sigIndex !== -1);
    const body = src.slice(sigIndex, sigIndex + 1200);
    assert.match(body, /options: IS_LITE\s*\?\s*\{\s*pruneStale: \$\('#opt-prune'\)\.checked\s*\}/);
  });
});

describe('HTML partials — Lite-strip markers are balanced (start + end present)', () => {
  const partials = [
    { file: '../../../src/admin/ui-src/partials/index-view.html', label: 'local-only-index-options' },
    { file: '../../../src/admin/ui-src/partials/settings-shell.html', label: 'local-only-reindex-options' },
  ];

  for (const { file, label } of partials) {
    it(`${file.split('/').pop()} has a balanced semidex-lite-strip:${label} marker pair`, () => {
      const src = readFileSync(new URL(file, import.meta.url), 'utf-8');
      assert.ok(src.includes(`<!-- semidex-lite-strip:${label}`), `missing start marker for ${label}`);
      assert.ok(src.includes(`<!-- semidex-lite-strip:end ${label} -->`), `missing end marker for ${label}`);
    });
  }

  it('the global-settings ONNX probe template still has its exact id (vite.config.lite.js\'s strip target)', () => {
    const src = readFileSync(new URL('../../../src/admin/ui-src/partials/templates/global-settings.html', import.meta.url), 'utf-8');
    assert.ok(src.includes('<template id="tpl-gs-onnx-probe-panel">'));
  });
});
