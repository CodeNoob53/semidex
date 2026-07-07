# Admin UI — Phase 3A Information Architecture Pivot Report (2026-07-07)

Scope: feature F0.5 from `docs/design/admin-ui-ux-and-ask-plan.md` (Phase
3A, lines 95-123) — collapse the collection detail page into sidebar
navigation + one main content surface. **Most of this phase's originally
envisioned scope was already delivered in Phase 2E**
(`docs/admin-ui-phase2e-navigation-redesign-2026-07-03.md`, 2026-07-03): a
real hash router, a recursive skeleton-tree sidebar as the primary
navigation surface, a single main content surface, and removal of the old
flat Documents/Skeleton-nav/Metadata panels (already regression-tested).
The design doc still lists Phase 3A as unstarted greenfield work — this
report corrects that: the actual delta shipped here is the URL scheme
rename to match the design doc's own naming, section/node-level routing
(previously only file-level existed), hash-sync on the two sidebar actions
that bypassed it, a collapsible collection header, and route unit tests
(previously zero).

## Already done — verified, not re-implemented (from Phase 2E)

- Hash router (`currentRoute()`/`route()`/`hashchange` listener) already
  dispatched into a single `#main` via `innerHTML` replacement; navigation
  already wrote `location.hash` directly (no bypass), so back/forward
  already worked for the route shapes that existed.
- Sidebar (`<nav class="sidebar">`) was already a recursive skeleton tree,
  not a flat list — `loadSidebarTree`/`loadSidebarFileList` already branched
  skeleton-tree vs. flat-file-list fallback per `hasSkeleton`.
- Collection detail page was already down to 3 blocks (header, search,
  file/section content-on-demand), not the original 5-panel stack —
  "Maintenance" already lived at its own `/settings` route.
- Old flat Documents/Skeleton-nav/Metadata cards already removed and
  regression-tested (`tests/unit/admin/static.test.js`, "old flat technical
  panels are removed").
- Search panel already rendered inline at the top of main, already scoped
  per-collection, already had the exact 3 always-visible controls (query,
  top-k, submit) with window/format/score/file-filter collapsed behind an
  `.advanced-box` disclosure.

## What changed

```text
src/admin/ui-src/app.js         - currentRoute(hash) takes an explicit
                                   parameter (was: read location.hash
                                   internally) — makes it a pure,
                                   zero-DOM-testable function
                                 - URL scheme renamed: #/collections/:name
                                   -> #/c/:name, /file/ -> /f/, at all
                                   6 write-sites + the router regexes
                                 - +#/c/:name/n/:nodePath route +
                                   openNodeFromPath() (resolves a bare
                                   nodePath via the existing
                                   GET .../skeleton/node endpoint, then
                                   reuses openSectionView() unchanged)
                                 - onSidebarNodeClick's section/file
                                   branches now set location.hash instead
                                   of calling openSectionView/openFileView
                                   directly — all navigation (click, back,
                                   forward, pasted URL) now goes through
                                   one path
                                 - renderCollection() gained a
                                   same-collection guard so switching
                                   file/section within the collection
                                   already on screen doesn't reset the
                                   search form (see below)
                                 - renderCollectionHeader(): description/
                                   point-count/warnings moved into a
                                   collapsible <details class="panel
                                   advanced-panel">; name/health badge/
                                   settings button stay always-visible
                                 - loadSidebarFileList()'s file links:
                                   removed a click handler that called
                                   openFileView() directly and bypassed
                                   the (already-correct) href, now just
                                   plain <a href="#/c/.../f/...">
tests/unit/admin/static.test.js - +loadRouterHelper() (vm+extractBetween,
                                   same pattern as existing DOM helpers)
                                 - +7 currentRoute() tests (home, file,
                                   section, settings, index/overview,
                                   Cyrillic decode, old-scheme rejection)
                                 - +1 header-collapsibility test
                                 - settings-button test updated for the
                                   new #/c/ prefix
                                 - +1 whole-bundle "#/collections/ fully
                                   removed" regression guard
```

No API, adapter, or CSS-rule changes — only `.panel`/`.panel-head`/
`.panel-body`/`.advanced-panel` (all pre-existing) are reused for the new
collapsible header.

## URL scheme rename

Six literal write-sites in `app.js` (sidebar row href, sidebar-collection
click handler, flat-file-list href, overview table row, settings button,
settings-page back link) plus the router's three regexes were renamed from
`#/collections/:name[...]` to `#/c/:name[...]`, matching the design doc's
own scheme (`#/c/:name`, `.../f/<sourceFile>`, `.../n/<nodePath>`). A
whole-bundle test (`assert.ok(!/#\/collections\//.test(js))`) guards
against any missed site regressing back in.

## Node-level routing

`openFileView`'s `nodePath` parameter existed but was write-only (never
read in the function body) before this phase — there was no way to
deep-link or restore a section view via URL. Added
`#/c/:name/n/:nodePath` and `openNodeFromPath(name, nodePath)`, which
resolves the bare path string (arrived via URL/back-forward, with no live
sidebar DOM node to hand off) through the existing
`GET /api/collections/:name/skeleton/node?nodePath=...` endpoint, then
delegates to the unchanged `openSectionView(name, node)` — zero duplicated
anchor-resolution logic.

## Hash sync on navigation, and the render-reset it exposed

`onSidebarNodeClick`'s section-click and childless-file-click branches
previously called `openSectionView`/`openFileView` directly, bypassing the
URL — confirmed by direct read as the one genuine gap in an otherwise
real, working router. Both branches now set `location.hash` instead, so
every navigation entry point (sidebar click, back, forward, a pasted URL)
converges on the same `hashchange` → `route()` path, rather than sidebar
clicks being a separate, URL-invisible code path.

This surfaced a real regression risk: `route()` calls `renderCollection()`
for every collection-view navigation, and `renderCollection()`
unconditionally reset `main.innerHTML` and re-ran `initSearchPanel()` —
meaning a section/file click would now also silently wipe any in-progress
search. Fixed with a same-collection guard: `renderCollection()` only
resets the shell and search panel when landing on a *different* collection
than what's already showing; switching file/section within the same
collection now preserves search state, while switching collections still
fully re-renders. The collection header still refreshes on every call
(cheap, keeps health/warnings live).

`loadSidebarFileList()`'s flat-file-list fallback had the same class of
issue in miniature: its `<a href="#/c/.../f/...">` was already correct,
but a click handler called `e.preventDefault()` and invoked `openFileView`
directly anyway, silently discarding the href. Removed the handler — the
anchor's default navigation now does the same job through the URL.

Directory/file-with-children expand/collapse intentionally still does not
touch the hash — tree-expansion is sidebar-visual-only state, not "which
content is showing," consistent with Phase 2E's own accepted limitation
that `expandedCollection` stays in-memory only.

## Collapsible collection header

`renderCollectionHeader()`: name, health badge, and the settings button
stay on an always-visible top line. Description, point count, and
inline warnings move into `<details class="panel advanced-panel">`,
reusing the exact class pairing `settings-shell.html` already uses for
"Advanced diagnostics" — read-only display info, matching that precedent
rather than the `.advanced-box` style used for actionable checkboxes
elsewhere (a distinction Phase 3A0's report already established).

No literal duplication was found with the settings page's own
always-visible health summary: they're different pages at different
altitudes of the same data — settings needs to work as a direct
bookmark/link target without ever having rendered the header first.

## Route test coverage

Previously zero — no test referenced `currentRoute`, `route()`,
`hashchange`, or `location.hash`. `currentRoute()` was refactored to accept
an explicit `hash` parameter (defaulting to `location.hash`), making it a
pure function testable with no DOM/location mocking at all. New
`loadRouterHelper()` follows the existing `extractBetween`/
`vm.createContext` pattern; one wrinkle: Vite strips the `export` keyword
from `export function startAdminApp` in the built bundle, so the end
marker is the bare `function startAdminApp`. Another wrinkle: the object
`vm.runInContext` returns is a cross-realm object, and
`node:assert/strict`'s `deepEqual` compares prototypes — structurally
identical objects failed comparison until the helper was changed to
re-serialize the return value through `JSON.parse(JSON.stringify(...))`
before returning it (safe here since every route shape is plain string
data).

## Verification

- `node --check src/admin/ui-src/app.js` / `tests/unit/admin/static.test.js` — OK.
- `npm run admin:build` — succeeds (`app.js` 54.71 kB, was 54.01 kB).
- `npm test` — 524/524 pass (was 515; +9 new tests).
- `npm run smoke` — 1293/1293 pass.
- `git diff --check` / `git diff --cached --check` — clean (routine
  CRLF/LF notices only; nothing staged).

## Known limitations

- Sidebar tree expand/collapse state is still in-memory only
  (`expandedCollection`), unchanged from Phase 2E — not synced to the URL,
  by design (see above).
- The same-collection render guard compares only collection `name`, not
  file/section — switching file/section within a collection is cheap and
  preserves search state; switching collections still fully resets the
  search form, which is the intended behavior, not a limitation, but worth
  stating for clarity.
- No chunk-index-in-URL capability was added — file vs. section remain two
  distinct route shapes (`/f/<sourceFile>`, `/n/<nodePath>`) per the design
  doc's own naming; jumping to an arbitrary chunk index from a search
  result (`openFileView(name, sourceFile, null, chunkIndex)`, used by
  "open" buttons on search results) is unchanged same-page behavior, not a
  sidebar navigation action, and was intentionally left outside this
  phase's routing scope.
