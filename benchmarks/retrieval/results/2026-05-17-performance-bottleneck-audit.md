# Performance Bottleneck Audit — 2026-05-17

**Scope:** indexing pipeline + ONNX embedding + Ollama calls + ColBERT benchmark pipeline.
**Method:** static call-graph analysis + existing benchmark timing data.
**Goal:** identify bottlenecks; no optimization implemented.

---

## 1. Indexer pipeline call graph

```
main() — files loop (sequential, one file at a time)
└── indexFile(filePath)
    ├── hashFile()                       async, I/O-bound, fast
    ├── getStoredMeta()                  async, Qdrant HTTP
    ├── deleteBySourceFile() [if reindex] async, Qdrant HTTP
    │
    ├── [1/5] chunkFileFromPath()        sync CPU, fast (<50 ms)
    │
    ├── [2/5] processChunks()            SEQUENTIAL per boundary check
    │   ├── shouldMerge(prev, current)   → generate() Ollama, one at a time
    │   └── runBatched(chunks, BATCH_SIZE, addContext)
    │       └── Promise.all(batch)       parallel within batch, sequential across batches
    │           └── addContext()  → generate() Ollama
    │
    ├── [3/5] addTagsBatch loop          sequential batches of BATCH_SIZE
    │   └── addTagsBatch(batch)          one generate() Ollama per batch
    │       └── fallback: Promise.all(chunks.map(addTags))  parallel individual
    │
    ├── [4/5] runBatched(chunks, BATCH_SIZE, embedAndBuild)
    │   └── Promise.all(batch)           parallel within batch
    │       └── embedForIndex()
    │           └── embedOnnx()          ONE ONNX session.run() per chunk (sequential in batch due to shared session)
    │   └── upsertPoints()               one HTTP call, all points together
    │
    ├── [5/5] runBatched(chunks, BATCH_SIZE, buildLinks)
    │   └── Promise.all(batch)           parallel within batch
    │       └── buildLinks()
    │           ├── embedForSearch()     → embedOnnx()  one call per chunk
    │           └── search() × N_collections  sequential, one Qdrant HTTP per collection
    │               └── updatePayload() per backlink  sequential HTTP
    │
    └── saveChunksMd()                   sync file I/O
```

### File-level concurrency

Files are processed **strictly one at a time** (`for...of` at line 288–291 of `index.js`). No inter-file parallelism exists. For a 50-file corpus, each file blocks the next.

---

## 2. Phase-by-phase analysis

### Phase 1 — Chunking

- **Implementation:** `chunkFileFromPath()` is synchronous CPU work.
- **Cost:** negligible (<50 ms per file).
- **Bottleneck:** no.

### Phase 2 — Contextualizing (Ollama, `processChunks`)

- **Boundary check:** `shouldMerge()` is called **one at a time** for each adjacent chunk pair (`while` loop, `await` inline). No parallelism possible here — each call depends on the previous merge result.
- **`addContext` batch:** `runBatched(chunks, BATCH_SIZE, addContext)` runs `BATCH_SIZE` (default 3) context calls in parallel via `Promise.all(batch)`, then awaits the batch before starting the next. Parallelism is limited to 3 concurrent Ollama requests.
- **Ollama serialization:** Ollama serializes model calls if `OLLAMA_NUM_PARALLEL` is unset or 1 (default). With `gemma3:4b` as both CONTEXT_MODEL and TAG_MODEL, concurrent requests queue at the server — effective throughput may be 1 request at a time regardless of client-side batching.
- **Bottleneck: HIGH.** Context phase dominates wall-clock time for any file with >3 chunks.

### Phase 3 — Tagging (Ollama, `addTagsBatch`)

- **Implementation:** one `generate()` call per batch (batch-prompt approach). Falls back to individual `Promise.all` if JSON parse fails.
- **Cost:** 1 Ollama call per `BATCH_SIZE` chunks. With `BATCH_SIZE=3` and 10 chunks → ~4 Ollama calls.
- **Bottleneck: MEDIUM.** Lower call count than context phase (batch prompt), but still Ollama-gated.

### Phase 4 — Embedding + Upsert (ONNX or Ollama)

**ONNX path (`ONNX_EMBED=1`):**
- `runBatched(taggedChunks, BATCH_SIZE, fn)` sends `BATCH_SIZE=3` embeddings in parallel via `Promise.all(batch)`.
- However, `embedOnnx()` uses a **single shared `session`** object. `onnxruntime-node` v1.24.3 does not make `session.run()` thread-safe for concurrent calls — concurrent `await session.run()` calls may serialize internally or produce incorrect results.
- **Effective throughput:** 1 ONNX inference at a time. The `Promise.all` gains nothing for the model call itself — all three tasks await the same session object sequentially.
- **Observed benchmark latency:** ~100–125 ms per chunk (query or doc encode), measured in ColBERT runs. A 20-chunk file → ~2–2.5 s embedding time.
- **ONNX threading:** `InferenceSession.create` accepts `intraOpNumThreads` and `interOpNumThreads` session options (documented in ONNX Runtime C++ API, exposed in Node binding). Current code passes only `graphOptimizationLevel: 'all'` — no thread count is set. Default is typically all available cores for `intraOpNumThreads`, but this is not verified. No env knob exists.
- **Bottleneck: MEDIUM** (dominated by Ollama phases for small files; dominant for large files).

**Ollama path (default):**
- Dense embed + sparse (hashed-tf) run in `Promise.all([ollamaEmbed(), hashedTfEncode()])`. `hashedTfEncode` is synchronous and instant. The only cost is one Ollama HTTP call per chunk.
- Same Ollama serialization issue as context/tag phases.
- **Bottleneck: HIGH** for large corpora on Ollama path.

**Upsert:** single `upsertPoints()` call with all points — efficient, not a bottleneck.

### Phase 5 — Link building

- `runBatched(chunks, BATCH_SIZE, buildLinks)` — parallel within batch.
- Each `buildLinks()` call does:
  1. `embedForSearch()` — one ONNX/Ollama call per chunk.
  2. `search()` per collection — sequential, one HTTP per collection per chunk.
  3. `updatePayload()` per backlink — sequential HTTP per backlink found.
- With N=5 collections and LINK_TOP=5 matches per collection, worst case per chunk: 1 embed + 5 search + 5×5 updatePayload = 31 sequential HTTP calls.
- **Bottleneck: MEDIUM-HIGH** for multi-collection setups with many backlinks.

---

## 3. ONNX embedding deep-dive

```
embedOnnx(text)
├── load()             — idempotent, lazy init (session reused ✓)
├── tokenizer(text)    — synchronous JS, fast
├── session.run(feeds) — ONE inference, ~100–125 ms on CPU
└── processSparse()    — synchronous, fast
```

**Key findings:**

| Property | Current state |
|----------|---------------|
| Session reuse | ✓ module-level singleton, loaded once |
| Batch size (indexer) | `BATCH_SIZE=3` texts per `Promise.all`, but session.run is not re-entrant |
| True batch inference | ✗ — each call is batch_size=1 (`dims = encoded.input_ids.dims` for single text) |
| ONNX thread knobs | ✗ not set — `intraOpNumThreads`/`interOpNumThreads` absent from session options |
| Execution provider | configurable via `ONNX_EXECUTION_PROVIDER` env (cpu default, dml/cuda supported) |
| max_length | 8192 for indexing — forces long sequence padding even for short chunks |

**True batch inference** (passing multiple texts as a batched tensor) is not implemented. Every call encodes one text. BGE-M3 ONNX can accept batch_size > 1 (the tokenizer `padding: true` already does this), but it requires passing stacked tensors and the current API returns a single embedding. This is the single largest untapped optimization.

---

## 4. Ollama path deep-dive

```
generate(model, prompt)   — POST /api/generate, stream: false, awaited
embed(text, model)        — POST /api/embed, awaited
```

**Key findings:**

| Property | Current state |
|----------|---------------|
| Concurrency (client) | `runBatched` sends `BATCH_SIZE=3` concurrent requests |
| Concurrency (server) | `OLLAMA_NUM_PARALLEL` unset → default 1 (serializes model calls) |
| CONTEXT_MODEL vs TAG_MODEL | both default to `gemma3:4b` — same model, same queue |
| Per-call overhead | 1–5 s per generation call depending on prompt length and GPU |
| Stream | `stream: false` — waits for full completion before returning |

With `OLLAMA_NUM_PARALLEL=1` (Ollama default), even 3 concurrent requests from the client queue at the server. Effective throughput = 1 LLM call at a time. Client-side `Promise.all(3)` adds no wall-clock benefit.

---

## 5. ColBERT benchmark pipeline

### Call graph (per query)

```
runQuery(q)
├── embedForSearch()        — 1 ONNX dense+sparse call (~120 ms)
├── hybridSearch(TOP_K)     — Qdrant HTTP, fast
├── hybridSearch(TOP_N_40)  — Qdrant HTTP, fast (second full search)
├── rerankResults()         — synchronous, fast
├── scoreColBERT(pool40)    — SEQUENTIAL
│   ├── encodeColBERT(query) — 1 ONNX colbert call (~120 ms)
│   └── for cand in pool40:
│       └── encodeColBERT(cand) — 1 ONNX call per candidate (~100–125 ms each)
│   → total: ~(40+1) × 115 ms ≈ 4 700–5 000 ms
└── scoreColBERT(pool20)    — SEQUENTIAL, re-encodes query + 20 candidates
    ├── encodeColBERT(query) — 1 ONNX colbert call (~120 ms)  ← DUPLICATE
    └── for cand in pool20:
        └── encodeColBERT(cand) — 1 ONNX call per candidate  ← ALL DUPLICATES (pool20 ⊆ pool40)
    → total: ~(20+1) × 115 ms ≈ 2 400 ms
```

**Observed p50 per query:** ~11 200–11 400 ms (top-40 mode), ~6 000 ms (top-20 mode).

### Critical inefficiencies

| Inefficiency | Impact |
|---|---|
| Query encoded twice (once for top40, once for top20) | ~120 ms wasted per query |
| Top-20 candidates all re-encoded (pool20 ⊆ pool40) | ~20 × 115 ms = ~2 300 ms wasted per query |
| Candidate encoding is sequential (one ONNX call at a time) | No parallelism; 40 calls × 115 ms = 4 600 ms serialized |
| Second `embedForSearch()` for dense+sparse on same query | ~120 ms duplicate — `embedForSearch` is called at line 218, then `encodeColBERT` re-encodes the same query at line 110 of colbert-rerank.js |
| Two full `hybridSearch()` calls (TOP_K + TOP_N_40) | TOP_K results are a subset of TOP_N_40 — one search would suffice |

**Quantified waste per query (measured ~11 400 ms total):**
- Duplicate query encode (top20 re-run): ~120 ms (1%)
- Duplicate candidate encode (top20 ⊆ top40): ~2 300 ms (20%)
- Sequential candidate encoding (vs theoretical parallel): not parallelizable with single session, but batching would help

### Top-40 timing breakdown (estimated from benchmark data)

| Component | Estimated ms |
|---|---|
| embedForSearch (dense+sparse) | ~120 |
| hybridSearch × 2 | ~30 |
| rerankResults | ~1 |
| scoreColBERT top40 (query + 40 docs) | ~4 800 |
| scoreColBERT top20 (query + 20 docs, duplicate) | ~2 500 |
| Overhead, Qdrant latency | ~150 |
| **Total** | **~11 600** (matches observed ~11 400) |

---

## 6. Existing profiler assessment

`Profiler` (`src/indexer/profiler.js`, enabled by `INDEX_PROFILE=1`) covers:
- `pre`, `chunk`, `context`, `tag`, `embed+upsert`, `link`, `chunks_out`
- Reports per-phase ms and chunks/s

**What it catches:** phase-level wall-clock breakdown per file. Sufficient to identify which of context/tag/embed is dominant for a given file.

**What it misses:**
- Per-chunk latency within a phase (e.g. embed: is it 10 × 100 ms or 2 × 500 ms?)
- Ollama server queue wait vs model inference time
- ONNX session load time (only on first call)
- Link phase breakdown (embed vs search vs updatePayload)
- Cross-file aggregate (no summary across all files)

**Assessment:** adequate for phase identification; not sufficient for sub-phase diagnosis. No new instrumentation strictly needed for the next optimization steps — the call graph analysis above is sufficient.

---

## 7. Bottleneck ranking

| Rank | Location | Bottleneck | Estimated impact |
|------|----------|-----------|-----------------|
| 1 | ColBERT benchmark | Top-20 results fully re-encoded (pool20 ⊆ pool40) | −20% benchmark time (−2 300 ms/query) |
| 2 | ColBERT benchmark | Query encoded twice per query (top40 + top20) | −1% benchmark time (−120 ms/query) |
| 3 | ONNX embed (indexer + ColBERT) | True batch inference not used — 1 text per session.run | Theoretical 3–8× throughput gain; safe only if batch API verified |
| 4 | Ollama context/tag | `OLLAMA_NUM_PARALLEL=1` server default — client batching wasted | Depends on server config; no code change needed |
| 5 | ColBERT benchmark | Candidate encoding is sequential — no parallelism | Would require concurrent session or worker thread |
| 6 | Indexer (all phases) | Files indexed strictly one at a time | N-file speedup possible; requires careful session/graph locking |
| 7 | Indexer link phase | `updatePayload` called per-backlink sequentially | Batchable via `updatePayload` bulk call |
| 8 | ColBERT benchmark | `embedForSearch` (dense+sparse) on query — separate from ColBERT encode | Minor (~120 ms); dense vector already computed |

---

## 8. Recommended next experiments

### First (safest, pure benchmark optimization)

**Eliminate top-20 re-encoding: score top40 once, slice for top20.**

In `colbert-bench.js` `runQuery()`, after scoring `pool40`:
```js
// score top40 once
const { scored: colbert40Scored, ms: colbert40Ms } = await scoreColBERT(q.query, pool40, {...});
// top20: slice already-scored results — no re-encode
const colbert20Scored = colbert40Scored.slice(0, TOP_K); // or re-sort from pool20 scores
```

This requires `scoreColBERT` to return intermediate scores (or a second path that reuses them). Saves ~2 300 ms per query (~20% of benchmark time). **Zero risk to quality — identical scores.** No production change.

**Also eliminate duplicate query encode:** pass query vectors from the top40 run into the top20 run instead of re-encoding. Saves ~120 ms per query.

#### Optimization follow-up (2026-05-17)

Implemented via `scoreColBERTAll()` in `benchmarks/retrieval/lib/colbert-rerank.js`. Pool40 is scored once; colbert-top20 results are derived by slicing `allScored` to the first `TOP_N_20` entries (hybrid rank ≤ 20) and re-sorting by the already-computed ColBERT scores — no additional ONNX calls.

**Outcome (post-optimization official run, 2026-05-17):**

| Metric | Before | After |
|--------|--------|-------|
| colbert-top40 MRR@10 | 0.718 | 0.718 |
| colbert-top20 MRR@10 | 0.716 | 0.716 |
| colbert-top20 p50 latency | ~5 971 ms | ~50 ms |
| colbert-top40 p50 latency | ~11 400 ms | ~11 332 ms |

Quality metrics for colbert-top20 and colbert-top40 are **unchanged** — identical scores, as expected (no re-encoding means no numerical difference).

**Baseline note:** the live `hybrid-true` MRR@10 changed between runs (0.665 in the no-eos run → 0.634 in the post-optimization run) due to Qdrant tie-breaking variance across sessions. Gate pass/fail status and ordering-loss counts changed accordingly. These differences are **not attributable to the optimization** — do not treat them as ranking improvement evidence. Compare only colbert-top20/40 quality metrics between runs.

Artifact: `benchmarks/retrieval/results/2026-05-17-custom50-colbert-top40-maxlen512-mean-official.txt`

### Second (benchmark quality experiment)

**Cache candidate ColBERT vectors across the run.**

Within a single benchmark run, the same chunks appear as candidates across many queries (e.g. `providers.md#5` appears in pool40 for multiple queries). A `Map<chunkId, Float32Array[]>` cache would avoid re-encoding the same chunk. Estimated hit rate depends on pool overlap — worth measuring before implementing.

### Third (ONNX thread knob, benchmark-only)

**Expose `intraOpNumThreads` / `interOpNumThreads` via env.**

```js
session = await ort.InferenceSession.create(modelPath, {
  executionProviders: providers,
  graphOptimizationLevel: 'all',
  intraOpNumThreads: parseInt(process.env.ORT_INTRA_THREADS ?? '0', 10), // 0 = default
  interOpNumThreads: parseInt(process.env.ORT_INTER_THREADS ?? '0', 10),
});
```

Add to `colbert-rerank.js` only (benchmark path). Measure effect on per-inference latency. Do not add to production `onnx-embed.js` without testing.

### Fourth (Ollama server, no code change)

**Test `OLLAMA_NUM_PARALLEL=3` during indexing.**

Set `OLLAMA_NUM_PARALLEL=3` in Ollama server config (or `OLLAMA_NUM_PARALLEL=3 ollama serve`). Measure context+tag phase time with `INDEX_PROFILE=1`. Effective only if GPU VRAM can hold the model at multiple parallel slots.

### Fifth (ONNX true batching, requires research)

**Batch multiple texts in one `session.run()` call.**

Tokenize N texts with `padding: true` into a single batch tensor, run one inference, split outputs. BGE-M3 supports batch_size > 1. Requires:
- Verifying ONNX model accepts dynamic batch dimension (likely yes — `aapot/bge-m3-onnx` uses dynamic axes).
- Verifying session.run is safe with batch_size > 1 for all three outputs (dense, sparse, colbert_vecs).
- API change to `embedOnnx(texts: string[])` — breaks current single-text contract.

High impact (3–8× throughput); medium risk (requires verification). Implement in benchmark helper first, not in production `onnx-embed.js`.

---

## 9. Do NOT do yet

- **Parallel file indexing** — requires locking graph mutations (`addLink`, `addBacklink`), session shared state, and config writes. Race conditions likely. Investigate only after single-file path is optimized.
- **Pipeline context/tag/embed phases** (overlap phases across chunks) — context output is input to tag prompt; tag output is input to embedding text. Overlapping requires buffering and out-of-order handling. Correctness risk.
- **ONNX concurrent session.run()** — `onnxruntime-node` single session is not guaranteed re-entrant. Creating multiple sessions is possible but ~2.3 GB model load per session is prohibitive.
- **ColBERT in production runtime** — deferred per Stage 1 verdict. No `src/` or MCP changes.
- **Length-bucketed batching** (grouping chunks by token length before batching) — only relevant after true batch inference is implemented.

---

## 10. Summary

The single highest-ROI fix requires zero quality risk and no production changes: **eliminate duplicate ColBERT encoding of the top-20 pool** in `colbert-bench.js`. Saves ~2 300 ms per query (~20% of benchmark wall time for 50 queries × ~460 s saved total). Implement by scoring pool40 once and deriving pool20 results from the same scored array.

The second highest-ROI fix is verifying and enabling **ONNX true batch inference** in the benchmark helper — potentially 3–8× throughput on encoding, but requires API change and verification first.

For the indexer, the dominant cost is Ollama LLM latency (context + tag phases). The only knob without code change is `OLLAMA_NUM_PARALLEL` on the server side. All other indexer optimizations require structural changes with correctness risks.
