import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteFollowUpQuery, looksLikeFollowUp } from '../../../../src/core/ask/query-rewrite.js';

function fakeProvider(generate) {
  return { name: () => 'fake', capabilities: () => ({}), ready: async () => ({ ok: true }), generate };
}

describe('looksLikeFollowUp', () => {
  test('no history at all — never a follow-up', () => {
    assert.equal(looksLikeFollowUp({ question: 'A long standalone question with many words in it here', recentMessages: [] }), false);
  });

  test('short question with history present — treated as a follow-up', () => {
    assert.equal(looksLikeFollowUp({ question: 'what about it?', summary: 's', recentMessages: [] }), true);
  });

  test('question starting with a pronoun and history present — treated as a follow-up', () => {
    assert.equal(looksLikeFollowUp({ question: 'It has a much longer body of text following the pronoun here', summary: 's', recentMessages: [] }), true);
  });

  test('long (>=12 tokens), non-pronoun-opening question with history present — not treated as a follow-up', () => {
    const question = 'Explain the full architecture of the retrieval pipeline in great technical detail please';
    assert.ok(question.split(/\s+/).length >= 12, 'fixture must be long enough to avoid the short-question heuristic');
    assert.equal(looksLikeFollowUp({ question, summary: 's', recentMessages: [] }), false);
  });
});

describe('rewriteFollowUpQuery', () => {
  test('first-turn (no history) never triggers a rewrite call', async () => {
    let called = false;
    const provider = fakeProvider(async () => { called = true; return { text: 'x' }; });
    const result = await rewriteFollowUpQuery({ question: 'a standalone first turn question with enough words', recentMessages: [], generationProvider: provider });
    assert.equal(called, false);
    assert.equal(result.rewritten, false);
    assert.equal(result.query, 'a standalone first turn question with enough words');
  });

  test('successful rewrite returns the rewritten query with rewritten:true', async () => {
    const provider = fakeProvider(async () => ({ text: 'a fully standalone rewritten query' }));
    const result = await rewriteFollowUpQuery({
      question: 'what about it?', summary: 'discussed something', recentMessages: [], generationProvider: provider,
    });
    assert.equal(result.rewritten, true);
    assert.equal(result.query, 'a fully standalone rewritten query');
  });

  test('failure fallback — provider throws, falls back to original question, rewritten:false, never propagates', async () => {
    const provider = fakeProvider(async () => { throw new Error('boom'); });
    const result = await rewriteFollowUpQuery({
      question: 'what about it?', summary: 's', recentMessages: [], generationProvider: provider,
    });
    assert.equal(result.rewritten, false);
    assert.equal(result.query, 'what about it?');
  });

  test('timeout fallback — provider never resolves, falls back within the injected short timeout window', async () => {
    const provider = fakeProvider(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const start = Date.now();
    const result = await rewriteFollowUpQuery({
      question: 'what about it?', summary: 's', recentMessages: [], generationProvider: provider, timeoutMs: 50,
    });
    const elapsed = Date.now() - start;
    assert.equal(result.rewritten, false);
    assert.equal(result.query, 'what about it?');
    assert.ok(elapsed < 2000, `expected fallback within the timeout window, took ${elapsed}ms`);
  });

  test('empty output fallback', async () => {
    const provider = fakeProvider(async () => ({ text: '   ' }));
    const result = await rewriteFollowUpQuery({ question: 'what about it?', summary: 's', recentMessages: [], generationProvider: provider });
    assert.equal(result.rewritten, false);
    assert.equal(result.query, 'what about it?');
  });

  test('oversized output fallback', async () => {
    const provider = fakeProvider(async () => ({ text: 'x'.repeat(10_000) }));
    const result = await rewriteFollowUpQuery({ question: 'what about it?', summary: 's', recentMessages: [], generationProvider: provider });
    assert.equal(result.rewritten, false);
    assert.equal(result.query, 'what about it?');
  });

  test('never leaks raw rewrite output beyond the query field — return shape has no extra debug field', async () => {
    const provider = fakeProvider(async () => ({ text: 'rewritten output text' }));
    const result = await rewriteFollowUpQuery({ question: 'what about it?', summary: 's', recentMessages: [], generationProvider: provider });
    assert.deepEqual(Object.keys(result).sort(), ['query', 'rewritten']);
  });
});
