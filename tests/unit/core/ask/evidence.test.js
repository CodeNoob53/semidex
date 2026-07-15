import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence, DEFAULT_TOP } from '../../../../src/core/ask/evidence.js';

// countTokens: deterministic word-count proxy — tests never load the real
// BGE-M3 tokenizer.
const countTokens = (text) => (text ?? '').split(/\s+/).filter(Boolean).length;

function fakeAdapter(overrides = {}) {
  return {
    capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
    getCollection: async (name) => ({ name }),
    searchHybrid: async () => [],
    getContentNode: async () => null,
    getSkeletonNode: async () => null,
    getSectionChunks: async () => [],
    getFileChunks: async () => [],
    ...overrides,
  };
}

const embedQuery = async () => ({ dense: [0.1], sparse: { indices: [], values: [] } });

describe('buildEvidence', () => {
  test('propagates a retrieval error unchanged', async () => {
    const adapter = fakeAdapter({ capabilities: () => ({ hybridSearch: false, sparseVectors: false }) });
    const result = await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q' });
    assert.equal(result.error, 'not_implemented');
  });

  test('returns empty sources for zero hits (never an error)', async () => {
    const adapter = fakeAdapter({ searchHybrid: async () => [] });
    const result = await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q' });
    assert.deepEqual(result.sources, []);
  });

  test('legacy hit (no nodeId) falls back to its own chunk text, numbered starting at 1', async () => {
    const hits = [
      { sourceFile: 'a.md', chunkIndex: 0, section: 'Intro', text: 'legacy chunk text', nodeId: null },
    ];
    const adapter = fakeAdapter({ searchHybrid: async () => hits });
    const result = await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q' });
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].n, 1);
    assert.equal(result.sources[0].snippet, 'legacy chunk text');
    assert.equal(result.sources[0].truncated, false);
    assert.equal(result.sources[0].nodeId, null);
  });

  test('skeleton hit with nodeId expands via getAnchoredContent to section scope', async () => {
    const hits = [
      { sourceFile: 'a.md', chunkIndex: 2, section: 'Config', text: 'short hit text', nodeId: 'n2', nodePath: '/a/config', parentId: 'section-1', nodeType: 'paragraph' },
    ];
    const sectionChunk = {
      sourceFile: 'a.md', chunkIndex: 2, nodeId: 'n2', nodePath: '/a/config', parentId: 'section-1',
      nodeType: 'paragraph', text: 'expanded section prose', section: 'Config',
    };
    const adapter = fakeAdapter({
      searchHybrid: async () => hits,
      getContentNode: async (_c, { nodeId }) => (nodeId === 'n2' ? { ...sectionChunk, sourceFile: 'a.md' } : null),
      getSkeletonNode: async (_c, { nodeId }) => (nodeId === 'section-1' ? { nodeId: 'section-1', nodeType: 'section', sourceFile: 'a.md', nodePath: '/a/config-section' } : null),
      getSectionChunks: async () => [sectionChunk],
    });
    const result = await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q' });
    assert.equal(result.sources.length, 1);
    assert.match(result.sources[0].snippet, /expanded section prose/);
    assert.equal(result.sources[0].nodeId, 'n2');
  });

  test('two hits resolving to the same section are deduplicated to one evidence block', async () => {
    const hits = [
      { sourceFile: 'a.md', chunkIndex: 1, section: 'Config', text: 'hit A', nodeId: 'n1', nodePath: '/a/p1', parentId: 'section-1', nodeType: 'paragraph' },
      { sourceFile: 'a.md', chunkIndex: 2, section: 'Config', text: 'hit B', nodeId: 'n2', nodePath: '/a/p2', parentId: 'section-1', nodeType: 'paragraph' },
    ];
    const sectionChunks = [
      { sourceFile: 'a.md', chunkIndex: 1, nodeId: 'n1', nodePath: '/a/p1', parentId: 'section-1', nodeType: 'paragraph', text: 'prose 1', section: 'Config' },
      { sourceFile: 'a.md', chunkIndex: 2, nodeId: 'n2', nodePath: '/a/p2', parentId: 'section-1', nodeType: 'paragraph', text: 'prose 2', section: 'Config' },
    ];
    const adapter = fakeAdapter({
      searchHybrid: async () => hits,
      getContentNode: async (_c, { nodeId }) => sectionChunks.find(s => s.nodeId === nodeId) ?? null,
      getSkeletonNode: async (_c, { nodeId }) => (nodeId === 'section-1' ? { nodeId: 'section-1', nodeType: 'section', sourceFile: 'a.md', nodePath: '/a/config-section' } : null),
      getSectionChunks: async () => sectionChunks,
    });
    const result = await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q' });
    assert.equal(result.sources.length, 1);
  });

  test('numbers sources sequentially starting at 1 regardless of gaps from dedup', async () => {
    const hits = [
      { sourceFile: 'a.md', chunkIndex: 1, section: 'S1', text: 'x', nodeId: null },
      { sourceFile: 'a.md', chunkIndex: 1, section: 'S1', text: 'x-dup', nodeId: null }, // same legacy key -> deduped
      { sourceFile: 'b.md', chunkIndex: 1, section: 'S2', text: 'y', nodeId: null },
    ];
    const adapter = fakeAdapter({ searchHybrid: async () => hits });
    const result = await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q' });
    assert.equal(result.sources.length, 2);
    assert.deepEqual(result.sources.map(s => s.n), [1, 2]);
  });

  test('truncates a legacy hit exceeding the per-source token budget and flags truncated', async () => {
    const longText = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const hits = [{ sourceFile: 'a.md', chunkIndex: 0, section: null, text: longText, nodeId: null }];
    const adapter = fakeAdapter({ searchHybrid: async () => hits });
    const result = await buildEvidence({
      adapter, embedQuery, countTokens, collection: 'c', question: 'q', perSourceTokenBudget: 5,
    });
    assert.equal(result.sources[0].truncated, true);
    // The regression this guards: a ratio-based single-shot trim was never
    // re-verified against the real tokenizer and could overshoot the
    // requested budget (code review: budget=5 produced a 21-token result).
    assert.ok(countTokens(result.sources[0].snippet) <= 5,
      `expected snippet to fit within budget=5, got ${countTokens(result.sources[0].snippet)} tokens`);
  });

  test('binary-search trim is exact at a variety of budgets, never overshooting', async () => {
    const longText = Array.from({ length: 80 }, (_, i) => `token${i}`).join(' ');
    const hits = [{ sourceFile: 'a.md', chunkIndex: 0, section: null, text: longText, nodeId: null }];
    for (const budget of [1, 2, 3, 7, 15, 40]) {
      const adapter = fakeAdapter({ searchHybrid: async () => hits });
      const result = await buildEvidence({
        adapter, embedQuery, countTokens, collection: 'c', question: 'q', perSourceTokenBudget: budget,
      });
      const actual = countTokens(result.sources[0].snippet);
      assert.ok(actual <= budget, `budget=${budget}: expected <= ${budget} tokens, got ${actual}`);
    }
  });

  test('respects a default top of 5 when not specified', async () => {
    let capturedLimit;
    const adapter = fakeAdapter({
      searchHybrid: async (_name, opts) => { capturedLimit = opts.limit; return []; },
    });
    await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q' });
    assert.equal(capturedLimit, DEFAULT_TOP);
  });

  test('passes sourceFile through as a retrieval filter', async () => {
    let capturedFilter;
    const adapter = fakeAdapter({
      searchHybrid: async (_name, opts) => { capturedFilter = opts.filter; return []; },
    });
    await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q', sourceFile: 'docs/x.md' });
    assert.equal(capturedFilter.sourceFile, 'docs/x.md');
    assert.equal(capturedFilter.excludeNav, true);
  });
});
