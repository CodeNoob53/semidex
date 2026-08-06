# Phase 8B Step 4 — physical relocation of the local ONNX tag-generation runtime

Implementation report for Phase 8B Step 4 of the Phase 8 migration plan
laid out in
[`phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`](phase-8a-shared-cloud-local-migration-audit-2026-08-02.md)
§9 ("Step 4"). Builds directly on Step 2's precedent (ONNX embedding
runtime relocation,
[`phase-8b-capability-contracts-and-composition-seams-2026-08-02.md`](phase-8b-capability-contracts-and-composition-seams-2026-08-02.md)
§12) and Step 3's precedent (Ollama relocation + `run.js` instance-scoped
`ctx` threading,
[`phase-8b-step3-local-ollama-relocation-2026-08-05.md`](phase-8b-step3-local-ollama-relocation-2026-08-05.md)).
**Nothing was committed** — this is the working-tree state at the end of
this step's own session.

**This report was corrected after a second code-review pass.** The first
version of this step's own work physically moved `tag-onnx.js`/
`tag-onnx-worker.js` but left the file's coordinator state
(`_worker`/`_pending`/`_dispatchTail`/failure flags) as MODULE-SCOPE
singleton bindings — unchanged from before the move — and this report
then incorrectly framed that as an acceptable, even required, design
("mirrors `core/ce-rerank.js`'s own established pattern"). The review
correctly identified this as a real, live isolation gap: two concurrent
`run({ capabilities })` calls in one process share the exact same
`tagOnnx` capability object (the cached `tag-onnx-lazy.js` module
namespace), so the first run's own cleanup could kill a worker a second,
still-running job's pending request needed — precisely the failure mode
Step 3's own `ctx`-threading fix exists to prevent for the other five
capabilities. The review also correctly identified that this step's own
regression test only proved request/response correlation between two
CALLS sharing one worker, not isolation between two capability INSTANCES,
and therefore could not have caught the gap. Every section below has been
rewritten to describe the actual fix — `createTagOnnxCapability()`, a
factory returning a fresh, independent worker lifecycle per call — not
the rejected singleton design. Sections describing the now-superseded
design are kept only where explicitly marked historical.

## 1. What moved

**Physically relocated** (`git mv`, history preserved):

| Old path | New path |
|---|---|
| `src/indexer/phases/tag-onnx.js` | `src/local/indexer/phases/tag-onnx.js` |
| `src/indexer/workers/tag-onnx-worker.js` | `src/local/indexer/workers/tag-onnx-worker.js` |

**Deliberately NOT moved** (mirrors Step 2/3's own precedent — the lazy
seam and the neutral predicate module are not local-only, so they stay):

- `src/indexer/phases/tag-onnx-lazy.js` — zero backend imports of its own;
  only its ONE dynamic-import specifier changed (`./tag-onnx.js` →
  `../../local/indexer/phases/tag-onnx.js`).
- `src/indexer/phases/tag-onnx-lazy.lite.js` — the Lite staging shim
  (already dead code per Step 1 round 4's own finding — see §5).
- `src/indexer/phases/tag-provider.js` — the pure `isOnnxTagProvider(env)`
  predicate, deliberately extracted in an earlier refactor specifically so
  it never needs to import `tag-onnx.js`'s own `fork()`/`WORKER_PATH`
  machinery. `tag-onnx.js` re-exports it for backward compatibility;
  after the move this is a `local -> shared` import (the normal, allowed
  direction — only `shared -> local` is forbidden), so `tag-onnx.js`'s
  own import of it was updated to `../../../indexer/phases/tag-provider.js`.

## 2. Import/worker-path updates

### 2.1 Internal cross-references inside the moved file itself

`tag-onnx.js` computes two paths from its own `import.meta.url` at module
load, both of which needed care:

```js
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, '../workers/tag-onnx-worker.js');
```

`WORKER_PATH` needed **zero change** — `tag-onnx-worker.js` moved to the
exact same *relative* position (`../workers/` from `phases/`) under the
new parent, so the relative specifier is still correct. Verified directly
at runtime (not just by inspection): `import('./tag-onnx-lazy.js')` then
calling `shutdownOnnxTagWorker()` before any worker was ever spawned
resolved the whole dynamic-import chain (`tag-onnx-lazy.js` →
`local/indexer/phases/tag-onnx.js` → its own `tag-provider.js` import →
`WORKER_PATH` construction) successfully in a real Node process.

```js
function resolveWorkerConfig(env = process.env) {
  const ROOT = join(__dirname, '../../../../'); // was '../../../' before the move
  return { cacheDir: join(ROOT, 'models', 'transformers-cache'), ... };
}
```

This one **did** need a change, and is exactly the kind of easy-to-miss
detail the task asked to check for: `tag-onnx.js` moved from
`src/indexer/phases/` (3 directory levels under the repo root) to
`src/local/indexer/phases/` (4 levels under the repo root) — one level
deeper — so `ROOT`'s relative-`../` count needed to grow from 3 to 4 to
still resolve to the repo root. Verified with a direct Node path-resolution
check before and after the edit (`join(oldDir, '../../../')` vs.
`join(newDir, '../../../../')` both resolve to the identical absolute repo
root), not by inspection alone.

The `import { isOnnxTagProvider } from './tag-provider.js'` line also
needed updating, to `../../../indexer/phases/tag-provider.js` — since
`tag-provider.js` correctly stays in `src/indexer/phases/` (shared,
zero-dependency, by design — see §1), the moved file's relative distance
to it changed. Verified by direct path resolution and by a real dynamic
import exercising the whole chain end to end (§2.1 above).

### 2.2 The lazy seam — path AND shape both changed (second pass)

`src/indexer/phases/tag-onnx-lazy.js`'s dynamic-import specifier changed,
same as Steps 2/3's own precedent for their own lazy seams:

```js
async function loadTagOnnx() {
  if (!_mod) _mod = await import('../../local/indexer/phases/tag-onnx.js'); // was './tag-onnx.js'
  return _mod;
}
```

But unlike Steps 2/3, this seam's own EXPORT SHAPE also changed (second
review pass): it used to re-export `addTagsOnnxBatch`/
`shutdownOnnxTagWorker` as bare async wrapper functions, forwarding
straight to the real module's own module-scope singleton. Now it exports
one function, `createTagOnnxCapability()`, which awaits the dynamic
import and then calls the real module's own factory of the same name,
returning a fresh instance:

```js
export async function createTagOnnxCapability() {
  const mod = await loadTagOnnx();
  return mod.createTagOnnxCapability();
}
```

`src/indexer/phases/tag-onnx-lazy.lite.js` (the Lite staging shim) was
updated to match this shape too, even though it is dead code today (see
§5) — kept in sync so a future consumer building against "the shim's
shape" never diverges from the real seam it stands in for.

### 2.3 Every other real importer

| File | Old specifier | New specifier |
|---|---|---|
| `src/backfill-tags.js` | `./indexer/phases/tag-onnx.js` | `./local/indexer/phases/tag-onnx.js` |
| `src/smoke/sections/38-tag-onnx-provider.js` | `../../indexer/phases/tag-onnx.js` | `../../local/indexer/phases/tag-onnx.js` |
| `tests/unit/indexer/phases/tag-onnx.test.js` (3 import sites — static import + 2 `readFileSync(new URL(...))` structural checks) | `../../../../src/indexer/phases/tag-onnx.js` | `../../../../src/local/indexer/phases/tag-onnx.js` |
| `tests/unit/indexer/phases/tag-onnx-lazy.test.js` (dynamic import of the real module + a stale-specifier regex) | `../../../../src/indexer/phases/tag-onnx.js` | `../../../../src/local/indexer/phases/tag-onnx.js` |
| `tests/unit/core/onnx-process-isolation.test.js` (4 `readSrc()` calls) | `indexer/phases/tag-onnx.js`, `indexer/workers/tag-onnx-worker.js` | `local/indexer/phases/tag-onnx.js`, `local/indexer/workers/tag-onnx-worker.js` |
| `tests/unit/indexer/indexer-settings-writeback.test.js` | `../../../src/indexer/phases/tag-onnx.js` | `../../../src/local/indexer/phases/tag-onnx.js` |
| `tests/unit/architecture/lite-lazy-shim-necessity.test.js` (`LOCAL_RUNTIME_TARGETS` array) | `src/indexer/phases/tag-onnx.js`, `src/indexer/workers/tag-onnx-worker.js` | `src/local/indexer/phases/tag-onnx.js`, `src/local/indexer/workers/tag-onnx-worker.js` |
| `tests/unit/architecture/shared-cloud-local-manifest.test.js` (`pairs` shim-target map) | `src/indexer/phases/tag-onnx.js` | `src/local/indexer/phases/tag-onnx.js` |

**Corrected from the first pass**: `index-full.js`, `backfill-tags.js`,
and every test file that constructed a capability from the real module or
its lazy seam were NOT "zero changes" — the first version of this report
claimed `index-full.js` required no change because only its import
*path* was checked; the review's fix changed the *shape* every real
consumer must use (§3). `src/indexer/run.js`,
`src/indexer/phases/tag-onnx-capability.js`, and
`src/admin/jobs/registry.js` genuinely required zero changes, confirmed
by a full repo-wide dependency inventory:

- `run.js` never imports `tag-onnx.js` directly, only the zero-backend-
  import `tag-onnx-capability.js` contract (`REQUIRED_TAG_ONNX_CAPABILITY_METHODS`,
  `validateTagOnnxCapability`) — path- and shape-independent by
  construction; `run.js` only ever calls `ctx.tagOnnx.addTagsOnnxBatch(...)`/
  `ctx.tagOnnx.shutdownOnnxTagWorker()` as instance methods on whatever
  object its composition root supplied, which is exactly what a
  `createTagOnnxCapability()`-produced instance provides.
- `tag-onnx-capability.js` has zero backend imports by design — the whole
  point of a capability contract is having no coupling to the
  implementation's physical location OR its construction mechanism.
- `admin/jobs/registry.js` has **zero** dependency, direct or indirect, on
  either moved file — it accepts an injected `spawnIndexer` callback with
  no default; the real `node:child_process.spawn()` call and each
  edition's own entry-file path live in `spawn-indexer-full.js`/
  `spawn-indexer-lite.js`, which spawn the indexer CLI as ONE process.
  `tag-onnx.js`'s own `fork()` of `tag-onnx-worker.js` happens entirely
  *inside* that already-spawned indexer process — `registry.js` has no
  visibility into or dependency on that second-level fork. Confirmed by
  reading the file in full, not assumed from Step 3's precedent.

## 3. Capability wiring — Full and Lite

**Rewritten after the second review pass** — this step is NOT a pure
relocation; `tag-onnx.js`'s own export shape changed from a module-scope
singleton to an instance factory, and every composition root's wiring
changed to match:

- **Full**: `index-full.js`'s `isIndexerMainModule` guard now does
  `const tagOnnxLazy = await import('./phases/tag-onnx-lazy.js'); const
  tagOnnx = await tagOnnxLazy.createTagOnnxCapability(); ...
  runIndexerCli({ ..., tagOnnx })` — ONE fresh capability instance,
  constructed exactly once, at composition time, before `runIndexerCli()`
  is ever called. This is the same "composition root selects the
  capability once, up front" discipline every other slot
  (`ollamaGenerate`/`ollamaEmbed`/etc.) already followed — `tagOnnx` was
  the one outlier, still passing a shared module namespace object
  in the first version of this step.
- **`src/backfill-tags.js`** (a separate Full-only tooling script, not
  routed through `index-full.js`/`run.js` at all): also constructs its
  own instance directly from the real module,
  `const tagOnnx = createTagOnnxCapability();` (synchronous here — no
  lazy-seam indirection, since this script already imports the real
  `local/indexer/phases/tag-onnx.js` directly), and calls
  `tagOnnx.addTagsOnnxBatch(...)`/`tagOnnx.shutdownOnnxTagWorker()` as
  instance methods in its own `finally` block.
- **Lite**: `index-lite.js` builds a typed-unavailable `tagOnnx` capability
  directly (never imports `tag-onnx-lazy.js`, real or `.lite.js`) — this
  was ALREADY a fresh-object-per-call factory function
  (`unavailableTagOnnxCapability()`), so no change was needed here; Lite's
  own design already matched the pattern Full needed to be brought up to.
  Lite's `TAG_GEN=0` hard pin means `addTagsOnnxBatch` is never reached
  regardless, and `shutdownOnnxTagWorker()` must still resolve as a safe
  no-op (Lite's own capability object satisfies this, matching the real
  implementation's documented contract).
- `run.js`'s `run({ capabilities })` → local `const ctx` →
  `ctx.tagOnnx.shutdownOnnxTagWorker()` in `finally` (Step 3's design)
  required **zero code change** — `run.js` never held, shared, or
  substituted a capability reference itself; it only ever threads
  whatever object its caller supplied. What changed is what that object
  now IS: previously a reference to a shared singleton, now an
  independently-constructed instance. `run.js`'s own header/inline
  comments were corrected (they previously claimed cleanup isolation as
  something `run.js`'s own design guaranteed on its own — it doesn't; that
  guarantee depends on the capability object's own construction, which is
  the composition root's responsibility, see `run.js`'s own updated
  comment for the full explanation).

## 4. Persistent worker lifecycle — before/after

**Rewritten after the second review pass.** The message-protocol/timeout/
error-handling CONTRACT itself — everything below except worker
OWNERSHIP — is unchanged from before the move, per the task's
"не рефакторити worker protocol без необхідності" instruction. What DID
change is who owns that contract's state: every piece of coordinator
state that used to be module-scope now lives inside
`createTagOnnxCapability()`'s own closure, private to one instance.

- **Worker creation — now genuinely per-instance, not a shared
  singleton**: `_worker`/`_workerReady`/`_initPromise`/`_pending`/
  `_dispatchTail`/the failure flags are closure variables inside
  `createTagOnnxCapability()`, never module-scope. Each call to the
  factory returns an object with its own private state and its own
  worker lifecycle — two instances share nothing. `index-full.js` calls
  the factory exactly once, so the common case (one indexer CLI
  invocation, one composition root) still has exactly one worker, same
  as before — but a second, independently-composed instance (a second
  Full composition constructed in the same process, or two concurrent
  `run({ capabilities })` calls each correctly given their OWN instance)
  now has a genuinely separate worker, not a shared one.
- **Request/response correlation**: monotonic `requestId`, `Map`-based
  pending-request tracking, a coordinator-side dispatch queue
  (`_dispatchTail`) that starts each request's own timeout only once
  dispatch genuinely happens (not while queued) — unchanged in mechanism,
  now scoped per-instance. Re-verified behaviorally: two concurrent
  `addTagsOnnxBatch()` calls against ONE instance's fake worker, replied
  to out of order, each resolve with only their own correlated result
  (unchanged from before — this was never the gap); separately, two
  DIFFERENT instances' own workers never cross-deliver at all, proven
  directly (new architecture test, §6).
- **Error/exit handling**: a worker `error` or non-zero `exit` rejects
  every pending request and marks that INSTANCE's own session failed
  (`_tagModelFailed = true`, now closure-scoped) — a crash in one
  instance never marks a different instance's own `_tagModelFailed`,
  confirmed by a new test constructing two instances where one fails to
  load and the other keeps working normally. A clean `exit` (code 0, only
  reachable via a deliberate `shutdownOnnxTagWorker()`, whose own
  listener removal prevents the global exit handler from ever seeing it)
  does not mark failure. Fully covered by the pre-existing
  `tag-onnx.test.js` suite, rewritten to construct a fresh instance per
  test via `createTagOnnxCapability()` rather than resetting one shared
  module-scope instance between tests.
- **`shutdownOnnxTagWorker()` before any worker was ever spawned**: the
  `if (_worker)` guard, now closure-scoped, makes this a true no-op —
  confirmed both by unit test (new architecture test, §6) and by the
  FIRST real action this step's own runtime-exercise took: constructing a
  fresh instance from the moved `tag-onnx-lazy.js` and calling
  `shutdownOnnxTagWorker()` on it before any worker existed, which
  resolved cleanly with no error.
- **Repeated shutdown safety**: idempotent by construction, per instance
  (`_worker` is reset to `null` after the first call, so a second call on
  the SAME instance hits the same no-op guard) — confirmed by a new
  behavioral test calling it twice in a row on one instance, both with
  and without a real fake-worker lifecycle in between, AND by a separate
  test proving repeated shutdown on instance A never affects instance B
  even once.
- **Cleanup of one run never affecting another's worker — the actual
  fix, not merely re-verified**: this is the guarantee the first version
  of this step's own report incorrectly claimed was already true by
  virtue of Step 3's `ctx`-threading design. It was NOT true for
  `tagOnnx` specifically until this round's fix: two capability instances
  constructed via two separate `createTagOnnxCapability()` calls now have
  fully independent `_worker`/`_pending`/failure state, so instance A's
  `shutdownOnnxTagWorker()` provably never kills instance B's worker,
  never rejects B's pending request, and never touches B's own failure
  flag — proven directly by three new tests (§6), not inferred from
  `run.js`'s own `ctx`-threading design (which only guarantees run.js
  passes the SAME reference back to the SAME capability object it was
  given — it says nothing about whether that object's own internals are
  actually independent of another object's).

## 5. Shim status — `tag-onnx-lazy.js`/`tag-onnx-lazy.lite.js`

Per the task's explicit instruction, investigated rather than assumed:

- **`tag-onnx-lazy.js`** (the real seam) is **still load-bearing** —
  `index-full.js` is its one real importer (Full-only, dynamically
  imported inside the `isIndexerMainModule` guard). It must stay.
- **`tag-onnx-lazy.lite.js`** (the Lite staging shim) was **already dead
  code before this step** — confirmed via `packages/lite/build.mjs`'s own
  `EXCLUDE_FILES` list, which excludes BOTH `indexer/phases/tag-onnx-lazy.js`
  and `indexer/phases/tag-onnx-lazy.lite.js` outright (a Step 1 round 4
  finding, predating this step: no *-lazy.js content-substitution
  mechanism exists in `build.mjs` anymore — Lite composition builds its
  typed-unavailable capabilities directly in `index-lite.js`, never
  importing either lazy variant). This step changed **nothing** about
  that status — it was dead before, stays dead now, and per the task's
  own instruction ("якщо стала redundant, не видаляй у цьому кроці без
  доказу та узгодження зі Step 8") it was **left in place, not deleted**.
  Its one header-comment mention of the real lazy module's dynamic-import
  specifier was updated for accuracy (`./tag-onnx.js` →
  `../../local/indexer/phases/tag-onnx.js`), since that comment explains
  WHY the shim exists by quoting the real module's own specifier.
- `packages/lite/build.mjs`'s `EXCLUDE_FILES` list had two now-redundant
  individual entries removed (`indexer/phases/tag-onnx.js`,
  `indexer/workers/tag-onnx-worker.js`) — both are now covered by the
  existing `'local'` `EXCLUDE_DIRS` entry, the same net-reduction pattern
  Steps 2 and 3 applied to the ONNX-embedding and Ollama files before
  them. `tag-onnx-lazy.js`/`tag-onnx-lazy.lite.js` themselves remain
  listed in `EXCLUDE_FILES` (they did not move).

## 6. New regression test

`tests/unit/architecture/phase-8b-step4-tag-onnx-relocation.test.js` (26
tests across 9 describe blocks — **rewritten after the second review
pass**, see below), mirroring Step 2/3's structure for the physical-move
proofs, plus lifecycle-behavioral tests neither prior step needed:

- **Physical move**: old paths gone, new paths exist, the lazy seam and
  its `.lite.js` sibling stay at their original location.
- **No stale references**: a repo-wide scan (real path resolution against
  each importing file's own directory, not a segment/regex heuristic —
  the exact blind spot Step 3's own equivalent test found and fixed)
  finds zero specifiers still resolving to either old path. A second test
  proves this check is genuinely load-bearing: it independently re-derives
  the detection logic's own verdict on a deliberately-reverted specifier
  (`./tag-onnx.js` from the lazy module's directory) and confirms it
  WOULD be flagged, then confirms the actual current specifier is NOT
  flagged.
- **Lite tarball**: the real staged tree (`build.mjs`'s own `stageSrc()`,
  not a simulation) contains zero files under `local/`; neither moved
  file is staged under any path; the lazy seam itself is confirmed
  EXCLUDED from staging (so there's no path through it to the real
  implementation in the shipped tarball either) — the test's own title
  previously mis-stated this as "the lazy seam IS staged," contradicting
  its own assertion; corrected.
- **Reachability**: neither moved file is reachable from Lite roots,
  PRE-shim or POST-shim (identical, both zero); `@huggingface/transformers`
  itself (the heavy dependency `tag-onnx-worker.js` pulls in) is confirmed
  unreachable from Lite roots.
- **Edge ownership**: `local/indexer/phases/tag-onnx.js` is imported only
  by Full-reachable files, never Lite-reachable ones;
  `local/indexer/workers/tag-onnx-worker.js` has **zero** import/require
  edges anywhere in the graph at all (it is reached exclusively via
  `fork()`, an OS-level process spawn the import-graph tool correctly
  does not — and should not — treat as a module edge).
- **Manifest**: shared/cloud modules have zero `src/local/` dependencies;
  the lazy seam is the one documented `mixed`-classified exception; both
  moved files are classified `local`.
- **Worker path genuinely resolves**: the `import.meta.url`-derived
  resolution algorithm, re-derived independently in the test (not just
  trusting `tag-onnx.js`'s own internal computation), points at a real
  file on disk; a REAL `fork()` of that resolved path launches
  successfully (a `'spawn'` event or the process still running after 2s,
  either proves Node located and began executing the file) — deliberately
  killed before it could reach `loadModel()`'s own heavy
  `@huggingface/transformers` import, so this test stays fast and never
  risks a network call.
- **Lifecycle behavioral tests, single-instance** (not source-regex):
  `shutdownOnnxTagWorker()` before any worker was ever spawned is a
  no-op; repeated shutdown (twice in a row, no worker spawned) is safe on
  one instance; a second shutdown after a real fake-worker lifecycle
  (spawn → use → shutdown) is still safe on one instance.
- **Lifecycle behavioral tests, TWO SEPARATE INSTANCES — the actual fix,
  rewritten from a misleading first draft**: an earlier version of this
  block constructed only ONE module-scope-backed instance (the design
  that existed before the fix) and proved two concurrent
  `addTagsOnnxBatch()` CALLS sharing that one worker got correctly
  correlated replies. That is real but far weaker than "two capability
  instances never share worker state," and could not have caught the
  isolation gap the review named. Replaced with three tests that each
  construct TWO independent `createTagOnnxCapability()` instances: (1)
  shutting down instance A never kills instance B's worker, never
  rejects B's own pending request (confirmed still pending immediately
  after A's shutdown, then confirmed it completes successfully once B's
  own worker replies), and B's own worker is never killed; (2) a load
  failure in instance A marks only A's own failure flag — instance B
  keeps generating real tags, unaffected; (3) repeated shutdown on
  instance A (twice in a row) never touches instance B, which can still
  be shut down cleanly on its own afterward.

All fake-worker tests use the exact same `makeFakeWorker()` helper shape
already proven correct in `tests/unit/indexer/phases/tag-onnx.test.js`
(`send()` synchronously records the message and replies via
`queueMicrotask()`) — an earlier draft of some of these tests used ad hoc
manual `EventEmitter` wiring instead, which lost a dispatch/listener race
and caused one test to hang for the full 2-minute real per-request
timeout before failing; switching to the known-correct helper fixed both
issues and cut that suite's own runtime from ~122s to ~2s.

## 7. Live tagging smoke — executed, with explicit pre-approval

Per the task's requirement, the exact command, fixture, expected memory,
and expected duration were presented for approval BEFORE running anything:

```
COLLECTION=phase-8b-step4-live-smoke TAG_GEN=1 TAG_PROVIDER=onnx \
  CONTEXT_MODE=deterministic TAG_ONNX_ALLOW_DOWNLOAD=0 \
  node src/indexer/index-full.js src/test-fixtures/three-sections.pdf
```

`CONTEXT_MODE=deterministic` was chosen (offered as the recommended
option) specifically to avoid ALSO requiring a locally-running Ollama
server for this test — it removes the LLM-context dependency while still
exercising the real ONNX tag-generation worker end to end, which is what
this step's own risk lives in. The `onnx-community/Qwen2.5-Coder-1.5B-Instruct`
model was already cached locally (1.8 GB, `models/transformers-cache`),
so `TAG_ONNX_ALLOW_DOWNLOAD=0` meant zero network access for the model
itself.

**Result: real, successful, end-to-end tagging** against the user's real
Qdrant Cloud cluster, using a disposable, clearly-named collection
(`phase-8b-step4-live-smoke`), created fresh and deleted immediately after:

- The worker spawned from the NEW location
  (`local/indexer/workers/tag-onnx-worker.js`), loaded the cached model,
  and reported `[tag-onnx] worker ready`.
- Real tags were generated and stored — verified directly via a Qdrant
  `scroll` read against the live collection, not inferred from log
  output: `["chapter-three","text"]`, `["chapter-two","text","body"]`,
  `["chapter","text","content"]` for the fixture's three sections. Never
  fell back to the empty-tags failure path.
- The indexer CLI process exited cleanly to a shell prompt after
  completion — since `fork()`'d children are not `unref()`'d, a leaked
  worker would have kept the parent process (and therefore the whole
  `node src/indexer/index-full.js ...` invocation) alive; a clean exit is
  itself proof the `finally` block's `ctx.tagOnnx.shutdownOnnxTagWorker()`
  call genuinely terminated the worker.
- Cleanup: the disposable Qdrant collection was deleted immediately after
  (confirmed absent via a follow-up collection list), and `npm run sync`
  was run to reconcile the local `config.json` cache (confirmed: `-
  removed: phase-8b-step4-live-smoke`, config.json itself is gitignored
  so no repo diff resulted).

This closes the one item Step 3's own report flagged as still outstanding
for this step: "re-verify the `shutdownOnnxTagWorker()` always-safe-no-op
contract with a real live-indexing smoke run after the move, not just
unit tests."

**Note (second review pass)**: this live smoke ran BEFORE the
`createTagOnnxCapability()` fix (§3-4) — it exercised the (then still
module-scope-singleton) worker protocol, timeout, and shutdown mechanics,
which are byte-for-byte unchanged by the fix (only state OWNERSHIP moved
from module scope into the factory's own closure — the message protocol,
`fork()` call, timeout constants, and error handling are identical code,
just relocated inside a function body). The live run is therefore still
valid evidence for everything it actually tested — real model load, real
tag generation, real clean shutdown of a single worker in a single-instance
composition (today's only real production topology, one indexer CLI
invocation per process) — but it does NOT, and was never intended to,
exercise the cross-instance isolation gap the review found; that gap only
manifests with two independently-constructed capability instances in one
process, which this live run never had. The 26 new unit tests (§6) are
the evidence for that specific fix; re-running the live smoke was judged
unnecessary since it would exercise the same single-instance code path
the original run already covered, and the fix touches no code that path
depends on.

## 8. Test results

Re-verified in full after the second review pass's fix — all numbers
below are from that final run, not the first pass:

| Check | Result |
|---|---|
| `node --check` on every changed `.js` file | clean |
| `node --test --test-concurrency=1` — 14 targeted files (new Step 4 architecture test, Step 2/3 architecture tests, `lite-lazy-shim-necessity`, `shared-cloud-local-manifest`, `tag-onnx.test.js`, `tag-onnx-lazy.test.js`, `tag-onnx-lazy-lite-shim.test.js`, `tag-onnx-capability.test.js`, `onnx-process-isolation.test.js`, `lazy-shim-backward-compat.test.js`, `indexer-settings-writeback.test.js`, `phase-capability-injection.test.js`, `index-capability-wiring.test.js`) | 190/190 pass |
| `node scripts/audit/classify-modules.mjs` | Full-reachable 232, Lite-reachable 143 (PRE- and POST-shim identical), 0 heavy-package-reachable-from-Lite, 0 cloud-imports-local violations — identical to baseline |
| `node scripts/audit/build-shared-cloud-local-manifest.mjs` | 243 modules, category counts identical to baseline (shared 111, mixed 41, local 16, composition 10, tooling 61, cloud 4) |
| `node scripts/audit/find-dependency-violations.mjs` | 0 dependency-direction violations, 0 shared→cloud edges |
| `npm test` | **2837/2837** pass |
| `npm run smoke` | 1316/1316 pass |
| `npm run admin:build` | succeeds, byte-identical bundle sizes to Step 3's own report |
| `npm run admin:build:lite` | succeeds, byte-identical bundle sizes to Step 3's own report |
| `node packages/lite/build.mjs` | OK — 117 files staged, closure validated clean (identical count — both moved files were already excluded before the move) |
| `git diff --check` | clean (exit 0; only pre-existing CRLF-normalization warnings) |
| Lite clean-install acceptance (`clean-install-acceptance.test.js`) | 6/6 pass — `npm ls --all` confirms `onnxruntime-node`/`@huggingface/transformers`/`acorn` absent from the real installed package |
| Live tagging smoke | **executed successfully** (§7) — real tags generated, worker lifecycle correct, cleanup verified (ran before the isolation fix; see §7's own note on scope) |

## 9. Known limitations / carried-forward items

- Three transitional lazy seams remain (`core/ollama-lazy.js`,
  `core/onnx-embed-lazy.js`, `indexer/phases/tag-onnx-lazy.js`) — not
  scheduled for removal until Step 8, unchanged by this step.
  `tag-onnx-lazy.lite.js` (along with its two siblings) remains dead code,
  left in place per this step's own explicit instruction not to remove it
  without Step 8 coordination.
- The pre-existing drift-test gap for `full-lite-module-inventory.json`/
  `full-lite-reachability-summary.json`/`full-lite-import-graph.json` (no
  automated byte-for-byte check, unlike
  `full-lite-module-classification.json`'s own drift test) — carried
  forward from Steps 2 and 3's own reports, still not fixed (out of this
  step's scope). All three were regenerated via their own generator
  scripts (never hand-edited) and confirmed current as of this report.
- This step's own architecture test's real-`fork()` test deliberately
  stops short of exercising `loadModel()`'s own `@huggingface/transformers`
  import (to keep the automated test suite fast and network-free) — the
  live smoke run in §7 is what actually exercises that path end to end,
  and was executed successfully.
- `tag-onnx.js`/`tag-onnx-lazy.js`/`tag-onnx-lazy.lite.js`'s export shape
  changed (bare `addTagsOnnxBatch`/`shutdownOnnxTagWorker` functions →
  `createTagOnnxCapability()` factory) as part of this round's fix — every
  real consumer in this repo was updated (§2.3, §3), but this is a
  genuine breaking change to those three modules' own public API, not
  merely an internal refactor. No external consumers exist today (these
  are internal implementation modules, not part of any published
  package), so this carries no compatibility risk beyond this repo.

## 10. Next step

**Step 5** — relocation of cloud providers, per the Phase 8A plan's own
step ordering. Not started, not scoped, no cloud-provider file touched by
this step.

## 11. Verdict

**PHASE_8B_STEP4_ACCEPT** (second review pass)

The first version of this report claimed `PHASE_8B_STEP4_ACCEPT` for a
design that had NOT actually eliminated the cross-run worker-isolation
gap for `tagOnnx` — coordinator state was still module-scope singleton
state, and the report's own verdict text incorrectly asserted this was
covered by Step 3's `ctx`-threading design, and that the regression test
proved instance isolation when it only proved request correlation within
one shared instance. That verdict is withdrawn; the criteria below
reflect the actual, now-fixed design.

All acceptance criteria met: `tag-onnx.js`/`tag-onnx-worker.js` are
physically under `src/local/indexer/`; the old
`src/indexer/phases/tag-onnx.js`/`src/indexer/workers/tag-onnx-worker.js`
paths no longer exist and no production import resolves to them (verified
via real path resolution, not a heuristic, with a regression-catching
sanity check on the check itself); no compatibility re-export was added
at either old path; Full tagging works through the existing, unmodified
`TagOnnxCapability` contract, now backed by `createTagOnnxCapability()` —
a factory returning a fresh, independent worker lifecycle per call, with
`index-full.js`/`backfill-tags.js` each constructing exactly one instance
of their own at composition time (§3); Lite physically excludes and
structurally never reaches either moved file, PRE- and POST-shim
identically (proven via the real staged tree and real import graph); the
persistent-worker lifecycle contract — lazy creation, per-request
correlation, error/exit handling, shutdown-before-spawn no-op,
repeated-shutdown safety — is confirmed both within one instance AND,
the core requirement this round adds, ACROSS two independently-
constructed instances: shutting one down never kills another's worker,
never rejects another's pending request, and never touches another's own
failure flag (26 behavioral architecture tests, §6, including three
tests specifically constructing two separate `createTagOnnxCapability()`
instances and proving their isolation directly — not inferred from
request correlation within a shared instance); `run.js`'s own comments
were corrected to state accurately what its `ctx`-threading design does
and does not guarantee on its own (§3); architecture audits are clean and
identical to baseline; the closure validator was not weakened (two
now-redundant `EXCLUDE_FILES` entries were removed in favor of the
existing `'local'` directory exclusion, the same net-reduction pattern
Steps 2 and 3 established); full unit, smoke, both admin UI builds, the
Lite package build, and Lite clean-install acceptance are all green (see
§8 for this round's own re-verified counts). Nothing was committed.
