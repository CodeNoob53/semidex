import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, parseHTML } from 'linkedom';
import {
  chunksBelongToSection,
  fileViewHeader,
  nodeTypeBadgeIcon,
  renderFileChunks,
} from '../../../src/shared/admin/ui-src/file-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(here, '../../../src/shared/admin/ui-src/partials/shared/templates');
const templates = ['chunk-card.html', 'file-view-header.html']
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

describe('stateless file-view helpers', () => {
  it('filters section chunks by exact node-path lineage', () => {
    const chunks = [
      { nodePath: 'guide.md#setup' },
      { nodePath: 'guide.md#setup/table-1' },
      { nodePath: 'guide.md#setup-extra' },
    ];
    assert.deepEqual(chunksBelongToSection(chunks, 'guide.md#setup'), chunks.slice(0, 2));
    assert.deepEqual(chunksBelongToSection(chunks, null), []);
  });

  it('renders header values through textContent, including long Cyrillic and hostile text', () => {
    const document = setup();
    const hostile = 'довгий/шлях/<img src=x onerror=alert(1)>.md';
    const header = fileViewHeader({
      nodeType: 'file', name: hostile, sourceFile: hostile,
      collectionName: '<script>alert(1)</script>', count: 7,
    });
    document.querySelector('main').appendChild(header);
    assert.equal(header.querySelector('.file-view-name').textContent, hostile);
    assert.match(header.querySelector('.file-view-meta').textContent, /<script>/);
    assert.equal(header.querySelector('.file-view-count').textContent, '7 chunks');
    assert.equal(header.querySelectorAll('img,script').length, 0);
  });

  it('marks only the requested target chunk and keeps structural context labels distinct', () => {
    const document = setup();
    document.querySelector('main').appendChild(renderFileChunks([
      { chunkIndex: 1, nodeType: 'paragraph', text: 'plain', context: 'Intro' },
      { chunkIndex: 2, nodeType: 'table', text: '| A |\n| - |\n| x |', context: 'Table context' },
    ], 2));
    assert.equal(document.querySelectorAll('.chunk-target').length, 1);
    assert.equal(document.querySelector('.chunk-target .chunk-index-label').textContent, 'chunk 2');
    assert.equal(document.querySelectorAll('.chunk')[0].querySelector('.chunk-context-label').textContent, 'section path:');
    assert.equal(document.querySelectorAll('.chunk')[1].querySelector('.chunk-context-label').textContent, 'retrieval context:');
  });

  it('renders structural badge icons only from the fixed icon registry', () => {
    assert.match(nodeTypeBadgeIcon('table'), /data-icon="table"/);
    assert.match(nodeTypeBadgeIcon('code_block'), /data-icon="code_block"/);
    assert.match(nodeTypeBadgeIcon('checklist'), /data-icon="checklist"/);
    assert.equal(nodeTypeBadgeIcon('<img>'), '');
  });

  it('contains no request, navigation, listener, or module-global reader state', () => {
    const source = fs.readFileSync(path.resolve(here, '../../../src/shared/admin/ui-src/file-view.js'), 'utf8');
    assert.doesNotMatch(source, /\breaderState\b|openFileView|openSectionView|\bapi\(|addEventListener\s*\(/);
  });
});
