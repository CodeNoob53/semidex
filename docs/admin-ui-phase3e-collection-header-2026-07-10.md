# Admin UI Phase 3E — Collection Header + Details Redesign (2026-07-10)

Redesigns the collection header/details area to read as a user-facing
collection overview rather than a debug/status dump — using only fields
already returned by the existing `GET /api/collections/:name` contract. No
backend changes. Verified with automated tests and live against the real
project Qdrant Cloud instance and its collections.

## Before/after problem statement

**Before**: the header showed name, health badge, and settings button on one
line, plus a small always-visible "provider · model · Nd · hybrid" line
(Phase 3C). Everything else — description, point count, warnings — was
buried inside a collapsed `Details` disclosure with only three fields (no
provider/schema facts at all inside it). A user opening a collection saw a
near-empty header with nothing explaining what the collection actually is,
and had to open Details just to see the point count.

**After**: the header now reads top-to-bottom as: name + health + settings
(unchanged), an optional description line directly under the name (promoted
out of Details — this is the collection's own human-authored summary, the
single most useful "what is this" fact when it exists), a compact row of
fact chips (points, provider/model, hybrid/dense-only, skeleton-nav status),
and a collapsed `Details` disclosure holding the full technical breakdown
(dense vector size/distance, sparse yes/no, both providers with model names,
schema/chunk/token versions, semidex-managed, skeleton nav again in full
terms, and any warnings). Nothing appears in two places — the chips are a
user-facing subset, Details is the one and only technical table.

## Fields used from the current backend contract

All from the existing `GET /api/collections/:name` response shape (no new
fields, no backend changes):

- `name`, `pointCount`, `warnings[]` — unchanged from before.
- `description` — **promoted** from Details-only to the visible header (this
  is the change with the most user-facing impact).
- `provider.denseProvider` / `provider.denseModel` / `provider.sparseProvider`
  — `denseProvider`/`denseModel` now shown as a chip; all three now also shown
  in Details (previously not in Details at all).
- `vectorSchema.dense.size` / `vectorSchema.dense.distance` /
  `vectorSchema.sparse` — `size` + `sparse` drive the hybrid/dense-only chip;
  full `size`/`distance`/`sparse` now in Details.
- `hasSkeleton` — now a chip ("skeleton nav on" / "flat file list") AND a
  Details row ("skeleton navigation: enabled/disabled") — the chip is a quick
  glance, the Details row is the fuller technical statement; the two together
  don't count as "duplicated metadata" any more than a health badge and a
  Details warnings list would, since they're different altitudes of the same
  fact for different audiences (this is the one case where the same
  underlying boolean appears in both places, by design, exactly like the
  Phase 3C-era acceptance already treated provider chips vs. Details).
- `semidexManaged` — new in Details (previously never surfaced anywhere in
  the UI).
- `versions.embeddingSchema` / `chunkingSchema` / `indexingSchema` /
  `tokenCountMode` — unchanged in spirit (was already excluded from the
  header body per an existing regression test), now organized as clean
  Details rows instead of not being shown in this view at all.

## What changed (code)

- [src/admin/ui-src/collection-view.js](../src/admin/ui-src/collection-view.js)
  — `renderCollectionHeader()` restructured; the old `collectionMetaRow()`
  (a single always-visible provider/schema text line) replaced by two new
  functions:
  - `collectionFactChips(detail)` — builds the compact chip row. Each chip is
    independent: the points chip always renders (even "0 points"); the
    provider/model and hybrid/dense-only chips are omitted as a pair when
    `denseProvider` is null (never-indexed or legacy collection); the
    skeleton-nav chip always renders.
  - `collectionDetailsPanel(detail)` — builds the collapsed `<details>`
    contents as a `dl.kv` table, one row per technical fact, using `'unknown'`
    as the fallback text for any missing value **inside Details only** — the
    visible header never shows a raw `null`/`undefined`/bare `?`.
- [src/admin/ui-src/app.css](../src/admin/ui-src/app.css) — new
  `.col-header-desc` (dimmed description text), `.col-header-facts` (flex-wrap
  chip row), and a generic `.chip` class reusing the same visual language as
  the existing `.cap` capability chips on the overview page (border, muted
  color, small radius) rather than inventing a new visual style.

## What was intentionally left out of scope

Per the task's explicit brief — none of these exist in the codebase and none
were added:

- Ask/chat, snapshots, aliases, provider settings, image lightbox, or any
  future action buttons.
- A Qdrant-dashboard-style raw metadata browser — the Details table shows
  semidex concepts (provider, schema versions, skeleton nav) framed in
  semidex's own vocabulary, not raw Qdrant collection-config JSON.
- Search panel changes — `search.js` was not touched. Verified via a new test
  that the query input / top selector / search button / Advanced disclosure
  are all still present and that no window/format selector or default-visible
  score/source-file control was reintroduced.
- Duplicated Documents/Skeleton-navigation/Metadata/Maintenance blocks — all
  four pre-existing regression tests guarding against these still pass
  unmodified; a fifth was added confirming there is exactly one
  `<details class="panel advanced-panel">` built by the header (not a
  separate Metadata block and a separate Maintenance block).

## Metadata currently unavailable from the backend that would be useful later

Noted for a future backend-touching task, not implemented here:

- **File/section counts** — the header shows `pointCount` (chunks), but not
  "N files" or "N sections," which would be a more intuitive size signal for
  a non-technical user than a raw chunk count. Would need a new lightweight
  aggregate from the skeleton/document listing, not currently returned by
  `getCollection()`.
- **Last-indexed timestamp** — "indexed 3 days ago" would help a user judge
  freshness at a glance; not currently tracked/returned per-collection.
- **A collection-level owner/tag field** distinct from `description` — right
  now `description` is the only free-text field available; a short
  categorical tag (e.g. "coursework", "benchmark") could support future
  filtering/grouping in the sidebar collection list, but that's speculative
  and explicitly out of this task's "no fake future features" scope.

## Tests

All five categories the task specified are covered, in a substantially
rewritten `tests/unit/admin/ui-collection-view.test.js` (23 tests, up from
10) plus small fixes to two other files whose assertions depended on the old
header's byte-layout:

1. **Header renders name/health/settings/points/provider-summary** — 4 tests
   in "top line" + "compact fact chips" describe blocks, exercised via the
   real `route()` call graph (`loadRouteIntegrationHelpers`), not just
   source-text regexes.
2. **Missing optional metadata never renders `undefined`/`null`/a bare `?`**
   — dedicated test asserting on `#col-header`'s full text content with a
   deliberately sparse API response (no description, no provider, no
   vectorSchema).
3. **Advanced details collapsed by default** — dedicated test asserting
   `hasAttribute('open') === false`; a second test drills into Details'
   actual content (dense/sparse schema, both providers, versions,
   semidex-managed).
4. **No duplicated maintenance/metadata block** — the four pre-existing Phase
   2E regression tests (`col-docs`, `#/collections/`, `col-skel`, `col-meta`
   absence) still pass; added a fifth asserting exactly one `<details
   class="panel advanced-panel">` in the source.
5. **Search panel stays present and default-simple** — two new tests: DOM
   presence of query input/top selector/search button/Advanced disclosure,
   and a source-level check that no window/format selector exists and that
   the score checkbox/file-filter chip live inside Advanced, not the default
   row.

Two small collateral fixes, both to tests whose assertions depended on the
*old* header's specific text layout rather than its actual intent:
- `tests/unit/admin/ui-toasts.test.js`'s "health badge renders before
  Details" check used a fixed 1200-byte window into `renderCollectionHeader`'s
  source, which no longer contains the literal `<details` string (now inside
  the separate `collectionDetailsPanel()` function it calls) — rewritten to
  check the call-graph relationship instead of a byte offset.
- `tests/unit/admin/ui-test-helpers.js`'s `loadRouteIntegrationHelpers()` had
  no `setTimeout` stub, which threw whenever a test's collection had
  `warnings` (→ `showCollectionWarnings()` → `showToast()`'s 8s auto-dismiss
  timer) — a real, previously-latent gap that a new warning-badge test
  exposed; added the same no-op stub pattern already used by every other vm
  helper in this file.

**Result: 680/680 unit tests passing, 1293/1293 smoke tests passing,
`npm run admin:build` clean (no sandbox/path issues), `git diff --check`
clean, `node --check` clean on every changed JS file.**

## Live verification

Playwright/Chromium against the real, running admin server
(`node src/admin/server.js`) and the project's actual Qdrant Cloud instance —
no fixtures for collection data:

- `Курсова робота` (296 pts, semidex-managed, hybrid, skeleton nav on, no
  description in this collection's real config) — header renders exactly as
  designed: name/healthy/settings on top, no description line (correctly
  omitted, no filler text), chip row "296 points · bge-m3-onnx ·
  aapot/bge-m3-onnx · hybrid · skeleton nav on", Details collapsed by default
  and expanding to show all 10 technical rows correctly (1024d · Cosine, sparse:
  yes, both providers, schema versions 2/4/4/bge-m3, semidex-managed: yes).
- `bench-retrieval-custom-50` (98 pts, flat file list, has a real
  `description`) — description line "custom-50 quality benchmark —
  auto-managed" renders correctly under the name, chip row correctly shows
  "flat file list" instead of a skeleton-nav-on chip.
- `nodejs-basics` (1,366 pts, no description) — re-verified with a
  wait-for-title-text condition (an earlier check raced a collection switch
  and briefly observed a stale intermediate DOM state, a test-script issue,
  not an app bug) — confirmed zero `.col-header-desc` elements, clean chip
  row, zero console errors.

Zero console errors across all three collections. Screenshots confirm the
header is visually compact — no giant cards, no debug tables on the first
screen — and Details opens cleanly into a readable two-column fact table.

## Acceptance criteria check

- Opening a collection shows a useful user-facing overview, not a debug page
  — confirmed live (description + chips are the first thing seen; the
  technical table is one click away, not immediately visible).
- Settings available but secondary — unchanged position (top-right, ghost
  button), unchanged behavior, covered by a regression test.
- Details collapsed and advanced — confirmed by test and live screenshot.
- Search remains the primary workflow — `search.js` untouched; new tests
  confirm the panel's default-simple shape survived the header change.
- No fake backend features introduced — confirmed by source-level scope
  checks matching the task's explicit exclusion list.
- Tests and build pass — 680/680 unit, 1293/1293 smoke, clean build/diff.
