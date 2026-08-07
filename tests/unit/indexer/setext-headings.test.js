// Migrated from src/smoke/sections/28-setext-headings.js
import '../../helpers/setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkFile } from '../../../src/shared/indexer/phases/chunk.js';

describe('parseMarkdown — setext headings', () => {
  it('setext h1 (===) creates a named section with its content', () => {
    const chunks = chunkFile('x.md', 'Title\n=====\nSome content under title.', 'x.md');
    assert.ok(chunks.some(c => c.section === 'Title'));
    assert.ok(chunks.some(c => c.section === 'Title' && c.text.includes('Some content under title')));
  });

  it('setext h2 (---) creates a named section with its content', () => {
    const chunks = chunkFile('x.md', 'Section\n-------\nContent under section.', 'x.md');
    assert.ok(chunks.some(c => c.section === 'Section'));
    assert.ok(chunks.some(c => c.section === 'Section' && c.text.includes('Content under section')));
  });

  it('multiple setext sections keep content in the correct section', () => {
    const chunks = chunkFile('x.md', 'Alpha\n=====\nAlpha content.\n\nBeta\n----\nBeta content.', 'x.md');
    const alpha = chunks.filter(c => c.section === 'Alpha');
    const beta = chunks.filter(c => c.section === 'Beta');
    assert.ok(alpha.length > 0, 'Alpha section missing');
    assert.ok(beta.length > 0, 'Beta section missing');
    assert.ok(alpha.every(c => !c.text.includes('Beta content')), 'Beta text leaked into Alpha');
    assert.ok(beta.every(c => !c.text.includes('Alpha content')), 'Alpha text leaked into Beta');
  });
});

describe('parseMarkdown — setext false positives', () => {
  it('frontmatter --- delimiter is not a setext h2', () => {
    const chunks = chunkFile('x.md', '---\ntitle: test\n---\n# Real Heading\nBody text.', 'x.md');
    assert.ok(chunks.every(c => c.section !== ''), 'frontmatter produced a sectionless chunk');
    assert.ok(chunks.some(c => c.section === 'Real Heading'));
  });

  it('horizontal rule (--- alone) does not create a spurious section', () => {
    const chunks = chunkFile('x.md', '# Heading\nSome text.\n\n---\n\nMore text after hr.', 'x.md');
    assert.ok(chunks.every(c => c.section === 'Heading' || c.section === ''));
  });

  it('setext heading text longer than 120 chars is not a heading', () => {
    const longTitle = 'A'.repeat(121);
    const chunks = chunkFile('x.md', `${longTitle}\n=====\nContent.`, 'x.md');
    assert.ok(!chunks.some(c => c.section === longTitle));
  });
});

describe('parseMarkdown — ATX and setext coexist', () => {
  it('both heading styles are parsed in the same document', () => {
    const md = '# ATX Heading\nATX content.\n\nSetext Section\n==============\nSetext content.';
    const chunks = chunkFile('x.md', md, 'x.md');
    assert.ok(chunks.some(c => c.section === 'ATX Heading'));
    assert.ok(chunks.some(c => c.section === 'Setext Section'));
  });
});
