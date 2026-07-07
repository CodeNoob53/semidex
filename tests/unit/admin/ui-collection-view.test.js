// Tests for src/admin/ui-src/collection-view.js (renderOverview,
// renderCollection, renderCollectionHeader) and general regression guards
// that the old flat technical panels stay removed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource } from './ui-test-helpers.js';

describe('collection header (ui-src/collection-view.js source)', () => {
  it('renders name, summary, health badge, and point count — no dense/sparse/provider strings', () => {
    const js = readUiSource('collection-view.js');
    assert.match(js, /function renderCollectionHeader/);
    const fn = js.slice(js.indexOf('function renderCollectionHeader'), js.indexOf('function renderCollectionHeader') + 1200);
    assert.ok(!/dense vector|sparse vector|denseProvider|chunkingSchema/.test(fn),
      'collection header must not render technical vector/provider/schema details');
  });

  it('has a settings button that navigates to the settings route using the #/c/ URL scheme', () => {
    const js = readUiSource('collection-view.js');
    assert.match(js, /col-settings-btn/);
    assert.match(js, /#\/c\/\$\{encodeURIComponent\(name\)\}\/settings/);
  });

  it('keeps name, health badge, and settings button always visible; collapses description/point-count/warnings behind a "Details" disclosure', () => {
    const js = readUiSource('collection-view.js');
    const start = js.indexOf('function renderCollectionHeader');
    const fn = js.slice(start, start + 1200);
    const topLineEnd = fn.indexOf('col-header-top');
    const detailsStart = fn.indexOf('<details class="panel advanced-panel"');
    assert.ok(detailsStart > -1, 'collection header must have a collapsible Details panel');
    assert.ok(fn.indexOf('col-settings-btn') < detailsStart, 'settings button must be outside/above the disclosure');
    assert.ok(fn.indexOf('healthBadge') < detailsStart || topLineEnd < detailsStart,
      'health badge must render on the always-visible top line, not inside the disclosure');
    const inside = fn.slice(detailsStart);
    assert.match(inside, /pointCount/, 'point count must be inside the collapsed Details panel');
  });
});

// ── Phase 2E: navigation-first dashboard redesign — old flat panels removed ─
describe('old flat technical panels are removed (ui-src source)', () => {
  it('no longer renders a separate Documents card', () => {
    const js = readUiSource('sidebar.js') + readUiSource('collection-view.js');
    assert.ok(!/col-docs/.test(js), 'old standalone Documents panel container must be gone');
    assert.ok(!/async function loadDocuments/.test(js), 'old loadDocuments() must be removed');
  });

  it('no longer uses the old #/collections/ URL scheme anywhere in the source', () => {
    const js = readUiSource('app.js') + readUiSource('router.js') + readUiSource('sidebar.js')
      + readUiSource('collection-view.js') + readUiSource('settings-view.js');
    assert.ok(!/#\/collections\//.test(js), 'old #/collections/ URL scheme must be fully removed');
  });

  it('no longer renders skeleton navigation as its own main-panel card', () => {
    const js = readUiSource('sidebar.js') + readUiSource('collection-view.js');
    assert.ok(!/col-skel/.test(js), 'old standalone skeleton-nav panel container must be gone');
  });

  it('the Metadata panel is not duplicated as a separate technical card in the collection view', () => {
    const js = readUiSource('collection-view.js');
    assert.ok(!/col-meta/.test(js), 'old standalone Metadata panel container must be gone');
  });
});
