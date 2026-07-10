# Admin UI Phase 3F — File/Section Reader + Sidebar Navigation Polish

2026-07-10

## Goal

Make the collection sidebar and file/section reader feel like a usable
knowledge browser: expand a collection tree, click a file and see its
chunks, click a section and see its relevant chunks, and be able to tell
folders/files/sections apart at a glance.

## What changed

### 1. File view now renders file chunks without requiring a section click

**New primitive**: `getFileChunks(collection, sourceFile)` in
`src/core/qdrant/store.js` — an exhaustive, nav-excluded, `chunkIndex`-sorted
scroll of every content chunk belonging to one file. Exposed through
`src/core/storage/qdrant-adapter.js`'s `getFileChunks(name, sourceFile)` and
added to the `StorageAdapter` contract
(`src/core/storage/adapter.js`'s `REQUIRED_ADAPTER_METHODS`).

**API shape**: `GET /api/collections/:name/chunks?sourceFile=...` — the
existing `chunkIndex` query param is now *optional*. When present, behavior
is unchanged (a windowed fetch of `chunkIndex ± window` around one target
chunk — the existing "jump to this part of the file" primitive). When
absent, the endpoint switches to whole-file mode and returns every chunk in
the file via the new `getFileChunks`. This is additive — no existing caller
of the windowed shape needed to change, and no Qdrant-specific concept
(`point_kind`, `parent_id`, etc.) leaked into the response or the UI layer.

**UI**: `src/admin/ui-src/file-view.js`'s `openFileView()` now branches on
whether a `chunkIndex` was given. A plain sidebar file click calls it with
no `chunkIndex` → whole-file mode: fetch every chunk once, then page through
it client-side 5 at a time ("load more" reveals from memory, no re-fetch),
mirroring the existing search-results "Show more" pattern for a consistent
feel. A section click still resolves through `/skeleton/anchor` to one
target `chunkIndex` and opens windowed mode as before.

### 2. Section view renders the correct anchored chunk, not chunk 0

This requirement was **already correctly implemented** before this phase —
verified by reading `getSectionAnchor()` → `getFirstContentChunkByParent()`
in `store.js`, which filters by `parent_id`, excludes nav points, and picks
the *minimum* `chunk_index` among the section's real children. No backend
change was needed here.

The gap was visual: a windowed fetch returns several neighboring chunks, and
nothing distinguished which one was "the" resolved target. Fixed by adding
a `.chunk-target` CSS class (subtle amber left-border, not a background
wash) to the matching chunk card, plus an auto-scroll-into-view on open.
Live-verified against `Курсова робота`'s `sql/Звіт.md`: clicking section
"Запит 15." correctly opens `chunk 1 / 7` (skipping the file's intro
paragraph at chunk 0) with the target visibly highlighted and scrolled into
view — see verification section below.

### 3. Real bug fix: `fetchWindowChunks` was missing nav-point exclusion

Found while auditing the windowed-fetch code path: every other
content-facing scroll in `store.js` wraps its filter in `withNavExcluded()`
except `fetchWindowChunks` (the function backing the windowed `/chunks`
endpoint). This meant a windowed file/section open could have silently
included `skeleton_nav` points alongside real content. Fixed by wrapping its
filter the same way as `getFirstContentChunkByParent` and the new
`getFileChunks`. Covered by a new regression test
(`tests/unit/core/qdrant-store-nav-exclusion.test.js`), verified via a
revert/re-test cycle to confirm the test fails against the pre-fix code.

### 4. Sidebar navigation polish — verified, not rebuilt

Per the task's explicit "this is not a full redesign" instruction, did a
verify-first pass rather than touching CSS/markup speculatively. Live
Playwright review against real collections (`nodejs-basics`'s long Ukrainian
directory names, `Курсова робота`'s nested file/section tree) confirmed
everything requirement 3 asks for is already in place from Phases 3C/3D:

- Distinct inline-SVG icons per node type (collection/directory/file/section),
  with icon color brightening on hover/active (`.tree-row.active .tree-icon`).
- Consistent 14px-per-depth-level indentation (measured via
  `getComputedStyle`: collection 8px → directory 22px → file 36px →
  section 50px).
- Truncation with `text-overflow: ellipsis` plus a full descriptive `title`
  tooltip (verified against genuinely long real labels like "Тема 10.
  Stateful аутентифікація. Управління сесіями та файлами cookie").
- Active-row and hover states clearly visible (amber left-border + icon
  color shift).

No sidebar code changes were made in this phase — the existing
implementation already satisfies the requirement.

### 5. Reader UI — verified, not rebuilt

Reviewed `renderFileChunks()`'s output (`tpl-chunk-card` template) against
requirement 4's checklist: chunk number/total (`chunk N / total`), section
path label, node-type badge with icon for structural types
(table/code/checklist), content text in a single `<pre>`, and a labeled
context line that switches between "section path" (prose chunks) and
"retrieval context" (structural chunks) so the two never look like
duplicate content. The template is a single flat `.chunk` div — no nested
cards, no metadata dump, no Qdrant vocabulary surfaced. No changes needed.

## Tests

- `tests/unit/core/qdrant-store-nav-exclusion.test.js` (new) —
  `fetchWindowChunks` wraps its filter in `withNavExcluded`;
  `getFileChunks` is exhaustively paginated and excludes nav points both
  server- and client-side.
- `tests/unit/core/storage/qdrant-adapter.test.js` — `getFileChunks` calls
  `store.getFileChunks` (not `fetchWindowChunks`) and maps every point
  through `toChunk`.
- `tests/unit/core/qdrant-adapter.test.js` — facade re-export surface
  includes `getFileChunks`.
- `tests/unit/admin/server.test.js` — omitting `chunkIndex` switches to
  whole-file mode (not a 400); whole-file mode never calls the windowed
  `getChunk`; an explicit `chunkIndex` still uses `getChunk`, not
  `getFileChunks`.
- `tests/unit/admin/ui-file-view.test.js` — 10 new tests covering
  whole-file mode (no params sent, pagination at 5, load-more reveals from
  memory with zero extra fetches, empty state, per-file state reset),
  explicit-`chunkIndex` target highlighting, and the "Open file from start"
  404 fallback.
- Stub adapters updated with `getFileChunks` in every hand-rolled test
  double (`ui-test-helpers.js`, `jobs.test.js`, `search.test.js`,
  `server.test.js`, `system.test.js`) to keep the adapter contract
  consistent.

All new tests were verified to fail against pre-fix code before the fix
landed (revert/re-test/restore cycle), not just written and left unverified.

## Verification run

- `npm test` — 712/712 passing.
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build, no sandbox/esbuild issues.
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings, no
  actual whitespace errors).
- Live Playwright pass against the real Qdrant Cloud instance
  (`Курсова робота`, `nodejs-basics`, `bench-structural-carryover`
  collections):
  - Whole-file mode: clicking `sql/SELECT.md` (3 chunks) fetches
    `GET /chunks?sourceFile=...` with no `chunkIndex`/`window` params,
    renders all 3 chunks, no spurious "load more" button.
  - Section-anchor mode: clicking section "Запит 15." under
    `sql/Звіт.md` resolves to `chunk 1 / 7` (correctly skipping the file's
    chunk-0 intro paragraph), highlights it with `.chunk-target`, and
    scrolls it into the viewport — confirmed via
    `getBoundingClientRect()`-based in-viewport check and a full-page
    screenshot.
  - Structural chunk rendering (a `code_block` inside the same section)
    correctly shows the "RETRIEVAL CONTEXT:" label distinct from the
    "SECTION PATH:" label used on prose chunks, confirming no
    duplicate-looking context/content rendering.
  - Search panel regression check: no Advanced block, no TOP selector, no
    score checkbox reintroduced; panel unaffected by file-view changes.

## Remaining limitations

- No stitched/full-document view — only the existing chunked view exists,
  per the task's explicit "implement only chunked now" instruction (carried
  over from Phase 3C's scope decision, unchanged in this phase).
- Whole-file mode fetches the entire file's chunk list in one request; for
  a very large file this is one bigger request instead of several small
  windowed ones. This trade-off was chosen deliberately (matches the task's
  "add a minimal endpoint... to list chunks for a sourceFile" instruction
  and the existing search.js "fetch once, page client-side" pattern) but is
  worth watching if a collection ever has an outlier-sized single file.
- Sidebar and reader UI polish requirements (3 and 4) needed no code
  changes — they were already satisfied by Phase 3C/3D work. This phase's
  contribution there is verification evidence, not new implementation.
