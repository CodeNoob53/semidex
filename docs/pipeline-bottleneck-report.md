# Semidex Indexing Pipeline — Bottleneck Analysis

**Prepared for:** Codex
**Date:** 2026-06-03
**Status:** bottleneck confirmed from real phase profiling (`INDEX_PROFILE=1`)

---

## 1. Current pipeline (sequential)

`src/indexer/index.js:408`:

```js
for (const filePath of files) {
  const status = await indexFile(filePath, rootPath, collection, linkTargetCollections, graph);
}
```

Each file completes all 5 phases before the next file starts. Inside `indexFile`, phases are strictly sequential with `await` at each step.

**Phase map:**

| Phase | Code location | Worker | Notes |
|---|---|---|---|
| A: pre/hash/chunk/finalize | `index.js:100–135` | CPU + I/O | SHA-256, `chunkFileFromPath()`, deterministic short-fragment merge + overlap |
| B: context | `index.js:131–135` | Ollama GPU | `runBatched(..., addContext)` |
| B: tag | `index.js:137–148` | Ollama GPU | `addTagsBatch(...)` |
| C: embed+upsert | `index.js:163–181` | ONNX CPU + Qdrant I/O | `embedForIndexBatch(...)` |
| D: link | `index.js:183+` | CPU | `buildLinks()`, mutates in-memory graph |

Graph is loaded once before the loop (`index.js:407: loadGraph`) and saved once after (`index.js:412: saveGraph`). Graph mutation (`removeFile`, `addFile`) happens inside `indexFile` on the shared in-memory object.

---

## 2. Measured phase timings (INDEX_PROFILE=1)

Three representative files profiled on 2026-06-03. Hardware: RTX 3080 10GB VRAM, CPU 6 threads active, ONNX_EMBED=1.

### File 1 — small (7 chunks, ~1828 tokens)

```
pre               531 ms
chunk             413 ms
context          7736 ms   ← Ollama GPU
tag              3301 ms   ← Ollama GPU
embed+upsert     9574 ms   ← ONNX CPU + Qdrant
link             4792 ms   ← CPU
total           26351 ms
```

**Ollama active: 11037 ms (42%). Ollama idle (embed+upsert+link): 14366 ms (55%).**

### File 2 — medium (24 raw → 20 finalized chunks, ~6132 tokens)

```
pre               497 ms
chunk            4278 ms
context         17890 ms   ← Ollama GPU
tag              9069 ms   ← Ollama GPU
embed+upsert    21829 ms   ← ONNX CPU + Qdrant
link            14174 ms   ← CPU
total           67746 ms
```

**Ollama active: 26959 ms (40%). Ollama idle (embed+upsert+link): 36003 ms (53%).**

### File 3 — large (48 raw → 41 finalized chunks, ~13491 tokens)

```
pre               490 ms
chunk           13334 ms
context         36086 ms   ← Ollama GPU
tag             21357 ms   ← Ollama GPU
embed+upsert    43264 ms   ← ONNX CPU + Qdrant
link            22363 ms   ← CPU
total          136911 ms
```

**Ollama active: 57443 ms (42%). Ollama idle (embed+upsert+link): 65627 ms (48%).**

### Summary across all three files

| File size | Total | Ollama (B) | embed+upsert (C) | link (D) | GPU idle fraction |
|---|---|---|---|---|---|
| Small (7 ch) | 26.4 s | 11.0 s (42%) | 9.6 s (36%) | 4.8 s (18%) | **55%** |
| Medium (20 ch) | 67.7 s | 26.9 s (40%) | 21.8 s (32%) | 14.2 s (21%) | **53%** |
| Large (41 ch) | 136.9 s | 57.4 s (42%) | 43.3 s (32%) | 22.4 s (16%) | **48%** |

**Conclusion: GPU is idle roughly half the time per file.** The idle time is split between embed+upsert (C) and link (D). Both run on CPU while Ollama does nothing.

Note: `link` phase is surprisingly long (14–22 s on medium/large files). This is likely `buildLinks()` scanning wikilinks across many chunks — it scales with chunk count. This is an additional overlap opportunity beyond embed+upsert.

---

## 3. Root cause

### 3.1 GPU idle inside one file (primary bottleneck)

```
One file:
  GPU (Ollama):  [=context=][=tag=][         idle ~50% of file time         ]
  CPU (ONNX):    [  idle   ][ idle][=embed+upsert=][=link=]
```

The Ollama phases (B) and the CPU phases (C, D) do not overlap at all within a single file. Phases are sequential `await` calls in `indexFile`.

### 3.2 No overlap between files (secondary bottleneck)

```
File N:   [A]─[B]─[C]─[D]
File N+1:                   [A]─[B]─[C]─[D]   ← starts only after N completes
```

File N+1 does not begin its CPU-only phase A (chunk/hash) until file N has fully completed all phases including D (link). This is confirmed by the sequential `for...await` loop at `index.js:408`.

---

## 4. REJECTED approach — naive `indexFile()` concurrency

The following pattern is **not recommended**:

```js
// REJECTED — do not implement
const results = await Promise.all(
  files.map(f => indexFile(f, ...))
);

// Also rejected:
indexFile(filePath, ...).then(...) // producer-consumer with concurrency=2 over whole indexFile()
```

**Why this is unsafe:**

1. `indexFile()` contains Ollama phase B internally. Running two `indexFile()` calls concurrently sends two complete file workloads to Ollama simultaneously.
2. `runBatched(..., LLM_BATCH_SIZE)` inside `indexFile` already sends multiple chunk-level requests to Ollama concurrently. Stacking file-level concurrency on top causes Ollama to receive bursts of requests from multiple files at once — GPU queue buildup, not clean pipeline overlap.
3. Graph mutation (`removeFile`, `addFile`, `buildLinks`) inside `indexFile` writes to a shared in-memory object (`graph` from `index.js:407`). Concurrent `indexFile()` calls would race on graph reads and writes — no synchronization exists.
4. Qdrant delete (`deleteBySourceFile`) before upsert is not atomic. Two files deleting and upserting concurrently can produce transient missing-chunk windows.

---

## 5. Correct approach — stage-based pipeline

Split `indexFile()` into discrete stages and overlap only adjacent stages across consecutive files.

### Stage definitions

```
Stage A  preflight / read / hash / chunk / merge    CPU + I/O     ~0.5–14 s
Stage B  context + tag generation                   Ollama GPU    ~11–57 s
Stage C  embed + Qdrant upsert                      ONNX CPU      ~10–43 s
Stage D  graph / link updates                       CPU (serial)  ~5–22 s
```

### Overlap model

```
File N:   [A]──[B]──────[C]──────[D]
File N+1:       [A]──[B]──────[C]──────[D]
File N+2:             [A]──[B]──────[C]──────[D]
```

**Key constraints:**

- Stage B has its own semaphore. Default concurrency: `OLLAMA_STAGE_CONCURRENCY=1`. This prevents multiple files from sending Ollama requests at the same time.
- Stage C has its own semaphore. Default concurrency: `EMBED_STAGE_CONCURRENCY=1`. ONNX is CPU-bound; running two embed batches concurrently on the same CPU threads brings no benefit and increases memory pressure.
- Stage D (graph/link) must remain **serial** in pipeline v1. The shared in-memory `graph` object from `src/core/graph.js` has no locking — concurrent mutation from multiple files is unsafe.
  - **Recommendation for v1: serial Stage D queue (Option A).** Each file's Stage D runs after its Stage C completes, but only one file runs Stage D at a time.
  - Stage D is **not free**. Profiling shows it takes 4.8 s (small), 14.2 s (medium), 22.4 s (large) — **16–21% of total file time**. It scales with chunk count, likely due to `buildLinks()` scanning wikilinks across many chunks.
  - A serial Stage D queue is the safest MVP, not necessarily the fastest final design. After pipeline v1 is stable, measure whether Stage D becomes the new throughput bottleneck. If it does, handle link optimization as a **separate follow-up task** — do not combine with the pipeline implementation. Options for that follow-up:
    - deferred link phase: build all links after all files are embedded, not inline
    - graph delta merge: each file produces a delta, merged once at the end
    - `LINK_BUILD=0` flag to disable link phase for bulk imports
    - narrowing `LINK_COLLECTIONS` to reduce cross-collection searches
    - batching or reducing Qdrant link searches inside `buildLinks()`

> **Do not combine pipeline implementation with link optimization.** First make the stage pipeline correct and measurable. Link optimization is a separate follow-up. Reason: pipeline changes are already risky; link graph correctness matters; changing both at once makes benchmark attribution unclear.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PIPELINE_MODE` | unset | When unset: current sequential behavior unchanged |
| `OLLAMA_STAGE_CONCURRENCY` | `1` | Max concurrent files in Stage B |
| `EMBED_STAGE_CONCURRENCY` | `1` | Max concurrent files in Stage C |

When `PIPELINE_MODE` is unset, the existing `for...await` loop runs as before. No behavior change for existing users.

### Implementation sketch

```js
// src/indexer/index.js — replaces the sequential for-loop when PIPELINE_MODE=1

import { Semaphore } from './semaphore.js'; // to be implemented

const ollamaSem = new Semaphore(OLLAMA_STAGE_CONCURRENCY);
const embedSem  = new Semaphore(EMBED_STAGE_CONCURRENCY);
const linkQueue = new SerialQueue(); // Stage D always serial

async function indexFilePipelined(filePath) {
  // Stage A: CPU only, no semaphore needed
  const prepared = await stageA(filePath); // hash check, chunk, merge
  if (prepared.skip) return 'skipped';

  // Stage B: Ollama GPU, semaphore-guarded
  const tagged = await ollamaSem.run(() => stageB(prepared));

  // Stage C: ONNX CPU + Qdrant, semaphore-guarded
  const upserted = await embedSem.run(() => stageC(tagged));

  // Stage D: graph/link, always serial
  await linkQueue.run(() => stageD(upserted, graph));

  return 'indexed';
}

// Launch all files; A starts immediately for each, B/C/D are rate-limited by semaphores
await Promise.all(files.map(f => indexFilePipelined(f)));
saveGraph(graph, COLLECTION);
```

**This is different from `concurrency=2` over whole `indexFile()`:** each stage has its own concurrency limit. Stage B never has more than `OLLAMA_STAGE_CONCURRENCY` files active regardless of how many files are in Stage A or C.

---

## 6. Expected gain

From the profiling data, the maximum theoretical speedup from overlapping Stage C of file N with Stage B of file N+1:

| File size | Stage B | Stage C | Overlap saving (min of B, C) |
|---|---|---|---|
| Small (7 ch) | 11.0 s | 9.6 s | up to 9.6 s saved |
| Medium (20 ch) | 26.9 s | 21.8 s | up to 21.8 s saved |
| Large (41 ch) | 57.4 s | 43.3 s | up to 43.3 s saved |

Theoretical max speedup per consecutive file pair: ~32–36% of total file time.

**Realistic estimate: 20–35% overall throughput improvement** on mixed corpora, measured as total wall-clock time for a full collection.

This is a **hypothesis** — must be measured after implementation. Failure cases:

- If Ollama remains the dominant bottleneck (Stage B >> Stage C), the overlap saving is bounded by Stage C time, which is smaller. Speedup is reduced.
- If Qdrant write latency spikes (network, cloud instance throttling), Stage C elongates and reduces the overlap window.
- If `DML` GPU embedding is enabled instead of ONNX CPU, Stage C moves partly to GPU and may contend with Ollama for GPU resources — concurrency should be reduced or disabled.
- Stage D (link) takes 16–21% of total file time and runs serially. On large files (22 s Stage D vs 43 s Stage C), it can reduce effective pipeline overlap. If Stage D becomes the new bottleneck after pipeline v1 ships, address it as a separate task — see section 5.

---

## 7. Acceptance criteria for future implementation

- [ ] Default behavior unchanged when `PIPELINE_MODE` is unset — existing sequential loop runs as before
- [ ] No more than `OLLAMA_STAGE_CONCURRENCY` (default: 1) files active in Stage B at any time
- [ ] No more than `EMBED_STAGE_CONCURRENCY` (default: 1) files active in Stage C at any time
- [ ] Stage D (graph/link) serialized — no concurrent mutation of the shared `graph` object (`src/core/graph.js`)
- [ ] Graph file output (`graph.<collection>.json`) is byte-stable or semantically identical vs sequential run on same input
- [ ] No duplicate or stale Qdrant points after a clean run (verify with `qdrant_collection_info` point count before/after)
- [ ] No stale points after an interrupted run followed by re-run (Qdrant delete before upsert must remain atomic per file)
- [ ] Same retrieval benchmark results within stable ordering tolerance (run existing benchmark suite)
- [ ] Profiler (`INDEX_PROFILE=1`) shows reduced inter-file idle gap or improved total wall-clock time vs sequential on same corpus

---

## 8. Future optimization — tag provider on CPU (separate task)

Moving tag generation from Ollama GPU to a lightweight CPU model is a separate optimization from the stage-based pipeline.

**Why it is separate:**

- It changes tag quality and behavior (different model, possibly different tag vocabulary or language handling).
- It requires its own benchmark to validate retrieval quality is not degraded.
- It is not required to implement or validate the stage-based pipeline overlap — the pipeline design works identically whether tags come from Ollama or a CPU model.

**Relevant context when that task is scoped:**

- Current tag prompt is English-only (`src/indexer/phases/tag.js:24`). Tags are always English regardless of source language (Ukrainian text → English tags). This is intentional for payload filtering.
- Tag phase measured at 3.3–21.4 s depending on file size (same scale as context phase).
- Moving tags to CPU would reduce Stage B time by ~30–37% (tag / (context + tag)), making Stage B shorter and reducing the theoretical maximum overlap gain — but freeing GPU for context generation to potentially run faster.
- Candidate env: `TAG_PROVIDER=onnx`, keeping `TAG_PROVIDER=ollama` as default.
- Hardware: 10 GB VRAM, 6 CPU threads currently ~30% utilized during ONNX embed phase — CPU headroom exists.

Implement after stage pipeline is stable and benchmarked.

---

## 9. Implementation boundary for pipeline v1

This task covers exactly:

- Split `indexFile()` into stage functions (`stageA`, `stageB`, `stageC`, `stageD`)
- Add `PIPELINE_MODE` env gate — existing sequential loop unchanged when unset
- Add `Semaphore` for Stage B (`OLLAMA_STAGE_CONCURRENCY=1`)
- Add `Semaphore` for Stage C (`EMBED_STAGE_CONCURRENCY=1`)
- Add serial `SerialQueue` for Stage D
- Wire into `Promise.all` launcher

This task does **not** cover:

- Tag provider changes (`TAG_PROVIDER=onnx`) — separate future task
- Link algorithm changes (`buildLinks` optimization, deferred linking, delta merge) — separate follow-up after v1 is measured
- Qdrant client changes
- Chunker changes
- Any retrieval or scoring logic

Measure Stage D wall-clock time after v1 ships. Only then decide if link optimization is warranted.

---

## 10. Files to change

| File | Change |
|---|---|
| [src/indexer/index.js](src/indexer/index.js) | Split `indexFile()` into `stageA/B/C/D`, add `PIPELINE_MODE` gating, semaphore-guarded `Promise.all` |
| `src/indexer/semaphore.js` | New: simple async semaphore (~20 lines) |
| `src/indexer/serial-queue.js` | New: serial async queue for Stage D (~15 lines) |
| [src/core/graph.js](src/core/graph.js) | No changes needed if Stage D is serial |
| [src/indexer/phases/tag.js](src/indexer/phases/tag.js) | No changes needed for pipeline task — future `TAG_PROVIDER` work is separate |

No changes to chunker, embedder, or Qdrant client required.
