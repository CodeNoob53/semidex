# Admin UI Phase 4A.5b — Global Runtime Settings View (2026-07-15)

Status: implemented, tested. Not committed (per task instruction).

## Scope

A thin, read-only `#/settings` screen over the runtime APIs Phase 4A.5a
completed (`GET /api/health`, `GET /api/generation/status`). No writes, no
provider switching, no `.env` editing, no second config-precedence
implementation — all explicitly out of scope per the task, and confirmed
untouched.

## What was built

### 1. `src/admin/ui-src/global-settings-view.js` (new)

`renderGlobalSettingsView(main)` — mounts the shell, then fetches
`/api/health` and `/api/generation/status` via `Promise.allSettled()` (not
sequential `try`/`catch`), so a failure on one endpoint never blocks the
other panel from rendering its own real result. Two panels:

- **Storage**: `Connected`/`Unavailable` badge, backend name (`qdrant`),
  and a concise error detail when unavailable.
- **Answer model**: `Ready`/`Unavailable` badge, provider, model. Context
  size and device policy are shown whenever the backend reports a resolved
  configuration at all (`status.configuration` truthy) — **not** gated on
  `ready: true` — since the backend resolves and returns `devicePolicy`
  from configuration independently of provider readiness; only a fully
  invalid configuration (`configuration: null`) has nothing to show, in
  which case both rows are omitted. Context size itself still honestly
  shows `"—"` while `numCtx` is unknown (unready), never a fabricated
  number, via `formatContextSize()`'s own null-safe fallback. When
  unavailable, the actionable reason from the backend is shown, plus the
  (already server-redacted) `baseUrl.display` as a secondary diagnostic
  line — shown only alongside an unavailable reason, since that's the one
  case it plausibly helps diagnose. Never reconstructed or guessed
  client-side; it is rendered exactly as the backend returned it.

Configuration provenance (`os_env` → "Operating system environment",
`dotenv` → ".env file", `default` → "Semidex default") renders inside a
collapsed `<details class="gs-provenance">` per panel — closed by default,
secondary text, never the dominant element on the screen. When
`configuration` is `null` (the invalid-configuration case — see States
below), the provenance block is simply omitted, not rendered empty.

Every API-controlled string (`backend`, `model`, `reason`,
`storage.detail`, a rejected request's `err.message`) goes through the
existing `esc()` helper — no raw string ever reaches `innerHTML`
unescaped.

**Explicitly never rendered**, matching the task's UX list: streaming/
cancellation capability booleans, raw backend response objects, JSON,
internal field names (`numCtx`, `devicePolicy`, `baseUrl` as literal
keys), raw environment variable contents, secret values, or unrelated
storage capability flags.

### 2. `src/admin/ui-src/partials/global-settings-shell.html` (new)

Minimal shell: a title, one sentence of framing copy, and two empty
`<div class="panel">` mount points (`#gs-storage`, `#gs-generation`) —
same `?raw` partial-import convention every other view module already
uses (`settings-shell.html`, `overview-shell.html`, `collection-shell.html`).

### 3. Routing — `routes.js`, `router.js`

`currentRoute()` gained a `#/settings` → `{ view: 'global-settings' }`
case. Actual check order (corrected after a code-review finding — the
original draft of this report described the order imprecisely): the
`#/c/:name/settings` pattern, then `#/c/:name/f/...`, then
`#/c/:name/n/...`, then the bare `#/c/(.+)$` collection pattern, then
`#/index`, **then** `#/settings`, with the `overview` fallback last of
all. A collection literally named `settings` still resolves correctly to
`{ view: 'settings', name: 'settings' }` via the bare `#/c/(.+)$` pattern,
which is matched several cases before `#/settings` is ever reached — the
two routes cannot collide regardless of check order, since `#/c/...` and
bare `#/settings` are disjoint path shapes. `router.js`'s `route()`
dispatches `view === 'global-settings'` to `renderGlobalSettingsView(main)`,
a plain sibling import alongside the existing `renderSettingsView`/
`renderIndexingView` imports — `global-settings-view.js` itself imports
only `dom.js` and `api.js`, so no circular import is possible (verified by
a dedicated test asserting it does not import `router.js`, mirroring the
existing `sidebar.js`/`jobs-view.js` circular-import guards in
`ui-router.test.js`).

### 4. Top bar gear link — `index.html`, `topbar.js`, `app.js`, `sidebar.js`

A single `<a href="#/settings" id="nav-global-settings" aria-label="Semidex
settings" title="Semidex settings">` added to the topbar's existing
`#topbar-status` flex row, after the capability summary. The icon itself
is not hand-duplicated markup — `topbar.js` gained `initGlobalSettingsLink()`,
which renders the **existing** `iconGear()` from `icons.js` into the link
at boot (`app.js` calls it once, alongside `loadTopbar()`/`initJobChip()`),
so the SVG has exactly one source of truth, matching how every sidebar row
icon already works.

Active-route styling: `sidebar.js`'s existing `markActive()` — already the
single call site `router.js` invokes on every navigation — gained one more
line toggling `.active` on `#nav-global-settings` when
`route.view === 'global-settings'`. This does not create a
sidebar↔topbar coupling; `markActive()` already toggles `#nav-index`
(also a topbar-adjacent element) the same way.

### 5. `app.css`

- `.topbar-gear-link` — a compact 26×26px icon-only link matching the
  topbar's existing visual weight (health lamp, job chip), with a hover
  state and an `.active` state (amber, matching the rest of the app's
  active-route color). Keyboard focus is already covered by the existing
  global `a:focus-visible` rule (`app.css`'s pre-existing
  `button/a/input/select/.tree-row:focus-visible` block) — no new
  focus-visible rule was needed, confirmed by the link actually being a
  real `<a>` (not a `<button>` with different default focus behavior).
- `.gs-detail` / `.gs-detail-sub` / `.gs-provenance` — the unavailable-
  reason line, the secondary redacted-endpoint line, and the provenance
  `<details>` block. `.gs-detail`/`.gs-detail-sub`/`.gs-provenance .kv dd`
  all set `overflow-wrap: anywhere` so a long model name, reason string, or
  endpoint never forces horizontal scroll — verified directly (see Tests).

## States implemented

All six states the task named, each with a dedicated behavioral test:

1. **Storage and generation ready** — both panels show their positive
   badge and real values.
2. **Storage unavailable** — `Unavailable` badge + connection detail;
   generation panel still renders independently.
3. **Generation unavailable** — `Unavailable` badge + the actionable
   reason. Device policy and context size are **not** blanket-hidden here:
   device policy still shows its real, backend-resolved value (the
   provider being unreachable doesn't make the configured device policy
   unknown), while context size shows `"—"` (honestly unknown, since the
   backend only reports the live model's effective `numCtx` after a
   successful readiness check) — never a stale or fabricated value either
   way.
4. **Invalid generation configuration** — the one case where device
   policy/context size ARE both omitted, because `runtime.js` reports
   `configuration: null` here (unlike plain unreachability, where
   `configuration` is still a real, resolved object) — the backend
   otherwise reports this identically to "unreachable"
   (`ready: false, reason`); the provenance `<details>` is likewise
   correctly absent since `configuration` is `null`.
5. **Status request failure** — a rejected `api()` call (network error,
   non-2xx) renders that panel's own `Unavailable` state using
   `err.message`, independently of the other panel.
6. **Loading state** — implicit in the shell: both panels start as the
   partial's placeholder content (`…`) until `Promise.allSettled()`
   resolves; no separate spinner/skeleton was added, matching the
   existing pattern collection settings/overview panels already use for
   their own initial `…` placeholder.

## Data sources — confirmed scope discipline

- Only `GET /api/health` and `GET /api/generation/status` are fetched
  (asserted by a test that captures every `api()` call the view makes and
  compares the exact set).
- No `fetch()` call — only the shared `api()` helper (source-level test).
- No `/api/system/ollama-status` call (source-level test, tightened after
  an initial false-positive against this file's own explanatory comment —
  the assertion now matches the literal `api('/api/system/ollama-status`
  call pattern, not any substring mention).
- No `apiPost`/`apiDelete` reference anywhere in the module (source-level
  test) and no `<form>`/`<input>`/`<button>` in the rendered output
  (behavioral test) — confirming this view performs zero writes.
- No `process.env` read in the module (source-level test) — provenance
  labels are a pure lookup table over what the backend already resolved
  and returned; no second config-precedence implementation exists
  client-side.

## Tests

New: `tests/unit/admin/ui-global-settings.test.js` (34 tests) covering:
route parsing (`#/settings` vs `#/c/:name/settings`, non-collision for a
collection named "settings"), router dispatch and the no-circular-import
guard, both-ready rendering, storage-unavailable rendering, generation-
unavailable-with-reason rendering, invalid-configuration rendering,
independent request-failure handling (health fails / generation fails /
both fail, each asserted independently), the `Promise.allSettled` source
check, provenance label translation for all three source values, the
provenance `<details>` being closed by default, five hostile-string tests
(malicious model name, reason, storage backend name, storage detail, and a
rejected-request error message — each asserted to never produce a live
element while the text still renders inertly), the "no secret/raw fields"
group (capability booleans, internal field names, raw JSON blob, no
`process.env`, no `ollama-status` call, no raw `fetch()`), and the
"no writes" group (no `apiPost`/`apiDelete` reference, no form/input/button
in the rendered DOM).

Extended existing files, per the task's explicit instruction not to rely
solely on the new file:

- `ui-router.test.js`: `#/settings` parsing test (co-located with the
  existing route-parsing suite) and a "global-settings-view.js does not
  import router.js" circular-import guard, matching the file's existing
  `sidebar.js`/`jobs-view.js`/`routes.js` guards.
- `ui-topbar.test.js`: three behavioral tests using a real DOM
  (`initGlobalSettingsLink()` actually rendering the real `iconGear()` SVG
  into the served link; the link's `href`/`aria-label`/`title`; confirming
  it is a real `<a>` element) — not source-regex-only, per the task's
  explicit "avoid source-regex-only coverage where observable DOM behavior
  can be tested" instruction.
- `ui-sidebar.test.js`: three `markActive()` tests for the gear link
  (marks active on `global-settings`, stays inactive elsewhere, clears on
  navigation away).
- `ui-test-helpers.js`: new `loadGlobalSettingsHelpers()` (same
  URL-substring-keyed `api()` stub convention as
  `loadFileViewBehaviorHelpers`/`loadRouteIntegrationHelpers`, supporting
  both resolved responses and thrown `Error`s per endpoint);
  `loadTopbarHelpers()` extended to also evaluate `icons.js` (needed once
  `topbar.js` started importing `iconGear`);
  `loadSidebarActiveStateHelpers()`'s fixture DOM extended with a
  `#nav-global-settings` element; `loadRouteIntegrationHelpers()`'s
  `router.js` stubbing extended to also stub
  `renderGlobalSettingsView(...)` alongside the existing
  `renderSettingsView`/`renderIndexingView` stubs.

Targeted run (initial): 172 tests across every Phase-4A.5b-relevant file
(the new file, router, topbar, sidebar, and the two existing settings-view
test files as a regression check), all passing. After round-1 code review
fixes: 238 targeted tests (+66: the `/api/health` redaction tests in
`server.test.js`, the topbar-overflow CSS tests, and the corrected/added
device-policy tests). After round-2 fixes: 242 targeted tests (+4: the
job-chip bounding CSS tests and the long-collection-name behavioral test),
all passing, serially
(`NODE_OPTIONS='--max-old-space-size=768' node --test --test-concurrency=1`).
Full suite: `node --test --test-concurrency=1 "tests/**/*.test.js"` → 1382
passed, 0 failed (up from 1328 before this phase). `npm run smoke` → 1293
passed, 0 failed (smoke has no UI coverage, so this count is unchanged
from Phase 4A.5a). `npm run admin:build` → succeeds (226 modules, up from
224 — the two new source files). `git diff --check` → clean (line-ending
warnings only, pre-existing repo convention, exit 0).

## Visual verification — limitation

**No pixel screenshots were captured.** Neither Playwright nor Puppeteer
(nor any other headless-browser tool) is installed in this project, and
installing one was not requested by the task and would add a new
dependency outside this phase's stated scope. Asked the user how to
proceed; instructed to verify via markup/CSS review instead of adding
tooling.

What was verified instead:
- The real admin server (`npm run admin`) was started and `GET /`'s served
  HTML was fetched directly, confirming the gear link's exact markup
  (`href`, `id`, `aria-label`, `title`) matches what shipped.
- `GET /api/generation/status` was hit live (Ollama not running in this
  check) to confirm the real unavailable-state payload shape the view
  renders against.
- Long-string overflow handling was verified structurally: a test render
  with a deliberately very long model name, unavailable reason, and
  endpoint string confirmed each lands inside its designated wrap-safe
  class (`.kv dd` — `word-break: break-all`; `.gs-detail`/`.gs-detail-sub`/
  `.gs-provenance .kv dd` — `overflow-wrap: anywhere`), so none of them can
  force horizontal panel overflow.
- The topbar layout was reviewed directly and, across two rounds of code
  review, corrected: the original claim that "this phase does not
  introduce a new overflow risk" was itself wrong (round 1 finding) — the
  pre-existing topbar had no narrow-viewport handling at all, and adding
  the gear link removed what little slack the row had. Fixed with a real
  `@media (max-width: 640px)` rule (hides `.brand-sub`/`.cap-summary`,
  tightens padding/gaps), `.brand` and `#health-text` bounded with
  `min-width: 0` + `text-overflow: ellipsis`, and — round 2 — the
  active-job chip's own dynamic, user-controlled collection-name text
  (`topbar.js`'s `renderJobChip()`, no length limit enforced anywhere)
  independently bounded via `.job-chip { max-width; min-width: 0 }` plus a
  new `.job-chip-text` wrapper span carrying the actual `overflow: hidden;
  text-overflow: ellipsis` truncation — `.topbar-status`'s `flex-shrink: 0`
  alone only protects the row from shrinking, not from one of its own
  children (the chip) growing unboundedly with a long collection name.
  `.main`'s existing `.panel`/`.kv` grid (used identically by collection
  settings and this new view) has no fixed pixel widths, so panel content
  reflows with viewport width by construction — that part of the original
  analysis was correct and is unchanged.
- The admin server was stopped and no scratch files were left running
  after this check.

This is real verification of the underlying CSS/DOM mechanics, but it is
**not** the same as an actual rendered-pixel screenshot at a real narrow
viewport, which the task explicitly asked for. If pixel-accurate
confirmation is required, either grant this session permission to add
Playwright as a devDependency, or a maintainer with a local Node install
can run `npm run admin` and check `#/settings` directly in a browser at
both a normal and narrow window width.

## Changed files

```
M  docs/design/admin-ui-ux-and-ask-plan.md
M  src/admin/ui-src/app.css
M  src/admin/ui-src/app.js
M  src/admin/ui-src/index.html
M  src/admin/ui-src/router.js
M  src/admin/ui-src/routes.js
M  src/admin/ui-src/sidebar.js
M  src/admin/ui-src/topbar.js
M  tests/unit/admin/ui-router.test.js
M  tests/unit/admin/ui-sidebar.test.js
M  tests/unit/admin/ui-test-helpers.js
M  tests/unit/admin/ui-topbar.test.js
?? docs/admin-ui-phase4a5b-global-runtime-settings-2026-07-15.md   (this report)
?? src/admin/ui-src/global-settings-view.js
?? src/admin/ui-src/partials/global-settings-shell.html
?? tests/unit/admin/ui-global-settings.test.js
```

`ask-chat.md` was reviewed but not modified — its existing `4A.5`
references describe a future Ask-UI "open settings" link (Phase 4B) as a
forward dependency, not a claim that Ask itself has settings integration
today; nothing there needed correcting for this phase.

`docs/admin-api-phase4a5a-generation-runtime-2026-07-15.md` was not
modified — this report is Phase 4A.5b's own, kept separate per the task's
explicit filename.

Nothing committed, per the task's explicit instruction.

## Code review fixes, round 1 (2026-07-15)

A structured code review found 3 findings (1 P1, 2 P2) plus one report
inaccuracy against the delivered Phase 4A.5b implementation. All were
confirmed against the code, fixed, and regression-tested.

**[P1] `GET /api/health` could leak secrets in its error text.**
`storagePing.detail` was sent to the client verbatim —
`qdrant-adapter.js`'s `ping()` returns `err.message` raw on failure, which
for a Qdrant Cloud connection failure can embed the full request URL
(potentially with the configured `QDRANT_KEY` or other credentials), and
this new `#/settings` screen is the first surface that displays that text
directly to a user rather than only logging it. `health.js` gained the
same `safeMessage()`/`sanitiseErrorMessage()` pattern `api/ask.js` and
`api/generation.js` already use. Regression-tested with both a literal
`QDRANT_KEY` value and a credentialed URL with a query-string token
embedded in a simulated `ping()` failure, asserting neither ever appears
in the response body.

**[P2] The top bar had no narrow-viewport handling at all.** The sole
existing media query (`@media (max-width: 720px)`) only ever touched
`.layout`/`.main`; `.topbar` itself was a fixed-height (52px), non-wrapping
flex row with no `min-width`/shrink handling on `.brand` and no
`flex-shrink` guarantee on `.topbar-status`. Adding the gear link left the
row with less slack and no mechanism to avoid horizontal overflow at
narrow widths — the original report's "no new overflow risk" claim was
incorrect; it should have said the pre-existing topbar had never been
tested at narrow widths either. Fixed: `.brand` can now shrink
(`min-width: 0`) and truncates instead of overflowing; a new
`@media (max-width: 640px)` rule hides decorative content (`.brand-sub`,
`.cap-summary`) so the essential controls (health status, job chip,
settings gear) keep their room; `#health-text` is bounded
(`max-width: 40vw` + ellipsis) so it can never alone force the row wider
than the viewport; `.topbar-status`'s fixed-size controls get
`flex-shrink: 0` so they never get squeezed illegibly. No headless browser
is available in this project (see "Visual verification" below, unchanged
limitation), so this is verified at the CSS-mechanism level, not by an
actual rendered-pixel check at a real narrow viewport.

**[P2] Device policy was hidden exactly when it was most useful for
diagnosis.** `global-settings-view.js` gated the context-size/device-policy
row pair on `ready === true` — but the backend
(`runtime.js`'s `getStatus()`) resolves and returns `devicePolicy.value`
from configuration regardless of provider readiness; it only nulls that
out (along with `configuration` itself) for a genuinely invalid
configuration. Hiding a known, backend-reported device policy whenever the
provider was merely unreachable (the common case — e.g. Ollama not
running) removed exactly the information a user would want while
diagnosing that state (e.g. confirming a `GENERATION_DEVICE` override
actually took effect). Fixed by gating on `status?.configuration` (truthy
whenever the backend resolved a real configuration, regardless of
readiness) instead of `ready` — `numCtx` still correctly shows "—" while
unready, since the backend genuinely doesn't know the live model's
effective context size until a successful readiness check. The existing
test that asserted "ready-only fields must not appear when not ready" was
corrected — it had been pinning the bug, not a real requirement — and two
new tests assert the device policy IS shown (with the real configured
value) and context size correctly shows "—" (not a fabricated number)
while the provider is unavailable.

**[P3] Report inaccuracy.** The "Routing" section originally stated the
`#/settings` case was "checked after the existing `#/c/:name/settings`
pattern and the `#/index`/fallback cases" — imprecise: the fallback
(`overview`) is last, and `#/settings` is checked immediately before it,
after `#/index` specifically. Corrected to state the actual check order
verbatim, matching `routes.js`'s real sequence.

## Code review fixes, round 2 (2026-07-15)

Two more findings against round 1's own fixes and this report's own text.

**[P2] The topbar could still overflow during an active operation.**
Round 1 gave `.topbar-status` `flex-shrink: 0` and bounded `#health-text`,
but `.job-chip` itself had no `max-width`, no truncation, and no
`min-width: 0` — and its text content is `topbar.js`'s `renderJobChip()`
interpolating `activeOp.collection`, a user-controlled string with no
length limit enforced anywhere (the API only rejects `/` and `\`). A long
collection name during an active index/reindex/repair could grow the chip
— and therefore the whole topbar row, alongside the settings gear and
bounded `#health-text` — past the viewport on its own, independent of
whatever the brand/health-text side was doing; round 1's CSS tests only
covered `.brand`/`#health-text`/`.topbar-status`, not the chip's own
dynamic content. Fixed: `.job-chip` gained `max-width: 220px; min-width: 0`
(narrowed further to `120px` at the round-1 640px breakpoint); its
label/collection/percent text is now wrapped in a new
`.job-chip-text` span (`topbar.js`'s `renderJobChip()`, previously bare
text nodes alongside `.job-chip-dot`) carrying the actual
`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`
truncation — a flex container's raw text-node children can't individually
receive `text-overflow`, only a wrapping element can. Regression-tested
with four new tests: the chip's `max-width`/`min-width: 0` CSS, the
`.job-chip-text` truncation CSS, the narrow-breakpoint rule, and a
behavioral test rendering a real 90+ character collection name through the
actual `renderJobChip()` and confirming it lands inside the `.job-chip-text`
wrapper (not bare text) — the existing XSS-safety test for the same
function was re-run unchanged and still passes against the new markup.

**[P3] This report was left internally contradictory after round 1.**
Round 1 fixed the device-policy-visibility bug in the code but did not
propagate that fix into two places this report itself still described the
old (buggy) behavior: the "What was built" section still said context
size/device policy were shown "when ready" (rewritten above to state the
actual `status?.configuration`-gated behavior), and state 3 in "States
implemented" still said "ready-only fields... are omitted" (rewritten
above to describe device policy as shown-when-known, distinct from state 4
where it's genuinely absent). The "Visual verification" section's original
topbar bullet — written before round 1 existed — also still claimed "this
phase does not introduce a new overflow risk," which round 1 itself had
already disproven; that bullet is rewritten above to describe the actual,
now-fixed mechanism instead of leaving the pre-fix analysis standing next
to the corrected one.

## Limitations / explicitly not done

Confirmed out of scope and untouched, per the task's exclusion list:
provider selection, `.env` editing, local config writes, API-key inputs,
cloud provider adapters, session provider switching, Ask UI, embedding-
provider changes, collection-level setting changes. **This screen has no
editable controls of any kind and no fake/disabled controls for deferred
functionality** — every field is plain text or a badge, nothing is an
`<input>`/`<select>`/disabled `<button>` standing in for a future feature.

Real limitation carried forward from 4A.5a, inherited unchanged by this
view (not something 4A.5b could or should fix): `createApp()`'s no-DI
default for `generationRuntime` loses provenance nuance if a caller skips
`bootstrap.js` — irrelevant to this UI phase since the UI only ever talks
to the already-resolved `GET /api/generation/status` response, never
resolves configuration itself.
