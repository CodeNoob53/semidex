# Admin UI Phase 3S — Unified Operation Status Modal

2026-07-11

## What changed

Replaced the route-bound `#/index` jobs list with one global operation
status modal, mounted at the application-shell level (outside `#main`, same
placement as the existing `#toast-host`), driven by a single shared
client-side poller. This is the design doc's Phase 3C, shipped.

### Backend: a merged operations view, not a rewritten job registry

`src/admin/jobs/registry.js` (952 lines of existing tests, spawns real
indexer processes) was **not** rewritten into a generic registry — the task
explicitly offered two options ("extend the current registry" or "introduce
a small operation abstraction used by both"), and the second was the safer,
smaller change:

- **`src/admin/jobs/task-registry.js`** (new): a smaller state machine
  (running/succeeded/failed only — no queued, since an in-process function
  starts immediately with no OS-scheduling delay; no cancelling/cancelled,
  since repair has no genuine cancellation point) for in-process async
  operations. `runTracked({ kind, collection, fn })` both tracks the call
  AND returns the underlying promise, so a caller needing a synchronous-
  looking HTTP response can `await` the exact execution being tracked,
  rather than running `fn` twice or polling its own state.
- **`src/admin/api/operations.js`** (new): `GET /api/operations` /
  `GET /api/operations/:id` merge the job registry (spawned index/reindex
  jobs) and the task registry (repair) into one shape:
  `{ id, kind: 'index'|'reindex'|'repair', collection, state, startedAt,
  finishedAt, cancellable, progress: {percent, phase, currentFile,
  processedFiles, totalFiles} | null, error }`. `progress` is `null`
  whenever no real per-file signal exists (a repair task, or a job before
  its first `[semidex:progress]` line) — never a fabricated 0%.
- **`jobs/registry.js`**: added an optional `kind` field to
  `startIndexJob({..., kind: 'index'|'reindex'})`, defaulting to `'index'`
  for full backward compatibility — purely a display-label distinction, both
  kinds run through the identical spawn/env/progress-parsing path.
  `api/jobs.js`'s request parser accepts an optional `kind` in the POST body
  the same way.
- **`api/collections.js`**'s `sync-schema` route: kept its original
  synchronous `200` contract (existing `server.test.js` tests depend on it,
  and `ensureCollectionSchema()` genuinely completes in well under a second
  — a handful of Qdrant round trips, not a long-running process). What's
  new: the same call is *also* run through `taskRegistry.runTracked()`, so
  it's visible in `GET /api/operations` for the duration it runs — "truthful
  states," not a synthetic progress bar faked just because the endpoint
  responds quickly.

### Frontend: one store, two subscribers

- **`operation-store.js`** (new): the *only* module that calls `GET
  /api/operations`. Started once at app boot (`app.js`), independent of
  route lifecycle — this is what lets an operation survive navigation.
  Exposes `subscribe(listener)` (events: `update` on every poll,
  `transition` exactly once per actual state change — diffed internally via
  a `lastSeenState` map, not fired per poll tick), `getOperations()`,
  `getActiveOperation()`, and `pollNow()` (forces an immediate fetch after
  starting a new operation, so the modal doesn't wait out the idle 5s
  interval). `topbar.js` and `operation-modal.js` both subscribe; neither
  polls independently.
- **`operation-render.js`** (new): the one function
  (`renderOperationCard`) that turns an operation into a `.job-card`
  element, reusing the existing `tpl-job-row` template. Replaces the
  deleted `jobs-view.js` renderer — one shared renderer, not duplicated
  progress-rendering logic between a modal and a list view.
- **`operation-modal.js`** (new): mounts `tpl-operation-modal` once
  (`mountOperationModal`), exposes `openOperationModal(id?)` /
  `closeOperationModal()`. Accessibility: `role="dialog"
  aria-modal="true" aria-labelledby="op-modal-title"`, Escape closes,
  backdrop-click closes, focus moves to the close button on open and
  returns to whatever had focus before on close. Cancel button wiring
  trusts the backend's `cancellable` flag (not a client-side state
  re-derivation) — this is what correctly hides cancel for repair even
  while it's running. A compact "Recent operations" history list (kind +
  collection + status + duration only, no per-row log/path) lets a user
  jump between the current operation and recent ones without leaving the
  modal.
- **`toasts.js`**: extended with `variant: 'success'|'error'` (alongside
  the existing `warn`) and an optional `action: { label, onClick }` —
  `showOperationToast()` (in `operation-modal.js`, to avoid a circular
  import back into `toasts.js`) fires on the store's `transition` event
  into a terminal state, so it fires once per transition, never once per
  poll tick.
- **`topbar.js`**: the chip no longer polls `/api/jobs` on its own timer —
  it subscribes to the store and re-renders on `update`. Clicking it opens
  the modal (`openOperationModal(getActiveOperation()?.id)`) instead of
  navigating to `#/index`. Shows a live percentage when known, an
  indeterminate dot alone otherwise.
- **`jobs-view.js`**: stripped to the collection-creation form only. The
  old "Indexing progress" panel (job list, `renderJobRow`, `loadJobs`,
  `tickRunningJobRows`, per-job cancel/log fetch, the whole 1.5s poller) is
  **deleted**, not hidden. `startIndexJob()` now calls `pollNow()` +
  `openOperationModal(job.id)` after a successful `POST /api/jobs/index`.
  `settings-view.js`'s reindex form does the same, passing `kind:
  'reindex'`; its repair button calls `pollNow()` after its own (still
  synchronous) response so the store picks up the just-finished repair
  immediately rather than waiting for the next poll tick.
- **`index-view.html`** / **`index.html`**: the `#idx-jobs` panel is
  removed; a new `#operation-modal-host` div and the
  `operation-modal.html` template are added at the shell level.

## What did NOT change

- **`jobs/registry.js`'s spawn/kill/line-splitter machinery**: untouched —
  only the additive `kind` field.
- **The `[semidex:progress]` contract**: reused exactly as-is
  (`progress-event.js`, `parseProgressLine`, `FILE_PROGRESS_WEIGHTS`) — no
  new progress event shape, no log-line parsing in the UI (the modal reads
  only the structured `progress` field, never job log text, to decide what
  to render).
- **Log capture-time redaction**: unchanged (`jobs/registry.js`'s
  `sanitiseErrorMessage` call in `appendLine()`), and confirmed still the
  only place secrets get scrubbed — the operation modal/toast surfaces only
  the already-redacted `error` field, never raw log lines.
- **`/api/jobs/*` routes**: all three (`POST /index`, `GET /`, `GET /:id`,
  `POST /:id/cancel`) keep their exact existing contracts; `/api/operations`
  is a new, additive read layer on top, not a replacement.

## Tests

**Backend** (31 new):
- `tests/unit/admin/task-registry.test.js` (7): running/succeeded/failed
  transitions, `done` resolves/rejects like `fn()` directly, no unhandled
  rejections, `listTasks()` ordering, no raw process handle on the record.
- `tests/unit/admin/operations.test.js` (14): merged list shape, `kind`
  default/override, progress null-vs-populated, repair's
  `cancellable: false`/indeterminate progress, newest-first merge ordering,
  detail endpoint's `sourcePath`/`log`, 404 handling, and two regression
  tests for the error-field bug found during live verification (see below).

**Frontend** (56 new/ported):
- `tests/unit/admin/ui-jobs.test.js`: rewritten to cover only the
  collection-creation form + confirmation that the old job-list machinery
  is gone from the module.
- `tests/unit/admin/ui-topbar.test.js`: rewritten for the subscribe-based
  chip (no more `pollJobChip`), including the new percent/kind-label
  rendering and "never navigates" checks.
- `tests/unit/admin/ui-operation-render.test.js` (new, 11): ported the
  deleted `renderJobRow` behavior tests (progress bar, indeterminate state,
  phase/step line, cancel-button-only-when-cancellable, duration wording)
  against `renderOperationCard`.
- `tests/unit/admin/ui-operation-store.test.js` (new, 10): immediate first
  poll, idempotent `startPolling()` (a real bug found and fixed — see
  below), fast/slow poll-interval selection, transition-fires-once, error
  tolerance, unsubscribe, `pollNow()`.
- `tests/unit/admin/ui-operation-modal.test.js` (new, 20): open/close/
  Escape/backdrop-click/focus-in/focus-return, accessible-title attributes,
  progress rendering, cancel wiring, history list, the four ported
  "manual Show details survives polling" scenarios, and three completion-
  toast tests (fires once, no secrets exposed, action reopens the modal).

All pre-existing suites this phase's changes touch — `jobs.test.js` (84),
`server.test.js` (28) — pass unchanged.

## Bugs found and fixed this phase

1. **`operation-store.js`'s `startPolling()` was not actually idempotent.**
   `pollTimer` is only assigned once the first `await api(...)` resolves, so
   a second `startPolling()` call made before that resolves saw
   `pollTimer === null` and started a second concurrent poll loop — exactly
   the "two pollers running simultaneously" failure mode the task's test
   list explicitly calls out. Fixed with a synchronously-set `isPolling`
   flag, independent of when `pollTimer` itself gets assigned. Caught by
   `ui-operation-store.test.js`'s idempotency test, not by hand-inspection.
2. **A failed job's `error` field was only ever populated on the DETAIL
   endpoint, never the LIST endpoint** — found via live Playwright
   verification, not a unit test. The modal's initial card render and the
   completion-toast `transition` event both read from the LIST endpoint
   (`GET /api/operations`), which had `error: null` hardcoded for every job.
   A real indexing failure showed a blank error summary in the modal and a
   toast with no reason text, even though the backend had a real message.
   Fixed by extracting a shared `firstErrorLine(job)` helper used by both
   endpoints.
3. **The error-line heuristic itself picked the wrong line** — inherited
   from the now-deleted `jobs-view.js`'s `loadJobLog()`, which took the
   *last* `[stderr]` log line as the "concise error summary." Confirmed live
   this surfaces a bare `"}"` for any multi-line Node uncaught-exception
   dump (a very common failure shape — e.g. a bad source path throws
   `Error: ENOENT: ...` followed by several stack-frame lines, ending in the
   error object's own closing brace). Fixed to take the *first* stderr line
   instead, which is the actual message in both the multi-line-stack-trace
   case and the plain single-line `console.error()` case. Added a
   regression test reproducing the exact multi-line shape.
4. **`assert.equal` on two linkedom DOM element objects caused an OOM
   crash**, not just a wrong result — discovered while debugging a hung
   test run (`node --test` growing to several GB and crashing with "Zone"
   allocation failure). `document.activeElement` comparisons were rewritten
   to compare `.id` or listen for the `focus` event instead of comparing
   element objects with loose `assert.equal`. Also discovered along the way:
   linkedom does not implement `document.activeElement` at all (`.focus()`
   only dispatches an event) — the test harness's `loadOperationModalHelpers`
   now patches `Element.prototype.focus` to maintain a minimal
   `document.activeElement` shim, scoped entirely to the test harness, not
   production code.

## Code review fixes (post-initial-implementation)

Two rounds of follow-up review, five real blockers total, all fixed. Round
1 (three blockers) below; round 2 (two more, found after round 1's fixes
landed) follows it.

### Round 1

**P1 — `pollNow()` allowed concurrent polls.** Every "start an operation"
flow calls `pollNow()` twice without awaiting the first (`startIndexJob()`
calls it, then `openOperationModal()` calls it again internally, before the
first fetch resolves). The original `pollNow()` had no in-flight guard, so
this reliably fired two concurrent `GET /api/operations` requests and two
full `notify()` cycles, with only one of the two reschedules surviving in
`pollTimer` — the other silently orphaned. Fixed with an `inFlight` flag +
`refreshRequested` queue: a `pollNow()` call that arrives while a fetch is
already running just flags one deferred follow-up, never a second
concurrent request, and `pollNow()` now returns a promise that resolves
once the store genuinely reflects *that* call's fetch (not a stale
in-flight one it happened to arrive during) — needed by the repair fix
below. New tests: `ui-operation-store.test.js` — concurrent-call
collapsing, several-calls-collapse-to-one, and a dedicated
promise-resolves-with-fresh-not-stale-data test.

**P1 — repair was not actually wired into the modal/toast workflow.**
`runSettingsRepair()` awaited the repair call to completion and only then
called `pollNow()`, never opening the modal at all; the failure branch
(`catch`) never called `pollNow()` either. Two compounding problems, both
fixed:
1. **The modal never opened for repair.** Fixed: the success path now
   calls `openOperationModal(body.id)`; the failure path looks up the
   just-failed operation via a new `findLatestOperation({ collection,
   kind })` store helper and opens the modal on it too.
2. **Even with the modal wired up, no toast ever fired**, because repair
   routinely completes faster than any poll can observe it "running" first
   — the store's transition detection treats an id's first-ever sighting as
   discovery, not completion, so a repair that's already terminal by the
   time the store first sees it produces no `transition` event. Fixed with
   a new `seedOperationAsRunning(id)` store primitive, called right after
   the repair response resolves (using the `id` the response body now
   carries — added to `POST /sync-schema`'s success contract) and strictly
   before the next `pollNow()`, so that poll's result — even though
   already terminal — is compared against an assumed `running` baseline
   and correctly produces a transition.
   An earlier version of this exact fix called the seeding `pollNow()`
   *before* the repair request was dispatched, hoping to catch the
   operation mid-flight — **confirmed live that this doesn't work**: that
   poll reliably raced ahead of the server even creating the task record,
   found nothing, and the eventual completion produced no toast at all
   (the modal opened correctly, which is why this was easy to miss in the
   first live check). The reliable fix seeds only once the id is actually
   known, not by racing a guess.
   New tests: `ui-operation-store.test.js` (`seedOperationAsRunning`
   itself), `ui-settings-repair.test.js` (a new file — 4 end-to-end tests
   exercising the real `settings-view.js` + `operation-modal.js` +
   `operation-store.js` + `toasts.js` stack together: success opens modal
   + fires success toast, failure opens modal + fires failure toast, a
   repair that completes before any poll ever saw it running still
   transitions correctly, and a documented proof that the failure path's
   single post-response poll is causally sufficient — `POST /sync-schema`
   creates the task record synchronously, before awaiting the repair work,
   so any poll sent only after that request's response is received cannot
   race the server into not having created it yet).

**P1 — repair errors were stored unredacted.** `task-registry.js` stored
`err.message` verbatim; `GET /api/operations` serves that field straight
back to the client. This registry's only real caller (repair) always
touches Qdrant, so a thrown error could legitimately contain `QDRANT_KEY`
or a connection URL with embedded credentials. Fixed by applying the same
`sanitiseErrorMessage(msg, process.env.QDRANT_KEY)` call `jobs/registry.js`
already uses for job logs, at the point the error is captured. The
existing test named "sanitised error message" was checking only
`state === 'failed'`, not sanitisation itself — fixed to actually assert
no secret survives, and two new regression tests added: a direct
`task-registry.test.js` unit test (literal key + credentialed URL) and an
`operations.test.js` end-to-end test exercising the real HTTP round trip
(`sync-schema` → task registry redaction → `GET /api/operations`), so the
wiring between the two is covered, not just the redaction function itself.

### Round 2

**P1 — the modal could get permanently stuck on a stale operation.**
`openOperationModal(id)` calls `pollNow()` (not yet resolved) and `render()`
back to back, synchronously. That first `render()` runs against the store's
snapshot from *before* this call — for a second operation started later in
the same server session, that snapshot doesn't contain the new id yet.
`render()`'s old fallback (`operations.find(...) ?? operations[0]`) would
silently pick a different, older operation whenever the requested id wasn't
found — and then **permanently overwrote** `openOperationId` with that
wrong id (`openOperationId = current.id`), so every subsequent poll kept
re-confirming the wrong operation instead of ever recovering to the one the
caller actually asked for. Fixed with a new `openOperationIsPinnedToLatest`
flag: `false` whenever a specific id was requested (the normal case —
`openOperationModal(job.id)`), `true` only when the caller genuinely asked
for "whatever's newest" (`openOperationModal()` with no argument, e.g. the
topbar chip with no specific operation in mind). `render()`'s "id not found
→ fall back to newest" rescue path now only ever runs in the `true` case;
otherwise it shows a plain "Loading operation…" state until the id
actually appears in a poll. Verified the new tests genuinely catch the bug
by temporarily disabling the guard and confirming both fail, then restoring
it. New tests: `ui-operation-modal.test.js` — two tests reproducing the
exact race (a stale operation already in the store, a specific id requested
that isn't there yet → must show loading, never the stale one; and the
extreme case where the requested id never appears at all → must never fall
back).

**P1 — an unexpected server error could still leak a secret through the
HTTP response itself.** Round 1's `task-registry.js` fix redacts
`task.error` correctly for `GET /api/operations`, but `POST
/sync-schema`'s failure path doesn't go through that field at all when
`ensureCollectionSchema()` rejects with something other than a deliberate
`HttpError` — the raw exception propagates straight to `router.js`'s
catch-all 500 handler, which sent `err.message` completely unredacted. This
is the exact response `settings-view.js`'s `runSettingsRepair()` displays
verbatim in the settings page's inline error box (`result.textContent =
err.message`). Fixed by running `router.js`'s unexpected-error branch
through the same `sanitiseErrorMessage(msg, process.env.QDRANT_KEY)` call
already used everywhere else raw Qdrant/process output is captured — scoped
specifically to the *unexpected*-error branch, not the deliberate-`HttpError`
branch (those are always static, developer-authored strings with nothing to
redact; a new test confirms an `HttpError` message survives unmangled, since
it can legitimately contain something that looks like a URL — e.g. "Collection
not found" messages echoing a user-supplied name). New tests:
`router.test.js` (three — literal key redaction, URL-credential redaction,
and the "HttpError is not redacted" guard, all at the router level) and
`server.test.js` (one — targets the actual `POST /sync-schema` HTTP response
body directly, the same response `settings-view.js` shows the user, per the
reviewer's explicit ask to test that response and not only `GET
/api/operations`).

## Verification run

- `npm test` — 848/848 passing (783 baseline before this phase + 65 net new
  across both review rounds, including all fixes above: task-registry.test.js,
  operations.test.js, ui-operation-render.test.js, ui-operation-store.test.js,
  ui-operation-modal.test.js, ui-settings-repair.test.js, router.test.js
  additions, plus additions to ui-jobs.test.js/ui-topbar.test.js/
  server.test.js — net of the old job-list rendering/polling tests deleted
  along with the behavior they covered).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build (28 modules).
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings).
- Live Playwright verification against a real, disposable collection
  (indexing `docs/design/`, ~276KB, 11 files, via ONNX embeddings — a real
  end-to-end run, not a stub):
  - **`#/index` confirmed free of the legacy jobs console**: no `#idx-jobs`
    element, no "Indexing progress" panel heading.
  - **Modal opens immediately on start**, showing `queued`/`running` from
    the POST response.
  - **Navigated to `#/c/demo` while indexing ran** — the topbar chip stayed
    visible with a live percentage (`"Indexing phase3s-verify-tmp 0%"`),
    confirming the operation survives navigation.
  - **Reopened the modal from the topbar chip** — no route change
    (`location.hash` stayed on `#/c/demo`), progress continued from where
    it left off.
  - **Completion**: modal showed `succeeded`, `100%`, `"Completed in
    Xm XXs"`; closing it produced a `toast-success` with a "View" action;
    clicking "View" reopened the modal on that exact operation.
  - **A genuine failure** (indexing a nonexistent path): modal showed
    `failed`, auto-expanded "Show details" (no prior manual toggle), a
    visible error summary with the real message
    (`"Error: ENOENT: no such file or directory, stat '...'"`), full
    started/ended timestamps and raw log behind "Show details"; closing
    produced a `toast-error` with the same message and a "View details"
    action that correctly reopened the modal on the failed operation.
  - Every disposable test collection created during verification
    (`phase3s-verify-tmp` and three `-fail*-tmp` variants) was deleted
    afterward via `DELETE /api/collections/:name`.
  - No console/page errors throughout.
- Live re-verification after the code review fixes, run twice against a
  real existing collection (`bench-structural-carryover`, real Qdrant
  Cloud, non-destructive/idempotent repair — no cleanup needed): clicking
  "Repair collection compatibility" now correctly opens the modal
  (`"Repaired bench-structural-carryover"`, `succeeded`, `"Completed in
  1s"`) **and** fires a `toast-success` (`"Repair complete:
  bench-structural-carryover (1s)"`) with a working "View" action that
  reopens the modal on the exact repair operation — confirming the fix
  actually closes the gap the first live verification pass had missed
  (the original implementation's modal-open behavior looked correct in a
  screenshot, which is why the missing toast wasn't caught until the
  post-review re-check).
- Live re-verification of the round-2 modal-pinning fix, using two real
  back-to-back indexing jobs (deliberately tiny one-file folders, skeleton
  chunking/nav switched off, so both jobs complete or fail in well under a
  second — this makes the race window the fix targets easy to actually hit
  live, rather than depending on multi-minute real embedding runs). Both
  jobs failed fast on an unrelated precondition (no local Ollama running —
  irrelevant to what was being tested; a fast, deterministic failure is
  just as good a race-window trigger as a fast success). Checked the modal
  ~30ms after clicking "start indexing" for the second job — before this
  fix, that window was exactly where the bug reproduced (the modal stuck
  showing the first job). The check confirmed the modal was **already**
  showing the second job (`"running … Indexing phase3s-pin-fast-b …
  cancel"`, no mention of the first job's collection name at all) — no
  stale fallback, no incorrect id-rebinding. Once the second job settled,
  the modal's final title correctly read `"Indexing failed"` for the
  second job specifically, confirming the fix holds through to the
  settled end state too, not just the initial race window. (An earlier
  attempt at this same live check used a full multi-file folder with real
  ONNX embeddings and got stuck mid-run for unrelated reasons — a system
  load spike from concurrent test suite runs — which is why the tiny,
  fast-indexing-or-fast-failing folder approach was used instead; both
  disposable test collections were deleted afterward via `DELETE
  /api/collections/:name`.)

## Known limitations

- **`operation-modal.js`'s "Recent operations" history is capped at 8
  entries** and only reflects what the backend registries hold in memory
  for the current server process's lifetime — there is no persistent
  operation history across server restarts, matching the existing job
  registry's own in-memory-only behavior (unchanged from before this
  phase).
- **Repair's `cancellable: false` is a real, permanent limitation**, not a
  placeholder — `ensureCollectionSchema()` has no cancellation token
  threaded through its Qdrant calls today. Adding genuine repair
  cancellation would require plumbing an `AbortSignal` through
  `src/core/qdrant/ensure-schema.js` and its Qdrant client calls, which is
  out of this phase's scope (the task explicitly said "not cancellable
  unless cancellation is genuinely supported").
- **The topbar chip shows only the single most-recently-started active
  operation** (`getActiveOperation()` returns the first match in
  newest-first order) — if two operations were ever active at once (not
  possible today: the job registry enforces one active job globally, and
  repair is typically near-instant), the chip would not show a "+N" count
  the way the old job-chip briefly did for multiple concurrent jobs. This
  matches the current real concurrency model (one job registry slot,
  repair calls are synchronous from the caller's perspective) rather than
  being a regression from a scenario that can actually occur.
- **`operation-store.js`'s `lastSeenState` Map is never evicted** beyond
  the backend registries' own in-memory bounds — acceptable for a single
  admin session's lifetime, matching this codebase's existing tolerance for
  unbounded-but-practically-small in-memory session state (e.g.
  `jobDetailsManualState` in the now-deleted `jobs-view.js` had the same
  shape).
