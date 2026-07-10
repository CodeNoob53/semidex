# Admin UI Phase 3I — Collection Header / Details Redesign

2026-07-10

## Starting point

This phase's requirements were, almost field-for-field, what Phase 3G (and
its subsequent code-review fixes) had already built: name + health badge +
settings on top, a summary block preferring `overviewSummary` over a config
`description` with a quiet empty-state fallback, compact metric pills
(chunk count, provider/model short form with a "local" hint, search mode,
navigation status), and a genuinely secondary collapsed `Details` panel
holding the exact technical fields (dense vector size/distance, sparse
status, both providers, schema/chunking/token versions, semidex-managed,
exact point counts). No card-in-card nesting, no giant JS HTML blob (the
header is built from a handful of small template-literal helper functions),
summary text in regular prose (not mono), pills in mono.

An audit against the task's literal requirements found the redesign itself
was already done — the real remaining gaps were two specific, fixable
issues:

1. The empty-summary fallback text didn't match the task's specified
   copy (`"No overview yet. Reindex with LLM summaries to generate one."`
   vs. the requested `"No collection summary yet."`).
2. **A real visual bug**: `.col-header-top` is a flex row with
   `justify-content: space-between`, and `.view-title` had no
   `min-width: 0` or `overflow-wrap` rule. Flex items default to
   `min-width: auto` (their content's intrinsic width), so a sufficiently
   long, hyphen/space-free collection name (uncommon in this dataset's
   real collections, but not excludable — collection names are
   user-chosen) would overflow past the settings button, pushing it off
   the visible viewport entirely rather than wrapping. Confirmed live with
   a synthetic pathological name before fixing, and again after, to
   verify the fix actually resolves it.

## What changed

### Fix: fallback summary wording

`src/admin/ui-src/collection-view.js`'s `renderCollectionHeader()` — the
empty-state fallback text now reads exactly *"No collection summary yet.
Reindex with LLM summaries to generate one."* (previously *"No overview
yet. ..."*), matching the task's specified fallback copy while keeping the
explanatory second sentence from the earlier Phase 3G code-review fix
(explains *why* it's empty, not just that it is).

### Fix: long collection names wrap instead of overflowing

`src/admin/ui-src/app.css`'s `.col-header-top` rule gained `flex-wrap:
wrap` (lets the health badge/settings button drop to their own row if the
title needs the space), and `.col-header-top .view-title` gained:

```css
.col-header-top .view-title { margin: 0; flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
```

`min-width: 0` lets the title flex item shrink below its own intrinsic
content width (the actual fix — without it, `overflow-wrap` alone has no
effect inside a flex row, since the item simply won't shrink far enough to
need wrapping). `overflow-wrap: anywhere` covers names with no natural
break points (a single long word/token, more likely in non-Latin scripts
without hyphenation) that default word-breaking rules would otherwise let
overflow.

Live-verified with a synthetic pathological name (120 characters, no
spaces or hyphens): before the fix, the title overflowed the viewport and
the settings button was pushed entirely off-screen and unreachable; after
the fix, the title wraps to 3 lines, the health badge and settings button
drop to their own row below it, and both stay fully visible and clickable.
Confirmed no regression on a normal-length real collection name (unchanged
single-line layout).

### Confirmed already correct (no change needed)

Everything else in the task's spec — verified by reading the current code
and its Phase 3G test suite, not re-implemented:

- **Header content**: name, health badge, summary (skeleton overview >
  config description > fallback), metric pills (chunks / provider-model /
  search mode / navigation status), settings button present but visually
  secondary (a `.btn-ghost`, not the primary amber action).
- **Details block**: collapsed by default, contains only the technical
  fields the task lists (dense vector size/distance, sparse yes/no, both
  providers by their full string, schema/chunking/token versions,
  semidex-managed, exact raw point count) — none of these duplicate into
  the header; the header's pills use different, simplified labels/values
  for the same underlying facts where they overlap (e.g. header shows
  `"194 chunks"`, Details shows `"points: 296"` — the exact, nav-inclusive
  raw count, a deliberately different number per the Phase 3G P1 fix).
- **Settings/maintenance**: indexing/reindex/delete/sync-schema/source-path
  all live behind the settings route (`settings-view.js`), not in the main
  header — confirmed by the existing "old flat technical panels are
  removed" test suite and by reading `settings-view.js` directly; this
  phase touched nothing there.
- **No card-in-card nesting**: the header is one flat block (title row →
  summary paragraph → pill row → collapsed Details) inside the existing
  `.col-header` container, not a card wrapping other cards.
- **No giant HTML blob in JS**: `renderCollectionHeader()`,
  `collectionFactChips()`, and `collectionDetailsPanel()` are three small,
  separately-named template-literal helpers, each responsible for one
  piece — not one large inline string.
- **Data contract**: uses only existing fields already returned by
  `GET /api/collections/:name` (`name`, `warnings`, `overviewSummary`,
  `description`, `chunkCount`, `pointCount`, `provider`, `vectorSchema`,
  `hasSkeleton`, `semidexManaged`, `versions`) — no new backend field was
  added, and every access already goes through `?.`/`?? default`, so a
  missing field degrades to an omitted chip or an "unknown" Details row
  rather than crashing (verified with a dedicated empty-`{}` test — see
  Tests below).

## Tests

`tests/unit/admin/ui-collection-view.test.js` (31 → 33 in this phase, plus
1 existing test's assertion text updated):

- **Long-name wrap fix**: a rendered-DOM test confirming a long/Cyrillic
  collection name still renders both the health badge and settings button
  as sibling elements (linkedom has no layout engine, so this can't assert
  actual pixel wrapping — that was verified live instead, see below); a
  source-string test pinning the actual CSS fix (`min-width: 0` +
  `overflow-wrap: anywhere` on `.col-header-top .view-title`) as a
  regression guard, confirmed via revert/re-test/restore to fail against
  the pre-fix CSS.
- **Fallback wording**: updated the existing empty-summary test's
  assertion from `/No overview yet/` to `/No collection summary yet/`.
- **Missing fields / no crash**: new test passing a completely empty
  `{}` collection detail object (not just a partially-sparse fixture) and
  asserting `route()` doesn't reject, plus that the title/health-badge/
  summary-fallback all still render.
- **Escaping**: 2 new tests — a collection name containing
  `<img onerror=...>` renders as inert text in `.view-title` (never a
  parsed element); an `overviewSummary` containing the same payload
  renders as inert text in `.col-header-desc`.
- Everything else (pills showing chunk count/provider-model/search
  mode/navigation status, Details collapsed-by-default and technical-only,
  no duplicate raw fields in the header, search panel unaffected) was
  already covered by the existing Phase 3G/3G-code-review test suite and
  re-run unchanged.

## Verification run

- `npm test` — 733/733 passing (728 baseline + 5 new).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings).
- Live Playwright verification against the real Qdrant Cloud instance:
  - A synthetic 120-character, space/hyphen-free name: before the CSS fix,
    title overflowed the viewport and the settings button was pushed
    fully off-screen; after the fix, the title wraps to 3 lines and both
    the health badge and settings button remain visible on their own row.
  - A real collection (`Курсова робота`) at normal width: unchanged
    single-line header layout, no visual regression from the flex-wrap/
    min-width changes.
  - A real collection with no `overviewSummary` (`nodejs-basics`):
    fallback text reads exactly *"No collection summary yet. Reindex with
    LLM summaries to generate one."*
  - No console/page errors during any of the above.

## Known limitations / follow-ups

- No real collection in the currently-indexed datasets has a name long
  enough to trigger the wrap fix in normal use — it was verified with a
  synthetic name. The fix is defensive (collection names are user-chosen
  at index time, so an unusually long one is plausible even if none exists
  today), not a response to an observed real failure.
- Per the task's explicit non-goals, no backend fields were added and none
  of Ask mode, snapshots, aliases, cloud provider settings, new search
  behavior, file browser changes, or indexing job changes were touched.
