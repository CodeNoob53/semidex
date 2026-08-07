# Semidex Lite — package boundary design

Status: implemented (2026-07-31). Foundation only — see the companion
implementation report (`docs/semidex-lite-package-foundation-2026-07-31.md`)
for what remains before a real `npm publish`.

## Goal

A separate, installable npm package — `semidex-lite` — for cheap
servers/containers that need Qdrant Cloud + Gemini only. It must never
download or initialize a local model runtime (`onnxruntime-node`,
`@huggingface/transformers`, Ollama), while reusing the full Semidex `src/`
tree rather than forking it.

## Dependency-graph verdict

Two heavy natives dominate the install footprint: `onnxruntime-node` and
`@huggingface/transformers`. Neither is ever *statically* imported anywhere
in the reachable-from-cloud module graph — both are always behind a
dynamic `import()` or a `fork()`'d child process. That single fact is what
makes a cloud-only package possible without forking the source tree:
**omit the heavy packages from `dependencies`, and any code path that would
have imported them dynamically instead fails a package-closure check at
build time if it's ever actually reachable.**

`@huggingface/tokenizers` is the one ML-adjacent package Lite keeps. It is
**tokenizer-only** — it downloads a `tokenizer.json`, never model weights,
and never touches an inference runtime. Semidex uses it in two places, both
kept in Lite:

- `cloud/embedding/qdrant-cloud-tokenizer.js` (Phase 8B Step 6 — physically
  relocated from `core/embedding-profile/`, see that step's own update
  below) — validates a text chunk fits inside the target Qdrant Cloud
  Inference model's input budget before sending it (`checkEmbedInputFits`,
  `cloud/embedding/qdrant-cloud-catalog.js`).
- `shared/core/bge-tokenizer.js` (via `shared/core/token-count.js`) — the default
  `TOKEN_COUNT=bge-m3` real-tokenizer chunk-sizing mode. Verified during
  this work to have **zero** dependency on `onnx-embed.js` or
  `@huggingface/transformers` — it only downloads and parses the tokenizer
  file, so it works unmodified in Lite.

This is the **local-inference-runtime vs. tokenizer-only-dependency**
distinction the whole design rests on: a package that only ever *counts*
tokens is not a local inference runtime, even though it's the same
underlying HF ecosystem.

`core/ollama.js` is different again: a light `dotenv`+`fetch` client, no
heavy dependency at all, but a **local provider** Lite must not contact.
Excluding it required real source changes (Refactor 1 below), not just an
absent-from-`dependencies` decision.

## The four `SEMIDEX_HOME` storage vars

A globally-installed npm package must not write into its own
`node_modules/` directory (many install layouts make that directory
read-only, and even where it's writable, mixing app state into an installed
package is bad practice). Full Semidex's `config.json`, `settings.json`,
and ONNX tokenizer cache all defaulted to package-relative paths. Four env
vars, each with a Lite-safe default and zero effect on full Semidex when
unset:

| Var | Resolves to | Consumer |
|---|---|---|
| `SEMIDEX_HOME` | Lite app home (`%LOCALAPPDATA%\semidex-lite`, `~/Library/Application Support/semidex-lite`, or `$XDG_DATA_HOME/semidex-lite`) | the Lite CLI itself |
| `SEMIDEX_CONFIG_PATH` | `SEMIDEX_HOME/config.json` | `shared/core/config.js` (existing seam) |
| `SEMIDEX_SETTINGS_PATH` | `SEMIDEX_HOME/settings.json` | `core/settings/settings-store.js` (new) |
| `SEMIDEX_TOKENIZER_CACHE_DIR` | `SEMIDEX_HOME/cache/tokenizers` | `shared/core/onnx-paths.js` (new) |

The Lite CLI (`packages/lite/lite-src/semidex-home.js`) derives all three
child paths from `SEMIDEX_HOME` and sets them **before any runtime module
import** — the same ordering discipline `bootstrapEnv()` already uses for
OS-env-vs-dotenv provenance.

## Refactor 1 — cutting every static `core/ollama.js` edge

Confirmed static importers of `core/ollama.js` reachable from the Lite
indexer/search/admin closure: `embeddings.js`, `indexer/phases/combined.js`,
`context.js`, `tag.js`, `skeleton-summary.js`, `preflight.js`, and
`run.js` directly. Each edge became a dynamic `await import('./ollama.js')`
behind a shared lazy wrapper, `core/ollama-lazy.js`:

```js
let _mod = null;
async function loadOllama() {
  if (!_mod) _mod = await import('./ollama.js');
  return _mod;
}
export async function generate(...args) { return (await loadOllama()).generate(...args); }
// ...
```

`core/ollama.js` never enters the module graph until a local Ollama
operation is actually about to run — which never happens under Lite's
pins. Full Semidex's behavior is observably unchanged (same functions, one
dynamic-import hop later, cached after first load).

**Packaging consequence.** `ollama-lazy.js`'s own
`await import('./ollama.js')` is *itself* a literal dynamic-import target,
and `core/ollama.js` is excluded from the Lite tarball — so a naively
staged `ollama-lazy.js` would fail the closure validator (its target
doesn't exist). The fix: `build.mjs` **substitutes** a Lite-specific
sibling file, `core/ollama-lazy.lite.js`, at the exact same staged path.
Every export throws a typed `OllamaNotAvailableInLiteError`
(`code: 'not_available_in_lite'`) instead of importing anything — a
policy rejection, not a bare `ERR_MODULE_NOT_FOUND` crash, if a future code
change ever accidentally reintroduced a reachable call path.

The same `*-lazy.js` / `*-lazy.lite.js` pattern was applied twice more
during this work, once the closure validator's own output made two more
edges visible:

- **`core/onnx-embed-lazy.js`** — extracted `embeddings.js`'s
  `loadOnnx()`/`loadOnnxBatch()` helpers (previously inline) so
  `embeddings.js` itself (needed for the Qdrant-cloud dense/sparse
  embedding path too) never statically pulls `onnx-embed.js`/
  `length-bucket.js`.
- **`indexer/phases/tag-onnx-lazy.js`** — same treatment for `run.js`'s
  ONNX tag-worker dispatch. Required extracting the pure
  `isOnnxTagProvider` predicate into a third, dependency-free module
  (`tag-provider.js`) so the lazy wrapper's own re-export of that predicate
  never needed to import `tag-onnx.js` (which owns the real `fork()` call).

`core/generation/ollama-provider.js` is the one Ollama-native file that
stays **in the closure** rather than excluded: `generation/registry.js`'s
provider-factory map references `createOllamaProvider` unconditionally
(only *called* when `backend === 'ollama'`), so the file must be staged —
but it now imports from `../ollama-lazy.js` instead of `../ollama.js`
directly, closing the loop the same way.

**Phase 7 update** (`docs/design/full-lite-shared-architecture-audit-2026-08-01.md`,
implemented — see `docs/design/phase-7-lite-shim-reduction-2026-08-02.md`):
all three shim pairs described above were re-audited after Phases 3–6
landed, specifically to check whether any had become redundant. All three
were found still load-bearing — none were removed. The concrete real
import path each one cuts (e.g. `serve-lite.js` → `admin/jobs/registry.js`
→ (spawn) → `indexer/index.js` → `run.js` → the `*-lazy.js` wrapper → the
real local-only file) is now pinned as a regression test in
`tests/unit/architecture/lite-lazy-shim-necessity.test.js`, not merely
asserted in this prose. The one real change this phase made: the
substitution list itself (`{real, shim}` path pairs) was previously
declared independently in both `packages/lite/build.mjs` and
`scripts/audit/classify-modules.mjs` — a silent-drift risk with no test
tying the two together. Both now import a single canonical list from
`packages/lite/lazy-shim-substitutions.mjs`.

**Phase 8A update** (`docs/design/phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`,
audit/plan only, no shim removed or moved): designed, but did not
implement, a target replacement for all three shims above — a shared
capability contract per shim (documented export surface, no backend
import) with Full composition injecting the real local implementation
and Lite composition injecting a typed-unavailable stub, matching the
zero-importer `core/generation/provider.js`/`core/storage/adapter.js`
contract pattern that already exists elsewhere in this codebase. Also
confirmed, by direct inspection, that each shim's own dependency on its
local target (`ollama.js`; `onnx-embed.js`/`length-bucket.js`;
`tag-onnx.js`) is exactly the `shared → local` edge this package
boundary exists to prevent, made safe only by the shim's dynamic-import
indirection plus `packages/lite/build.mjs`'s build-time content
substitution — not by the dependency direction itself being correct. The
`tag-onnx-lazy.js` pair's persistent-worker lifecycle and its
production-incident-derived always-safe-no-op `shutdownOnnxTagWorker()`
contract (§ above) are called out explicitly as a non-negotiable
constraint any future contract-based replacement must preserve. See that
report's own Part D for the full per-shim design and its Part G for the
staged migration order in which shim removal (Step 8) would actually
happen — only after every real consumer is moved onto the new injection
seam, not before.

**Phase 8B Step 2 update** (`docs/design/phase-8b-capability-contracts-and-composition-seams-2026-08-02.md`
§12, implemented): the ONNX half of the local target this paragraph
describes — `onnx-embed.js`/`onnx-runtime.js`/`onnx-probe-runner.js`/
`onnx-provider-probe.js`/`length-bucket.js` — physically moved from
`core/` to `local/core/`. `core/onnx-embed-lazy.js`'s own dynamic-import
specifiers are the only thing inside the shim that changed
(`await import('../local/core/onnx-embed.js')` /
`await import('../local/core/length-bucket.js')`); `packages/lite/build.mjs`
now excludes the whole `local/` directory rather than naming these 5 files
individually in `EXCLUDE_FILES`. The shim itself, its `.lite.js` sibling,
and Step 1's own capability-contract seam (`OnnxEmbedCapability`) are all
unchanged — this was a pure path rename with zero behavioral or
architectural-boundary change, and `ollama.js`/`tag-onnx.js` (the other two
shims' local targets) remain at their original `core/`/`indexer/phases/`
locations pending Steps 3–4.

**Phase 8B Step 3 update** (`docs/design/phase-8b-step3-local-ollama-relocation-2026-08-05.md`,
implemented): the Ollama half of the local target this paragraph and
Refactor 1 below describe — `core/ollama.js` and `core/ollama-models.js` —
physically moved to `local/core/ollama.js`/`local/core/ollama-models.js`.
`core/ollama-lazy.js`'s own dynamic-import specifier is the only thing
inside the shim that changed (`await import('../local/core/ollama.js')`);
`packages/lite/build.mjs`'s `EXCLUDE_FILES` no longer names either file
individually — both are covered by the same `'local'` `EXCLUDE_DIRS` entry
Step 2 introduced. This step ALSO went beyond a pure path rename: the five
indexer phase modules (`context.js`/`tag.js`/`combined.js`/
`skeleton-summary.js`/`preflight.js`) that consumed their Ollama capability
via a module-scope `apply*Capability()` setter (Phase 8B Step 1's own
design) were converted to genuine instance-scoped injection — each function
now takes its capability as a real parameter, resolved once per
`indexer/run.js`'s own `run()` call and threaded through explicitly, with no
module-scope binding left in any of the five files for a concurrently
constructed Full/Lite composition to contaminate. `tag-onnx.js` (the one
remaining shim's local target) remained at its original
`indexer/phases/tag-onnx.js` location pending Step 4 — see the Step 4
update below for its own physical relocation.

**Phase 8B Step 4 update** (`docs/design/phase-8b-step4-local-tag-onnx-relocation-2026-08-06.md`,
implemented):
`indexer/phases/tag-onnx.js` and `indexer/workers/tag-onnx-worker.js`
physically relocated to `local/indexer/phases/tag-onnx.js` and
`local/indexer/workers/tag-onnx-worker.js` — the last of the three real
`*-lazy.js` targets to move, completing the pattern Steps 2 (ONNX
embedding) and 3 (Ollama) established. `tag-onnx-lazy.js`/
`tag-onnx-lazy.lite.js` themselves stayed put (only the lazy module's own
dynamic-import specifier changed); both are now covered by the same
`'local'` `EXCLUDE_DIRS` entry Steps 2-3 relied on. `run.js`'s own
`ctx.tagOnnx` instance-scoped threading (Step 3's design) required no
change. `TagOnnxCapability`'s own shape DID change, per a second
code-review pass on this step: `tag-onnx.js`'s worker coordinator state
(`_worker`/`_pending`/`_dispatchTail`/failure flags) had been left as
module-scope singleton bindings by the move's first draft, so every
composition root's `ctx.tagOnnx` — despite each holding its own object
reference — pointed at the same underlying worker. Fixed by converting
`tag-onnx.js` to export `createTagOnnxCapability()`, a factory returning
a fresh, independent worker lifecycle per call; `tag-onnx-lazy.js`'s own
export shape changed to match (`createTagOnnxCapability()` instead of
bare `addTagsOnnxBatch`/`shutdownOnnxTagWorker` re-exports).
`index-full.js`/`backfill-tags.js` each construct exactly one instance at
composition time. The persistent-worker lifecycle contract itself (lazy
creation, per-request correlation, shutdown-before-spawn no-op,
repeated-shutdown safety) is otherwise unchanged in mechanism — only
state OWNERSHIP moved from module scope into the factory's own closure —
re-verified both behaviorally (26 unit/architecture tests, including
three constructing two separate instances to prove cross-instance
isolation directly) and via one real, successful, end-to-end live
indexing run (which predates the isolation fix and exercises the
now-relocated-into-a-closure but otherwise byte-identical worker
protocol, not the cross-instance guarantee itself).

**Phase 8B Step 5 update** (`docs/design/phase-8b-step5-onnx-embed-instance-scoping-2026-08-06.md`,
implemented): the same isolation gap Step 4 found and fixed for
`tag-onnx.js` also existed for `local/core/onnx-embed.js` (already
physically relocated by Step 2, above — this step touched no file
paths). `onnx-embed.js`'s `tokenizer`/`session`/`_loadPromise`/
`_providerState` were module-scope bindings, and every real composition
root passed the cached `core/onnx-embed-lazy.js` module namespace itself
as the `onnxEmbed` capability — so two composition roots sharing one
process shared one `InferenceSession`. Fixed the same way:
`onnx-embed.js` now exports `createOnnxEmbeddingCapability()`, a factory
whose entire runtime lives in its own closure, plus a new `shutdown()`
method that calls the ONNX Runtime's own documented `session.release()`
(never called anywhere before this fix — a real native-resource leak).
`core/onnx-embed-lazy.js`'s own seam is deliberately kept
**synchronous** (unlike a naive port of Step 4's async factory) so that
`admin/server-full.js`'s existing synchronous `createApp()` — with 16
existing call sites — did not need to become async; the real dynamic
import and factory construction are deferred until the first actual
method call. `REQUIRED_ONNX_EMBED_CAPABILITY_METHODS` gained `shutdown`
as a required method, mirroring `TagOnnxCapability`'s own Step 4
precedent; every Lite "unavailable" capability builder gained a matching
no-op. `index-full.js`/`admin/server-full.js`/`mcp/server.js` each
construct exactly one instance at composition time; `run.js`'s `finally`
block now calls `ctx.onnxEmbed.shutdown()` alongside its existing
`ctx.tagOnnx.shutdownOnnxTagWorker()` call. Cross-instance isolation —
including the case where instance B has a genuinely in-flight request at
the exact moment instance A is shut down — is proven by 18 hermetic unit
tests (fake session/tokenizer, no real model load) plus 9 composition-
level architecture tests proving Full and Lite construct in either order
without contaminating this capability lane. Re-verified live against the
real cached model: real indexing, real hybrid search, real
`session.release()` on shutdown, against a disposable Qdrant collection,
deleted after.

**Phase 8B Step 6 update** (`docs/design/phase-8b-step6-cloud-runtime-relocation-2026-08-06.md`,
implemented): a different kind of move from Steps 2-5 above — those
physically relocated LOCAL-only runtime code (excluded from Lite); this
step physically relocated the seven CLOUD-only provider implementations
(Qdrant Cloud Inference, Gemini) into one top-level `src/cloud/` boundary,
per the original migration plan's own Step 5
(`phase-8a-shared-cloud-local-migration-audit-2026-08-02.md` §7). Moved,
via `git mv`: `core/embedding-profile/qdrant-cloud-{catalog,models,tokenizer}.js`
→ `cloud/embedding/qdrant-cloud-{catalog,models,tokenizer}.js`;
`core/generation/gemini-provider.js` → `cloud/generation/gemini-provider.js`;
`core/gemini-models.js` → `cloud/generation/gemini-models.js`;
`admin/api/qdrant-cloud.js` → `cloud/admin/qdrant-cloud-api.js`;
`admin/system/qdrant-cloud.js` → `cloud/admin/qdrant-cloud-system.js` (the
last two renamed, not just relocated, to avoid a same-name collision once
both siblings share one directory). Because Semidex Lite is cloud-only by
design, this is NOT an exclusion move the way Steps 2-4 were — all seven
files must continue shipping in the Lite tarball, at their new path, and
do: `packages/lite/build.mjs`'s directory walk picks up `src/cloud/`
automatically (it stages every file not explicitly excluded), so this
step required zero `EXCLUDE_DIRS`/`EXCLUDE_FILES` changes at all — the
117-staged-file count is unchanged, and both admin UI builds are
byte-identical to their pre-move hashes. No `*-lazy.js` shim was
introduced (the task's own explicit constraint) — every one of the
fourteen real production importers (`core/embeddings.js`,
`core/retrieval/search.js`, `core/embedding-profile/{resolve,availability}.js`,
`core/token-count.js`, `core/config.js`, `core/settings/definitions.js`,
`core/generation/registry.js`, `indexer/run.js`,
`admin/register-neutral-routes.js`, `admin/api/generation-models.js`,
`admin/ui-src/global-settings-view.js`, plus the two moved files'
own internal cross-references and `packages/lite/lite-src/doctor-lite.js`'s
cross-package imports) now imports the real file directly at its new
`src/cloud/` path, in both Full and Lite composition identically —
mirroring how these files were already imported directly, unconditionally,
before the move (cloud capabilities never needed Steps 2-4's own
Full/Lite-unavailable-stub pattern, since Lite always needs the real
implementation, never a disabled one).
`node scripts/audit/find-dependency-violations.mjs` reports the exact
same baseline after the move as before it — `0` dependency-direction
violations, `0` shared→cloud edges (the manifest's own iterative
`mixed`-propagation pass, driven by `core/token-count.js`'s own
dual local/cloud tokenizer role, already absorbs what an earlier design
note called "12 shared→cloud edges" into `mixed`-classified orchestration
files well before this step — this step's own move changed which PATH
those edges point at, not their count or classification). Verified via a
real, un-mocked `npm pack` clean-install acceptance run (read-only
installed package directory): `doctor` and `serve` both start and
correctly reach the relocated Qdrant Cloud/Gemini code paths.

**Phase 8B Step 7A update** (`docs/design/phase-8b-step7a-shared-core-relocation-2026-08-07.md`,
implemented): the 17 stable, top-level `src/core/*.js` files the real
import graph confirms are genuinely `shared` (Full- and Lite-reachable,
plus `rerank-capability.js` — a zero-dependency contract, same class as
`onnx-embed-capability.js`) physically relocated to `src/shared/core/`.
Every `core/embeddings.js`/`core/config.js`/`core/token-count.js`/etc.
path named above in this Step 6 entry now reads `shared/core/embeddings.js`/
`shared/core/config.js`/`shared/core/token-count.js` — that renaming is
NOT retroactively edited into the Step 6 prose above (kept as an accurate
historical record of what Step 6 itself did, at the paths that existed
then); read this note as the authoritative "where these files live now"
pointer instead. `core/embedding-profile/`, `core/generation/`,
`core/qdrant/`, `core/retrieval/`, `core/settings/`, `core/storage/`
(subdirectories) and the 4 files that stayed at top-level `src/core/`
(the real `ce-rerank.js`/`ce-rerank-worker.js`/`rerank.js`/
`rerank-provider.js` local-runtime implementation, plus the 3 remaining
`*-lazy.js`/`*-lazy.lite.js` transitional shim pairs) were explicitly out
of this step's own scope. See that report for the full file-by-file
classification table and verification results.

## Refactor 2 — deterministic context for legacy (non-Markdown) chunks

`chunk.js` routes PDF/Pandoc/plain-text through the legacy chunker, and
`stageB`'s legacy branch unconditionally called `addContext()` → Ollama.
Added `CONTEXT_MODE=deterministic|llm` (default `llm`, Lite pins
`deterministic`): the deterministic branch builds context from
`source_file`/`section` — the same `headingPath.join(' › ')` shape
skeleton (Markdown) chunks already use — with zero LLM calls.

Combined with Refactor 1, a Lite index of any supported file type (`.md`,
PDF, plain text, anything Pandoc converts) makes zero Ollama calls — but
this required a **second** fix the design didn't originally call out: the
Ollama **preflight check** (`ensureOllamaPreflight()` in `run.js`) gated
on a different condition (`chunkMeta.chunkingModel`, true only for
skeleton/Markdown files) than the actual context-generation call site
(gated on `isDeterministicContextMode()`). A legacy file under
`CONTEXT_MODE=deterministic` still tripped the preflight check and threw
through the Lite Ollama shim — found by the live vertical slice (Part H),
not by any unit test, because every existing test stubbed
`ensureOllamaPreflight` rather than exercising the real gating condition.
Fixed by extracting a single, exported, directly-testable
`shouldSkipOllamaPreflight(chunkMeta, env, {...})` that both the preflight
gate and (indirectly, by construction) the context branch now agree with.

## Refactor 3 — admin composition split

**Note:** this section describes the shape as originally implemented, when
`registerNeutralRoutes()`, `createHttpServer()`, and `createLiteApp()` all
still lived in one file, `admin/server.js`. That file has since been split
further, mechanically, with no behavior change:
`docs/design/full-lite-shared-architecture-audit-2026-08-01.md`'s Phase 3
moved `registerNeutralRoutes()`/`createHttpServer()` into
`admin/register-neutral-routes.js`; its Phase 4 moved `createLiteApp()`/
`LITE_JOB_POLICY` into `admin/composition/lite.js`. `admin/server.js` today
hosts only `resolveHostConfig()`/`resolvePortConfig()`. The narrative below
is kept as the historical record of why this split shape was chosen; read
`(in server.js)` below as "in whichever file currently owns it" — see the
two phase reports (`phase-3-register-neutral-routes-2026-08-02.md`,
`phase-4-lite-composition-root-2026-08-02.md`) for the current file layout.

`createApp()` (`server.js`) was one ~200-line inline registration mixing
cloud-safe and local-only routes. `admin/api/jobs.js` statically imported
`checkOllama`; `admin/api/generation-models.js` statically imported
`discoverOllamaModels`; both also need different accepted-option/backend
policies for Lite vs. full.

The resulting shape:

- **`registerNeutralRoutes(router, deps)`** (in `server.js`; now in
  `admin/register-neutral-routes.js`, Phase 3) — every genuinely
  cloud-safe/Ollama-free route (health, collections, documents, chunks,
  assembly, skeleton, node, search, Ask v1, generation runtime,
  Qdrant-Cloud probe, settings, folder-pick). Shared by both roots so they
  cannot drift apart the way two independently hand-written functions
  would.
- **`createHttpServer(router)`** (in `server.js`; now in
  `admin/register-neutral-routes.js`, Phase 3) — the shared HTTP+static-UI
  server tail.
- **jobs route parameterized by a policy + injected Ollama check.**
  `registerJobsRoutes` takes a `jobPolicy` (which options are accepted)
  and a `checkOllamaFn` by dependency injection rather than a static
  import — the module no longer statically pulls `system/ollama.js`. Full
  passes the real `checkOllama` + `FULL_JOB_POLICY`
  (onnxEmbed/llmSummaries/tagGen allowed); Lite passes no `checkOllamaFn`
  and `LITE_JOB_POLICY` (rejects onnxEmbed/llmSummaries/tagGen, **allows**
  pruneStale — pure Qdrant-Cloud-compatible stale cleanup, not a
  local-model feature).
- **generation-models route split** — `registerGenerationModelsRoutes`
  (full, Ollama+Gemini) vs. `registerGenerationModelsRoutesGeminiOnly`
  (Lite, imports only `gemini-models.js`).
- **`createLiteApp()`** (in `server.js`; now in `admin/composition/lite.js`,
  Phase 4) = `registerNeutralRoutes()` + the Gemini-only model route +
  `LITE_JOB_POLICY`. Local-only routes are never registered, so their
  handlers *and* every module behind them are never reachable — and, once
  excluded from the tarball, never even shipped.

**A real architectural finding mid-implementation:** `createApp()` (the
full-only composition root) has four of its own static imports
(`registerOnnxRoutes`, `registerOllamaModelsRoutes`,
`discoverOllamaModels`, `checkOllama`) that ES module import statements
make **unconditional** — they exist in the file regardless of which
function a caller actually invokes, since imports can't be conditional.
This meant `createApp()` and `createLiteApp()` could not safely live in
the same file once Lite needed to *stage* that file (for `createLiteApp`)
without also staging those four Ollama/ONNX-only modules. Resolved by
splitting `createApp()` out into a new file, **`admin/server-full.js`**
(excluded from Lite's tarball). At the time this was written,
`server-full.js` imported `registerNeutralRoutes`/`createHttpServer` back
from `server.js` — a real, intentional circular import, safe because
neither binding is invoked at module-evaluation time. Phase 3 (see the
note at the top of this section) later removed even that circularity:
`registerNeutralRoutes`/`createHttpServer` moved into their own file,
`admin/register-neutral-routes.js`, which both `server-full.js` and
`admin/composition/lite.js` import directly — `server.js` is no longer in
either import path at all. `server.js` never re-exports `createApp` (that
re-export would itself be a static edge to the excluded file); every
full-Semidex caller (`bootstrap.js`, ~9 test files) imports `createApp`
directly from `server-full.js`.

## Hard cloud-only enforcement

Single, unambiguous pin policy: the Lite CLI (`bin/semidex-lite.js`) sets
eight env vars **unconditionally, before `bootstrapEnv()`**:
`DENSE_PROVIDER=qdrant-cloud`, `SPARSE_PROVIDER=qdrant-cloud`,
`SEMIDEX_GENERATION_BACKEND=gemini`, `CONTEXT_MODE=deterministic`,
`TAG_GEN=0`, `SKELETON_SUMMARY=deterministic`, `COMBINED_LLM=0`,
`ONNX_EMBED=0`. Because the CLI sets them first and unconditionally, a
stray local env var left over from a full-Semidex `.env` a user copied by
habit cannot re-enable a local code path. The Lite settings API and jobs
API separately reject any attempt to change these at runtime
(`not_available_in_lite`) — belt-and-suspenders, not the primary
enforcement mechanism.

`core/settings/service.lite.js` wraps the real `SettingsService`: `getAll()`
returns only the Lite allow-list (`core/settings/lite-policy.js`),
`get()`/`getActiveValue()` on any other key behave as absent, `setMany()`
rejects any non-Lite key in the same all-or-nothing pass the real service
already uses. **The allow-list is not just the "obviously cloud" keys** —
a full audit of every `settingsService.getActiveValue()` call site
reachable from `createLiteApp()`'s route graph found that
`core/qdrant/store.js`'s hybrid search reads `HYBRID_PREFETCH_LIMIT`/
`RRF_K` through the *same shared instance* that backs the Settings API.
Omitting those two keys from the allow-list would have made every Lite
search request throw `not_available_in_lite` — caught by a dedicated
integration test (`tests/unit/admin/lite-app.test.js`) before it could
ship, not by inspection.

**Phase 5 update** (`docs/design/full-lite-shared-architecture-audit-2026-08-01.md`
§9.2, implemented — see `docs/design/phase-5-lite-settings-policy-completeness-2026-08-02.md`):
`lite-policy.js`'s allow-list is no longer a bare `LITE_SETTINGS_KEYS`
array maintained by hand. It is now derived from an exhaustive
`LITE_SETTINGS_POLICY` object that classifies every single key in
`definitions.js`'s `DEFINITIONS` as `exposed` or `excluded` (with a
reason), and `tests/unit/core/settings-lite-policy-completeness.test.js`
fails immediately if a new/renamed/removed `DEFINITIONS` key has no
matching policy entry — closing the "a human must remember to update the
allow-list" gap this section originally only asserted was handled by
"defaults safe," not by an automated check. `LITE_SETTINGS_KEYS` itself is
unchanged in contents, order, shape, and every consumer's usage —
`LITE_SETTINGS_POLICY` declares its `exposed()` entries first, in the
exact original order, specifically so `LITE_SETTINGS_KEYS`'s real,
single-source-of-truth derivation
(`Object.entries(LITE_SETTINGS_POLICY).filter(exposed)`) preserves that
order by construction (a code review finding: an intermediate version
instead added a second, separately-declared order constant, which
reintroduced a second source of truth for the same classification; fixed
by ordering the canonical policy itself, with a regression test pinning
the exact resulting order).

## Redaction covers multiple secrets

`sanitiseErrorMessage(msg, secret)` took one secret; three call sites
(`generation-models.js`, `generation.js`, `ask-api/v1/route.js`) needed to
redact both `QDRANT_KEY` and `GEMINI_API_KEY` from the same message and
worked around the single-secret signature with a double call:
`sanitiseErrorMessage(sanitiseErrorMessage(msg, a), b)`. Extended to accept
a string *or* array of secrets (backward compatible — every existing
single-secret call site is unaffected), and simplified all three
double-call sites to one array-based call.

## Packaging mechanism — same-repo staging, no npm workspaces

`packages/lite/build.mjs` (npm's own `prepack` hook) stages a curated
subset of the repo's `src/` tree into `packages/lite/src/` (gitignored,
regenerated on every build), substitutes every `*-lazy.js` module with its
Lite shim, copies the prebuilt Lite admin UI into
`packages/lite/dist/admin-ui/`, and then runs a five-part closure
validator against the **staged** tree — never the repo's live `src/` — so
the validator's result reflects exactly what ships in the tarball.

Deliberately **not** npm workspaces (would require a much larger structural
change for a first foundation) and **not** `optionalDependencies` (npm
still tries to install "optional" heavy deps by default in most
configurations — it doesn't mean "never install").

### The five-part closure validator

Parser: **acorn** (a root `devDependency` — never shipped in the Lite
package itself; confirmed absent from the installed tree via
`npm ls --all` in the clean-install acceptance suite). Every staged `.js`
file is parsed into a real ESTree AST and walked with `acorn-walk` — no
source-regex scanning is used as the authority for any of the five checks.

1. **Static imports / export-from** resolve to a staged file or a
   declared dependency.
2. **Literal dynamic imports** (`await import('literal')`) resolve the
   same way. A *non-literal* dynamic import specifier is flagged as an
   error (`[dynamic-import:non-literal]`), not silently trusted — the
   validator cannot prove a runtime-computed specifier is safe, so it
   refuses to guess.
3. **`fork()`/`spawn()` literal path targets** resolve to a staged file.
   **No "intentionally absent and unreachable" allow-list exists** — a
   validator cannot statically prove a runtime branch never executes, so a
   fork/spawn target must either be staged or the calling edge must be cut
   (the `*-lazy.js` treatment above) until the fork call itself becomes
   provably unreachable in the closure. `admin/jobs/registry.js`'s own
   `spawn(process.execPath, [INDEXER_ENTRY, path], ...)` pattern
   (spawning the current Node binary with a resolved literal entry-file
   argument) is the one recognized safe shape, and `INDEXER_ENTRY` itself
   is checked against the staged tree like any other reference.
4. **Bare package specifiers** must be in `packages/lite/package.json`'s
   `dependencies`.
5. **Built UI content scan** (HTML *and* JS, not just HTML) — the staged
   `dist/admin-ui/` must contain zero occurrences of a fixed marker list:
   local-only setting keys (`ONNX_EXECUTION_PROVIDER`,
   `ONNXRUNTIME_NODE_PATH`, `OLLAMA_URL`, ...), local-only HTML template
   ids (`tpl-gs-onnx-probe-panel`), and local-only API route strings
   (`/api/system/onnx-probe`, `/api/ollama-models`,
   `/api/system/ollama-status`).

### The Lite admin UI — real dead-code elimination, not hiding

**Phase 6 update** (`docs/design/full-lite-shared-architecture-audit-2026-08-01.md`
§8, implemented — see `docs/design/phase-6-full-lite-ui-composition-2026-08-02.md`):
everything below this note describes the ORIGINAL marker-strip/DCE
mechanism, kept as the historical record of why it was built and how it
was verified. That mechanism no longer exists. Full and Lite now build
from physically separate HTML/JS entry points and physically separate
partial files (`partials/full/*.html` vs. `partials/lite/*.html`) —
`stripHtmlMarkers()`, `HTML_STRIPS`, and every `semidex-lite-strip:*`
marker are gone; there is nothing to strip because Lite's build never
composes the local-only markup into its page or bundle in the first
place. `SEMIDEX_LITE`/`IS_LITE` are gone from `global-settings-view.js`/
`jobs-view.js`/`settings-view.js` entirely — the local-only BEHAVIOR
(ONNX probe panel, Ollama model discovery, Ollama readiness check,
onnxEmbed/llmSummaries/tagGen job options) now lives in a new
`local-features.js`, reached only through a capability-injection seam
(`setLocalSettingsCapabilities()`/`setJobsLocalCapabilities()`/
`setSettingsLocalCapabilities()`) that only `entries/full.js` calls.
`tests/unit/lite/ui-build-dce.test.js` still runs the same real
`vite build --config vite.config.lite.js` + output-marker-scan this
section describes, and still passes — the guarantee is unchanged, only
the mechanism producing it is.

Most of the Settings view is already rendered generically from
`GET /api/settings`'s response (`fieldRow(category, entry)` — the same
function for every field), so a Lite backend (whose response only ever
contains the Lite allow-list) already renders zero ONNX/Ollama field rows
with the *same* JS, no build variant needed for that part. Two places had
genuinely static, unconditional local-only markup that data-gating alone
can't remove:

- `global-settings.html`'s `<template id="tpl-gs-onnx-probe-panel">` block.
- `index-view.html` / `settings-shell.html`'s ONNX/LLM-summaries/tag-gen
  checkboxes on the two separate indexing forms (collection-creation and
  per-collection reindex — found to be two independently duplicated forms,
  not one shared component).

`vite.config.lite.js` defines `SEMIDEX_LITE` as a literal boolean (`true`;
`vite.config.js`'s own copy defines it `false`) and:

1. Strips the two HTML template/markup blocks at build time via a small
   marker-based plugin — one hook (`transformIndexHtml`, default order,
   after `vite-plugin-html-inject` has already inlined `<load>` partials)
   for `global-settings.html`, and a **different** hook
   (`load()`, `enforce: 'pre'`) for `index-view.html`/`settings-shell.html`,
   because those two are imported via Vite's `?raw` loader as JS module
   source, not part of the HTML document pipeline at all — a real
   `transformIndexHtml`-only implementation silently never matched them
   (build succeeded, markers stayed in the bundle) until this was found
   and fixed.
2. Guards the corresponding JS (`onnxProbePanel()`, `wireOnnxProbePanel()`,
   `runOnnxProbe()`, `categoryNeedsOllamaModels()`, `refreshOllamaModels()`
   in `global-settings-view.js`; the options-building logic in
   `jobs-view.js`/`settings-view.js`) with
   `const IS_LITE = typeof SEMIDEX_LITE !== 'undefined' && SEMIDEX_LITE;`
   followed by `if (IS_LITE) return ...;` as each guarded function's first
   statement. The `typeof` check is required because the same source files
   are also loaded directly (bypassing Vite) by
   `tests/unit/admin/ui-test-helpers.js`'s `vm.Script`-based test harness,
   where `SEMIDEX_LITE` is a genuinely undeclared global — a bare
   reference threw `ReferenceError` there before this was caught.

Verified empirically, not assumed: a minimal Rollup/Vite build with the
exact same guard pattern was run standalone first to confirm dead-code
elimination actually happens (string literals physically absent from
output, not just unreachable), before applying it to the real files. Two
real Vite builds (`admin:build`, `admin:build:lite`) are diffed by an
automated test (`tests/unit/lite/ui-build-dce.test.js`) on every run: the
full build's output hash is unchanged from before these guards existed
(byte-identical — the strongest possible proof of zero behavior change),
and the Lite build has zero occurrences of every marker in both its HTML
*and* its JS bundle. `opt-prune` (the one option Lite's jobs policy
allows) is separately asserted to survive, proving the strip is scoped
correctly and not simply deleting the whole options block.

## Clean-install acceptance

`tests/unit/lite/clean-install-acceptance.test.js` operates on the real
packed tarball (`npm pack`), not the repository layout: installs into a
fresh empty temp directory outside the repo, marks the installed package
directory **read-only**, then runs `--help`, `doctor` (missing
credentials → clean exit 1, never a crash), and `serve` (real HTTP
`/api/health` round-trip) against it — plus an acorn-based check that
**every relative import/require in the installed package resolves to a
path inside the package directory** (no `../../../` escaping into a path
that only existed in the repo).

This exact test caught a real packaging bug: `packages/lite/lite-src/*.js`
(the shipped composition/CLI layer) used `../../../src/...` import paths,
correct for the **repo** layout (`packages/lite/lite-src/` → up three
levels → repo-root `src/`) but wrong once packaged, where `lite-src/` and
`src/` (the **generated shared runtime layer**, staged by `build.mjs`
directly under `packages/lite/`) become direct siblings — the correct
path is `../src/...`. Fixed in all three files
(`doctor-lite.js`/`serve-lite.js`/`index-lite.js`); `build.mjs` does not
duplicate `lite-src/` during staging, so this one-hop relationship is now
correct in both the repo (once `build.mjs` has staged `src/` at least
once) and the packaged tarball.

## What a live vertical slice caught that no unit test did

Three bugs surfaced only by indexing real files into a real disposable
Qdrant Cloud collection and asking a real Gemini question against them —
none visible to DI-stub-based unit tests, because in two of the three
cases the stub and the implementation shared the same wrong assumption:

1. `doctor-lite.js` checked `result.status === 'ok'` for the Cloud
   Inference probe's success case; the real value
   (`core/qdrant/store.js`'s `probeInference()`) is `'inference_available'`.
   The unit test's own stub returned `{status: 'ok'}`, matching the bug.
2. `tag-onnx-lazy.lite.js` made *every* export throw, including
   `shutdownOnnxTagWorker()` — but that function is unconditional cleanup
   `run.js` calls in its own `finally` block on every indexing run,
   regardless of whether tagging was ever used. The real (non-Lite)
   `tag-onnx.js` documents this exact function as a safe no-op when no
   worker was ever spawned; the Lite shim needed the same contract, not a
   blanket "everything throws" policy.
3. The Ollama-preflight gating gap described under Refactor 2 above.

The lesson generalizes: a stub that encodes the same incorrect assumption
as the code under test provides no signal. Where practical, prefer
asserting against the *real* status/shape returned by the underlying
layer (as the fix for finding 1 now does implicitly, since the stub was
corrected to match reality) over a stub invented independently of it.
