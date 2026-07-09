// Tests for src/admin/ui-src/sidebar-resize.js. Long file/section names
// need more room than the old fixed 240px column — width is user-adjustable
// via a drag handle or keyboard and remembered across sessions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, loadSidebarResizeHelpers } from './ui-test-helpers.js';

describe('sidebar resize — pure helpers (ui-src/sidebar-resize.js source, evaluated behavior)', () => {
  it('clampSidebarWidth clamps below-min up to the minimum', () => {
    const { clampSidebarWidth } = loadSidebarResizeHelpers();
    assert.equal(clampSidebarWidth(100), 240);
  });

  it('clampSidebarWidth clamps above-max down to the maximum', () => {
    const { clampSidebarWidth } = loadSidebarResizeHelpers();
    assert.equal(clampSidebarWidth(900), 520);
  });

  it('clampSidebarWidth falls back to the default for NaN/non-number input', () => {
    const { clampSidebarWidth } = loadSidebarResizeHelpers();
    assert.equal(clampSidebarWidth(NaN), 340);
    assert.equal(clampSidebarWidth('abc'), 340);
    assert.equal(clampSidebarWidth(undefined), 340);
    assert.equal(clampSidebarWidth(null), 340);
  });

  it('clampSidebarWidth passes an in-range value through unchanged', () => {
    const { clampSidebarWidth } = loadSidebarResizeHelpers();
    assert.equal(clampSidebarWidth(400), 400);
  });

  function makeFakeStorage() {
    const store = {};
    return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, _store: store };
  }

  it('readSidebarWidth/writeSidebarWidth round-trip through a storage-like object', () => {
    const { readSidebarWidth, writeSidebarWidth } = loadSidebarResizeHelpers();
    const storage = makeFakeStorage();
    writeSidebarWidth(storage, 400);
    assert.equal(readSidebarWidth(storage), 400);
  });

  it('readSidebarWidth returns the default when no width has been stored', () => {
    const { readSidebarWidth } = loadSidebarResizeHelpers();
    assert.equal(readSidebarWidth(makeFakeStorage()), 340);
  });

  it('readSidebarWidth falls back to the default (not clamped garbage) for a corrupted non-numeric stored value', () => {
    const { readSidebarWidth } = loadSidebarResizeHelpers();
    const storage = makeFakeStorage();
    storage._store['semidex-admin-sidebar-width'] = 'not-a-number';
    assert.equal(readSidebarWidth(storage), 340);
  });

  it('readSidebarWidth/writeSidebarWidth never throw even if storage access throws (e.g. private-mode quota)', () => {
    const { readSidebarWidth, writeSidebarWidth } = loadSidebarResizeHelpers();
    const throwingStorage = {
      getItem: () => { throw new Error('quota exceeded'); },
      setItem: () => { throw new Error('quota exceeded'); },
    };
    assert.doesNotThrow(() => readSidebarWidth(throwingStorage));
    assert.equal(readSidebarWidth(throwingStorage), 340);
    assert.doesNotThrow(() => writeSidebarWidth(throwingStorage, 400));
  });

  it('nextSidebarWidth steps left/right by the small step (16px)', () => {
    const { nextSidebarWidth } = loadSidebarResizeHelpers();
    assert.equal(nextSidebarWidth(320, 'ArrowLeft', false), 304);
    assert.equal(nextSidebarWidth(320, 'ArrowRight', false), 336);
  });

  it('nextSidebarWidth steps left/right by the large step (48px) with shiftKey', () => {
    const { nextSidebarWidth } = loadSidebarResizeHelpers();
    assert.equal(nextSidebarWidth(320, 'ArrowLeft', true), 272);
    assert.equal(nextSidebarWidth(320, 'ArrowRight', true), 368);
  });

  it('nextSidebarWidth: Home/End jump to min/max (unclamped result — caller clamps)', () => {
    const { nextSidebarWidth } = loadSidebarResizeHelpers();
    assert.equal(nextSidebarWidth(320, 'Home', false), 240);
    assert.equal(nextSidebarWidth(320, 'End', false), 520);
  });

  it('nextSidebarWidth: Enter or Space reset to the default width', () => {
    const { nextSidebarWidth } = loadSidebarResizeHelpers();
    assert.equal(nextSidebarWidth(450, 'Enter', false), 340);
    assert.equal(nextSidebarWidth(450, ' ', false), 340);
  });

  it('nextSidebarWidth returns null for keys it does not handle (caller must not preventDefault those)', () => {
    const { nextSidebarWidth } = loadSidebarResizeHelpers();
    assert.equal(nextSidebarWidth(320, 'Tab', false), null);
    assert.equal(nextSidebarWidth(320, 'a', false), null);
  });

  it('nextSidebarWidth result still needs clampSidebarWidth applied at the boundaries', () => {
    const { nextSidebarWidth, clampSidebarWidth } = loadSidebarResizeHelpers();
    // one more ArrowLeft below the minimum must clamp, not go negative/out-of-range
    assert.equal(clampSidebarWidth(nextSidebarWidth(240, 'ArrowLeft', false)), 240);
    assert.equal(clampSidebarWidth(nextSidebarWidth(520, 'ArrowRight', false)), 520);
  });
});

describe('sidebar resize — markup and CSS (ui-src source)', () => {
  it('index.html has an accessible resize handle', () => {
    const html = readUiSource('index.html');
    assert.match(html, /id="sidebar-resize-handle"/);
    assert.match(html, /role="separator"/);
    assert.match(html, /aria-orientation="vertical"/);
  });

  it('app.css sizes the sidebar column via a CSS custom property, not a fixed 240px', () => {
    const css = readUiSource('app.css');
    assert.match(css, /grid-template-columns:\s*var\(--sidebar-width,/);
    assert.ok(!/grid-template-columns:\s*240px 1fr/.test(css), 'the old fixed 240px column must be gone');
  });

  it('the handle is focusable (tabindex="0")', () => {
    const html = readUiSource('index.html');
    assert.match(html, /id="sidebar-resize-handle"[^>]*tabindex="0"/);
  });

  it('ARIA value attributes are not hardcoded in HTML — set dynamically from the JS width constants', () => {
    const html = readUiSource('index.html');
    assert.ok(!/aria-valuemin/.test(html), 'aria-valuemin must be set from JS, not hardcoded in HTML');
    assert.ok(!/aria-valuemax/.test(html), 'aria-valuemax must be set from JS, not hardcoded in HTML');
    assert.ok(!/aria-valuenow/.test(html), 'aria-valuenow must be set from JS, not hardcoded in HTML');
  });

  it('sidebar-resize.js sets aria-valuemin/aria-valuemax/aria-valuenow from the width constants', () => {
    const js = readUiSource('sidebar-resize.js');
    assert.match(js, /setAttribute\(['"]aria-valuemin['"],\s*String\(SIDEBAR_MIN_WIDTH\)\)/);
    assert.match(js, /setAttribute\(['"]aria-valuemax['"],\s*String\(SIDEBAR_MAX_WIDTH\)\)/);
    assert.match(js, /setAttribute\(['"]aria-valuenow['"]/);
    assert.match(js, /aria-valuetext/);
  });

  it('keyboard handler is wired on the resize handle and handles ArrowLeft/ArrowRight/Home/End/Enter/Space', () => {
    const js = readUiSource('sidebar-resize.js');
    assert.match(js, /addEventListener\(['"]keydown['"]/);
    assert.match(js, /ArrowLeft/);
    assert.match(js, /ArrowRight/);
    assert.match(js, /['"]Home['"]/);
    assert.match(js, /['"]End['"]/);
    assert.match(js, /['"]Enter['"]/);
  });

  it('keyboard handler calls preventDefault only for keys the resize control actually handles', () => {
    const js = readUiSource('sidebar-resize.js');
    const start = js.indexOf("addEventListener('keydown'");
    assert.ok(start !== -1, 'keydown handler should be defined on the resize handle');
    const fn = js.slice(start, start + 400);
    assert.match(fn, /nextSidebarWidth/);
    assert.match(fn, /if \(next === null\) return;/, 'unhandled keys must return early, not preventDefault');
    assert.match(fn, /preventDefault/);
  });

  it('app.css has a :focus-visible rule for the resize handle', () => {
    const css = readUiSource('app.css');
    assert.match(css, /\.sidebar-resize-handle:focus-visible/);
  });

  it('drag-end, double-click, and keyboard all funnel through the same shared setSidebarWidth helper', () => {
    const js = readUiSource('sidebar-resize.js');
    const matches = js.match(/setSidebarWidth\(/g) ?? [];
    // init + drag-end + dblclick + keyboard = at least 4 call sites sharing one path
    assert.ok(matches.length >= 4, `expected setSidebarWidth to be reused across input methods, found ${matches.length} call sites`);
  });
});
