// fixtures/structural-fixture.mjs — offline, no network, no Qdrant.
// Parses the fixture through the REAL skeleton-parsing function
// (src/indexer/phases/skeleton.js's parseSkeleton) to prove the three
// oversized nodes actually classify as table/code_block/checklist, not
// something else — skeleton parsing has no network/DB dependency, so
// this is fully offline and a real behavioral proof, not a guess about
// Markdown syntax.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkeleton } from '../../../src/shared/indexer/phases/skeleton.js';
import {
  buildStructuralFixtureMarkdown, buildStructuralFixtureCorpus,
  buildStructuralFixtureQueriesMap, buildStructuralFixtureQrels,
  STRUCTURAL_FIXTURE_DOC_ID, STRUCTURAL_FIXTURE_EXACT_IDENTIFIERS,
  STRUCTURAL_FIXTURE_QUERIES,
} from './fixtures/structural-fixture.mjs';

describe('buildStructuralFixtureMarkdown() — real skeleton parsing', () => {
  const markdown = buildStructuralFixtureMarkdown();
  const nodes = parseSkeleton(markdown, { sourceFile: 'structural-fixture.md' });

  it('produces exactly one table node', () => {
    const tableNodes = nodes.filter((n) => n.nodeType === 'table');
    assert.equal(tableNodes.length, 1);
  });

  it('produces exactly one code_block node', () => {
    const codeNodes = nodes.filter((n) => n.nodeType === 'code_block');
    assert.equal(codeNodes.length, 1);
  });

  it('produces exactly one checklist node — never classified as a plain "list"', () => {
    const checklistNodes = nodes.filter((n) => n.nodeType === 'checklist');
    const plainListNodes = nodes.filter((n) => n.nodeType === 'list');
    assert.equal(checklistNodes.length, 1);
    assert.equal(plainListNodes.length, 0, 'every checklist item must carry "- [ ] " so isChecklist() fires — a plain bullet list would be misclassified');
  });

  it('the table node\'s raw content contains the table\'s exact identifier', () => {
    const tableNode = nodes.find((n) => n.nodeType === 'table');
    assert.ok(tableNode.rawContent.includes(STRUCTURAL_FIXTURE_EXACT_IDENTIFIERS.table) || markdown.includes(STRUCTURAL_FIXTURE_EXACT_IDENTIFIERS.table));
  });

  it('the code_block node\'s raw content contains the minified line with the exact identifier', () => {
    const codeNode = nodes.find((n) => n.nodeType === 'code_block');
    assert.ok(codeNode.rawContent.includes(STRUCTURAL_FIXTURE_EXACT_IDENTIFIERS.codeBlock));
  });

  it('the code_block node\'s raw content includes one line over 2000 characters — the "hard case" a table row split does not cover', () => {
    const codeNode = nodes.find((n) => n.nodeType === 'code_block');
    const longestLine = codeNode.rawContent.split('\n').reduce((max, l) => Math.max(max, l.length), 0);
    assert.ok(longestLine > 2000, `expected a line over 2000 chars, longest was ${longestLine}`);
  });

  it('the checklist node\'s raw content contains the exact identifier', () => {
    const checklistNode = nodes.find((n) => n.nodeType === 'checklist');
    assert.ok(checklistNode.rawContent.includes(STRUCTURAL_FIXTURE_EXACT_IDENTIFIERS.checklist) || markdown.includes(STRUCTURAL_FIXTURE_EXACT_IDENTIFIERS.checklist));
  });

  it('the checklist has enough items to be a real oversized-entity candidate (>40)', () => {
    const checklistNode = nodes.find((n) => n.nodeType === 'checklist');
    const itemLines = checklistNode.rawContent.split('\n').filter((l) => l.trim().startsWith('- [ ]'));
    assert.ok(itemLines.length > 40, `expected >40 checklist items, got ${itemLines.length}`);
  });

  it('the table has enough rows to be a real oversized-entity candidate (>30 data rows)', () => {
    const tableNode = nodes.find((n) => n.nodeType === 'table');
    const rowLines = tableNode.rawContent.split('\n').filter((l) => l.trim().startsWith('| item-'));
    assert.ok(rowLines.length > 30, `expected >30 table rows, got ${rowLines.length}`);
  });
});

describe('buildStructuralFixtureCorpus() / queries / qrels', () => {
  it('corpus contains the fixture doc plus distractors, all with real text', () => {
    const corpus = buildStructuralFixtureCorpus();
    assert.ok(corpus.has(STRUCTURAL_FIXTURE_DOC_ID));
    assert.ok(corpus.size > 1, 'expected the fixture doc plus at least one distractor');
    for (const [docId, doc] of corpus.entries()) {
      assert.ok(doc.text && doc.text.length > 0, `doc ${docId} has empty text`);
    }
  });

  it('every query maps to exactly the fixture doc in qrels — never a distractor', () => {
    const qrels = buildStructuralFixtureQrels();
    for (const q of STRUCTURAL_FIXTURE_QUERIES) {
      const qr = qrels.get(q.id);
      assert.ok(qr);
      assert.deepEqual([...qr.keys()], [STRUCTURAL_FIXTURE_DOC_ID]);
    }
  });

  it('queries map has one entry per STRUCTURAL_FIXTURE_QUERIES item', () => {
    const queriesMap = buildStructuralFixtureQueriesMap();
    assert.equal(queriesMap.size, STRUCTURAL_FIXTURE_QUERIES.length);
  });

  it('zero dangling qrels — every qrels docId is present in the corpus', () => {
    const corpus = buildStructuralFixtureCorpus();
    const qrels = buildStructuralFixtureQrels();
    for (const qr of qrels.values()) {
      for (const docId of qr.keys()) {
        assert.ok(corpus.has(docId), `dangling qrels reference: ${docId} not in corpus`);
      }
    }
  });
});
