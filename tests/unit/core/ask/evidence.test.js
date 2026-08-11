import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence, fitEvidenceToContextBudget, DEFAULT_TOP } from '../../../../src/core/ask/evidence.js';
import { RESERVED_HEADROOM_TOKENS } from '../../../../src/core/ask/prompt.js';

// countTokens: deterministic word-count proxy — tests never load the real
// BGE-M3 tokenizer.
const countTokens = (text) => (text ?? '').split(/\s+/).filter(Boolean).length;

const validProfile = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function fakeAdapter(overrides = {}) {
  return {
    capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
    getCollection: async (name) => ({ name }),
    getEmbeddingProfile: async () => ({ state: 'valid', profile: validProfile }),
    searchHybridVectors: async () => [],
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
    const adapter = fakeAdapter({ searchHybridVectors: async () => [] });
    const result = await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q' });
    assert.deepEqual(result.sources, []);
  });

  test('legacy hit (no nodeId) falls back to its own chunk text, numbered starting at 1', async () => {
    const hits = [
      { sourceFile: 'a.md', chunkIndex: 0, section: 'Intro', text: 'legacy chunk text', nodeId: null },
    ];
    const adapter = fakeAdapter({ searchHybridVectors: async () => hits });
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
      searchHybridVectors: async () => hits,
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
      searchHybridVectors: async () => hits,
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
    const adapter = fakeAdapter({ searchHybridVectors: async () => hits });
    const result = await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q' });
    assert.equal(result.sources.length, 2);
    assert.deepEqual(result.sources.map(s => s.n), [1, 2]);
  });

  test('truncates a legacy hit exceeding the per-source token budget and flags truncated', async () => {
    const longText = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const hits = [{ sourceFile: 'a.md', chunkIndex: 0, section: null, text: longText, nodeId: null }];
    const adapter = fakeAdapter({ searchHybridVectors: async () => hits });
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
      const adapter = fakeAdapter({ searchHybridVectors: async () => hits });
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
      searchHybridVectors: async (_name, opts) => { capturedLimit = opts.limit; return []; },
    });
    await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q' });
    assert.equal(capturedLimit, DEFAULT_TOP);
  });

  test('passes sourceFile through as a retrieval filter', async () => {
    let capturedFilter;
    const adapter = fakeAdapter({
      searchHybridVectors: async (_name, opts) => { capturedFilter = opts.filter; return []; },
    });
    await buildEvidence({ adapter, embedQuery, countTokens, collection: 'c', question: 'q', sourceFile: 'docs/x.md' });
    assert.equal(capturedFilter.sourceFile, 'docs/x.md');
    assert.equal(capturedFilter.excludeNav, true);
  });
});

describe('fitEvidenceToContextBudget', () => {
  function source(n, wordCount) {
    return {
      n, sourceFile: `doc${n}.md`, chunkIndex: n, section: `S${n}`,
      snippet: Array.from({ length: wordCount }, (_, i) => `w${n}_${i}`).join(' '),
      nodeId: null, nodePath: null, nodeType: null, truncated: false,
    };
  }

  test('does not double-count conversation history — a numCtx that fits the REAL rendered prompt (evidence+history+question) keeps all sources, never over-trims because of a separately-subtracted history reservation', async () => {
    // Code review finding (P1): a prior version of this function computed
    // `budget = numCtx - RESERVED_HEADROOM_TOKENS - historyReservationTokens`
    // even though the SAME history text was already fully rendered (via
    // conversationContext) into the prompt string being measured on every
    // loop iteration — subtracting the reservation on top of the real
    // rendered count double-charged history, silently over-constraining
    // evidence. This test picks a numCtx that is JUST large enough for the
    // real combined prompt (system + conversation block + all sources +
    // question) but would have failed under the old double-subtraction —
    // asserting the fix keeps every source rather than spuriously dropping
    // one or refusing outright.
    const sources = [source(1, 20), source(2, 20)];
    const conversationContext = {
      summary: Array.from({ length: 30 }, (_, i) => `hist${i}`).join(' '),
      recentMessages: [{ role: 'user', content: Array.from({ length: 30 }, (_, i) => `msg${i}`).join(' ') }],
    };

    // Measure the REAL rendered prompt's token count directly (system +
    // conversation block + both sources + question), then pick a numCtx
    // that gives just a little headroom above RESERVED_HEADROOM_TOKENS plus
    // that real count — under the old (buggy) implementation, subtracting
    // ANOTHER copy of the history reservation on top would push this
    // numCtx below the loop's own budget and force a source to be dropped
    // even though the real prompt genuinely fits.
    const { buildPromptParts, estimatePromptText } = await import('../../../../src/core/ask/prompt.js');
    const realPromptTokens = countTokens(estimatePromptText(buildPromptParts(sources, 'q', conversationContext)));
    const numCtx = RESERVED_HEADROOM_TOKENS + realPromptTokens + 5; // tight but sufficient

    const result = await fitEvidenceToContextBudget(sources, 'q', numCtx, countTokens, conversationContext);
    assert.equal(result.sources.length, 2, 'both sources must survive — the real rendered prompt already fits, no double-charged history reservation should force a drop');
    assert.equal(result.dropped, 0);
  });

  test('still trims sources when the real combined prompt genuinely does not fit', async () => {
    const sources = [source(1, 20), source(2, 20), source(3, 20)];
    const conversationContext = {
      recentMessages: [{ role: 'user', content: Array.from({ length: 100 }, (_, i) => `msg${i}`).join(' ') }],
    };
    const numCtx = RESERVED_HEADROOM_TOKENS + 60; // genuinely too small for everything
    const result = await fitEvidenceToContextBudget(sources, 'q', numCtx, countTokens, conversationContext);
    assert.ok(result.sources.length < 3, 'expected some sources to be dropped when the real prompt does not fit');
  });

  test('byte-identical v1 behavior when conversationContext is omitted', async () => {
    const sources = [source(1, 20)];
    const numCtx = RESERVED_HEADROOM_TOKENS + 500; // comfortable headroom above the real single-source prompt cost
    const result = await fitEvidenceToContextBudget(sources, 'q', numCtx, countTokens);
    assert.equal(result.sources.length, 1);
    assert.equal(result.dropped, 0);
  });
});
