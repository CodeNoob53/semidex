// ── search: "Search this collection" ───────────────────────────────────────
// Default view is deliberately just query + Search button — no visible top-k
// selector, no Advanced disclosure, no score opt-in checkbox. Rank/score is
// shown on every result by default (framed as "compare order, not absolute
// value", never hidden behind a toggle). A file-scope filter still exists as
// internal state (set via setSearchFile(), e.g. from a "search in this file"
// entry point elsewhere in the UI, or restored from an old permalink's
// &file=) and shows as a small clearable chip when active — but there is no
// manual file-path input control for a user to type into.
//
// runSearch() always fetches SEARCH_FETCH_LIMIT results in one request and
// renders them in batches of SEARCH_PAGE_SIZE via "Show more" — no repeated
// retrieval calls with an increasing top, which could reorder results if the
// index changes between clicks (see SEARCH_FETCH_LIMIT below).
//
// Admin search always sends window: 0 — the dashboard shows one clean
// matched chunk per result, not an MCP-style "Nearby context" window of
// neighboring chunks (that window/compact-vs-full-format UI was removed;
// the API still accepts a non-zero window for other callers, this UI just
// never asks for one).
import { $, esc, cloneTemplate, prefersReducedMotion } from './dom.js';
import { apiPost } from './api.js';
import { openFileView, hideCollectionContent, nodeTypeBadgeIcon, STRUCTURAL_NODE_TYPES } from './file-view.js';
import { currentRoute } from './routes.js';
import { markActive, revealSidebarPath } from './sidebar.js';
import { renderChunkContent } from './structural-renderer.js';

// The backend's /api/search caps `top` at 20 (src/admin/api/search.js's
// TOP_MAX) — this fetches that whole cap in one request so "Show more" is
// just revealing already-fetched results, never a second retrieval call.
const SEARCH_FETCH_LIMIT = 20;
const SEARCH_PAGE_SIZE = 5;

let searchSourceFile = null;
let searchCollectionName = null;
// The full fetched result set from the last successful search, and how many
// of them are currently rendered — "Show more" advances the latter without
// re-fetching. Reset on every fresh runSearch() call.
let lastSearchResults = [];
let visibleResultCount = 0;

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
  lastSearchResults = [];
  visibleResultCount = 0;
  const box = $('#search-panel');
  box.innerHTML = `
    <form class="search-form" id="search-form" autocomplete="off">
      <div class="search-main-row">
        <input type="text" id="q-input" class="q-input"
          placeholder="Ask a question about this collection…">
        <button type="submit" class="btn-amber" id="q-submit">Search</button>
      </div>
      <span class="filter-chip" id="q-file-chip" style="display:none">
        <span class="mono" id="q-file-label"></span>
        <button type="button" id="q-file-clear" title="Clear file filter" aria-label="Clear file filter">×</button>
      </span>
      <div class="q-recent" id="q-recent" hidden></div>
    </form>
    <div id="search-status" class="empty">Results are retrieval evidence — real indexed chunks with scores.
      The sidebar tree is navigation only.</div>
    <div id="search-results"></div>
    <button type="button" class="mini-btn" id="search-show-more" hidden>Show more</button>`;

  $('#q-file-clear').addEventListener('click', () => clearSearchFile());

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(name);
  });

  $('#search-show-more').addEventListener('click', () => showMoreResults(name));

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
// default in runSearch()) — routes.js still parses ?window=/?format=/?top=
// for backward compatibility with an old bookmarked/shared URL, but this
// module no longer reads or writes any of them: `top` is no longer a user-
// facing control (search always fetches SEARCH_FETCH_LIMIT results — see
// the module-level comment above), so an old permalink's &top= is simply
// ignored rather than applied to anything.
//
// Split in two so file/section routes stay in sync too, without the file/
// section view getting clobbered by a re-run search:
//   - applySearchStateFromUrl(name): always updates the form fields (query/
//     file-filter) to match the URL — safe to call on every collection-
//     route navigation, file/section routes included, since it never
//     touches #search-results/#collection-content.
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
  // Sync the file filter exactly to what the URL says — set it when the
  // URL carries &file=, but also CLEAR it when the URL doesn't, rather than
  // leaving a stale searchSourceFile from a prior state. Without the clear
  // branch, a URL that had once carried &file=readme.md and then navigated
  // (e.g. browser Back) to a query with no &file= at all left the old file
  // scope active in memory — the next search silently stayed scoped to a
  // file the visible UI no longer indicated. Uses the quiet setter (no
  // scroll/focus) since this runs on every route sync, not just a real
  // user-initiated "search in this file" click.
  if (search.sourceFile) setSearchFileQuiet(search.sourceFile);
  else clearSearchFile();
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

// Writes the current query/file-filter into the URL — deliberately NOT
// top/window/format, none of which are part of normal admin UI search state
// any more (search always fetches a fixed SEARCH_FETCH_LIMIT; see the
// "Nearby context" removal note above runSearch()'s window=0 default). Uses
// history.pushState for a genuinely new query text (so Back steps through
// prior searches one at a time — standard browser-search history UX) and
// history.replaceState for everything else (re-running the same query with
// a different file-filter, or a URL-driven sync re-writing the query that's
// already current — neither is "a new search" from the user's point of
// view, and pushing on every one would flood history). NOT location.hash,
// which would fire a hashchange and re-run route() recursively (this app's
// router listens on hashchange for all navigation) — both push/replace
// update the URL bar/history silently.
//
// The base path (everything before "?") is read from the current hash, not
// rebuilt as a bare "#/c/:name" — searching while a file/section is open
// (hash is "#/c/:name/f/..." or "#/c/:name/n/...") must not overwrite that
// path and silently kick the user back to the collection's search-only
// view; only the query string changes.
function updateSearchUrl(name, { query, sourceFile }) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
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

// Opens a search result's chunk in the file view AND keeps the sidebar tree
// in sync with what's now open (Phase 3R) — a plain sidebar click already
// gets this for free (it sets location.hash, which fires hashchange ->
// route() -> markActive()), but this "Open chunk"/"Open file section" button
// used to call openFileView() directly with no hash update at all, so the
// sidebar kept showing whichever row (if any) was active before the search,
// silently going stale the moment a user opened a result. Uses
// history.pushState (not `location.hash =`) for the same reason
// updateSearchUrl() above does: setting location.hash fires a real
// hashchange, which would re-run route() recursively and re-open this exact
// view a second time (plus clobber the search results this click is trying
// to keep visible in browser history). markActive() is called directly
// afterward instead, the same targeted sync route()'s own second
// markActive() call performs once the sidebar tree has settled.
//
// revealSidebarPath() additionally expands whatever collapsed ancestor
// directories stand between the tree root and this file (a search result
// can open a file buried several folders deep that was never clicked open
// in the sidebar) — markActive() alone only toggles .active on rows that
// already exist in the DOM, it cannot reveal a row hidden inside a
// collapsed directory. Best-effort: a flat-file-list collection (no
// skeleton) or a row that genuinely isn't found yet just leaves markActive()
// with nothing extra to highlight, same as before this fix existed.
async function openResultInFileView(name, sourceFile, chunkIndex) {
  const url = `#/c/${encodeURIComponent(name)}/f/${encodeURIComponent(sourceFile)}`;
  history.pushState(null, '', url);
  openFileView(name, sourceFile, null, chunkIndex);
  await revealSidebarPath(name, sourceFile);
  markActive();
}

function updateSearchScopeLabel() {
  const scope = $('#search-scope');
  if (!scope) return;
  scope.textContent = searchSourceFile
    ? `Searching in: ${searchSourceFile}`
    : `Searching in: ${searchCollectionName}`;
}

// Sets the chip/state only — no scroll/focus. Shared by setSearchFile()
// (a real user-initiated "search in this file" action, where jumping focus
// to the search box is the point) and applySearchStateFromUrl() (a silent
// URL restore, e.g. on every route navigation, where yanking scroll/focus
// on each sync would be disruptive and wrong).
function setSearchFileQuiet(sourceFile) {
  searchSourceFile = sourceFile;
  $('#q-file-label').textContent = sourceFile;
  $('#q-file-chip').style.display = '';
  updateSearchScopeLabel();
}

export function setSearchFile(sourceFile) {
  setSearchFileQuiet(sourceFile);
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

  // Admin dashboard search is ranked-hits evidence, not an MCP-style
  // context-window view — window is always 0 here (the API/adapter still
  // supports a non-zero window for other callers, e.g. the MCP tool; this
  // UI simply never asks for one). See tpl-search-result's absence of any
  // "Nearby context"/windowChunks rendering below. `top` is always the
  // fixed fetch cap (SEARCH_FETCH_LIMIT) — "Show more" below reveals more
  // of this same already-fetched batch, it never re-runs retrieval with a
  // larger top (which could reorder results if the index changed between
  // clicks).
  const payload = { collection: name, query, top: SEARCH_FETCH_LIMIT, window: 0 };
  if (searchSourceFile) payload.sourceFile = searchSourceFile;

  updateSearchUrl(name, { query, sourceFile: searchSourceFile });

  submit.disabled = true;
  status.className = 'empty';
  status.textContent = 'searching…';
  resultsBox.innerHTML = '';
  lastSearchResults = [];
  visibleResultCount = 0;
  $('#search-show-more').hidden = true;
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
      // Actionable, not just "nothing found" — the filtered case already
      // named its one fix (clear the file scope); the general case gets
      // the same treatment (Phase 3O) rather than a dead-end sentence.
      status.textContent = searchSourceFile
        ? 'No results in the filtered file — try clearing the file filter.'
        : 'No results for this query — try different wording, or search a different file/collection.';
      return;
    }
    lastSearchResults = body.results;
    renderVisibleResults(name, Math.min(SEARCH_PAGE_SIZE, lastSearchResults.length));
  } catch (err) {
    status.className = 'error-box';
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

// Renders lastSearchResults[0..count) into #search-results (replacing
// whatever was there), updates the status line to match what's actually on
// screen, and wires each card's "open" button — shared by the initial
// runSearch() render and showMoreResults() below so both go through the
// same render/status/wiring path (a "Show more" click must update the
// status text too — "20 results" sitting above only 5 visible cards would
// read as broken, and staying "5 of 20" forever after revealing the rest
// would be just as wrong the other way).
function renderVisibleResults(name, count) {
  const status = $('#search-status');
  const resultsBox = $('#search-results');
  visibleResultCount = count;
  const total = lastSearchResults.length;
  // Bar width is normalized against the top-ranked result's own score,
  // never an absolute confidence reading — results already arrive
  // rank-sorted, so lastSearchResults[0] is always the top score.
  const topScore = lastSearchResults[0]?.score;
  const visible = lastSearchResults.slice(0, count);
  resultsBox.replaceChildren(...visible.map((r, i) => renderResult(r, i, topScore)));
  for (const btn of resultsBox.querySelectorAll('.result-open')) {
    btn.addEventListener('click', () => openResultInFileView(name, btn.dataset.sf, Number(btn.dataset.ci)));
  }
  status.textContent = (count < total ? `Showing ${count} of ${total} results` : `${total} result${total > 1 ? 's' : ''}`)
    + (searchSourceFile ? ` · filtered to one file` : '');
  const showMoreBtn = $('#search-show-more');
  showMoreBtn.hidden = visibleResultCount >= total;
}

// "Show more" reveals the next SEARCH_PAGE_SIZE results already sitting in
// lastSearchResults — no new /api/search request, so clicking it can never
// reorder results relative to what's already on screen (see the
// SEARCH_FETCH_LIMIT/SEARCH_PAGE_SIZE module comment).
function showMoreResults(name) {
  const nextCount = Math.min(visibleResultCount + SEARCH_PAGE_SIZE, lastSearchResults.length);
  renderVisibleResults(name, nextCount);
}

// Normalizes whitespace/case for the context-vs-text similarity check below
// — "almost identical" should catch trivial formatting differences (extra
// spaces, a trailing period, case), not just byte-for-byte equality.
function normalizeForCompare(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Phase 3O: a search result's `context` (a short section-path breadcrumb,
// e.g. "Setup › Install") and `text` (the actual matched chunk) used to
// always render as two equally-weighted blocks — for a short/plain-prose
// chunk, that reads as duplicated information rather than two distinct
// pieces of evidence. This decides whether `context` earns its own visible
// line: only when it's both present AND says something `text` doesn't
// already show at a glance.
//
//   - context is empty/whitespace-only -> never show it (nothing to add).
//   - context, once normalized, is a substring of the (also normalized)
//     text -> the same words already appear in the evidence itself,
//     showing both would just repeat it.
//   - context is "too short to be a real lead-in" (a bare word or two, e.g.
//     just a section name with no real breadcrumb) AND text already starts
//     with something similar -> same call, narrower trigger.
//   - otherwise -> show it as a subtitle/lead-in above the evidence text,
//     not a second equally-weighted block.
function shouldShowContext(context, text) {
  const c = normalizeForCompare(context);
  if (!c) return false;
  const t = normalizeForCompare(text);
  if (!t) return true; // no text to compare against — context is all we have
  if (t.includes(c)) return false; // context's words already appear verbatim in the evidence
  return true;
}

// table/code_block/checklist chunks carry their own inline "retrieval
// context" annotation (see file-view.js's STRUCTURAL_NODE_TYPES /
// entityContext() in the indexer) rather than a prose section-path — the
// evidence itself is a structural excerpt (raw table/code markdown), so it
// gets a distinct short label ("table evidence" / "code evidence" /
// "checklist evidence") instead of being announced only by the node-type
// badge up in the primary row, which is easy to miss at a glance.
const STRUCTURAL_EVIDENCE_LABEL = {
  table: 'table evidence',
  code_block: 'code evidence',
  checklist: 'checklist evidence',
};

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
//
// Score/rank is shown unconditionally now (no showScore opt-in checkbox —
// see the module-level comment) — the numeric score and the bar each still
// carry the "used for ranking, compare order not absolute value" tooltip
// from tpl-search-result, so the safety framing survives even though the
// toggle that used to gate it doesn't exist any more. Score/rank sit in the
// card's secondary meta row (Phase 3O), not the primary identity row — a
// ranking signal, not the headline of the card.
export function renderResult(r, i, topScore) {
  const canOpen = r.sourceFile && Number.isInteger(r.chunkIndex);
  const frag = cloneTemplate('tpl-search-result');
  const card = frag.querySelector('.result-card');
  const isStructural = STRUCTURAL_NODE_TYPES.has(r.nodeType);

  card.querySelector('.rank').textContent = `#${i + 1}`;
  card.querySelector('.result-source').textContent = r.sourceFile ?? '?';
  card.querySelector('.result-section').textContent = r.section || 'intro';
  card.querySelector('.result-chunk-index').textContent =
    `chunk ${r.chunkIndex ?? '?'}${r.totalChunks ? ` / ${r.totalChunks}` : ''}`;

  const nodeTypeEl = card.querySelector('.result-node-type');
  if (r.nodeType) {
    // innerHTML (not textContent) so a structural-type icon (table/code/
    // checklist) can sit alongside the label — nodeTypeBadgeIcon() only
    // ever returns icons.js's own static SVG strings, r.nodeType (the only
    // untrusted piece here) is still escaped.
    nodeTypeEl.innerHTML = nodeTypeBadgeIcon(r.nodeType) + esc(r.nodeType);
    nodeTypeEl.hidden = false;
  }

  // "Open chunk" vs "Open file section": a structural hit (table/code/
  // checklist) is one specific excerpt, so "Open chunk" is the accurate
  // verb; a plain prose hit is part of a larger section, so "Open file
  // section" better sets the expectation that the file view opens nearby
  // context, not just this one isolated line.
  const openBtn = card.querySelector('.result-open');
  if (canOpen) {
    openBtn.dataset.sf = r.sourceFile;
    openBtn.dataset.ci = String(r.chunkIndex);
    openBtn.textContent = isStructural ? 'Open chunk' : 'Open file section';
    openBtn.hidden = false;
  }

  const contextEl = card.querySelector('.chunk-context');
  if (shouldShowContext(r.context, r.text)) {
    contextEl.textContent = r.context;
    contextEl.hidden = false;
  }

  renderChunkContent(card.querySelector('.chunk-text'), r);

  const structuralHintEl = card.querySelector('.result-structural-hint');
  if (isStructural) {
    structuralHintEl.textContent = STRUCTURAL_EVIDENCE_LABEL[r.nodeType] ?? `${r.nodeType} evidence`;
    structuralHintEl.hidden = false;
  }

  if (typeof r.score === 'number') {
    const scoreEl = card.querySelector('.score');
    scoreEl.textContent = r.score.toFixed(4);
    scoreEl.hidden = false;

    if (typeof topScore === 'number' && topScore > 0) {
      const barEl = card.querySelector('.score-bar');
      const fillEl = card.querySelector('.score-bar-fill');
      fillEl.style.width = `${Math.max(0, Math.min(100, (r.score / topScore) * 100))}%`;
      barEl.hidden = false;
    }
  }

  return card;
}
