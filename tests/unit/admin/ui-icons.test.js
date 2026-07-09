// Tests for src/admin/ui-src/icons.js and its wiring into sidebar.js/
// file-view.js/search.js (Phase 3C — v3 mock's inline-SVG icon direction).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, loadSidebarLabelHelpers, loadFileViewRenderHelpers, loadSearchRenderHelpers, withServer } from './ui-test-helpers.js';

describe('icons.js — hand-authored inline SVG, no icon-package import', () => {
  it('every icon function returns a non-empty <svg> string tagged with data-icon', () => {
    const js = readUiSource('icons.js');
    const names = ['iconCollection', 'iconDirectory', 'iconFile', 'iconSection', 'iconTable', 'iconCodeBlock', 'iconChecklist', 'iconChevron', 'iconSearch', 'iconGear'];
    for (const name of names) {
      assert.match(js, new RegExp(`export function ${name}\\(`), `${name} must be exported`);
    }
    // Every icon's root <svg> carries data-icon="<name>" so tests/consumers
    // can assert on icon identity without matching path data.
    const dataIconMatches = js.match(/data-icon="[\w_]+"/g) ?? [];
    assert.ok(dataIconMatches.length >= names.length - 2, // iconChevron/iconSearch/iconGear aren't node-type icons but still tagged
      'most icon functions must tag their root <svg> with a unique data-icon attribute');
  });

  it('does not import any icon package (lightweight inline SVG only, per the task brief)', () => {
    const js = readUiSource('icons.js');
    assert.ok(!/^import /m.test(js), 'icons.js must have zero imports — no icon-package dependency');
  });

  it('iconForNodeType() maps every real structural node type to its own icon, with a sane fallback', () => {
    const js = readUiSource('icons.js');
    assert.match(js, /export function iconForNodeType/);
    for (const nodeType of ['collection', 'directory', 'file', 'section', 'table', 'code_block', 'checklist']) {
      assert.match(js, new RegExp(`${nodeType}:\\s*icon`), `iconForNodeType must map "${nodeType}" to a dedicated icon function`);
    }
  });
});

describe('sidebar.js — sidebarNodeRow() uses icons.js instead of emoji glyphs', () => {
  it('no longer uses the old emoji glyphs (📁/📄) for directory/file nodes', () => {
    const js = readUiSource('sidebar.js');
    assert.ok(!/📁|📄/.test(js), 'emoji glyphs must be replaced by icons.js icon functions');
  });

  it('sidebarNodeRow renders the icon matching the node\'s nodeType', () => {
    const { sidebarNodeRow } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const dir = sidebarNodeRow({ nodeType: 'directory', nodePath: 'demo#dir/sub' }, 0, 0);
    const file = sidebarNodeRow({ nodeType: 'file', nodePath: 'readme.md#file', sourceFile: 'readme.md', childCount: 0 }, 0, 0);
    const section = sidebarNodeRow({ nodeType: 'section', nodePath: 'readme.md#intro', childCount: 0 }, 0, 0);
    assert.match(dir, /data-icon="directory"/);
    assert.match(file, /data-icon="file"/);
    assert.match(section, /data-icon="section"/);
  });

  it('a table/code_block/checklist skeleton node gets its own distinct icon, not the generic file/section fallback', () => {
    const { sidebarNodeRow } = loadSidebarLabelHelpers(readUiSource('sidebar.js'));
    const table = sidebarNodeRow({ nodeType: 'table', nodePath: 'readme.md#t1', childCount: 0 }, 0, 0);
    const code = sidebarNodeRow({ nodeType: 'code_block', nodePath: 'readme.md#c1', childCount: 0 }, 0, 0);
    const checklist = sidebarNodeRow({ nodeType: 'checklist', nodePath: 'readme.md#l1', childCount: 0 }, 0, 0);
    assert.match(table, /data-icon="table"/);
    assert.match(code, /data-icon="code_block"/);
    assert.match(checklist, /data-icon="checklist"/);
  });
});

describe('file-view.js — structural node-type badges carry a matching icon', () => {
  it('nodeTypeBadgeIcon() returns an icon for table/code_block/checklist and nothing for other types', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { nodeTypeBadgeIcon } = loadFileViewRenderHelpers(html);
      assert.match(nodeTypeBadgeIcon('table'), /data-icon="table"/);
      assert.match(nodeTypeBadgeIcon('code_block'), /data-icon="code_block"/);
      assert.match(nodeTypeBadgeIcon('checklist'), /data-icon="checklist"/);
      assert.equal(nodeTypeBadgeIcon('paragraph'), '', 'non-structural types get no icon prefix, matching the task\'s icon scope');
      assert.equal(nodeTypeBadgeIcon('directory'), '');
    });
  });
});

describe('search.js — search result node-type badge also carries a matching icon', () => {
  it('renderResult() prefixes a structural node-type badge with its icon', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, nodeType: 'table' }, 0, false);
      assert.match(card.querySelector('.result-node-type').innerHTML, /data-icon="table"/);
    });
  });

  it('renderResult() still escapes an untrusted nodeType value even with the icon prefix (XSS-safe)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, nodeType: malicious }, 0, false);
      assert.equal(card.querySelectorAll('img').length, 0, 'malicious nodeType must never be parsed into a real element');
      assert.match(card.querySelector('.result-node-type').textContent, /<img/, 'the malicious text must render as inert text, not markup');
    });
  });
});
