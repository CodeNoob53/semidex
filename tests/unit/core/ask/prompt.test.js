import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, REFUSAL_SENTINEL } from '../../../../src/core/ask/prompt.js';

function source(n, overrides = {}) {
  return { n, sourceFile: `docs/${n}.md`, section: `Section ${n}`, snippet: `Text for ${n}`, ...overrides };
}

describe('buildPrompt', () => {
  test('includes the refusal sentinel instruction and citation rule', () => {
    const prompt = buildPrompt([source(1)], 'What is X?');
    assert.match(prompt, /ONLY the numbered evidence/);
    assert.match(prompt, /\[1\] or \[2\]\[4\]/);
    assert.ok(prompt.includes(REFUSAL_SENTINEL));
  });

  test('numbers evidence blocks with source header and snippet', () => {
    const prompt = buildPrompt([source(1), source(2)], 'q');
    assert.match(prompt, /\[1\] \(docs\/1\.md § Section 1\)\nText for 1/);
    assert.match(prompt, /\[2\] \(docs\/2\.md § Section 2\)\nText for 2/);
  });

  test('omits section from header when source has no section', () => {
    const prompt = buildPrompt([source(1, { section: null })], 'q');
    assert.match(prompt, /\[1\] \(docs\/1\.md\)\n/);
  });

  test('includes the node-marker instruction only when a source is a structural type (table/code_block/checklist) with a nodePath', () => {
    const withoutNode = buildPrompt([source(1)], 'q');
    assert.doesNotMatch(withoutNode, /\[node: <node_path>\]/);

    const withNode = buildPrompt([source(1, { nodePath: '/doc/table-1', nodeType: 'table' })], 'q');
    assert.match(withNode, /\[node: <node_path>\]/);
  });

  test('does NOT include the node-marker instruction for a plain paragraph, even with a nodePath', () => {
    // A paragraph's nodePath is retrieval metadata, not a structural entity
    // the model can "show" via [node: <path>] — regression test for the
    // code-review finding that any nodePath (including paragraphs) was
    // wrongly treated as structural.
    const prompt = buildPrompt([source(1, { nodePath: '/doc/para-1', nodeType: 'paragraph' })], 'q');
    assert.doesNotMatch(prompt, /\[node: <node_path>\]/);
  });

  test('includes the source\'s own [node: <path>] in its header for a structural source', () => {
    const prompt = buildPrompt([source(1, { nodePath: '/doc/table-1', nodeType: 'table' })], 'q');
    assert.match(prompt, /\[1\] \(docs\/1\.md § Section 1 \[node: \/doc\/table-1\]\)/);
  });

  test('does NOT include a [node: <path>] in the header for a non-structural source', () => {
    const prompt = buildPrompt([source(1, { nodePath: '/doc/para-1', nodeType: 'paragraph' })], 'q');
    assert.doesNotMatch(prompt, /\[node:/);
  });

  test('includes the literal question text', () => {
    const prompt = buildPrompt([source(1)], 'How do I configure chunk size?');
    assert.match(prompt, /Question: How do I configure chunk size\?/);
  });
});
