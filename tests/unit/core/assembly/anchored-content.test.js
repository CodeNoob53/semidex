// Tests for src/core/assembly/anchored-content.js (getAnchoredContent) — the
// StorageAdapter-only orchestration behind qdrant_get_content: resolve
// anchor -> reject nav/missing -> derive scope -> assembleDocument() ->
// buildAssemblyWindow(). All fixtures use a fake in-memory adapter — no
// live Qdrant, no direct Qdrant import anywhere in this file or the module
// under test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAnchoredContent } from '../../../../src/core/assembly/anchored-content.js';

const countTokens = (text) => Math.ceil(String(text ?? '').length / 4);

function makeFixture() {
  const sectionNode = { nodeType: 'section', nodeId: 'sec-1', nodePath: 'a.md#setup', sourceFile: 'a.md', parentId: 'file-1' };
  const otherSectionNode = { nodeType: 'section', nodeId: 'sec-2', nodePath: 'a.md#other', sourceFile: 'a.md', parentId: 'file-1' };
  const fileNode = { nodeType: 'file', nodeId: 'file-1', nodePath: 'a.md#file', sourceFile: 'a.md' };

  const proseChunk = {
    sourceFile: 'a.md', chunkIndex: 0, section: 'Setup', text: 'Some prose here.',
    nodeType: 'paragraph', nodeId: 'p0', nodePath: 'a.md#setup/paragraph-0', parentId: 'sec-1', entityRefs: [],
  };
  const tableChunk = {
    sourceFile: 'a.md', chunkIndex: 1, section: 'Setup', text: '| A | B |', rawContent: '| A | B |',
    nodeType: 'table', nodeId: 't1', nodePath: 'a.md#setup/table-1', parentId: 'sec-1', entityRefs: [],
  };
  const otherChunk = {
    sourceFile: 'a.md', chunkIndex: 2, section: 'Other', text: 'Unrelated other-section prose.',
    nodeType: 'paragraph', nodeId: 'p2', nodePath: 'a.md#other/paragraph-0', parentId: 'sec-2', entityRefs: [],
  };
  // A content node with no parent section at all (directly under the file root).
  const rootLevelChunk = {
    sourceFile: 'b.md', chunkIndex: 0, section: '', text: 'Root-level prose, no section.',
    nodeType: 'paragraph', nodeId: 'r0', nodePath: 'b.md#paragraph-0', parentId: null, entityRefs: [],
  };

  const contentById = new Map([
    ['p0', proseChunk], ['t1', tableChunk], ['p2', otherChunk], ['r0', rootLevelChunk],
  ]);
  const skeletonById = new Map([
    ['sec-1', sectionNode], ['sec-2', otherSectionNode], ['file-1', fileNode],
  ]);

  const adapter = {
    async getContentNode(collection, { nodeId }) {
      return contentById.get(nodeId) ?? null;
    },
    async getSkeletonNode(collection, { nodeId }) {
      return skeletonById.get(nodeId) ?? null;
    },
    async getSectionChunks(collection, { nodeId }) {
      if (nodeId === 'sec-1') return [proseChunk, tableChunk];
      if (nodeId === 'sec-2') return [otherChunk];
      return null;
    },
    async getFileChunks(collection, sourceFile) {
      if (sourceFile === 'a.md') return [proseChunk, tableChunk, otherChunk];
      if (sourceFile === 'b.md') return [rootLevelChunk];
      return [];
    },
  };

  return { adapter, proseChunk, tableChunk, otherChunk, rootLevelChunk, sectionNode };
}

describe('getAnchoredContent — exact section-parent scope', () => {
  it('resolves the anchor to its EXACT containing section (parentId), never the whole file', async () => {
    const { adapter } = makeFixture();
    const r = await getAnchoredContent({ adapter, collection: 'c', anchorNodeId: 'p0', scope: 'section', maxTokens: 1000, countTokens });
    assert.equal(r.scope, 'section');
    assert.equal(r.nodePath, 'a.md#setup');
    const chunkIndexes = r.window.items.map(i => i.chunkIndex);
    assert.deepEqual(chunkIndexes, [0, 1], 'only the anchor\'s own section\'s chunks (0,1), never section 2\'s chunk (2)');
  });

  it('a prose anchor resolves and centers correctly', async () => {
    const { adapter } = makeFixture();
    const r = await getAnchoredContent({ adapter, collection: 'c', anchorNodeId: 'p0', scope: 'section', maxTokens: 1000, countTokens });
    assert.equal(r.window.items[0].kind, 'prose');
    assert.equal(r.window.anchorNodeId, 'p0');
  });

  it('a table (structural) anchor resolves with authoritative raw content preserved', async () => {
    const { adapter } = makeFixture();
    const r = await getAnchoredContent({ adapter, collection: 'c', anchorNodeId: 't1', scope: 'section', maxTokens: 1000, countTokens });
    const tableItem = r.window.items.find(i => i.nodeId === 't1');
    assert.equal(tableItem.kind, 'entity');
    assert.equal(tableItem.rawContent, '| A | B |');
  });
});

describe('getAnchoredContent — file scope', () => {
  it('scope=file assembles the WHOLE file, including chunks outside the anchor\'s own section', async () => {
    const { adapter } = makeFixture();
    const r = await getAnchoredContent({ adapter, collection: 'c', anchorNodeId: 'p0', scope: 'file', maxTokens: 1000, countTokens });
    assert.equal(r.scope, 'file');
    assert.equal(r.nodePath, null);
    const chunkIndexes = r.window.items.map(i => i.chunkIndex);
    assert.deepEqual(chunkIndexes, [0, 1, 2], 'file scope includes every chunk in the file, not just the anchor\'s section');
  });

  it('a root-level anchor (no section structure) works fine under scope=file', async () => {
    const { adapter } = makeFixture();
    const r = await getAnchoredContent({ adapter, collection: 'c', anchorNodeId: 'r0', scope: 'file', maxTokens: 1000, countTokens });
    assert.equal(r.error, undefined);
    assert.equal(r.sourceFile, 'b.md');
  });
});

describe('getAnchoredContent — anchor rejection', () => {
  it('missing anchor: a node_id that resolves to nothing at all is rejected cleanly', async () => {
    const { adapter } = makeFixture();
    const r = await getAnchoredContent({ adapter, collection: 'c', anchorNodeId: 'does-not-exist', scope: 'section', maxTokens: 1000, countTokens });
    assert.equal(r.error, 'anchor_not_found');
  });

  it('navigation-node anchor: a node_id belonging to a skeleton_nav node is rejected, never treated as content', async () => {
    const { adapter } = makeFixture();
    // sec-1 exists as a skeleton node but getContentNode() correctly returns
    // null for it (nav points are never content) — the orchestration must
    // distinguish this from "doesn't exist at all."
    const r = await getAnchoredContent({ adapter, collection: 'c', anchorNodeId: 'sec-1', scope: 'section', maxTokens: 1000, countTokens });
    assert.equal(r.error, 'anchor_is_navigation');
  });

  it('scope=section requested but the anchor has no section parent to resolve into: honest rejection, no silent downgrade to file scope', async () => {
    const { adapter } = makeFixture();
    const r = await getAnchoredContent({ adapter, collection: 'c', anchorNodeId: 'r0', scope: 'section', maxTokens: 1000, countTokens });
    assert.equal(r.error, 'no_section_scope');
  });
});

describe('getAnchoredContent — legacy collection without node identity', () => {
  it('getContentNode() returning a chunk with no sourceFile/identity at all is rejected as not found, never fabricated', async () => {
    const adapter = {
      async getContentNode() { return { sourceFile: null, nodeId: null }; },
      async getSkeletonNode() { return null; },
      async getSectionChunks() { return null; },
      async getFileChunks() { return []; },
    };
    const r = await getAnchoredContent({ adapter, collection: 'legacy', anchorNodeId: 'whatever', scope: 'file', maxTokens: 1000, countTokens });
    assert.equal(r.error, 'anchor_not_found');
  });
});

describe('getAnchoredContent — no direct Qdrant dependency', () => {
  it('anchored-content.js imports only assemble.js/window.js — no Qdrant SDK or core/qdrant import', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../../src/core/assembly/anchored-content.js', import.meta.url)), 'utf-8');
    assert.doesNotMatch(src, /from ['"].*qdrant/i, 'must never import a Qdrant module directly — StorageAdapter only');
    assert.match(src, /from '\.\/assemble\.js'/);
    assert.match(src, /from '\.\/window\.js'/);
  });
});
