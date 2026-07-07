// Tests for src/admin/ui-src/sidebar.js. API behavior is covered in
// server.test.js/jobs.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, loadSidebarLabelHelpers, loadSidebarActiveStateHelpers } from './ui-test-helpers.js';

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
});

// ── Phase 3A: sidebar active state extends to the open file/section ────────
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
});
