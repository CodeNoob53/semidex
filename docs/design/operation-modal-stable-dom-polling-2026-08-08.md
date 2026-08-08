# Operation modal: stable DOM, details state, and log scroll during polling

Date: 2026-08-08

## Root cause

`operation-modal.js`'s `render()` was invoked on every `operation-store.js`
poll tick (every ~1.5s while an operation is active). For a poll of the
**same** operation id, it still:

1. Called `renderOperationCard()`, which cloned the `tpl-job-row` template
   from scratch and rebuilt every DOM node inside it, including
   `<details class="job-details">` (reset to whatever `detailsOpen` the
   caller passed) and `<pre class="job-log">` (blank until the log fetch
   resolved).
2. Called `body.replaceChildren(card)`, discarding the previous card
   entirely — the browser tears down and rebuilds every node, so any
   uncommitted native state (scroll position inside `.job-log`, the
   `<details>` element's own toggle-in-progress state, focus) was lost.
3. Kicked off `loadOperationLog()` asynchronously, with no guard against a
   slower, earlier fetch (e.g. for a previously-open operation, or a
   superseded poll tick) resolving after a newer one and overwriting a
   fresher log with stale text.

None of this was needed for the common case — a poll tick for the
operation already on screen only ever needs a handful of text/attribute
updates (status badge, progress bar, counts, elapsed line), not a full
subtree replacement.

## Fix summary

### 1. Create vs. update split

`operation-render.js` now has:

- `applyOperationFields(card, op)` (private) — the single place that writes
  every field that can legitimately change between polls of the same id:
  status badge, title, progress bar/count/current-file/phase, cancel
  button visibility, status line, error summary, path, and timestamps.
  Both of the functions below call this — it is the only place this logic
  exists, so create and update can never drift.
- `renderOperationCard(op, opts)` — unchanged signature/behavior for
  callers. Still clones the template, still owns `.job-details`' initial
  `open` state and its one `toggle` listener, still fills `.job-log` from
  `op.log` if present. Called only for a genuinely new card.
- `updateOperationCard(card, op)` (new export) — calls
  `applyOperationFields()` against an **existing** card and touches nothing
  else. Never reads or writes `.job-details`' `open` attribute, never
  touches its listener, never touches `.job-log`.

`operation-modal.js`'s `render()` now tracks which operation id the
currently-mounted `.job-card` represents (`renderedCardId`/`renderedCard`,
module-level). On each render:

- If the incoming operation's id equals `renderedCardId` **and** the
  tracked card is still attached to `#op-modal-body` → call
  `updateOperationCard(renderedCard, current)`. No template clone, no
  `replaceChildren`, no new cancel-button listener (the one attached at
  creation time keeps working since the button element itself never
  changes identity).
- Otherwise (first open, or the operation id changed, e.g. via the
  history-row click or `openOperationModal(newId)`) → build a fresh card
  with `renderOperationCard()`, `replaceChildren()` it in, and record the
  new `renderedCardId`/`renderedCard`.

`renderedCardId`/`renderedCard` are reset to `null` on `closeOperationModal()`
and on the "loading"/"no operations yet" empty-state branches, so the next
real render always does a full build rather than trusting a stale
reference.

### Stable DOM nodes across a poll of the same operation

Never replaced for the same id: `.job-card` itself, `.job-head`,
`.job-body`, `<details class="job-details">` (and its `open` attribute/
listener), `<pre class="job-log">`, `.job-cancel` (and its click listener).
Only their **text/attribute/class contents** change — confirmed by test
("two poll updates for the same id leave the same `.job-card` DOM node in
place").

### 2. Details state preservation

Unchanged mechanism (`detailsManualState` Map + `resolveDetailsOpen()`),
but now actually protected by construction rather than by convention:
since `updateOperationCard()` never touches `.job-details`, a poll tick for
the same id physically cannot open or close it — the DOM node isn't
rebuilt, so there's no `detailsOpen` value to re-apply in the first place.
The `toggle` listener attached once at card-creation time keeps firing
`onToggleDetails` → `detailsManualState.set(id, open)` for as long as the
card is mounted; it is never re-attached on a later poll (there is no later
`addEventListener` call for the same card).

### 3. Log scroll preservation

New `updateOperationLog(pre, nextText)` in `operation-render.js`:

```js
export function updateOperationLog(pre, nextText) {
  if (pre.textContent === nextText) return;
  const wasAtBottom =
    pre.scrollHeight - pre.scrollTop - pre.clientHeight <= LOG_SCROLL_BOTTOM_TOLERANCE;
  const previousScrollTop = pre.scrollTop;
  pre.textContent = nextText;
  if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
  else pre.scrollTop = previousScrollTop;
}
```

- No-ops entirely (no `textContent` write, no `scrollTop` write) when the
  new text is byte-identical to what's already rendered — an unrelated poll
  tick (progress-only change, no new log lines) never touches `.job-log` at
  all.
- `LOG_SCROLL_BOTTOM_TOLERANCE = 4` (px) absorbs the same kind of
  sub-pixel/rounding slack a real browser can produce, matching the
  `<= tolerance` formula from the task spec.
- `operation-modal.js`'s `loadOperationLog()` now calls
  `updateOperationLog(pre, nextText)` instead of writing `pre.textContent`
  directly.

### 4. Async race protection

`loadOperationLog(card, id)` in `operation-modal.js` gained:

- **No redundant parallel fetch for one id**: a module-level
  `logRequestedForId` guard — if a fetch for the same `id` is already in
  flight, a new `render()` call's `loadOperationLog()` invocation returns
  immediately instead of firing a second one.
- **Stale-response guard**, checked once the fetch resolves, before
  applying anything:
  - `myRequestId !== logRequestId` — a newer log fetch (for this id or any
    other) has since started; this response lost the race.
  - `openOperationId !== id` — the modal has since switched to a different
    operation (or closed, where `openOperationId` is `null`).
  - `renderedCardId !== id || renderedCard !== card` — the mounted card no
    longer represents this id, or was itself replaced (e.g. a very fast id
    switch that rebuilt the card before this fetch resolved).
  - `!card.isConnected` — the card is no longer attached to the document at
    all (defensive; covers any teardown path not caught by the checks
    above).
  
  Any one of these failing drops the response silently — `updateOperationLog()`
  is never called.

Covered by two dedicated tests: a stale response for a **previously-open**
operation never leaks into the **currently-open** one's log, and a stale
response arriving **after the modal has closed** touches no DOM (no throw,
no stray write).

### 5. Recent operations history isolation

`renderHistory()` now computes a signature of only the fields it actually
renders (`id, state, kind, collection, startedAt, finishedAt`) for the
filtered (non-current) operation list, and returns immediately —
rebuilding nothing — when that signature is unchanged from the last render
(`renderedHistorySignature`, module-level, reset alongside
`renderedCardId` on close/empty-state). A poll tick that only changes the
**open** card's progress (the overwhelmingly common case) never touches the
history list's DOM at all, and by extension never affects the open card's
focus, details state, or log scroll — those live in a completely separate
subtree that `renderHistory()` never reaches into.

## What did NOT change

- `operation-store.js` — zero changes. Still the one shared poller; the fix
  is entirely on the render/update side of `operation-modal.js`/
  `operation-render.js`.
- No backend/API changes.
- No CSS changes.
- Live updates (polling itself) still run exactly as before — the fix
  makes each update cheaper and non-destructive, it does not throttle or
  disable them.
- `renderOperationCard()`'s public signature and template-based creation
  path are unchanged — existing callers/tests of the "first open" path
  needed no changes.

## Automated verification results

Run sequentially, per the task's OOM-avoidance constraint (no parallel/
background test runners):

| Command | Result |
|---|---|
| `node --max-old-space-size=512 --test --test-concurrency=1 tests/unit/admin/ui-operation-render.test.js` | 11/11 pass |
| `node --max-old-space-size=512 --test --test-concurrency=1 tests/unit/admin/ui-operation-store.test.js` | 15/15 pass |
| `node --max-old-space-size=512 --test --test-concurrency=1 tests/unit/admin/ui-operation-modal.test.js` | **33/33 pass** (23 pre-existing + 10 new, see below) |
| `node --max-old-space-size=512 --test --test-concurrency=1 tests/unit/admin/ui-settings-repair.test.js` | 4/4 pass (shares the same operation-modal/-render/-store stack via `runSettingsRepair()`) |
| `npm test` (full suite) | 3384 pass, 4 fail — all 4 failures are in `tests/unit/local/core/managed-runtime-listing.test.js`, a file this task never touched (git diff confirms zero changes to it or its source), part of the unrelated in-progress CUDA managed-runtime-installer plan tracked separately. No failures in any operation-modal/-render/-store/-settings-repair test. |
| `npm run admin:build` | Vite build succeeded, 227 modules transformed, no errors |
| `npm run smoke` | 1316 passed, 0 failed |
| `git diff --check` | No whitespace errors reported (only informational LF→CRLF warnings on the 3 touched files, from Windows `core.autocrlf`) |

### New tests added (10 scenarios, all in `tests/unit/admin/ui-operation-modal.test.js`)

1. **Stable DOM across poll updates** — two poll updates for the same id
   leave the same `.job-card` node in place, still reflecting the latest
   progress.
2. **Different operation → new card** — switching id creates a brand-new
   `.job-card` node.
3. **No duplicate listeners** — five consecutive in-place updates, then one
   cancel click, produces exactly one `POST /api/jobs/:id/cancel`.
4. **Cancel still works after many in-place updates** — direct regression
   guard for the cancel button surviving `updateOperationCard()`.
5. **Log scrolled up keeps its `scrollTop`** after new lines are appended.
6. **Log at the bottom stays pinned to the (new) bottom** after new lines
   are appended.
7. **Unchanged log never re-writes `textContent`** — a progress-only poll
   tick with identical log content produces zero `textContent` set calls
   (verified via an instrumented accessor).
8. **Stale response for operation A never overwrites operation B** — A's
   slow in-flight detail fetch resolves only after the modal has already
   switched to B; B's log is verified intact and A's stale text never
   appears.
9. **Stale response after modal close touches no DOM** — a slow in-flight
   fetch resolves after `closeOperationModal()`; no throw, modal stays
   closed.
10. **History-list isolation** — (a) a history-list-only data change (i.e.
    no change to the filtered non-current list) does not rebuild history
    row DOM nodes; (b) an update to a *different* operation's history entry
    does not affect the open card's `<details>` open state or `.job-log`
    scroll position.

Existing coverage (details-state-survives-polling, completion toast
dedup, cancel POST, history render/select, loading-state fallback,
open/close/focus) — all still pass unchanged, confirming no regression to
previously-verified behavior.

## Manual acceptance checklist (українською)

Ручна перевірка в браузері **не виконувалась** цією сесією (заборонено
завданням) — цей чекліст призначений для користувача, щоб підтвердити
поведінку наживо:

1. Запустити реальну індексацію (або reindex/repair) і відкрити operation
   modal. Переконатися, що бейдж статусу, прогрес-бар, "Current file" і
   "Step" оновлюються плавно кожні ~1.5с, **без миготіння чи "стрибка"**
   картки.
2. Натиснути "Show details", щоб розкрити `<details>`. Дочекатися кількох
   poll-циклів (30+ секунд активної операції) і переконатися, що деталі
   **залишаються відкритими**, а не закриваються самі.
3. Закрити "Show details" вручну під час **failed**-операції (яка спочатку
   автоматично відкрита). Дочекатися наступного poll-циклу і переконатися,
   що деталі **не відкриваються знову самі**.
4. Прокрутити `.job-log` вгору, щоб читати старі рядки, поки операція ще
   активна і генерує нові рядки логу. Переконатися, що позиція прокрутки
   **не збивається вниз** автоматично.
5. Прокрутити `.job-log` вниз до кінця (або не чіпати прокрутку взагалі —
   вона й так внизу за замовчуванням) і дочекатися нових рядків логу.
   Переконатися, що лог **сам прокручується вниз**, показуючи нові рядки.
6. Під час активної операції клікнути на інший рядок в "Recent operations",
   переконатися, що картка модалки одразу перемикається на нову операцію
   (новий заголовок, новий прогрес), а старий лог/деталі не "просочуються".
7. Натиснути кнопку "cancel" після того, як модалка відкрита якийсь час і
   встигла оновитися кілька разів через polling — переконатися, що
   скасування спрацьовує (статус переходить у "Cancelling…", потім
   "cancelled").
8. Відкрити модалку, одразу закрити її (до завершення першого запиту
   деталей/логу), і переконатися, що немає помилок у консолі браузера і
   що повторне відкриття модалки показує коректний стан.
