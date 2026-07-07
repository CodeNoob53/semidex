// ── search: "Search this collection" ───────────────────────────────────────
// Default view is minimal: query + top-k + submit. Score display and the
// file-scope filter live inside a native <details> "advanced" block so a
// first-time user sees a plain search box. Admin search always sends
// window: 0 — the dashboard shows one clean matched chunk per result, not
// an MCP-style "Nearby context" window of neighboring chunks (that
// window/compact-vs-full-format UI was removed; the API still accepts a
// non-zero window for other callers, this UI just never asks for one).
import { $, esc, cloneTemplate, prefersReducedMotion } from './dom.js';
import { apiPost } from './api.js';
import { openFileView, hideCollectionContent } from './file-view.js';
import { currentRoute } from './routes.js';

let searchSourceFile = null;
let searchCollectionName = null;

// Snapshot of the last URL search-params this module itself synced to (via
// syncSearchStateFromUrl) or wrote (via updateSearchUrl) — lets
// syncSearchStateFromUrl tell "the URL's query string actually changed
// since I last looked at it" (a real back/forward navigation to a
// different search state — should restore) apart from "the query string
// is unchanged, just carried over onto a new route" (should NOT re-run a
// search and clobber a file/section view the route is explicitly asking
// to show). Reset to null on every fresh initSearchPanel() mount so the
// first sync after switching collections always applies.
let lastSyncedSearchParamsKey = null;

// Recent searches, scoped per collection (a separate localStorage key per
// name — the simplest way to keep one collection's queries from leaking
// into another's suggestions) — same dedupe-and-cap-at-8 convention as
// settings-view.js's RECENT_SOURCE_PATHS_KEY.
function recentSearchesKey(name) {
  return `semidex-admin-recent-searches:${name}`;
}

function getRecentSearches(name) {
  try {
    return JSON.parse(localStorage.getItem(recentSearchesKey(name)) ?? '[]');
  } catch { return []; }
}

function rememberRecentSearch(name, query) {
  const trimmed = query.trim();
  if (!trimmed) return;
  const recent = [trimmed, ...getRecentSearches(name).filter(q => q !== trimmed)].slice(0, 8);
  try { localStorage.setItem(recentSearchesKey(name), JSON.stringify(recent)); } catch { /* storage unavailable — non-fatal */ }
}

function renderRecentSearches(name) {
  const box = $('#q-recent');
  if (!box) return;
  const recent = getRecentSearches(name);
  if (!recent.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = recent.map(q => `<button type="button" class="mini-btn q-recent-chip">${esc(q)}</button>`).join('');
  for (const chip of box.querySelectorAll('.q-recent-chip')) {
    chip.addEventListener('click', () => {
      $('#q-input').value = chip.textContent;
      runSearch(name);
    });
  }
}

export function initSearchPanel(name) {
  searchSourceFile = null;
  searchCollectionName = name;
  lastSyncedSearchParamsKey = null;
  lastPushedQuery = null;
  const box = $('#search-panel');
  box.innerHTML = `
    <form class="search-form" id="search-form" autocomplete="off">
      <div class="search-main-row">
        <input type="text" id="q-input" class="q-input"
          placeholder="Ask a question about this collection…">
        <label class="ctl" title="Number of results to return">top
          <select id="q-top">${[3, 5, 10, 20].map(n =>
            `<option value="${n}" ${n === 5 ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <button type="submit" class="btn-amber" id="q-submit">Search</button>
      </div>
      <div class="q-recent" id="q-recent" hidden></div>
      <details class="advanced-box">
        <summary>Advanced</summary>
        <div class="search-controls">
          <label class="ctl" title="Show the retrieval rank score on each result"><input type="checkbox" id="q-show-score"> score</label>
          <span class="filter-chip" id="q-file-chip" style="display:none">
            <span class="mono" id="q-file-label"></span>
            <button type="button" id="q-file-clear" title="Clear file filter" aria-label="Clear file filter">×</button>
          </span>
        </div>
      </details>
    </form>
    <div id="search-status" class="empty">Results are retrieval evidence — real indexed chunks with scores.
      The sidebar tree is navigation only.</div>
    <div id="search-results"></div>`;

  $('#q-file-clear').addEventListener('click', () => clearSearchFile());

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(name);
  });

  updateSearchScopeLabel();
  renderRecentSearches(name);
  // Deliberately does NOT call apply/syncSearchStateFromUrl here — this
  // function only mounts the UI. Deciding whether the current route may
  // run a search (bare collection route) or must only sync form fields
  // (a file/section route, where running a search would call
  // hideCollectionContent() and hide the view the route is about to open)
  // requires knowing r.openFile/r.openNodePath, which only router.js's
  // route() has. router.js calls applySearchStateFromUrl/
  // syncSearchStateFromUrl itself, right after this mounts — including on
  // first mount, not just subsequent same-collection navigation.
}

// Permalink contract (Phase 3B): a collection route may carry
// "?q=...&top=...&file=..." on ANY collection route, including file/
// section routes (#/c/:name/f/readme.md?q=install) — currentRoute()
// (routes.js) already parses this into route.search regardless of which
// collection sub-route it's attached to. window/format are deliberately
// no longer part of normal UI state (the "Nearby context" window-chunks
// feature was removed from the admin dashboard — see search.js's window=0
// default in runSearch()) — routes.js still parses ?window=/?format= for
// backward compatibility with an old bookmarked/shared URL, but this
// module no longer reads or writes them.
//
// Split in two so file/section routes stay in sync too, without the file/
// section view getting clobbered by a re-run search:
//   - applySearchStateFromUrl(name): always updates the form fields (query/
//     top/file-filter) to match the URL — safe to call on every
//     collection-route navigation, file/section routes included, since it
//     never touches #search-results/#collection-content.
//   - syncSearchStateFromUrl(name): the above, PLUS actually runs the
//     search — reserved for bare collection routes only (called from
//     router.js). Running a search calls hideCollectionContent(), so
//     doing this on a file/section route would immediately hide the file
//     view the route is explicitly asking to show.
//
// Both are no-ops when the URL's search params haven't actually changed
// since this module last synced to or wrote them (lastSyncedSearchParamsKey)
// — otherwise a route re-render with an unchanged query string (e.g.
// route() re-running markActive()) would spuriously re-trigger a search or
// reset form fields the user is actively editing.
export function applySearchStateFromUrl(name) {
  const { search } = currentRoute();
  const key = JSON.stringify(search ?? null);
  if (key === lastSyncedSearchParamsKey) return false;
  lastSyncedSearchParamsKey = key;

  if (!search?.q) return false;
  $('#q-input').value = search.q;
  if (search.top && [3, 5, 10, 20].includes(search.top)) $('#q-top').value = String(search.top);
  if (search.sourceFile) setSearchFile(search.sourceFile);
  // The query text is already current in the URL (we just read it from
  // there) — mark it as "already pushed" so the runSearch() this triggers
  // (in syncSearchStateFromUrl) replaces this same entry instead of
  // pushing a duplicate one for a query the URL already reflects.
  lastPushedQuery = search.q;
  return true;
}

export function syncSearchStateFromUrl(name) {
  if (applySearchStateFromUrl(name)) runSearch(name);
}

// The query text of the URL entry this module last pushed (or the initial
// query.q it synced from on mount) — lets updateSearchUrl() tell "the user
// just typed/submitted a genuinely new query" (push a real history entry,
// so Back steps through prior searches one at a time) apart from "the same
// query is being re-run with a different top/file-filter, or a URL-driven
// sync is re-running the query already in the URL" (replace in place —
// pushing on every filter tweak or keystroke-adjacent re-search would
// flood history with one entry per action, not one per distinct question
// asked).
let lastPushedQuery = null;

// Writes the current query/top/file-filter into the URL — deliberately
// NOT window/format, which are no longer part of normal admin UI search
// state (see the "Nearby context" removal note above runsearch()'s
// window=0 default). Uses history.pushState for a genuinely new query
// text (so Back steps through prior searches one at a time — standard
// browser-search history UX) and history.replaceState for everything else
// (re-running the same query with a different top/file-filter, or a
// URL-driven sync re-writing the query that's already current — neither
// is "a new search" from the user's point of view, and pushing on every
// one would flood history). NOT location.hash, which would fire a
// hashchange and re-run route() recursively (this app's router listens on
// hashchange for all navigation) — both push/replace update the URL
// bar/history silently.
//
// The base path (everything before "?") is read from the current hash, not
// rebuilt as a bare "#/c/:name" — searching while a file/section is open
// (hash is "#/c/:name/f/..." or "#/c/:name/n/...") must not overwrite that
// path and silently kick the user back to the collection's search-only
// view; only the query string changes.
function updateSearchUrl(name, { query, top, sourceFile }) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('top', String(top));
  if (sourceFile) params.set('file', sourceFile);
  const qs = params.toString();
  const currentHash = location.hash || `#/c/${encodeURIComponent(name)}`;
  const base = currentHash.split('?')[0];
  const url = qs ? `${base}?${qs}` : base;
  const isNewQuery = query !== lastPushedQuery;
  history[isNewQuery ? 'pushState' : 'replaceState'](null, '', url);
  lastPushedQuery = query;
  // Re-derive through currentRoute() (not the `params` object above) so the
  // snapshot key is byte-identical to what syncSearchStateFromUrl() will
  // compute later — it folds "file" into "sourceFile", which this
  // function's own params don't do.
  lastSyncedSearchParamsKey = JSON.stringify(currentRoute().search ?? null);
}

function updateSearchScopeLabel() {
  const scope = $('#search-scope');
  if (!scope) return;
  scope.textContent = searchSourceFile
    ? `Searching in: ${searchSourceFile}`
    : `Searching in: ${searchCollectionName}`;
}

export function setSearchFile(sourceFile) {
  searchSourceFile = sourceFile;
  $('#q-file-label').textContent = sourceFile;
  $('#q-file-chip').style.display = '';
  updateSearchScopeLabel();
  $('#search-panel').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  $('#q-input').focus();
}

export function clearSearchFile() {
  searchSourceFile = null;
  $('#q-file-chip').style.display = 'none';
  updateSearchScopeLabel();
}

export async function runSearch(name) {
  const status = $('#search-status');
  const resultsBox = $('#search-results');
  const submit = $('#q-submit');

  const query = $('#q-input').value.trim();
  if (!query) {
    status.className = 'error-box';
    status.textContent = 'Enter a query first.';
    return;
  }

  const top = Number($('#q-top').value);
  const showScore = $('#q-show-score').checked;

  // Admin dashboard search is ranked-hits evidence, not an MCP-style
  // context-window view — window is always 0 here (the API/adapter still
  // supports a non-zero window for other callers, e.g. the MCP tool; this
  // UI simply never asks for one). See tpl-search-result's absence of any
  // "Nearby context"/windowChunks rendering below.
  const payload = { collection: name, query, top, window: 0 };
  if (searchSourceFile) payload.sourceFile = searchSourceFile;

  updateSearchUrl(name, { query, top, sourceFile: searchSourceFile });

  submit.disabled = true;
  status.className = 'empty';
  status.textContent = 'searching…';
  resultsBox.innerHTML = '';
  hideCollectionContent();

  try {
    const body = await apiPost('/api/search', payload);
    // Only remember a query once its request has actually succeeded — a
    // failed/errored search (network error, 500, etc.) must not pollute
    // the recent-searches list with a query that never actually returned
    // evidence to the user.
    rememberRecentSearch(name, query);
    renderRecentSearches(name);
    $('#search-mode').textContent = body.searchMode ? `mode: ${body.searchMode}` : '';
    if (!body.results.length) {
      status.textContent = searchSourceFile
        ? 'No results in the filtered file — try clearing the file filter.'
        : 'No results for this query.';
      return;
    }
    status.textContent = `${body.results.length} result${body.results.length > 1 ? 's' : ''}`
      + (searchSourceFile ? ` · filtered to one file` : '');
    // Bar width is normalized against the top-ranked result's own score,
    // never an absolute confidence reading — results already arrive
    // rank-sorted, so body.results[0] is always the top score.
    const topScore = body.results[0]?.score;
    resultsBox.replaceChildren(...body.results.map((r, i) => renderResult(r, i, showScore, topScore)));
    for (const btn of resultsBox.querySelectorAll('.result-open')) {
      btn.addEventListener('click', () =>
        openFileView(name, btn.dataset.sf, null, Number(btn.dataset.ci)));
    }
  } catch (err) {
    status.className = 'error-box';
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

// Builds a result-card element from the tpl-search-result template — all
// user/API content (source file, section, score, chunk text) is filled via
// textContent/dataset, never string-concatenated into markup. Returns the
// element (not an HTML string) so callers append it directly instead of
// round-tripping through innerHTML.
//
// Deliberately does NOT render r.windowChunks — the admin dashboard shows
// clean ranked hits (rank/score/source/chunk-index/section/node-type/
// context/matched text/open), not an MCP-style "Nearby context" window.
// The API may still return windowChunks (runSearch() always sends
// window: 0, so in practice the field is absent/empty), but even if a
// caller passed a non-zero window somehow, this function ignores it.
export function renderResult(r, i, showScore, topScore) {
  const canOpen = r.sourceFile && Number.isInteger(r.chunkIndex);
  const frag = cloneTemplate('tpl-search-result');
  const card = frag.querySelector('.result-card');

  card.querySelector('.rank').textContent = `#${i + 1}`;

  const scoreEl = card.querySelector('.score');
  if (showScore && typeof r.score === 'number') {
    scoreEl.textContent = r.score.toFixed(4);
    scoreEl.hidden = false;

    if (typeof topScore === 'number' && topScore > 0) {
      const barEl = card.querySelector('.score-bar');
      const fillEl = card.querySelector('.score-bar-fill');
      fillEl.style.width = `${Math.max(0, Math.min(100, (r.score / topScore) * 100))}%`;
      barEl.hidden = false;
    }
  }

  card.querySelector('.result-source').textContent = r.sourceFile ?? '?';
  card.querySelector('.result-chunk-index').textContent =
    `chunk ${r.chunkIndex ?? '?'}${r.totalChunks ? ` / ${r.totalChunks}` : ''}`;
  card.querySelector('.result-section').textContent = r.section || 'intro';

  const nodeTypeEl = card.querySelector('.result-node-type');
  if (r.nodeType) {
    nodeTypeEl.textContent = r.nodeType;
    nodeTypeEl.hidden = false;
  }

  const openBtn = card.querySelector('.result-open');
  if (canOpen) {
    openBtn.dataset.sf = r.sourceFile;
    openBtn.dataset.ci = String(r.chunkIndex);
    openBtn.hidden = false;
  }

  const contextEl = card.querySelector('.chunk-context');
  if (r.context) {
    contextEl.textContent = r.context;
    contextEl.hidden = false;
  }

  card.querySelector('.chunk-text').textContent = r.text ?? '';

  return card;
}
