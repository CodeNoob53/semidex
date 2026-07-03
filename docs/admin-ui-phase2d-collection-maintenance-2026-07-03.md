# Admin UI — Phase 2D Collection Maintenance Panel Report (2026-07-03)

Adds a maintenance panel to the collection detail page: schema health at a
glance, a sync-schema action, a reindex action (via the existing Phase 2C
jobs system), and a delete action gated by exact-name confirmation. This is
**semidex maintenance UI, not a Qdrant dashboard** — every action speaks
domain shapes (`Collection`, job summaries) through the existing
`StorageAdapter`; no Qdrant filter DSL or raw internals are exposed.

## What changed

```text
src/admin/router.js         - +delete() method (router previously only had
                               get()/post())
src/admin/api/collections.js - +DELETE /api/collections/:name
src/admin/ui/app.js          - maintenance panel: health badge, sync-schema
                               button, reindex form (prefilled collection),
                               delete with type-to-confirm
src/admin/ui/app.css         - maintenance panel styles (danger button,
                               section dividers)
tests/unit/admin/server.test.js  - +4 tests for DELETE /api/collections/:name
tests/unit/admin/static.test.js  - +8 served-file tests for the new panel
```

`src/core/`, the indexer, and every other existing `src/admin/api/*.js` file
are untouched. `POST /api/jobs/index` (Phase 2C) is reused as-is — no
changes there.

## API endpoints used/added

**Reused, unchanged:**
- `GET /api/collections/:name` — feeds both the existing Metadata panel and
  the new Maintenance panel's health badge/schema/provider display.
- `POST /api/collections/:name/sync-schema` — already existed (Phase 1A);
  wired to the new "sync schema" button.
- `POST /api/jobs/index` — already existed (Phase 2C); the maintenance panel
  submits to it with the collection name prefilled and no separate polling
  (the response links to `#/index` for job status).

**Added:**
- `DELETE /api/collections/:name` (`src/admin/api/collections.js`). Checked
  first whether this already existed anywhere in the stack — it did not:
  `src/admin/api/collections.js` had no `DELETE` route, though
  `StorageAdapter.deleteCollection()` and `store.deleteCollection()` already
  existed from Phase 0 with no caller. This endpoint is the first caller.
  - Requires `getCollection(name)` to succeed first → `404` if the
    collection doesn't exist.
  - Requires a JSON body `{ "confirm": "<exact collection name>" }` → `400`
    if missing or not an exact match (case-sensitive, no trimming — the UI
    only enables its delete button on an exact match, so a mismatch here
    means the request didn't come from the UI's own flow).
  - Success: `200 { collection: name, deleted: true }` — a semidex-shaped
    response, not Qdrant's raw delete-collection result.
  - Goes through `adapter.deleteCollection(name)` only; no Qdrant SDK/store
    import in `src/admin/`.
- `router.delete(path, handler)` (`src/admin/router.js`) — the router only
  had `get`/`post` before this task; added the third HTTP method the same
  way, no other router behavior changed.

## UI behavior

New **Maintenance** panel on the collection detail page
(`#/collections/:name`), between the existing Metadata and Search
playground panels:

- **Health/schema summary**: a `healthy` (green) or `N warning(s)` (amber)
  badge derived from the same `Collection.warnings` array the Metadata
  panel already receives — no new API call, no raw Qdrant JSON. Also
  repeats dense/sparse vector info and provider/version fields already
  present in the domain response, so the maintenance actions have their
  own compact context without requiring a scroll back to Metadata.
- **Sync schema**: button disabled while the request is in flight; on
  success shows `repaired: ...` / `warnings: ...` in a compact result line
  (both surfaced — a `warnings`-only response still gets an amber result
  box, never silently swallowed) and refreshes the whole collection detail
  view afterward (indexes/sparse-support can change what the Metadata panel
  shows); on failure shows the API's error message.
- **Reindex**: a small form — source path (required text input, no file
  picker, no path browsing) and the same five option checkboxes as the
  standalone indexing page, same defaults (`onnxEmbed`/`skeletonChunking`/
  `skeletonNav` on, `pruneStale`/`tagGen` off). The collection name is
  **not** a separate input — it's the current page's `name`, sent as-is to
  `POST /api/jobs/index`. On `202`, shows the job id and a link to `#/index`
  to watch it; on `409` (a job is already running), shows the conflict
  message and points the user to the indexing jobs view to cancel/wait.
  Does not block on job completion — this page never polls job status
  itself, matching the task's "do not block on job completion" requirement.
  Copy: *"Reindex starts a background job and writes to this collection."*
  and *"Use prune stale only with the full source root."*
- **Delete**: a text input with the collection name as its placeholder and
  a disabled delete button. The button enables only when the input's value
  is an exact match (`===`) for the current collection name — no partial
  match, no case-insensitivity. On confirm, calls
  `DELETE /api/collections/:name` with `{ confirm: <typed input value> }` —
  read from the input at submit time, not the already-known collection name,
  so the button's disabled state is a convenience and not the only thing
  standing between a click and a real delete; on success navigates to `#/`
  (overview) and refreshes the sidebar collection list; on failure (e.g. a
  race where the collection was already deleted) shows the API's error
  message and re-enables the button. Copy: *"Deleting a collection
  permanently removes it from storage. This cannot be undone."*

## Safety decisions

- **Exact-name confirmation, not a generic "are you sure?" prompt.** The
  delete button is `disabled` by default and only enables on a byte-for-byte
  match against the current collection's name, both client-side (button
  gating) and server-side (`confirm` body field checked against `params.name`
  in the API handler) — a client bug or direct API call without the UI still
  can't delete without supplying the exact name.
- **No bulk delete, no "drop all collections."** The delete action is scoped
  to exactly one collection (`:name` from the current page); no endpoint or
  UI control operates on more than one collection at a time.
- **StorageAdapter-only.** `DELETE /api/collections/:name` calls
  `adapter.deleteCollection(name)` — same pattern as every other route in
  `collections.js`. The existing layering test (recursive scan of
  `src/admin/` for a Qdrant SDK/store/client import) covers the new route
  and the router change automatically; it still passes.
- **Reindex reuses Phase 2C's existing safety properties as-is**: no shell
  interpolation, one-active-job-globally concurrency guard (a maintenance
  reindex is subject to the same `409` conflict as the standalone indexing
  page), remote-URL path rejection, capture-time log redaction. Nothing in
  this panel bypasses or duplicates that logic — it's the same
  `POST /api/jobs/index` endpoint.
- **No filesystem browsing, no remote URL indexing** — the source-path
  field is a plain required text input, identical in behavior to the
  standalone indexing page's field (same non-goal, same MVP scope).

## Tests run

```
npm test
  ℹ tests 373
  ℹ suites 94
  ℹ pass 373
  ℹ fail 0

npm run smoke
  Smoke tests: 1293 passed, 0 failed

node --check src/admin/api/collections.js   OK
node --check src/admin/router.js            OK
node --check src/admin/server.js            OK
node --check src/admin/ui/app.js            OK
node --check tests/unit/admin/server.test.js    OK
node --check tests/unit/admin/static.test.js    OK

git diff --cached --check                   clean
```

New tests (12 total: 4 in `server.test.js`, 8 in `static.test.js`), all
offline — no real Qdrant, no real indexer process:

- **`DELETE /api/collections/:name`** (4 tests, `server.test.js`): `404` for
  a missing collection (and `adapter.deleteCollection` is never called);
  `400` for a missing `confirm` field (no adapter call); `400` for a
  `confirm` value that doesn't exactly match the collection name (no
  adapter call); `200` with `{ collection, deleted: true }` and the adapter
  called with the correct name when `confirm` matches.
- **Maintenance panel** (8 tests, `static.test.js`): collection detail
  renders a `col-maint` container via `initMaintenancePanel`; posts to
  `/api/collections/:name/sync-schema`; can start `/api/jobs/index` via
  `runMaintenanceReindex` with `collection: name` (not a second retyped
  field); requires a source path before submitting; the delete button's
  `disabled` state is driven by an exact string match against the
  collection name; calls `DELETE` with the typed confirmation via
  `apiDelete`; keeps the exact reindex/prune-stale safety copy strings;
  navigates to `#/` after a successful delete.
- **Regression fix in an existing test**: `returns 404 for a known path
  called with an unsupported method` (`server.test.js`) previously sent
  `DELETE /api/collections/demo` to prove no route existed at that
  method+path — now that `DELETE` is a real route, that request correctly
  returns `400` (missing confirm), not `404`. The test was not weakened;
  it was retargeted to `PUT /api/collections/demo`, a method+path
  combination this API still doesn't register anywhere, so it continues to
  exercise the same "unsupported method on a known path" case the test
  name describes.

Also manually exercised end-to-end over a real `node:http` server with a
stub adapter and fake `spawnFn`: fetched collection detail with a
non-empty `warnings` array, ran sync-schema and confirmed both `repaired`
and `warnings` came back, started a reindex job through
`POST /api/jobs/index` with the collection prefilled, attempted delete
without confirmation (`400`), then deleted with the correct confirmation
(`200`, adapter called with the right name). All matched the documented
contract above.

## Known limitations

- **No path browsing or file picker** for the reindex source path, matching
  the explicit task scope — the field is a plain required text input, same
  as the standalone indexing page.
- **No bulk delete or multi-select** — every maintenance action (sync,
  reindex, delete) operates on exactly one collection, the one currently
  being viewed.
- **The maintenance panel's reindex form does not poll job status** — by
  design (the task says not to block on job completion here), so a user
  who starts a reindex and stays on the collection page won't see live
  progress; they have to follow the provided link to `#/index` for that.
- **Delete has no server-side rate limit or cooldown** beyond the exact-name
  confirmation — a scripted client that already knows the exact collection
  name can still delete it in one request. This matches the task's stated
  safety bar (type-to-confirm), not a stronger guarantee.
- **Health badge is a coarse warnings-count signal**, not a full doctor-style
  health report — it reflects exactly what `Collection.warnings` already
  contains (e.g. legacy flat schema, missing sparse vectors on points); it
  does not independently probe Qdrant, Ollama, or ONNX.
