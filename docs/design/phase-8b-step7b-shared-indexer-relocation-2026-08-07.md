# Phase 8B Step 7B — physical relocation of shared indexer modules

Implementation report for "Phase 8B Step 7B — фізичне перенесення
shared-модулів індексатора." Corresponds to the deferred part of
[`phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`](phase-8a-shared-cloud-local-migration-audit-2026-08-02.md)
§7 Step 6 ("plus `src/indexer/`'s 24 remaining shared files"), which
[`phase-8b-step7a-shared-core-relocation-2026-08-07.md`](phase-8b-step7a-shared-core-relocation-2026-08-07.md)
explicitly narrowed to top-level `src/core/*.js` only and deferred to a
later step (see that report's own §0). **Nothing was committed** — this
is the working-tree state at the end of this round's own session.

## 1. Part A — inventory, built from the real import graph, not the inherited "24" figure

Read `phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`,
`phase-8b-step7a-shared-core-relocation-2026-08-07.md`,
`docs/design/artifacts/full-lite-module-inventory.json`, and
`scripts/audit/full-lite-module-classification.json` first, per the
task's own instruction — and explicitly did NOT trust the earlier "24"
count from Phase 8A §5's own per-directory disposition table (which
predates several later changes: `tag-onnx.js`/`tag-onnx-worker.js`
physically moving to `src/local/indexer/` in Step 4, `entity-split.js`
being added). Regenerated the manifest fresh
(`node scripts/audit/build-shared-cloud-local-manifest.mjs`) and the
import graph (`node scripts/audit/build-import-graph.mjs`) before
classifying anything, then cross-checked every file's own direct-
dependency list (not just its manifest category label) and, for
`index-runtime.js`/`run.js` specifically, read their full source — the
task's own explicit instruction not to classify these two by name alone.

Every top-level `src/indexer/*.js` and `src/indexer/phases/*.js` file at
the start of this step (`src/indexer/workers/` does not exist — the
`tag-onnx-worker.js` this task's own "not to move" list names already
lives at `src/local/indexer/workers/`, relocated in an earlier step):

| File | Category | Full R | Lite R | Deps | Action | Reason |
|---|---|---|---|---|---|---|
| `batch.js` | shared | true | true | 0 | **move** | zero-dep pure helper |
| `files.js` | shared | true | true | 0 | **move** | zero-dep pure helper |
| `index-full.js` | composition | true | false | 8 | **keep composition** | Full entry point, builds real capabilities |
| `index-lite.js` | composition | false | true | 2 | **keep composition** | Lite entry point |
| `index-runtime.js` | shared | true | true | 3 | **move** | read in full: edition-neutral orchestration, capability param, no branching |
| `index.js` | local (declared)/mixed (propagated) | true | false | 1 | **keep composition** | Full-only backward-compat CLI launcher alias, not shared orchestration |
| `preflight.js` | shared | true | true | 1 | **move** | capability-injected, no direct local import |
| `profiler.js` | shared | true | true | 0 | **move** | zero-dep |
| `progress-event.js` | shared | true | true | 0 | **move** | zero-dep |
| `run.js` | shared | true | true | 34 | **move** | read in full: every dependency resolves to a contract, pure data, or already-shared module — zero local/cloud implementation edges |
| `semaphore.js` | shared | true | true | 0 | **move** | zero-dep |
| `serial-queue.js` | shared | true | true | 0 | **move** | zero-dep |
| `skeleton-payload.js` | shared | true | true | 1 | **move** | pure |
| `skeleton-warnings.js` | shared | true | true | 0 | **move** | has an `import.meta.url`-relative path (needs depth fix) |
| `phases/chunk.js` | shared | true | true | 7 | **move** | capability-injected token counter, no local edge |
| `phases/combined.js` | shared | true | true | 3 | **move** | capability-injected |
| `phases/context.js` | shared | true | true | 2 | **move** | capability-injected |
| `phases/empty-section.js` | shared | true | true | 0 | **move** | pure |
| `phases/entity-split.js` | shared | true | true | 1 | **move** | pure |
| `phases/node-policy.js` | shared | true | true | 2 | **move** | pure |
| `phases/skeleton-chunk.js` | shared | true | true | 5 | **move** | pure |
| `phases/skeleton-index.js` | shared | true | true | 2 | **move** | has an `import.meta.url`-relative path (needs depth fix) |
| `phases/skeleton-summary.js` | shared | true | true | 0 | **move** | capability-injected |
| `phases/skeleton.js` | shared | true | true | 0 | **move** | pure |
| `phases/tag-onnx-capability.js` | shared | true | true | 0 | **move** | zero-dep contract |
| `phases/tag-onnx-lazy.js` | mixed | true | false | 2 | **keep transitional** | lazy shim, explicit no-move list |
| `phases/tag-onnx-lazy.lite.js` | mixed | false | false | 1 | **keep transitional** | lazy shim sibling |
| `phases/tag-provider.js` | shared | true | true | 0 | **move** | zero-dep pure predicate |
| `phases/tag.js` | shared | true | true | 1 | **move** | capability-injected |
| `phases/token-budget-split.js` | shared | true | true | 0 | **move** | pure |

**24 move, 3 keep composition, 2 keep transitional, 0 unclassified.**
(29 files total under `src/indexer/`+`src/indexer/phases/` at the start
of this step — 24 moved, 5 kept.)

Every one of the 24 `move` candidates was cross-checked against its own
direct-dependency list to confirm none had a hidden `local`/`cloud`
implementation edge, never branched on edition (`SEMIDEX_LITE`/`IS_LITE`
— zero hits), and never contained a literal reference to
`onnxruntime-node`, `@huggingface/transformers`, or `ollama.js`. `run.js`
(34 dependencies — the largest file in the whole move) was read in full,
not sampled: every dependency resolves to either a capability contract
(`ollama-capability.js`, `tag-onnx-capability.js`,
`cloud-embedding-capability.js`), pure catalog data
(`qdrant-cloud-models.js`), or another already-`shared` module. Every
file was also checked for non-`from`-statement path references
(`import.meta.url`-relative constants, `fork()`/`spawn()`/`WORKER_PATH`
targets) — see §3 for the two real findings this surfaced (neither file
has a `fork()`/worker target of its own; that machinery lives in
`tag-onnx.js`, which was never in scope for this step).

## 2. Part B — scope table

| Current path | Classification | Consumers (rough) | Action |
|---|---|---|---|
| `src/indexer/batch.js` | shared | 1 (`run.js`) | move |
| `src/indexer/files.js` | shared | 2 | move |
| `src/indexer/index-runtime.js` | shared | 2 (`index-full.js`, `index-lite.js`) | move |
| `src/indexer/preflight.js` | shared | 2 | move |
| `src/indexer/profiler.js` | shared | 1 | move |
| `src/indexer/progress-event.js` | shared | 2 | move |
| `src/indexer/run.js` | shared | many (indexer CLI, benchmarks, smoke) | move |
| `src/indexer/semaphore.js` | shared | 1 | move |
| `src/indexer/serial-queue.js` | shared | 1 | move |
| `src/indexer/skeleton-payload.js` | shared | 5+ | move |
| `src/indexer/skeleton-warnings.js` | shared | 1 | move |
| `src/indexer/phases/chunk.js` | shared | many | move |
| `src/indexer/phases/combined.js` | shared | 2 | move |
| `src/indexer/phases/context.js` | shared | 2 | move |
| `src/indexer/phases/empty-section.js` | shared | 1 | move |
| `src/indexer/phases/entity-split.js` | shared | 2 | move |
| `src/indexer/phases/node-policy.js` | shared | 2 | move |
| `src/indexer/phases/skeleton-chunk.js` | shared | many | move |
| `src/indexer/phases/skeleton-index.js` | shared | many | move |
| `src/indexer/phases/skeleton-summary.js` | shared | 2 | move |
| `src/indexer/phases/skeleton.js` | shared | many | move |
| `src/indexer/phases/tag-onnx-capability.js` | shared | 2 | move |
| `src/indexer/phases/tag-provider.js` | shared | 3 | move |
| `src/indexer/phases/tag.js` | shared | 2 | move |
| `src/indexer/phases/token-budget-split.js` | shared | 2 | move |
| `src/indexer/index.js` | local/mixed | 1 | **keep composition** — Full-only backward-compat CLI launcher alias, a process entry point (not shared orchestration) |
| `src/indexer/index-full.js` | composition | 2 | **keep composition** — Full's own real-capability-building entry point |
| `src/indexer/index-lite.js` | composition | 1 | **keep composition** — Lite's own typed-unavailable-stub entry point |
| `src/indexer/phases/tag-onnx-lazy.js` | mixed | 1 | **keep transitional** — lazy shim, Phase 8B Step 8's own scope |
| `src/indexer/phases/tag-onnx-lazy.lite.js` | mixed | 0 | **keep transitional** — lazy shim sibling |

**Files remaining in `src/indexer/` and why:**

- `index.js` — a real process entry point (a direct `node
  src/indexer/index.js <path>` invocation), not shared orchestration — it
  carries no capability-building imports of its own but exists solely to
  delegate to `index-full.js`'s `isIndexerMainModule()` guard via an
  alias URL. Composition-adjacent, not a candidate for this step's
  "shared or pure contract" scope.
- `index-full.js`, `index-lite.js` — the two edition-specific composition
  roots. Neither is reachable from the other edition's roots (confirmed:
  `index-full.js` is Full-only/`liteReachable: false`, `index-lite.js` is
  Lite-only/`fullReachable: false`) — by definition not shared.
- `phases/tag-onnx-lazy.js`, `phases/tag-onnx-lazy.lite.js` — the one
  remaining transitional lazy-shim pair still physically inside
  `src/indexer/phases/`, explicitly listed in the task's own "не
  переносити" list (Phase 8B Step 8's own scope, once every consumer uses
  the composition-time injection seam Step 1 already introduced).

`src/local/indexer/phases/tag-onnx.js` and
`src/local/indexer/workers/tag-onnx-worker.js` were NOT touched by this
step — both already physically relocated to `src/local/indexer/` in an
earlier step (Phase 8B Step 4), before this task began.

## 3. Part C — physical move

Created `src/shared/indexer/` and `src/shared/indexer/phases/`. Moved all
24 confirmed files via `git mv` (history preserved, confirmed by `git
status` reporting each as a rename), preserving the existing `phases/`
subdirectory structure:

```
src/indexer/batch.js                     -> src/shared/indexer/batch.js
src/indexer/files.js                     -> src/shared/indexer/files.js
src/indexer/index-runtime.js             -> src/shared/indexer/index-runtime.js
src/indexer/preflight.js                 -> src/shared/indexer/preflight.js
src/indexer/profiler.js                  -> src/shared/indexer/profiler.js
src/indexer/progress-event.js            -> src/shared/indexer/progress-event.js
src/indexer/run.js                       -> src/shared/indexer/run.js
src/indexer/semaphore.js                 -> src/shared/indexer/semaphore.js
src/indexer/serial-queue.js              -> src/shared/indexer/serial-queue.js
src/indexer/skeleton-payload.js          -> src/shared/indexer/skeleton-payload.js
src/indexer/skeleton-warnings.js         -> src/shared/indexer/skeleton-warnings.js
src/indexer/phases/chunk.js              -> src/shared/indexer/phases/chunk.js
src/indexer/phases/combined.js           -> src/shared/indexer/phases/combined.js
src/indexer/phases/context.js            -> src/shared/indexer/phases/context.js
src/indexer/phases/empty-section.js      -> src/shared/indexer/phases/empty-section.js
src/indexer/phases/entity-split.js       -> src/shared/indexer/phases/entity-split.js
src/indexer/phases/node-policy.js        -> src/shared/indexer/phases/node-policy.js
src/indexer/phases/skeleton-chunk.js     -> src/shared/indexer/phases/skeleton-chunk.js
src/indexer/phases/skeleton-index.js     -> src/shared/indexer/phases/skeleton-index.js
src/indexer/phases/skeleton-summary.js   -> src/shared/indexer/phases/skeleton-summary.js
src/indexer/phases/skeleton.js           -> src/shared/indexer/phases/skeleton.js
src/indexer/phases/tag-onnx-capability.js -> src/shared/indexer/phases/tag-onnx-capability.js
src/indexer/phases/tag-provider.js       -> src/shared/indexer/phases/tag-provider.js
src/indexer/phases/tag.js                -> src/shared/indexer/phases/tag.js
src/indexer/phases/token-budget-split.js -> src/shared/indexer/phases/token-budget-split.js
```

No file was left duplicated between `src/indexer/` and
`src/shared/indexer/`. No backward-compatible re-export was added at the
old path — every real consumer's import specifier was updated instead
(Part D). No export signature changed; no indexing/batching/chunking/
tagging/progress-event behavior changed.

### 3.1 Two real path-depth fixes the move itself surfaced (not a behavior change)

Both `skeleton-warnings.js` and `phases/skeleton-index.js` compute a path
relative to their own file location via `import.meta.url`, for the
`.tmp/semidex-inspect/` inspect-artifact directory — found by direct
inspection, not assumed safe from the manifest category alone:

- **`skeleton-warnings.js`**: `ROOT` defaulted to
  `resolve(dirname(fileURLToPath(import.meta.url)), '../../')` — correct
  at `src/indexer/` (2 levels deep), now needs `'../../../'` at
  `src/shared/indexer/` (3 levels deep). Fixed.
- **`phases/skeleton-index.js`**: `ROOT` defaulted to
  `resolve(dirname(fileURLToPath(import.meta.url)), '../../../')` —
  correct at `src/indexer/phases/` (3 levels deep), now needs
  `'../../../../'` at `src/shared/indexer/phases/` (4 levels deep).
  Fixed.

Both are mechanical depth corrections, not logic changes — confirmed by
a new behavioral test (not just a text check): `warningsPathFor()` is
called and its result checked to start with the real repo-root
`.tmp/semidex-inspect/` prefix; `buildFileSkeleton()` is called and its
output checked to contain real nav points, proving its own relative
imports of `node-id.js`/`node-policy.js` (not just the `ROOT` constant)
resolved correctly too (§5).

### 3.2 Cross-file reference fixes the move surfaced

`run.js` (34 dependencies) mixes files that moved WITH it (siblings,
kept as `./...`) and files that stayed at `src/core/` (a subdirectory,
out of scope — `embedding-profile/`, `generation/`, `settings/`,
`storage/`). Every occurrence of the two prior patterns
(`../shared/core/...`, correct from `src/indexer/`; `../core/...`,
correct from `src/indexer/` to `src/core/`) was recomputed from the new
location (`src/shared/indexer/`): `../shared/core/...` → `../core/...`
(now a sibling directory under `src/shared/`); `../core/...` →
`../../core/...` (now one level deeper). The same two-pattern fix
applied to `preflight.js` (1 occurrence) and `phases/{combined,context,
tag}.js` (1 occurrence each, `ollama-capability.js`). JSDoc
`import('...')` type-reference paths in `run.js`/`preflight.js` needed
the identical fix — found and corrected in the same pass, not treated as
lower-priority than the executable imports.

`index-runtime.js` needed the same two-pattern fix for its own two
dynamic imports (`env-bootstrap.js`, `settings/service.js`) — **missed
in the first pass** (caught only when `tests/unit/admin/jobs/
spawn-indexer-lite.test.js` and `tests/unit/core/backfill-entity-refs.test.js`
actually executed `runIndexerCli()`/`run.js`'s real code path and hit a
real `ERR_MODULE_NOT_FOUND` for `src/shared/shared/core/env-bootstrap.js`
— a doubled `shared/shared/` path from blindly reusing the pre-move
`'../shared/core/...'` specifier one directory too shallow). This is the
single most important finding of this step: **static-import correctness
(`node --check`, `node scripts/audit/build-import-graph.mjs`, and even a
bare `import()` of the file) does not catch a broken path inside a
function body that only executes at runtime** — only actually calling
`runIndexerCli()` end-to-end (§5's own behavioral test) surfaced it.

## 4. Part D — import updates

Updated every real reference, verified by direct Grep-tool searches
after each batch, and by a final repo-wide zero-stale-references check
(a dedicated Node script reading every `.js`/`.mjs` file's raw text —
not relying on `grep`/ripgrep alone, since at least one file
(`src/smoke/sections/47-skeleton-nav.js`) was silently skipped by a
text-search tool's binary-content heuristic despite being valid UTF-8
source, a second confirmed gap-class this step's final verification
had to specifically guard against):

- **~90 production consumer files** under `src/` (admin/jobs/registry.js,
  backfill-entity-refs.js, backfill-tags.js, smoke/sections/*.js, plus
  the 24 moved files' own internal cross-references) — every static
  `from` import and dynamic `await import(...)` specifier recomputed to
  the correct relative depth per consumer directory.
- **~35 test files** under `tests/unit/` — including the same
  `?query-string`/template-literal cache-busting dynamic-import pattern
  Step 7A's own report flagged (`import(\`.../run.js?concurrency-test-${Date.now()}\`)`
  in `phase-capability-injection.test.js` — a template literal, not a
  plain string, so the query-string regex needed to also match backtick-
  delimited specifiers), and 9 source-inspection literal-path assertions
  (`readFileSync(new URL(...))`, `graph.nodes[oldPath]`/manifest
  `byPath.get(oldPath)` lookups, `String.indexOf('../core/...')`-based
  slicing) across `lite-lazy-shim-necessity.test.js`,
  `phase-8b-step6-cloud-relocation.test.js`,
  `shared-cloud-local-manifest.test.js`, `lazy-shim-backward-compat.test.js`,
  `chunk-pandoc-windows-hide.test.js`, `embedding-profile-wiring.test.js`,
  `index-capability-wiring.test.js`, `ollama.test.js`,
  `tag-onnx-capability.test.js`, `tag-onnx-lazy.test.js`.
- **~50 files under `benchmarks/`** (retrieval scripts + one
  `external/production-path/` fixture file) — real
  `import ... from '../../src/indexer/...'` references, plus 3 files
  where the old path appeared only inside a generated-markdown-report
  string literal (`lines.push('- \`src/indexer/phases/tag.js\` — ...')`)
  rather than a real import — fixed for documentation accuracy even
  though they have zero functional impact.
- **~27 files under `src/smoke/sections/`** — real
  `await import('../../indexer/...')` references, all fixed to
  `'../../shared/indexer/...'`.
- **2 files at `src/` root** (`backfill-entity-refs.js`,
  `backfill-tags.js`) — real `import ... from './indexer/...'`
  references (bare `./`, no `../` prefix, since both live directly under
  `src/`) — a distinct specifier SHAPE from every other consumer's
  `../indexer/...`/`../../indexer/...`, and the exact shape a
  path-suffix-only search can miss if it assumes a `../` prefix; both
  found only by an explicit top-level-`src/*.js`-file-by-file check, not
  the directory-scoped batch search.
- **2 non-moved files with a real cross-reference into the moved set**:
  `src/local/indexer/phases/tag-onnx.js` (imports `tag-provider.js`,
  which moved — a `local -> shared` edge, the normal allowed direction)
  and `src/indexer/phases/tag-onnx-lazy.js`/`.lite.js` (re-export
  `isOnnxTagProvider` from `tag-provider.js` too).
- **`packages/lite/lite-src/`** — checked, zero real references (only a
  prose comment mentioning `indexer/index-lite.js`, which never moved).
- **`packages/lite/build.mjs`** — confirmed to need **zero** changes,
  same reasoning as Step 7A: directory-walk exclude-list staging, and
  `src/shared/` is never excluded. Its `EXCLUDE_FILES` list
  (`'indexer/phases/tag-onnx-lazy.js'`, `'indexer/phases/tag-onnx-lazy.lite.js'`,
  `'indexer/index.js'`, `'indexer/index-full.js'`,
  `'admin/jobs/spawn-indexer-full.js'`) names only files that stayed at
  `src/indexer/` — none needed updating.
- **`scripts/audit/classify-modules.mjs`** — inspected `FULL_ROOTS`,
  `LOCAL_ONLY_PATH_PATTERNS`, `COMPOSITION_FULL_PATTERNS` for hardcoded
  paths to any of the 24 moved files; confirmed none exist (the file's
  own hardcoded indexer references — `'src/indexer/index.js'`,
  `'src/indexer/index-full.js'` in `FULL_ROOTS` — name files that never
  moved).
- **`scripts/audit/build-shared-cloud-local-manifest.mjs`** — checked its
  `SHARED_CONTRACT_FILES`/`COMPOSITION_COMMON_FILES` override lists
  (the exact mechanism Step 7A's own report found a stale-path bug in,
  for `rerank-capability.js`) — neither list references any indexer file
  at all, so no update was needed here this time.
- Generated JSON artifacts (`docs/design/artifacts/full-lite-import-graph.json`,
  `full-lite-module-inventory.json`, `full-lite-reachability-summary.json`)
  — regenerated via the audit scripts, never hand-edited.
- `docs/en/project-structure.md` and
  `docs/design/semidex-lite-package-boundary.md` — updated (Part F,
  §7 below).

## 5. Part E — architecture regression test

New: `tests/unit/architecture/phase-8b-step7b-shared-indexer-relocation.test.js`
(77 tests, 8 `describe` blocks), extending the proven Step 7A/Step 6
pattern with the additional guarantees this task's own Part E requires
that neither prior step needed:

- **Physical presence/absence**: each of the 24 moved files' old path
  (gone) and new path (exists); the 3 composition/entry files and 2
  lazy-shim files confirmed to have stayed at `src/indexer/` with no
  duplicate under `src/shared/indexer/`; confirms
  `src/local/indexer/phases/tag-onnx.js`/`workers/tag-onnx-worker.js`
  untouched (already relocated by an earlier step).
- **No stale old-path references anywhere**: the same real path-
  resolution walk as Step 7A (absolute-path comparison against each
  importing file's own directory, `?query-string` suffix stripped)
  across `src/`, `benchmarks/`, `scripts/`, and
  `packages/lite/lite-src/`. Includes the same synthetic-reverted-
  specifier self-test proving the detector itself is load-bearing.
- **`shared -> local`/`shared -> cloud` still zero**: a direct file-
  content walk of `src/shared/indexer/` itself (both for
  local/cloud-directory import edges AND for any literal
  `onnxruntime-node`/`@huggingface/transformers`/`ollama.js` reference —
  the "shared indexer must not import concrete ONNX/Ollama/Transformers
  runtime" guarantee this task's own Part E names explicitly, which
  Step 7A's core-module move had no equivalent risk surface for), plus
  the general manifest-based graph check across every `shared`-declared
  module.
- **Zero unclassified modules** anywhere in the manifest after the move.
- **Full and Lite entry points genuinely construct at runtime, not just
  resolve at the text level** — three escalating checks: (1) both
  `index-full.js`/`index-lite.js` import `index-runtime.js` from its new
  path (text check); (2) `runFullIndexerComposition()` is called with
  fully injected fakes and asserted to build a real capability bundle and
  call `runIndexerCliFn` (behavioral, mirrors the existing
  `index-capability-wiring.test.js` convention); (3) — new, and the
  check that would have caught this step's own `index-runtime.js` bug
  from §3.2 — a REAL, un-stubbed `runIndexerCli()` call (imported from
  its new `src/shared/indexer/` path) against a deliberately nonexistent
  target path, proving the entire dynamic-import chain
  (`env-bootstrap.js` → `settings/service.js` → `run.js`) resolves all
  the way into `run.js`'s own real `main()`, which then fails for the
  EXPECTED reason (nonexistent source path, `process.exitCode === 1`)
  rather than a module-resolution crash.
- **Lite tarball staging**: all 24 moved files staged at their new
  `shared/indexer/` path, none at the old `indexer/` path; zero new
  `local/` files; **the local ONNX tag-generation worker/implementation
  (`tag-onnx.js`, `tag-onnx-worker.js`) absent from the tarball at ANY
  path** (this task's own explicit Part E requirement, distinct from
  Step 7A's "zero new `local/` files" check — proves the move didn't
  accidentally change what Lite excludes, not just what it newly
  includes); `index-full.js` absent, `index-lite.js` present (the
  edition-asymmetric staging this step's move must not disturb); the 3
  composition/2 lazy-shim files that stayed create no `shared/indexer/`
  duplicate.
- **Full entry point still resolves and can use real local capabilities**
  — this task's own explicit Part E requirement, distinct from every
  prior step's own test suite: confirms `index-full.js` still
  statically/dynamically references the real `ollama-lazy.js`/
  `onnx-embed-lazy.js`/`phases/tag-onnx-lazy.js` lazy shims unchanged,
  and that importing it still exports `runFullIndexerComposition`
  cleanly — proving this move (a `shared` relocation) did not sever the
  unrelated `local`-capability wiring Full's own composition root still
  needs.
- **The `import.meta.url` depth fix is real, not just text-correct**:
  `warningsPathFor()` is called and its result checked against the real
  repo-root `.tmp/semidex-inspect/` prefix; `buildFileSkeleton()` is
  called and produces real nav points, proving its own relative imports
  of `node-id.js`/`node-policy.js` resolved correctly too, not just the
  `ROOT` constant itself.

Verified genuinely load-bearing: reverted `index-full.js`'s
`index-runtime.js` import back to the old (now-wrong) relative path and
confirmed 5 independent tests failed with the exact expected assertions
(the stale-path scan, the manifest-classification check, the direct
import-text check, and both runtime-construction checks) — restored the
fix, regenerated the manifest, re-ran, all 77 pass.

## 6. Unexpected findings

1. **`index-runtime.js`'s own two dynamic imports were missed in the
   first fix pass** (§3.2) — a genuinely silent bug: `node --check`,
   `node scripts/audit/build-import-graph.mjs` (0 parse errors), and even
   a bare `await import('./src/shared/indexer/index-runtime.js')` all
   passed cleanly, because the two broken specifiers
   (`'../shared/core/env-bootstrap.js'` → doubled to
   `src/shared/shared/core/env-bootstrap.js`; `'../core/settings/service.js'`
   → resolved one directory too shallow) live inside `runIndexerCli()`'s
   own function body, a dynamic `await import()` that only executes when
   the function is actually CALLED, not at module-load time. Only found
   by `tests/unit/admin/jobs/spawn-indexer-lite.test.js` and
   `tests/unit/core/backfill-entity-refs.test.js` genuinely exercising
   the real code path during the full `npm test` run. This is the
   concrete justification for this step's own new architecture test's
   "real, un-stubbed `runIndexerCli()` call" check (§5) — a text-only or
   bare-import-only regression test would not have caught this class of
   bug, and would not catch a regression of it in the future either.
2. **`src/smoke/sections/47-skeleton-nav.js` was silently skipped by a
   text-search tool's binary-content detection** despite being valid
   UTF-8 source with no actual binary content — found only by a
   dedicated Node script reading every file's raw text directly
   (`fs.readFileSync(file, 'utf-8')`), not by any `grep`/ripgrep-based
   search, which is why the final verification pass for this step
   explicitly used that approach rather than trusting a second text-tool
   sweep to be complete.
3. **`backfill-entity-refs.js`/`backfill-tags.js`'s bare `./indexer/...`
   specifier shape** (files living directly under `src/`, not a
   subdirectory) was missed by directory-scoped batch searches that
   implicitly assumed every consumer's specifier started with `../` —
   found only by an explicit, separate check of every top-level
   `src/*.js` file individually.
4. No `src/admin/`/`src/core/` subdirectory file needed a change beyond
   its own import-path update to the 24 moved files — confirming this
   step's "не переносити `src/admin/`, не переносити `src/core/`
   subdirectories" boundary was already respected by the existing
   codebase structure, not something this move had to work around.

## 7. Part F — audit artifacts and documentation updates

- **`scripts/audit/full-lite-module-classification.json`** —
  regenerated; category counts identical to the pre-move baseline
  (shared 144, local 27, composition 12, mixed 9, tooling 61, cloud 8).
- **`docs/design/artifacts/full-lite-import-graph.json`**,
  **`full-lite-module-inventory.json`**, **`full-lite-reachability-summary.json`**
  — regenerated via the audit scripts.
- **`docs/en/project-structure.md`** — the "Indexer Pipeline" section
  split into `src/shared/indexer/` (the 24 moved files, `phases/`
  subdirectory preserved) and `src/indexer/` (the 3 composition/entry
  files + 2 lazy-shim files that stayed), mirroring the Core Modules
  section's own existing split convention from Step 7A; the Cloud
  section's own consumer list (`indexer/run.js`) updated to the new
  path.
- **`docs/design/semidex-lite-package-boundary.md`** — a new **Phase 8B
  Step 7B update** note added immediately after the existing Phase 8B
  Step 7A update note (same format, same "historical prose stays
  unedited, this note is the authoritative current-path pointer"
  convention that note itself established).
- **`phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`** — its
  §7 Step 6 entry's header updated to reference both Step 7A and Step
  7B's own reports; a new "As implemented (Step 7B)" note added after
  the existing Step 7A one, with this step's own inventory/verification
  summary.
- This report: `docs/design/phase-8b-step7b-shared-indexer-relocation-2026-08-07.md`.

## 8. Verification results

All numbers below are from this step's own final run, not copied from
Step 7A or any earlier report.

| Check | Result |
|---|---|
| `node --test --test-concurrency=1 tests/unit/architecture/phase-8b-step7b-shared-indexer-relocation.test.js` | 77/77 pass |
| `node --test --test-concurrency=1` on the full `tests/unit/architecture/*.test.js` directory | 271/271 pass |
| `node scripts/audit/find-dependency-violations.mjs` | 0 dependency-direction violations, 0 shared→cloud edges |
| `node scripts/audit/build-shared-cloud-local-manifest.mjs` | 261 modules classified; shared 144, local 27, composition 12, mixed 9, tooling 61, cloud 8 — identical to the pre-move baseline |
| `node scripts/audit/classify-modules.mjs` | 0 cloud-imports-local violations; 0 heavy local packages reachable from Lite (pre- and post-shim); Lite-reachable 148 (unchanged) |
| `npm test` | 3264/3264 pass (was 3187 before this step; +77 from the new test file) |
| `npm run smoke` | 1316/1316 pass |
| `npm run admin:build` | succeeds, byte-identical output hashes to the pre-move build |
| `npm run admin:build:lite` | succeeds, byte-identical output hashes to the pre-move build |
| `node packages/lite/build.mjs` | 123 files staged, closure validator clean (unchanged from the pre-move baseline) |
| Lite clean-install acceptance (`tests/unit/lite/clean-install-acceptance.test.js`) | 6/6 pass — real `npm pack`, fresh install into an empty dir, read-only package dir; `doctor`/`serve` both run correctly against the real installed tarball with the moved `shared/indexer/` files; "no relative import escapes the package root" check passes against the real installed files |
| `git diff --check` | clean (only pre-existing CRLF line-ending warnings, zero real whitespace/conflict errors) |
| Reverted-fix regression check | confirmed the new architecture test genuinely fails (5 independent assertions) when `index-full.js`'s `index-runtime.js` import is reverted to its old path; passes again once restored |

## 9. Known limitations / deferred work

- `src/admin/`'s shared files and `src/core/`'s subdirectories remain
  untouched — explicitly out of scope for this step, per the task's own
  "не переносити" list. `src/admin/` is Phase 8A §7's own eventual
  scope for a later step (never named "Step 7C" — not decided here).
- `phases/tag-onnx-lazy.js`/`.lite.js` remain physically inside
  `src/indexer/phases/`, not yet removed or relocated — Phase 8B Step
  8's own scope, unaffected by this step.
- `core/rerank.js`'s pre-existing Lite-tarball-staging gap (documented in
  Step 7A's own report, itself citing Phase 8A §3.3) remains unrelated
  to and unaffected by this step — not revisited here.
- The `import.meta.url`-dynamic-function-body class of bug found in §3.2/
  §6.1 (a broken relative path inside a function body that only executes
  at call time, invisible to `node --check`/static-import tests) is
  worth keeping in mind for any FUTURE physical-relocation step in this
  codebase — this step's own new test now guards specifically against it
  for `index-runtime.js`/`run.js`, but the general pattern (any moved
  file with a dynamic `await import()` inside a function body) is not
  automatically covered by a generic check; each future step should
  budget for a real, un-stubbed execution test of any moved file that
  has one.

## Next step

`src/admin/`'s shared files — the remaining portion of Phase 8A §7 Step
6's original combined scope, not yet covered by either Step 7A or Step
7B.

## Verdict

**PHASE_8B_STEP7B_ACCEPT**
