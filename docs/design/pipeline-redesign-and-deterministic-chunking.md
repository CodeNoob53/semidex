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
