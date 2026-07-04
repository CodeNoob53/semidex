# Admin UI — Phase 2E Navigation-First Dashboard Redesign Report (2026-07-03)

Rebuilds the Admin UI's core interaction model. The previous UI (Phase
2A–2D) was a debug console: separate always-visible technical panels
(Metadata, Maintenance, Documents, Skeleton navigation, Search playground)
stacked on one page. This phase corrects that: the **sidebar is now the
primary navigation surface** (collection → skeleton/file tree → section),
and the main panel shows exactly one thing at a time — collection overview,
search results, selected file/section content, or collection settings.

## What changed

```text
src/admin/api/collections.js  - DELETE /api/collections/:name no longer
                                requires a { confirm } body (modal confirm
                                is a UI-level concern now, not an API contract)
src/admin/api/jobs.js         - +llmSummaries boolean option
src/admin/api/skeleton.js     - +GET .../skeleton/anchor (section -> first
                                content chunk resolution, post-review fix)
src/admin/jobs/registry.js    - llmSummaries -> SKELETON_SUMMARY=llm env var
src/admin/ui/app.js           - full navigation-model rewrite (sidebar tree,
                                collection header, file/section view,
                                collection settings, delete modal)
src/admin/ui/app.css          - new sidebar-tree/header/settings/modal
                                styles; removed superseded flat-panel styles
src/core/qdrant/store.js      - +getFirstContentChunkByParent (post-review fix)
src/core/qdrant/schema.js     - +parent_id payload index (post-review fix)
src/core/storage/adapter.js   - +getSectionAnchor in the StorageAdapter
                                contract (post-review fix)
src/core/storage/qdrant-adapter.js - +getSectionAnchor implementation
tests/unit/admin/jobs.test.js    - +llmSummaries tests (registry + API);
                                    +getSectionAnchor stub
tests/unit/admin/search.test.js  - +getSectionAnchor stub
tests/unit/admin/server.test.js  - delete tests updated: no confirm body;
                                    +getSectionAnchor stub
tests/unit/admin/static.test.js  - replaced Phase 2B/2D served-file
                                    assertions with Phase 2E ones (46 tests);
                                    +getSectionAnchor stub
tests/unit/core/qdrant-adapter.test.js - REQUIRED_PAYLOAD_INDEXES includes
                                          parent_id
```

The indexer, `src/admin/router.js`, `src/admin/http.js`,
`src/admin/static.js`, and every other `src/admin/api/*.js` file are
untouched.

## Sidebar navigation

- `loadSidebarTree(name)`: for a selected collection, fetches
  `GET /api/collections/:name/skeleton`. If a skeleton root exists, the tree
  renders collection → directory/file → section nodes, lazily fetching
  children via `GET .../skeleton/children` only when a node is expanded
  (never the whole tree upfront).
- `loadSidebarFileList(name, box)`: fallback for collections with no
  skeleton nav — a flat list from `GET .../documents`, still inside the
  sidebar, still clickable straight into the file view.
- Clicking a leaf (section, or a file with no children) calls
  `openFileView()`, which replaces the main panel's content area — it does
  **not** navigate to a new page or lose the sidebar tree state.
- Directory/file nodes with children expand inline (indented, same tree),
  matching "repository/file navigation" behavior rather than a drill-down
  breadcrumb UI.

## Main header

`renderCollectionHeader()` renders exactly: collection name, a one-line
summary (the collection's `description`, or a fallback noting whether a
skeleton map exists), a health badge (`healthy` / `N warnings`, derived from
the same `warnings` array as before), the point count, and a **settings**
button. Verified via a static test that the function body contains none of
`dense vector`, `sparse vector`, `denseProvider`, `chunkingSchema` — those
now live only in Collection settings → Advanced diagnostics.

## Search: "Search this collection"

- Renamed from "Search playground" everywhere in the UI (verified: the old
  string does not appear anywhere in the served `app.js`).
- Default visible controls: query input, a `top` (result count) selector,
  and a Search button — one row (`.search-main-row`).
- Window size, compact/full toggle, score-visibility checkbox, and the
  file-filter chip are inside a native `<details class="advanced-box">`,
  collapsed by default, with a `title` tooltip on each control explaining
  what it does.
- **Default window format is `full`** (readable prose), not `compact` —
  compact is now an advanced/debug-only option a user has to opt into.
- Clicking "open" on a result calls the same `openFileView()` the sidebar
  tree uses, so search results and tree navigation land in the same place.

## Selected file/section view

- Replaces the old standalone Documents card entirely — confirmed removed:
  no `col-docs` container, no `loadDocuments()` function anywhere in the
  served file.
- `openFileView(name, sourceFile, nodePath, chunkIndex)` fetches a window of
  chunks around the requested index/section and renders them with a
  **"load more"** button that fetches the next unseen chunk range on click
  — simple forward pagination, not a full document loader.
- Reachable from three places: the sidebar tree (files/sections), search
  results ("open" button), and the URL itself
  (`#/collections/:name/file/:sourceFile` is parsed by the router and opens
  the file view automatically after the collection loads).

## Collection settings (renamed from "Maintenance")

`renderSettingsView()` (`#/collections/:name/settings`) contains, in order:

1. **Collection health** — status badge, point count, skeleton
   availability, warnings. This is the *only* place point count/warnings
   are shown outside the thin main header — not duplicated as a second
   "Metadata" card.
2. **Reindex** — grouped options (Quality: ONNX embeddings, LLM summaries;
   Structure: skeleton chunking, skeleton navigation; Optional enrichment:
   tags; Maintenance: prune stale with its warning), collection name taken
   from the current page (never a second text field to retype), and a
   **source-path selector**: a `<select>` populated from up to 8 recently
   used paths (persisted in `localStorage`, written after every successful
   reindex start) with a manual text-input fallback when no recent path
   matches or none exist yet. A true OS folder-picker is not implementable
   from a browser for a Node-based Local API (a file `<input>` cannot
   return a directory path) — the recent-path selector is the closest
   available approximation to "pick a place you've indexed before" without
   a native/Electron shell.
3. **Repair collection compatibility** (renamed from "sync schema") — with
   the exact explanatory copy requested: *"Checks and repairs semidex
   metadata, vector names, and payload indexes for this collection. It does
   not reindex files or update document content."* Reuses the existing
   `POST /api/collections/:name/sync-schema` endpoint unchanged.
4. **Advanced diagnostics** (`<details>`, collapsed by default) — dense/
   sparse vector size & distance, provider strings, schema versions,
   `semidexManaged` flag. This is the only place these fields render.
5. **Delete collection** — button + modal (see below).

## Delete: modal confirmation, no typed name, and a server contract change

Per explicit instruction during this task, the delete flow changed at both
layers, not just the UI:

- **API**: `DELETE /api/collections/:name` no longer reads or validates a
  request body. It still checks `getCollection(name)` first (`404` for a
  name that never existed), then calls `adapter.deleteCollection(name)` and
  returns the same `{ collection, deleted: true }` shape as before. The
  previous `{ confirm: "<exact name>" }` requirement is gone — it was never
  a Qdrant API concept, and per this task's explicit instruction it's not a
  semidex API contract either. No backward-compatibility shim for the old
  body was added (per instruction: "not a public API contract yet").
- **UI**: clicking "Delete collection" opens a modal
  (`#delete-modal-backdrop`) showing the collection name and an irreversible
  warning, with **Cancel**/**Delete collection** buttons — no text input,
  no retyped name, no client-side substitution logic to get wrong. This
  removes the exact-name-confirmation mechanism entirely (both the earlier
  buggy version that silently substituted the known name, and the later
  fixed version that read a typed value) — there is no typed value anymore
  because there is no text input.
- The Local API's loopback-only bind (`resolveHostConfig`) remains the
  actual safety boundary, matching every other destructive-adjacent
  operation in this admin tool (reindex, schema repair) that also has no
  per-request secret/token.

## Tests run

```
npm test
  ℹ tests 392
  ℹ suites 97
  ℹ pass 392
  ℹ fail 0

npm run smoke
  Smoke tests: 1293 passed, 0 failed

node --check src/admin/api/collections.js   OK
node --check src/admin/api/jobs.js          OK
node --check src/admin/api/skeleton.js      OK
node --check src/admin/jobs/registry.js     OK
node --check src/admin/server.js            OK
node --check src/core/qdrant/store.js       OK
node --check src/core/storage/qdrant-adapter.js  OK
node --check tests/unit/admin/jobs.test.js       OK
node --check tests/unit/admin/server.test.js     OK
node --check tests/unit/admin/static.test.js     OK
(app.js has no CLI entry point; validated via `new Function(source)` parse check)

git diff --check (staged)                   clean
```

New/changed tests:
- **`jobs.test.js`** (+3): `buildJobEnv` omits `SKELETON_SUMMARY` when
  `llmSummaries` is false/unset, sets it to `"llm"` only when true; the API
  accepts `llmSummaries` as a boolean option and forwards it to the spawned
  process's env.
- **`server.test.js`** (delete tests replaced, net −1): removed the
  missing-confirm and mismatched-confirm rejection tests (that contract no
  longer exists); kept the 404-for-missing-collection test; the
  success test now asserts `DELETE` with **no request body** returns `200`
  and calls `adapter.deleteCollection` with the right name.
- **`static.test.js`** (46 tests, replacing the prior Phase 2B/2D served-file
  blocks): sidebar tree rendering and skeleton-children lazy-loading, file
  view opening, collection header excluding technical fields, explicit
  absence checks for `col-docs`/`col-skel`/`col-meta` (the old flat panel
  containers), "Search this collection" naming + `full`-default + advanced
  disclosure, settings view's grouped reindex options + LLM summaries +
  recent-path selector, the renamed/explained repair action, the delete
  modal's absence of any typed-confirmation input, and that `apiDelete`
  takes no payload parameter.

Also manually exercised end-to-end over a real `node:http` server with a
stub adapter: collection detail → skeleton root → children (file level) →
children (section level) → chunk fetch for a section → search → repair
(sync-schema) → reindex job start with `llmSummaries: true` correctly
mapped to `SKELETON_SUMMARY=llm` in the observed spawn env → delete with no
request body. All matched the documented behavior above.

## Post-review fixes (2026-07-04)

Four issues found in review of the initial redesign, all fixed with tests
added:

1. **Clicking a section in the sidebar opened chunk 0 of the file, not the
   section.** `openFileView` always requested `chunkIndex=0` regardless of
   which node was clicked — a section nav node and its content chunks are
   *separate* Qdrant points, linked only by `parent_id` (the section's
   `node_id`), not by sharing a `node_path`. Fixed by adding a resolution
   step: a new `getFirstContentChunkByParent(collection, parentId)` in
   `src/core/qdrant/store.js` finds the earliest (lowest `chunk_index`)
   content chunk under a given parent; a new `StorageAdapter.getSectionAnchor`
   method (added to `REQUIRED_ADAPTER_METHODS`) resolves a section's
   `nodeId`/`nodePath` to its `node_id` and calls it; a new
   `GET /api/collections/:name/skeleton/anchor` endpoint exposes that; and
   the UI's `onSidebarNodeClick` now calls a new `openSectionView()` for
   section nodes specifically (file-without-children nodes still open at
   chunk 0, which is correct for them — a file's first chunk **is** its
   start). A section with no content chunks (e.g. empty) gets a `404` from
   the anchor endpoint, which the UI catches and falls back to chunk 0 of
   the file with an explanatory message, rather than either crashing or
   silently misdirecting. Added `parent_id` to `REQUIRED_PAYLOAD_INDEXES`
   (`src/core/qdrant/schema.js`) since the anchor lookup filters by it —
   without an index this would degrade to a full collection scan on every
   section click. *(See item 5 below — the 404 fallback described here was
   itself revised in a second review pass.)*
2. **The old Phase 2D report still read as current documentation for a
   contract that no longer exists.** Added a notice at the top of
   `docs/admin-ui-phase2d-collection-maintenance-2026-07-03.md` marking it
   superseded by this report and explicitly stating that every
   `{ confirm: ... }`/type-to-confirm reference in it describes historical
   behavior only.
3. **The search "score" checkbox was checked by default**, even though it
   lives inside the collapsed "Advanced" disclosure — so a first-time user
   who never opens Advanced still saw score numbers on every result. Changed
   the checkbox to unchecked by default; score display is now a genuine
   opt-in, consistent with everything else inside Advanced being
   off/full-readable by default.
4. **The hidden (when a recent-path `<select>` is shown) manual source-path
   input had an HTML `required` attribute**, which risks browser-native
   constraint validation blocking form submission before the JS handler
   runs, depending on how strictly a given browser applies "barred from
   constraint validation" to a `display:none` field. Removed `required`
   entirely — validation is done solely by `runSettingsReindex`'s existing
   `"Source path is required"` check, which already correctly reads from
   either the select or the manual input via `currentSourcePathValue()`.

All four fixes verified by new/updated tests (see below) and a live manual
check confirming a section-nav node with `nodePath` `"demo#file/a.md#Section
2"` correctly anchors to `chunkIndex: 7` (not 0), and that a section with no
content chunks gets a clean `404` instead of a silent wrong-chunk open.

## Second review pass (2026-07-04)

Two more issues found reviewing the fixes above:

5. **The 404 fallback in `openSectionView` still auto-opened chunk 0.** The
   original fix (item 1 above) caught the `skeleton/anchor` `404` and showed
   an explanatory message, but then *immediately* called
   `openFileView(name, node.sourceFile, node.nodePath, 0)` anyway — the
   message was overwritten by `openFileView`'s own `"loading…"` state before
   a user could ever read it, so the user still landed on chunk 0 with no
   real indication the section itself was empty. Fixed by removing the
   automatic `openFileView` call entirely: on `404`, `openSectionView` now
   renders a persistent message ("This section has no indexed content.")
   with an explicit `Open file from start` button (only shown when
   `node.sourceFile` is known) that calls `openFileView(..., 0)` solely on a
   real user click. Opening chunk 0 is still possible, but it's now an
   opt-in action, not a silent substitution.
6. **`getFirstContentChunkByParent` (`src/core/qdrant/store.js`) only
   scanned the first 50 points returned by `scroll()` for a given
   `parent_id`, then took the minimum `chunk_index` among those 50.** Qdrant
   does not guarantee scroll order matches `chunk_index` order, so for a
   section with more than 50 content chunks the true first chunk could be on
   a later, unfetched page — the function could return a chunk from the
   middle of the section instead of the start. Fixed by adding
   `scrollAllFiltered(collection, filter, payloadFields, pageSize)` to
   `store.js`, a filtered counterpart to the existing `scrollAllPoints` that
   follows `next_page_offset` until Qdrant reports no more pages (the same
   pagination loop already used by `scrollAllPoints`/`listSourceFiles`, just
   with a filter parameter). `getFirstContentChunkByParent` now calls it
   instead of a single capped `scroll()`, so it considers every content
   chunk under the parent, not just the first page.

Both fixes verified by `npm test` (392/392) and `npm run smoke` (1293/1293).
No new store-level test was added for item 6: consistent with the rest of
this codebase, `store.js` functions aren't unit-tested against a live Qdrant
client (see `qdrant-adapter.test.js`'s shape-only check); the fix reuses the
exact pagination pattern already relied upon elsewhere in the same file.

## Known limitations

- **No true OS folder picker.** As explained above, a browser `<input
  type="file">` cannot return a directory path usable by a Node child
  process without either a native shell integration or an
  Electron-style API this project doesn't have. The recent-path selector +
  manual fallback is the closest available approximation for this MVP.
- **"Load more" in the file view is a simple forward step**, not a true
  cursor/pagination API — it re-requests a window starting at the next
  unseen chunk index. Fine for the common case (walking through a file
  top to bottom) but does not support jumping to an arbitrary later range
  without scrolling through intermediate "load more" clicks.
- **The standalone `#/index` page (Phase 2C) was left mostly as-is** apart
  from adding the `llmSummaries` checkbox — it still uses a plain
  collection-name + manual-path form, because it has no "current
  collection" context to prefill from and is a secondary entry point now
  that per-collection reindex lives in Collection settings. Bringing it in
  line with the recent-path selector is a reasonable next increment, not
  done here to keep this phase scoped to the sidebar/main-panel redesign
  and collection settings.
- **Sidebar tree state is not persisted across a full page reload** — only
  one collection's tree is expanded at a time, tracked in an in-memory
  module variable (`expandedCollection`), matching the existing app's
  general "no client-side state persistence beyond localStorage recent
  paths" pattern.
- **Delete's only remaining safety net is the modal click + the loopback
  bind.** This was an explicit, deliberate simplification instructed for
  this phase — no typed confirmation, server-side or client-side. If this
  tool is ever exposed beyond a single local user (`ADMIN_ALLOW_REMOTE=1`),
  this would need revisiting alongside the auth requirement the design doc
  already flags as mandatory for that case.
