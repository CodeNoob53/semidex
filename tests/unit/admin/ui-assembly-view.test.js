// Tests for the Phase 3W document reader: assembly-view.js (segment/banner
// rendering) + file-view.js's reader state machine (assembly-first opens,
// Document/Chunks mode toggle, lazy cached /chunks, race safety). Uses the
// same vm-evaluated-source harness as the other ui-* tests, against the real
// built index.html (for the <template> partials).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFileViewBehaviorHelpers, withServer, readUiSource } from './ui-test-helpers.js';
import { renderChunkContent } from '../../../src/shared/admin/ui-src/structural-renderer.js';

function fileAssembly(overrides = {}) {
  return {
    collection: 'my-docs', scope: 'file', sourceFile: 'guide.md', nodePath: null,
    assemblyMode: 'entity_refs',
    segments: [
      { kind: 'prose', chunkIndex: 0, nodeType: 'paragraph', text: 'First paragraph.\n\nSecond paragraph.', context: 'Setup', section: 'Setup', headingPath: ['Setup'] },
      { kind: 'entity', chunkIndex: 1, nodeId: 'n-table', nodePath: 'guide.md#setup/table-1', nodeType: 'table', rawContent: '| A | B |\n|---|---|\n| 1 | 2 |', lang: null, context: 'Setup', section: 'Setup', headingPath: ['Setup'] },
      { kind: 'prose', chunkIndex: 2, nodeType: 'paragraph', text: 'Closing remark.', context: 'Setup', section: 'Setup', headingPath: ['Setup'] },
    ],
    warnings: [],
    ...overrides,
  };
}

function sectionAssembly(overrides = {}) {
  return {
    collection: 'my-docs', scope: 'section', sourceFile: 'guide.md', nodePath: 'guide.md#setup',
    assemblyMode: 'entity_refs',
    segments: [
      { kind: 'prose', chunkIndex: 3, nodeType: 'paragraph', text: 'Section prose.', context: 'Setup', section: 'Setup', headingPath: ['Setup'] },
    ],
    warnings: [],
    ...overrides,
  };
}

describe('document reader — open flows request the assembly API', () => {
  it('a file open requests scope=file assembly with the exact sourceFile, and does NOT fetch /chunks', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const requested = [];
      let chunksFetches = 0;
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': (url) => { requested.push(url); return fileAssembly(); },
        '/chunks?': () => { chunksFetches++; return { chunks: [] }; },
      });
      await openFileView('my-docs', 'docs/guide.md');
      assert.equal(requested.length, 1);
      const qs = new URL(requested[0], 'http://x').searchParams;
      assert.equal(qs.get('scope'), 'file');
      assert.equal(qs.get('sourceFile'), 'docs/guide.md');
      assert.equal(chunksFetches, 0, 'the /chunks fetch must be lazy — never during the initial Document render');
      assert.ok(document.querySelector('.assembly-doc'), 'Document mode renders the assembled document');
    });
  });

  it('a section open requests scope=section with the exact nodePath — no whole-file fetch, no anchor call', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const requested = [];
      let otherCalls = 0;
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': (url) => { requested.push(url); return sectionAssembly(); },
        '/chunks?': () => { otherCalls++; return { chunks: [] }; },
        '/skeleton/anchor?': () => { otherCalls++; return {}; },
      });
      await openSectionView('my-docs', { nodePath: 'guide.md#setup', nodeType: 'section', sourceFile: 'guide.md', headingPath: ['Setup'] });
      assert.equal(requested.length, 1);
      const qs = new URL(requested[0], 'http://x').searchParams;
      assert.equal(qs.get('scope'), 'section');
      assert.equal(qs.get('nodePath'), 'guide.md#setup');
      assert.equal(otherCalls, 0, 'the Document path must not fetch the whole file or resolve an anchor in the browser');
      assert.match(document.querySelector('.assembly-doc').textContent, /Section prose\./);
    });
  });

  it('initial mode is Document: the toggle renders with Document pressed, and no chunk card exists', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': fileAssembly(),
      });
      await openFileView('my-docs', 'guide.md');
      const toggle = document.querySelector('.reader-mode-toggle');
      assert.ok(toggle, 'the header carries the Document | Chunks segmented control');
      const docBtn = toggle.querySelector('[data-mode="document"]');
      const chunksBtn = toggle.querySelector('[data-mode="chunks"]');
      assert.equal(docBtn.getAttribute('aria-pressed'), 'true');
      assert.equal(chunksBtn.getAttribute('aria-pressed'), 'false');
      assert.equal(docBtn.getAttribute('title'), 'Read as a continuous document');
      assert.equal(chunksBtn.getAttribute('title'), 'Inspect indexed chunks');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 0, 'no chunk cards in Document mode');
    });
  });

  it('Document mode hides the technical "N chunks" badge in the header', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': fileAssembly(),
      });
      await openFileView('my-docs', 'guide.md');
      assert.equal(document.querySelector('.file-view-count').hidden, true);
      const meta = document.querySelector('.file-view-meta').textContent;
      assert.match(meta, /guide\.md/, 'source path stays as secondary metadata');
      assert.match(meta, /my-docs/, 'collection stays as secondary metadata');
    });
  });
});

describe('document reader — segment rendering', () => {
  it('prose segments render continuously, in order, as unframed text (no per-segment card, no chunk N label)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': fileAssembly(),
      });
      await openFileView('my-docs', 'guide.md');
      const segments = [...document.querySelectorAll('.assembly-segment')];
      assert.equal(segments.length, 3, 'one segment element per API segment, in order');
      assert.deepEqual(segments.map(s => s.dataset.chunkIndex), ['0', '1', '2'], 'chunk identity kept in the DOM via data-chunk-index');
      assert.match(segments[0].textContent, /First paragraph\./);
      assert.match(segments[2].textContent, /Closing remark\./);
      const docText = document.querySelector('.assembly-doc').textContent;
      assert.ok(docText.indexOf('First paragraph.') < docText.indexOf('Closing remark.'), 'original order preserved');
      assert.doesNotMatch(docText, /chunk \d/, 'no technical "chunk N" labels in Document mode');
      assert.equal(document.querySelectorAll('.assembly-doc .chunk').length, 0, 'prose is never wrapped in chunk cards');
    });
  });

  it('a table entity renders through the SHARED structural renderer (a real <table>, same as chunk cards)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': fileAssembly(),
      }, { renderChunkContentImpl: renderChunkContent });
      await openFileView('my-docs', 'guide.md');
      const entity = document.querySelector('.assembly-entity');
      assert.ok(entity.querySelector('table.structural-table'), 'the shared renderer produced its real table element');
      assert.equal(entity.querySelector('.structural-table tbody td').textContent, '1');
    });
  });

  it('a code entity renders through the SHARED structural renderer (hljs code element, lang passed through)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const assembly = fileAssembly({
        segments: [
          { kind: 'prose', chunkIndex: 0, nodeType: 'paragraph', text: 'Snippet:' },
          { kind: 'entity', chunkIndex: 1, nodeId: 'n-code', nodePath: 'guide.md#setup/code_block-1', nodeType: 'code_block', rawContent: '```js\nconst x = 1;\n```', lang: 'js' },
        ],
      });
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': assembly,
      }, { renderChunkContentImpl: renderChunkContent });
      await openFileView('my-docs', 'guide.md');
      const code = document.querySelector('.assembly-entity code');
      assert.ok(code, 'the shared renderer produced a code element');
      assert.match(code.className, /language-javascript/, 'the segment lang drove highlighting');
      assert.match(code.textContent, /const x = 1;/);
    });
  });

  it('a checklist entity stays on the renderer\'s safe plain-text path (inert text, no second renderer)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const hostile = '- [x] done <img src=x onerror=alert(1)>\n- [ ] next';
      const assembly = fileAssembly({
        segments: [
          { kind: 'entity', chunkIndex: 0, nodeId: 'n-cl', nodePath: 'guide.md#tasks/checklist-1', nodeType: 'checklist', rawContent: hostile, lang: null },
        ],
      });
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': assembly,
      }, { renderChunkContentImpl: renderChunkContent });
      await openFileView('my-docs', 'guide.md');
      const entity = document.querySelector('.assembly-entity');
      assert.equal(entity.textContent.includes(hostile), true, 'checklist raw content preserved verbatim as text');
      assert.equal(Boolean(entity.querySelector('img')), false, 'hostile markup must never become a live element');
      assert.equal(Boolean(entity.querySelector('table')), false, 'a checklist is not routed through the table renderer');
    });
  });

  it('no placeholder line appears in rendered Document mode, and no entity is duplicated', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': fileAssembly(),
      });
      await openFileView('my-docs', 'guide.md');
      const docText = document.querySelector('.assembly-doc').textContent;
      assert.doesNotMatch(docText, /\[table node:|\[code block node:|\[checklist node:/,
        'the assembled document never shows placeholder lines');
      assert.equal(document.querySelectorAll('.assembly-entity').length, 1, 'exactly one entity segment per API entity — never inserted twice');
    });
  });

  it('hostile prose, paths, and context never become live HTML anywhere in the reader', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const hostile = '<img src=x onerror="window.__pwned=1"><script>alert(1)</script>';
      const assembly = fileAssembly({
        sourceFile: hostile,
        segments: [
          { kind: 'prose', chunkIndex: 0, nodeType: 'paragraph', text: `Prose with ${hostile} inline.`, context: hostile, section: hostile },
        ],
      });
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': assembly,
      });
      await openFileView('my-docs', hostile);
      const box = document.querySelector('#collection-content');
      assert.equal(box.querySelectorAll('img').length, 0, 'no hostile <img> anywhere in the rendered reader');
      assert.equal(box.querySelectorAll('script').length, 0, 'no hostile <script> anywhere in the rendered reader');
      assert.match(box.querySelector('.assembly-prose').textContent, /<img src=x/, 'hostile prose is preserved as inert text, not stripped');
      assert.match(box.querySelector('.file-view-meta').textContent, /<img src=x/, 'hostile path renders as inert header text');
    });
  });

  it('a target chunkIndex (search open) highlights exactly its assembled segment, without switching to Chunks mode', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': fileAssembly(),
      });
      await openFileView('my-docs', 'guide.md', null, 2);
      const targets = document.querySelectorAll('.assembly-target');
      assert.equal(targets.length, 1, 'exactly one segment carries the target highlight');
      assert.equal(targets[0].dataset.chunkIndex, '2');
      assert.ok(document.querySelector('.assembly-doc'), 'the reader stays in Document mode');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 0, 'a search open must not fall back to chunk cards');
    });
  });
});

describe('document reader — Document/Chunks mode switching, lazy fetch, caching', () => {
  function makeChunks(count) {
    return Array.from({ length: count }, (_, i) => ({ chunkIndex: i, text: `chunk ${i}`, section: 'Intro', nodePath: `guide.md#setup/paragraph-${i}` }));
  }

  it('switching to Chunks lazily fetches /chunks once; repeated toggles refetch nothing', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let assemblyFetches = 0;
      let chunksFetches = 0;
      const { document, openFileView, setReaderMode } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': () => { assemblyFetches++; return fileAssembly(); },
        '/chunks?': () => { chunksFetches++; return { chunks: makeChunks(3) }; },
      });
      await openFileView('my-docs', 'guide.md');
      assert.equal(chunksFetches, 0);

      await setReaderMode('chunks');
      assert.equal(chunksFetches, 1, 'first switch fetches the chunks');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 3);
      assert.equal(document.querySelector('.reader-mode-toggle [data-mode="chunks"]').getAttribute('aria-pressed'), 'true');
      assert.equal(document.querySelector('.file-view-count').hidden, false, 'Chunks mode shows the chunk count badge');
      assert.equal(document.querySelector('.file-view-count').textContent, '3 chunks');

      await setReaderMode('document');
      assert.ok(document.querySelector('.assembly-doc'), 'Document mode re-renders from the cached assembly');
      await setReaderMode('chunks');
      await setReaderMode('document');
      assert.equal(assemblyFetches, 1, 'Document -> Chunks -> Document -> Chunks must not refetch the assembly');
      assert.equal(chunksFetches, 1, '...nor the chunks');
    });
  });

  it('the header toggle buttons actually switch modes on click', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': fileAssembly(),
        '/chunks?': { chunks: makeChunks(2) },
      });
      await openFileView('my-docs', 'guide.md');
      document.querySelector('.reader-mode-toggle [data-mode="chunks"]').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 2, 'clicking Chunks renders the chunk cards');
    });
  });

  it('Chunks mode keeps the five-at-a-time reveal and "load more" pagination', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let chunksFetches = 0;
      const { document, setReaderMode, openFileView, loadMoreFileChunks } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': fileAssembly(),
        '/chunks?': () => { chunksFetches++; return { chunks: makeChunks(12) }; },
      });
      await openFileView('my-docs', 'guide.md');
      await setReaderMode('chunks');
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 5);
      await loadMoreFileChunks();
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 10);
      await loadMoreFileChunks();
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 12);
      assert.equal(Boolean(document.querySelector('#file-load-more')), false, 'the button disappears once everything is visible');
      assert.equal(chunksFetches, 1, '"load more" reveals from memory, no extra network calls');
    });
  });

  it('a section\'s Chunks mode filters the whole-file fetch by exact node_path lineage', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openSectionView, setReaderMode } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': sectionAssembly(),
        '/chunks?': { chunks: [
          { chunkIndex: 0, nodePath: 'guide.md#intro/paragraph-1', text: 'intro text' },
          { chunkIndex: 3, nodePath: 'guide.md#setup/paragraph-1', text: 'setup text' },
          { chunkIndex: 5, nodePath: 'guide.md#other/paragraph-1', text: 'other text' },
        ] },
      });
      await openSectionView('my-docs', { nodePath: 'guide.md#setup', nodeType: 'section', sourceFile: 'guide.md' });
      await setReaderMode('chunks');
      const text = document.querySelector('#collection-content').textContent;
      assert.match(text, /setup text/);
      assert.doesNotMatch(text, /intro text/);
      assert.doesNotMatch(text, /other text/);
    });
  });

  it('opening another file resets reader state: Document mode, fresh caches, no stale content', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let chunksFetches = 0;
      const { document, openFileView, setReaderMode } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': (url) => {
          const sf = new URL(url, 'http://x').searchParams.get('sourceFile');
          return fileAssembly({
            sourceFile: sf,
            segments: [{ kind: 'prose', chunkIndex: 0, nodeType: 'paragraph', text: `content of ${sf}` }],
          });
        },
        '/chunks?': (url) => {
          chunksFetches++;
          const sf = new URL(url, 'http://x').searchParams.get('sourceFile');
          return { chunks: [{ chunkIndex: 0, text: `chunks of ${sf}` }] };
        },
      });
      await openFileView('my-docs', 'first.md');
      await setReaderMode('chunks');
      assert.equal(chunksFetches, 1);

      await openFileView('my-docs', 'second.md');
      assert.ok(document.querySelector('.assembly-doc'), 'a fresh open defaults back to Document mode');
      assert.match(document.querySelector('.assembly-doc').textContent, /content of second\.md/);
      assert.doesNotMatch(document.querySelector('#collection-content').textContent, /first\.md/, 'no stale content from the previous file');

      await setReaderMode('chunks');
      assert.equal(chunksFetches, 2, 'the second file gets its own lazy chunks fetch — the first file\'s cache is not reused');
      assert.match(document.querySelector('#collection-content').textContent, /chunks of second\.md/);
    });
  });

  // Code review (P2): a rejected lazy /chunks fetch used to replace the
  // ENTIRE reader (header, toggle, document) with a bare error box — the
  // user had no way back short of re-opening the file. The reader must
  // recover to the still-cached Document view and surface the failure as a
  // non-blocking toast instead.
  it('a rejected lazy /chunks fetch recovers to the Document view (header + toggle intact) with a non-blocking toast, and the toggle can be retried', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let chunksCalls = 0;
      const helpers = loadFileViewBehaviorHelpers(html, {
        '/assembly?': fileAssembly(),
        '/chunks?': () => {
          chunksCalls++;
          if (chunksCalls === 1) throw Object.assign(new Error('backend unavailable'), { status: 503 });
          return { chunks: makeChunks(2) };
        },
      });
      const { document, openFileView, setReaderMode } = helpers;
      await openFileView('my-docs', 'guide.md');

      await setReaderMode('chunks');
      assert.ok(document.querySelector('.assembly-doc'), 'the Document view is re-rendered from cache, not replaced by a bare error box');
      assert.ok(document.querySelector('.reader-mode-toggle'), 'the mode toggle survives the failure — the user can retry');
      assert.equal(document.querySelector('.reader-mode-btn[data-mode="document"]').getAttribute('aria-pressed'), 'true',
        'the reader honestly reports it is back in Document mode');
      assert.equal(document.querySelectorAll('#collection-content .error-box').length, 0,
        'no blocking error box replaces the reader surface');
      assert.equal(helpers.__toasts.length, 1, 'the failure surfaces as exactly one toast');
      assert.equal(helpers.__toasts[0].variant, 'error');
      assert.match(helpers.__toasts[0].message, /backend unavailable/);

      // The toggle is immediately retryable — the failed attempt cached
      // nothing, so the retry fetches again and succeeds.
      await setReaderMode('chunks');
      assert.equal(chunksCalls, 2);
      assert.equal(document.querySelectorAll('#collection-content .chunk').length, 2, 'the retry renders the chunk cards');
    });
  });

  it('a stale slow assembly response cannot overwrite a newer navigation (generation guard, no timeouts)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let releaseFirst;
      const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': async (url) => {
          const sf = new URL(url, 'http://x').searchParams.get('sourceFile');
          if (sf === 'slow.md') {
            await firstGate; // held until after the second navigation lands
            return fileAssembly({ segments: [{ kind: 'prose', chunkIndex: 0, nodeType: 'paragraph', text: 'SLOW STALE CONTENT' }] });
          }
          return fileAssembly({ segments: [{ kind: 'prose', chunkIndex: 0, nodeType: 'paragraph', text: 'fresh fast content' }] });
        },
      });
      const slowOpen = openFileView('my-docs', 'slow.md');
      await openFileView('my-docs', 'fast.md');
      assert.match(document.querySelector('.assembly-doc').textContent, /fresh fast content/);

      releaseFirst();
      await slowOpen;
      assert.match(document.querySelector('.assembly-doc').textContent, /fresh fast content/,
        'the late response must not render');
      assert.doesNotMatch(document.querySelector('#collection-content').textContent, /SLOW STALE CONTENT/);
    });
  });
});

describe('document reader — assembly warnings and legacy modes', () => {
  it('placeholder_fallback with several warnings collapses to ONE fallback banner (+ at most one generic integrity line)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const assembly = fileAssembly({
        assemblyMode: 'placeholder_fallback',
        warnings: [
          { code: 'placeholder_fallback', message: 'internal fallback message' },
          { code: 'orphan_placeholder', message: 'internal orphan detail 1', placeholder: '[table node: x]' },
          { code: 'orphan_placeholder', message: 'internal orphan detail 2', placeholder: '[table node: y]' },
        ],
      });
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, { '/assembly?': assembly });
      await openFileView('my-docs', 'guide.md');
      const banners = document.querySelectorAll('.assembly-warning');
      assert.equal(banners.length, 2, 'one fallback banner + one collapsed integrity banner — never one per warning');
      assert.match(banners[0].textContent, /assembled from an older index/i);
      assert.match(banners[1].textContent, /Some structured content could not be linked automatically/);
      const boxText = document.querySelector('#collection-content').textContent;
      assert.doesNotMatch(boxText, /orphan_placeholder|internal orphan detail|\[table node: x\]/,
        'raw warning objects/codes/placeholders never surface in the UI');
    });
  });

  it('integrity warnings alone (entity_refs mode) show one generic banner, not the fallback banner', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const assembly = fileAssembly({
        warnings: [{ code: 'ref_entity_missing', message: 'internal', nodePath: 'x' }],
      });
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, { '/assembly?': assembly });
      await openFileView('my-docs', 'guide.md');
      const banners = document.querySelectorAll('.assembly-warning');
      assert.equal(banners.length, 1);
      assert.match(banners[0].textContent, /could not be linked automatically/);
      assert.doesNotMatch(banners[0].textContent, /older index/);
    });
  });

  it('plain_chunks (legacy) renders its prose continuously with NO banner — a normal mode, not an error', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const assembly = fileAssembly({
        assemblyMode: 'plain_chunks',
        segments: [
          { kind: 'prose', chunkIndex: 0, nodeType: null, text: 'Legacy first.' },
          { kind: 'prose', chunkIndex: 1, nodeType: null, text: 'Legacy second.' },
        ],
      });
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, { '/assembly?': assembly });
      await openFileView('my-docs', 'old.md');
      assert.equal(document.querySelectorAll('.assembly-warning').length, 0);
      const docText = document.querySelector('.assembly-doc').textContent;
      assert.match(docText, /Legacy first\./);
      assert.match(docText, /Legacy second\./);
    });
  });

  it('a real empty section (200, segments: []) shows the clean empty state with an Open file action', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let fileOpened = null;
      const { document, openSectionView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': (url) => {
          const scope = new URL(url, 'http://x').searchParams.get('scope');
          if (scope === 'section') return sectionAssembly({ segments: [] });
          fileOpened = new URL(url, 'http://x').searchParams.get('sourceFile');
          return fileAssembly();
        },
      });
      await openSectionView('my-docs', { nodePath: 'guide.md#empty', nodeType: 'section', sourceFile: 'guide.md' });
      assert.match(document.querySelector('#collection-content').textContent, /This section has no indexed content\./);
      const btn = document.querySelector('#section-open-file-start');
      assert.ok(btn, 'the Open file action renders when sourceFile is known');
      btn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(fileOpened, 'guide.md', 'the action opens the containing file');
    });
  });
});

describe('document reader — search/reader mutual exclusion and module boundaries', () => {
  it('openFileView still clears #search-results/#search-status (single content surface)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, openFileView } = loadFileViewBehaviorHelpers(html, {
        '/assembly?': fileAssembly(),
      });
      assert.notEqual(document.querySelector('#search-results').innerHTML, '');
      await openFileView('my-docs', 'guide.md');
      assert.equal(document.querySelector('#search-results').innerHTML, '');
      assert.equal(document.querySelector('#search-status').innerHTML, '');
    });
  });

  it('assembly-view.js consumes only the Local API contract — it never imports backend/core assembly modules', () => {
    const src = readUiSource('assembly-view.js');
    assert.doesNotMatch(src, /core\/assembly|core\/entity-reference|\.\.\/\.\.\//,
      'browser code must not import backend/core modules');
    assert.match(src, /from '\.\/structural-renderer\.js'/, 'entities go through the one shared structural renderer');
  });

  it('the mode switch never touches the route/history (presentation-only)', () => {
    const src = readUiSource('file-view.js');
    const setModeFn = src.slice(src.indexOf('export async function setReaderMode'), src.indexOf('\n}', src.indexOf('export async function setReaderMode')));
    assert.doesNotMatch(setModeFn, /location\.hash|pushState|replaceState/,
      'switching Document/Chunks must not create a route/history entry');
  });
});
