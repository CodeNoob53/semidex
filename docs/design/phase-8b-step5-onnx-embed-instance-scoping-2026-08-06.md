# Phase 8B Step 5 — instance isolation of the local ONNX embedding runtime

Implementation report for a Phase 8 migration task titled "Phase 8B Step
5 — Physical relocation and instance isolation of local ONNX embedding
runtime." Builds directly on Step 2's precedent (ONNX embedding runtime
physical relocation,
[`phase-8b-capability-contracts-and-composition-seams-2026-08-02.md`](phase-8b-capability-contracts-and-composition-seams-2026-08-02.md)
§12) and mirrors the exact isolation-gap-and-fix pattern
[`phase-8b-step4-local-tag-onnx-relocation-2026-08-06.md`](phase-8b-step4-local-tag-onnx-relocation-2026-08-06.md)
established for the local ONNX tag-generation runtime one step earlier.
**Nothing was committed** — this is the working-tree state at the end of
this step's own session.

**Naming note**: the task text calls this "Step 5," but per the Phase 8A
plan's own step ordering
([`phase-8a-shared-cloud-local-migration-audit-2026-08-02.md`](phase-8a-shared-cloud-local-migration-audit-2026-08-02.md)
§9), physical relocation of the local ONNX embedding runtime was already
Step 2's work, completed and left in the working tree in an earlier
session (commit boundary not yet crossed — nothing from Step 2 onward has
been committed this cycle either). This step is really "the ONNX-embed
instance-scoping fix," the direct sibling of Step 4's tag-onnx fix,
applied one runtime later in the plan's own sequence. The filename keeps
the task's own "Step 5" label for traceability to the original request.

## 1. Part A — audit finding: physical relocation was already done

Before writing any code, the repo was audited (a background research
agent, then independently re-verified by direct file reads) to map every
production importer, session/tokenizer/batching/provider/worker-state
file, composition root, existing lazy module, existing Lite substitution
shim, and benchmark-only import touching the local ONNX embedding
runtime — per the task's own explicit "do not assume exact files from the
task text" instruction.

**Finding**: `onnx-embed.js`, `onnx-runtime.js`, `onnx-probe-runner.js`,
`onnx-provider-probe.js`, and `length-bucket.js` already live under
`src/local/core/` — moved and committed in an earlier session (commit
`37d322d`). Zero remaining references to the old `src/core/onnx-embed.js`
path exist anywhere in the repo (verified by a repo-wide specifier scan,
not assumed). Part B of the task ("physical relocation") therefore
required **zero file moves this round** — the real, still-open gap was
Parts C through I: the runtime's mutable state was still module-scope,
exactly the same class of problem Step 4 found and fixed for
`tag-onnx.js` one runtime earlier.

## 2. The gap — module-scope mutable state, shared across composition roots

`src/local/core/onnx-embed.js` held its entire runtime as four
module-scope `let` bindings:

```js
let tokenizer    = null;
let session      = null;
let _loadPromise = null;
let _providerState = null;
```

Every real production composition root
(`indexer/index-full.js`, `admin/server-full.js`, `mcp/server.js`)
imported `core/onnx-embed-lazy.js` and passed the **cached module
namespace object itself** as the `onnxEmbed` capability
(`onnxEmbed: onnxEmbedLazy`). Since ES module namespace objects are
singletons per process, this meant every composition root sharing one
Node process shared the exact same ONNX `InferenceSession`, the same
in-flight `_loadPromise`, and the same provider-fallback state — two
independently-composed callers (e.g. a Full app and a second Full app, or
a future concurrent-indexing scenario) were never actually isolated,
regardless of how many "capability" objects each one believed it held.

No `shutdown()`/cleanup method existed at all — the real
`InferenceSession` created by `ort.InferenceSession.create(...)` was
never released via its own documented `session.release()` method
(confirmed via the official ONNX Runtime Node.js docs,
`https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.html`,
and the shared common interface source,
`https://github.com/microsoft/onnxruntime/blob/main/js/common/lib/inference-session.ts`
— `release()` is part of the shared `InferenceSession` interface, not a
web-only API). This was a real, previously-unaddressed native-resource
leak, independent of the instance-isolation question.

## 2A. Code review — two further P1 races found and fixed after initial acceptance

A code review pass on the design described in §3-4 below found two
further real races, both since fixed. Recorded here rather than silently
folded into §3-4's prose, per this report's own precedent of keeping a
corrected design's history visible (see Step 4's report for the same
practice).

**P1 — the lazy wrapper's own first-construction race**
(`core/onnx-embed-lazy.js`): `ensureInstance()` originally memoized only
`_instance`, a binding not assigned until AFTER
`await Promise.all([loadOnnxEmbedModule(), loadLengthBucketModule()])`
resolved. Two concurrent first calls on ONE wrapper object — e.g.
`loadOnnx()` and `loadOnnxBatch()` invoked back to back with no
intervening `await`, or two concurrent `loadOnnx()` calls — both observed
`_instance` still `null`, both proceeded past the guard, and both
constructed a real underlying `local/core/onnx-embed.js` capability
instance (each with its own real ONNX `InferenceSession`). The second
assignment silently overwrote `_instance`, orphaning the first instance —
no reference to it survived anywhere, so its session could never be
released by `shutdown()`, a genuine resource leak triggered by ordinary
concurrent use of one composition root's single `onnxEmbed` capability
object (e.g. two requests both triggering the very first embed call at
once). Fixed by memoizing the in-flight **promise** itself,
synchronously, before any `await` runs — every caller during the
construction window, first or concurrent, awaits the same promise and
receives the same instance (§3 code block above already reflects the
fixed version).

**P1 — `shutdown()` not synchronized with an in-flight `_doLoad()`**
(`local/core/onnx-embed.js`): `shutdown()` originally cleared
`_loadPromise` and returned WITHOUT waiting for it. If `shutdown()` was
called while `_doLoad()` was still mid-flight (e.g. between the tokenizer
download and `ort.InferenceSession.create()`), `_doLoad()` kept running
in the background after `shutdown()` had already returned — and if it
went on to succeed, it assigned a brand-new `session` binding AFTER
`shutdown()` believed the instance was fully torn down. That session's
native resources were never released by anything (a second `shutdown()`
call would see the `if (session)` guard pass and call `release()`, but
nothing guarantees a second call ever happens). Fixed by setting
`_shutdown = true` first (so `load()`'s own `if (_shutdown) throw` guard
prevents any NEW load from starting once shutdown has begun — this part
was already correct, and closes the window cleanly since `load()`'s
own guard-check-then-set is fully synchronous, so there is no way for
`shutdown()` to interleave mid-`load()`), then awaiting any load already
in flight (swallowing its own failure — a load that fails on its own
means no session exists, nothing to release, and shutdown itself must
never throw for that reason) before deciding what to release.

Both fixes were verified to actually catch their own regression: each
was temporarily reverted in place, the corresponding new test was
re-run and confirmed to fail with a clear, on-point assertion message,
then the real fix was restored and the test re-confirmed passing — not
merely "written to pass against working code."

## 3. The fix — `createOnnxEmbeddingCapability()` factory

`src/local/core/onnx-embed.js` now exports a factory. Calling it returns
a fresh object whose entire runtime — `tokenizer`, `session`,
`_loadPromise`, `_providerState`, and a new `_shutdown` flag — lives
inside the factory's own closure, never at module scope:

```js
export function createOnnxEmbeddingCapability({
  ortFactory = loadOnnxRuntime,
  loadTokenizerAndModel = defaultLoadTokenizerAndModel,
} = {}) {
  let tokenizer = null, session = null, _loadPromise = null, _providerState = null, _shutdown = false;
  // ... encodeTexts / _doLoad / load / embedOnnx / embedOnnxBatch, all closing over the above ...
  async function shutdown() {
    _shutdown = true;
    _loadPromise = null;
    if (session) { const s = session; session = null; await s.release(); }
  }
  return {
    async loadOnnx() { return embedOnnx; },
    async loadOnnxBatch() { return { embedOnnxBatch }; },
    getOnnxProviderState() { return _providerState; },
    shutdown,
    __test: { state: () => ({ hasSession: session !== null, hasTokenizer: tokenizer !== null, shutdown: _shutdown }) },
  };
}
```

Two calls to `createOnnxEmbeddingCapability()` return two objects that
share nothing — verified directly (not just by inspection): distinct
object identity, distinct `shutdown` closures, and — the real proof —
shutting down instance A never releases instance B's session, even while
B has a genuinely in-flight request at the exact moment A shuts down (see
§6).

Two new dependency-injection seams were added specifically so unit tests
never touch the real 2.3 GB model cache, per the task's own explicit
instruction: `ortFactory` (overrides the ONNX runtime module/session) and
`loadTokenizerAndModel` (overrides the real tokenizer-download-and-parse
step).

A CUDA-unavailable → CPU-fallback retry path, and the
`isCudaStrict(env)` hard-fail behavior, are unchanged in mechanism — only
relocated into the factory's own closure, exactly as Step 4 relocated
(and did not otherwise alter) `tag-onnx.js`'s own worker protocol.

## 4. The synchronous-seam design constraint

`admin/server-full.js`'s `createApp()` is a synchronous function with 16
existing call sites across production code and tests. Making the
capability factory itself `async` (the first draft) would have forced
`createApp()` to become async too — a large, risky ripple this task's own
"prefer explicit instance-scoped dependencies... do not introduce a large
generic service locator" instruction argued against taking on
unnecessarily.

**Fix**: `core/onnx-embed-lazy.js`'s `createOnnxEmbeddingCapability()` is
itself **synchronous** — it returns a wrapper object immediately. The
real dynamic `import('../local/core/onnx-embed.js')` and the real
factory call are deferred until the first actual method invocation
(`loadOnnx()`/`loadOnnxBatch()`/`shutdown()`), each of which is already
`async`:

```js
export function createOnnxEmbeddingCapability() {
  let _instance = null;
  async function ensureInstance() {
    if (_instance) return _instance;
    const [onnxEmbedMod, lengthBucketMod] = await Promise.all([
      loadOnnxEmbedModule(), loadLengthBucketModule(),
    ]);
    const real = onnxEmbedMod.createOnnxEmbeddingCapability();
    _instance = {
      loadOnnx: real.loadOnnx,
      async loadOnnxBatch() {
        const { embedOnnxBatch } = await real.loadOnnxBatch();
        return { embedOnnxBatch, embedBucketed: lengthBucketMod.embedBucketed };
      },
      getOnnxProviderState: real.getOnnxProviderState,
      shutdown: real.shutdown,
    };
    return _instance;
  }
  return {
    async loadOnnx() { return (await ensureInstance()).loadOnnx(); },
    async loadOnnxBatch() { return (await ensureInstance()).loadOnnxBatch(); },
    getOnnxProviderState() { return _instance ? _instance.getOnnxProviderState() : null; },
    async shutdown() { if (!_instance) return; await _instance.shutdown(); },
  };
}
```

`embedBucketed` (a pure helper from the separate `length-bucket.js`
module) is composed into `loadOnnxBatch()`'s return shape by this lazy
seam, not by `onnx-embed.js` itself — `onnx-embed.js` never imported
`length-bucket.js` and still doesn't; this preserves the exact
`{ embedOnnxBatch, embedBucketed }` shape `core/embeddings.js`'s own
dispatch logic requires, without adding a new cross-module dependency
inside the local runtime file itself.

Every composition root now does, uniformly:

```js
const { createOnnxEmbeddingCapability } = await import('../core/onnx-embed-lazy.js');
const onnxEmbed = createOnnxEmbeddingCapability(); // synchronous, no await
```

## 5. Capability contract change — `shutdown` becomes required

`core/onnx-embed-capability.js`'s `REQUIRED_ONNX_EMBED_CAPABILITY_METHODS`
grew from `['loadOnnx', 'loadOnnxBatch']` to
`['loadOnnx', 'loadOnnxBatch', 'shutdown']`, mirroring the exact
precedent Step 4 established for `TagOnnxCapability`'s own
`shutdownOnnxTagWorker()` requirement — every capability that owns
runtime resources must expose an always-safe no-op cleanup method,
whether or not that runtime was ever actually used.

This rippled to every hand-written or generic-loop "unavailable"
capability builder, each of which needed an explicit no-op `shutdown`
(never a throwing stub):

- `admin/composition/lite.js`'s `unavailableOnnxEmbedCapability()` used a
  generic loop over `REQUIRED_ONNX_EMBED_CAPABILITY_METHODS` to build
  throwing stubs — `shutdown` was special-cased after the loop to
  override it with a real no-op, since a generically-thrown `shutdown`
  would break every caller's unconditional cleanup.
- `indexer/index-lite.js`'s hand-written `unavailableOnnxEmbedCapability()`
  got an explicit `async shutdown() { /* no-op */ }` added alongside its
  existing `loadOnnx`/`loadOnnxBatch` throwing stubs.
- `core/onnx-embed-lazy.lite.js` (the Lite staging shim) got the same
  addition, and was made synchronous to mirror the real seam's new shape.

`indexer/run.js`'s `run({ capabilities })` `finally` block now calls
`await ctx.onnxEmbed.shutdown();` alongside the pre-existing
`await ctx.tagOnnx.shutdownOnnxTagWorker();` — same reasoning, same
comment style as Step 4's own precedent: `run.js` itself never holds or
shares a capability reference; it only ever calls whatever object its
composition root supplied, and what changed is only what that object
now IS (an independently-constructed instance rather than a shared
module namespace).

## 6. New regression test — instance isolation (hermetic, fake session)

`tests/unit/core/onnx-embed-instance-isolation.test.js` (new, **19**
tests across 5 describe blocks, fully hermetic — no real model/tokenizer
touched except in one deliberately-marked describe block using the real
cached tokenizer with a fake session):

- Basic behavior: `loadOnnx`/`loadOnnxBatch` shape, empty-array rejection,
  lazy session creation, session reuse across calls, concurrent-call
  promise-guarding (two simultaneous `loadOnnx()` calls trigger exactly
  one `InferenceSession.create`).
- Provider state and CUDA fallback: `null` before first use, correct CPU
  reporting, and a CUDA-failure-then-CPU-retry path simulated via a fake
  `ortFactory` whose `InferenceSession.create` throws when
  `executionProviders[0] === 'cuda'` — no real CUDA hardware required.
- Shutdown lifecycle: no-op before any session exists; repeated shutdown
  is idempotent; `session.release()` is called **exactly once** even
  under double shutdown; reuse after shutdown throws a clear error rather
  than silently reconstructing state; **(code review, P1, §2A)** a
  dedicated `shutdown()`-called-while-`_doLoad()`-is-still-in-flight test
  — gates the fake `loadTokenizerAndModel()` on an externally-controlled
  promise so the load is GENUINELY still in progress when `shutdown()` is
  invoked, asserts `shutdown()`'s own promise does not resolve while the
  load is still gated, then releases the gate and confirms the session
  the load eventually produces is released exactly once, with a second
  `shutdown()` call afterward still a safe no-op.
- **Two independently-constructed instances have genuinely independent
  state** — the core proof this task requires:

```js
test('shutting down instance A never kills instance B\'s session, and B\'s genuinely
in-flight request still completes successfully', async () => {
  // capA and capB each get their own fake ortFactory/session/releaseCalls array.
  // capB's fake session.run() genuinely awaits an external gate promise —
  // not a simulated ordering, a real one.
  const embedA = await capA.loadOnnx();
  const embedB = await capB.loadOnnx();
  await embedA('warm up A');

  const bPending = embedB('B in-flight request, started before A\'s shutdown');
  await new Promise((resolve) => setTimeout(resolve, 10));

  await capA.shutdown();
  assert.equal(releaseCallsA.length, 1);
  assert.equal(releaseCallsB.length, 0, 'B must not be released while B\'s own request is genuinely still in flight');

  releaseBRun(); // release the gate — B's request completes only now
  const bResult = await bPending;
  assert.equal(bResult.dense.length, 1024);
  assert.equal(releaseCallsB.length, 0);

  await capB.shutdown();
  assert.equal(releaseCallsB.length, 1);
});
```

The gate is a real, externally-controllable promise inside the fake
session's own `run()` method, not a "call before, resolve after"
coincidence — this is the same rigor Step 4's own cross-instance
isolation tests established for `tag-onnx.js`'s worker lifecycle.

Also proven: independent CUDA-fallback provider state per instance, and
independent repeated-shutdown safety (shutting A down twice never affects
B, and B can still be shut down cleanly afterward). A fifth describe
block confirms the real cached BGE-M3 tokenizer still integrates
correctly against a fake session, so the DI seam split (`ortFactory` vs.
`loadTokenizerAndModel`) hasn't silently broken real tokenizer behavior.

## 6A. New regression test — the lazy wrapper's own concurrent-first-call safety (code review, P1, §2A)

`tests/unit/core/onnx-embed-lazy-concurrency.test.js` (new, 6 tests, one
describe block), added specifically to close the gap §2A's first finding
identified: none of the existing tests exercised
`core/onnx-embed-lazy.js`'s OWN `ensureInstance()` logic under real
concurrency — they either tested the real `local/core/onnx-embed.js`
factory directly (§6, bypassing the wrapper entirely) or tested the
wrapper's composition-level wiring via source inspection (§7, which
cannot observe a runtime race).

Testing this wrapper hermetically required a small, deliberate addition:
`createOnnxEmbeddingCapability(_testOnlyRealFactoryOptions)` — an
underscore-prefixed, JSDoc-undocumented parameter forwarded unchanged as
the real factory's own `options` argument. Without it, the wrapper's
`await import('../local/core/onnx-embed.js')` always resolves to the
real module with its real defaults, and exercising this wrapper's own
race at all would require the real 2.3GB model — exactly what the task's
own constraints forbid for unit tests. Production callers never pass
this parameter.

- Two concurrent `loadOnnx()` calls on one wrapper share exactly one
  real underlying instance (asserted both by identical returned function
  references AND by exactly one real `InferenceSession.create()` call) —
  the primary regression proof; confirmed to fail against the
  pre-fix `ensureInstance()` (checked by temporary revert, §2A).
- A `loadOnnx()` and a `loadOnnxBatch()` call issued back to back with NO
  intervening `await` (the exact shape of the original bug) also share
  one instance.
- A `shutdown()` call racing against a still-in-flight first `loadOnnx()`
  call (gated via a controllable `loadTokenizerAndModel` promise, the
  same real-interleaving technique as §6's own gated-session test) waits
  for construction to finish and releases exactly the one session that
  construction produces — never silently no-ops because `_instance` (as
  opposed to `_instancePromise`) was not yet assigned.
- `getOnnxProviderState()` returns `null` (never throws) while
  construction is still in flight, and reflects real state once settled.
- `shutdown()` before any method was ever called remains a true no-op —
  never triggers construction just to shut it down.
- Two SEPARATE wrapper objects never share an `_instancePromise` —
  confirmed independent by distinct `InferenceSession.create()` call
  counts.

## 7. New regression test — composition-level guarantees

`tests/unit/architecture/onnx-embed-instance-scoping.test.js` (new, 9
tests across 6 describe blocks), proving the composition-level
guarantees §6's hermetic tests can't reach on their own:

- `createOnnxEmbeddingCapability()` is exported from
  `local/core/onnx-embed.js`; two calls return two independent objects
  with distinct `shutdown` closures; a source-level sanity check
  confirms none of the four state bindings remain declared at top-level
  module scope (a secondary check, not the sole proof — §6's behavioral
  tests are the real evidence).
- `index-full.js`, `admin/server-full.js`, and `mcp/server.js` each
  import `createOnnxEmbeddingCapability` and construct their own instance
  — never pass the bare `*-lazy.js` module namespace as the capability
  (the exact bug pattern this whole step fixes). `admin/server-full.js`'s
  `createApp()` is also exercised directly, twice in one process,
  confirming it never errors or reuses a shared instance across calls.
- `admin/composition/lite.js` and `indexer/index-lite.js` never import
  `onnx-embed-lazy.js` (real or `.lite.js`) at all, and each one's
  `unavailableOnnxEmbedCapability()` includes the required `shutdown`
  no-op.
- **Full and Lite composition roots construct in either order** — the
  exact pattern Step 3 established for the Ollama lane
  (`phase-8b-step3-local-ollama-relocation-2026-08-05.md`), applied to
  the ONNX-embed lane specifically: `createLiteApp()` then `createApp()`,
  then the reverse order, repeatedly, in one process, with
  `core/embeddings.js`'s own shared module-scope fallback confirmed
  untouched (`embedForIndex()` still rejects with
  `/no onnxEmbed capability available/`) after every construction, in
  both orders — directly satisfying the task's own Part D requirement
  ("Ensure a Full app and Lite app can be constructed sequentially in the
  same process without changing each other's embedding behavior") and
  Part G requirement ("Full and Lite apps can coexist in one process
  without order-dependent behavior").

## 8. Consumers updated (Part E)

| File | Change |
|---|---|
| `indexer/index-full.js` | Constructs `const onnxEmbed = onnxEmbedLazy.createOnnxEmbeddingCapability();` (synchronous) at composition time; passes `onnxEmbed` (not `onnxEmbedLazy`) into `runIndexerCli(...)`. |
| `admin/server-full.js` | `import { createOnnxEmbeddingCapability }` (named, not `import * as`); `const onnxEmbed = createOnnxEmbeddingCapability();` inside `createApp()`. |
| `mcp/server.js` | `const { createOnnxEmbeddingCapability } = await import(...)`; `const onnxEmbed = createOnnxEmbeddingCapability();`; passed into `search.setEmbedQuery()`'s bound closure. |
| `admin/composition/lite.js` | No structural change — already built a fresh object per call; added the `shutdown` no-op override (§5). |
| `indexer/index-lite.js` | Same — added `shutdown` no-op (§5). |

`run.js` itself required no change to its own capability-handling
design (§5) beyond the one added `finally`-block `shutdown()` call — it
never held or shared a capability reference to begin with.

**Benchmark scripts (Part E's own explicit "must not break benchmark
scripts silently" requirement)** — 10 files audited, 8 required fixes
(two distinct existing DI patterns, each preserved):

- `benchmarks/onnx-batch-indexing-bench.js`,
  `benchmarks/external/beir/run-rrf-mini.mjs` — already used explicit
  default-parameter injection (`embedBatch = embedOnnxBatch`); fixed by
  constructing the capability in `main()` and passing
  `embedBatch: embedOnnxBatch` explicitly, with `capability.shutdown()`
  called at the natural end of `main()` (or in a `finally`).
- `benchmarks/external/beir/run-scifact.mjs`,
  `benchmarks/external/fusion/run-rrf-sweep.mjs`,
  `benchmarks/external/fusion/run-weighted-rrf-live.mjs`,
  `benchmarks/external/miracl/run-miracl.mjs`,
  `benchmarks/external/slavic/run-slavic-benchmark.mjs`,
  `benchmarks/external/slavic/run-slavic-weighted-rrf.mjs` — used bare
  module-level function calls scattered across multiple internal
  functions; fixed via a benchmark-file-scoped lazy singleton wrapper
  (`async function embedOnnxBatch(texts) { if (!_embedOnnxBatch) { ... }
  return _embedOnnxBatch(texts); }`) plus a
  `shutdownOnnxEmbedCapability()` called via `.finally()` on the `main()`
  promise chain — safe across each script's own multiple early-return
  paths. A single per-script instance is correct here (out of scope for
  the multi-instance isolation requirement, which targets production
  composition roots, not single-purpose benchmark runs).
- `benchmarks/retrieval/bge-m3-colbert-probe.js`,
  `benchmarks/retrieval/lib/colbert-rerank.js` — confirmed no change
  needed; both only import the still-unchanged pure export
  `resolveOnnxExecutionProviders`.

## 9. Part F — Lite package closure (unaffected this round)

Confirmed via both audit tools, not assumed: since no file physically
moved this round (§1) and no audit script references specific export
names (only file paths), Part F required **zero changes**:

- `node scripts/audit/find-dependency-violations.mjs` — 0
  dependency-direction violations, 0 shared→cloud edges.
- `node packages/lite/build.mjs` — 117 files staged (identical count to
  before this round), closure validated clean.
- `node scripts/audit/classify-modules.mjs` — Full-reachable 232,
  Lite-reachable 143 PRE- and POST-shim (identical), 0 heavy local
  packages reachable from Lite either pre- or post-shim,
  `@huggingface/transformers` correctly reachable from Full roots only,
  0 cloud-imports-local violations.
- Lite clean-install acceptance (`tests/unit/lite/clean-install-acceptance.test.js`,
  the strongest available proof — a real `npm pack` → `npm install` into
  an empty temp dir, package directory made read-only, exercised as an
  actual `npm install -g semidex-lite` user would be) — **6/6 pass**,
  confirming via a real `npm ls --all` that `onnxruntime-node`,
  `@huggingface/transformers`, and `acorn` are genuinely absent from the
  installed package, and that `semidex-lite serve` starts and answers
  `/api/health` from the read-only install.

No ONNX-embed-specific shim became newly unnecessary this round (the
existing `core/onnx-embed-lazy.lite.js` staging shim's necessity is
unchanged — it remains excluded from the Lite build by
`packages/lite/build.mjs`'s own `EXCLUDE_FILES` list, same as before);
nothing was removed.

## 10. Test results

| Check | Result |
|---|---|
| `node --check` on every changed `.js` file (10 core files + 8 benchmark files) | clean |
| `node --test --test-concurrency=1` — 21 targeted files (both original new test files, the new `onnx-embed-lazy-concurrency.test.js` (§2A/§6A), all fixed existing test files, all related architecture/capability-wiring tests) | **254/254** pass |
| `node scripts/audit/find-dependency-violations.mjs` | 0 dependency-direction violations, 0 shared→cloud edges |
| `node scripts/audit/classify-modules.mjs` | Full-reachable 232, Lite-reachable 143 (PRE- and POST-shim identical), 0 heavy-package-reachable-from-Lite, 0 cloud-imports-local violations — identical to baseline |
| `node packages/lite/build.mjs` | OK — 117 files staged, closure validated clean |
| `npm run admin:build` | succeeds — `285.51 kB` JS bundle (`85.83 kB` gzip) |
| `npm run admin:build:lite` | succeeds — `279.79 kB` JS bundle (`84.39 kB` gzip) |
| `npm test` | **2875/2875** pass |
| `npm run smoke` | **1316/1316** pass |
| `node --test --test-concurrency=1 tests/unit/lite/clean-install-acceptance.test.js` | **6/6** pass — real packed/installed tarball, `onnxruntime-node`/`@huggingface/transformers`/`acorn` confirmed absent |
| `git diff --check` | clean (exit 0; only pre-existing CRLF-normalization warnings) |

**Test files fixed for the new API shape** (12): `onnx-embed-capability.test.js`,
`onnx-embed-lazy-lite-shim.test.js`, `lazy-shim-backward-compat.test.js`,
`index-capability-wiring.test.js`, `phase-capability-injection.test.js`
(a real production bug caught here — see below),
`server-capability-wiring.test.js`, plus 6 files confirmed to need no
change after inspection (comment-only or structurally unrelated
mentions).

**Real production bug found via test-writing, not inspection**:
`tests/unit/indexer/phase-capability-injection.test.js`'s own
`makeCapabilities()`/`makeSharedCapabilities()` fake-capability helpers
were missing `shutdown` on their `onnxEmbed` fakes. These tests call the
REAL `run()` function, whose `finally` block now unconditionally calls
`ctx.onnxEmbed.shutdown()` — running these tests unfixed would have
produced a real `TypeError: ctx.onnxEmbed.shutdown is not a function`.
Fixed by adding `shutdown: async () => {}` to both helpers. This is
exactly the class of gap the task's own Part G explicitly warned against
("Do not satisfy isolation requirements using source regex alone").

**Two further P1 races found by code review after initial acceptance**
(§2A) — the lazy wrapper's own concurrent-first-call race in
`core/onnx-embed-lazy.js`, and `shutdown()` not synchronized with an
in-flight `_doLoad()` in `local/core/onnx-embed.js` — were fixed, and
each fix's own regression test was verified to genuinely fail against a
temporarily-reverted version of that fix before being confirmed passing
against the real one (not merely "written to pass"). This added 1 test
to `onnx-embed-instance-isolation.test.js` (18 → 19) and one new file,
`onnx-embed-lazy-concurrency.test.js` (6 tests), accounting for the
count increases above (247 → 254 focused; 2868 → 2875 full suite).

## 11. Live acceptance smoke (Part H) — executed, with explicit pre-approval

Per the task's requirement, the exact plan (disposable collection with a
unique prefix, one tiny Markdown fixture, real cached BGE-M3 ONNX
embedding, one hybrid query, clean resource release, delete only the
disposable collection, plus a separate Lite-build check) was presented
for approval before running anything real.

**Indexing**: `ONNX_EMBED=1 COLLECTION=semidex-onnx-embed-smoke-<unix-ts>
node src/indexer/index-full.js <fixture.md>` — a two-section Markdown
fixture containing the unique anchor phrase "purple quokka telescope".
Ran successfully against the real embedding-lane collection prefix, on
the environment's configured Qdrant Cloud cluster (the only Qdrant
endpoint configured in this environment — `QDRANT_URL` in `.env` points
at a Cloud cluster, not a local instance). Result: collection created
fresh with the correct dense/sparse provider metadata
(`bge-m3-onnx/aapot/bge-m3-onnx`), 3 chunks embedded using the real
cached model (`[onnx] ready. outputs: dense_vecs,sparse_vecs,colbert_vecs`,
CPU provider — no CUDA requested or forced), 3 content points + 4
skeleton-nav points upserted, indexer exited cleanly.

**Search**: a small one-off script exercising the exact real production
call shape `mcp/server.js` itself uses
(`runHybridSearch({ adapter, collection, query, top, embedQuery:
(profile, query) => embedForSearch(profile, query, { capabilities: {
onnxEmbed } }) })`, with `onnxEmbed` a real
`createOnnxEmbeddingCapability()` instance) queried "purple quokka
telescope" against the disposable collection. **3 hits returned**, RRF
scores in the documented-normal range (0.0164–0.0333) — confirming both
dense and sparse vectors were written correctly and are genuinely
searchable via hybrid RRF, not merely present in the collection.
`onnxEmbed.shutdown()` was called in a `finally` block and completed
without error, releasing the real `InferenceSession`.

**Cleanup**: the disposable collection was deleted immediately after,
via the storage adapter's own `deleteCollection()` (the same one
`store.js`/`qdrant-adapter.js` expose to production code) — guarded by a
hard prefix check (`semidex-onnx-embed-smoke-`) in the cleanup script
itself, refusing to run against anything outside that prefix. No
pre-existing collection was read, written, or deleted at any point.

**Lite build — no local model touched**: file mtimes under `models/`
(the real `ONNX_CACHE_DIR`) were captured before and after
`node packages/lite/build.mjs`, and diffed — **zero files changed**. The
Lite build staged 117 files and validated its closure clean without
creating, downloading, or reading a single byte under the local model
cache directory.

Note on scope, mirroring Step 4's own §7 note: this smoke run exercised
the real, already-cached model against a real (Cloud) Qdrant cluster —
the single-instance production topology this fix's own composition-level
guarantees are additive to, not a replacement for. The cross-instance
isolation guarantee itself (§6) is proven by the 18 hermetic unit tests,
which deliberately never touch the real 2.3 GB model, per the task's own
instruction; the live smoke's job is to confirm the real model/session
still functions correctly end to end after the closure/shape changes,
which it does.

## 12. Documentation updated

- This report (new).
- `docs/design/semidex-lite-package-boundary.md` — reviewed; no
  ONNX-embed-specific content required a factual update (the boundary
  description was already accurate for the post-Step-2 relocated path;
  this round changed export shape, not location or boundary).
- `docs/en/project-structure.md` — reviewed; `src/local/core/onnx-embed.js`
  was already listed at its Step-2-relocated path; no path change this
  round.
- `docs/design/artifacts/full-lite-import-graph.json`,
  `full-lite-module-inventory.json`,
  `full-lite-reachability-summary.json`,
  `scripts/audit/full-lite-module-classification.json` — regenerated via
  their own generator scripts (`classify-modules.mjs`,
  `build-shared-cloud-local-manifest.mjs`), never hand-edited; confirmed
  byte-consistent with the pre-existing baseline (same counts reported in
  §9/§10 above) since no file moved and no reachability edge changed.

## 13. Known limitations / carried-forward items

- The transitional lazy seam `core/onnx-embed-lazy.js` (and its `.lite.js`
  sibling) remains — not scheduled for removal until Step 8, unchanged in
  status by this step. Its necessity was re-verified, not assumed: it is
  still `index-full.js`'s and `admin/server-full.js`'s and
  `mcp/server.js`'s one real import path to the local implementation.
- The live acceptance smoke ran against the environment's configured
  Qdrant Cloud cluster rather than a local Qdrant instance — the only
  Qdrant endpoint available in this environment. This does not weaken the
  proof (the embedding/session lifecycle under test is entirely local and
  provider-independent of which Qdrant endpoint receives the resulting
  vectors), but is noted for completeness since the task's own wording
  assumed a locally-reachable instance was available.
- As with Step 4's own report, the pre-existing drift-test gap for the
  three generated artifact JSON files (no automated byte-for-byte check,
  unlike `full-lite-module-classification.json`'s own drift test) is
  carried forward, unfixed, out of this step's scope.

## 14. Verdict

**PHASE_8B_STEP5_ACCEPT** (second review pass)

A code review after initial acceptance found two further real races
(§2A) that the first pass's own tests did not cover: the lazy wrapper's
own concurrent-first-call construction race, and `shutdown()` racing an
in-flight `_doLoad()`. Both are now fixed, each fix's regression test was
verified against a temporary revert to confirm it genuinely catches the
bug it targets, and full verification was re-run end to end afterward
(§10) — all counts in this report reflect that final, post-review state.

All acceptance criteria met: the local ONNX embedding implementation
physically lives under `src/local/core/onnx-embed.js` (relocated in an
earlier session; re-verified, not re-done, this round); no old
compatibility implementation or re-export exists at the former
`src/core/onnx-embed.js` path; the Lite package contains and structurally
cannot reach the real local implementation, confirmed both by the static
closure validator/audit tooling AND by a real packed-and-installed
tarball's own `npm ls --all` output; Full and Lite composition roots use
explicit capability composition (`createOnnxEmbeddingCapability()`
constructed once per composition root, never a shared module namespace);
all previously-module-scope mutable runtime state (`tokenizer`, `session`,
`_loadPromise`, `_providerState`, plus a new `_shutdown` flag) is now
closure-scoped inside the factory; two capability instances are
behaviorally proven independent, including the critical genuinely-in-flight-
request-survives-the-other-instance's-shutdown case; Full local ONNX
indexing and hybrid search were re-verified end to end against a real
Qdrant cluster using the real cached model, including a real
`session.release()` on clean shutdown; full verification — focused tests,
full unit suite, smoke suite, both admin UI builds, the Lite package
build, dependency/reachability audits, and the Lite clean-install
acceptance suite — is entirely green. Nothing was committed.
