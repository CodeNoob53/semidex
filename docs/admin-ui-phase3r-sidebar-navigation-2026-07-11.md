# Admin UI Phase 3R — Sidebar Navigation / File Tree UX

2026-07-11

## What changed

An audit against the task's stated pain points found the sidebar much
further along than the task text implies — meaningful labels, distinct
node-type icons, correct file/section click routing, and direct-click
active-state tracking were all already implemented from Phases 2E, 3A, 3C,
3D, 3H, and 3L. The genuine gap was narrower: **opening a file from a
search result never updated the sidebar's selection or revealed it in the
tree**, and a related small density tweak.

### Search-result-open now syncs the sidebar (the real gap)

`search.js`'s "Open chunk"/"Open file section" button called
`openFileView()` directly, with no `location.hash` update at all. A direct
sidebar click gets sidebar sync for free (it sets the hash, which fires
`hashchange` → `route()` → `markActive()`), but this button bypassed that
entire path — the sidebar silently kept showing whichever row (if any) was
active before the search, or nothing at all.

Fixed with a new `openResultInFileView()` in `search.js`:
- Updates the URL via `history.pushState` (not `location.hash =`, which
  would fire a real `hashchange` and recursively re-run `route()`, re-
  opening the same view a second time — the same reasoning already used by
  the existing `updateSearchUrl()` for query-string updates).
- Calls the new `revealSidebarPath()` (see below) to expand whatever
  collapsed ancestor folders stand between the tree root and the target
  file.
- Calls `markActive()` directly, mirroring the targeted sync `router.js`'s
  own second `markActive()` call performs once the sidebar tree settles.

### `revealSidebarPath()` — minimal expand-to-reveal (new)

`markActive()` alone only toggles `.active` on rows already present in the
DOM — it cannot reveal a file buried inside a directory the user never
manually expanded, which a search result commonly is. Live-testing the
`markActive()`-only fix against a real collection (`Курсова робота`)
confirmed exactly this: opening a result inside the collapsed `analysis`
folder left zero active rows, even though the hash was correct.

New `sidebar.js` export `revealSidebarPath(name, sourceFile)`: splits
`sourceFile` into its directory segments, and expands each collapsed
ancestor directory row in turn (fetching real `/skeleton/children` at each
level — never guessed/skipped, since which nodes exist under a given
ancestor is only known once that level is actually fetched). Directory
`node_path` follows the indexer's own fixed convention
(`"<collection>#dir/<dirPath>"`, `skeleton-index.js`), so the ancestor
chain's expected paths are derivable purely from `sourceFile`'s own
segments — no extra API round-trip needed just to discover the chain
itself. A file at the collection root (no directory segments) is a no-op.
If an ancestor isn't found in the currently-rendered level (e.g. the
collection's own tree was never expanded at all), it gives up quietly —
best-effort, no error UI, matching the task's "minimal expansion" framing
rather than a guaranteed-complete navigation feature.

`markActive()` also gained a second lookup: `route.openFile` now matches
either a flat-fallback-mode `.tree-file[data-sf=...]` row OR a skeleton
tree's own `.tree-node[data-path="<sourceFile>#file"]` row (the indexer's
file-node-path convention, same derivation as above). Before this, a plain
file-route open (`#/c/:name/f/:file`, used by both `revealSidebarPath`'s
target and any other bare file open) could never highlight anything in a
skeleton-nav collection's tree at all — only `route.openNodePath` (section
opens) had a working `.tree-node` match.

### Row density (small, isolated tweak)

`.tree-row`'s vertical padding increased from `5px` to `7px` — the task
explicitly permitted "increase clickable row height just enough for
comfort" as a small, isolated change, not a layout-infrastructure change.
Indentation math (`--depth`), the resizable sidebar width, and the icon
column were all left untouched.

## What was already implemented and preserved (audited, not changed)

- **Meaningful labels** (`format.js`'s `nodeDisplayLabel()`, from an
  earlier phase): file → basename of `sourceFile`; section → last
  `headingPath` entry, falling back to `summary`/`nodePath`; directory →
  last path segment — exactly the priority order Phase 3R's requirement 1
  asks for. No generic "file" labels were found live against a real
  skeleton-nav collection.
- **Node-type icons** (`icons.js`, from Phase 3C): a small, hand-authored,
  centralized inline-SVG icon set (Feather/Lucide-style strokes, not
  emoji, not a new dependency) — already the exact implementation choice
  the task's requirement 2 asks for. Already covers
  collection/directory/file/section/table/code_block/checklist, each with
  its own `data-icon` attribute for test assertions.
- **File click opens whole-file view, section click opens exact section**
  (`sidebar.js`'s `onSidebarNodeClick`, from Phase 3D/3H/3L): a file row
  click always opens the whole-file view via the hash route (not chunk 0
  only, not the caret's job); a section row click routes to the exact
  section view. The caret is a separate click target for expand/collapse,
  so a file-with-sections can still be opened directly. No changes needed;
  confirmed still correct via the full existing `ui-file-view.test.js`
  suite (35 tests, untouched this phase) and live-verified against a real
  file with 9 chunks.
- **Active state for direct sidebar navigation** (`markActive()`, from
  Phase 3A, extended this phase): a direct file/section click already
  highlighted the correct row before this phase — only the
  search-result-open path and the skeleton-file-node match were gaps.
- **Skeleton-first, no separate panel** (`loadSidebarTree()`, from Phase
  2E/3H): the sidebar already uses the skeleton as the tree source when
  `hasSkeleton` is true, falling back to a flat file list otherwise —
  skeleton was never rendered as a separate main-panel feature.
- **No debug fields as visible labels**: audited all of `sidebar.js` for
  `node_id`/`node_path`/`parent_id`/`point_kind`/raw payload keys as
  visible text — none found. `nodePath` appears only inside the row's
  `title` tooltip (a hover detail for power users, alongside `summary`),
  never as the label itself — already covered by an existing test
  ("sidebarNodeRow keeps node_path and summary in the tooltip only").
- **Resizable sidebar** (`sidebar-resize.js`, from an earlier phase): left
  completely untouched, per the task's explicit instruction not to
  implement/change resize infrastructure in this task.

## Label fallback rules (unchanged, confirmed correct)

From `format.js`'s `nodeDisplayLabel()`:
- **file**: `basename(sourceFile)` → `shortLabel(nodePath or nodeId)` if
  `sourceFile` is missing.
- **section**: last entry of `headingPath` → `shortLabel(summary)` →
  `shortLabel(nodePath or nodeId)`.
- **directory**: last segment of the directory's own path (stripped of the
  `"<collection>#dir/"` prefix) → `shortLabel(nodePath or nodeId)`.
- **anything else**: `shortLabel(nodePath or nodeId)`.

`shortLabel()` truncates to 46 characters with an ellipsis and strips any
`"collection#"` prefix; the full untruncated value is always still present
via the row's `title` attribute.

## Tests

New tests, all on rendered DOM/behavior (not source-regex where avoidable):

**`tests/unit/admin/ui-sidebar.test.js`** (+6):
1. `markActive()` highlights a skeleton tree's own `.tree-node` file row
   (`data-path="<sourceFile>#file"`) matching `route.openFile`.
2. Does not cross-highlight an unrelated file's skeleton row.
3. `revealSidebarPath()` expands a single collapsed ancestor directory and
   leaves the file row present in the DOM.
4. `revealSidebarPath()` is a no-op for a file at the collection root (no
   directory segments to expand).
5. `revealSidebarPath()` gives up quietly (no throw) when an ancestor isn't
   present in the currently-rendered tree level.
6. `.tree-row`'s vertical padding is at least 7px (density regression
   guard).

**`tests/unit/admin/ui-search.test.js`** (+2):
1. Clicking a result's open button updates the URL hash to the file route
   and calls `markActive()`.
2. Opening a result pushes exactly one history entry, not zero and not
   several.

**`tests/unit/admin/ui-test-helpers.js`**: `loadSearchRenderHelpers()`
needed two new stubs for `search.js`'s newly-added imports —
`__markActiveImpl` (already added, then reused) and
`__revealSidebarPathImpl` (default a no-op async function) — same pattern
as the existing `__openFileViewImpl` caller-injectable stub.

All pre-existing tests pass unchanged: `ui-sidebar.test.js` (35 baseline),
`ui-search.test.js` (74 baseline), `ui-file-view.test.js` (35, untouched
this phase, file/section click behavior unchanged), `ui-collection-view.test.js`
(37, unaffected), `ui-icons.test.js` (9, icon system unchanged).

## Verification run

- `npm test` — 783/783 passing (775 baseline-before-this-session-continued
  + 8 new).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings); files
  touched: `app.css`, `search.js`, `sidebar.js`, and 3 test files —
  frontend + test only, no backend/API files, no new dependencies.
- Live Playwright verification against the real Qdrant Cloud instance
  (`Курсова робота`, a skeleton-nav collection with Cyrillic folder/file
  names):
  - **Tree labels**: sampled 8 rows across folders and a root-level file —
    zero generic "file" labels; every row showed its real name
    (`access`, `analysis`, `00_INDEX.md`, etc.).
  - **Direct file click**: clicked `access/Права_доступу.md` — the row got
    `.active`, the header showed "9 chunks" (not silently chunk 0), the
    hash updated correctly, and the folder + file rows were both visibly
    highlighted in the screenshot.
  - **Search-result-open sidebar sync** (the core fix): searched
    "database", clicked "Open" on a result inside the collapsed `analysis`
    folder — before the fix, this left 0 active sidebar rows; after the
    fix, the `analysis` folder auto-expanded and
    `analysis/Користувачі_БД.md#file` was correctly highlighted (confirmed
    both via DOM query and visually in a screenshot).
  - No console/page errors throughout.

## Known limitations

- `revealSidebarPath()` only expands directory ancestors — it does not
  currently reveal a **section** nested inside a file that itself needs
  its parent directories expanded (a search result opening a specific
  chunk uses `openFileView` in windowed mode with `chunkIndex`, which
  routes through `#/c/:name/f/:file`, i.e. `route.openFile`, not
  `route.openNodePath` — so this is consistent with what actually gets
  opened today, not a gap in the fix itself, but worth noting if a future
  phase adds a "jump to section from search" entry point that uses the
  `/n/` route instead).
- Best-effort only: if a collection's sidebar tree was never expanded at
  all (the top-level `<div class="tree-children">` itself has no rendered
  rows yet), `revealSidebarPath()` finds no ancestor row to start from and
  silently does nothing — in practice this doesn't occur for the search-
  result-open flow, since `initSearchPanel()` only mounts once a collection
  is already selected/expanded in the sidebar.
- The row-height increase (5px → 7px) was a small, deliberately
  conservative tweak — not re-evaluated against every possible sidebar
  width/zoom combination, per the task's framing that this phase is about
  navigation clarity, not a layout-infrastructure pass.
