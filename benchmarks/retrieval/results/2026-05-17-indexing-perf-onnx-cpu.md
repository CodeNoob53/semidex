# Indexing Performance Benchmark — 2026-05-17 — onnx/cpu

## Configuration

| Setting | Value |
|---------|-------|
| Provider | onnx |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | cpu |
| ONNX_BATCH_SIZE | 4 |
| ONNX_CUDA_STRICT | (unset) |
| Runs | 3 |
| Collection | bench-indexing-skip-path-cpu |
| Corpus files | 15 (README.md, AGENTS.md, docs/en/*.md) |
| SOURCE_ROOT | C:\Users\Aorus\Documents\Projects\semidex\.bench-indexing-corpus |
| Cleanup | true |

## Summary

| Metric | Value |
|--------|-------|
| Runs completed | 3 |
| Mean total ms | 365656 ms |
| Stdev total ms | 631499 ms |
| Min total ms | 1025 ms |
| Max total ms | 1094848 ms |
| Mean files indexed | 5.0 |
| Mean files skipped | 10.0 |
| Mean chunks produced | 106.0 |
| Mean chunks/sec | 0.29 |
| Mean ms/chunk | 3449.6 |

## Per-Run Results

| Run | Total ms | Files indexed | Files skipped | Chunks | chunks/sec |
|-----|----------|---------------|---------------|--------|------------|
| 1 | 1094848 | 15 | 0 | 318 | 0.29 |
| 2 | 1094 | 0 | 15 | 0 | — |
| 3 | 1025 | 0 | 15 | 0 | — |

## Phase Timing Summary (indexed files only)

Run 1 includes ONNX session init, tokenizer load, and Ollama model warmup.
The profiler emits no phase lines for skipped files, so this table reflects Run 1 data only.
Skip-path cost (Run 2+) is visible only in the per-run total ms above.

| Phase | Samples | Mean ms | p50 ms | p95 ms |
|-------|---------|---------|--------|--------|
| pre | 15 | 57 | 57 | 73 |
| chunk | 15 | 1 | 1 | 2 |
| context | 15 | 18828 | 17281 | 59878 |
| tag | 15 | 36148 | 16956 | 323553 |
| embed+upsert | 15 | 13837 | 11160 | 51038 |
| link | 15 | 4046 | 4227 | 8279 |
| chunks_out | 15 | 11 | 10 | 28 |

## What This Benchmark Can and Cannot Prove

**Can prove:**
- Wall-clock phase timings for this corpus on this machine/provider combination.
- Relative speedup between invocations with different `BENCH_INDEX_EP` / `BENCH_INDEX_PROVIDER` values.
- Chunk throughput and phase bottleneck identification (Run 1).

**Cannot prove:**
- Absolute timings are not portable across machines or Node.js versions.
- Run 1 always includes model warmup (ONNX session init, tokenizer load, Ollama model load).
  Run 1 total ms is the best signal for end-to-end cold-start cost.
- After Run 1 all files hash as unchanged and are skipped. Runs 2+ measure process
  startup, collection/config setup, graph load/save, file scan, hash check, and
  getStoredMeta lookup — not re-indexing throughput. The profiler emits no phase
  lines for skipped files; skip-path cost is visible only in per-run total ms.
- DML batching is only active with `BENCH_INDEX_EP=dml` and the `shouldUseOnnxBatching` gate.

**DML batching comparison:** Run this script twice — once with `BENCH_INDEX_EP=cpu`,
once with `BENCH_INDEX_EP=dml`. Compare Run 1 `total ms` and `chunks/sec` from the
two JSON artifacts (same-day runs have distinct filenames by provider+EP).

*Generated: 2026-05-17 — onnx/cpu*
