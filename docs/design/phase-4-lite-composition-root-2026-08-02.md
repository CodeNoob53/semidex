# Phase 4 — Explicit Semidex Lite composition root

Implementation report for Phase 4 of
[`full-lite-shared-architecture-audit-2026-08-01.md`](full-lite-shared-architecture-audit-2026-08-01.md)
(§11's "Phase 4 — Split provider registries' Lite-relevant DI seams into an
explicit `composition-lite` module"). Follows
[Phase 3](phase-3-register-neutral-routes-2026-08-02.md), which split
`registerNeutralRoutes()`/`createHttpServer()` out of `admin/server.js` into
`admin/register-neutral-routes.js`. This phase completes that split: Lite's
own composition root (`createLiteApp()`, `LITE_JOB_POLICY`) moves out of
`admin/server.js` into a new `admin/composition/lite.js`, leaving
`admin/server.js` as pure shared bind-config resolution.

Mechanical extraction only — no behavior change, no route/contract/
status-code/middleware-order changes, no new abstractions.

## 1. Before/after ownership

| Responsibility | Before Phase 4 | After Phase 4 |
|---|---|---|
| `createLiteApp()` | `src/admin/server.js` | `src/admin/composition/lite.js` |
| `LITE_JOB_POLICY` | `src/admin/server.js` | `src/admin/composition/lite.js` |
| Gemini-only generation-model route composition (the `generationModelsFn` closure passed into `registerNeutralRoutes`) | `src/admin/server.js` (inline in `createLiteApp`) | `src/admin/composition/lite.js` (inline in `createLiteApp`, unchanged) |
| Lite jobs-route policy composition (the `jobsFn` closure) | `src/admin/server.js` (inline in `createLiteApp`) | `src/admin/composition/lite.js` (inline in `createLiteApp`, unchanged) |
| `resolveHostConfig()` | `src/admin/server.js` | `src/admin/server.js` (unchanged) |
| `resolvePortConfig()` | `src/admin/server.js` | `src/admin/server.js` (unchanged) |
| `registerNeutralRoutes()` / `createHttpServer()` | `src/admin/register-neutral-routes.js` (Phase 3) | unchanged |
| `createApp()` (Full) | `src/admin/server-full.js` | unchanged |

`src/admin/server.js` shrank from 127 lines (post-Phase-3) to 41 lines — now
exclusively `LOOPBACK_HOSTS`, `resolveHostConfig()`, `resolvePortConfig()`.
`src/admin/composition/lite.js` is a new 61-line file.

## 2. Import-consumer audit

Ran before editing any test or entry point, per the task's own requirement.
Searched for every static/dynamic import of `createLiteApp`/`LITE_JOB_POLICY`
from `src/admin/server.js` across `src/`, `tests/`, and `packages/`:

| Consumer | Import before | Import after |
|---|---|---|
| `packages/lite/lite-src/serve-lite.js` | `const { resolveHostConfig, resolvePortConfig, createLiteApp } = await import('../src/admin/server.js');` (one dynamic import) | Two dynamic imports: `resolveHostConfig`/`resolvePortConfig` from `../src/admin/server.js`, `createLiteApp` from `../src/admin/composition/lite.js` |
| `tests/unit/admin/lite-app.test.js` | `import { createLiteApp } from '../../../src/admin/server.js';` | `import { createLiteApp } from '../../../src/admin/composition/lite.js';` |
| `tests/unit/admin/register-neutral-routes.test.js` | `import { createLiteApp } from '../../../src/admin/server.js';` | `import { createLiteApp } from '../../../src/admin/composition/lite.js';` |
| `tests/unit/admin/server.test.js` | `import { resolveHostConfig, resolvePortConfig } from '../../../src/admin/server.js';` (never imported `createLiteApp`) | unchanged |
| `src/admin/server-full.js` | imports `registerNeutralRoutes, createHttpServer` from `./register-neutral-routes.js` (Phase 3 result, never imported `createLiteApp`) | unchanged |

Three prose-only (non-import) comment references to "`server.js`'s
`LITE_JOB_POLICY`" were also found and corrected for accuracy, since they
describe current ownership to a future reader: `vite.config.lite.js`,
`packages/lite/lite-src/index-lite.js`, `src/admin/ui-src/jobs-view.js`.
None of these are imports — no runtime behavior changed.

No compatibility re-export was added anywhere. `src/admin/server.js`'s
public export surface is exactly `resolveHostConfig`, `resolvePortConfig` —
confirmed via a direct `Object.keys()` test
(`tests/unit/admin/composition-lite.test.js`).

## 3. Exact moved exports

Moved verbatim (function bodies byte-identical, only the file changed) from
`src/admin/server.js` into `src/admin/composition/lite.js`:

- `createLiteApp({ adapter, embedQuery, jobRegistry, taskRegistry, assemblyLogFn, generationRuntime, askCoordinator, countTokens, settingsService, jobBaseEnv, discoverGeminiModelsFn, runQdrantCloudProbeFn, resolveNewCollectionProfileFn, jobPolicy })` — same signature, same defaults, same internal `registerNeutralRoutes()` call shape (all DI args threaded through unchanged), same `generationModelsFn`/`jobsFn` closures.
- `LITE_JOB_POLICY` (frozen object, identical fields/values).
- Imports needed only by `createLiteApp()`: `createStorageAdapter` (from `../../core/storage/factory.js`), `createRouter` (from `../router.js`), `registerJobsRoutes` (from `../api/jobs.js`), `registerGenerationModelsRoutesGeminiOnly` (from `../api/generation-models.js`), `createSettingsService` (from `../../core/settings/service.js`), `registerNeutralRoutes`/`createHttpServer` (from `../register-neutral-routes.js`).

`src/admin/server.js` retained: `LOOPBACK_HOSTS` (private), `resolveHostConfig()`, `resolvePortConfig()` — unchanged.

## 4. Behavioral preservation evidence

- No route registration order changed — `createLiteApp()`'s single call
  into `registerNeutralRoutes(router, {...})` is textually unchanged, only
  relocated.
- No DI argument, default value, or closure shape changed.
- `packages/lite/lite-src/serve-lite.js`'s documented 7-step bootstrap
  order (`bootstrapEnv()` → settings services → `jobBaseEnv` capture →
  `applyEnvWriteBack()` → host/port resolution → generation runtime →
  `createLiteApp()`) is unchanged; only the import statement for
  `createLiteApp` moved from one `await import()` to a second, separate
  `await import()` immediately alongside the first.
- `tests/unit/admin/lite-app.test.js` (14 tests, unmodified test logic,
  import path only) and `tests/unit/admin/register-neutral-routes.test.js`'s
  existing end-to-end HTTP tests against real `createLiteApp()`/`createApp()`
  instances (import path only) both pass unmodified against the new layout.
- `tests/unit/lite/serve-lite.test.js` (real `startLite()` end-to-end,
  including the dual-dynamic-import path) passes unmodified.

## 5. Lite closure evidence

- `packages/lite/build.mjs`'s `EXCLUDE_FILES`/`EXCLUDE_DIRS` lists needed
  **no change** — they are directory-listing-based, not import-graph-based,
  so the new `src/admin/composition/lite.js` file is naturally staged
  (nothing in `EXCLUDE_DIRS` matches `admin/composition/`).
- `node packages/lite/build.mjs`: 118 files staged (117 before Phase 4,
  +1 for `admin/composition/lite.js`), closure validated clean, zero new
  allow-list exceptions.
- Confirmed staged tree contains `src/admin/composition/lite.js`,
  `src/admin/server.js`, `src/admin/register-neutral-routes.js`, and
  excludes `src/admin/server-full.js` (`ls packages/lite/src/admin/server-full.js`
  → no such file).
- Confirmed the staged `server.js` copy exports only `resolveHostConfig`/
  `resolvePortConfig` (`grep '^export'`), and the staged
  `composition/lite.js` copy is the real file with `createLiteApp`/
  `LITE_JOB_POLICY`.
- `scripts/audit/classify-modules.mjs` re-run: 238 modules classified
  (+1 vs. Phase 3's 237, for the new file), zero cloud-imports-local
  violations, zero heavy local packages (`onnxruntime-node`,
  `@huggingface/transformers`) reachable post-shim. Real classification
  output confirms:
  - `src/admin/server.js` → `shared`, `fullReachable: true`, `liteReachable: true` (no longer `mixed` — the `firstPassBucket()` special case for it was removed, since real graph facts now correctly classify it without help).
  - `src/admin/composition/lite.js` → `cloud`, `fullReachable: false`, `liteReachable: true`, `liteTarballStaged: true`.
  - `src/admin/server-full.js` → `composition-full`, `liteReachable: false`, `liteTarballStaged: false` (unchanged).
- New `tests/unit/admin/composition-lite.test.js` (12 tests) proves, via
  the same real AST-derived import graph Phase 3's tests use (never regex):
  `composition/lite.js` has zero direct/transitive edges into
  `server-full.js` or any `COMPOSITION_FULL_PATTERNS` file; zero direct
  edges into any `LOCAL_ONLY_PATH_PATTERNS` file; zero transitive edges
  into any `LOCAL_ONLY_PATH_PATTERNS` file **post-lazy-shim-substitution**
  (matching the real shipped tarball, not just pre-shim `src/`); zero bare
  package imports; `server.js` has zero relative imports of any kind
  (not just "no forbidden ones" — genuinely none). Verified these tests
  catch a real regression: temporarily re-added a
  `createStorageAdapter` import to `server.js`, confirmed 2 of the new
  tests failed with the exact expected messages, then restored the file
  (confirmed clean via `git diff --check`).

## 6. Test/build results

Run sequentially (`--test-concurrency=1`), per the task's own requirement:

| Check | Result |
|---|---|
| `tests/unit/admin/server.test.js` + `lite-app.test.js` + `register-neutral-routes.test.js` + `composition-lite.test.js` (combined) | 91/91 pass |
| `tests/unit/lite/**/*.test.js` | 75/75 pass |
| `npm test` (full suite) | 2624/2624 pass (2612 Phase-3 baseline + 12 new `composition-lite.test.js` tests) |
| `npm run smoke` | 1316/1316 pass (matches baseline) |
| `npm run admin:build` | succeeds, 285.23 kB JS bundle (byte-identical to Phase 3's build — no UI-affecting change in this phase) |
| `npm run admin:build:lite` | succeeds, 279.98 kB JS bundle (byte-identical to Phase 3's build) |
| `node packages/lite/build.mjs` | 118 files staged, closure validated clean |
| `node --check` on every changed/new `.js` file | all pass |
| `git diff --check` | clean (only expected LF/CRLF warnings) |
| `tests/unit/lite/clean-install-acceptance.test.js` (real packed tarball) | 6/6 pass — `semidex-lite serve` starts and responds on `/api/health` from the read-only installed tarball, routed through the new `composition/lite.js` import; no relative import escapes the package root |

## 7. Known limitations

- `registerNeutralRoutes()` (Phase 3's shared function) still accepts both
  cloud-specific (`runQdrantCloudProbeFn`, `resolveNewCollectionProfileFn`)
  and local-specific (`pickFolderFn`, `checkOllamaFn`) DI seams in one
  parameter list — Lite's `createLiteApp()` simply never passes the
  local-specific ones. This was flagged in the original audit (§4.1) as an
  acceptable, low-cost shape and was intentionally NOT redesigned in this
  phase (redesigning the seam itself was never in scope for Phase 3 or 4).
- No behavior, settings, or UI change of any kind — Phase 5 (settings
  definitions completeness) and Phase 6 (Admin UI entry/partials restructure)
  remain fully separate, unstarted work.
- The Lite composition module still constructs its own `router` via
  `createRouter()` with no DI seam for tests to intercept it directly (same
  limitation Phase 3's report already documented for `createApp()`/
  `createLiteApp()` generally — real end-to-end HTTP tests remain the
  strongest available behavioral proof, not a router-interception test).

## 8. Recommendation for Phase 5

Per the audit's own §11 ordering and this task's explicit non-goals, Phase 5
(settings definitions completeness — either splitting
`core/settings/definitions.js` or adding the automated allow-list-completeness
test per §9.2) was not started and should be scoped as its own task, not
folded into a follow-up here. Both Phase 3 and Phase 4 are now complete;
`admin/server.js`, `admin/register-neutral-routes.js`, and
`admin/composition/lite.js` each have a single, unambiguous responsibility,
and every one of the phase's own acceptance criteria (canonical owner for
`createLiteApp`/`LITE_JOB_POLICY`, bind-config-only `server.js`, no
compatibility re-export, clean Lite closure, unchanged Full/Lite behavior)
is met and test-verified.

**PHASE_4_ACCEPT**
