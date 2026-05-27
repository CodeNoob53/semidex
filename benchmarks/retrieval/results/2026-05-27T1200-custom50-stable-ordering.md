# custom-50 Stable Ordering Fix

*Generated: 2026-05-27*

## Purpose

Eliminate MRR/nDCG run-to-run variance caused by Qdrant RRF tie-breaking on
near-equal scores. Adds a deterministic post-search sort to all custom-50
benchmark scripts without changing production MCP result ordering.

## Problem

`2026-05-26T1430-custom50-variance-source-check.md` confirmed:

- nDCG@10 variance across skip-index runs: ±0.014 (range 0.719–0.733)
- MRR@10 variance across skip-index runs: ±0.030 (range 0.665–0.695)
- Root cause: RRF fuses dense + sparse scores; near-equal results can swap
  rank within a single Qdrant call due to HNSW traversal order / internal
  sort instability. Affected queries: c26, c38, c43, c48.

## Implementation

### New shared helper

`benchmarks/retrieval/custom-50/sort-results.js` — `stableSortResults(results)`

Tie-break order applied after hybrid RRF result lists. MMR output (`dense-mmr`
mode) is intentionally left in diversity-selected order — re-sorting by score
would undo the MMR diversity ranking, which is the intended final ordering for
that mode. The variance diagnosed in T1430 was hybrid RRF tie-order noise only.

1. `score` descending (preserves retrieval ranking — no reordering of genuinely
   different scores)
2. `payload.source_file` ascending (alphabetic)
3. `payload.chunk_index` ascending (earlier chunk wins within same file)
4. point `id` ascending (UUID string order — last resort for truly identical
   payloads)

The sort is a copy (`results.slice().sort(…)`) — input array is not mutated.

### Files changed

| File | Change |
|------|--------|
| `benchmarks/retrieval/custom-50/sort-results.js` | **new** — shared helper |
| `benchmarks/retrieval/custom-50/run-v3.js` | import + apply in `runQuery` return |
| `benchmarks/retrieval/custom-50/combined-llm-quality-matrix.js` | import + apply in `runQuery` |
| `benchmarks/retrieval/custom-50/combined-context-only-ablation.js` | import + apply in `runQuery` |
| `benchmarks/retrieval/custom-50/combined-llm-quality.js` | import + apply in `runQuery` |
| `benchmarks/retrieval/custom-50/tag-gen-ablation.js` | import + apply in `runQuery` |
| `benchmarks/retrieval/custom-50/context-policy-bench.js` | import + apply inline in query loop |
| `benchmarks/retrieval/custom-50/combined-hard-regression-diagnostic.js` | import + apply in `runQuery` |

### Scripts not patched — rationale

| File | Reason |
|------|--------|
| `colbert-bench.js`, `cross-encoder-bench.js`, `ce-routing-bench.js` | Use `hybridSearch` as one of several candidate pools for reranker comparison; per-script design uses multi-call comparison where tie-break identity across variants matters more than run-to-run stability — and these scripts index fresh collections per run anyway |
| `ce-latency-probe.js` | Latency-only probe; computes nDCG but results are informational, not decision-quality metrics |
| `diagnostics.js`, `threshold-sweep.js`, `agent-policy.js`, `smoke-live-window.js` | Diagnostic / exploratory / live-workflow scripts; do not produce quality-decision MRR/nDCG reports |
| `analyze-failures.js`, `compare-candidates.js`, `tuning-matrix.js`, `rank1-analysis.js` | Post-processing / comparison scripts; operate on already-retrieved results, not direct search callers |
| `c03-diagnostic.js` | Single-query diagnostic; ad-hoc, not part of automated benchmark runs |

Production MCP (`src/mcp/tools/search.js`) is **not changed**. No shared helper
in `src/` was modified.

---

## Smoke test

```
Smoke tests: 650 passed, 0 failed
```

---

## Validation

### Run 0 — full reindex (post-sort)

```powershell
$env:ONNX_EMBED = "1"; $env:BENCH_PROVIDER = "onnx"
Remove-Item Env:BENCH_SKIP_INDEX -ErrorAction SilentlyContinue
npm run bench:custom50
```

| Metric | Value |
|--------|-------|
| chunkRecall@3 | 79.6% |
| chunkRecall@5 | 89.8% |
| chunkRecall@10 | 93.9% |
| nDCG@10 | 0.721 |
| MRR@10 | 0.675 |
| fileRecall@1 | 71.4% |
| negativePass | 100.0% |

### Runs 1–3 — BENCH_SKIP_INDEX=1 (same collection)

```powershell
$env:BENCH_SKIP_INDEX = "1"
npm run bench:custom50   # run 1
npm run bench:custom50   # run 2
npm run bench:custom50   # run 3
```

| Metric | Run 1 | Run 2 | Run 3 | Stable? |
|--------|-------|-------|-------|---------|
| chunkRecall@3 | 79.6% | 79.6% | 79.6% | ✓ |
| chunkRecall@5 | 89.8% | 89.8% | 89.8% | ✓ |
| chunkRecall@10 | 93.9% | 93.9% | 93.9% | ✓ |
| nDCG@10 | 0.721 | 0.721 | 0.721 | ✓ |
| MRR@10 | 0.675 | 0.675 | 0.675 | ✓ |
| fileRecall@1 | 71.4% | 71.4% | 71.4% | ✓ |
| negativePass | 100.0% | 100.0% | 100.0% | ✓ |

All metrics bit-identical across all three runs.

---

## Before / After Comparison vs Variance Source Check

| Metric | Pre-fix range (T1430) | Post-fix range (this run) | Delta |
|--------|-----------------------|--------------------------|-------|
| chunkRecall@3 | 79.6% (stable) | 79.6% (stable) | 0 |
| chunkRecall@5 | 89.8% (stable) | 89.8% (stable) | 0 |
| chunkRecall@10 | 93.9% (stable) | 93.9% (stable) | 0 |
| nDCG@10 | 0.719–0.733 (±0.014) | **0.721 (±0.000)** | variance eliminated |
| MRR@10 | 0.665–0.695 (±0.030) | **0.675 (±0.000)** | variance eliminated |
| fileRecall@1 | 73.5%–75.5% (±2.0pp) | **71.4% (±0.0pp)** | variance eliminated |

Note: absolute nDCG/MRR values differ from T1430 because this run uses a fresh
reindex (different random UUIDs → different HNSW tie-order at index time). The
post-fix point is that repeated skip-index runs are now identical, not that they
match T1430 values exactly.

---

## Verdict

**`STABLE_ORDERING_FIX_CONFIRMED`**

The tie-break sort eliminates all MRR/nDCG run-to-run variance for skip-index
runs. Three consecutive `BENCH_SKIP_INDEX=1` runs produced bit-identical results
for all metrics. The previously noisy queries (c26, c38, c43, c48) are now
deterministically ordered.

Production MCP result ordering is unchanged — `src/mcp/tools/search.js` was not
modified. The fix is benchmark-harness only.
