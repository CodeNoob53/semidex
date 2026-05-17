# Indexing Performance Benchmark — 2026-05-17 — onnx/dml

## Configuration

| Setting | Value |
|---------|-------|
| Provider | onnx |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | dml |
| ONNX_BATCH_SIZE | 4 |
| ONNX_CUDA_STRICT | (unset) |
| Runs | 1 |
| Collection | bench-indexing-perf-2026-05-17T1841 |
| Corpus files | 15 (README.md, AGENTS.md, docs/en/*.md) |
| SOURCE_ROOT | C:\Users\Aorus\Documents\Projects\semidex\.bench-indexing-corpus |
| Cleanup | true |

## Summary

| Metric | Value |
|--------|-------|
| Runs completed | 1 |
| Mean total ms | 1882114 ms |
| Stdev total ms | 0 ms |
| Min total ms | 1882114 ms |
| Max total ms | 1882114 ms |
| Mean files indexed | 15.0 |
| Mean files skipped | 0.0 |
| Mean chunks produced | 318.0 |
| Mean chunks/sec | 0.17 |
| Mean ms/chunk | 5918.6 |

## Per-Run Results

| Run | Total ms | Files indexed | Files skipped | Chunks | chunks/sec |
|-----|----------|---------------|---------------|--------|------------|
| 1 | 1882114 | 15 | 0 | 318 | 0.17 |

## Phase Timing Summary (indexed files only)

Run 1 includes ONNX session init, tokenizer load, and Ollama model warmup.
The profiler emits no phase lines for skipped files, so this table reflects Run 1 data only.
Skip-path cost (Run 2+) is visible only in the per-run total ms above.

| Phase | Samples | Mean ms | p50 ms | p95 ms |
|-------|---------|---------|--------|--------|
| pre | 15 | 57 | 59 | 66 |
| chunk | 15 | 1 | 1 | 2 |
| context | 15 | 35160 | 20916 | 134630 |
| tag | 15 | 82611 | 28898 | 576373 |
| embed+upsert | 15 | 3112 | 2114 | 11506 |
| link | 15 | 4436 | 4437 | 10689 |
| chunks_out | 15 | 17 | 17 | 54 |

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

*Generated: 2026-05-17 — onnx/dml*
