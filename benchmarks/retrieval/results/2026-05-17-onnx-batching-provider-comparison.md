# ONNX Batching Provider Comparison — 2026-05-17

**Question:** Does any ONNX execution provider (CPU / DML / CUDA) make length-bucketed
batching worthwhile for indexing?

**Method:** `benchmarks/onnx-batch-indexing-bench.js --batch-size 4 --naive-batch-size 4`
on 163 paragraph-chunks from 6 fixture docs. Three strategies × three provider settings.
Correctness verified against per-provider sequential baseline.

**Scope:** benchmark-only. No production code path wired to batching.

---

## Corpus

163 chunks, 6 docs. Token-length distribution (estimated, chars/4):

| Range | Count | % |
|-------|-------|---|
| 1–16 | 74 | 45.4% |
| 17–32 | 15 | 9.2% |
| 33–64 | 43 | 26.4% |
| 65–128 | 25 | 15.3% |
| 129–256 | 5 | 3.1% |
| >256 | 1 | 0.6% |

Bucketed strategy (maxBatch=4): 44 total batches across 6 buckets.

---

## Results by Provider

### CPU (`ONNX_EXECUTION_PROVIDER=cpu`)

**Actual backend:** CPU (onnxruntime-node default)

| Strategy | Total ms | ms/text | Speedup |
|----------|----------|---------|---------|
| Sequential | 18 030 ms | 110.6 ms | 1.00× |
| Naive batch (size=4) | 37 091 ms | 227.6 ms | 0.49× |
| Bucketed (maxBatch=4) | 19 577 ms | 120.1 ms | 0.92× |

**Correctness:** bit-identical (max dense delta = 0, max sparse delta = 0, cosine = 1.000000)

---

### DML (`ONNX_EXECUTION_PROVIDER=dml`)

**Actual backend:** DirectML with CPU fallback (`providers: dml, cpu`)

| Strategy | Total ms | ms/text | Speedup |
|----------|----------|---------|---------|
| Sequential | 12 507 ms | 76.7 ms | 1.00× |
| Naive batch (size=4) | 4 433 ms | 27.2 ms | **2.82×** |
| Bucketed (maxBatch=4) | 3 917 ms | 24.0 ms | **3.19×** |

**Correctness:** not bit-identical (FP differences from GPU accumulation order), but
numerically negligible — max dense delta = 2.3e-7, max sparse delta = 2.7e-6,
avg cosine sim = 1.000000. Functionally equivalent for indexing purposes.

---

### CUDA (`ONNX_EXECUTION_PROVIDER=cuda`)

**Actual backend:** CPU fallback — CUDA provider unavailable:
`no available backend found. ERR: [cuda] backend not found.`
`onnxruntime-node` does not bundle the CUDA EP; a separate `onnxruntime-node-gpu`
package would be required. Results are identical to CPU.

| Strategy | Total ms | ms/text | Speedup |
|----------|----------|---------|---------|
| Sequential | 18 002 ms | 110.4 ms | 1.00× |
| Naive batch (size=4) | 36 384 ms | 223.2 ms | 0.49× |
| Bucketed (maxBatch=4) | 19 770 ms | 121.3 ms | 0.91× |

**Correctness:** bit-identical (CPU fallback — same as CPU run)

---

## Cross-Provider Summary

| Provider | Sequential ms/text | Bucketed ms/text | Bucketed speedup | Correctness |
|----------|--------------------|------------------|------------------|-------------|
| CPU | 110.6 ms | 120.1 ms | 0.92× | bit-identical |
| DML | 76.7 ms | 24.0 ms | **3.19×** | FP equiv (cosine=1.0) |
| CUDA | 110.4 ms (CPU fallback) | 121.3 ms | 0.91× | bit-identical |

DML sequential is already 1.44× faster than CPU sequential before batching.
DML bucketed (24.0 ms/text) is **4.61× faster** than CPU sequential (110.6 ms/text).

---

## Analysis

**CPU:** `session.run()` call overhead dominates. Batching adds padding cost without
parallelism benefit. Both naive and bucketed are slower than sequential.

**DML:** DirectML runs the model graph on the GPU (integrated or discrete). Parallel
execution units absorb padding overhead and amortize `session.run()` call cost across
the batch. Length-bucketing reduces within-batch padding waste further, giving 3.19×
over DML sequential and beating CPU sequential by 4.61×. The small FP deltas
(~1e-7 dense, ~1e-6 sparse) are expected from GPU floating-point accumulation order
and are immaterial for embedding similarity search.

**Naive vs bucketed on DML:** bucketed (3.19×) beats naive (2.82×) because the corpus
is heavily short-skewed (45% of texts ≤16 tokens). Without bucketing, a single long
text forces the other 3 texts in the batch to be padded to its length. Bucketing
keeps the 1 long text in its own batch and groups the 74 short texts into 19 compact
batches of 4.

**CUDA:** not bundled in `onnxruntime-node`. Fell back to CPU silently (logged to
stderr). Requires `onnxruntime-node-gpu` which is a separate install not in this
project's dependencies. Not tested.

---

## Verdict

| Provider | Verdict |
|----------|---------|
| CPU | **Defer** — batching regresses (0.92× bucketed). No production change. |
| DML | **Proceed** — 3.19× bucketed speedup confirmed. DML available on Windows with any DirectX 12 GPU (integrated or discrete). Correctness: FP-equivalent. |
| CUDA | **Falls back to CPU** — `onnxruntime-node` does not bundle CUDA EP. Results identical to CPU. CUDA/Linux GPU support pending research; out of scope for this task. |

**Recommended next step (Windows DirectML opt-in batching):** wire
`embedBucketed(texts, embedOnnxBatch, 4)` as an opt-in indexer path, gated by
`ONNX_EMBED=1` + `ONNX_EXECUTION_PROVIDER=dml`. Users on Windows with any DirectX 12
GPU (including integrated Intel/AMD graphics) get ~3× indexing throughput. CPU path
remains the default and is unaffected. Design: `2026-05-17-dml-batching-production-wiring-design.md`.

---

## Artifacts

- `benchmarks/onnx-batch-indexing-bench.js` — benchmark script
- `benchmarks/lib/length-bucket.js` — pure bucketing helper
- `src/core/onnx-embed.js` — `embedOnnxBatch()` (infrastructure)
- `src/core/embeddings.js` — `embedForIndexBatch()` with Windows DirectML gate (implemented — see design doc)
- `src/smoke/sections/23-length-bucket.js` — 32 pure-helper assertions (338/338 pass)
- Prior: `2026-05-17-onnx-true-batching-probe.md` — correctness probe
- Prior: `2026-05-17-onnx-length-bucketed-batching.md` — CPU-only benchmark
