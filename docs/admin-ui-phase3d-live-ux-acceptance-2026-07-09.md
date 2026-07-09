# Admin UI Phase 3D — Real Browser UX Acceptance + Fix Visible Regressions (2026-07-09)

A real-browser verification pass over the current Vite-built admin UI (not the
`.dc.html` mock) against the actual project Qdrant Cloud instance and its real
collections. Playwright/Chromium drove the built `dist/admin-ui` output served
by `node src/admin/server.js`; every check below is against real data, not
stubs. Five real regressions were found and fixed, each with a browser-verified
before/after and a new automated regression test.

**Update (post-review)**: an earlier version of this report described the
sidebar's "file-with-sections only expands, never opens the file" behavior as
"existing, intentional design... not a regression." A review correctly
rejected that framing — it directly contradicted this project's own UX
direction ("chunks should show when a section is picked, not require picking
a file that then can't be opened"), and for this project's real skeleton
collections it made the whole-file view almost unreachable from the sidebar,
since nearly every real markdown file has at least one section. This has been
fixed (regression #4 below) and the report rewritten accordingly — Phase 3D is
not being called fully accepted until this fix's own tests and live
verification are in, which they now are.

## Manual/browser checks performed

Driven via Playwright (chromium) against `http://127.0.0.1:8642`, the actual
built admin server, with the project's configured Qdrant Cloud instance as the
backend (no fixtures/mocks for collection data).

**Collections used**: `Курсова робота` (296 pts, skeleton-enabled, Cyrillic
names, nested folders — `access/`, `analysis/`, `sql/`, `theory/`, etc.),
`nodejs-basics` (1,366 pts, skeleton-enabled, Cyrillic), `linux-basics` (1,329
pts, skeleton-enabled), `bench-structural-carryover` (1,450 pts, flat-file-list
fallback — `hasSkeleton: false`), plus two throwaway collections
(`phase3d-scratch-test`, `phase3d-scratch-test-2`) created and deleted during
this session to exercise a real indexing job end-to-end without touching real
data.

- **Sidebar**: expanded `Курсова робота` (Cyrillic collection name) — renders
  correctly, 340px default width holds up with icons, directory/file icons
  render as real SVGs (`data-icon="directory"` etc.), long Ukrainian filenames
  truncate cleanly with ellipsis, active-row highlighting is visible, expanding
  a folder (`sql/`) causes no layout jump (sidebar width identical
  before/after: 340px → 340px). Screenshots confirm a clean, non-debug-feeling
  tree.
- **File view**: confirmed via the flat-file-list path
  (`bench-structural-carryover`) that a single click on a file row opens the
  full-file chunk view directly (`#/c/.../f/...`, title shows "N chunks").
  For skeleton-enabled collections, a real bug was found and fixed here — see
  regression #4 below — since nearly every real markdown file in this
  project's collections (`Курсова робота`, `nodejs-basics`) has at least one
  section, which made the whole-file view almost unreachable from the sidebar
  before the fix.
- **Section view**: clicked a real section node (`SELECT.md` → "Запит 2.") —
  opens correctly (`#/c/.../n/...`, title "sql/SELECT.md — 3 chunks", 3 chunk
  cards, active row highlighted). Content is genuinely readable: retrieval
  context breadcrumbs, section-path annotations, structural node-type badges
  with icons all render as intended.
- **Search**: ran a real query against `nodejs-basics` — response payload
  confirmed `window: 0`, no `windowChunks`/nearby-context markup anywhere in
  the rendered cards, rank/score-bar (hidden by default)/source
  file/chunk-index/section/node-type-badge/open-button all present, a
  `code_block` result correctly shows the code icon. Clicking "open" correctly
  navigated to the file view at the matched chunk.
- **Collection header**: `Курсова робота`'s header shows name, health badge
  ("healthy"), settings button, and (after Phase 3C's `description` bug fix)
  the compact secondary row `bge-m3-onnx · aapot/bge-m3-onnx · 1024d ·
  hybrid` — confirmed against live data, not just a stub. Settings button is
  present but visually secondary, matching the brief.
- **Job chip + indexing progress**: triggered two real indexing jobs via
  `POST /api/jobs/index` (one tiny, one larger with real ONNX embedding) against
  scratch collections. Confirmed live via Win32 `MainWindowHandle` inspection
  that the spawned indexer child process had **no window handle at all** while
  actively running. Confirmed the job-chip's `<details>`-preservation and
  route-reachability behavior. Found and fixed a real chip-visibility bug (see
  below).
- **Windows console flash — indexing job spawn**: confirmed directly (not
  inferred) — while a real indexer child process was running
  (`node src/indexer/index.js ...`, spawned by `registry.js` with
  `windowsHide: true`), `Get-Process -Id <pid> | Select MainWindowHandle`
  returned `0` (no window at all). This is the strongest possible evidence
  short of a human's eyes on a real desktop: the process genuinely has no
  window to flash.
- **Windows console flash — folder picker**: **could not be completed
  end-to-end**. Clicking "Choose folder…" spawns a real `powershell.exe -STA`
  process running a `System.Windows.Forms.FolderBrowserDialog` — this
  requires an interactive desktop session to render and be clicked through,
  which this automation environment does not have (no real user-facing
  desktop for the dialog to appear on). The request hung (button stuck on
  "Choosing…") for longer than this session could productively wait; no
  `powershell.exe` process matching the picker script was found running
  server-side afterward, and the admin server logged no error, so the hang is
  most likely in the OS-level dialog/session-attach step itself, not a bug in
  `folder-picker.js`. This exact limitation was already flagged in the Phase
  3C report and remains open — **a human with a real Windows desktop session
  must click through this once** to confirm no console flash for the picker
  specifically. The `windowsHide: true` fix itself is unit-tested at the
  spawn-args level and is Node's documented mechanism for suppressing a
  spawned process's console window without affecting GUI windows it opens.

## Regressions found and fixed

### 1. Stale file/section content survives browser Back to a bare collection route

**Symptom** (confirmed live): open a section (e.g. `Курсова робота` →
`sql/SELECT.md` → "Запит 2."), then press browser Back. The URL correctly
returns to `#/c/Курсова робота`, but the previous section's 3 chunk cards
stayed on screen indefinitely — the sidebar even still showed "Запит 2." as
the active row.

**Root cause**: `router.js`'s bare-collection-route branch only clears
`#collection-content` as a side effect of `syncSearchStateFromUrl()` actually
running a real search (`runSearch()` calls `hideCollectionContent()`) — but
that function is a no-op whenever the URL has no `?q=` at all, which is
exactly the case on a plain "back to the collection" navigation. The "return
to a query-less bare collection" case was never explicitly handled.

**Fix**: [src/admin/ui-src/router.js](../src/admin/ui-src/router.js) — call
`hideCollectionContent()` directly in the bare-collection branch when there is
no `?q=` in the route, before `syncSearchStateFromUrl()` runs.

**Test**: `tests/unit/admin/ui-router.test.js` — new regression test
(`route() end-to-end: returning to a bare (query-less) collection route from
an open section`), confirmed to fail without the fix and pass with it.

### 2. Search results/query leak across a collection switch

**Symptom** (confirmed live, screenshot-verified): search `nodejs-basics` for
"модулі та експорт коду", then click a different collection
(`linux-basics`) in the sidebar. The header correctly updates to
"linux-basics", but the search panel still showed **"SEARCHING IN:
NODEJS-BASICS"** with the old query text and the old (now cross-collection)
result cards still on screen.

**Root cause**: `sidebar.js`'s collection-row click handler sets
`location.hash` (which fires `hashchange` → `route()` **asynchronously**) and
then immediately calls `toggleSidebarTree(name)` → `setExpandedCollection(name)`
**synchronously**, right after. By the time `route()`'s own async
`renderCollection()` ran, `getExpandedCollection()` had already advanced to
the *new* collection name — even though `#main` still held the *old*
collection's shell. `renderCollection()` used
`getExpandedCollection() === name` as its "is this a same-collection
re-render" check, so a genuine collection switch was misdetected as
"already on this collection," and the shell reset (which includes
`initSearchPanel()`, the only thing that clears the query input and
`#search-results`) was skipped entirely.

**Fix**: [src/admin/ui-src/collection-view.js](../src/admin/ui-src/collection-view.js)
— added a new module-local `renderedCollectionName` variable that tracks
which collection's shell is *actually mounted in `#main`* (set only inside
`renderCollection()` itself, reset to `null` in `renderOverview()`),
independent of the sidebar's `getExpandedCollection()` UI state. The
same-collection check now uses this instead.

**Test**: `tests/unit/admin/ui-router.test.js` — new regression test
(`route() end-to-end: switching collections via two sequential route()
calls`) that reproduces the exact race by driving `setExpandedCollection()`
synchronously ahead of `route()`, matching what `sidebar.js` actually does.
Confirmed to fail without the fix and pass with it.

### 3. Topbar job chip never actually hides (CSS cascade bug)

**Symptom** (confirmed live via `getComputedStyle`): with zero active jobs,
`document.getElementById('job-chip').hidden` correctly reads `true` and the
`hidden=""` attribute is present in the DOM — but `getComputedStyle(chip).display`
was `"flex"`, not `"none"`. The chip was never visually hidden; it just looked
inconspicuous when empty (zero text content, so an easy-to-miss empty pill),
while still occupying interactive DOM space.

**Root cause**: `.job-chip { display: flex; ... }` in `app.css` sets `display`
unconditionally. A same-specificity class selector loaded after the browser's
own UA stylesheet overrides the default `[hidden] { display: none }` rule, so
setting the `hidden` property/attribute from JS had no visual effect at all
for this element.

**Fix**: [src/admin/ui-src/app.css](../src/admin/ui-src/app.css) — added
`.job-chip[hidden] { display: none; }`. While auditing for the same pattern,
found and fixed an identical (currently harmless, since the element collapses
to zero height when empty of children) instance on `.q-recent` (search.js's
recent-searches chip row, from Phase 3B) — added `.q-recent[hidden] { display:
none; }` too. No other `hidden`-toggled element in the codebase shares this
bug (audited every `.hidden = ` call site in `ui-src/*.js` against every
`display:`-setting CSS selector).

**Test**: source-level assertions in `tests/unit/admin/ui-topbar.test.js` and
`tests/unit/admin/ui-search.test.js` confirming both `[hidden]` override rules
exist in `app.css`.

### 4. Sidebar: a file with sections could never be opened directly — only expanded

**Symptom** (confirmed live against `Курсова робота`): every real file in a
skeleton-enabled collection here has at least one section (any markdown
heading creates one). Clicking a file row in the sidebar only expanded/
collapsed its sections — it never opened the file's own chunk view. Since
essentially no file in this project's real skeleton collections has zero
sections, "click a file, see its chunks" was effectively unreachable from the
sidebar for skeleton collections; only individual sections could be opened.

**Root cause**: `sidebarNodeRow()`/`onSidebarNodeClick()` used a single click
target (the whole row) for two different actions on a file-with-children:
opening it, and expanding it — with the expand behavior always winning
(`node.nodeType === 'file' && !(node.childCount > 0)` was the *only* branch
that opened a file; anything with `childCount > 0` fell through to the same
expand/collapse code path used for directories).

**Fix**: [src/admin/ui-src/sidebar.js](../src/admin/ui-src/sidebar.js) — split
the caret into its own independent click/keyboard target
(`data-caret` attribute, `role="button"`, `tabindex="0"`, with
`stopPropagation()` so it never also fires the row's own handler):
- **Caret click** → `onSidebarCaretClick()` → always just expands/collapses
  (directories and files-with-sections alike).
- **Row-body click** → `onSidebarNodeClick()` → a file now *always* opens
  (`#/c/:name/f/:sourceFile`) regardless of `childCount`; a directory still
  expands (directories have no separate "open" action, so no split was needed
  there — confirmed via a dedicated test, see below); a section still opens
  the section view, unchanged.

The caret only renders as a clickable target (`data-caret`) when there's
actually something to expand (`directory`, or `file` with `childCount > 0`);
a leaf file's caret stays a plain, non-interactive glyph, matching its
existing `visibility: hidden` treatment. Added `.tree-caret[data-caret]`
hover/focus-visible styling and a slightly larger padded hit area (a bare
12px glyph is too small a mouse target) in
[src/admin/ui-src/app.css](../src/admin/ui-src/app.css).

**Live verification**: against `Курсова робота` → `sql/SELECT.md` (a real
file with 3 sections) — a row-body click now opens
`#/c/Курсова робота/f/sql%2FSELECT.md` directly, title "sql/SELECT.md — 3
chunks", all 3 chunks render. A subsequent caret click on the same row (while
the file view stays open, URL unchanged) expands the section list inline
("4.2 Запити на вибірку даних (SELECT)", "Запит 2.", "Запит 3."), so both
actions — open the file, browse its sections — are now independently
reachable from the same row.

**Test**: `tests/unit/admin/ui-sidebar.test.js` — five new tests exercising
the actual click-wiring (not just source-text regexes) via a new
`loadSidebarNodeInteractionHelpers()` test helper that drives real DOM click
events against `renderSidebarSkeletonLevel()`'s production render+wiring
path: row click on a file-with-sections navigates to the file route without
also expanding; caret click on the same file expands without navigating; a
childless file renders no clickable caret at all; a directory's caret still
expands (regression guard); a directory's row-body click still expands too
(directories intentionally have no split, since they have nothing to
"open"). Three of the five were confirmed to fail against the pre-fix
`sidebar.js`. `tests/unit/admin/ui-accessibility.test.js` was updated (not
weakened) to also require the new caret's own `:focus-visible` rule.

**Known a11y debt (flagged in code review, not blocking)**: the fix nests a
`role="button"` `<span>` (the caret) inside a `role="button"` `<div>` (the
row) — invalid ARIA nesting (interactive roles must not nest). Works
correctly today for mouse, keyboard, and this task's tests, since the
caret's own click/keydown handlers call `stopPropagation()` before the row's
handler runs, but a screen reader may announce the nested roles oddly. A
future UI cleanup should restructure the row as a non-interactive container
holding two real sibling controls (an expand `<button>` + the file/section
action) instead of one interactive role wrapping another. Documented inline
at [src/admin/ui-src/sidebar.js](../src/admin/ui-src/sidebar.js)'s
`sidebarNodeRow()`.

## What was NOT implemented (per task's explicit scope)

Ask/chat tab, cloud provider/API key settings, Qdrant snapshots UI,
alias-based reindex, image lightbox, stitched file view, fake future
capability buttons — none of these exist in the codebase and none were added.

## Tests

All new/changed behavior has dedicated automated coverage:

- `tests/unit/admin/ui-router.test.js` — two new end-to-end regression tests
  (stale-content-on-back, stale-search-on-collection-switch), each verified to
  fail without its corresponding fix.
- `tests/unit/admin/ui-topbar.test.js` — new CSS-cascade regression test for
  `.job-chip[hidden]`.
- `tests/unit/admin/ui-search.test.js` — new CSS-cascade regression test for
  `.q-recent[hidden]`.
- `tests/unit/admin/ui-sidebar.test.js` — five new tests for the caret/row
  click split (regression #4), three confirmed to fail without the fix.
- `tests/unit/admin/ui-accessibility.test.js` — updated (not weakened) to also
  require the new caret's `:focus-visible` rule.

**Result: 667/667 unit tests passing, 1293/1293 smoke tests passing,
`npm run admin:build` clean, `git diff --check` clean, `node --check` clean on
every changed JS file.**

## Remaining known limitations

- **Folder-picker console-flash cannot be confirmed by automation in this
  environment** — requires a human with a real interactive Windows desktop
  session to click "Choose folder…" and visually confirm (a) no console
  window flashes and (b) the picker dialog itself appears normally. The
  `windowsHide: true` fix is in place and unit-tested, and the *indexing job*
  spawn path (the other `windowsHide` call site) was confirmed live via Win32
  window-handle inspection to have zero window — giving reasonable confidence
  the picker path behaves the same way, but this is inference, not direct
  observation of that specific spawn.
- **Auto-commit anomaly** (not part of this task's scope, flagged for
  visibility): `git log` shows a commit
  (`cb174e9 feat: Implement inline SVG icon system and integrate into admin
  UI`) that bundles prior Phase 3C work, which was never created via an
  explicit `git commit` in this session. This is a recurring, previously
  unresolved anomaly noted across earlier phases of this project — not
  investigated further here since it's outside this task's scope, but worth
  the user's attention.
