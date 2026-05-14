# Audit: Indexing/Chunking Performance Baseline Instrumentation

Date: 2026-05-14

## Summary

The indexing pipeline has five sequential phases per file, each with distinct
cost profiles (CPU-bound chunking, LLM-bound context/tag, GPU/CPU-bound
embedding, network-bound Qdrant upsert). No timing data is collected today.
Before optimising anything, a non-invasive per-phase wall-clock profile under
`INDEX_PROFILE=1` is the right first step.

**Recommended Stage 1:** add a single `Profiler` helper (≈30 lines) gated on
`process.env.INDEX_PROFILE === '1'` and wrap the five `console.log('[N/5]…')`
boundaries in `indexFile`. Print a per-file summary table at the end. No
behavior changes; no new npm command needed initially.

---

## Q1 — Pipeline phases in `indexFile`

Source: `src/indexer/index.js:29–122`

```
indexFile(filePath, …)
  ├─ [pre]   hashFile(filePath)                       — crypto, fast
  ├─ [pre]   getStoredMeta(collection, sourceFile)    — Qdrant scroll, network
  ├─ [skip?] storedHash === fileHash → return 'skipped'
  ├─ [pre]   deleteBySourceFile (if reindexing)       — Qdrant delete, network
  │
  ├─ [1/5]  chunkFileFromPath(filePath, sourceFile)   — CPU / pandoc / pdf-parse
  ├─ [2/5]  processChunks(rawChunks)                  — LLM (context + merge)
  ├─ [3/5]  addTagsBatch loop                         — LLM (tags, batched)
  ├─ [4/5]  runBatched → embedForIndex + upsertPoints — ONNX/Ollama + Qdrant
  └─ [5/5]  runBatched → buildLinks                  — ONNX/Ollama + Qdrant (per chunk)
            saveChunksMd(filePath, linkedChunks)      — disk write
```

**Pre-phases not currently labelled in console output:**

| Sub-phase | Cost estimate | Currently timed? |
|-----------|---------------|------------------|
| `hashFile` | ~1ms (stream hash) | No |
| `getStoredMeta` (scroll) | ~5–20ms (Qdrant roundtrip) | No |
| `deleteBySourceFile` (reindex) | ~5–20ms | No |

These are cheap and rarely the bottleneck, but worth capturing in `INDEX_PROFILE`
to confirm the assumption.

---

## Q2 — What is already batched/parallel vs sequential

### Parallel within a phase

| Phase | Parallelism | Mechanism |
|-------|-------------|-----------|
| [2/5] context | `BATCH_SIZE` chunks run concurrently | `runBatched` → `Promise.all(batch.map(fn))` in `context.js:59` |
| [3/5] tag | `BATCH_SIZE` chunks per LLM call (batch prompt) | `addTagsBatch` with JSON array prompt; falls back to individual |
| [4/5] embed+upsert | `BATCH_SIZE` embeds run concurrently | `runBatched` → `Promise.all`; but `upsertPoints` is called once after all embeds |
| [5/5] link | `BATCH_SIZE` link builds concurrently | `runBatched`; then `Promise.all(linkedChunks.map(…))` for payload updates |
| ollama dense+sparse | Both called in parallel | `embeddings.js:95` — `Promise.all([ollamaEmbed, hashedTfEncode])` |

### Sequential bottlenecks (confirmed)

1. **Phase pipeline is strictly sequential.** Phase 2 does not start until all
   chunks from phase 1 are done. Phase 4 does not start until phase 3 is
   complete. LLM (phases 2–3) and ONNX (phase 4) never overlap.

2. **`processChunks` (phase 2) is partially sequential.** The `shouldMerge`
   LLM call at `context.js:41–46` is awaited one chunk at a time (it checks
   chunk `i` against the last merged chunk in order). The final `runBatched`
   for `addContext` then runs in parallel, but merge decisions are serial.

3. **ONNX embed is one text at a time.** `embedForIndex` calls `embedOnnx(text)`
   per chunk inside `runBatched`. Each call creates a tensor, runs inference,
   and returns. The ONNX session is reused (singleton), but tokenisation and
   inference are per-chunk, not batched. This is the largest confirmed
   optimization opportunity (noted in `2026-05-13-indexing-performance-analysis.md`).

4. **Link building searches Qdrant per chunk.** Phase 5 calls `embedForSearch`
   (another embed) and `search(collection, vector, LINK_TOP)` per chunk per
   target collection. On a corpus with `N` chunks and `C` collections:
   `N × C` Qdrant search calls + `N × C` embeds.

### Key insight: `BATCH_SIZE=3` controls LLM parallelism, not embed parallelism

`LLM_BATCH_SIZE` governs both the context/tag batch window (phases 2–3) and
the embed batch window (phase 4). There is no separate `EMBED_BATCH_SIZE`.
The ONNX model is likely under-saturated at `batch=3` since it has no
token-generation overhead. An independent `EMBED_BATCH_SIZE` env var would
be the cheapest optimization lever.

---

## Q3 — Metrics to collect

### Per-file summary (minimum useful set)

| Metric | How to derive | Why |
|--------|---------------|-----|
| `chunksCount` | `rawChunks.length` after phase 1 | Normalise all other metrics |
| `mergedCount` | `contextChunks.length` after phase 2 | Merge rate = how often `shouldMerge` fires |
| `phaseMs[0..4]` | `Date.now()` at each phase boundary | Dominant cost identification |
| `totalMs` | end − start, including pre-phases | Wall clock cost per file |
| `tokensEst` | `sum(chunk.text.length / 4)` | Normalise embed throughput |
| `chunksPerSec` | `chunksCount / (totalMs / 1000)` | Top-level throughput signal |
| `embedMsPerChunk` | `phaseMs[3] / chunksCount` | ONNX/Ollama embed cost per unit |
| `contextMsPerChunk` | `phaseMs[1] / mergedCount` | LLM context cost per unit |
| `tagMsPerChunk` | `phaseMs[2] / mergedCount` | LLM tag cost per unit |
| `upsertMs` | time of `upsertPoints` call | Network cost to Qdrant |
| `linkMsPerChunk` | `phaseMs[4] / mergedCount` | Per-chunk link search cost |

### Nice-to-have (Stage 2)

- `mergeCount` — how many `shouldMerge` calls fired (vs total boundary checks)
- `tagBatchFallbacks` — count of batch-parse failures falling back to individual
- `embedTokensEst` — total `embedText` characters / 4 (slightly larger than raw chunk)
- `linkSearchCount` — `mergedCount × linkCollectionCount`

### What NOT to collect

- Individual chunk timings — too granular for Stage 1, high overhead
- Memory usage — `process.memoryUsage()` snapshots are cheap but add noise without
  a baseline comparison framework; defer to Stage 2
- Qdrant response latency per call — defer; needs instrumentation inside `qdrant.js`

---

## Q4 — Non-invasive instrumentation design

### Design principles

- `INDEX_PROFILE=1` gates all output — zero overhead when unset
- No behavior changes: no new `await`, no changed return values, no altered log format
- Existing `console.log('  [N/5] …')` lines stay; profile output is additive
- Output to stderr or a prefixed stdout line so it is easy to filter

### Proposed `Profiler` helper

Location: `src/indexer/profiler.js` (new, ~35 lines)

```js
// Lightweight per-file phase timer. Only active when INDEX_PROFILE=1.
// Usage: const p = new Profiler(); p.mark('chunk'); ... p.mark('context'); p.report(chunks);

export class Profiler {
  constructor() {
    this.enabled = process.env.INDEX_PROFILE === '1';
    this.marks = [];                 // [{ label, t }]
    this.t0 = this.enabled ? Date.now() : 0;
  }

  mark(label) {
    if (!this.enabled) return;
    this.marks.push({ label, t: Date.now() });
  }

  report({ chunksIn, chunksOut, tokensEst }) {
    if (!this.enabled) return;
    const totalMs = Date.now() - this.t0;
    const phases = [];
    let prev = this.t0;
    for (const { label, t } of this.marks) {
      phases.push({ label, ms: t - prev });
      prev = t;
    }
    const rows = phases.map(p =>
      `    ${p.label.padEnd(12)} ${String(p.ms).padStart(6)} ms`
    ).join('\n');
    const cps = chunksOut > 0 ? (chunksOut / (totalMs / 1000)).toFixed(1) : '—';
    console.log(
      `  [profile] ${chunksIn}→${chunksOut} chunks, ~${tokensEst} tokens\n` +
      rows + '\n' +
      `    ${'total'.padEnd(12)} ${String(totalMs).padStart(6)} ms  (${cps} chunks/s)`
    );
  }
}
```

### Integration points in `indexFile`

```js
const profiler = new Profiler();

// after hashFile + getStoredMeta:
profiler.mark('pre');

// after chunkFileFromPath:
profiler.mark('chunk');

// after processChunks:
profiler.mark('context');

// after addTagsBatch loop:
profiler.mark('tag');

// after runBatched embeds + upsertPoints:
profiler.mark('embed+upsert');

// after runBatched buildLinks + Promise.all payload updates:
profiler.mark('link');

saveChunksMd(filePath, linkedChunks);
profiler.mark('chunks_out');

const tokensEst = taggedChunks.reduce((s, c) => s + Math.ceil(c.text.length / 4), 0);
profiler.report({ chunksIn: rawChunks.length, chunksOut: taggedChunks.length, tokensEst });
```

### Sample output (INDEX_PROFILE=1)

```
→ docs/en/architecture.md
  [1/5] chunking...
        18 chunks
  [2/5] contextualizing...
        17 chunks after merge
  [3/5] tagging...
  [4/5] embedding + upserting...
        upserted 17 points
  [5/5] linking...
  [profile] 18→17 chunks, ~4210 tokens
    pre             12 ms
    chunk            8 ms
    context       4230 ms
    tag           2140 ms
    embed+upsert  3180 ms
    link          2950 ms
    chunks_out       4 ms
    total        12524 ms  (1.4 chunks/s)
  ✓ done
```

---

## Q5 — Benchmark command: new vs env flag

### Verdict: `INDEX_PROFILE=1` env flag is sufficient for Stage 1

Reasons:

1. A `bench:index` npm script would need a fixed test corpus and ground-truth
   timing expectations — that requires defining "acceptable" baseline first.
   We don't have that yet. The point of Stage 1 is to *discover* the baseline.

2. `INDEX_PROFILE=1` works on any real or benchmark corpus without changing
   the indexing target or adding fixture management overhead.

3. The profiler output is human-readable inline with the existing indexer log —
   no new runner, no results file format to maintain.

### When a dedicated `bench:index` command makes sense (Stage 2)

After baseline numbers are captured and the dominant phase is confirmed, a
`bench:index` command is useful for:

- Reproducible before/after comparison across code changes
- CI regression gate (e.g. "embedding phase must not exceed X ms/chunk")
- Multi-file corpus timing (total throughput, not just per-file)

Suggested form (Stage 2):

```bash
INDEX_PROFILE=1 COLLECTION=bench-perf npm run bench:index
```

With a small fixed-size corpus in `benchmarks/indexing/fixtures/` and a
`benchmarks/indexing/run.js` that captures the profile output and writes a
summary to `benchmarks/indexing/results/`.

---

## Q6 — Smoke tests without live Qdrant

### What can be tested offline

The `Profiler` class is pure JS with no I/O and no async calls. It is fully
testable without Qdrant, Ollama, or the ONNX model.

**Proposed offline smoke cases (pure unit):**

| Case | What to assert |
|------|---------------|
| `INDEX_PROFILE` unset → `profiler.enabled === false` | No marks, no output |
| `INDEX_PROFILE=0` → same as unset | No output |
| `INDEX_PROFILE=1` → marks recorded | `profiler.marks.length === N` after N calls |
| `report()` with `INDEX_PROFILE=1` → output contains phase names | Check output string includes expected labels |
| `report()` output format | Parses `total` ms and `chunks/s` correctly |
| Zero-chunk edge case | `chunksOut=0` → cps reported as `—` not `NaN` or `Infinity` |
| Single mark → only one phase row | No off-by-one in phase duration loop |

These are pure constructor + method call tests. No mocking needed. They can
live in the existing `src/smoke.js` under a new "Section 14 — Profiler" block.

### What NOT to test in smoke

- Actual timing values — non-deterministic, not suitable for assertions
- That `INDEX_PROFILE=1` produces exactly N ms for a given phase — that is a
  live benchmark concern, not a unit test concern
- Integration with `indexFile` — that requires Qdrant and is a live test

---

## Recommended Stage 1 Implementation Plan

**Files to create/edit:**

| File | Change |
|------|--------|
| `src/indexer/profiler.js` | New file, `Profiler` class (~35 lines) |
| `src/indexer/index.js` | Import `Profiler`; add 7 `profiler.mark()` calls + `profiler.report()` in `indexFile` (~10 lines total) |
| `src/smoke.js` | Section 14 — 7 offline Profiler unit cases |
| `docs/en/benchmarking.md` | Add `INDEX_PROFILE=1` to the env vars / commands section |

**Files NOT changed:**

- All phase files (`chunk.js`, `context.js`, `tag.js`, `link.js`) — no changes
- `embeddings.js`, `qdrant.js` — no changes
- `batch.js` — no changes
- Any test fixtures or benchmark runners

**Ordering:**

1. `profiler.js` — standalone, testable immediately
2. Smoke cases for `profiler.js` — confirm the helper works before wiring it in
3. Wire into `indexFile` — 10-line change, existing phase labels unchanged
4. Docs update — one paragraph in `benchmarking.md`

**Not in Stage 1:**

- `bench:index` npm script or benchmark corpus
- Any actual optimisation (batch ONNX inference, pipeline overlap, EMBED_BATCH_SIZE)
- Memory profiling
- Per-phase Qdrant latency breakdown

---

## Context: Known bottlenecks from prior analysis

From `benchmarks/retrieval/results/2026-05-13-indexing-performance-analysis.md`:

1. **ONNX runs on CPU (hardcoded)** — `ONNX_EXECUTION_PROVIDER` env var now
   supported (already implemented per AGENTS.md). Baseline measurement will
   confirm actual speedup on this machine.

2. **Sequential LLM → ONNX pipeline** — Phase 2+3 (Ollama) and phase 4 (ONNX)
   never overlap. Assembly-line parallelism is the highest-complexity option;
   a separate `EMBED_BATCH_SIZE` is the lowest-risk partial win.

3. **Per-chunk ONNX inference** — each embed call tokenises + runs inference
   once. Batched ONNX inference (`N` texts → one `session.run`) is the largest
   ONNX throughput improvement, estimated 3–5× at batch=8–16.

**The profiler will confirm which of these is actually dominant before any code
is changed.** On a fast SSD with ONNX on CPU, embedding may not dominate if
the Ollama LLM calls (context + tag) are the real bottleneck. Measure first.
