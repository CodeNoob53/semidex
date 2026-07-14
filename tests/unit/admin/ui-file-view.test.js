// Tests for src/admin/ui-src/file-view.js's rendering (renderFileChunks).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFileViewRenderHelpers, loadFileViewBehaviorHelpers, withServer, readUiSource } from './ui-test-helpers.js';
import { renderChunkContent } from '../../../src/admin/ui-src/structural-renderer.js';

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
      assert.equal(Boolean(card.querySelector('.rank')), false);
      assert.equal(Boolean(card.querySelector('.score')), false);
      assert.equal(Boolean(card.querySelector('.score-bar')), false);
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
    // that file-view.js's (now lazy, Chunks-mode-only) chunk fetch actually
    // calls the /chunks endpoint backed by that primitive (no separate,
    // unaudited fetch path), and that the Document path goes through the
    // assembly endpoint, whose store primitives carry the same exclusion.
    const js = readUiSource('file-view.js');
    assert.match(js, /api\(`\/api\/collections\/\$\{encodeURIComponent\(state\.collection\)\}\/chunks\?\$\{qs\}`\)/);
    assert.match(js, /api\(`\/api\/collections\/\$\{encodeURIComponent\(name\)\}\/assembly\?\$\{qs\}`\)/);
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
      assert.equal(Boolean(primary.querySelector('.chunk-index-label')), false, '.chunk-index-label must not live inside .chunk-primary');
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
describe('chunk cards (Phase 3P/3T): raw table/code content never parses into live HTML elements', () => {
  it('a table chunk containing HTML-like text (not a valid GFM table) falls back to inert raw text', async () => {
    // No header-separator row ("|---|") — not a parseable GFM table, so
    // structural-renderer.js falls back to its raw-only path (same
    // .chunk-text-bearing shape as before Phase 3T) rather than throwing.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html, { renderChunkContentImpl: renderChunkContent });
      const adversarial = '| <img src=x onerror=alert(1)> | <script>alert(2)</script> |';
      const frag = renderFileChunks([{ chunkIndex: 0, nodeType: 'table', text: adversarial, context: 'Intro — table' }]);
      const textEl = frag.querySelector('.chunk-text');
      assert.equal(textEl.textContent, adversarial, 'the raw table text must be preserved verbatim as text');
      assert.equal(Boolean(textEl.querySelector('img')), false, 'must never parse into a real <img> element');
      assert.equal(Boolean(textEl.querySelector('script')), false, 'must never parse into a real <script> element');
    });
  });

  it('a valid GFM table with an HTML-like cell renders through the structural renderer with no live element', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html, { renderChunkContentImpl: renderChunkContent });
      const adversarial = '| A | B |\n| --- | --- |\n| <img src=x onerror=alert(1)> | <script>alert(2)</script> |';
      const frag = renderFileChunks([{ chunkIndex: 0, nodeType: 'table', text: adversarial, context: 'Intro — table' }]);
      assert.equal(Boolean(frag.querySelector('img')), false, 'must never parse into a real <img> element');
      assert.equal(Boolean(frag.querySelector('script')), false, 'must never parse into a real <script> element');
      assert.ok(frag.querySelector('table'), 'a valid GFM table renders as a real <table>');
    });
  });

  it('a code_block chunk containing HTML-like text renders as inert text, not a real element (Phase 3T: through the highlighter, still never live markup)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html, { renderChunkContentImpl: renderChunkContent });
      const adversarial = 'const x = "<div onclick=alert(1)>";';
      const frag = renderFileChunks([{ chunkIndex: 0, nodeType: 'code_block', text: adversarial, context: 'Intro — code block' }]);
      const codeEl = frag.querySelector('code');
      assert.ok(codeEl, 'code_block renders through the structural renderer');
      // Scoped to inside <code> specifically — the card itself legitimately
      // contains a real <div class="chunk"> wrapper (the template root), so
      // a query against the whole fragment for "div" would false-positive
      // on that unrelated element rather than checking the adversarial
      // string was never parsed into markup.
      assert.equal(Boolean(codeEl.querySelector('div')), false, 'must never parse into a real <div> element inside the code output');
      assert.equal(codeEl.textContent, adversarial, 'the raw code text must be preserved verbatim as text');
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
  const assemblyStub = {
    collection: 'my-docs', scope: 'file', sourceFile: 'readme.md', nodePath: null,
    assemblyMode: 'entity_refs', warnings: [],
    segments: [{ kind: 'prose', chunkIndex: 0, nodeType: 'paragraph', text: 'hello' }],
  };

  it('openFileView() clears #search-results and #search-status', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': assemblyStub,
      });
      assert.notEqual(document.querySelector('#search-results').innerHTML, '');
      await openFileView('my-docs', 'readme.md', null, 0);
      assert.equal(document.querySelector('#search-results').innerHTML, '');
      assert.equal(document.querySelector('#search-status').innerHTML, '');
    });
  });

  it('openSectionView() clears #search-results and #search-status', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': { ...assemblyStub, scope: 'section', nodePath: 'readme.md#intro' },
      });
      assert.notEqual(document.querySelector('#search-results').innerHTML, '');
      await openSectionView('my-docs', { nodePath: 'readme.md#intro', nodeType: 'section' });
      assert.equal(document.querySelector('#search-results').innerHTML, '');
    });
  });
});

// ── Phase 3W: Document mode is the default; /chunks is lazy behind the
// Chunks reader mode. The full reader state machine (mode switching, lazy
// caching, race safety, target highlight, warnings) lives in
// ui-assembly-view.test.js — this file keeps the header/empty-state/
// pagination behaviors that stayed with file-view.js.
describe('file open (Phase 3W): assembled Document by default, chunk count only in Chunks mode', () => {
  function makeChunks(count) {
    return Array.from({ length: count }, (_, i) => ({ chunkIndex: i, text: `chunk ${i}`, section: 'Intro' }));
  }
  const assembly = {
    collection: 'my-docs', scope: 'file', sourceFile: 'docs/readme.md', nodePath: null,
    assemblyMode: 'entity_refs', warnings: [],
    segments: [{ kind: 'prose', chunkIndex: 0, nodeType: 'paragraph', text: 'hello' }],
  };

  it('the title stays the plain filename, and the Document-mode header hides the chunk-count badge', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': assembly,
      });
      await openFileView('my-docs', 'docs/readme.md');
      assert.equal(document.querySelector('#content-title').textContent, 'readme.md');
      assert.equal(document.querySelector('.file-view-count').hidden, true,
        'Document mode is a reader, not an index inspector — no technical chunk-count badge');
      const meta = document.querySelector('.file-view-meta').textContent;
      assert.match(meta, /docs\/readme\.md/, 'meta line must show the relative source path, not just the basename');
      assert.match(meta, /my-docs/, 'meta line must show the collection name as secondary context');
    });
  });

  it('the lazy Chunks-mode fetch requests /chunks with no chunkIndex/window params (the whole-file primitive)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let requestedUrl = null;
      const { document, openFileView, setReaderMode } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': assembly,
        '/chunks?': (url) => { requestedUrl = url; return { chunks: makeChunks(7) }; },
      });
      await openFileView('my-docs', 'docs/readme.md');
      assert.equal(requestedUrl, null, 'no /chunks request during the initial Document render');
      await setReaderMode('chunks');
      const qs = new URL(requestedUrl, 'http://x').searchParams;
      assert.equal(qs.get('sourceFile'), 'docs/readme.md');
      assert.equal(qs.has('chunkIndex'), false, 'the lazy fetch must not send chunkIndex');
      assert.equal(qs.has('window'), false, 'the lazy fetch must not send window');
      assert.equal(document.querySelector('.file-view-count').textContent, '7 chunks',
        'Chunks mode shows the real fetched count in the header badge');
    });
  });

  it('Chunks mode pages five at a time, revealing from memory with no extra requests, and resets per file', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let fetchCount = 0;
      const { document, openFileView, setReaderMode, loadMoreFileChunks } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': (url) => ({ ...assembly, sourceFile: new URL(url, 'http://x').searchParams.get('sourceFile') }),
        '/chunks?': (url) => {
          fetchCount++;
          const sourceFile = new URL(url, 'http://x').searchParams.get('sourceFile');
          return { chunks: makeChunks(sourceFile === 'first.md' ? 12 : 3) };
        },
      });
      await openFileView('my-docs', 'first.md');
      await setReaderMode('chunks');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 5);
      await loadMoreFileChunks();
      assert.equal(fetchCount, 1, '"load more" must not trigger a second /chunks request');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 10);
      await loadMoreFileChunks();
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 12);
      assert.equal(Boolean(document.querySelector('#file-load-more')), false,
        '"load more" must disappear once every fetched chunk is visible');

      await openFileView('my-docs', 'second.md');
      await setReaderMode('chunks');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 3,
        'opening a new file must not carry over the previous file\'s visible-count state');
      assert.equal(fetchCount, 2, 'the new file gets its own lazy fetch — caches never leak across opens');
    });
  });

  it('shows a clean, non-technical empty-state message when the file genuinely has zero chunks (assembly 404)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': Object.assign(new Error('not found'), { status: 404 }),
      });
      await openFileView('my-docs', 'empty.md');
      const text = document.querySelector('#collection-content').textContent;
      assert.match(text, /No searchable chunks in this file/);
      assert.match(text, /navigation\/metadata or unsupported content/,
        'must explain the file may only contain navigation/metadata, not raw API/debug text');
    });
  });
});

// ── Chunks-mode target highlight stays at the pure render layer ────────────
describe('renderFileChunks() target highlighting (Chunks mode)', () => {
  it('the chunk matching targetChunkIndex gets the .chunk-target class, others do not', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const frag = renderFileChunks([
        { chunkIndex: 4, text: 'before' },
        { chunkIndex: 5, text: 'the target' },
        { chunkIndex: 6, text: 'after' },
      ], 5);
      const targets = frag.querySelectorAll('.chunk-target');
      assert.equal(targets.length, 1, 'exactly one chunk must be marked as the target');
      assert.match(targets[0].textContent, /the target/);
    });
  });

  it('no targetChunkIndex marks no chunk as .chunk-target', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const frag = renderFileChunks([{ chunkIndex: 0, text: 'a' }, { chunkIndex: 1, text: 'b' }]);
      assert.equal(frag.querySelectorAll('.chunk-target').length, 0);
    });
  });
});

// ── Phase 3H: the new file/section header never lets API/collection-name
// content become live markup, and long names don't break layout ──────────
describe('file-view header (Phase 3H): API content is escaped, never parsed as markup', () => {
  const proseAssembly = {
    collection: 'my-docs', scope: 'file', sourceFile: 'x', nodePath: null,
    assemblyMode: 'entity_refs', warnings: [],
    segments: [{ kind: 'prose', chunkIndex: 0, nodeType: 'paragraph', text: 'hello' }],
  };

  it('a sourceFile/collection name containing HTML renders as inert text in the header, never a real element', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': proseAssembly,
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
        '/assembly?': proseAssembly,
      });
      await openFileView('nodejs-basics', longPath, null, undefined);
      assert.equal(document.querySelector('#content-title').textContent, 'дуже-довга-назва-файлу-для-перевірки.md');
      assert.match(document.querySelector('.file-view-meta').textContent, new RegExp(longPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });
});

// ── Phase 3W: section opens go straight to the exact assembly contract ─────
// The old chain (whole-file fetch + browser-side node_path filtering, then
// /skeleton/anchor + windowed fallback) is gone from the default path — the
// backend resolves exact section identity through the skeleton node and
// parent_id. The full section behaviors (exact nodePath request, empty
// state, Chunks-mode filtering) live in ui-assembly-view.test.js; this
// describe pins that the legacy fallback machinery really is gone.
describe('openSectionView() — assembly-backed exact section (Phase 3W)', () => {
  it('a section open makes exactly one request — the assembly call — never /skeleton/anchor or a whole-file /chunks fetch', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const requested = [];
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': (url) => {
          requested.push(url);
          return {
            collection: 'my-docs', scope: 'section', sourceFile: 'readme.md', nodePath: 'readme.md#setup',
            assemblyMode: 'entity_refs', warnings: [],
            segments: [{ kind: 'prose', chunkIndex: 3, nodeType: 'paragraph', text: 'setup step 1' }],
          };
        },
        '/skeleton/anchor?': () => { throw new Error('anchor must not be called'); },
        '/chunks?': () => { throw new Error('/chunks must not be called on the Document path'); },
      });
      await openSectionView('my-docs', { nodePath: 'readme.md#setup', nodeType: 'section', sourceFile: 'readme.md', headingPath: ['Setup'] });
      assert.equal(requested.length, 1);
      assert.match(document.querySelector('.assembly-doc').textContent, /setup step 1/);
      assert.match(document.querySelector('.file-view-meta').textContent, /Setup/, 'the heading path renders as secondary metadata');
    });
  });

  it('file-view.js no longer contains the anchor/windowed fallback machinery at all', () => {
    const js = readUiSource('file-view.js');
    assert.doesNotMatch(js, /skeleton\/anchor/, 'the /skeleton/anchor fallback is gone from the reader');
    assert.doesNotMatch(js, /window=3/, 'the windowed neighborhood fetch is gone from the reader');
  });

  it('an unknown section (assembly 404) shows the clean empty state with the Open file action when sourceFile is known', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': Object.assign(new Error('not found'), { status: 404 }),
      });
      await openSectionView('my-docs', { nodePath: 'readme.md#intro', nodeType: 'section', sourceFile: 'readme.md' });
      assert.match(document.querySelector('#collection-content').textContent, /This section has no indexed content\./);
      assert.ok(document.querySelector('#section-open-file-start'), 'the Open file action must render when sourceFile is known');
    });
  });
});
