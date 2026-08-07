# Phase 8A — Audit and migration plan for physical shared/cloud/local separation

> **Update (2026-08-05, Phase 8B Step 1 round 4).** §4's "target
> architecture for the 3 remaining lazy shims" describes a FUTURE-phase
> plan (physical file relocation, Phase 8B Step 2+). Phase 8B Step 1's own
> round-4 code review found and fixed a *structural* gap that made part of
> §4's premise obsolete ahead of schedule: `indexer/index.js` was split
> into `index-runtime.js`/`index-full.js`/`index-lite.js`, every remaining
> module-scope `*-lazy.js` default was removed, and
> `packages/lite/build.mjs`'s shim-substitution mechanism was deleted
> entirely — the three lazy shims are now excluded from the Lite package
> outright (like any other local-only file) rather than content-
> substituted at build time, and PRE-shim/POST-shim Lite reachability of
> `core/ollama.js`/`core/onnx-embed.js`/`indexer/phases/tag-onnx.js` are
> now identical (both zero) with no build step involved. See
> [`phase-8b-capability-contracts-and-composition-seams-2026-08-02.md`](phase-8b-capability-contracts-and-composition-seams-2026-08-02.md)
> §0's "Round 4" subsection for the full account. This does NOT complete
> §4's own plan (at the time this note was written, the three real modules —
> `core/ollama.js`, `core/onnx-embed.js`, `indexer/phases/tag-onnx.js` —
> were still physically present under `src/`, not relocated; §4/§5's
> physical-move plan remained future work), but it does mean the
> *build-time substitution* dependency §4 describes today no longer exists
> — reread §4 with that in mind. **Update (Step 2, see §7's own Step 2
> entry below):** `core/onnx-embed.js` and its 4 siblings have since
> physically moved to `src/local/core/`; `core/ollama.js` and
> `indexer/phases/tag-onnx.js` remain at their original paths pending
> Steps 3–4. **Update (Step 3, see §7's own Step 3 entry below):**
> `core/ollama.js` and `core/ollama-models.js` have since physically moved
> to `src/local/core/` too; `indexer/phases/tag-onnx.js` remains at its
> original path pending Step 4.

> **Review correction (2026-08-02).** The initial report treated runtime
> reachability as architectural identity and therefore mislabeled 12 direct
> `shared -> cloud` edges as an accepted provider-neutral pattern. That was
> incorrect: the target rule is `shared -> shared` only. The corrected
> manifest performs semantic, dependency-aware propagation up to composition
> boundaries. Current result: **101 shared, 43 mixed, 16 local, 4 cloud,
> 10 composition, 61 tooling, 0 unclassified**. The former shared/cloud
> callers and their provider-coupled callers are now explicitly `mixed`;
> the strict checker reports **0 violations and 0 shared -> cloud edges**.
> MCP is no longer hidden under tooling: `mcp/server.js` is Full composition,
> provider-neutral MCP tools are shared, and provider-coupled MCP tools are
> mixed. Old counts and conclusions below are retained as initial audit
> history and are superseded by this correction and the generated manifest.

Implementation report for Phase 8A of
[`full-lite-shared-architecture-audit-2026-08-01.md`](full-lite-shared-architecture-audit-2026-08-01.md)
("Phase 8A — Audit and migration plan for physical shared/cloud/local
separation"). This is an audit and planning task — **no production files
were physically moved**. The only code changes are: (1) two small, real
bug fixes to `scripts/audit/classify-modules.mjs`'s existing analyzer
(Part A), (2) two new audit-tooling scripts (Part B/C), and (3) new
architecture regression tests (Part H). Everything else is documentation
and design.

## 1. Part A — dependency graph completeness

Reused `scripts/audit/build-import-graph.mjs`'s existing real AST-based
import graph (static imports, literal `import()`, `require()`, resolved
`fork()`/`spawn()` targets, worker targets) and
`scripts/audit/classify-modules.mjs`'s existing reachability computation
— not a new analyzer. Verified this tooling's entry-point coverage
against the task's own required list:

| Required entry point | Traced as |
|---|---|
| Full: indexer CLI | `src/indexer/index.js` (`FULL_ROOTS`) |
| Full: MCP server | `src/mcp/server.js` (`FULL_ROOTS`) |
| Full: Admin server | `src/admin/bootstrap.js` (`FULL_ROOTS`) |
| Full: Admin UI | `src/admin/ui-src/entries/full.js` — **fixed, see below** |
| Full: sync/doctor/backfill scripts | `src/sync.js`, `src/doctor.js`, `src/backfill-tags.js`, `src/backfill-entity-refs.js`, `src/smoke.js`, `src/bootstrap-docs.js` (`FULL_ROOTS`) |
| Lite: doctor-lite | `packages/lite/lite-src/doctor-lite.js` (Lite synthetic roots) |
| Lite: serve-lite | `packages/lite/lite-src/serve-lite.js` (Lite synthetic roots) |
| Lite: index-lite | `packages/lite/lite-src/index-lite.js` (Lite synthetic roots) |
| Lite: Admin UI | `src/admin/ui-src/entries/lite.js` — **fixed, see below** |
| Lite: search | reached via `admin/register-neutral-routes.js` → `admin/api/search.js`, itself reached from `serve-lite.js`'s composition chain |
| Lite: Ask | reached via `admin/register-neutral-routes.js` → `core/ask-api/v1/route.js`, same chain |
| Lite: indexing job child process | `admin/jobs/registry.js`'s `spawn(process.execPath, [indexer/index.js, ...])` — a resolved `forkSpawnCalls` edge, already correctly traced |

### Two real classifier bugs found and fixed

**Bug 1 — the Full and Lite Admin UI browser bundles were never traced
roots at all.** `src/admin/ui-src/entries/full.js` and
`src/admin/ui-src/entries/lite.js` are the real Vite JS entry points each
edition's `index.html` `<script type="module">` tag loads (added in
Phase 6) — but neither `FULL_ROOTS` nor the Lite synthetic-roots
computation included them, because nothing in the SERVER-side graph
statically imports a browser entry point (Vite bundles it separately).
The whole `admin/ui-src/` tree was previously classified only by a
hand-verified directory-pattern special case in `firstPassBucket()`
(comment: "admin/ui-src/*.js is OUTSIDE the Node.js import graph this
script traces... a plain reachability classification cannot say anything
about it at all") — a premise that was **already false** by the time
Phase 6 landed (the UI's own real import graph, including its one
legitimate cross-boundary edge into
`core/embedding-profile/qdrant-cloud-models.js`, a pure-data
zero-dependency module, is fully traceable) but had never been revisited.

Fixed: `FULL_ROOTS` now includes `src/admin/ui-src/entries/full.js`; a new
exported constant `LITE_UI_ENTRY` (`src/admin/ui-src/entries/lite.js`) is
unioned into the Lite reachability computation. Full-reachable count rose
from 201 to 226; Lite-reachable (post-shim) rose from 117 to 141 — the
real UI module graph (`app.js`, `router.js`, `global-settings-view.js`,
`jobs-view.js`, `settings-view.js`, plus `local-features.js` for Full
only) is now genuinely traced, not asserted in a comment.

**Bug 2 — `global-settings-view.js`/`settings-view.js` were hard-coded
`'mixed'`, a Phase-6-stale special case.** Before Phase 6, these two files
genuinely mixed shared rendering logic with inline `IS_LITE`-guarded
ONNX/Ollama branches, found by hand-grepping for `onnx`/`ollama`
substrings (documented in the same stale comment as Bug 1). Phase 6's own
capability-injection refactor already moved every one of those branches
into a new file, `local-features.js`, reached only through a seam neither
file directly imports — but the hand-coded `'mixed'` special case was
never removed. With Bug 1 fixed (real UI reachability), the graph now
correctly finds both files `fullReachable && liteReachable` (genuinely
`shared`) on its own, and `local-features.js` correctly
`fullReachable && !liteReachable` (genuinely `local`) — no special case
needed for either. Fixed by removing the hard-coded case entirely.

Verified via the full test suite (1001/1001 across
`tests/unit/architecture/` + `tests/unit/admin/` before any new Phase 8A
test was added) that both fixes are additive and caused zero regressions
— see §7.

## 2. Part B — classification manifest

New: `scripts/audit/build-shared-cloud-local-manifest.mjs`, which
generates the committed `scripts/audit/full-lite-module-classification.json`
— every one of the 235 production `.js` files under `src/` (excluding
`packages/lite/lite-src/*.js`, out of this manifest's scope), classified
into exactly the task's 7-category vocabulary: `shared`, `cloud`, `local`,
`composition`, `tooling`, `mixed`, `unclassified`.

| Category | Count | Definition used |
|---|---|---|
| `shared` | 122 | Reachable from both Full and Lite; imports no cloud/local implementation directly |
| `local` | 16 | ONNX Runtime, Ollama, local workers/probes/models — see full list in §4 |
| `cloud` | 10 | Qdrant Cloud Inference, Gemini, and Lite-specific composition/settings wiring (see the one open ambiguity noted below) |
| `composition` | 4 | `admin/bootstrap.js`, `admin/server-full.js` (Full); `admin/ui-src/entries/full.js`, `admin/ui-src/entries/lite.js` |
| `tooling` | 75 | MCP protocol server (`src/mcp/**`, 14 files) + dev/maintenance CLI surface (`src/smoke/**`, 55 files, plus `sync.js`/`doctor.js`/`backfill-*.js`/`bootstrap-docs.js` themselves) |
| `mixed` | 6 | The 3 `*-lazy.js`/`*-lazy.lite.js` shim pairs — by design, this IS the boundary seam |
| `unclassified` | 2 | `core/generation/provider.js`, `core/storage/adapter.js` — see §2.2 |

Maps onto `classify-modules.mjs`'s own richer, pre-existing vocabulary
(`shared`/`local`/`cloud`/`composition-full`/`composition-lite`/`mixed`/`unclear`)
— `composition-full`/`composition-lite` both collapse to `composition`
(edition preserved separately in a `compositionEdition` field);
`unclear` maps to `unclassified`. The manifest is NOT a second,
independent classification — every category is derived mechanically from
`classify-modules.mjs`'s own real reachability facts, re-exported and
re-shaped, never re-computed by a separate pass.

### 2.1 `tooling` — a genuinely new distinction

`classify-modules.mjs`'s own pre-existing `runtimeCoupling` field already
separates "reachable only from Full" from "genuinely ONNX/Ollama-coupled"
— of the 84 files it classified `'local'` before Phase 8A, 62 had
`runtimeCoupling: 'none'` (Full-only purely because Lite has no MCP entry
point / isn't a dev-tooling surface, not because of any local-runtime
edge). This manifest makes that distinction a real, separate top-level
category (`tooling`) instead of leaving it folded into `local`, matching
the task's own explicit 7-category vocabulary. `tooling` = the MCP
protocol server (a distinct external-AI-client-facing surface with no
Lite equivalent) plus the dev/maintenance CLI surface (`smoke.js` and its
57 section fixtures, `sync.js`, `doctor.js`, `backfill-tags.js`,
`backfill-entity-refs.js`, `bootstrap-docs.js`) — neither has anything to
do with the cloud-vs-local runtime-capability axis this task is really
about.

### 2.2 The 2 `unclassified` files are documented contracts, not dead code

`core/generation/provider.js` and `core/storage/adapter.js` are
**zero-importer** files (confirmed: no real `import` statement anywhere
in the codebase references either) — pure JSDoc `@typedef` contract
definitions (`GenerationProvider`, `StorageAdapter`) plus a small runtime
shape validator, explicitly documented in their own header comments as
"no backend imports... must stay importable with zero configuration."
They are reachable from neither Full nor Lite roots because they are
never `import`ed at all — every real consumer (the generation
registry's provider map, the storage factory) references the shapes
these files DOCUMENT, not the files themselves. This is the exact
"shared contract" pattern Part D asks the three `*-lazy.js` shims to
adopt — see §4, which draws directly on this existing pattern rather
than inventing a new one.

### 2.3 One open classification ambiguity, not resolved in Phase 8A

3 of the 10 `cloud`-classified files
(`src/admin/composition/lite.js`, `src/core/settings/lite-policy.js`,
`src/core/settings/service.lite.js`) are `cloud` only because
`classify-modules.mjs`'s fallback rule reads "reachable from Lite, never
from Full" as `cloud` — a reasonable default when Lite's reachable-only
set is dominated by real cloud-provider files, but architecturally
inaccurate for these 3: `admin/composition/lite.js` is Lite's own
composition root (the direct analog of `admin/server-full.js`, which is
correctly `composition`, not `cloud`); `lite-policy.js`/`service.lite.js`
are a generic settings allow-list/wrapper mechanism that happens to
gate mostly-cloud setting keys, not cloud-provider integration code
themselves. Left unreclassified in Phase 8A — fixing this would be a
THIRD classifier change beyond the two Part A already made, and the two
Part A fixes were justified as "obvious errors of the analyzer itself"
(a genuinely untraced root, a stale hard-coded special case); this is a
softer, more debatable taxonomy call better made as part of an actual
Phase 8 physical-move step (§6, step 1) where the target directory for
these 3 files is decided concretely, not abstractly. Pinned as a known,
tested exception in `tests/unit/architecture/shared-cloud-local-manifest.test.js`
so it cannot silently drift further without a test noticing.

## 3. Part C — dependency-direction violations

New: `scripts/audit/find-dependency-violations.mjs`, which walks the
manifest's own `directDependencies` edges against the task's target
rules.

**Real violations found: zero.**

| Direction | Edges found | Verdict |
|---|---|---|
| `shared → local` | 0 | Clean |
| `cloud → local` | 0 | Clean |
| `local → cloud` (unjustified) | 0 | Clean |
| `shared → cloud` | **12** | Reviewed findings, not violations — see below |

### 3.1 The 12 `shared → cloud` edges are an established, reviewed pattern

Every one of the 12 edges (`core/embeddings.js`, `core/retrieval/search.js`,
`core/generation/registry.js`, `core/settings/definitions.js`,
`core/token-count.js`, `core/embedding-profile/{availability,resolve}.js`,
`core/config.js`, `indexer/run.js`, `admin/api/generation-models.js`,
`admin/register-neutral-routes.js`, `admin/ui-src/global-settings-view.js`
→ one of `qdrant-cloud-{catalog,models,tokenizer}.js`,
`gemini-models.js`, `generation/gemini-provider.js`) is the SAME
already-established pattern this codebase uses throughout: shared
orchestration code reads a cloud PROVIDER's catalog/config/tokenizer data
unconditionally, exactly mirroring how `generation/registry.js`'s own
provider-factory map references BOTH `gemini-provider.js` AND
`ollama-provider.js` unconditionally (an accepted, pre-existing pattern,
confirmed correctly classified `shared` itself). Inspected each target
file directly: `qdrant-cloud-models.js` is pure data (zero dependencies,
confirmed by its own header comment, safe even in the browser bundle);
`qdrant-cloud-catalog.js`'s functions reached from these edges
(`checkEmbedInputFits`, tokenizer/budget calculators) make no live
network call themselves — the actual Qdrant Cloud Inference HTTP call
happens only inside `admin/system/qdrant-cloud.js`
(correctly classified `cloud`, never imported by a `shared` file).
None of the 12 edges give a `shared` file the ability to reach `local`
code or a heavy local package — confirmed separately and exhaustively by
the zero `shared → local` result above.

**Decision**: not flagged as violations requiring a fix. Pinned as a
regression-tested count (`tests/unit/architecture/shared-cloud-local-manifest.test.js`
asserts exactly 12) so a FUTURE change to this count — up (a new shared
file reaching into cloud code) or down (an edge removed) — is a visible
signal a human should look at, without treating today's 12 as something
to eliminate.

### 3.2 Build-time shim compensates for dependency direction — exactly 3 places, by design

The task's own Part C explicitly asks to find "місця, де build-time shim
компенсує неправильний dependency direction." Found: exactly the 3
`*-lazy.js` files (`core/ollama-lazy.js`, `core/onnx-embed-lazy.js`,
`indexer/phases/tag-onnx-lazy.js`), each with a real, direct dependency
on a `local`-classified target (`ollama.js`; `onnx-embed.js`/
`length-bucket.js`; `tag-onnx.js`). Without the shim's dynamic-import
indirection, EVERY real consumer of each shim (all classified `shared` —
`embeddings.js`, `generation/ollama-provider.js`, `run.js`, 4 indexer
phase modules, `preflight.js`) would have a direct `shared → local`
static edge. This is precisely what "a build-time shim compensates for
the wrong direction" means here — it is a deliberate, working, already
audited-in-Phase-7 mechanism, not an accidental one. See §4 for the
target architecture that would let these 3 shims be removed by replacing
the compensation with a real composition-time injection seam instead.

### 3.3 Other Part C checks

- **Files staging includes but Lite never uses**: 3 —
  `core/generation/provider.js`, `core/storage/adapter.js` (the two
  zero-importer contract files, §2.2 — harmless dead weight, not a safety
  issue) and `core/rerank.js` (Full-reachable via the search route's
  deterministic-rerank call, zero local-runtime coupling of its own,
  simply never invoked by Lite's own search handling today — a real
  `move`-to-fully-shared candidate for a future phase, not a bug).
- **Closure validator allows only via a manual/reviewed exception**:
  exactly one — `local/core/onnx-runtime.js`'s (at `core/onnx-runtime.js`
  when this audit was originally written, before Step 2's physical move)
  `require(resolveOnnxRuntimeModule(env))` (a genuinely non-literal
  runtime resolution of `onnxruntime-node` itself, or a user-supplied
  override path), already tracked in
  `tests/unit/architecture/full-lite-boundary.test.js`'s
  `ALLOWED_NON_LITERAL_REFERENCES` since before this phase.
- **env/provider branching replacing a composition boundary**: none
  found. Zero remaining `SEMIDEX_LITE`/`IS_LITE` references exist
  anywhere under `src/` (Phase 6 removed the last of them from the UI).
  Raw `process.env.DENSE_PROVIDER`/`SEMIDEX_GENERATION_BACKEND`/
  `TAG_PROVIDER` reads outside the two real provider registries
  (`storage/factory.js`, `generation/registry.js`) exist only in
  `doctor.js` (a Full-only tooling script reporting the resolved config
  to the user — legitimate) and smoke-test fixtures.

## 4. Part D — target architecture for the 3 remaining lazy shims

All three shims were confirmed still load-bearing in Phase 7 (see
`docs/design/phase-7-lite-shim-reduction-2026-08-02.md`) — this section
designs what a REAL composition-seam replacement would look like, per
the task's own template, without implementing it.

```
shared contract
  ← Full composition injects the real local implementation
  ← Lite composition injects a disabled/cloud implementation
```

### 4.1 `core/ollama-lazy.js`

- **Current consumers** (8, all `shared`): `core/embeddings.js`,
  `core/generation/ollama-provider.js`, `indexer/phases/{combined,context,tag,skeleton-summary}.js`,
  `indexer/preflight.js`, `indexer/run.js`.
- **Minimal contract**: `{ generate, embed, getModelContextLength, isThinkingModel, getOllamaEmbeddingDimension, isOllamaReachable, listOllamaModels, generateStream, validateOllamaModels }` — exactly `core/ollama-lazy.js`'s own current export surface, no more (this codebase already has the discipline of a minimal contract; `core/generation/provider.js`'s `GenerationProvider` JSDoc typedef is the closest existing precedent for how such a contract would be documented).
- **Who owns the implementation**: `core/ollama.js` (paths as they existed when this design section was written, before Step 3's physical move — now `local/core/ollama.js`; unchanged in every other respect) for Full; a thin `unavailable()`-typed-error object (unchanged in spirit from today's `.lite.js` shim) for Lite.
- **Where injection happens**: the natural seam is `indexer/index.js` (the one real Full/Lite-shared entry both `admin/jobs/registry.js`'s spawn AND direct CLI invocation go through) or, one level up, wherever `applyAllSettings()`/`run()` is composed — NOT inside `embeddings.js`/`run.js` themselves, which should keep calling a contract-shaped parameter, never `process.env` or a module-level singleton they resolve themselves.
- **Persistent worker lifecycle**: none needed — every `ollama-lazy.js` export is a stateless async wrapper around an HTTP call; no child process, no singleton state beyond the module-cache `_mod` reference itself.
- **Typed errors**: preserved trivially — the Lite implementation object's methods already throw `OllamaNotAvailableInLiteError` today; a composition-injected object would do the same.
- **Indexing/search behavior change**: none, if done correctly — this is a pure "who constructs which object and passes it in" change, not a call-shape change.
- **Shim removal condition**: once every one of the 8 consumers accepts its Ollama-capability object as a constructor/function parameter instead of doing `import { generate } from '../ollama-lazy.js'` at module scope, `ollama-lazy.js`/`ollama-lazy.lite.js` are no longer needed — the two real implementations (`ollama.js`, a Lite stub) would be selected once, at composition time, and threaded down.

### 4.2 `core/onnx-embed-lazy.js`

- **Current consumers** (1, `shared`): `core/embeddings.js` only.
- **Minimal contract**: `{ loadOnnx, loadOnnxBatch }` — 2 functions, both already returning function REFERENCES (not results) that the caller then invokes — this shape maps unusually cleanly onto "the contract IS the injected object" (the object's own two methods, called once per `embeddings.js` invocation to get the real `embedOnnx`/`embedOnnxBatch`/`embedBucketed` functions).
- **Who owns the implementation**: `core/onnx-embed.js` + `core/length-bucket.js` (paths as they existed when this design section was written, before Step 2's physical move — now `local/core/onnx-embed.js` + `local/core/length-bucket.js`; unchanged in every other respect) for Full; a typed-unavailable stub for Lite.
- **Where injection happens**: `embeddings.js` is the ONLY consumer, so the seam could be as narrow as `embeddings.js`'s own top-level exported functions accepting an optional injected onnx-capability object (defaulting to a real, composition-supplied one in production, matching the existing DI convention this codebase already uses pervasively — e.g. `adapter`/`embedQuery` optional-DI parameters throughout `admin/api/*.js`).
- **Persistent worker lifecycle**: none — `loadOnnx`/`loadOnnxBatch` are stateless module-loaders, no child process.
- **Typed errors**: preserved the same way as §4.1.
- **Shim removal condition**: `embeddings.js` accepting its ONNX capability via parameter/injection instead of a module-scope import.

### 4.3 `indexer/phases/tag-onnx-lazy.js`

- **Current consumers** (1, `shared`): `indexer/run.js` only.
- **Minimal contract**: `{ isOnnxTagProvider, addTagsOnnxBatch, shutdownOnnxTagWorker }`.
- **Who owns the implementation**: `indexer/phases/tag-onnx.js` (unchanged) for Full; a typed-unavailable stub for Lite, EXCEPT `shutdownOnnxTagWorker` — see below.
- **Where injection happens**: `indexer/run.js`'s own top-level composition (it already calls `applyAllSettings()`/resolves its own dependencies once per run) is the natural seam — this is the file that owns the whole indexing pipeline's lifecycle already.
- **Persistent worker lifecycle — the one real complication**: unlike the other two shims, `tag-onnx.js` manages a genuine, persistent, singleton `fork()`ed child process (`tag-onnx-worker.js`) with its own FIFO request queue, load/request timeouts, and an explicit `shutdownOnnxTagWorker()` cleanup call `run.js` invokes UNCONDITIONALLY in its own `finally` block on every indexing run, regardless of whether tagging was ever used — this is why the existing Lite shim's `shutdownOnnxTagWorker` is a genuine no-op (`async () => {}`), NOT a typed-error throw like every other export: a real live-indexing bug (documented in the shim's own header comment) crashed a Lite run with `TagOnnxNotAvailableInLiteError` on this exact call before that fix. Any future composition-injected replacement MUST preserve this exact "cleanup is always safe to call, even when nothing was ever started" contract — it is not optional simplification, it is a load-bearing behavioral requirement discovered by a real production incident.
- **Typed errors**: preserved for `addTagsOnnxBatch` (throws); NOT for `shutdownOnnxTagWorker` (always resolves).
- **Indexing behavior change**: none, if the no-op cleanup contract above is preserved exactly.
- **Shim removal condition**: `run.js` accepting its tag-onnx capability via injection instead of a module-scope import, AND the injected object's `shutdownOnnxTagWorker` preserving the always-safe-no-op contract for the Lite/disabled case.

### 4.4 Common design note (not a new framework)

All three contracts above are DIFFERENT shapes (9 methods, 2 methods, 3
methods) with different lifecycle requirements (none, none, persistent
worker) — deliberately not unified into one generic
`LocalCapabilityProvider` interface. This matches the task's own explicit
instruction not to build a speculative provider framework; it also
matches this codebase's own established convention (Phase 6's UI-side
capability seam, `setLocalSettingsCapabilities()`/
`setJobsLocalCapabilities()`/`setSettingsLocalCapabilities()`, likewise
uses three separate, narrow, differently-shaped contracts rather than one
shared interface — this Part D design is the server-side mirror of a
pattern already proven, not a new one).

## 5. Part E — target physical tree

The codebase is, at the FILE level, already remarkably close to this
target shape — the manifest shows only 6 truly `mixed` files (the 3 shim
pairs) in the entire 235-file tree; almost every directory is already
internally homogeneous. The disposition below is overwhelmingly "this
directory is already one category, it would just move as a unit" rather
than "this directory needs internal splitting."

```
src/
  shared/          (122 files today, ~120 after the ambiguity in §2.3
                     is resolved and core/rerank.js is confirmed movable)
    admin/         (register-neutral-routes.js, router.js, server.js,
                     static.js, api/*.js minus the 2 local ones, jobs/,
                     system/folder-picker.js, ui-src/ minus local-features.js)
    core/          (config.js, embeddings.js, point-id.js, node-id.js,
                     qdrant.js, sparse.js, token-count.js, bge-tokenizer.js,
                     entity-reference.js, env.js, env-bootstrap.js,
                     doctor-checks.js, onnx-paths.js, bench-telemetry.js,
                     ask/, ask-api/, assembly/, http/, qdrant/, retrieval/,
                     settings/ minus lite-policy.js/service.lite.js,
                     embedding-profile/ minus the 3 qdrant-cloud-*.js,
                     storage/ minus storage/adapter.js's own disposition
                     question (§2.2), generation/ minus gemini-provider.js)
    indexer/       (everything except phases/tag-onnx.js, workers/tag-onnx-worker.js)
  cloud/           (10 files today)
    core/
      embedding-profile/qdrant-cloud-{catalog,models,tokenizer}.js
      generation/gemini-provider.js
      gemini-models.js
    admin/
      api/qdrant-cloud.js
      system/qdrant-cloud.js
  local/           (16 files today; 7 physically relocated as of Step 3 —
                     see that step's own and Step 2's "IMPLEMENTED" notes
                     above; the remaining 9 are still physically at their
                     ORIGINAL src/ locations pending Step 4)
    core/
      onnx-embed.js, onnx-runtime.js, onnx-probe-runner.js,
      onnx-provider-probe.js, length-bucket.js — MOVED (Step 2, real,
      physically at src/local/core/ today)
      ollama.js, ollama-models.js — MOVED (Step 3, real, physically at
      src/local/core/ today)
      ce-rerank.js, ce-rerank-worker.js, rerank.js (pending the §3.3
      move-to-shared question; NOT YET MOVED regardless)
    admin/
      api/onnx.js, api/ollama-models.js, system/ollama.js — NOT physically
      moved and NOT planned to move — Step 3's own execution found both
      ollama-models.js/onnx.js under admin/api/ and system/ollama.js under
      admin/system/ are thin wrapper/route files, not genuine Ollama
      implementation, so this plan's own original Step 3 file list (which
      included them) was narrowed at execution time — see that step's own
      "IMPLEMENTED" note for the reasoning. Correctly classified `local` by
      classify-modules.mjs via their own dependency on the real
      implementation, not by physical location.
    indexer/
      phases/tag-onnx.js, workers/tag-onnx-worker.js — NOT YET MOVED
      (Step 4; still at src/indexer/ today)
    admin/ui-src/
      local-features.js — NOT YET MOVED (deferred, §5's own "split, narrow"
      disposition for admin/ui-src/ as a whole)
  composition/
    full/          (admin/bootstrap.js, admin/server-full.js,
                     admin/ui-src/entries/full.js)
    lite/          (admin/composition/lite.js, admin/ui-src/entries/lite.js,
                     — and, pending §2.3's resolution, core/settings/lite-policy.js,
                     core/settings/service.lite.js)
  tooling/         (75 files — src/mcp/**, src/smoke/**, and the
                     sync.js/doctor.js/backfill-*.js/bootstrap-docs.js
                     entry points themselves; LEFT AS-IS, not moved — see
                     the "defer" disposition below)
```

### Per-directory disposition

| Current directory | Disposition | Why |
|---|---|---|
| `src/core/*.js` (top-level, 28 files) | **split** | The one genuinely mixed-category directory — 14 shared, 10 local, 1 cloud, 3 mixed-shim files sit as flat siblings today; would split cleanly along the manifest's own per-file category, no file itself needs internal changes |
| `src/core/embedding-profile/` | **split** | 6 shared, 3 cloud (`qdrant-cloud-*.js`) — clean per-file split, zero internal file changes needed |
| `src/core/generation/` | **split** | 4 shared (`config.js`, `ollama-provider.js`, `registry.js`, `runtime.js`), 1 cloud (`gemini-provider.js`), 1 unclassified contract (`provider.js`, stays wherever contracts live — see below) |
| `src/core/storage/` | **mostly leave** | 4 shared, 1 unclassified contract (`adapter.js`) — no local/cloud split needed here at all today, `qdrant-adapter.js` is the one and only storage backend, correctly shared |
| `src/core/qdrant/` | **leave** | Entirely shared — Qdrant is the ONE storage backend both editions use; "qdrant" in the directory name does not mean "cloud-only," confirmed by the Qdrant SDK research (§8) — the base collection/points API this directory wraps is not Cloud-Inference-specific at all |
| `src/core/retrieval/` | **leave** | Entirely shared |
| `src/core/settings/` | **mostly leave, 1 open question** | 3 shared, 2 cloud-classified-but-really-composition (`lite-policy.js`, `service.lite.js` — §2.3) |
| `src/indexer/` (top-level + `phases/`) | **split, narrow** | Only 2 real files (`phases/tag-onnx.js`, `workers/tag-onnx-worker.js`) plus the shim pair need to move; everything else (24 files) is already shared |
| `src/admin/` (top-level) | **leave** | Already exactly composition (`bootstrap.js`, `server-full.js`) + shared (`register-neutral-routes.js`, `router.js`, `server.js`, `static.js`) — no split needed |
| `src/admin/api/` | **split, narrow** | 15 shared, 2 local (`onnx.js`, `ollama-models.js`), 1 cloud (`qdrant-cloud.js`) — clean per-file split |
| `src/admin/composition/` | **leave, rename category only** | Already its own directory; the one file in it (`lite.js`) just needs its manifest category corrected from `cloud` to `composition` per §2.3, no physical move |
| `src/admin/system/` | **split, narrow** | 1 file each of shared/local/cloud — trivial per-file split |
| `src/admin/ui-src/` | **split, narrow** | 23 shared, 1 local (`local-features.js`), plus the 2 already-separate `entries/` composition files — Phase 6 already did the hard part (physically separate partials/entries); this is the smallest remaining piece |
| `src/mcp/`, `src/smoke/` | **defer** | See Part F/G — `tooling` is deliberately NOT part of this migration's shared/cloud/local scope; physically relocating 75 files that are already 100% excluded from Lite by a 2-line `EXCLUDE_DIRS` rule would be pure churn with zero closure-safety benefit |

## 6. Part F — Lite staging strategy: allow-list vs. entry-closure

### Option 1 — allow-list staging (copy only `shared/`, `cloud/`, `composition/lite/`)

- **Safety**: high, but only as good as the directory boundary itself — a
  file physically misplaced into `shared/` when it should be `local/`
  would ship silently, with no closure-validator catch (the validator
  would see it "belongs" in the shipped tree by directory, and never
  question WHY).
- **Transparency**: very high — `packages/lite/build.mjs` becomes
  `EXCLUDE_DIRS: ['local/']` plus the existing `admin/ui-src`/`mcp`/
  `smoke`/`test-fixtures` exclusions, replacing today's 25-entry
  `EXCLUDE_FILES` list entirely. A reviewer can answer "is X in Lite?" by
  looking at which directory X lives in, no graph traversal needed.
- **Maintainability**: high, PROVIDED the physical move actually
  happens and stays disciplined — the risk shifts from "did anyone
  forget to add a new local file to `EXCLUDE_FILES`" (today's real
  failure mode) to "did anyone accidentally create a new file in the
  wrong top-level directory" (arguably an easier mistake to catch in
  code review, since the directory is visible at a glance in a diff).
- **Dynamic imports/workers**: NOT provably safe by directory alone — a
  `shared/`-directory file could still contain a literal
  `await import('../local/something.js')` and the allow-list mechanism
  itself would not catch it; this is EXACTLY why the existing closure
  validator (an AST-based check, not a directory check) must remain
  regardless of which staging strategy is chosen — allow-list staging
  narrows the SOURCE of truth for "what gets copied," it does not
  replace the validator that proves "what got copied is actually safe."
- **Package debugging**: easier — `packages/lite/src/` (the staged
  mirror) would visually mirror `src/shared/` + `src/cloud/` +
  `src/composition/lite/` exactly, with no files present that "shouldn't"
  be there requiring cross-referencing an exclude list to explain.
- **Risk of accidentally skipping a runtime file**: LOWER than today for
  a different reason — an allow-list only ever includes what's
  explicitly listed, so a NEW file added anywhere would need to be
  explicitly placed into a real directory to ship at all (impossible to
  silently ship an unclassified file, unlike today's deny-list, where a
  new local-only file ships by default unless someone remembers to
  exclude it — the exact class of bug `EXCLUDE_FILES`'s own header
  comment already frets about).
- **npm tarball / clean-install compatibility**: no change needed to
  `packages/lite/package.json`'s `"files"` field or the clean-install
  acceptance test's own assertions — both already operate on
  `packages/lite/src/`, the staged mirror, regardless of which rule
  populates it.

### Option 2 — entry-closure staging (AST-computed reachable-set copy)

- **Safety**: theoretically the HIGHEST — copies exactly what's reachable
  from Lite's real entry points, nothing more, nothing less, by
  construction (this is literally what `computeReachable()` already
  computes for the CLOSURE VALIDATION step today — Option 2 would just
  use that same computation to decide WHAT to copy, not merely what to
  validate afterward).
- **Transparency**: LOWER — "is X in Lite?" requires running the graph
  tool, not glancing at a directory; a reviewer cannot eyeball a
  `git mv` diff and know the staging consequence the way they could with
  Option 1.
- **Maintainability**: the computation is already fully automated and
  already exists (`computeReachable` + `LAZY_SHIM_SUBSTITUTIONS`) — in
  that sense "maintaining" the staging RULE requires zero ongoing
  hand-editing at all, a real advantage over both Option 1 and today's
  deny-list. But debugging "why did file X ship" or "why didn't file X
  ship" requires re-running the graph tool and reading its trace, not
  looking at a file's own location.
- **Dynamic imports/workers**: fully covered by construction, same as
  today's validator — this is exactly what the validator already proves,
  Option 2 would just also use it to decide the COPY set, closing the
  "the exclude list itself could theoretically drift from the graph"
  risk (which, per this phase's own manifest work, is empirically NOT a
  problem today for local-runtime safety — zero shared/cloud→local
  violations were found — but the drift risk that motivated Phase 7's
  `lazy-shim-substitutions.mjs` unification is a real, general pattern
  worth closing here too).
- **Package debugging**: HARDER than Option 1 — a Lite bug report
  ("why does the tarball not have file X") requires re-deriving
  reachability, not reading a directory tree.
- **Risk of accidentally skipping a runtime file**: the LOWEST of all
  three options in principle (staging IS reachability, no second list to
  drift from it) — but the actual computation already exists and already
  drives closure VALIDATION; using it to drive staging too is a genuinely
  small change from where the codebase already is.
- **npm tarball / clean-install compatibility**: same as Option 1 — no
  change to `package.json`'s `"files"` or the acceptance test's own
  assertions.

### Recommendation: Option 1 (allow-list staging), AFTER the physical move

Recommend allow-list staging directory structure as the END STATE, but
only once the physical `shared/`/`cloud/`/`local/` directories genuinely
exist (Part G's migration order) — NOT as an intermediate step layered on
top of today's still-flat `src/` tree. Reasoning:

1. **Transparency is the deciding factor for a project at this
   maturity level.** This codebase's own established convention
   (confirmed throughout Phases 1–7) consistently favors real,
   file-level, human-inspectable guarantees over computed ones where
   both are available — e.g. Phase 7 chose real regression-tested import
   PATHS over a purely-computed "trust the graph" claim specifically so
   a human reviewer could verify each one directly. A directory boundary
   is the most human-inspectable guarantee physically possible.
2. **Option 2's theoretical safety edge is not a REAL edge here.**
   Entry-closure staging's main advantage over allow-list staging is
   "catches a file misplaced into the wrong directory" — but Option 1
   would still run the EXACT SAME closure validator afterward (this is
   not optional under either option — dynamic imports/workers require
   it regardless), so a misplaced file still gets caught, just one step
   later (at validation instead of at copy-time). The practical
   difference is negligible; the practical difference in
   debuggability/reviewability is not.
3. **Zero regression risk to the exact thing that matters most today.**
   Both options preserve every one of the acceptance criteria Phases
   6–7 established (heavy packages absent, closure clean, tarball
   `index.html` filename, clean-install acceptance) — this is a choice
   between two SAFE options, not safe-vs-unsafe, so the tie-break
   correctly goes to whichever is easier for a human to reason about
   without running a script.

`tooling/` (`mcp/`, `smoke/`) stays excluded via the SAME simple
directory rule it already uses today (`EXCLUDE_DIRS`) — neither staging
option changes anything about how MCP/dev-tooling exclusion works, since
neither is part of this migration's shared/cloud/local scope at all
(§5's "defer" disposition).

## 7. Part G — staged migration plan

Each step is independently committable/revertable and does not depend on
Phase 8B+ existing yet beyond the step immediately before it. No step in
this list was executed as part of Phase 8A.

### Step 1 — Introduce contracts/composition seams, zero file moves — IMPLEMENTED (see `docs/design/phase-8b-capability-contracts-and-composition-seams-2026-08-02.md`)

**Files**: new contract objects for the 3 shim capabilities (§4), wired
into `indexer/index.js`'s (or one level up) composition; the 8+1+1
consumers updated to accept an injected parameter instead of a
module-scope `*-lazy.js` import. `admin/composition/lite.js`'s manifest
category corrected (§2.3) as part of this step, once its real target
directory is decided.
**Behavioral risk**: low — pure DI-parameter threading, same call
results, no shim file deleted yet (the shims can coexist with the new
seam as a transitional default during this step).
**Depends on**: nothing before it.
**Tests**: existing per-shim drop-in-replacement tests
(`tests/unit/core/{ollama,onnx-embed}-lazy-lite-shim.test.js`,
`tests/unit/indexer/phases/tag-onnx-lazy-lite-shim.test.js`) extended to
also exercise the new injected-parameter call shape; `npm test`+`npm run smoke`.
**Exit gate**: every consumer accepts injection; the OLD `*-lazy.js`
import path still works too (both paths tested), zero behavior change.
**Separate PR**: yes. **Rollback boundary**: revert the one commit; no
downstream step depends on this one being merged to remain functional.

As implemented, across three rounds of code review: 6 narrow,
provider-neutral capability contracts (`OllamaGenerateCapability`/
`OllamaSummaryCapability`/`OllamaEmbedCapability`/`OllamaDiscoveryCapability`
in `core/generation/ollama-capability.js`, plus `OnnxEmbedCapability` and
`TagOnnxCapability`) were added, each with a `REQUIRED_*_METHODS` list
and a `validate*()` shape-checker, mirroring the pre-existing
`GenerationProvider`/`StorageAdapter` contract pattern. The Ollama
surface was split twice — first into 3 contracts after review found the
initial single wide shape forced every consumer to implement methods it
never called; then further into 4 after a second review found even the
post-split "generation" contract (4 methods) was still wider than
`context.js`/`tag.js`/`combined.js` individually needed (each calls only
`generate()`) — settling once every remaining contract matched its real
consumer(s) exactly (`generate`-only for those three; `generate` +
`getModelContextLength` + `isThinkingModel` for `skeleton-summary.js`;
`generateStream` ended up in no contract at all, since no shared-contract
consumer calls it). All 7 real shared consumers now call through a
module-scope capability binding, set by their own `apply*Capability()`
seam.

Composition wiring closed two more real gaps found across the two review
rounds. Round 1: `applyAllCapabilities()` existed and was fully tested
but nothing in production ever called it — fixed by wiring an explicit
call into `indexer/index.js`'s `isMainModule` guard, after
`applyAllSettings()` and before `run()`, with the 3 real `*-lazy.js`
modules; and `admin/composition/lite.js`'s `applyEmbeddingCapabilities()`
call ran at module IMPORT time — a real bug that would have permanently
mutated the shared `embeddings.js` singleton for the whole process merely
from importing the file — fixed by scoping it inside `createLiteApp()`
itself. Round 2 found round 1's Lite-side fix was still incomplete:
`core/embeddings.js`'s `_ollama`/`_onnxEmbed` bindings are process-wide
state shared across ALL THREE real Full entry points that reach that
dispatch (indexer CLI, admin server, MCP server) as well as Lite — before
round 2, only `createLiteApp()` and `indexer/index.js` ever asserted
anything about this state, so a process constructing a Lite app and then
a Full admin-server app (which genuinely happens in an existing test)
would leave Full permanently stuck on Lite's typed-unavailable rejection
with no code path that ever recovered it. Fixed (round 2) by making
`admin/server-full.js`'s `createApp()` and `src/mcp/server.js` also
explicitly reassert the real capability every time they run — all real
composition roots that touch this singleton became symmetric ("last
call wins," not one-directional poisoning). A THIRD review round
correctly pushed back that "last call wins" is still not real isolation
— only a safer ordering convention on the same shared mutable state, so
two composition roots constructed concurrently (or interleaved with
async work) could still observe the wrong capability. Fixed (round 3) by
giving `core/embeddings.js`'s `embedForIndex`/`embedForIndexBatch`/
`embedForSearch` a genuine per-call `capabilities` parameter that bypasses
the shared module-scope state entirely when supplied, and wiring the 3
real callers that matter (`indexer/run.js` for indexing;
`admin/server-full.js`'s `createApp()` and
`admin/composition/lite.js`'s `createLiteApp()` for search/Ask, via a
bound `embedQuery` closure each already-existing DI parameter now
resolves to by default; `mcp/server.js` via a new
`tools/search.js`'s `setEmbedQuery()` seam) to supply their own
capability explicitly, per call, captured at construction time — the
module-scope fallback remains only as a safety net for callers not yet
updated. Verified with a real HTTP regression test: construct and start
Lite's server, construct Full's server SECOND in the same process, then
confirm Lite's already-running server still returns its own typed
rejection on a real request — checked to actually catch the regression
(reverting the fix made the test fail with a real network error instead)
for both the round-2 and round-3 fixes independently. A separate,
correctly non-actionable review observation was that the physical
dependency graph itself is still not cut by this step
(`indexer/index.js` now directly imports all three `*-lazy.js` modules,
and the shim-necessity architecture test still correctly reports all
three as `KEEP`) — this is Step 1's own intended scope, not a defect;
graph-cutting is a later physical-relocation concern.

`admin/composition/lite.js`'s own cloud-vs-composition manifest
ambiguity (§2.3) was intentionally left unresolved in this step — a
debatable taxonomy call better made concretely during the actual
directory move (Steps 2–6/9), not abstractly here. All 3 shims remain
fully in place; zero indexing/search/generation/tagging behavior changed
(confirmed by 2755/2755 `npm test`, 1316/1316 `npm run smoke`, both admin
UI builds, and the Lite closure validator all green after both review
rounds). See the linked report for the full per-consumer call-site list,
the composition-wiring detail (including a real closure-breaking mistake
caught and fixed before ever running the validator), and the manifest's
own `mixed`-count implications.

### Step 2 — Physically relocate the local embedding runtime — IMPLEMENTED (see `docs/design/phase-8b-capability-contracts-and-composition-seams-2026-08-02.md` §12)

**Files**: `core/onnx-embed.js`, `core/onnx-runtime.js`,
`core/onnx-probe-runner.js`, `core/onnx-provider-probe.js`,
`core/length-bucket.js` → `src/local/`. Update the 1–2 real importers'
paths (`core/embeddings.js`, `admin/api/onnx.js`).
**Behavioral risk**: low — pure path rename, no logic change.
**Depends on**: Step 1 (so `embeddings.js` is already calling through
the new seam, not a stale direct import that would need touching twice).
**Tests**: `npm test`, `node packages/lite/build.mjs` (closure must stay
clean with updated paths), the drift test (manifest regenerated,
committed).
**Exit gate**: closure validator clean; `admin:build`/`admin:build:lite`
succeed; tarball size unchanged.
**Separate PR**: yes. **Rollback boundary**: revert; Step 1's seam still
works with files at their old path if this step is reverted alone.

As implemented: the target directory is `src/local/core/` (one level more
specific than this section's own original `src/local/`, matching Step 2's
own concrete task instructions — `src/local/` remains the eventual home for
every local-runtime file across Steps 2–4, of which `core/` is the first
populated subdirectory). All five files moved via `git mv`, preserving
history. Internal cross-references between the five moved files were kept
relative (`./onnx-runtime.js` etc. — both files moved together, so the
relationship didn't change); references to files that stayed in `src/core/`
(`onnx-paths.js`, `doctor-checks.js`) were updated to `../../core/...`; one
`node_modules`-relative reference in `onnx-probe-runner.js` gained an extra
`../` for the new directory depth. External importers updated:
`core/onnx-embed-lazy.js` (2 dynamic-import specifiers), `admin/api/onnx.js`,
`doctor.js`, 2 smoke sections, 12 benchmark scripts, and every test file
importing a moved file directly. `packages/lite/build.mjs`'s `EXCLUDE_DIRS`
gained a `'local'` entry (replacing 5 individual `EXCLUDE_FILES` name
entries) — `scripts/audit/classify-modules.mjs`'s own independent
re-derivation of the same exclusion rule was updated in parallel, keeping
the two lists in sync as they were before. Verified: Lite tarball byte-
identical to baseline (413.9 kB packed / 1.4 MB unpacked / 129 files — these
5 files were already excluded from Lite before the move, so relocating them
changed nothing about what ships), closure validator clean (117 staged
files, same as baseline), 2788/2788 `npm test` (2774 baseline + 14 new
regression tests in `tests/unit/architecture/phase-8b-step2-local-relocation.test.js`),
1316/1316 `npm run smoke`, both admin UI builds byte-identical, clean-install
acceptance green. New regression tests prove (not merely assert) three
things a path rename could silently violate: the old `src/core/*.js` paths
are gone AND no production import specifier anywhere under `src/`,
`benchmarks/`, or `scripts/` still resolves to one (verified to genuinely
catch a reintroduced stale path, not just pass trivially); the new
`src/local/core/*.js` paths exist; and the Lite tarball's own staged file
list (via `build.mjs`'s real `stageSrc()`, not a simulation) contains zero
files under `local/` at all — a stronger claim than "unreachable," since it
confirms the directory is never even copied.

### Step 3 — Physically relocate the Ollama generation/context runtime — IMPLEMENTED (see `docs/design/phase-8b-step3-local-ollama-relocation-2026-08-05.md`)

**Files**: `core/ollama.js`, `core/ollama-models.js`,
`admin/system/ollama.js`, `admin/api/ollama-models.js` → `src/local/`.
**Behavioral risk**: low — same shape as Step 2.
**Depends on**: Step 1.
**Tests/exit gate**: same shape as Step 2.
**Separate PR**: yes. **Rollback boundary**: independent of Step 2.

As implemented: only `core/ollama.js` and `core/ollama-models.js` — the two
genuine Ollama-implementation files — physically moved, to
`src/local/core/`. `admin/system/ollama.js` and `admin/api/ollama-models.js`
were audited and found to be thin wrapper/route files (a readiness-check
wrapper and an HTTP route handler respectively), not implementation —
per this step's own explicit scope ("не перенось orchestration, доменні
контракти або загальні generation abstractions тільки через те, що зараз
вони викликають Ollama"), both stay at their original `admin/` paths,
already correctly classified `local` by `classify-modules.mjs` via their
own dependency on the real implementation, not by their own physical
location. This step also converted the five indexer phase modules
(`context.js`/`tag.js`/`combined.js`/`skeleton-summary.js`/`preflight.js`)
from Step 1's module-scope `apply*Capability()` setters to genuine
instance-scoped capability injection — a deliberate broadening of this
step's original "pure path rename" scope, done because the setter pattern
technically left mutable module-scope state a concurrently constructed
Full/Lite composition (or two sequential runs) could theoretically
contaminate, even though the real process topology (indexer CLI = one
edition per OS process) made this a latent, not live, risk.

### Step 4 — Physically relocate local tagging workers

**Files**: `indexer/phases/tag-onnx.js`, `indexer/workers/tag-onnx-worker.js`
→ `src/local/`. Update `admin/jobs/registry.js`'s spawn-target-adjacent
paths if any reference these by relative path (confirm via the graph tool
before moving, not assumed).
**Behavioral risk**: low-medium — this is the one shim with the
persistent-worker lifecycle constraint (§4.3); re-verify the
`shutdownOnnxTagWorker()` always-safe-no-op contract with a real
live-indexing smoke run after the move, not just unit tests, given that
exact contract was the source of a real past production incident.
**Depends on**: Step 1.
**Tests/exit gate**: same as Step 2, PLUS a real `npm run smoke` section
exercising tag-onnx specifically (already exists —
`smoke/sections/02-onnx-embed.js`/similar — confirm it still runs against
the moved paths).
**Separate PR**: yes.

### Step 5 — Physically relocate cloud providers

**Files**: `core/embedding-profile/qdrant-cloud-{catalog,models,tokenizer}.js`,
`core/generation/gemini-provider.js`, `core/gemini-models.js`,
`admin/api/qdrant-cloud.js`, `admin/system/qdrant-cloud.js` → `src/cloud/`.
**Behavioral risk**: low — but touches the 12 `shared → cloud` edges from
§3.1; re-run `find-dependency-violations.mjs` after the move and confirm
the count is still 12 (same edges, new paths) — a changed count here is
the single most important post-move signal.
**Depends on**: nothing structurally, but sequenced after Steps 2–4 so
the PR review surface for "did local code stay local" and "did cloud code
stay cloud" are never mixed in one diff.
**Tests/exit gate**: same as Step 2, plus the shared-cloud-local-manifest
drift test.
**Separate PR**: yes.

### Step 6 — Physically relocate stable shared modules — IMPLEMENTED in three parts (see `docs/design/phase-8b-step7a-shared-core-relocation-2026-08-07.md` for top-level src/core/*.js, `docs/design/phase-8b-step7b-shared-indexer-relocation-2026-08-07.md` for src/indexer/'s shared files, `docs/design/phase-8b-step7c-admin-relocation-2026-08-08.md` for src/admin/'s shared files; this repo's dated reports call these Step 7A, Step 7B, and Step 7C)

**Files**: the remaining `src/core/*.js` top-level files (14) into
`src/shared/core/`, plus `src/indexer/`'s 24 remaining shared files,
`src/admin/`'s shared files. The single largest step by file count, but
zero logic changes — pure `git mv` + import-path updates.
**Behavioral risk**: low (mechanical) but HIGH REVIEW SURFACE (many
files touched at once) — this is exactly why it comes last among the
"move" steps, once Steps 2–5 have already proven the move mechanics work
correctly on smaller, easier-to-review batches.
**Depends on**: Steps 2–5 (so no remaining ambiguous import needs
touching twice).
**Tests/exit gate**: full `npm test`+`npm run smoke`+both UI
builds+closure validator+clean-install acceptance, all green.
**Separate PR**: yes, and likely the one step worth splitting further by
sub-directory (`core/` first, `indexer/` second, `admin/` third) if
review load is a concern at execution time — not decided here, a
call for whoever executes this step.

**As implemented (Step 7A)**: narrower than this section's original
scope — only the top-level `src/core/*.js` files were moved (17, not the
14 counted here; the extra 3 are `app-data-dir.js`/`bench-telemetry.js`
(added to `src/core/` after this plan was written) and
`rerank-capability.js`, a zero-dependency contract confirmed `shared` by
the same reasoning as `onnx-embed-capability.js` despite its one real
consumer, MCP tools, not currently being Lite-reachable). `src/indexer/`'s
24 shared files and `src/admin/`'s shared files were explicitly deferred
— a later step's own scope, per the executing task's own instructions,
not a gap found during execution. 4 top-level `src/core/*.js` files that
looked like `move` candidates by directory alone were confirmed `local`
(real implementation: `ce-rerank.js`/`ce-rerank-worker.js`/`rerank.js`/
`rerank-provider.js`) or `mixed` (the 3 remaining lazy-shim pairs) by the
real import graph and correctly left in place — the exact "verify via
import graph, not directory-name assumption" discipline this plan's own
Part A calls for. Verified: 0 dependency-direction violations, 0
shared→local/cloud edges, 0 unclassified modules, category counts
unchanged from the pre-move baseline (144 shared/27 local/12
composition/9 mixed/61 tooling/8 cloud), `npm test` (3187/3187), `npm run
smoke`, both admin UI builds byte-identical, Lite closure clean (123
staged files, unchanged), real `npm pack` clean-install acceptance green.

**As implemented (Step 7B)**: the `src/indexer/`'s-24-shared-files portion
deferred by Step 7A above. An actual import-graph inventory (not the
inherited "24" figure) found 24 top-level `src/indexer/*.js` +
`src/indexer/phases/*.js` files genuinely `shared` — moved to
`src/shared/indexer/`, preserving the `phases/` subdirectory structure.
Left at `src/indexer/`: `index.js` (backward-compatible CLI launcher
alias), `index-full.js`/`index-lite.js` (the two edition composition
roots — never shared, since neither is reachable from the other
edition), and the one remaining `phases/tag-onnx-lazy.js`/`.lite.js`
lazy-shim pair (explicitly out of scope, Phase 8B Step 8's own scope).
`index-runtime.js`/`run.js` were checked by real dependency inspection,
not name, per this plan's own Part A instruction — both capability-
injected, zero direct local/cloud implementation edges, confirmed moved.
Two files (`skeleton-warnings.js`, `phases/skeleton-index.js`) needed an
`import.meta.url`-relative path-depth fix (one extra `'../'`) for their
`.tmp/semidex-inspect/` inspect-artifact directory constant — mechanical,
not a logic change, covered by a new behavioral regression test.
Verified: 0 dependency-direction violations, 0 shared→local/cloud edges,
0 unclassified modules, category counts unchanged from the pre-move
baseline, `npm test` (3264/3264), `npm run smoke` (1316/1316), both admin
UI builds byte-identical, Lite closure clean (123 staged files,
unchanged, zero `local/` files, zero `tag-onnx.js`/`tag-onnx-worker.js`
staged at any path), real `npm pack` clean-install acceptance green.

**As implemented (Step 7C)** (`docs/design/phase-8b-step7c-admin-relocation-2026-08-08.md`):
the `src/admin/`'s-shared-files portion deferred by Step 7A/7B above,
covering the Admin runtime AND Admin UI together (this repo's own dated
report combines both, since they share one composition-root wiring
point). An actual import-graph inventory found: 4 top-level Admin
infrastructure files (`router.js`/`server.js`/`static.js`/
`register-neutral-routes.js`), 15 API route modules, 2 job-registry
files, 1 system file (`folder-picker.js`), and 23 shared UI modules (plus
`app.css` and the 12 shared HTML partial templates under
`ui-src/partials/shared/`) genuinely `shared` — moved to
`src/shared/admin/`, preserving internal directory structure
(`api/`, `jobs/`, `system/`, `ui-src/`). 3 local-only files
(`api/onnx.js`, `api/ollama-models.js`, `system/ollama.js`) plus
`ui-src/local-features.js` and `ui-src/partials/full/` (3 HTML files)
moved to `src/local/admin/`. Left at `src/admin/`: `bootstrap.js`,
`server-full.js`, `composition/lite.js` (the two composition roots — never
shared, same reasoning as `index-full.js`/`index-lite.js` in Step 7B),
`jobs/spawn-indexer-{full,lite}.js`, and `ui-src/{entries/,index.html,
lite-entry/,partials/lite/}` (the two edition UI entry points — Lite's own
`partials/lite/` markup is composition-owned, neither shared nor
local-only, confirmed by explicit scope decision during execution, not
directory-name assumption). `src/cloud/admin/` (Step 6) was unaffected.
Two Vite configs (`vite.config.js`'s `edition` alias and `fullReload()`
glob; `vite.config.lite.js` needed zero changes since its own `root`/UI
tree never physically moved) and `packages/lite/build.mjs`'s
`EXCLUDE_DIRS`/`EXCLUDE_FILES` needed depth-sensitive updates — mechanical
consequences of the move, not logic changes, each verified via a real
`npm run admin:build`/`admin:build:lite`/`node packages/lite/build.mjs`
run, not just `node --check`. Verified: 0 dependency-direction
violations, 0 shared→local/cloud edges, 0 unclassified modules, category
counts unchanged from the pre-move baseline (144 shared/27 local/12
composition/9 mixed/61 tooling/8 cloud), `npm test`, `npm run smoke`,
both admin UI builds succeed with zero local-only markers leaked into the
Lite bundle, Lite closure clean (123 staged files), real `npm pack`
clean-install acceptance green.

### Step 7 — Update every import path

Folded into Steps 2–6 above (each step updates its own movers' import
paths as part of the same commit) — listed separately here only because
the task's own template asks for it; in practice, "move files" and
"update their importers' paths" are not meaningfully separable
sub-steps and splitting them would only create a broken intermediate
commit state.

### Step 8 — Remove the 3 now-unnecessary shims

**Files**: delete `core/ollama-lazy.js`/`.lite.js`,
`core/onnx-embed-lazy.js`/`.lite.js`,
`indexer/phases/tag-onnx-lazy.js`/`.lite.js`; remove their entries from
`packages/lite/lazy-shim-substitutions.mjs` (now empty — per Phase 7's
own note, delete that file too once it has zero entries, rather than
leave an empty list); update `scripts/audit/classify-modules.mjs`'s
`LOCAL_ONLY_PATH_PATTERNS` accordingly.
**Behavioral risk**: none, if Step 1's injection seam is already fully
adopted by every consumer (a prerequisite this step's exit gate
re-verifies, not assumes).
**Depends on**: Steps 1–6 all complete (every consumer must be using the
new seam, and every local file must already be physically relocated,
before the shim's dynamic-import target even needs to still resolve).
**Tests/exit gate**: `tests/unit/architecture/lite-lazy-shim-necessity.test.js`
(Phase 7's own test) is DELETED as part of this step (its entire premise
— that the shims exist and are necessary — is gone); the 3
drop-in-replacement test files are deleted too; closure validator clean
with zero shim substitutions configured at all.
**Separate PR**: yes.

### Step 9 — Replace deny-list Lite staging with allow-list staging

**Files**: `packages/lite/build.mjs`'s `EXCLUDE_FILES` (25 entries) and
`EXCLUDE_DIRS`'s `local`-adjacent parts replaced by
`EXCLUDE_DIRS: ['src/local/', 'src/admin/ui-src/', 'src/mcp/', 'src/smoke/', 'src/test-fixtures/', 'src/composition/full/']`
(§6's recommendation) — `EXCLUDE_FILES` should be near-empty afterward
(any remaining entries are genuinely file-level, not directory-level,
exceptions, if any are found at execution time).
**Behavioral risk**: medium — this is the step that changes the
STAGING MECHANISM itself, not just file locations; requires the closure
validator (unchanged in its own logic) to independently re-confirm the
new staged tree matches the old one byte-for-byte in scope (same files
staged, none extra, none missing) before trusting the new rule.
**Depends on**: Steps 2–6 (the directories must exist) and Step 8 (no
shim substitution logic left to reconcile with the new staging rule).
**Tests/exit gate**: a NEW test diffing the staged file SET (not
content) between the old deny-list output (captured once, before this
step, as a fixture) and the new allow-list output — must be identical;
full clean-install acceptance; tarball size unchanged (±expected minor
variance from the shim files' own removal in Step 8).
**Separate PR**: yes.

### Step 10 — Remove obsolete exclusions and compatibility aliases

**Files**: any now-dead entries in `scripts/audit/classify-modules.mjs`'s
`LOCAL_ONLY_PATH_PATTERNS`/`CLOUD_ONLY_PATH_PATTERNS`/`COMPOSITION_FULL_PATTERNS`
(these become largely REDUNDANT once directory-based classification is
possible — `firstPassBucket()` could shrink to "classify by which
top-level directory the file is under," with the graph-facts fallback
becoming a pure sanity-check/drift-detector instead of the primary
mechanism); any leftover re-export shims from the move steps (only if
one was added as a real, verified-necessary compatibility layer during
Steps 2–6 — the task's own constraint against unjustified compatibility
re-exports applies to every prior step too, so this step should find
little or nothing left to remove if the earlier steps were disciplined).
**Behavioral risk**: low.
**Depends on**: Step 9.
**Tests/exit gate**: full suite green; this is the natural "close out
Phase 8" checkpoint — a final `full-lite-shared-architecture-audit`
update marking the whole shared/cloud/local migration complete.
**Separate PR**: yes.

## 8. Qdrant documentation verification

Per the task's explicit requirement, verified the following against
current official Qdrant documentation before making any Qdrant-related
claim in this report:

- **Qdrant Cloud Inference is an extension of the base collection/points
  API**, not a separate service — text/images are passed directly inside
  standard `upsert`/`query` request bodies (a `Document`-typed vector
  field carrying `text` + `model`), and Qdrant computes the embedding
  server-side. Source:
  [qdrant.tech/documentation/cloud/inference/](https://qdrant.tech/documentation/cloud/inference/),
  [qdrant.tech/cloud-inference/](https://qdrant.tech/cloud-inference/).
- **No programmatic model-discovery/list-models API is documented** —
  the only documented discovery path is the Qdrant Cloud Console's
  Inference tab. This confirms the codebase's own existing comment
  (`qdrant-cloud-catalog.js`: "No model-discovery API exists (a
  live-spike finding..., confirmed against the Qdrant Cloud Console for
  one account on 2026-07-21)") is still accurate — not stale, not
  something this phase needed to correct.
- **The JS client (`@qdrant/js-client-rest`) has no built-in
  retry/connection-pooling** — its transport
  (`@qdrant/openapi-typescript-fetch`) is a thin typed-fetch wrapper that
  explicitly leaves retry/backoff to a layer above it. This confirms
  `src/core/qdrant/client.js`'s own retry logic (unrelated to this
  phase's own changes, pre-existing) is not duplicating native client
  functionality — it is filling a real gap. Source:
  [github.com/qdrant/qdrant-js](https://github.com/qdrant/qdrant-js).
- **Qdrant collections have a NATIVE, documented arbitrary top-level
  `metadata` field** (distinct from point payload), settable at creation
  or via a shallow-merge PATCH, synchronized cluster-wide via consensus.
  Confirmed the codebase's `src/core/qdrant/store.js`'s
  `updateCollectionMetadata()` already uses exactly this native
  mechanism (not an invented payload-based convention) to track which
  embedding profile a collection was created with — matching the task's
  own explicit instruction not to invent a Qdrant abstraction when the
  SDK already provides the operation natively. Source:
  [qdrant.tech/documentation/manage-data/collections/](https://qdrant.tech/documentation/manage-data/collections/).

No Qdrant-related architectural claim in §3.1, §5, or §6 above required
inventing behavior beyond what these sources confirm.

## 9. Risks and rejected alternatives

- **Rejected**: reclassifying `admin/composition/lite.js`/
  `lite-policy.js`/`service.lite.js` from `cloud` to `composition` as
  part of Phase 8A itself. Rejected because it is a genuinely debatable
  taxonomy call (§2.3), not an "obvious analyzer error" the way the two
  Part A fixes were — better decided concretely during Step 1/9 of the
  actual migration, when these files' real target directory is chosen,
  than abstractly here.
- **Rejected**: a single unified `LocalCapabilityProvider` interface for
  all 3 shims (§4.4). Rejected per the task's own explicit instruction
  against a speculative provider framework, and because the 3 real
  contracts have genuinely different shapes and lifecycle requirements
  (persistent worker vs. stateless wrapper) that a forced-unified
  interface would either paper over or bloat with unused fields.
- **Rejected**: entry-closure Lite staging (Option 2, §6) as the
  recommendation. Not because it is unsafe — it is arguably marginally
  safer in theory — but because this codebase's own established
  convention favors human-reviewable, file-level guarantees over
  computed ones wherever both achieve the same safety outcome, and here
  they do (the same closure validator runs under either option).
- **Risk carried forward, not resolved here**: Step 4's persistent-worker
  lifecycle move (tag-onnx) is explicitly flagged as the one step in the
  whole plan with real behavioral risk beyond "mechanical path rename" —
  a past production incident already occurred on exactly this contract
  (§4.3). Any future executor of Step 4 should treat the
  `shutdownOnnxTagWorker()` no-op contract as non-negotiable, not an
  implementation detail free to simplify away.
- **Risk carried forward**: the 12 `shared → cloud` edges (§3.1) are
  judged safe today, but that judgment rests on manual inspection, not
  an automated content-level guarantee (e.g. "this file makes no network
  call") — only a count-based regression test exists
  (`shared-cloud-local-manifest.test.js`). A future Phase could consider
  a stronger AST-level check (e.g. "no `shared`-classified file may call
  `fetch`/an HTTP client directly") if this class of risk needs a harder
  guarantee than a human review + a count assertion.

## 10. Verification

| Check | Result |
|---|---|
| `tests/unit/architecture/*.test.js` (full directory, including 2 new Phase 8A test files) | 64/64 pass |
| `tests/unit/admin/ui-composition-isolation.test.js` (Phase 6, unmodified) | pass |
| `node scripts/audit/classify-modules.mjs` | runs clean, 240 modules classified, 0 cloud-imports-local violations, 0 heavy packages reachable from Lite post-shim |
| `node scripts/audit/build-shared-cloud-local-manifest.mjs` | 235 modules classified, manifest committed |
| `node scripts/audit/find-dependency-violations.mjs` | 0 real violations, 12 reviewed shared→cloud findings |
| Drift test genuinely catches corruption | verified — deliberately corrupted one manifest entry, confirmed 3 tests failed with the exact expected assertions, restored |
| `npm test` | see final verification run, §11 of the session's own closing summary |
| `npm run smoke` | see final verification run |
| `git diff --check` | clean |

No production `src/` file was moved. No shim was removed. No behavior
changed.
