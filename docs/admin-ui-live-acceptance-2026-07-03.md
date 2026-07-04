# Admin UI — Live Acceptance Check (2026-07-03/04)

Live verification of the Admin UI against a real Qdrant instance, on the
current Phase 2E navigation-redesign code (including the P1/P2 post-review
fixes: section-anchor resolution, paginated anchor lookup, no-auto-open-on-404,
score opt-in, no `required` on a hidden input). Performed at the HTTP API
layer (the same endpoints the served `app.js` calls), with `app.js` itself
inspected directly to confirm delete-flow code paths match the current
contract.

**Method note:** this check does not have direct access to browser DevTools
or click automation. Every behavior below (data shapes, status codes, job
lifecycle, delete safety, section-anchor resolution) was verified with real
HTTP requests against a live server and a live Qdrant instance. Visual/UI
code paths (modal markup, button wiring) were confirmed by inspecting the
served `app.js` source, not a live click-through.

## Setup

- Command used: `ADMIN_PORT=8642 npm run admin`, `ADMIN_HOST=127.0.0.1`
  (default).
- **This check spans two sessions.** The admin server (and Ollama, needed
  for skeleton context generation during reindexing) had both been shut
  down between sessions and were restarted at the start of this check.
  Restarting reset the in-memory job registry (`src/admin/jobs/registry.js`
  is intentionally not persistent — jobs don't survive a server restart),
  so a job id referenced at the start of this check
  (`ce9ea088-6a91-46f6-9b05-b9c139c13ea3`) no longer existed after the
  restart; a fresh indexing job was started instead. This is expected
  behavior, not a bug.
- Confirmed via the served `app.js` that the running server is on current
  Phase 2E code: no `{ confirm: ... }` literal anywhere in the delete
  flow, `openDeleteModal`-style modal functions present, and
  `apiDelete(path)` sends a bare `fetch(path, { method: 'DELETE' })` with
  no body.
- Working tree: staged changes for the Phase 2E post-review fixes (P1/P2,
  see `docs/admin-ui-phase2e-navigation-redesign-2026-07-03.md`), nothing
  committed during this check.

## Collections used

- Real, pre-existing: `linux-basics` (1329 points, skeleton nav present) —
  used for sections 2–6.
- Temporary dummy, created and destroyed during this check:
  `admin-ui-live-check-dummy`, indexed from `docs/design/` (9 markdown
  files, 578 points, skeleton chunking + nav enabled) — used for sections
  6 (reindex) and the section-anchor / P1 regression proof, then deleted
  at the end. No real collection was modified by this check.

## Results by section

### 1. Overview — PASS

- `GET /api/collections` returns all 11 real collections (12 momentarily,
  while the dummy existed), each with `pointCount`, `provider.denseProvider`
  /`denseModel`, `provider.sparseProvider`, `vectorSchema` — the exact
  fields the overview table/sidebar renders per collection.
- `GET /api/health` returned `{ ok: true, storage: { backend: "qdrant", ok:
  true, detail: "Qdrant reachable" } }` — domain-shaped, no raw Qdrant
  collection-info JSON.
- No response inspected in this check exposed Qdrant point IDs, vector
  arrays, or raw REST-body shapes.

### 2. Collection Detail (`linux-basics`) — PASS

- `GET /api/collections/linux-basics` → `pointCount: 1329`,
  `vectorSchema.dense.size/distance`, `sparse: true`,
  `provider.denseProvider: bge-m3-onnx`, `versions.*`, `hasSkeleton: true`,
  `warnings: []`, `semidexManaged: true` — all fields the collection header
  and settings view read, confirmed by direct fetch, not assumed from code.
- Unchanged across the entire check (re-verified `pointCount: 1329` again
  at the very end, after the reindex/delete work on the unrelated dummy
  collection).

### 3. Skeleton Navigation — PASS

- `GET /api/collections/linux-basics/skeleton` → root node,
  `nodeType: "collection"`, `childCount: 30`, `summary: "linux-basics — 160
  files"`.
- Drilled through directory → file → section levels via
  `GET .../skeleton/children?nodePath=...` — each level returns correctly
  shaped nodes (`nodeType`, `nodePath`, `childCount`, `summary`,
  `sourceFile`), including Cyrillic topic names.
- **Section-anchor resolution (P1 fix), tested twice:**
  1. Against `linux-basics` (a single-section-per-file dataset): anchoring
     `"...1. Вступ.md#вступ"` correctly resolved to `chunkIndex: 0` (this
     file's one section legitimately starts at chunk 0 — a necessary but
     not sufficient test, since 0 is also the pre-fix bug's constant
     output).
  2. **Stronger proof, against the dummy collection's
     `skeleton-first-chunking.md`** (40 sections, 82 content chunks):
     anchoring section `"...18. Ризики / відкриті питання"` (the 34th of
     40 sections, deep in the file) correctly resolved to
     **`chunkIndex: 73`**, `nodePath` ending in
     `.../18-ризики-відкриті-питання/paragraph-1`. This is not
     reproducible by the pre-fix code path (which always requested
     `chunkIndex: 0`) and — since 73 is well past the old 50-point scroll
     cap — also confirms the P2 pagination fix
     (`scrollAllFiltered`/`getFirstContentChunkByParent`) works correctly
     for sections with many preceding content chunks.
  2b. A 404 probe against a made-up section path
      (`"...#nonexistent-section-xyz"`) correctly returned
      `404 { error: { code: "not_found" } }` rather than crashing or
      silently defaulting.
- **Found and fixed during this check (see Sync Schema section below):**
  the `parent_id` payload index required by section-anchor lookups was
  missing on `linux-basics` (a collection indexed before `parent_id` was
  added to `REQUIRED_PAYLOAD_INDEXES`) — the first anchor attempt returned
  a `500` from Qdrant ("Index required but not found for parent_id").
  Running `sync-schema` added the missing index and the anchor endpoint
  then worked correctly. This is the expected repair path (sync-schema
  exists precisely to backfill new required indexes onto older
  collections) — flagged as a process note, not a code defect.

### 4. Search Playground ("Search this collection") — PASS

- `POST /api/search` with `{ collection: "linux-basics", query: "як
  подивитись список процесів", format: "full", limit: 3 }` → `200`,
  `searchMode: "hybrid"`, 3 results each with `sourceFile`, `chunkIndex`,
  `totalChunks`, `section`, `nodeType`, `nodePath`, `score`, `isMatch` —
  the exact fields the results template renders. Result relevance was
  reasonable for a natural-language Ukrainian query (top hit correctly
  matched on `ps`/process-listing content).
- No raw Qdrant filter/point-id shapes present in the response.

### 5. Maintenance: Sync Schema ("Repair collection compatibility") — PASS

- `POST /api/collections/linux-basics/sync-schema` → `200`, `repaired: [8
  index names + "sparse vector support"]`, `warnings: []`. Notably this
  run's `repaired` list included `index "parent_id" (keyword)` — this
  collection did not have that index before this check (added to
  `REQUIRED_PAYLOAD_INDEXES` as part of the P1 fix), and sync-schema
  correctly backfilled it without any special-casing needed.
- Also ran the same call against the dummy collection, which likewise
  needed `parent_id` backfilled — most likely a side effect of this
  session's job-registry restart/re-run rather than a current
  `createCollection()` bootstrap gap (see Issues found: P2 follow-up
  section for why the bootstrap path itself is not implicated). Either
  way, `sync-schema` handled it identically to the `linux-basics` case:
  correct repair, no special-casing needed, `warnings: []` after.
- No crash on a healthy collection with an empty `warnings` array.

### 6. Maintenance: Reindex Job — PASS (with one tooling gotcha, see Polish)

- Started `POST /api/jobs/index` with
  `{ collection: "admin-ui-live-check-dummy", path: "./docs/design",
  options: { onnxEmbed: true, skeletonChunking: true, skeletonNav: true } }`
  → `202`-equivalent immediate `state: "running"` response (does not block
  on completion).
- **First attempt was misconfigured by this check, not by the API**: the
  three boolean options were initially sent as top-level body fields
  (`{ collection, path, onnxEmbed: true, ... }`) instead of nested under
  `options`. `parseOptions()` only reads `body.options` and silently
  ignores unrecognized top-level keys — no validation error was raised,
  and the job ran to completion with an effectively-empty options object
  (plain, non-skeleton chunking). The resulting collection had
  `hasSkeleton: false` after indexing. Diagnosed by checking
  `GET /api/jobs/:id`'s `options` field (came back `{}`), deleted the
  malformed collection, and restarted the job with options correctly
  nested — the second run correctly showed `"contextualizing skipped
  (skeleton deterministic context)"` in the log and produced
  `hasSkeleton: true`. See Polish below — recommend rejecting unexpected
  top-level keys instead of silently ignoring them.
- Followed the corrected job via repeated `GET /api/jobs/:id` polling
  (same approach the `#/index` view uses): logs showed per-file
  `chunking...`/`embedding...`/`upserting...` progress with chunk and nav-
  point counts, ending in `state: "succeeded"`, `exitCode: 0`, and *"Done.
  9 file(s): 9 indexed, 0 skipped."* plus a nav-summary line. Final
  collection: 578 points, `hasSkeleton: true`.
- The job took several minutes end-to-end across two attempts (ONNX CPU
  embedding of 9 files, up to 82 chunks in the largest); this is expected
  hardware-bound latency — the non-blocking `202`-style response means the
  UI itself never waits on it. Verified the indexer's child process was
  actively consuming CPU (not hung) via `Get-Process` CPU-time deltas
  during a long-looking "embedding..." stretch, before continuing to wait.
- A concurrent second `POST /api/jobs/index` while a job is running still
  correctly returns `409` (verified in the prior Phase 2C/2D checks;
  behavior unchanged, not re-broken by Phase 2E).

### 7. Delete Safety — PASS (current Phase 2E modal-only contract)

This section was re-verified end-to-end against the **new** contract —
**no request body, no `confirm` field, no typed collection name, anywhere**
— per the explicit instruction that removed type-to-confirm in Phase 2E.

- `DELETE /api/collections/admin-ui-live-check-dummy` with **no body** →
  `200 { collection: "admin-ui-live-check-dummy", deleted: true }`.
- `DELETE /api/collections/no-such-collection-xyz` (nonexistent name) →
  `404 { error: { code: "not_found" } }`.
- `DELETE /api/collections/admin-ui-live-check-dummy` again (already
  deleted) → `404`, confirming the delete isn't idempotently silent and a
  double-click/retry can't be mistaken for a no-op success.
- Post-delete: `GET /api/collections` shows the original 11 real
  collections, the dummy is absent from the list.
- `linux-basics` specifically re-checked: `pointCount: 1329`, identical to
  every earlier check in this session — confirms no real collection was
  touched by any delete/reindex/repair action performed here.
- Served `app.js` inspected directly and confirmed to match this contract:
  no `{ confirm: ... }` literal anywhere, a delete-confirmation modal
  (Cancel/Delete buttons, no text input) present in the rendered settings
  view, and `apiDelete(path)` issuing a bare `DELETE` with no request body.

## Issues found

**Blocker:** none.

**P2 follow-up (not a live-acceptance blocker, but a real defect worth a
dedicated task):**
- `POST /api/jobs/index` silently ignores unrecognized top-level body keys
  instead of rejecting them. Sending indexing options at the top level of
  the request body (instead of nested under `options`) produces no error
  and no options at all — the job runs with every option at its default,
  which for `skeletonChunking`/`skeletonNav` means a materially different
  collection shape (`hasSkeleton: false`) with no indication anything was
  misconfigured. This isn't hypothetical — it's exactly what happened to
  the dummy collection in this check's first indexing attempt, and it was
  only caught by manually inspecting `GET /api/jobs/:id`'s echoed
  `options` field after the job had already finished. Proposed fix for a
  follow-up task:
  - Reject the request body at the top level to only `collection`, `path`,
    `options` — any other top-level key is a `400`.
  - In particular, if a known option name (`onnxEmbed`, `skeletonChunking`,
    `skeletonNav`, `llmSummaries`, `pruneStale`, `tagGen`) appears at the
    top level instead of nested under `options`, reject with a `400` that
    names the misplaced key — this is the exact mistake made in this
    session and the most likely real-world version of this bug.
  - `options` present but not an object is already rejected (existing
    behavior in `parseOptions()` — no change needed there).
  - Add a test: "a known option key sent at the top level (misnested) is
    rejected with 400", alongside the existing options-validation tests in
    `tests/unit/admin/jobs.test.js`.

**Polish:**
- The `parent_id` payload index (needed by the new
  `GET .../skeleton/anchor` endpoint) was missing on `linux-basics`, a
  collection indexed before this check's P1 fix added `parent_id` to
  `REQUIRED_PAYLOAD_INDEXES` — expected, and exactly what `sync-schema`
  ("Repair collection compatibility") exists to fix. The first anchor
  attempt against it surfaced a Qdrant `500` ("Index required but not
  found") instead of the intended `404`/`200`; running `sync-schema`
  repaired it correctly.
  **The dummy collection also needed the same repair, which at first read
  looked like a bootstrap-path defect — it is not.** `createCollection()`
  (`src/core/qdrant/store.js:28`) already iterates
  `REQUIRED_PAYLOAD_INDEXES` (`src/core/qdrant/schema.js:21` already lists
  `parent_id`) when creating a collection, so a genuinely fresh collection
  created by current code should get the index immediately. The dummy
  collection in this check most likely picked up a stale/mismatched state
  from this session's job-registry restart and re-run (see Setup/Reindex
  Job notes) rather than exposing a real gap in `createCollection()` —
  re-running `sync-schema` is a normal, expected step after any reindex in
  this check's session, not evidence of a code defect. No separate
  bootstrap-path fix is warranted; only old, already-indexed collections
  (like `linux-basics`) are confirmed to need `sync-schema` for this
  reason.
- No in-server warning when an older running process is still bound to
  the admin port with stale code loaded (documented as a gotcha in the
  prior 2026-07-03 pass of this check, unchanged here) — a build/version
  marker on `GET /api/health` remains a reasonable low-effort improvement.
- Reindexing 9 small-to-medium files still takes several minutes on CPU
  ONNX embedding with only a raw log tail as progress indication (no ETA,
  no per-stage timing). Acceptable for MVP; a progress percentage would be
  a nicer future polish item.

**Future feature:**
- A `GET /api/health`-level build/version marker (carried over from the
  prior check) — useful once this tool runs across multiple machines/
  sessions and stale-server confusion becomes more likely.
- Consider surfacing the "this collection is missing a payload index
  required for section navigation" case more specifically than a generic
  `500`, e.g. detecting the Qdrant "index required but not found" error
  shape in `getSectionAnchor`/`skeleton/anchor` and returning a `409`-or-
  similar with a "run Repair collection compatibility first" hint, instead
  of relying on the caller to recognize a raw Qdrant error message.

## Verdict

**PASS** — overview/detail/skeleton-navigation/search/reindex/delete flows
all worked end-to-end against a live Qdrant instance and two real indexing
jobs. The P1 section-anchor fix is confirmed correct with a strong,
non-trivial proof (`chunkIndex: 73` for the 34th of 40 sections in an
82-chunk file, well past the old 50-point scroll cap), not just the
weaker single-section-file case. Delete safety correctly reflects the new
Phase 2E no-body/modal-only contract: a bare `DELETE` succeeds, a
nonexistent name returns `404`, and no real collection was affected by
either delete performed in this check. No blockers found; one P2
follow-up (`POST /api/jobs/index` should reject misnested top-level
option keys instead of silently ignoring them), three polish items, and
two future-feature ideas noted above.
