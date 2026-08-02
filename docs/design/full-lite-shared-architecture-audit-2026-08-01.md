# Semidex Full / Lite / Shared — architecture audit

Status: audit only. No production files were moved, renamed, or refactored.
Date: 2026-08-01.

Companion artifacts (regeneratable, read-only tooling):
- `scripts/audit/build-import-graph.mjs` — AST-based (acorn/acorn-walk)
  import-graph builder over the real `src/` tree.
- `scripts/audit/classify-modules.mjs` — reachability + classification
  layer on top of the graph.
- `docs/design/artifacts/full-lite-import-graph.json` — raw graph (every
  file's static imports, dynamic imports, requires, fork/spawn targets).
- `docs/design/artifacts/full-lite-reachability-summary.json` — Full/Lite
  reachable sets, external-dependency lists, heavy-package findings.
- `docs/design/artifacts/full-lite-module-inventory.json` — the required
  per-module machine-readable inventory (236 entries).

Regenerate with `node scripts/audit/build-import-graph.mjs && node scripts/audit/classify-modules.mjs`
(both read-only; safe to re-run any time).

## 1. Executive summary

Semidex already has a real, working Full/Lite boundary — not a proposal,
an implemented one, shipped as `packages/lite/build.mjs` plus four source
refactors documented in `docs/design/semidex-lite-package-boundary.md`
(2026-07-31). That mechanism (curated file staging + `*-lazy.js` shim
substitution + a five-part AST-based closure validator) is **the correct
architectural boundary already** for the packaging question specifically:
it provably keeps `onnxruntime-node`/`@huggingface/transformers` out of
the shipped tarball, verified by this audit's own independently-built
graph (see §5), not merely re-asserted.

What does **not** yet exist is the thing this task's target model
describes: a real `shared/cloud/local` **source-directory** partition with
enforced import-direction rules, checked automatically on every change.
Today the boundary is enforced by a curated **exclude list**
(`EXCLUDE_FILES`/`EXCLUDE_DIRS` in `build.mjs`) plus a handful of
`*-lazy.js` **indirection shims** — both real, both tested, but both
require a human to remember to update them when a new local-only module is
added, rather than a directory boundary a linter can check by construction.
This audit's own **Part K test design** (§13) closes that gap without
requiring the file-move the task explicitly says not to do in this pass.

**Two genuine, previously-undetected defects were found and fixed in this
audit's own tooling** while cross-checking `build.mjs`'s closure-validator
logic (which this audit's scripts deliberately re-implement independently
rather than import, precisely so they can catch this class of bug):

1. `admin/jobs/registry.js` spawns the indexer CLI as
   `spawn(process.execPath, [INDEXER_ENTRY, path], ...)` — Node's own
   "re-spawn the current binary with an explicit entry file" pattern.
   Neither the original `build.mjs` nor this audit's first-draft extractor
   recognized this shape (the `spawn` binding is aliased on import, then
   flows through a default-parameter named `spawnFn`, then the real
   target lives in the **second**, not first, call argument) — the
   closure validator's own header comment claims to check this pattern,
   but the extraction silently never matched it. **Currently harmless**
   (the target file is genuinely staged), but previously **completely
   unverified** by the validator. Fixed in this audit's
   `build-import-graph.mjs`, then **ported into `packages/lite/build.mjs`
   itself** (Phase 2, §11 — completed; see that section for a real, third
   finding the port itself surfaced).
2. `core/ce-rerank.js`'s `fork(WORKER_PATH, ...)` where
   `WORKER_PATH = join(__dirname, 'ce-rerank-worker.js')` — a bare
   same-directory sibling filename with no `/` in it — was rejected by
   both tools' literal-path extraction (`.includes('/')` check), so this
   fork target was also silently unverified. Fixed the same way, also
   ported into `build.mjs` in Phase 2.

**Numbers** (final, after a first internal review and a subsequent code
review pass — see below): 236 production modules classified. 119 shared,
84 local, 9 cloud, 8 composition-full, 9 mixed, 5 composition-lite, 2
unclear (genuine test-only contract validators — not a defect, see §6.9).
Zero heavy local packages (`onnxruntime-node`, `@huggingface/transformers`)
reachable from Lite's real composition roots **after** the `*-lazy.js`
shim substitution the shipped tarball actually applies — confirmed by
this audit's own independently-built graph, not merely restated from the
earlier design doc. **Before** that substitution (i.e. if Lite ever
shipped raw `src/` without the shim step), `@huggingface/transformers`
WOULD be reachable via `indexer/workers/tag-onnx-worker.js` — which is
exactly why the shim mechanism, not "Lite just doesn't call that
function," is load-bearing today (§5.2).

**A second round of code review found and fixed four more real gaps in
this audit's own tooling** — the same "re-verify, don't just re-run"
discipline that found the two spawn/fork gaps above, applied again:

3. `packages/lite/lite-src/*.js`'s real imports were originally
   hand-transcribed into a `LITE_SYNTHETIC_ROOTS` constant (both in
   `classify-modules.mjs` and duplicated again in the Phase-1 test file)
   instead of being parsed. This is exactly the silent-drift risk the
   whole rest of this audit exists to eliminate: a new import added to a
   Lite entry point with no matching update to the hand-copied list would
   leave every downstream check green while missing the new edge —
   reproduced directly (§3, §12) by injecting a new
   `core/ollama.js` import into `hard-pins.js` and confirming the
   *previous* version of the test suite stayed green. Fixed by extending
   `build-import-graph.mjs` to parse `packages/lite/lite-src/` as real AST
   nodes in the SAME unified, `REPO_ROOT`-relative graph as `src/` (not a
   second graph, not a hand-copied list) — Lite's synthetic roots are now
   `graph.files.filter(f => f.startsWith('packages/lite/lite-src/'))`, a
   computed fact, not a maintained one.
4. `liteTarballStaged` in the module inventory only checked
   `LOCAL_ONLY_PATH_PATTERNS` (14 files) plus 4 excluded directories,
   silently missing 8 of `build.mjs`'s real 18 `EXCLUDE_FILES` entries —
   every `composition-full`-classified file (`admin/bootstrap.js`,
   `admin/server-full.js`, `doctor.js`, `sync.js`, `smoke.js`,
   `bootstrap-docs.js`, `backfill-tags.js`, `backfill-entity-refs.js`) was
   wrongly reported `liteTarballStaged: true`. Fixed by re-deriving
   `build.mjs`'s complete, verbatim 18-file exclude list and unioning both
   pattern sets for the tarball check. Cross-checked against the REAL
   staged tree on disk after the fix: **0 mismatches across all 231 `src/`
   files** (a full-coverage verification, not a spot check).
5. The `'local'` classification bucket conflated two different facts:
   "reachable only from Full, never Lite" (which for most of `mcp/`'s 14
   files is true purely because Lite has no MCP entry point at all, not
   because the file imports anything ONNX/Ollama-specific) and "actually
   imports a local-runtime module." A new `runtimeCoupling` field
   (`'local'|'cloud'|'none'`, computed from each file's own direct
   dependency edges, not its reachability bucket) makes this distinguishable:
   of the 84 `'local'`-classified modules, only **22 are genuinely
   local-runtime-coupled**; the other **62** (mostly `mcp/`'s
   provider-neutral tool files) have `runtimeCoupling: 'none'` — Full-only
   by missing Lite entry-point coverage, not by architecture. See §6.6 for
   the precise per-file breakdown.
6. "Cloud never imports local" was listed as a required Part K rule but no
   test actually checked it — only the weaker, indirect "Lite reachability
   excludes local" was checked. Added a real, direct check (both in
   `classify-modules.mjs`'s own run and as a dedicated architecture test):
   for every cloud-classified file, do any of its OWN direct dependency
   edges resolve to a local-only file. Current result: **zero violations**.
   Also replaced every `recommendedAction: null` placeholder in the 236-entry
   inventory (previously "filled in by hand later," despite the artifact
   being presented as a complete inventory) with a deterministically
   computed value (`keep`/`split`/`move`/`exclude`), and replaced the
   Phase-1 test's fuzzy `nonLiteralCount <= 3` bound with an exact,
   two-directional allow-list check (every real non-literal reference must
   be explicitly reviewed and listed; every list entry must still
   correspond to a real reference, so a stale entry for since-fixed code is
   also caught) — the codebase currently has exactly **one** non-literal
   reference in total (`core/onnx-runtime.js`'s
   `require(resolveOnnxRuntimeModule(env))`, a genuinely necessary runtime
   resolution, local-only, never staged into Lite).

## 2. Current architecture

### 2.1 Directory survey (verified counts, this audit's own file walk)

| Area | Files (.js/.html) | Role |
|---|---|---|
| `src/core/` | 76 | Domain logic: embeddings, storage, retrieval, Ask, settings, generation, config |
| `src/indexer/` | 28 | File discovery, chunking, tagging, embedding, Qdrant writes |
| `src/admin/` | 69 (incl. `ui-src/`) | HTTP API, job registry, Admin UI source |
| `src/mcp/` | 14 | Model Context Protocol server + tools |
| `src/` top-level | 9 | `sync.js`, `doctor.js`, `smoke.js`, `bootstrap-docs.js`, `backfill-*.js` — full-Semidex-only maintenance CLIs |
| `packages/lite/lite-src/` | 5 | Lite's own composition layer (CLI + server bootstrap) |
| `packages/lite/{src,dist}/` | generated, gitignored | `build.mjs`'s staging output — never hand-edited, never committed |

231 files parsed cleanly under `src/` by this audit's AST walker (0 parse
errors); 5 more under `packages/lite/lite-src/` (hand-verified, outside
the `src/`-only graph by construction) — 236 total.

### 2.2 Entry points (verified, not assumed)

**Full entry points** (`package.json` `scripts`, cross-checked against
`packages/lite/build.mjs`'s `EXCLUDE_FILES`, which excludes exactly these
six top-level files plus `admin/bootstrap.js`):

| Command | File | Notes |
|---|---|---|
| `npm run admin` | `admin/bootstrap.js` | Dynamically imports `admin/server-full.js`'s `createApp()` — see §2.4 |
| `npm run index` | `indexer/index.js` | Thin `bootstrapEnv()` wrapper around `indexer/run.js` |
| `npm run mcp` | `mcp/server.js` | Separate long-lived process, stdio transport |
| `npm run sync` | `sync.js` | Full-only maintenance CLI |
| `npm run doctor` | `doctor.js` | Full-only health check |
| `npm run backfill:tags` / `:entity-refs` | `backfill-tags.js` / `backfill-entity-refs.js` | Full-only one-shot migrations |
| `npm run smoke` | `smoke.js` | Full-only dev test harness |
| `npm run bootstrap:docs` | `bootstrap-docs.js` | Full-only doc-indexing helper |

**Lite entry points** (`packages/lite/bin/semidex-lite.js` dispatching
into `packages/lite/lite-src/*.js`):

| Command | File | Real `src/`-relative imports (hand-verified) |
|---|---|---|
| `semidex-lite doctor` | `lite-src/doctor-lite.js` | `core/doctor-checks.js`, `admin/system/qdrant-cloud.js`, `core/embedding-profile/qdrant-cloud-catalog.js`, `core/embedding-profile/resolve.js` |
| `semidex-lite serve` | `lite-src/serve-lite.js` | `core/env-bootstrap.js`, `core/settings/service.js`, `core/settings/service.lite.js`, `admin/jobs/registry.js`, `admin/server.js` (dynamic), `core/generation/runtime.js` (dynamic) |
| `semidex-lite index` | `lite-src/index-lite.js` | `core/env-bootstrap.js`, `core/settings/service.js`, `admin/jobs/registry.js` — **does not** statically import `indexer/run.js`; it spawns `indexer/index.js` as a **child process** through `admin/jobs/registry.js`'s job registry, the identical mechanism `serve`'s HTTP job API uses |
| (internal) | `lite-src/hard-pins.js` | none — pure env-var constant list |
| (internal) | `lite-src/semidex-home.js` | none — pure path-resolution, Node builtins only |

**MCP has no Lite entry point at all today.** `packages/lite/build.mjs`
excludes the whole `mcp/` directory from staging. This is a genuine
product gap, not a technical blocker — see §6.6 for exactly which MCP
files are local-coupled and which are already provider-neutral.

### 2.3 Composition roots (verified by reading, not inferred)

- **`admin/bootstrap.js`** (Full) — dynamically imports `./server-full.js`
  for `createApp()`, and, separately and **statically** (an important
  finding, §5.3), dynamically imports `../core/ce-rerank.js` to call
  `applyCeRerankSettings()` unconditionally on every Full admin start.
- **`admin/server-full.js`** — owns `createApp()`, the Full composition
  root proper. Its own header comment documents exactly why it is a
  separate file from `server.js`: ES module imports are unconditional
  (they exist regardless of which exported function a caller actually
  invokes), so `createApp()`'s four Ollama/ONNX-only static imports
  (`registerOnnxRoutes`, `registerOllamaModelsRoutes`,
  `discoverOllamaModels`, `checkOllama`) could not safely coexist in the
  same file as `createLiteApp()` once Lite needed to stage that file.
- **`admin/server.js`** — hosts BOTH `createLiteApp()` (Lite's real
  composition root) and `registerNeutralRoutes()` (the shared route
  registration function both roots call) and `createHttpServer()` (shared
  HTTP+static-UI tail). This file is genuinely `mixed` by role, not by
  accident — see §4 for why splitting it further is a real open question,
  not an obvious win.
- **`packages/lite/lite-src/serve-lite.js`** — Lite's real composition
  root, dynamically imports `createLiteApp` from the **same**
  `admin/server.js` Full's `server-full.js` also depends on. This is the
  one piece of code genuinely shared **as composition**, not just as
  domain logic.

### 2.4 Lazy-import boundaries (verified, all three, by reading both variants)

| Real module | Lite shim | Cuts a static edge onto |
|---|---|---|
| `core/ollama-lazy.js` | `core/ollama-lazy.lite.js` | `core/ollama.js` |
| `core/onnx-embed-lazy.js` | `core/onnx-embed-lazy.lite.js` | `core/onnx-embed.js`, `core/length-bucket.js` |
| `indexer/phases/tag-onnx-lazy.js` | `indexer/phases/tag-onnx-lazy.lite.js` | `indexer/phases/tag-onnx.js` (and transitively `indexer/workers/tag-onnx-worker.js`, which is where the real `@huggingface/transformers` dynamic import lives) |

Each real variant does `await import('./<excluded>.js')` — a literal
dynamic import that resolves fine in the real repo but would throw
`ERR_MODULE_NOT_FOUND` in an installed Lite package once the target is
excluded from staging. `build.mjs` substitutes the shim's **content** at
the real module's **exact path**, so every caller's import specifier is
unchanged. Each shim's exports throw a typed
`*NotAvailableInLiteError { code: 'not_available_in_lite' }` instead of a
bare crash — a policy rejection if a future code change ever
accidentally reintroduces a reachable call path, confirmed as a deliberate
design choice by the shim source itself.

### 2.5 Worker/child-process boundaries (verified via the corrected graph)

| Spawner | Target | Mechanism | Purpose |
|---|---|---|---|
| `core/ce-rerank.js` | `core/ce-rerank-worker.js` | `fork(WORKER_PATH, ...)` where `WORKER_PATH = join(__dirname, 'ce-rerank-worker.js')` | Process-isolates `@huggingface/transformers` (CE reranking) from the CUDA-enabled `onnxruntime-node` build the main process's `onnx-embed.js` loads — two ORT builds cannot safely share one process |
| `indexer/phases/tag-onnx.js` | `indexer/workers/tag-onnx-worker.js` | `fork()` | Same isolation reason, for ONNX-based tag generation |
| `admin/jobs/registry.js` | `indexer/index.js` | `spawn(process.execPath, [INDEXER_ENTRY, path], ...)` | Runs an indexing job as a real child process — log capture, cancellation, and (documented in the file's own header) "no indexer library refactor, no in-process import" |

The third row is real infrastructure **both** Full and Lite depend on
identically (Lite's `index`/`serve` commands both go through this same
job registry) — it is correctly `shared`, not local, despite spawning
`indexer/index.js`, because the indexer entry point itself is
provider-neutral (its own dense/sparse provider comes from
`resolveEnvProviders()`/the resolved embedding profile, not a hardcoded
local assumption).

### 2.6 Hard pins (verified against `bin/semidex-lite.js`)

Eight env vars, set unconditionally before `bootstrapEnv()` runs:
`DENSE_PROVIDER=qdrant-cloud`, `SPARSE_PROVIDER=qdrant-cloud`,
`SEMIDEX_GENERATION_BACKEND=gemini`, `CONTEXT_MODE=deterministic`,
`TAG_GEN=0`, `SKELETON_SUMMARY=deterministic`, `COMBINED_LLM=0`,
`ONNX_EMBED=0`. Belt-and-suspenders enforcement: the Lite settings
service (`core/settings/service.lite.js` + `lite-policy.js`'s 19-key
allow-list) separately rejects any runtime attempt to change these, and
`server.js`'s `LITE_JOB_POLICY` rejects `onnxEmbed`/`llmSummaries`/`tagGen`
job options at the API layer — three independent layers agreeing, not one
mechanism relied on alone. See §11 for which of these are genuine product
defaults vs. compensating for the missing composition boundary.

### 2.7 Build-time allow/exclude lists

`packages/lite/build.mjs`'s `EXCLUDE_DIRS` (4 entries: `admin/ui-src`,
`mcp`, `smoke`, `test-fixtures`) and `EXCLUDE_FILES` (18 entries, listed
and individually justified in the script's own comments) are the actual,
current enforcement mechanism for tarball membership. `packages/lite/package.json`'s
`dependencies` (11 packages) is the actual, current enforcement mechanism
for npm-install-time footprint — verified by this audit as a proper
subset of the root `package.json`'s 15 dependencies, missing exactly
`onnxruntime-node`, `@huggingface/transformers`, and `highlight.js`
(confirmed Vite-build-time-only, per the earlier design doc).

### 2.8 UI partials and template entry points

Two build-time HTML-manipulation mechanisms coexist today, verified by
reading both Vite configs directly (§9 covers this in full):
`vite-plugin-html-inject`'s `<load>` tag (shared partial composition,
identical in both builds) and `vite.config.lite.js`'s own
`stripHtmlMarkers()` plugin (marker-delimited removal, Lite-only, two
distinct Vite hooks for two distinct HTML-delivery mechanisms — post-inline
`transformIndexHtml` for `global-settings.html`'s injected content, a
`pre`-enforced `load()` hook for `index-view.html`/`settings-shell.html`'s
`?raw`-imported content).

### 2.9 Closure-validation mechanism

`packages/lite/build.mjs`'s five-part AST-based validator (acorn/acorn-walk,
never regex) — already described accurately in
`docs/design/semidex-lite-package-boundary.md` and independently
re-verified by this audit's own separately-implemented graph builder,
which additionally **found and fixed two real gaps** in that validator's
own extraction logic (§1, §5). Recommend porting those two fixes back
into `build.mjs` itself (§16).

### 2.10 What is ALREADY a correct architectural boundary — does not need rework

- **The `*-lazy.js`/`*-lazy.lite.js` pattern itself.** A real, working,
  tested indirection seam. The task's target model's "cloud → shared,
  local → shared, shared ↛ cloud, shared ↛ local" rules are already
  enforced for these three specific edges — just not generalized to a
  directory-wide rule yet.
- **`admin/server-full.js` / `admin/server.js` split.** Already exactly
  the composition-root separation the target model asks for: Full's
  composition root imports both neutral and local-only route
  registration; Lite's composition root (via `server.js`) never imports
  anything local-only at all, by construction (no local-only import
  exists in that file at all — confirmed, not merely asserted, by this
  audit's graph).
- **`core/storage/factory.js` / `core/generation/registry.js`.** Already
  real, working, single-choke-point provider registries with **zero**
  conditional/environment-branching imports inside them (§6.1, §6.2) —
  exactly the "provider registry assembled at composition root, not
  scattered global conditionals" the task's Part E asks for.
- **`core/embedding-profile/schema.js`'s `EXECUTION` enum.** Already the
  correct per-collection discriminator (`client` / `qdrant-cluster` /
  `qdrant-cloud`) between local-execution and cloud-execution embedding,
  independent of which provider produced the profile — this is the
  mechanism that makes a single `StorageAdapter` implementation (there is
  only one: `qdrant-adapter.js`, for both local and cloud Qdrant) correct
  without a Local/Cloud adapter split (§6.3).
- **The five-part closure validator's core design** (parse-don't-guess,
  literal-specifier-only, fail-on-non-literal). The methodology is sound;
  only two specific extraction shapes had gaps (§1), not the overall
  approach.

## 3. Import/dependency graph — methodology

Built by `scripts/audit/build-import-graph.mjs`: every `.js` file under
`src/` is parsed into a real ESTree AST (acorn) and walked (acorn-walk)
for four reference kinds — static `import`/`export ... from`, literal
`import()`, `require()`/`createRequire()`-bound `require()`, and
`fork()`/`spawn()` literal targets (including the
`join(__dirname, 'literal')` and `fileURLToPath(new URL('literal', import.meta.url))`
patterns used throughout this codebase for worker/child-process paths).
Every relative specifier is resolved against the real filesystem
(`existsSync` + the same extension/`index.js` fallback order Node's own
ESM loader uses) — never assumed to resolve.

Reachability is computed by BFS from two root sets:

- **Full roots**: the 9 entry-point files in §2.2's first table.
- **Lite synthetic roots**: every file under `packages/lite/lite-src/` —
  now genuine parsed AST nodes in the same unified graph as `src/` (not a
  hand-transcribed import list; see this section's own revision note
  below for why that mattered).

Two distinct Lite-reachable sets are computed and reported **separately**,
not conflated (§5.2 explains why this distinction is load-bearing):

- **Pre-shim** (121 files, including the 5 `lite-src/` files themselves):
  reachability against real, unmodified `src/` — what a naive "just stage
  everything reachable" tool would compute.
- **Post-shim** (115 files): reachability after substituting each
  `*-lazy.js`→`*-lazy.lite.js` pair, matching what `build.mjs` actually
  stages and what genuinely ships in the tarball.

`docs/design/artifacts/full-lite-reachability-summary.json` records both
full file lists, both external-dependency maps, and the exact 6-file
diff the shim substitution removes:
`src/core/length-bucket.js`, `src/core/ollama.js`, `src/core/onnx-embed.js`,
`src/core/onnx-runtime.js`, `src/indexer/phases/tag-onnx.js`,
`src/indexer/workers/tag-onnx-worker.js`.

**Revision note (code review, second pass)**: the first version of this
methodology hand-transcribed each `lite-src/*.js` file's real imports into
a constant (`LITE_SYNTHETIC_ROOTS`) rather than parsing them — reviewed
and flagged as a silent-drift risk: a new import added to a Lite entry
point with no matching manual update would leave the whole reachability
computation (and every test built on it) blind to the new edge.
Reproduced directly: injecting a new `core/ollama.js` import into
`hard-pins.js` (previously an empty-imports file) and confirming the OLD
test suite stayed green despite the new local-runtime edge. Fixed by
extending `build-import-graph.mjs` to walk `packages/lite/lite-src/` as a
second root directory, parsed with the exact same AST walker as `src/`,
in one unified `REPO_ROOT`-relative coordinate space (node keys like
`src/core/config.js` and `packages/lite/lite-src/doctor-lite.js` sharing
one graph) — with one real wrinkle: `lite-src/`'s own `'../src/...'`
specifiers, resolved literally from their own directory, land on
`packages/lite/src/...` (the gitignored, `build.mjs`-GENERATED staging
mirror, verified via `diff -rq src packages/lite/src` to be a verbatim
content copy of `src/` modulo the documented exclusions/substitutions) —
not the real `src/` this graph treats as canonical. `resolveRelativeSpecifier()`
now redirects any path falling under that staging prefix to its real
`src/` equivalent, confirmed to still resolve correctly even with
`packages/lite/src/` entirely absent (a fresh-checkout simulation: moved
the directory away, re-ran the graph builder, confirmed identical
resolution).

## 4. Mixed-module findings

Nine files are genuinely `mixed` — real local AND shared/cloud code
coexisting in one file, confirmed by reading each one's actual branching
logic, not inferred from its directory:

| File | What's mixed | Who imports it | In Lite tarball? | In Lite JS bundle? | Recommended split |
|---|---|---|---|---|---|
| `admin/server.js` | `createLiteApp()` (Lite composition) + `registerNeutralRoutes()`/`createHttpServer()` (shared, used by BOTH roots) + `resolveHostConfig`/`resolvePortConfig` (shared utility) | `server-full.js` (Full), `lite-src/serve-lite.js` (Lite, dynamic) | yes | n/a (server-side) | Keep as-is for now (§4.1) — splitting further has a real cost, not an obvious win |
| `admin/ui-src/global-settings-view.js` | `IS_LITE`-guarded ONNX-probe-panel/Ollama-model-refresh functions, coexisting with the (much larger) fully shared, data-driven `fieldRow()` rendering | Vite's build graph (both builds) | n/a (UI source, excluded from tarball; only the BUILT `dist/admin-ui*/` ships) | yes — but DCE-verified byte-different between the two builds (§9) | Keep — genuinely one file with a real, tested, verified-by-build-diff dead-code split; extracting the guarded functions into a separate `-local.js` file is possible but adds an import hop for zero closure-validator benefit (the marker-scan already proves the strip works) |
| `admin/ui-src/settings-view.js` | `IS_LITE`-guarded reindex-options branch (reads `#opt-onnx`/`#opt-llm-summaries`/`#opt-tags` DOM elements that don't exist in Lite's stripped HTML) vs. shared reindex-submission logic | Vite's build graph | n/a | yes | Same as above |
| `core/ollama-lazy.js` / `.lite.js` | By design — the whole file pair's PURPOSE is being the boundary seam | `core/generation/ollama-provider.js`, `indexer/run.js`, `core/embeddings.js`, others | real file: no (substituted); shim: yes (as the real file's content) | n/a | This IS the recommended pattern — no split needed, it already is the split |
| `core/onnx-embed-lazy.js` / `.lite.js` | Same as above | `core/embeddings.js` | same substitution | n/a | Same |
| `indexer/phases/tag-onnx-lazy.js` / `.lite.js` | Same as above | `indexer/run.js` | same substitution | n/a | Same |

### 4.1 Why `admin/server.js` is not an obvious split candidate

The task's target model implies `server.js` should live entirely in
`composition-lite` (since it hosts `createLiteApp`) while
`registerNeutralRoutes`/`createHttpServer` should live in `shared`. In
practice, `registerNeutralRoutes` is **not** provider-neutral in the
literal sense the target model wants — it currently accepts
`runQdrantCloudProbeFn`, `resolveNewCollectionProfileFn` (cloud-specific
DI seams added in a recent task) alongside `pickFolderFn`/`checkOllamaFn`
threading points (local-specific, injected by the Full-only caller and
simply never passed by Lite). Splitting this file into
`shared/registerNeutralRoutes.js` + `composition-lite/server.js` is a
real, low-risk, mechanical Phase-5 candidate (§14) — but doing it as part
of THIS audit would be exactly the "move files first, decide the target
shape from the move" ordering the task explicitly warns against.

## 5. Lite closure findings (heavy/local dependency closure)

### 5.1 The four distinct guarantees, kept separate (per the task's own requirement)

| Guarantee | What it actually proves | How this audit checked it |
|---|---|---|
| Code does not execute | A code path is never reached at runtime under Lite's hard pins | Traced via the reachability BFS — `liteReachable` (post-shim) |
| Code is tree-shaken | Rollup/Vite's dead-code elimination physically removes a guarded branch from the built JS bundle | NOT re-verified by this audit (would require running Vite) — the existing `tests/unit/lite/ui-build-dce.test.js` already does this, by diffing two real builds, not by assertion |
| Code is absent from the JS bundle | Same as above, for the ADMIN UI specifically | Same — `ui-build-dce.test.js` is the authority here |
| Code is absent from the npm tarball | The file's bytes were never copied by `build.mjs`'s staging step | Checked directly: `liteTarballStaged` field in the module inventory, re-derived from `build.mjs`'s own `EXCLUDE_FILES`/`EXCLUDE_DIRS`, independently re-verified against `npm pack --dry-run`'s real output by the existing `clean-install-acceptance.test.js` |

### 5.2 Why the pre-shim/post-shim distinction is load-bearing

This audit's graph, built from real unmodified `src/`, finds
`@huggingface/transformers` **reachable** from Lite's synthetic roots —
via `admin/jobs/registry.js` → (spawn) → `indexer/index.js` →
`indexer/run.js` → `indexer/phases/tag-onnx-lazy.js` →
(pre-shim: the REAL file) `indexer/phases/tag-onnx.js` →
`indexer/workers/tag-onnx-worker.js` → (dynamic import)
`@huggingface/transformers`.

This is **not a bug** — it is the honest, correct statement of what real
`src/` looks like before `build.mjs`'s staging step runs. The reason Lite
is safe is specifically that `build.mjs` **substitutes**
`tag-onnx-lazy.js`'s content with `tag-onnx-lazy.lite.js` (whose every
export throws instead of importing anything) at staging time. Re-running
this audit's classifier with `applyLiteShims: true` (matching the real
staged output) correctly drops this edge, and the post-shim heavy-package
set is empty — confirmed, not assumed.

**The architectural implication**: Lite's local-dependency safety
currently depends on a human remembering that any new static edge onto
`core/ollama.js`/`core/onnx-embed.js`/`indexer/phases/tag-onnx.js` (or
any FUTURE local-only heavy module) must be routed through a NEW
`*-lazy.js` pair, or excluded outright — nothing today prevents a new
local-only file from being added with a *direct* static edge from a
Lite-reachable file, other than the closure validator catching it
**after the fact**, at `npm pack` time. §13 proposes tests that catch this
at `git diff`/CI time instead of npm-publish time.

### 5.3 `core/ce-rerank.js` — module load vs. runtime execution

`admin/bootstrap.js` (Full only) unconditionally, dynamically imports
`core/ce-rerank.js` and calls `applyCeRerankSettings()` on every Full
admin startup — this module load is NOT gated by `RERANK_CE_ENABLED`.
What IS gated: `ce-rerank.js`'s own `fork(WORKER_PATH, ...)` call, which
only happens lazily, on first actual CE-rerank request, and only if
`RERANK_CE_ENABLED=1`. This means, for Full: the module is always loaded
(fine — it never imports `@huggingface/transformers` itself, only forks a
worker that does), but the heavy package is never actually pulled into
the main process regardless of the feature flag, by the same
process-isolation design already documented in the file's own header
comment. This is a correct, intentional design already in place — not a
finding requiring a fix, but a nuance §5.1's "code does not execute" row
needed to state precisely rather than conflate with "module never
loaded."

### 5.4 Full closure heavy-dependency reachability (for comparison)

`onnxruntime-node`: reachable from Full only via the dynamic-specifier
inside `core/onnx-runtime.js` (`return customPath ? resolve(customPath) : 'onnxruntime-node';`
— a computed string passed to a dynamic `import()` elsewhere, correctly
flagged `[dynamic-import:non-literal]`-shaped by a validator, since it
cannot be statically proven safe; this is fine for Full, which is
SUPPOSED to reach it, and irrelevant for Lite since `onnx-runtime.js`
itself is excluded from staging). `@huggingface/transformers`: reachable
from Full unconditionally via `bootstrap.js` → `ce-rerank.js` (module
load only, per §5.3) and, separately, via `indexer/run.js` →
`tag-onnx-lazy.js` → `tag-onnx.js` → `tag-onnx-worker.js` (real edge,
real fork, real dynamic import — Full genuinely needs this reachable).

## 6. Target architecture — provider boundaries and module areas

### 6.1 `EmbeddingProvider` — real current consumers

No single `EmbeddingProvider` interface object exists today; embedding
selection is done through `core/embeddings.js`'s `resolveEnvProviders()`
(env/settings-driven) feeding a resolved `EmbeddingProfile`
(`core/embedding-profile/schema.js`) whose `execution` field
(`client`/`qdrant-cluster`/`qdrant-cloud`) is the real dispatch key.
`core/embeddings.js` itself IS the closest thing to a provider-neutral
orchestration point — it is `shared`-classified and correctly imports
`onnx-embed-lazy.js` (never `onnx-embed.js` directly) so it can be staged
in Lite without pulling ONNX. Real consumers: `indexer/run.js`,
`core/retrieval/search.js` (query-side embedding), `core/ask/evidence.js`.
A formal `EmbeddingProvider` contract object (mirroring
`storage/adapter.js`'s `validateStorageAdapter()` shape-check pattern)
does not exist yet — `core/embeddings.js`'s functions ARE the de facto
contract, just not reified as a typed shape. Recommend formalizing this
only if/when a THIRD dense-embedding execution path is added (e.g. a
future non-Qdrant cloud embedding API) — introducing the abstraction now,
for exactly two real implementations, would be exactly the
"abstraction for symmetry, not for a real second consumer" the task
explicitly warns against.

### 6.2 `GenerationProvider` — real current consumers

**This one already exists as a real, tested, typed contract**:
`core/generation/provider.js`'s `validateGenerationProvider()` +
`REQUIRED_PROVIDER_METHODS` (`name`, `capabilities`, `ready`, `generate`).
`core/generation/registry.js`'s `createGenerationProvider({backend, options})`
is the real, working, single-choke-point factory — a plain object map
(`{ollama: createOllamaProvider, gemini: createGeminiProvider}`), zero
`process.env` reads inside the registry itself (confirmed by reading the
file — the header comment states this explicitly and the code matches).
Real consumers: `core/generation/runtime.js` (the service that resolves
which backend to construct from settings), `core/ask/coordinator.js` (the
one caller that uses a constructed provider's `.generate()`). Full sees
both backends (`ollama` factory statically imported, itself routed
through `ollama-lazy.js`); Lite's own hard pin
(`SEMIDEX_GENERATION_BACKEND=gemini`) never selects `ollama` at runtime,
but the registry itself has no Lite-specific branch at all — the SAME
registry file runs unmodified in both builds. This is the exact
"provider registry assembled at composition root, shared orchestration
never imports a concrete provider" shape the task's Part E asks for,
already real.

### 6.3 `StorageAdapter` — real current consumers, and why there is only one implementation

`core/storage/adapter.js`'s `validateStorageAdapter()` +
`REQUIRED_ADAPTER_METHODS` is the real, tested contract.
`core/storage/factory.js`'s `createStorageAdapter({backend})` is the
real, working factory — currently a ONE-entry map (`{qdrant: createQdrantStorageAdapter}`).
This is correct, not incomplete: local Qdrant and Qdrant Cloud speak the
identical wire protocol through the identical `@qdrant/js-client-rest`
client; what differs between a local-cluster collection and a
cloud-Inference collection is which embedding EXECUTION mode its stored
profile declares, not which storage adapter implementation handles it.
`core/embedding-profile/schema.js`'s `EXECUTION` enum already includes an
unimplemented third value, `qdrant-cluster` (server-side embedding on a
self-hosted cluster, distinct from `qdrant-cloud`'s billed Inference API)
— confirmed via the enum's own header comment, which explicitly
distinguishes the two so a future
`dense=e5(qdrant-cloud) + sparse=bm25(qdrant-cluster)` profile stays
representable. Real consumers of `StorageAdapter`: essentially every
route handler in `admin/api/*.js`, `core/ask/coordinator.js`,
`core/retrieval/search.js`, every `mcp/tools/*.js` file.
`validateStorageAdapter()`/`validateGenerationProvider()` themselves are
`unclear`-classified in the inventory (§6.9) because their only real
callers are test files — a legitimate, correct outcome for a
conformance-check utility, not a defect.

### 6.4 `ModelCatalog`

Exists, cloud-only, real: `core/embedding-profile/qdrant-cloud-catalog.js`
+ `qdrant-cloud-models.js` (the browser-safe, zero-dependency data half,
confirmed by its own header comment to deliberately exclude
`qdrant-cloud-tokenizer.js`'s fs/fetch/native-tokenizer code so the Admin
Settings UI can import catalog data without pulling in
`@huggingface/tokenizers`'s Node-only half). No equivalent catalog exists
for local (Ollama) models — `core/ollama-models.js`/`admin/api/ollama-models.js`
do live model discovery instead (a genuinely different problem: Qdrant
Cloud's model list is static/curated because no discovery API exists,
Ollama's IS a live `/api/tags`-style discovery). These are not the same
shape and should not be forced into one contract.

### 6.5 `RuntimeAvailabilityProbe`

Exists in pieces, not as one contract: `admin/system/qdrant-cloud.js`'s
`classifyInferenceProbeError()`/`probeModelAvailability()` (cloud, 4-status:
`available`/`unavailable_for_cluster`/`unsupported_by_semidex`/`unverified`
— added in a recent task this session), `admin/system/ollama.js`'s
`checkOllama()` (local, different shape), `core/onnx-provider-probe.js`
(local, ONNX execution-provider-specific). Genuinely three different
probe shapes for three different runtimes with different real failure
modes (a Qdrant Cloud tier-gate error is a wholly different concept from
"is the Ollama daemon reachable"). A shared `RuntimeAvailabilityProbe`
interface is possible (`{probe(): Promise<{status, message}>}`) but would
currently have exactly zero code reuse benefit — no caller today needs to
treat a cloud-model probe and an Ollama-reachability probe identically.
Recommend against introducing this abstraction now; revisit if a THIRD
probe consumer needs to treat them polymorphically.

### 6.6 MCP — the one real "should be shared but isn't reachable" finding

Of `mcp/`'s 14 files, only **3** have a genuine local-coupling edge:
`mcp/server.js` and `mcp/tools/search.js` (both import `core/ce-rerank.js`
for opt-in reranking) and `mcp/tools/collections.js` (imports
`core/ollama.js` directly, statically, for its own availability-display
logic — `isOllamaReachable`/`listOllamaModels`/`validateOllamaModels`).
The other **11** MCP tool files import only `core/storage/factory.js`,
`core/retrieval/search.js`, `core/assembly/*.js`, `core/token-count.js` —
already fully provider-neutral. This is the single clearest concrete
example in the whole codebase of the target model's "Lite should reuse
cloud, not know local exists" principle NOT yet being applied: MCP is
currently `local`-classified in the inventory purely because Lite has no
MCP entry point to reach it from, not because most of it needs anything
local. If Lite ever wants MCP support, the real work is: (a) route
`mcp/tools/collections.js`'s Ollama-availability display through a
`checkOllamaFn` DI parameter the way `admin/api/jobs.js` already does
(§2.6's pattern, already proven), and (b) route `ce-rerank.js` through the
existing `ce-rerank.js`-is-already-safe-to-load-but-never-fork's-in-Lite
pattern (or exclude it and disable CE reranking in Lite specifically,
which is a legitimate product decision either way).

**Precise, codebase-wide version of this same finding** (code review,
second pass — the module inventory's `runtimeCoupling` field, computed
from each file's own direct dependency edges rather than its Full-vs-Lite
reachability bucket): of all 84 `classification: 'local'` modules,
**exactly 22 are genuinely `runtimeCoupling: 'local'`** (a real ONNX/
Ollama-native edge of their own); the other **62** have
`runtimeCoupling: 'none'` — Full-only purely because no Lite entry point
reaches them, not because of anything in their own dependency graph.
MCP's 11 provider-neutral tool files are the largest single contributor to
that 62, but not the only one — the same distinction applies to any other
Full-only file with no real local-runtime edge of its own. The earlier
"84 local modules" headline number in the executive summary is real but
was, before this distinction existed, easy to misread as "84 modules
that need ONNX/Ollama" — it does not mean that; `runtimeCoupling` is the
field that answers that specific question precisely.

### 6.7 Where settings definitions live

`src/core/settings/definitions.js` — 66 total field definitions, one flat
map, `category`-tagged (`embeddings`, `ai`, `system`, ...) but not
directory-partitioned. `src/core/settings/lite-policy.js`'s
`LITE_SETTINGS_KEYS` — a 19-key allow-list, already achieving the
API-exposure half of the task's Part H requirement (`core/settings/service.lite.js`
wraps the real service so `getAll()`/`get()`/`setMany()` all reject
anything outside the allow-list). See §10 for the full analysis of
whether a physical `sharedDefinitions`/`cloudDefinitions`/`localDefinitions`
file split is warranted given this already-working allow-list.

### 6.8 Where provider selection happens

`resolveEnvProviders()` (`core/config.js`) reads `DENSE_PROVIDER`/
`SPARSE_PROVIDER`/model env vars — called from `indexer/run.js`'s
new-collection branch and `core/generation/runtime.js`'s backend
resolution. Both are genuinely `shared` (no Lite-specific branch inside
either function) — Lite's hard pins work by constraining WHICH VALUES
these env vars can hold before this code ever runs, not by this code
knowing Lite exists.

### 6.9 The two `unclear`-classified files, explained precisely

`core/storage/adapter.js` and `core/generation/provider.js` are reachable
from **neither** Full's nor Lite's real composition-root graph — verified
by grepping every reference to either file across the ENTIRE codebase:
every single hit outside the files themselves is a JSDoc
`@param {import('...').TypeName}` type-only reference (never executed,
acorn correctly does not extract it as an `ImportDeclaration`), except for
each file's OWN real runtime export (`validateStorageAdapter`,
`validateGenerationProvider`), whose only real callers are test files
(`tests/unit/core/storage/*.test.js`, `tests/unit/core/generation/*.test.js`).
This is the CORRECT, intended shape for a conformance-check utility — not
a defect, not dead code, `recommendedAction: keep`.

## 7. Indexer/Ask composition

Pipeline stages surveyed (`src/indexer/phases/`, `src/core/ask/`):

| Stage | Current shared-ness | Notes |
|---|---|---|
| File discovery (`indexer/files.js`) | Already shared | No provider awareness at all |
| Parsing (Markdown/PDF/Pandoc) | Already shared | `chunk.js` dispatches by file type, not by provider |
| Skeleton chunking | Already shared | `skeleton-chunk.js`/`skeleton.js`/`token-budget-split.js` — provider-neutral, token-budget-aware per the resolved profile's model, not hardcoded |
| Token budgeting | Already shared | `token-count.js`'s `resolveTokenCountMode(env, profile)` — profile-aware, dispatches to either the local BGE-M3 tokenizer or a model-scoped Qdrant Cloud tokenizer based on `profile.embedding.dense.execution`, confirmed in this session's own earlier work |
| Deterministic context | Already shared, Lite-relevant | `CONTEXT_MODE=deterministic` — a real product feature (zero-LLM-call context for non-Markdown files), not Lite-only; Full defaults to `llm` but can opt into the same deterministic path |
| LLM summaries | Provider-injected correctly | `SKELETON_SUMMARY` env — Lite pins `deterministic`, same reasoning as context mode |
| Tagging | Local-only when ONNX-routed, shared when off | `TAG_GEN=0` in Lite; `tag-provider.js` (the pure `isOnnxTagProvider` predicate, dependency-free) is already correctly extracted from `tag-onnx.js` specifically so the lazy wrapper doesn't need to import the heavy file just to answer a routing question |
| Embeddings | Already shared via `embeddings.js` + lazy ONNX edge | §6.1 |
| Qdrant writes | Already shared | Single `StorageAdapter`, §6.3 |
| Retrieval | Already shared | `core/retrieval/search.js` — no provider branching, reads the collection's own resolved profile |
| Ask context assembly | Already shared | `core/ask/evidence.js`/`coordinator.js` — provider-neutral, takes an injected `GenerationProvider` |
| Generation | Already shared registry, §6.2 | |

**Conclusion**: the indexer/Ask pipeline is ALREADY almost entirely
provider-injected at the stage level — this was true before this audit
and is not a new finding this task needed to produce. The real remaining
work is entirely at the MODULE-BOUNDARY level (§4, §5), not the
pipeline-stage level.

### 7.1 Lite hard-pin audit (task's own explicit ask)

| Pin | Genuine product default? | Or compensating for missing boundary? | Removable after Part D? |
|---|---|---|---|
| `DENSE_PROVIDER=qdrant-cloud` / `SPARSE_PROVIDER=qdrant-cloud` | Genuine — Lite's whole product identity is "cloud only" | — | No, and shouldn't be — this is THE product contract, not a workaround |
| `SEMIDEX_GENERATION_BACKEND=gemini` | Genuine | — | No |
| `CONTEXT_MODE=deterministic` | Genuine product default (zero-LLM-call, cheaper/faster) that HAPPENS to also suit Lite | — | Could become user-configurable in Lite later without any architectural change — already a real, tested, non-Lite-specific feature |
| `TAG_GEN=0` / `SKELETON_SUMMARY=deterministic` / `COMBINED_LLM=0` | Compensating — these exist because Lite has no local tagging/summary LLM path at all today | Yes | Only if Lite ever gains a cloud-LLM-backed tagging/summary path (a real, separate, larger feature, not a refactor) |
| `ONNX_EMBED=0` | Compensating | Yes | Removable in the sense that it becomes moot once `DENSE_PROVIDER` is already pinned to `qdrant-cloud` — this pin is redundant with the dense-provider pin today, kept as defense-in-depth per the design doc's own "belt-and-suspenders" framing |

## 8. Admin UI composition

### 8.1 Current mechanism (verified by reading both Vite configs in full)

Two Vite configs (`vite.config.js` / `vite.config.lite.js`), ONE shared
`src/admin/ui-src/` source tree, `SEMIDEX_LITE` boolean literal define
(Rollup DCE, verified by an existing test to be REAL elimination — output
byte-diffed, not merely "should work"). Local-only, unconditional STATIC
markup (not removable by data-gating alone, since most of the Settings
view already renders generically from `GET /api/settings`) is removed by
a small marker-based strip plugin at exactly two spots:
`global-settings.html`'s `<template id="tpl-gs-onnx-probe-panel">` block,
and duplicated ONNX/LLM-summaries/tag-gen checkboxes on TWO separate
indexing forms (`index-view.html`, `settings-shell.html`).

### 8.2 Assessment of the task's proposed `entries/full.js` + `partials/{shared,full,lite}/` structure

Evaluated against the CURRENT working mechanism, not assumed superior by
default. The proposed structure would require:

- Splitting `main.js`'s single entry point into two (`entries/full.js`,
  `entries/lite.js`) — mechanically simple, Vite already supports
  multiple entries via `build.rollupOptions.input`.
- Moving the 2 genuinely local-only markup blocks into
  `partials/full/*.html` and having `partials/lite/` supply Lite-specific
  replacements (the current `stripHtmlMarkers()` plugin already
  effectively does this via inline `replacement` strings — the task's own
  "no HTML generated by large JS strings" constraint is ALREADY satisfied
  today, since the replacements are short, hand-written HTML fragments
  inline in the Vite config, not string-built).
- Moving `global-settings-view.js`'s/`settings-view.js`'s `IS_LITE`-guarded
  functions into separate `-full.js` files — a real, moderate-effort
  change with a real, moderate benefit (removes the `typeof SEMIDEX_LITE`
  runtime-guard pattern the task's own rules discourage as "relying on
  runtime flags as the primary isolation mechanism").

**Verdict**: the CURRENT marker-strip mechanism already satisfies every
hard requirement (local-only partials excluded from Lite HTML, local-only
JS excluded from the Lite bundle — both verified by a real build-diff
test, not asserted) — it is not broken. The proposed `entries/`+`partials/{full,lite}`
restructure is a genuine improvement specifically for the **third**
concern the task raises (runtime flags should not be the PRIMARY
isolation mechanism) — today's `IS_LITE` checks are a secondary
belt-and-suspenders layer UNDER a real build-time marker strip, not the
primary mechanism, so the current state is defensible but not the
cleanest achievable shape. Recommend as a real Phase-5/6 migration item
(§14), not urgent, not a defect.

### 8.3 `vite-plugin-html-inject` / `vite-plugin-full-reload` compatibility

Both plugins operate on the SHARED partial-composition mechanism
(`<load>` tags), used identically by both builds today — confirmed by
reading `vite.config.js` (`fullReload(['partials/**/*.html'], ...)`,
dev-only, absent from `vite.config.lite.js` entirely since Lite has no
`admin:dev` equivalent). No compatibility conflict exists with the
proposed `partials/{shared,full,lite}/` restructure — `vite-plugin-html-inject`
resolves `<load>` paths relative to its own root regardless of directory
depth.

## 9. Settings composition

### 9.1 Current mechanism (already partially achieves Part H)

`core/settings/definitions.js` (66 keys, flat, `category`-tagged) +
`core/settings/lite-policy.js` (19-key allow-list) +
`core/settings/service.lite.js` (wraps the real `SettingsService`,
rejects any non-allow-listed key on `get`/`getAll`/`setMany`). This
ALREADY achieves "Lite API physically does not expose local settings" —
confirmed by the design doc's own description of a full call-site audit
that found `HYBRID_PREFETCH_LIMIT`/`RRF_K` needed adding to the allow-list
(a real bug caught by that audit, now fixed and covered by
`tests/unit/admin/lite-app.test.js`).

### 9.2 Should `definitions.js` be physically split into shared/cloud/local files?

Assessed, not assumed. Arguments for keeping the CURRENT single-file +
allow-list shape: (a) the allow-list already achieves the hard
requirement (Lite API/UI never sees local definitions) without
duplicating any cloud-setting definition between two files — the task's
own explicit "no duplication of cloud settings between Lite and Full"
requirement is trivially satisfied by construction today, since there is
exactly one `QDRANT_CLOUD_DENSE_MODEL` definition, period; (b) a physical
split would require `fullDefinitions = {...sharedDefinitions, ...cloudDefinitions, ...localDefinitions}`
to be assembled somewhere — that assembly point would need to preserve
insertion order and category grouping the current flat map provides for
free. Arguments for splitting: (a) a physical file boundary is checkable
by an import-direction test the way a shared allow-list constant is not
(nothing today prevents a NEW local-only definition from being added
without also adding it to `lite-policy.js`'s exclusion, other than a
human remembering — the allow-list is an ALLOW list specifically so this
failure mode defaults safe, but it is still a manual step); (b) it would
make "which definitions exist for which product" grep-able by directory
instead of requiring cross-referencing two files.

**Recommendation**: keep the allow-list mechanism (it is correct, tested,
and defaults-safe), but ADD a Part-K architecture test asserting every
`definitions.js` key is either in `LITE_SETTINGS_KEYS` OR provably
unreachable from Lite's own settings-rendering code path — turning the
"human must remember" gap into an automatically-checked one, without a
file-move.

### 9.3 Collection-specific embedding profile as canonical source of truth

Already correctly implemented and unrelated to the settings-definitions
question — `resolveExistingCollectionProfile()`
(`core/embedding-profile/resolve.js`) is READ-ONLY, never consults
global/env settings, confirmed by a dedicated test suite (from this
session's earlier work) that stubs `settingsService.getActiveValue` to
THROW if ever called during an existing-collection search, proving no
accidental fallback exists. Global settings affect only
`resolveNewCollectionProfile()`, the new-collection path — exactly the
"global settings influence only new collections" contract the task's
Part H requires.

## 10. Packaging and publishing

### 10.1 Current `packages/lite/build.mjs` staged content (re-verified by this audit)

- Source files copied: every file under real `src/` EXCEPT the 4 excluded
  directories and 18 individually-listed excluded files, `*.js` extension
  only for the file-exclusion check (matching `build.mjs`'s own logic,
  re-read directly, not assumed).
- Dependencies in the package manifest: 11, a verified proper subset of
  root `package.json`'s 15 — `onnxruntime-node`, `@huggingface/transformers`,
  `highlight.js` (Vite-build-time-only) excluded.
- Generated artifacts in the tarball: `dist/admin-ui/` (copied from
  `dist/admin-ui-lite/`, the SEPARATE Lite Vite build output — never the
  Full build's output).
- Unauthorized local-module import after install: checked by the existing
  `clean-install-acceptance.test.js` (acorn-based, confirmed every
  relative import in the INSTALLED package resolves inside the package
  directory — no `../../../` escape into a path that only existed in the
  repo).
- Leftover URL/Ollama/HuggingFace fragments: checked by `build.mjs`'s own
  check #5, a real content scan (not just AST) of the BUILT UI output
  (HTML and JS) for a fixed marker list.
- Closure validator's real coverage: verified accurate for 3 of 3 lazy-shim
  edges, 4 of 4 bare-specifier checks, but had 2 real gaps in its
  fork/spawn-target resolution (§1) — now fixed in this audit's own
  independent re-implementation; **not yet ported back into the actual
  `build.mjs`** (an explicit open decision, §16).

### 10.2 Recommended target publish pipeline

```
source composition (src/, unchanged)
  → npm run admin:build:lite            (Lite Vite build -> dist/admin-ui-lite/)
  → node packages/lite/build.mjs        (stage src/, substitute lazy shims,
                                          copy dist/admin-ui-lite/, run the
                                          FIXED five-part closure validator)
  → npm pack (inside packages/lite/)    (real tarball, via `prepack` hook
                                          already wired to the two steps above)
  → clean-install acceptance            (real tarball, fresh temp dir,
                                          read-only install, --help/doctor/
                                          serve + import-escape check)
  → npm publish                          (manual, explicit — never automatic)
```

This is the EXISTING pipeline (`packages/lite/package.json`'s `prepack`
script already chains the first two steps) — no new pipeline stage is
proposed, only the closure-validator fix (§1) and CI wiring (§10.3, a gap
the earlier design doc's own "Remaining limitations" section already
flagged and this audit independently reconfirms).

### 10.3 What CI should build vs. what must never be a committed generated duplicate

`packages/lite/src/` and `packages/lite/dist/` are gitignored — confirmed
by the fact `build.mjs` unconditionally `rmSync`s and regenerates both on
every run. **This is correct and must stay this way** — committing either
would create exactly the "two copies of the same chunking/retrieval/Ask
logic" drift risk the earlier design doc explicitly rejected as an
alternative architecture. CI should run: `npm run admin:build:lite` →
`node packages/lite/build.mjs` → the Lite test suite
(`tests/unit/lite/**`) → `npm pack --dry-run` (or a real `npm pack` into a
scratch dir) → clean-install acceptance — on every change touching `src/`
or `packages/lite/`, exactly the "next recommended task" the earlier
implementation report already identified as not yet done.

## 11. Migration phases

Each phase is independently shippable, independently revertable, and
adds a test BEFORE or WITH the change it's protecting — never after.

### Phase 1 — Lock in dependency rules with automated tests (no source changes)

Files: new test files only (§13's designs). Dependencies: none (reads
existing source). Risk: none — purely additive, read-only checks. Backward
compatibility: trivially preserved (no runtime code touched). Tests: the
new tests themselves. Exit gate: `npm run admin:build` +
`node packages/lite/build.mjs` + the new tests all pass against CURRENT
`src/`, proving the rules the tests encode are already true today (not
aspirational) before anything is asked to change to satisfy them.

### Phase 2 — Port the two closure-validator extraction fixes into `build.mjs` itself (DONE)

Status: **completed**, `packages/lite/build.mjs` only, no other files
touched. Ported the `AssignmentPattern` default-param tracking and the
`process.execPath`-aware spawn-arg resolution (both from §1's finding 1),
plus the `join(__dirname, bareFilename)` fix (§1's finding 2) from
`scripts/audit/build-import-graph.mjs` into `build.mjs`'s own
`extractReferences()`/`findLiteralRelativePathArg()`.

**This plan's own original risk assessment was wrong on one point** —
"the validator's pass/fail outcome for the CURRENT staged tree is
unchanged" did NOT hold. Running the ported fix for real surfaced a
THIRD, previously-invisible spawn edge neither the original validator nor
this audit's own tooling had exercised before: `admin/system/folder-picker.js`'s
`spawnFn('powershell.exe', [...])` (the native folder-picker dialog) has
the exact same `spawn as nodeSpawn` → default-param `spawnFn` shape as
`admin/jobs/registry.js`, but here the target is a real OS executable
invoked by PATH name, not a repo-relative script — categorically
different from "a repo file that should have been staged but wasn't."
The AssignmentPattern fix correctly started tracing this call for the
first time and the validator correctly flagged it as
`[spawn:missing-target]`, since `'powershell.exe'` cannot resolve to any
staged file.

**Revision note**: the FIRST fix for this finding added a hardcoded
`TRUSTED_OS_SPAWN_TARGETS` Set of specific program names (e.g.
`'powershell.exe'`) — a subsequent code-review round correctly rejected
this as exactly the kind of hardcoded allow-list this validator's own
design principle forbids, AND unnecessary: Node's own `child_process`
semantics already distinguish "an OS command resolved via PATH search"
from "a repo-relative file path" without naming anything. The FINAL,
shipped fix is `isBareOsCommand(arg)` — a semantic classifier, not a name
lookup: a literal `spawn()` first argument is treated as a bare OS
command (never checked against the staged tree at all) when it does NOT
start with `.` and contains neither `/` nor `\` — i.e. it doesn't look
like a path at all, mirroring the exact rule Node's own PATH-search logic
uses. Scoped to `spawn` only (never `fork`, which always launches a Node
module by path and has no legitimate "OS binary by name" mode at all — so
it is never exempted, regardless of shape). No specific command name
(`'powershell.exe'`, `'bash'`, `'ffmpeg'`, ...) is ever compared against
anything; a genuinely arbitrary, never-before-seen command name is
accepted identically to a known one, which a later regression test
(`tests/unit/lite/build-closure-validator.test.js`) verifies directly by
constructing a fixture with a made-up command name and asserting
`runValidator()` reports zero errors for it.

A second, independent bug was found and fixed alongside this one: the
lexical-scope resolution added to trace `spawn`/`fork` through import
aliases and default parameters initially checked the file-scope
module-import binding BEFORE checking the enclosing-function parameter
chain, so a parameter that shadowed a directly-imported `spawn`/`fork`
name (no alias at all, e.g. `import { spawn } from 'node:child_process';
function run(spawn) { spawn('./x.js'); }`) was still misclassified as a
real `child_process.spawn` call. Fixed by making the resolution walk the
enclosing-function chain from innermost to outermost FIRST, consulting
the module-level import binding only once no enclosing function declares
the name as a parameter at all — matching real JS lexical scoping.

Verified: `node packages/lite/build.mjs` passes clean (116 files staged);
`extractReferences()` directly confirmed to resolve
`admin/jobs/registry.js`'s spawn target to `../../indexer/index.js` and
`core/ce-rerank.js`'s fork target to `./ce-rerank-worker.js` against real
source; `tests/unit/lite/build-closure-validator.test.js` (27 tests,
covering extraction, lexical-scope shadowing in both directions, the
semantic bare-command classifier via a real `runValidator()` fixture
call, and isolated `mkdtemp()`-based positive/negative validation
fixtures — no test mutates the shared, generated
`packages/lite/src/` tree in place); full `tests/unit/lite/**`, the real
packed-tarball `clean-install-acceptance.test.js`, and `tests/unit/admin/**`
(includes `pickFolder()`'s own direct unit tests) all pass. `git status`/
`git diff --check` confirm only `packages/lite/build.mjs` and its
dedicated test file changed.

Files: `packages/lite/build.mjs`, `tests/unit/lite/build-closure-validator.test.js`.
Dependencies: none new. Risk: realized, not merely assessed — the fix's
own true positive (the `powershell.exe` finding) required additional,
deliberate design work (first an allow-list, then — after code review —
the semantic classifier that actually shipped) beyond the
originally-scoped "port the fix" work, and a second code-review round
found the lexical-scope ordering bug above — exactly why a spawn/fork-shape
change to a closure validator warrants running it for real, and
re-reviewing it, rather than trusting a priori that newly-recognized
edges will always already resolve correctly. Backward compatibility:
preserved — the real, packed Lite tarball is unchanged in contents
(`npm ls --all` / clean-install acceptance both still pass, `pickFolder()`
remains fully staged and functional). Tests: all listed above, currently
passing. Exit gate: met.

### Phase 3 — Split `admin/server.js` into `registerNeutralRoutes.js` (shared) + a thinner `server.js` (Lite composition)

Files: `admin/server.js`, its ~9 test-file importers (mechanical import-path
updates only). Dependencies: none new. Risk: low, mechanical — the
FUNCTION BODIES do not change, only which file they live in. Backward
compatibility: every external import path (`admin/server-full.js`,
`lite-src/serve-lite.js`) needs exactly one import-path update each.
Tests: existing `tests/unit/admin/server.test.js` + Lite app tests, run
unmodified against the new file layout (should require zero test-logic
changes, only import-path fixes if they import internals directly).
Exit gate: full test suite green, `git diff --check` clean.

### Phase 4 — Split provider registries' Lite-relevant DI seams into an explicit `composition-lite` module

Files: extract `LITE_JOB_POLICY`, `registerGenerationModelsRoutesGeminiOnly`,
and `createLiteApp()` itself out of `server.js` into a new
`admin/composition/lite.js`. Dependencies: none new. Risk: low, mechanical.
Tests: same suites as Phase 3. Exit gate: same.

### Phase 5 — Split settings definitions physically OR add the automated allow-list-completeness test from §9.2 (pick ONE, not both, per the audit's own recommendation in §9.2 to prefer the test over the file-split)

Files: either `core/settings/definitions.js` (if splitting) or a single
new test file (if not). Dependencies: none new. Risk: low either way.
Exit gate: the new/updated test passes.

### Phase 6 — Admin UI `entries/{full,lite}.js` + `partials/{shared,full,lite}/` restructure (§8.2)

Files: `vite.config.js`, `vite.config.lite.js`, `main.js` split into two
entries, the 2 local-only markup blocks moved into `partials/full/`.
Dependencies: none new. Risk: moderate — this is the first phase that
touches the BUILD OUTPUT shape, not just source organization; requires
the existing `ui-build-dce.test.js`-style byte-diff test to be re-run and
re-baselined (an intentional, expected diff this time, since the entry
point genuinely changes — verify the diff is EXACTLY "different bundle
structure," never "different runtime behavior"). Exit gate: both real
Vite builds succeed, DCE test suite (updated for the new entry shape)
passes, manual smoke of both `admin:dev` and a Lite `serve` session.

### Phase 7 — Remove now-unnecessary Lite shims (only after Phases 3–6 land)

Files: TBD — depends on which shims Phases 3–6 make redundant. Not
plannable in detail until those phases exist. Exit gate: closure
validator still clean, Lite tarball size does not regress.

### Phase 8 — Narrow npm staging to the real, now-directory-enforced shared+cloud closure

Files: `packages/lite/build.mjs`'s `EXCLUDE_FILES` list, potentially
replaceable by a single `EXCLUDE_DIRS: ['src/local']`-shaped rule IF
Phases 3–7 have produced a real `local/` directory by this point. Risk:
this is the FIRST phase that could plausibly involve a real file move —
explicitly sequenced last, matching the task's own required ordering
("only after this point consider physical file movement").

**No single giant refactor commit is proposed anywhere in this plan.**
Each phase above is sized to be its own PR.

## 12. Architecture tests (Part K)

Implemented, not merely designed — `tests/unit/architecture/full-lite-boundary.test.js`
(12 tests, all passing, imports its constants/helpers directly from
`scripts/audit/classify-modules.mjs` rather than duplicating them, per the
same silent-drift lesson §3's revision note describes). All checks use
AST/import-graph analysis (reusing `build-import-graph.mjs`'s `buildGraph()`
and `classify-modules.mjs`'s `computeReachable()`/`collectExternalDeps()`)
over regex, per the task's own explicit preference.

1. **`shared` never imports `local` or `cloud`.** Not yet a standalone
   test (no real `shared/` directory exists yet to assert this against
   directly) — today's equivalent, item #2 below, IS implemented.
2. **`cloud` never imports `local`.** **Implemented** — asserts every
   `CLOUD_ONLY_PATH_PATTERNS` file has zero direct resolved edges into any
   `LOCAL_ONLY_PATH_PATTERNS` file. Current result: 0 violations.
3. **Lite composition never imports local.** **Implemented**, twice —
   once checking zero heavy-package reachability (`onnxruntime-node`/
   `@huggingface/transformers`), once checking zero
   `LOCAL_ONLY_PATH_PATTERNS`-file reachability, both POST-shim (matching
   the real tarball). Reproduced-and-fixed the exact failure mode this
   test exists to catch: injected a new `core/ollama.js` import into
   `hard-pins.js` and confirmed the test fails immediately with the
   specific leaked file named in the assertion message, then confirmed it
   passes clean again after reverting.
4. **Lite tarball contains no local files.** Already existed
   (`clean-install-acceptance.test.js`'s `npm ls --all` check) — no new
   test needed, confirmed still passing. Additionally, this audit's own
   `liteTarballStaged` field (module inventory) is now cross-checked
   file-for-file against the REAL staged tree
   (`packages/lite/src/` after running `build.mjs`) with **0 mismatches
   across all 231 `src/` files** — a full-coverage verification of the
   inventory's own accuracy, not merely a claim.
5. **Lite JS bundle contains no local-only modules/controls.** Already
   exists (`ui-build-dce.test.js`'s marker scan) — no new test needed.
6. **Lite package dependencies contain no heavy local packages.** Already
   exists (same `npm ls --all` check as #4) — no new test needed.
7. **Full build still includes local and cloud.** **Implemented** — two
   tests assert `fullReachable` includes every `LOCAL_ONLY_PATH_PATTERNS`
   file and every `CLOUD_ONLY_PATH_PATTERNS` file, so a future refactor
   that accidentally excludes local/cloud code from FULL (not just Lite)
   is caught too.
8. **Spawn/fork/worker targets belong to the allowed closure.** **Implemented**
   — dedicated regression tests assert `admin/jobs/registry.js`'s spawn
   target resolves to `indexer/index.js` and `core/ce-rerank.js`'s fork
   target resolves to `core/ce-rerank-worker.js` (the exact two shapes §1
   found gaps in), plus a third test asserting every
   `LAZY_SHIM_SUBSTITUTIONS` real/shim pair exists as a real graph node,
   plus a fourth (added during the second review pass) asserting
   `lite-src/doctor-lite.js`'s real imports resolve into `src/`, never the
   gitignored `packages/lite/src/` staging mirror — a regression guard for
   the staging-path-redirect fix in §3's revision note.
9. **Dynamic imports don't bypass the rules.** **Implemented** as an
   exact, two-directional allow-list (§1, finding 6) — replaces an earlier
   `nonLiteralCount <= 3` fuzzy bound. Every actual non-literal reference
   (dynamic `import()`, `require()`, or `fork()`/`spawn()`) in the graph
   must appear in a reviewed allow-list constant; every allow-list entry
   must still correspond to a real reference. Building this exact list
   surfaced a genuine gap in the extractor itself: `core/onnx-runtime.js`'s
   `require(resolveOnnxRuntimeModule(env))` (a non-literal `require()`,
   not a dynamic `import()`) was previously silently DROPPED by the
   extractor entirely — not flagged, not counted, indistinguishable from a
   file with no `require()` call at all. Fixed by extending
   `build-import-graph.mjs`'s `requireCalls` extraction to record
   non-literal calls the same way `dynamicImports` already did, instead of
   only recording literal ones.

## 13. Risks and rejected alternatives

- **A long-lived Lite branch instead of same-repo staging.** Rejected —
  explicitly out of scope per the task's own rules, and the existing
  design doc already rejected this same alternative for the same reason
  (permanent drift risk between two copies of chunking/retrieval/Ask
  logic).
- **npm workspaces, right now, in this pass.** Considered (it IS the
  cleaner long-term shape for a real `shared/cloud/local` directory
  split) but rejected for this audit specifically because the task
  explicitly forbids a "big source refactor" — a workspace migration is
  exactly that scale of change, correctly deferred to a LATER, explicitly
  separate decision, not bundled into this audit's own recommendations.
- **Reifying `EmbeddingProvider`/`RuntimeAvailabilityProbe` as formal
  contract objects right now.** Rejected per §6.1/§6.5's own analysis —
  no second real consumer exists today that would benefit; would be
  "abstraction for symmetry," which the task explicitly warns against.
- **Splitting `definitions.js` physically instead of testing the
  allow-list's completeness.** Considered and NOT rejected outright — see
  §9.2's explicit both-sides analysis; recommended as a real open
  decision for the user, not resolved unilaterally by this audit (§16).
- **Trusting `build.mjs`'s existing closure-validator coverage as
  complete.** Explicitly rejected by this audit's own methodology — the
  validator was independently re-implemented rather than imported and
  trusted, which is exactly what surfaced the two real extraction gaps in
  §1. Recommend the same "re-verify, don't just re-run" discipline for
  any future change to the validator itself.

## 14. Open decisions

1. ~~Should the two closure-validator extraction fixes (§1, Phase 2) be
   ported into `packages/lite/build.mjs`?~~ **Resolved — done.** Ported as
   a separate, isolated commit to `packages/lite/build.mjs` only (Phase 2,
   §11). The port itself surfaced a real third finding (the
   `folder-picker.js`/`powershell.exe` case) requiring one additional
   deliberate design decision beyond the original two fixes — a first
   attempt (a hardcoded `TRUSTED_OS_SPAWN_TARGETS` allow-list) was
   rejected on code review as violating this validator's own no-allow-list
   principle; the shipped fix is `isBareOsCommand()`, a semantic
   classifier matching Node's own PATH-search rule (no `.`/`/`/`\` prefix
   means "OS command," never a name comparison). A second code-review
   round also found and fixed a lexical-scope ordering bug (a parameter
   shadowing a DIRECT, non-aliased `child_process` import was still
   misclassified). Verified against the real packed tarball
   (`clean-install-acceptance.test.js`) and the full `tests/unit/lite/**`
   and `tests/unit/admin/**` suites, plus a dedicated 27-test file
   (`tests/unit/lite/build-closure-validator.test.js`) covering both
   bugs' exact reported shapes as regression tests.
2. Physical `definitions.js` split (§9.2) vs. an allow-list-completeness
   test — which does the user prefer as the Phase 5 approach?
3. Should MCP ever gain a Lite entry point (§6.6)? This is a genuine
   product-scope question, not an architecture question this audit can
   resolve — the architecture work to enable it (routing
   `mcp/tools/collections.js`'s Ollama check through DI, deciding whether
   `ce-rerank.js` ships in Lite's MCP or is excluded) is small either way.
4. Timing and ownership of Phase 6 (Admin UI `entries/`+`partials/{full,lite}/`
   restructure) — real value, moderate effort, not urgent; worth
   sequencing against other product priorities rather than immediately.
5. Should `npm workspaces` be revisited as a SEPARATE, later, explicitly-scoped
   decision once Phases 1–8 land and a real `shared/`/`cloud/`/`local/`
   directory structure exists to migrate?
6. ~~Is `admin/system/folder-picker.js`'s `'powershell.exe'` the only real
   bare-OS-command `spawn()` case in the codebase?~~ **Resolved — checked
   exhaustively, yes.** A full sweep of the entire graph for every `spawn`
   call found exactly **3 in the whole codebase**: `admin/jobs/registry.js`
   → `indexer/index.js` (resolves to a real repo file),
   `core/onnx-provider-probe.js` → `onnx-probe-runner.js` (resolves to a
   real repo file), and `admin/system/folder-picker.js` →
   `'powershell.exe'` (the one genuine OS-command case). Since the shipped
   classifier (`isBareOsCommand()`) is semantic, not a name lookup, this
   sweep was never about completing an allow-list — it confirms there is
   no OTHER bare-command `spawn()` shape in the codebase that the
   classifier's rule might handle unexpectedly; re-run this same sweep
   (`buildGraph()` + filter `forkSpawnCalls` for `callee === 'spawn'`) if
   a new `spawn()` call site is ever added anywhere in `src/`.

## 15. Recommended first implementation task

**Phase 1 exactly as scoped in §11**: land the architecture tests
described in §12 as real `node:test` files under
`tests/unit/architecture/` (or similar), reusing
`scripts/audit/build-import-graph.mjs`'s exported `buildGraph()`/
`extractReferences()` functions directly (not re-implementing AST parsing
a third time) — these tests should all PASS against the codebase exactly
as it exists today, proving the rules they encode are already true, not
aspirational. Immediately followed by Phase 2 (porting the two
closure-validator fixes into the real `build.mjs`), since that fix
directly strengthens the one mechanism every other guarantee in this
document depends on. Both phases are small, low-risk, and require zero
decisions from the open-decisions list above.
