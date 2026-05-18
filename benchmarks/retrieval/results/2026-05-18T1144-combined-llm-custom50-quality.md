# COMBINED_LLM=1 — custom-50 Retrieval Quality — 2026-05-18

## Environment

| Item | Value |
|------|-------|
| Node.js | v25.2.1 |
| CONTEXT_MODEL | qwen2.5:3b-instruct |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | cpu (default) |
| Corpus | custom-50 fixture docs (10 files) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Search mode | hybrid (RRF) |
| Top-K | 10 |

## Indexing

| Run | Exit | Points | Wall time | Phase context (mean/file) | Phase tag (mean/file) | Combined fallbacks | Tag batch fallbacks |
|-----|------|--------|-----------|--------------------------|----------------------|-------------------|---------------------|
| Baseline | OK | 101 | 872281 ms | 4295 ms | 75869 ms | n/a | 21 |
| Combined | OK | 101 | 227798 ms | 42 ms (merge) | 16310 ms | 1 | n/a |

*Combined path records context=0 ms (merge only) and all LLM time under tag.*

## Aggregate Metrics

| Metric | Baseline | Combined | Delta |
|--------|----------|----------|-------|
| chunkRecall@3 | 83.7% | 89.8% | +0.061 |
| chunkRecall@5 | 89.8% | 95.9% | +0.061 |
| chunkRecall@10 | 95.9% | 95.9% | — |
| windowRecall@5 | 95.9% | 98.0% | +0.020 |
| windowRecall@10 | 98.0% | 98.0% | — |
| supportRecall@10 | 98.0% | 98.0% | — |
| nDCG@10 | 0.759 | 0.766 | +0.008 |
| MRR@10 | 0.753 | 0.748 | -0.005 |
| negativePass | 100.0% | 100.0% | — |

## Per-Query Diff (positive queries only)

5 regressed (0 hard / 5 soft), 9 improved, 35 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5 (chunk no longer in top-5). Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c05 | conceptual | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c07 | troubleshooting | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c08 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c25 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c38 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.169 | 0.131 | -0.038 | ✗ | ✗ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.956 | 0.900 | -0.056 | ✓ | ✓ | — |
| c11 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c15 | config-env | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.907 | -0.025 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.889 | +0.102 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.907 | +0.120 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.598 | 0.497 | -0.102 | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c36 | source-navigation | 0.333 | 0.333 | — | 0.307 | 0.491 | +0.185 | ✓ | ✓ | — |
| c39 | exact-token | 1.000 | 1.000 | — | 0.918 | 1.000 | +0.082 | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.495 | 0.506 | +0.011 | ✓ | ✓ | — |
| c41 | conceptual | 0.167 | 0.200 | +0.033 | 0.426 | 0.402 | -0.024 | ✗ | ✓ | improved |
| c48 | cross-lingual-ua-en | 0.167 | 0.200 | +0.033 | 0.493 | 0.517 | +0.024 | ✗ | ✓ | improved |
| c03 | provider-activation | 0.250 | 0.333 | +0.083 | 0.339 | 0.491 | +0.152 | ✓ | ✓ | improved |
| c49 | config-env | 0.250 | 0.333 | +0.083 | 0.451 | 0.514 | +0.062 | ✓ | ✓ | improved |
| c37 | source-navigation | 0.167 | 0.333 | +0.167 | 0.411 | 0.539 | +0.128 | ✗ | ✓ | improved |
| c04 | exact-token | 0.333 | 0.500 | +0.167 | 0.524 | 0.627 | +0.103 | ✓ | ✓ | improved |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c14 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c35 | source-navigation | 0.333 | 1.000 | +0.667 | 0.539 | 0.956 | +0.417 | ✓ | ✓ | improved |

## Regression Detail

Queries where combined MRR@10 < baseline MRR@10 by more than 0.001.
Hard = lost chunkRecall@5 (structural miss). Soft = rank-order shift within hit set (LLM variance).

### c05 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c07 (troubleshooting) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c08 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c25 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c38 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

## Verdict

**proceed opt-in** — COMBINED_LLM=1 shows no hard quality regression on custom-50.

MRR@10 delta: -0.005. chunkRecall@5 delta: +0.061. chunkRecall@10 delta: —. Combined parse fallbacks: 1.

5 soft regression(s) (rank-order shift within chunkRecall@5 hits, not retrieval misses): c05, c07, c08, c25, c38.
These reflect LLM context/tag phrasing variance affecting embedding score — not a structural retrieval failure.

COMBINED_LLM=1 remains opt-in. No default promotion needed at this time.

**Before making COMBINED_LLM=1 the default:**
1. Run on full 15-file benchmark corpus.
2. Verify no regressions on cross-lingual and config-env query types.
3. Address short-chunk context drift if COMBINED_MIN_CHARS threshold needs tuning.

*Generated: 2026-05-18 — collections: bench-c50-baseline-1779103540404, bench-c50-combined-1779103540404*