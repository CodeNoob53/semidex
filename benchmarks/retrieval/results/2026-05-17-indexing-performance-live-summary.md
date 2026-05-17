# Indexing Performance Live Summary — 2026-05-17

## Environment

| Item | Value |
|------|-------|
| OS | Windows 11 Pro |
| Node.js | v25.2.1 |
| semidex | v2.0.0 |
| onnxruntime-node | 1.24.3 |
| Qdrant | cloud (eu-central-1, reachable) |
| Ollama | v0.23.2 (localhost:11434) |
| CONTEXT_MODEL | gemma3:4b |
| TAG_MODEL | gemma3:4b |
| ONNX_EXECUTION_PROVIDER tested | cpu, dml |
| Corpus | 15 files — README.md, AGENTS.md, docs/en/*.md |
| Chunks produced | 317–318 |

## Results

| Run | EP | Total ms | chunks/sec | ms/chunk | dominant phase | notes |
|-----|----|----------|------------|----------|----------------|-------|
| CPU Run 1 | cpu | 1 062 685 | 0.30 | 3 352 | tag (35.4s mean, p95=338s) | full index, cold start |
| DML Run 1 | dml | 1 882 114 | 0.17 | 5 919 | tag (82.6s mean, p95=576s) | full index, cold start |
| CPU skip Run 2 | cpu | 1 094 | n/a | n/a | skip-path | 15 files skipped, ~1.1s total |
| CPU skip Run 3 | cpu | 1 025 | n/a | n/a | skip-path | 15 files skipped, ~1.0s total |

### Phase breakdown — CPU vs DML (mean ms per file, 15 files)

| Phase | CPU mean ms | DML mean ms | Delta | Notes |
|-------|-------------|-------------|-------|-------|
| pre | 59 | 57 | −2 | file hash + stored-meta lookup |
| chunk | 1 | 1 | 0 | parse + split |
| context | 16 704 | 35 160 | +18 456 | Ollama LLM — observed 2.1× slower in DML run |
| tag | 35 403 | 82 611 | +47 208 | Ollama LLM — observed 2.3× slower in DML run |
| embed+upsert | 13 975 | 3 112 | −10 863 | ONNX embed — **4.5× faster under DML** ✓ |
| link | 4 631 | 4 436 | −195 | Qdrant search — no meaningful difference |
| chunks_out | 12 | 17 | +5 | file write — no meaningful difference |

### Skip-path run (BENCH_INDEX_RUNS=3, cpu)

Completed. See §5 for numbers. Baseline preserved as `2026-05-17-indexing-perf-onnx-cpu-run1.json` / `-run1.md`.

## Findings

### 1. DML embed+upsert is 4.5× faster; end-to-end was 77% slower in this run

embed+upsert dropped from 14.0s → 3.1s mean under DML — a genuine 4.5× speedup on
the ONNX embedding phase. However, end-to-end total was 1 882s vs 1 063s for CPU, a
77% regression in this single-run comparison.

The context and tag phases (both Ollama LLM) were observed to be 2.1–2.3× slower in
the DML run. **The most likely explanation is GPU resource contention**: DirectML
occupies the GPU for ONNX inference, and Ollama's CPU-bound token generation may also
be degraded by memory bandwidth or PCIe pressure from concurrent DML activity. However,
this is a hypothesis — with one run per configuration there is no way to rule out run-order
variance, Ollama warmup state differences, or background system load. A controlled repeat
(CPU run immediately after DML, or DML run with Ollama on a separate process pinned to
CPU-only) would be needed to confirm causation.

**The DML embed speedup is real but small relative to total cost**: embed+upsert is
~20% of CPU wall time (13.9s / 70.8s per-file mean). Even a 10× embed speedup would
save ~12s per file while Ollama accounts for ~52s.

### 2. Ollama LLM phases (context + tag) dominate — 73% of CPU wall time

Per-file breakdown on CPU:
- context: 16.7s (24%)
- tag: 35.4s (50%)
- embed+upsert: 14.0s (20%)
- link: 4.6s (7%)
- other (pre/chunk/chunks_out): <0.1s

The tag phase dominates at 50% of wall time with extreme p95 variance (338s on CPU,
576s on DML). The variance is driven by file size: longer docs produce more chunks,
which generates more LLM_BATCH_SIZE=3 Ollama calls, causing very long tail latencies
on large files (benchmarking.md, operations.md).

### 3. DML guidance on this hardware: do not use with co-located Ollama

In this run, DML caused net regression. DML would be beneficial only if:
(a) Ollama runs on separate hardware (different machine or dedicated CPU-only process), OR
(b) The pipeline batches all LLM work before any ONNX work (no interleaving), OR
(c) LLM context/tag generation is disabled entirely.

Without one of these conditions, DML adds GPU overhead that competes with Ollama.

### 4. The confirmed bottleneck is Ollama throughput, not ONNX

Optimizing ONNX embedding (DML, CUDA) is premature: embedding is already only ~20%
of wall time on CPU. Next optimizations must target LLM throughput:

1. **LLM_BATCH_SIZE sweep** (3 → 8 → 16) — higher batches reduce per-call overhead
2. **Faster model** — gemma3:1b vs gemma3:4b speed/quality tradeoff on custom-50
3. **Pipeline LLM calls** — parallelize context+tag across files
4. **Headless baseline** — disable CONTEXT_MODEL/TAG_MODEL to isolate pure ONNX+Qdrant throughput

### 5. Skip-path overhead (BENCH_INDEX_RUNS=3)

Collection: `bench-indexing-skip-path-cpu`. Run 1 full index, Runs 2–3 skip path.

| Run | Total ms | Files indexed | Files skipped |
|-----|----------|---------------|---------------|
| 1 | 1 094 848 | 15 | 0 |
| 2 | 1 094 | 0 | 15 |
| 3 | 1 025 | 0 | 15 |

**Skip-path cost: ~1.0–1.1 s for 15 files** (~67–73 ms per file). This covers process
startup, Qdrant collection/config lookup, graph load, file scan, hash check, and
getStoredMeta lookup per file. No profiler phase lines are emitted for skipped files —
this number comes from per-run total ms only.

1.1 s for a 15-file incremental scan is acceptable. At this rate, a 150-file corpus
would take ~11 s on the skip path, which is reasonable for an incremental re-run.

## Verdict

**DML as production default: DEFER — do not promote.**
The observed DML regression (77% slower end-to-end) is likely explained by Ollama/GPU
contention on this machine, but even under ideal conditions the embed speedup addresses
only ~20% of total indexing time. DML opt-in guidance remains correct for embed-only
workloads; it should not be the default when Ollama runs on the same host.

**Next recommended task: LLM throughput investigation.**
Specifically: LLM_BATCH_SIZE sweep and gemma3:1b vs gemma3:4b comparison on the
custom-50 benchmark. This is the highest-leverage remaining bottleneck.

**ONNX batching DML investigation: complete.**
The harness works correctly. The embed+upsert speedup (4.5×) is confirmed. The
end-to-end regression under co-located Ollama is documented. No further DML benchmarking
needed until the Ollama bottleneck is addressed or the hardware configuration changes.

---

*Artifacts:*
- `2026-05-17-indexing-perf-onnx-cpu-run1.json` / `-run1.md` — CPU baseline (RUNS=1, preserved before overwrite)
- `2026-05-17-indexing-perf-onnx-cpu.json` / `.md` — skip-path run (RUNS=3, collection bench-indexing-skip-path-cpu)
- `2026-05-17-indexing-perf-onnx-dml.json` / `.md` — DML baseline (RUNS=1)
