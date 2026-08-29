# Admin dashboard v2 — design plan (2026-08-29)

> Status: design document. Nothing here is implemented. It consumes the decision
> register in `admin-dashboard-research-synthesis-2026-08-29.md` — accepted
> decisions appear here as constraints, rejected ones are absent by
> construction, future capability appears only in the API-gap register (§14).
>
> Supersedes the UI-layer parts of `docs/design/admin-ui-ux-and-ask-plan.md`
> phases 4B–4C for the Ask surface; the layering rules in
> `docs/design/admin-ui-and-storage-adapter.md` remain in force.
>
> **This plan is written from the code, not from screenshots.** No reference
> product was visually inspected. Section 7 states exactly where that limit
> bites.

---

## 1. Scope and non-goals

**In scope.** A rebuilt admin dashboard for the surfaces Semidex actually
serves: overview/readiness, collections and their documents/structure, search,
indexing operations, Ask, and settings — for both Full and Lite, from one code
base.

**Out of scope, by construction.** Anything in §14's "future capability"
column: conversation persistence, file upload, log browsing, RBAC/profiles,
provider fallback, metrics dashboards, MCP management, telemetry, command
palette, cross-collection search, history-API routing, i18n. These are named so
they cannot be smuggled in as "obviously needed".

**Not a rewrite of the server.** Every gap this design finds is recorded in §14
rather than assumed. Where a screen needs an endpoint that does not exist, the
screen is scoped down or deferred — it is never designed against an invented
contract.

---

## 2. Product principles

1. **Operator tool, not a dashboard product.** The user is running and
   diagnosing a local retrieval system. Density, predictability and honest state
   beat visual polish. No hero blocks, no vanity metrics, no card grid.
2. **Evidence stays authoritative.** Every rendered convenience (stitched
   reader, rendered table, highlighted code, an Ask answer) has a one-click path
   back to the raw original. A model never re-types content the UI could show
   directly. This is carried forward unchanged from
   `admin-ui-ux-and-ask-plan.md` §0.
3. **Deterministic operations stay buttons.** Index, reindex, repair, delete and
   settings changes are explicit controls with explicit confirmation. They are
   never driven through Ask.
4. **Truthful states.** If progress is unknown, show an indeterminate
   indicator, never a fabricated percentage — the server already models this
   (`progress.percent` is `null` unless genuinely computable,
   `src/shared/admin/api/jobs.js:199`). If an action cannot be cancelled, do not
   render a cancel button (`operations.js:88`).
5. **The browser is untrusted and holds no credential.** The admin UI talks
   only to same-origin admin routes. It never holds an integration bearer key,
   never receives a secret setting's value, and never treats its own validation
   as enforcement.
6. **Content is untrusted.** Filenames, chunk text, section titles, job log
   lines, error messages and model output are all attacker-influenceable.
   Default rendering is text.
7. **Full/Lite is a capability disclosure, not a switch.** Edition is decided at
   composition time (`src/admin/composition/lite.js` vs
   `src/admin/server-full.js`). The UI reports it; it never offers to change it.
8. **Security foundations are part of every slice.** Safe rendering, secret
   handling, cancellation/ownership and destructive-action design ship with the
   first screen, not in a closing hardening phase.

---

## 3. Target operator workflows

Nine workflows the design must make fast. Each is expressed against endpoints
that exist today unless marked.

| # | Workflow | Path through the product |
|---|---|---|
| W1 | **Is my instance healthy?** | Overview → global status strip (`GET /api/health`, `GET /api/generation/status`) → click a failing subsystem → Settings category that owns it |
| W2 | **Index a folder** | Collections → Index → pick a path (`POST /api/system/pick-folder`) → preflight → `POST /api/jobs/index` (202) → Operation detail |
| W3 | **Watch / diagnose a running operation** | Any screen → status chip → Operation detail (`GET /api/operations/:id`) → phase, counts, current file, log tail → Cancel if `cancellable` |
| W4 | **Diagnose a failed indexing job** | Operations list → failed row (`error` is the first stderr line, already redacted at capture) → detail → log tail → affected collection |
| W5 | **Find content** | Collection → Search (`POST /api/search`) → result inspector → open the file/section reader at that chunk |
| W6 | **Read a document as a document** | Collection → Structure/skeleton tree → node → stitched reader (`GET /api/collections/:name/assembly`) with rendered/raw toggle |
| W7 | **Ask a grounded question** | Ask → collection → question → sources land first, answer streams → citation → source inspector → open the underlying chunk/file |
| W8 | **Change a runtime setting safely** | Settings → category → field with provenance (`configuredSource`/`activeSource`/`pendingRestart`) → save → explicit result, including "applies at next restart" |
| W9 | **Repair or delete a collection** | Collection → Danger zone → repair (`POST …/sync-schema`, tracked as an operation) or delete (typed-name confirmation → `DELETE /api/collections/:name`) |

W1, W3, W4, W8 are the workflows an operator repeats. They get the shortest
paths and the most keyboard affordance.

---

## 4. Information architecture and route model

### 4.1 Shell

```text
┌ topbar: instance identity · global status strip · active-operation chip · settings ┐
│ rail / sidebar            │ content surface                                        │
│  Overview                 │  ┌ list / table ─────────┬ inspector (optional) ┐      │
│  Collections              │  │                       │                      │      │
│   └ <collection>          │  │                       │                      │      │
│      Documents            │  └───────────────────────┴──────────────────────┘      │
│      Structure            │                                                        │
│      Search               │                                                        │
│      Settings             │                                                        │
│  Operations               │                                                        │
│  Ask                      │                                                        │
│  Settings                 │                                                        │
└───────────────────────────┴────────────────────────────────────────────────────────┘
```

Five top-level destinations: **Overview, Collections, Operations, Ask,
Settings.** Search is deliberately *inside* a collection, because both search
routes are single-collection by contract (`GAP-05`). The collection subtree
expands in place — the existing skeleton tree already lives there and stays.

### 4.2 Routing

**Hash routing is retained.** This is not inertia: `handleStatic()` serves only
known file extensions and 404s everything else (`src/shared/admin/static.js:39,72`).
A history-API router would break every deep-link reload until the server grows
an SPA fallback (`GAP-08`). Hash routing also keeps `route()` free of
server-coupling.

| Route | Screen | Notes |
|---|---|---|
| `#/` | Overview | |
| `#/collections` | Collections list | new; today `#/` doubles as this |
| `#/c/:name` | Collection home | **existing route, preserved** |
| `#/c/:name/documents` | Documents | new |
| `#/c/:name/structure` | Structure (skeleton) | new; today folded into the sidebar |
| `#/c/:name/f/<sourceFile>` | File reader | **existing, preserved** |
| `#/c/:name/n/<nodePath>` | Section reader | **existing, preserved** |
| `#/c/:name/search?q=…&top=…&window=…&format=…&file=…` | Search | **existing query contract, preserved** (`routes.js:11-21`) |
| `#/c/:name/settings` | Collection settings + danger zone | **existing, preserved** |
| `#/operations` | Operations list | new |
| `#/operations/:id` | Operation detail | new; today a modal only |
| `#/ask?collection=<name>` | Ask | new |
| `#/settings` , `#/settings/:category` | Global settings | **existing, preserved** |
| `#/index` | Indexing form | **existing, preserved**; folded into Collections → Index later |

**Deep-link rules.**

- The URL carries *identity and non-sensitive view state only*: collection name,
  file/node path, operation id, settings category, search parameters that
  already round-trip today.
- **Ask question text is never placed in the URL.** Only `collection`. Prompt
  text is view-local. Rationale: URLs leak through history, screen sharing and
  copy/paste, and an Ask prompt is the most likely place for confidential text.
- Every route must be reachable by paste-into-new-tab and must survive
  back/forward. A route that cannot restore its state without a POST is not a
  route (this is why Ask runs are not addressable).
- Route parameters are decoded once, in `routes.js`, and treated as untrusted
  strings everywhere downstream.

### 4.3 Cross-link graph

```text
Overview ──► failing subsystem ──► Settings/<category>
         └─► active operation ──► Operations/<id>

Collections ──► Collection ──┬─► Documents ──► File reader
                             ├─► Structure ──► Section reader
                             ├─► Search ──► result ──► File/Section reader (anchored)
                             ├─► Index ──► Operations/<id>
                             └─► Settings ──► repair | delete

Operations/<id> ──► Collection
                └─► source path (display only; not a filesystem link)

Ask ──► citation ──► source inspector ──► File/Section reader (anchored)
    └─► collection selector ──► Collection
```

Every arrow above is backed by an existing endpoint. The one arrow the reports
wanted that is *not* drawn: Operation → affected document. `GET /api/operations/:id`
returns a log tail, not a per-document result set (`GAP-06`).

---

## 5. Screen catalogue

Each screen states purpose, primary action, required states, and cross-links.
The state vocabulary is fixed for the whole product:

`empty` · `loading` (skeleton with reserved geometry) · `refreshing` (previous
valid data stays visible) · `ready` · `degraded` (partial data usable, banner
names the subsystem) · `error` (human summary + collapsed technical detail +
retry) · `stale` (superseded by a newer request; never committed) ·
`unavailable-in-this-edition`.

`unavailable-in-this-edition` applies at **control granularity only**: a field,
option or action inside a screen this edition does serve renders **disabled with
a one-line reason** — never silently absent, because a missing control is
indistinguishable from a bug. Screen-level unavailability is a different thing
and is handled differently: a screen whose backing routes this edition never
registers is **omitted from navigation**, with the edition disclosed globally.
See §6 for the rule and its rationale.

### 5.1 Overview

- **Purpose:** answer "is this instance working, and what is running?" in one
  screen; be a router to the cause of any problem.
- **Data:** `GET /api/health`, `GET /api/generation/status`,
  `GET /api/capabilities`, `GET /api/collections`, `GET /api/operations`.
- **Primary action:** navigate to the failing subsystem or the running
  operation.
- **Content:** status strip (storage, generation, edition); collections summary;
  active + recent operations (bounded list); nothing else. No charts.
- **States:** all of them; `degraded` is the common one (Qdrant up, generation
  provider not ready — a completely normal Lite state before a key is set).
- **Cross-links:** Settings category, Operation detail, Collection.

### 5.2 Collections list

- **Purpose:** the collection directory.
- **Data:** `GET /api/collections`.
- **Primary action:** open a collection. Secondary: start an indexing job.
- **Note:** there is **no create-collection endpoint** — a collection comes into
  existence when an indexing job writes it. The primary action is therefore
  "Index a folder", and the empty state says exactly that rather than offering a
  "New collection" button that would have nothing to call (`GAP-04`).
- **States:** `empty` (no collections yet → index CTA), `loading`, `degraded`
  (Qdrant unreachable → the list is unavailable, not blank), `error`.

### 5.3 Collection home

- **Purpose:** identity and health of one collection.
- **Data:** `GET /api/collections/:name`.
- **Content:** compact header (name, points, embedding profile/provider,
  dimensions, schema state) + expandable details. Embedding provider is shown as
  **read-only collection metadata**; it is baked into the vectors and cannot be
  switched from here (`admin-ui-ux-and-ask-plan.md` §4A.5, unchanged).
- **Cross-links:** Documents, Structure, Search, Index, Settings.

### 5.4 Documents

- **Purpose:** what is in this collection, by source file.
- **Data:** `GET /api/collections/:name/documents` (+ `GET …/chunks` in the
  inspector).
- **Layout:** split pane — document list left, chunk inspector right.
- **Rendering:** `sourceFile` is untrusted text. Long paths use middle-ellipsis
  with the full value available via copy and via the inspector, never
  tooltip-only.
- **Pagination:** driven by whatever the endpoint's real bounds are
  (`GAP-03`). No virtualization until profiling shows a DOM bottleneck.

### 5.5 Structure

- **Purpose:** navigate the skeleton as a document outline.
- **Data:** `GET …/skeleton`, `…/skeleton/children`, `…/skeleton/node`,
  `…/skeleton/anchor`, `…/node`.
- **Known limitation:** "missing parent" and "empty parent" are currently
  indistinguishable in the children response
  (`memory: Admin API skeleton/children gap`). The tree must render an explicit
  "no children reported" state rather than silently showing a leaf.
- **Cross-links:** Section reader, Search scoped to the node.

### 5.6 File / Section reader

- **Purpose:** read indexed content as a document; verify what was actually
  stored.
- **Data:** `GET …/assembly` (stitched), `GET …/chunks` (chunked).
- **Controls:** stitched/chunked toggle, rendered/raw toggle per structural
  entity, chunk-boundary gutter marks, anchored scroll to a matched chunk.
- **This surface already exists** and is the strongest part of the current UI.
  v2 re-hosts it inside the workbench; it does not redesign it.

### 5.7 Search

- **Purpose:** the operator's retrieval-testing surface.
- **Data:** `POST /api/search` → `{ collection, query, searchMode, top, window,
  windowFormat, results }`.
- **Layout:** query bar + parameters (top, window, window format, source-file
  filter, tags) → ranked result list → inspector.
- **State:** the existing `?q=` permalink contract is preserved verbatim.
- **Ownership:** every submitted query takes a generation number; a late
  response from an earlier query is discarded, not rendered (§8.7).
- **Cross-links:** result → anchored File/Section reader; result → "Ask about
  this collection" (pre-fills the Ask collection, never the question).

### 5.8 Index

- **Purpose:** start an indexing/reindexing job.
- **Data:** `POST /api/system/pick-folder`, `POST /api/jobs/index`,
  `GET /api/system/ollama-status` (Full only).
- **Fields:** collection name, path, `kind: index|reindex`, and the four options
  the server accepts (`onnxEmbed`, `llmSummaries`, `pruneStale`, `tagGen`) —
  options the current edition disallows render as disabled with the reason, and
  the server rejects them anyway with `not_available_in_lite`
  (`api/jobs.js:95-103`).
- **Preflight (UX only):** non-empty name; no `/` or `\` in the name (the server
  enforces the same, `api/jobs.js:40`); path is not URL-shaped (server enforces,
  `api/jobs.js:57`). Allowed-roots scope is **not** pre-checked in the browser —
  the server owns it and returns an actionable error.
- **On success (202):** route to `#/operations/:id`.

### 5.9 Operations list and detail

- **Purpose:** the answer to "why is this stuck / why did it fail?"
- **Data:** `GET /api/operations`, `GET /api/operations/:id`.
- **Detail content:** kind (`index`/`reindex`/`repair`), collection, state,
  timestamps, progress (percent when known, phase, current file, processed/total
  — indeterminate otherwise), first error line, log tail (last 200 lines,
  redacted at capture).
- **Actions:** Cancel, only when `cancellable` is true. **No retry button** —
  there is no retry endpoint; a "Run again" affordance, if offered, must be
  labelled as starting a *new* job with the same parameters (`GAP-06`).
- **Polling:** one shared store polls `GET /api/operations`; the detail view
  subscribes and additionally fetches `:id` for the log. Existing cadence
  (1500 ms active / 5000 ms idle) is kept until measured otherwise.
- **Promotion from modal to route:** the operation modal remains for
  in-context monitoring, but `#/operations/:id` is the addressable, reloadable
  surface. Both read the same store.

### 5.10 Ask

Covered in full in §9. Summary: collection selector, conversation viewport,
composer, source/evidence inspector. **Ephemeral and in-memory by decision**
(§9.1).

### 5.11 Settings (global)

- **Purpose:** see and change runtime configuration, with honest provenance.
- **Data:** `GET /api/settings` → `{ categories, settings }`;
  `PATCH /api/settings` → `{ changes: { KEY: value|null } }`.
- **Categories are server-owned** (`status`, `storage`, `ai`, `embeddings`,
  `indexing`, `retrieval`, `system` — `src/core/settings/definitions.js:1015`).
  The UI never hardcodes them.
- **Per-field UI is derived from the entry**, not from a client-side table:
  `type`, `writable`, `secret`, `min`/`max`/`options`, `visibleWhen`/`hiddenWhen`,
  `derivedWhen`, `catalogDerived`, `pathPicker`, `advanced`, `appliesAt`,
  `requiresReindex`, `requiresBackfill`, `readOnlyReason`.
- **Secrets:** a `secret` entry carries only `configured: boolean`. The UI shows
  `Configured` / `Not configured` and offers "Replace" and "Clear". It never
  renders a *stored* value (it never has one), never echoes a submitted value
  back into the field, and never round-trips a value; a replacement being typed
  is transient only (§11.2).
- **Provenance:** `configuredSource` vs `activeSource` are shown separately, and
  `pendingRestart: true` renders as an explicit "takes effect at next restart"
  marker. A single "source" label would be a lie for a `next_restart` field
  right after a save (`service.js:131-140`).
- **Destination fields** (`QDRANT_URL`, `OLLAMA_URL`) require a direct loopback
  connection; the UI must render the `loopback_required` 403 as a specific,
  actionable message rather than a generic failure (`api/settings.js:56`).
- **Error codes to render distinctly:** `unknown_key`, `not_writable`,
  `invalid_value`, `setting_overridden` (409), `not_available_in_lite`.

### 5.12 Collection settings / danger zone

- **Repair:** `POST /api/collections/:name/sync-schema` — synchronous 200 with
  `{ id, repaired, warnings }`; the returned `id` opens the operation surface
  deterministically rather than guessing "newest operation".
- **Delete:** typed-collection-name confirmation, consequence stated
  ("removes all indexed content for `<name>`; cannot be undone"), then
  `DELETE /api/collections/:name`. No optimistic update: the row disappears only
  after the authoritative 200.

---

## 6. Full/Lite composition

- One code base, one bundle per edition. Vite already builds both
  (`admin:build`, `admin:build:lite`).
- Composition is driven by a **capability object resolved once at boot**, not by
  `if (edition === 'lite')` scattered through views.
- **Today the only capability data available over HTTP is storage capability**
  (`GET /api/capabilities` → `{ backend, capabilities: { namedVectors,
  sparseVectors, hybridSearch, payloadIndexes, aliases, snapshots,
  collectionExists } }`). Edition and feature availability are **not** exposed
  (`GAP-01`).
- **Interim rule until `GAP-01` closes:** the boot capability object is
  assembled from (a) `GET /api/capabilities`, (b) build-time edition constant
  from the Vite entry, and (c) probe-endpoint presence checked lazily on the
  screens that need it (a 404 from a Full-only route is a legitimate "not in
  this edition" signal). This is stated as an interim mechanism, not a design
  preference — it is exactly the "hard-coded edition checks" risk the synthesis
  flagged, contained to one module (`shared/capabilities.js`) so closing
  `GAP-01` is a one-file change.
- **Disabled vs omitted — the rule, stated once.** The distinction is *what is
  unavailable*, not *how important it is*:
  - **A control, field or option inside a screen this edition serves** →
    rendered **disabled with a one-line reason**. Example: the `onnxEmbed`,
    `llmSummaries` and `tagGen` checkboxes on Lite's indexing form (§5.8) — the
    form exists, three of its options do not. Hiding them would leave the
    operator wondering whether the option moved, was renamed, or broke.
  - **A whole screen or navigation entry whose backing routes this edition never
    registers** → **omitted from navigation**. Example: the ONNX runtime and
    Ollama panels in Lite — `createLiteApp()` never calls
    `registerOnnxRoutes`/`registerOllamaStatusRoutes`/`registerOllamaModelsRoutes`
    at all (`src/admin/composition/lite.js:110-120`), so there is no endpoint
    behind them and a disabled shell would be an empty promise.
  - Edition itself is disclosed globally in the status strip and in
    Settings → Runtime, so an omitted screen is always explicable — the operator
    can see *which* edition they are running without hunting for a missing
    menu item.
  - This is the control-vs-screen distinction the state vocabulary in §5 refers
    to; the two sections state one rule, not two.
- Capability is **never** treated as authorization. The server enforces
  independently (`api/jobs.js:95`, `service.lite.js`).

---

## 7. Visual direction

**Direction: operator console shell + split-pane workbench.** Stable left rail;
dense toolbar; table/list first; a persistent right inspector on Documents,
Search, Operations and Ask. Rejected alternatives: dashboard-first widget grids,
chat-first navigation, and command-palette-only navigation (the palette is
`FUT-04`, additive, never the only way to reach a screen).

> **This section is not a substitute for screenshot exploration.** It was
> written from code and from textual reports; not one reference product was
> visually inspected. Before implementation, the density, table and inspector
> specifications below must be checked against real screenshots of at least
> Qdrant Web UI and Supabase Studio, and against the current Semidex UI at
> real collection sizes. Numeric values here are starting points to be
> reviewed, not measured results.

### 7.1 Design tokens

The current stylesheet already defines a dark, amber-accented, IBM Plex system
(`src/shared/admin/ui-src/app.css:6-24`). v2 keeps that identity and formalizes
it into two layers.

**Layer 1 — primitives** (values): the existing `--bg`, `--bg-raise`,
`--bg-inset`, `--line`, `--line-soft`, `--ink`, `--ink-dim`, `--ink-faint`,
`--amber`, `--amber-dim`, `--ok`, `--warn`, `--fail`, `--mono`, `--sans`, plus
new spacing/radius/elevation steps.

**Layer 2 — semantic aliases** (roles): `--surface-page`, `--surface-panel`,
`--surface-sunken`, `--border-strong`, `--border-subtle`, `--text-primary`,
`--text-secondary`, `--text-muted`, `--accent`, `--accent-muted`,
`--status-ok`, `--status-warn`, `--status-fail`, `--status-running`,
`--focus-ring`.

Components consume **only layer 2**. That is what makes a second theme a token
file rather than a rewrite.

### 7.2 Light/dark strategy

The UI is **dark-only today**; there is no `prefers-color-scheme` handling in
`app.css`. This plan does **not** treat a light theme as free.

- Slice 1 formalizes the two token layers and ships dark only.
- A light theme is added as a second **token set** (not a filter/inversion),
  with independent contrast verification, once the semantic layer is stable and
  the component inventory has stopped moving.
- `prefers-color-scheme` is respected once both sets exist; an explicit override
  is stored in a UI-preference key (never a cookie, never anything sensitive).

### 7.3 Density and typography

- Table rows: two densities, comfortable and compact; compact is the default for
  Operations/Documents/Search results. Starting values ~36 px / ~28 px, to be
  reviewed against real content (long Cyrillic paths wrap differently from the
  ASCII examples the reports assumed).
- `--sans` for prose and labels; `--mono` for paths, ids, hashes, log lines,
  raw content, numeric columns (tabular figures).
- Text must remain resizable and reflow at 320 CSS px; fixed-height rows that
  clip enlarged text are not acceptable.

### 7.4 Color and status

- Neutral base; a single accent (`--amber`) for selection and focus; semantic
  colors used only for state.
- **Status is never colour alone.** Every status is icon + text + colour, with
  an accessible name. This is already a project rule
  (`admin-ui-ux-and-ask-plan.md` F1) and becomes a DoD checkbox.

### 7.5 Tables

- Native `<table>` with real `<th scope>`. ARIA `grid` only if a surface
  genuinely acquires spreadsheet-like cell interaction — none currently does.
- Sticky header; sortable only on columns the backend can actually sort by;
  row actions revealed on hover **and** reachable by keyboard.
- Long values: middle-ellipsis + full value in the inspector and via copy. Never
  tooltip-only.

### 7.6 Forms

- Persistent top-aligned labels; placeholders are examples, never labels.
- Errors inline, below the field, associated via `aria-describedby`; advanced
  options collapsible, but an error inside a collapsed group force-expands it.
- Secret fields: state chip (`Configured` / `Not configured`) + Replace/Clear.
  No stored value is ever shown, no masked round-trip, no `autocomplete`.

### 7.7 Dialogs, drawers and inspectors

- **Modal** only for destructive confirmation and for a genuinely blocking
  choice. Focus enters the dialog, is trapped, and returns to the trigger.
- **Inspector** (persistent right pane) for source/chunk/result/operation
  detail. It is not a dialog: it does not trap focus and does not block.
- **Drawer** is the narrow-viewport form of the inspector.
- Operation monitoring keeps its non-blocking modal + topbar chip behaviour, now
  backed by an addressable route.

### 7.8 Responsive behaviour

- ≥1280 px: rail + content + inspector.
- 1024–1280 px: rail collapses to icons; inspector stays.
- 768–1024 px: inspector becomes a drawer.
- <768 px: rail becomes a drawer; tables keep primary columns and move the rest
  into row detail. No bottom tab bar — the hierarchy is deeper than a consumer
  app's.

### 7.9 Code, paths and errors

- Monospace blocks with copy buttons; wrapping where meaning survives,
  horizontal scroll in `<pre>` where it does not.
- Errors always have two levels: a one-sentence human summary and a collapsed
  **Technical details** disclosure. Neither level ever contains a stack trace —
  the server redacts at capture (`sanitiseErrorMessage`) and the UI adds nothing.

### 7.10 Motion

Functional transitions only. `prefers-reduced-motion` removes non-essential
transitions and any streaming cursor animation, leaving a static state
indicator. Already partially implemented (`app.css:481,1066`).

---

## 8. Frontend architecture

### 8.1 Module boundaries

```text
src/shared/admin/ui-src/
  app/            shell bootstrap, router wiring, global status
  shared/
    api/          client, error model, contract validators
    capabilities/ boot capability object (see §6)
    ui/           table, dialog, drawer, inspector, form-field,
                  status-badge, code-block, live-region, empty/error states
    lifecycle/    view controller base: mount/dispose, signal, generation
    format/       paths, bytes, durations, timestamps
  features/
    overview/ collections/ documents/ structure/ reader/
    search/ index/ operations/ ask/ settings/
```

Rules:

- A feature never queries or writes another feature's DOM. Navigation between
  features goes through the router; data goes through the API client.
- A feature exports a **view controller**: `mount(host, params) → { dispose() }`.
- `shared/ui` components are DOM-producing functions, not classes — matching the
  existing module style (there are no UI classes anywhere in `ui-src/` today).
- Existing modules migrate feature by feature. `structural-renderer.js`,
  `operation-store.js`, `operation-render.js`, `dom.js`, `format.js`,
  `icons.js`, `toasts.js` move essentially unchanged.

### 8.2 API client and contract validation

One client. Every request goes through it; no view calls `fetch` directly (this
is already true and must stay true).

Responsibilities, in order: URL construction → method/headers (including the
existing `X-Semidex-Request: admin` on non-safe requests) → per-request timeout
composed with the caller's `AbortSignal` → dispatch → status/`Content-Type`
handling → JSON parse → **contract validation** → normalized error.

**Normalized error type**

```text
ApiError {
  kind: 'validation'|'not_found'|'conflict'|'forbidden'|'unavailable'
      | 'rate_limited'|'server'|'network'|'timeout'|'aborted'|'contract',
  status: number|null,
  code: string|null,      // the server's machine-readable code, verbatim
  message: string,        // already-redacted server text, or a client-side string
  retryAfterSeconds: number|null,
}
```

`code` is passed through verbatim because the server's codes are the contract:
`setting_overridden`, `not_available_in_lite`, `loopback_required`,
`ui_not_built`, `JOB_ALREADY_RUNNING`→`conflict`, and the Ask/Search versioned
code sets.

**Validation mechanism.** Every response is validated at the boundary; a
malformed response produces `kind: 'contract'` and a controlled error state,
never a crash and never a partly-rendered view. The mechanism **must not
construct functions at runtime** — the shipped CSP is `script-src 'self'` with
no `unsafe-eval` (`request-security.js:535-546`), so a runtime schema compiler
is out. Two acceptable options: hand-written validators colocated with each
feature's contract module, or build-time-compiled validators. Decision deferred
to slice 1 (§16, `D-2`); the constraint is not.

**Validators are derived from the server's own projection modules where they
exist** (`src/core/ask-api/v2/contract.js`, `src/core/search-api/v1/contract.js`)
so a contract change is a two-file change, not a silent drift.

### 8.3 State ownership

| State | Owner | Notes |
|---|---|---|
| Route (collection, file/node, operation id, settings category, search params) | URL hash | The one shareable/back-restorable plane |
| Boot capability + edition | App bootstrap, read-only after boot | Server-authoritative where possible (§6) |
| Global health/generation status | Shell-owned store, polled | One poller, many subscribers |
| Active/recent operations | Existing shared operation store | Already correct; keep |
| Per-feature data (list, detail, inspector selection) | Feature controller | Dies with the view |
| Form drafts, dialog open/closed, expanded rows | Local view state | Never in the URL |
| Ask conversation (messages, summary, run state) | Ask feature controller, in memory | §9.1 |
| Toasts | Shell | Ephemeral |
| Theme/density preference | Small UI-preference store | Non-sensitive only |
| A stored secret's value | **Never client-side** | The server returns only `configured: boolean` for secret entries (`service.js:183-188`); the browser never receives an existing value |
| A secret the operator is entering | The one input element, transiently | This is the entire client-side lifetime of a secret: keystroke → `PATCH` body → cleared. Never persisted, logged, echoed back, or placed in the URL; field and any holding variable cleared on success, failure, cancel and `dispose()`. See §11.2 |

The current single shared mutable (`state.js`'s `expandedCollection`) becomes
sidebar-owned state with an explicit accessor, not a module global read by three
features.

### 8.4 Lifecycle

```text
mount(host, params)
  ├ create view AbortController
  ├ create generation counter
  ├ register listeners with { signal }
  ├ start requests with the view signal (composed with per-request timeout)
  └ return { dispose }

dispose()
  ├ controller.abort()          → listeners removed, requests aborted, streams cancelled
  ├ clear timers/intervals/observers
  ├ release the host subtree
  └ mark generation invalid (no late commit can pass the ownership check)
```

The router calls `dispose()` on the outgoing view **before** mounting the next
one. A view that leaves anything behind is a merge blocker (§12, leak soak).

### 8.5 Rendering boundaries

- One owner per DOM subtree. Re-render the smallest region that changed.
- Streaming Ask updates only the streaming node; it never re-renders the
  conversation.
- Global status updates never rebuild navigation; table filtering never remounts
  the shell.
- All templates come from `<template>` elements filled with `textContent` /
  `setAttribute` (existing `cloneTemplate` discipline, `dom.js:18`). String
  concatenation into `innerHTML` is not introduced anywhere new.

### 8.6 Event architecture

- **Delegation at a stable owning view/component root** — the table body, the
  result list, the conversation viewport. Not `document`; not one listener per
  row.
- **Direct listeners** for singleton controls, form fields, and anything with
  its own lifecycle (the Ask composer, the sidebar resize handle).
- All listeners registered with `{ signal }` from the view controller.
- **No global event bus by default.** Cross-feature communication happens
  through the router (navigation), through shared stores (operations, status),
  or through a `CustomEvent` dispatched on a specific owning element. If a
  genuinely cross-cutting event ever appears, it needs a named owner, an
  immutable minimal payload, additive-only evolution, and a documented contract
  — and it still is not the default.
- `stopPropagation()` only where a component's interaction boundary genuinely
  ends; never as a fix for an unknown listener conflict.

### 8.7 Cancellation and stale responses

Two mechanisms, both required:

1. **Abort** — `AbortController` per view, composed with a per-request timeout,
   so navigating away or issuing a new request cancels the old one.
2. **Ownership/generation check** — every commit path re-reads the owning
   counter before touching the DOM:

```text
gen = ++view.generation          // on submit
… await request …
if (gen !== view.generation) return   // superseded: discard, do not render
```

Abort alone is insufficient: a response can resolve before the abort lands, and
a synchronous follow-up can already be in flight. This applies to search
submissions, collection navigation, settings saves, and Ask runs alike.

**Optimistic updates** are used only for cheap, trivially reversible view state.
Never for delete, settings writes, job start, or anything with an authoritative
server result.

### 8.8 Large lists

Order of attack, strictly: (1) use the endpoint's real bounds and add
server-side paging/filters where they exist; (2) measure with real collections;
(3) virtualize only the specific surface where profiling shows a DOM bottleneck,
and only with keyboard/screen-reader behaviour preserved. A paginated native
table is the preferred outcome.

---

## 9. Ask v2: run states and bounded streaming

### 9.1 The initial Ask experience is ephemeral — an explicit choice

**Decision.** The first Ask UI keeps the conversation **in memory, in the view
controller, for the lifetime of the mounted view.** No persistence, no
conversation list, no rename/delete, no cross-session history, no server-owned
conversation id.

**What the server contract settles, and what it does not.** Semidex is stateless
between HTTP requests: `conversation` is a client-supplied block the server
validates, budgets and echoes, and `conversation.id` is a correlation identifier
the *client* invents (`src/core/ask-api/v2/request.js:62`;
`docs/design/ask-v2-conversational-context.md` §1 ownership table). That settles
one half — **server-owned** conversations, server-issued ids and server-side
history are genuinely unavailable, and no UI can conjure them. It does not
settle the other half: the browser could technically persist conversations
itself in `localStorage` or IndexedDB. That option exists, and it is declined.

**Why it is declined:**

1. **It would put Semidex on the wrong side of its own ownership split.** The
   v2 design assigns conversation creation, history and persistence to the
   *integrating application* — the admin UI is a reference client of the Ask
   API, not the product's chat-storage layer. A browser-side store would make
   the dashboard a second, divergent implementation of the one role the contract
   explicitly gives away.
2. **Conversation text is the wrong thing to leave on disk.** Prompts and
   answers over indexed private content are exactly the class of data kept out
   of the URL for the same reason (§4.2); browser storage on a shared or
   long-lived operator machine is no better, and it is readable by anything that
   achieves script execution in this origin.
3. **It creates durable state with no lifecycle.** Persistence without a
   retention policy, an erasure path, a size bound, an export format, and an
   answer to "which collection and which edition was this against" is not a
   feature — it is a liability that ships silently and is discovered later.
4. **It is a product decision, not a UI convenience.** If conversation history
   is wanted, it should be designed once, with the questions above answered, and
   most likely on the server where the retention story can actually be enforced
   (`FUT-01`).

So: ephemeral is a deliberate product, security and architecture choice that
sits naturally on top of the stateless server contract — not a limitation the
protocol imposed on the UI.

**Consequences the UI must state honestly to the operator:**

- Navigating away from Ask ends the conversation. The composer area says so
  once, plainly, rather than pretending otherwise.
- The client generates `conversation.id` (a UUID) per conversation and sends it
  so the server can echo it back on `done`.
- The client owns `summary` and `recentMessages`. When `done.conversation`
  reports `summaryChanged: true` and carries `updatedSummary`, the client
  replaces its held summary and drops `compactedMessageCount` messages from the
  front of its own history — the same commit-both-together rule the design doc
  specifies for integrators.
- The client enforces the protocol ceilings *before* sending, and surfaces them
  as UX limits, not as server errors: 200 recent messages, 50 000 chars per
  message, 8 000-char summary, 256-char id (`request.js:41-44`).

Persistence is `FUT-01`. If it is ever approved it is a backend product decision
first, not a UI feature.

### 9.2 Screen composition

```text
┌ collection selector · run state · Stop ────────────────────────────┐
│ conversation viewport                    │ source / evidence       │
│   … prior turns (in memory) …            │  sources[n] cards       │
│   current run                            │  selected citation      │
│     sources arrived                      │  → open in reader       │
│     answer streaming                     │                         │
│     citations [1] [2]                    │                         │
│ composer (Enter sends, Shift+Enter newline)                        │
└────────────────────────────────────────────────────────────────────┘
```

Two-phase render: `sources` arrives before generation starts and is immediately
useful on its own. The answer streams after.

### 9.3 Run state machine (mapped to the real protocol)

```text
idle
 └► submitting            POST /api/v2/ask sent, response headers not yet seen
     ├► pre-stream-error  non-SSE JSON body → { error: { code, message, retryable } }
     └► streaming         Content-Type is text/event-stream
         ├► complete      `done` with refused:false
         ├► refused       `done` with refused:true + refusalReason
         ├► stream-error  `error` event → terminal, typed
         ├► partial       transport ended without `done`
         ├► cancelled     operator pressed Stop
         └► timeout       no first event / stall exceeded budget → treated as partial
```

- `refused` is a **semantic result**, not a failure. Render the refusal reason
  and the evidence count; keep the sources visible.
- `partial` keeps whatever text arrived, labelled as incomplete. It is never
  silently promoted to a successful answer.
- **No automatic retry, ever.** Ask is not idempotent: a second attempt re-runs
  retrieval and re-generates tokens, spending budget again and risking a
  duplicated answer. Retry is an explicit operator action that starts a *new*
  run. This is the same invariant the SDK enforces
  (`packages/lite/lite-src/client/retry.js` header).
- **No reconnect, no resume, no `Last-Event-ID`.** The protocol has no event
  ids. The server's `: keep-alive` comments (`src/core/http/sse.js:7,19`) are
  transport liveness the client must *tolerate and ignore*; they are not a
  reconnect facility.

### 9.4 Pre-stream vs in-stream failures

The discriminator is `Content-Type`, exactly as the SDK does
(`client/index.js:517`): a non-`text/event-stream` response is a JSON error body
`{ error: { apiVersion, code, message, retryable } }`; anything after the stream
opens is an SSE `error` event with the same payload shape.

Codes the Ask screen must render distinctly (`ask-api/v2/contract.js:20-45`):

| Code | HTTP | UI treatment |
|---|---|---|
| `bad_request` | 400 | Field-level; should be unreachable after preflight |
| `invalid_conversation` / `invalid_message_role` / `message_too_large` | 400 | Client-side bug or a ceiling breach; log and show a specific message |
| `not_found` | 404 | Collection missing → offer collection re-selection |
| `busy` | 429 | "Another generation is already running" — single-flight, not a rate limit. Offer to wait, never auto-retry |
| `rate_limited` (router stage 1.5) | 429 + `Retry-After` | Show the wait; do not auto-retry |
| `budget_exceeded` / `budget_limit_exceeded` | 429 + `Retry-After` | Spend ceiling; explain and show the window |
| `budget_unenforceable` | 503 | Not retryable — say so |
| `context_budget_exceeded` | 422 | The model's context cannot fit the request; suggest starting a new conversation (which is free — history is client-side) |
| `dependency_unavailable` | 503 | Link to Settings → AI providers |
| `embedding_unresolved` / `embedding_unsupported` | 503 / 501 | Collection-level problem; link to the collection |
| `generation_failed` / `internal_error` | — | Two-level error display |
| `stream_aborted` | — | Emitted when the operator cancelled; render as `cancelled`, not as an error |

`retryable` on the payload is server *advice*. The UI never turns it into an
automatic action.

### 9.5 Bounded stream decoding

The decoder must:

1. Read `response.body` incrementally with `TextDecoder('utf-8', { stream: true })`,
   flushing at end of stream.
2. Split frames only on a complete blank-line boundary, after CRLF→LF
   normalization.
3. Ignore comment lines (`:`) and unknown SSE fields (`id:`, `retry:`) without
   error — the server sends keep-alive comments continuously.
4. Treat a malformed `data:` payload as a **protocol error**, surfaced as a
   typed failure, never as model output and never as a silent drop.
5. Forward unknown *event names* and unknown fields on known events unchanged
   (forward compatibility), while validating the fields the UI actually reads.
6. Enforce hard ceilings on every accumulator — single line, assembled frame,
   undelivered buffer, and total accumulated answer — and abort with a typed
   error when one is exceeded.
7. Release the reader, timers and listeners on abort, completion and error
   alike.

**Bounds.** Where the protocol fixes a value, use it. Where it does not, the
following are **provisional engineering guardrails**, not measurements, and must
be revisited against real Ask payloads before they become CI gates:

| Bound | Value | Basis |
|---|---|---|
| Recent messages sent | 200 | **Protocol constant** (`request.js:42`) |
| Chars per message sent | 50 000 | **Protocol constant** (`request.js:41`) |
| Summary chars held | 8 000 | **Protocol constant** (`request.js:43`) |
| Single SSE line | ~64 KiB | Provisional |
| Assembled SSE frame | ~256 KiB | Provisional |
| Undelivered decode buffer | ~1 MiB | Provisional |
| Total streamed answer | — | **Unknown.** Depends on the backend output cap; see `GAP-09` |
| Time to first event | — | **Unknown.** Must be measured on the slowest supported local model before a number is set |
| Inter-event stall | — | Same. The server's 15 s keep-alive is a floor for any such number, not the number itself |
| Visual commit cadence | batched, ~10/s target | Provisional; profile before fixing |

### 9.6 Reusing the SDK rather than writing a second protocol implementation

`packages/lite/lite-src/client/sse.js` is a correct, tested streaming SSE parser
using only `ReadableStream`, `TextDecoder` and `AbortSignal` — all browser
primitives. It already handles arbitrary chunk boundaries, CRLF/LF, comment and
unknown-field lines, the trailing-frame flush, and the malformed-payload case
(`__parse_error__`). Re-implementing it for the browser would create a second
divergent parser for one protocol.

**Constraint:** `createSemidexClient` itself is *not* usable from the admin
browser — it requires an `apiKey` and throws without one
(`client/index.js:108-122`), and the admin browser must never hold one. So the
reuse target is the **parser and the error projection**, not the client.

**Options, to be decided in slice "Ask" (§16, `D-3`):**

- **(a)** Extract `sse.js` + `errors.js` into a shared, dependency-free module
  consumed by both `packages/lite/lite-src/client/` and the admin UI bundle.
  Requires confirming it does not violate the Lite package's closure rules
  (`VER-07`, `tests/unit/lite/build-closure-validator.test.js`).
- **(b)** Keep them where they are and import them into the Vite admin bundle by
  path.
- **(c)** Last resort: a browser copy, with a test that asserts behavioural
  equivalence against the same corpus.

(a) is preferred; (c) is acceptable only with the shared-corpus test, because an
untested copy is exactly the divergence this rule exists to prevent.

### 9.7 Ask accessibility

- The streaming text node is **not** an `aria-live` region. Announcing every
  token makes the output unusable.
- A separate `role="status"` region announces meaningful transitions only:
  "Retrieved N sources", "Generating", "Answer complete, N citations",
  "Answer refused: <reason>", "Answer incomplete", "Cancelled".
- Errors go to `role="alert"`.
- **Focus is never moved on completion.** The operator may be reading the
  sources. Completion is announced, not forced.
- With `prefers-reduced-motion`, no cursor animation; text appears in batches.
- The full answer is reachable and re-readable as ordinary text after
  completion.

---

## 10. Validation and trust boundaries

### 10.1 Validation matrix

Frontend validation is preflight and ergonomics. The backend is authoritative
for everything in the right-hand columns.

| Input / operation | Frontend (UX only) | Backend (authoritative) | Policy layer |
|---|---|---|---|
| Empty / whitespace field | Block submit, inline message | Re-reject (`badRequest`) | — |
| Collection name | Non-empty; no `/` or `\`; length hint | Same rules, authoritative (`api/jobs.js:40-49`) | — |
| Indexing path | Non-empty; not URL-shaped | URL-shape rejection (`api/jobs.js:57`); realpath canonicalization; allowed-roots containment (`allowed-roots.js`, `api/jobs.js:264`) | `INDEX_ALLOWED_ROOTS`; audit event on denial |
| Indexing options | Disable options this edition disallows | `not_available_in_lite` (`api/jobs.js:95`); removed options rejected loudly (`api/jobs.js:120`) | Job policy per composition root |
| Qdrant / Ollama URL | `new URL()` parse + `http(s)` scheme hint | `evaluateEgressUrl()` — scheme, userinfo, cloud-metadata literals (`network-egress-policy.js`) | Direct-loopback requirement for these two keys (`api/settings.js:52`) |
| Numeric settings | `min`/`max`/`step` from the settings entry | `invalid_value` from `SettingsService` | Writable/override rules |
| Incompatible settings | Server-driven conditional visibility via the entry's own `visibleWhen`/`hiddenWhen`/`derivedWhen` — a field irrelevant to the current configuration. Distinct from edition gating (§6), which disables rather than hides | Reject the combination | Edition/capability policy (`service.lite.js`) |
| Overridden setting | Show `configuredSource` vs `activeSource` | `setting_overridden` 409 | Env precedence |
| Ask question size | Char counter against protocol ceilings | Protocol parse limits (`ask-api/v2/request.js`) | Token budget + rate limit |
| Ask conversation shape | Enforce role/count/size before sending | `invalid_conversation` / `invalid_message_role` / `message_too_large` | Context budget |
| Search parameters | Range hints | `parseSearchRequest()` bounds | — |
| Collection deletion | Typed-name confirmation | Existence check then delete (`api/collections.js:78`) | Audit event |
| Collection authorization | **Not a frontend concern** | Stage 2 object-level check for integration callers (`core/http/authorize.js`) | Key scopes |
| Rate limiting / spend | Render `Retry-After` honestly | Router stage 1.5 + budget ledger | Per-key policy |
| Response shape | Contract-validate every response; malformed → controlled error | Server should satisfy its own contract | — |

### 10.2 Trust boundaries

| Zone | What is trusted | What the UI must assume | Server controls in force today |
|---|---|---|---|
| **Loopback (default)** | Nothing more than any other origin. The operator's browser may simultaneously have a hostile page open | `127.0.0.1` is not a security boundary; DNS rebinding can point a public origin at this listener | Host allow-list incl. duplicate-Host rejection and real-listening-port allowance (`request-security.js:265-336`); cross-site rejection on non-safe methods (`:362`); JSON `Content-Type` enforcement (`:471`); security headers on API *and* static (`:556`) |
| **LAN / reverse proxy** (`ADMIN_ALLOW_REMOTE=1`) | The operator's explicit configuration | Any network peer may reach the listener; there is **no admin authentication** | `ADMIN_ALLOWED_HOSTS` becomes mandatory and *replaces* the loopback default (`:172-189`); `ADMIN_ALLOWED_ORIGINS` strictly parsed; `X-Forwarded-*` ignored unless `trustProxy`; destination settings still require direct loopback |
| **Admin routes** | Nothing — they are credential-free by design | The UI's custom header is not authentication; hidden or disabled UI is not authorization | Never see an integration principal (`router.js:198`). JSON bodies capped at 1 MB (`http.js:87`) and ingestion bounded by `requestTimeout`/`headersTimeout`/`maxHeadersCount` (`register-neutral-routes.js:295-298`); **no per-caller rate limit** (`GAP-10`); mutations emit audit events |
| **Integration routes** | A bearer key held **server-side by an integrating application** | The admin browser is never an integration client and never sends `Authorization` | Hashed key store, collapsed 401, 503 when unconfigured; `collections`/`operations` scopes; stage-1.5 rate limit; per-request and per-key token budgets |

**The bridge is the server we already have.** The browser calls same-origin
admin routes; the admin process holds Qdrant and provider credentials and never
returns them. No separate BFF process, no cookie session, no OAuth, and no CSRF
token set is introduced — there is no cookie or ambient credential for a CSRF
token to protect, and the Origin/Fetch-Metadata checks already reject
cross-site state-changing requests. If admin authentication is ever added
(`GAP-11`), the CSRF question is re-opened *at that time*, as part of that
design.

---

## 11. Security, safety and performance

### 11.1 Safe content rendering

- **Default is text.** `textContent` for filenames, paths, section titles, chunk
  text, log lines, error messages, source snippets and model answers.
- **Raw HTML is off everywhere.** No `innerHTML` with interpolated data; markup
  comes from `<template>` clones filled programmatically (`dom.js:18-32`).
- **Structural rendering stays on the existing curated path**: `remark-parse` +
  `remark-gfm` for GFM tables, `highlight.js` with a fixed 15-grammar registry
  and no dynamic grammar resolution (`structural-renderer.js:40-77`). Every
  structural render has a byte-exact raw fallback and a rendered/raw toggle, and
  any parse/highlight failure falls back to raw.
- **Model output.** Ask answers render as text plus a narrow, explicitly
  supported inline subset (citation markers `[n]`, code spans, fenced blocks
  through the same curated renderer). If richer Markdown is ever wanted, the
  supported node set is enumerated first and only then is a sanitizer
  considered — a sanitizer is a decision with a dependency cost, not a default
  (`ACC*-02`).
- **URLs.** Any URL derived from content or model output is parsed and allowed
  only for `http:`/`https:`; `javascript:`, `data:`, `file:` and anything else is
  rendered as inert text. External links get `rel="noopener noreferrer"`.
- **CSP is defence in depth, not the control.** Residual XSS risk is never zero;
  this is stated, not designed away.

### 11.2 Secrets

- **The browser never receives a *stored* secret value.** `GET /api/settings`
  returns `configured: boolean` for secret entries and nothing more
  (`service.js:183-188`). There is no read path back to a saved secret.
- **Entry is the one moment a secret exists client-side, and the guarantee is
  bounded accordingly.** While an operator types a replacement, the value
  necessarily lives in the input element and then in the `PATCH /api/settings`
  request body. Claiming a secret is "never in memory" would be false. What is
  guaranteed instead:
  - it is never written to `localStorage`, `sessionStorage`, IndexedDB, a
    cookie, the URL, or browser history;
  - it is never logged, never included in an error message, and never reachable
    from a copy button or a diagnostics export;
  - it is never echoed back into the field after submit — a successful save
    re-renders the field from the server's `configured` boolean, not from what
    was typed, so the value is not re-rendered even once;
  - the field and any variable holding it are cleared on success, on failure, on
    cancel, and in `dispose()`, so navigating away cannot leave it alive in a
    detached node.
- Error and diagnostic text is displayed as received — the server redacts at
  capture (`sanitiseErrorMessage`, applied at `router.js:366`,
  `ask-api/v2/route.js:25`, `api/health.js:17`, `api/generation.js:26`, and in
  job-log capture). The UI adds no second redaction layer and, critically, adds
  no new un-redacted channel (no `console.log` of response bodies in production
  builds).

### 11.3 Destructive actions

- Named resource, stated consequence, typed confirmation for collection
  deletion.
- No optimistic removal; the row disappears on the authoritative response.
- Focus moves to a meaningful surface after success, never into a detached node.
- The confirmation is UI-level by design — the API deliberately has no
  typed-confirmation body (`api/collections.js:73-77`) — which means the UI's
  confirmation is an ergonomics guard, not a security control, and is documented
  as such.

### 11.4 CSP target

The current header is already strict and is a **target to preserve, not to
introduce**:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none';
base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

Design constraints this imposes on v2:

- No runtime `Function`/`eval` — rules out runtime schema compilers and
  expression-compiling micro-frameworks (§8.2, and why Petite-Vue was rejected).
- No CDN, no external font, no external image, no remote source map in the
  shipped bundle.
- `style-src 'unsafe-inline'` exists only because the shipped templates carry
  static `style="…"` attributes. **A v2 goal is to remove those** and tighten to
  `style-src 'self'`; that is a real, verifiable deliverable, and the header must
  not be tightened until the templates are actually clean.
- No HSTS is added. The listener is plain HTTP by default; TLS termination and
  HSTS belong to an operator's proxy.

### 11.5 Accessibility

WCAG 2.2 AA is a per-screen gate (§12.3). Specific commitments:

- Every action reachable by keyboard; no `div` used as a button; native
  controls first; APG keyboard models for tabs, dialogs and any composite
  widget.
- Focus: visible ring (already `:focus-visible`-based), trapped in modals,
  returned to the trigger on close, moved to the main heading on route change,
  never obscured by sticky chrome.
- Status: `role="status"` for progress and streaming milestones, `role="alert"`
  for errors; announcements throttled to meaningful changes, never per token or
  per percent tick.
- Colour never the sole carrier of state.
- Contrast ≥ 4.5:1 text, ≥ 3:1 UI and focus indicator — including the existing
  `--ink-faint`, which must be re-verified against the v2 surfaces.
- Reflow at 320 CSS px and 200 % zoom with no loss of function; long
  paths/tokens wrap or scroll rather than clip.
- `prefers-reduced-motion` honoured, including in streaming.

### 11.6 Performance principles

Principles, not thresholds — every number below is provisional until measured on
real collections and reference Full/Lite hardware (`VER-06`).

- **No unbounded accumulator.** Streams, logs, event lists and result sets all
  have ceilings. This one is absolute, not provisional.
- **Batch streaming DOM commits**; never one commit per token.
- **Server bounds first, DOM optimization second.** Paging/filtering before
  virtualization; virtualization only where profiled.
- **Reserve geometry** so skeletons do not cause layout shift.
- **Lazy-load** heavy, optional surfaces (the structural renderer's grammar set,
  Ask); never lazy-load shell primitives, validation, or the error UI.
- **Leak budget is zero:** repeated mount/unmount cycles must not grow listener
  count, detached nodes or heap.

---

## 12. Test strategy and Definition of Done

### 12.1 Levels

| Level | Runner | What it covers |
|---|---|---|
| Unit | `node --test` | Route parsing/serialization, validators, formatters, error mapping, run-state reducer, bound arithmetic |
| Contract | `node --test` | Each endpoint's response shape: valid, missing field, wrong type, unknown optional field. Validators asserted against the server's own projection functions where they exist |
| View | `node --test` + `linkedom` | Each screen's `empty`/`loading`/`refreshing`/`degraded`/`error`/`partial` states; form error association; dialog focus behaviour. Follows the existing `tests/unit/admin/ui-*.test.js` + `ui-test-helpers.js` pattern (including the cached `vm.Script` requirement) |
| SSE | `node --test` | Report 01's corpus, adopted: split frames, split multibyte, CRLF/LF/CR, event with no trailing blank line, comment/keep-alive lines, unknown event name, unknown field on a known event, malformed JSON, oversized line/frame/buffer, disconnect at 0 bytes, disconnect mid-answer, abort racing completion, duplicate terminal event, old stream finishing after a new run, citation index out of range. Every case has one deterministic outcome: accepted, forward-compatibly ignored, or explicit protocol error |
| Security | `node --test` | XSS corpus applied separately to filename, path, section title, chunk text, log line, error message, source snippet and answer text; URL-scheme rejection; after every settings flow (success, failure and cancel alike) assert that no secret value appears in any rendered surface, storage, URL or log, and that the entry field and its holding state were cleared |
| Lifecycle / leak | `node --test` | Mount→dispose ×N: listener count, detached nodes and pending requests must not grow; one user action must produce exactly one request |
| Malformed backend | `node --test` | Invalid JSON, schema violations, truncated bodies → controlled error state, never an uncaught exception |
| Edition parity | `node --test` | One capability matrix exercised for Full and Lite, covering both halves of §6's rule: a control the edition disallows must render **disabled with a reason** *and* be rejected by the server if submitted anyway; a screen whose routes the edition never registers must be **absent from navigation** and its route must not resolve |
| Live acceptance | manual, documented | The existing per-phase live-acceptance convention (`docs/admin-ui-live-acceptance-*.md`) continues: real Qdrant, real provider, real slow model, provider down mid-stream |

Browser-driver E2E (Playwright), visual regression and automated axe scanning
are recommended by four of the five reports. The repository has **no browser
test infrastructure today** — introducing it is its own decision with its own
cost (`D-4`), not an assumed part of this plan. Until it exists, accessibility
is verified by view-level assertions plus a documented manual keyboard and
screen-reader pass per screen.

### 12.2 Regression protection for the old UI

Existing `tests/unit/admin/ui-*.test.js` must stay green for as long as the old
UI is reachable. A v2 slice that breaks one of them has broken a surface the
operator can still use.

### 12.3 Per-screen Definition of Done

A screen is done when **all** of the following hold:

1. Primary task is obvious; secondary and destructive actions are visually and
   spatially separated.
2. Route works for deep link, reload, back and forward; no sensitive value is in
   the URL.
3. All applicable states implemented: empty, loading, refreshing, ready,
   degraded, error, partial, unavailable-in-this-edition.
4. Every response is contract-validated; a malformed response yields a
   controlled error, not a crash.
5. Cancellation and ownership: navigating away aborts in flight work; a
   superseded response cannot commit. Proven by test.
6. `dispose()` leaves no listener, timer, observer, stream reader or pending
   request. Proven by the leak soak.
7. All untrusted values render as text or through the curated structural path;
   no new raw-HTML sink.
8. No stored secret value is received or rendered; a secret being entered is
   transient only and is cleared on success, failure, cancel and `dispose()` —
   never persisted, logged, echoed back, or placed in the URL (§11.2).
9. Full keyboard operation of the primary flow; focus behaviour for dialogs,
   navigation and errors verified.
10. Status announcements are meaningful units, not per-token or per-tick; colour
    is never the only signal.
11. Reflow at 320 px and 200 % zoom; long paths and long strings handled.
12. Edition behaviour is explicit in the capability matrix and enforced
    server-side.
13. Unit + contract + view tests present; SSE/security/leak tests where the
    screen touches those surfaces.
14. Any bound, timeout or threshold the screen introduces is either a protocol
    constant or explicitly labelled provisional with a measurement task.
15. The screen's backend assumptions are recorded — if it depends on anything in
    §14, that dependency is named in the PR.

---

## 13. Incremental implementation plan

**Rules for the whole plan.**

- **Vertical slices only.** Each slice ships one operator workflow end to end —
  route, data, states, safety, tests — rather than a horizontal layer.
- **The existing UI stays reachable and green until functional parity is
  proved,** per surface. v2 mounts alongside it; existing routes keep working;
  an old surface is deleted only when its v2 replacement passes that surface's
  DoD and the corresponding live-acceptance pass.
- **No calendar estimates.** There is no repository-based evidence for
  durations; sequencing is the commitment, timing is not.
- **Security foundations are inside slice 1**, not a final phase.

| Slice | Workflow delivered | Contents | Exit gate |
|---|---|---|---|
| **S1 — Shell + status** | W1 | Two-layer tokens; view-controller lifecycle (`mount`/`dispose`/signal/generation); API client with timeout, abort, normalized error and contract validation; capability boot object; router extension preserving all existing routes; global status strip; shared primitives (table, dialog, drawer, inspector, form-field, status-badge, live-region, empty/error) | Overview meets DoD; every existing route still resolves; leak soak green; validation mechanism decided and CSP-compatible |
| **S2 — Collections + reader** | W5, W6 | Collections list, collection home, Documents, Structure, and re-hosting of the existing file/section reader and structural renderer inside the workbench | Both reader surfaces meet DoD; existing reader tests still green; long-path and Cyrillic rendering verified |
| **S3 — Operations** | W2, W3, W4, part of W9 | Operations list, `#/operations/:id` route, index form with preflight, cancel, repair-as-tracked-operation; the existing operation store/modal is reused, not duplicated | Full job lifecycle (start → progress → complete/fail → cancel) meets DoD; indeterminate progress renders honestly; denial paths (allowed-roots, `not_available_in_lite`, `JOB_ALREADY_RUNNING`) each render specifically |
| **S4 — Search** | W5 | Search workbench with the preserved `?q=` contract, result inspector, anchored hand-off to the reader, ownership-checked submissions | Stale-response test green; permalink round-trips; DoD met |
| **S5 — Ask** | W7 | Bounded stream decoder (SDK reuse decision executed), run state machine, two-phase render, source/evidence inspector, citation ↔ source linking, cancel, refusal/partial handling, ephemeral in-memory conversation with client-side budgeting, accessible status region | Full SSE corpus green; fault injection (provider down mid-stream, malformed frame, oversized frame, abort racing completion) green; no auto-retry/reconnect anywhere; DoD met; live acceptance against a slow local model documented |
| **S6 — Settings** | W8, W9 | Settings driven entirely by the server inventory; provenance and `pendingRestart` display; secret handling; destination-field loopback error; collection danger zone with typed confirmation | Secret-leak test green across every settings flow; each settings error code renders distinctly; DoD met |
| **S7 — Parity, retirement, tightening** | — | Per-surface parity sign-off and deletion of the replaced old surfaces; removal of inline `style` attributes and tightening of `style-src` to `'self'`; profiling on real collections; replacement of every provisional bound with a measured value or an explicit "measured, keeping" note | Old surfaces deleted, not hidden; `style-src 'self'` shipped; every provisional number resolved; full test suite + smoke green |

Cross-cutting, unscheduled and additive after S7: light theme token set,
localization, command palette — each dependent on decisions in §16 or on gaps in
§14.

---

## 14. API-gap register

**A. Confirmed current API** (verified in code; the design may rely on it)

`GET /api/health` · `GET /api/capabilities` · `GET /api/settings` ·
`PATCH /api/settings` · `GET /api/collections` · `GET /api/collections/:name` ·
`POST /api/collections/:name/sync-schema` · `DELETE /api/collections/:name` ·
`GET /api/collections/:name/documents` · `.../chunks` · `.../assembly` ·
`.../skeleton` · `.../skeleton/node` · `.../skeleton/children` ·
`.../skeleton/anchor` · `.../node` · `POST /api/search` ·
`GET /api/generation/status` · `GET /api/generation/models` ·
`POST /api/jobs/index` · `GET /api/jobs` · `GET /api/jobs/:id` ·
`POST /api/jobs/:id/cancel` · `GET /api/operations` · `GET /api/operations/:id` ·
`POST /api/system/pick-folder` · `POST /api/system/qdrant-cloud-probe` ·
Full-only: `GET /api/system/ollama-status`, `POST /api/system/onnx-probe`,
`GET /api/system/onnx-managed-runtimes`, `GET /api/ollama-models` ·
Integration (never called by the browser): `POST /api/v1/search`,
`POST /api/v1/ask`, `POST /api/v2/ask`.

**B. Missing API this design would benefit from** (design is scoped to work
without it; each is a small, self-contained server change)

| ID | Gap | Impact on this design | Interim behaviour |
|---|---|---|---|
| `GAP-01` | No edition/feature capability manifest. `GET /api/capabilities` returns storage flags only (`capabilities.js:6`), while route `edition` metadata exists in-process but is never served (`route-audience.js:103`, `router.listRoutes()`) | Capability-driven composition cannot be fully backend-authoritative | Build-time edition constant + probe-route presence, isolated in `shared/capabilities.js` (§6) |
| `GAP-02` | No `X-Request-Id` response header. The router mints a `requestId` for audit only (`router.js:113`); our own SDK reads `x-request-id` and always gets `null` (`client/index.js:215`) | Error surfaces cannot show a correlation id an operator could match to an audit event | Show the server message only |
| `GAP-03` | No documented pagination/limit contract on `GET .../documents` and `.../chunks` | Documents pagination is designed against unknown bounds | Read the actual defaults from `api/query-params.js` at implementation time and pin them in the contract validator |
| `GAP-04` | No create-collection endpoint | Collections list has no "New collection" primary action | Primary action is "Index a folder" (§5.2) |
| `GAP-05` | No cross-collection search | Search stays collection-scoped | By design for now |
| `GAP-06` | No job-retry endpoint and no per-document job result set | No Retry button; no Operation → affected document link | "Run again" (a new job) may be offered, explicitly labelled |
| `GAP-07` | Admin `POST /api/search` is unversioned and has no published contract doc, unlike `/api/v1/search` | The UI validator must be derived from `search-request.js`/route code rather than a contract module | Acceptable; noted so drift is visible |
| `GAP-08` | Static serving has no SPA history fallback (`static.js:39,72`) | History-API routing is impossible without a server change | Hash routing (§4.2) |
| `GAP-09` | No published maximum Ask answer size or streaming duration | The total-answer bound is provisional | Measure during S5; record the value |
| `GAP-10` | No per-caller **request-rate limit** on the admin surface (the audit's §12c item 5 leaves this open). Request *size* is **not** a gap: every admin route that reads a body goes through `readJsonBody`'s 1 MB default (`http.js:87`) — verified at `api/settings.js:40`, `api/search.js:53`, `api/jobs.js:254`, `cloud/admin/qdrant-cloud-api.js:39`, `local/admin/api/onnx.js:64`, with no call site overriding `maxBytes` or disabling Content-Type enforcement. Routes that read no body (sync-schema, job cancel, collection delete, pick-folder) have nothing to cap, and static serving is GET/HEAD-only | Not a UI blocker; recorded because the UI polls this surface continuously | None |
| `GAP-11` | No admin authentication of any kind | Any LAN/reverse-proxy deployment relies entirely on Host/Origin policy | The UI is designed so that adding a session later touches only the API client |

**C. Proposed future capability** (explicitly *not* current; must not be
designed against without a separate product decision)

Conversation persistence (`FUT-01`) · file upload / drag-and-drop indexing
(`FUT-02`) · system-log browsing (`FUT-03`) · command palette (`FUT-04`) ·
global search (`FUT-05`) · collection create/configure (`FUT-06`) ·
"test an unsaved URL" probes (`FUT-07`) · job retry (`FUT-08`) ·
multi-user/RBAC (`FUT-09`) · telemetry (`FUT-10`, rejected on principle) ·
MCP management UI (`FUT-11`) · Ask-run trace/timeline (`FUT-12`) ·
metrics/dashboards/vector visualization (`FUT-17`) · admin UI localization
(`FUT-16`) · light theme (§7.2).

No screen in §5 depends on anything in list C.

---

## 15. First implementation task (ready to hand off; do not implement here)

**Title:** Introduce the v2 view-controller lifecycle and the validated API
client, and prove them on one existing read-only surface.

**Why first:** every other slice depends on `dispose()` semantics, ownership
checks and a normalized error type. Proving them on an existing surface avoids
coupling the foundation to a new screen's unknowns.

**Scope**

1. Add `src/shared/admin/ui-src/shared/lifecycle/view.js`:
   `createViewController()` returning `{ signal, nextGeneration(), isCurrent(gen),
   onDispose(fn), dispose() }`. `dispose()` aborts the controller, runs
   registered teardown in reverse order, and invalidates the generation counter.
2. Add `src/shared/admin/ui-src/shared/api/client.js`, wrapping the existing
   `api.js` helpers without changing their behaviour for current callers:
   per-request timeout composed with a caller `AbortSignal`, the existing
   `X-Semidex-Request: admin` header on non-safe methods, JSON parsing, and a
   normalized `ApiError` (`kind`, `status`, `code`, `message`,
   `retryAfterSeconds`). No runtime function construction anywhere.
3. Add `src/shared/admin/ui-src/shared/api/contracts/operations.js`: hand-written
   validators for `GET /api/operations` and `GET /api/operations/:id`, derived
   field-by-field from `src/shared/admin/api/operations.js`'s
   `jobToOperation()`/`taskToOperation()` projections. A response that fails
   validation produces `ApiError { kind: 'contract' }`.
4. Wire **only** the existing `operation-store.js` fetch path through the new
   client + validators. Do not change its polling cadence, its pub/sub contract,
   its rendering, or any other module.

**Explicitly out of scope:** any new screen, any new route, any visual change,
any token refactor, any change to `structural-renderer.js`, and any change to
`packages/lite/`.

**Tests to add**

- `tests/unit/admin/ui-view-lifecycle.test.js` — `dispose()` aborts the signal,
  runs teardown in reverse order, removes `{ signal }`-registered listeners, and
  makes `isCurrent()` false for every generation issued before it.
- `tests/unit/admin/ui-api-client.test.js` — success; each `ApiError.kind`
  mapping; `Retry-After` parsing; timeout produces `kind: 'timeout'`; a caller
  abort produces `kind: 'aborted'`; non-JSON body produces `kind: 'contract'`;
  the admin header is present on POST/PATCH/DELETE and absent on GET.
- `tests/unit/admin/ui-contracts-operations.test.js` — a valid payload passes; a
  missing required field, a wrong type, and a non-array `operations` each fail;
  an unknown optional field passes unchanged.

**Acceptance**

- `npm test` green, including every existing `tests/unit/admin/ui-*.test.js`.
- No behavioural change observable in the operation modal or topbar chip.
- No new runtime dependency.
- `git diff --check` clean.

---

## 16. Open decisions

| ID | Decision | Owner | Needed by |
|---|---|---|---|
| `D-1` | Close `GAP-01` with a capability/edition manifest endpoint, or accept the build-time interim for the foreseeable future | Backend + product | S1 (interim is designed; the decision affects how long it lives) |
| `D-2` | Validation mechanism: hand-written validators vs build-time-compiled schemas. Constraint is fixed (no runtime `Function` under `script-src 'self'`) | Frontend | S1 |
| `D-3` | SDK parser reuse strategy — extract shared module (a), import by path (b), or tested copy (c). Depends on `VER-07` | Frontend + Lite packaging | S5 |
| `D-4` | Whether to introduce browser-driver E2E, visual regression and automated axe scanning at all, given the current `node:test` + `linkedom` setup | Whole team | S7 |
| `D-5` | Whether a light theme is a product requirement or an optional token set | Product | after S2 |
| `D-6` | Whether admin UI localization (`FUT-16`) is in scope for v2 at all | Product | before S6 (settings copy is the largest string surface) |
| `D-7` | Whether `#/index` folds into Collections → Index or stays a top-level route | Frontend | S3 |
| `D-8` | Whether to emit `X-Request-Id` (`GAP-02`) so error surfaces can carry a correlation id | Backend | S1 (nice to have), S5 (most useful) |

---

## 17. Relationship to existing documents

- `admin-dashboard-research-synthesis-2026-08-29.md` — the decision register this
  plan implements.
- `docs/design/admin-ui-ux-and-ask-plan.md` — the IA pivot (§3A), the
  evidence-authoritative principle (§0), the generation/embedding asymmetry
  (§4A.5) and the cross-cutting requirements (§4) all remain in force. The Ask
  UI sections (4B/4C) are superseded by §9 here, which is written against the
  shipped v2 protocol rather than the original `POST /api/ask` sketch.
- `docs/design/ask-v2-conversational-context.md` — the ownership model §9.1
  depends on. Not modified.
- `docs/security/semidex-lite-public-api-audit-2026-08.md` — the source of the
  trust boundaries in §10.2 and of `GAP-10`/`GAP-11`.
- `docs/security/rag-prompt-injection-threat-model-2026-08.md` — the two named
  residual risks (citation presence is not semantic grounding; body text can
  forge an evidence header) apply to every Ask surface described here and are
  never claimed to be solved by the UI.
