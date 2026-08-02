# Phase 3 — extract shared HTTP composition from `admin/server.js`

Implementation report. Date: 2026-08-02. Status: implemented, not committed.

Companion: `docs/design/full-lite-shared-architecture-audit-2026-08-01.md`
(§11, Phase 3 entry) — this report documents what was actually done
against that phase's own exit gate.

## 1. Module responsibility — before and after

### Before

`src/admin/server.js` (287 lines) mixed three distinct responsibilities in
one file: (a) `resolveHostConfig()`/`resolvePortConfig()` — bind-config
parsing, unrelated to route registration; (b) `registerNeutralRoutes()` +
`createHttpServer()` — the shared, provider-neutral route wiring both
`createApp()` (full) and `createLiteApp()` (Lite) build on; (c)
`createLiteApp()` + `LITE_JOB_POLICY` — the Lite composition root itself.
`src/admin/server-full.js` imported `registerNeutralRoutes`/
`createHttpServer` back from `server.js` to build `createApp()`.

### After

- **`src/admin/register-neutral-routes.js`** (new, 175 lines) — owns
  `registerNeutralRoutes()` and `createHttpServer()` exclusively, plus the
  one private helper (`defaultCountTokens`) and every import those two
  functions need. Nothing else.
- **`src/admin/server.js`** (135 lines, down from 287) — owns
  `resolveHostConfig()`, `resolvePortConfig()`, `createLiteApp()`,
  `LITE_JOB_POLICY`. Imports `registerNeutralRoutes`/`createHttpServer`
  from the new module instead of defining them.
- **`src/admin/server-full.js`** — one import line changed: now imports
  `registerNeutralRoutes`/`createHttpServer` from
  `./register-neutral-routes.js` directly instead of `./server.js`. No
  other change.

This is exactly the module boundary the audit doc's Phase 3 entry
specified: a dedicated shared module for neutral route registration, not
split further into multiple files.

## 2. Exports/helpers moved

| Export | Old location | New location |
|---|---|---|
| `registerNeutralRoutes` | `server.js` | `register-neutral-routes.js` |
| `createHttpServer` | `server.js` | `register-neutral-routes.js` |
| `defaultCountTokens` (private) | `server.js` | `register-neutral-routes.js` |
| `resolveHostConfig` | `server.js` | `server.js` (unchanged) |
| `resolvePortConfig` | `server.js` | `server.js` (unchanged) |
| `createLiteApp` | `server.js` | `server.js` (unchanged) |
| `LITE_JOB_POLICY` | `server.js` | `server.js` (unchanged) |

No new export was added anywhere. No re-export was added for backward
compatibility — a full `rg`-based import audit (§3) found zero real
consumers of `registerNeutralRoutes`/`createHttpServer` other than
`server.js` itself (for `createLiteApp`) and `server-full.js` (for
`createApp`), so `server.js` does not re-export either name.

## 3. Import-consumer audit (performed before editing)

Searched the whole repo for every real importer of `src/admin/server.js`
before making any change:

| File | What it imports | Action taken |
|---|---|---|
| `src/admin/server-full.js` | `registerNeutralRoutes`, `createHttpServer` | Updated to import from `register-neutral-routes.js` |
| `tests/unit/admin/server.test.js` | `resolveHostConfig`, `resolvePortConfig` (from `server.js`), `createApp` (from `server-full.js`) | No change needed — both still exported from the same paths |
| `tests/unit/admin/lite-app.test.js` | `createLiteApp` | No change needed |
| `packages/lite/lite-src/serve-lite.js` | `resolveHostConfig`, `resolvePortConfig`, `createLiteApp` — dynamic `await import('../src/admin/server.js')` | No change needed |
| `tests/unit/admin/ui-test-helpers.js` | `createApp` (from `server-full.js`) | No change needed |
| 7 more `tests/unit/admin/*.test.js` files | `createApp` (from `server-full.js`) | No change needed |

Every comment-only mention of `registerNeutralRoutes`/`LITE_JOB_POLICY`
across the repo (in `jobs.js`, `index-lite.js`, `vite.config.lite.js`,
`jobs-view.js`, `lite-policy.js`, `classify-modules.mjs`, `build.mjs`) was
checked and confirmed to be prose only, not a real import — none needed
updating.

**Result: exactly one file needed a real import-path change** (`server-full.js`).
Every other consumer's import path was already correct because
`resolveHostConfig`/`resolvePortConfig`/`createLiteApp` never moved.

## 4. Behavior preservation

No route URL, request/response contract, middleware/registration order,
status code, error-serialization path, or static-UI-serving logic
changed — `registerNeutralRoutes()`'s and `createHttpServer()`'s function
bodies were moved verbatim (copy, not rewrite) into the new file. Verified:

- `createApp()` and `createLiteApp()` both still start and respond
  `200` on `GET /api/health` (new end-to-end test).
- Calling `registerNeutralRoutes()` directly with a real router-shaped
  fake and Full-only extra args (`pickFolderFn`) vs. Lite-shaped args
  registers the byte-identical route set both times (new behavioral
  test — proves the shared function's own output doesn't vary by caller
  shape).
- `createLiteApp()` still returns `404` for the two local-only routes
  (`POST /api/system/onnx-probe`, `GET /api/system/ollama-status`) it
  never registers.
- The full `tests/unit/admin/**` (1022+ tests) and `tests/unit/lite/**`
  (75 tests) suites pass unmodified — zero test-logic changes were
  needed anywhere outside the one new test file this phase added
  (`tests/unit/admin/register-neutral-routes.test.js`).

## 5. Full/Lite build and test results

| Check | Result |
|---|---|
| `node --test --test-concurrency=1 tests/unit/admin/server.test.js` | 60/60 pass |
| `node --test --test-concurrency=1 tests/unit/admin/register-neutral-routes.test.js` (new) | 12/12 pass |
| `node --test --test-concurrency=1 "tests/unit/lite/**/*.test.js"` | 75/75 pass |
| `node packages/lite/build.mjs` | 117 files staged (116 before + `register-neutral-routes.js`), closure validated clean, **zero new allow-lists or exceptions added to the validator** |
| `npm run admin:build` | succeeds, output byte-identical (`index-CgR64j6G.js`/`index-BbNI7HoT.css` — same hashes as before this phase) |
| `npm run admin:build:lite` | succeeds, output byte-identical (`index-BB3kKBKl.js`) |
| `npm test` (full repo) | 2612/2612 pass (2600 pre-existing + 12 new) |
| `npm run smoke` | 1316/1316 pass |
| `tests/unit/lite/clean-install-acceptance.test.js` (real packed tarball) | 6/6 pass — `onnxruntime-node`/`@huggingface/transformers`/`acorn` still absent from the installed dependency tree; `serve` still starts and responds from a read-only install |
| `git diff --check` | clean (only expected LF/CRLF notices) |

## 6. Architecture guarantees (Part E), how each was proven

New test file: `tests/unit/admin/register-neutral-routes.test.js` (12
tests). Reuses the SAME real AST-based import graph
(`scripts/audit/build-import-graph.mjs`'s `buildGraph()`) the earlier
architecture audit built — never regex-only assertions.

**Code review finding, corrected**: an earlier version of this file's
"Full and Lite both register the identical neutral-route set" test was
named and commented as if it "intercepted the real router each
composition root constructs" — it never did; it only called
`registerNeutralRoutes()` twice, directly, with a fake recording router,
which proves the function's own output is deterministic across caller
shapes, not that `createApp()`/`createLiteApp()` actually reach it. A
real DI seam for injecting a router into either composition root was
considered and rejected (this task's own scope forbids adding one "just
in case," and a live-ESM-binding monkey-patch of `router.js`'s
`createRouter` export was tried and found unreliable — import ordering
across the test process meant the patched binding was not consistently
the one either composition root actually called). Fixed by (a) renaming
and re-commenting that test to state its real, narrower claim precisely,
and (b) adding a genuinely stronger test that starts BOTH real composed
apps and confirms, over real HTTP, that a shared set of neutral routes
responds non-`404` on both — combined with the structural
single-source-of-truth import check (item 2 below), this is the actual
evidence for "Full and Lite share one neutral-route wiring," spread
honestly across three tests rather than overclaimed by one. Verified the
new HTTP-based test genuinely catches a regression: temporarily commented
out one route registration inside `register-neutral-routes.js` and
confirmed the test failed with the exact route and status named, then
reverted.

1. **`register-neutral-routes.js` imports zero local-runtime modules** —
   checked twice: direct edges (no local-only file imported by the file
   itself) and post-lazy-shim transitive edges (matching what the real
   Lite tarball ships, via the existing `*-lazy.js`→`*-lazy.lite.js`
   substitution). Verified BOTH checks catch a real regression: a direct
   `core/ollama.js` import was temporarily injected and confirmed both
   tests failed with the exact offending path named, then reverted.
2. **Full and Lite both use the identical neutral-route set** — proven by
   THREE separate pieces of evidence, none individually overclaimed: (a)
   a structural check that `server.js` and `server-full.js` both
   statically import `registerNeutralRoutes` from the same module (so
   they cannot have silently forked into two copies); (b) a call-shape
   determinism test proving `registerNeutralRoutes()` itself registers
   the identical route set whether invoked with Full-shaped or
   Lite-shaped extra arguments (a fake recording router — this is
   explicitly NOT a claim about intercepting either composition root's
   own internal router instance); (c) a real end-to-end test that starts
   BOTH `createApp()` and `createLiteApp()` and confirms, over real HTTP,
   that a shared set of neutral routes responds non-`404` on both — the
   strongest of the three, since it exercises each composition root's
   own genuinely-constructed router.
3. **Lite closure validator passes with zero new allow-lists or
   exceptions** — `node packages/lite/build.mjs` output confirmed clean;
   no change was made to `build.mjs`'s `EXCLUDE_FILES`/`EXCLUDE_DIRS` or
   any check in this phase.
4. **Lite npm staging received no local-runtime modules** — confirmed by
   `clean-install-acceptance.test.js`'s `npm ls --all` check (unchanged,
   still passes) and by the staged-tree file count (117, +1 for the new
   shared module, +0 for anything local-only).
5. Three additional end-to-end tests confirm `createApp()`/`createLiteApp()`
   genuinely still start and serve real HTTP requests after the
   extraction (two single-app health checks plus the dual-app neutral-route
   check from item 2c), not just that their imports resolve.

## 7. Audit-document correction (Part A)

`docs/design/full-lite-shared-architecture-audit-2026-08-01.md`'s Phase 2
section and two Open Decisions entries described the FIRST (later
rejected) fix for the `powershell.exe` closure-validator finding — a
hardcoded `TRUSTED_OS_SPAWN_TARGETS` allow-list. That description no
longer matched the shipped code, which uses `isBareOsCommand()`, a
semantic classifier (no `.`/`/`/`\` prefix → OS command, scoped to
`spawn` only, never `fork`) with no name comparison at all — plus a
second, independently-found lexical-scope-ordering bug (a parameter
shadowing a DIRECT, non-aliased `child_process` import was still
misclassified before a subsequent fix). Both stale sections were rewritten
to describe the actual shipped mechanism and cite the real 27-test
regression file; no other section of the audit was touched, and no
historical finding that remains correct was altered.

## 8. Known limitations

- `createLiteApp()` was explicitly NOT moved into a separate
  `admin/composition/lite.js` in this phase — per the task's own
  constraint, this remains `server.js`'s responsibility until Phase 4.
- `resolveHostConfig()`/`resolvePortConfig()` still live in `server.js`
  alongside `createLiteApp()`, not in a dedicated config module — no
  requirement in this phase asked for that split, and introducing one
  would be an unrequested abstraction.
- The pre-existing regex-based layering test
  (`tests/unit/admin/server.test.js`'s `describe('layering — ...')`) was
  left in place unmodified — it still passes and still provides a coarse,
  whole-`src/admin/` sanity check; the new AST-based tests in
  `register-neutral-routes.test.js` are the stronger, file-scoped
  guarantee this phase specifically required, not a replacement for the
  older test.
- `Cannot find module` occurs if `node --test tests/unit/lite` is invoked
  with a bare directory path (no glob) on this Node/OS combination — this
  is a pre-existing Node test-runner CLI quirk unrelated to this phase;
  `tests/unit/lite/**/*.test.js` (glob) runs the same 75 tests correctly
  and was used for verification instead.

## 9. Recommendation for Phase 4

Per the audit doc's own Phase 4 entry ("Split provider registries' Lite-relevant
DI seams into an explicit `composition-lite` module"): extract
`LITE_JOB_POLICY`, `registerGenerationModelsRoutesGeminiOnly`'s wiring, and
`createLiteApp()` itself out of `server.js` into a new
`admin/composition/lite.js`, leaving `server.js` to own only
`resolveHostConfig()`/`resolvePortConfig()` (or moving those too, if a
clean natural home emerges). This is explicitly NOT started in this task,
per its own constraints. Recommend running the same import-consumer audit
methodology (§3 of this report) before touching any file, since
`serve-lite.js`'s dynamic import of `createLiteApp` from `server.js` would
need updating to point at the new composition module.
