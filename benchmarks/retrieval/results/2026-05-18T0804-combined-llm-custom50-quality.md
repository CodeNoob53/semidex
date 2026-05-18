# COMBINED_LLM=1 — custom-50 Retrieval Quality — 2026-05-18

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
| Baseline | OK | 101 | 195451 ms | 8256 ms | 7937 ms | n/a | 7 |
| Combined | OK | 101 | 162743 ms | 44 ms (merge) | 12901 ms | 1 | n/a |

*Combined path records context=0 ms (merge only) and all LLM time under tag.*

## Aggregate Metrics

| Metric | Baseline | Combined | Delta |
|--------|----------|----------|-------|
| chunkRecall@3 | 85.7% | 85.7% | — |
| chunkRecall@5 | 93.9% | 89.8% | -0.041 |
| chunkRecall@10 | 95.9% | 98.0% | +0.020 |
| windowRecall@5 | 98.0% | 98.0% | — |
| windowRecall@10 | 98.0% | 98.0% | — |
| supportRecall@10 | 98.0% | 98.0% | — |
| nDCG@10 | 0.772 | 0.755 | -0.018 |
| MRR@10 | 0.746 | 0.705 | -0.041 |
| negativePass | 100.0% | 100.0% | — |

## Per-Query Diff (positive queries only)

12 regressed (2 hard / 10 soft), 6 improved, 31 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5 (chunk no longer in top-5). Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c37 | source-navigation | 1.000 | 0.333 | -0.667 | 0.907 | 0.514 | -0.394 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 0.500 | -0.500 | 0.918 | 0.627 | -0.291 | ✓ | ✓ | **regressed** |
| c08 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c11 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c32 | config-env | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c33 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c43 | config-env | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c49 | config-env | 1.000 | 0.500 | -0.500 | 0.907 | 0.627 | -0.280 | ✓ | ✓ | **regressed** |
| c35 | source-navigation | 0.500 | 0.333 | -0.167 | 0.665 | 0.731 | +0.066 | ✓ | ✓ | **regressed** |
| c04 | exact-token | 0.250 | 0.167 | -0.083 | 0.508 | 0.449 | -0.059 | ✓ | ✗ | **regressed** |
| c31 | config-env | 0.333 | 0.250 | -0.083 | 0.606 | 0.552 | -0.055 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.125 | -0.075 | 0.642 | 0.394 | -0.248 | ✓ | ✗ | **regressed** |
| c05 | conceptual | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.932 | -0.068 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.932 | +0.145 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c36 | source-navigation | 1.000 | 1.000 | — | 1.000 | 0.807 | -0.193 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.500 | 0.500 | — | 0.665 | 0.642 | -0.023 | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.932 | 0.918 | -0.015 | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.539 | 0.524 | -0.015 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.143 | — | 0.475 | 0.475 | — | ✗ | ✗ | — |
| c02 | conceptual | 0.000 | 0.100 | +0.100 | 0.213 | 0.565 | +0.352 | ✗ | ✗ | improved |
| c15 | config-env | 0.333 | 0.500 | +0.167 | 0.606 | 0.665 | +0.059 | ✓ | ✓ | improved |
| c03 | provider-activation | 0.500 | 1.000 | +0.500 | 0.627 | 0.932 | +0.305 | ✓ | ✓ | improved |
| c21 | conceptual | 0.500 | 1.000 | +0.500 | 0.497 | 0.889 | +0.392 | ✓ | ✓ | improved |
| c45 | config-env | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c28 | exact-token | 0.200 | 1.000 | +0.800 | 0.642 | 1.000 | +0.358 | ✓ | ✓ | improved |

## Regression Detail

Queries where combined MRR@10 < baseline MRR@10 by more than 0.001.
Hard = lost chunkRecall@5 (structural miss). Soft = rank-order shift within hit set (LLM variance).

### c01 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.918 → 0.627 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c04 (exact-token) — hard

- MRR: 0.250 → 0.167 (-0.083)
- nDCG@10: 0.508 → 0.449 (-0.059)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c08 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c11 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c31 (config-env) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.606 → 0.552 (-0.055)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c32 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c33 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c35 (source-navigation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.665 → 0.731 (+0.066)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 2

### c37 (source-navigation) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.907 → 0.514 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.125 (-0.075)
- nDCG@10: 0.642 → 0.394 (-0.248)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 2 → 0

### c43 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c49 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.907 → 0.627 (-0.280)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

## Verdict

**defer** — 2 hard regression(s) detected. MRR@10 delta: -0.041.

Hard regressions (lost chunkRecall@5): c04, c41.
Investigate context/tag quality on failed cases before promoting COMBINED_LLM=1 as opt-in default.

**Before making COMBINED_LLM=1 the default:**
1. Run on full 15-file benchmark corpus.
2. Verify no regressions on cross-lingual and config-env query types.
3. Address short-chunk context drift if COMBINED_MIN_CHARS threshold needs tuning.

*Generated: 2026-05-18 — collections: bench-c50-baseline-1779091101118, bench-c50-combined-1779091101118*