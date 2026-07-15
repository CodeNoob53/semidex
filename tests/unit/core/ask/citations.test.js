import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateCitations } from '../../../../src/core/ask/citations.js';
import { REFUSAL_SENTINEL } from '../../../../src/core/ask/prompt.js';

const sources = [
  { n: 1, nodePath: null },
  { n: 2, nodePath: '/doc/table-1', nodeType: 'table' },
  { n: 3, nodePath: null },
];

describe('validateCitations', () => {
  test('detects the refusal sentinel as an exact-match refusal', () => {
    const result = validateCitations(REFUSAL_SENTINEL, sources);
    assert.equal(result.refused, true);
    assert.equal(result.text, '');
    assert.deepEqual(result.citations, []);
  });

  test('does not refuse when sentinel is embedded in longer text (must be exact trim match)', () => {
    const result = validateCitations(`Some answer [1]. ${REFUSAL_SENTINEL} trailing`, sources);
    assert.equal(result.refused, false);
  });

  test('collects valid citations in order, deduped', () => {
    const result = validateCitations('Claim [1]. Another [3][1].', sources);
    assert.deepEqual(result.citations, [1, 3]);
  });

  test('separates invalid citations (out of range) from valid ones', () => {
    const result = validateCitations('Claim [1] and [9].', sources);
    assert.deepEqual(result.citations, [1]);
    assert.deepEqual(result.invalidCitations, [9]);
  });

  test('dedupes invalid citations too', () => {
    const result = validateCitations('[9] and [9] again', sources);
    assert.deepEqual(result.invalidCitations, [9]);
  });

  test('keeps a [node: path] marker in text when path is in evidence', () => {
    const result = validateCitations('See below.\n[node: /doc/table-1]\nDone.', sources);
    assert.deepEqual(result.nodeReferences, ['/doc/table-1']);
    assert.deepEqual(result.strippedMarkers, []);
    assert.match(result.text, /\[node: \/doc\/table-1\]/);
  });

  test('strips a [node: path] marker not present in evidence and reports it', () => {
    const result = validateCitations('See below.\n[node: /doc/missing]\nDone.', sources);
    assert.deepEqual(result.nodeReferences, []);
    assert.deepEqual(result.strippedMarkers, ['/doc/missing']);
    assert.doesNotMatch(result.text, /\[node:/);
  });

  test('strips a [node: path] marker whose path belongs to a non-structural (paragraph) source', () => {
    // Regression: a paragraph's nodePath must not validate a marker even
    // though the path itself matches a source — only table/code_block/
    // checklist sources are legitimate [node: path] targets.
    const withParagraph = [...sources, { n: 4, nodePath: '/doc/para-1', nodeType: 'paragraph' }];
    const result = validateCitations('See below.\n[node: /doc/para-1]\nDone.', withParagraph);
    assert.deepEqual(result.nodeReferences, []);
    assert.deepEqual(result.strippedMarkers, ['/doc/para-1']);
  });

  test('never treats a score field on sources as a confidence signal (no such field is read)', () => {
    const scoredSources = [{ n: 1, nodePath: null, score: 0.001 }];
    const result = validateCitations('Claim [1].', scoredSources);
    assert.deepEqual(result.citations, [1]);
    assert.equal(result.refused, false);
  });

  test('trims stray whitespace left by a stripped marker line', () => {
    const result = validateCitations('Text\n[node: /doc/missing]\nMore', sources);
    assert.equal(result.text.includes('/doc/missing'), false);
  });
});
