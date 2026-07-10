# Admin UI Phase 3H — File/Section View Cleanup

2026-07-10

## Starting point

Phases 3F/3G had already built most of the file/section navigation
foundation: whole-file mode via `getFileChunks`, windowed/anchored section
opens with a `.chunk-target` highlight, sidebar icons/indentation/active
state/truncation, and a rewritten collection header. This phase's own audit
found the remaining real gaps were narrower than the task text implied:

- File/section opens had no dedicated "what is actually open" header — only
  a single `#content-title` text line, no relative path, no explicit
  collection context, no distinct chunk-count badge.
- Section clicks always fell straight to the windowed anchor+highlight view,
  even when the section's own content could be resolved exactly.
- The empty-state message for a zero-chunk file was generic ("No chunks
  found for this file") rather than explaining *why* that's normal.
- Search-vs-browse card score/rank separation, sidebar icons, and active
  state were already correctly built and tested in 3F/3G — verified, not
  rebuilt.

## What changed

### New: exact section-content filtering, not just anchor+window

`openSectionView()` (`src/admin/ui-src/file-view.js`) now tries an exact
match before falling back to the existing windowed view:

1. **If the section node already carries `sourceFile`** (the normal case —
   both the sidebar tree and the URL/back-forward restore path populate
   this from the skeleton API), fetch every chunk in that file via the
   existing whole-file `GET .../chunks?sourceFile=...` immediately —
   *before* calling `/skeleton/anchor` at all.
2. Filter client-side: a chunk belongs to the section if its own
   `nodePath` equals the section's `nodePath`, or is a descendant of it
   (`"<section nodePath>/<child>"`). This is a **structural**, exact match —
   parent/child `node_path` lineage is a fact the indexer sets at index
   time, not a label or heading-text comparison. (Retrieval chunks don't
   carry a `heading_path` array — only skeleton nav nodes do — so
   `node_path` prefix matching is the reliable key available at the chunk
   level.)
3. If any chunks matched, render only those, with a header explicitly
   labeled "exact section match" plus the heading path breadcrumb when
   available. **`/skeleton/anchor` is never called in this case.**
4. Only if nothing matched (or `sourceFile` wasn't already known) does it
   call `GET .../skeleton/anchor?nodePath=...` — and if the node's
   `sourceFile` still wasn't known beforehand, retries the same exact-match
   filter once more using the file the anchor call resolved, before
   falling further back to the windowed view.
5. If the exact attempt still finds nothing, falls back to the original
   anchor-resolved windowed fetch (`chunkIndex ± 3`) with the
   `.chunk-target` highlight — unchanged behavior, still correct — and the
   header now discloses "showing nearby chunks" so the fallback is visible
   to the user, not silently
   indistinguishable from an exact match.

New pure helper `chunksBelongToSection(chunks, sectionNodePath)` implements
step 3 and is exported/unit-tested directly.

**No new backend endpoint was added.** Both fetches this uses
(`/skeleton/anchor`, `/chunks?sourceFile=...`) already existed from Phase
3F/earlier — this phase only added client-side filtering on top of data the
UI was already allowed to fetch.

### New: a real "what is open" header

New template `src/admin/ui-src/partials/templates/file-view-header.html`
(`tpl-file-view-header`) and a `fileViewHeader()` builder in `file-view.js`,
rendered above the chunk cards inside `#collection-content` (not replacing
the existing small uppercase `.panel-head` label, which stays as-is):

- Icon (file or section) + name (file basename, or the section's own
  display label).
- A chunk-count badge (`"N chunks"`), shown once the count is known.
- A meta line: relative source path, `"in <collection name>"`, and — for
  section views — the heading path breadcrumb and whether this is an
  "exact section match" or a "showing nearby chunks" fallback.

All header text is set via `textContent`, never string-concatenated into
markup — verified with an explicit XSS test (a `sourceFile`/collection name
containing `<img onerror=...>` renders as inert text, never a parsed
element).

The header survives "load more" clicks in whole-file mode (previously
`renderVisibleFileChunks()`'s `replaceChildren()` call would have silently
dropped anything prepended before it — fixed by capturing and re-prepending
the header element on every re-render).

### Changed: file empty-state wording

A file with zero retrieval chunks now shows *"No searchable chunks in this
file. It may only contain navigation/metadata or unsupported content."*
instead of the generic *"No chunks found for this file."* — matching the
task's exact requested wording, explaining that this is often a normal
state (frontmatter-only files, unsupported content types), not an error.

### Verified, not changed (already correct from 3F/3G)

- **Search vs. browse cards never share rank/score risk**: `tpl-search-result`
  (rank/score/score-bar) and `tpl-chunk-card` (no such fields at all) are
  two entirely separate templates — there is no shared toggle that could
  leak one mode's fields into the other. Added an explicit regression test
  confirming `tpl-chunk-card` has no `.rank`/`.score`/`.score-bar` markup at
  all, and that a rendered browse card has none of these elements even
  though the search template (confirmed in the same test) does.
- **Sidebar icons/indentation/active-state/truncation**: already built in
  Phase 3C (icon system) and 3D/3F (active state, indentation, truncation
  with tooltips) — confirmed via the existing, extensive
  `ui-sidebar.test.js`/`ui-icons.test.js` coverage (28+ tests) and this
  phase's own live Playwright pass. No sidebar code was touched.
- **Collection header / Details behavior**: unaffected by this phase — all
  28 `ui-collection-view.test.js` tests (Details collapsed by default,
  header prioritizes the top line, no duplicated technical facts) pass
  unchanged, confirming this phase's `#collection-content`-only changes
  don't touch `#col-header`.

## Code review fix

The first pass of this phase's `openSectionView()` called
`/skeleton/anchor` *before* attempting the exact-match filter — reusing the
anchor call's resolved `sourceFile` to then fetch and filter the whole
file. This was backwards: the backend's anchor resolver
(`getFirstContentChunkByParent`) only finds a chunk whose `parent_id` is
*directly* the section's own `node_id` — it does not look at descendants.
A section with no prose/table/code of its own, but with real content nested
under a child section (a common, legitimate shape — e.g. `## Setup` with no
body text, just `### Step 1` / `### Step 2` subsections that each have
content) would 404 out of the anchor call before `chunksBelongToSection()`
— which explicitly treats descendants, not just direct children, as
belonging to the section — ever got a chance to run. The fallback's own
404 handler would then show "This section has no indexed content," which
was simply false: content existed, just further down the tree.

Fixed by reordering: when the section node already carries `sourceFile`
(the normal case), the exact-match attempt runs first and skips
`/skeleton/anchor` entirely on success. Only a node arriving without a
known `sourceFile`, or an exact match that genuinely finds nothing, reaches
the anchor call — and if that node's `sourceFile` was unknown beforehand,
the exact-match filter is retried once more with the anchor's resolved
file before falling further back to the windowed view. The "no indexed
content" empty state now only appears when *both* the exact attempt and
the anchor fallback come up empty.

Verified with a regression test that reproduces the exact failure shape:
a section node with `sourceFile` set, a `/skeleton/anchor` stub that always
404s, and a whole-file chunk list containing only a chunk nested under a
child section (`node_path: "readme.md#setup/child-section/paragraph-1"`).
Confirmed via revert-and-retest that the test fails (the anchor call
happens and the empty-state renders instead of the real content) when the
reordering fix is disabled, then passes again once restored.

## Backend APIs used (no new endpoints)

- `GET /api/collections/:name/chunks?sourceFile=...` — whole-file mode
  (existing, Phase 3F), used both for a plain file open and for the new
  section exact-match attempt.
- `GET /api/collections/:name/chunks?sourceFile=...&chunkIndex=...&window=3`
  — windowed mode (existing), used for the section fallback and for
  search-result "open" clicks.
- `GET /api/collections/:name/skeleton/anchor?nodePath=...` — existing
  section-to-chunk anchor resolution (Phase 3B/3F), unchanged.

## Section filtering: exact vs. fallback

Exact when at least one chunk's `node_path` falls under the section's own
`node_path` — its own direct content, or content nested under any of its
child sections. This now runs before `/skeleton/anchor` is ever called
(see "Code review fix" above), so it correctly covers both a section with
direct paragraph/table/code content AND a section whose only content lives
under nested child headings. Falls back to the windowed anchor view
(documented, not hidden — the header discloses it) only when no chunk's
`node_path` matches anywhere in the file, or the node's `sourceFile` wasn't
already known and the anchor-resolved retry also found nothing. This is
the documented limitation the task asked for, not a fragile secondary
heuristic — no fuzzy label or heading-text matching was introduced.

## Tests

`tests/unit/admin/ui-file-view.test.js` (27 → covers all of this phase's
new behavior) and `tests/unit/admin/ui-test-helpers.js` (added a `basename`
stub to the two file-view test-context builders, needed since the real
module now imports it from `format.js`):

- File route renders all chunks from `/chunks?sourceFile=...` (existing,
  unchanged) — the header badge now also asserts the exact count and the
  relative path + collection name in the meta line.
- File route shows the new clean empty-state wording (not the old generic
  text) when zero chunks are returned.
- Section route: 4 tests — a code-review-fix regression proving the exact
  match runs before `/skeleton/anchor` (a section with `sourceFile` set,
  an anchor stub that always 404s, and a whole-file chunk list containing
  only a chunk nested under a *child* section — the exact match must still
  render it, and `/skeleton/anchor` must never be called); exact match
  renders only chunks whose `node_path` falls under the section (and
  excludes chunks from other sections in the same file); the header
  badge/meta reflect the exact match; when no chunk matches anywhere, falls
  back to the windowed anchor view with exactly 2 `/chunks` requests
  (whole-file attempt, then windowed fallback) and a
  `.chunk-target`-highlighted, "nearby chunks"-labeled result.
- Search result cards vs. file/section browse cards: 2 new tests confirming
  `tpl-chunk-card` has no rank/score/score-bar markup at all, and a
  rendered browse card has none of these elements even though the search
  template does.
- Sidebar icon/class/active-state tests: pre-existing, unchanged, still
  passing (28+ tests across `ui-sidebar.test.js`/`ui-icons.test.js`).
- Escaping: 2 new tests — a `sourceFile`/collection name containing
  `<img onerror=...>` renders as inert text in the header (never a parsed
  element); a long Cyrillic source path renders in full in the meta line
  without truncation/mangling.

All new regression tests were verified to fail against the pre-fix code
(revert/re-test/restore cycle) before being confirmed passing against the
final code, per this project's established verification discipline.

## Verification run

- `npm test` — 728/728 passing (720 baseline + 8 new, including the
  code-review-fix regression test).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings).
- Live Playwright verification against the real Qdrant Cloud instance:
  - Whole-file open (`sql/Звіт.md`, 7 chunks): header shows filename in
    `#content-title`, "7 chunks" badge, meta line
    `"sql/Звіт.md · in Курсова робота"`. Clicking "load more" correctly
    reveals chunks 6-7 while the header stays in place as the first child
    (no duplicate/dropped header).
  - Exact section match (section "Запит 15." under the same file): header
    shows "3 chunks" (not the file's 7), meta line reads
    `"sql/Звіт.md · in Курсова робота · 4.9 Запит для звіту › Запит 15. ·
    exact section match"`, and only the 3 chunks genuinely under that
    section render — no intro paragraph or sibling-section content leaking
    in. No `.chunk-target` highlight (correct — every rendered chunk
    already belongs to the section, there's no single "the" chunk to
    single out among unrelated neighbors). Re-verified unchanged after the
    code-review reordering fix — same result, confirming the fix didn't
    regress the already-working case.
  - Confirmed a real section that 404s on `/skeleton/anchor` exists in this
    dataset (`sql/Розрахункове_поле.md#4-8-підзапити`) — but on inspection
    it has zero children and zero content anywhere, so it's a genuine
    "both exact match and fallback correctly find nothing" case, not an
    instance of the bug this fix targets (a parent with content nested
    under child sections). No live collection in the currently-indexed
    datasets was found with that specific shape; the fix is verified
    instead by a targeted unit test that reproduces the exact failure
    scenario and was confirmed to fail against the pre-fix code (see "Code
    review fix" above).
  - No console/page errors during any of the above navigation.

## Known limitations

- Section exact-matching depends on chunk `node_path` being set correctly
  by the indexer at index time. A section with no content anywhere in its
  own subtree (no direct content and no content under any child section)
  will not match exactly and falls back to the windowed anchor view, which
  will also find nothing and show the "no indexed content" empty state —
  this is a genuinely empty section, not a filtering gap.
- The empty-file-with-zero-chunks path is thoroughly unit-tested but was
  not independently re-verified live in this pass (no readily available
  real collection file with genuinely zero content chunks was found during
  manual QA) — the DOM-behavior test exercises the exact same code path
  the live UI runs, so this is a coverage note, not an open risk.

## Manual QA checklist

- [x] Click a collection — header/summary/chips render, sidebar tree loads.
- [x] Click a folder — expands/collapses inline, no navigation.
- [x] Click a file — whole-file view opens with the new header (name, path,
      collection, chunk count), all chunks render, "load more" pages
      correctly with the header intact.
- [x] Click a section — exact match renders only that section's chunks with
      an "exact section match" label; verified the fallback path
      separately via the unit test suite (2 `/chunks` requests, correct
      `.chunk-target` highlight, "nearby chunks" disclosure).
- [x] Search, then open a result — opens via the existing windowed mode
      (`openFileView` with an explicit `chunkIndex`), browse card shows no
      rank/score (confirmed structurally: separate templates).
- [x] Return/back navigation — collection header stays in sync via the
      existing `route()`/`markActive()` machinery, unaffected by this
      phase's changes (confirmed via the unchanged, still-passing
      `ui-collection-view.test.js`/`ui-router.test.js` suites).
- [x] Long Cyrillic file/section names — render correctly in the sidebar
      (pre-existing, Phase 3D/3F) and in the new file-view header (new
      test this phase: a long Cyrillic path renders in full, unescaped
      text, in the meta line).
