// Tests for src/admin/ui-src/file-view.js's rendering (renderFileChunks).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFileViewRenderHelpers, loadFileViewBehaviorHelpers, withServer } from './ui-test-helpers.js';

describe('chunk view rendering (ui-src source + built index.html, evaluated behavior)', () => {
  it('renderFileChunks includes a node_type badge for every chunk', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const frag = renderFileChunks([
        { chunkIndex: 0, section: 'Intro', nodeType: 'paragraph', text: 'hello', context: 'Intro' },
      ]);
      const badge = frag.querySelector('.chunk-node-type');
      assert.equal(badge.hidden, false);
      // .trim() — non-structural badges (paragraph here) get no icon prefix,
      // but the badge is filled via innerHTML now (to support the icon
      // prefix on structural types below), so textContent can pick up
      // incidental whitespace from the surrounding markup.
      assert.equal(badge.textContent.trim(), 'paragraph');
      assert.match(badge.className, /badge-amber/);
    });
  });

  it('labels structural node types (table/code/checklist) distinctly, each with an icon prefix', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const table = renderFileChunks([{ chunkIndex: 1, nodeType: 'table', text: '| a | b |', context: 'Intro — table' }]);
      const code = renderFileChunks([{ chunkIndex: 2, nodeType: 'code_block', text: 'console.log(1)', context: 'Intro — code block' }]);
      const checklist = renderFileChunks([{ chunkIndex: 3, nodeType: 'checklist', text: '- [ ] todo', context: 'Intro — checklist' }]);
      assert.equal(table.querySelector('.chunk-node-type').textContent.trim(), 'table');
      assert.equal(code.querySelector('.chunk-node-type').textContent.trim(), 'code');
      assert.equal(checklist.querySelector('.chunk-node-type').textContent.trim(), 'checklist');
      // Each structural badge carries its own icon (Phase 3C) — a real
      // node-type-specific icon, not just the generic file/section fallback.
      assert.match(table.querySelector('.chunk-node-type').innerHTML, /data-icon="table"/);
      assert.match(code.querySelector('.chunk-node-type').innerHTML, /data-icon="code_block"/);
      assert.match(checklist.querySelector('.chunk-node-type').innerHTML, /data-icon="checklist"/);
    });
  });

  it('labels context as "retrieval context" for structural chunks and "section path" for plain prose', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const prose = renderFileChunks([{ chunkIndex: 0, nodeType: 'paragraph', text: 'hello', context: 'Intro › Details' }]);
      const table = renderFileChunks([{ chunkIndex: 1, nodeType: 'table', text: '| a |', context: 'Intro — table' }]);
      assert.match(prose.querySelector('.chunk-context-label').textContent, /section path/i);
      assert.doesNotMatch(prose.querySelector('.chunk-context-label').textContent, /retrieval context/i);
      assert.match(table.querySelector('.chunk-context-label').textContent, /retrieval context/i);
      assert.doesNotMatch(table.querySelector('.chunk-context-label').textContent, /^section path/i);
    });
  });

  it('the context annotation is visually secondary (a distinct label class), not ordinary chunk content', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const frag = renderFileChunks([{ chunkIndex: 0, nodeType: 'paragraph', text: 'hello', context: 'Intro' }]);
      const contextEl = frag.querySelector('.chunk-context');
      assert.equal(contextEl.hidden, false);
      assert.ok(contextEl.querySelector('.chunk-context-label'), 'context must carry a distinct label element, not just plain text');
    });
  });
});

// ── Phase 3A: main shows one content surface at a time ──────────────────────
describe('opening a file/section clears prior search results (single-content-surface)', () => {
  it('openFileView() clears #search-results and #search-status', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: [{ chunkIndex: 0, text: 'hello', totalChunks: 1 }] },
      });
      assert.notEqual(document.querySelector('#search-results').innerHTML, '');
      await openFileView('my-docs', 'readme.md', null, 0);
      assert.equal(document.querySelector('#search-results').innerHTML, '');
      assert.equal(document.querySelector('#search-status').innerHTML, '');
    });
  });

  it('openSectionView() clears #search-results and #search-status (via its delegate openFileView call)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/skeleton/anchor?': { chunk: { sourceFile: 'readme.md', chunkIndex: 2 } },
        '/chunks?': { chunks: [{ chunkIndex: 2, text: 'hello', totalChunks: 5 }] },
      });
      assert.notEqual(document.querySelector('#search-results').innerHTML, '');
      await openSectionView('my-docs', { nodePath: 'readme.md#intro', nodeType: 'section' });
      assert.equal(document.querySelector('#search-results').innerHTML, '');
    });
  });
});

describe('file view shows a visible total chunk count (not a silent 3-chunk window)', () => {
  it('openFileView() sets the content title to "sourceFile — N chunks" when totalChunks is known', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: [{ chunkIndex: 0, text: 'hello', totalChunks: 13 }] },
      });
      await openFileView('my-docs', 'pitch-en.md', null, 0);
      assert.equal(document.querySelector('#content-title').textContent, 'pitch-en.md — 13 chunks');
    });
  });

  it('openFileView() falls back to the plain filename when totalChunks is not a number', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: [{ chunkIndex: 0, text: 'hello', totalChunks: null }] },
      });
      await openFileView('my-docs', 'pitch-en.md', null, 0);
      assert.equal(document.querySelector('#content-title').textContent, 'pitch-en.md');
    });
  });

  it('opening at a non-zero chunkIndex (a centered /chunks window) does not make "load more" re-fetch/duplicate already-shown chunks', async () => {
    // The /chunks endpoint centers its window on chunkIndex: chunkIndex=10,
    // window=3 returns chunks [7..13], not chunks starting at 0. If
    // fileViewState.loaded were set from chunks.length (7) instead of the
    // highest chunk index actually shown (13), "load more" would re-request
    // starting at chunkIndex=7 — re-fetching and duplicating chunks 7-9
    // instead of continuing forward from 14.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const requestedChunkIndexes = [];
      const { document, openFileView, loadMoreFileChunks } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': (url) => {
          const chunkIndex = Number(new URL(url, 'http://x').searchParams.get('chunkIndex'));
          requestedChunkIndexes.push(chunkIndex);
          // Simulate the real centered-window endpoint: chunkIndex=10 -> 7..13.
          const from = Math.max(0, chunkIndex - 3);
          const to = chunkIndex + 3;
          const chunks = [];
          for (let i = from; i <= to; i++) chunks.push({ chunkIndex: i, text: `chunk ${i}`, totalChunks: 20 });
          return { chunks };
        },
      });

      await openFileView('my-docs', 'pitch-en.md', null, 10);
      assert.deepEqual(requestedChunkIndexes, [10]);
      // 7 cards shown (7..13) after the initial open.
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 7);

      await loadMoreFileChunks();
      // Must continue forward from 14 (the chunk after the highest one
      // already shown: 13), never re-request from 7 — which would both
      // re-fetch and (before the fix) let chunks 7-9 slip past the
      // c.chunkIndex >= loaded filter as "new", duplicating them.
      assert.deepEqual(requestedChunkIndexes, [10, 14]);
      // Second request (chunkIndex=14, window=3) returns 11..17; only
      // 14..17 are new (4 cards) — 7 already shown from the first batch
      // (7..13) must not be re-added. 7 + 4 = 11, not 14.
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 11,
        '7 initial (7..13) + 4 new (14..17), no duplicates from re-fetching 7-9');
    });
  });
});
