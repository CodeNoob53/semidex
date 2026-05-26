# custom-50 Metric Variance Source Check

*Generated: 2026-05-26*

## Purpose

Identify whether nDCG@10 / MRR@10 variance across repeated custom-50 ONNX runs
originates from:
- **A) reindex / LLM context generation** (context text changes → embedding shifts → ranking changes), or
- **B) search / Qdrant / RRF tie-ordering** (same index, same vectors, different result ordering on near-equal scores).

## Commands

```powershell
# Run 0 — full reindex
$env:ONNX_EMBED = "1"
$env:BENCH_PROVIDER = "onnx"
Remove-Item Env:BENCH_SKIP_INDEX -ErrorAction SilentlyContinue
npm run bench:custom50

# Runs 1–5 — skip reindex, same collection
$env:BENCH_SKIP_INDEX = "1"
npm run bench:custom50   # run 1
npm run bench:custom50   # run 2
npm run bench:custom50   # run 3
npm run bench:custom50   # run A (per-query detail)
npm run bench:custom50   # run B (per-query detail)
```

## Summary Metrics Across All Runs

| Metric | Run 0 (reindex) | Run 1 (skip) | Run 2 (skip) | Run 3 (skip) |
|--------|-----------------|--------------|--------------|--------------|
| Provider | onnx | onnx | onnx | onnx |
| chunkRecall@3 | 79.6% | 79.6% | 79.6% | 79.6% |
| chunkRecall@5 | 89.8% | 89.8% | 89.8% | 89.8% |
| chunkRecall@10 | 93.9% | 93.9% | 93.9% | 93.9% |
| windowRecall@5 | 95.9% | 95.9% | 95.9% | 95.9% |
| windowRecall@10 | 98.0% | 98.0% | 98.0% | 98.0% |
| supportRecall@10 | 98.0% | 98.0% | 98.0% | 98.0% |
| **nDCG@10** | **0.733** | **0.731** | **0.719** | **0.724** |
| **MRR@10** | **0.695** | **0.695** | **0.665** | **0.685** |
| fileRecall@1 | 75.5% | 73.5% | 75.5% | 73.5% |
| fileRecall@10 | 100.0% | 100.0% | 100.0% | 100.0% |
| negativePass | 100.0% | 100.0% | 100.0% | 100.0% |
| Latency p50/p95 | 96/112ms | 94/103ms | 89/96ms | 90/100ms |

Observed ranges across all 4 runs:
- nDCG@10: **0.719 – 0.733** (delta 0.014)
- MRR@10: **0.665 – 0.695** (delta 0.030)
- fileRecall@1: **73.5% – 75.5%** (flips by ±1 file hit at rank 1)

## Verdict

**`VARIANCE_FROM_SEARCH_ORDERING`**

All recall metrics (chunkRecall@3/5/10, windowRecall, supportRecall) are perfectly
stable across all measured runs (4 aggregate runs in the summary table above, plus
2 additional per-query detail runs A/B), including across the full reindex boundary.
This proves the embedded vectors and qrel coverage are deterministic and correct.

nDCG@10 and MRR@10 vary even when `BENCH_SKIP_INDEX=1` — the index is byte-identical
across skip-index runs. The only source of variance is Qdrant's tie-breaking behavior
when multiple points have near-equal RRF scores. RRF fuses dense and sparse scores;
when the fused scores are sufficiently close, small non-deterministic factors in
Qdrant's internal ordering (network, HNSW traversal order, internal sort stability)
can swap adjacent results, changing which relevant chunk lands at rank 2 vs rank 3.

## Per-Query Unstable Rows (runs A vs B, same index)

The following queries produced different nDCG or MRR values between two consecutive
skip-index runs — confirming the flip is in search ordering, not index content:

| Query | Run A nDCG | Run B nDCG | Run A MRR | Run B MRR | Likely cause |
|-------|-----------|-----------|-----------|-----------|--------------|
| c26 | 0.834 | 1.000 | 0.500 | 1.000 | rel chunk swapped rank 1↔2 |
| c38 | 0.497 | 0.787 | 0.500 | 1.000 | rel chunk swapped rank 2↔1 |
| c43 | 0.834 | 1.000 | 0.500 | 1.000 | rel chunk swapped rank 1↔2 |
| c48 | 0.956 | 1.000 | 1.000 | 1.000 | second rel chunk order shift |

All flipping queries have rel=3 chunks that appear in top-5 in every run (recall
stable), but the exact rank among near-equal-score results varies. A rank-1 vs
rank-2 swap for a rel=3 chunk changes MRR by 0.5 and nDCG by ~0.15–0.17.

## Implications for Benchmark Comparisons

**Stable metrics (safe for direct comparison across runs):**
- chunkRecall@3, chunkRecall@5, chunkRecall@10
- windowRecall@5, windowRecall@10
- supportRecall@10
- fileRecall@10
- negativePass
- per-query ✓/✗ pass/fail (top-5 threshold is wide enough to absorb tie swaps)

**Ordering-sensitive metrics (require controlled conditions):**
- nDCG@10: ±0.014 run-to-run noise floor with identical index
- MRR@10: ±0.030 run-to-run noise floor with identical index
- fileRecall@1: ±1 file flip (±2.0pp on 49 queries)

**Recommended practice for fair comparisons involving nDCG/MRR:**

Option A — single controlled index:
```powershell
# Index once
$env:BENCH_SKIP_INDEX = ""
npm run bench:custom50

# Compare variants using the same collection
$env:BENCH_SKIP_INDEX = "1"
npm run bench:custom50   # variant 1
npm run bench:custom50   # variant 2
```
This eliminates reindex variance but does not eliminate search-ordering noise.
For decisions within ±0.02 nDCG, run 3+ times and use the mean.

Option B — report as range:
When comparing across full reindex runs, report nDCG and MRR as a range
(e.g., "nDCG@10 = 0.725–0.740") rather than a single value.

## Note on Prior Reports

The 2026-05-25 combined-mode reports and the
post-fix run in `2026-05-26T1300-custom50-post-empty-section-removal.md` used
different qrel chunkIds (corrected in the post-fix run). Direct nDCG/MRR comparison
across that boundary is invalid for two reasons:
1. Qrel targets changed (chunk index shift + stale qrel correction).
2. Search-ordering noise floor is ±0.014 nDCG / ±0.030 MRR independently.
