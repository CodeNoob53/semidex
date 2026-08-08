# Phase 8B Step 8 — full removal of the transitional lazy-shim layer

Status: implemented (2026-08-08). Final step of the Phase 8B capability-
contract/physical-relocation series — see
`docs/design/phase-8b-capability-contracts-and-composition-seams-2026-08-02.md`
§9 ("What still runs on the old lazy-shim path, and why") for the original
Step 1 decision to keep the shims in place, and its own closing condition
for when removal would become safe.

## Goal

Delete the six transitional `*-lazy.js`/`*-lazy.lite.js` files outright
and every piece of build-time logic that knew about substituting or
excluding them by name, now that Full and Lite have separate composition
roots, the indexer is split into `index-full.js`/`index-lite.js`,
embedding capability construction is instance-scoped, and every real
consumer already constructs and injects its own capability explicitly at
composition time — the dynamic-loader deferral the six files existed for
is no longer load-bearing.

## Part A — inventory before any change

Confirmed via `git grep` for real (non-comment) import specifiers, not
directory-name assumption, that exactly **6 production files** statically
or dynamically imported one of the six shim files:

| Consumer | Capability slot(s) used | Composition root? |
|---|---|---|
| `src/admin/bootstrap.js` | `ollamaLazy.{isOllamaReachable,listOllamaModels,validateOllamaModels,generateStream,getModelContextLength}` (5 of 9 bare functions, for `createOllamaProvider`'s `*Fn` overrides) | Yes — Full's real entry point |
| `src/admin/server-full.js` | `ollamaLazy` (whole namespace, passed as `capabilities.ollama`) + `onnx-embed-lazy.js`'s `createOnnxEmbeddingCapability()` | Yes — `createApp()` |
| `src/indexer/index-full.js` | `ollamaLazy` (whole namespace, on all 4 `ollamaGenerate`/`ollamaSummary`/`ollamaEmbed`/`ollamaDiscovery` slots) + both `onnx-embed-lazy.js`/`tag-onnx-lazy.js` factories | Yes — `runFullIndexerComposition()` |
| `src/backfill-tags.js` | `ollamaLazy` (whole namespace, as `capabilities.ollama` to `addTagsBatch`) | Yes — standalone Full-only tooling script |
| `src/mcp/onnx-runtime-resolution.js` | `onnx-embed-lazy.js`'s `createOnnxEmbeddingCapability()` | No — helper called by `mcp/server.js`'s own composition |
| `src/mcp/server.js` | `ollamaLazy` (whole namespace, as `capabilities.ollama` + `setOllamaDiscovery(ollamaLazy)`) | Yes — MCP's own composition root |

Confirmed via inspection of `local/core/ollama.js`, `local/core/onnx-embed.js`,
and `local/indexer/phases/tag-onnx.js` that:
- `onnx-embed.js` and `tag-onnx.js` **already** exported real,
  instance-scoped `createOnnxEmbeddingCapability()`/`createTagOnnxCapability()`
  factories (from the Phase 8B Step 2/4 "instance-scoping parity fix") —
  the corresponding `*-lazy.js` files added nothing but a deferred
  `await import()` around an otherwise-identical call.
- `ollama.js` exports 11 bare functions with **no** factory of its own —
  `core/ollama-lazy.js` was the only place that grouped them, and it
  grouped all of them into one namespace regardless of which narrow
  contract (`OllamaGenerateCapability`/`OllamaSummaryCapability`/
  `OllamaEmbedCapability`/`OllamaDiscoveryCapability`, all four already
  defined in `core/generation/ollama-capability.js`) a given consumer
  actually needed.
- All six real consumers above are **already** wholesale-excluded from
  the Lite package (`packages/lite/build.mjs`'s `EXCLUDE_FILES`/
  `EXCLUDE_DIRS` — `admin/bootstrap.js`, `admin/server-full.js`,
  `indexer/index-full.js`, `backfill-tags.js` individually; `mcp/`
  wholesale as a directory), so the deferred-`import()` mechanism the six
  shim files existed for was structurally unnecessary the moment every
  real caller lived behind that exclusion boundary — which was already
  true before this step began.
- The build-time content-substitution mechanism (`substituteLazyShims()`/
  `LAZY_SHIM_SUBSTITUTIONS`) referenced in the shim files' own header
  comments had **already been removed** in an earlier pass —
  `packages/lite/build.mjs`'s own header comment already documented "No
  `*-lazy.js` content substitution step ... that mechanism has been
  removed entirely," and `scripts/audit/classify-modules.mjs`'s own
  `LAZY_SHIM_SUBSTITUTIONS` constant was already a permanently-empty `{}`.
  This step's own scope was therefore narrower than a first read of the
  task suggested: delete the six now-inert files, migrate their six real
  consumers off them, and remove the now-meaningless *scaffolding*
  (`applyLiteShims` option, `LAZY_SHIM_PATTERNS`, the pre/post-shim
  reachability double-computation) that still referenced them by name,
  even though it was already a no-op.

## Part B — local capability factories

**New file: `src/local/core/ollama-capability.js`** — the one genuinely
new production file this step adds. Four narrow factory functions
(`createOllamaGenerateCapability()`, `createOllamaSummaryCapability()`,
`createOllamaEmbedCapability()`, `createOllamaDiscoveryCapability()`),
each a stateless object literal (no session/worker lifecycle to isolate —
`ollama.js`'s bare functions hold no mutable state), returning only the
method subset its own contract in `core/generation/ollama-capability.js`
declares — never the full `ollama.js` namespace. Plus bare re-exports
(`generateStream`, `isOllamaReachable`, `listOllamaModels`,
`validateOllamaModels`, `getModelContextLength`) for `admin/bootstrap.js`'s
own five-`*Fn` `createOllamaProvider` override, which needs an ad hoc
mix spanning two of the four contracts plus `generateStream` (which
belongs to none of them — see `ollama-capability.js`'s own header comment
for why).

`local/core/onnx-embed.js` and `local/indexer/phases/tag-onnx.js` needed
**no new file** — their existing `createOnnxEmbeddingCapability()`/
`createTagOnnxCapability()` factories already satisfied every requirement
(instance-scoped, no module-global mutable state, concurrent-first-call
safe via each real module's own internal `_loadPromise`/promise-memoization
guard, idempotent `shutdown()`); the deleted `*-lazy.js` wrappers around
them added only deferred-loading, not any missing capability behavior.

## Part C — composition wiring

All six real consumers rewired to construct capabilities directly:

- **`src/admin/server-full.js`** — `import { createOllamaEmbedCapability } from '../local/core/ollama-capability.js'` and `import { createOnnxEmbeddingCapability } from '../local/core/onnx-embed.js'`, both static (this file is already Full-only/excluded from Lite regardless of import shape, and it is always itself dynamically imported by `admin/bootstrap.js`, so there is no "imported without running" ordering hazard here).
- **`src/admin/bootstrap.js`** — **dynamic** `await import('../local/core/ollama-capability.js')`, called inside the `isMainModule` guard, after `bootstrapEnv()`/`applyEnvWriteBack()` have both already run (see "Errors and fixes" below — the first pass got this wrong, as a static import, and a code review caught it).
- **`src/indexer/index-full.js`** — **dynamic** `await import(...)` for all three (`ollama-capability.js`, `onnx-embed.js`, `tag-onnx.js`), placed inside `runFullIndexerComposition()`, not as static top-level imports. This is the one place a static import would have been a real regression (see "Errors and fixes" below) — `indexer/index.js` (the backward-compatible launcher) does a plain top-level `import './index-full.js'`, and `local/core/ollama.js` has its own top-level `import 'dotenv/config'` side effect; a static chain would make merely *importing* `index.js` (never running it) mutate `process.env`, before `isIndexerMainModule()`'s own guard ever runs.
- **`src/backfill-tags.js`** — dynamic `await import('./local/core/ollama-capability.js')` (this file already used dynamic imports throughout its own top-level script body, matching `sync.js`/`doctor.js`'s convention).
- **`src/mcp/server.js`** — dynamic `await import('../local/core/ollama-capability.js')` for `createOllamaEmbedCapability`/`createOllamaDiscoveryCapability` (this file already dynamically imports everything after its own `bootstrapEnv()` call, by the same ordering discipline `admin/bootstrap.js` uses).
- **`src/mcp/onnx-runtime-resolution.js`** — static `import { createOnnxEmbeddingCapability } from '../local/core/onnx-embed.js'` (this file has no `dotenv`-ordering concern of its own — it is only ever called from inside `mcp/server.js`'s own already-bootstrapped sequence).

No `apply*Capabilities()` global process configuration, no shared
module-scope setter, no `process.env`-based edition branching inside
shared business logic, no `if (lite)` around a local-module import, and no
Lite-side stub that copies the full local API surface were introduced —
Lite's own typed-unavailable capabilities (`admin/composition/lite.js`'s
`unavailableOllamaEmbedCapability()`/`unavailableOnnxEmbedCapability()`,
`indexer/index-lite.js`'s three `unavailable*Capability()` functions) were
already small, local, throwaway classes predating this step (Phase 8B
Step 6/7's own work) — confirmed unchanged, since neither ever imported
any of the six deleted files in the first place.

## Part D — the three named production consumers

- **`backfill-tags.js`** — Full-only command; now constructs
  `createOllamaGenerateCapability()` directly (the one method `tag.js`'s
  own `addTagsBatch({ ollama })` actually calls), matching
  `indexer/index-full.js`'s own composition discipline.
- **`mcp/onnx-runtime-resolution.js`** — already received its capability
  request from its own composition root (`mcp/server.js`, via
  `resolveOnnxEmbedCapabilityForMcp({ settingsService })`) before this
  step; its own internal `createOnnxEmbeddingCapability` import was the
  one thing this step changed (from `core/onnx-embed-lazy.js` to
  `local/core/onnx-embed.js` directly) — it did not "self-open a lazy
  shim" in the sense of bypassing its composition root, but it did import
  a shim module internally, which is now gone.
- **`admin/bootstrap.js`** — was already structured correctly: it
  dynamically imports `server-full.js` inside its own `isMainModule`
  guard, and never duplicates `createApp()`'s own composition. This
  step's only change here was swapping its five `ollamaLazy.*` re-exports
  for the equivalent bare functions from `local/core/ollama-capability.js`.

No observable CLI/API behavior changed for any of the three.

## Part E — shim removal

Deleted via `git rm` (no compatibility re-exports, no deprecated
aliases):

```
src/core/ollama-lazy.js
src/core/ollama-lazy.lite.js
src/core/onnx-embed-lazy.js
src/core/onnx-embed-lazy.lite.js
src/indexer/phases/tag-onnx-lazy.js
src/indexer/phases/tag-onnx-lazy.lite.js
```

## Part F — Lite build cleanup

**`packages/lite/build.mjs`**: removed the 6 `EXCLUDE_FILES` entries
naming the deleted files (they are simply gone now — nothing to exclude
by name); updated the header comment and the surrounding `EXCLUDE_FILES`
prose that referenced "the *-lazy.js content substitution mechanism" and
"the three *-lazy.lite.js shim files themselves are also excluded" to
describe the current, simpler state (no substitution mechanism has
existed for some time; now there are no shim files to reference at all).

**`scripts/audit/classify-modules.mjs`**: removed `LAZY_SHIM_SUBSTITUTIONS`
(the permanently-empty `{}` constant), the `applyLiteShims` option on
`computeReachable()` (every call site — in this file, in
`build-shared-cloud-local-manifest.mjs`, and across ~10 test files —
either dropped the option or had it become a harmless ignored extra
argument), `LAZY_SHIM_PATTERNS` (`[/-lazy\.js$/, /-lazy\.lite\.js$/]`) and
its `'mixed'`-classification branch in `firstPassBucket()`, and the
`isLazyShimSourceFile` special-case in the per-file `liteTarballStaged`
computation. Collapsed the pre-shim/post-shim double reachability
computation (`liteReachablePreShim` vs. `liteReachable`, `shimCutFiles`,
`liteExternalDepsPreShim`, `liteHeavyDepsReachablePreShim`) in `main()`
down to a single `liteReachable` computation, since the two were already
identical by construction before this step (no substitution mechanism
existed) and are now identical by the stronger fact that there is nothing
left to substitute at all. Updated `full-lite-reachability-summary.json`'s
own emitted shape to match (no `*PreShim*`/`shimCutFiles`/
`lazyShimSubstitutions` fields).

**`scripts/audit/build-shared-cloud-local-manifest.mjs`**: removed the
`{ applyLiteShims: true }` option (unused now) and the
`/-lazy\.js$/`/`/-lazy\.lite\.js$/`-based `'mixed'` classification branch.

The Lite closure validator's own five checks (static imports, dynamic
imports, `require()`, fork/spawn targets, UI-asset forbidden-marker scan)
were **not weakened** in any way — no new allow-list exception, no
loosened pattern, no regex-only substitute for the AST-based checks.

## Part G — architecture tests

**7 test files deleted** (their entire premise was the shim mechanism
itself, not any surviving contract):
`tests/unit/architecture/lite-lazy-shim-necessity.test.js`,
`tests/unit/core/lazy-shim-backward-compat.test.js`,
`tests/unit/core/ollama-lazy-lite-shim.test.js`,
`tests/unit/core/onnx-embed-lazy-concurrency.test.js`,
`tests/unit/core/onnx-embed-lazy-lite-shim.test.js`,
`tests/unit/indexer/phases/tag-onnx-lazy-lite-shim.test.js`,
`tests/unit/indexer/phases/tag-onnx-lazy.test.js`. The concurrent-first-call
race property `onnx-embed-lazy-concurrency.test.js` proved against the
wrapper is still proven — against the real `local/core/onnx-embed.js`
implementation directly — by the pre-existing
`tests/unit/core/onnx-embed-instance-isolation.test.js`.

**16 test files updated** (real import specifiers or hardcoded
graph-key/manifest-path strings pointing at the six deleted files, found
via `git grep` for non-comment matches, not assumed from file names):
`tests/unit/architecture/{full-lite-boundary,onnx-embed-instance-scoping,
phase-8b-step3-ollama-relocation,phase-8b-step4-tag-onnx-relocation,
phase-8b-step7a-shared-core-relocation,phase-8b-step7b-shared-indexer-relocation,
shared-cloud-local-manifest}.test.js`,
`tests/unit/core/{generation/ollama-capability,ollama,onnx-embed-capability}.test.js`,
`tests/unit/indexer/{index-capability-wiring,phases/tag-onnx-capability}.test.js`,
`tests/unit/mcp/server-capability-wiring.test.js`. Each rewrite proves
the same property the original did, against the new implementation shape
— e.g. `onnx-embed-capability.test.js`'s "instance provides every
required method" check now imports `local/core/onnx-embed.js` directly
(with a fake `ortFactory` to stay hermetic) instead of the deleted
wrapper; `full-lite-boundary.test.js`'s "every shim pair exists" check
became "the six shim paths are absent from the graph entirely."

New tests prove exactly what Part G's own checklist requires:
- the six files are physically absent (`existsSync` false, and absent
  from the real AST-parsed graph and from the manifest) —
  `full-lite-boundary.test.js`, `shared-cloud-local-manifest.test.js`,
  `phase-8b-step3/4/7a/7b-*.test.js`;
- no production file contains a live import specifier for any of the six
  old paths (`git grep` swept across `src/`, confirmed zero real
  specifiers remain — only historical/explanatory prose comments, which
  the task's own convention permits);
- Lite's real staged closure never reaches `src/local/` — proven by
  `stageSrc()` + the real five-part closure validator, not a simulation
  (`phase-8b-step3/4-*.test.js`'s own `before(() => stageSrc())` blocks,
  plus a direct `runValidator()` call in the new architecture-relocation
  test suite carried over from Step 7C);
- Full composition roots reach local implementations only through the
  new local factories — `onnx-embed-instance-scoping.test.js`'s
  `index-full.js`/`server-full.js`/`mcp/server.js` describe blocks;
- Full and Lite composition roots constructed in either order in one
  process never contaminate `embeddings.js`'s shared module-scope
  fallback — `onnx-embed-instance-scoping.test.js`'s and
  `phase-8b-step3-ollama-relocation.test.js`'s own "either order" tests
  (unchanged behaviorally, only their capability-construction lines
  updated);
- two ONNX capability instances never share mutable lifecycle state —
  already proven directly against `local/core/onnx-embed.js` by the
  pre-existing `onnx-embed-instance-isolation.test.js` (unaffected by
  this step) and cross-checked again by `onnx-embed-capability.test.js`'s
  updated "instance-scoped" test;
- the Lite tarball contains no local runtime and no shim files — the
  `packages/lite/build.mjs` real staging run (123 files, unchanged count)
  plus a direct `find`-equivalent check of the staged tree (see
  Verification below);
- the build script contains no substitution mechanism — confirmed by
  reading `build.mjs`'s own current source (no `LAZY_SHIM_SUBSTITUTIONS`,
  no `substituteLazyShims`, no per-file content-copy logic anywhere);
- Full ONNX/Ollama/tagging behavior is unchanged — the full `npm test`
  suite (3367/3367) and `npm run smoke` (1316/1316) exercise these paths
  end to end, unaffected in count or outcome by this step.

No behavioral check was replaced by a regex-only substitute — every
rewritten test that previously proved something behaviorally (instance
independence, capability-shape conformance, order-independence) still
does, against the new call target.

## Errors and fixes

**Real regression caught by the existing test suite, not introduced
silently**: the first pass of Part C made `index-full.js`'s three new
`local/` imports **static** top-level imports (mirroring
`server-full.js`'s own static-import style). `npm test` caught this
immediately —
`tests/unit/indexer/index-bootstrap-ordering.test.js`'s "importing
index.js (not as main module) must not mutate any existing env var" test
failed, because `local/core/ollama.js` has its own top-level
`import 'dotenv/config'`, and `indexer/index.js` (the backward-compatible
launcher) does a plain top-level `import './index-full.js'` — a static
import chain would have made merely *importing* `index.js` load dotenv
and gap-fill `process.env` as a side effect, before
`isIndexerMainModule()`'s own guard ever ran, exactly the ordering bug
that test exists to catch (and which a prior code-review round already
fixed once, for the `run.js`/`index.js` split itself). Fixed by moving
the three imports back to dynamic `await import(...)` calls inside
`runFullIndexerComposition()`, restoring the exact ordering guarantee
that held before this step, and updating the three tests that had
(correctly, at the time) come to expect the static form
(`index-capability-wiring.test.js`, `onnx-embed-instance-scoping.test.js`,
`phase-8b-step7b-shared-indexer-relocation.test.js`) back to the dynamic
one. `admin/server-full.js`'s and `mcp/onnx-runtime-resolution.js`'s own
static imports were deliberately left static — neither is ever reached by
a bare top-level `import` the way `index.js` reaches `index-full.js` (both
are always themselves dynamically imported by their own real callers,
`admin/bootstrap.js` and `mcp/server.js`), so no equivalent ordering
hazard exists for them.

**Second real regression, found by external code review (P1)**: the same
class of bug survived in `admin/bootstrap.js`, missed by the fix above
because `bootstrap.js` has no equivalent existing "import-ordering"
regression test the way `indexer/index.js` does. `admin/bootstrap.js`
statically imported `local/core/ollama-capability.js` at its own top
level — which statically imports `local/core/ollama.js`, which runs
`import 'dotenv/config'` and captures `OLLAMA_URL` into a module-scope
constant (`const OLLAMA_URL = process.env.OLLAMA_URL || '...'`) at import
time. Because `bootstrap.js` is the real `npm run admin` entry point
whose own header comment explicitly promises "bootstrap env FIRST (before
any import below could mutate `process.env`)," this static import broke
that exact promise: merely importing `bootstrap.js` (not even running it
as the main module) would gap-fill `process.env` from `.env` before
`bootstrapEnv()` ever ran, and — the more serious half — a
`settings.json`-configured `OLLAMA_URL`, applied via
`applyEnvWriteBack(settingsService)` on line 88, could never actually
reach the real Ollama runtime, since `ollama.js`'s own `OLLAMA_URL`
constant would already be frozen (from a stale env value) by the time the
write-back ran. Fixed the same way as `index-full.js`: moved the
`ollama-capability.js` import to a dynamic `await import(...)`, placed
explicitly after `applyEnvWriteBack(settingsService)` (not merely after
`bootstrapEnv()`, since the write-back is the step that makes a
settings.json override actually visible in `process.env`). Added two new
behavioral tests to `tests/unit/admin/bootstrap.test.js` (neither existed
before, since no prior version of this file had any dynamic-vs-static
import ordering concern):
- a subprocess regression test, mirroring
  `index-bootstrap-ordering.test.js`'s own pattern exactly — imports
  `bootstrap.js` in a fresh child process, NOT as the main module, from a
  temp working directory containing a conflicting `.env` file, and asserts
  zero `process.env` mutations occurred;
- a direct behavioral test proving the fix actually *delivers* the
  correct runtime value, not just that import ordering is structurally
  correct: constructs a real `SettingsService` with an os_env-tier
  `OLLAMA_URL`, calls the real `applyEnvWriteBack()`, dynamically imports
  `ollama-capability.js` only afterward (mirroring `bootstrap.js`'s own
  sequence), and asserts a real `isOllamaReachable()` call (with no
  explicit `baseUrl` argument) actually targets the settings-configured
  host — proving the write-back reaches the real runtime, not a
  pre-bootstrap default.

`admin/server-full.js`'s own static `ollama-capability.js`/`onnx-embed.js`
imports were re-verified against this same concern and confirmed safe:
`admin/bootstrap.js` always dynamically imports `server-full.js` itself
(`await import('./server-full.js')`, after its own bootstrap sequence has
already run), so `server-full.js`'s module graph — including its own
static imports — never evaluates until bootstrap is already complete,
regardless of what `server-full.js` imports statically. The same reasoning
applies to `mcp/onnx-runtime-resolution.js`'s static `onnx-embed.js`
import — it is only ever reached via `mcp/server.js`'s own
already-bootstrapped dynamic-import sequence.

No other errors were encountered — every other test-file update matched
the new implementation shape on the first attempt, verified by running
each affected file individually before moving to the next.

## Verification results (sequential only, no background/parallel test runs)

- `node --check` on all changed/new production files: clean.
- Targeted capability/architecture test files, run individually and then
  together: all pass.
- Full `tests/unit/architecture/*.test.js` suite: 409/409.
- `tests/unit/admin/bootstrap.test.js` (with the two new P1-fix
  regression tests): 7/7.
- `node scripts/audit/find-dependency-violations.mjs`: 0
  dependency-direction violations, 0 shared→cloud edges.
- `node scripts/audit/build-shared-cloud-local-manifest.mjs`: 256 modules
  classified (was 261 — the 6 deleted files minus the 1 new
  `ollama-capability.js`), 0 unclassified; category counts: composition 12
  (unchanged), **mixed 3** (down from 9 — the six former shim entries are
  gone; the 3 remaining are `admin/jobs/spawn-indexer-{full,lite}.js` and
  `indexer/index.js`, pre-existing and unrelated to this step), tooling 61
  (unchanged), cloud 8 (unchanged), shared 144 (unchanged), **local 28**
  (up from 27 — the new `local/core/ollama-capability.js`).
- `node scripts/audit/classify-modules.mjs`: 261 modules classified
  (unchanged from before — this script parses `packages/lite/lite-src/`
  too, which the manifest script above does not), 0 heavy local packages
  reachable from Lite, 0 cloud-imports-local violations.
- `npm test`: 3370/3370 (3367 + the 3 new tests: 2 in
  `bootstrap.test.js`'s new P1-fix describe block plus one new assertion
  in its "resolves the effective ONNX CUDA runtime" block).
- `npm run smoke`: 1316/1316.
- `npm run admin:build`: succeeds, 227 modules transformed (unchanged).
- `npm run admin:build:lite`: succeeds, 226 modules transformed
  (unchanged).
- `node packages/lite/build.mjs`: 123 files staged (unchanged count),
  five-part closure validator clean. Staged tree confirmed to contain
  zero files under `local/` and zero files matching `*-lazy*` anywhere.
- `tests/unit/lite/clean-install-acceptance.test.js`: 6/6 — real
  `npm pack`, clean install into an empty temp directory, package
  directory marked read-only, `semidex-lite doctor`/`semidex-lite serve`
  (responds on `/api/health`) run from the read-only install with zero
  writes into the package directory, `npm ls --all` confirms
  `onnxruntime-node`/`@huggingface/transformers`/`acorn` are absent from
  the installed dependency tree, and every relative import in the
  installed package resolves inside the package root.
- `git diff --check`: exit 0 (only routine LF/CRLF `core.autocrlf`
  warnings, no real whitespace errors).

## Residual limitations

- `admin/jobs/spawn-indexer-full.js`/`spawn-indexer-lite.js` and
  `indexer/index.js` remain classified `mixed` in the manifest — this is
  pre-existing (unrelated to the lazy-shim removal) and out of this
  step's own scope; they are composition-owned spawn-target/launcher
  files, not local/cloud implementation boundaries.
- The one remaining non-literal dynamic reference in the whole import
  graph (`local/core/onnx-runtime.js`'s `require(resolveOnnxRuntimeModule(env))`,
  a genuine runtime resolution of `onnxruntime-node` itself or a
  user-supplied override path) is unrelated to this step and was already
  on the reviewed allow-list before it began.
- Live/manual smoke verification of real Ollama/ONNX/tag-generation
  behavior against a running Ollama instance and a real ONNX model was
  not performed as part of this step (out of scope per the task's own
  "do not run live indexing" constraint) — `npm test`/`npm run smoke`
  exercise these paths with injected fakes/stubs, which is the same
  coverage level these paths had before this step.

## Verdict

`PHASE_8B_STEP8_ACCEPT`
