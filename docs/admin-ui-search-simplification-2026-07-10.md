# Admin UI Search Simplification — Remove Advanced, Default Scores, Add Show More (2026-07-10)

Simplifies the admin search panel from a tuning console (visible `TOP`
selector, collapsed `Advanced` block, score hidden behind a checkbox) to a
plain user-facing search box: query input + Search button, score/rank shown
by default on every result, and a `Show more` control instead of a manual
top-k choice. No backend API contract change — the existing `/api/search`
endpoint and its `top` field (already capped at 20 server-side) are reused
exactly as they were.

## Before/after

**Before**: the search panel showed a query input, a `TOP` `<select>`
(3/5/10/20), and a Search button on the main row, plus a collapsed
`Advanced` disclosure holding a score-display checkbox and a file-filter
chip. A user had to open Advanced and tick a checkbox just to see why one
result ranked above another — the default experience hid the one piece of
information (relative rank) that makes retrieval results legible.

**After**: the main row is just the query input and Search button. Every
result shows its rank, a numeric score, and a score bar by default — no
opt-in required — each still carrying the existing "compare order, not
absolute value" tooltip, so the safety framing survives even though the
toggle that used to gate it is gone. There is no `TOP` selector: search
always fetches the backend's own maximum (`top: 20`, `src/admin/api/
search.js`'s `TOP_MAX`) in a single request, renders the first 5, and a
`Show more` button reveals the rest in batches of 5 — no repeated retrieval
calls, so revealed results can never reorder relative to what's already on
screen.

## Implementation choice: Option A (fetch-once, paginate client-side)

Per the task's explicit preference. `runSearch()` now always sends `top: 20`
(the backend's hard cap — request bodies above it are rejected with a 400,
so this was the only value permissible, not "20 or 25" as the task's
example suggested) and stores the full response in a module-local
`lastSearchResults` array. A separate `visibleResultCount` tracks how much
of that array is currently rendered; `renderVisibleResults(name, count)` is
the single render path both the initial search and `Show more` go through,
so the "open" button wiring, score-bar normalization (relative to
`lastSearchResults[0]`, never an absolute value), and rank numbering are
identical whichever page is showing. A fresh search resets both back to
page one.

## What changed

- [src/admin/ui-src/search.js](../src/admin/ui-src/search.js):
  - `initSearchPanel()`'s markup: removed the `#q-top` `<select>` and the
    `<details class="advanced-box">` wrapper entirely. The file-filter chip
    (`#q-file-chip`) moved out of the removed Advanced block into the main
    panel markup, but stays hidden by default and is only ever populated by
    `setSearchFile()` — there is still no manual file-path text input for a
    user to type into; it only appears (as a small clearable chip) when a
    "search in this file" flow or an old permalink's `&file=` sets it
    programmatically.
  - New `SEARCH_FETCH_LIMIT = 20` / `SEARCH_PAGE_SIZE = 5` constants,
    `lastSearchResults`/`visibleResultCount` module state, and two new
    functions: `renderVisibleResults(name, count)` and
    `showMoreResults(name)`.
  - `runSearch()` now always requests `top: SEARCH_FETCH_LIMIT`; renders via
    `renderVisibleResults(name, min(SEARCH_PAGE_SIZE, results.length))`
    instead of rendering the full response.
  - `renderResult(r, i, topScore)` — dropped the `showScore` boolean
    parameter entirely; score/score-bar now render unconditionally whenever
    `r.score` is a number (previously gated by `showScore && ...`).
  - `updateSearchUrl()` / `applySearchStateFromUrl()` — stopped
    writing/reading `top`. `routes.js` still parses `?top=`/`?window=`/
    `?format=` from an old URL (untouched, zero backend/router change), but
    `search.js` never applies any of them to anything anymore — an old
    bookmarked link with `&top=10` still works, it just has no `#q-top`
    control left to apply to.
- [src/admin/ui-src/app.css](../src/admin/ui-src/app.css):
  - Removed now-fully-unused rules: `.search-controls`, `.ctl`/`.ctl select`
    (only ever used inside the removed Advanced block and the removed `TOP`
    label), `.segmented` (already dead before this change — confirmed via
    grep, no source referenced it), and `.advanced-box` (the generic
    disclosure class search.js's Advanced block used — distinct from
    `.advanced-panel`, the collection-header Details class from Phase 3E,
    which is untouched and still in active use).
  - Added `#search-show-more` styling (reuses the existing `.mini-btn` look,
    centered) plus an explicit `#search-show-more[hidden] { display: none;
    }` override — the same `[hidden]`-vs-unconditional-`display` cascade bug
    found and fixed for `.job-chip`/`.q-recent` in Phase 3D applies to any
    new element that sets `display` and toggles via the `hidden` property,
    so this was added proactively rather than discovered live again.

## What stayed the same (explicitly preserved)

- The file-scope filter's underlying mechanism (`setSearchFile`/
  `clearSearchFile`, the `#q-file-chip` markup, the `&file=` permalink
  param) — untouched, just relocated in the markup since its old home
  (inside Advanced) no longer exists.
- `window: 0` is still always sent — the "Nearby context" window-chunks
  removal from an earlier phase is unrelated to this task and unaffected.
- Recent-searches (localStorage, scoped per collection, capped at 8,
  dedupe-to-front) — untouched.
- The permalink's push-vs-replace history semantics (new query text pushes,
  everything else replaces) — untouched; only which fields get written
  changed (no more `top`).
- No backend/API changes. `src/admin/api/search.js`'s `TOP_MAX = 20` was
  read, not modified — the UI simply now always asks for the max the
  backend already allowed.

## Tests

`tests/unit/admin/ui-search.test.js` was substantially rewritten (63 tests
after the code-review follow-up below, up from 33) covering all 5 categories
the task specified:

1. **Visible controls**: query input and Search button present; `#q-top`,
   `<details class="advanced-box">`, and `#q-show-score` all absent from
   both the mounted DOM and the source; the file-filter chip confirmed to be
   internal state (no manual text input exists) rather than a control.
2. **Request payload**: a behavioral test (captures the real `apiPost`
   payload, not a source regex) asserting `top: 20` on every search
   regardless of how many results the UI ends up showing; a separate test
   confirms only 5 `.result-card` elements render even when the backend
   returns 20.
3. **Show more** (new describe block, 8 tests): hidden at ≤5 results,
   visible at >5; first click reveals 6–10 without a second `/api/search`
   call (asserted via a fetch-count spy) and without reordering (asserted
   via source-file identity per position); second click reveals 11–15; a
   non-multiple-of-5 total (7 results) reveals only the remaining 2 on the
   final click and then hides the button; a fresh search resets the visible
   count back to page one; "Show more"-revealed cards' open buttons are
   wired identically to the first page's (new `openFileViewImpl` test-helper
   hook added to `ui-test-helpers.js`'s `loadSearchRenderHelpers` to make
   this observable).
4. **Score display**: score number and score bar both render by default
   with no checkbox anywhere; rank always renders independent of score;
   score/bar still correctly stay hidden when a result genuinely has no
   numeric `score` field (missing data, not an opt-out); the shared
   "compare order, not absolute value" tooltip is still present on both
   elements; `renderResult`'s new two-argument-plus-topScore signature is
   pinned at the source level.
5. **Permalink**: a successful search writes only `q` (and `file` when
   scoped) — `top`/`window`/`format` all asserted absent from the written
   URL; an old permalink carrying `top=10&window=1&format=full` still
   parses via `routes.js` without affecting the UI (no `#q-top` element
   exists to be affected in the first place).

Two collateral fixes to tests in other files whose assertions baked in the
*old* search-panel shape as "the thing that must survive": [tests/unit/
admin/ui-collection-view.test.js](../tests/unit/admin/ui-collection-view.test.js)'s
"search panel stays present and default-simple" describe block (written
during the prior collection-header task, before this task's own scope was
known) asserted `#q-top` and an Advanced disclosure *must* exist — rewritten
to assert they must *not* exist, matching this task's explicit direction.

**Result (before the code-review follow-up below): 691/691 unit tests
passing, 1293/1293 smoke tests passing, `npm run admin:build` clean (no
sandbox/path issues), `git diff --check` clean, `node --check` clean on
every changed JS file.**

## Live verification

Playwright/Chromium against the real running admin server and the project's
actual Qdrant Cloud instance, collection `nodejs-basics` (1,366 pts, real
Ukrainian/Cyrillic content):

- Confirmed via DOM query: `#q-top` count 0, `details.advanced-box` count 0,
  `#q-show-score` count 0 — none of the removed controls exist in the live
  page.
- Ran a real query ("модулі та експорт коду") — captured the actual
  `/api/search` POST payload: `top: 20`. 5 result cards rendered initially.
  Score number and score bar both visible on the first card without any
  interaction.
- "Show more" visible and labeled correctly; one click brought the visible
  count from 5 to 10, revealing real results (including a `code_block`
  result with its structural icon rendering correctly, score bars scaled
  correctly relative to the top result).
- Confirmed the URL after search carried only `?q=<query>`, no `&top=`.
- Zero console errors throughout.

Screenshots confirm the panel reads as a plain search box, not a tuning
console — this matches the acceptance criteria directly.

## Code review follow-up

Two real issues found in review, both fixed, both re-verified live:

### P1 — stale file filter survived a URL sync that dropped `&file=`

**Bug**: `applySearchStateFromUrl()` only ever called `setSearchFile()` when
the new URL's `search.sourceFile` was present — it never cleared
`searchSourceFile` when a subsequent URL sync (e.g. browser Back, or a
different permalink) carried no `&file=` at all. Concretely: set a file
scope (via a "search in this file" flow or an old `&file=readme.md`
permalink), then navigate to a URL with a different query and no `&file=` —
the file chip disappeared from view in some paths but the in-memory
`searchSourceFile` variable didn't, so the next search silently stayed
scoped to a file the visible UI no longer indicated.

**Fix**: `applySearchStateFromUrl()` now syncs the file filter exactly to
what the URL says on every call — `setSearchFileQuiet(search.sourceFile)`
when present, `clearSearchFile()` when absent — instead of only ever
setting, never clearing. Introduced `setSearchFileQuiet()`, a new
state-and-chip-only helper factored out of the existing `setSearchFile()`
(which still calls it, then adds the scroll/focus that make sense for a
real user-initiated "search in this file" click but would be wrong to fire
on every silent route sync).

**Tests**: two new tests in `tests/unit/admin/ui-search.test.js` — one
reproduces the exact scenario (sync to a URL with `&file=`, then sync to a
URL without it, assert the chip hides and the next search payload carries
no `sourceFile`) and is confirmed to fail without the fix; a second confirms
the URL-driven sync path never calls `scrollIntoView` (i.e. genuinely goes
through the quiet setter, not `setSearchFile()`).

**Live-verified**: navigated directly to a permalink with `&file=` (chip
appeared with the correct filename), then to a different-query permalink
with no `&file=` (chip correctly disappeared) — against the real running
admin server, zero console errors.

### P2 — status line said "20 results" above only 5 visible cards

**Bug**: the status text was set once, right after a successful fetch, to
the full fetched count ("20 results") — it never changed unless the query
was updated. A user saw "20 results" with only 5 result cards below, and
clicking "Show more" didn't update the text at all, so it stayed wrong even
after revealing 10.

**Fix**: the status text is now computed inside `renderVisibleResults()` —
the one function both the initial render and every `Show more` click go
through — as `"Showing {count} of {total} results"` whenever more remain,
collapsing to the plain `"{total} results"` once everything fetched is
visible (avoids the slightly odd "Showing 20 of 20").

**Tests**: three new tests confirming the exact wording at each stage
("Showing 5 of 20 results" → "Showing 10 of 20 results" after one click →
plain "5 results" when nothing is held back).

**Live-verified**: real search against `nodejs-basics` showed "Showing 5 of
20 results" initially, "Showing 10 of 20 results" after one "Show more"
click — matching the actual card counts on screen at each step.

Both fixes verified together: 696/696 unit tests passing (63/63 in
`ui-search.test.js`), 1293/1293 smoke tests, clean build, clean diff, clean
`node --check`.
