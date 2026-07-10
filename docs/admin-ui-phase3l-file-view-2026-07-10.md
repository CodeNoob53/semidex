# Admin UI Phase 3L — File View Opens Whole File Chunks

2026-07-10

## What was broken

Nothing, as of this phase. The task described a real UX problem — "clicking
a file often shows an empty/summary-like view instead of the file's indexed
chunks" — but a direct read of the current `src/admin/ui-src/sidebar.js`
and `src/admin/ui-src/file-view.js`, followed by an audit of the existing
test suite, confirmed this was already fully fixed in **Phase 3F** (whole-
file mode via the `getFileChunks` backend primitive) and **Phase 3D**
(the row-body-vs-caret click split that lets a file with sections still
open directly on a row click). Every one of this task's 7 numbered
requirements was already correctly implemented:

1. File click opens the file view, shows chunks, works with or without
   sections, never requires selecting a section first —
   `onSidebarNodeClick()` (`sidebar.js:242-260`) routes a file-type node to
   `#/c/:name/f/:sourceFile` on row-body click regardless of `childCount`;
   the caret is a separate click target for expand/collapse only.
2. Section click still opens the section-focused view, unregressed —
   `openSectionView()` in `file-view.js` (Phase 3F/3H's exact node_path
   matching + anchor-resolution fallback) is untouched.
3. Chunk rendering reuses the existing `tpl-chunk-card` template
   (`renderFileChunks()`), shows all chunks or a sensible first page
   (`FILE_PAGE_SIZE = 5` with "load more"), never fakes placeholder
   content, and structurally cannot render a skeleton-nav summary as a
   content chunk (see "Nav-exclusion" below).
4. Active state distinguishes file vs. section routes — `markActive()`
   (`sidebar.js:269-286`) clears `.tree-file`/`.tree-node` active state on
   every route change and re-applies it only to the row matching
   `route.openFile` (file) or `route.openNodePath` (section), never both.
5. Empty state shows a clear, non-technical message — *"No searchable
   chunks in this file. It may only contain navigation/metadata or
   unsupported content."* (a more informative variant of the task's
   suggested wording, kept as-is rather than regressed to the shorter
   literal string) — and never silently falls back to chunk 0.
6. Routing goes entirely through the existing hash system
   (`#/c/:name/f/:sourceFile`, `#/c/:name/n/:nodePath`) — no second route
   system exists or was introduced.
7. Uses exactly the endpoint the task names —
   `GET /api/collections/:name/chunks?sourceFile=...` — which already
   supports whole-file mode (an omitted `chunkIndex` triggers
   `adapter.getFileChunks()` instead of the windowed `adapter.getChunk()`,
   per `src/admin/api/chunks.js`). No `qdrant_get_node`/MCP logic exists
   anywhere in the admin UI.

Re-implementing any of this would have been pure churn against an already-
correct system. This phase's actual work was narrower: confirming the
above via direct code reading (not assuming the task's problem description
was still accurate), then closing two real gaps in *test coverage* found
during that audit — the implementation itself needed no changes.

## What changed

**No source code changes.** Two test-coverage gaps were found and closed:

1. **Section-row-click → hash navigation had no direct simulated-click
   test.** It was covered indirectly (route-parsing tests in
   `ui-router.test.js`, and `openSectionView()`'s own rendering tests in
   `ui-file-view.test.js`), but no test simulated an actual click on a
   `.tree-node` (section) row and asserted the resulting
   `location.hash`. Added `'row click on a section node navigates to the
   section route, not an expand'` in `ui-sidebar.test.js`, matching the
   existing pattern used for the equivalent file-row-click test.
2. **No render-layer test proving skeleton-nav points can't leak into
   file-view chunk cards.** The actual exclusion happens two layers below
   the UI — server-side (`withNavExcluded` in `store.js`'s
   `getFileChunks`/`fetchWindowChunks`, already tested in
   `qdrant-store-nav-exclusion.test.js`) and at the adapter boundary
   (`toChunk()` in `qdrant-adapter.js` never carries `point_kind` through
   to the domain `Chunk` shape at all — confirmed by direct read of that
   file's own header comment: *"Callers above this layer... must never see
   point_kind, node_type snake_case fields"*). `renderFileChunks()`
   therefore has no nav-awareness of its own — there's no field for it to
   check, by design. Added a test that feeds an adversarial chunk object
   (with a `point_kind: 'skeleton_nav'` field grafted on, as if a raw
   payload had somehow leaked past the adapter unmapped) into
   `renderFileChunks()` and confirms the field never surfaces in the
   rendered output — a contract test proving the render layer trusts and
   correctly passes through whatever it's given, not that it does its own
   (redundant, and therefore a second place to get wrong) filtering.

Both new tests live in the same describe-block style and file as their
closest existing siblings (`ui-sidebar.test.js`, `ui-file-view.test.js`) —
no new test infrastructure was needed.

## API route/endpoint used

`GET /api/collections/:name/chunks?sourceFile=...` (no `chunkIndex`) —
unchanged from Phase 3F, confirmed still correctly wired through
`adapter.getFileChunks()` → `store.getFileChunks()`, which exhaustively
paginates (`scrollAllFiltered`, not a single-page `scroll()`) and excludes
nav points both server-side (`withNavExcluded`) and defensively
client-side within `store.js` (`isNavPoint`).

## Tests

- `tests/unit/admin/ui-sidebar.test.js` — 1 new test (section-row-click →
  hash navigation), verified via a temporary source revert to confirm it
  correctly fails against broken routing before restoring.
- `tests/unit/admin/ui-file-view.test.js` — 2 new tests (adversarial
  chunk-object rendering never leaks a raw field; a source-level
  cross-reference confirming `openFileView`'s whole-file fetch actually
  goes through the same `/chunks` endpoint the nav-exclusion tests cover,
  so the two test files' guarantees compose into one real end-to-end
  chain rather than two isolated claims).
- All 8 of the task's originally-requested test scenarios were checked
  against the existing suite first (via a research pass): 6 were already
  fully covered (file click routes correctly; file-with-sections opens on
  row click, not caret; caret expands without navigating; whole-file mode
  omits `chunkIndex` entirely; empty-file message is clear and
  non-technical; active state distinguishes file vs. section routes), and
  the 2 genuine gaps (section-row-click, nav-exclusion at the render
  layer) are what this phase added.

## Verification run

- `npm test` — 751/751 passing (748 baseline + 3 new).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings; the
  changed-files list is test-only — `ui-sidebar.test.js`,
  `ui-file-view.test.js` — confirming no source code needed to change).
- Live Playwright verification against the real Qdrant Cloud instance
  (`Курсова робота` / `sql/Звіт.md`, a file with sections):
  - Clicking the file row body directly opened the whole-file view
    immediately — `#/f/sql%2FЗвіт.md`, "7 chunks" badge, 5 chunks on the
    first page — with no section click required first, confirming the
    exact scenario this task's acceptance criteria describes.
  - Clicking a section afterward (`Запит 15.`) correctly opened the exact
    section match — `#/n/sql%2FЗвіт.md%23...`, 3 chunks (not the file's
    full 7), correct active-state node, no regression from the file-click
    test just before it.
  - No console/page errors during either navigation.

## Limitations / follow-ups

None identified. This phase's audit-first approach (verify against the
task's literal claims before writing any code) confirmed the described
problem no longer exists in the current codebase — the remaining value was
closing two real test-coverage gaps, both now closed.
