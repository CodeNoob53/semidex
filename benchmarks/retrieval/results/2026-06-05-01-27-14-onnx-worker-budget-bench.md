# ONNX Worker/Thread Budget Benchmark

**Date:** 2026-06-05 01:27:14  
**CPU threads:** 12  
**BGE-M3 texts/run:** 10  
**Qwen2.5 prompts/run:** 5 (max_new_tokens=32)  
**Warmup reps:** 2 | **Bench reps:** 3 (avg reported)

## Results

| embedThreads | tagThreads | embed-only | tag-only | concurrent wall | embed-deg | tag-deg | wall-deg |
|:---:|:---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 807 ms | 7835 ms | 7956 ms | +61% | +1% | +2% |
| 1 | 2 | 807 ms | 7709 ms | 8004 ms | +67% | +3% | +4% |
| 1 | 4 | 807 ms | 7791 ms | 7987 ms | +64% | +2% | +3% |
| 2 | 1 | 499 ms | 7835 ms | 7940 ms | +62% | +1% | +1% |
| 2 | 2 | 499 ms | 7709 ms | 8013 ms | +60% | +4% | +4% |
| 2 | 4 | 499 ms | 7791 ms | 7953 ms | +60% | +2% | +2% |
| 4 | 1 | 395 ms | 7835 ms | 8023 ms | +49% | +2% | +2% |
| 4 | 2 | 395 ms | 7709 ms | 7960 ms | +54% | +3% | +3% |
| 4 | 4 | 395 ms | 7791 ms | 7919 ms | +53% | +1% | +2% |

## Verdict

**ONNX_WORKER_OVERLAP_ACCEPT**

Max wall degradation vs matching slower solo lane: **+4%**

### Thresholds
- ONNX_WORKER_OVERLAP_ACCEPT: wall <= 1.25x solo baseline (<= +25% degradation)
- ONNX_WORKER_OVERLAP_NEEDS_TUNING: 1.25x - 1.75x (+25% - +75%)
- ONNX_WORKER_OVERLAP_REJECT: > 1.75x (+75% degradation)

### Notes
- embed-only and tag-only are single-worker baselines (no contention)
- concurrent wall = actual wall clock with both workers running in parallel
- embed-deg / tag-deg = per-worker slowdown vs its own solo baseline
- wall-deg = concurrent wall / max(embed-only, tag-only) - 1
- Tag model: onnx-community/Qwen2.5-0.5B-Instruct (dtype=q4, device=cpu)
- Embed model: aapot/bge-m3-onnx
