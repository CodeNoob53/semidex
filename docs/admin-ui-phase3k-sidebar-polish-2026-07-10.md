# Admin UI Phase 3K — Sidebar / File Manager Polish

2026-07-10

## Starting point

An upfront audit (before writing any code) checked the current sidebar
implementation against all 6 requirement areas in the task spec. Five of
six areas — resizable sidebar (width persistence, clamping, keyboard
control), tree row visual hierarchy (icons, indentation, active-state),
file/folder label content (basename/directory-segment/tooltip logic),
collection-level counts (no gratuitous extra fetches), and keyboard/
accessibility (focusable rows, Enter/Space activation, a separate
keyboard-reachable expand control) — were already fully implemented and
already had solid test coverage from Phases 2E/3A/3C/3D. No rework was
needed there; re-implementing any of it would have been redundant churn
against a spec whose intent ("make the sidebar feel like a real file
browser") was already met.

The audit did surface two genuine, previously-untested bugs, both fixed
this phase:

1. **`.tree-label` was missing `min-width: 0`.** A flex item's default
   `min-width` is its own intrinsic (unwrapped) content width, not `0` —
   this silently defeats `overflow: hidden`/`text-overflow: ellipsis` for
   any label with no natural break points. A long, unbroken collection
   name would not actually truncate; it would force the row wider than
   the sidebar, pushing the trailing `.count` badge off-screen. The
   identical bug class was already found and fixed for
   `.col-header-top .view-title` in Phase 3I — that fix was never applied
   to `.tree-label`.
2. **Raw fetch/API error text leaked into the sidebar tree.** Three call
   sites (`loadSidebar()`, `loadSidebarTree()`, `loadSidebarFileList()`)
   rendered `err.message` — either an internal server error string or the
   bare fallback `HTTP {status}` — directly into the tree, using the exact
   same `.tree-loading` styling as a legitimate "nothing here yet" empty
   state, with no visual or textual way to tell "this is empty" apart from
   "this failed to load."

## What changed

### Fix: `.tree-label` truncation (`app.css`)

```css
.tree-label {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
```

Verified live with a synthetic 130-character unbroken name at a narrow
340px sidebar width: the label now correctly ellipsizes (`scrollWidth`
943px clipped to a `clientWidth` of 233px) and the `.count` badge stays
fully within the viewport, versus overflowing before the fix.

### Fix: distinct error state in the sidebar tree (`sidebar.js`, `app.css`)

New `treeErrorBox(err)` helper renders a calm, generic message —
*"Couldn't load this. Try again."* / *"Couldn't load collections. Try
again."* — instead of the raw `err.message`, applied at all three
fetch-failure sites. The real error text is preserved as a `title`
tooltip attribute (still available to anyone who needs it, e.g. via
right-click "Inspect"), just not shown as the primary visible text. A new
`.tree-error` CSS class (muted warm-red, reusing `--fail`) makes a failed
load visually distinct from `.tree-loading`'s neutral empty/loading tone,
without pulling in the heavier `.error-box` treatment sized for the main
content panel.

Also reworded two legitimate empty-state strings to be slightly more
actionable, per the task's "empty collection should say what user can do
next" requirement: *"no collections yet"* → *"No collections yet. Create
one to get started."*; *"No documents."* → *"No documents indexed in this
collection yet."*

### Confirmed already correct (no change needed)

- Resizable sidebar: handle, `localStorage` persistence
  (`semidex-admin-sidebar-width`), clamping (`SIDEBAR_MIN_WIDTH = 240`,
  `SIDEBAR_MAX_WIDTH = 520`), full keyboard control (arrows, Home/End,
  Enter/Space reset) — `sidebar-resize.js`, unchanged.
- Icons per node type (`collection`, `directory`, `file`, `section`,
  `table`, `code_block`, `checklist`) via `icons.js`'s `iconForNodeType()`
  — unchanged.
- Consistent 14px-per-depth-level indentation, hover/active-state CSS,
  and `markActive()`'s route-driven (not expansion-driven) highlighting of
  the currently open file/section — unchanged.
- `nodeDisplayLabel()`/`basename()`/`shortLabel()` (`format.js`) —
  basename for files, last segment for directories, full `node_path` kept
  in the `title` tooltip only, never the visible label — unchanged.
- Collection-level `pointCount` badge sourced directly from the already-
  fetched `/api/collections` list response — no separate per-collection
  fetch. No per-file/per-section count is rendered anywhere (correctly
  absent, per the task's "do not invent count fetches" instruction).
- `hasSkeleton: false`, a `skeleton: null` 200 response, and a thrown
  skeleton fetch all correctly degrade to the flat file list — unchanged,
  now behaviorally tested (see below).
- Tree rows are keyboard-focusable (native `<a>` for collection/file rows,
  explicit `tabindex="0" role="button"` for skeleton nodes), Enter/Space
  activate them, and the expand/collapse caret is its own separate
  keyboard-reachable target (`stopPropagation()` on both click and keydown
  so it never also triggers the row's open/navigate action) — unchanged.
  One known, already-self-documented ARIA nesting issue (`role="button"`
  span inside `role="button"` div when a caret is clickable) remains
  deliberately deferred, per its existing "not blocking" comment — out of
  this phase's scope, not silently reintroduced or worsened.

## Tests

New `loadSidebarTreeHelpers()` test helper in `ui-test-helpers.js` — drives
`loadSidebar()`/`loadSidebarTree()`/`loadSidebarFileList()` against a real
DOM with a URL-substring-keyed `api()` stub (same convention as
`loadFileViewBehaviorHelpers`/`loadRouteIntegrationHelpers`), so these
functions' empty/error/fallback branches can finally be asserted on as
real rendered DOM, not just source-text regex matches. Uses a
longest-matching-key strategy (not first-match) so a broad key like the
bare collection-detail URL can't accidentally shadow a more specific
`/documents` or `/skeleton` endpoint stub — a real ambiguity discovered
and fixed while writing these tests, not a hypothetical.

`tests/unit/admin/ui-sidebar.test.js` — 10 new tests:

- No collections at all → calm actionable message, no technical text.
- Collection list fetch fails → distinct `.tree-error`-styled message,
  real error preserved only in `title`, not the visible text.
- `hasSkeleton: false` → flat file list renders correctly.
- Skeleton root is `null` (a valid 200, not an error) → falls back to the
  flat file list, not an error state.
- Skeleton fetch throws → falls back to the flat file list, not a raw
  error.
- Flat file list is genuinely empty → clean "No documents" message, not
  raw API text, not styled as an error.
- Collection-detail fetch fails → distinct error state, raw backend
  message not shown verbatim.
- Flat file list fetch itself fails → distinct error state, raw
  `HTTP 500`-style fallback text not shown verbatim.
- `.tree-label` CSS source-check: `min-width: 0` present alongside the
  existing `overflow: hidden`/`text-overflow: ellipsis` rules.
- Collection row count badge: renders `pointCount` locale-formatted
  straight from the already-fetched list (`12,345`, and correctly shows
  `0` rather than omitting the badge for an empty collection) — confirming
  no extra per-collection fetch is made.

All 10 new tests were verified via revert/re-test/restore to fail against
the pre-fix code before being confirmed passing against the final code.

## Verification run

- `npm test` — 748/748 passing (738 baseline + 10 new).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings).
- Live Playwright verification against the real Qdrant Cloud instance:
  - A synthetic 130-character unbroken collection name at a 340px sidebar
    width: label ellipsizes correctly, count badge stays fully visible,
    row width stays reasonable (324px, not blown out past the viewport).
  - Keyboard: focused a directory tree row via Tab, pressed Enter —
    confirmed it expanded (`.tree-subtree` count went from 0 to 1), no
    console errors.
  - Resize handle: dragged it via real mouse events, confirmed the new
    width (420px) was written to `localStorage` under
    `semidex-admin-sidebar-width`.
  - A stray empty test collection (`phase3j-test-throwaway`, an artifact
    from Phase 3J's live-verification job) was noticed during this
    session's live testing and deleted via the admin API to avoid leaving
    test data in the real Qdrant instance.

## Limitations / follow-ups

- The already-documented ARIA nesting issue (nested `role="button"`
  elements when a tree row's caret is independently clickable) remains
  unresolved — it was flagged as "not blocking" in an earlier phase and
  this task's scope was sidebar polish, not an accessibility rewrite.
  Still tracked via its existing in-source comment.
- `.tree-error`'s styling is intentionally minimal (color only, reusing
  `.tree-loading`'s existing padding/layout) rather than a full icon-
  plus-retry-button treatment — matches the task's "no raw API/debug
  errors in normal empty states" requirement without introducing a new
  interactive retry affordance the task didn't ask for.
