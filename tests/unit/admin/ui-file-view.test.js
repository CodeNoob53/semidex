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

// ── Phase 3F: whole-file mode (a plain sidebar file click, no target chunk) ─
describe('openFileView() with no chunkIndex — whole-file mode (getFileChunks, not the windowed endpoint)', () => {
  function makeChunks(count) {
    return Array.from({ length: count }, (_, i) => ({ chunkIndex: i, text: `chunk ${i}`, section: 'Intro' }));
  }

  it('requests the /chunks endpoint with no chunkIndex/window query params at all', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let requestedUrl = null;
      const { openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': (url) => { requestedUrl = url; return { chunks: makeChunks(2) }; },
      });
      await openFileView('my-docs', 'readme.md');
      const qs = new URL(requestedUrl, 'http://x').searchParams;
      assert.equal(qs.get('sourceFile'), 'readme.md');
      assert.equal(qs.has('chunkIndex'), false, 'whole-file mode must not send chunkIndex');
      assert.equal(qs.has('window'), false, 'whole-file mode must not send window');
    });
  });

  it('renders every chunk up to the first page (5) when the file has more than one page', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: makeChunks(12) },
      });
      await openFileView('my-docs', 'readme.md');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 5,
        'whole-file mode pages the client-side render, same as search.js\'s Show more');
    });
  });

  it('renders every chunk directly (no "load more") when the file has 5 or fewer chunks', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: makeChunks(3) },
      });
      await openFileView('my-docs', 'readme.md');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 3);
      assert.equal(document.querySelector('#file-load-more'), null,
        '"load more" must not render when everything is already visible');
    });
  });

  it('sets the content title to "sourceFile — N chunks" using the real fetched count', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: makeChunks(7) },
      });
      await openFileView('my-docs', 'readme.md');
      assert.equal(document.querySelector('#content-title').textContent, 'readme.md — 7 chunks');
    });
  });

  it('"load more" reveals the next page from memory, with zero additional network requests', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let fetchCount = 0;
      const { document, openFileView, loadMoreFileChunks } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': () => { fetchCount++; return { chunks: makeChunks(12) }; },
      });
      await openFileView('my-docs', 'readme.md');
      assert.equal(fetchCount, 1);
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 5);

      await loadMoreFileChunks();
      assert.equal(fetchCount, 1, 'whole-file "load more" must not trigger a second /chunks request');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 10);

      await loadMoreFileChunks();
      assert.equal(fetchCount, 1);
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 12,
        'the final click reveals only the remaining 2, not overshooting past what was fetched');
      assert.equal(document.querySelector('#file-load-more'), null,
        '"load more" must disappear once every fetched chunk is visible');
    });
  });

  it('shows an empty-state message (not an error) when the file genuinely has zero chunks', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: [] },
      });
      await openFileView('my-docs', 'empty.md');
      assert.match(document.querySelector('#collection-content').textContent, /No chunks found for this file/);
    });
  });

  it('a fresh whole-file open of a DIFFERENT file resets the page back to the first 5, not the previous file\'s expanded count', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView, loadMoreFileChunks } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': (url) => {
          const sourceFile = new URL(url, 'http://x').searchParams.get('sourceFile');
          return { chunks: makeChunks(sourceFile === 'first.md' ? 12 : 3) };
        },
      });
      await openFileView('my-docs', 'first.md');
      await loadMoreFileChunks();
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 10);

      await openFileView('my-docs', 'second.md');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 3,
        'opening a new file must not carry over the previous file\'s visible-count state');
    });
  });
});

// ── Phase 3F: section-anchored opens highlight their target chunk ──────────
describe('openFileView() with an explicit chunkIndex highlights the resolved target chunk', () => {
  it('the chunk matching the requested chunkIndex gets the .chunk-target class, others do not', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: [
          { chunkIndex: 4, text: 'before' },
          { chunkIndex: 5, text: 'the target' },
          { chunkIndex: 6, text: 'after' },
        ] },
      });
      await openFileView('my-docs', 'readme.md', null, 5);
      const targets = document.querySelectorAll('#collection-content .chunk-target');
      assert.equal(targets.length, 1, 'exactly one chunk must be marked as the target');
      assert.match(targets[0].textContent, /the target/);
    });
  });

  it('whole-file mode (no chunkIndex) never marks any chunk as .chunk-target', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: [{ chunkIndex: 0, text: 'a' }, { chunkIndex: 1, text: 'b' }] },
      });
      await openFileView('my-docs', 'readme.md');
      assert.equal(document.querySelectorAll('#collection-content .chunk-target').length, 0);
    });
  });
});

// ── Phase 3F: "open file from start" (empty section) uses whole-file mode ──
describe('openSectionView() "Open file from start" fallback', () => {
  it('clicking it opens the file in whole-file mode, not a chunkIndex=0 windowed fetch', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let requestedUrl = null;
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/skeleton/anchor?': Object.assign(new Error('not found'), { status: 404 }),
        '/chunks?': (url) => { requestedUrl = url; return { chunks: [{ chunkIndex: 0, text: 'hi' }] }; },
      });
      await openSectionView('my-docs', { nodePath: 'readme.md#intro', nodeType: 'section', sourceFile: 'readme.md' });
      const startBtn = document.querySelector('#section-open-file-start');
      assert.ok(startBtn, 'the "Open file from start" button must render for a section with no content');
      startBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the click handler's async openFileView settle
      const qs = new URL(requestedUrl, 'http://x').searchParams;
      assert.equal(qs.has('chunkIndex'), false, '"Open file from start" must use whole-file mode, not a windowed chunkIndex=0 fetch');
    });
  });
});
