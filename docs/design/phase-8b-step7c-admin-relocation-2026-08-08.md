# Phase 8B Step 7C — Admin runtime and Admin UI relocation

Status: implemented (2026-08-08). Third and final part of Phase 8A's
migration plan Step 6 ("Physically relocate stable shared modules"),
covering `src/admin/`'s shared files — deferred by Step 7A
(`docs/design/phase-8b-step7a-shared-core-relocation-2026-08-07.md`, top-level
`src/core/*.js`) and Step 7B
(`docs/design/phase-8b-step7b-shared-indexer-relocation-2026-08-07.md`,
`src/indexer/`'s shared files). See
`docs/design/phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`
§Step 6 for the original plan text and all three "As implemented" notes.

## Goal

Physically split Admin code by ownership, mirroring the shared/local/cloud
separation already established for core modules and the indexer pipeline:

- `src/shared/admin/` — shared Admin API, server infrastructure, jobs, UI
- `src/local/admin/` — local-only Admin API/system/UI (ONNX, Ollama)
- `src/cloud/admin/` — cloud-only Admin API/system (already relocated,
  Phase 8B Step 6 — unaffected by this step)
- `src/admin/` — only the Full/Lite composition roots and edition entry
  points

Pure relocation: no HTTP API contract change, no route/response/status-code
change, no behavior change to jobs/indexing/search/Ask/settings/health, no
UI redesign, no new npm dependencies, no compatibility re-export stubs, no
duplicated files.

## Inventory and moves (all via `git mv`)

**Shared Admin infrastructure** (4 files), `src/admin/` → `src/shared/admin/`:
`router.js`, `server.js`, `static.js`, `register-neutral-routes.js`.

**Shared Admin API routes** (15 files), `src/admin/api/` → `src/shared/admin/api/`:
`assembly.js`, `chunks.js`, `collections.js`, `documents.js`,
`generation-models.js`, `generation.js`, `health.js`, `jobs.js`, `node.js`,
`operations.js`, `query-params.js`, `search.js`, `settings.js`,
`skeleton.js`, `system.js`.

**Shared Admin jobs** (2 files), `src/admin/jobs/` → `src/shared/admin/jobs/`:
`registry.js`, `task-registry.js`.

**Shared Admin system** (1 file): `system/folder-picker.js` →
`src/shared/admin/system/folder-picker.js`.

**Shared Admin UI source** (24 `.js`/`.css` files), `src/admin/ui-src/` →
`src/shared/admin/ui-src/`: `api.js`, `app.css`, `app.js`,
`assembly-view.js`, `collection-view.js`, `dom.js`, `file-view.js`,
`format.js`, `global-settings-view.js`, `icons.js`, `jobs-view.js`,
`operation-modal.js`, `operation-render.js`, `operation-store.js`,
`router.js`, `routes.js`, `search.js`, `settings-view.js`,
`sidebar-resize.js`, `sidebar.js`, `state.js`, `structural-renderer.js`,
`toasts.js`, `topbar.js`.

**Shared UI partials** (14 HTML files): `ui-src/partials/shared/{collection-shell,overview-shell}.html`
plus all 12 files under `ui-src/partials/shared/templates/` →
`src/shared/admin/ui-src/partials/shared/...`.

**Local-only Admin API** (2 files): `api/onnx.js`, `api/ollama-models.js` →
`src/local/admin/api/`.

**Local-only Admin system** (1 file): `system/ollama.js` →
`src/local/admin/system/ollama.js`.

**Local-only Admin UI** (1 file + 3 HTML partials):
`ui-src/local-features.js` → `src/local/admin/ui-src/local-features.js`;
`ui-src/partials/full/{index-view,onnx-probe-panel,settings-shell}.html` →
`src/local/admin/ui-src/partials/full/`.

**Left unmoved at `src/admin/`** (composition-owned, explicitly out of
scope): `bootstrap.js`, `server-full.js`, `composition/lite.js`,
`jobs/spawn-indexer-{full,lite}.js`, `ui-src/entries/{full,lite}.js`,
`ui-src/index.html`, `ui-src/lite-entry/index.html`,
`ui-src/partials/lite/{index-view,settings-shell}.html`. The
`partials/lite/` decision (neither shared nor local-only markup) was made
via explicit consultation during execution rather than assumed — it is
Lite's own composition-time markup, structurally analogous to
`index-full.js`/`index-lite.js` staying at `src/indexer/` in Step 7B.

Total: 67 files moved via `git mv` (4 + 15 + 2 + 1 + 24 + 14 = 60 shared;
2 + 1 + 1 + 3 = 7 local).

## Path-depth fixes

Every moved file gained or lost exactly one `../` in its relative imports
to account for its new depth, mechanically derived from the move, not a
logic change:

- `src/shared/admin/static.js` — `UI_DIR` (`import.meta.url`-relative
  constant pointing at `dist/admin-ui/`) gained one `../`; its
  `sendError` import gained one `../`.
- `src/shared/admin/register-neutral-routes.js` — 4 import lines
  (`ask-api/v1/route.js`, `generation/runtime.js`, `ask/coordinator.js`
  gained one `../`; `token-count.js` lost one `../`, since it moved from
  `src/core/` to `src/shared/core/` in Step 7A, a net-zero depth change
  once both moves are combined).
- `src/shared/admin/router.js` — `http.js`/`doctor-checks.js` imports
  gained one `../`.
- All 15 `src/shared/admin/api/*.js` files — sibling imports (`./query-params.js`,
  `./jobs.js`, `../system/folder-picker.js`) unchanged; imports into
  `core/`/`shared/core/` gained one `../` uniformly.
- `src/shared/admin/jobs/{registry,task-registry}.js` — `doctor-checks.js`
  import gained one `../`; `registry.js` also fixed `progress-event.js`.
- `src/local/admin/api/onnx.js` — 7 import lines gained one `../` each
  (now three levels deep under `src/local/admin/api/`, vs. two levels
  under the old `src/admin/api/`).
- `src/local/admin/api/ollama-models.js`, `src/local/admin/system/ollama.js` —
  same one-level depth fix.
- `src/local/admin/ui-src/local-features.js` — its one import
  (`api.js`, now in `shared/admin/ui-src/`) rewritten as
  `../../../shared/admin/ui-src/api.js`.
- `src/shared/admin/ui-src/global-settings-view.js` — one import
  (`qdrant-cloud-models.js`) gained one `../`.

## Composition roots

`src/admin/bootstrap.js`, `src/admin/server-full.js`, and
`src/admin/composition/lite.js` each had their full import block rewritten
to the new `shared/`/`local/`/`cloud/` paths. No change to `createApp()`'s
or `createLiteApp()`'s own function body — the DI pattern (capabilities
constructed and passed explicitly per call, no module-scope mutable
composition state) was already correct before this step and needed no
further change.

`vite.config.js` — the `edition` alias (`partials/full/` → now
`src/local/admin/ui-src/partials/full/`) and the `fullReload()` glob list
(now 3 entries: the still-composition-owned `partials/lite/`, plus the two
physically relocated shared/local partial trees) were updated. A stale
`node src/admin/server.js` comment was also fixed to `bootstrap.js`.
`vite.config.lite.js` needed **zero changes** — its own `root`
(`lite-entry/`), UI tree, and `edition` alias target (`partials/lite/`)
never physically moved.

`src/admin/ui-src/index.html` and `.../lite-entry/index.html` — every
`<load>` tag's `src` attribute updated to the new relative depth
(`../../shared/admin/ui-src/partials/...` from `index.html`;
`../../../shared/admin/ui-src/partials/...` from `lite-entry/index.html`,
one level deeper). `src/admin/ui-src/entries/{full,lite}.js` — every
import of `app.css`/`app.js`/`global-settings-view.js`/`jobs-view.js`/
`settings-view.js` now points into `../../../shared/admin/ui-src/`;
`entries/full.js`'s one `local-features.js` import now points into
`../../../local/admin/ui-src/`.

A `vite-plugin-html-inject`-specific bug was caught and fixed during
verification: a `.`-prefixed `<load src="../shared/admin/...">` resolves
relative to the *including file's own directory* (confirmed by reading
that plugin's source directly), not the Vite root — the first attempt used
one `../` too few from `index.html` (which lives at `admin/ui-src/`, two
levels above `src/`, not one). Caught immediately by running the real
`npm run admin:build` rather than trusting `node --check`.

## `packages/lite/build.mjs`

`EXCLUDE_DIRS` — `'admin/ui-src'` kept (still excludes the composition-owned
remainder); `'shared/admin/ui-src'` added (the relocated shared UI *source*
tree — Lite ships the *built* `dist/admin-ui-lite/` output instead, never
raw source, same rule as before); `'local/admin/ui-src'` is already
covered by the pre-existing blanket `'local'` entry.

`EXCLUDE_FILES` — three now-redundant individual entries
(`admin/system/ollama.js`, `admin/api/onnx.js`, `admin/api/ollama-models.js`)
removed, since those files now live under the blanket-excluded
`src/local/` directory. `admin/server-full.js`, `admin/bootstrap.js`,
`admin/jobs/spawn-indexer-full.js` entries kept (still real, unmoved
Full-only composition files at their original paths).

Verified via a real `node packages/lite/build.mjs` run: 123 files staged
(unchanged from the pre-move baseline), five-part closure validator clean.

## Consumer sweep

~180 files matched a broad grep for `admin/(api|jobs|system|router|server|
static|register-neutral-routes|ui-src)` paths; the overwhelming majority
were historical docs (left untouched per the task's own "do not
mass-rewrite historical documents" instruction) or already-correct
references to the unmoved composition roots. Real fixes landed in:

- 18 files via an automated relative-import rewrite pass (AST-agnostic,
  resolves each specifier against the importing file's own directory and
  rewrites only genuine matches against the confirmed move table):
  `tests/unit/admin/{api/onnx,composition-lite,jobs,operations,
  query-params,register-neutral-routes,router,server,static-serving,
  system,task-registry,ui-assembly-view,ui-file-view,ui-search,
  ui-structural-renderer,ui-test-helpers}.{test.js,js}`,
  `tests/unit/core/ollama.test.js`,
  `tests/unit/indexer/indexer-settings-writeback.test.js`.
- `tests/unit/admin/ui-test-helpers.js`'s `readUiSource()` helper —
  rewritten to resolve into the correct one of three physical roots
  (`admin/ui-src/` for `index.html`; `local/admin/ui-src/` for
  `local-features.js`/`partials/full/*`; `shared/admin/ui-src/` for
  everything else) based on the requested relative path, so every existing
  call site (`readUiSource('app.js')`, `readUiSource('partials/full/index-view.html')`,
  etc.) kept working unchanged.
- `tests/unit/admin/ui-accessibility.test.js`'s own separate hardcoded
  `CSS_PATH` constant (didn't use the shared helper) — fixed directly.
- `tests/unit/admin/server.test.js`'s "layering" test — widened to walk
  all four Admin roots (`src/admin/`, `src/shared/admin/`,
  `src/local/admin/`, `src/cloud/admin/`) instead of only `src/admin/`,
  since most of what it was checking physically moved out of that
  directory.
- `tests/unit/admin/ui-composition-isolation.test.js` — every graph-key
  string and physical-existence check rewritten to the new three-root
  layout (11 `it()` blocks touched); this was the single largest test-file
  rewrite in the sweep.
- `tests/unit/architecture/{full-lite-boundary,phase-8b-step6-cloud-relocation,
  shared-cloud-local-manifest}.test.js` — hardcoded graph-key/manifest-path
  strings updated (`src/admin/jobs/registry.js` →
  `src/shared/admin/jobs/registry.js`, etc.).
- `tests/unit/lite/build-closure-validator.test.js` — 3 hardcoded
  `join(REPO_SRC, 'admin', ...)` paths updated to their new location.
- `packages/lite/lite-src/{index-lite,serve-lite}.js` — both had real,
  previously-undetected bugs: `index-lite.js`'s `createJobRegistry` import
  and `serve-lite.js`'s `createJobRegistry`/`resolveHostConfig`/
  `resolvePortConfig` imports still pointed at
  `../src/admin/jobs/registry.js` / `../src/admin/server.js` (resolving
  against the *staged* `packages/lite/src/` tree, where those files no
  longer exist post-move) — fixed to `../src/shared/admin/jobs/registry.js`
  / `../src/shared/admin/server.js`. Neither bug was caught by
  `node --check` (both are syntactically valid, resolution-time-only
  failures) — caught by the architecture/lite test suite actually
  executing these files.
- `scripts/audit/build-shared-cloud-local-manifest.mjs`'s
  `COMPOSITION_COMMON_FILES` override set — `'src/admin/register-neutral-routes.js'`
  updated to `'src/shared/admin/register-neutral-routes.js'`. This was the
  most consequential single fix: without it, the manifest silently
  reclassified `register-neutral-routes.js` from `composition` to `shared`
  (11→12 composition count regression), which the drift-detection test
  (`shared-cloud-local-manifest.test.js`) caught immediately.
- `scripts/audit/classify-modules.mjs` — `LOCAL_ONLY_PATH_PATTERNS`'s three
  stale entries (`src/admin/system/ollama.js`, `src/admin/api/onnx.js`,
  `src/admin/api/ollama-models.js`) updated to their `src/local/admin/...`
  paths; `EXCLUDE_DIRS` gained `'src/shared/admin/ui-src/'`; the
  `liteBrowserBundle` computation widened to recognize all three physical
  UI-source roots, not just the original `src/admin/ui-src/`.

No changes were needed in `benchmarks/` (zero matches) or any other
`scripts/` file.

## Architecture test

`tests/unit/architecture/phase-8b-step7c-admin-relocation.test.js` (new,
151 tests, 12 `describe` blocks) covers: every inventory-approved file
exists at its new path; every old production path is absent (including a
check that `admin/jobs/` contains *only* the two composition-owned
spawn-indexer files, not a stray leftover); no live import/require/dynamic-import
specifier anywhere under `src/`, `benchmarks/`, `scripts/`, or
`packages/lite/lite-src/` resolves to an old `src/admin/<moved-file>.js`
path — proven load-bearing via a reverted-fix proof (temporarily reverts
`composition/lite.js`'s real import of `register-neutral-routes.js` back
to its exact pre-move relative specifier, confirms the same detector logic
flags it, restores the correct code, and asserts the restoration is
byte-identical to the original); `src/shared/admin/` never imports
`src/local/` or `src/cloud/`; `src/cloud/admin/` never imports
`src/local/`; zero declared-shared→local/cloud manifest edges restricted
to `shared/admin/` modules; zero unclassified modules; every moved file's
declared category matches expectation (including the
`register-neutral-routes.js`-is-`composition`-but-`server.js`-is-`shared`
distinction, confirmed against the real `COMPOSITION_COMMON_FILES` set
rather than assumed); Lite composition roots (`composition/lite.js`,
`ui-src/entries/lite.js`) structurally cannot reach `src/local/admin/`,
any `LOCAL_ONLY_PATH_PATTERNS` file post-lazy-shim, the Full indexer
spawner, or the Full-only UI entry/partials; Full composition roots still
reach every local/cloud/shared capability they need; real HTTP round-trips
against `createApp()`/`createLiteApp()` confirm neutral routes plus
Full-only ONNX/Ollama routes are present, and Lite correctly 404s the
latter; job registries resolve to the correct indexer entry; UI entries
resolve without any old path; Lite package staging contains every moved
shared file and zero local-only Admin files, and the real closure
validator passes against the staged tree; zero compatibility re-export
stubs exist anywhere under `src/admin/`.

## Verification results (Part I, sequential only)

- `node --check` on all 87 changed `.js`/`.mjs` files: clean.
- New architecture test alone: 151/151.
- Full `tests/unit/architecture/*.test.js` suite: 422/422.
- `node scripts/audit/find-dependency-violations.mjs`: 0 dependency-direction
  violations, 0 shared→cloud edges.
- `node scripts/audit/build-shared-cloud-local-manifest.mjs`: 261 modules
  classified, 0 unclassified, category counts unchanged from the pre-move
  baseline (composition: 12, mixed: 9, tooling: 61, cloud: 8, shared: 144,
  local: 27).
- `node scripts/audit/classify-modules.mjs`: 266 modules classified, 0
  cloud-imports-local violations, 0 heavy local packages reachable from
  Lite post-shim.
- `npm test`: 3415/3415.
- `npm run smoke`: 1316/1316.
- `npm run admin:build`: succeeds, 227 modules transformed, output
  unchanged in shape from pre-move.
- `npm run admin:build:lite`: succeeds, 226 modules transformed; the
  built bundle was scanned for local-only markers (`onnx-probe-panel`,
  `local-features`, `Ollama model discovery`, `gs-onnx-probe`) and found
  zero matches.
- `node packages/lite/build.mjs`: 123 files staged (unchanged from the
  pre-move baseline), five-part closure validator clean.
- `git diff --check`: exit 0 (only routine LF/CRLF `core.autocrlf`
  warnings, no real whitespace errors).
- `tests/unit/lite/clean-install-acceptance.test.js`: 6/6 — a real
  `npm pack`, install into a clean empty temp directory, package directory
  marked read-only, `semidex-lite doctor`/`semidex-lite serve` (responds
  on `/api/health`) run from the read-only install with zero writes into
  the package directory, and confirmation that no relative import in the
  installed package resolves outside the package root.

## Known limitations

- The reverted-fix proof in the new architecture test covers one
  representative case (`composition/lite.js`'s import of
  `register-neutral-routes.js`), not every one of the 46 moved files
  individually — consistent with the precedent set by Step 7A/7B's own
  equivalent tests.
- Several test-file header comments (prose only, e.g.
  `tests/unit/admin/system.test.js`'s file-level comment still says
  "Tests for src/admin/system/folder-picker.js, src/admin/system/ollama.js")
  were not scrubbed of the old path — the real import statements
  immediately below them are correct and verified; this mirrors the same
  "comments legitimately preserve historical path mentions" convention
  Step 7A's own architecture test explicitly documents and checks for
  (code-only, not comment-only, matching).
- Historical docs (all `docs/admin-ui-phase*.md`, `docs/admin-api-*.md`,
  `docs/admin-local-api-*.md`, and this repo's own prior Phase 8B step
  reports) were deliberately left unedited, per this task's own explicit
  instruction — `docs/en/project-structure.md`,
  `docs/design/semidex-lite-package-boundary.md`, and
  `docs/design/phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`
  received the authoritative current-path updates instead.

## Next step

Phase 8B Step 8 (delete the 3 now-unnecessary `*-lazy.js`/`*-lazy.lite.js`
shim pairs, once every consumer confirmed on the Step 1 injection seam) —
unaffected by this step, still pending per the original Phase 8A plan.

## Verdict

`PHASE_8B_STEP7C_ACCEPT`
