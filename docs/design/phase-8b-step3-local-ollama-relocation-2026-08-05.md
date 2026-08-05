# Phase 8B Step 3 — physical relocation of the local Ollama implementation

Implementation report for Phase 8B Step 3 of the Phase 8 migration plan
laid out in
[`phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`](phase-8a-shared-cloud-local-migration-audit-2026-08-02.md)
§7 ("Step 3 — Physically relocate the Ollama generation/context runtime").
Builds directly on Step 2's own precedent
([`phase-8b-capability-contracts-and-composition-seams-2026-08-02.md`](phase-8b-capability-contracts-and-composition-seams-2026-08-02.md)
§12, the ONNX embedding runtime relocation) and on Step 1's capability
contracts. **Nothing was committed** — this is the working-tree state at
the end of this step's own session.

## 1. What moved, and what deliberately did not

**Physically relocated** (`git mv`, history preserved):

| Old path | New path |
|---|---|
| `src/core/ollama.js` | `src/local/core/ollama.js` |
| `src/core/ollama-models.js` | `src/local/core/ollama-models.js` |

**Deliberately NOT moved**, despite appearing in this plan's own original
Step 3 file list (`core/ollama.js`, `core/ollama-models.js`,
`admin/system/ollama.js`, `admin/api/ollama-models.js`):

- `src/admin/system/ollama.js` — a thin readiness-check wrapper
  (`checkOllama()`) used only by the indexer job-preflight check
  (`admin/api/jobs.js`, injected via `checkOllamaFn` DI). It imports
  `local/core/ollama.js`'s three primitives but contains no Ollama protocol
  logic of its own.
- `src/admin/api/ollama-models.js` — a thin HTTP route handler
  (`GET /api/ollama-models`) wrapping `local/core/ollama-models.js`'s
  `discoverOllamaModels()`.

Both are genuine **orchestration/route** files, not implementation — moving
them would have violated the task's own explicit constraint ("Не перенось
orchestration, доменні контракти або загальні generation abstractions
тільки через те, що зараз вони викликають Ollama"). Both are already
correctly classified `local` by `classify-modules.mjs`, via their own
dependency edge onto the real implementation — classification does not
require physical co-location.

**Also confirmed to require no change** (contract/registry files, per the
same audit that motivated Step 2):

- `src/core/generation/ollama-provider.js` — a `GenerationProvider`
  registered unconditionally in `generation/registry.js`'s `BACKENDS` map,
  so it must stay staged in Lite regardless of edition. Contains **zero**
  import of `ollama.js`/`ollama-lazy.js` — its five `*Fn` options default to
  typed-unavailable stubs, with the real functions supplied only by
  `admin/bootstrap.js` (Full-only).
- `src/core/generation/ollama-capability.js` — the four capability
  contracts (`OllamaGenerateCapability`/`OllamaSummaryCapability`/
  `OllamaEmbedCapability`/`OllamaDiscoveryCapability`), zero backend
  imports.
- `src/core/ollama-lazy.js` (the seam) stays in `src/core/` — mirrors
  `onnx-embed-lazy.js` staying in `core/` after Step 2. Only its own
  dynamic-import specifier changed.

## 2. Composition seams changed

### 2.1 The physical-move seam (mirrors Step 2 exactly)

`core/ollama-lazy.js`'s `await import('./ollama.js')` became
`await import('../local/core/ollama.js')` — the one legitimate `shared →
local` edge, by design (the seam Step 1 built and Step 8 will eventually
retire). No other file needed to know the physical location of
`ollama.js`/`ollama-models.js` beyond this one specifier.

### 2.2 The deeper seam: five indexer phase modules converted from
module-scope setters to instance-scoped injection

This went beyond a pure path rename, per explicit direction during this
step's own work. Phase 8B Step 1 gave `context.js`/`tag.js`/`combined.js`/
`skeleton-summary.js`/`preflight.js` each a module-scope `let _ollama =
null` binding, populated once via an `apply*Capability()` setter called
from `indexer/run.js`'s own `applyAllCapabilities()`. This technically
violated "жодного mutable module-scope capability state" — even though the
real process topology (the indexer CLI is always a single edition per OS
process; the admin server and MCP never import these five files at all)
made cross-contamination a **latent**, not **live**, risk. Audited and
confirmed: no test or production code path ever constructs a Full and a
Lite *indexer* composition in the same process — that scenario is
structurally impossible today (each edition has its own entry point,
`index-full.js`/`index-lite.js`, each its own spawned child process). The
concrete, TESTED concurrency scenario in this codebase is Full+Lite
**admin-server** composition (`createApp()`/`createLiteApp()`), which
never touches these five files.

Converted anyway, per explicit instruction not to rely on process isolation
as a substitute for correct DI:

| File | Old shape | New shape |
|---|---|---|
| `phases/context.js` | `addContext(chunk)` — module-scope `_ollama` | `addContext(chunk, { ollama })` — required param |
| `phases/tag.js` | `addTags(chunk)`, `addTagsWithModel(chunk, model)`, `addTagsBatch(chunks)` | same signatures + `opts` param carrying `{ ollama }`, threaded through internally (`addTagsBatch` → `addTags` → `addTagsWithModel`) |
| `phases/combined.js` | `addContextAndTags(chunk, model, chunks)` | `addContextAndTags(chunk, model, chunks, { ollama })` — same `opts` object threaded unchanged into its own fallback `addContext()`/`addTagsWithModel()` calls |
| `phases/skeleton-summary.js` | `opts.generateFn` already existed (Phase 4-era) with a module-scope fallback (`generate`/`getModelContextLength`/`isThinkingModel`) | `opts.generateFn` now **required** (no fallback); `opts.getModelContextLengthFn`/`opts.isThinkingModelFn` added as explicit optional overrides; `resolveRunNumCtx()`'s `skipGetModelContextLength: boolean` became a real `getModelContextLengthFn` parameter |
| `preflight.js` | `checkOllamaPreflight(url, ctxModel, tagModel)` — module-scope `_ollama` | `checkOllamaPreflight(url, ctxModel, tagModel, capability)` — required 4th param; `ensureOllamaPreflight()` gained the same param |

Every `apply*Capability()` function in these five files was **removed
entirely** — there is no longer any module-scope Ollama binding anywhere in
`phases/context.js`, `phases/tag.js`, `phases/combined.js`,
`phases/skeleton-summary.js`, or `preflight.js` for a concurrent
composition to contaminate. Not a whole "ollama" container object passed
around either — each function receives only the narrow slice it needs
(`OllamaGenerateCapability` for context/tag/combined, individual
`generateFn`/`getModelContextLengthFn`/`isThinkingModelFn` functions for
skeleton-summary, `OllamaDiscoveryCapability` for preflight), per the
task's own "не передавай цілий composition container" instruction.

### 2.3 `indexer/run.js` — the real instance-scoped owner

**This section was rewritten after a second code-review pass rejected the
design first shipped here.** The first version gave `run.js` a "run-scoped
snapshot": module-scope `let` bindings for each capability, copied into a
SECOND module-scope `let` (`_activeRunEmbedCapabilities`/
`_activeRunOllamaCapabilities`) at the top of `run()` and cleared in
`finally`. That is still module-scope mutable state — two genuinely
concurrent `run()` calls in one process still race on it: Run A writes its
snapshot, Run B overwrites it with its own, Run A silently starts reading
Run B's capabilities, Run B finishes and clears the snapshot, Run A falls
back to whatever the live bindings happen to be — the exact "last call
wins" failure the original task required eliminating, just with a smaller
window. `tagOnnx` was worse: it was never even snapshotted — `stageB` read
a live module-scope `_tagOnnx` directly, and `run()`'s cleanup could shut
down a DIFFERENT run's in-flight worker. The review's existing "construct
in either order" test could not have caught this: it only ever set one
snapshot via a test-only setter and called another setter afterward,
without ever running two overlapping calls — see §6 for how the
replacement test closes that gap.

The fix removes every module-scope capability binding from `run.js` —
`applyRunCapabilities()`, `applyAllCapabilities()`, `embedCapabilities()`,
`ollamaCapabilities()`, `_activeRunEmbedCapabilities`,
`_activeRunOllamaCapabilities`, and every `__setActiveRun*ForTest()`
test-only setter are all **gone**. In their place, `run({ capabilities })`
builds one plain object and holds it as a **local `const`**, threaded as a
real parameter through every downstream call — never stored anywhere a
second call could reach it:

```js
function buildRunContext({ ollamaGenerate, ollamaSummary, ollamaEmbed, ollamaDiscovery, onnxEmbed, tagOnnx } = {}) {
  validateOllamaGenerateCapability(ollamaGenerate);
  validateOllamaSummaryCapability(ollamaSummary);
  validateOllamaEmbedCapability(ollamaEmbed);
  validateOllamaDiscoveryCapability(ollamaDiscovery);
  validateOnnxEmbedCapability(onnxEmbed);
  validateTagOnnxCapability(tagOnnx);
  return { ollamaGenerate, ollamaSummary, ollamaEmbed, ollamaDiscovery, onnxEmbed, tagOnnx };
}

export async function run({ capabilities }) {
  const ctx = buildRunContext(capabilities);
  try {
    await main(ctx);
  } finally {
    // Always THIS call's own ctx.tagOnnx — never a shared binding a
    // concurrent run() could have replaced.
    await ctx.tagOnnx.shutdownOnnxTagWorker();
  }
}
```

`ctx` is passed explicitly into `main(ctx)`, and from there into
`stageA(filePath, rootPath, collection, profiler, ctx, reporter)`,
`stageB(prepared, ctx, ollamaSem, reporter)`, and
`stageC(withTagged, ctx, reporter)` — each stage destructures only the
slice it needs off `ctx` (e.g. `stageB` reads `ctx.ollamaGenerate`,
`ctx.ollamaSummary`, `ctx.tagOnnx`). No function anywhere in `run.js`
resolves a capability from a module-scope binding; every call site receives
it as a real argument on its own call stack. Two concurrently-executing
`run({ capabilities })` calls in one process therefore close over two
independent `ctx` objects with zero shared mutable state — not "a narrower
window for the race," but no race at all.

`index-runtime.js`'s `runIndexerCli()` was changed to match: it now calls
`run({ capabilities })` directly, in one step, rather than first mutating
`run.js`'s module state via `applyAllCapabilities(capabilities)` and then
invoking a bare `run()` — that two-step *shape* at the caller boundary
could reintroduce the same bug class even after `run.js`'s own internals
were fixed, since a second composition root's own call could still
interleave between the mutate and the call.

A real, previously-latent `ReferenceError` bug was found and fixed as a
byproduct of this refactor: `stageB` used `ollamaGenerate`, `ollamaSummary`,
and `tagOnnx` as bare identifiers in roughly a dozen places but never
declared them in its own scope (a leftover from the module-scope-binding
design, where they resolved as globals). Any real execution path through
`SKELETON_SUMMARY=llm`, LLM-backed tagging, or ONNX-tag-parallel mode would
have thrown at runtime — masked because no prior test exercised those exact
lines with real, non-early-returning execution. Fixed by `stageB`
destructuring `const { ollamaGenerate, ollamaSummary, tagOnnx } = ctx;` at
its own top, which is also what makes those three slices real,
instance-scoped values rather than global lookups.

### 2.4 A real, previously-latent bug found and fixed along the way

`src/backfill-tags.js` (a Full-only CLI tooling script, separate from
`indexer/run.js`) calls `addTagsBatch()` but **never called any
capability-setting function** — under the old Step 1 design this meant a
non-ONNX backfill run would throw `"no ollama capability injected"` the
moment it actually ran (confirmed: zero test coverage existed for this
script). Fixed as part of this step (since `addTagsBatch()`'s own call
shape changed anyway): the script now imports `core/ollama-lazy.js`
directly (mirroring `index-full.js`'s own composition pattern) and passes
`{ ollama: ollamaLazy }` explicitly.

## 3. Shims/substitutions removed or kept, and why

- **Removed**: `packages/lite/build.mjs`'s `EXCLUDE_FILES` entries for
  `'core/ollama.js'` and `'core/ollama-models.js'` — both are now covered
  by the existing `'local'` `EXCLUDE_DIRS` entry (introduced in Step 2),
  since both files physically live under `src/local/core/` now. No new
  exclusion mechanism was added; this is a net reduction in
  `EXCLUDE_FILES`'s line count.
- **Kept, unchanged**: `core/ollama-lazy.js` / `core/ollama-lazy.lite.js` —
  still the one seam separating shared code from the local implementation.
  The `.lite.js` sibling remains dead code (per Phase 8B Step 1 round 4's
  own finding: `packages/lite/build.mjs` no longer does any `*-lazy.js`
  content substitution at all), left in place rather than deleted, same
  policy as Step 2 applied to `onnx-embed-lazy.lite.js`.
- **No new shim, substitution, or allow-list exception was added anywhere**
  — the closure validator's own rules, the module classifier's
  `LOCAL_ONLY_PATH_PATTERNS`, and `find-dependency-violations.mjs`'s
  direction rules are all unchanged in *logic*, only in the specific paths
  two of their existing entries point at.

## 4. Import graph — before/after

Real importers found via `rg` and cross-checked against
`scripts/audit/build-import-graph.mjs`'s AST-based graph (not assumed from
this task's own suggested file list):

| Importer | Old specifier | New specifier |
|---|---|---|
| `core/ollama-lazy.js` | `./ollama.js` | `../local/core/ollama.js` |
| `src/local/core/ollama-models.js` (moved with it) | `./ollama.js` | `./ollama.js` (unchanged — same directory) |
| `admin/system/ollama.js` | `../../core/ollama.js` | `../../local/core/ollama.js` |
| `admin/api/ollama-models.js` | `../../core/ollama-models.js` | `../../local/core/ollama-models.js` |
| `admin/server-full.js` | `../core/ollama-models.js` | `../local/core/ollama-models.js` |
| `mcp/tools/collections.js` | `../../core/ollama.js` | `../../local/core/ollama.js` (Full-only, MCP is entirely excluded from Lite — direct static import is safe, same precedent as `admin/system/ollama.js`) |
| `smoke/sections/18-validate-ollama-models.js` | `../../core/ollama.js` | `../../local/core/ollama.js` |
| `backfill-tags.js` | (none — the gap, §2.4) | `./core/ollama-lazy.js` (new) |
| 6 benchmark scripts (`benchmarks/retrieval/{tag-model-bench,tag-batch-fallback-diagnostic,legacy-merge,combined-prompt-policy-bench,combined-parser-stability-diagnostic,combined-context-tags-probe}.js`) | `../../src/core/ollama.js` | `../../src/local/core/ollama.js` |
| 2 test files (`tests/unit/core/{ollama,ollama-models}.test.js`) | `../../../src/core/ollama*.js` | `../../../src/local/core/ollama*.js` |

A repo-wide, real-path-resolution scan (resolving every relative
import/require specifier against its importing file's own directory, not a
segment-text heuristic) confirmed **zero** remaining specifiers resolving to
the old `src/core/ollama.js`/`src/core/ollama-models.js` locations, across
`src/`, `benchmarks/`, and `scripts/`.

## 5. Evidence of absence from Lite

- **Physical**: `packages/lite/build.mjs`'s real `stageSrc()` (not a
  simulation) stages zero files under `local/` — the whole directory does
  not exist in the staged tree. Neither `ollama.js` nor `ollama-models.js`
  is staged under any path.
- **Reachability, PRE-shim**: `computeReachable(graph, liteRoots,
  { applyLiteShims: false })` never reaches `src/local/core/ollama.js` or
  `src/local/core/ollama-models.js` — proven with no build-time
  substitution involved at all.
- **Reachability, POST-shim**: identical to PRE-shim (both zero) — nothing
  left for a shim substitution to do, matching Step 1 round 4's own finding
  for the other two shims.
- **Importer classification**: every real static/dynamic importer of
  `local/core/ollama.js`/`local/core/ollama-models.js` is Full-reachable
  and NOT Lite-reachable — checked programmatically against the graph, not
  asserted.
- **Manifest**: `local/core/ollama.js` and `local/core/ollama-models.js`
  are both classified `local` (not `shared`, `mixed`, or `unclassified`).
- **No shared/cloud module has a direct dependency on `src/local/**`** —
  checked across every `shared`/`cloud`-classified module's own
  `directDependencies` list in the generated manifest; the one exception
  (`core/ollama-lazy.js`, classified `mixed` — the deliberate boundary
  itself) is explicitly asserted as the ONE documented exception, not
  silently exempted.
- **Lite package UI/CLI**: no `localhost:11434` string, no Ollama-specific
  UI control, ever ships in the Lite admin UI bundle (already covered by
  the pre-existing `ui-build-dce.test.js` marker scan, unaffected by this
  move — Ollama UI logic lives in `local-features.js`, statically imported
  only by `entries/full.js`, confirmed unchanged); Lite's CLI hard-pins
  `SEMIDEX_GENERATION_BACKEND=gemini` before `bootstrapEnv()` runs, so
  `discoverOllamaModels`/Ollama discovery/preflight are never invoked
  regardless of reachability.
- **Clean-install acceptance** (real `npm pack` + real install into a
  fresh, read-only directory): `npm ls --all` confirms no local-runtime
  package present; `doctor`/`serve` run correctly against the installed
  package with zero Ollama-related errors or attempted connections.

## 6. Test results

| Check | Result |
|---|---|
| `node --check` on every changed `.js`/`.mjs` file | clean |
| `node --test --test-concurrency=1` — `phase-8b-step3-ollama-relocation.test.js`, `full-lite-boundary.test.js`, `lite-lazy-shim-necessity.test.js`, `shared-cloud-local-manifest.test.js` | 55/55 pass |
| Narrow Ollama-touching suite (`ollama.test.js`, `ollama-models.test.js`, `generation/ollama-provider.test.js`, `generation/ollama-capability.test.js`, `admin/system.test.js`, `admin/api/ollama-models.test.js`, `ollama-lazy-lite-shim.test.js`, `lazy-shim-backward-compat.test.js`, `phase-capability-injection.test.js`, `index-capability-wiring.test.js`) | 138/138 pass |
| `node scripts/audit/classify-modules.mjs` | Full-reachable 232, Lite-reachable 143 (PRE- and POST-shim identical), 0 heavy-package-reachable-from-Lite, 0 cloud-imports-local violations |
| `node scripts/audit/build-shared-cloud-local-manifest.mjs` | 243 modules, category counts: shared 111, mixed 41, local 16, composition 10, tooling 61, cloud 4 |
| `node scripts/audit/find-dependency-violations.mjs` | 0 dependency-direction violations, 0 shared→cloud edges |
| `npm run admin:build` | succeeds |
| `npm run admin:build:lite` | succeeds |
| `node packages/lite/build.mjs` | OK — 117 files staged, closure validated clean |
| `npm test` | **2804/2804** pass |
| `npm run smoke` | 1316/1316 pass |
| `git diff --check` | clean (exit 0; only pre-existing CRLF-normalization warnings) |

Note: `run-embed-capability-snapshot.test.js`, previously listed here, was
**deleted** — its entire premise was testing the module-scope
`embedCapabilities()`/`applyRunCapabilities()`/
`__setActiveRunEmbedCapabilitiesForTest()` snapshot mechanism removed in
§2.3; there is nothing left in `run.js` for that file to test.

New regression test, `tests/unit/architecture/phase-8b-step3-ollama-relocation.test.js`
(15 tests), proves: old paths gone / new paths exist; no production import
specifier anywhere resolves to the old path (using real path resolution
against each importing file's own directory — NOT a segment/regex
heuristic, since that class of check has a real blind spot for
same-directory relative imports like `./ollama.js`, discovered and fixed
during this step's own work); Lite's real staged tree contains zero files
under `local/`; Lite's import graph never reaches the Ollama
implementation, PRE- and POST-shim identically; only Full-reachable files
import the moved files; shared/cloud manifest modules never depend on
`src/local/**` directly (with the one documented `mixed`-classified
exception); the classifier labels the moved files `local`; and
`createApp()`/`createLiteApp()` construct correctly in BOTH orders in one
process with `core/embeddings.js`'s own module-scope fallback provably
uncontaminated by either order.

Verified this new test's core "no stale path" check genuinely catches a
regression, not just passes trivially: deliberately reverted
`ollama-lazy.js`'s import specifier back to `./ollama.js`, confirmed the
test failed naming the exact file and specifier, restored the fix,
reconfirmed all 15 green. Applied the same path-resolution fix
retroactively to `phase-8b-step2-local-relocation.test.js`'s own equivalent
check, which had the identical latent blind spot (never triggered there,
since the ONNX seam's specifiers were correct from the start) — now both
Step 2's and Step 3's regression tests use real path resolution instead of
a segment-text heuristic.

### 6.1 The concurrency test, specifically (second code-review pass)

The reviewer's own P2 finding on the first pass named the exact flaw: the
"construct in either order" test in
`phase-8b-step3-ollama-relocation.test.js` only ever set one module-scope
snapshot via `__setActiveRunOllamaCapabilitiesForTest()` and then called
`applyRunCapabilities()` afterward — it never ran two genuinely overlapping
`run()` calls, so it structurally could not observe the "last call wins"
race it appeared to guard against. That test-only setter no longer exists;
the misleading test was **removed**, not reimplemented against a design
that no longer exists.

Its real behavioral replacement lives in
`tests/unit/indexer/phase-capability-injection.test.js`, split across two
describe blocks, each proving a different, genuine claim:

- **"TWO real concurrent `run()` calls each clean up only their OWN
  `tagOnnx` worker"** — two actually-overlapping `run({ capabilities })`
  calls (via `Promise.allSettled`), each with a distinguishable fake
  `tagOnnx.shutdownOnnxTagWorker()`, driven to a real, fast rejection
  (`main()`'s own path-validation throw, before any Qdrant call — no live
  server needed) and asserting each call's own `finally` block invoked
  exactly its own capability's cleanup, never the other's.
- **"`stageB(prepared, ctx, ...)` — two overlapping calls with distinct ctx
  objects never cross-read each other's capability"** — calls the same
  `stageB()` function `main()` itself calls, directly, with two distinct
  `ctx` objects and a REAL interleaving: the slower call's `ctx.
  ollamaGenerate.generate()` is deliberately held open (via a gated
  promise) while the faster call's own, different `ctx.ollamaGenerate` is
  used and fully resolves — then the slow call is released and asserted to
  have resolved against its own original `ctx`, unaffected by the faster
  call having already completed with a different one. This is the test
  that actually exercises `ollamaGenerate` isolation under real
  concurrency (a third code-review pass flagged an earlier version of the
  `run()`-level describe block for carrying a second test that CLAIMED to
  prove this but could not — both overlapping `run()` calls died at the
  path-validation throw before `ollamaGenerate` was ever touched; that test
  was removed as a misleadingly-named duplicate of the `tagOnnx` test next
  to it, not reimplemented, since driving two real `run()` calls all the
  way through `main()`'s own `listCollections()` call and into `stageB()`
  would require either a live Qdrant server or a DI seam `main()` does not
  currently expose).

Together these two tests cover what the original review demanded: real
overlapping calls (not a simulation), separately-tracked capabilities
(`tagOnnx` at the `run()` level, `ollamaGenerate` at the `stageB()` level —
the same function `run()`'s own call chain reaches), and correct per-call
cleanup.

## 7. Lite tarball size — small increase, explained

| Metric | Baseline (pre-Step-3) | After Step 3 |
|---|---|---|
| Packed size | 413.9 kB | 415.0 kB |
| Unpacked size | 1.4 MB | 1.4 MB |
| Total files | 129 | 129 |
| Staged `src/` files (`build.mjs`) | 117 | 117 |

File count is byte-identical. The ~1.1 kB packed-size increase is
attributable entirely to more precise documentation added to files that
were ALREADY staged in Lite before this step
(`admin/composition/lite.js`, `core/embeddings.js`,
`core/generation/ollama-provider.js`, `core/generation/ollama-capability.js`,
and the five converted phase modules' own header comments explaining the
new instance-scoped design) — no new file was added to the tarball, and no
existing file's functional content changed size meaningfully. This is
consistent with (not a regression from) the byte-for-byte-identical file
list and closure-validation result.

## 8. Known limitations / carried-forward items

- **Step 4** (physically relocating `indexer/phases/tag-onnx.js` and
  `indexer/workers/tag-onnx-worker.js`) has **not** been executed. Per
  Phase 8A's own §9 risk note, this is the one remaining step with real
  behavioral risk beyond a mechanical path rename — the persistent-worker
  lifecycle and its production-incident-derived always-safe-no-op
  `shutdownOnnxTagWorker()` contract must be preserved exactly.
- **Three transitional lazy seams remain** (`core/ollama-lazy.js`,
  `core/onnx-embed-lazy.js`, `indexer/phases/tag-onnx-lazy.js`) — not
  scheduled for removal until Step 8, once every remaining consumer
  (currently none — all five former phase-file consumers of
  `ollama-lazy.js`-shaped defaults are now instance-scoped) is confirmed
  migrated and the physical moves (Step 4) are complete.
- **The pre-existing drift-test gap** for `full-lite-module-inventory.json`/
  `full-lite-reachability-summary.json`/`full-lite-import-graph.json`
  (no automated byte-for-byte check, unlike
  `full-lite-module-classification.json`'s own drift test) — carried
  forward from Step 2's own report, still not fixed (out of this step's
  scope). All three were manually regenerated and confirmed current as of
  this report.
- **`admin/system/ollama.js`/`admin/api/ollama-models.js` remain
  physically at their original `admin/` paths** — a deliberate scope
  narrowing from this plan's original Step 3 file list, not an oversight
  (see §1).

## 9. Verdict

**PHASE_8B_STEP3_ACCEPT**

All acceptance criteria met: the Ollama implementation is physically under
`src/local/`; the old `src/core/ollama.js`/`src/core/ollama-models.js`
paths no longer exist and no production import resolves to them; no
compatibility re-export was added at the old path; `run.js` holds **no
module-scope capability state of any kind** — `run({ capabilities })`
builds a local `const ctx` (`buildRunContext()`) and threads it explicitly
through `main`/`stageA`/`stageB`/`stageC`, including `tagOnnx` (previously
excluded from any snapshot at all), with cleanup bound to exactly the
calling run's own `ctx.tagOnnx` — the module-scope "run-scoped snapshot"
design this section originally shipped with (`applyRunCapabilities()`/
`ollamaCapabilities()`/`_activeRunOllamaCapabilities`) was rejected on a
second review pass for still being module-scope mutable state subject to
the same "last call wins" race under real concurrency, and has been
completely removed — see §2.3; Lite physically excludes and structurally
never reaches the Ollama runtime (proven via the real staged tree and the
real import graph, not assumption); the closure validator and module
classifier were not weakened — two `EXCLUDE_FILES` entries became
redundant and were removed, not replaced with a weaker check; Full and Lite
composition roots construct correctly in either order in one process with
no capability cross-contamination (the embed lane, via
`core/embeddings.js`'s own module-scope fallback); two REAL,
genuinely-overlapping `run()` calls prove per-call `tagOnnx` cleanup
isolation, and two REAL, genuinely-overlapping `stageB()` calls (the same
function `run()`'s own call chain reaches) prove per-call `ollamaGenerate`
isolation under an actual interleaving — not a simulated snapshot swap
(§6.1); Full, Lite, unit (2804/2804), smoke (1316/1316), both admin UI
builds, and the Lite package build are all green. Nothing was committed.
