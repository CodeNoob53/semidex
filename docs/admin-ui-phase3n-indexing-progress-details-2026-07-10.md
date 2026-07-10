# Admin UI Phase 3N — Indexing Progress Details Stability

2026-07-10

## Before/after behavior

**Before this phase**: this exact bug — job details disclosure collapsing
on every poll — was already identified and fixed in **Phase 3J**. A direct
read of `src/admin/ui-src/jobs-view.js` at the start of this phase confirmed
the fix was already in place and working: opening a job's details, closing
it, auto-opening on failure, and respecting a manual close on a failed job
all behaved exactly as this task's acceptance criteria describe.

**What this phase actually found and fixed**: not a behavior bug, but a
*test-coverage* gap. Cross-checking the task's 7 listed test scenarios
against the existing suite (`tests/unit/admin/ui-jobs.test.js`) found 4
already covered from Phase 3J, and 3 genuinely missing:

- Requirement 2 ("user closes details, stays closed") was tested for a
  *failed* job (closing an auto-opened failed job) but not for a *running*
  job the user opens and then closes — a distinct code path (exercises the
  manual-close branch of `jobDetailsManualState`, not just its "never
  touched" default).
- Requirement 3 ("keyed per job id") had no test with more than one job on
  screen at once — nothing proved two jobs' states don't collide or share
  a single flag.
- Requirement 7 ("logs are not duplicated between renders") had no test at
  all — `loadJobLog()`'s log-rendering behavior was untested in isolation.

**After**: same behavior (unchanged), now with complete test coverage for
all 7 scenarios the task lists.

## State model

Unchanged from Phase 3J — documented here since the task asked for it:

```js
// Module-level, in-memory only — no localStorage, cleared on page reload
// by virtue of being a fresh JS module instance.
const jobDetailsManualState = new Map(); // jobId -> boolean (explicit user choice)

function resolveJobDetailsOpenState(job) {
  if (jobDetailsManualState.has(job.id)) return jobDetailsManualState.get(job.id);
  return job.state === 'failed'; // auto-open default, only when untouched
}
```

- `renderJobRow()` calls `resolveJobDetailsOpenState(job)` as the single
  source of truth for each job's `<details open>` attribute on every
  render (each poll tick rebuilds every job card from scratch via
  `box.replaceChildren(...jobs.map(renderJobRow))`).
- A native `toggle` event listener on each `<details>` element records
  every real user interaction — both opening and closing — into the map,
  keyed by that job's id.
- `loadJobs()` prunes map entries for job ids no longer present in the
  list (e.g. after a server restart), so the map doesn't grow unbounded
  across a long admin session — still in-memory only, still cleared
  entirely on a page reload.
- Progress bar, current step, elapsed-time ticker, and status badge are
  all driven by separate code paths (`jobFilesLabel()`,
  `tickRunningJobRows()`, the status-line branch in `renderJobRow()`) that
  don't read or write `jobDetailsManualState` at all — confirmed
  unaffected both by code inspection and by the new tests that assert
  progress values change correctly while details state stays put.
- Log rendering (`loadJobLog()`) fetches and replaces `.job-log`'s
  `textContent` wholesale on every call (`pre.textContent =
  job.log.slice(-30).join('\n')`) — never appends — so there's no
  client-side accumulation to deduplicate; the server's own response is
  authoritative each time.

## Tests

`tests/unit/admin/ui-jobs.test.js` — 3 new tests (30 → 33 total in this
describe block's containing file):

1. *(Already covered, Phase 3J)* Details stays open after `loadJobs()` is
   called again with the same running job, including as progress/log
   content changes.
2. **New**: a user opens then closes a *running* job's details — stays
   closed across a further poll, even as progress changes. Distinct from
   the existing "never touched, stays closed" test, since this exercises
   the actual manual-close write path.
3. **New**: open/closed state is keyed per job id — two jobs on screen at
   once, opening one leaves the other untouched; closing the first and
   opening the second correctly flips only those two, proving the state
   isn't a single shared flag.
4. *(Already covered, Phase 3J)* A failed job auto-opens details when no
   manual state exists.
5. *(Already covered, Phase 3J)* A failed job does not auto-open if the
   user manually closed it — the core Phase 3J bug fix.
6. *(Already covered, Phase 3J)* Progress percent/current step still
   updates on re-render, independent of details open/closed state.
7. **New**: logs are not duplicated between renders — confirms the
   `.job-log` element's text is replaced wholesale on each poll (matching
   the server's authoritative `job.log` array each time), not appended to
   with stale client-side text, verified by asserting each log line
   appears exactly once even after two consecutive polls with growing log
   content.

All 3 new tests were verified via a temporary source-level bug injection
(changing `pre.textContent =` to `pre.textContent +=` for the log test) to
confirm they correctly catch a regression before restoring the original
code.

## Verification run

- `npm test` — 754/754 passing (751 baseline + 3 new).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean; only `ui-jobs.test.js` changed — confirming
  this phase's actual footprint was test coverage only, no source change.
- Live Playwright verification against the real admin server (a harmless
  throwaway job pointed at a non-existent path, so it fails in ~1.5s with
  nothing written to any real collection): confirmed the job's details
  auto-opened on failure (`true`), a real click on `<summary>` closed it
  (`false`), and it remained closed through more than two real 1.5s poll
  cycles (`false`) — the collection created for this test was deleted
  afterward via the admin API.

## Limitations / follow-ups

None. This phase's contribution was closing genuine test-coverage gaps
against an already-correct implementation, not new behavior — every
acceptance criterion in the task was already true of the codebase before
this phase started, and is now backed by a complete set of the tests the
task itself asked for.
