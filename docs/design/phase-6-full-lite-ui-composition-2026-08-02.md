# Phase 6 — Physical Full/Lite Admin UI composition with separate Vite entries and partials

Implementation report for Phase 6 of
[`full-lite-shared-architecture-audit-2026-08-01.md`](full-lite-shared-architecture-audit-2026-08-01.md)
(§8.2/§11's "Phase 6 — Admin UI `entries/{full,lite}.js` +
`partials/{shared,full,lite}/` restructure"). Replaces the pre-Phase-6
mechanism (Rollup DCE of `SEMIDEX_LITE`/`IS_LITE`-guarded branches +
`stripHtmlMarkers()` post-build HTML/JS string surgery) with physically
separate Full and Lite composition roots. Build/composition refactor only
— no UI redesign, no new product features.

## 1. Final Full/Lite entry points

| | Full | Lite |
|---|---|---|
| HTML entry | `src/admin/ui-src/index.html` | `src/admin/ui-src/lite-entry/index.html` |
| JS entry | `src/admin/ui-src/entries/full.js` | `src/admin/ui-src/entries/lite.js` |
| Vite config | `vite.config.js` | `vite.config.lite.js` |
| Build output | `dist/admin-ui/` | `dist/admin-ui-lite/` |
| Output HTML filename | `index.html` | `index.html` |

`entries/lite.js`'s HTML lives in its own `lite-entry/` subdirectory (not
a top-level `index-lite.html`) specifically so Vite's own
path-relative-to-`root` output naming produces `dist/admin-ui-lite/index.html`
— the exact filename `packages/lite/build.mjs` and `src/admin/static.js`
both require (the static server always serves `index.html` for `/`).
`vite.config.lite.js`'s own `root` is `src/admin/ui-src/lite-entry/`
(not `src/admin/ui-src/` — a deliberate difference from `vite.config.js`);
JS module resolution (imports, the `edition` alias) is governed by
Node/Rollup module resolution from each file's own location, independent
of this HTML-`root` choice, so nothing else needed to change because of it.

`main.js` (the old single shared entry) was removed — superseded by the
two files above, each with its own real `<script type="module">` tag in
its own real HTML document.

## 2. Final partial ownership map

```
src/admin/ui-src/partials/
├── shared/                          — genuinely shared (both editions)
│   ├── collection-shell.html
│   ├── overview-shell.html
│   └── templates/
│       ├── assembly-segment.html
│       ├── assembly-warning.html
│       ├── chunk-card.html
│       ├── delete-modal.html
│       ├── empty-state.html
│       ├── error-state.html
│       ├── file-view-header.html
│       ├── global-settings.html     — every tpl-gs-* template EXCEPT the ONNX probe panel
│       ├── job-row.html
│       ├── operation-modal.html
│       ├── reader-mode-toggle.html
│       └── search-result.html
├── full/                            — Full-only
│   ├── index-view.html              — collection-creation form: ONNX/LLM-summaries/tag-gen checkboxes + Ollama-status placeholder
│   ├── onnx-probe-panel.html        — <template id="tpl-gs-onnx-probe-panel">
│   └── settings-shell.html          — per-collection reindex form: same three checkboxes
└── lite/                            — Lite-only
    ├── index-view.html              — collection-creation form: prune-stale checkbox only
    └── settings-shell.html          — per-collection reindex form: prune-stale checkbox only
```

`partials/full/index-view.html`/`partials/lite/index-view.html` and their
`settings-shell.html` counterparts are real, independently-maintained
files, not one file with the other derived by a build step — each
contains the full markup for its own edition's form.

## 3. Remaining shared modules

Every JS module under `src/admin/ui-src/` except `entries/full.js`,
`entries/lite.js`, and `local-features.js` is unchanged in its file
identity — still one shared file, imported once by both editions via the
shared `router.js`/`app.js` composition chain: `app.js`, `router.js`,
`routes.js`, `dom.js`, `api.js`, `state.js`, `format.js`, `icons.js`,
`sidebar.js`, `sidebar-resize.js`, `topbar.js`, `toasts.js`,
`operation-store.js`, `operation-render.js`, `operation-modal.js`,
`collection-view.js`, `file-view.js`, `assembly-view.js`, `search.js`,
`structural-renderer.js`, `global-settings-view.js`, `jobs-view.js`,
`settings-view.js`. None of these import `entries/full.js`/
`entries/lite.js` (verified — see §5).

`global-settings-view.js`, `jobs-view.js`, and `settings-view.js` each
gained one new export: a capability setter
(`setLocalSettingsCapabilities`/`setJobsLocalCapabilities`/
`setSettingsLocalCapabilities`) and a module-level `let localCapabilities
= null;`. No other public API changed. Their large shared rendering logic
(the generic per-setting-field renderer, the collection-creation form
skeleton, the reindex form skeleton) is untouched.

## 4. New module: `local-features.js`

Owns every genuinely local-only BEHAVIOR (not just markup):
`onnxProbePanel()`, `wireOnnxProbePanel()`, `runOnnxProbe()` (ONNX
hardware probe panel), `categoryNeedsOllamaModels()`,
`refreshOllamaModels()` (Ollama model discovery), `loadOllamaStatus()`
(Ollama readiness check), `retryOllamaStatus()`, `collectLocalJobOptions()`,
`wireIndexingFormLocalOptions()` (the onnxEmbed/llmSummaries/tagGen job
options and their DOM wiring).

Every `#opt-onnx`/`#opt-llm-summaries`/`#opt-tags`/`#idx-ollama-status`
selector string lives ONLY inside this file's own `querySelector()` calls
— a real regression during this work (see §7) proved that even a
feature-detection check like `$('#opt-onnx')` in a shared file leaks that
selector string into the Lite bundle regardless of whether the code path
using it is reachable, since Rollup has no way to know a string constant
is "local-only." The shared view modules never reference these id
strings at all.

`local-features.js` is imported by exactly one file:
`entries/full.js`. `entries/lite.js` never imports it, directly or
transitively — confirmed by the real AST import graph
(`scripts/audit/build-import-graph.mjs`) and by a real Vite build output
scan finding zero occurrences of any of its exported function names in
the Lite bundle.

## 5. Whether any `SEMIDEX_LITE`/`IS_LITE` guard remains

None, in ordinary UI feature code. `SEMIDEX_LITE` (the Vite `define`) and
`IS_LITE` (the `typeof`-guarded local constant) were removed from
`vite.config.js`, `vite.config.lite.js`, `global-settings-view.js`,
`jobs-view.js`, and `settings-view.js` — the only five places that ever
referenced either. No file under `src/admin/ui-src/` references
`SEMIDEX_LITE` or `IS_LITE` any more (confirmed by `grep`).

The intended result the task specified — "zero such guards in ordinary UI
feature code" — is met exactly.

## 6. Build output changes

| | Before Phase 6 | After Phase 6 |
|---|---|---|
| Full JS bundle size | ~285.2 kB | ~285.5 kB |
| Lite JS bundle size | ~280.0 kB | ~279.8 kB |
| Full output HTML | `dist/admin-ui/index.html` | unchanged |
| Lite output HTML | `dist/admin-ui-lite/index.html` | unchanged (same filename, different build mechanism producing it) |
| Local-only markers in Lite build | 0 (via marker-strip) | 0 (via physical exclusion) |
| Local-only markers in Full build | present (unchanged) | present (unchanged) |

Bundle sizes are within normal build-to-build variance (module boilerplate,
hash-length differences) — no meaningful size regression in either
direction. No route, API contract, or visual CSS changed.

## 7. A real regression found and fixed during this work

An intermediate version of `jobs-view.js`/`settings-view.js` kept the
`IS_LITE` boolean removed (correct) but replaced it with DOM
feature-detection performed IN THE SHARED FILE itself — e.g.
`const onnxCheckbox = $('#opt-onnx'); if (onnxCheckbox) { ... }`. A real
`vite build --config vite.config.lite.js` run followed by a marker scan of
the actual output caught that `'#opt-onnx'`/`'#opt-llm-summaries'` (the
selector STRINGS, not the surrounding logic) were still physically present
in the Lite JS bundle, because the `$('#opt-onnx')` call itself — needed
just to check whether the element exists — still appears in
`jobs-view.js`, which both editions import. Fixed by moving every such
selector string into `local-features.js`'s own `querySelector()` calls
(`wireIndexingFormLocalOptions(form, ...)`, `collectLocalJobOptions(form)`)
— the shared view modules call these unconditionally through the
capability seam and never hold the selector strings themselves. Re-verified
with another real build + marker scan: zero leaks.

A second, related bug (infinite recursion) was found and fixed in the
`tests/unit/admin/ui-test-helpers.js` `vm.Script`-based test harness
while wiring the same capability seam into its concatenated-source bundle
— see that file's own comment on `getGlobalSettingsScript()` for the
full explanation (two same-named top-level function declarations from two
different real files collide when concatenated into one flat scope;
fixed by renaming `local-features.js`'s exports with a test-harness-only
`__lf_` prefix, never in the real shipped source).

## 8. CSS ownership

One shared stylesheet (`app.css`) — not split. It retains a small number
of Full-only class selectors (`.gs-onnx-probe-panel`, `.gs-onnx-result`,
etc., ~5 rules) targeting elements that, after this phase, exist in the
DOM ONLY in the Full build (the `.gs-onnx-probe-panel` markup itself is
now a physically separate file, `partials/full/onnx-probe-panel.html`,
never `<load>`ed by Lite's `index.html`). These rules are inert, dead CSS
in the Lite build: they cannot create any visible Lite UI by themselves,
since there is no DOM element in Lite for them to ever match. Splitting
`app.css` into Full/Lite copies to remove ~10 lines of dead selectors was
judged not worth the churn (a second CSS file to keep in sync, for a
class of problem — a handful of harmless unused selectors — that has no
user-visible or security consequence).

## 9. Tests proving physical isolation

- **`tests/unit/admin/ui-composition-isolation.test.js`** (new, 16 tests)
  — real AST import-graph tests (via `scripts/audit/build-import-graph.mjs`,
  never regex, per the task's own preference): `entries/lite.js` never
  reaches `local-features.js`, directly or transitively; `entries/lite.js`
  never calls any of the three capability setters (code-only, comments
  excluded); `entries/lite.js` still reaches every genuinely shared module
  (proves the isolation isn't accidental); `entries/full.js` reaches
  `local-features.js` directly and calls all three setters; no shared
  module imports either entry point; `local-features.js` is never
  imported by the three shared view modules directly; `vite.config.lite.js`
  contains no `stripHtmlMarkers`/`HTML_STRIPS`/marker-replacement code;
  no partial file contains a `semidex-lite-strip` marker; `partials/full/`
  and `partials/lite/` both physically exist with their own
  `index-view.html`/`settings-shell.html`; no flat
  `partials/index-view.html`/`partials/settings-shell.html`/
  `partials/templates/global-settings.html` exists any more; both HTML
  entry documents point at their own real edition's JS entry; only Full's
  `index.html` `<load>`s the ONNX probe panel template.
- **`tests/unit/lite/ui-build-dce.test.js`** (renamed in intent, not just
  in file — same real-build-output methodology, 6 tests) — runs the
  ACTUAL `vite build --config vite.config.lite.js`/`vite build` and scans
  real output: zero local-only markers in Lite's build; `opt-prune`
  survives (proves the exclusion is scoped, not over-broad); Lite's
  output is literally named `index.html`; zero occurrences of
  `local-features.js`'s own exported function names in Lite's build (a
  stronger check than the marker list — proves real import-graph absence,
  not just string-marker absence); Full's build still has every
  local-only marker (zero behavior change for Full); Full's output is
  named `index.html`.
- The two pre-Phase-6 structural test files
  (`tests/unit/admin/global-settings-view-lite-dce.test.js`,
  `tests/unit/admin/jobs-and-settings-view-lite-dce.test.js`) were
  deleted — their entire premise (IS_LITE guard shape,
  `semidex-lite-strip` marker balance) no longer applies to this codebase.

## 10. Test/build results

Run sequentially, per the task's own requirement:

| Check | Result |
|---|---|
| `node --check` on every changed/new `.js` file | all pass |
| `git diff --check` | clean (only expected LF/CRLF warnings) |
| `npm run admin:build` (Full) | succeeds, ~285.5 kB JS |
| `npm run admin:build:lite` (Lite) | succeeds, ~279.8 kB JS, `dist/admin-ui-lite/index.html` |
| `node packages/lite/build.mjs` | 118 files staged, closure validated clean |
| `tests/unit/admin/ui-composition-isolation.test.js` | 16/16 pass |
| `tests/unit/lite/ui-build-dce.test.js` | 6/6 pass |
| `tests/unit/admin/*.test.js` (full directory) | 972/972 pass |
| `tests/unit/lite/**/*.test.js` (full directory) | 78/78 pass |
| `tests/unit/lite/clean-install-acceptance.test.js` (real packed tarball) | 6/6 pass |
| `npm test` (full suite) | 2641/2641 pass |
| `npm run smoke` | 1316/1316 pass (matches baseline) |

Real regressions caught and fixed during this work are documented in §7 —
both were caught by the real-build-output test methodology this phase
required, not by source inspection alone.

## 11. Known limitations

- `app.css` retains a handful of inert, Full-only class selectors (§8) —
  a deliberate, documented decision, not an oversight.
- `local-features.js`'s functions take their DOM/helper dependencies as
  parameters (`{ templateRoot, currentPendingValue }`,
  `{ esc, errorBox }`) rather than importing them directly, since some of
  those dependencies (`currentPendingValue`) are private state owned by
  `global-settings-view.js` itself. This is a real but narrow seam-shape
  cost of the capability-injection pattern — acceptable here since
  `local-features.js` stays a small, single-purpose module.
- The `edition` Vite alias (used by `jobs-view.js`'s/`settings-view.js`'s
  `?raw` partial imports) is a bare-specifier alias, not a real npm
  package — `scripts/audit/build-import-graph.mjs`'s own AST resolver
  correctly reports it as an unresolved `package`-kind specifier (it has
  no way to know about Vite-specific alias config), which is expected and
  does not affect any of this phase's own reachability assertions (none
  of them depend on resolving through that specifier).
- `npm run admin:dev:lite` was added as a real, working Lite dev command
  (same proxy-to-`/api` convention as `admin:dev`) but was not
  exhaustively manually exercised beyond a successful `vite` dev-server
  start — see the manual verification checklist for what still needs a
  human pass.
- Phase 7 (removing now-unnecessary Lite shims) and Phase 8 (narrowing
  npm staging to a directory-enforced closure) remain unstarted, per the
  audit's own §11 ordering.

## 12. Recommendation for Phase 7

Phases 3 through 6 are now all complete. Phase 7 ("Remove now-unnecessary
Lite shims, only after Phases 3–6 land") is next in the audit's own §11
ordering and was explicitly out of scope here — it requires first
auditing which of the three `*-lazy.js`/`*-lazy.lite.js` shim pairs (if
any) are now redundant given this phase's own physical-separation work,
which is a distinct investigation from this phase's build/composition
refactor.
