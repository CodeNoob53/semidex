# Admin UI — Live Acceptance Check (2026-07-03)

Live verification of the Admin UI against a real Qdrant instance before
Phase 2E polish. Performed primarily at the HTTP API layer (the same
endpoints the served `app.js` calls), with the served `app.js`/`index.html`
inspected directly to confirm the required UI code paths exist. The user
had the UI open in VS Code's built-in browser during this session.

**Method note (read before trusting "pass" on visual items):** this check
does not have direct access to browser DevTools console output or click
automation. Every API-level behavior below (data shapes, status codes,
job lifecycle, delete safety) was verified with real HTTP requests against
a live server. Purely visual/interactive claims (e.g. "window match
highlighting is understandable", "summaries help orientation") are based on
inspecting the exact data the UI renders and the rendering code in
`app.js`, not on a screenshot or a live click-through. This is flagged
per-section below.

## Setup

- Command used: `npm run admin` (default `ADMIN_PORT=8642`, `ADMIN_HOST=127.0.0.1`).
- **Stale-process issue found and fixed during this check**: a server
  process from an earlier session (started 2026-07-02, before the Phase 2D
  `DELETE /api/collections/:name` commit) was still bound to port 8642.
  All Phase 0–2C behavior worked fine against it, but delete requests
  returned `404 No route for DELETE ...` because that route didn't exist
  in the running process's loaded code. Stopped the stale process (with
  the user's confirmation) and restarted `npm run admin` from the current
  working tree before continuing section 7. **This is a process-management
  gotcha, not a code bug** — `git status` was clean and the code was
  correct; the *running* server was simply older than the *checked-out*
  code. Noted under polish below.
- Working tree clean, `git log` HEAD at `a0ab09f` for the entire check
  (after the restart).

## Collections used

- Real, pre-existing: `linux-basics` (1329 points, skeleton nav present) —
  used for sections 2–6.
- Temporary dummy, created and destroyed during this check:
  `admin-ui-live-check-dummy`, indexed from `docs/design/` (9 markdown
  files, 578 points after indexing) — used for sections 6 (reindex) and 7
  (delete safety), then deleted at the end. No real collection was
  modified by this check.

## Results by section

### 1. Overview — PASS

- `GET /api/collections` returns all 10 real collections with
  `pointCount`, `provider.denseProvider`/`denseModel`, `provider.sparseProvider`,
  `vectorSchema` — the exact fields the overview table renders per-row.
- `GET /api/health` / `GET /api/capabilities` return the domain-shaped
  `{ ok, storage: { backend, ok, detail } }` and
  `{ backend, capabilities: {...} }` — no raw Qdrant collection-info JSON,
  no Qdrant filter/REST shapes.
- No section of the response surface exposes Qdrant point IDs, vector
  arrays, or REST-body shapes — confirmed by reading the actual JSON
  returned, not just the UI code.

### 2. Collection Detail (`linux-basics`) — PASS

- Metadata: `pointCount: 1329`, `vectorSchema.dense.size/distance`,
  `sparse: true`, `provider.denseProvider: bge-m3-onnx`, `versions.*`,
  `hasSkeleton: true`, `warnings: []` — all present and all the fields the
  Metadata panel's template reads.
- Maintenance: same `getCollection` response feeds the health badge
  (0 warnings → "healthy"), schema/provider summary, and the reindex
  form's option checkboxes — verified this is the exact same API call the
  Metadata panel uses (no second, Qdrant-shaped fetch).
- Search playground, Documents, Skeleton panel: all backed by endpoints
  verified individually below (sections 3–4) with real data from
  `linux-basics`.

### 3. Skeleton Navigation — PASS

- `GET /api/collections/linux-basics/skeleton` → root node,
  `nodeType: "collection"`, `childCount: 30`, `summary: "linux-basics — 160
  files"`.
- Drilled one level via `GET .../skeleton/children?nodePath=...`: returned
  5 of 30 directory nodes (`limit` respected), each with its own
  `childCount` and a summary like *"Тема 10. Процеси в Linux (ps, top,
  kill, htop) — 7 files, 0 directories"* — this is genuinely useful
  orientation (topic name + file count), not a generic placeholder.
- Confirmed via the domain shape itself that skeleton nodes never carry
  `text`/`score`/retrieval fields — only `summary`, `nodeType`, `nodePath`,
  `childCount`, `children` — structurally distinct from a `Chunk`, which is
  what keeps it "navigation, not evidence" at the data level. The UI's own
  copy (verified present in `app.js`, see section 4) reinforces this in
  words too.

### 4. Search Playground (3 searches against `linux-basics`) — PASS

1. **Natural-language question** (*"як завершити завислий процес у
   Linux"*): `searchMode: "hybrid"`, 3 results, each with `sourceFile`,
   `chunkIndex`, `score` (~0.03, RRF-scale — low absolute values are
   expected and correctly documented in the UI's score tooltip), `section`,
   `nodeType: "paragraph"`. Relevance was moderate for this particular
   phrasing (topically adjacent results, not the exact `kill`/`SIGTERM`
   passage) — noted under polish, not a blocker, since the API contract
   (fields present, hybrid mode active) is what this check verifies.
2. **Exact-token query** (*"nice renice ulimit"*): 3 results, all from the
   correct topic file (`Тема 13. Обмеження ресурсів (nice, ulimit)/...`),
   including a `table` node type. `windowChunks` correctly marked
   `isMatch: true` only on the matched chunk, `false` on neighbors — the
   highlighting data is unambiguous (exactly one `true` per result).
3. **Scoped "search in file"** (`sourceFile` filter on the same topic's
   intro file): 3 results, **100% from the requested file** — confirmed
   programmatically (`results.every(r => r.sourceFile === ...)`), no
   cross-file leakage.
- **Preview chunk**: `GET .../chunks?sourceFile=...&chunkIndex=1&window=2`
  returned exactly 3 chunks (indices 0–2, correctly clipped to the file's
  bounds) — confirms "preview chunk" opens the correct window around the
  clicked result.
- One tooling note (not a product issue): running the scoped-search query
  through `curl` with a Cyrillic `sourceFile` value initially returned 0
  results; re-run via `node`'s `fetch()` (bypassing the shell) returned the
  correct 3 results. This is the same Git-Bash/Windows non-ASCII shell
  encoding artifact documented in the Phase 1D report — not a UI or API
  bug.

### 5. Maintenance: Sync Schema — PASS

- `POST /api/collections/linux-basics/sync-schema` returned
  `{ collection, repaired: [7 index names + "sparse vector support"],
  warnings: [] }` with no error — matches "already up to date"/healthy-path
  behavior (indexes are idempotent; Qdrant reports the create call as
  successful even when the index already existed).
- No crash on a healthy collection with an empty `warnings` array (this is
  the case the task explicitly says must not crash) — confirmed via a
  clean `200` response and by reading `app.js`'s handling of
  `body.warnings?.length` (renders "Schema already up to date." when
  empty).

### 6. Maintenance: Reindex Job — PASS

- Started `POST /api/jobs/index` with `collection:
  "admin-ui-live-check-dummy"`, `path: "./docs/design"`, default option
  set — returned `202` immediately (does not block on completion, matching
  the requirement).
- A concurrent second start attempt while the job was running returned a
  clear `409`: *"An indexing job is already running (id: ...). Only one
  job may run at a time."*
- Followed the job via `GET /api/jobs/:id` repeatedly (polling, same as
  the `#/index` view does): logs showed per-file progress
  (`chunking...`/`embedding...`/`upserting...` with chunk/point counts),
  ending in `state: "succeeded"`, `exitCode: 0`, and the indexer's own
  summary line *"Done. 9 file(s): 9 indexed, 0 skipped."* — status and
  logs are both present and legible.
- The job took a few minutes end-to-end (ONNX CPU embedding of 9 files,
  418 chunks total) — this is expected hardware-bound latency, not a UI
  issue; the non-blocking `202` response means the UI itself never waited
  on it.

### 7. Delete Safety — PASS (after a stale-server restart, see Setup)

- `DELETE /api/collections/admin-ui-live-check-dummy` with
  `{ confirm: "wrong-name" }` → `400 bad_request`, collection untouched.
- Same endpoint with `{}` (no `confirm` field) → `400 bad_request`.
- Same endpoint with `{ confirm: "admin-ui-live-check-dummy" }` (exact
  match) → `200 { collection, deleted: true }`.
- Post-delete: `GET /api/collections` shows 10 collections (was 11), the
  dummy is absent, and every real collection name from before the check is
  still present.
- Confirmed `linux-basics` specifically: `pointCount: 1329`, unchanged from
  the very first check in section 2 — no real collection was touched.
- The served `app.js` was re-checked on the restarted server and confirmed
  to contain the exact-name gating (`confirmInput.value !== name` disables
  the button) and the fixed confirm-value wiring
  (`const confirm = $('#maint-delete-confirm').value`, not a hardcoded
  collection name) from the prior review round.

## Issues found

**Blocker:** none.

**Polish:**
- Stale running server vs. checked-out code is an easy trap during
  iterative local development — `npm run admin` gives no warning that an
  older version of itself might already be bound to the port with
  different (older) routes loaded. A version/build marker in `GET
  /api/health` (e.g. a git short-hash or start timestamp) would make this
  class of confusion self-diagnosing instead of requiring a manual
  `netstat`/`Get-CimInstance` investigation like this session needed.
- General natural-language query relevance on `linux-basics` was moderate
  for loosely-phrased questions (the exact-token and scoped searches were
  both strong). This is a retrieval-quality property of the hybrid
  search/embedding setup, not a UI defect — flagged for awareness, not as
  an Admin UI issue.
- Reindexing 9 small files took a few minutes on CPU ONNX embedding with
  no in-UI indication of *why* it's slow (no ETA, no per-stage timing
  surfaced beyond the raw log tail). Acceptable for an MVP log-tail
  approach; a progress percentage would be a nicer Phase 2E+ polish item.

**Future feature:**
- A `GET /api/health`-level build/version marker (see polish above) could
  double as a genuinely useful "which version of semidex is this admin UI
  talking to" indicator once this tool is used across multiple machines.

## Verdict

**PASS** — overview/detail/search/skeleton/job flows all worked end-to-end
against a live Qdrant instance and a real indexing job; delete safety
correctly rejected non-matching/missing confirmation and only proceeded on
an exact match; no Qdrant-specific raw internals appeared in any response
the UI consumes; no endpoint returned an unexpected shape or crashed on a
non-error input (including the empty-`warnings` sync-schema case). Proceed
to Phase 2E.
