// Tests for src/admin/ui-src/search.js. Behavior of /api/search itself is
// covered in search.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, loadSearchRenderHelpers, withServer } from './ui-test-helpers.js';

describe('search this collection (ui-src/search.js source)', () => {
  it('search.js posts to /api/search and file-view.js wires the panel container', () => {
    const js = readUiSource('search.js');
    assert.match(js, /apiPost\(["']\/api\/search["']/, 'search must call POST /api/search');
    assert.match(js, /windowFormat/, 'search must send windowFormat');
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

  it('defaults the window format to full, not compact', () => {
    const js = readUiSource('search.js');
    assert.match(js, /data-v="full" class="on"/, 'full must be the default-selected segmented option');
    assert.ok(!/data-v="compact" class="on"/.test(js), 'compact must not be the default');
  });

  it('defaults the score display to off (an advanced/debug opt-in, not shown by default)', () => {
    const js = readUiSource('search.js');
    const checkboxTag = js.slice(js.indexOf('id="q-show-score"') - 40, js.indexOf('id="q-show-score"') + 30);
    assert.ok(!/\bchecked\b/.test(checkboxTag), `score checkbox must not be checked by default: ${checkboxTag}`);
  });

  it('hides advanced controls (window, format, score, file filter) behind a collapsible disclosure', () => {
    const js = readUiSource('search.js');
    assert.match(js, /<details class="advanced-box">/);
    assert.match(js, /<summary>Advanced<\/summary>/);
  });

  it('the default visible controls are just query, top-k, and submit', () => {
    const js = readUiSource('search.js');
    assert.match(js, /search-main-row/);
    assert.match(js, /id="q-top"/);
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
    // behavior directly: a sourceFile/text/window-snippet containing HTML
    // must render as inert text, never as a parsed element.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const card = renderResult({
        sourceFile: malicious, text: malicious, section: malicious,
        chunkIndex: 0, windowChunks: [{ chunkIndex: 1, textSnippet: malicious, isMatch: true }],
      }, 0, false);
      assert.equal(card.querySelector('.result-source').textContent, malicious);
      assert.equal(card.querySelector('.chunk-text').textContent, malicious);
      assert.equal(card.querySelectorAll('img').length, 0, 'malicious markup must never be parsed into a real element');
      assert.equal(card.querySelector('.win-text').textContent, malicious);
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
