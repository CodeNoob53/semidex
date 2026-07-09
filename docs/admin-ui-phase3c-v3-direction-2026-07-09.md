# Admin UI Phase 3C — Apply v3 Mock Direction to Current Backend (2026-07-09)

Adopts the visual/IA direction from a design-tool mock (`Semidex Admin
v3.dc.html`) only where the current backend already supports it: an inline
icon system, sidebar/CSS density polish, a real collection-header metadata
row, a topbar active-job chip, and a Windows console-flash fix. The mock was
analyzed for information architecture and component behavior only — its
markup, `support.js`, custom elements, and mock state were never imported,
copied, or referenced in code.

Two research passes (mock analysis + current-codebase audit) plus direct
verification found that **most of the v3 information architecture was
already implemented** by Phases 3A/3B: single main content surface,
sidebar-owns-navigation, section-view-without-an-extra-click, active/hover
states, label truncation, the search-card field set, and `window: 0` by
default. The real remaining work was narrower than the task text implied.

## What was transferred from v3

1. **Icon system** (`src/admin/ui-src/icons.js`, new file) — ten small,
   hand-authored inline-SVG functions (`iconCollection`, `iconDirectory`,
   `iconFile`, `iconSection`, `iconTable`, `iconCodeBlock`, `iconChecklist`,
   `iconChevron`, `iconSearch`, `iconGear`), Feather/Lucide-style visual
   language (16×16 viewBox, `stroke="currentColor"`, `fill="none"`). No icon
   package was imported — matches the task's explicit "not a noisy custom
   icon system" instruction. Each icon's root `<svg>` carries
   `data-icon="<name>"` so tests can assert on identity without matching
   path data. Wired into:
   - `sidebar.js` — replaces the old emoji glyphs (📁/📄/§) in the tree rows,
     mapped by real `nodeType` via `iconForNodeType()`.
   - `file-view.js` — structural chunk badges (`table`/`code_block`/
     `checklist`) get an icon prefix; other node types stay text-only.
   - `search.js` — the search result card's node-type badge gets the same
     icon treatment as the file view, for visual consistency between the two
     surfaces.
2. **Sidebar width + density** (`sidebar-resize.js`, `app.css`) —
   `SIDEBAR_DEFAULT_WIDTH` raised from 320 to 340 (icons added a column to
   every tree row; min/max unchanged at 240/520). Added a fixed-width icon
   column with a dimmed-until-hover/active color treatment so the icon
   doesn't outweigh the label text next to it.
3. **Collection header secondary row** (`collection-view.js`,
   `renderCollectionHeader`) — a new always-visible-but-compact line below
   the name/health-badge/settings row: `denseProvider · denseModel · Nd ·
   hybrid|dense-only`, sourced from `getCollection()`'s existing
   `provider`/`vectorSchema` fields (see bug #1 below — these were already
   in the response shape, just blocked by the `description` bug from ever
   being exercised end-to-end). Omitted entirely when `denseProvider` is
   null (never-indexed or legacy collection) rather than showing empty
   chips. Detailed schema-version fields (`chunkingSchema` etc.) stay out of
   the header — those remain in Collection settings' Advanced diagnostics.
4. **Topbar active-job chip** (`topbar.js`, new `initJobChip()`/
   `pollJobChip()`/`renderJobChip()`) — a small pill next to the health lamp,
   reachable from any route, showing "Indexing `<collection>`" (+N if more
   than one job is active). Hidden with zero active jobs. Click navigates to
   `#/index`. Polls `GET /api/jobs` on its own cadence (1.5s while a job is
   active, 5s idle) but explicitly skips its own poll while already on
   `#/index`, since `jobs-view.js` already polls faster there — confirmed via
   a test that asserts zero `/api/jobs` calls from the chip on that route.
   This is not a job center: the full list with logs/cancel still lives only
   at `#/index`.
5. **Windows console-flash fix** — `windowsHide: true` added to both
   admin-UI-triggered `spawn()` call sites:
   - `src/admin/jobs/registry.js:183` (the indexer child process).
   - `src/admin/system/folder-picker.js` (the `powershell.exe` folder-picker
     process) — confirmed this does **not** hide the actual folder-browse
     dialog, since that's a separate WinForms GUI window the process opens,
     not the console/terminal window `windowsHide` suppresses.
   `ollama.js`, `jobs.js` (API layer), and `server.js` were re-confirmed via
   direct grep to have zero real `spawn()` calls — only comments mentioning
   "spawn" — so they were never a flash source in the first place.
   `bootstrap-docs.js` (CLI-only) and the indexer's own pandoc/tag-worker
   spawns (already hidden, run inside the already-non-console indexer child)
   stayed out of scope, per "keep changes scoped to admin UI."

## Code review follow-up (post-implementation)

A review of the topbar job chip found two real issues, both fixed:

1. **XSS via `job.collection` in `renderJobChip()`** — the chip's
   `innerHTML` interpolated the job's collection name unescaped. Collection
   names are user-controlled (the API only rejects `/` and `\`), so a name
   like `<img src=x onerror=...>` would have executed as markup. Fixed by
   routing both `job.collection` and the `+N` suffix through `esc()` (from
   `dom.js`), matching how every other collection/file-name interpolation in
   this codebase is handled. Added a test asserting a malicious collection
   name renders as inert text with zero `<img>` elements created.
2. **Stale chip while on `#/index`** — `pollJobChip()` skips its own poll
   tick while the user is on `#/index` (by design, to avoid double-polling
   with `jobs-view.js`), but was leaving whatever the chip last showed
   untouched. If a user clicked the chip to reach `#/index` and the job then
   finished, the chip would keep showing "Indexing ..." indefinitely until
   the user navigated away and the chip's own poller ran again. Fixed by
   hiding the chip immediately on entering that branch — the jobs list
   itself is the source of truth while on `#/index`. Added a regression test
   that flips a route stub from `overview` to `index` mid-test and asserts
   the chip hides.

Both fixes verified: 657/657 unit tests passing (11/11 in
`ui-topbar.test.js`), `node --check` clean, admin build clean.

## Two backend bugs found and fixed (Phase 1, foundational)

1. **`src/core/storage/qdrant-adapter.js`'s `getCollection()` hardcoded
   `description: null`**, while `listCollections()` correctly read it from
   `loadConfig()`. Silently broke any collection description from ever
   reaching the UI. Fixed by loading config the same way `listCollections()`
   does. Verified live against the real cloud Qdrant instance during manual
   checks: `bench-retrieval-custom-50` now correctly returns `"description":
   "custom-50 quality benchmark — auto-managed"` instead of `null`.
2. **`jobs-view.js`'s `loadJobs()` destroyed a user-opened `<details>` panel
   on every poll tick** (~1.5s) for a still-running job — `renderJobRow()`
   always rebuilds a fresh `<details>`, auto-opening it only on failure, and
   the full `replaceChildren()` re-render silently closed anything the user
   had manually expanded. This is requirement 7's "preserve opened
   `<details>` state during polling" — a real, previously-unfixed bug. Fixed
   by capturing open job IDs (via `[open]` attribute presence, not the
   `.open` IDL property — more robust across DOM implementations) before the
   re-render and reapplying them after.

## What was intentionally NOT transferred

- **Ask/chat tab, cloud provider/API key management, provider marketplace,
  alias-based reindex, Qdrant snapshots UI, image lightbox, native assistant
  answer rendering, fake "zero downtime" buttons, fake capability cards** —
  none of these exist in the current UI and none were added. `settings-view.js`
  was not touched.
- **Stitched/chunked toggle** — confirmed via direct read of `file-view.js`
  and a full-repo grep (zero hits for "stitched" or "chunked") that no such
  toggle exists, not even a disabled stub. There is only one display mode
  today (chunked chunk-by-chunk view), which is what the task explicitly
  permitted ("implement only chunked now ... do not fake stitched output").
  A toggle with one dead option would have been worse than no toggle.
- **Per-file summary field** — confirmed the `/chunks` API response has no
  file-level `summary` field, only per-chunk `context` (already surfaced via
  `.chunk-context`/`.chunk-context-label`). "Optional summary if available"
  resolves to "not available yet" for now; no backend work was done to add
  one, since that's new API surface outside this task's scope.
- **Full color-token/palette rewrite toward v3's orange-accent/oklch scheme**
  — judgment call: the current amber-accent dark theme already reads as a
  coherent, non-debug design system from Phases 3A/3B. A full palette swap
  was cosmetic risk with no functional payoff and wasn't required by the
  task's "IA and component behavior" framing. Only spacing/density and the
  new icon-row layout were adjusted; `--amber`/`--bg`/`--ink` tokens are
  unchanged.

## Tests

All new/changed behavior has dedicated automated coverage, run alongside the
full existing suite (no regressions):

- `tests/unit/core/storage/qdrant-adapter.test.js` — `getCollection()`
  description-from-config fix.
- `tests/unit/admin/ui-jobs.test.js` — `<details>`-state-preservation
  regression test.
- `tests/unit/admin/ui-icons.test.js` (new file) — every icon function
  returns a tagged, non-empty `<svg>`; `iconForNodeType()` covers every real
  structural type; `sidebarNodeRow()` renders the correct icon per node type;
  `file-view.js`/`search.js` node-type badges carry the matching icon and
  stay XSS-safe (untrusted `nodeType` values are still escaped even with the
  icon-prefix `innerHTML` change).
- `tests/unit/admin/ui-sidebar-resize.test.js` — updated for the new 340px
  default.
- `tests/unit/admin/ui-collection-view.test.js` — new describe block: the
  provider/schema row renders with real fields, shows `dense-only` vs
  `hybrid` correctly, and is omitted entirely when there's no provider data.
- `tests/unit/admin/ui-topbar.test.js` (new file) — chip hidden with no
  active jobs, visible with one (and shows a `+N` suffix with more), filters
  out terminal job states, click navigates to `#/index`, does not double-poll
  while already on `#/index`, a transient API error doesn't throw, hides a
  stale chip on navigating to `#/index` while a job was showing, and an
  untrusted collection name is escaped (XSS-safe) — the last two added
  during code review, see below.
- `tests/unit/admin/jobs.test.js` — `windowsHide: true` on the indexer spawn.
- `tests/unit/admin/system.test.js` — `windowsHide: true` on the
  `powershell.exe` folder-picker spawn.

**Result: 657/657 unit tests passing (includes the two code-review fixes
below), 1293/1293 smoke tests passing, `npm run admin:build` clean,
`git diff --check` clean, `node --check` clean on all changed/new JS
files.**

## Manual verification

A literal interactive-browser click-through was not possible in this
environment. Instead, the built admin server was started against the
project's real configured Qdrant Cloud instance and driven end-to-end over
HTTP to verify the same surfaces a manual pass would check:

- `GET /api/collections` / `GET /api/collections/:name` — real collections
  load; `bench-retrieval-custom-50`'s `description` now returns real text
  (confirms bug #1's fix against live data, not just a mock).
- `GET /api/collections/:name/skeleton` and `/skeleton/children` — real
  skeleton tree data confirmed, including real long Cyrillic file/directory
  names (`ml-math-tests-skeleton`), useful for confirming the truncation and
  icon-per-node-type paths against realistic data shapes.
- `POST /api/search` — confirmed the response shape has no `windowChunks`
  field (window=0 default holds against live search).
- `GET /api/collections/:name/chunks` — file-view chunk fetch confirmed
  against real content.
- `GET /api/jobs` — returns `{ jobs: [] }`, confirming the topbar chip would
  correctly stay hidden with no active jobs.
- Fetched the actual **built** `index.html` and JS bundle from the running
  server and confirmed the served bundle contains `id="job-chip"` (hidden by
  default), `data-icon` attributes (icon system present), `job-chip-dot`, and
  `col-header-meta-row` — i.e., the built artifact a browser would actually
  load contains every Phase 3C feature, not just the source.

**Not verified** (needs a human with a real browser/Windows session): visual
truncation rendering, hover/focus/active CSS states as actually painted,
click/keyboard interaction feel, sidebar resize drag behavior, and — most
importantly for requirement 7 — whether a PowerShell/cmd console window is
now visibly absent during an indexing run or folder pick on a real Windows
desktop. The `windowsHide: true` fix is Node's documented, standard
mechanism for this and is unit-tested at the spawn-args level, but its
real-world visual effect could not be observed in this environment.

## Follow-ups

- Manual browser/Windows verification of the items listed above, especially
  the console-flash fix's actual visual effect.
- A file-level `summary` field, if ever added to the backend, would slot
  into the existing per-file header area in `file-view.js` without further
  restructuring.
- A "stitched" (whole-file reconstructed) view remains undesigned/
  unimplemented — deliberately, per this task's scope.
- The v3 mock's Ask/chat tab was not evaluated further; per the task, it may
  become a separate "ask this collection" capability later, but is out of
  scope for now.
