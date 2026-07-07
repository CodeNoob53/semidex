# Admin UI Phase 3B — Polish, Accessibility, Search QoL (2026-07-07)

Polish pass on the Phase 3A layout (sidebar navigation + single main
content surface): accessibility fixes, a shareable search URL, per-
collection recent searches, a normalized score bar, and a toast-system
audit. Not a redesign — the IA from Phase 3A is unchanged.

## What was already correct (verified, not rewritten)

- **Advanced controls mostly collapsed**: score display and file-filter
  controls are inside `<details class="advanced-box">` in `search.js`,
  collapsed by default. `top` is the one control outside it, in the
  always-visible main row next to the query input and Search button —
  kept visible deliberately: it's a single, low-noise, non-technical
  control ("how many results"). The old `window`/`format` controls were
  removed later in this task (see "Window-chunk removal").
- **RRF/score wording**: the score span already carried "Rank score —
  compare order, not absolute value" before this task. The new score bar
  reuses the identical tooltip string, verified by a test asserting both
  elements carry it.
- **Toast system**: single host (`#toast-host`, mounted once in
  `index.html`, outside `#main`), `aria-live="polite"` already present,
  de-dup already scoped per (collection, warning-text) via an in-memory
  `Set`. Search errors already go to the inline `#search-status` box, not
  toasts. No source changes made — the task said "do not rebuild it
  unless broken," and it wasn't. Two tests added to pin what was
  previously unasserted: `aria-live="polite"` presence, and exactly one
  `#toast-host` in the markup.
- **No manual toast dismiss**: auto-dismiss only (8s), by the file's own
  "minimal by design" header comment. Left as-is — a deliberate scope
  decision from an earlier phase, not something this polish pass should
  silently expand.

## What changed

### 1. Accessibility

- **Contrast**: `--ink-faint` was `#5c5a4f` — computed via the WCAG
  relative-luminance formula, this is **2.64:1** against `--bg` and
  **2.44:1** against `--bg-raise`, both failing the 4.5:1 AA minimum for
  normal text. Brightened to `#888572` (**4.91:1** / **4.54:1** — clears
  AA on the harder of the two backgrounds), while staying visibly dimmer
  than `--ink-dim` (`#8b8878`, 5.11:1/4.72:1, already correct). Single
  CSS custom property — every consumer (`.muted` list items,
  `.sidebar-foot`, `.skel-note`, `.chunk-context-label`, `.empty`,
  `.tree-caret`, `.tree-loading`, `.cap`) updates automatically.
- **Focus states**: previously only `.sidebar-resize-handle` and
  `.q-input` had any `:focus`/`:focus-visible` styling — every button
  class and the sidebar tree rows had none. Added one shared
  `:focus-visible` rule (`button, a, input, select, .tree-row`) with an
  amber outline, matching the existing accent-color language.
- **Active row beyond color**: `.tree-collection-row.active` already had
  a background + border-left change (not color-only). Found that
  `.tree-file.active`/`.tree-node.active` — set by `markActive()` since
  the Phase 3A follow-up — had **no CSS rule at all**, making that
  active-state highlight invisible in practice. Added matching styling.
- **Keyboard reachability, sidebar tree**: `.tree-collection-row` and
  `.tree-file` are real `<a>` tags (already focusable). `.tree-node`
  (skeleton section/directory rows) is a plain `<div>` with only a click
  handler — no `tabindex`, unreachable by keyboard at all. Added
  `tabindex="0"`, `role="button"`, `aria-label`, and an Enter/Space
  `keydown` handler alongside the existing click handler.
- **`prefers-reduced-motion`**: no such media query existed anywhere.
  Added a block disabling the panel load-in animation and the
  indeterminate progress-bar sweep. Added `dom.js`'s `prefersReducedMotion()`
  (guards `typeof matchMedia === 'function'` so it degrades safely in
  bare test contexts) and guarded all three `scrollIntoView({behavior:
  'smooth'})` call sites (`file-view.js` ×2, `search.js` ×1) to use
  `'auto'` when the user has asked for reduced motion.
- **Accessible names**: `#q-file-clear` (the `×` clear-filter button) had
  a `title` but no `aria-label` (titles aren't reliably exposed as
  accessible names). Added `aria-label="Clear file filter"`.
- **Label floor (10px labels)**: left as-is. `.brand-sub`, `.panel-label`,
  `.panel-head`, `.tree-caret`, `.chunk-context-label`, table headers,
  `.opt-group-label` are uppercase letter-spaced section
  labels/micro-metadata — a common, defensible pattern, and the task's
  own wording ("11px unless already justified by existing design") leaves
  room for it. This is a judgment call, flagged here rather than silently
  applied — happy to bump these in a follow-up if the user disagrees.

### 2. Search query permalink

`routes.js`'s `currentRoute(hash)` now splits off any `?`-suffixed query
string **before** path-matching (so `f/(.+)` never swallows a trailing
`?q=...` into the `openFile` capture), then parses it into a `search`
sub-object via `URLSearchParams`. The key is present in the returned
route only when the query string is non-empty — no `search: {}` noise on
plain routes.

**Contract**: `#/c/my-docs?q=refund&top=5` and
`#/c/my-docs/f/readme.md?q=install`. Active admin search query keys are
`q`, `top` (number), and `file` (maps to `search.sourceFile` —
deliberately distinct from the path's own `f/:sourceFile` segment, since
"which file is open in the content view" and "is search scoped to a file
filter" can differ, e.g. filtering search to fileA while fileB's content
is on screen). Legacy shared/bookmarked URLs may still contain `window`
and `format`; `routes.js` parses them for backward compatibility, but the
admin UI ignores them and no longer writes them.

`search.js` writes state via `history.pushState`/`replaceState` (never
`location.hash =`, which would fire a `hashchange` and recursively
re-enter `route()` — this app's router listens on `hashchange` for all
navigation) — see "Second round of post-review fixes" below for exactly
which one fires when. Both update the URL bar/history entry silently.

Reading state back out is **not** something `initSearchPanel` does on its
own (see "Third round of post-review fixes" below for why an earlier
version of this feature got that wrong). `initSearchPanel` only mounts
the form; `router.js`'s `route()` is the sole owner of deciding what to
do with a route's `?q=...` — it calls `applySearchStateFromUrl(name)`
(updates the form fields only) on file/section routes, and
`syncSearchStateFromUrl(name)` (form fields **plus** actually running the
search) on bare collection routes, on every navigation including a
route's first visit. This is what makes refresh, back/forward, and
pasted URLs all resolve to the same correct state, without a file/section
view ever getting silently hidden by a stale search re-running underneath
it.

### 3. Recent searches

Follows the existing `settings-view.js` convention exactly (dedupe-and-
cap, try/catch-wrapped `localStorage`): key
`semidex-admin-recent-searches:<collectionName>` — the collection name is
baked into the key itself, the simplest way to keep collections from
leaking into each other's suggestions. Capped at 8, deduped by exact
query text (repeat moves to front, not duplicated), empty/whitespace-only
queries never stored. A small chip row (`#q-recent`) sits in the
always-visible main row, not inside Advanced — this is a normal search
affordance, not a debug control. Clicking a chip fills the input and runs
the search immediately (not just "fills the box").

### 4. Score bar

`renderResult(r, i, showScore, topScore)` gained a 4th parameter;
`runSearch()` computes `topScore = body.results[0]?.score` once (results
already arrive rank-sorted) and passes it to every card. A new
`.score-bar`/`.score-bar-fill` pair in `search-result.html`, hidden
unless `showScore` is on **and** the result has a numeric score — purely
additive to the existing opt-in numeric score, never shown on its own.
Bar width is `(r.score / topScore) * 100%`, clamped to [0,100]. Carries
the identical "compare order, not absolute value" tooltip as the numeric
score span.

### 5. Advanced controls — confirmed, no change

Covered under "already correct" above.

### 6. Toast audit — confirmed, tests added, no source change

Covered under "already correct" above.

## Files changed

- `src/admin/ui-src/app.css` — `--ink-faint`, global `:focus-visible`,
  `.tree-file.active`/`.tree-node.active`, `prefers-reduced-motion`
  block, `.q-recent`, `.score-bar`/`.score-bar-fill`.
- `src/admin/ui-src/dom.js` — `prefersReducedMotion()`.
- `src/admin/ui-src/routes.js` — query-string parsing on top of existing
  path matching.
- `src/admin/ui-src/search.js` — URL read/write, recent searches
  (storage + chip UI), score-bar wiring, `aria-label` fix, reduced-motion
  guard on its `scrollIntoView` call.
- `src/admin/ui-src/file-view.js` — reduced-motion guard on both
  `scrollIntoView` call sites (factored into one `scrollToPanel()`
  helper).
- `src/admin/ui-src/sidebar.js` — `.tree-node` keyboard reachability
  (`tabindex`/`role`/`aria-label`/keydown handler).
- `src/admin/ui-src/partials/templates/search-result.html` — score-bar
  markup.
- Tests: new `tests/unit/admin/ui-accessibility.test.js` (10 tests —
  contrast math, focus-visible rule presence, active-row CSS, reduced-
  motion CSS + guard-site coverage, accessible name); `ui-sidebar.test.js`
  (+2 — tree-node keyboard markup/wiring); `ui-router.test.js` (+6 —
  query-string parsing); `ui-search.test.js` (+17 — URL permalink read/
  write, recent searches, score bar); `ui-toasts.test.js` (+2 —
  `aria-live`, single-host); `ui-test-helpers.js` extended
  (`loadSearchRenderHelpers` now injects `URLSearchParams`/`localStorage`/
  `location`/`history` and accepts `{hash, storage}`; `loadRouterHelper`
  injects `URLSearchParams`).

## Post-review fixes (found by code review, same day)

Three defects were found in the initial permalink/recent-searches
implementation by review, all fixed before this report was finalized:

1. **Searching from an open file/section kicked the user back to the bare
   collection view.** `updateSearchUrl()` hardcoded the URL base as
   `#/c/${name}`, discarding whatever path segment (`/f/:sourceFile` or
   `/n/:nodePath`) was actually current — so running a search while a file
   was open silently rewrote the hash to `#/c/name?q=...`, losing the open
   file. Fixed by reading the current path from `location.hash.split('?')[0]`
   instead of reconstructing a bare collection path.
2. **Back/forward within the same collection never restored search
   state.** `syncSearchStateFromUrl()` (formerly `restoreSearchStateFromUrl`)
   only ran from `initSearchPanel()`, which `collection-view.js`'s
   `alreadyOnThisCollection` guard skips on every navigation within a
   collection after the first (a deliberate, documented optimization from
   an earlier phase, so the fix could not just remove that guard). Fixed
   by having `router.js`'s `route()` call `syncSearchStateFromUrl(r.name)`
   directly on every **bare** collection-route navigation (never when the
   route also carries `openFile`/`openNodePath` — opening a file/section
   is a stronger, explicit signal than a passively-carried query string,
   and must win, since `runSearch()` calls `hideCollectionContent()`).
   `syncSearchStateFromUrl` now keeps a `lastSyncedSearchParamsKey`
   snapshot (updated both when it restores state and when `updateSearchUrl`
   itself writes a new URL) so it only actually restores/re-runs a search
   when the URL's search params genuinely changed since it last looked —
   otherwise a route re-render with an unchanged query string would
   spuriously re-search and clobber whatever the user was doing.
3. **A failed search was still added to recent searches.**
   `rememberRecentSearch()`/`renderRecentSearches()` used to run before the
   `apiPost('/api/search', ...)` call, so a network error or 500 still
   polluted the recent-searches list with a query that never actually
   returned evidence. Moved both calls to after `apiPost` resolves
   successfully (a zero-results response still counts as success and is
   still remembered — only a thrown error skips it).

6 new tests cover these: preserving `/f/`/`/n/` path segments across a
search (2 tests), `syncSearchStateFromUrl` restoring on a genuine
params change and no-op'ing on an unchanged one (2 tests), and a failed
vs. zero-result-but-successful search's effect on recent searches (2
tests). All were verified to actually catch their respective regression
by temporarily reverting each fix and confirming the new test failed,
before restoring the fix.

## Second round of post-review fixes (same day, second review pass)

A follow-up review of the fixes above found two further gaps and flagged
one untracked file:

1. **File/section routes still didn't sync search state.** The first
   fix made `router.js` call `syncSearchStateFromUrl(r.name)` only on
   bare collection routes — correct for not clobbering an open file view,
   but it meant a file/section route's own `?q=...` was never applied to
   the form at all (e.g. back/forward between
   `#/c/my-docs/f/readme.md?q=cats` and `...?q=dogs` left the form
   showing whichever query happened to be there first). Fixed by
   splitting the function in two: `applySearchStateFromUrl(name)` always
   updates the form fields to match the URL (safe on every route, since
   it never touches `#search-results`/`#collection-content`) and returns
   whether it changed anything; `syncSearchStateFromUrl(name)` is that,
   plus actually calling `runSearch()` — reserved for bare collection
   routes. `router.js` now calls `applySearchStateFromUrl` in both the
   `openFile` and `openNodePath` branches (form sync only), and
   `syncSearchStateFromUrl` only in the bare-route branch (form sync +
   search).
2. **`replaceState` meant Search A → Search B lost Search A from
   history entirely.** Every search rewrote the *same* URL entry, so
   pressing Back after two searches skipped past both and landed on
   whatever came before the first one — "back/forward restores search
   state" was true only for the single most recent search, not a real
   history. Resolved (per explicit direction) by using `pushState` for a
   genuinely new query and `replaceState` for everything else (re-running
   the same query with different `top`/file-filter settings, or a
   URL-driven sync restoring a query the URL already carries) — pushing
   on every filter tweak or keystroke-adjacent re-search would flood
   history with one entry per action rather than one per distinct
   question asked. A new `lastPushedQuery` snapshot in `search.js` drives
   the push-vs-replace decision.
3. **`docs/design/ask-chat.md` appeared untracked, unrelated to this
   task.** Confirmed it's a legitimate future-phase design doc (dated
   2026-07-02, scoped to Phase 4A/4B/4C's Ask/chat feature, explicitly
   *not* part of Phase 3B) rather than accidental scratch content — but
   left untouched and unstaged either way, since whether/when to commit
   it is the user's call, not something this task should fold in
   silently.

7 new tests cover the two code fixes: `applySearchStateFromUrl` updating
the form without running a search on a file route, and returning `false`
on an unchanged URL (2 tests, `ui-search.test.js`); push-vs-replace for a
new query, an unchanged query, and a URL-driven sync (3 tests,
`ui-search.test.js`); and two source-level guards in `ui-router.test.js`
pinning that `applySearchStateFromUrl` (not `syncSearchStateFromUrl`) is
what the `openFile`/`openNodePath` branches call. Both router-level tests
were verified to fail when the fix was temporarily reverted.

## Third round of post-review fixes (same day, third review pass)

A third review pass found the second round's fix was incomplete, and
flagged that the router-level tests added so far were source-text
regex, not real behavior tests, and had missed this:

1. **`initSearchPanel()` still called `syncSearchStateFromUrl()`
   directly on mount.** Even after splitting `apply`/`syncSearchStateFromUrl`
   and making `router.js` route-aware, `initSearchPanel()` (called from
   `collection-view.js`'s `renderCollection()` on a collection's first
   visit) still called `syncSearchStateFromUrl(name)` itself — so the
   very first navigation to `#/c/my-docs/f/readme.md?q=dogs` ran a full
   `runSearch()` (extra `/api/search` call, URL/history rewrite, recent-
   searches pollution, and a brief content-surface flicker) **during**
   `renderCollection()`, before `router.js` ever reached the `openFile`
   branch that was supposed to protect this exact case. `router.js`'s own
   apply-vs-sync split was correct; `initSearchPanel()` was bypassing it
   from a different module. Fixed by removing the call entirely —
   `initSearchPanel()` now only mounts the UI (form markup, event
   listeners, scope label, recent-searches list) and does nothing with
   URL search state. `router.js`'s `route()` already calls
   `applySearchStateFromUrl`/`syncSearchStateFromUrl` unconditionally
   after `renderCollection()`/`openFileView()`/`openNodeFromPath()`
   resolve on every single invocation, including the first — so it now
   correctly covers first-visit routes too, with no other call site
   needed.
2. **The router tests couldn't have caught this class of bug.** The
   existing `ui-router.test.js` tests for the apply-vs-sync split were
   source-regex over `router.js`'s own text — accurate about what
   `router.js` calls, but blind to a bug living in a *different* module
   (`search.js`) further down the call chain. Added
   `loadRouteIntegrationHelpers()` to `ui-test-helpers.js`: evaluates the
   real `route()`/`renderCollection()`/`openFileView()`/
   `initSearchPanel()` call graph together (11 real modules — `dom.js`,
   `format.js`, `state.js`, `toasts.js`, `routes.js`, `file-view.js`,
   `search.js`, `sidebar.js`, `collection-view.js`, `router.js`, plus a
   stub `api`/`apiPost` — `settings-view.js`/`jobs-view.js` are stubbed
   out since they're only reachable via routes this flow doesn't
   exercise) against a minimal shell, tracking every `api`/`apiPost` call
   made. Three new tests in `ui-router.test.js` exercise this for real:
   navigating straight to `#/c/my-docs/f/readme.md?q=dogs` updates
   `#q-input` to `dogs` but never calls `/api/search`; the file view
   genuinely opens (`#content-title` shows the filename, not stale
   "Results" text); and — the contrast case, so the fix isn't
   over-broad — a *bare* collection route with `?q=` still does call
   `/api/search`. The first of these three was manually confirmed to
   fail (reporting the exact spurious `/api/search` call) when the bug
   was temporarily reintroduced, then pass again once the fix was
   restored — direct proof this test class catches what the source-regex
   tests structurally could not.

1 new test in `ui-search.test.js` pins `initSearchPanel()`'s body
(with its own comments excluded, to avoid a false positive against the
comment's own prose mention of both function names) as calling neither
`applySearchStateFromUrl(` nor `syncSearchStateFromUrl(`.

## Window-chunk removal (same day, follow-up scope change)

A follow-up task superseded the earlier "Nearby context" deduplication fix
(second round, item 3 above): rather than fix duplication in the
window-chunks display, remove the window-chunks feature from the admin
dashboard entirely. Rationale: the admin dashboard is a user-facing
evidence view, not an MCP-style debug console — a clean ranked-hits list
(one matched chunk per card) is the right default, with neighbor-context
expansion deferred as a future opt-in rather than always-on.

**Changed**:
- `runSearch()` now always sends `window: 0` in the `/api/search` payload
  (previously read from a `#q-window` `<select>`, defaulting to 1).
- The window `<select>` and the compact/full segmented format control are
  removed from the Advanced disclosure entirely — they only ever mattered
  when `window > 0`, so with window fixed at 0 they had no effect to show.
- `renderResult()` no longer renders `windowChunks` at all (previously
  filtered to non-match entries under a "Nearby context" label — that
  entire code path, its CSS, and its `tpl-window-chunk` sub-template are
  removed). A result card is exactly: rank, optional score/score-bar,
  source file, chunk index, section, node type, context, matched chunk
  text, open button.
- `updateSearchUrl()` no longer writes `window=`/`format=` into the
  permalink — a search URL from this UI is now
  `#/c/my-docs?q=refund&top=5` (or with `&file=...`), never carrying
  window/format as noisy always-present defaults.
- `applySearchStateFromUrl()` no longer reads `search.window`/
  `search.format` from an incoming URL — `routes.js`'s `currentRoute()`
  parser still parses `?window=`/`?format=` (so an old bookmarked link
  with those params doesn't throw or misparse), the admin UI simply
  ignores them now.

**Explicitly unchanged** (verified via `git diff --stat` on backend/MCP
directories showing no diff): `src/admin/api/search.js`'s `window`/
`windowFormat` request handling and `expandWindows`/`toWindowChunk`
helpers; the MCP `assembleWindowChunks` tool; `tests/unit/admin/search.test.js`
(the backend `/api/search` route test, which still exercises `window=1`
compact/full behavior directly against the API). The admin UI simply
never asks the API for a window anymore — the API's capability is intact
for any other caller.

**Tests**: rewrote `ui-search.test.js`'s window/format-related tests
(the old "does not write &format= when window=0" test, made moot since
window/format are never written at all now) and added: a **behavioral**
test capturing the real payload `runSearch()` sends to a stubbed
`apiPost` and asserting `payload.window === 0` (a source-text regex
version of this test was tried first and found to falsely pass against
an explanatory code comment containing the string `window: 0` — replaced
with the payload-capture version, which was verified to actually fail
when a `window: 1` regression was reintroduced); a test that no
`.win-chunks`/`.win-chunk` element or "Nearby context" text appears in a
rendered card even when the API response includes a `windowChunks` field
(defensive — covers a hypothetical future/legacy caller); a test that the
search-result template no longer defines `tpl-window-chunk` at all; and a
test confirming an old permalink with `window=1&format=compact` still
parses without error but does not affect rendered UI state.

## Verification

1. `node --check` on every changed source and test file — all OK.
2. `npm run admin:build` — 24 modules, clean build (router.js now also
   imports search.js — one new one-directional edge, no cycle: verified
   both by the existing import-cycle guard test and a clean build).
3. Live boot check: fetched the real built bundle, evaluated in a
   linkedom-stubbed Node context — `startAdminApp()` runs to completion,
   `boot check result: OK`.
4. `npm test` — 630/630 pass.
5. `npm run smoke` — 1293/1293 pass.
6. `git diff --check` — clean (routine CRLF notices only).
7. `git diff --stat` on `src/admin/api/`, `src/core/`, `src/mcp/` — no
   changes, confirming the backend/MCP window-search contract is
   untouched.

## Known limitations

- **No manual toast dismiss** — auto-dismiss only (8s). Deliberate,
  inherited scope decision from an earlier phase; the task's "do not
  rebuild unless broken" instruction means this stays as-is.
- **10px labels not bumped** — a judgment call (see "Accessibility"
  above); flagged for the user to weigh in on rather than silently
  changed.
- **`<select>.value` is not independently verifiable in this test
  harness for restoring `top` from a URL** — the vm/linkedom test
  environment (linkedom 0.18.x) has a confirmed limitation where
  `<select>.value = ...` does not update the selected `<option>`, and the
  `.value` getter also stops reflecting reality once an `<option>.selected`
  is toggled directly as a workaround. This is a test-infrastructure gap,
  not a product bug — the affected assertions were downgraded to
  source-level checks (pinning the exact line of code that performs the
  assignment) rather than removed, and every other DOM-observable
  behavior in this task (text inputs, button classes, chip rendering,
  score-bar width, localStorage content) is still verified through real
  DOM behavior.
- **No visual/manual browser QA was performed.** Every claim in this
  report is backed by computed contrast math, source-level assertions, or
  linkedom-based DOM-behavior tests — not a running browser. If a visual
  regression exists (e.g. the new focus outline overlapping other UI, the
  score bar's width in a real layout), it would not be caught by this
  suite.
