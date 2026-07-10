# Admin UI Phase 3P — File/Section View UX Polish

2026-07-10

## What changed

An audit against the task's stated complaint found the header/logic layer
already correct (from Phases 3F/3H) but the chunk card itself was a genuine
gap: `.chunk-head` was a shaded bar with `.chunk-index-label` as the first,
most prominent element in every card — the same "debug dump" problem Phase
3O fixed for search-result cards, just not yet applied to file/section
browsing.

### Chunk cards: three tiers, quiet-to-loud

`src/admin/ui-src/partials/templates/chunk-card.html` and
`src/admin/ui-src/app.css` were restructured using the same
primary/evidence/meta tiering Phase 3O established for search-result cards:

- **`.chunk-primary`** — identity: section label + node-type badge. No
  background fill (the old `.chunk-head`'s `background: var(--bg-inset)`
  is gone). What this chunk *is*.
- **`.chunk-evidence`** — the actual content: an optional context lead-in
  above the chunk text, which is now the visually dominant part of the
  card.
- **`.chunk-meta`** — the chunk index only, small/muted, dashed top border,
  at the very bottom. Implementation detail, not a headline.

All existing class names (`.chunk-index-label`, `.chunk-section`,
`.chunk-node-type`, `.chunk-context`, `.chunk-context-label`,
`.chunk-context-text`, `.chunk-text`) were kept unchanged — only their
grouping/wrapper structure and CSS moved. `renderFileChunks()` in
`file-view.js` populates every field via `card.querySelector('.class-name')`,
never positional DOM access, so **zero JS logic changes were needed** — this
was a template + CSS-only redesign.

`.chunk-text`'s critical containment properties (`max-height: 300px;
overflow-y: auto; word-break: break-word;`) were preserved unchanged —
confirmed live (see below) still clip large raw table/code content without
breaking card layout.

### `.chunk-target` — unchanged by design

The task explicitly asked to "preserve existing `.chunk-target` behavior or
improve it without making it noisy." Read the existing CSS
(`border-color: var(--amber-dim); border-left: 3px solid var(--amber);`,
established Phase 3F) and judged it already correctly subtle — a left
border only, no background wash, distinguishable from neighboring chunks
without competing with the amber accent already used elsewhere in the UI.
Left unchanged; confirmed still renders correctly against the new card
structure (live-verified below).

### Header, whole-file mode, section exact-match — already correct

Read `file-view.js` in full and confirmed the following task requirements
were already satisfied by Phase 3F/3H work, with no changes needed:

- File/section header (`fileViewHeader()` / `tpl-file-view-header.html`):
  name/path is the headline, chunk count is a secondary badge (not
  headline), node-type icon present but not dominant.
- Whole-file mode: opening a file with no target chunk renders every chunk
  in a readable vertical flow via client-side pagination (`FILE_PAGE_SIZE =
  5`, "load more").
- Section view: opening a section resolves to an exact node_path match
  first (whole-file fetch + prefix filter), falling back to windowed
  anchor-resolution only when nothing matches — already the "Cleaner fix"
  from Phase 3H's code review.
- Empty states: `'No searchable chunks in this file. It may only contain
  navigation/metadata or unsupported content.'` (whole-file, zero chunks),
  `'No chunks found for this file/section.'` (windowed, zero chunks),
  `'This section has no indexed content.'` + "Open file from start" button
  (section 404) — all already plain, human-readable sentences, not raw
  API/debug text.
- Structural chunks (table/code_block/checklist): raw content already
  rendered via `.textContent` (never parsed as markup) with existing
  scroll/wrap containment.

## Code review fix

**P2 (caught in review):** the initial `.chunk-text { padding: 0 }` change
was global, not scoped to file/section view. `.chunk-text` is also used by
`tpl-search-result` (`search-result.html`'s `.result-evidence .chunk-text`,
from Phase 3O), which has no horizontal padding of its own
(`.result-evidence { padding: 2px 0; }`) — it relied on `.chunk-text`'s base
`padding: 10px` for breathing room. The unscoped change silently stripped
that padding from search-result cards too, regressing the Phase 3O evidence
block.

Fixed by restoring `.chunk-text`'s base `padding: 10px` and adding a scoped
override, `.chunk-evidence .chunk-text { padding: 0; }`, so only file/section
chunk cards (whose `.chunk-evidence` wrapper already supplies its own
`padding: 0 10px 8px`) zero it out. Verified live via Playwright:
search-result `.chunk-text` computed padding is back to `10px`; file-view
`.chunk-text` stays `0px` with `.chunk-evidence` supplying `0px 10px 8px`.
Re-ran `npm test` (771/771), `npm run smoke` (1293/1293), `npm run
admin:build`, `git diff --check` — all clean after the fix.

## What did NOT change

- **Backend/API/retrieval/chunking**: zero changes outside
  `src/admin/ui-src/` and `tests/unit/admin/`, confirmed via `git status`.
- **`file-view.js` logic**: no changes — `renderFileChunks()`,
  `openFileView()`, `openSectionView()`, `chunksBelongToSection()`,
  `fileViewHeader()` all untouched.
- **`.chunk-target` visual weight**: intentionally left as-is (see above).
- **No new dependencies**: only existing `app.css` +
  `chunk-card.html` + a test file touched.

## Tests

`tests/unit/admin/ui-file-view.test.js` — 6 new tests, all on rendered DOM
output (via `renderFileChunks()`'s returned fragment), not source-regex:

1. `.chunk-index-label` lives inside `.chunk-meta`, never inside
   `.chunk-primary`.
2. `.chunk-primary` carries the section label + node-type badge (identity),
   not the evidence text.
3. `.chunk-evidence` carries the context lead-in and chunk text (the
   dominant reading surface).
4. A table chunk with HTML-like adversarial text renders as inert text
   (`.textContent` match, no real `<img>`/`<script>` element parsed).
5. A code_block chunk with HTML-like adversarial text renders as inert text
   (no real `<div>` element parsed).
6. `.chunk-text`'s CSS keeps `max-height: 300px`, `overflow-y: auto`,
   `word-break: break-word` — the containment that stops large raw content
   from breaking page layout.

All pre-existing file-view tests (29) pass unchanged against the
restructured template — confirming the redesign didn't break any
class-name-dependent assertion. Full file: 35/35 passing.

Items already covered by pre-existing Phase 3F/3H/3L tests, re-confirmed
still passing against the new structure rather than duplicated: file open
renders whole-file chunks, section open marks target chunk, context labels
differ prose vs. structural, empty chunks state.

## Verification run

- `npm test` — 771/771 passing (765 baseline + 6 new).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build (25 modules, 170ms).
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings); files
  touched: `app.css`, `chunk-card.html`, `ui-file-view.test.js` — frontend
  + test only, no backend/API files.
- Live Playwright verification against the real Qdrant Cloud instance
  (`bench-structural-carryover`, a collection with real table/code_block
  chunks):
  - **Whole-file open** (clicking a file in the sidebar): renders every
    chunk top-to-bottom in a readable document flow — section label as
    plain identity text, "SECTION PATH" as a quiet italic lead-in, evidence
    text as the dominant block, chunk index as tiny muted text at the
    bottom-right.
  - **Section/table view** (search → "Open chunk" on a table hit, landing
    on the windowed section view): confirmed `.chunk-target` renders with a
    `3px` solid amber left border (`rgb(232, 163, 61)`) — visible, subtle,
    not noisy. A code_block chunk in the same view showed `"retrieval
    context"` labeling (not "section path"), chunk index inside
    `.chunk-meta` (not `.chunk-primary`), raw code rendered inside a real
    `<pre>` element with no HTML parsing (`hasRealTableElement: false`).
  - **Containment confirmed live**: the code_block chunk's `.chunk-text`
    had `scrollHeight: 378` vs `clientHeight: 300` — the `max-height` clip
    + internal scroll is actively engaged for real oversized content, not
    just passing in a unit test.
  - Screenshots confirm the visual result reads as document/evidence
    sections, not a debug dump — table content (multi-row markdown tables)
    renders fully readable inside its card with no layout breakage.
  - No console/page errors during either view.

## Known limitations

- Checklist-node-type chunks were not found in the live collections used
  for verification (`bench-structural-carryover` had table and code_block
  hits but no checklist hits surfaced by search) — checklist rendering is
  covered by unit tests (both the rendered-DOM node-type-badge test and the
  existing structural-labeling test) using the identical code path as
  table/code_block, but wasn't independently confirmed against a real
  Qdrant Cloud checklist chunk this phase.
- No raw-content modal/lightbox was added, per the task's explicit
  instruction not to add one yet — large structural content still relies
  on the existing scroll-contained `.chunk-text` box.
