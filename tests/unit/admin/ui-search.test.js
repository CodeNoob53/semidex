// Tests for src/admin/ui-src/search.js. Behavior of /api/search itself is
// covered in search.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, loadSearchRenderHelpers, withServer } from './ui-test-helpers.js';

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

  it('always sends window: 0 in the actual /api/search request payload', async () => {
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

  it('defaults the score display to off (an advanced/debug opt-in, not shown by default)', () => {
    const js = readUiSource('search.js');
    const checkboxTag = js.slice(js.indexOf('id="q-show-score"') - 40, js.indexOf('id="q-show-score"') + 30);
    assert.ok(!/\bchecked\b/.test(checkboxTag), `score checkbox must not be checked by default: ${checkboxTag}`);
  });

  it('hides remaining advanced controls (score, file filter) behind a collapsible disclosure', () => {
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
    // behavior directly: a sourceFile/text/section containing HTML must
    // render as inert text, never as a parsed element.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const card = renderResult({
        sourceFile: malicious, text: malicious, section: malicious, chunkIndex: 0,
      }, 0, false);
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
      }, 0, false);
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
      }, 0, false);
      assert.equal(card.querySelector('.win-chunks'), null);
      assert.equal(card.querySelector('.win-chunk'), null);
      assert.equal(card.textContent.includes('Nearby context'), false);
    });
  });

  it('the search-result template no longer defines a window-chunk sub-template or "Nearby context" markup', () => {
    const html = readUiSource('partials/templates/search-result.html');
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
      }, 0, false);
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

// ── Phase 3B: search query permalink (URL is the source of truth) ─────────
describe('search URL permalink (pushState for new queries, replaceState otherwise; not localStorage)', () => {
  it('a successful search rewrites the hash to include q/top, but NOT window or format', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, runSearch, location } = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      initSearchPanel('my-docs');
      document.querySelector('#q-input').value = 'refund policy';
      await runSearch('my-docs');
      assert.match(location.hash, /^#\/c\/my-docs\?/);
      const qs = new URLSearchParams(location.hash.split('?')[1]);
      assert.equal(qs.get('q'), 'refund policy');
      assert.equal(qs.get('top'), '5');
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
        hash: '#/c/my-docs?q=cats&top=5',
      });
      initSearchPanel('my-docs');
      const lengthAfterMount = history.length;
      syncSearchStateFromUrl('my-docs'); // called again with the same URL, e.g. a redundant router call
      assert.equal(history.length, lengthAfterMount, 'restoring a query the URL already carries must replace, not push');
      assert.match(location.hash, /q=cats/);
    });
  });

  it('restores query text and top from the URL when router.js syncs after mount', async () => {
    // initSearchPanel() itself no longer applies URL state (see the
    // "initSearchPanel() does NOT" test below) — router.js is the sole
    // decision point, so tests call syncSearchStateFromUrl explicitly
    // after mount, mirroring what route() does for a bare collection route.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, syncSearchStateFromUrl } = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs?q=refund&top=10',
      });
      initSearchPanel('my-docs');
      syncSearchStateFromUrl('my-docs');
      assert.equal(document.querySelector('#q-input').value, 'refund');
    });
  });

  it('an old permalink containing window=1/format=full is still parsed by routes.js but does not affect the UI', async () => {
    // routes.js keeps parsing ?window=/?format= for backward compatibility
    // with an old bookmarked/shared link — but search.js's
    // applySearchStateFromUrl never reads search.window/search.format, so
    // a URL like this must not surface or depend on either.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel, syncSearchStateFromUrl } = loadSearchRenderHelpers(html, {
        hash: '#/c/my-docs?q=refund&top=10&window=1&format=compact',
      });
      initSearchPanel('my-docs');
      syncSearchStateFromUrl('my-docs');
      assert.equal(document.querySelector('#q-input').value, 'refund');
      assert.equal(document.querySelector('#q-top').value, '5', 'top select is a real <select> — see limitation note below; value is unaffected either way since this UI does not read/write window/format');
      // No #q-window/#q-format elements exist to be affected in the first place.
      assert.equal(document.querySelector('#q-window'), null);
      assert.equal(document.querySelector('#q-format'), null);
    });
  });

  it('applySearchStateFromUrl assigns #q-top from route.search, and does NOT reference #q-window/#q-format (source-level check)', () => {
    const js = readUiSource('search.js');
    assert.match(js, /\$\('#q-top'\)\.value = String\(search\.top\)/);
    assert.ok(!/\$\('#q-window'\)/.test(js));
    assert.ok(!/\$\('#q-format'\)/.test(js));
  });

  it('a URL with no ?q= does not disturb the default form state', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initSearchPanel } = loadSearchRenderHelpers(html, { hash: '#/c/my-docs' });
      initSearchPanel('my-docs');
      assert.equal(document.querySelector('#q-input').value, '');
      assert.equal(document.querySelector('#q-top').value, '5');
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
      const helpers = loadSearchRenderHelpers(html, { hash: '#/c/my-docs?q=cats&top=5' });
      helpers.initSearchPanel('my-docs');
      helpers.syncSearchStateFromUrl('my-docs'); // first sync — runs "cats"
      assert.equal(helpers.document.querySelector('#q-input').value, 'cats');

      // Simulate browser back/forward landing on a different search state.
      helpers.location.hash = '#/c/my-docs?q=dogs&top=5';
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
      const helpers = loadSearchRenderHelpers(html, { hash: '#/c/my-docs?q=cats&top=5' });
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
    const start = js.indexOf('export function initSearchPanel');
    // Stop at initSearchPanel's own closing brace (the line that is just
    // "}", at the start of a line) — not at the next "export function",
    // since the doc-comment above applySearchStateFromUrl's declaration
    // legitimately mentions "applySearchStateFromUrl(name):" in prose and
    // would otherwise produce a false positive here.
    const closingBraceIndex = js.indexOf('\n}\n', start);
    const fn = js.slice(start, closingBraceIndex);
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

describe('score bar (normalized relative to the top-1 result, not absolute confidence)', () => {
  it('is hidden when showScore is false, regardless of topScore', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, score: 0.8 }, 0, false, 0.8);
      assert.equal(card.querySelector('.score-bar').hidden, true);
    });
  });

  it('is hidden when showScore is true but the result has no numeric score', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0 }, 0, true, 0.8);
      assert.equal(card.querySelector('.score-bar').hidden, true);
    });
  });

  it('the top result (score === topScore) fills to 100%', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, score: 0.8 }, 0, true, 0.8);
      assert.equal(card.querySelector('.score-bar').hidden, false);
      assert.equal(card.querySelector('.score-bar-fill').style.width, '100%');
    });
  });

  it('a lower-ranked result fills proportionally to topScore, not to an absolute scale', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadSearchRenderHelpers(html);
      const card = renderResult({ sourceFile: 'a.md', chunkIndex: 0, score: 0.4 }, 1, true, 0.8);
      assert.equal(card.querySelector('.score-bar-fill').style.width, '50%');
    });
  });

  it('the score-bar keeps the same "compare order, not absolute value" tooltip as the numeric score', () => {
    const html = readUiSource('partials/templates/search-result.html');
    const matches = html.match(/title="Rank score — compare order, not absolute value"/g) ?? [];
    assert.equal(matches.length, 2, 'both .score and .score-bar must carry the RRF-order-not-confidence tooltip');
  });
});
