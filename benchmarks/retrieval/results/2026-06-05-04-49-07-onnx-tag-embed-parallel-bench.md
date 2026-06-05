# ONNX Tag Lane + BGE-M3 Embed Lane Parallel Benchmark

**Date:** 2026-06-05 04:49:07  
**Fixture:** benchmarks/retrieval/fixtures/combined-live (5 files)  
**ONNX tag model:** onnx-community/Qwen2.5-Coder-0.5B-Instruct  
**Reps per variant:** 2  
**Common env:** PIPELINE_MODE=1 ONNX_EMBED=1 FORCE_REINDEX=1 INDEX_PROFILE=1

## Variant Commands

### Variant A: TAG_PROVIDER=onnx (current)
```
PIPELINE_MODE=1 ONNX_EMBED=1 FORCE_REINDEX=1 TAG_PROVIDER=onnx TAG_ONNX_MODEL=onnx-community/Qwen2.5-Coder-0.5B-Instruct TAG_ONNX_THREADS=1 OLLAMA_STAGE_CONCURRENCY=1 EMBED_STAGE_CONCURRENCY=1 COLLECTION=<tmp> npm run index benchmarks/retrieval/fixtures/combined-live
```

### Variant B: TAG_GEN=0 (lower bound)
```
PIPELINE_MODE=1 ONNX_EMBED=1 FORCE_REINDEX=1 TAG_GEN=0 OLLAMA_STAGE_CONCURRENCY=1 EMBED_STAGE_CONCURRENCY=1 COLLECTION=<tmp> npm run index benchmarks/retrieval/fixtures/combined-live
```

### Variant C: TAG_PROVIDER=ollama (reference)
```
PIPELINE_MODE=1 ONNX_EMBED=1 FORCE_REINDEX=1 OLLAMA_STAGE_CONCURRENCY=1 EMBED_STAGE_CONCURRENCY=1 COLLECTION=<tmp> npm run index benchmarks/retrieval/fixtures/combined-live
```

## Wall-Clock Summary (per-file average over all reps)

| Variant | Description | Files×Reps | Wall avg | Wall p50 | Wall p95 | Error |
|---------|------------|:----------:|--------:|--------:|--------:|-------|
| A | TAG_PROVIDER=onnx (current) | 10 | 36715 ms | 38884 ms | 49278 ms | — |
| B | TAG_GEN=0 (lower bound) | 10 | 28512 ms | 29150 ms | 38432 ms | — |
| C | TAG_PROVIDER=ollama (reference) | — | — | — | — | skipped |

## Stage Timings (per file, avg over all reps)

*Profiler phase names from INDEX_PROFILE=1 output.*

### Variant A: TAG_PROVIDER=onnx (current)

| Phase | avg | p50 | p95 |
|-------|----:|----:|----:|
| pre (hash+skip check) | 549 ms | 560 ms | 608 ms |
| chunk | 24 ms | 30 ms | 54 ms |
| context (Ollama) | 4981 ms | 4752 ms | 8728 ms |
| tag (ONNX or Ollama) | 6891 ms | 6840 ms | 10112 ms |
| embed (BGE-M3 ONNX) | 3403 ms | 3088 ms | 7634 ms |
| link | 12412 ms | 13350 ms | 15437 ms |
| **total/file** | 36715 ms | 38884 ms | 49278 ms |

Tag fill: **24/24** (100%)

Sample tags (last rep):
- `04-operations.md`: `doctor`, `qdrant`, `ollama`, `model`, `schema`, `provider`
- `04-operations.md`: `prune-stale`, `onnx-embed`, `collection`, `npm`, `run`
- `01-technical-config.md`: `qdrant-url`, `qdrant-key`, `cloud`, `self-hosted`
- `01-technical-config.md`: `onnx-embed`, `bge-m3`, `ollama`
- `03-short-chunks.md`: `combined-min-chars`, `context-model`, `tag-model`

### Variant B: TAG_GEN=0 (lower bound)

| Phase | avg | p50 | p95 |
|-------|----:|----:|----:|
| pre (hash+skip check) | 537 ms | 546 ms | 583 ms |
| chunk | 18 ms | 18 ms | 30 ms |
| context (Ollama) | 10300 ms | 10812 ms | 17202 ms |
| tag (ONNX or Ollama) | 0 ms | 0 ms | 0 ms |
| embed (BGE-M3 ONNX) | 2328 ms | 1652 ms | 5118 ms |
| link | 15326 ms | 16118 ms | 19308 ms |
| **total/file** | 28512 ms | 29150 ms | 38432 ms |

Tag fill: **0/24** (0%)

## Parallel Overlap Analysis

### Tag vs Embed time (Variant A)

| Metric | Value |
|--------|------:|
| Tag avg (ONNX worker) | 6891 ms |
| Embed avg (BGE-M3) | 3403 ms |
| Tag / Embed ratio | 2.03× |
| Sequential tag+embed | 10294 ms |
| Ideal parallel max | 6891 ms |
| Potential savings per file | 3403 ms (33%) |

**Cross-file overlap:** In PIPELINE_MODE=1, stageC (embed) of file N
runs while stageB (tags) of file N+1 is active — provided ollamaSem
and embedSem both allow it. With concurrency=1 on both semaphores,
this cross-file overlap is limited to: stageC_N ∥ stageA_{N+1}
(stageB_{N+1} waits for ollamaSem after stageA_{N+1} completes).

### Overhead vs no-tag lower bound (A vs B)

| Metric | Value |
|--------|------:|
| Variant A total/file avg | 36715 ms |
| Variant B total/file avg (no tags) | 28512 ms |
| A/B ratio | 1.29× |
| Tag overhead per file | 8203 ms |

## Conclusion

**Verdict:** `NEEDS_TUNING (tag adds 20-50% overhead)`

ONNX tag (~6891 ms/file) is longer than BGE-M3 embed (~3403 ms/file).
This means embed finishes first in stageC, and tag in stageB is the bottleneck.
Investigate: reduce TAG_ONNX_THREADS contention, or accept tag cost as pipeline tail.

### Recommended next step

Tag adds modest overhead. Current cross-file overlap is working adequately.
If throughput is a concern: test OLLAMA_STAGE_CONCURRENCY=2 to pipeline more files
and give the embed lane more opportunities to overlap with tag generation.

### Caveats
- Fixture is small (5 files). Wall-time averages include model warm-up on first file.
- INDEX_PROFILE=1 times include semaphore queue wait in pipeline mode.
- "embed+upsert" phase label covers embed only (upsert is in stageD, not profiled separately).
- Ollama context generation is the dominant GPU cost; not measured here (no INDEX_PROFILE for Ollama wall).
