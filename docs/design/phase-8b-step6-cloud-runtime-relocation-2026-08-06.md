# Phase 8B Step 6 — physical relocation + real architectural separation of the cloud-only provider implementations

Implementation report for "Phase 8B Step 6 — Physical relocation of
cloud-only implementations into `src/cloud/`." **Supersedes** two earlier
versions of this report from the same dated file, both rejected by this
repo's own code review:

> Round 1: "Це фізичне перенесення файлів, але не архітектурне
> відокремлення cloud-runtime. Спільні модулі досі напряму імпортують
> конкретні cloud-реалізації... Практично `src/cloud/` зараз є новою
> папкою, а не реальною архітектурною межею."
>
> Round 2: "Новий аудит знаходить 3 реальні порушення, але завершується з
> exit code 0... Архітектурна межа все ще не чиста через три
> shared -> local залежності... Cloud-відокремлення виправлене, але
> загальне правило shared implementation -> local implementation forbidden
> досі порушене."

Both rounds are fully addressed below. **Nothing was committed** — this is
the working-tree state at the end of this round's own session.

## 0. What the first pass got wrong, and what changed

The first pass moved seven files into `src/cloud/` and stopped there —
`embeddings.js`, `registry.js`, `token-count.js`, `search.js`, `run.js`,
and `register-neutral-routes.js` all kept real, static `import` statements
reaching directly into the moved implementations. The audit script itself
(`build-shared-cloud-local-manifest.mjs`) reclassified any such module to
`mixed` the instant it found a forbidden dependency, which meant the
violation checker (`find-dependency-violations.mjs`) never saw the
original `shared` classification — a circular design that hid exactly the
defect it existed to catch. The architecture test's own "shared
implementations never import..." block checked exactly one file
(`qdrant-cloud-system.js`, from `src/admin/` only) and let every other
direct edge through unnoticed.

This round's fix, in order:

1. **Separated pure data from implementation.** `qdrant-cloud-models.js`
   (`QDRANT_CLOUD_DENSE_MODELS`/`SPARSE_MODELS`, `findDenseModel`/
   `findSparseModel`, `isCatalogCompatibleWithChunking` — zero
   dependencies, no `fs`, no `fetch`, no tokenizer, confirmed by its own
   header comment) moved back to `src/core/embedding-profile/`. It was
   never a cloud *implementation* — it's typed catalog metadata, exactly
   the kind of thing shared code is allowed to depend on directly.
2. **Built two narrow capability contracts**, mirroring the existing
   `OnnxEmbedCapability` pattern (`src/core/onnx-embed-capability.js`) —
   zero backend imports, a `REQUIRED_*_METHODS` list, a `validate*()`
   shape-checker:
   - `src/core/embedding-profile/cloud-embedding-capability.js` —
     `CloudEmbeddingCapability` (`checkEmbedInputFits`,
     `fitContextToBudget`, `buildCloudQueryInputs`,
     `resolveEmbeddingBudget`, `getCloudTokenCounter`).
   - `src/core/generation/cloud-generation-capability.js` —
     `CloudGenerationCapability` (`createProvider`, `discoverModels`).
3. **Built the two real implementation factories**, each the ONE file a
   composition root imports to obtain the real capability:
   - `src/cloud/embedding/cloud-embedding-provider.js` —
     `createCloudEmbeddingCapability()`.
   - `src/cloud/generation/cloud-generation-provider.js` —
     `createCloudGenerationCapability()` (now also self-validates its own
     return value against the contract before returning it — closing a
     gap where nothing previously exercised
     `validateCloudGenerationCapability()` at all).
4. **Rewired every one of the six named shared modules** to accept the
   capability via dependency injection instead of importing the
   implementation directly (detail in §2).
5. **Injected the real capability from every composition root** — Full
   (`server-full.js`, `bootstrap.js`), Lite (`composition/lite.js`,
   `serve-lite.js`), MCP (`mcp/server.js`), and the indexer CLIs
   (`index-full.js`, `index-lite.js`) — never via a module-global setter
   (detail in §3).
6. **Fixed the manifest's classification logic** so a module's declared
   ownership can no longer be erased by the propagation pass that used to
   overwrite `category` in place (detail in §4).
7. **Replaced the single-file architecture-test block** with a real,
   general graph test over the whole manifest (detail in §5).

## 1. Physical relocation (unchanged from the first pass)

Six files, via `git mv` (history preserved) — **not seven**; see §0.1 for
why `qdrant-cloud-models.js` is not in this list:

| Old path | New path |
|---|---|
| `src/core/embedding-profile/qdrant-cloud-catalog.js` | `src/cloud/embedding/qdrant-cloud-catalog.js` |
| `src/core/embedding-profile/qdrant-cloud-tokenizer.js` | `src/cloud/embedding/qdrant-cloud-tokenizer.js` |
| `src/core/generation/gemini-provider.js` | `src/cloud/generation/gemini-provider.js` |
| `src/core/gemini-models.js` | `src/cloud/generation/gemini-models.js` |
| `src/admin/api/qdrant-cloud.js` | `src/cloud/admin/qdrant-cloud-api.js` |
| `src/admin/system/qdrant-cloud.js` | `src/cloud/admin/qdrant-cloud-system.js` |

### 0.1 `qdrant-cloud-models.js` — moved to `src/cloud/`, then moved back

The first pass moved this file into `src/cloud/embedding/` alongside the
other six. This round moved it **back** to
`src/core/embedding-profile/qdrant-cloud-models.js` — it is genuinely
neutral catalog/typed-metadata data, not an implementation: no `fs`, no
`fetch`, no tokenizer, confirmed by re-reading the file and its own header
comment. `qdrant-cloud-catalog.js` (the real implementation, which
performs tokenizer I/O) re-exports `findDenseModel`/`findSparseModel` from
it for backward compatibility, but every shared caller was repointed to
import directly from `qdrant-cloud-models.js` instead of through the
cloud re-export — `core/config.js`, `core/embedding-profile/resolve.js`,
and `core/embedding-profile/availability.js` all had this exact
`shared -> cloud` re-export edge and were fixed the same way.

## 2. The six named modules — real capability injection, not a path change

Each of the six files the review named now takes its cloud dependency as
an explicit parameter, never a static/dynamic import of a concrete
implementation.

**`src/core/embeddings.js`** — `applyEmbeddingCapabilities({ollama, onnxEmbed, cloudEmbed})`
gained a third `cloudEmbed` slot alongside the pre-existing
`ollama`/`onnxEmbed` fallback pattern; a new `resolveCloudEmbed(capabilities)`
helper throws a clear, actionable error if neither the per-call
`capabilities.cloudEmbed` nor a module-scope default was ever set.
`embedForIndexCloud(profile, text, context, capabilities)` (now 4
parameters) destructures `checkEmbedInputFits`/`fitContextToBudget` from
the resolved capability. `findDenseModel` now imports from
`./embedding-profile/qdrant-cloud-models.js` (pure data — allowed
directly).

**`src/core/generation/registry.js`** — the static `import
{ createGeminiProvider } from './gemini-provider.js'` and its
unconditional registration in `DEFAULT_BACKENDS` are gone.
`DEFAULT_BACKENDS = { ollama: createOllamaProvider }` only.
`createGenerationProvider({backend, options, providers = {}})` merges
`{...DEFAULT_BACKENDS, ...providers}` — `'gemini'` becomes selectable only
when a composition root supplies `providers: { gemini: someFn }`
explicitly. This reused an *already-existing* DI seam
(`createGenerationProviderFn` in `core/generation/runtime.js`, previously
used only for Ollama's own `*Fn` overrides in `admin/bootstrap.js`) rather
than inventing a new mechanism.

**`src/core/token-count.js`** — the direct tokenizer import is gone.
`getCloudTokenCounter(modelId, {localFilesOnly, cloudEmbed})` throws if
`cloudEmbed` is missing, else delegates to
`cloudEmbed.getCloudTokenCounter(modelId, {localFilesOnly})` and wraps the
result with the pre-existing per-text cache. `getTokenCounter(options)`
threads `options.cloudEmbed` through.

**`src/core/retrieval/search.js`** — the direct
`buildCloudQueryInputs`/`checkEmbedInputFits` import is gone (kept
`findDenseModel` from `qdrant-cloud-models.js`, pure data). `runHybridSearch({...,
cloudEmbed, ...})` gained an optional parameter; the `QDRANT_CLOUD`
execution branch returns a typed `embedding_failed` error naming the
missing capability if `cloudEmbed` was not supplied, instead of importing
one itself.

**`src/indexer/run.js`** — `findDenseModel`/`isCatalogCompatibleWithChunking`
now import from `../core/embedding-profile/qdrant-cloud-models.js`.
`buildRunContext({..., cloudEmbed})` validates the new slot via
`validateCloudEmbeddingCapability` (contract file, §0). Every
`resolveEmbeddingBudget(EMBEDDING_PROFILE)` call site became
`ctx.cloudEmbed.resolveEmbeddingBudget(EMBEDDING_PROFILE)`; the one
`getTokenCounter(...)` call site gained `cloudEmbed: ctx.cloudEmbed`.

**`src/admin/register-neutral-routes.js`** — the static `import
{ registerQdrantCloudRoutes } from './api/qdrant-cloud.js'` is gone.
`registerNeutralRoutes(router, {..., cloudEmbed, registerQdrantCloudRoutesFn})`
now requires `registerQdrantCloudRoutesFn` explicitly (throws a
`TypeError` naming the real production file
(`src/cloud/admin/qdrant-cloud-api.js`) a composition root must supply, or
a test stub) — mirroring the file's own pre-existing
`generationModelsFn`-required pattern. `cloudEmbed` is threaded through to
`registerSearchRoutes`/`createAskCoordinator`.

Two adjacent files gained the same `cloudEmbed` parameter for the same
reason: `src/admin/api/search.js`'s `registerSearchRoutes` forwards it to
`runHybridSearch`; `src/core/ask/evidence.js`'s `buildEvidence` and
`src/core/ask/coordinator.js`'s `createAskCoordinator` both forward it
down to `buildEvidence`/`runHybridSearch`.

## 3. Composition roots — real injection, not a module-global setter

Every composition root constructs the real capability once and passes it
down as a plain function argument — never a setter mutating shared module
state.

| Root | What it constructs | Notes |
|---|---|---|
| `src/admin/server-full.js` (`createApp()`) | `cloudEmbed = createCloudEmbeddingCapability()`, `cloudGeneration = createCloudGenerationCapability()` | `resolvedGenerationRuntime` wires `providers: { gemini: cloudGeneration.createProvider }` into `createGenerationProvider`; `registerNeutralRoutes(...)` receives `cloudEmbed`, `registerQdrantCloudRoutesFn: registerQdrantCloudRoutes`, and `discoverGeminiModelsFn: cloudGeneration.discoverModels` |
| `src/admin/composition/lite.js` (`createLiteApp()`) | same two, identical pattern | Lite is the one case where the composition root builds the REAL implementation (not a typed-unavailable stub) — Lite is cloud-only by design and genuinely needs it, unlike its `ollama`/`onnxEmbed` slots |
| `src/admin/bootstrap.js` (Full's real entry point) | `cloudGeneration` via dynamic import | `createGenerationProviderFn` wrapper merges `providers: {...opts.providers, gemini: cloudGeneration.createProvider}` alongside its pre-existing Ollama `*Fn` overrides |
| `packages/lite/lite-src/serve-lite.js` (Lite's real entry point) | `cloudGeneration` via dynamic import | Same `createGenerationProviderFn` pattern as `bootstrap.js` |
| `src/mcp/server.js` | `cloudEmbed` via dynamic import | `search.setCloudEmbed(cloudEmbed)` — reusing the pre-existing `setEmbedQuery`-style DI seam already in `mcp/tools/search.js`, not a new mechanism |
| `src/indexer/index-full.js` / `index-lite.js` | `cloudEmbed = createCloudEmbeddingCapability()` | Passed into `runIndexerCli({..., cloudEmbed})`; both Full and Lite build the REAL implementation here too (same rationale as composition/lite.js above) |

Verified live: `node -e` scripts imported and constructed `createApp()`
and `createLiteApp()` in one process (including alternating Full → Lite →
Full → Lite, four constructions) with no error, before the test suite ran.

## 4. Manifest classification — fixing the circularity the review found

`scripts/audit/build-shared-cloud-local-manifest.mjs` previously
overwrote a module's `category` field **in place** the moment its
propagation pass found a forbidden dependency — so a real
`shared -> cloud` edge silently relabeled its own source module `mixed`
*before* `find-dependency-violations.mjs` ever read it, and the
"0 violations" the first pass reported proved nothing.

**Fix**: each module now carries two fields:

- **`declaredCategory`** — fixed at classification time, from explicit
  path patterns, composition-root lists, and Full/Lite reachability only.
  Never rewritten by the propagation pass. This is the module's real
  ownership fact.
- **`category`** — the propagation-refined, "effective" classification
  (`mixed` once a module transitively depends on something outside its
  declared category's allowed targets). Existing consumers that assert
  "this lazy shim is classified mixed" keep reading this field unchanged.

`find-dependency-violations.mjs`'s `findDirectionViolations()` and
`findSharedToCloudEdges()` now read `declaredCategory` (falling back to
`category` for any older-shaped manifest fixture), so a real
`shared -> cloud` edge is reported as a violation instead of being
pre-absorbed into `mixed`.

A second, smaller fix: `DIRECTION_RULES` previously forbade `cloud`/`local`
sources from depending on `composition` targets — but a `local`/`cloud`
spawn wrapper importing its own edition's composition-root entry point
(e.g. `spawn-indexer-full.js` → `index-full.js`) is a normal same-edition
"launch my own entry point" relationship, never a boundary crossing. This
rule never actually fired before because the old propagation logic masked
it the same way; now that masking is gone, the rule itself needed
correcting. `shared -> composition` stays forbidden (shared code must
never depend on a specific edition's composition root).

Two related, narrower fixes surfaced by re-running the classifier with
this change:

- `core/generation/registry.js` was hardcoded into
  `COMPOSITION_COMMON_FILES` (a holdover from when it statically imported
  Gemini) — removed; it's now genuinely provider-neutral (DI-only, its
  only dependency is `ollama-provider.js`) and classifies as `shared`.
- `indexer/index-full.js`/`index-lite.js` are genuine per-edition
  composition roots (they build and inject their own capability bundle)
  but previously fell through to a reachability-only baseline that
  labeled them `local`/`cloud` — added as explicit `composition-full`/
  `composition-lite` entries, matching `admin/bootstrap.js`'s treatment.
- `src/cloud/embedding/cloud-embedding-provider.js` and
  `src/cloud/generation/cloud-generation-provider.js` (the two new real
  implementation factories from §0) were added to
  `CLOUD_ONLY_PATH_PATTERNS` in `classify-modules.mjs` — they physically
  live in `src/cloud/` and are never imported by shared code, so they
  belong in the same pattern list as the other cloud implementation files.

### Result

```
node scripts/audit/find-dependency-violations.mjs
[violations] dependency-direction violations: 0
[violations] shared->cloud edges: 0
```

Genuinely **zero** violations of any kind — see §5.1/§5.2 below for how
the three `shared -> local` edges this same check surfaced (round 2's
review) were closed properly, not allow-listed.

Manifest counts after all fixes: 143 shared / 17 local / 11 composition /
9 mixed / 61 tooling / 8 cloud / 0 unclassified (249 total production
modules — up from 243 in the first pass's manifest: two capability
contracts and two cloud implementation factories from round 1, plus one
new `RerankCapability` contract and its real implementation factory from
round 2, §5.1).

## 5. New graph test — replacing the single-file check

The first pass's `phase-8b-step6-cloud-relocation.test.js` had a describe
block titled "shared implementations never import a concrete cloud
PROVIDER call site directly" that checked exactly one thing: no file
under `src/admin/` imports `qdrant-cloud-system.js` directly. It never
looked at `src/core/`, `src/indexer/`, the generation registry, or any
other target file — which is exactly how the six real violations passed
it undetected.

Replaced with a real, general graph test
(`tests/unit/architecture/phase-8b-step6-cloud-relocation.test.js`, new
describe block "declared-shared modules never directly import a concrete
`src/cloud/` implementation, anywhere in the graph"):

- **The general check**: builds the real manifest
  (`buildManifest()`, AST-based via `build-import-graph.mjs`, never
  regex) and asserts zero modules with `declaredCategory === 'shared'`
  have any `directDependencies` entry pointing at a module with
  `declaredCategory === 'cloud'` — every shared module, every cloud
  target, all at once, not one named pair.
- **A named-file regression pin**: asserts the exact six files the review
  called out are genuinely `declaredCategory` `shared`/`composition`.
- **A self-test**: re-derives the detection logic against a synthetic
  manifest fragment shaped exactly like the original bug (a `shared`
  module gaining a direct edge to a real `cloud` module), proving the
  test would actually catch that regression class, not just pass
  trivially on a clean graph.
- The original narrower `qdrant-cloud-system.js`-specific check is kept
  alongside the general one, as an additional pin, not a replacement.

The `MOVED` file list (§1) dropped `qdrant-cloud-models.js` (now 6
entries, not 7); the "no network call on import" test's six remaining
`src/cloud/` imports plus a new explicit import of
`src/core/embedding-profile/qdrant-cloud-models.js` (covering the same
"no network at import time" guarantee for the file that moved back).

## 5.1 Round 2 — the audit's own exit code

The review's first finding: `find-dependency-violations.mjs`'s `main()`
only ever printed the violation counts and never set `process.exitCode`
— a manifest with real, unjustified violations still exited 0, so any CI
step or `&&`-chained command treating this script as a gate silently
passed regardless of what it found.

**Fix**: `main()` now sets `process.exitCode = 1` when either
`findDirectionViolations()` or `findSharedToCloudEdges()` returns a
non-empty result, and is exported (previously a private, unexported
function) specifically so this contract is unit-testable directly —
`tests/unit/architecture/shared-cloud-local-manifest.test.js`'s new
"find-dependency-violations.mjs CLI — exit code" describe block calls
`main()` with synthetic manifests shaped like each failure mode (a real
`DIRECTION_RULES` violation; a `shared -> cloud` edge with no
`DIRECTION_RULES` violation; a genuinely clean manifest) and asserts
`process.exitCode` directly, plus one test against the real, current
on-disk manifest confirming it produces `exitCode: undefined` — not
merely an empty test fixture.

## 5.2 Round 2 — the three real `shared -> local` edges, closed properly

The review's second finding: the previous round left three real
`shared -> local` violations in place, disclosed via an allow-list rather
than fixed, and correctly rejected that as insufficient for an
acceptance-gate task — "Назвати це просто 'pre-existing/out of scope'
недостатньо, бо поточний етап саме перетворює аудит на acceptance gate."

Both MCP tool files now take their local-runtime-coupled operations as
injected capabilities from `src/mcp/server.js`, mirroring every other
capability-injection seam in this codebase (`OnnxEmbedCapability`,
`CloudEmbeddingCapability`, etc.) — no broad allow-list, no `-lazy.js`
shim, no physical file relocation.

**`src/mcp/tools/collections.js` → `src/local/core/ollama.js`**: the
direct `import { isOllamaReachable, listOllamaModels, validateOllamaModels }
from '../../local/core/ollama.js'` is gone. An **already-existing**
contract, `OllamaDiscoveryCapability`
(`src/core/generation/ollama-capability.js`'s
`validateOllamaDiscoveryCapability` — the same shape `indexer/run.js`'s
own `ollamaDiscovery` capability slot already uses) is now the injection
point: `setOllamaDiscovery(capability)` validates and stores it;
`checkOllamaLane()` throws a clear, actionable error if called before
injection, instead of silently importing the real module. `src/mcp/server.js`
calls `collections.setOllamaDiscovery(ollamaLazy)` at startup — the same
`ollama-lazy.js` namespace object already used for `search.setEmbedQuery()`'s
own capabilities, reused rather than duplicated.

**`src/mcp/tools/search.js` → `src/core/ce-rerank.js`, `src/core/rerank.js`**:
the direct imports of `rerankResults`/`ceRerank`/`withCETimeout`/
`getCeRerankConfig` are gone. A new contract,
**`RerankCapability`** (`src/core/rerank-capability.js` — `rerankResults`,
`ceRerank`, `withCETimeout`, `getCeRerankConfig`, zero backend imports,
mirrors `OnnxEmbedCapability`'s shape exactly), and its one real
implementation factory, **`createRerankCapability()`**
(`src/core/rerank-provider.js` — imports `rerank.js`/`ce-rerank.js`
directly, the deliberate seam, same role as `ollama-lazy.js`). `search.js`
gained `setRerank(capability)`; `handle()` throws a clear, actionable
error if reranking is enabled (`RERANK_ENABLED`/`RERANK_CE_ENABLED`) but
no capability was ever injected. `src/mcp/server.js` calls
`search.setRerank(createRerankCapability())` at startup.

Both capability contracts bundle deterministic (`rerankResults`) and
cross-encoder (`ceRerank`) reranking into ONE `RerankCapability` rather
than splitting them into two contracts — a real implementation always
supplies both together, from the same composition step (`search.js`'s own
two-stage det-rerank → CE-rerank pipeline), so a second contract would buy
no independent-lifecycle benefit the way, say, `OnnxEmbedCapability`'s
persistent session state did (see that file's own header comment for the
precedent this reasoning follows).

**Lite packaging fallout**: `core/rerank-provider.js` directly imports
`core/ce-rerank.js`, which `packages/lite/build.mjs`'s `EXCLUDE_FILES`
already excludes from the Lite tarball (Lite ships no MCP server, no CE
reranking). Since `rerank-provider.js`'s only real consumer is
`src/mcp/server.js` (already excluded via the `'mcp'` directory entry),
`core/rerank-provider.js` was added to `EXCLUDE_FILES` too — otherwise the
Lite closure validator correctly failed with `[static import:missing-target]
core/rerank-provider.js: "./ce-rerank.js" does not resolve to any staged
file`, caught by the existing `clean-install-acceptance.test.js` on the
first re-run after this fix.

**Manifest classification fallout**: the new `RerankCapability` contract
file (`rerank-capability.js`, zero dependencies) initially classified
`local` by the reachability baseline (Full-only-reachable, since MCP has
no Lite-reachable root at all in this manifest's model) — the same class
of false signal `provider.js`/`storage/adapter.js` already needed an
explicit `SHARED_CONTRACT_FILES` override for. Added alongside them.

### Result after both round-2 fixes

```
node scripts/audit/find-dependency-violations.mjs
[violations] dependency-direction violations: 0
[violations] shared->cloud edges: 0
```
```
echo $?
0
```

Genuinely zero violations, genuinely non-zero exit on failure (proven by
the new CLI exit-code tests, §5.1) — the acceptance gate the review asked
for.

## 6. Test-suite fallout from the DI refactor

Removing every module-scope real-network default meant every test that
previously relied on one now needs to inject a real or fake `cloudEmbed`/
`providers.gemini`/etc. explicitly. This was mechanical but wide: **172
failures** surfaced on the first full `npm test` run after the capability
refactor landed; all genuinely expected (removing an implicit default is
not a logic bug), each fixed at the test level:

| File | Fix |
|---|---|
| `tests/unit/core/token-count.test.js` | Import the real `createCloudEmbeddingCapability`, thread `cloudEmbed` through every `getTokenCounter(...)` call |
| `tests/unit/core/embeddings.test.js` | One module-level `applyEmbeddingCapabilities({cloudEmbed: ...})` call |
| `tests/unit/core/embedding-profile/qdrant-cloud-catalog.test.js` | Two integration tests' `embedForIndex(...)` calls gained `capabilities: { cloudEmbed }` |
| `tests/unit/core/generation/registry.test.js` | Gemini tests now pass `providers: { gemini: cloudGeneration.createProvider }` explicitly; added a test proving gemini is NOT selectable without it |
| `tests/unit/core/retrieval/search.test.js` | Every `runHybridSearch(...)` call exercising a `qdrant-cloud` profile gained `cloudEmbed` |
| `tests/unit/indexer/embedding-profile-wiring.test.js` | Updated a stale source-regex expecting `resolveEmbeddingBudget(EMBEDDING_PROFILE)` to match the new `ctx.cloudEmbed.resolveEmbeddingBudget(EMBEDDING_PROFILE)` call shape |
| `tests/unit/indexer/index-capability-wiring.test.js`, `tests/unit/indexer/phase-capability-injection.test.js` | Capability-fake builders gained a `cloudEmbed` slot (real factory — pure constructor, no network I/O until a method is called) |
| `tests/unit/mcp/search-embedding-profile.test.js` | Added `search.setCloudEmbed(createCloudEmbeddingCapability())` before the one test exercising a qdrant-cloud profile |
| `tests/unit/admin/register-neutral-routes.test.js` | Both direct `registerNeutralRoutes(...)` calls gained a no-op `registerQdrantCloudRoutesFn` fake |
| `tests/unit/admin/ui-test-helpers.js` | `readCloudSource()`'s base directory retargeted from `src/cloud/` back to `src/core/`, matching `qdrant-cloud-models.js`'s real new location (the file's browser-bundle helper for `global-settings-view.js`'s `vm`-based UI test harness) — fixes the `ui-global-settings*.test.js` batch (147 tests) |
| `tests/unit/architecture/shared-cloud-local-manifest.test.js` | Round 2: removed the four now-incorrectly-`mixed`-expecting entries (`embeddings.js`, `search.js`, `token-count.js`, `run.js`); "distinguishes neutral tools" test updated — `collections.js`/`search.js` now assert `shared`, not `mixed`; the `KNOWN_SHARED_TO_LOCAL_EXCEPTIONS` allow-list removed entirely (the 3 edges it disclosed are now actually fixed, §5.2), replaced with unconditional zero-violation assertions; new "CLI — exit code" describe block (4 tests) exercising `main()`'s `process.exitCode` contract directly (§5.1) |
| `tests/unit/architecture/phase-8b-step6-cloud-relocation.test.js` | `MOVED` list, network-check import list, and the replaced graph-test block (§5) |

## 7. Test results

| Check | Result |
|---|---|
| `node --check` on every changed/new file | clean |
| `npm test` | **2908/2908** pass |
| `npm run smoke` | **1316/1316** pass |
| `node scripts/audit/find-dependency-violations.mjs` | **0** dependency-direction violations, **0** `shared->cloud` edges — genuinely zero, exits **0** (§5.1, §5.2) |
| `node scripts/audit/build-shared-cloud-local-manifest.mjs` | 249 modules, 0 unclassified |
| `node scripts/audit/classify-modules.mjs` | regenerated `docs/design/artifacts/full-lite-module-inventory.json` and `full-lite-reachability-summary.json`; 0 heavy-package-reachable-from-Lite, 0 cloud-imports-local violations |
| `npm run admin:build` | clean build, 227 modules transformed |
| `npm run admin:build:lite` | clean build, 226 modules transformed |
| `node packages/lite/build.mjs` | OK — 122 files staged, closure validated clean |
| `tests/unit/lite/clean-install-acceptance.test.js` | passes as part of the full `npm test` run above (real packed/installed tarball — this is what caught the `rerank-provider.js` → `ce-rerank.js` closure gap in §5.2, fixed before this final run) |
| `git diff --check` | clean (exit 0; only pre-existing CRLF-normalization warnings on Windows) |

## 8. Known limitations / carried-forward items

- Three transitional lazy seams for the LOCAL runtime
  (`core/ollama-lazy.js`, `core/onnx-embed-lazy.js`,
  `indexer/phases/tag-onnx-lazy.js`) remain, unrelated to and unaffected
  by this step.
- This step did not touch the `admin/composition/lite.js`/
  `core/settings/lite-policy.js`/`core/settings/service.lite.js`
  cloud-vs-composition manifest ambiguity flagged in the original Phase
  8A audit — still open, out of this step's scope.
- No remaining known `shared -> local` or `shared -> cloud` violations —
  the three from round 2 (§5.2) are fixed, not disclosed-and-deferred.

## 9. Verdict

**`PHASE_8B_STEP6_ACCEPT`**

Both rounds of review findings are addressed: direct `shared -> cloud`
implementation edges are eliminated via real capability contracts and
composition-root injection (round 1); the audit script now exits non-zero
on any unjustified violation, proven by dedicated exit-code tests, and the
three `shared -> local` edges the round-2 review correctly refused to
accept as a disclosed exception are closed the same way — real capability
injection from `src/mcp/server.js`, no allow-list (round 2). The
dependency-direction audit reports genuinely zero violations of any kind
and exits 0; the full test suite (2908), smoke suite (1316), both admin UI
builds, the Lite package build, and the real clean-install acceptance run
are all green; `git diff --check` is clean. Nothing was committed.
