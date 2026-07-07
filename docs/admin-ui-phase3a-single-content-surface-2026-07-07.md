# Admin UI Phase 3A — Single Content Surface + Sidebar Navigation UX (2026-07-07)

Implements the Phase 3A information-architecture pivot from
`docs/design/admin-ui-ux-and-ask-plan.md` (§3, Phase 3A): sidebar owns
navigation, main shows exactly one content surface at a time.

## Honest scoping note

Before implementing, the actual code was audited against all 8 numbered
requirements in the task. Most of Phase 3A was **already built and
test-covered** in earlier phases (the sidebar-owns-navigation design
correction — see `sidebar.js`'s own header comment referencing "Phase
2E" — and the collection-shell/search/file-view/settings work from
commit `66090d8`). This report is honest about what was already true vs.
what this task actually changed. The "five stacked debug panels" framing
in the design doc's Phase 3A exit gate describes a state that predates
the current code — the collection shell already had 3 panels
(header/search/content), not 5, and no standalone Documents or Skeleton-
navigation panel exists in main (verified: `ui-collection-view.test.js`
already asserted their absence before this task started).

## What was already correct (verified, not rewritten)

| Requirement | Status | Evidence |
|---|---|---|
| 3. Compact collection header, technical details behind `<details>` | Already done | `collection-view.js`'s `renderCollectionHeader` — name/badge/settings on top line, description/point-count/warnings inside `<details class="advanced-panel">`. `ui-collection-view.test.js` (3 tests) |
| 4 (mostly). Search defaults: top=5, window=1, format=full, advanced collapsed | Already done | `search.js`'s `initSearchPanel` — all defaults confirmed correct, `<details class="advanced-box">` not open. `ui-search.test.js` |
| 6. Section view honesty (no silent chunk-0 fallback) | Already done | `file-view.js`'s `openSectionView` — explicit "no indexed content" message + opt-in button on a 404, never a silent fallback. `ui-sidebar.test.js` |
| 7. Evidence-card search results, RRF-rank tooltip | Already done | `search-result.html` already has `title="Rank score — compare order, not absolute value"` on the score span; `.result-open` already opens file/chunk context |
| 8. Delete modal-confirm, not typed-confirm | Already done | `settings-view.js` — `#delete-modal-backdrop` cloned from a template, cancel/confirm buttons, no typed-name input |
| No standalone Documents/Skeleton-nav panel in main | Already done | `ui-collection-view.test.js`'s "old flat technical panels are removed" block (asserts absence of `col-docs`/`col-skel`/`col-meta`) |
| No sidebar.js ↔ router.js cycle | Already done (prior follow-up task) | `ui-router.test.js`'s import-cycle guard block |

None of these were touched by this task, beyond re-running their existing
tests to confirm they still pass after the real changes below.

## What actually changed

### 1. The core bug: search results and file/section view could both be visible at once

`collection-shell.html` has `#search-panel` (containing `#search-results`,
always in the DOM) and a separate `#collection-content-panel` (file/section
view, toggled via inline `style.display`). `runSearch()` already cleared
the file panel before showing results — but nothing cleared search results
when a file/section was opened. Searching, then clicking a file, left
stale search results visible above the new file view: two independently
toggled panels, not one surface.

**Fix**: added `hideSearchResults()` to `file-view.js` (`src/admin/ui-src/file-view.js`),
matching the shape of the existing `hideCollectionContent()`. Both
`openSectionView()` and `openFileView()` now call it before showing the
content panel. This is the actual "main shows one content surface at a
time" mechanism the task asked for.

### 2. File view: visible total chunk count

`openFileView()`'s title previously showed only the filename
(`title.textContent = sourceFile`). The chunk count was already available
end-to-end (the backend already writes `total_chunks` at index time and
maps it into every chunk's `totalChunks` field; `renderFileChunks` already
showed `chunk N / totalChunks` per card) — just never surfaced as a
top-of-view header. Now: `` `${sourceFile} — ${chunks[0].totalChunks} chunks` ``
when known, falling back to the plain filename when a chunk's
`totalChunks` is `null` (structural/skeleton-internal chunks). No backend
change needed.

### 2b. Fix: "load more" pagination broke when the file view opened at a non-zero chunk index

Found in review after the initial Phase 3A pass. `openFileView()` set
`fileViewState.loaded = chunks.length` after its first `/chunks` fetch.
The `/chunks` endpoint centers its window on `chunkIndex`
(`[chunkIndex-window, chunkIndex+window]`), so when the view opens at a
non-zero `chunkIndex` (e.g. a skeleton-section anchor lands mid-file), the
returned chunks don't start at 0 — `chunks.length` under-counts how far
into the file was actually shown. Example: `chunkIndex=10, window=3`
returns chunks 7–13 (7 chunks), but `loaded` was set to `7`, not `14`.
`loadMoreFileChunks()` then requested the next page starting at
`chunkIndex=7` — re-fetching and, via its `c.chunkIndex >= loaded` filter,
letting chunks 7–9 slip back in as "new," duplicating cards instead of
continuing forward from 14.

**Fix**: `fileViewState.loaded` is now set to
`Math.max(...chunks.map(c => c.chunkIndex + 1))` — the index one past the
highest chunk actually shown, matching the same "next un-seen index" logic
`loadMoreFileChunks()` already used on its own subsequent calls. Covered
by a new regression test in `ui-file-view.test.js` that opens at
`chunkIndex=10`, gets back chunks 7–13, calls `loadMoreFileChunks()`, and
asserts the follow-up request targets `chunkIndex=14` (not 7) with no
duplicate cards. Verified the test fails against the old `chunks.length`
logic before confirming it passes against the fix.

### 3. Search scope label ("Searching in: ...")

Added a `#search-scope` span to `collection-shell.html`'s search-panel
head (next to the existing `#search-mode`, which shows the API's
retrieval-mode string and was left as-is). `search.js`'s
`initSearchPanel(name)` sets it to `Searching in: ${name}`;
`setSearchFile(sourceFile)` narrows it to `Searching in: ${sourceFile}`;
`clearSearchFile()` restores the collection-scoped text.

### 4. Sidebar active-state now extends to the open file/section

`markActive()` previously only highlighted the collection row. A user who
opened a file had no visual indicator of which row was open in the tree —
part of requirement 1's "active state must stay synced... sidebar
highlight." Fixed by:
- adding a `data-path="${nodePath}"` attribute to `sidebarNodeRow()`'s
  markup (file fallback rows already had `data-sf`);
- extending `markActive(route)` to also toggle `.active` on the matching
  `.tree-file[data-sf]` or `.tree-node[data-path]` row based on
  `route.openFile`/`route.openNodePath`;
- `router.js`'s `route()` now calls `markActive()` a second time after the
  view-rendering branch resolves, since skeleton-tree rows render
  asynchronously (`loadSidebarTree`) and don't exist yet at the first
  `markActive(r)` call.

## Routes (unchanged)

All 6 routes continue to work exactly as before — no route rename:
`#/`, `#/index`, `#/c/:collection`, `#/c/:collection/settings`,
`#/c/:collection/f/:sourceFile`, `#/c/:collection/n/:nodePath`.

## Deferred (explicitly out of scope, per the task's non-goals)

- Ask/chat (Phase 4A+).
- Entity rendering/chunk stitching (Phase 3D/3E) — file/section view still
  shows discrete chunk cards, not a stitched document.
- Any backend/API changes — none were needed; `totalChunks` and
  `/skeleton/anchor` honesty behavior already existed.
- Full settings redesign — untouched, as instructed.

## Tests added

Following the existing whole-file/vm-evaluation pattern in
`tests/unit/admin/ui-test-helpers.js` (no browser needed):

- `ui-test-helpers.js`: `loadFileViewBehaviorHelpers(html, apiResponses)`
  (evaluates `file-view.js` against a collection-shell-shaped document with
  a stubbed `api()` — `apiResponses` values may be a function of the
  request URL, so a test can vary its response across sequential calls,
  e.g. to check the exact `chunkIndex` a follow-up "load more" targets),
  `loadSidebarActiveStateHelpers()` (evaluates `sidebar.js` against a small
  real tree fragment), and extended `loadSearchRenderHelpers` to inject a
  `#search-panel`/`#search-scope` container so
  `initSearchPanel`/`setSearchFile`/`clearSearchFile` are exercisable, not
  just `renderResult`.
- `ui-file-view.test.js` (+5): opening a file clears search results;
  opening a section clears search results (via its delegate call);
  chunk-count title when `totalChunks` is known; plain-filename fallback
  when it isn't; opening at a non-zero `chunkIndex` and calling "load more"
  continues forward from the actual highest chunk shown, not a stale
  chunk-count-based index (the pagination fix above).
- `ui-search.test.js` (+3): scope label set on mount; scope label narrows/
  restores via `setSearchFile`/`clearSearchFile`; regression guard that
  `runSearch` still calls `hideCollectionContent` (the other half of the
  mutual-exclusion pair).
- `ui-sidebar.test.js` (+5): `sidebarNodeRow` carries `data-path`;
  `markActive` highlights the file row; highlights the section row; clears
  stale file/section active state; collection row stays highlighted
  alongside the file/section row.

Total: 13 new tests, all passing.

## Verification

1. `node --check` on every changed source and test file — all OK.
2. `npm run admin:build` — 24 modules, clean build (unchanged module
   count/graph; only function bodies and one new DOM attribute changed).
3. Live boot check: fetched the real built bundle, evaluated in a
   linkedom-stubbed Node context — `startAdminApp()` runs to completion,
   `boot check result: OK`. Confirmed the minified output contains the new
   `markActive` file/section-row logic.
4. `npm test` — 570/570 pass (557 pre-existing + 13 new).
5. `npm run smoke` — 1293/1293 pass.
6. `git diff --check` — clean (routine CRLF notices only).
7. `ui-router.test.js`'s import-cycle guard block still passes — no
   sidebar.js ↔ router.js (or jobs-view.js ↔ router.js) regression; this
   task only edited function bodies, not import statements.

## Known limitations

- The chunk-count header depends on the backend populating `totalChunks`
  on every returned chunk (it already does, via `total_chunks` written at
  index time) — collections indexed before that field existed, or
  structural/skeleton-internal chunks where it's `null`, fall back to the
  plain filename with no visible count. This is an honest degrade, not a
  bug, but worth knowing if a user reports "no chunk count" on an old
  collection.
- `markActive`'s file/section-row lookup uses a small hand-rolled
  attribute-value escaper (`cssEscapeAttr`) rather than the real
  `CSS.escape`, since `CSS.escape` isn't available in every target
  environment this UI runs in. It only escapes `"` and `\`, which is
  sufficient for building a `[data-sf="..."]`/`[data-path="..."]` selector
  safely, but is not a general-purpose CSS.escape replacement.
- No visual/manual browser check was performed as part of this task (no
  running dev server was used to eyeball the result) — verification is
  build + unit-test + live-boot-check based, per this project's
  established pattern for backend-only-observable admin UI work. If a
  visual regression exists in the scope-label or active-row styling, it
  would not be caught by this test suite (no CSS assertions were added,
  only DOM-structure/text-content assertions).
