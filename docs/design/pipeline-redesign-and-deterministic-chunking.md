# Pipeline Redesign and Deterministic Chunking

Status: implemented decision record (2026-06-10).

All proposals in this document are fully implemented in production code:
`PIPELINE_MODE`, stage A–D pipeline, `Semaphore`/`SerialQueue` concurrency
primitives, deterministic chunk merge without LLM. See `src/indexer/index.js`,
`src/indexer/semaphore.js`, `src/indexer/serial-queue.js`.

This note records the proposed indexing pipeline redesign discussed after the
pipeline bottleneck profiling work.

The goal is to reduce idle time and remove low-value LLM calls from the critical
path. This is not a retrieval ranking feature. It is an indexing architecture
change.

Related documents:

- `docs/pipeline-bottleneck-report.md`
- `docs/design/bge-m3-token-aware-chunking-plan.md`
- `docs/design/skeleton-first-chunking.md`
- `docs/design/skeleton-first-chunking-impl-spec.md`

---

## 1. Current Problem

The current indexer is still shaped around a mostly sequential per-file flow:

```text
chunk -> LLM merge -> context -> tag -> embed -> upsert -> link
```

Even in `PIPELINE_MODE=1`, the current ONNX tag branch still has a strong
barrier:

```text
stageB:
  await Promise.all([
    context via Ollama,
    tags via ONNX worker
  ])

stageC:
  embed starts only after both context and tags are finished
```

This is better than serial `context -> tag`, but it is not the final pipeline
shape. If ONNX tag generation is slower than context generation, tag generation
holds the whole Stage B completion. Worse, because Stage B is guarded by
`ollamaSem`, CPU tag generation can keep the Ollama semaphore occupied after
the Ollama/GPU context work has already finished.

That means the GPU lane can still be blocked by CPU work.

The core issue is not that ONNX tag generation must be faster than Ollama tag
generation. The core issue is resource utilization:

```text
GPU/Ollama lane: context generation
CPU/ONNX lane:   tag generation
CPU/BGE-M3 lane: embedding
```

The old pipeline leaves one or more lanes idle while another lane runs. The new
pipeline should keep independent lanes busy without letting one lane hold a
semaphore that belongs to another lane.

In particular, ONNX tag generation must not hold `ollamaSem`. `ollamaSem` is a
GPU/Ollama resource guard, not a general Stage B guard.

---

## 2. Design Goals

1. Remove LLM merge from the indexing critical path.
2. Use the real BGE-M3 tokenizer for deterministic chunk decisions.
3. Keep chunk boundaries final before any context/tag/embed work starts.
4. Run GPU context generation and CPU tag generation independently.
5. Start embedding as soon as context is ready, without waiting for tags.
6. Wait for tags only before final payload assembly/upsert.
7. Keep graph/link optimization separate from this pipeline change.
8. Make phase timing measurable without mixing queue wait, context, tag, and
   embed timings into misleading labels.

---

## 3. Remove LLM Merge

### 3.1 Current LLM Merge

`src/indexer/phases/context.js` currently has:

- `shouldMerge(chunkA, chunkB)` - Ollama call;
- `mergeChunksWithDecisions(chunks, decideMerge)`;
- `mergeChunks(chunks)` - uses `shouldMerge`;
- `mergeChunksDeterministic(chunks)` - currently equivalent to "never merge",
  then add split overlap.

The LLM merge decision checks adjacent boundary chunks and asks whether they
belong to the same thought.

Problems:

- it adds Ollama calls before context generation can begin;
- it is difficult to benchmark as a quality win;
- earlier overlap ordering caused duplicate text bugs;
- real BGE-M3 token counting now gives a better deterministic basis;
- it is especially undesirable before skeleton-first chunking, where chunk
  quality matters more because per-chunk context may shrink or disappear.

### 3.2 Target Deterministic Merge

Short chunks should be merged inside the chunker, before chunks enter the
pipeline:

```text
if chunk.token_count < MIN_CHUNK_TOKENS:
  merge with previous chunk in the same section
  if it is the first chunk in a section, merge with the next chunk in that section
```

Important invariants:

- never merge across `source_file`;
- never merge across `section`;
- never merge across future skeleton node boundaries;
- merge before adding overlap;
- add overlap only after final chunk boundaries are known;
- reindex `chunkIndex` and `totalChunks` after merge;
- keep empty/heading-only suppression independent from short-chunk merge.

### 3.3 Placement

The deterministic merge belongs in the chunker, not in the pipeline coordinator.

Reason: context/tag/embed should never start on a chunk that might later be
merged. Chunk finalization is part of chunking.

Target structure:

```text
parse/section split
  -> token-aware splitting
  -> deterministic short-chunk merge
  -> final overlap
  -> chunkIndex/totalChunks
  -> pipeline
```

For the current codebase, this likely means changing the production async path
in `src/indexer/phases/chunk.js`, especially `chunkSectionsAsync()` and the
PDF/plain-text branches that build `needsBoundaryCheck` chunks.

`context.js` should keep only context generation and possibly a small overlap
helper during migration. The LLM merge path should be removed or moved to a
benchmark-only legacy helper once deterministic merge is proven.

---

## 4. Target Pipeline Shape

The target per-file flow:

```text
Stage A:
  preflight/hash/skip
  chunk with deterministic merge
  final chunks are now stable

Stage B/C lanes:
  contextPromise = Ollama/GPU context lane
  tagPromise     = ONNX/CPU tag lane

  when contextPromise resolves:
    embedPromise = BGE-M3/CPU embed lane

Commit:
  await embedPromise
  await tagPromise
  assemble payload
  upsert

Stage D:
  optional/narrowed link work
```

Diagram:

```text
chunk/finalize
  |-- context (Ollama/GPU) ----> embed (BGE-M3/CPU) --|
  |-- tags (ONNX/CPU worker) -------------------------|
                                                      |
                                                      v
                                                  payload/upsert
```

The important change:

```text
embed waits for context
embed does not wait for tags
```

Tags are needed for payload, not for embeddings. Therefore tags should not
block embedding.

### 4.1 Current Barrier To Remove

Current ONNX-tag shape:

```js
await ollamaSem.run(async () => {
  await Promise.all([
    contextViaOllama(chunks),
    tagsViaOnnxWorker(chunks)
  ]);
});
```

This is wrong for the target architecture. If tags take longer than context,
the ONNX CPU worker keeps `ollamaSem` occupied even though Ollama/GPU context
generation is already finished. The next file cannot enter context generation
because a CPU task is holding the GPU semaphore.

Correct shape:

```js
const contextPromise = ollamaSem.run(() =>
  contextViaOllama(chunks)
);

const tagPromise = tagQueue.run(() =>
  tagsViaOnnxWorker(chunks)
);

const contextChunks = await contextPromise;
const pointsWithDense = await embedSem.run(() =>
  embedContextChunks(contextChunks)
);

const taggedChunks = await tagPromise;
const payload = assemblePayload(contextChunks, taggedChunks, pointsWithDense);
await commit(payload);
```

This means:

- context is protected by `ollamaSem`;
- tags are protected by the tag worker queue;
- embed starts after context;
- embed does not wait for tags;
- final commit waits for both embed and tags.

---

## 5. Semaphore Model

Current pipeline has:

- `ollamaSem`
- `embedSem`
- serial `linkQueue`

The redesigned pipeline should avoid holding the wrong semaphore while another
lane does unrelated work.

### 5.1 Ollama Semaphore

`ollamaSem` should guard only Ollama context work.

It should not be held while waiting for ONNX tags.

Bad shape:

```js
await ollamaSem.run(async () => {
  await Promise.all([context(), tags()]);
});
```

Better shape:

```js
const contextPromise = ollamaSem.run(() => context());
const tagPromise = tagQueue.run(() => tags());

const contextChunks = await contextPromise;
const embedded = await embedSem.run(() => embed(contextChunks));
const tagged = await tagPromise;
```

### 5.2 Tag Worker Queue

The ONNX tag worker needs a real request queue or request ids before any
concurrency increase is safe.

Current risk:

```text
multiple callers -> one singleton worker -> messages without request_id
```

If two `run` messages are in flight, a `done` response cannot be safely matched
to the caller. Before raising `OLLAMA_STAGE_CONCURRENCY`, fix this with one of:

- serialize `addTagsOnnxBatch()` through a queue;
- add `request_id` to worker messages and resolve the matching promise;
- create a bounded pool of workers, each with one in-flight request.

For v1, a serial tag queue is sufficient and easier to validate.

### 5.3 Embed Semaphore

`embedSem` guards BGE-M3 embedding work.

The current default can remain `EMBED_STAGE_CONCURRENCY=1` until CPU contention
tests justify raising it. BGE-M3 may use only part of the CPU, but multiple
embedding sessions can compete for RAM bandwidth and model loading.

### 5.4 Link Queue

Graph/link work remains serial in this redesign.

Do not combine pipeline restructuring with link optimization. Link is a separate
design problem. See `docs/design/global-search-and-collection-profiles.md` for
the possible query-time replacement direction.

---

## 6. Profiling Requirements

The current profiler is not enough for the redesigned lanes if marks are placed
after `Promise.all()`.

Needed measurements:

- context wall time;
- tag wall time;
- embed wall time;
- context queue wait;
- tag queue wait;
- embed queue wait;
- payload assembly/upsert wall time;
- link wall time.

Do not infer tag timing from a mark placed after both context and tag complete.

Minimum report table:

| Metric | Meaning |
|---|---|
| `context_wait_ms` | time waiting for `ollamaSem` |
| `context_run_ms` | Ollama context generation |
| `tag_wait_ms` | time waiting for tag worker/queue |
| `tag_run_ms` | ONNX tag generation |
| `embed_wait_ms` | time waiting for `embedSem` |
| `embed_run_ms` | BGE-M3 embedding |
| `commit_ms` | Qdrant upsert / payload update |
| `link_ms` | graph/link phase |

For performance benchmarks, run at least two modes:

```text
link disabled or narrowed  -> measure pipeline itself
link enabled               -> measure end-to-end production cost
```

Otherwise the link phase can hide or distort the pipeline result.

---

## 7. Implementation Plan

### Phase 1 - Deterministic Merge In Chunker

- Add token-aware short-chunk merge in `chunk.js`.
- Use the real BGE-M3 token counter on the async production path.
- Preserve sync legacy helper behavior unless tests intentionally migrate it.
- Ensure no cross-section merge.
- Ensure overlap is added only after final boundaries.
- Add smoke tests:
  - short middle chunk merges with previous section-local chunk;
  - first short chunk merges with next section-local chunk;
  - short chunk does not merge across sections;
  - short chunk does not merge across files;
  - overlap is not duplicated after merge;
  - `chunkIndex` and `totalChunks` are correct.

### Phase 2 - Remove LLM Merge From Production Path

- Stop calling `mergeChunks()` in `index.js` production indexing.
- Either remove `shouldMerge()` or move it to a benchmark-only legacy path.
- Keep deterministic/no-LLM merge as the production behavior.
- Update docs/config references so agents do not expect LLM merge.

### Phase 3 - Split Context, Tag, Embed Lanes

- Refactor stage flow so `contextPromise` and `tagPromise` start independently.
- `contextPromise` runs under `ollamaSem`.
- `tagPromise` runs under tag queue/worker, not under `ollamaSem`.
- `embed` starts after context resolves and does not wait for tags.
- Payload assembly waits for both embed and tags.

Pseudo-code:

```js
async function processPreparedFile(prepared) {
  const finalChunks = prepared.rawChunks; // already deterministic-merged

  const contextPromise = ollamaSem.run(() =>
    runBatched(finalChunks, BATCH_SIZE, addContext)
  );

  const tagPromise = tagQueue.run(() =>
    addTagsOnnxBatch(finalChunks)
  );

  const contextChunks = await contextPromise;
  const pointsWithDense = await embedSem.run(() =>
    embedChunks(contextChunks)
  );

  const tagChunks = await tagPromise;
  const chunksWithTags = mergeContextAndTags(contextChunks, tagChunks);

  return assembleForCommit(chunksWithTags, pointsWithDense);
}
```

### Phase 4 - Worker Safety

- Add request queue or request ids to `tag-onnx.js` and
  `tag-onnx-worker.js`.
- Add smoke tests for concurrent `addTagsOnnxBatch()` calls:
  - two calls return correct aligned tags;
  - one failure does not poison later calls;
  - shutdown terminates worker cleanly.

### Phase 5 - Benchmark

Compare:

- old sequential path;
- current pipeline path;
- redesigned lane pipeline;
- redesigned lane pipeline with link disabled/narrowed;
- redesigned lane pipeline with link enabled.

The first performance benchmark must include a link-disabled or link-narrowed
run. Otherwise a 9-22 second link phase can hide whether the pipeline redesign
actually improved context/tag/embed overlap.

Metrics:

- total wall time;
- files indexed;
- points indexed;
- context/tag/embed/link timings;
- queue wait times;
- CPU/GPU utilization if available;
- retrieval sanity check on the resulting collection.

---

## 8. Quality And Safety Invariants

The pipeline redesign must not change retrieval semantics accidentally.

Required invariants:

- same input and same env produce deterministic chunk ids;
- no empty chunks;
- no overlap-only chunks;
- no duplicate overlap text after merge;
- no cross-section merges;
- no tag/context mismatch by index;
- no Qdrant delete before replacement points are ready;
- graph mutations remain serial until graph delta merge exists;
- provider metadata still controls reindexing.

---

## 9. Relationship To Skeleton-First Chunking

This redesign is a bridge to skeleton-first chunking.

Today:

```text
text chunk -> LLM context -> embed(context + text)
```

Skeleton-first likely moves toward:

```text
structural node/prose chunk -> embed authoritative text or node context
```

Per-chunk context may shrink or disappear for ordinary prose. If that happens,
embedding can start immediately after chunking for many node types. This makes
deterministic chunk quality even more important.

Therefore deterministic short-chunk merge should live in the chunker now, not
as a temporary pipeline patch.

---

## 10. Open Questions

1. What exact threshold should trigger short-chunk merge?
   - Candidate: existing `MIN_CHUNK_TOKENS`.
   - Needs benchmark confirmation.

2. Should first short chunk merge with next only when the combined chunk stays
   under `MAX_CHUNK_TOKENS`?
   - Proposed answer: yes.

3. If previous + short exceeds `MAX_CHUNK_TOKENS`, should the short chunk stay
   alone or merge with next?
   - Proposed answer: try next in the same section; otherwise keep it.

4. Should deterministic merge apply to PDF/plain-text fallback chunks too?
   - Proposed answer: yes, as long as source/section boundaries are respected.

5. Should `mergeChunksDeterministic()` remain in `context.js`?
   - Proposed answer: only during migration. Final behavior belongs in
     `chunk.js`.

6. Should link be disabled by default during performance benchmarks?
   - Proposed answer: yes, then run a second benchmark with link enabled.

---

## 11. Expected Result

If implemented correctly:

- no Ollama calls for merge;
- fewer tiny/weak chunks before context generation;
- no CPU tag work holding the Ollama semaphore;
- embed starts as soon as context is ready;
- indexing uses GPU and CPU lanes more continuously;
- benchmarks can attribute speedups to pipeline changes instead of link noise;
- the design remains compatible with skeleton-first chunking.

---

## Addendum (2026-08-08): device-aware bounded pipeline replaces `PIPELINE_MODE`

This document's original scope (§1 above) was **intra-file** overlap only
(context vs. tags within one file's stageB). A later change added
`PIPELINE_MODE=1` as an opt-in that additionally overlapped generation and
embedding **across different files**, but unconditionally — no check of
whether the two stages were actually on independent compute resources.
That made `PIPELINE_MODE=1` unsafe on a single-GPU box running both Ollama
and ONNX embedding: cross-file overlap could put context generation and
embedding on the same physical device at the same time, fighting for the
same VRAM/compute lane instead of actually running in parallel.

This addendum replaces `PIPELINE_MODE`'s cross-file behavior with a
**device-aware bounded pipeline** that is the automatic default for every
multi-file indexing run — not an opt-in env var:

- New modules: `src/shared/indexer/device/resource-identity.js` (resolves
  a verified-or-not `ResourceIdentity` per stage — generation via Ollama's
  real `GET /api/ps` VRAM-placement signal, embedding via ONNX's
  `getOnnxProviderState()` OR the collection's own resolved embedding
  profile execution — `remote` (verified) for Qdrant Cloud/cluster
  server-side inference, never misclassified as local ONNX CPU work —
  tagging as a structural CPU fact), `src/shared/indexer/device/scheduling-policy.js`
  (the pairwise overlap-decision matrix — `verified` is required on both
  sides for any overlap, with ONE deliberate exception: an explicit
  `GENERATION_DEVICE_OVERRIDE` assertion is treated as verified — real,
  informed operator intent — but permanently tagged `source:'manual'` in
  every diagnostic so it is never confused with a genuine runtime read,
  and a real `/api/ps` signal always takes priority over it), and
  `src/shared/indexer/pipeline/bounded-file-pipeline.js` (the actual
  scheduler: three lane semaphores — generation, tagging, embedding, each
  capacity 1 by default — acquired in a fixed generation→tagging→embedding
  order to keep the design deadlock-free, plus a backpressure semaphore
  capping how many files can be prepared-but-uncommitted in memory at
  once). The scheduling policy is read exactly once per file, INSIDE the
  generationSem hold itself, right before that file's stageB starts — not
  as an outer snapshot taken before the file even queues for that permit.
  This closes a real staleness gap: a cohort of files that all queue
  while the signal is still unverified must each be able to escape into
  the overlap-capable code shape once the signal upgrades while they
  wait, not merely refine a decision inside a branch shape already
  committed to from a stale read. The branch itself — whether stageC runs
  inside or outside the generation-lane hold — is chosen from that same
  fresh read, never from an earlier snapshot.
- `buildResourceIdentityInputs()`'s Ollama `/api/ps` calls are routed
  through an already-settled `Promise.resolve().then(...)` before
  `.catch()` is attached, so a rejecting OR synchronously-throwing
  `getRunningModel()` — a composition that does not honor its own
  documented never-throw contract (Semidex Lite's Ollama-unavailable
  stub throws for every method, by design) — is treated exactly like that
  method's own documented `null` return (unresolved), never allowed to
  reject the whole scheduling decision and take an indexing run down
  before stageB even starts.
- `stageB()` (`src/shared/indexer/run.js`) gained one new optional
  parameter, `generationTaggingExecutionMode: 'parallel' | 'sequential'`
  (default `'parallel'`, preserving prior behavior for every caller that
  doesn't pass it), read only by the `TAG_PROVIDER=onnx` branch — the
  bounded pipeline computes this per file from the same freshly
  recomputed scheduling policy that gates the outer lane semaphores.
- The old sequential `indexFile()` function and the old
  `if (pipelineMode) { ... } else { ... }` branch in `main()` were both
  removed — the bounded pipeline is now the only multi-file codepath, and
  degrades to observably-sequential behavior on its own when the policy
  says stages are not on independent resources (no separate "sequential
  mode" implementation to keep in sync).
- **Behavior change, intentional**: `PIPELINE_MODE=1` used to always force
  cross-file overlap. It no longer does — `OLLAMA_STAGE_CONCURRENCY`/
  `EMBED_STAGE_CONCURRENCY`/`STAGEA_CONCURRENCY`/`MAX_PREPARED_FILES_IN_FLIGHT`
  remain as concurrency-tuning env knobs only. Overlap now always depends
  on the device-aware policy, which self-heals across a run as real
  signals become available (embedding is unverified until the first real
  embed call in-process; generation is unverified until the target model
  is actually loaded into Ollama) — in practice this means overlap
  typically engages from roughly the second file onward, not file 1.
- Progress reporting gained one new, additive, optional field —
  `activeStages: Array<{ stage, file }> | null` — surfaced through
  `emitProgress()` and coerced defensively in
  `src/shared/admin/jobs/registry.js`'s `appendLine()`. It is stored on
  the raw job record but deliberately NOT threaded through
  `toProgressSummary()`/the public `GET /api/jobs`/`GET /api/operations`
  shapes — no Admin UI rendering changes were required or made.
- A new settings field, `GENERATION_DEVICE_OVERRIDE` (enum
  `unknown|cpu|gpu`, default `unknown`), is a last-resort fallback for the
  generation resource identity — consulted only when Ollama's real
  `/api/ps` signal is unavailable for every active model this run. Unlike
  every other unverified fallback in this design, an explicit override is
  treated as `verified:true` (still permanently `source:'manual'` in
  diagnostics, never conflated with a real runtime read) — a deliberate
  exception: the operator is making an informed, real claim about their
  own deployment topology and knowingly accepts the risk of an incorrect
  overlap decision if that claim is wrong. A real `/api/ps` read always
  takes priority over this setting the instant one becomes available.

See the file-by-file change list and test suite under
`src/shared/indexer/device/`, `src/shared/indexer/pipeline/`, and their
`tests/unit/indexer/device/`, `tests/unit/indexer/pipeline/` counterparts
for the full implementation.

## Addendum continued (2026-08-11): provider-agnostic capability-driven resource identity

> **Invariant**: No provider-specific branching is allowed in the shared
> scheduling policy. Provider implementations expose normalized resource
> identities through capability contracts.

The addendum above already made cross-file overlap device-aware, but its
own identity layer, `buildResourceIdentityInputs()`, was itself hardcoded
to Ollama's `/api/ps` and ONNX's `onnxProviderState` — the shared device
layer directly imported and called Ollama/ONNX-shaped signals. That was
fine for the two providers semidex had at the time, but it meant every
future provider combination (ONNX generation, cloud generation, cloud
embedding, Qdrant Cloud/cluster server-side embedding, tagging via a
non-ONNX backend) would have required editing the scheduler itself to add
another provider-shaped branch. This addendum closes that gap: the
scheduler and the aggregate resolver are now fully provider-agnostic, and
adding a new provider means adding a capability, never touching the
scheduler.

**`src/shared/indexer/device/resource-identity.js` now contains zero
provider-specific code.** It exports only the `ResourceIdentity` typedef
and one generic aggregate resolver:

```
resolvePipelineResourceIdentities({ generationCapability, embeddingCapability, taggingCapability, env })
  => Promise<{ generation, embedding, tagging }>
```

Every provider's own identity logic — Ollama's VRAM-ratio classification
and active-model selection, ONNX's execution-provider mapping, the ONNX
tag worker's structural CPU fact — now lives inside that provider's own
capability module (`src/local/core/ollama-capability.js`,
`src/local/core/onnx-embed.js`, `src/local/indexer/phases/tag-onnx.js`
respectively), never in `shared/`.

**The uniform contract**, every capability slot the resolver touches,
every provider, no exceptions:

```
getResourceIdentity({ env }) => Promise<ResourceIdentity>
```

`ResourceIdentity`'s shape is unchanged (`{kind, backend, deviceId,
verified, source}`); only `source`'s type widened from a closed enum to
`string | null`, so a new capability can introduce its own source token
without another typedef edit. `resolvePipelineResourceIdentities()` never
imports, names, or special-cases a provider — it calls each injected
capability's own `getResourceIdentity({env})`, and normalizes a missing
capability, a malformed result, a synchronous throw, or a rejected
promise to the same conservative `unknown` identity. A resource-identity
capability must never be able to crash a run merely because discovery is
unavailable.

The one deliberate, narrowly-scoped exception: `OllamaResourceIdentityCapability`
exposes a *second* method, `getEmbeddingResourceIdentity({env, model})`,
used only internally by `EmbeddingResourceIdentityCapability`'s own
implementation (`src/shared/indexer/device/embedding-resource-identity-capability.js`)
when the resolved embedding profile routes through Ollama — because only
the composition layer knows the resolved embedding model name, and only
Ollama's capability can answer both "how is generation placed" and "how
is this named model placed." This non-uniformity is fully contained
inside that one wrapper's own implementation; every capability
`resolvePipelineResourceIdentities` itself ever sees still exposes only
the plain `getResourceIdentity({env})` shape.

**`/api/ps` in-flight deduplication** is an internal optimization private
to `createOllamaResourceIdentityCapability()`'s own closure — an
in-flight-only `Map` keyed by `` `${model}::${baseUrl}` ``, not a
resolved-value cache with any staleness window. Two concurrent calls on
the same instance that need the same model+baseUrl share one in-flight
request; the moment that request settles, its entry is removed
(`.finally()`), so the very next call — even a microtask later — always
issues a fresh real request. There is no TTL and nothing to invalidate.
`resolvePipelineResourceIdentities()` and `run.js`'s own `recomputePolicy`
are completely unaware this exists.

**Remote-provider concurrency is NOT unbounded.** A capability reporting
`kind: 'remote'` unlocks overlap in the scheduler for exactly one reason:
that resource does not contend with a local CPU/GPU device lane. It says
nothing about how many concurrent requests the remote API can actually
sustain. Any future remote generation/embedding/tagging provider must
enforce its own request-rate bound — a dedicated rate limiter or
semaphore inside that provider's own capability implementation, sized to
that provider's real limits — entirely independent of, and invisible to,
the bounded pipeline's device-lane semaphores
(`generationSem`/`taggingSem`/`embeddingSem`), which only ever arbitrate
local device contention. The lane semaphores are not a substitute for a
remote provider's own concurrency control, and vice versa: a
`remote`-classified capability that overlaps freely at the device-lane
level must still gate its own outbound call volume elsewhere. No real
remote provider exists yet in this codebase — this is a documented
boundary so the first one doesn't have to rediscover it.

**Note on an earlier, reversed design**: an intermediate draft of this
work considered a separate `tagging-resource-identity-capability.js` file
with forward-looking constructor parameters (`active`, `provider`,
`onnxRuntime`, `generationResourceIdentity`) for symmetry with the
embedding wrapper. That file was never built — `getResourceIdentity()`
lives directly on `TagOnnxCapability`
(`src/local/indexer/phases/tag-onnx.js`) instead, since the "ONNX tag
worker is structurally CPU-only" fact is real, provider-owned knowledge
with no composition-time parameters to inject. A future second tagging
backend would add its own `getResourceIdentity()` to whatever capability
implements it, following the same pattern — no scheduler change, no new
shared contract.

See `tests/unit/indexer/device/pipeline-resource-identities-provider-agnostic.test.js`
for the direct proof that Ollama+ONNX, ONNX-only, cloud generation +
local embedding, local generation + Qdrant Cloud embedding, fully-cloud,
and two entirely novel/never-before-seen provider name+source
combinations all produce correct overlap decisions through the exact
same resolver and scheduler code, with zero provider-specific branches
anywhere in either.
