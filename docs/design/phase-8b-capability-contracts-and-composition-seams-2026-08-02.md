# Phase 8B Step 1 — capability contracts and composition seams

Implementation report for Phase 8B Step 1 of the Phase 8 migration plan
laid out in
[`phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`](phase-8a-shared-cloud-local-migration-audit-2026-08-02.md)
§7 ("Step 1 — Introduce contracts/composition seams, zero file moves").
No production files were physically moved. The three lazy shims
(`core/ollama-lazy.js`, `core/onnx-embed-lazy.js`,
`indexer/phases/tag-onnx-lazy.js`) and their `.lite.js` counterparts were
**not removed** — they remain the real, working transitional compatibility
path, exactly as this step's scope requires. Nothing was committed.

## 0. Code review fixes (applied after the initial implementation)

A code review of the first version of this step found 3 real defects.
All 3 are fixed in the version this report now describes; the sections
below already reflect the fixed state.

- **[P1] `applyAllCapabilities()` was never called in production.** The
  function existed and was fully tested, but nothing outside tests ever
  invoked it — the indexer CLI (`indexer/index.js`) kept relying entirely
  on each phase module's implicit `*-lazy.js` default. **Fixed**:
  `indexer/index.js`'s `isMainModule` branch now dynamically imports
  `core/ollama-lazy.js`, `core/onnx-embed-lazy.js`,
  `indexer/phases/tag-onnx-lazy.js` and calls
  `applyAllCapabilities({ ollamaGeneration, ollamaEmbed, ollamaDiscovery, onnxEmbed, tagOnnx })`
  explicitly, after `applyAllSettings()` and before `run()` — the same
  three modules every phase file already defaulted to, so behavior is
  unchanged, but Full's composition choice is now a real, explicit call
  instead of an unexercised default. See §4 and §11 below.
- **[P1] `admin/composition/lite.js` mutated shared process-wide state at
  module import time.** `applyEmbeddingCapabilities({...unavailable})` ran
  as a top-level side effect — merely IMPORTING the file (not calling
  `createLiteApp()`) permanently reconfigured `core/embeddings.js`'s
  module-scope `_ollama`/`_onnxEmbed` bindings for the rest of the
  process. In any hypothetical process that imports both this module and
  Full's `server-full.js`, importing Lite's composition module alone
  would have silently poisoned Full's real capability out from under it.
  **Fixed**: the `applyEmbeddingCapabilities()` call moved inside
  `createLiteApp()` itself — "Lite's capability choice takes effect" and
  "`createLiteApp()` was actually invoked" are now the same event,
  matching every other composition decision that function already makes
  (adapter, jobPolicy, route registration). See §4 below; regression-tested
  by `tests/unit/admin/composition-capability-wiring.test.js`'s new
  "merely importing... does NOT mutate shared capability state" case.
- **[P2] `OllamaCapability` was not a narrow contract.** The first version
  copied all 9 of `ollama-lazy.js`'s exports into one shape, so every
  consumer and every future stub had to implement methods it never
  called (`embeddings.js` implementing `generateStream`; `preflight.js`
  implementing `embed`). **Fixed**: split into 3 narrow contracts —
  `OllamaGenerationCapability`, `OllamaEmbedCapability`,
  `OllamaDiscoveryCapability` — each consumer now depends on only the
  slice it actually calls. See §3 below for the full breakdown.

### Round 2 (a second code review pass)

Found 2 more real defects and 1 already-correctly-scoped observation
worth documenting explicitly. Fixed the 2 defects; addressed the
observation with clarifying documentation only (no code change needed —
see its own entry below for why).

- **[P1] `createLiteApp()` still permanently mutated shared global state
  — with no way for Full to recover it.** Round 1's fix (moving
  `applyEmbeddingCapabilities()` inside `createLiteApp()`) closed the
  "merely importing poisons Full" bug, but left a real, live gap:
  `core/embeddings.js`'s `_ollama`/`_onnxEmbed` bindings are still
  process-wide singleton state, and nothing in `createApp()` (Full's own
  composition root) ever reasserted the real capability. A process that
  calls `createLiteApp()` and THEN `createApp()` — which genuinely
  happens today in `tests/unit/admin/register-neutral-routes.test.js`,
  not a hypothetical — would leave Full permanently stuck on Lite's
  typed-unavailable rejection for the rest of the process, with no code
  path that ever restored the real one. **Fixed**: `createApp()`
  (`src/admin/server-full.js`) now also explicitly calls
  `applyEmbeddingCapabilities({ ollama: ollamaLazy, onnxEmbed: onnxEmbedLazy })`
  as its own first statement — the exact same real modules
  `embeddings.js` already defaulted to, so Full's behavior is unchanged,
  but the two composition roots are now symmetric: each unconditionally
  asserts its own capability every time it runs, so whichever one runs
  LAST in a shared process is what's in effect (ordinary "last call
  wins" semantics, not silent one-directional poisoning). Every real
  production process still calls exactly one of `createApp()`/
  `createLiteApp()`, exactly once (confirmed by checking
  `admin/bootstrap.js`'s and `serve-lite.js`'s own real call sites) — this
  fix only matters for a process that constructs both, which today means
  tests. Regression-tested by a new
  `tests/unit/admin/composition-capability-wiring.test.js` case
  ("Lite -> Full ordering in one process") that calls `createLiteApp()`
  then `createApp()` and asserts the real capability is back in effect
  afterward — verified to actually catch the regression by temporarily
  reverting the fix and re-running (failed exactly as expected, restored
  and reconfirmed green).
- **[P2, continued] `OllamaGenerationCapability` (round 1's 4-method
  contract) was STILL wider than individual consumers needed.**
  `context.js`/`tag.js`/`combined.js` each call ONLY `generate()` —
  never `generateStream`/`getModelContextLength`/`isThinkingModel`.
  `skeleton-summary.js` calls `generate()`/`getModelContextLength()`/
  `isThinkingModel()` but never `generateStream()`. Checked directly
  (grepping every real capability-object call site in `src/`, not
  assumed) that `generateStream()` is called through NO capability
  object anywhere — its one real consumer, `ollama-provider.js`, already
  has its own separate, working per-method DI (`generateStreamFn`)
  unrelated to these shared contracts. **Fixed**: split further into
  `OllamaGenerateCapability` (`generate` only — used by `context.js`,
  `tag.js`, `combined.js`) and `OllamaSummaryCapability` (`generate`,
  `getModelContextLength`, `isThinkingModel` — used by
  `skeleton-summary.js`); `generateStream` was removed from every
  contract, since no contract consumer needs it. `applyAllCapabilities()`
  now takes `ollamaGenerate`/`ollamaSummary` as two separate parameters
  instead of one `ollamaGeneration` blob. See §3 for the full 4-contract
  breakdown.
- **[Observation, not a defect] The dependency graph itself is still NOT
  physically cut by this step — correctly, by the task's own design.**
  A review correctly noted that `indexer/index.js` now directly imports
  all three `*-lazy.js` modules, and
  `tests/unit/architecture/lite-lazy-shim-necessity.test.js` still
  correctly reports all three shims as `KEEP` — i.e. the physical
  reachability graph from Lite's entry points still includes
  `core/ollama.js`/`core/onnx-embed.js`/`indexer/phases/tag-onnx.js`,
  gated only by the shim's build-time content substitution, exactly as
  before this step. **This is expected, not a regression**: Phase 8B
  Step 1's own scope (per the original task and per Phase 8A's own
  staged plan) is explicitly to add contracts and injection SEAMS without
  moving files or cutting the graph — graph-cutting is Phase 8's later
  physical-relocation steps (Step 2+) and shim removal is Step 8. This
  report never claimed otherwise; §9 and §10 already documented the
  shims as fully retained and load-bearing. Restated here explicitly
  because the distinction between "a capability CONTRACT exists" and "the
  physical import graph no longer contains the local file" is easy to
  conflate, and is worth being unambiguous about for anyone skimming this
  report expecting Step 1 to have narrowed the Lite tarball's closure —
  it has not, and was never meant to.

### Round 3 (a third code review pass)

Found that round 2's fix ("createApp()/createLiteApp() each reassert
their own capability every time they run, so whichever runs LAST wins")
was still not real isolation — only a safer ordering convention on top
of the same shared mutable singleton. Two composition roots constructed
concurrently, or interleaved with async work between construction and a
request, could still observe the wrong capability. Fixed by introducing
a genuine per-call isolation mechanism instead of relying on shared
state at all.

- **[P1] `core/embeddings.js` gained a real per-call `capabilities`
  parameter.** `embedForIndex`, `embedForIndexBatch`, and `embedForSearch`
  now accept an optional `{ capabilities: { ollama, onnxEmbed } }` — when
  supplied, THAT call dispatches through exactly those objects, never
  touching the module-scope `applyEmbeddingCapabilities()` fallback at
  all. Omitted fields still fall back to the module-scope default, so
  every pre-existing caller (any test or tool that hasn't been updated)
  is unaffected. This is the actual fix: two callers holding different
  capability objects can now run concurrently in one process with zero
  interference, which "last call wins" could never provide regardless of
  how many composition roots reasserted themselves.
- **`indexer/run.js`** (the one real caller of `embedForIndex`/
  `embedForIndexBatch`) now resolves its own `_ollama`/`_onnxEmbed`
  (already module-scope state in that file, unchanged) and passes
  `{ capabilities: { ollama: _ollama, onnxEmbed: _onnxEmbed } }`
  explicitly to all 6 of its own embed call sites, via a small
  `embedCapabilities()` helper that always reads the CURRENT value (so a
  later `applyRunCapabilities()` call still takes effect for the next
  indexing call). `applyRunCapabilities()` gained an `onnxEmbed`
  parameter (previously tracked only `ollama`/`tagOnnx`) so `run.js` can
  hold a complete capability pair of its own.
- **`admin/server-full.js`'s `createApp()` and `admin/composition/lite.js`'s
  `createLiteApp()`** each now build their own bound `embedQuery` closure
  — `embedQuery ?? ((profile, query) => embedForSearch(profile, query, { capabilities: <own> }))`
  — captured BY VALUE at construction time, and pass it into
  `registerNeutralRoutes()` (which already threads `embedQuery` through
  to both `registerSearchRoutes()` and `createAskCoordinator()` — Ask is
  covered for free, no separate change needed). `embedQuery` was already
  real, pre-existing DI on both factories; the fix is that when the
  CALLER doesn't override it, each factory's OWN internal default is now
  bound to its own capability object instead of falling through to
  `embedForSearch`'s bare module-scope default.
- **`mcp/server.js`** — the same fix, via a new `setEmbedQuery()` seam
  added to `mcp/tools/search.js` (mirrors that file's existing
  `setStorageAdapter()`/`setSettingsService()` module-level-override
  convention, since `runHybridSearch()`'s `embedQuery` parameter has no
  natural per-request DI point in MCP's `handle(args)` call shape).
  `mcp/server.js` calls `search.setEmbedQuery((profile, query) => embedForSearch(profile, query, { capabilities: <own> }))`
  once at startup, before the server starts handling requests.
- **[P2] A test performed a real, non-deterministic Ollama network
  call.** `composition-capability-wiring.test.js`'s `assertRealCapability()`
  helper called the real `embedForSearch()` and asserted only that the
  rejection wasn't Lite's typed error — with a real Ollama server
  reachable and `bge-m3` pulled, the call could SUCCEED, and
  `assert.rejects()` itself would then fail with an unrelated "expected
  rejection, got fulfillment" error. Fixed: replaced with
  `assertUsesRealOllamaLazyDefault()`, which stubs the GLOBAL `fetch`
  (the one thing the real `core/ollama.js`'s `embed()` calls) to reject
  immediately with a distinct, recognizable marker, never touching a
  real network — still exercises the real, unmodified
  `ollama-lazy.js -> ollama.js -> fetch` code path end to end, just
  removes the non-determinism of what a real server might do.
- The applyEmbeddingCapabilities() module-scope fallback described in
  earlier rounds of this section (§0, rounds 1–2) is **not removed** —
  it remains the correct, real default for Full's three entry points and
  the explicit typed-unavailable assertion for Lite, exactly as before.
  What changed in round 3 is that it is no longer the PRIMARY mechanism
  for the request paths that matter (indexing, search, Ask) — those now
  use the genuinely isolated per-call seam, with the module-scope
  fallback demoted to "safety net for callers that haven't been updated
  yet," which is what it always should have been.

All round 3 fixes verified with the same "deliberately revert, confirm
the test fails with the expected message, restore, confirm green again"
methodology as rounds 1–2 (see §7/§8 for the updated test list and
verification results).

### Round 4 (code review) — real immutability, real Lite/local-runtime
### separation, real global-state removal

A fourth review round found 3 more real defects — this round's fixes are
substantially larger than rounds 1–3 because finding #2 turned out to
require removing the lazy-shim substitution mechanism entirely, not just
patching around it.

- **[P1] `run.js`'s indexer capability was not actually immutable during
  a run.** `embedCapabilities()` read the mutable `_ollama`/`_onnxEmbed`
  module-scope bindings live, on every call — so a caller invoking
  `applyRunCapabilities()` *while* a `run()` was still in flight (a
  concurrent job composition, or a test) could change which backend a
  later chunk in the *same* run embedded against, mid-run. **Fixed**:
  `run()` now snapshots `{ ollama: _ollama, onnxEmbed: _onnxEmbed }` into
  a new `_activeRunEmbedCapabilities` variable exactly once, at the top of
  `run()`, and clears it in `run()`'s own `finally` block.
  `embedCapabilities()` returns that frozen snapshot whenever a run is in
  flight, falling back to the live bindings only outside of `run()` (e.g.
  a test driving `stageA`/`stageB`/`stageC` directly, unchanged behavior).
  `embedCapabilities()` itself, and a `__setActiveRunEmbedCapabilitiesForTest()`
  test-only seam, are now exported so
  `tests/unit/indexer/run-embed-capability-snapshot.test.js` can drive the
  exact snapshot/clear lifecycle without needing a real `run()`/`main()`
  (which requires a live `COLLECTION`/target and touches Qdrant/Ollama).
  Verified by reverting the fix, confirming the new test fails with the
  expected "must not observe a capability change that happens mid-run"
  message, restoring, confirming green.

- **[P1] Semidex Lite still structurally depended on build-time content
  substitution to cut the edge to local-runtime code — not genuine
  isolation.** Before this round, `indexer/index.js` was the ONE shared
  spawn target for both editions, branching on a `SEMIDEX_INDEXER_EDITION`
  env var read at runtime. The AST-based Lite package closure validator
  (`packages/lite/build.mjs`) is branch-insensitive: a literal
  `await import('../core/ollama-lazy.js')` anywhere in a Lite-shipped
  file's source is a real static edge regardless of which `if` branch it
  sits in. The only thing making that safe for the shipped tarball was
  `build.mjs`'s `substituteLazyShims()` step, which replaced
  `core/ollama-lazy.js`/`core/onnx-embed-lazy.js`/
  `indexer/phases/tag-onnx-lazy.js`'s *content* with their `.lite.js`
  shims at staging time — meaning Lite's real isolation guarantee lived in
  a build step, not in the source graph itself. Separately, several
  shared files (`core/embeddings.js`, `indexer/run.js`, the four phase
  modules, `indexer/preflight.js`, `core/generation/ollama-provider.js`)
  still imported the real `*-lazy.js` modules at module scope purely to
  seed their own default capability value, giving each of them the exact
  same structural edge independently of `index.js`.

  **Fixed, in full** (not a narrower patch — the review explicitly asked
  for the shared indexer to never import local implementations itself,
  and for the shim substitution to be removable):
  - Every former module-scope `*-lazy.js` default (`core/embeddings.js`,
    `indexer/run.js`, `context.js`/`tag.js`/`combined.js`/
    `skeleton-summary.js`, `indexer/preflight.js`,
    `core/generation/ollama-provider.js`) now starts **unset** (`null`, or
    a typed-unavailable stub for `ollama-provider.js`'s five `*Fn`
    options) — a caller that never injects a capability gets a clear,
    actionable error (`"no ollama capability available — pass
    { capabilities: { ollama } } or call applyEmbeddingCapabilities()
    first"`, etc.) instead of a silent real-network default.
  - `indexer/index.js` was **split** into three files:
    `indexer/index-runtime.js` (the shared CLI/indexing flow —
    `runIndexerCli(capabilities)` — takes a fully-resolved capability
    bundle as a parameter and never imports any Ollama/ONNX module, never
    branches on edition), `indexer/index-full.js` (Full-only, dynamically
    imports the three real `*-lazy.js` modules and calls
    `runIndexerCli()`, excluded from the Lite package), and
    `indexer/index-lite.js` (Lite's own entry point, builds typed-
    unavailable capability objects locally and calls the same
    `runIndexerCli()`, imports none of the three real modules).
    `indexer/index.js` itself is now a two-line backward-compatible
    launcher (`import './index-full.js'`) with no capability-building
    imports of its own, kept so `node src/indexer/index.js <path>` (a
    direct CLI invocation outside the admin job registry) still works.
  - `admin/jobs/registry.js` (shared, staged for Lite) no longer contains
    *any* `spawn()`/`node:child_process` import of its own. It accepts a
    **required** `spawnIndexer({ args, env }) -> ChildProcess` dependency
    with no default (a default importing either edition's spawn helper
    would put that edition's own literal path back into this shared
    file's source). The actual `node:child_process.spawn()` call, and
    each edition's own literal entry-file path, now live in two small
    sibling files — `admin/jobs/spawn-indexer-full.js` (spawns
    `index-full.js`, excluded from Lite) and
    `admin/jobs/spawn-indexer-lite.js` (spawns `index-lite.js`, staged).
    `admin/server-full.js`'s `createApp()` and
    `admin/composition/lite.js`'s `createLiteApp()` each construct their
    own `resolvedJobRegistry` with their own edition-correct
    `spawnIndexer`, before calling `registerNeutralRoutes()`.
    `registerNeutralRoutes()` itself now requires `jobRegistry` as a
    parameter — the shared-file `createJobRegistry()` fallback default it
    used to have was removed, since no safe generic default exists once
    `spawnIndexer` itself has none.
  - `packages/lite/build.mjs`'s `substituteLazyShims()` step, and the
    `packages/lite/lazy-shim-substitutions.mjs` file it read from, were
    **removed entirely**. `core/ollama-lazy.js`, `core/onnx-embed-lazy.js`,
    `indexer/phases/tag-onnx-lazy.js` (and their `.lite.js` siblings) are
    now simply listed in `build.mjs`'s `EXCLUDE_FILES`, excluded from
    staging outright like any other local-only file — because nothing in
    the Lite-staged closure imports any of them anymore, PRE-shim or
    POST-shim; both reachability numbers are now identical and zero (see
    `tests/unit/architecture/lite-lazy-shim-necessity.test.js`, fully
    rewritten this round — see below).
  - `core/generation/ollama-provider.js`'s five `*Fn` options
    (`isOllamaReachableFn`/`listOllamaModelsFn`/`validateOllamaModelsFn`/
    `generateStreamFn`/`getModelContextLengthFn`) now default to typed-
    unavailable stubs instead of `../ollama-lazy.js`'s real exports — this
    closed a real static edge `generation/registry.js`'s `BACKENDS` map
    gave every caller (its `BACKENDS.ollama = createOllamaProvider`
    reference is unconditional, even though only ever *called* when
    `backend === 'ollama'`). `validateOllamaModelsFn` is a **new** sixth
    DI seam on this factory — the pre-existing code called the module-
    scope `validateOllamaModels` directly, un-overridable, which was safe
    only because that import used to always be the real one; several
    existing tests (and the real Full+Ollama Ask path in
    `admin/bootstrap.js`) were missing this override and would have
    broken/did break until this round's fix added it everywhere. The
    real `ollama-lazy.js`-backed functions are now supplied only by
    `admin/bootstrap.js` (Full-only, excluded from Lite), via a small
    `createGenerationProviderFn` wrapper passed into
    `createGenerationRuntime()`, resolved once *before*
    `createGenerationRuntime()` runs (that function calls the factory
    synchronously, so the dynamic `ollama-lazy.js` import must already be
    settled).
  - `tests/unit/architecture/lite-lazy-shim-necessity.test.js` was fully
    rewritten (per the review's own explicit instruction: "must no longer
    assert/pin KEEP, but instead prove the ABSENCE of Lite → local-runtime
    edges") — it now proves, via the same real AST import graph, that
    none of the three real `*-lazy.js` modules (or the local-runtime
    targets they used to lead to) are reachable from Lite roots, PRE-shim
    *or* POST-shim, that both numbers are identical, that `build.mjs` no
    longer exports/calls `substituteLazyShims()`, and that
    `indexer/index-full.js` is the ONE remaining file that imports the
    three real modules — confirmed unreachable from Lite.

  A genuinely bigger blast radius than rounds 1–3 (touching ~20 files),
  but this is what "the shared indexer must not import local
  implementations itself" and "prove absence, not pin KEEP" required once
  followed through completely, per the reviewer's own explicit direction
  after an initial narrower attempt (keeping the shim substitution for
  `index.js`'s own branch-insensitive literal) was rejected in favor of
  the full split.

- **[P2] `createLiteApp()` (and, by the same reasoning, `createApp()` and
  `mcp/server.js`) unnecessarily mutated `core/embeddings.js`'s shared
  module-scope capability.** Round 3 already made the per-call
  `embedQuery` closure the real isolation mechanism for every production
  request path — the `applyEmbeddingCapabilities()` calls each
  composition root still made were pure global side-effecting noise with
  no real consumer, and (rounds 1–2's own finding) risked one composition
  root's construction affecting whatever OTHER composition root happened
  to share the same process. **Fixed**: `applyEmbeddingCapabilities()`
  calls removed from all three composition roots
  (`admin/server-full.js`'s `createApp()`, `admin/composition/lite.js`'s
  `createLiteApp()`, `mcp/server.js`) — confirmed as the intended scope
  via an explicit user decision ("remove from all three composition
  roots") rather than only the literal `createLiteApp()` the finding named.
  `core/embeddings.js`'s own module-scope fallback (`_ollamaDefault`/
  `_onnxEmbedDefault`) now starts unset (`null`) rather than defaulting to
  the real `ollama-lazy.js`/`onnx-embed-lazy.js` modules — since it is
  fully redundant for every real production composition root now,
  keeping a real-module default would have been exactly the kind of
  structural Lite → local-runtime edge finding #2 removed everywhere
  else. `tests/unit/admin/composition-capability-wiring.test.js` was
  rewritten: the old rounds-1–2-era "mutation ordering" tests (which
  tested a mechanism this round removed) were replaced with (a) a
  structural check that none of the three composition roots import
  `applyEmbeddingCapabilities` anymore, (b) a behavioral check that
  constructing `createLiteApp()` then `createApp()` in the same process
  leaves `embeddings.js`'s own fallback untouched by either (same "no
  capability injected" error before and after both constructions), and
  (c) the real per-call isolation proof from round 3, now extended to
  **both** construction orders (Lite-then-Full *and* Full-then-Lite,
  each verified over real HTTP against the other's already-running
  server) — satisfying the review's explicit "test Full and Lite
  simultaneously and in both creation orders" requirement.

All round 4 fixes verified with the same "deliberately revert, confirm
the test fails with the expected message, restore, confirm green again"
methodology as rounds 1–3, plus the full verification sequence: both
audit scripts (`build-shared-cloud-local-manifest.mjs`,
`find-dependency-violations.mjs`, 0 violations), the complete `npm test`
suite (2768/2768 passing), `npm run smoke` (1316/1316 assertions
passing, no live Qdrant/Ollama required), both admin UI builds
(`npm run admin:build`, `npm run admin:build:lite`), the Lite package
closure validator (`node packages/lite/build.mjs` — 117 files staged,
clean), and `git diff --check` (line-ending-only warnings, no real
whitespace errors).

One additional, unplanned fix surfaced only by this round's capability-
injection work: `indexer/phases/skeleton-summary.js`'s
`resolveRunNumCtx()`/`resolveNumCtx()` unconditionally called
`getModelContextLength()` (a capability-backed call) even when the
caller supplied its own `generateFn` — unlike the sibling `thinking`
resolution, which already correctly skipped `isThinkingModel()` in that
case. Before this round, that gap was invisible because the real
`ollama-lazy.js` module-scope default silently attempted (and failed) a
real network call to a nonexistent `'stub'` model, which
`generateAdaptiveSummary()`'s own retry/fallback logic swallowed as "LLM
rejected — keeping inventory" — masking that the stub `generateFn` some
smoke-test sections inject was never actually exercised as intended.
Fixed by adding a `skipGetModelContextLength` parameter (`true` whenever
`opts.generateFn` is supplied), matching the existing `thinking` pattern
exactly, with a documented fallback constant
(`FALLBACK_NUM_CTX_NO_CAPABILITY = 8000`, matching
`summaryWindowTokens()`'s own unset-env default).

## 1. What changed

Nine shared-orchestration files that previously imported `core/ollama.js`
(via `core/ollama-lazy.js`), `core/onnx-embed.js`/`core/length-bucket.js`
(via `core/onnx-embed-lazy.js`), or `indexer/phases/tag-onnx.js` (via
`indexer/phases/tag-onnx-lazy.js`) directly at module scope now depend
only on a small, provider-neutral **capability contract**, with the
`*-lazy.js` module kept only as that contract's **default binding** —
never a hardcoded call target baked into the function body itself.

| File | Contract(s) used | New seam |
|---|---|---|
| `src/core/embeddings.js` | OllamaEmbedCapability, OnnxEmbedCapability | `applyEmbeddingCapabilities({ ollama, onnxEmbed })` |
| `src/core/generation/ollama-provider.js` | generate-shaped + discovery-shaped methods (already had its own working per-method DI since Phase 4A.5a — does not consume a shared contract object directly; the one real consumer spanning what two of the narrow contracts cover) | unchanged 5 `*Fn` constructor options, doc comment updated |
| `src/indexer/phases/context.js` | OllamaGenerateCapability (1 method: `generate`) | `applyContextCapability(capability)` |
| `src/indexer/phases/tag.js` | OllamaGenerateCapability | `applyTagCapability(capability)` |
| `src/indexer/phases/combined.js` | OllamaGenerateCapability | `applyCombinedCapability(capability)` |
| `src/indexer/phases/skeleton-summary.js` | OllamaSummaryCapability (3 methods: `generate`, `getModelContextLength`, `isThinkingModel` — fallback only, every call site already accepted `opts.generateFn`) | `applySkeletonSummaryCapability(capability)` |
| `src/indexer/preflight.js` | OllamaDiscoveryCapability | `applyPreflightCapability(capability)` |
| `src/indexer/run.js` | OllamaEmbedCapability, TagOnnxCapability | `applyRunCapabilities({ ollama, tagOnnx })`, plus a composed `applyAllCapabilities({ ollamaGenerate, ollamaSummary, ollamaEmbed, ollamaDiscovery, onnxEmbed, tagOnnx })` that fans out each narrow capability to only the seams above that actually need it |
| `src/indexer/index.js` | — (Full's real caller for the indexer path) | explicitly calls `applyAllCapabilities()` with the 3 real `*-lazy.js` modules, inside the `isMainModule` guard, after `applyAllSettings()` |
| `src/admin/server-full.js` | — (Full's real caller for the admin-server path) | `createApp()` calls `applyEmbeddingCapabilities({ ollama: <real ollama-lazy.js>, onnxEmbed: <real onnx-embed-lazy.js> })` as its own first statement, every time it runs — added in round 2 to close a real Lite→Full singleton-leak gap (§0) |
| `src/admin/composition/lite.js` | — (Lite's real caller) | `createLiteApp()` calls `applyEmbeddingCapabilities({ ollama: <disabled>, onnxEmbed: <disabled> })` at the start of its own function body — not at module import time |

## 2. Research performed before any change (Part 1 of the task)

Traced every real importer of the 6 shim files via the AST import graph
(`scripts/audit/build-import-graph.mjs`), not the Phase 8A report's prose:

```
src/core/embeddings.js                    -> core/ollama-lazy.js, core/onnx-embed-lazy.js
src/core/generation/ollama-provider.js    -> core/ollama-lazy.js
src/indexer/phases/combined.js            -> core/ollama-lazy.js
src/indexer/phases/context.js             -> core/ollama-lazy.js
src/indexer/phases/skeleton-summary.js    -> core/ollama-lazy.js
src/indexer/phases/tag.js                 -> core/ollama-lazy.js
src/indexer/preflight.js                  -> core/ollama-lazy.js
src/indexer/run.js                        -> core/ollama-lazy.js, indexer/phases/tag-onnx-lazy.js
```

This is 8 real importers of `ollama-lazy.js` (matching the count already
pinned by `tests/unit/architecture/lite-lazy-shim-necessity.test.js`), 1
of `onnx-embed-lazy.js`, 1 of `tag-onnx-lazy.js` — confirmed exhaustive by
grep cross-check.

Per-shim findings used to size each contract:

- **`ollama-lazy.js`** exports 9 async wrappers
  (`generate, embed, getModelContextLength, isThinkingModel,
  getOllamaEmbeddingDimension, isOllamaReachable, listOllamaModels,
  generateStream, validateOllamaModels`). Real per-consumer usage was
  checked directly (grepping each call site, not assumed) and splits
  cleanly into 3 groups no real consumer straddles more than one of,
  except `ollama-provider.js`: `generate`/`generateStream`/
  `getModelContextLength`/`isThinkingModel` (generation — `context.js`,
  `tag.js`, `combined.js`, `skeleton-summary.js`); `embed`/
  `getOllamaEmbeddingDimension` (embed — `embeddings.js`, `run.js`);
  `isOllamaReachable`/`listOllamaModels`/`validateOllamaModels`
  (discovery — `preflight.js`). This finding drove §3's contract split
  (initially missed — see §0's P2 fix). `ollama-provider.js` already had
  a working per-method DI seam since Phase 4A.5a (`isOllamaReachableFn`,
  `listOllamaModelsFn`, `generateStreamFn`, `getModelContextLengthFn`,
  spanning generation+discovery) — this is the exact pattern the task
  asked to generalize, not something to redesign. `skeleton-summary.js`
  already accepted `opts.generateFn` per call site (comment: "generateFn
  is injectable for tests") — its own module-scope default was the only
  thing not yet contract-shaped. `combined.js`/`context.js`/`tag.js`/
  `preflight.js` had **no** DI seam at all — a bare module-scope import
  called inline.
- **`onnx-embed-lazy.js`** exports 2 functions, both **loaders** that
  resolve to real embed function references
  (`loadOnnx() -> embedOnnx`, `loadOnnxBatch() -> {embedOnnxBatch, embedBucketed}`)
  — `embeddings.js` calls the *returned* function itself. The contract
  preserves this loader shape rather than flattening it, since
  `embeddings.js`'s own DML-batch-vs-per-call dispatch logic depends on
  getting back distinct function references it composes itself.
- **`tag-onnx-lazy.js`** exports `isOnnxTagProvider` (a plain re-export
  from the already-neutral `tag-provider.js`, zero fork/worker coupling of
  its own) plus 2 worker-touching functions:
  `addTagsOnnxBatch` (stateful — dispatches to a persistent forked worker)
  and `shutdownOnnxTagWorker` (cleanup, called **unconditionally** in
  `run.js`'s own `finally` block on every indexing run). The real
  `tag-onnx.js` documents `shutdownOnnxTagWorker()` as a safe no-op when no
  worker was ever spawned — Lite's existing shim variant already relies on
  this exact contract (a past production incident occurred when an earlier
  Lite shim version threw here instead). `isOnnxTagProvider` was
  deliberately **excluded** from the new `TagOnnxCapability` contract —
  every real consumer (`run.js`, both `*-lazy.js` variants) already
  imports it directly from `tag-provider.js`, and wrapping an
  already-neutral predicate in a capability object would add indirection
  crossing no real boundary.
- `embeddings.js` already had one existing test-only DI seam,
  `setLocalEmbedOverrideForTest` — a wholesale override of the internal
  `_embed()` dispatch, used only by
  `tests/unit/core/embeddings.test.js` to prove a qdrant-cloud profile
  never reaches local embed code. This is independent of and unaffected
  by the new `applyEmbeddingCapabilities()` seam (the override intercepts
  *before* `_ollama`/`_onnxEmbed` would ever be consulted).

## 3. The six capability contracts

Each is a small, provider-neutral shape-validator file, in the same
style as the two pre-existing contracts in this codebase
(`core/generation/provider.js`'s `GenerationProvider`,
`core/storage/adapter.js`'s `StorageAdapter`) — JSDoc typedefs, a flat
`REQUIRED_*_METHODS` array, one `validate*()` function. None imports
`onnxruntime-node`, `@huggingface/transformers`, `core/ollama.js`, or any
other local implementation module — verified both by direct source
inspection and by a dedicated test in each contract's own test file.

`src/core/generation/ollama-capability.js` holds 4 SEPARATE narrow
contracts, not one wide one — split TWICE after two code review rounds
(§0's P2 entries):

- **`OllamaGenerateCapability`** — 1 method (`generate`), used by
  `context.js`, `tag.js`, `combined.js` (each calls ONLY `generate()`,
  checked directly per file — none of them calls `generateStream`,
  `getModelContextLength`, or `isThinkingModel`).
- **`OllamaSummaryCapability`** — 3 methods (`generate`,
  `getModelContextLength`, `isThinkingModel`), used by
  `skeleton-summary.js` as its module-scope fallback (every real call
  site already accepts its own `opts.generateFn` override; this contract
  only governs what an UNSPECIFIED override falls back to). Never
  `generateStream` — that method is called through no capability object
  anywhere in `src/`.
- **`OllamaEmbedCapability`** — 2 methods (`embed`,
  `getOllamaEmbeddingDimension`), used by `embeddings.js` and `run.js`.
- **`OllamaDiscoveryCapability`** — 3 methods (`isOllamaReachable`,
  `listOllamaModels`, `validateOllamaModels`), used by `preflight.js`.

These 4 contracts, deduplicated, account for exactly 8 of
`ollama-lazy.js`'s real 9 exported functions — every method except
`generate` appears in exactly one contract; `generate` deliberately
appears in both `OllamaGenerateCapability` and `OllamaSummaryCapability`
(both real consumers need it); `generateStream` appears in NONE of them,
since no contract-object consumer calls it (regression-tested by
`tests/unit/core/generation/ollama-capability.test.js`'s own partition
check, which asserts this exact shape — not naive full-coverage). 
`ollama-provider.js` needs both generate-shaped and discovery-shaped
methods (its `ready()` check needs discovery, its `generate()` needs
generation) but does not consume any of these 4 contract objects
directly — it already has its own separate, working per-method DI seam
since Phase 4A.5a (`isOllamaReachableFn`, `listOllamaModelsFn`,
`generateStreamFn`, `getModelContextLengthFn`), so it never has to
satisfy a contract wider than what it individually needs either — it is
simply outside this contract system, not a fifth contract or an
exception to the partition.

The other two contracts are unaffected by either split (their own real
usage was already narrow):

- **`src/core/onnx-embed-capability.js`** — `OnnxEmbedCapability`,
  2 methods (`loadOnnx`, `loadOnnxBatch`), matches
  `onnx-embed-lazy.js`'s export surface exactly.
- **`src/indexer/phases/tag-onnx-capability.js`** — `TagOnnxCapability`,
  2 methods (`addTagsOnnxBatch`, `shutdownOnnxTagWorker`), with an
  explicit header comment documenting the always-safe-no-op requirement
  for `shutdownOnnxTagWorker` as a load-bearing behavioral contract, not
  an implementation detail.

No universal `LocalCapabilityProvider` framework was built — the six
contracts have deliberately different shapes and lifecycle requirements
(1, 2, or 3 methods with no persistent state; 2 loader methods with no
persistent state; 2 methods, one of which manages a real forked-worker
lifecycle), matching the task's explicit instruction against a
speculative "just in case" framework and mirroring this codebase's own
existing convention (Phase 6's `setLocalSettingsCapabilities()`/
`setJobsLocalCapabilities()`/`setSettingsLocalCapabilities()` UI-side seam
likewise uses three separate, narrow, differently-shaped contracts).
Splitting was driven exclusively by checking real call sites, not by an
a priori target granularity — the process stopped once every remaining
contract matched its consumer(s) exactly, rather than continuing to
split down to one contract per method regardless of whether any real
consumer needed that granularity.

## 4. Composition wiring

**Full's real composition root is now `src/indexer/index.js`** for the
indexer path (the admin server and MCP server paths do not touch the
Ollama/ONNX/tag-onnx capability seam at all — see the note below). Its
`isMainModule` guard, after `applyAllSettings(settingsService)` and
before `run()`, now explicitly does:

```js
const ollamaLazy = await import('../core/ollama-lazy.js');
const onnxEmbedLazy = await import('../core/onnx-embed-lazy.js');
const tagOnnxLazy = await import('./phases/tag-onnx-lazy.js');
applyAllCapabilities({
  ollamaGenerate: ollamaLazy, ollamaSummary: ollamaLazy, ollamaEmbed: ollamaLazy, ollamaDiscovery: ollamaLazy,
  onnxEmbed: onnxEmbedLazy, tagOnnx: tagOnnxLazy,
});
```

This is a real fix, not a cosmetic one (§0's P1): the first version of
this step left `applyAllCapabilities()` fully implemented and tested but
never called by anything in production — every phase module's *default*
binding was doing all the work, silently. The composition call above uses
the exact same 3 `*-lazy.js` modules every phase file already defaulted
to (a plain namespace import satisfies every narrow contract, since it's
a strict superset of methods), so **behavior is unchanged** — what
changed is that Full's choice is now a real, explicit, executed call
instead of an implicit default nothing in the codebase ever exercised.
The dynamic imports are placed inside the `isMainModule` guard,
preserving `index.js`'s existing env-bootstrap-ordering guarantee (its
own header comment: no dotenv-tainted static import may run before
`bootstrapEnv()`) — verified unaffected by
`tests/unit/indexer/index-bootstrap-ordering.test.js`.

`admin/bootstrap.js`, `src/admin/server-full.js`'s `createApp()`, and
`src/mcp/server.js` never call `applyAllCapabilities()` — correctly: none
of those three paths reaches `context.js`/`tag.js`/`combined.js`/
`skeleton-summary.js`/`preflight.js`/`run.js`'s direct calls or
`tag-onnx-lazy.js` at all (those are indexer CLI-only concerns).

**`embeddings.js`'s dense-embed dispatch, however, IS reachable from
BOTH the admin-server path AND the MCP server path** — checked directly,
not assumed, since an earlier draft of this report incorrectly claimed
MCP was unaffected. `register-neutral-routes.js -> api/search.js ->
core/retrieval/search.js -> embeddings.js` covers the admin-server path;
`mcp/tools/search.js -> core/retrieval/search.js`'s `runHybridSearch()`
call uses that function's own default `embedQuery = embedForSearch`
parameter (no override supplied anywhere in `mcp/`), so MCP's search tool
reaches the exact same `embeddings.js` dispatch. Both
`src/admin/server-full.js`'s `createApp()` and `src/mcp/server.js` now
explicitly call, as one of their first statements, every time they run:

```js
applyEmbeddingCapabilities({ ollama: ollamaLazy, onnxEmbed: onnxEmbedLazy });
```

This is a second real fix (§0's round-2 P1), added after a follow-up
review found that round 1's Lite-side fix alone left a live, asymmetric
gap: `core/embeddings.js`'s `_ollama`/`_onnxEmbed` bindings are
process-wide singleton state SHARED across `createApp()`,
`createLiteApp()`, and `mcp/server.js` — before this fix, only
`createLiteApp()` ever asserted anything about this state; the other two
silently trusted whatever the module-scope default happened to be. A
process that constructs a Lite app and then a Full app — which genuinely
happens today in `tests/unit/admin/register-neutral-routes.test.js` —
would leave Full permanently stuck on Lite's typed-unavailable rejection
for the rest of the process, with no code path that ever recovered it.
Now all three are symmetric: each unconditionally reasserts its own
capability every time it runs, so whichever one runs LAST in a shared
process is what's in effect — ordinary "last call wins" semantics. Every
real production process still calls/starts exactly one of `createApp()`/
`createLiteApp()`/`mcp/server.js`, exactly once (`admin/bootstrap.js`
calls `createApp()` once; `packages/lite/lite-src/serve-lite.js` calls
`createLiteApp()` once; `mcp/server.js` is a self-starting
`isMainModule`-shaped script, never imported as a library — confirmed by
reading all three real entry points), so this fix changes nothing about
real single-composition-root process behavior; it only matters for a
process — today, only tests, and only for the `createApp()`/
`createLiteApp()` pair, since nothing imports `mcp/server.js` as a
library — that constructs more than one. `mcp/server.js`'s own fix is
therefore defensive (closes the same class of gap at zero real risk
today, in case a future test or tool ever does import it as a library)
rather than fixing a currently-provable live bug the way the
`createApp()` fix does. Regression-tested by a new
`tests/unit/admin/composition-capability-wiring.test.js` case
("Lite -> Full ordering in one process") that calls `createLiteApp()`
then `createApp()` and asserts the real capability is back; verified to
actually catch the regression by temporarily reverting the fix, watching
the test fail with exactly the expected assertion, then restoring it.
`admin/bootstrap.js`'s own `applyCeRerankSettings(settingsService)` call
(for the unrelated CE-reranking capability) is the existing precedent
this "reassert at composition time" pattern already followed before this
phase.

**This "last call wins" symmetry was itself superseded by round 3 (§0)
as the PRIMARY mechanism**, for the exact reason its own name implies —
it is an ordering convention on shared mutable state, not real isolation,
and a further review correctly pushed back on it a third time. It
remains in place as the module-scope FALLBACK default (harmless, and
still the correct behavior for any caller that hasn't been updated to
the newer per-call seam), but `createApp()`/`createLiteApp()`/
`mcp/server.js`'s own request paths (search, Ask) now use the genuinely
isolated `embedQuery`-closure/`capabilities`-parameter mechanism
described below instead — see this section's own "Real per-call
isolation" subsection further down for the actual fix.

**Lite** has exactly one real composition root,
`src/admin/composition/lite.js` (confirmed via the AST import graph — only
`packages/lite/lite-src/serve-lite.js` imports it; Full never does).
`createLiteApp()` now calls, as the FIRST statement in its own function
body (not at module top level — §0's P1 fix):

```js
export function createLiteApp({ ... } = {}) {
  applyEmbeddingCapabilities({
    ollama: unavailableOllamaEmbedCapability(),
    onnxEmbed: unavailableOnnxEmbedCapability(),
  });
  const router = createRouter();
  // ...
}
```

The first version of this step called `applyEmbeddingCapabilities()` at
module top level — a real bug: `core/embeddings.js`'s `_ollama`/
`_onnxEmbed` bindings are process-wide module-scope state, so merely
IMPORTING `composition/lite.js` (without ever calling `createLiteApp()`)
permanently reconfigured `embeddings.js` for the rest of the process. Any
hypothetical future process importing both this module and Full's
`server-full.js` in the same process would have had Lite's import
silently poison Full's real capability out from under it, with no call
to `createLiteApp()` ever having happened. Fixed by scoping the call to
actual invocation — "Lite's capability choice takes effect" and
"`createLiteApp()` was actually called" are now the same event, matching
every other composition decision that function makes (adapter, jobPolicy,
route registration). Regression-tested by
`tests/unit/admin/composition-capability-wiring.test.js`'s "merely
importing... does NOT mutate shared capability state" case, which would
fail if the top-level call ever came back.

Both `unavailable*Capability()` helpers build an object satisfying the
contract where every method throws a typed, locally-defined
"not available in Semidex Lite" error — the SAME typed-error shape
(`code: 'not_available_in_lite'`, matching message text) the existing
`*-lazy.lite.js` build-time shims already throw, so a caller catching
`err.code === 'not_available_in_lite'` today keeps working unchanged
regardless of which mechanism (build-time content substitution or this
explicit runtime injection) actually produced the rejection.

**A real bug avoided during this step**: the first version of this file
imported `core/ollama-lazy.lite.js`/`core/onnx-embed-lazy.lite.js`
directly to reuse their exported error classes. This would have broken
the Lite package build — `packages/lite/build.mjs`'s
`substituteLazyShims()` consumes each `.lite.js` file's *content*,
writing it onto the real module's own staged path
(`core/ollama-lazy.js`), then **deletes** the `.lite.js` file's own
separate staged copy (`rmSync`) since "it has done its job." A static
import of `ollama-lazy.lite.js` BY NAME from a kept file would therefore
reference a path that does not exist in the staged tree, and the closure
validator would correctly flag it. Fixed by defining small, local,
throwaway error classes in `composition/lite.js` itself instead — caught
before ever running the closure validator, by re-reading
`build.mjs`'s own `substituteLazyShims()` implementation first. Verified
afterward: `node packages/lite/build.mjs` reports `121 files staged,
closure validated clean.`

**Why this matters even though these branches are policy-unreachable
today**: `core/embeddings.js` is statically imported by
`admin/register-neutral-routes.js -> api/search.js -> core/retrieval/search.js`,
a route both Full and Lite register — so `admin/composition/lite.js` is a
real place a wrong `EMBEDDING_BACKEND` value could otherwise reach
`embeddings.js`'s Ollama/ONNX dispatch branches. Lite's settings-service
layer already rejects any `EMBEDDING_BACKEND`/`DENSE_PROVIDER` value other
than `qdrant-cloud`, so this is defense in depth, not a live gap — but per
the task's explicit "composition root is the only place that selects an
implementation" requirement, this guarantee now lives at the composition
boundary rather than being merely an emergent property of settings
validation plus the build-time shim substitution.

**The Lite indexing child process is untouched by this step, correctly.**
Both `serve-lite.js` (via `admin/jobs/registry.js`) and `index-lite.js`
(via `createJobRegistry`) spawn `indexer/index.js` as a **separate Node
child process** — a fresh module graph the parent process's composition
wiring never reaches. The correctness guarantee there is, and remains,
the package's own build-time content substitution
(`packages/lite/lazy-shim-substitutions.mjs` +
`packages/lite/build.mjs`'s `substituteLazyShims()`): the staged
`core/ollama-lazy.js`/`indexer/phases/tag-onnx-lazy.js` paths (the exact
same paths my new `_ollama`/`_tagOnnx` module-scope defaults reference)
carry the `.lite.js` variant's content in the shipped tarball. None of my
edits changed any `*-lazy.js` import specifier string anywhere, so this
mechanism is unaffected and still fully correct.

**Real per-call isolation (§0's round 3 fix)** — the actual mechanism that
makes two composition roots safe to coexist in one process, superseding
"last call wins" as the primary path:

`core/embeddings.js`'s `embedForIndex`/`embedForIndexBatch`/`embedForSearch`
each gained an optional `{ capabilities: { ollama, onnxEmbed } }`
argument. When supplied, that ONE call dispatches through exactly those
objects — never consulting `applyEmbeddingCapabilities()`'s module-scope
default at all. Three real callers now supply it explicitly:

- **`indexer/run.js`** resolves its own `_ollama`/`_onnxEmbed` (module-scope
  state already local to that file) via a small `embedCapabilities()`
  helper and passes `{ capabilities: embedCapabilities() }` to all 6 of
  its own `embedForIndex`/`embedForIndexBatch` call sites.
- **`admin/server-full.js`'s `createApp()`** and
  **`admin/composition/lite.js`'s `createLiteApp()`** each build
  `embedQuery ?? ((profile, query) => embedForSearch(profile, query, { capabilities: <own> }))`
  — captured by value at construction time — and pass it as `embedQuery`
  into `registerNeutralRoutes()`, which already threads that parameter
  through to both `registerSearchRoutes()` (search) and
  `createAskCoordinator()` (Ask) — both covered by this one change, no
  separate Ask-specific fix needed.
- **`mcp/server.js`** calls a new `search.setEmbedQuery()` seam (added to
  `mcp/tools/search.js`, mirroring that file's existing
  `setStorageAdapter()`/`setSettingsService()` module-level-override
  convention — MCP's `handle(args)` call shape has no per-request DI
  point of its own) with the same kind of bound closure, once at startup.

With this in place, two composition roots constructed in the same
process — even interleaved, even concurrently — no longer share any
mutable state their own search/Ask/indexing requests actually consult.
The module-scope `applyEmbeddingCapabilities()` fallback (rounds 1–2)
remains in place as a safety net for any caller that hasn't been updated
to pass `capabilities` explicitly, but it is no longer what Full's or
Lite's own real request paths depend on.

## 5. Call sites converted

Every call site below now reads through a module-scope binding
(`_ollama`, `_onnxEmbed`, `_tagOnnx`) set only by its file's own
`apply*Capability()` — never a bare imported function called inline.

| File | Converted call(s) |
|---|---|
| `core/embeddings.js` | `_ollama.embed(text, cfg.denseModel)`; `_onnxEmbed.loadOnnx()`; `_onnxEmbed.loadOnnxBatch()` |
| `indexer/phases/context.js` | `_ollama.generate(MODEL, prompt)` in `addContext()` |
| `indexer/phases/tag.js` | `_ollama.generate(model, prompt)` in `addTagsWithModel()`; `_ollama.generate(MODEL, prompt, {format:'json'})` in `addTagsBatch()` |
| `indexer/phases/combined.js` | `_ollama.generate(model, buildPrompt(...), {format:'json'})` in `addContextAndTags()` (its fallback path already delegated to `context.js`/`tag.js`'s own now-injected functions) |
| `indexer/phases/skeleton-summary.js` | module-scope `generate`/`getModelContextLength`/`isThinkingModel` bindings now route through `_ollama`; every call site's pre-existing `opts.generateFn ?? generate` DI is unchanged |
| `indexer/preflight.js` | `_ollama.isOllamaReachable(base)`, `_ollama.listOllamaModels(base)`, `_ollama.validateOllamaModels(...)` in `checkOllamaPreflight()` |
| `indexer/run.js` | `_ollama.getOllamaEmbeddingDimension(...)` (new-collection vector-size detection); `_tagOnnx.addTagsOnnxBatch(...)` (3 call sites); `_tagOnnx.shutdownOnnxTagWorker()` (the `run()` `finally` block); AND (round 3) all 6 `embedForIndex`/`embedForIndexBatch` calls now pass `{ capabilities: embedCapabilities() }` explicitly — see §4's "Real per-call isolation" subsection |

No consumer duplicates provider-selection logic — every one of the seven
files defers entirely to whatever object its own `apply*Capability()` was
last called with (or the real `*-lazy.js` default if never called).
Three more files, added by §0's P1/round-3 fixes, are real composition
CALLERS rather than capability CONSUMERS: `indexer/index.js` calls
`applyAllCapabilities()` explicitly with the 3 real `*-lazy.js` modules;
`admin/server-full.js`'s `createApp()`, `admin/composition/lite.js`'s
`createLiteApp()`, and `mcp/server.js` each call
`applyEmbeddingCapabilities()` explicitly with their own real/disabled
modules AND (round 3) each build their own bound `embedQuery` closure
passed through to the search/Ask call chain — see §4.

## 6. Manifest and dependency-direction results

Regenerated `scripts/audit/full-lite-module-classification.json`
(238 production modules — up from Phase 8A's 235 by exactly the 3 new
contract files, all correctly `shared`):

| Category | Count |
|---|---|
| `shared` | 104 |
| `mixed` | 43 |
| `local` | 16 |
| `composition` | 10 |
| `tooling` | 61 |
| `cloud` | 4 |
| `unclassified` | 0 |

**Note on the manifest tooling itself**: between the Phase 8A report and
this step, `scripts/audit/build-shared-cloud-local-manifest.mjs` and
`scripts/audit/find-dependency-violations.mjs` had already been
substantially strengthened (uncommitted, carried over from that same
session's later work, not a new change made in this step) with a
fixed-point "mixed propagation" pass: any module whose category allows
only same-or-shared targets (`shared -> shared`; `cloud -> shared, cloud`;
`local -> shared, local`) but has a direct dependency on a module outside
that allowed set is itself reclassified `mixed`, iterated to a stable
fixed point. This is why `mixed` (43) is much larger than Phase 8A's
original 6 — every one of the 7 phase files converted in this step
(§1's table) still lists its own `*-lazy.js` default in
`directDependencies`, and `*-lazy.js` is itself `mixed` by definition
(the boundary seam), so the propagation correctly flags each converted
consumer `mixed` too. **This is the intended, honest signal for Step 1's
actual state**: a real capability contract and injection seam now exist
for each of these files, but the literal default import of the
`*-lazy.js` shim is still present (by design — shim removal is Step 8,
not Step 1) — the stricter classifier correctly refuses to call a file
"clean shared" while it still has a live default edge onto the boundary
seam. Confirmed the underlying architectural fact the task's exit
criteria actually cares about, independent of this labeling nuance:

```
shared -> local edges: 0
shared -> cloud edges: 0
```

`node scripts/audit/find-dependency-violations.mjs` reports
`0` direction violations and `0` shared→cloud edges (both now folded into
`mixed` by the same propagation, so the checker's own `DIRECTION_RULES`
simplify to "no category may depend on `mixed`," which is automatically
satisfied once mixed-propagation has already run).

## 7. Tests added

9 test files, 80 tests, all passing together in one
`node --test --test-concurrency=1` run alongside the existing suite with
no cross-file pollution:

- `tests/unit/core/generation/ollama-capability.test.js` (17 tests) —
  shape validation for all 4 narrow contracts individually (including a
  dedicated "does NOT require the other contracts' methods" case per
  contract); a partition check proving the 4 contracts' `REQUIRED_*_METHODS`
  lists, deduplicated, equal `ollama-lazy.js`'s real export surface MINUS
  `generateStream` (the one real export no contract needs); a second
  check proving `generate` is the ONLY method allowed to repeat across
  contracts (Generate + Summary), every other method exactly once;
  zero-backend-import source check.
- `tests/unit/core/onnx-embed-capability.test.js` (6 tests) — same shape
  for `OnnxEmbedCapability`.
- `tests/unit/indexer/phases/tag-onnx-capability.test.js` (8 tests) —
  same shape for `TagOnnxCapability`, plus a dedicated
  always-safe-no-op cross-check against the real, already-shipped
  `tag-onnx-lazy.lite.js` shim.
- `tests/unit/core/embeddings-capability-injection.test.js` (10 tests) —
  proves, via injected fakes: the dispatch calls through the injected
  capability with the exact documented arguments (`ollama.embed(text,
  model)`; `onnxEmbed.loadOnnx()` then the returned function called with
  the exact text); a capability error propagates as the *same error
  instance*, never wrapped; `applyEmbeddingCapabilities()` validates
  before installing (a broken capability never displaces a good one);
  omitting one capability leaves the other's current binding untouched;
  PLUS (round 3's own real-isolation regression guard) a dedicated
  4-test block proving the per-call `capabilities` parameter is used
  INSTEAD of the module-scope default even when that default would
  reject; proving it works for both the Ollama and ONNX lanes; proving
  two CONCURRENT calls with different per-call capabilities never
  interfere with each other (`Promise.all` of two `embedForSearch` calls
  with distinct capability objects, no `applyEmbeddingCapabilities()`
  call between them); and proving omitting `capabilities` still falls
  back to the module-scope default (backward compatible).
- `tests/unit/indexer/phase-capability-injection.test.js` (19 tests) —
  the same behavioral proof (injected-fake argument capture, error
  propagation, validate-before-install) across `context.js`, `tag.js`,
  `combined.js` (all `OllamaGenerateCapability`, single-method),
  `skeleton-summary.js` (`OllamaSummaryCapability`), `preflight.js`
  (`OllamaDiscoveryCapability`), and `run.js`'s
  `applyRunCapabilities`/`applyAllCapabilities` — including a dedicated
  test proving `applyAllCapabilities()` REJECTS a generate-only
  capability passed as the summary, embed, or discovery slot (proving
  the fan-out validates each seam against its own narrow contract, not
  one shared wide one).
- `tests/unit/admin/composition-capability-wiring.test.js` (5 tests) —
  proves Full's default (before anything calls `createLiteApp()`) reaches
  the real `ollama-lazy.js` module (deterministically — see round 3's P2
  fix below, not a real network attempt); proves merely IMPORTING
  `admin/composition/lite.js` does NOT mutate `embeddings.js`'s shared
  capability state (round 1's P1 regression guard); proves CALLING
  `createLiteApp()` makes every subsequent `embeddings.js` dense-embed
  call (both Ollama and ONNX lanes) reject with the typed
  `not_available_in_lite` error; proves calling `createLiteApp()` THEN
  `createApp()` in the same process recovers the REAL capability
  afterward (round 2's P1 regression guard — verified to actually catch
  the regression when the fix was temporarily reverted); PLUS (round 3's
  own real-isolation regression guard) a REAL HTTP test that constructs
  and starts Lite's server, THEN constructs Full's server in the same
  process, THEN sends a real POST to Lite's ALREADY-RUNNING server's
  `/api/search` and confirms it still returns Lite's typed
  `embedding_failed`/`not available in Semidex Lite` response — proving
  Lite's own bound `embedQuery` closure, captured at construction time,
  is unaffected by Full's later construction (verified to actually catch
  the regression when the `embedQuery` binding fix was temporarily
  reverted — the test failed with a real "fetch failed" network error
  instead, exactly as expected).
- `tests/unit/core/lazy-shim-backward-compat.test.js` (4 tests) — pins
  the 3 real `*-lazy.js` modules' export surfaces unchanged, and that
  every converted consumer still references `ollama-lazy.js` as its
  default (nothing silently bypassed).
- `tests/unit/indexer/index-capability-wiring.test.js` (5 tests — the
  round-1 P1 fix's own regression guard) — proves `indexer/index.js`'s
  source imports `applyAllCapabilities` from `run.js`; proves the real
  call supplies a value for every one of the 6 capability slots
  (`ollamaGenerate`, `ollamaSummary`, `ollamaEmbed`, `ollamaDiscovery`,
  `onnxEmbed`, `tagOnnx`); proves the call happens INSIDE the
  `isMainModule` guard, after `applyAllSettings()` and before `run()` —
  never as an import-time side effect; proves the 3 objects passed are
  real, dynamically-imported `*-lazy.js` modules (not stubs); proves a
  real `*-lazy.js` namespace import satisfies every narrow contract
  `applyAllCapabilities()` validates against (no validation failure from
  a real object).
- `tests/unit/mcp/server-capability-wiring.test.js` (6 tests — rounds 2
  and 3's own regression guards for the MCP path) — proves
  `mcp/server.js`'s source imports `applyEmbeddingCapabilities` from
  `core/embeddings.js` and calls it with the real `ollama-lazy.js`/
  `onnx-embed-lazy.js` modules (not stubs), before any MCP tool module
  (in particular `tools/search.js`, which reaches this same dispatch via
  `runHybridSearch()`'s own default `embedQuery` parameter) is imported
  (round 2's fallback-default fix); PLUS (round 3's own real-isolation
  fix) proves `mcp/server.js` calls the new `search.setEmbedQuery()` seam
  with a closure bound to its own real capability, after
  `setSettingsService()` and before the server starts accepting
  connections; proves `mcp/tools/search.js` exports `setEmbedQuery`,
  mirroring its existing `setStorageAdapter`/`setSettingsService`
  module-level-override convention.

Existing tests updated (no new assertions changed their meaning, only
their expected *path*, since real new shorter graph edges appeared from
`index.js`'s new dynamic imports):
`tests/unit/architecture/lite-lazy-shim-necessity.test.js`'s three
`findImportPath()` assertions (`core/ollama.js`, `core/onnx-embed.js`,
`indexer/workers/tag-onnx-worker.js`) now expect
`serve-lite.js -> jobs/registry.js (spawn) -> index.js -> *-lazy.js -> <real file>`
— `index.js` now dynamically imports all three `*-lazy.js` modules
directly (to call `applyAllCapabilities()`), which is a real, shorter BFS
path than either the old run.js-mediated spawn-chain path or the
`admin/composition/lite.js -> embeddings.js` path from the first version
of this step; all of those older paths still exist too, just no longer
shortest. Both PRE-shim/POST-shim reachability assertions (the actual
proof each shim is load-bearing) were unaffected and unchanged throughout.

Existing `tests/unit/admin/composition-lite.test.js` (Phase 4's own
import-boundary suite, unmodified) continues to independently verify
`admin/composition/lite.js` has zero direct or transitive resolved edges
into any `LOCAL_ONLY_PATH_PATTERNS` file, post-shim — confirming the 3
new imports this step added there (`core/embeddings.js`,
`core/generation/ollama-capability.js`, `core/onnx-embed-capability.js`)
did not introduce one. `server-full.js` and `mcp/server.js` (both
Full-only, already excluded from the Lite tarball entirely by
`packages/lite/build.mjs`'s `EXCLUDE_FILES`/`EXCLUDE_DIRS`) each gained
the round-2 imports (`core/embeddings.js`, `core/ollama-lazy.js`,
`core/onnx-embed-lazy.js`) — confirmed harmless to the Lite closure by
re-running the closure validator (§8) after both fixes.

## 8. Verification results

| Check | Result |
|---|---|
| New focused tests (`node --test --test-concurrency=1`, 9 files together) | 80/80 pass |
| `node scripts/audit/build-shared-cloud-local-manifest.mjs` | 238 modules classified, manifest regenerated |
| `node scripts/audit/find-dependency-violations.mjs` | 0 violations, 0 shared→cloud edges |
| `npm test` | 2755/2755 pass |
| `npm run smoke` | 1316/1316 pass |
| `npm run admin:build` | succeeds, 227 modules transformed |
| `npm run admin:build:lite` | succeeds, 226 modules transformed |
| `node packages/lite/build.mjs` | `OK — 121 files staged, closure validated clean.` |
| `git diff --check` | clean (pre-existing CRLF-normalization notices only, no whitespace errors) |

No indexing, search, generation, or tagging behavior changed — every
converted call site's default binding is the exact same `*-lazy.js`
module that ran before this step, called with the exact same arguments,
in the exact same order. `indexer/index.js`'s explicit
`applyAllCapabilities()` call and `server-full.js`'s explicit
`applyEmbeddingCapabilities()` call (§0/§4) both pass those SAME real
modules as the concrete capability objects, so this remains true even
though Full's composition choice is now an explicit call rather than an
implicit default for both the indexer CLI path and the admin-server path.

## 9. What still runs on the old lazy-shim path, and why

All three shims remain fully in place and load-bearing, exactly as this
step requires. This is intentional (§0's "Observation" entry) — Step 1's
scope is to add injection SEAMS, not to cut the physical dependency
graph or remove the shims; `tests/unit/architecture/lite-lazy-shim-necessity.test.js`
correctly continues to report all three as `KEEP`, meaning the real
`core/ollama.js`/`core/onnx-embed.js`/`indexer/phases/tag-onnx.js` files
are still reachable from Lite's own entry points in the unmodified
graph, exactly as before this step — only the build-time content
substitution (unchanged) is what keeps them out of the shipped tarball.

- **`core/ollama-lazy.js`** — the real capability object `indexer/index.js`
  (indexer CLI path), `createApp()` (admin-server path), and
  `mcp/server.js` (MCP path) ALL now explicitly pass at composition time
  (round 1 fixed the indexer path; round 2 fixed the admin-server and MCP
  paths — see §0/§4). Removal (Step 8) requires every consumer's
  `apply*Capability()` to be called with a real object by SOME real
  composition root — now true for all three real Full entry points that
  reach this seam, and for Lite (always was).
- **`core/onnx-embed-lazy.js`** — same story: `indexer/index.js`,
  `server-full.js`'s `createApp()`, and `mcp/server.js` all now pass it
  explicitly.
- **`indexer/phases/tag-onnx-lazy.js`** — same story, 1 consumer
  (`run.js`, explicitly supplied by `indexer/index.js` — this seam is
  indexer-CLI-only, neither `createApp()` nor `mcp/server.js` ever
  touches it), plus the
  persistent-worker lifecycle constraint (§2) that this explicit
  injection already had to (and does) honor exactly — the real
  `tag-onnx-lazy.js` module's own `shutdownOnnxTagWorker` behavior is
  unchanged, only the path by which `run.js` obtains it changed (explicit
  argument instead of implicit default).

This matches the task's own explicit Step 1 scope: contracts and seams
exist, the new orchestration path already works through injection (proven
behaviorally, not just structurally, by §7's tests), and — after both
code review rounds' fixes — every real Full composition root that
reaches one of these seams now explicitly exercises it in production,
not merely in tests, and the two composition roots (`createApp()`/
`createLiteApp()`) are symmetric with respect to the shared
`embeddings.js` singleton state. The shim itself stays the literal
implementation every seam still resolves to (by explicit
composition-time choice, not merely a fallback default), the physical
import graph is unchanged, and no file was physically moved.

## 10. Risks and open items carried into Step 2+

- **The manifest's `mixed` count (43) will only shrink once the
  `*-lazy.js` default import itself is removed from each consumer file**
  — that is Step 8's job, not Step 1's. Anyone reading the manifest
  between now and Step 8 should expect this elevated count and not
  mistake it for a regression; §6 documents exactly why.
- **`skeleton-summary.js`'s capability seam is a fallback only** — every
  real call site already accepts its own `opts.generateFn` override
  (pre-existing, Phase-4-era design). `applySkeletonSummaryCapability()`
  changes what an UNSPECIFIED `opts.generateFn` falls back to; it does
  not change the calling convention itself. This is intentional (matching
  the task's instruction not to change indexing behavior) but should be
  kept in mind if Step 2+ ever wants a single, uniform injection style
  across every phase file.

## 11. Readiness for Step 2 — physical relocation of the local embedding runtime

Per Phase 8A's own staged plan (§7, Step 2:
`core/onnx-embed.js`, `core/onnx-runtime.js`, `core/onnx-probe-runner.js`,
`core/onnx-provider-probe.js`, `core/length-bucket.js` → `src/local/`),
this step's work directly unblocks that move:

- `embeddings.js` (the one real importer of `onnx-embed-lazy.js`) no
  longer needs to know the physical location of `onnx-embed.js`/
  `length-bucket.js` at all beyond the `*-lazy.js` module's own internal
  `await import('./onnx-embed.js')` — moving those two files only
  requires updating `onnx-embed-lazy.js`'s own two dynamic-import
  specifiers, not touching `embeddings.js` a second time.
- The `OnnxEmbedCapability` contract itself has zero path dependency on
  where the real implementation lives — Step 2 does not need to touch
  `core/onnx-embed-capability.js`.
- `admin/api/onnx.js` (the one other real importer of `onnx-embed.js`'s
  sibling `onnx-provider-probe.js`) is unaffected by this step and
  remains a direct, Full-only import — Step 2 will need to update that
  file's import path too, a fact already noted in Phase 8A's own plan.

No blocker was found. Step 2 can proceed as planned once reviewed.
