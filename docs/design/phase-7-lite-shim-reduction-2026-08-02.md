# Phase 7 — Audit and reduce unnecessary Semidex Lite lazy shims

Implementation report for Phase 7 of
[`full-lite-shared-architecture-audit-2026-08-01.md`](full-lite-shared-architecture-audit-2026-08-01.md)
("Phase 7 — Remove now-unnecessary Lite shims, only after Phases 3–6
land"). Audited whether Phase 6's physical Full/Lite UI separation made
any of the three server/indexer `*-lazy.js`/`*-lazy.lite.js` shim pairs
redundant. Result: **all three remain necessary — none were removed.**
The phase's real deliverable is a found-and-fixed silent-drift risk
between two independently-declared copies of the substitution list.

## 1. Per-shim verdicts

| Shim pair | Verdict | Evidence |
|---|---|---|
| `core/ollama-lazy.js` / `.lite.js` | **KEEP** | Real path `serve-lite.js → admin/jobs/registry.js (spawn) → indexer/index.js → run.js → ollama-lazy.js → ollama.js`. 8 real Lite-reachable consumers (`embeddings.js`, `generation/ollama-provider.js`, 4 indexer phase modules, `preflight.js`, `run.js`). Pre-shim reachable, post-shim not. |
| `core/onnx-embed-lazy.js` / `.lite.js` | **KEEP** | Two independent real paths: indexing (`serve-lite.js → registry.js → run.js → embeddings.js → onnx-embed-lazy.js`) and search (`admin/register-neutral-routes.js → api/search.js → embeddings.js → onnx-embed-lazy.js`). `onnx-embed.js` itself statically imports `@huggingface/tokenizers` and (via `onnx-runtime.js`) dynamically resolves `onnxruntime-node`. |
| `indexer/phases/tag-onnx-lazy.js` / `.lite.js` | **KEEP** | Real path `serve-lite.js → registry.js (spawn) → run.js → tag-onnx-lazy.js → tag-onnx.js → (fork) → tag-onnx-worker.js`. This is the ONLY reachable-from-Lite path to `@huggingface/transformers` anywhere in the codebase. |

No shim was classified `REMOVE` or `REPLACE_WITH_COMPOSITION_BOUNDARY`.
Every dependency-path claim above is now a regression test, not prose —
see §4.

## 2. Part A method — real AST import graph, not regex

Used `scripts/audit/build-import-graph.mjs`'s real parsed graph
(static imports, literal `import()`, `require()`, resolved `fork()`/
`spawn()` targets) and `scripts/audit/classify-modules.mjs`'s
`computeReachable()`, run twice per shim: `applyLiteShims: false`
(pre-shim — "what if the substitution didn't exist") and
`applyLiteShims: true` (post-shim — "what the real shipped tarball
looks like"). The difference between the two is the exact, falsifiable
test of whether a shim is load-bearing: if a target is reachable
pre-shim and unreachable post-shim, the shim is what cuts that edge.

All three real Lite entry points
(`packages/lite/lite-src/{doctor-lite,serve-lite,index-lite}.js`) were
checked individually:

| Entry point | Reaches `ollama.js`/`onnx-embed.js`/`tag-onnx.js` pre-shim? |
|---|---|
| `doctor-lite.js` | No (all three) — `doctor` never touches indexing/search/generation |
| `serve-lite.js` | Yes (all three) — the admin API's job-spawn chain and search route both reach them |
| `index-lite.js` | Yes (all three) — the CLI `index` command uses the same job-spawn chain |

This directly maps to the task's required "doctor / serve / index /
search / Ask / admin API" breakdown: `doctor` is unaffected by any of
the three shims; `serve` (admin API, including search/Ask) and `index`
(CLI indexing) both depend on all three.

Dynamic `import()`, `require()`, `fork()`/`spawn()`, and worker targets
were all checked (not just static imports) — the existing
`ALLOWED_NON_LITERAL_REFERENCES` allow-list in
`tests/unit/architecture/full-lite-boundary.test.js` already covers the
one genuinely non-literal reference in the whole graph
(`onnx-runtime.js`'s `require(resolveOnnxRuntimeModule(env))`, which
resolves `onnxruntime-node` itself or a user-supplied override path —
confirmed still the only such reference, no new one introduced by this
audit).

Two other local-only fork/spawn targets were checked and confirmed to
need no shim of their own: `core/ce-rerank.js`'s fork target
(`ce-rerank-worker.js`) and `core/onnx-provider-probe.js`'s spawn target
(`onnx-probe-runner.js`) both stay unreachable from Lite through the
existing composition-boundary exclusion (`ce-rerank.js` has zero
importers among kept files; `admin/composition/lite.js` never registers
`admin/api/onnx.js`'s routes) — confirmed by the same reachability check,
now pinned as a test (§4).

## 3. Part D — unified source of truth

**Before**: `packages/lite/build.mjs` declared
`const LAZY_SHIM_SUBSTITUTIONS = [{ real, shim }, ...]` (3 entries,
`REPO_SRC`-relative paths); `scripts/audit/classify-modules.mjs`
independently declared `export const LAZY_SHIM_SUBSTITUTIONS = { [realPath]: shimPath }`
(the same 3 pairs, `src/`-prefixed repo-root-relative paths, different
shape). No test tied the two together — a shim pair added, removed, or
renamed in one file with no corresponding update to the other would
leave the two tools silently disagreeing.

**After**: a new module, `packages/lite/lazy-shim-substitutions.mjs`
(pure data, zero imports, zero I/O), declares the canonical
`{ real, shim }` array once. `build.mjs` imports it directly (same shape
it always used). `classify-modules.mjs` imports it and derives its own
`{ [realPath]: shimPath }` object via one `Object.fromEntries()`
mechanical key-prefixing call — confirmed byte-identical to the old
hand-maintained object before deleting it.

The new module is a top-level `packages/lite/*.mjs` file, outside
`packages/lite/package.json`'s `"files"` allowlist (`bin/`, `lite-src/`,
`src/`, `dist/`, `README.md`, `.env.example`) — confirmed via a real
`npm pack --dry-run` that it (like `build.mjs` itself) never ships in the
tarball.

## 4. Architecture regression tests

New: `tests/unit/architecture/lite-lazy-shim-necessity.test.js` (17
tests). For each of the three shims: pre-shim reachability (must be
`true`), post-shim reachability (must be `false`), the exact real import
path (asserted as a literal array, not just "a path exists"), and a
consumer-count/heavy-package check specific to that shim (8 Lite-reachable
`ollama-lazy.js` importers; the search-route path for
`onnx-embed-lazy.js`; the exact single-file `@huggingface/transformers`
reachability set for `tag-onnx-lazy.js`). Plus: the shared substitution
list has exactly the 3 expected pairs; every pair's real/shim path exists
as a real graph node; the two composition-boundary-only exclusions
(`ce-rerank.js`, `onnx-provider-probe.js`) need no shim of their own.

Verified this test suite genuinely catches drift: temporarily deleted the
`ollama-lazy.js` entry from `lazy-shim-substitutions.mjs`, confirmed 2
tests failed with exactly the expected assertions (the pair-count check,
and the post-shim-unreachability check now failing since the substitution
no longer exists to apply), then restored the file (confirmed
byte-identical via the prior read).

The pre-existing `tests/unit/architecture/full-lite-boundary.test.js`
(12 tests, unmodified) and the three shim-specific drop-in-replacement
tests (`tests/unit/core/ollama-lazy-lite-shim.test.js`,
`tests/unit/core/onnx-embed-lazy-lite-shim.test.js`,
`tests/unit/indexer/phases/tag-onnx-lazy-lite-shim.test.js`, unmodified)
all still pass — this phase added a genuinely new proof (necessity), not
a replacement for the existing proofs (drop-in shape, typed-error
behavior).

## 5. What was actually removed

Nothing. No `.lite.js` file was deleted. No substitution entry was
removed from `packages/lite/build.mjs`. No entry was removed from
`scripts/audit/classify-modules.mjs` (its own declaration was replaced
by an import + derivation, not shortened). All three shim pairs, and the
production `*-lazy.js`/`*.lite.js` files themselves, are byte-identical
to before this phase.

## 6. Tarball size change

| | Before | After |
|---|---|---|
| Package size | 397.4 kB | 397.4 kB |
| Unpacked size | 1.3 MB | 1.3 MB |
| Total files | 127 | 127 |

No change, as expected — zero files added, removed, or modified in the
staged `src/` tree; only two build-tooling files
(`packages/lite/build.mjs`, `scripts/audit/classify-modules.mjs`) and one
new non-staged tooling file (`lazy-shim-substitutions.mjs`) changed, none
of which are part of the shipped package.

## 7. Closure validator and test/build results

Run sequentially:

| Check | Result |
|---|---|
| `tests/unit/architecture/lite-lazy-shim-necessity.test.js` (new) | 17/17 pass |
| `tests/unit/architecture/full-lite-boundary.test.js` (unmodified) | 12/12 pass |
| `node packages/lite/build.mjs` | 118 files staged, closure validated clean |
| `npm run admin:build` (Full) | succeeds, ~285.5 kB JS (unchanged) |
| `npm run admin:build:lite` (Lite) | succeeds, ~279.8 kB JS (unchanged) |
| `npm test` (full suite) | 2658/2658 pass (2641 pre-Phase-7 baseline + 17 new) |
| `npm run smoke` | 1316/1316 pass (matches baseline) |
| `git diff --check` | clean |

## 8. Live/package acceptance (§F)

Ran `tests/unit/lite/clean-install-acceptance.test.js` (the existing test
that already performs exactly the required workflow — a real `npm pack`,
install into a fresh empty temp directory, mark the package directory
read-only, then exercise the installed CLI):

| Check | Result |
|---|---|
| `npm ls --all` from the installed package excludes `onnxruntime-node`, `@huggingface/transformers`, and `acorn` | pass |
| `semidex-lite --help` runs from the read-only install | pass |
| `semidex-lite doctor` runs from the read-only install, writes nothing into the package dir, reports missing credentials cleanly | pass |
| `semidex-lite serve` starts from the read-only install and responds on `/api/health` | pass |
| The installed package directory itself received zero writes (only `SEMIDEX_HOME` did) | pass |
| Every relative import/require in the installed package resolves to a path inside the package directory | pass |

No real indexing job was run against a user collection, per the task's
own constraint — `doctor`/`--help`/a `/api/health` probe are sufficient
to prove the installed package boots and its dependency closure is
correct without indexing anything.

## 9. Open questions for Phase 8

Phase 8 ("Narrow npm staging to the real, now-directory-enforced
shared+cloud closure") remains unstarted and out of this phase's scope,
per the task's own explicit non-goals. Two things Phase 8 would need to
re-examine, noted here for continuity:

- `packages/lite/build.mjs`'s `EXCLUDE_FILES` list is still a curated,
  hand-maintained file list, not a directory-based rule — Phase 8's own
  stated precondition ("a real `local/` directory") does not yet exist,
  since no phase through Phase 7 has physically relocated `src/` files
  into `shared/`/`cloud/`/`local/` subdirectories (explicitly out of
  scope for every phase so far, including this one).
- The three `*-lazy.js`/`*-lazy.lite.js` pairs remain the correct
  mechanism for their specific job (a literal dynamic-import target that
  must resolve to *something* even when the real target is excluded) —
  Phase 8, if it ever introduces a directory-based exclusion rule, should
  re-confirm these three pairs still need the content-substitution
  mechanism specifically (they do today, and this phase found no reason
  to expect that to change), not assume a directory rule alone would
  replace them.
