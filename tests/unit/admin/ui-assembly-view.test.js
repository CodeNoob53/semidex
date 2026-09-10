import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, parseHTML } from 'linkedom';
import { renderAssemblyBanners, renderAssemblySegments } from '../../../src/shared/admin/ui-src/assembly-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(here, '../../../src/shared/admin/ui-src/partials/shared/templates');
const templates = ['assembly-segment.html', 'assembly-warning.html']
  .map(name => fs.readFileSync(path.join(templatesDir, name), 'utf8')).join('\n');
const originalDocument = globalThis.document;
const originalNode = globalThis.Node;

function setup() {
  const { document } = parseHTML(`<main>${templates}</main>`);
  globalThis.document = document;
  globalThis.Node = Node;
  return document;
}

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.Node = originalNode;
});

describe('assembly renderer', () => {
  it('renders ordered prose as inert continuous content and returns the matched target', () => {
    const document = setup();
    const { root, target } = renderAssemblySegments({ segments: [
      { kind: 'prose', chunkIndex: 1, text: '<b>first</b>' },
      { kind: 'prose', chunkIndex: 2, text: 'другий' },
    ] }, { targetChunkIndex: 2 });
    document.querySelector('main').appendChild(root);
    assert.equal(root.querySelectorAll('.assembly-segment').length, 2);
    assert.equal(root.querySelectorAll('b').length, 0);
    assert.equal(target.dataset.chunkIndex, '2');
  });

  it('uses the shared structural renderer for tables and preserves raw mode safely', () => {
    const document = setup();
    const { root } = renderAssemblySegments({ segments: [{
      kind: 'entity', chunkIndex: 3, nodeType: 'table',
      rawContent: '| A |\n| - |\n| <img src=x> |', lang: null,
    }] });
    document.querySelector('main').appendChild(root);
    assert.ok(root.querySelector('.structural-table'));
    assert.equal(root.querySelectorAll('img').length, 0);
    root.querySelectorAll('.structural-toggle-btn')[1].click();
    assert.match(root.querySelector('.structural-raw').textContent, /<img src=x>/);
    assert.equal(root.querySelectorAll('img').length, 0);
  });

  it('collapses fallback and integrity diagnostics into bounded generic banners', () => {
    setup();
    const banners = renderAssemblyBanners({
      assemblyMode: 'placeholder_fallback',
      warnings: [
        { code: 'placeholder_fallback', message: 'secret one' },
        { code: 'orphan_placeholder', message: 'secret two' },
        { code: 'ref_entity_missing', message: 'secret three' },
      ],
    });
    assert.equal(banners.length, 2);
    assert.doesNotMatch(banners.map(node => node.textContent).join(' '), /secret/);
  });

  it('keeps renderer architecture request-free and backend-independent', () => {
    const source = fs.readFileSync(path.resolve(here, '../../../src/shared/admin/ui-src/assembly-view.js'), 'utf8');
    assert.doesNotMatch(source, /from ['"].*(core\/assembly|shared\/admin\/api)|\bfetch\s*\(|\bapi\s*\(/);
  });
});
