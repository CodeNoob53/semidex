# Phase 8B Step 7A — physical relocation of stable shared core modules

Implementation report for "Phase 8B Step 7A — фізичне перенесення стабільних
shared core-модулів." Corresponds to
[`phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`](phase-8a-shared-cloud-local-migration-audit-2026-08-02.md)
§7's own "Step 6 — Physically relocate stable shared modules" (the plan's
own numbering; this repo's dated reports call it Step 7A, mirroring how
Step 6/cloud-relocation's own report diverges from the plan's "Step 5"
numbering the same way — see that report's own naming note). **Nothing
was committed** — this is the working-tree state at the end of this
round's own session.

## 0. Scope note — narrower than the original plan section

The original plan's Step 6 (§7) scoped "the remaining `src/core/*.js`
top-level files (14) into `src/shared/core/`, plus `src/indexer/`'s 24
remaining shared files, `src/admin/`'s shared files" in one step. The
executing task for this round explicitly scoped Part A/C to **top-level
`src/core/*.js` files only** ("Побудуй список top-level модулів
`src/core/*.js`"), with `src/indexer/` and `src/admin/` both listed under
"Не переносити в цьому завданні." This report covers exactly that
narrower scope; `src/indexer/`'s and `src/admin/`'s own shared files
remain a later step's work, not a gap found during execution.

## 1. Part A — inventory, built from the real import graph, not directory-name assumption

Read `phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`,
`phase-8b-step6-cloud-runtime-relocation-2026-08-06.md`,
`docs/design/artifacts/full-lite-module-inventory.json`, and
`scripts/audit/full-lite-module-classification.json` first, per the
task's own instruction. Regenerated the manifest fresh
(`node scripts/audit/build-shared-cloud-local-manifest.mjs`) before
classifying anything — it produced byte-identical output to the
committed file (confirming the committed baseline was current, not
stale), then used it plus a reverse-dependency (consumer) computation and
direct file inspection (not the manifest's category label alone) to
verify every classification.

`src/core/*.js` (25 top-level files) at the start of this step:

| File | Classification | fullReachable/liteReachable | Action | Reason |
|---|---|---|---|---|
| `app-data-dir.js` | shared | true/true | **move** | Full+Lite reachable, zero dependencies |
| `bench-telemetry.js` | shared | true/true | **move** | Full+Lite reachable, zero dependencies |
| `bge-tokenizer.js` | shared | true/true | **move** | Full+Lite reachable |
| `config.js` | shared | true/true | **move** | Full+Lite reachable (has an `import.meta.url`-relative path constant needing a depth fix — see §3) |
| `doctor-checks.js` | shared | true/true | **move** | Full+Lite reachable, zero dependencies |
| `embeddings.js` | shared | true/true | **move** | Full+Lite reachable |
| `entity-reference.js` | shared | true/true | **move** | Full+Lite reachable, zero dependencies |
| `env-bootstrap.js` | shared | true/true | **move** | Full+Lite reachable, zero dependencies |
| `env.js` | shared | true/true | **move** | Full+Lite reachable, zero dependencies |
| `node-id.js` | shared | true/true | **move** | Full+Lite reachable |
| `onnx-embed-capability.js` | shared | true/true | **move** | Full+Lite reachable, zero dependencies (contract) |
| `onnx-paths.js` | shared | true/true | **move** | Full+Lite reachable (has an `import.meta.url`-relative path constant needing a depth fix — see §3) |
| `point-id.js` | shared | true/true | **move** | Full+Lite reachable, zero dependencies |
| `qdrant.js` | shared | true/true | **move** | Full+Lite reachable (facade re-exporting `core/qdrant/index.js`, which stays put) |
| `rerank-capability.js` | shared (explicit contract override) | true/**false** | **move** | Zero-dependency capability contract, same class as `onnx-embed-capability.js`; its one real consumer (MCP tools) is not currently Lite-reachable, so bare reachability would misclassify it `local` — `build-shared-cloud-local-manifest.mjs`'s own `SHARED_CONTRACT_FILES` override (pre-existing, for `provider.js`/`adapter.js`) already covers this exact pattern |
| `sparse.js` | shared | true/true | **move** | Full+Lite reachable, zero dependencies |
| `token-count.js` | shared | true/true | **move** | Full+Lite reachable |
| `ce-rerank.js` | local | true/false | **keep** | Real cross-encoder reranker implementation, not a contract |
| `ce-rerank-worker.js` | local | true/false | **keep** | Real cross-encoder worker (child-process entry) |
| `rerank.js` | local | true/false | **keep** | Real deterministic reranker implementation |
| `rerank-provider.js` | local | true/false | **keep** | The `RerankCapability` factory — imports `ce-rerank.js`/`rerank.js` directly |
| `ollama-lazy.js` | mixed | true/false | **keep** | Transitional lazy shim — explicitly out of scope (Phase 8B Step 8's own scope) |
| `ollama-lazy.lite.js` | mixed | false/false | **keep** | Transitional lazy shim sibling |
| `onnx-embed-lazy.js` | mixed | true/false | **keep** | Transitional lazy shim |
| `onnx-embed-lazy.lite.js` | mixed | false/false | **keep** | Transitional lazy shim sibling |

**17 files moved. 8 files kept. 0 unclassified.**

Every one of the 17 `move` candidates was cross-checked against its own
direct-dependency list (not just its manifest category label) to confirm
none had a hidden `local`/`cloud` implementation edge: all dependencies
resolved to other `shared`-classified files or pure-data/contract modules
(`embedding-profile/qdrant-cloud-models.js` — pure catalog data, already
established safe for `shared` code in Step 6's own report;
`cloud-embedding-capability.js`/`ollama-capability.js` — contracts, zero
backend imports). Every file was also checked for non-`from`-statement
path references (`import.meta.url`-relative constants, `import()`
dynamic-path JSDoc type references, barrel `export * from`) — see §3 for
the two real findings this surfaced.

## 2. Part B — scope table

| Current path | Classification | Consumers | Action |
|---|---|---|---|
| `src/core/app-data-dir.js` | shared | 1 (`local/core/semidex-home.js`) | move |
| `src/core/bench-telemetry.js` | shared | 3 | move |
| `src/core/bge-tokenizer.js` | shared | 1 (`token-count.js`) | move |
| `src/core/config.js` | shared | 9 | move |
| `src/core/doctor-checks.js` | shared | 19 | move |
| `src/core/embeddings.js` | shared | 10 | move |
| `src/core/entity-reference.js` | shared | 4 | move |
| `src/core/env-bootstrap.js` | shared | 9 | move |
| `src/core/env.js` | shared | 11 | move |
| `src/core/node-id.js` | shared | 5 | move |
| `src/core/onnx-embed-capability.js` | shared | 4 | move |
| `src/core/onnx-paths.js` | shared | 9 | move |
| `src/core/point-id.js` | shared | 6 | move |
| `src/core/qdrant.js` | shared | 17 | move |
| `src/core/rerank-capability.js` | shared (contract override) | 1 (`mcp/tools/search.js`) | move |
| `src/core/sparse.js` | shared | 1 (`embeddings.js`) | move |
| `src/core/token-count.js` | shared | 7 | move |
| `src/core/ce-rerank.js` | local | 4 | **keep** — real local-runtime cross-encoder implementation, `liteReachable: false` |
| `src/core/ce-rerank-worker.js` | local | 1 | **keep** — real cross-encoder worker (child-process entry) |
| `src/core/rerank.js` | local | 2 | **keep** — real deterministic reranker implementation |
| `src/core/rerank-provider.js` | local | 1 | **keep** — factory that directly imports `ce-rerank.js`/`rerank.js` |
| `src/core/ollama-lazy.js` | mixed | 5 | **keep** — transitional lazy shim, explicitly out of scope |
| `src/core/ollama-lazy.lite.js` | mixed | 0 | **keep** — transitional lazy shim sibling |
| `src/core/onnx-embed-lazy.js` | mixed | 3 | **keep** — transitional lazy shim |
| `src/core/onnx-embed-lazy.lite.js` | mixed | 0 | **keep** — transitional lazy shim sibling |

**Files remaining in `src/core/` and why:**

- `ce-rerank.js`, `ce-rerank-worker.js`, `rerank.js`, `rerank-provider.js`
  — real local-runtime implementation code (a genuine cross-encoder
  reranker and its worker/factory), correctly classified `local`
  (`liteReachable: false`) — not a contract, so not eligible for this
  step's "shared or pure contract" scope.
- `ollama-lazy.js`, `ollama-lazy.lite.js`, `onnx-embed-lazy.js`,
  `onnx-embed-lazy.lite.js` — 2 of the 3 remaining transitional lazy-shim
  pairs (the top-level `src/core/*.js` ones; the third,
  `tag-onnx-lazy.js`/`tag-onnx-lazy.lite.js`, lives under
  `src/indexer/phases/`, outside this step's `src/core/*.js` scope
  entirely), explicitly listed in the task's own "не переносити" list
  (Phase 8B Step 8's own scope, once every consumer uses the composition-
  time injection seam Step 1 already introduced).
- Every `src/core/` **subdirectory** (`ask/`, `ask-api/`, `assembly/`,
  `embedding-profile/`, `generation/`, `http/`, `qdrant/`, `retrieval/`,
  `settings/`, `storage/`) — out of scope per the task's own "Побудуй
  список top-level модулів `src/core/*.js`" instruction; a later step's
  work, per §0 above.

## 3. Part C — physical move

Created `src/shared/core/`. Moved all 17 confirmed files via `git mv`,
preserving history — `git mv` itself always writes a delete+add pair to
the working tree; Git's rename DETECTION only surfaces once both sides
are staged together (`git add -A` followed by `git status`/`git diff
--stat`), so the current unstaged `git status` (deletions under
`src/core/`, untracked entries under `src/shared/core/`) is expected, not
evidence against the move — nothing has been committed or staged in this
session, per the task's own "нічого не коміть" instruction.

```
src/core/app-data-dir.js          -> src/shared/core/app-data-dir.js
src/core/bench-telemetry.js       -> src/shared/core/bench-telemetry.js
src/core/bge-tokenizer.js         -> src/shared/core/bge-tokenizer.js
src/core/config.js                -> src/shared/core/config.js
src/core/doctor-checks.js         -> src/shared/core/doctor-checks.js
src/core/embeddings.js            -> src/shared/core/embeddings.js
src/core/entity-reference.js      -> src/shared/core/entity-reference.js
src/core/env-bootstrap.js         -> src/shared/core/env-bootstrap.js
src/core/env.js                   -> src/shared/core/env.js
src/core/node-id.js               -> src/shared/core/node-id.js
src/core/onnx-embed-capability.js -> src/shared/core/onnx-embed-capability.js
src/core/onnx-paths.js            -> src/shared/core/onnx-paths.js
src/core/point-id.js              -> src/shared/core/point-id.js
src/core/qdrant.js                -> src/shared/core/qdrant.js
src/core/rerank-capability.js     -> src/shared/core/rerank-capability.js
src/core/sparse.js                -> src/shared/core/sparse.js
src/core/token-count.js           -> src/shared/core/token-count.js
```

No file was left duplicated between `src/core/` and `src/shared/core/`
(verified in §5's regression test). No backward-compatible re-export was
added at the old path — every real consumer's import specifier was
updated instead (Part D). No exception was needed; there is no external
package-API boundary for these internal modules.

### 3.1 Two real path-depth fixes the move itself surfaced (not a behavior change)

Both `config.js` and `onnx-paths.js` compute a path relative to their own
file location via `import.meta.url` — a genuine architectural risk Part F
warned about, found by direct inspection (not assumed safe from the
manifest category alone):

- **`config.js`**: `CONFIG_PATH` defaulted to
  `resolve(dirname(fileURLToPath(import.meta.url)), '../../config.json')`
  — correct at `src/core/` (2 levels deep), now needs `'../../../config.json'`
  at `src/shared/core/` (3 levels deep). Fixed.
- **`onnx-paths.js`**: `ROOT` defaulted to
  `join(dirname(fileURLToPath(import.meta.url)), '../../')` (the repo
  root, for `ONNX_CACHE_DIR = join(ROOT, 'models')`) — same fix, one
  extra `'../'`.

Both are mechanical depth corrections, not logic changes — confirmed by
a new behavioral test (not just a text check) that `loadConfig()` doesn't
throw and `ONNX_CACHE_DIR` resolves to the real repo-root `models/`
directory (§5).

### 3.2 Two real cross-file reference fixes the move surfaced

- **`config.js`** also imports `./embedding-profile/qdrant-cloud-models.js`
  — a sibling that did NOT move (it lives under `src/core/embedding-profile/`,
  a subdirectory, out of this step's scope). Fixed to
  `../../core/embedding-profile/qdrant-cloud-models.js`.
- **`embeddings.js`** imports 4 siblings that did NOT move
  (`generation/ollama-capability.js`, `embedding-profile/cloud-embedding-capability.js`,
  `embedding-profile/schema.js`, `embedding-profile/qdrant-cloud-models.js`)
  alongside 4 that DID move with it (`onnx-embed-capability.js`,
  `sparse.js`, `env.js`, `bench-telemetry.js`) — fixed the 4 non-moved
  ones to `../../core/...`, left the 4 moved ones as `./...` (still
  correct, since both moved together). Also fixed 2 JSDoc
  `import('./...')` type-reference paths referencing the same 2
  non-moved siblings.
- **`token-count.js`** imports `./embedding-profile/schema.js` (did not
  move) alongside `./bge-tokenizer.js` (moved with it) — same pattern,
  fixed the former, left the latter, plus one JSDoc type-reference path.
- **`qdrant.js`**: `export * from './qdrant/index.js'` — the barrel
  facade's own re-export target (`src/core/qdrant/`, a subdirectory) did
  NOT move. This would have silently broken at runtime (a barrel
  re-exporting from a now-nonexistent sibling directory) had it not been
  caught by direct inspection before running tests — fixed to
  `export * from '../../core/qdrant/index.js'`.

## 4. Part D — import updates

Updated every real reference, verified by direct Grep-tool searches (not
a single regex sweep trusted blind) after each batch, and by a final
repo-wide zero-stale-references check covering both `from '...'` and
`import('...')` forms:

- **80 production consumer files** under `src/` (admin/, core/, cloud/,
  indexer/, local/, mcp/, smoke/, plus `src/doctor.js`/`sync.js`/
  `bootstrap-docs.js`/`backfill-*.js`) — every static `from` import and
  dynamic `await import(...)` specifier recomputed to the correct
  relative depth per consumer directory (a Node script using
  `path.relative()` against each consumer's own directory, not a blind
  string substitution — the exact "перевір кожен клас шляхів" the task
  required).
- **35 test files** under `tests/unit/` — including 4 files using a
  `?query-string` cache-busting dynamic-import trick
  (`await import('.../embeddings.js?onnx-embed-order-check')`), which a
  naive quote-adjacent regex would miss (the closing quote is not
  immediately after `.js`) — found and fixed via a dedicated repo-wide
  scan for exactly that pattern. Also fixed 6 **source-inspection**
  literal-path assertions that read a moved file's own source via
  `readFileSync(new URL('../../../src/core/<file>.js', import.meta.url))`
  or looked up a manifest entry by its old `src/core/<file>.js` path key
  (`lite-lazy-shim-necessity.test.js`, `phase-8b-step6-cloud-relocation.test.js`,
  `shared-cloud-local-manifest.test.js`, `onnx-process-isolation.test.js`,
  `bge-tokenizer-parity.test.js`, `onnx-embed-capability.test.js`,
  `onnx-paths.test.js`, `lazy-shim-backward-compat.test.js`,
  `embedding-profile-wiring.test.js`, `server-capability-wiring.test.js`,
  `phase-8b-step3-ollama-relocation.test.js`) — these are exactly the
  "literal paths, які аналізують architecture tests" the task's Part D
  called out by name; a plain import-specifier fix would have left every
  one of them silently broken (`existsSync` returning false,
  `graph.nodes[path]` returning `undefined`, or a `String.indexOf(...)`
  returning `-1` and corrupting a downstream `slice()`).
- **47 files under `benchmarks/`** — real `import ... from '../../src/core/...'`
  references (not the hundreds of false-positive substring matches in
  `.md`/`.txt` result files, which were excluded by requiring an actual
  `from`/`import(` statement match). Includes 4 files using the
  `import(` dynamic form specifically (`structural-carryover-bench.js`,
  `custom-raw/smoke-live-{source-filter,answer-policy}.js`,
  `custom-50/smoke-live-window.js`) and one file (`lib/resolve-profile.js`)
  initially missed by an incomplete manual file-list transcription — found
  by the same final repo-wide zero-stale-references check, not left as a
  silent gap.
- **4 files under `packages/lite/lite-src/`** (real, git-tracked source —
  not the gitignored `packages/lite/src/` build output, which
  regenerates automatically from `node packages/lite/build.mjs` and
  needed no manual edit): `serve-lite.js`, `semidex-home.js`,
  `index-lite.js`, `doctor-lite.js`.
- **`packages/lite/build.mjs`** — confirmed to need **zero** changes:
  it stages `src/` by directory walk with an exclude-list
  (`EXCLUDE_DIRS`/`EXCLUDE_FILES`), never an include-list keyed to
  specific paths, so a file moving from one non-excluded directory to
  another non-excluded directory (`src/core/` → `src/shared/core/`,
  neither ever excluded) requires no staging-rule change at all — the
  same conclusion Step 6's own cloud-relocation report reached for the
  identical reason.
- **`scripts/audit/build-shared-cloud-local-manifest.mjs`**'s own
  `SHARED_CONTRACT_FILES` allow-list — this genuinely needed updating: it
  hardcoded `'src/core/rerank-capability.js'`, which no longer matched
  after the move, silently falling through to bare-reachability
  classification (`local`, since MCP tools aren't Lite-reachable) instead
  of the intended `shared` override. Found by re-running the manifest
  builder immediately after the move and noticing the category count
  drift (`shared: 142` instead of the pre-move `144`) rather than
  assuming the move alone couldn't affect classification — fixed to
  `'src/shared/core/rerank-capability.js'`; category counts returned to
  exactly the pre-move baseline (`shared: 144, local: 27, composition:
  12, mixed: 9, tooling: 61, cloud: 8`) after the fix.
- Generated JSON artifacts (`docs/design/artifacts/full-lite-import-graph.json`,
  `full-lite-module-inventory.json`, `full-lite-reachability-summary.json`)
  — regenerated via `node scripts/audit/build-import-graph.mjs` and
  `node scripts/audit/classify-modules.mjs`, never hand-edited.
- `scripts/audit/classify-modules.mjs` itself — inspected for hardcoded
  `src/core/<moved-file>.js` path patterns (`LOCAL_ONLY_PATH_PATTERNS`,
  `CLOUD_ONLY_PATH_PATTERNS`, `COMPOSITION_FULL_PATTERNS`, `FULL_ROOTS`)
  — confirmed none reference any of the 17 moved files; no change needed.
- `docs/en/project-structure.md` and
  `docs/design/semidex-lite-package-boundary.md` — updated (Part G,
  §6 below).

## 5. Part E — architecture regression test

New: `tests/unit/architecture/phase-8b-step7a-shared-core-relocation.test.js`
(58 tests, 7 `describe` blocks), following the same proven pattern as
`phase-8b-step2-local-relocation.test.js` and
`phase-8b-step6-cloud-relocation.test.js`:

- **Physical presence/absence**: each of the 17 moved files' old path
  (`existsSync` false) and new path (`existsSync` true); the 4 `local`
  files and 4 lazy-shim files confirmed to have stayed at `src/core/`
  with no duplicate created under `src/shared/core/`.
- **No stale old-path references anywhere**: a real path-resolution walk
  (via `path.resolve()` against each importing file's own directory,
  comparing the ABSOLUTE result against the deleted old path — not a
  text/segment heuristic, since a same-directory relative import like
  `'./embeddings.js'` has no `"core/"` segment in its specifier text at
  all) across `src/`, `benchmarks/`, `scripts/`, and
  `packages/lite/lite-src/`, strips a `?query-string` cache-busting
  suffix before resolving. Includes a self-test proving the detector
  itself would catch a synthetic reverted specifier, not just pass
  trivially on a clean tree.
- **`shared -> local`/`shared -> cloud` still zero**: both a direct
  file-content walk of `src/shared/core/` itself, and a general
  manifest-based graph check (every `declaredCategory: 'shared'` module,
  not just the 17 moved ones) — proving the move didn't introduce a new
  boundary violation anywhere, not just within the moved files.
- **Zero unclassified modules** anywhere in the manifest after the move.
- **Full and Lite composition roots both resolve the new paths at
  runtime, not just at the text level**: `createApp()` then
  `createLiteApp()`, and the reverse order, repeated, in one process,
  never throws a module-resolution error.
- **Lite tarball staging**: all 17 moved files staged at their new
  `shared/core/` path, none staged at the old `core/` path, zero new
  `local/` files introduced, and the 4 `local`-classified files that
  stayed at `src/core/` create no `shared/core/` duplicate (not asserting
  they're absent from Lite altogether — `core/rerank.js` itself
  genuinely does ship, pre-existing, documented in Phase 8A §3.3 as
  harmless unreachable dead weight; unrelated to and unaffected by this
  move).
- **The `import.meta.url` depth fix is real, not just text-correct**:
  `loadConfig()` doesn't throw against the real repo-root `config.json`;
  `ONNX_CACHE_DIR` resolves to the real repo-root `models/` directory
  (path identity, not just non-throwing); `qdrant.js`'s facade re-export
  still exposes `scroll()` from the unmoved `core/qdrant/index.js`.

Verified genuinely load-bearing: reverted `server-full.js`'s
`embeddings.js` import back to the old path and confirmed 3 specific
tests failed with the exact expected assertions (the stale-path scan, the
direct file-content check, and the runtime construction check) — restored
the fix, re-ran, all 58 pass.

## 6. Part G — audit and documentation updates

- **`scripts/audit/full-lite-module-classification.json`** — regenerated,
  committed-diff-ready (category counts unchanged from pre-move
  baseline).
- **`docs/design/artifacts/full-lite-import-graph.json`**,
  **`full-lite-module-inventory.json`**, **`full-lite-reachability-summary.json`**
  — regenerated via the audit scripts.
- **`docs/en/project-structure.md`** — Core Modules section split into
  `src/shared/core/` (the 17 moved files, with a short explanation of the
  split) and `src/core/` (the subdirectories plus the 4 files that stayed
  top-level); the "MCP/indexer/admin all use shared modules under
  `src/core/`" sentence and the `src/cloud/` section's own consumer list
  updated to the new paths.
- **`docs/design/semidex-lite-package-boundary.md`** — the
  `@huggingface/tokenizers` consumer list and the `SEMIDEX_HOME` env-var
  table updated to the new paths; a new **Phase 8B Step 7A update** note
  added after the existing Step 6 entry (mirroring that entry's own
  format), pointing to this report — the Step 6 entry's own historical
  prose is left unedited (an accurate record of what Step 6 did, at the
  paths that existed then), not retroactively renamed.
- **`phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`** — its
  own §7 Step 6 entry given an "IMPLEMENTED" status header (matching
  Steps 1–4's own convention) plus an "As implemented" note explaining
  the narrower actual scope (§0 above) and verification results.
- This report: `docs/design/phase-8b-step7a-shared-core-relocation-2026-08-07.md`.

## 7. Unexpected findings

1. **`qdrant.js`'s barrel re-export** (§3.2) — would have silently broken
   at runtime (import resolution failure) had it not been caught before
   running tests. Found by direct inspection, not a test failure.
2. **`SHARED_CONTRACT_FILES`'s hardcoded old path** (§4) — a real,
   silent classification regression (`rerank-capability.js` would have
   quietly become `local` instead of `shared`) caught only by noticing a
   category-count drift after regenerating the manifest, not by any
   automated check that existed before this step (the drift-detection
   test, `shared-cloud-local-manifest.test.js`, checks the manifest is
   internally self-consistent and byte-identical to a fresh
   regeneration — it does NOT independently assert what each category
   count *should* be, so it would not have caught this on its own; the
   new Step 7A test's "the 17 moved files are genuinely declared shared"
   assertion now pins this specific file by name going forward).
3. **`benchmarks/lib/resolve-profile.js`** (§4) — missed on the first
   pass due to an incomplete manual transcription of Grep-tool results
   into a file list; found only by a final, independent, per-base
   Grep-tool verification pass across the whole repo rather than trusting
   the first pass's file count. This is the reason the final verification
   step (§8) treats "zero remaining references" as something to
   re-confirm with a fresh, independent search rather than declare
   complete based on a fixed file list.
4. No `src/indexer/`/`src/admin/` file needed a change beyond its own
   import-path update to the 17 moved files — none of them had a hidden
   dependency on the OLD `src/core/` location beyond that import
   specifier itself (i.e., no relative-sibling reference, no
   `import.meta.url`-relative path assumption).

## 8. Verification results

| Check | Result |
|---|---|
| `node scripts/audit/find-dependency-violations.mjs` | 0 dependency-direction violations, 0 shared→cloud edges |
| `node scripts/audit/build-shared-cloud-local-manifest.mjs` | 261 modules classified; shared 144, local 27, composition 12, mixed 9, tooling 61, cloud 8 — identical to the pre-move baseline |
| `node scripts/audit/classify-modules.mjs` | 0 cloud-imports-local violations; 0 heavy local packages reachable from Lite (pre- and post-shim); Lite-reachable 148 (unchanged) |
| `node --test --test-concurrency=1` on the new/changed architecture tests | 58/58 pass (new file); 194/194 pass (full `tests/unit/architecture/` directory) |
| `npm test` | 3187/3187 pass (was 3129 before this step; +58 from the new test file) |
| `npm run smoke` | 1316/1316 pass |
| `npm run admin:build` | succeeds, byte-identical output hashes to the pre-move build |
| `npm run admin:build:lite` | succeeds, byte-identical output hashes to the pre-move build |
| `node packages/lite/build.mjs` | 123 files staged, closure validator clean (unchanged from the pre-move baseline) |
| Lite clean-install acceptance (`tests/unit/lite/clean-install-acceptance.test.js`) | 6/6 pass — real `npm pack`, fresh install into an empty dir, read-only package dir; `doctor`/`serve` both run correctly against the real installed tarball; "no relative import escapes the package root" check passes against the real installed files, including all 17 moved files at their new `shared/core/` path |
| `git diff --check` | clean (only pre-existing CRLF line-ending warnings, zero real whitespace/conflict errors) |
| Reverted-fix regression check | confirmed the new architecture test genuinely fails (3 specific assertions) when a single import is reverted to its old path; passes again once restored |

## 9. Known limitations / deferred work

- `src/indexer/`'s 24 remaining shared files and `src/admin/`'s shared
  files (register-neutral-routes.js, router.js, server.js, static.js,
  api/*.js, jobs/, etc.) were explicitly out of scope for this step (§0)
  — a later step's own work.
- `src/core/`'s subdirectories (`ask/`, `ask-api/`, `assembly/`,
  `embedding-profile/`, `generation/`, `http/`, `qdrant/`, `retrieval/`,
  `settings/`, `storage/`) were out of scope — top-level files only, per
  the task's own instruction.
- The 2 remaining `*-lazy.js`/`*-lazy.lite.js` transitional shim pairs at
  top-level `src/core/*.js` (4 files: `ollama-lazy.js`/`.lite.js`,
  `onnx-embed-lazy.js`/`.lite.js`) and the 4 real `local`-classified
  files at top-level `src/core/` (`ce-rerank.js`, `ce-rerank-worker.js`,
  `rerank.js`, `rerank-provider.js`) were confirmed correctly excluded
  from this step's scope, not silently skipped.
- `core/rerank.js` itself ships in the Lite tarball today despite being
  `local`-classified and never invoked by Lite's own request path — a
  pre-existing, documented gap (Phase 8A §3.3), unrelated to and
  unaffected by this step; a future step could add it to
  `build.mjs`'s `EXCLUDE_FILES` if closing that gap is ever prioritized.

## Next step

**Shared indexer relocation** — `src/indexer/`'s 24 remaining shared
files, deferred from this step's own original (broader) scope per §0.

## Verdict

**PHASE_8B_STEP7A_ACCEPT**
