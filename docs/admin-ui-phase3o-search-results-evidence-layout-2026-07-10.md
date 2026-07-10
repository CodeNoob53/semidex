# Admin UI Phase 3O — Search Results Evidence Layout

2026-07-10

## What changed

Unlike recent prior phases, this was a genuine redesign — the search
result card had not been touched since Phase 3B/3E and still read as a
flat technical row: rank, score, score bar, source file, chunk index,
section, and a node-type badge all crammed into one `.result-head` line,
followed by two equally-weighted blocks (`context`, then `text`) with no
distinction between "this is a lead-in" and "this is the evidence."

### Card structure: three tiers instead of one flat row

`src/admin/ui-src/partials/templates/search-result.html` and
`src/admin/ui-src/search.js`'s `renderResult()` were restructured into:

- **`.result-primary`** — identity: rank, source file, section, node-type
  badge, and the open action. What this result *is*.
- **`.result-evidence`** — the actual matched content: an optional context
  lead-in above the evidence text, which is now the visually dominant part
  of the card (no border/background competing with it).
- **`.result-meta`** — secondary/service row: chunk index, a structural-
  evidence hint for table/code/checklist hits, and score/score-bar last.
  Small, muted, easy to skim past — a ranking signal, not the headline.

All existing field-level class names (`.rank`, `.result-source`,
`.result-section`, `.result-node-type`, `.result-chunk-index`,
`.chunk-context`, `.chunk-text`, `.score`, `.score-bar`, `.result-open`)
were kept unchanged — only their grouping/wrapper structure and CSS moved
— so every test and code path that already depended on those selectors
(windowChunks exclusion, XSS-safety, Show More batching, URL permalinks,
recent searches) needed no changes beyond the ones described below.

### Context/text deduplication

New `shouldShowContext(context, text)` in `search.js`: normalizes
whitespace/case on both strings and hides the context lead-in when its
words already appear verbatim in the evidence text (the common case for a
short prose chunk, where `context` was often just a near-repeat of the
chunk's own opening words) or when context is empty/whitespace-only.
Context still renders — as a genuine subtitle above the evidence, not a
second equally-weighted block — whenever it states something the evidence
text doesn't already say (e.g. a real multi-level heading breadcrumb like
`"Deployment › Docker › Production config"` above a chunk that only
mentions `NODE_ENV=production`).

### Structural evidence labeling

Table/code_block/checklist hits (reusing `file-view.js`'s existing
`STRUCTURAL_NODE_TYPES` set, imported rather than re-declared, so the two
chunk-rendering surfaces can't drift apart on what counts as
"structural") now show a short `"table evidence"` / `"code evidence"` /
`"checklist evidence"` hint in the meta row, distinct from the node-type
badge in the primary row — confirmed live against a real table hit in
`Курсова робота`'s `00_INDEX.md`, where the raw markdown table (many
long, pipe-delimited lines) renders fully contained inside the card
(existing `word-break: break-word` + `max-height: 300px` + `overflow-y:
auto` on `.chunk-text` already handled this — no new CSS needed for
containment itself).

### Open button wording

`"open"` → `"Open chunk"` for a structural hit (one specific excerpt) or
`"Open file section"` for a plain prose hit (part of a larger section) —
sets the right expectation for what clicking it will show.

### Score as a secondary signal

Moved from the primary row into `.result-meta`, last in reading order.
Tooltip copy updated to the task's exact requested wording — `"Used for
ranking; compare order, not absolute value."` — on both `.score` and
`.score-bar` (was `"Rank score — compare order, not absolute value"`).
Numeric value, bar-width calculation (normalized to the top-1 result's own
score, never an absolute reading), and default-visible behavior (no
opt-in checkbox — established in an earlier phase) are all unchanged.

### Empty-state copy

`"No results for this query."` → `"No results for this query — try
different wording, or search a different file/collection."` The
already-existing filtered-file case (`"No results in the filtered file —
try clearing the file filter."`) was already actionable and is unchanged.
The `"searching…"` loading text was already plain, lowercase, and
consistent with the rest of the admin UI's loading-state tone (matches
`file-view.js`/`sidebar.js`'s own `"loading…"`) — confirmed already
correct, not changed.

## What did NOT change

- **Backend/retrieval/ranking**: zero changes to `src/admin/api/search.js`,
  the core retrieval/ranking pipeline, MCP tools, or the Qdrant adapter —
  confirmed by `git status` showing only `src/admin/ui-src/*` and
  `tests/unit/admin/*` files touched.
- **`/api/search` request payload**: still `{ collection, query, top:
  SEARCH_FETCH_LIMIT, window: 0, sourceFile? }` — unchanged.
- **Show More / fetch-once-page-in-batches behavior**: unchanged, still
  passes its own describe block (11 tests) with zero modifications needed.
- **URL permalink behavior**: unchanged (18 tests, zero modifications).
- **Recent searches**: unchanged (9 tests, zero modifications).
- **No new dependencies**: confirmed via `git diff --stat package.json
  package-lock.json` (empty) — the only new import is `STRUCTURAL_NODE_TYPES`,
  already exported by `file-view.js` from an earlier phase.

## Tests

`tests/unit/admin/ui-search.test.js` — 11 new tests, all asserting on
*rendered DOM output* (via `renderResult()`'s returned element), not
source-regex, per the task's explicit instruction:

1. Context whose words already appear in the evidence text is hidden, not
   duplicated as a second block.
2. Context that adds real information (a genuine breadcrumb/lead-in) still
   renders.
3. Empty/whitespace-only context never renders as a block.
4. A table hit shows the `"table evidence"` structural hint.
5. A code_block hit shows `"code evidence"`.
6. A checklist hit shows `"checklist evidence"`.
7. A plain paragraph hit never shows the structural hint.
8. Score/score-bar render inside `.result-meta`, never inside
   `.result-primary`.
9. Rank/source/section/node-type/open-button all render inside
   `.result-primary`.
10. Raw table/code markdown containing HTML-like text never gets parsed
    into a real element (evidence text stays plain text, XSS-safe).
11. A zero-result search's status text suggests a concrete next step
    (different wording / different scope), not just "no results," and
    never leaks raw technical text.

Plus updates to 2 existing tests to match the new copy/behavior:
- The "required fields" test now also asserts the open-button reads
  `"Open file section"` for a plain prose result.
- The tooltip test now checks for the new exact wording (`"Used for
  ranking; compare order, not absolute value."`).

`tests/unit/admin/ui-test-helpers.js`'s `loadSearchRenderHelpers()` needed
one fix: it stubs `search.js`'s `file-view.js` imports manually (a `vm`
context, not a real module loader) and was missing a `STRUCTURAL_NODE_TYPES`
stub for the newly-added import — added alongside the existing
`nodeTypeBadgeIcon` stub.

All new/changed tests were verified via a temporary source revert
(disabling `shouldShowContext()`'s dedup check) to confirm the dedup tests
correctly fail against pre-fix behavior before restoring.

## Verification run

- `npm test` — 765/765 passing (754 baseline + 11 new).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings); files
  touched: `app.css`, `search-result.html`, `search.js`,
  `ui-search.test.js`, `ui-test-helpers.js` — all admin UI frontend + test
  files, no backend/retrieval/MCP/adapter files.
- Live Playwright verification against the real Qdrant Cloud instance
  (`Курсова робота`, query "SQL запит вибірка"):
  - A prose hit (`sql/SELECT.md`) renders with a real breadcrumb context
    lead-in, evidence text as the dominant block, `"Open file section"`
    button, score/chunk-index in the small meta row at the bottom.
  - A table hit (`00_INDEX.md`) renders the `table` badge in the primary
    row, `"table evidence"` hint in the meta row, `"Open chunk"` button,
    and the raw multi-column markdown table (long pipe-delimited lines)
    renders fully contained within the card — no layout breakage, no
    horizontal page overflow.
  - No console/page errors during either search.

## Known limitations

- The empty-state copy change (suggesting "different wording, or search a
  different file/collection") was verified via the unit test's stubbed
  zero-result response, not reproduced live — the real hybrid (dense +
  sparse RRF) search proved robust enough to return *some* result even for
  deliberately nonsensical test queries against real indexed content, so a
  genuine zero-result live case wasn't readily reproducible without an
  empty collection or backend-side query manipulation, both out of this
  phase's frontend-only scope. The code path itself is deterministic and
  directly tested.
- The context/text dedup heuristic (`shouldShowContext`) is a substring
  check on normalized text, not a fuzzy/semantic similarity measure — it
  correctly handles the common case (context's words literally repeated in
  the evidence) but won't catch a context that's semantically redundant
  with different wording. This was a deliberate scope decision (a simple,
  predictable rule beats a fuzzy one that could unpredictably hide a real
  lead-in) rather than an oversight.
