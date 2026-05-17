# Indexing Performance Benchmark — 2026-05-17 — onnx/cpu

## Configuration

| Setting | Value |
|---------|-------|
| Provider | onnx |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | cpu |
| ONNX_BATCH_SIZE | 4 |
| ONNX_CUDA_STRICT | (unset) |
| Runs | 1 |
| Collection | bench-indexing-perf-2026-05-17T1823 |
| Corpus files | 15 (README.md, AGENTS.md, docs/en/*.md) |
| SOURCE_ROOT | C:\Users\Aorus\Documents\Projects\semidex\.bench-indexing-corpus |
| Cleanup | true |

## Summary

| Metric | Value |
|--------|-------|
| Runs completed | 1 |
| Mean total ms | 1062685 ms |
| Stdev total ms | 0 ms |
| Min total ms | 1062685 ms |
| Max total ms | 1062685 ms |
| Mean files indexed | 15.0 |
| Mean files skipped | 0.0 |
| Mean chunks produced | 317.0 |
| Mean chunks/sec | 0.30 |
| Mean ms/chunk | 3352.3 |

## Per-Run Results

| Run | Total ms | Files indexed | Files skipped | Chunks | chunks/sec |
|-----|----------|---------------|---------------|--------|------------|
| 1 | 1062685 | 15 | 0 | 317 | 0.30 |

## Phase Timing Summary (indexed files only)

Run 1 includes ONNX session init, tokenizer load, and Ollama model warmup.
The profiler emits no phase lines for skipped files, so this table reflects Run 1 data only.
Skip-path cost (Run 2+) is visible only in the per-run total ms above.

| Phase | Samples | Mean ms | p50 ms | p95 ms |
|-------|---------|---------|--------|--------|
| pre | 15 | 59 | 60 | 67 |
| chunk | 15 | 1 | 1 | 1 |
| context | 15 | 16704 | 16608 | 38459 |
| tag | 15 | 35403 | 14390 | 337958 |
| embed+upsert | 15 | 13975 | 11265 | 53793 |
| link | 15 | 4631 | 5029 | 9503 |
| chunks_out | 15 | 12 | 12 | 35 |

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
