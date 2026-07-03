# Admin UI — Phase 2C Indexing Jobs Foundation Report (2026-07-02)

Adds a minimal local indexing job flow: start an index run from the browser,
watch its status and log, cancel it if needed. Uses the existing indexer CLI
as a spawned child process — no indexer internals were touched or
refactored.

## What changed

```text
src/admin/jobs/registry.js  - in-memory job manager: spawn, log capture,
                              state machine, one-active-job concurrency guard
src/admin/api/jobs.js       - POST /api/jobs/index, GET /api/jobs,
                              GET /api/jobs/:id, POST /api/jobs/:id/cancel
src/admin/http.js           - +conflict() (409) HttpError constructor
src/admin/server.js         - +createJobRegistry wiring, jobRegistry DI param
src/admin/ui/index.html     - +sidebar link to the indexing view
src/admin/ui/app.js         - indexing view: form, options, job list, log
                              tail, cancel button, sidebar auto-refresh
src/admin/ui/app.css        - indexing view styles (form rows, checkboxes,
                              job cards, log pane)
tests/unit/admin/jobs.test.js    - 43 tests (registry + API, fake spawn)
tests/unit/admin/static.test.js  - +6 served-file tests for the new view
```

`src/core/` and the existing `src/admin/api/{health,collections,documents,
chunks,skeleton,node,search}.js` are untouched. No indexer file under
`src/indexer/` was modified.

## API contract

**`POST /api/jobs/index`**
```json
{
  "collection": "my-docs",
  "path": "C:\\path\\to\\docs",
  "options": {
    "onnxEmbed": true, "skeletonChunking": true, "skeletonNav": true,
    "pruneStale": false, "tagGen": false
  }
}
```
- `collection` and `path` are required non-empty strings; `options` is an
  optional object whose five fields, if present, must be booleans.
- Success: `202 { job: { id, collection, path, options, state, startedAt,
  finishedAt, exitCode } }` (job summary shape — no log, no child handle, no
  env).
- Conflict: `409 { error: { code: "conflict", message } }` when a job is
  already `queued`/`running` — the second request is rejected outright, not
  queued.
- Validation failures: `400 bad_request`.

**`GET /api/jobs`** → `200 { jobs: [JobSummary, ...] }`, newest first.

**`GET /api/jobs/:id`** → `200 { job: { ...JobSummary, log: string[] } }`
(last 200 lines, each prefixed `[stdout]`/`[stderr]`); `404` for an unknown id.

**`POST /api/jobs/:id/cancel`** → `200 { job: JobSummary }` with
`state: "cancelling"` (not yet `"cancelled"` — the kill signal was sent but
the process may still be running; the state becomes `"cancelled"` only once
the child's own `exit` event confirms it actually stopped); `404` for an
unknown id; a no-op (200, unchanged state) if the job has already finished.

**Env translation** (`buildJobEnv`, `src/admin/jobs/registry.js`): the UI
never composes env vars — it sends the typed `options` object, and the
server maps it at spawn time:
`COLLECTION`, `ONNX_EMBED=1|0`, `SKELETON_CHUNKING=1|0`, `SKELETON_NAV=1|0`
always present; `PRUNE_STALE`/`TAG_GEN` set to `"1"` only when `true`,
**omitted entirely** otherwise (matching the task's exact spec and the
indexer's existing "unset = off" convention, rather than sending `"0"`).

**Spawn shape**: `spawnFn(process.execPath, [INDEXER_ENTRY, path], { env })`
— `process.execPath` (not a hardcoded `"node"`) and an absolute path to
`src/indexer/index.js` resolved once at module load, so the child process
is not affected by the server's own working directory. `args` is a plain
array; the path is never concatenated into a shell string. `spawnFn` is
dependency-injectable (defaults to `node:child_process`'s `spawn`) so tests
never launch a real indexer.

## UI behavior

New **"index a folder"** screen (`#/index`, linked from the sidebar):
- Form: collection name, source path (plain text inputs — no file picker,
  no path browsing, per the task's explicit non-goals), five checkboxes
  (ONNX embeddings / skeleton chunking / skeleton navigation default **on**;
  prune stale / generate tags default **off**). Checking "Prune stale" adds
  a visible warning style to its own label.
- Copy: *"Indexing writes to the selected collection."* (page subtitle) and
  *"Prune stale should be used only with the full source root."* (inline,
  next to the checkboxes).
- Submit → `POST /api/jobs/index`. A `409` response is shown as
  *"\<message\> Wait for it to finish, or cancel it below."*; other errors
  show the API's message verbatim.
- **Jobs list**: every job (not just the active one) as a card — status
  badge (queued/running/cancelling/succeeded/failed/cancelled, color-coded),
  collection, source path, exit code when non-zero, started/ended
  timestamps, a scrollable log tail (last 30 lines fetched from
  `GET /api/jobs/:id`), and a **cancel** button while queued/running (a
  "stopping…" indicator replaces it once `cancelling`).
- **Polling**: while any job is queued/running/cancelling, the view
  re-fetches `GET /api/jobs` (and each job's log) every 1.5s; polling stops
  once nothing is active, and also stops immediately if the user navigates
  away from `#/index` (checked before each poll tick, not just on route
  change).
- **Post-success refresh**: when a poll cycle observes a job transition to
  `succeeded`, the sidebar collection list (`loadSidebar()`) is refreshed
  automatically — satisfies the task's "small refresh action or
  auto-refresh" requirement via the auto-refresh path. No separate manual
  button was added since the auto-refresh already covers it; a manual
  "refresh now" button would be redundant while a job is active (the poll
  loop already refreshes) and unnecessary once the sidebar is current.

## Safety decisions

- **No shell interpolation.** `spawnFn(command, argsArray, opts)` throughout
  — verified by a test asserting `args` is an array and the source path
  (including one containing a space, tested with `C:\docs\my folder`) is
  never substring-concatenated into a command string. `opts.shell` is never
  set (defaults to `false`/`undefined` in `node:child_process`).
- **One active job at a time, globally** (not per-collection, matching the
  task spec exactly — a stricter constraint than the design doc's
  per-collection model). A second start attempt while one is
  queued/running/cancelling gets `409`, never silently queued or dropped —
  `cancelling` counts as active specifically so a job mid-shutdown can't be
  raced by a new start before its process has actually exited.
- **No env dump, no secrets in logs or responses.** `toJobSummary`/
  `toJobDetail` (`src/admin/api/jobs.js`) explicitly allow-list the fields
  serialized to the client (`id, collection, path, options, state,
  startedAt, finishedAt, exitCode`, `log` for detail only) — the raw `env`
  object built in `registry.js` never leaves that function's local scope,
  and `job.child` (the actual child_process handle) is never touched by the
  API layer's response builders.
- **Localhost-only remains the boundary.** No new host/port logic was
  added; jobs endpoints are behind the same `resolveHostConfig` loopback
  guard as every other route.
- **Path/collection validation is non-empty-string only**, deliberately not
  existence-on-disk. The design doc says "validates the path exists"; this
  task's spec says "validate path non-empty," and that's what's
  implemented — checking filesystem existence in the API layer would add a
  dependency the indexer already checks itself (and duplicates effort for
  a value that's about to be handed to a child process that does its own
  validation and prints a clear usage error if the path or `COLLECTION` is
  missing). Noted as a deliberate scope choice, not an oversight.
- **No remote URLs, no path browsing.** `path` is rejected with `400` if it
  matches a URL-scheme pattern (`scheme://` — catches `http://`, `https://`,
  `file://`, `ftp://`, etc.); otherwise it's passed through as an opaque
  local-filesystem string to the indexer's own argument parsing. Nothing in
  this layer fetches, uploads, or lists filesystem contents.
- **Cancel is best-effort** (`child.kill()`), matching the design doc's
  "safe to re-run" reasoning (deterministic point IDs make a
  cancelled/resumed collection non-corrupting). The job sits in
  `cancelling` — still counted as active, still blocking a new start —
  until the child's `exit` event confirms the process actually stopped, at
  which point it becomes `cancelled`. No Windows `taskkill /pid /t`
  fallback was added in this MVP slice; noted as a limitation below rather
  than implemented speculatively.

## Tests run

```
npm test (run 3x in a row post-fix to rule out timing flakiness)
  ℹ tests 361
  ℹ suites 92
  ℹ pass 361
  ℹ fail 0

npm run smoke
  Smoke tests: 1293 passed, 0 failed

node --check src/admin/jobs/registry.js   OK
node --check src/admin/api/jobs.js        OK
node --check src/admin/http.js            OK
node --check src/admin/server.js          OK
node --check tests/unit/admin/jobs.test.js       OK
node --check tests/unit/admin/static.test.js     OK

git diff --check (staged)                 clean
```

New tests (49 total: 43 in `jobs.test.js`, 6 in `static.test.js`), all
offline — no real indexer process is ever spawned:

- **`buildJobEnv`** (4 tests): always-present flags, `"1"` on true,
  `PRUNE_STALE`/`TAG_GEN` omitted (not `"0"`) when false, set to `"1"` only
  when true.
- **Spawn shape** (2 tests): `spawnFn` called with `(command, argsArray,
  { env })`, no shell string concatenation (path containing a space passed
  as its own array element), env vars correctly forwarded.
- **Log capture** (4 tests): stdout/stderr lines tagged by stream, no empty
  lines from trailing newlines, a leaked `QDRANT_KEY` value is redacted to
  `[REDACTED]`, a URL with embedded credentials is reduced to its host-only
  form — both asserted on the stored `job.log`, not just the API response.
- **Concurrency** (4 tests): second `startIndexJob()` throws
  `JOB_ALREADY_RUNNING` while one is active; a second start is still
  rejected immediately after `cancelJob()` (before any exit event —
  regression test for the cancel-race fix below); a new job is allowed
  after the active one finishes, or after the cancelled one's process
  actually exits (not merely after `cancelJob()` returns).
- **State transitions** (8 tests): queued→running immediately,
  running→succeeded (exit 0), running→failed (non-zero exit), running→failed
  (killed by signal), running→cancelling immediately on `cancelJob()` (and
  only becomes cancelled once the process's real exit event arrives —
  `getActiveJob()` still returns the job while cancelling, returns `null`
  only after), spawn-level error → failed with `exitCode: null`,
  `cancelJob` on an already-finished job is a no-op, `cancelJob` on an
  unknown id returns `null`.
- **Listing** (1 test): newest-first ordering.
- **API validation** (13 tests): missing `collection`, missing `path`,
  non-object `options`, non-boolean option value, four rejected remote-URL
  path schemes (`http://`, `https://`, `file://`, `ftp://`) each `400`, five
  accepted local-path forms (`C:\path`, `C:/path`, `./docs`, `../docs`,
  bare `docs`) each `202`.
- **API success/conflict** (2 tests): `202` with a job summary containing
  no `child`/`env` keys; `409` on a second concurrent start.
- **API list/detail/cancel** (5 tests): job list ordering, job detail
  includes a `log` array, `404` for unknown ids (list, detail, cancel), and
  the full cancel sequence with a manually-controlled fake process:
  `POST .../cancel` returns `state: "cancelling"`, a concurrent second start
  still gets `409` while the process hasn't exited, and only after the fake
  process's `exit` event fires does a third start attempt succeed with
  `202`.
- **Served-file assertions** (6 tests, `static.test.js`): `index.html` links
  to `#/index`; `app.js` posts the five typed options to
  `/api/jobs/index`; fetches the job list and per-job detail/log; supports
  `POST .../cancel`; keeps the two required safety-copy strings verbatim;
  refreshes the sidebar (`loadSidebar()`) after a success is observed.

Also manually exercised end-to-end over a real `node:http` server (not just
the test suite) with a fake `spawnFn`: verified the exact `spawn()`
arguments (command, args array, env keys), the full job lifecycle through
the real HTTP surface (`202` → polling → `succeeded`), the cancel path
(`running` → `cancelling` → `cancelled`, slot freed only after the real exit
event), the failure path (non-zero exit → `failed`, stderr captured), secret
redaction in captured log lines, and remote-URL path rejection. All matched
the documented contract above (contract updated post-review — see below).

## Post-review fixes (2026-07-03)

Three issues found in review of the initial implementation, all fixed with
tests added:

1. **Cancel freed the concurrency slot before the process actually
   exited.** `cancelJob()` used to set `state: 'cancelled'` and clear
   `activeJobId` synchronously, but `child.kill()` only sends a signal — the
   indexer process could still be running (and still writing to Qdrant) for
   some time afterward. A second `startIndexJob()` right after cancelling
   the first would have started a real concurrent indexer run. Fixed by
   adding an intermediate `cancelling` state: `isActive()` now treats
   `cancelling` the same as `queued`/`running` (still blocks a new start),
   and the slot is only freed — the state only becomes `cancelled` — when
   the child's own `exit` event fires. The API's `POST /api/jobs/:id/cancel`
   response now returns `state: 'cancelling'`, not `'cancelled'`; the UI
   shows a "stopping…" indicator and keeps polling until the real
   `cancelled` state arrives. Two of the original tests were asserting the
   old (buggy) behavior directly — `allows a new job to start after the
   active one is cancelled` and the cancel API test — and were rewritten to
   assert the corrected contract, plus a new regression test that a second
   start attempt made immediately after `cancelJob()` (before any exit
   event) still gets rejected.
2. **Captured stdout/stderr could leak secrets verbatim.** `job.log` is
   served back through `GET /api/jobs/:id` with no further processing, but
   the indexer (or Qdrant/Ollama error paths it doesn't control) can print
   `QDRANT_KEY` or a URL with embedded credentials to stderr on failure.
   Fixed by running every captured line through the existing
   `sanitiseErrorMessage()` helper (`src/core/doctor-checks.js`, already
   used for doctor/preflight output) at capture time, in `appendLog()` —
   before a line is ever stored, not just before it's returned by the API.
   Redacts a literal `QDRANT_KEY` value and reduces any URL with
   credentials/query string to its host-only form. Two new tests confirm a
   leaked key and leaked URL credentials are both redacted in `job.log`.
3. **`path` accepted remote URLs despite the stated non-goal.** The task
   spec says "Do not accept remote URLs as source path in this MVP," but
   validation only checked for a non-empty string — `https://...`,
   `file://...`, etc. would pass through to the indexer's own (unguarded)
   argument parsing. Fixed by rejecting any string matching a URL-scheme
   pattern (`scheme://`) with `400 bad_request`, added as
   `requireLocalPathField()` in `src/admin/api/jobs.js`. Verified the regex
   doesn't false-positive on real Windows paths (`C:\path`, `C:/path`,
   relative paths, UNC paths) since none of those contain `://`. Eight new
   tests cover four rejected URL schemes and five accepted local-path forms.

All three fixes verified both by unit tests (43 tests in `jobs.test.js`,
up from 31) and by a live manual check against a real `node:http` server
with fake `spawnFn`/`kill()` under full test-writer control, confirming the
exact same behavior end-to-end. The full suite was also run three times in
a row after these fixes to rule out timing flakiness in the new
`cancelling`-window tests (see below) — all three runs passed identically.

## Known limitations

- **No SSE log streaming** (design doc §9 describes it; this task's spec
  asks for polling-based `GET /api/jobs/:id` instead). Implemented exactly
  as specified — polling every 1.5s while a job is active. A future SSE
  upgrade would replace the poll loop without changing the job model.
- **No Windows `taskkill /pid /t` fallback for cancel.** `child.kill()`
  alone may not reliably terminate the entire process tree the indexer
  spawns (if any) on Windows. Deferred rather than implemented
  speculatively, per the task's "if cancel is risky, defer it explicitly"
  guidance — cancel is implemented, but its robustness on Windows process
  trees specifically is unverified beyond the direct-child case tested here.
- **In-memory job registry only** — jobs vanish on server restart, matching
  the design doc's stated MVP scope. Collection state itself is always
  recoverable from Qdrant regardless.
- **Global (not per-collection) concurrency limit** — indexing collection A
  blocks starting a job for unrelated collection B. Matches the task spec's
  "one active indexing job at a time" literally; the design doc's
  per-collection model is a possible future relaxation, not implemented here.
- **No job persistence/summary parsing from log tail** — the "exit code +
  raw log" fallback the design doc describes is effectively the only mode
  implemented (no structured files-indexed/skipped count is parsed from
  stdout). Acceptable per the design doc's own fallback framing ("never
  block on parsing").
- **No collection-name/path autocomplete** — plain text inputs only, as
  scoped ("no file picker yet").

## Verdict

**ADMIN_UI_INDEXING_JOBS_ACCEPT**
