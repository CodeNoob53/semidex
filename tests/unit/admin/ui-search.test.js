// Tests for src/admin/ui-src/search.js. Behavior of /api/search itself is
// covered in search.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { readUiSource, loadSearchRenderHelpers, withServer } from './ui-test-helpers.js';
import { renderChunkContent } from '../../../src/shared/admin/ui-src/structural-renderer.js';

describe('search this collection (ui-src/search.js source)', () => {
  it('search.js posts to /api/search and file-view.js wires the panel container', () => {
    const js = readUiSource('search.js');
    assert.match(js, /apiPost\(["']\/api\/search["']/, 'search must call POST /api/search');
    assert.match(js, /sourceFile/, 'search must support the file filter');
    // "search-panel" is the DOM target search.js writes into — collection-view.js's
    // renderCollection() is what mounts the collection shell containing it.
    assert.match(js, /search-panel/, 'search must render into the search panel container');
  });

  it('is labeled "Search this collection", not "Search playground"', () => {
    const js = readUiSource('search.js');
    assert.match(js, /Search this collection/);
    assert.ok(!/Search playground/.test(js), 'old "Search playground" label must not remain');
  });

  it('always sends window: 0 and the fixed fetch-limit top in the actual /api/search request payload', async () => {
    // Behavioral, not source-regex — a source-text match on "window: 0"
    // could false-pass against an explanatory comment elsewhere in the
    // file, so this captures the real payload runSearch() sends.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let capturedPayload = null;
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async (_path, payload) => { capturedPayload = payload; return { results: [] }; },
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'refund policy';
      await helpers.runSearch('my-docs');
      assert.ok(capturedPayload, 'apiPost must have been called');
      assert.equal(capturedPayload.window, 0, `default admin search request must use window: 0, got ${capturedPayload.window}`);
      // 20 is the backend's own TOP_MAX cap (src/admin/api/search.js) — a
      // request for anything above it would be rejected outright, so the
      // UI's fixed fetch limit must sit exactly at that cap, not "20 or 25".
      assert.equal(capturedPayload.top, 20, 'the UI must fetch the backend\'s max allowed top in one request, not repeatedly re-search with an increasing top');
    });
  });

  it('does not read from a #q-window control (source-level check — no such control exists anymore)', () => {
    const js = readUiSource('search.js');
    assert.ok(!/\$\('#q-window'\)/.test(js), 'no #q-window control should be read anymore');
  });

  it('does not render the window/compact-full format control in the UI at all', () => {
    const js = readUiSource('search.js');
    assert.ok(!/id="q-window"/.test(js), 'the window <select> must not be in the mounted markup');
    assert.ok(!/id="q-format"/.test(js), 'the compact/full segmented control must not be in the mounted markup');
  });

  it('no longer renders a visible TOP selector', () => {
    const js = readUiSource('search.js');
    assert.ok(!/id="q-top"/.test(js), 'the #q-top <select> must not exist in the mounted markup anymore');
  });

  it('no longer renders an Advanced disclosure or a score opt-in checkbox', () => {
    const js = readUiSource('search.js');
    assert.ok(!/<details class="advanced-box">/.test(js), 'the Advanced disclosure must be removed');
    assert.ok(!/<summary>Advanced<\/summary>/.test(js), 'the Advanced disclosure must be removed');
    assert.ok(!/id="q-show-score"/.test(js), 'the score opt-in checkbox must be removed — score shows by default now');
  });

  it('the default visible controls are exactly query input and Search button', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel } = loadSearchRenderHelpers(html);
      initSearchPanel('my-docs');
      const mainRow = document.querySelector('.search-main-row');
      assert.ok(mainRow.querySelector('#q-input'), 'query input must be present');
      assert.ok(mainRow.querySelector('#q-submit'), 'Search button must be present');
      // Nothing else lives in the always-visible main row — no top-k
      // select, no score checkbox, no manual file-path input.
      assert.equal(mainRow.querySelectorAll('select').length, 0, 'no <select> control in the main row');
      assert.equal(mainRow.querySelectorAll('input[type="checkbox"]').length, 0, 'no checkbox in the main row');
    });
  });

  it('a source-file filter is internal state with a clearable chip, not a manual text input', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, setSearchFile } = loadSearchRenderHelpers(html);
      initSearchPanel('my-docs');
      // Before setSearchFile() is ever called, the chip must be hidden and
      // there must be no free-text input for a source file anywhere.
      assert.equal(document.querySelectorAll('input[type="text"]').length, 1, 'only the query input, no manual file-path input');
      setSearchFile('readme.md');
      assert.equal(document.querySelector('#q-file-chip').style.display, '', 'the chip becomes visible once a file scope is set programmatically');
      assert.equal(document.querySelector('#q-file-label').textContent, 'readme.md');
      assert.ok(document.querySelector('#q-file-clear'), 'the chip must still be clearable');
    });
  });

  it('search.js keeps evidence-vs-navigation copy', () => {
    const js = readUiSource('search.js');
    assert.match(js, /retrieval evidence/i, 'results must be framed as evidence');
    assert.match(js, /navigation only/i, 'sidebar tree must be framed as navigation');
  });

  it('still calls hideCollectionContent() before rendering results (mutual-exclusion regression guard)', () => {
    // Companion to file-view.js's hideSearchResults() — the two calls
    // together are what keep main to one content surface at a time
    // (Phase 3A). This guards runSearch() from silently losing its half of
    // that pair in a future edit.
    const js = readUiSource('search.js');
    assert.match(js, /hideCollectionContent\(\)/, 'runSearch must still hide the file/section panel before showing results');
  });

  it('search result rendering never lets API/user content become live markup (XSS-safe by construction)', async () => {
    // renderResult() fills result fields via textContent, not innerHTML/string
    // concatenation — this is a stronger guarantee than esc()+innerHTML
    // (there is no escaping step to forget), so this test proves the
    // behavior directly: a sourceFile/text/section containing HTML must
    // render as inert text, never as a parsed element.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const card = renderResult({
        sourceFile: malicious, text: malicious, section: malicious, chunkIndex: 0,
      }, 0);
      assert.equal(card.querySelector('.result-source').textContent, malicious);
      assert.equal(card.querySelector('.chunk-text').textContent, malicious);
      assert.equal(card.querySelectorAll('img').length, 0, 'malicious markup must never be parsed into a real element');
    });
  });
});

// ── Result card content: clean ranked hits, no window-chunk noise ──────────
describe('search result cards show only the matched chunk (no windowChunks rendering)', () => {
  it('a result with windowChunks attached (e.g. a stale/legacy API response) still renders only the matched text once', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({
        sourceFile: 'readme.md', chunkIndex: 5, text: 'the matched chunk text',
        // Even if the API response carried windowChunks (e.g. a caller that
        // passed a non-zero window), the admin UI must not render them —
        // requirement: no windowChunks rendering in normal search cards.
        windowChunks: [
          { chunkIndex: 4, text: 'chunk before', isMatch: false },
          { chunkIndex: 5, text: 'the matched chunk text', isMatch: true },
          { chunkIndex: 6, text: 'chunk after', isMatch: false },
        ],
      }, 0);
      const occurrences = card.textContent.split('the matched chunk text').length - 1;
      assert.equal(occurrences, 1, `matched text must appear exactly once in the card, found ${occurrences} times`);
      assert.equal(card.querySelector('.chunk-text').textContent, 'the matched chunk text');
      assert.equal(card.textContent.includes('chunk before'), false, 'no neighbor/context text must render');
      assert.equal(card.textContent.includes('chunk after'), false, 'no neighbor/context text must render');
    });
  });

  it('there is no "Nearby context" block, .win-chunks, or .win-chunk element anywhere in a rendered card', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({
        sourceFile: 'readme.md', chunkIndex: 5, text: 'matched',
        windowChunks: [{ chunkIndex: 4, text: 'before', isMatch: false }],
      }, 0);
      assert.equal(Boolean(card.querySelector('.win-chunks')), false);
      assert.equal(Boolean(card.querySelector('.win-chunk')), false);
      assert.equal(card.textContent.includes('Nearby context'), false);
    });
  });

  it('the search-result template no longer defines a window-chunk sub-template or "Nearby context" markup', () => {
    const html = readUiSource('partials/shared/templates/search-result.html');
    assert.ok(!/tpl-window-chunk/.test(html), 'the window-chunk template must be removed entirely');
    assert.ok(!/win-chunks/.test(html), 'no win-chunks container must remain in the template');
    assert.ok(!/Nearby context/.test(html), 'no "Nearby context" label must remain in the template');
  });

  it('a result card contains exactly the required fields: rank, source, chunk index, section, matched text, open button', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({
        sourceFile: 'readme.md', chunkIndex: 3, totalChunks: 10, section: 'Introduction',
        nodeType: 'paragraph', context: 'some context', text: 'the matched text',
      }, 0);
      assert.equal(card.querySelector('.rank').textContent, '#1');
      assert.equal(card.querySelector('.result-source').textContent, 'readme.md');
      assert.equal(card.querySelector('.result-chunk-index').textContent, 'chunk 3 / 10');
      assert.equal(card.querySelector('.result-section').textContent, 'Introduction');
      assert.equal(card.querySelector('.result-node-type').hidden, false);
      assert.equal(card.querySelector('.result-node-type').textContent, 'paragraph');
      assert.equal(card.querySelector('.chunk-context').hidden, false);
      assert.equal(card.querySelector('.chunk-context').textContent, 'some context');
      assert.equal(card.querySelector('.chunk-text').textContent, 'the matched text');
      assert.equal(card.querySelector('.result-open').hidden, false);
      assert.equal(card.querySelector('.result-open').textContent, 'Open file section',
        'a plain prose hit opens as part of its file section, not an isolated chunk');
    });
  });
});

// ── Phase 3O: search results read as evidence, not a raw debug dump ────────
describe('search result cards — evidence layout (Phase 3O)', () => {
  it('does not show context as a second equally-weighted block when its words already appear in the evidence text', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({
        sourceFile: 'readme.md', chunkIndex: 0, nodeType: 'paragraph',
        context: 'Setup', text: 'Setup: run npm install before starting the server.',
      }, 0);
      assert.equal(card.querySelector('.chunk-context').hidden, true,
        'context whose words already appear in the evidence text must not be duplicated as its own block');
      assert.equal(card.querySelector('.chunk-text').textContent, 'Setup: run npm install before starting the server.');
    });
  });

  it('still shows context as a lead-in when it adds real information the evidence text does not already state', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({
        sourceFile: 'readme.md', chunkIndex: 0, nodeType: 'paragraph',
        context: 'Deployment › Docker › Production config', text: 'Set NODE_ENV=production before building the image.',
      }, 0);
      assert.equal(card.querySelector('.chunk-context').hidden, false,
        'a real breadcrumb/lead-in with information not in the evidence text must still render');
      assert.equal(card.querySelector('.chunk-context').textContent, 'Deployment › Docker › Production config');
    });
  });

  it('does not show an empty/whitespace-only context as a block at all', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, context: '   ', text: 'some evidence' }, 0);
      assert.equal(card.querySelector('.chunk-context').hidden, true);
    });
  });

  it('a table hit shows a "table evidence" structural hint distinct from the node-type badge', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, nodeType: 'table', text: '| a | b |\n|---|---|\n| 1 | 2 |' }, 0);
      const hint = card.querySelector('.result-structural-hint');
      assert.equal(hint.hidden, false);
      assert.equal(hint.textContent, 'table evidence');
      assert.equal(card.querySelector('.result-open').textContent, 'Open chunk',
        'a structural hit is one specific excerpt, not part of a larger prose section');
    });
  });

  it('a code_block hit shows a "code evidence" structural hint', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, nodeType: 'code_block', text: 'const x = 1;' }, 0);
      assert.equal(card.querySelector('.result-structural-hint').textContent, 'code evidence');
    });
  });

  it('a checklist hit shows a "checklist evidence" structural hint', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, nodeType: 'checklist', text: '- [ ] todo' }, 0);
      assert.equal(card.querySelector('.result-structural-hint').textContent, 'checklist evidence');
    });
  });

  it('a plain prose hit (paragraph) never shows the structural evidence hint', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, nodeType: 'paragraph', text: 'just prose' }, 0);
      assert.equal(card.querySelector('.result-structural-hint').hidden, true);
    });
  });

  it('score/score-bar sit in the secondary meta row, not the primary identity row', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, score: 0.5 }, 0, 0.5);
      const primaryRow = card.querySelector('.result-primary');
      const metaRow = card.querySelector('.result-meta');
      assert.equal(Boolean(primaryRow.querySelector('.score')), false, 'score must not appear in the primary identity row');
      assert.equal(Boolean(primaryRow.querySelector('.score-bar')), false, 'score-bar must not appear in the primary identity row');
      assert.ok(metaRow.querySelector('.score'), 'score belongs in the secondary meta row');
      assert.ok(metaRow.querySelector('.score-bar'), 'score-bar belongs in the secondary meta row');
    });
  });

  it('the rank/source/section/node-type/open-button all sit in the primary identity row', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, section: 'Intro', nodeType: 'paragraph' }, 0);
      const primaryRow = card.querySelector('.result-primary');
      assert.ok(primaryRow.querySelector('.rank'));
      assert.ok(primaryRow.querySelector('.result-source'));
      assert.ok(primaryRow.querySelector('.result-section'));
      assert.ok(primaryRow.querySelector('.result-node-type'));
      assert.ok(primaryRow.querySelector('.result-open'));
    });
  });

  it('rendering never lets raw table/code markdown inject HTML — a malicious cell renders as inert text, never a real element (Phase 3T)', async () => {
    // Phase 3T: table chunks now render as a real <table> via
    // structural-renderer.js (see ui-structural-renderer.test.js for full
    // coverage) — this card-level test only re-confirms the search-card
    // integration still carries the same security property the old plain-
    // text-only rendering had, not the specific (now superseded) plain-
    // <pre>-with-raw-textContent shape.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html, { renderChunkContentImpl: renderChunkContent });
      const maliciousLookingMarkdown = '| <img src=x onerror=alert(1)> | b |\n|---|---|';
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, nodeType: 'table', text: maliciousLookingMarkdown }, 0);
      assert.equal(card.querySelectorAll('img').length, 0, 'raw table markdown must never be parsed into a real element');
      assert.ok(card.querySelector('.structural-render-root'), 'a table chunk renders through the shared structural renderer');
    });
  });
});

describe('search empty-state copy is actionable, not a dead end (Phase 3O)', () => {
  it('a query with zero results suggests trying different wording or a different scope', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, runSearch } = loadSearchRenderHelpers(html, {
        apiPostImpl: async () => ({ results: [] }),
      });
      initSearchPanel('my-docs');
      document.getElementById('q-input').value = 'nonexistent thing';
      await runSearch('my-docs');
      const text = document.getElementById('search-status').textContent;
      assert.match(text, /No results/);
      assert.match(text, /different wording|different file|collection/i,
        'the empty state must suggest a concrete next step, not just report absence');
      assert.doesNotMatch(text, /HTTP \d|undefined|null|Error:/i, 'must not read like a technical/debug message');
    });
  });
});

describe('search scope label ("Searching in: ...")', () => {
  it('initSearchPanel() sets the scope label to the collection name', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel } = loadSearchRenderHelpers(html);
      initSearchPanel('my-docs');
      assert.equal(document.querySelector('#search-scope').textContent, 'Searching in: my-docs');
    });
  });

  it('setSearchFile() narrows the scope label to the file, clearSearchFile() restores the collection scope', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, setSearchFile, clearSearchFile } = loadSearchRenderHelpers(html);
      initSearchPanel('my-docs');
      setSearchFile('readme.md');
      assert.equal(document.querySelector('#search-scope').textContent, 'Searching in: readme.md');
      clearSearchFile();
      assert.equal(document.querySelector('#search-scope').textContent, 'Searching in: my-docs');
    });
  });
});

// ── Show more: fetch once (top=20), render in batches of 5 ─────────────────
describe('"Show more" — batched rendering of an already-fetched result set', () => {
  function makeResults(count) {
    return Array.from({ length: count }, (_, i) => ({
      sourceFile: `file-${i}.md`, chunkIndex: i, score: 1 - i * 0.01, text: `text ${i}`,
    }));
  }

  it('renders only the first 5 results even when the backend returns more', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(20) }),
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');
      assert.equal(helpers.document.querySelectorAll('.result-card').length, 5,
        'only the first page (5) must be rendered initially, even though 20 were fetched');
    });
  });

  it('"Show more" is hidden when there are 5 or fewer results total', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(5) }),
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');
      assert.equal(helpers.document.querySelectorAll('.result-card').length, 5);
      assert.equal(helpers.document.querySelector('#search-show-more').hidden, true,
        '"Show more" must stay hidden when there is nothing more to reveal');
    });
  });

  it('"Show more" is visible when there are more than 5 results', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(20) }),
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');
      assert.equal(helpers.document.querySelector('#search-show-more').hidden, false);
    });
  });

  it('the first click reveals results 6–10 without re-fetching', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let fetchCount = 0;
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => { fetchCount++; return { results: makeResults(20) }; },
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');
      assert.equal(fetchCount, 1);

      helpers.document.querySelector('#search-show-more').click();
      assert.equal(helpers.document.querySelectorAll('.result-card').length, 10,
        'a single click must reveal exactly 5 more results (10 total)');
      assert.equal(fetchCount, 1, 'revealing more results must not trigger a second /api/search request');
      const sources = [...helpers.document.querySelectorAll('.result-source')].map(el => el.textContent);
      assert.deepEqual(sources, Array.from({ length: 10 }, (_, i) => `file-${i}.md`),
        'results 1-10 must be in original rank order, not re-ordered by a second fetch');
    });
  });

  it('the second click reveals results 11–15', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(20) }),
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');

      helpers.document.querySelector('#search-show-more').click();
      helpers.document.querySelector('#search-show-more').click();
      assert.equal(helpers.document.querySelectorAll('.result-card').length, 15);
      assert.equal(helpers.document.querySelector('#search-show-more').hidden, false,
        '5 more (of the fetched 20) remain, so the button must still be visible');
    });
  });

  it('"Show more" disappears once all fetched results are visible, even mid-batch', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        // 7 results: first click shows 5, second click should reveal the
        // remaining 2 (not a full 5) and hide the button — there is nothing
        // left after that, even though 7 isn't a clean multiple of 5.
        apiPostImpl: async () => ({ results: makeResults(7) }),
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');
      assert.equal(helpers.document.querySelectorAll('.result-card').length, 5);
      assert.equal(helpers.document.querySelector('#search-show-more').hidden, false);

      helpers.document.querySelector('#search-show-more').click();
      assert.equal(helpers.document.querySelectorAll('.result-card').length, 7,
        'the final click must reveal only the remaining 2, not overshoot');
      assert.equal(helpers.document.querySelector('#search-show-more').hidden, true,
        '"Show more" must disappear once every fetched result is visible');
    });
  });

  it('a fresh search resets the visible count back to 5 and re-hides/re-shows "Show more" as appropriate', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(20) }),
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'first query';
      await helpers.runSearch('my-docs');
      helpers.document.querySelector('#search-show-more').click();
      assert.equal(helpers.document.querySelectorAll('.result-card').length, 10);

      helpers.document.querySelector('#q-input').value = 'second query';
      await helpers.runSearch('my-docs');
      assert.equal(helpers.document.querySelectorAll('.result-card').length, 5,
        'a new search must reset back to the first page, not keep the previous expanded count');
    });
  });

  it('open buttons on results revealed by "Show more" are wired the same as the first page', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let openedWith = null;
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(10) }),
        openFileViewImpl: (name, sf, nodePath, ci) => { openedWith = { name, sf, ci }; },
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');
      helpers.document.querySelector('#search-show-more').click();

      const cards = helpers.document.querySelectorAll('.result-card');
      cards[9].querySelector('.result-open').click();
      assert.ok(openedWith, 'the open button on a "Show more"-revealed card must be wired');
      assert.equal(openedWith.sf, 'file-9.md');
      assert.equal(openedWith.ci, 9);
    });
  });

  // ── Phase 3R: opening a search result must keep the sidebar's active-row
  // highlight in sync, the same way a direct sidebar click already does (via
  // location.hash -> hashchange -> route() -> markActive()). Before this
  // fix, the "Open chunk"/"Open file section" button called openFileView()
  // directly with no hash update at all, so markActive() never ran and the
  // sidebar silently went stale the moment a search result was opened.
  it('clicking a result\'s open button updates the URL hash to the file route and calls markActive()', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let markActiveCalled = 0;
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(3) }),
        markActiveImpl: () => { markActiveCalled += 1; },
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');

      helpers.document.querySelectorAll('.result-card')[0].querySelector('.result-open').click();
      // openResultInFileView is async (it awaits revealSidebarPath before
      // calling markActive) but the click handler itself doesn't await it —
      // same fire-and-forget shape as every other DOM event handler in this
      // codebase — so the hash update (synchronous, happens first) can be
      // asserted immediately, but markActive (after the awaited stub) needs
      // a microtask flush first.
      assert.equal(helpers.location.hash, `#/c/my-docs/f/${encodeURIComponent('file-0.md')}`,
        'the hash must update to the file route so back/forward and a page refresh land on the same open file');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(markActiveCalled, 1, 'markActive() must be called so the sidebar highlight reflects the newly-opened file');
    });
  });

  it('opening a search result does not push a duplicate/extra history entry beyond the one file-route entry', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(2) }),
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');
      const before = helpers.history.length;

      helpers.document.querySelectorAll('.result-card')[0].querySelector('.result-open').click();

      assert.equal(helpers.history.length, before + 1, 'opening a result must push exactly one history entry, not zero and not several');
    });
  });

  it('the status line shows "Showing 5 of 20 results" when more are available, not just the fetched total', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(20) }),
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');
      assert.equal(helpers.document.querySelector('#search-status').textContent, 'Showing 5 of 20 results',
        'the status text must match what is actually visible, not silently overclaim the full fetched count');
    });
  });

  it('the status line updates to "Showing 10 of 20 results" after one "Show more" click', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(20) }),
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');
      helpers.document.querySelector('#search-show-more').click();
      assert.equal(helpers.document.querySelector('#search-status').textContent, 'Showing 10 of 20 results');
    });
  });

  it('the status line drops the "Showing X of Y" wording once every fetched result is visible', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: makeResults(5) }),
      });
      helpers.initSearchPanel('my-docs');
      helpers.document.querySelector('#q-input').value = 'test';
      await helpers.runSearch('my-docs');
      assert.equal(helpers.document.querySelector('#search-status').textContent, '5 results',
        'with nothing left to reveal, the plain total is clearer than "Showing 5 of 5"');
    });
  });
});

// ── Phase 3B: search query permalink (URL is the source of truth) ─────────
describe('search URL permalink (pushState for new queries, replaceState otherwise; not localStorage)', () => {
  it('a successful search rewrites the hash to include q, but NOT top, window, or format', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, runSearch, location } = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      initSearchPanel('my-docs');
      document.querySelector('#q-input').value = 'refund policy';
      await runSearch('my-docs');
      assert.match(location.hash, /^#\/c\/my-docs\?/);
      const qs = new URLSearchParams(location.hash.split('?')[1]);
      assert.equal(qs.get('q'), 'refund policy');
      assert.equal(qs.get('top'), null, 'top is no longer user-facing state and must not be written');
      assert.equal(qs.get('window'), null, 'window must not be written as a noisy default');
      assert.equal(qs.get('format'), null, 'format must not be written as a noisy default');
    });
  });

  it('a file filter is written as &file=, separate from any open-file path segment', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, setSearchFile, runSearch, location } = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      initSearchPanel('my-docs');
      setSearchFile('readme.md');
      document.querySelector('#q-input').value = 'install';
      await runSearch('my-docs');
      const qs = new URLSearchParams(location.hash.split('?')[1]);
      assert.equal(qs.get('file'), 'readme.md');
    });
  });

  it('applySearchStateFromUrl() clears a stale file filter when the new URL carries no &file= (regression)', async () => {
    // Regression: a prior URL/search state had set searchSourceFile
    // (e.g. via a "search in this file" flow, or an earlier permalink with
    // &file=readme.md). Navigating (e.g. browser Back) to a URL with a
    // different ?q= and NO &file= must clear that stale scope — otherwise
    // the next search silently stays scoped to a file the visible UI (chip
    // gone) no longer indicates.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let capturedPayload = null;
      const helpers = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs?q=install&file=readme.md',
        apiPostImpl: async (_path, payload) => { capturedPayload = payload; return { results: [] }; },
      });
      helpers.initSearchPanel('my-docs');
      helpers.syncSearchStateFromUrl('my-docs');
      assert.equal(helpers.document.querySelector('#q-file-chip').style.display, '',
        'sanity: the file chip is visible after the first sync');

      // Simulate Back landing on a URL with a different query and no &file=.
      helpers.location.hash = '#/c/my-docs?q=dogs';
      helpers.syncSearchStateFromUrl('my-docs');
      assert.equal(helpers.document.querySelector('#q-file-chip').style.display, 'none',
        'the file chip must be hidden once the URL no longer carries &file=');
      assert.equal(capturedPayload.sourceFile, undefined,
        'the re-run search must NOT still be scoped to the stale file filter');
    });
  });

  it('applySearchStateFromUrl() syncing the file filter does not scroll or steal focus (uses the quiet setter, not setSearchFile)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, { hash: '#/c/my-docs?q=install&file=readme.md' });
      helpers.initSearchPanel('my-docs');
      let scrollCalled = false;
      helpers.document.getElementById('search-panel').scrollIntoView = () => { scrollCalled = true; };
      helpers.applySearchStateFromUrl('my-docs');
      assert.equal(scrollCalled, false, 'a URL-driven sync must not scroll the page — only a real user-initiated setSearchFile() call should');
    });
  });

  it('a genuinely new query pushes a real history entry (Back can step through prior searches)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, runSearch, history } = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      initSearchPanel('my-docs');
      const startLength = history.length;

      document.querySelector('#q-input').value = 'cats';
      await runSearch('my-docs');
      assert.equal(history.length, startLength + 1, 'the first distinct query must push a new entry');

      document.querySelector('#q-input').value = 'dogs';
      await runSearch('my-docs');
      assert.equal(history.length, startLength + 2, 'a second, different query must push another entry');
    });
  });

  it('re-running the same query does NOT push a new entry (replaces in place)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, runSearch, history } = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      initSearchPanel('my-docs');
      document.querySelector('#q-input').value = 'cats';
      await runSearch('my-docs');
      const lengthAfterFirst = history.length;

      // Same query text, just re-submitted — must not be treated as "a new
      // search" for history purposes.
      await runSearch('my-docs');
      assert.equal(history.length, lengthAfterFirst, 'an unchanged query must replace, not push');
    });
  });

  it('a URL-driven sync (back/forward landing on a query already in the URL) does not push a duplicate entry', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { initSearchPanel, history, syncSearchStateFromUrl, location } = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs?q=cats',
      });
      initSearchPanel('my-docs');
      const lengthAfterMount = history.length;
      syncSearchStateFromUrl('my-docs'); // called again with the same URL, e.g. a redundant router call
      assert.equal(history.length, lengthAfterMount, 'restoring a query the URL already carries must replace, not push');
      assert.match(location.hash, /q=cats/);
    });
  });

  it('restores query text from the URL when router.js syncs after mount', async () => {
    // initSearchPanel() itself no longer applies URL state (see the
    // "initSearchPanel() does NOT" test below) — router.js is the sole
    // decision point, so tests call syncSearchStateFromUrl explicitly
    // after mount, mirroring what route() does for a bare collection route.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, syncSearchStateFromUrl } = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs?q=refund',
      });
      initSearchPanel('my-docs');
      syncSearchStateFromUrl('my-docs');
      assert.equal(document.querySelector('#q-input').value, 'refund');
    });
  });

  it('an old permalink containing top=10/window=1/format=full is still parsed by routes.js but does not affect the UI', async () => {
    // routes.js keeps parsing ?top=/?window=/?format= for backward
    // compatibility with an old bookmarked/shared link — but search.js's
    // applySearchStateFromUrl never reads any of them, since none of them
    // are user-facing controls in this UI anymore.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, syncSearchStateFromUrl } = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs?q=refund&top=10&window=1&format=compact',
      });
      initSearchPanel('my-docs');
      syncSearchStateFromUrl('my-docs');
      assert.equal(document.querySelector('#q-input').value, 'refund');
      // No #q-top/#q-window/#q-format elements exist to be affected in the first place.
      assert.equal(Boolean(document.querySelector('#q-top')), false);
      assert.equal(Boolean(document.querySelector('#q-window')), false);
      assert.equal(Boolean(document.querySelector('#q-format')), false);
    });
  });

  it('applySearchStateFromUrl does NOT reference #q-top/#q-window/#q-format (source-level check)', () => {
    const js = readUiSource('search.js');
    assert.ok(!/\$\('#q-top'\)/.test(js));
    assert.ok(!/\$\('#q-window'\)/.test(js));
    assert.ok(!/\$\('#q-format'\)/.test(js));
  });

  it('a URL with no ?q= does not disturb the default form state', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel } = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      initSearchPanel('my-docs');
      assert.equal(document.querySelector('#q-input').value, '');
    });
  });

  it('a search run while a file/section is open preserves the /f/ or /n/ path segment, not just #/c/:name', async () => {
    // Regression test for the bug where updateSearchUrl() hardcoded the URL
    // base as "#/c/:name", discarding whatever path segment was actually
    // current — searching from an open file used to silently kick the user
    // back to the bare collection view.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, runSearch, location } = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs/f/readme.md',
      });
      initSearchPanel('my-docs');
      document.querySelector('#q-input').value = 'install steps';
      await runSearch('my-docs');
      assert.match(location.hash, /^#\/c\/my-docs\/f\/readme\.md\?/,
        'the /f/readme.md path segment must survive a search run from that view');
    });
  });

  it('a search run while a section is open preserves the /n/:nodePath segment', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, runSearch, location } = loadSearchRenderHelpers(html, {
        hash: `#/c/my-docs/n/${encodeURIComponent('readme.md#intro')}`,
      });
      initSearchPanel('my-docs');
      document.querySelector('#q-input').value = 'intro';
      await runSearch('my-docs');
      assert.match(location.hash, /^#\/c\/my-docs\/n\//);
    });
  });

  it('applySearchStateFromUrl() updates the query field from a file-route URL WITHOUT running a search', async () => {
    // The router-level fix for the file/section back-forward bug: a route
    // like #/c/my-docs/f/readme.md?q=dogs must update the search form (so
    // it's not stale if the user later clears the file view) but must NOT
    // call runSearch() — that would hideCollectionContent() and hide the
    // file view the route just opened.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, applySearchStateFromUrl, location } = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
      });
      initSearchPanel('my-docs');
      // Plant a marker in #search-results — runSearch() unconditionally
      // clears this element, so if applySearchStateFromUrl wrongly ran a
      // search, the marker would disappear.
      document.querySelector('#search-results').innerHTML = '<div id="marker"></div>';
      location.hash = '#/c/my-docs/f/readme.md?q=dogs';
      const applied = applySearchStateFromUrl('my-docs');
      assert.equal(applied, true, 'a URL carrying ?q= must report that it applied state');
      assert.equal(document.querySelector('#q-input').value, 'dogs');
      assert.ok(document.querySelector('#marker'), 'applySearchStateFromUrl must not run a search (would have cleared #search-results)');
    });
  });

  it('applySearchStateFromUrl() returns false and changes nothing when the URL search params are unchanged', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { initSearchPanel, applySearchStateFromUrl } = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs/f/readme.md?q=dogs',
      });
      initSearchPanel('my-docs');
      assert.equal(applySearchStateFromUrl('my-docs'), true, 'the first call must apply the URL state');
      assert.equal(applySearchStateFromUrl('my-docs'), false, 'a second call with the same URL must be a no-op');
    });
  });

  it('syncSearchStateFromUrl() re-runs the search when the URL search params actually change (real back/forward)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, { hash: '#/c/my-docs?q=cats' });
      helpers.initSearchPanel('my-docs');
      helpers.syncSearchStateFromUrl('my-docs'); // first sync — runs "cats"
      assert.equal(helpers.document.querySelector('#q-input').value, 'cats');

      // Simulate browser back/forward landing on a different search state.
      helpers.location.hash = '#/c/my-docs?q=dogs';
      helpers.syncSearchStateFromUrl('my-docs');
      assert.equal(helpers.document.querySelector('#q-input').value, 'dogs',
        'a real change in the URL search params must restore the new state');
    });
  });

  it('syncSearchStateFromUrl() is a no-op when called again with an unchanged URL (idempotency / no spurious re-search)', async () => {
    // runSearch() unconditionally clears #search-results at the very start
    // of every call (before the async apiPost resolves) — planting a
    // marker element there after the initial sync settles and confirming
    // it survives a second sync call is an observable proxy for "runSearch
    // was not invoked again," without needing to intercept apiPost itself
    // (which isn't reachable from outside the vm context here).
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadSearchRenderHelpers(html, { hash: '#/c/my-docs?q=cats' });
      helpers.initSearchPanel('my-docs');
      helpers.syncSearchStateFromUrl('my-docs'); // first sync — runs "cats"
      helpers.document.querySelector('#search-results').innerHTML = '<div id="marker"></div>';

      helpers.syncSearchStateFromUrl('my-docs'); // same hash, called again
      assert.ok(helpers.document.querySelector('#marker'),
        'an unchanged URL must not re-run the search (which would have cleared #search-results)');
    });
  });

  it('initSearchPanel() does NOT itself call apply/syncSearchStateFromUrl — router.js is the sole decision point', () => {
    // Regression test for the bug where initSearchPanel() called
    // syncSearchStateFromUrl() directly, which ran a search unconditionally
    // on first mount — including when the very same route also carried
    // r.openFile/r.openNodePath (e.g. #/c/my-docs/f/readme.md?q=dogs),
    // bypassing router.js's file/section-aware apply-vs-sync split and
    // firing a spurious /api/search + URL/history/recent-searches update
    // before router.js ever got to open the file view.
    const js = readUiSource('search.js');
    // Real parse (not a line-based indexOf('\n}\n', ...) scan) so extraction
    // is brace-aware and immune to line-ending style — acorn's start/end are
    // character offsets into the source, not line-based, so they land on the
    // true end of initSearchPanel whether search.js is CRLF or LF. A
    // line-based indexOf('\n}\n', start) version silently over-captured on a
    // CRLF file (no literal "\n}\n" run at a real closing brace there),
    // bleeding into later code — including the doc-comment above
    // applySearchStateFromUrl's declaration, which legitimately mentions
    // "applySearchStateFromUrl(name):" in prose and would then false-positive
    // this guard.
    const fileAst = parse(js, { sourceType: 'module', ecmaVersion: 'latest' });
    const initSearchPanelNode = fileAst.body.find((node) => {
      const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
      return decl?.type === 'FunctionDeclaration' && decl.id?.name === 'initSearchPanel';
    });
    assert.ok(initSearchPanelNode, 'initSearchPanel must be defined as a top-level exported function declaration');
    const fn = js.slice(initSearchPanelNode.start, initSearchPanelNode.end);
    // Strip line comments before checking — the function's own explanatory
    // comment mentions both names in prose ("router.js calls
    // applySearchStateFromUrl/syncSearchStateFromUrl itself"), which must
    // not itself trigger this guard.
    const fnWithoutComments = fn.replace(/\/\/.*$/gm, '');
    assert.ok(!/syncSearchStateFromUrl\(|applySearchStateFromUrl\(/.test(fnWithoutComments),
      'initSearchPanel must only mount the UI — apply/syncSearchStateFromUrl must be called by router.js, not from here');
  });
});

describe('recent searches (localStorage, scoped per collection)', () => {
  it('a failed search (API error) is NOT remembered — only a successful response counts', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers1 = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => { throw new Error('network error'); },
      });
      helpers1.initSearchPanel('my-docs');
      helpers1.document.querySelector('#q-input').value = 'refund policy';
      await helpers1.runSearch('my-docs');
      assert.equal(helpers1.document.querySelector('#search-status').textContent, 'network error');

      const helpers2 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs', storage: helpers1.localStorage });
      helpers2.initSearchPanel('my-docs');
      assert.equal(helpers2.document.querySelectorAll('.q-recent-chip').length, 0,
        'a query whose search request failed must not appear in recent searches');
    });
  });

  it('a successful search with zero results IS remembered (a valid query that returned nothing is not a failure)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers1 = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs',
        apiPostImpl: async () => ({ results: [] }),
      });
      helpers1.initSearchPanel('my-docs');
      helpers1.document.querySelector('#q-input').value = 'nothing matches this';
      await helpers1.runSearch('my-docs');

      const helpers2 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs', storage: helpers1.localStorage });
      helpers2.initSearchPanel('my-docs');
      const chips = [...helpers2.document.querySelectorAll('.q-recent-chip')].map(c => c.textContent);
      assert.deepEqual(chips, ['nothing matches this']);
    });
  });

  it('a successful search is remembered and rendered as a chip on the next mount', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers1 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      helpers1.initSearchPanel('my-docs');
      helpers1.document.querySelector('#q-input').value = 'refund policy';
      await helpers1.runSearch('my-docs');

      // Re-mount with the same storage backing (simulating navigating away
      // and back, or a fresh page load) — the chip should now appear.
      const helpers2 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs', storage: helpers1.localStorage });
      helpers2.initSearchPanel('my-docs');
      const chips = [...helpers2.document.querySelectorAll('.q-recent-chip')].map(c => c.textContent);
      assert.deepEqual(chips, ['refund policy']);
    });
  });

  it('recent searches are scoped per collection — a query in one collection does not appear in another', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers1 = loadSearchRenderHelpers(html, { hash: '#/c/collection-a' });
      helpers1.initSearchPanel('collection-a');
      helpers1.document.querySelector('#q-input').value = 'alpha query';
      await helpers1.runSearch('collection-a');

      const helpers2 = loadSearchRenderHelpers(html, { hash: '#/c/collection-b', storage: helpers1.localStorage });
      helpers2.initSearchPanel('collection-b');
      assert.equal(helpers2.document.querySelectorAll('.q-recent-chip').length, 0,
        'collection-b must not see collection-a\'s recent searches');
    });
  });

  it('an empty/whitespace-only query is never stored', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers1 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      helpers1.initSearchPanel('my-docs');
      helpers1.document.querySelector('#q-input').value = '   ';
      await helpers1.runSearch('my-docs'); // rejected by the "Enter a query first" guard before storage

      const helpers2 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs', storage: helpers1.localStorage });
      helpers2.initSearchPanel('my-docs');
      assert.equal(helpers2.document.querySelectorAll('.q-recent-chip').length, 0);
    });
  });

  it('repeating the same query text dedupes to one chip, moved to the front', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers1 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      helpers1.initSearchPanel('my-docs');
      for (const q of ['first query', 'second query', 'first query']) {
        helpers1.document.querySelector('#q-input').value = q;
        await helpers1.runSearch('my-docs');
      }
      const helpers2 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs', storage: helpers1.localStorage });
      helpers2.initSearchPanel('my-docs');
      const chips = [...helpers2.document.querySelectorAll('.q-recent-chip')].map(c => c.textContent);
      assert.deepEqual(chips, ['first query', 'second query'], 'the repeated query must move to the front, not duplicate');
    });
  });

  it('caps the list at 8 entries', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers1 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      helpers1.initSearchPanel('my-docs');
      for (let i = 0; i < 10; i++) {
        helpers1.document.querySelector('#q-input').value = `query ${i}`;
        await helpers1.runSearch('my-docs');
      }
      const helpers2 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs', storage: helpers1.localStorage });
      helpers2.initSearchPanel('my-docs');
      assert.equal(helpers2.document.querySelectorAll('.q-recent-chip').length, 8);
    });
  });

  it('clicking a recent-search chip fills the input and runs the search', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers1 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      helpers1.initSearchPanel('my-docs');
      helpers1.document.querySelector('#q-input').value = 'refund policy';
      await helpers1.runSearch('my-docs');

      const helpers2 = loadSearchRenderHelpers(html, { hash: '#/c/my-docs', storage: helpers1.localStorage });
      helpers2.initSearchPanel('my-docs');
      helpers2.document.querySelector('.q-recent-chip').click();
      assert.equal(helpers2.document.querySelector('#q-input').value, 'refund policy');
    });
  });

  it('app.css has an explicit .q-recent[hidden] override, not just an unconditional "display: flex"', () => {
    // Regression, confirmed live via Playwright: .q-recent sets
    // "display: flex" unconditionally, which overrides the browser's
    // default "[hidden] { display: none }" rule in the cascade — so
    // renderRecentSearches()'s box.hidden = true (search.js) never actually
    // hid the element. Harmless in practice here (the row has zero
    // children when hidden, collapsing to zero height anyway) but not
    // correct — same bug pattern as topbar.js's .job-chip.
    const css = readUiSource('app.css');
    assert.match(css, /\.q-recent\[hidden\]\s*\{\s*display:\s*none;?\s*\}/,
      '.q-recent must have an explicit [hidden] rule that actually hides it');
  });
});

describe('score/rank shown by default (no checkbox opt-in)', () => {
  it('a result with a numeric score shows both the numeric score and the score bar without any opt-in', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, score: 0.8 }, 0, 0.8);
      assert.equal(card.querySelector('.score').hidden, false, 'the numeric score must be shown by default');
      assert.equal(card.querySelector('.score').textContent, '0.8000');
      assert.equal(card.querySelector('.score-bar').hidden, false, 'the score bar must be shown by default');
    });
  });

  it('the rank number always renders, independent of score', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0 }, 2);
      assert.equal(card.querySelector('.rank').textContent, '#3');
    });
  });

  it('the score/score-bar stay hidden when a result genuinely has no numeric score (not an opt-in toggle, just missing data)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0 }, 0, 0.8);
      assert.equal(card.querySelector('.score').hidden, true);
      assert.equal(card.querySelector('.score-bar').hidden, true);
    });
  });

  it('the top result (score === topScore) fills to 100%', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, score: 0.8 }, 0, 0.8);
      assert.equal(card.querySelector('.score-bar').hidden, false);
      assert.equal(card.querySelector('.score-bar-fill').style.width, '100%');
    });
  });

  it('a lower-ranked result fills proportionally to topScore, not to an absolute scale', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, score: 0.4 }, 1, 0.8);
      assert.equal(card.querySelector('.score-bar-fill').style.width, '50%');
    });
  });

  it('the score-bar keeps the same "used for ranking, compare order not absolute value" tooltip as the numeric score (Phase 3O copy)', () => {
    const html = readUiSource('partials/shared/templates/search-result.html');
    const matches = html.match(/title="Used for ranking; compare order, not absolute value\."/g) ?? [];
    assert.equal(matches.length, 2, 'both .score and .score-bar must carry the RRF-order-not-confidence tooltip');
  });

  it('renderResult() no longer takes a showScore parameter (source-level check on the exported signature)', () => {
    const js = readUiSource('search.js');
    assert.match(js, /export function renderResult\(r, i, topScore\)/,
      'renderResult must be (r, i, topScore) — no showScore boolean gating it anymore');
  });
});
