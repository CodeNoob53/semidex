# Combined Context-Only Ablation — custom-50 — 2026-05-22

## Purpose

Test hypothesis: does asking the model for both context AND tags in one combined prompt
degrade context quality vs asking for context only?

- **baseline separate**: production separate context + tags path (COMBINED_LLM=0)
- **combined ctx+tags**: COMBINED_LLM=1, one call returns {"context","tags"}
- **combined ctx-only**: COMBINED_LLM=1 + BENCH_COMBINED_CONTEXT_ONLY=1, one call returns {"context"}, tags=[]

## Environment

| Item | Value |
|------|-------|
| Node.js | v25.2.1 |
| DENSE_PROVIDER | bge-m3-onnx |
| ONNX_EXECUTION_PROVIDER | cpu |
| Model | gemma3:4b |
| Corpus | custom-50 fixture docs (10 files) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Search mode | hybrid (RRF) |
| Top-K | 10 |

## Indexing

| Variant | Exit | Points | Wall time | Combined fallbacks | Tag batch fallbacks |
|---------|------|--------|-----------|-------------------|---------------------|
| baseline separate | OK | 101 | 184801 ms | n/a | 8 |
| combined ctx+tags | OK | 101 | 157111 ms | 1 | n/a |
| combined ctx-only | OK | 101 | 140929 ms | 1 | n/a |

## Aggregate Metrics

| Metric | baseline | ctx+tags (Δ) | ctx-only (Δ) |
|--------|----------|-------------|-------------|
| chunkRecall@3 | 89.8% | 85.7% (-0.041) | 83.7% (-0.061) |
| chunkRecall@5 | 93.9% | 91.8% (-0.020) | 93.9% (—) |
| chunkRecall@10 | 95.9% | 98.0% (+0.020) | 95.9% (—) |
| windowRecall@5 | 98.0% | 98.0% (—) | 98.0% (—) |
| windowRecall@10 | 98.0% | 100.0% (+0.020) | 98.0% (—) |
| supportRecall@10 | 98.0% | 100.0% (+0.020) | 98.0% (—) |
| nDCG@10 | 0.763 | 0.761 (-0.002) | 0.746 (-0.017) |
| MRR@10 | 0.723 | 0.733 (+0.010) | 0.696 (-0.027) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Δ = combined variant − baseline.*

## Per-Query Diff: combined ctx+tags vs baseline

7 regressed (1 hard / 6 soft), 7 improved, 35 unchanged

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c05 | conceptual | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c06 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c12 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.609 | -0.178 | ✓ | ✓ | **regressed** |
| c26 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c37 | source-navigation | 0.333 | 0.200 | -0.133 | 0.514 | 0.305 | -0.209 | ✓ | ✓ | **regressed** |
| c31 | config-env | 0.333 | 0.250 | -0.083 | 0.606 | 0.676 | +0.070 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.143 | -0.057 | 0.517 | 0.431 | -0.086 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.213 | 0.169 | -0.044 | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.598 | 0.594 | -0.004 | ✓ | ✓ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.617 | 0.642 | +0.025 | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.932 | — | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.900 | -0.100 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.885 | -0.015 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 0.956 | 0.907 | -0.049 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.500 | 0.500 | — | 0.642 | 0.665 | +0.023 | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.918 | 0.956 | +0.038 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.598 | +0.102 | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.500 | 0.491 | -0.009 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.143 | — | 0.475 | 0.475 | — | ✗ | ✗ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.900 | 0.907 | +0.008 | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.111 | +0.111 | 0.000 | 0.237 | +0.237 | ✗ | ✗ | improved |
| c35 | source-navigation | 0.333 | 0.500 | +0.167 | 0.539 | 0.497 | -0.042 | ✓ | ✓ | improved |
| c08 | exact-token | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c15 | config-env | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c25 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c28 | exact-token | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c36 | source-navigation | 0.500 | 1.000 | +0.500 | 0.651 | 0.877 | +0.226 | ✓ | ✓ | improved |

## Regression Detail: combined ctx+tags

### c05 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c06 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c12 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.609 (-0.178)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c26 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c31 (config-env) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.606 → 0.676 (+0.070)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 2

### c37 (source-navigation) — soft

- MRR: 0.333 → 0.200 (-0.133)
- nDCG@10: 0.514 → 0.305 (-0.209)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.143 (-0.057)
- nDCG@10: 0.517 → 0.431 (-0.086)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

## Per-Query Diff: combined ctx-only vs baseline

9 regressed (0 hard / 9 soft), 4 improved, 36 unchanged

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c26 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c33 | conceptual | 1.000 | 0.500 | -0.500 | 0.956 | 0.834 | -0.122 | ✓ | ✓ | **regressed** |
| c49 | config-env | 1.000 | 0.500 | -0.500 | 0.900 | 0.609 | -0.291 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 0.500 | 0.200 | -0.300 | 0.651 | 0.431 | -0.220 | ✓ | ✓ | **regressed** |
| c03 | provider-activation | 0.500 | 0.333 | -0.167 | 0.598 | 0.495 | -0.103 | ✓ | ✓ | **regressed** |
| c15 | config-env | 0.500 | 0.333 | -0.167 | 0.834 | 0.731 | -0.103 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 0.500 | 0.333 | -0.167 | 0.642 | 0.606 | -0.036 | ✓ | ✓ | **regressed** |
| c37 | source-navigation | 0.333 | 0.200 | -0.133 | 0.514 | 0.406 | -0.108 | ✓ | ✓ | **regressed** |
| c31 | config-env | 0.333 | 0.250 | -0.083 | 0.606 | 0.676 | +0.070 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.213 | 0.213 | — | ✗ | ✗ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.617 | 0.665 | +0.049 | ✓ | ✓ | — |
| c05 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c06 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.900 | +0.112 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.894 | -0.106 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.787 | -0.112 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.603 | +0.106 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c41 | conceptual | 0.200 | 0.200 | — | 0.517 | 0.450 | -0.068 | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.918 | 0.956 | +0.038 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.500 | 0.495 | -0.005 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.167 | +0.024 | 0.475 | 0.449 | -0.026 | ✗ | ✗ | improved |
| c35 | source-navigation | 0.333 | 0.500 | +0.167 | 0.539 | 0.497 | -0.042 | ✓ | ✓ | improved |
| c25 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c28 | exact-token | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |

## Regression Detail: combined ctx-only

### c03 (provider-activation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.598 → 0.495 (-0.103)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c15 (config-env) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.834 → 0.731 (-0.103)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 2 → 2

### c26 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c31 (config-env) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.606 → 0.676 (+0.070)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 2

### c33 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.956 → 0.834 (-0.122)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c36 (source-navigation) — soft

- MRR: 0.500 → 0.200 (-0.300)
- nDCG@10: 0.651 → 0.431 (-0.220)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c37 (source-navigation) — soft

- MRR: 0.333 → 0.200 (-0.133)
- nDCG@10: 0.514 → 0.406 (-0.108)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c39 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.642 → 0.606 (-0.036)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c49 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.900 → 0.609 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

## Hypothesis Answer

| Comparison | MRR@10 Δ | nDCG@10 Δ | Hard regressions |
|------------|----------|-----------|-----------------|
| ctx+tags vs baseline | +0.010 | -0.002 | 1 |
| ctx-only vs baseline | -0.027 | -0.017 | 0 |
| ctx-only vs ctx+tags | -0.037 | -0.015 | -1 |

**HYPOTHESIS REJECTED**: ctx-only does not recover quality vs ctx+tags.
The tags field in the prompt is not degrading context. Regression source is
likely the combined prompt wording itself, JSON format constraint, or LLM variance.

## Notes

- `BENCH_COMBINED_CONTEXT_ONLY=1` is a benchmark-only flag in `src/indexer/phases/combined.js`.
  Do not use it in production. Not documented as stable config.
- ctx-only variant stores tags=[] — tag-based retrieval (qdrant_find_by_tag) not usable for those chunks.
- Production default (baseline separate path) unchanged.

*Generated: 2026-05-22*