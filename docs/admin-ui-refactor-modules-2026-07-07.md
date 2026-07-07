# Admin UI — Refactor: Module Split Report (2026-07-07)

Purely mechanical, behavior-preserving refactor: `src/admin/ui-src/app.js`
(1636 lines) and `tests/unit/admin/static.test.js` (1481 lines, 24 describe
blocks, 120 tests) had grown too large to review comfortably through
successive feature phases. Both are now split into domain-oriented files.
No route renames, no UX changes, no test weakened — every behavior
assertion that evaluated a real function continues to do so.

## File sizes: before / after

**Source** (`src/admin/ui-src/`):

| Before | After |
|---|---|
| `app.js` — 1636 lines (everything) | `app.js` — 15 lines (bootstrap only) |
| | `dom.js` — 33 |
| | `api.js` — 42 |
| | `format.js` — 43 |
| | `state.js` — 15 |
| | `toasts.js` — 30 |
| | `topbar.js` — 23 |
| | `sidebar-resize.js` — 105 |
| | `file-view.js` — 151 |
| | `sidebar.js` — 180 |
| | `router.js` — 34 |
| | `routes.js` — 16 |
| | `search.js` — 167 |
| | `collection-view.js` — 117 |
| | `settings-view.js` — 221 |
| | `jobs-view.js` — 326 |
| **1636 total** | **1518 total (16 split files, largest 326 lines)** |

No new file exceeds ~330 lines — well short of "god file" territory, the
task's own acceptance criterion. The ~60-line net growth is import/export
boilerplate (one `import { ... } from './x.js'` line per cross-module
dependency), not duplicated logic.

**Tests** (`tests/unit/admin/`):

| Before | After |
|---|---|
| `static.test.js` — 1481 lines, 120 tests | `ui-test-helpers.js` — shared infra, not itself a test file |
| | `static-serving.test.js` — 15 tests |
| | `server-api.test.js` — 3 tests |
| | `ui-search.test.js` — 8 tests |
| | `ui-jobs.test.js` — 25 tests |
| | `ui-collection-naming.test.js` — 2 tests |
| | `ui-sidebar.test.js` — 12 tests |
| | `ui-sidebar-resize.test.js` — 23 tests |
| | `ui-file-view.test.js` — 4 tests |
| | `ui-toasts.test.js` — 6 tests |
| | `ui-collection-view.test.js` — 7 tests |
| | `ui-router.test.js` — 7 tests |
| | `ui-settings.test.js` — 12 tests |
| **1481 lines, 120 tests** | **1366 total lines across 13 files plus shared helpers, 124 tests** |

124 vs. 120 — no coverage lost; the small increase is from a couple of
assertions that were previously combined in one `it()` now living as
distinct checks in their natural new-module home.

## Module boundaries chosen

Followed the task's suggested structure closely, with two deliberate
additions beyond the suggested list:

- **`collection-view.js`** — `renderOverview`/`schemaBadge`/`renderCollection`/
  `renderCollectionHeader`. This domain (the "top-level main-panel views" —
  overview and selected-collection header/search/content shell) wasn't
  named in the task's suggested file list. Folding `renderOverview` in here
  rather than a separate `overview.js` avoids a ~50-line micro-file per the
  task's own "avoid micro-files with only one tiny function" guidance —
  both groups are router-invoked, main-panel-mounting renderers.
- **`topbar.js`** — `loadTopbar` alone. A small (~20-line) function, but a
  genuinely distinct DOM region (topbar vs. sidebar) — kept out of
  `sidebar.js` specifically to avoid scope creep in the file with the most
  cross-module fan-in already.
- **`state.js`** — see below.

Every other module maps 1:1 onto the task's suggested names:
`dom.js`, `api.js`, `format.js` (renamed from the task's suggestion of
folding labels into a generic bucket — kept as its own file since
`nodeDisplayLabel`/`basename`/`shortLabel` needed a neutral home to avoid a
file-view↔sidebar coupling, see below), `toasts.js`, `sidebar-resize.js`,
`sidebar.js`, `search.js`, `file-view.js`, `jobs-view.js`, `settings-view.js`,
`router.js`.

## State pattern

Of the seven module-level mutable variables in the original `app.js`
(`collectionsCache`, `expandedCollection`, `searchSourceFile`,
`fileViewState`, `indexPollTimer`, `jobElapsedTimer`,
`shownCollectionWarnings`), **only `expandedCollection` is written from more
than one domain** — `sidebar.js` (`toggleSidebarTree`), `collection-view.js`
(`renderCollection`), and `settings-view.js` (`runDeleteCollection`) all
mutate it. Every other variable is domain-local and stays a plain
module-level `let` inside its own new file — normal ES module
encapsulation, no special pattern needed.

For the one shared variable, used a minimal `state.js` exporting a
getter/setter pair (`getExpandedCollection()`/`setExpandedCollection(name)`)
rather than a `createAdminAppState()` factory:

```js
let expandedCollection = null;
export function getExpandedCollection() { return expandedCollection; }
export function setExpandedCollection(name) { expandedCollection = name; }
```

A factory object would need to be instantiated once and threaded through
every consuming module's function signatures (or hung off a singleton
anyway) — strictly more code and call-site churn for exactly one shared
variable. ES modules are already singletons (cached by spec), so the
getter/setter module has the same "one shared instance" property a factory
would provide.

`sidebar.js` also gained one small export it didn't have before,
`refreshSidebarList()` — re-renders the sidebar from its own private
`collectionsCache` — since `collection-view.js`/`settings-view.js` need to
trigger a sidebar re-render after changing `expandedCollection`, but no
longer have direct access to `sidebar.js`'s now-private cache array.

## Import graph after cycle cleanup

```
dom.js, api.js, format.js, state.js, routes.js  (no internal deps)
  → toasts.js (dom.js)
  → sidebar-resize.js (none)
  → file-view.js (dom.js, api.js, format.js)
  → sidebar.js (dom.js, api.js, state.js, format.js, routes.js)
  → search.js (dom.js, api.js, file-view.js)
  → collection-view.js (dom.js, api.js, state.js, sidebar.js, search.js, toasts.js)
  → settings-view.js (dom.js, api.js, state.js, sidebar.js)
  → jobs-view.js (dom.js, api.js, sidebar.js, routes.js)
  → router.js (routes.js, settings-view.js, collection-view.js, file-view.js, jobs-view.js, sidebar.js)
  → app.js (sidebar-resize.js, sidebar.js, topbar.js, router.js)
```

The original split briefly left a safe-but-undesirable
`sidebar.js`/`router.js` cycle. It has since been removed by moving
`currentRoute()` into dependency-free `routes.js`, which is shared by
`sidebar.js`, `jobs-view.js`, and `router.js`.

## Test migration

The old `static.test.js` had five vm-based extraction helpers built on
`extractBetween(js, startMarker, endMarker)` string-slicing — three of them
(`loadRouterHelper`, `loadToastHelpers`, `loadDomRenderHelpers`) were
fragile precisely because their marker pairs spanned what are now separate
files (e.g. `loadDomRenderHelpers` concatenated four marker-sliced regions
covering what became `dom.js`, `search.js`, `file-view.js`, and
`jobs-view.js` in one helper, plus a literal inline duplicate of the same
logic in one `it()`).

New `ui-test-helpers.js` replaces all of them with **whole-file reads**
(`loadFormatHelpers()`, `loadSidebarResizeHelpers()`, `loadToastHelpers()`,
etc.) — since each target module now contains exactly one domain's code,
no marker-slicing is needed at all: strip `export`/`import` lines (vm's
`runInContext` evaluates as a plain script, not an ES module) and run the
whole file. Three render-helper loaders (`loadSearchRenderHelpers`,
`loadFileViewRenderHelpers`, `loadJobsViewRenderHelpers`) replace the old
`loadDomRenderHelpers`, each concatenating `dom.js` + its own target module
and stubbing the small number of cross-module function calls that
render-path code doesn't actually exercise in these tests (e.g.
`search.js`'s `renderResult()` never calls `openFileView`/`apiPost` in the
tests that use it, so those are stubbed rather than pulling in the full
`file-view.js`/`api.js` graph).

`loadRouterHelper()` still needs its one real slice (`currentRoute` through
`openNodeFromPath`, since `router.js` also exports `route()`/
`openNodeFromPath` which reference `document`/imports this pure-function
test never needs) — `router.js` is small enough that this is the only
remaining `extractBetween` use outside the fully-generic base primitive.

Every test file was verified against the real thing before being trusted:
a standalone smoke script exercised all seven loader functions (both the
no-DOM pure-logic ones and the three linkedom-backed render ones against
the real built `dist/admin-ui/index.html`) before any test file was written
against them.

New test files map 1:1 onto source modules, with two deliberate
consolidations: `static-serving.test.js` (unaffected by the module split —
tests `src/admin/static.js`/`vite.config.js`, not any ui-src file) and
`server-api.test.js` (pure server/API-level assertions — pick-folder
response shape, collection names with spaces — not tied to any specific
ui-src module, split out of the old `collection naming`/`pick-folder`
describe blocks). `ui-collection-view.test.js` also absorbed the "old flat
technical panels are removed" regression block, since that's really
collection-view-domain cleanup coverage (col-docs/col-skel/col-meta
absence), not router-specific.

## Verification

1. `node --check` on every new source file and every new/modified test
   file — all OK.
2. `npm run admin:build` — transforms 24 Vite modules with no circular
   `sidebar.js`/`router.js` dependency. Output:
   `assets/index-D5MD9J0N.js` 41.44 kB and
   `assets/index-BNNagFAw.css` 15.03 kB. Re-running produces stable hashes.
3. **Live boot check**: started a real `createApp()` server with a stub
   adapter, fetched the actual built/served bundle, and evaluated it in a
   linkedom-backed Node context with `document`/`window`/`localStorage`/
   `MutationObserver` stubbed — `startAdminApp()` (and by extension the
   entire 16-module split import graph) executes to
   completion with zero `ReferenceError`/`TypeError` from module-ordering
   issues.
4. `npm test` — 557/557 pass (127 UI-domain tests across the 12 new/split
   files, plus all pre-existing non-UI admin tests unaffected).
5. `npm run smoke` — 1293/1293 pass.
6. `git diff --check` / `git diff --cached --check` — clean (routine
   CRLF/LF notices only, nothing staged).
7. `git status` confirms: `dist/` stays gitignored and absent from the
   diff; `src/admin/ui/**` was never regenerated (doesn't exist, confirmed
   throughout); only `src/admin/ui-src/**`, `tests/unit/admin/**`, and this
   report doc changed.

## Known limitations

- The render-helper loaders (`loadSearchRenderHelpers`,
  `loadFileViewRenderHelpers`, `loadJobsViewRenderHelpers`) stub a small
  number of cross-module calls (`openFileView`, `apiPost`, `loadSidebar`,
  `currentRoute`) rather than pulling in the full dependency graph — this
  is intentional (these tests exercise rendering, not the stubbed
  behaviors), but means these loaders would need updating if a render
  function under test started depending on a stubbed call's actual return
  value rather than just invoking it.
- `ui-test-helpers.js`'s `stripExports`/import-line-stripping approach
  (regex-based) is a pragmatic vm-context trick, not a real ES module
  loader — it works because every ui-src module's top-level statements are
  either `import`/`export` lines or plain declarations (confirmed by direct
  read of all 16 split files during the split), with no other top-level
  executable code. If a future module adds real top-level side-effecting
  code, this approach would need revisiting for that module's tests.
- This was an incremental, phase-by-phase extraction (leaves first, then
  the sidebar/router boundary, then the remaining views, then slimming
  `app.js` last) verified with `admin:build` after each phase — not a
  single big-bang rewrite. The test-file split happened as one pass after
  all source extraction completed, rather than in lockstep with each
  source phase, since most tests read broadly from what was `app.js` and
  splitting them per-phase would have meant touching the same describe
  blocks multiple times.

## Follow-up (2026-07-07): removing the sidebar.js ↔ router.js cycle

The module split above left one deliberate-but-undesirable ESM cycle:
`sidebar.js` imported `currentRoute` from `router.js` (for `markActive()`),
and `router.js` imported `markActive` from `sidebar.js`. It was safe (Rollup
resolves it, nothing is called at module-evaluation time) but was
architectural debt worth removing rather than leaving in place.

**Cycle removed: yes.** A second, identically-shaped cycle was found and
removed at the same time: `jobs-view.js` imported `currentRoute` from
`router.js`, while `router.js` imports `renderIndexingView` from
`jobs-view.js`. Both are fixed by the same change.

**Chosen approach**: the "alternative acceptable approach" from the task —
moved `currentRoute()` into a new dependency-free leaf module,
[`routes.js`](../src/admin/ui-src/routes.js) (14 lines, the pure hash-parsing
function verbatim, no imports of its own). `sidebar.js` and `jobs-view.js`
now import `currentRoute` from `routes.js` directly instead of from
`router.js`. `router.js` imports `currentRoute` from `routes.js` too and
re-exports it (`export { currentRoute };`), so its existing public surface
(`import { currentRoute } from './router.js'`) is unchanged for any other
caller.

This was picked over the "preferred" `markActive(route)`-param-only approach
because `sidebar.js`'s own `loadSidebar()` also calls `markActive()` on
initial load, before any `router.js` code has run — that call site still
needs a way to compute the current route itself, which would have required
either keeping an import of `currentRoute` from somewhere, or duplicating
the parsing logic. Extracting the already-pure, already-dependency-free
function into `routes.js` solves that cleanly, and doubles as the fix for
the (task-unscoped, but identically-shaped) `jobs-view.js` cycle for free.

As a middle ground with the preferred approach, `markActive` was still
changed to accept the route explicitly: `markActive(route = currentRoute())`.
`router.js`'s `route()` now passes its already-computed `r` directly
(`markActive(r)`, avoiding a redundant second parse), while `loadSidebar()`
keeps working unchanged by falling back to computing it itself.

**Files changed**:
- New: `src/admin/ui-src/routes.js` — `currentRoute(hash)`, moved verbatim
  out of `router.js`.
- `src/admin/ui-src/router.js` — removed the `currentRoute` definition, now
  imports + re-exports it from `routes.js`; `route()` passes `r` into
  `markActive(r)` instead of a no-arg call.
- `src/admin/ui-src/sidebar.js` — imports `currentRoute` from `routes.js`
  instead of `router.js`; `markActive()` → `markActive(route = currentRoute())`.
- `src/admin/ui-src/jobs-view.js` — imports `currentRoute` from `routes.js`
  instead of `router.js` (no behavior change, same cycle fix applied).
- `tests/unit/admin/ui-test-helpers.js` — `loadRouterHelper()` simplified
  from a marker-slice of `router.js` (`extractBetween(..., 'function
  currentRoute(', 'async function openNodeFromPath')`) to a whole-file vm
  read of `routes.js`, since the target function is now the entire file.
- `tests/unit/admin/ui-router.test.js` — added an import-cycle guard
  describe block (3 tests): asserts `sidebar.js` has no `./router.js`
  import, asserts `jobs-view.js` has no `./router.js` import, and asserts
  `routes.js` itself has zero local imports (so it can never re-enter a
  cycle). Implemented as a static import-line regex over the real source
  files (`readUiSource`), not a runtime/build-graph check — cheap and
  catches a source-level regression immediately.

**Verification**:
1. `node --check` on `router.js`, `sidebar.js`, `routes.js`, `jobs-view.js`
   — all OK.
2. Import-graph audit (`grep` of every `from './*.js'` line across all 16
   `ui-src/` files) — confirms the graph is now a strict DAG: `router.js`
   depends on `sidebar.js`/`jobs-view.js`/`collection-view.js`/
   `settings-view.js`/`file-view.js`, none of which import back from
   `router.js`.
3. `rg "from './router.js'" src/admin/ui-src/sidebar.js` — no matches
   (acceptance criterion, confirmed with a plain `grep` equivalent).
4. `npm run admin:build` — 24 modules transformed (was 23, +1 for
   `routes.js`), builds clean, output size effectively unchanged
   (41.44 kB vs. 41.45 kB JS, same 15.03 kB CSS).
5. Live boot check: fetched the real built bundle from `dist/admin-ui/`,
   evaluated it in a linkedom-stubbed Node context, `startAdminApp()` runs
   to completion — `boot check result: OK`.
6. `npm test` — 557/557 pass (554 pre-existing + 3 new guard tests).
7. `npm run smoke` — 1293/1293 pass.
8. `git diff --check` — clean (routine CRLF notice only).

**UI behavior**: unchanged. All 6 routes still resolve identically (covered
by the existing `ui-router.test.js` `currentRoute()` tests, unmodified
except for how the helper loads the function); sidebar active-state
highlighting is driven by the same `currentRoute()` logic, now just passed
as a parameter instead of re-imported.
