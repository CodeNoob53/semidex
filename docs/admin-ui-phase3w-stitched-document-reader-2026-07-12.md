# Admin UI Phase 3W — Stitched File/Section Document Reader

The Admin UI file/section view now consumes the Phase 3V assembly API and
renders a continuous document by default: prose reads as one unframed
document, tables/code blocks/checklists appear at their original positions
through the shared structural renderer, placeholder lines are absent, and
the original chunk-card representation remains available as an alternate
"Chunks" reader mode.

## Final UX behavior

- **Reader modes** — a compact `Document | Chunks` segmented control in the
  file-view header (real `<button>`s with `aria-pressed`, tooltips "Read as
  a continuous document" / "Inspect indexed chunks"). Document is the
  default for every file and section open; switching is presentation-only
  (no route/history entry — pinned by a source-level test).
- **Document mode** — assembly segments render in API order, one element
  per segment. Prose is text only (`textContent`, CSS `pre-wrap` preserves
  paragraphs/line breaks; no Markdown parsing this phase), visually
  connected as one document at a 72ch reading measure, never wrapped in
  cards. Entities render through `renderChunkContent()` from
  `structural-renderer.js` — the exact shared implementation chunk cards
  and search results use (real `<table>`, highlighted code with the
  Rendered/Raw toggle, checklist as safe plain text); no second renderer
  exists.
- **Chunk boundaries** — no cards or "chunk N" labels in Document mode.
  Chunk identity stays in the DOM as `data-chunk-index` on every segment,
  visualized only as a subtle 2px gutter marker on hover, stronger (amber)
  on the target segment.
- **Target navigation** — a search-result open locates the assembled
  segment with the matching `chunkIndex`, gives it a restrained
  `.assembly-target` highlight, scrolls it into view, and stays in
  Document mode.
- **Header** — the existing file-view header, extended with the mode
  toggle in its title row. Document mode shows name + source path +
  collection and hides the technical "N chunks" badge; Chunks mode shows
  the real fetched count.
- **Empty section** — a real empty section (200, `segments: []`) and an
  unknown-section 404 both show "This section has no indexed content."
  with an "Open file" action when the source file is known.

## API usage

- File open: `GET /api/collections/:name/assembly?scope=file&sourceFile=…`
- Section open: `GET /api/collections/:name/assembly?scope=section&nodePath=…`
  — exact section identity resolved server-side through the skeleton node
  and `parent_id`. The old client-side chain (whole-file fetch +
  browser-side node_path filtering, `/skeleton/anchor` + windowed
  neighborhood fallback) is **gone from file-view.js entirely** (pinned by
  a source-level test: no `skeleton/anchor`, no `window=3` remain).
- `GET …/chunks?sourceFile=…` is now **lazy**: fetched only the first time
  the user switches an open file/section to Chunks mode, cached on the
  reader state. Document → Chunks → Document → Chunks refetches nothing
  (verified in unit tests AND live via Playwright request counting).
  Section Chunks mode reuses `chunksBelongToSection()` (exact node_path
  lineage) as a client-side filter over the whole-file fetch — alternate
  view only, never the Document path.

## State model, cache, and race safety

Reader state is one module-level object scoped to the currently open
file/section:

```js
{ generation, collection, scope, sourceFile, nodePath,
  targetChunkIndex, mode, assembly, chunks, visibleCount, titleText, node }
```

Every open replaces the object and bumps a module-level `readerGeneration`
counter; every async continuation (assembly fetch, lazy chunks fetch, mode
render) re-checks `isCurrent(state)` after each await. A slow stale
response can never overwrite a newer navigation, and a mode toggle after
navigating away renders nothing — deterministic generation guard, no
timeouts. `assembly` and `chunks` are per-open caches; opening another
file/section discards both (verified: second file gets its own lazy fetch).
Back/Forward routing is unchanged (`route()` → `openFileView`/
`openNodeFromPath` → `openSectionView`); search and reader remain mutually
exclusive surfaces via the existing `hideSearchResults()`/
`hideCollectionContent()` pair.

## Module boundaries

- **`src/admin/ui-src/assembly-view.js`** (new, ~100 lines) — pure DOM
  construction: `renderAssemblySegments()` (segments → `.assembly-doc`,
  target highlight) and `renderAssemblyBanners()`. Imports only `dom.js`
  and `structural-renderer.js`; a test pins that no backend/core module is
  ever imported into browser code.
- **`file-view.js`** — fetching, reader state, mode switching, header,
  open/routing behavior, Chunks-mode rendering (unchanged
  `renderFileChunks()` + five-at-a-time reveal).
- **Templates** (Vite partials, all `<load>`-ed into index.html):
  `assembly-segment.html`, `reader-mode-toggle.html`,
  `assembly-warning.html`. All API-derived values are assigned via
  `textContent`/attributes or the existing safe renderers.

## Assembly warnings

Raw warning objects/codes/node IDs never reach the UI. At most two compact
banners per document, never one per warning:

- `assemblyMode === "placeholder_fallback"` → one banner: *"This document
  was assembled from an older index. Refresh its metadata for the most
  reliable structure."*
- any integrity warning (orphan/missing reference) → one generic banner:
  *"Some structured content could not be linked automatically."*
- `plain_chunks` (legacy) → no banner; prose renders continuously.

## Security

- Prose, section names, paths, context: `textContent` only — a hostile
  `<img onerror>`/`<script>` in any API-derived string renders as inert
  text (unit-tested with hostile prose/paths/context/rawContent; the
  structural-renderer security suites are untouched and still green).
- Entity content goes through the already-audited structural renderer
  (DOM-API tables, hljs-generated highlight markup only).
- Banner copy is fixed strings; warning payloads are never interpolated.

## Styling

Unframed continuous prose at `max-width: 72ch`; entities distinct through
spacing and the renderer's own chrome (no cards in cards); tables keep
their horizontal scroll wrapper; code stays inside the page width. One
scoped narrow-viewport fix was required: `.layout`'s fixed sidebar column
(`--sidebar-width`, default 340px) consumed the whole viewport on phones,
squeezing `#main` to zero width — a `@media (max-width: 720px)` rule now
caps the sidebar at `38vw` (a minimal accommodation, not a mobile nav
redesign; this predates Phase 3W but the reader made it a checklist item).

## Automated tests

- `tests/unit/admin/ui-assembly-view.test.js` (new) — 25 tests: scope=file
  request shape (and no eager /chunks), scope=section exact nodePath (no
  anchor/whole-file calls), Document default + aria-pressed + tooltips,
  hidden count badge, continuous ordered prose with `data-chunk-index`,
  table/code through the real shared renderer, checklist safe plain text,
  no placeholder lines, no duplicate entities, hostile content inertness,
  target highlight without mode switch, lazy fetch-once + repeated-toggle
  no-refetch, real button clicks, five-at-a-time pagination, section
  Chunks filtering, per-open state reset, stale-response generation guard
  (gated promise, no timeouts), rejected lazy /chunks recovery (Document
  re-rendered + error toast + retryable toggle — review round 1), fallback
  banner collapsing, integrity-only banner, plain_chunks without warning,
  empty-section state + Open file, search/reader exclusion,
  module-boundary and no-history source pins.
- `tests/unit/admin/ui-file-view.test.js` — rewritten for the new default:
  28 tests (assembly-first opens, lazy /chunks contract, header badge
  rules, empty states, pure `renderFileChunks` target highlighting, the
  Phase 3P/3T card-layout and XSS suites unchanged, source pin that the
  anchor/window machinery is gone).
- `ui-router.test.js` — the section-route integration fixture updated to
  the assembly contract (same subject: bare-route return clears content).
- Full suite: **1022/1022** unit (sequential, `--test-concurrency=1`,
  768 MB cap; 1021 + 1 review-round test), **1293/1293** smoke, clean
  `admin:build`, clean `git diff --check`, `node --check` clean on both
  changed UI modules.

## Live checks actually performed

Playwright (chromium, resolved from the local npx cache) drove the REAL
admin server (`node src/admin/server.js`) against the real cloud Qdrant
instance — **21/21 live checks passed**, screenshots captured for each:

1. Skeleton file with prose + table (a backfilled collection, `demo`):
   Document default, no banner, real `<table>` via the shared renderer,
   count badge hidden, no placeholder lines, no page overflow (desktop
   1280×900).
2. Document → Chunks → Document → Chunks: cards render, count badge
   appears, exactly ONE `/chunks` request across all toggles (network
   counted in-browser).
3. A placeholder_fallback file: exactly one compact banner with the
   user-facing copy, no internal codes.
4. Section selected from the real sidebar (collection auto-expand → file
   caret → section row click): opens as an assembled Document.
5. A real search (live ONNX embedding) → "Open file section" on a result:
   lands in Document mode with exactly one highlighted target segment,
   scrolled into view.
6. Legacy collection (plain_chunks): continuous prose, no banner.
7. Prose + many code entities (a study-notes skeleton collection):
   highlighted code blocks through the shared renderer, no overflow.
8. Narrow viewport 390×844: readable column, no horizontal overflow (after
   the sidebar-cap fix above).

An **empty section** was not available in the live data — that state is
covered by unit tests only (assembly `segments: []` → empty state + Open
file action). This is the one checklist item not exercised live.

## Code review fixes

### Round 1

**P2 — a failed lazy /chunks fetch stranded the reader.** When the
Chunks-mode fetch rejected, `setReaderMode()` set the mode back to
`document` but replaced the entire `#collection-content` with a bare error
box — header, Document view, and the mode toggle all gone, so the user
could not recover without re-opening the file from the sidebar. **Fix**:
the catch now re-renders the Document view from the still-cached reader
state (header and toggle intact, `aria-pressed` honestly back on Document)
and surfaces the failure as a non-blocking `showToast(…, { variant:
'error' })`. The failed attempt caches nothing, so the toggle is
immediately retryable. New test: `/chunks` rejects on the first call and
succeeds on the second — asserts the Document view and toggle survive, no
blocking `.error-box` appears, exactly one error toast fires, and the
retried toggle renders the chunk cards. (The behavior test harness gained
a `showToast` capture stub; the route-integration harness already
evaluates the real `toasts.js`.)

## Limitations

- Prose is rendered as plain text — Markdown constructs inside prose
  (lists, emphasis, links) show as their raw/flattened text. A Markdown
  prose renderer is explicitly out of scope this phase.
- Indexed list nodes were flattened at indexing time (semicolon-joined
  items in older collections) — the reader shows the stored text verbatim;
  this is an indexer-side artifact visible in the live screenshots, not a
  reader bug.
- No assembly pagination: very large files render all segments at once.
- The narrow-viewport fix is a minimal cap, not a mobile navigation
  redesign.
- Several live collections still assemble in `placeholder_fallback` mode —
  running `npm run backfill:entity-refs` on them (with the current, post-
  round-6 matcher) is the operational follow-up for the preferred path.

## Verdict

STITCHED_DOCUMENT_READER_ACCEPT
