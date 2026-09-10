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

  it('Collection Home keeps warnings outside its collapsed Details panel', () => {
    const toastsJs = readUiSource('toasts.js');
    assert.match(toastsJs, /function showToast/, 'a toast mechanism must exist');
    const indexHtml = readUiSource('index.html');
    assert.match(indexHtml, /toast-host/, 'a toast host must be wired');
    const collectionHome = readUiSource('features/collection-home/view.js');
    const renderStart = collectionHome.indexOf('function renderHeader');
    const renderFn = collectionHome.slice(renderStart);
    assert.match(renderFn, /buildWarningsBanner\(warnings\)[\s\S]*detailsPanel\(detail\)/,
      'the visible warning banner must render before and outside Details');
  });

  it('#toast-host is announced to assistive tech via aria-live="polite" (Phase 3B audit)', () => {
    const indexHtml = readUiSource('index.html');
    const tagStart = indexHtml.indexOf('id="toast-host"');
    assert.ok(tagStart > -1, '#toast-host must exist in index.html');
    const tag = indexHtml.slice(indexHtml.lastIndexOf('<', tagStart), indexHtml.indexOf('>', tagStart) + 1);
    assert.match(tag, /aria-live="polite"/, 'the toast host must be a polite live region so new toasts are announced without stealing focus');
  });

  it('there is exactly one toast host in index.html (single shared instance, not per-view duplicates)', () => {
    const indexHtml = readUiSource('index.html');
    const matches = indexHtml.match(/id="toast-host"/g) ?? [];
    assert.equal(matches.length, 1);
  });
});
