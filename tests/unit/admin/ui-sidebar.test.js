// Tests for src/admin/ui-src/sidebar.js. API behavior is covered in
// server.test.js/jobs.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, loadSidebarLabelHelpers, loadSidebarActiveStateHelpers, loadSidebarNodeInteractionHelpers, loadSidebarTreeHelpers } from './ui-test-helpers.js';

describe('sidebar navigation tree (ui-src/sidebar.js source)', () => {
  it('renders collections as an expandable tree, not a flat link list', () => {
    const js = readUiSource('sidebar.js');
    assert.match(js, /function renderSidebarList/);
    assert.match(js, /tree-collection-row/);
    assert.match(js, /tree-children/);
  });

  it('loads the skeleton tree for a selected collection, falling back to a flat file list', () => {
    const js = readUiSource('sidebar.js');
    assert.match(js, /async function loadSidebarTree/);
    assert.match(js, /hasSkeleton/);
    assert.match(js, /async function loadSidebarFileList/);
    assert.match(js, /\/documents\?limit=/);
  });

  it('drills into skeleton children via /api/collections/:name/skeleton/children', () => {
    const js = readUiSource('sidebar.js');
    assert.match(js, /\/skeleton\/children\?/);
  });

  it('clicking a file/section opens the file view, not a separate route', () => {
    const js = readUiSource('sidebar.js');
    // Section/leaf-file clicks route through location.hash — file-view.js's
    // openFileView is invoked by router.js, not called directly from
    // sidebar.js (see the "route through the hash" comment in the source).
    assert.match(js, /location\.hash = `#\/c\//);
  });

  it('an empty section (404 from skeleton/anchor) does not auto-open chunk 0 — it requires an explicit click', () => {
    // This behavior lives in file-view.js's openSectionView (sidebar.js only
    // routes through the hash; file-view.js is what resolves the anchor).
    const js = readUiSource('file-view.js');
    const start = js.indexOf('async function openSectionView');
    assert.ok(start !== -1, 'openSectionView should be defined');
    // file-view.js exports openFileView directly ('export async function
    // openFileView'), unlike the old monolithic app.js where it was a bare
    // top-level declaration — match on the substring after 'export '.
    const end = js.indexOf('async function openFileView', start);
    assert.ok(end !== -1 && end > start, 'openFileView should follow openSectionView');
    const fn = js.slice(start, end);
    assert.match(fn, /section-open-file-start/);
    assert.match(fn, /addEventListener\(["']click["'], \(\) => openFileView/);
    assert.ok(!/return openFileView\(name, node\.sourceFile, node\.nodePath, 0\);/.test(fn),
      'a 404 from skeleton/anchor must not automatically open chunk 0 of the file');
  });
});

// ── Phase 3D: a file WITH sections still opens directly on row click ────────
// Prior behavior treated a file-with-children exactly like a directory: the
// row click only expanded/collapsed its sections, never opened the file
// itself — the caret and the row body were the same click target. Since
// nearly every real markdown file has at least one section, this made
// "click a file, see its chunks" almost unreachable for skeleton-enabled
// collections. The caret is now its own click target for expand/collapse;
// the row body always opens the file.
describe('sidebar file rows: row click opens the file, caret click expands sections', () => {
  it('row click on a file-with-sections navigates to the file route, not an expand', async () => {
    const helpers = loadSidebarNodeInteractionHelpers({
      apiResponses: {
        root: [{ nodeType: 'file', nodePath: 'sql/SELECT.md#file', sourceFile: 'sql/SELECT.md', childCount: 3 }],
      },
    });
    const box = helpers.document.getElementById('root');
    await helpers.renderSidebarSkeletonLevel(box, 'my-docs', { nodePath: 'root', childCount: 1 }, 0);

    const row = box.querySelector('.tree-node');
    assert.ok(row, 'sanity: the file row rendered');
    row.click();
    await Promise.resolve(); // onSidebarNodeClick is async but the hash write itself is synchronous

    assert.equal(helpers.location.hash, `#/c/my-docs/f/${encodeURIComponent('sql/SELECT.md')}`,
      'clicking the row body must open the file, not just expand its sections');
    assert.equal(box.querySelector('.tree-subtree'), null,
      'a row click must not also expand the sections subtree');
  });

  it('caret click on a file-with-sections expands the sections subtree, without navigating', async () => {
    const helpers = loadSidebarNodeInteractionHelpers({
      apiResponses: {
        root: [{ nodeType: 'file', nodePath: 'sql/SELECT.md#file', sourceFile: 'sql/SELECT.md', childCount: 3 }],
        'sql/SELECT.md#file': [{ nodeType: 'section', nodePath: 'sql/SELECT.md#intro', childCount: 0 }],
      },
    });
    const box = helpers.document.getElementById('root');
    await helpers.renderSidebarSkeletonLevel(box, 'my-docs', { nodePath: 'root', childCount: 1 }, 0);

    const caret = box.querySelector('.tree-caret[data-caret]');
    assert.ok(caret, 'a file with childCount > 0 must render a clickable caret');
    caret.click();
    await Promise.resolve();
    await Promise.resolve(); // toggleSidebarNodeExpand's own api() await

    assert.equal(helpers.location.hash, '#/', 'caret click must never navigate/open the file');
    assert.ok(box.querySelector('.tree-subtree'), 'caret click must expand the sections subtree');
  });

  // ── Phase 3L: confirm a section ROW click still navigates via the hash,
  // same single code path as a file click — this was previously only
  // covered indirectly (route-parsing tests + openSectionView()'s own
  // rendering tests), never as an actual simulated row click. ────────────
  it('row click on a section node navigates to the section route, not an expand', async () => {
    const helpers = loadSidebarNodeInteractionHelpers({
      apiResponses: {
        root: [{ nodeType: 'section', nodePath: 'sql/SELECT.md#intro', sourceFile: 'sql/SELECT.md', childCount: 0 }],
      },
    });
    const box = helpers.document.getElementById('root');
    await helpers.renderSidebarSkeletonLevel(box, 'my-docs', { nodePath: 'root', childCount: 1 }, 0);

    const row = box.querySelector('.tree-node');
    assert.ok(row, 'sanity: the section row rendered');
    row.click();
    await Promise.resolve();

    assert.equal(helpers.location.hash, `#/c/my-docs/n/${encodeURIComponent('sql/SELECT.md#intro')}`,
      'clicking a section row must route through the same #/c/:name/n/:nodePath hash as a pasted/back-forward URL');
  });

  it('a file with NO sections (childCount 0) renders no clickable caret at all', () => {
    const helpers = loadSidebarNodeInteractionHelpers();
    const { sidebarNodeRow } = helpers;
    const html = sidebarNodeRow({ nodeType: 'file', nodePath: 'WHERE.md#file', sourceFile: 'WHERE.md', childCount: 0 }, 0, 0);
    assert.ok(!html.includes('data-caret'), 'a leaf file has nothing to expand, so its caret must not be a separate click target');
  });

  it('a directory caret still expands on caret click, same as before', async () => {
    const helpers = loadSidebarNodeInteractionHelpers({
      apiResponses: {
        root: [{ nodeType: 'directory', nodePath: 'my-docs#dir/sql', childCount: 2 }],
      },
    });
    const box = helpers.document.getElementById('root');
    await helpers.renderSidebarSkeletonLevel(box, 'my-docs', { nodePath: 'root', childCount: 1 }, 0);

    const caret = box.querySelector('.tree-caret[data-caret]');
    assert.ok(caret, 'a directory must render a clickable caret');
    caret.click();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(helpers.location.hash, '#/', 'caret click on a directory must not navigate');
    assert.ok(box.querySelector('.tree-subtree'), 'caret click must expand the directory');
  });

  it('clicking a directory row body (not the caret) also still expands — directories have no separate "open" action', async () => {
    const helpers = loadSidebarNodeInteractionHelpers({
      apiResponses: {
        root: [{ nodeType: 'directory', nodePath: 'my-docs#dir/sql', childCount: 2 }],
      },
    });
    const box = helpers.document.getElementById('root');
    await helpers.renderSidebarSkeletonLevel(box, 'my-docs', { nodePath: 'root', childCount: 1 }, 0);

    const row = box.querySelector('.tree-node');
    row.click();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(helpers.location.hash, '#/', 'a directory row click must not navigate');
    assert.ok(box.querySelector('.tree-subtree'), 'a directory row click must still expand (no caret-vs-row split for directories)');
  });
});

// ── Phase 3R: revealSidebarPath() expands whatever collapsed ancestor
// directories stand between the tree root and a file, so a file opened from
// somewhere other than a direct sidebar click (currently: a search-result
// "Open" button) can still be highlighted — markActive() alone only toggles
// .active on rows already present in the DOM, it can't reveal a row buried
// inside a collapsed folder.
describe('revealSidebarPath(): expands collapsed ancestor folders to reveal a file', () => {
  it('expands a single collapsed ancestor directory and leaves the file row present in the DOM', async () => {
    const helpers = loadSidebarNodeInteractionHelpers({
      apiResponses: {
        'my-docs#dir/sql': [{ nodeType: 'file', nodePath: 'sql/SELECT.md#file', sourceFile: 'sql/SELECT.md', childCount: 0 }],
      },
    });
    const doc = helpers.document;
    // Build the top-level tree exactly as renderSidebarList()'s
    // `<div class="tree-children" id="tree-${cssId(name)}">` container, with
    // one collapsed directory row already rendered inside it (as if the
    // collection had already been expanded once, but this particular
    // subfolder never was).
    const treeBox = doc.createElement('div');
    treeBox.id = 'tree-my-docs';
    doc.body.appendChild(treeBox);
    treeBox.innerHTML = helpers.sidebarNodeRow({ nodeType: 'directory', nodePath: 'my-docs#dir/sql', childCount: 1 }, 0, 0);

    assert.equal(treeBox.querySelector('.tree-subtree'), null, 'sanity: the directory starts collapsed');
    await helpers.revealSidebarPath('my-docs', 'sql/SELECT.md');

    const fileRow = treeBox.querySelector('.tree-node[data-path="sql/SELECT.md#file"]');
    assert.ok(fileRow, 'the file row must exist in the DOM after revealing its path');
    assert.ok(treeBox.querySelector('.tree-subtree'), 'the ancestor directory must now be expanded');
  });

  it('a file at the collection root (no directory segments) is a no-op — nothing to expand', async () => {
    const helpers = loadSidebarNodeInteractionHelpers();
    const doc = helpers.document;
    const treeBox = doc.createElement('div');
    treeBox.id = 'tree-my-docs';
    doc.body.appendChild(treeBox);
    treeBox.innerHTML = '<div class="tree-node" data-path="readme.md#file"></div>';

    await assert.doesNotReject(helpers.revealSidebarPath('my-docs', 'readme.md'));
    assert.equal(treeBox.querySelectorAll('.tree-subtree').length, 0, 'a root-level file must not trigger any expansion');
  });

  it('gives up quietly (no throw) when an ancestor directory is not present in the currently-rendered level', async () => {
    const helpers = loadSidebarNodeInteractionHelpers();
    const doc = helpers.document;
    const treeBox = doc.createElement('div');
    treeBox.id = 'tree-my-docs';
    doc.body.appendChild(treeBox);
    treeBox.innerHTML = '<div class="tree-node" data-path="my-docs#dir/other"></div>'; // "sql" is not here

    await assert.doesNotReject(helpers.revealSidebarPath('my-docs', 'sql/SELECT.md'),
      'a best-effort reveal must never throw just because the tree has not been expanded down to that point yet');
  });
});

// ── skeleton node labels and chunk display clarity ───────────────────────────
describe('sidebar node labels (ui-src/sidebar.js source, evaluated behavior)', () => {
  it('a file node with nodePath "pitch-en.md#file" renders as "pitch-en.md", not "file"', () => {
    const { nodeDisplayLabel } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const label = nodeDisplayLabel({ nodeType: 'file', nodePath: 'pitch-en.md#file', sourceFile: 'pitch-en.md' });
    assert.equal(label, 'pitch-en.md');
    assert.notEqual(label, 'file');
  });

  it('a file node under a subfolder renders only the basename, not the folder path', () => {
    const { nodeDisplayLabel } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const label = nodeDisplayLabel({
      nodeType: 'file',
      nodePath: 'Тема 10. Процеси в Linux/1. Вступ.md#file',
      sourceFile: 'Тема 10. Процеси в Linux/1. Вступ.md',
    });
    assert.equal(label, '1. Вступ.md');
  });

  it('a section node uses the last heading_path entry, not the raw nodePath', () => {
    const { nodeDisplayLabel } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const label = nodeDisplayLabel({
      nodeType: 'section',
      nodePath: 'pitch-en.md#intro/details',
      headingPath: ['Introduction', 'Details'],
      summary: 'Details — 3 paragraphs',
    });
    assert.equal(label, 'Details');
  });

  it('a section node with no heading_path falls back to summary, not the raw nodePath', () => {
    const { nodeDisplayLabel } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const label = nodeDisplayLabel({
      nodeType: 'section', nodePath: 'pitch-en.md#вступ', headingPath: [], summary: 'Вступ',
    });
    assert.equal(label, 'Вступ');
  });

  it('a directory node renders its own directory name, not the full nested path', () => {
    const { nodeDisplayLabel } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const label = nodeDisplayLabel({
      nodeType: 'directory',
      nodePath: 'demo#dir/Тема 10. Процеси в Linux (ps, top, kill, htop)',
    });
    assert.equal(label, 'Тема 10. Процеси в Linux (ps, top, kill, htop)');
  });

  it('a nested directory node renders only its own segment, not the parent path', () => {
    const { nodeDisplayLabel } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const label = nodeDisplayLabel({ nodeType: 'directory', nodePath: 'demo#dir/parent/child' });
    assert.equal(label, 'child');
  });

  it('sidebarNodeRow keeps node_path and summary in the tooltip only, not the visible label', () => {
    const { sidebarNodeRow } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const html = sidebarNodeRow({
      nodeType: 'file', nodePath: 'pitch-en.md#file', sourceFile: 'pitch-en.md', summary: 'Pitch deck', childCount: 0,
    }, 0, 0);
    assert.match(html, /title="Pitch deck — pitch-en\.md#file"/);
    assert.match(html, />pitch-en\.md</);
    assert.ok(!html.includes('>pitch-en.md#file<'), 'raw node_path must not be the visible label text');
  });

  it('sidebarNodeRow carries a stable data-path attribute (for active-state lookup by markActive)', () => {
    const { sidebarNodeRow } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const html = sidebarNodeRow({ nodeType: 'section', nodePath: 'readme.md#intro', childCount: 0 }, 0, 0);
    assert.match(html, /data-path="readme\.md#intro"/);
  });

  it('sidebarNodeRow is keyboard-focusable (tabindex + role=button + accessible name) — it is a <div>, not a native control', () => {
    const { sidebarNodeRow } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const html = sidebarNodeRow({ nodeType: 'section', nodePath: 'readme.md#intro', childCount: 0 }, 0, 0);
    assert.match(html, /tabindex="0"/);
    assert.match(html, /role="button"/);
    assert.match(html, /aria-label="/);
  });

  it('a skeleton tree row responds to Enter/Space, not click alone', () => {
    const js = readUiSource('sidebar.js');
    const start = js.indexOf('async function renderSidebarSkeletonLevel');
    const end = js.indexOf('async function fetchSkeletonChildren');
    const fn = js.slice(start, end);
    assert.match(fn, /addEventListener\('click', \(\) => onSidebarNodeClick/);
    assert.match(fn, /addEventListener\('keydown'/);
    assert.match(fn, /e\.key !== 'Enter' && e\.key !== ' '/);
  });
});

// ── Phase 3A: sidebar active state extends to the open file/section ────────
describe('markActive() — global settings gear link (#nav-global-settings, Phase 4A.5b)', () => {
  it('marks the gear link active on the global-settings route', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'global-settings' });
    assert.ok(document.getElementById('nav-global-settings').classList.contains('active'));
  });

  it('does not mark the gear link active on any other route', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'collection', name: 'my-docs' });
    assert.ok(!document.getElementById('nav-global-settings').classList.contains('active'));
  });

  it('clears the gear link active state when navigating away from #/settings', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'global-settings' });
    markActive({ view: 'overview' });
    assert.ok(!document.getElementById('nav-global-settings').classList.contains('active'));
  });
});

// ── S2A: shell-level Overview/Collections nav (design plan §4.1/§4.2) ──────
describe('markActive() — shell Overview/Collections nav (#nav-overview/#nav-collections, S2A)', () => {
  it('marks #nav-overview active and aria-current="page" on the overview route, leaving #nav-collections inactive with no aria-current', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'overview' });
    const overview = document.getElementById('nav-overview');
    const collections = document.getElementById('nav-collections');
    assert.ok(overview.classList.contains('active'));
    assert.equal(overview.getAttribute('aria-current'), 'page');
    assert.ok(!collections.classList.contains('active'));
    assert.equal(collections.hasAttribute('aria-current'), false);
  });

  it('marks #nav-collections active and aria-current="page" on the collections route, leaving #nav-overview inactive with no aria-current', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'collections' });
    const overview = document.getElementById('nav-overview');
    const collections = document.getElementById('nav-collections');
    assert.ok(collections.classList.contains('active'));
    assert.equal(collections.getAttribute('aria-current'), 'page');
    assert.ok(!overview.classList.contains('active'));
    assert.equal(overview.hasAttribute('aria-current'), false);
  });

  it('removes aria-current from the previously-active link (not merely left stale) when navigating between the two', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'overview' });
    markActive({ view: 'collections' });
    assert.equal(document.getElementById('nav-overview').hasAttribute('aria-current'), false);
    assert.equal(document.getElementById('nav-collections').getAttribute('aria-current'), 'page');
  });

  it('neither link is active/aria-current on an unrelated route (e.g. a collection route)', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'collection', name: 'my-docs' });
    for (const id of ['nav-overview', 'nav-collections']) {
      const el = document.getElementById(id);
      assert.ok(!el.classList.contains('active'));
      assert.equal(el.hasAttribute('aria-current'), false);
    }
  });
});

// The active-state distinction must survive without colour as the only
// signal (WCAG 1.4.1) — .nav-list a.active already added a background tint
// and a coloured left border, but both of those are themselves colour
// changes; this pins a non-colour (font-weight) difference too, on top of
// aria-current="page" (asserted above) for assistive tech.
describe('app.css: .nav-list a.active is distinguishable beyond colour alone', () => {
  it('.nav-list a.active sets a font-weight distinct from the base .nav-list a rule', () => {
    const css = readUiSource('app.css');
    const baseRule = css.match(/\.nav-list a\s*\{([^}]*)\}/)?.[1] ?? '';
    const activeRule = css.match(/\.nav-list a\.active\s*\{([^}]*)\}/)?.[1] ?? '';
    assert.ok(activeRule, '.nav-list a.active must exist as its own rule');
    const activeWeight = activeRule.match(/font-weight:\s*(\d+)/)?.[1];
    assert.ok(activeWeight, '.nav-list a.active must set an explicit font-weight beyond the shared background/border-colour treatment');
    const baseWeight = baseRule.match(/font-weight:\s*(\d+)/)?.[1] ?? '400';
    assert.notEqual(activeWeight, baseWeight, 'the active link\'s font-weight must differ from the inactive/base weight');
  });
});

describe('markActive() highlights the open file/section row, not just the collection row', () => {
  it('highlights the .tree-file row matching route.openFile', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'collection', name: 'my-docs', openFile: 'readme.md' });
    assert.ok(document.querySelector('.tree-file[data-sf="readme.md"]').classList.contains('active'));
    assert.ok(!document.querySelector('.tree-node[data-path="readme.md#intro"]').classList.contains('active'));
  });

  it('highlights the .tree-node row matching route.openNodePath', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'collection', name: 'my-docs', openNodePath: 'readme.md#intro' });
    assert.ok(document.querySelector('.tree-node[data-path="readme.md#intro"]').classList.contains('active'));
    assert.ok(!document.querySelector('.tree-file[data-sf="readme.md"]').classList.contains('active'));
  });

  it('clears prior file/section active state when navigating to a route with neither', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'collection', name: 'my-docs', openFile: 'readme.md' });
    markActive({ view: 'collection', name: 'my-docs' });
    assert.ok(!document.querySelector('.tree-file[data-sf="readme.md"]').classList.contains('active'));
  });

  it('still highlights the collection row alongside the file/section row', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'collection', name: 'my-docs', openFile: 'readme.md' });
    assert.ok(document.querySelector('.tree-collection-row[data-name="my-docs"]').classList.contains('active'));
  });

  // ── Phase 3R: route.openFile must also highlight a SKELETON tree's own
  // file row, not just the flat-fallback-mode .tree-file row. A skeleton
  // file node's data-path is always "<sourceFile>#file" (the indexer's own
  // node_path convention for file nodes, skeleton-index.js), so this is a
  // stable derivation from route.openFile, not a heuristic. Before this
  // fix, opening a file in a skeleton-nav collection (the common case) left
  // the sidebar tree showing no active row at all.
  it('highlights a skeleton tree\'s own .tree-node file row (data-path="<sourceFile>#file") matching route.openFile', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'collection', name: 'my-docs', openFile: 'readme.md' });
    assert.ok(document.querySelector('.tree-node[data-path="readme.md#file"]').classList.contains('active'),
      'a skeleton file row must be highlighted too, not just the flat-mode .tree-file row');
  });

  it('does not cross-highlight a skeleton file row for an unrelated openFile', () => {
    const { document, markActive } = loadSidebarActiveStateHelpers();
    markActive({ view: 'collection', name: 'my-docs', openFile: 'other.md' });
    assert.ok(!document.querySelector('.tree-node[data-path="readme.md#file"]').classList.contains('active'));
  });
});

// ── Phase 3K: sidebar empty/loading/error/fallback states (behavioral,
// not source-regex) — none of loadSidebar()/loadSidebarTree()/
// loadSidebarFileList()'s fetch-failure or empty-result branches had DOM-
// level test coverage before this phase. ────────────────────────────────
describe('sidebar collection list — empty and error states', () => {
  it('shows a calm, actionable message when there are no collections at all', async () => {
    const { document, loadSidebar } = loadSidebarTreeHelpers({
      apiResponses: { '/api/collections': { collections: [] } },
    });
    await loadSidebar();
    const item = document.querySelector('#collection-list li');
    assert.match(item.textContent, /No collections yet/);
    assert.doesNotMatch(item.textContent, /HTTP \d|Error|undefined/i, 'must not read like a technical/debug message');
  });

  it('shows a distinct, non-raw error message (not err.message) when the collection list fetch fails', async () => {
    const { document, loadSidebar } = loadSidebarTreeHelpers({
      apiResponses: { '/api/collections': new Error('ECONNREFUSED 127.0.0.1:6333') },
    });
    await loadSidebar();
    const item = document.querySelector('#collection-list li');
    assert.doesNotMatch(item.textContent, /ECONNREFUSED/, 'the raw error message must not leak into the visible text');
    assert.match(item.textContent, /Couldn't load|try again/i);
    assert.ok(item.classList.contains('tree-error'), 'a failed fetch must be visually distinct from an empty state');
    assert.equal(item.getAttribute('title'), 'ECONNREFUSED 127.0.0.1:6333', 'the real error stays available via title for anyone who needs it');
  });

  it('renders each collection\'s pointCount as a formatted, always-visible count badge — no extra fetch needed', async () => {
    const { document, loadSidebar } = loadSidebarTreeHelpers({
      apiResponses: {
        '/api/collections': { collections: [{ name: 'big-collection', pointCount: 12345 }, { name: 'empty-collection', pointCount: 0 }] },
      },
    });
    await loadSidebar();
    const rows = document.querySelectorAll('.tree-collection-row');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector('.count').textContent, '12,345',
      'the count must come straight from the already-fetched /api/collections list (locale-formatted), not a separate per-collection fetch');
    assert.equal(rows[1].querySelector('.count').textContent, '0',
      'a collection with zero points must still show a "0" count, not omit the badge or show blank/undefined');
  });
});

describe('sidebar tree — loading/empty/error states for a selected collection', () => {
  function withTreeContainer(document, name) {
    const box = document.createElement('div');
    box.id = `tree-${name}`;
    document.body.appendChild(box);
    return box;
  }

  it('falls back to a flat file list when the collection has no skeleton (hasSkeleton: false)', async () => {
    const { document, loadSidebarTree } = loadSidebarTreeHelpers({
      apiResponses: {
        '/api/collections/my-docs': { collection: { hasSkeleton: false } },
        '/api/collections/my-docs/documents?limit=': { documents: [{ sourceFile: 'readme.md' }, { sourceFile: 'guide.md' }] },
      },
    });
    withTreeContainer(document, 'my-docs');
    await loadSidebarTree('my-docs');
    const rows = document.querySelectorAll('#tree-my-docs .tree-file');
    assert.equal(rows.length, 2);
    assert.match(rows[0].querySelector('.tree-label').textContent, /readme\.md/);
  });

  it('falls back to a flat file list when the skeleton root is null (200 response, no skeleton layer)', async () => {
    const { document, loadSidebarTree } = loadSidebarTreeHelpers({
      apiResponses: {
        '/api/collections/my-docs': { collection: { hasSkeleton: true } },
        '/api/collections/my-docs/skeleton': { skeleton: null },
        '/api/collections/my-docs/documents?limit=': { documents: [{ sourceFile: 'a.md' }] },
      },
    });
    withTreeContainer(document, 'my-docs');
    await loadSidebarTree('my-docs');
    assert.equal(document.querySelectorAll('#tree-my-docs .tree-file').length, 1,
      'a null skeleton (not an error) must still fall back to the flat file list, not an error state');
  });

  it('falls back to a flat file list when the skeleton fetch itself throws', async () => {
    const { document, loadSidebarTree } = loadSidebarTreeHelpers({
      apiResponses: {
        '/api/collections/my-docs': { collection: { hasSkeleton: true } },
        '/api/collections/my-docs/skeleton': new Error('boom'),
        '/api/collections/my-docs/documents?limit=': { documents: [{ sourceFile: 'a.md' }] },
      },
    });
    withTreeContainer(document, 'my-docs');
    await loadSidebarTree('my-docs');
    assert.equal(document.querySelectorAll('#tree-my-docs .tree-file').length, 1,
      'a broken skeleton fetch must degrade to the flat file list, not show a raw error');
  });

  it('shows a clean "No documents" message (not raw API text) when the flat file list is genuinely empty', async () => {
    const { document, loadSidebarTree } = loadSidebarTreeHelpers({
      apiResponses: {
        '/api/collections/my-docs': { collection: { hasSkeleton: false } },
        '/api/collections/my-docs/documents?limit=': { documents: [] },
      },
    });
    const box = withTreeContainer(document, 'my-docs');
    await loadSidebarTree('my-docs');
    assert.match(box.textContent, /No documents/);
    assert.doesNotMatch(box.textContent, /HTTP \d|undefined|null/i);
    assert.ok(!box.querySelector('.tree-error'), 'a genuinely empty file list must not read as an error');
  });

  it('shows a distinct error state (not the collection detail\'s raw message) when the collection detail fetch fails', async () => {
    const { document, loadSidebarTree } = loadSidebarTreeHelpers({
      apiResponses: {
        '/api/collections/my-docs': new Error('Collection "my-docs" not found'),
      },
    });
    const box = withTreeContainer(document, 'my-docs');
    await loadSidebarTree('my-docs');
    assert.doesNotMatch(box.textContent, /not found/i, 'the raw backend error text must not be shown verbatim');
    assert.match(box.textContent, /Couldn't load|try again/i);
    assert.ok(box.querySelector('.tree-error'), 'a failed collection-detail fetch must be visually distinct from empty/loading');
  });

  it('shows a distinct error state (not raw text) when the flat file list fetch itself fails', async () => {
    const { document, loadSidebarTree } = loadSidebarTreeHelpers({
      apiResponses: {
        '/api/collections/my-docs': { collection: { hasSkeleton: false } },
        '/api/collections/my-docs/documents?limit=': new Error('HTTP 500'),
      },
    });
    const box = withTreeContainer(document, 'my-docs');
    await loadSidebarTree('my-docs');
    assert.doesNotMatch(box.textContent, /HTTP 500/, 'the raw status-code fallback text must not be shown verbatim');
    assert.match(box.textContent, /Couldn't load|try again/i);
    assert.ok(box.querySelector('.tree-error'));
  });
});

// ── Phase 3K: a long/unbroken tree label must actually truncate, not push
// the trailing count badge off-screen ────────────────────────────────────
describe('app.css: .tree-label truncates instead of overflowing its flex row', () => {
  it('.tree-label sets min-width: 0 alongside its existing overflow/ellipsis rules', () => {
    // Regression: a flex item's default min-width is its own intrinsic
    // (unwrapped) content width, not 0 — this silently defeats
    // overflow:hidden/text-overflow:ellipsis for any label with no natural
    // break points, forcing the row wider than the sidebar and pushing
    // .tree-collection .count off-screen. The identical bug was already
    // found and fixed for .col-header-top .view-title (Phase 3I); this
    // pins the same fix for .tree-label.
    const css = readUiSource('app.css');
    const rule = css.match(/\.tree-label\s*\{([^}]*)\}/)?.[1] ?? '';
    assert.match(rule, /min-width:\s*0/, '.tree-label must set min-width: 0 or long names will overflow the row');
    assert.match(rule, /overflow:\s*hidden/);
    assert.match(rule, /text-overflow:\s*ellipsis/);
  });
});

// ── Phase 3R: tree rows get a slightly taller, more comfortable hit area —
// a small, isolated density tweak (not a layout-infrastructure change: the
// existing --depth indentation math, resizable sidebar width, and icon
// column are all untouched).
describe('app.css: .tree-row has a comfortable clickable height (Phase 3R density pass)', () => {
  it('.tree-row vertical padding is at least 7px (up from the original 5px)', () => {
    const css = readUiSource('app.css');
    const rule = css.match(/\.tree-row\s*\{([^}]*)\}/)?.[1] ?? '';
    const match = rule.match(/padding:\s*(\d+)px/);
    assert.ok(match, '.tree-row must set an explicit padding');
    assert.ok(Number(match[1]) >= 7, `.tree-row vertical padding must be at least 7px for a comfortable click target, got ${match[1]}px`);
  });
});
