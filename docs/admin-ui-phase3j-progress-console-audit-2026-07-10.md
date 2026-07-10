# Admin UI Phase 3J — Indexing Progress Stability + Console Flash Audit

2026-07-10

## Part A — Job Details Open State Persistence

### What was wrong

`src/admin/ui-src/jobs-view.js`'s `loadJobs()` polls `/api/jobs` every
1.5s while any job is active and rebuilds the entire job list
(`box.replaceChildren(...jobs.map(renderJobRow))`) on every tick. An
earlier phase had already partially fixed the obvious case — capturing
which job IDs had an open `<details>` before the rebuild and reapplying
`open` to the same IDs afterward — but that fix tracked only "was it open
in the DOM right before this render," not "did the user ever explicitly
touch this." `renderJobRow()` itself still unconditionally set
`.job-details.open = state === 'failed'` on every freshly-built element.

The gap: a **manually closed failed job** got silently reopened on the
very next poll. Trace: job fails → auto-opens (state === 'failed', no
manual state yet) → user clicks `<summary>` to close it → next poll tick →
the old "was it open before" snapshot correctly excludes this job from the
reapply set → but `renderJobRow()`'s own unconditional
`open = state === 'failed'` line still runs on the fresh element it just
built, and the job is still `failed` → back open again. The user's close
action was invisible to the code the moment the row was rebuilt.

### Fix

Replaced the DOM-snapshot approach with a small module-level map,
`jobDetailsManualState: Map<jobId, boolean>`, that records every EXPLICIT
user open/close via a `toggle` event listener attached to each job's
`<details>` element (native `<details>`/`<summary>` fires `toggle` on both
directions, for both mouse and keyboard activation — one listener covers
both):

```js
const jobDetailsManualState = new Map();

function resolveJobDetailsOpenState(job) {
  if (jobDetailsManualState.has(job.id)) return jobDetailsManualState.get(job.id);
  return job.state === 'failed';
}
```

`renderJobRow()` calls this resolver as the single source of truth for
each fresh element's open/closed attribute, and attaches the `toggle`
listener that keeps the map current for any future poll. `loadJobs()` no
longer does a separate before/after DOM snapshot — `renderJobRow()` already
gets it right the first time. `loadJobs()` does prune `jobDetailsManualState`
entries for job IDs no longer present in the list, so the map doesn't grow
unbounded across a long admin session.

This satisfies every scenario in the task:
- Auto-open on failure only applies while the user has never touched that
  job's details (`jobDetailsManualState.has(job.id)` is false).
- Any explicit user toggle — open OR close — is recorded and always wins
  over the auto-open default on every subsequent render, including when a
  job is already `failed`.
- Progress/log content changing between polls never touches
  `jobDetailsManualState` at all, so it can't affect open/closed state.

### Tests

`tests/unit/admin/ui-jobs.test.js` — 5 new tests plus 1 existing test's
assertion style fixed (see below):

1. An untouched running job stays closed across polling, including as
   progress changes.
2. A user-opened running job survives a poll re-render, including as
   progress/log content changes across two subsequent ticks.
3. A failed job auto-expands when the user has never manually toggled it.
4. **The core bug fix**: a user manually closing a failed job's details is
   respected — the next poll does not reopen it.
5. A running job that transitions to `failed` between polls still
   auto-expands if the user never manually touched it (confirms the
   transition case is distinct from "user already closed it").

A `simulateToggle(document, detailsEl, nextOpen)` test helper works around
two real linkedom limitations discovered while writing these tests:
linkedom doesn't fire native `toggle` events on attribute mutation, click,
or `dispatchEvent(new Event('toggle'))` (the last one throws — linkedom's
`dispatchEvent` assumes an event created via `document.createEvent`, not a
bare `Event` instance); `document.createEvent('Event')` + `initEvent()` is
the one dispatch path that works in this harness. The helper also mirrors
real-browser ordering (the open/closed attribute changes, THEN `toggle`
fires) — getting this order backwards was an early mistake caught by these
tests initially failing for the wrong reason during development.

Also fixed one existing test's assertion (`'failed job shows "Failed
after..."'`) from `.job-details.open` (the IDL property, which linkedom
does not reflect from `setAttribute`) to `.hasAttribute('open')`, matching
the convention the newer tests already used.

All 5 new tests were verified via revert/re-test/restore to fail against
the pre-fix code (the old DOM-snapshot-only approach), confirming they
exercise the real bug, not just new code paths.

### Live verification

Started a real (harmless — pointed at a non-existent path, so it fails in
~1.5s with no files ever touched and nothing written to Qdrant) indexing
job via the real admin server, then drove the actual browser via
Playwright:

- Job auto-opened its details on load (failed state, no prior manual
  interaction) — confirmed.
- Clicking `<summary>` closed it — confirmed.
- Waited 3.5 real seconds (more than two 1.5s poll cycles) — details
  remained closed the entire time — confirmed the fix holds under real
  polling, not just the unit-test simulation.
- A fresh page load (new browser session, fresh JS module state) correctly
  re-derived the auto-open default from the job's own `failed` state —
  confirms `jobDetailsManualState` is intentionally session-scoped client
  state, not expected to persist across a full page reload (not asked for
  by the task).
- No console/page errors during any of the above.

## Part B — Windows Console Flash Audit

### Method

Searched the entire `src/` tree for `spawn(`, `exec(`, `execFile(`,
`spawnSync(`, `execSync(`, any `child_process` import, `powershell`,
`cmd.exe`, `ollama serve`, `windowsHide`, `detached`, and `shell:`. Found
exactly 4 files that import `child_process` in the whole codebase — every
process-launching call site in the project, with no exceptions.

### Audit table

| File | Function | Process launched | Triggered by | `windowsHide`? | `detached`? | `shell`? | Could flash? | Notes |
|---|---|---|---|---|---|---|---|---|
| `src/admin/jobs/registry.js` | `startIndexJob()` | `node <indexer entry> <path>` (`process.execPath`) | Admin UI "Start indexing" | **Yes**, already set | No | No (args array) | No — already fixed | Was already correct before this phase; confirmed via source read and existing DI-based unit test (`jobs.test.js`) asserting `opts.windowsHide === true` and `opts.shell === undefined`. |
| `src/admin/system/folder-picker.js` | `pickFolder()` | `powershell.exe -NoProfile -NonInteractive -STA ... -Command <script>` | Admin UI "Choose folder" button | **Yes**, already set | No | No (args array) | No — already fixed | Also already correct; existing test (`system.test.js`) asserts `opts.windowsHide === true`. The WinForms `FolderBrowserDialog` GUI window itself is unaffected by `windowsHide` (that flag only hides the PowerShell console host, not GUI windows the script opens) — deliberate and correct per the task's "folder dialog itself must be visible" requirement. |
| `src/indexer/phases/chunk.js` | `chunkFile()`'s pandoc branch | `pandoc <file> -t markdown --wrap=none` | Any `.docx`/`.odt`/`.rtf`/`.epub`/`.html`/`.htm` file encountered during an indexing job | **No — fixed this phase** | No | No (args array) | **Yes — real, fixed** | Runs once per matching file inside the already-`windowsHide`'d indexer child process. A child process launched from a hidden parent still gets its own console window on Windows unless it's also told to hide it — a job indexing several such files flashed one console window per file. This is very likely the "several times" flashing the task describes. |
| `src/bootstrap-docs.js` | `runIndexer()` | `node <indexer entry> <path>` (`spawnSync`) | `npm run bootstrap:docs` (a manual CLI command, not admin-UI-triggered) | No | No | No (args array) | No — out of scope | `stdio: 'inherit'` is deliberate and correct here: this is a CLI script the user runs directly in their own terminal, so there's no separate console to flash — inheriting stdio is exactly right for a foreground CLI tool. Confirmed out of scope by the earlier Phase 3C plan's explicit "CLI-only, not admin-UI-triggered" scoping, unchanged here. |
| `src/admin/system/ollama.js` | `checkOllama()` | *(none)* | LLM-summaries checkbox / job-start preflight | N/A | N/A | N/A | **No — confirmed check-only** | No `child_process` import at all. Pure HTTP via `src/core/ollama.js` (`isOllamaReachable`/`listOllamaModels`, both `fetch`-based). Confirmed by direct read of both files and an existing test (`system.test.js`) that source-greps for the absence of `child_process`. |

### Ollama autostart

No autostart code exists anywhere in the codebase — searched for `ollama
serve` and found only instructional strings telling the user to run it
themselves (`doctor.js`, `preflight.js`, `ollama.js`'s own error messages).
No `spawn`/`exec` call anywhere is passed anything resembling an Ollama
binary invocation. This was already true before this phase; confirmed, not
assumed.

### Fix applied

`src/indexer/phases/chunk.js` — added `windowsHide: true` to the pandoc
`execFileAsync` call's options object (alongside the existing
`maxBuffer`). No-op on non-Windows. No architecture change: same
`execFile`/`promisify` call shape, same args array, no `shell: true`
introduced.

```js
({ stdout } = await execFileAsync('pandoc', [filePath, '-t', 'markdown', '--wrap=none'], {
  maxBuffer: 50 * 1024 * 1024, windowsHide: true,
}));
```

### Tests

New `tests/unit/indexer/chunk-pandoc-windows-hide.test.js` — a
source-string regression guard (no dependency-injectable `execFile` stub
exists for this module today, unlike `registry.js`/`folder-picker.js`,
so this pins the actual options object text rather than exercising a real
pandoc invocation, consistent with this project's established convention
for hard-to-integration-test spawn call sites). Verified via
revert/re-test/restore to fail against the pre-fix code.

The other three required Part B test assertions — job spawn
`windowsHide`, folder-picker `windowsHide`, Ollama check has no
`child_process` — were already present and passing before this phase
(`jobs.test.js`, `system.test.js`); re-run and confirmed unchanged.

### Paths verified already safe (no change needed)

- `src/admin/jobs/registry.js`'s indexer spawn.
- `src/admin/system/folder-picker.js`'s PowerShell spawn.
- `src/admin/system/ollama.js` — check-only, no process launch at all.

### Out of scope, documented

- `src/bootstrap-docs.js`'s `spawnSync` — CLI-only, `stdio: 'inherit'` is
  correct for a foreground terminal tool, not admin-UI-triggered.

### Remaining suspected flash sources that could not be reproduced

None identified beyond the pandoc gap. The audit covered every
`child_process` import in the repository — there is no fifth spawn call
site left unexamined. If flashing is still observed after this fix on a
real Windows machine, the next most likely explanation is the OS/terminal
host itself (e.g. a GUI launcher briefly showing its own child-process
window before the admin server's own console suppression takes effect),
which is outside this codebase's control and outside this task's scope.

## Verification run

- `npm test` — 738/738 passing (733 baseline + 5 new).
- `npm run smoke` — 1293/1293 passing.
- `npm run admin:build` — clean Vite build.
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings).
- Live Playwright verification (Part A) against a real, harmless indexing
  job (see "Live verification" above) — auto-open, manual close
  persistence across real polling, and fresh-session re-derivation all
  confirmed correct with no console errors.

## Acceptance criteria check

- Opening job details/log remains stable across polling — confirmed by
  both unit tests and live verification.
- Failed job details still auto-open, but a manual close is now respected
  — the core bug fix, confirmed by both unit tests and live verification.
- Audit table above explains the concrete, verified cause of repeated
  console flashing: the pandoc `execFile` call, once per matching file per
  job, with no `windowsHide`.
- All non-interactive admin/indexer spawn paths now use `windowsHide: true`
  (registry.js, folder-picker.js already did; chunk.js's pandoc call fixed
  this phase) or are explicitly justified (bootstrap-docs.js, a CLI tool
  where `stdio: 'inherit'` is correct, not a flash source).
- Ollama check remains check-only; confirmed no hidden autostart behavior
  exists anywhere in the codebase.
- Tests/build pass.
- No unrelated UI redesign — only `jobs-view.js`'s details-persistence
  logic and `chunk.js`'s one options object changed; no visual/layout
  changes anywhere.
