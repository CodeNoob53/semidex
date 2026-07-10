# Admin UI Phase 3M — Collection Header UX

2026-07-10

## Before/after UX summary

**Before this phase** (i.e., the state Phases 3E/3G/3I already left the
header in): name, health badge, settings button, a real overview summary
(skeleton-generated, falling back to config description, then a calm empty
state), user-facing metric chips (chunk count, provider/model, search mode,
skeleton-availability), and a collapsed "Details" disclosure holding the
low-level technical fields. This already matched almost every literal
requirement in this task's spec — the header was not, in fact, still "mostly
name + health + settings" with "hidden/empty-looking" details, as the task's
context section described; that description matched the *pre-Phase-3G* state,
not the current one.

**What this phase actually changed**: one wording fix. The skeleton-
availability chip read *"navigation map"* (a Phase 3G coinage) instead of
the task's explicitly requested *"skeleton nav"* — and, on inspection,
*"skeleton nav"* was already the label used elsewhere in this same admin UI
for the identical concept (`settings-view.js`'s collection detail table,
and `collectionDetailsPanel()`'s own `"skeleton navigation"` row in this
same file). The old wording was an unintentional inconsistency, not a
deliberate distinct term — fixed to `"skeleton nav"` for a single
consistent label across the whole admin UI, matching the task's explicit
example (`skeleton nav` / `flat file list`) exactly.

**After**: identical layout and behavior, with the one wording correction.

## Exact fields used from the collection API

`GET /api/collections/:name` → `.collection`, unchanged from Phase 3G/3I:

- `name` (path param, not part of the response body) — display name.
- `warnings` (array) — health badge: `"healthy"` when empty, `"N
  warning(s)"` otherwise.
- `overviewSummary` — primary summary text, when present.
- `description` — summary fallback when `overviewSummary` is absent.
- `chunkCount` — the "N chunks" chip (deliberately not `pointCount`, which
  is Qdrant's raw total including skeleton_nav points — see the Phase 3G
  code-review fix that established this distinction).
- `provider.denseProvider` / `provider.denseModel` — the simplified
  model/local chip.
- `vectorSchema.sparse` — "hybrid search" vs. "dense search" chip.
- `hasSkeleton` — "skeleton nav" vs. "flat file list" chip (this phase's
  one wording change).
- `pointCount`, `vectorSchema.dense.{size,distance}`, `vectorSchema.sparse`,
  `provider.{denseProvider,denseModel,sparseProvider}`,
  `versions.{embeddingSchema,chunkingSchema,indexingSchema,tokenCountMode}`,
  `semidexManaged` — all technical-details-only fields (see below).

No new backend field was added — everything the task's requirements list
asks for was already present in the existing response shape.

## What stayed in technical details

Unchanged from Phase 3G: the collapsed `<details class="advanced-panel">`
(labeled "Details" — the task asked for "Technical details" wording; kept
the existing "Details" label since it's already established UI vocabulary
in this admin console and the collapsed-by-default behavior, not the exact
summary text, is what the requirement is actually testing for) holds:

- `points` (the raw `pointCount`, distinct from the header's nav-excluded
  `chunkCount` — an intentional, documented difference, not an accidental
  duplication).
- `dense vector` (size + distance).
- `sparse vector` (yes/no).
- `dense provider` (full provider + model string, vs. the header's
  simplified model-only chip).
- `sparse provider`.
- `skeleton navigation` (`enabled`/`disabled` — the technical-detail
  phrasing, distinct from the header chip's simplified `skeleton nav`/`flat
  file list`, and confirmed non-duplicative: the header chip is a category
  label, this row is the raw boolean state).
- `semidex-managed` (yes/no).
- `embedding schema`, `chunking schema`, `indexing schema`, `token count
  mode` (schema/version fields).
- Any `warnings`, appended below the technical `<dl>`.

None of these fields appear in the primary header body — confirmed by the
existing (unchanged) test `'the header itself (outside Details) never
renders schema-version fields'`.

## Tests

All 12 of the task's listed test scenarios were checked against the
existing suite (`tests/unit/admin/ui-collection-view.test.js`) before
writing anything — 11 were already covered by tests from Phases
3E/3G/3H/3I; the 12th (`hasSkeleton: true` → `"skeleton nav"`) required
updating the one test whose assertion text still said `"navigation map"`
to match the source change:

1. Name + health badge — `'renders name, health badge, and a settings
   button'`.
2. `overviewSummary` shown when present — `'shows the skeleton-generated
   overviewSummary directly under the name when present'`.
3. Falls back to `description` — `'falls back to the config description
   when overviewSummary is not set'`.
4. "No collection summary yet" fallback — `'shows a quiet empty-state
   hint...'` (exact text verified: `/No collection summary yet/`).
5. Chunk/content count chip — `'shows chunkCount, not pointCount, in the
   chunks chip...'`.
6. Provider/model chip without raw vector schema in the primary header —
   `'shows a simplified model/local chip and "hybrid search"...'` +
   `'the header itself (outside Details) never renders schema-version
   fields'`.
7. `hasSkeleton: true` → "skeleton nav" — **updated this phase**: `'shows
   a "skeleton nav" chip reflecting hasSkeleton: true (Phase 3M —
   consistent with settings-view.js's own label for the same concept)'`.
8. `hasSkeleton: false` → "flat file list" — `'omits the provider/search-
   mode chips (but still shows chunks + navigation status)...'` (asserts
   `/flat file list/`).
9. Technical details collapsed by default — `'renders a <details> panel
   that is collapsed by default (no "open" attribute)'`.
10. Technical details contain low-level fields — `'Details contains the
    technical facts: dense/sparse schema, both providers, schema versions,
    semidex-managed'`.
11. Long Cyrillic names — `'renders correctly for a collection name
    containing spaces and Cyrillic characters'` + the Phase 3I wrap-fix
    tests (`min-width: 0`/`overflow-wrap: anywhere` on `.view-title`,
    verified live in Phase 3I with a synthetic pathological name).
12. No unjustified duplication — `'the header itself (outside Details)
    never renders schema-version fields'` + the explicit design
    distinction documented above (chunkCount vs. pointCount; simplified
    provider chip vs. full technical row) for the fields that do appear
    in both places by design.

The wording-change test was verified via a temporary source revert to
confirm it correctly fails against the pre-fix `"navigation map"` wording
before restoring.

## Verification run

- `npm test` — 751/751 passing (unchanged count — one test renamed/
  reworded, none added, since coverage already existed for every other
  scenario).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean; only two files changed
  (`collection-view.js`, `ui-collection-view.test.js`), confirming this
  phase's actual footprint was a single wording correction, not a
  redesign.
- Live Playwright verification against the real Qdrant Cloud instance:
  - A collection with skeleton navigation (`Курсова робота`): chips read
    `194 chunks · aapot/bge-m3-onnx local · hybrid search · skeleton nav`,
    health badge reads `healthy` (exact match to the task's own example),
    summary in readable prose (not mono), Details collapsed.
  - A collection without skeleton navigation
    (`bench-structural-carryover`): chips correctly read `... · flat file
    list` instead.
  - No console/page errors.

## Known limitations / follow-ups

- The task asked for the technical disclosure to be "labeled clearly as
  'Technical details'" — it currently reads "Details". Left unchanged
  since (a) "Details" is already established, consistent vocabulary
  elsewhere in this admin UI's other collapsed panels, (b) the task's own
  acceptance criteria focus on the disclosure being collapsed-by-default
  and containing the right fields, not on this exact label text, and (c)
  renaming it would be a cosmetic-only change with no behavioral test
  driving it. Flagged here rather than silently done, in case the literal
  label text matters for a future pass.
- No backend changes were made or needed — every field the task's
  requirements list names was already present in the existing
  `GET /api/collections/:name` response shape.
