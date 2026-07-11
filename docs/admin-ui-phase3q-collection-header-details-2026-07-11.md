# Admin UI Phase 3Q — Collection Header and Details UX

2026-07-11

## What changed

An audit against the task's stated complaint found most of the requested
behavior already in place from earlier phases (3E/3G/3I/3M and an unnumbered
settings-redesign phase). The header/details/settings split was already
correctly implemented; the one genuine gap was the Details disclosure's
internal structure.

### Header (requirement 1) — already correct, verified only

`renderCollectionHeader()` in `src/admin/ui-src/collection-view.js` already
matched the task's ask exactly:
- Collection display name as an `<h1>`.
- Health badge (`healthy` / `N warning(s)`).
- A summary line: skeleton-generated `overviewSummary` preferred, config
  `description` as fallback, a quiet italic empty state
  ("No collection summary yet. Reindex with LLM summaries to generate one.")
  when neither exists.
- Compact metadata chips (`collectionFactChips()`): chunk count (nav-
  excluded), model/local hint, "hybrid search"/"dense search", "skeleton
  nav"/"flat file list" — using semidex vocabulary, not raw Qdrant terms.

No changes needed here. Confirmed live against a real collection
(`Курсова робота`): name, health badge, a real Ukrainian-language
LLM-generated summary, and four chips (`194 chunks`, `aapot/bge-m3-onnx
local`, `hybrid search`, `skeleton nav`) all render correctly.

### Details disclosure (requirement 2) — restructured into sub-sections

**This was the real gap.** The previous Details panel was one flat 11-row
`<dl>` mixing collection-size facts, provider facts, and schema-version
facts with no grouping — readable, but not organized the way the task's
"Recommended structure" (Overview / Indexing / Storage) asks for.

`collectionDetailsPanel()` was restructured to build three labeled
sub-sections via a new `collectionDetailsSubsection(label, rows)` helper:

- **Indexing** — dense vector size/distance, sparse vector yes/no, dense
  provider (+model), sparse provider, skeleton navigation status,
  embedding/chunking/indexing schema versions, token count mode.
- **Storage** — point count, semidex-managed flag.
- **Overview** — conditionally rendered, see below.

All existing field-level labels (`dense vector`, `points`,
`semidex-managed`, etc.) were kept character-for-character, so every
pre-existing test asserting on those labels/values still passes unchanged —
only the grouping/wrapper markup and a new `.details-subsection-label`
sub-header were added.

**Overview sub-section — deliberately conditional, not a duplicate.** The
task's requirement 2 asks for an "Overview" entry showing the
description/summary (or a friendly empty state). Since the header body
*already* shows that same summary prominently (requirement 1, unchanged),
repeating it verbatim inside Details would be exactly the "duplicate
metadata block" the task's own constraints forbid ("Do not duplicate the
same fields in multiple places" / acceptance criterion "No duplicate
metadata blocks"). Resolved by making the Overview sub-section render
**only when the header has nothing** (no `overviewSummary`, no
`description`) — in that case Details shows a one-line friendly note ("No
collection summary indexed yet.") for anyone who opened Details directly
without reading the header empty-state line above. When a summary exists,
Details has no Overview sub-section at all — Indexing/Storage only.

New CSS: `.details-subsection` / `.details-subsection-label` in `app.css` —
a small uppercase muted label (matching the existing `.panel-head`
typographic language) above each grouped `<dl>`, with vertical spacing
between sub-sections.

### Settings / Maintenance separation (requirement 3) — already correct

`settings-view.js` + `settings-shell.html` already fully separate
maintenance actions from the main collection view: reindex, "Repair
collection compatibility" (the sync-schema endpoint), and delete all live
exclusively behind `#/c/:name/settings`, reached via the header's
`settings` button. The main collection view (`collection-view.js`) contains
zero reindex/repair/delete controls — confirmed by the existing "old flat
technical panels are removed" test suite and by reading `collection-view.js`
in full (no `apiPost`/`apiDelete` calls anywhere in that file). No changes
needed.

### `sync schema` UI copy (requirement 4) — already correct

Already renamed from "sync schema" to **"Repair collection compatibility"**
with exactly the plain-language explanation the task asks for: *"Checks and
repairs semidex metadata, vector names, and payload indexes for this
collection. It does not reindex files or update document content."* — both
as visible body copy and as a `title` tooltip. This was done in an earlier,
unnumbered settings-redesign phase (confirmed via the pre-existing
`ui-settings.test.js` test `'renames sync-schema to "Repair collection
compatibility" with an explanatory tooltip'`). No changes needed; the
task's literal requested wording is about the underlying `/sync-schema`
route, which the UI already re-labels for users.

### Debug tone (requirement 5) — audited, one minor label left as-is

Searched all of `src/admin/ui-src/` for "metadata"/"maintenance"/"provider
metadata" as user-visible labels. Found exactly one: `settings-shell.html`'s
reindex-options form has an `opt-group-label` reading "Maintenance" above
the single "Prune stale" checkbox. Judged this is not the debug-tone problem
the task describes (that problem was about the *main collection view*
leading with maintenance/debug controls, which is already fixed) — grouping
one advanced checkbox under "Maintenance" inside the settings/reindex form
is a reasonable, narrow label, not a diagnostics-panel tone. Left unchanged;
called out here for visibility rather than silently reinterpreting scope.

## What did NOT change

- **Backend/API**: zero changes outside `src/admin/ui-src/` and
  `tests/unit/admin/` — confirmed via `git status`.
- **Search behavior**: `search.js` untouched; confirmed live (see below)
  that search still returns results and renders correctly after the header
  restructure.
- **File/section view behavior**: `file-view.js` untouched.
- **Settings view**: `settings-view.js` / `settings-shell.html` untouched —
  already correct per above.
- **Header body** (requirement 1's fields/chips): untouched — already
  correct.
- **No new dependencies.**

## Tests

`tests/unit/admin/ui-collection-view.test.js` — 4 new tests, all on
rendered DOM output:

1. Details groups technical facts under `Indexing` and `Storage`
   sub-section labels, with the right fields under each (provider facts
   under Indexing, point count under Storage).
2. The overviewSummary/description text shown in the header body is never
   repeated inside Details (anti-duplication regression guard).
3. Details shows a friendly "No collection summary indexed yet." Overview
   line — but only when the header itself has no summary.
4. Details omits its own Overview sub-section entirely when the header
   already has a summary (no duplicate "Overview" block).

All 33 pre-existing `ui-collection-view.test.js` tests pass unchanged
against the restructured Details panel (label-level assertions, not
row-position assertions, so the regrouping didn't break anything). Full
file: 37/37 passing. `ui-settings.test.js`'s existing 15 tests (sync-schema
rename, settings/maintenance separation, etc.) already covered requirements
3 and 4 and needed no changes.

## Verification run

- `npm test` — 775/775 passing (771 baseline + 4 new).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings); files
  touched: `app.css`, `collection-view.js`, `ui-collection-view.test.js` —
  frontend + test only, no backend/API files.
- Live Playwright verification against the real Qdrant Cloud instance
  (`Курсова робота`, a collection with skeleton nav, hybrid search, and a
  real LLM-generated `overviewSummary`):
  - **Header**: name, `healthy` badge, full Ukrainian-language summary
    paragraph, and four chips (`194 chunks`, `aapot/bge-m3-onnx local`,
    `hybrid search`, `skeleton nav`) all render correctly.
  - **Details** (opened via click): shows `INDEXING` and `STORAGE`
    sub-section labels with the expected fields under each (dense/sparse
    vector, both providers, skeleton nav status, schema versions under
    Indexing; points + semidex-managed under Storage) — no `Overview`
    sub-section, since the header already had a summary (confirmed no
    duplication).
  - **Settings** (navigated via the `settings` button): "Collection
    health" panel (status/points/skeleton nav), "Reindex" form with
    grouped Quality/Structure/Optional enrichment/Maintenance checkboxes,
    confirmed the "Repair collection compatibility" wording is what's
    shown to the user (not raw "sync schema").
  - **Search still works**: after navigating collection → details → settings
    → back to collection, ran a live search query and confirmed 5 results
    rendered normally with no console/page errors.
  - No console/page errors throughout the full click-through.

## Known limitations

- The Overview sub-section's empty-state copy ("No collection summary
  indexed yet.") was only exercised via the unit test's stubbed
  no-summary response, not reproduced live — none of the real Qdrant Cloud
  collections used for live verification happened to have both
  `overviewSummary` and `description` unset at the same time. The code path
  is deterministic and directly unit-tested (2 of the 4 new tests cover
  exactly this branch), so this is a coverage note, not an open risk.
- The one remaining "Maintenance" label (the reindex form's "Prune stale"
  checkbox group) was left as-is — see "Debug tone" above for the reasoning
  that this is out of the task's actual scope (main-view tone), not an
  oversight.
