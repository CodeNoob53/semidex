# COMBINED_LLM=1 — custom-50 Retrieval Quality — 2026-05-17

## Environment

| Item | Value |
|------|-------|
| Node.js | v25.2.1 |
| CONTEXT_MODEL | gemma3:4b |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | cpu (default) |
| Corpus | custom-50 fixture docs (10 files) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Search mode | hybrid (RRF) |
| Top-K | 10 |

## Indexing

| Run | Exit | Points | Wall time | Phase context (mean/file) | Phase tag (mean/file) | Combined fallbacks | Tag batch fallbacks |
|-----|------|--------|-----------|--------------------------|----------------------|-------------------|---------------------|
| Baseline | OK | 101 | 432840 ms | 7656 ms | 32217 ms | n/a | 13 |
| Combined | OK | 101 | 156713 ms | 42 ms (merge) | 12251 ms | 1 | n/a |

*Combined path records context=0 ms (merge only) and all LLM time under tag.*

## Aggregate Metrics

| Metric | Baseline | Combined | Delta |
|--------|----------|----------|-------|
| chunkRecall@3 | 87.8% | 87.8% | — |
| chunkRecall@5 | 93.9% | 89.8% | -0.041 |
| chunkRecall@10 | 98.0% | 95.9% | -0.020 |
| windowRecall@5 | 98.0% | 98.0% | — |
| windowRecall@10 | 100.0% | 98.0% | -0.020 |
| supportRecall@10 | 100.0% | 98.0% | -0.020 |
| nDCG@10 | 0.760 | 0.751 | -0.009 |
| MRR@10 | 0.728 | 0.718 | -0.010 |
| negativePass | 100.0% | 100.0% | — |

## Per-Query Diff (positive queries only)

8 regressed (2 hard / 6 soft), 3 improved, 38 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5 (chunk no longer in top-5). Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c11 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c12 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.594 | -0.193 | ✓ | ✓ | **regressed** |
| c27 | exact-token | 1.000 | 0.500 | -0.500 | 0.956 | 0.665 | -0.291 | ✓ | ✓ | **regressed** |
| c35 | source-navigation | 0.500 | 0.333 | -0.167 | 0.665 | 0.731 | +0.066 | ✓ | ✓ | **regressed** |
| c29 | conceptual | 0.111 | 0.000 | -0.111 | 0.237 | 0.000 | -0.237 | ✗ | ✗ | **regressed** |
| c04 | exact-token | 0.250 | 0.143 | -0.107 | 0.470 | 0.408 | -0.062 | ✓ | ✗ | **regressed** |
| c41 | conceptual | 0.250 | 0.143 | -0.107 | 0.552 | 0.408 | -0.144 | ✓ | ✗ | **regressed** |
| c48 | cross-lingual-ua-en | 0.143 | 0.125 | -0.018 | 0.475 | 0.461 | -0.014 | ✗ | ✗ | **regressed** |
| c02 | conceptual | 0.000 | 0.000 | — | 0.213 | 0.337 | +0.125 | ✗ | ✗ | — |
| c05 | conceptual | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c15 | config-env | 0.500 | 0.500 | — | 0.665 | 0.665 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.900 | 0.907 | +0.008 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.932 | -0.068 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.787 | -0.112 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.731 | +0.125 | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c36 | source-navigation | 1.000 | 1.000 | — | 0.850 | 0.807 | -0.044 | ✓ | ✓ | — |
| c37 | source-navigation | 0.500 | 0.500 | — | 0.627 | 0.617 | -0.010 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.500 | 0.500 | — | 0.665 | 0.642 | -0.023 | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.918 | -0.038 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.539 | 0.514 | -0.025 | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.907 | 0.932 | +0.025 | ✓ | ✓ | — |
| c01 | exact-token | 0.500 | 1.000 | +0.500 | 0.642 | 0.932 | +0.291 | ✓ | ✓ | improved |
| c03 | provider-activation | 0.500 | 1.000 | +0.500 | 0.617 | 0.918 | +0.301 | ✓ | ✓ | improved |
| c32 | config-env | 0.500 | 1.000 | +0.500 | 0.598 | 0.787 | +0.189 | ✓ | ✓ | improved |

## Regression Detail

Queries where combined MRR@10 < baseline MRR@10 by more than 0.001.
Hard = lost chunkRecall@5 (structural miss). Soft = rank-order shift within hit set (LLM variance).

### c04 (exact-token) — hard

- MRR: 0.250 → 0.143 (-0.107)
- nDCG@10: 0.470 → 0.408 (-0.062)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c11 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c12 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.594 (-0.193)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c27 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.956 → 0.665 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c29 (conceptual) — soft

- MRR: 0.111 → 0.000 (-0.111)
- nDCG@10: 0.237 → 0.000 (-0.237)
- chunkRecall@5: ✗ → ✗
- top-1 relevance: 0 → 0

### c35 (source-navigation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.665 → 0.731 (+0.066)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 2

### c41 (conceptual) — hard

- MRR: 0.250 → 0.143 (-0.107)
- nDCG@10: 0.552 → 0.408 (-0.144)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c48 (cross-lingual-ua-en) — soft

- MRR: 0.143 → 0.125 (-0.018)
- nDCG@10: 0.475 → 0.461 (-0.014)
- chunkRecall@5: ✗ → ✗
- top-1 relevance: 0 → 0

## Verdict

**proceed opt-in with caution** — minor hard regressions detected but aggregate metrics within tolerance.

Hard regressions (lost chunkRecall@5): c04, c41. Review regression detail above.
Recommend re-running on larger corpus before any default promotion.

**Before making COMBINED_LLM=1 the default:**
1. Run on full 15-file benchmark corpus.
2. Verify no regressions on cross-lingual and config-env query types.
3. Address short-chunk context drift if COMBINED_MIN_CHARS threshold needs tuning.

*Generated: 2026-05-17 — collections: bench-c50-baseline-1779060224008, bench-c50-combined-1779060224008*