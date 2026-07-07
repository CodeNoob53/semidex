// Tests for src/admin/ui-src/toasts.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, loadToastHelpers } from './ui-test-helpers.js';

describe('collection warning delivery (ui-src/toasts.js source, evaluated behavior)', () => {
  it('showToast() appends a visible, readable toast into #toast-host', () => {
    const { showToast, document } = loadToastHelpers();
    showToast('legacy flat vector schema — hybrid search unavailable');
    const toasts = document.querySelectorAll('#toast-host .toast');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].textContent, /hybrid search unavailable/);
  });

  it('showCollectionWarnings() shows one toast per distinct warning text', () => {
    const { showCollectionWarnings, document } = loadToastHelpers();
    showCollectionWarnings('demo', ['warning A', 'warning B']);
    const toasts = document.querySelectorAll('#toast-host .toast');
    assert.equal(toasts.length, 2);
  });

  it('does not spam a duplicate toast for the same collection + warning text seen again', () => {
    const { showCollectionWarnings, document } = loadToastHelpers();
    showCollectionWarnings('demo', ['no vector schema found on this collection']);
    showCollectionWarnings('demo', ['no vector schema found on this collection']);
    const toasts = document.querySelectorAll('#toast-host .toast');
    assert.equal(toasts.length, 1, 're-showing the same collection+warning must not add a second toast');
  });

  it('the same warning text on a different collection is not deduped away', () => {
    const { showCollectionWarnings, document } = loadToastHelpers();
    showCollectionWarnings('demo-a', ['no vector schema found on this collection']);
    showCollectionWarnings('demo-b', ['no vector schema found on this collection']);
    const toasts = document.querySelectorAll('#toast-host .toast');
    assert.equal(toasts.length, 2, 'dedupe key must be scoped per collection, not warning text alone');
  });

  it('collection-view.js\'s renderCollection() triggers warning toasts on collection open', () => {
    const js = readUiSource('collection-view.js');
    assert.match(js, /showCollectionWarnings\(name, detail\.warnings\)/,
      'opening a collection must route its warnings through the toast dedupe path, not render them ad hoc');
  });

  it('the collapsed Details panel is not the only place warning text appears — toasts exist as a separate delivery path', () => {
    const toastsJs = readUiSource('toasts.js');
    assert.match(toastsJs, /function showToast/, 'a toast mechanism must exist');
    const indexHtml = readUiSource('index.html');
    assert.match(indexHtml, /toast-host/, 'a toast host must be wired');
    // The badge itself (health summary) must still be visible outside Details —
    // regression guard for the Phase 3A header collapsibility this builds on.
    const collectionViewJs = readUiSource('collection-view.js');
    const start = collectionViewJs.indexOf('function renderCollectionHeader');
    const fn = collectionViewJs.slice(start, start + 1200);
    const detailsIdx = fn.indexOf('<details');
    const badgeIdx = fn.indexOf('healthBadge');
    assert.ok(badgeIdx > -1 && badgeIdx < detailsIdx, 'health badge must render before/outside the Details disclosure');
  });
});
