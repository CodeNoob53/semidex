# Admin UI Phase 3G — Collection Header / Overview That Explains the Library

2026-07-10

## Goal

Turn the selected-collection header into a "library overview" a user can
read before searching or browsing, instead of a mostly-technical block with
almost no explanatory content.

## Starting point

Phase 3E had already built the header's structural shell (title/health/
settings top line, an optional description line, compact fact chips, a
collapsed Details disclosure). What Phase 3G needed to fix was narrower than
a full rebuild:

1. The description line only ever read the config-level `description` field
   (typed once at index time, usually never set) — it never used the
   richer, content-derived skeleton-root summary that already exists for
   collections indexed with LLM summaries.
2. When no summary existed at all, the description line was silently
   omitted — a blank gap rather than a clear "nothing here yet" signal.
3. Fact-chip wording leaned Qdrant-ish ("points", "hybrid"/"dense-only")
   rather than semidex vocabulary ("chunks", "hybrid search"/"dense
   search", "navigation map"/"flat file list").

## What changed

### Backend: `overviewSummary` field on `GET /api/collections/:name`

`src/core/storage/qdrant-adapter.js`'s `getCollection()` already fetched the
collection's skeleton root node (`store.getCollectionSkeletonNode(name)`) to
compute the boolean `hasSkeleton` flag, but discarded everything else about
it. The skeleton root payload carries its own `summary` field (an
LLM-generated "what is this collection about" blurb, produced during
indexing for collections that opted into LLM summaries) — the same field
`toSkeletonNode()` already maps for the skeleton browser elsewhere in the
admin UI.

Fixed by reusing the already-fetched skeleton root (no extra network
round-trip). `hasSkeleton` now derives from the same fetch
(`Boolean(skeletonRoot)`) instead of a second call. No Qdrant-specific
concept crosses the adapter boundary — `overviewSummary` is a plain string
or `null`, same shape as the existing `description` field.

The root's `summary` field is not always a real overview, though — the
indexer's `skeleton-summary.js` stamps a `summary_kind` on every generated
summary, and only `'collection_overview'` means an actual LLM-authored
blurb (a rollup or single-child propagation). `'inventory'` means a plain
mechanical fallback like `"nodejs-basics — 72 files"` with no real
narrative content — which is worse than the admin UI's own "no overview
yet" empty state and must not be allowed to shadow a real config
`description`. `overviewSummary` is therefore gated:

```js
overviewSummary: skeletonRoot?.summary_kind === 'collection_overview'
  ? skeletonRoot.summary ?? null
  : null,
```

*(This gate was added after an initial code review caught the ungated
version — see "Code review fixes" below.)*

### Backend: `chunkCount` — an honest, nav-excluded chunk count

`pointCount` (from Qdrant's raw `getCollectionInfo().points_count`) counts
every point in the collection, including `skeleton_nav` navigation points on
any collection with skeleton navigation on. Labeling that number "N chunks"
in the header overstates real content — on one real collection in this
session, `pointCount` was 296 while the actual content-chunk count was 194
(102 nav points, ~35% of the raw total).

Added `countContentPoints(collection)` to `src/core/qdrant/store.js`: a
server-side exact `count` call (Qdrant's `POST .../points/count`, no
payload/vector transfer) filtered through the same `withNavExcluded()`
helper every other content-facing query already uses. `getCollection()`
exposes this as a new `chunkCount` field, distinct from `pointCount`.
`pointCount` is untouched and keeps meaning "raw total" — it's still used
as-is by the collapsed Details panel's technical "points" row, where the
raw total is the correct thing to show.

*(Also added after the same code review — see below.)*

### UI: summary priority + quiet empty state

`src/admin/ui-src/collection-view.js`'s `renderCollectionHeader()` now
resolves the summary block as:

```js
const summaryText = detail.overviewSummary || detail.description || null;
```

Skeleton-root summary wins when both exist (it's generated from the actual
indexed content, so it tends to be more current and specific than a
config-level description typed once and often left stale). When neither
exists, the header shows `No overview yet. Reindex with LLM summaries to
generate one.` in a dedicated `.col-header-desc-empty` style (dim, italic —
reads as "nothing indexed yet," not as an error or missing data).

### UI: fact-chip wording

`collectionFactChips()` relabeled from Qdrant-flavored terms to semidex
vocabulary:

- `"N points"` → `"N chunks"`, sourced from `chunkCount` (nav-excluded), not
  `pointCount` (raw total) — see the `chunkCount` section above.
- `"onnx · bge-m3-onnx"` (raw provider id + model) → `"bge-m3-onnx"` (model
  only) `+ " local"` suffix when the provider is a local one (onnx/ollama),
  since "is this calling out to the cloud or not" is the one distinction a
  user actually needs at a glance — the full provider string is still in
  Details.
- `"hybrid"` / `"dense-only"` → `"hybrid search"` / `"dense search"`
- `"skeleton nav on"` → `"navigation map"` (and the existing `"flat file
  list"` fallback is unchanged, since it was already in plain language)

The collapsed Details panel (`collectionDetailsPanel()`) is untouched —
it's explicitly the technical/advanced view and keeps "points", full
provider strings, dense/sparse vector specifics, and schema versions
exactly as before.

## Data source priority (as specified)

1. Skeleton root summary (`overviewSummary`), when the collection has one.
2. Config-level `description`, when set and no skeleton summary exists.
3. A quiet, worded empty state — never raw technical filler.

No new API endpoint was needed; the existing `GET /api/collections/:name`
response gained one additional field, reusing data the adapter already
fetched for `hasSkeleton`.

## Code review fixes

A first pass of this phase shipped two content-accuracy bugs, both caught in
review before commit:

1. **[P1] The "chunks" chip showed `pointCount`, Qdrant's raw point total,
   which includes `skeleton_nav` navigation points on any collection with
   skeleton navigation on.** This meant the header could tell the user "1,450
   chunks" when a meaningful fraction of that number was invisible
   navigation metadata, not retrieval content — a real, user-facing
   inaccuracy, not just a cosmetic one. Fixed by adding
   `countContentPoints()` (nav-excluded server-side count) and a distinct
   `chunkCount` field; the chip now reads from `chunkCount` only, with no
   fallback to `pointCount` (showing 0 on a genuinely missing count is more
   honest than silently reusing the nav-inflated number).

2. **[P2] `overviewSummary` accepted the skeleton root's `summary` field
   unconditionally, without checking `summary_kind`.** The root summary can
   be a real LLM-generated overview (`summary_kind: 'collection_overview'`)
   or a mechanical `'inventory'` fallback like `"nodejs-basics — 72 files"`
   with no real narrative content. Ungated, an inventory fallback would
   silently outrank and hide a real config `description`, and would render
   in the header looking like a genuine (if terse) summary rather than "not
   generated yet." Fixed by gating `overviewSummary` on
   `summary_kind === 'collection_overview'` — an inventory-kind root now
   correctly falls through to `description`, then to the quiet empty state.

Both fixes were verified with the revert/re-test/restore discipline used
throughout this project: each new regression test was confirmed to fail
against the pre-fix code, then the fix was restored and re-confirmed
passing. Both were also re-verified live against the real Qdrant Cloud
instance — see "Verification run" below for the before/after numbers.

## Tests

- `tests/unit/core/storage/qdrant-adapter.test.js`:
  - `overviewSummary` reads `skeletonRoot.summary` only when
    `summary_kind === 'collection_overview'`; `hasSkeleton` reuses the same
    fetch (`getCollectionSkeletonNode` called exactly once, not duplicated).
  - `chunkCount` comes from `store.countContentPoints(name)`, not
    `info.points_count`; `pointCount` still reads the raw total (used by the
    Details panel).
- `tests/unit/core/qdrant-store-nav-exclusion.test.js` — `countContentPoints`
  is defined, filters through `withNavExcluded()`, uses Qdrant's server-side
  `client.count()` (not a scroll+length approximation), and requests an
  exact count.
- `tests/unit/admin/ui-collection-view.test.js`:
  - Summary block: skeleton summary takes priority over description;
    description is used when skeleton summary is absent; quiet empty-state
    text renders (with its distinct CSS class) when neither exists.
  - Fact chips: `"N chunks"`, `"... local"` suffix, `"hybrid search"` /
    `"dense search"`, `"navigation map"` — all reworded assertions replacing
    the old Qdrant-flavored wording.
  - New: `chunkCount` (not `pointCount`) drives the chunks chip, verified
    with a fixture where the two numbers deliberately differ (1,450 vs
    1,200) — the raw, nav-inflated number must never appear in the chip.
  - New Phase 3G acceptance block: no raw snake_case payload field names
    (`point_kind`, `node_type`, `dense_provider`, etc.) ever appear in the
    rendered header text, even with a fully-populated technical detail
    object; a collection name containing spaces and Cyrillic characters
    renders its title/summary/settings button correctly; switching from one
    collection to another updates the summary and chips correctly (old
    collection's summary text does not linger).
  - Existing Details-disclosure tests (collapsed by default, contains the
    full technical facts, sits below the top line) were left unchanged —
    Details itself was not touched.
  - Existing search-panel-regression tests (no Advanced block, no TOP
    selector, no score checkbox, score visible by default) were left
    unchanged and still pass — confirms this phase didn't touch search.js.

## Verification run

- `npm test` — 720/720 passing (712 baseline + 8 new: 5 from the initial
  implementation, 3 from the code-review fixes).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings).
- Live Playwright verification against the real Qdrant Cloud instance
  (post-fix):
  - A collection with a real LLM-generated overview (`summary_kind:
    'collection_overview'`): header renders the real summary paragraph,
    chips correctly read the nav-excluded `chunkCount` — `194 chunks`
    against a raw `pointCount` of `296` (102 nav points correctly excluded)
    — `<model> local`, `hybrid search`, `navigation map`. Details starts
    collapsed and expands on click to show the full technical dump (raw
    `points: 296`, dense vector size/distance, both providers, schema
    versions) without duplicating anything already shown in the chip row.
  - A collection whose skeleton root is `summary_kind: 'inventory'` (an
    older collection indexed before LLM summaries, whose root summary was
    the mechanical placeholder `"nodejs-basics — 72 files"`): confirmed
    `overviewSummary` is `null` in the API response (correctly gated out),
    and the header renders the quiet "No overview yet…" empty state instead
    of the misleading placeholder text. Its chunks chip correctly reads
    `1,206 chunks` against a raw `pointCount` of `1,366` (160 nav points
    excluded).
  - A collection with no skeleton and no config description: summary block
    falls back to the quiet empty state; chips correctly show
    `flat file list` instead of `navigation map`.
  - Switching collections via a sidebar click updates the header's title,
    summary, and chips correctly with no stale content from the previously
    selected collection.

## Remaining limitations

- `overviewSummary` quality depends entirely on what was generated at index
  time. Collections indexed before LLM summaries existed, or indexed
  without opting into them, correctly show the empty-state fallback rather
  than a real prose overview (the earlier "inventory summary leaks through
  as if it were real" bug is now fixed — see "Code review fixes" above).
  Generating a real overview for these collections requires reindexing with
  LLM summaries enabled, which is out of scope for this UI-only phase.
- No changes were made to the Details panel's content or the search panel —
  both were explicitly out of scope and are confirmed unaffected by
  regression tests.
