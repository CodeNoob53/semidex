// Tests for src/admin/ui-src/file-view.js's rendering (renderFileChunks).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFileViewRenderHelpers, loadFileViewBehaviorHelpers, withServer, readUiSource } from './ui-test-helpers.js';

// ── Phase 3H: file/section browse cards are evidence-free — this is browse
// mode, not search-evidence mode. Search results (tpl-search-result) show
// rank/score/score-bar; file/section browse cards (tpl-chunk-card) never do
// — they're two separate templates, not one template with a toggled field,
// so there's no risk of a stray flag leaking rank/score into browse mode.
describe('file/section browse cards never show search rank/score (this is browse mode, not search-evidence mode)', () => {
  it('tpl-chunk-card has no rank/score/score-bar fields at all', () => {
    const templateHtml = readUiSource('partials/templates/chunk-card.html');
    assert.doesNotMatch(templateHtml, /class="rank"/);
    assert.doesNotMatch(templateHtml, /class="[^"]*\bscore\b[^"]*"/);
    assert.doesNotMatch(templateHtml, /score-bar/);
  });

  it('a rendered browse chunk card has no .rank/.score/.score-bar element, even though tpl-search-result (a different template) does', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const frag = renderFileChunks([{ chunkIndex: 0, section: 'Intro', nodeType: 'paragraph', text: 'hello' }]);
      const card = frag.querySelector('.chunk');
      assert.equal(card.querySelector('.rank'), null);
      assert.equal(card.querySelector('.score'), null);
      assert.equal(card.querySelector('.score-bar'), null);
      // Confirm the search template really does carry these fields, so this
      // test is proving "browse mode omits them," not "no template anywhere
      // has them by coincidence."
      const { document } = loadFileViewRenderHelpers(html);
      const searchTplHtml = document.getElementById('tpl-search-result').innerHTML;
      assert.match(searchTplHtml, /class="rank"/);
      assert.match(searchTplHtml, /class="mono score"/);
    });
  });
});

// ── Phase 3L: nav points must never render as file-view content ────────────
// The actual exclusion happens two layers below the UI — server-side
// (withNavExcluded, store.js's getFileChunks/fetchWindowChunks — see
// tests/unit/core/qdrant-store-nav-exclusion.test.js) and at the adapter
// boundary (toChunk() in qdrant-adapter.js maps a raw Qdrant point to a
// domain Chunk shape that never carries point_kind/node_id-as-nav-marker
// through at all — see src/core/storage/qdrant-adapter.js's own header
// comment: "Callers above this layer... must never see point_kind, node_type
// snake_case fields"). file-view.js's renderFileChunks() therefore has no
// nav-awareness of its own to test — there is no field for it to check. This
// test instead confirms the render layer's side of that contract: it
// renders exactly what it's given, one card per chunk object, with no
// hidden filtering OR accidental pass-through of raw snake_case fields —
// proving the boundary is real (nothing downstream re-adds a nav concept),
// not just that this one call happens to look clean.
describe('file-view chunk rendering trusts the adapter boundary — no nav-point concept exists at this layer', () => {
  it('renders exactly one card per chunk passed in, with no snake_case/point_kind field ever appearing in the output', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      // A domain Chunk never has point_kind — this shape is intentionally
      // adversarial (as if a nav point's raw payload had leaked past the
      // adapter unmapped) to prove renderFileChunks does not special-case
      // or accidentally surface it if it ever did arrive.
      const chunks = [
        { chunkIndex: 0, section: 'Intro', nodeType: 'paragraph', text: 'real content', point_kind: 'skeleton_nav' },
        { chunkIndex: 1, section: 'Body', nodeType: 'paragraph', text: 'more real content' },
      ];
      const frag = renderFileChunks(chunks);
      const cards = frag.querySelectorAll('.chunk');
      assert.equal(cards.length, 2, 'every chunk object passed in renders exactly one card — no implicit filtering by this layer');
      const html2 = [...cards].map(c => c.outerHTML).join('');
      assert.doesNotMatch(html2, /point_kind/, 'a raw payload field must never surface in the rendered card even if present on the input object');
      assert.doesNotMatch(html2, /skeleton_nav/);
    });
  });

  it('getFileChunks (the whole-file backend primitive) is the one place nav-exclusion actually happens — confirmed server-side, not re-implemented here', () => {
    // Cross-reference, not a duplicate: the real guarantee lives in
    // tests/unit/core/qdrant-store-nav-exclusion.test.js's
    // "getFileChunks() — whole-file primitive..." test, which asserts
    // withNavExcluded()/isNavPoint() are both used. This test just pins
    // that file-view.js's whole-file fetch actually calls the /chunks
    // endpoint backed by that primitive (no separate, unaudited fetch path).
    const js = readUiSource('file-view.js');
    assert.match(js, /api\(`\/api\/collections\/\$\{encodeURIComponent\(name\)\}\/chunks\?\$\{qs\}`\)/);
  });
});

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

// ── Phase 3P: chunk cards read as document evidence, not a debug dump ──────
// The old layout put a shaded ".chunk-head" bar with the chunk index FIRST —
// the most prominent element in the card, ahead of the actual content. This
// mirrors the exact problem Phase 3O fixed for search-result cards: three
// tiers, quiet-to-loud — .chunk-primary (identity), .chunk-evidence (the
// dominant reading surface), .chunk-meta (secondary, chunk index only).
describe('chunk cards (Phase 3P): chunk index is secondary metadata, not the headline', () => {
  it('.chunk-index-label lives inside .chunk-meta, never inside .chunk-primary', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const frag = renderFileChunks([{ chunkIndex: 4, totalChunks: 9, section: 'Intro', nodeType: 'paragraph', text: 'hello' }]);
      const card = frag.querySelector('.chunk');
      const meta = card.querySelector('.chunk-meta');
      const primary = card.querySelector('.chunk-primary');
      assert.ok(meta, 'card must have a .chunk-meta wrapper');
      assert.ok(primary, 'card must have a .chunk-primary wrapper');
      assert.ok(meta.querySelector('.chunk-index-label'), '.chunk-index-label must live inside .chunk-meta');
      assert.equal(primary.querySelector('.chunk-index-label'), null, '.chunk-index-label must not live inside .chunk-primary');
      assert.equal(meta.querySelector('.chunk-index-label').textContent, 'chunk 4 / 9');
    });
  });

  it('.chunk-primary carries the section label and node-type badge (identity), not the evidence text', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const frag = renderFileChunks([{ chunkIndex: 0, section: 'Setup', nodeType: 'paragraph', text: 'install steps here' }]);
      const primary = frag.querySelector('.chunk').querySelector('.chunk-primary');
      assert.ok(primary.querySelector('.chunk-section'), '.chunk-primary must carry the section label');
      assert.equal(primary.querySelector('.chunk-section').textContent, 'Setup');
      assert.doesNotMatch(primary.textContent, /install steps here/, 'evidence text must not appear in the identity row');
    });
  });

  it('.chunk-evidence carries the context lead-in and the chunk text (the dominant reading surface)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const frag = renderFileChunks([{ chunkIndex: 0, nodeType: 'paragraph', text: 'install steps here', context: 'Setup › Prereqs' }]);
      const evidence = frag.querySelector('.chunk').querySelector('.chunk-evidence');
      assert.ok(evidence, 'card must have a .chunk-evidence wrapper');
      assert.ok(evidence.querySelector('.chunk-text'), '.chunk-evidence must carry the chunk text');
      assert.equal(evidence.querySelector('.chunk-text').textContent, 'install steps here');
      assert.ok(evidence.querySelector('.chunk-context'), '.chunk-evidence must carry the context lead-in');
    });
  });
});

// Raw structural content (a markdown table or code block) must render as
// inert text via .textContent, never parsed as markup — a chunk's text is
// untrusted API/indexed content, and an HTML-like table/code snippet must
// not become real DOM elements (XSS-safety), matching the same guarantee
// Phase 3O already established for search-result evidence text.
describe('chunk cards (Phase 3P): raw table/code content stays plain text, never parsed as HTML', () => {
  it('a table chunk containing HTML-like text renders as inert text, not a real element', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const adversarial = '| <img src=x onerror=alert(1)> | <script>alert(2)</script> |';
      const frag = renderFileChunks([{ chunkIndex: 0, nodeType: 'table', text: adversarial, context: 'Intro — table' }]);
      const textEl = frag.querySelector('.chunk-text');
      assert.equal(textEl.textContent, adversarial, 'the raw table text must be preserved verbatim as text');
      assert.equal(textEl.querySelector('img'), null, 'must never parse into a real <img> element');
      assert.equal(textEl.querySelector('script'), null, 'must never parse into a real <script> element');
    });
  });

  it('a code_block chunk containing HTML-like text renders as inert text, not a real element', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const adversarial = 'const x = "<div onclick=alert(1)>";';
      const frag = renderFileChunks([{ chunkIndex: 0, nodeType: 'code_block', text: adversarial, context: 'Intro — code block' }]);
      const textEl = frag.querySelector('.chunk-text');
      assert.equal(textEl.textContent, adversarial);
      assert.equal(textEl.querySelector('div'), null);
    });
  });

  it('.chunk-text keeps its scroll/wrap containment (max-height + overflow) so large raw content cannot break page layout', () => {
    const css = readUiSource('app.css');
    const chunkTextBlock = css.match(/\.chunk-text\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(chunkTextBlock, /max-height:\s*300px/);
    assert.match(chunkTextBlock, /overflow-y:\s*auto/);
    assert.match(chunkTextBlock, /word-break:\s*break-word/);
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
  it('openFileView() shows the chunk count in the header badge (Phase 3H) when totalChunks is known', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: [{ chunkIndex: 0, text: 'hello', totalChunks: 13 }] },
      });
      await openFileView('my-docs', 'pitch-en.md', null, 0);
      // Phase 3H moved the chunk count out of #content-title (now just the
      // plain filename, matching the sidebar's own file label) and into a
      // dedicated header badge above the chunk cards, alongside the
      // relative path and collection name — see file-view-header.html.
      assert.equal(document.querySelector('#content-title').textContent, 'pitch-en.md');
      assert.equal(document.querySelector('.file-view-count').textContent, '13 chunks');
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

  it('shows the real fetched count in the header badge, and the relative path + collection name in the meta line', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: makeChunks(7) },
      });
      await openFileView('my-docs', 'docs/readme.md');
      assert.equal(document.querySelector('#content-title').textContent, 'readme.md');
      assert.equal(document.querySelector('.file-view-count').textContent, '7 chunks');
      const meta = document.querySelector('.file-view-meta').textContent;
      assert.match(meta, /docs\/readme\.md/, 'meta line must show the relative source path, not just the basename');
      assert.match(meta, /my-docs/, 'meta line must show the collection name as secondary context');
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

  it('shows a clean, non-technical empty-state message when the file genuinely has zero chunks', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: [] },
      });
      await openFileView('my-docs', 'empty.md');
      const text = document.querySelector('#collection-content').textContent;
      assert.match(text, /No searchable chunks in this file/);
      assert.match(text, /navigation\/metadata or unsupported content/,
        'must explain the file may only contain navigation/metadata, not raw API/debug text');
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

// ── Phase 3H: the new file/section header never lets API/collection-name
// content become live markup, and long names don't break layout ──────────
describe('file-view header (Phase 3H): API content is escaped, never parsed as markup', () => {
  it('a sourceFile/collection name containing HTML renders as inert text in the header, never a real element', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: [{ chunkIndex: 0, text: 'hello', totalChunks: 1 }] },
      });
      await openFileView(malicious, malicious, null, undefined);
      const header = document.querySelector('.file-view-header');
      assert.equal(header.querySelectorAll('img').length, 0, 'malicious markup must never be parsed into a real element');
      assert.match(header.querySelector('.file-view-meta').textContent, /<img/,
        'the malicious string must still appear as literal inert text, not be silently stripped');
    });
  });

  it('a long Cyrillic source path renders fully in the header meta line without truncation or mangling', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const longPath = 'Тема 10. Stateful аутентифікація. Управління сесіями та файлами cookie/дуже-довга-назва-файлу-для-перевірки.md';
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/chunks?': { chunks: [{ chunkIndex: 0, text: 'hello' }] },
      });
      await openFileView('nodejs-basics', longPath, null, undefined);
      assert.equal(document.querySelector('#content-title').textContent, 'дуже-довга-назва-файлу-для-перевірки.md');
      assert.match(document.querySelector('.file-view-meta').textContent, new RegExp(longPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });
});

// ── Phase 3H: section clicks try an exact node_path match before falling
// back to the windowed anchor view ──────────────────────────────────────
describe('openSectionView() — exact section match via node_path filtering', () => {
  it('code-review fix: tries the exact match BEFORE /skeleton/anchor when node.sourceFile is already known', async () => {
    // Regression: the backend's anchor resolver only finds chunks whose
    // parent_id is DIRECTLY this section's node_id
    // (getFirstContentChunkByParent) — a parent section with no prose/
    // table/code of its own, only nested child sections that DO have
    // content, 404s out of /skeleton/anchor. chunksBelongToSection()
    // explicitly treats descendants (not just direct children) as
    // belonging to the section, so the exact-match attempt must run first
    // and succeed here even though the anchor call would 404 if it were
    // tried.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let anchorCalled = false;
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/skeleton/anchor?': () => { anchorCalled = true; throw Object.assign(new Error('not found'), { status: 404 }); },
        '/chunks?': {
          chunks: [
            { chunkIndex: 0, nodePath: 'readme.md#setup/child-section/paragraph-1', text: 'nested step detail' },
            { chunkIndex: 1, nodePath: 'readme.md#other/paragraph-1', text: 'unrelated section' },
          ],
        },
      });
      await openSectionView('my-docs', {
        nodePath: 'readme.md#setup', nodeType: 'section', sourceFile: 'readme.md', headingPath: ['Setup'],
      });
      assert.equal(anchorCalled, false, '/skeleton/anchor must not be called at all when the exact match already succeeded');
      const cards = document.querySelectorAll('#collection-content .chunk');
      assert.equal(cards.length, 1, 'the descendant chunk under the child section must render');
      assert.match(document.querySelector('#collection-content').textContent, /nested step detail/);
      assert.doesNotMatch(document.querySelector('#collection-content').textContent, /unrelated section/);
      assert.doesNotMatch(document.querySelector('#collection-content').textContent, /no indexed content/i,
        'must not show the empty-state — the exact match found real content');
    });
  });

  it('renders only chunks whose node_path falls under the section node_path, not the whole file', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/skeleton/anchor?': { chunk: { sourceFile: 'readme.md', chunkIndex: 3 } },
        '/chunks?': (url) => {
          // openSectionView's exact-match path fetches the whole file (no
          // chunkIndex param) — a windowed request (with chunkIndex) would
          // indicate it fell back instead, which this test must not do.
          assert.equal(new URL(url, 'http://x').searchParams.has('chunkIndex'), false,
            'an exact section match must not also make a windowed fallback request');
          return {
            chunks: [
              { chunkIndex: 0, nodePath: 'readme.md#intro/paragraph-1', text: 'intro text' },
              { chunkIndex: 3, nodePath: 'readme.md#setup/paragraph-1', text: 'setup step 1' },
              { chunkIndex: 4, nodePath: 'readme.md#setup/code_block-1', text: 'setup code' },
              { chunkIndex: 5, nodePath: 'readme.md#other/paragraph-1', text: 'unrelated section' },
            ],
          };
        },
      });
      await openSectionView('my-docs', { nodePath: 'readme.md#setup', nodeType: 'section', headingPath: ['Setup'] });
      const cards = document.querySelectorAll('#collection-content .chunk');
      assert.equal(cards.length, 2, 'only the 2 chunks under readme.md#setup must render');
      const text = document.querySelector('#collection-content').textContent;
      assert.match(text, /setup step 1/);
      assert.match(text, /setup code/);
      assert.doesNotMatch(text, /intro text/);
      assert.doesNotMatch(text, /unrelated section/);
    });
  });

  it('the header badge shows the exact matched count and labels it an exact section match', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/skeleton/anchor?': { chunk: { sourceFile: 'readme.md', chunkIndex: 3 } },
        '/chunks?': {
          chunks: [
            { chunkIndex: 3, nodePath: 'readme.md#setup/paragraph-1', text: 'a' },
            { chunkIndex: 4, nodePath: 'readme.md#setup/paragraph-2', text: 'b' },
          ],
        },
      });
      await openSectionView('my-docs', { nodePath: 'readme.md#setup', nodeType: 'section', headingPath: ['Setup'] });
      assert.equal(document.querySelector('.file-view-count').textContent, '2 chunks');
      assert.match(document.querySelector('.file-view-meta').textContent, /exact section match/);
    });
  });

  it('falls back to the windowed anchor view with a "nearby chunks" disclosure when no chunk node_path matches the section', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const requestedUrls = [];
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/skeleton/anchor?': { chunk: { sourceFile: 'readme.md', chunkIndex: 3 } },
        '/chunks?': (url) => {
          requestedUrls.push(url);
          const hasChunkIndex = new URL(url, 'http://x').searchParams.has('chunkIndex');
          if (!hasChunkIndex) {
            // First call: whole-file fetch for the exact-match attempt —
            // none of these node_paths fall under readme.md#setup.
            return { chunks: [{ chunkIndex: 3, nodePath: 'readme.md#other/paragraph-1', text: 'unrelated' }] };
          }
          // Second call: the windowed fallback fetch.
          return { chunks: [{ chunkIndex: 3, text: 'the target', totalChunks: 10 }] };
        },
      });
      await openSectionView('my-docs', { nodePath: 'readme.md#setup', nodeType: 'section', headingPath: ['Setup'] });
      assert.equal(requestedUrls.length, 2, 'must attempt the exact match, then fall back to a second windowed request');
      const targets = document.querySelectorAll('#collection-content .chunk-target');
      assert.equal(targets.length, 1, 'the fallback must still highlight the resolved anchor chunk');
      assert.match(document.querySelector('.file-view-meta').textContent, /nearby chunks/,
        'the fallback header must disclose that this is a neighborhood, not an exact section slice');
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
