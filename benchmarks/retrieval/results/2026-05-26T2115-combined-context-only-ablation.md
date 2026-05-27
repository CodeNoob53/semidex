# Combined Context-Only Ablation — custom-50 — 2026-05-26

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
| baseline separate | OK | 96 | 803330 ms | n/a | 6 |
| combined ctx+tags | OK | 96 | 210687 ms | 0 | n/a |
| combined ctx-only | OK | 96 | 175942 ms | 1 | n/a |

## Aggregate Metrics

| Metric | baseline | ctx+tags (Δ) | ctx-only (Δ) |
|--------|----------|-------------|-------------|
| chunkRecall@3 | 91.8% | 91.8% (—) | 87.8% (-0.041) |
| chunkRecall@5 | 95.9% | 93.9% (-0.020) | 93.9% (-0.020) |
| chunkRecall@10 | 95.9% | 95.9% (—) | 95.9% (—) |
| windowRecall@5 | 95.9% | 98.0% (+0.020) | 98.0% (+0.020) |
| windowRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| supportRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| nDCG@10 | 0.797 | 0.764 (-0.033) | 0.749 (-0.048) |
| MRR@10 | 0.788 | 0.733 (-0.055) | 0.721 (-0.067) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Δ = combined variant − baseline.*

## Per-Query Diff: combined ctx+tags vs baseline

9 regressed (1 hard / 8 soft), 2 improved, 38 unchanged

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c05 | conceptual | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c15 | config-env | 1.000 | 0.333 | -0.667 | 1.000 | 0.606 | -0.394 | ✓ | ✓ | **regressed** |
| c06 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c26 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c35 | source-navigation | 1.000 | 0.500 | -0.500 | 0.932 | 0.665 | -0.267 | ✓ | ✓ | **regressed** |
| c03 | provider-activation | 0.500 | 0.333 | -0.167 | 0.594 | 0.495 | -0.099 | ✓ | ✓ | **regressed** |
| c37 | source-navigation | 0.500 | 0.333 | -0.167 | 0.603 | 0.394 | -0.209 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 0.500 | 0.333 | -0.167 | 0.665 | 0.606 | -0.059 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.167 | -0.033 | 0.517 | 0.493 | -0.024 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.932 | 1.000 | +0.068 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.112 | 0.213 | +0.100 | ✗ | ✗ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.918 | 0.918 | — | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.907 | 0.787 | -0.120 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.918 | +0.131 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 0.500 | 0.500 | — | 0.834 | 0.834 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.642 | +0.145 | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.918 | 0.932 | +0.015 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.500 | 0.500 | — | 0.609 | 0.609 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c04 | exact-token | 0.333 | 0.500 | +0.167 | 0.524 | 0.617 | +0.093 | ✓ | ✓ | improved |
| c36 | source-navigation | 0.500 | 1.000 | +0.500 | 0.693 | 0.877 | +0.184 | ✓ | ✓ | improved |

## Regression Detail: combined ctx+tags

### c03 (provider-activation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.594 → 0.495 (-0.099)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c05 (conceptual) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.787 → 0.394 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c06 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c15 (config-env) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 1.000 → 0.606 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c26 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c35 (source-navigation) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.932 → 0.665 (-0.267)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c37 (source-navigation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.603 → 0.394 (-0.209)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c39 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.665 → 0.606 (-0.059)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.167 (-0.033)
- nDCG@10: 0.517 → 0.493 (-0.024)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

## Per-Query Diff: combined ctx-only vs baseline

11 regressed (1 hard / 10 soft), 2 improved, 36 unchanged

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c12 | exact-token | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c15 | config-env | 1.000 | 0.333 | -0.667 | 1.000 | 0.606 | -0.394 | ✓ | ✓ | **regressed** |
| c49 | config-env | 1.000 | 0.333 | -0.667 | 1.000 | 0.731 | -0.269 | ✓ | ✓ | **regressed** |
| c05 | conceptual | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c06 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c08 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c37 | source-navigation | 0.500 | 0.250 | -0.250 | 0.603 | 0.437 | -0.167 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 0.500 | 0.333 | -0.167 | 0.693 | 0.544 | -0.150 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 0.500 | 0.333 | -0.167 | 0.665 | 0.606 | -0.059 | ✓ | ✓ | **regressed** |
| c31 | config-env | 0.333 | 0.200 | -0.133 | 0.606 | 0.473 | -0.133 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.143 | -0.057 | 0.517 | 0.475 | -0.042 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.932 | 1.000 | +0.068 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.112 | 0.213 | +0.100 | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.594 | 0.497 | -0.098 | ✓ | ✓ | — |
| c04 | exact-token | 0.333 | 0.333 | — | 0.524 | 0.539 | +0.015 | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.918 | 0.894 | -0.024 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.907 | 0.787 | -0.120 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 0.500 | 0.500 | — | 0.834 | 0.834 | — | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 1.000 | 1.000 | — | 0.932 | 0.885 | -0.048 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.918 | 0.932 | +0.015 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.500 | 0.500 | — | 0.609 | 0.598 | -0.011 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c45 | config-env | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |

## Regression Detail: combined ctx-only

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

### c08 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c12 (exact-token) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.787 → 0.394 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c15 (config-env) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 1.000 → 0.606 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c31 (config-env) — soft

- MRR: 0.333 → 0.200 (-0.133)
- nDCG@10: 0.606 → 0.473 (-0.133)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c36 (source-navigation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.693 → 0.544 (-0.150)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c37 (source-navigation) — soft

- MRR: 0.500 → 0.250 (-0.250)
- nDCG@10: 0.603 → 0.437 (-0.167)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c39 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.665 → 0.606 (-0.059)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.143 (-0.057)
- nDCG@10: 0.517 → 0.475 (-0.042)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c49 (config-env) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 1.000 → 0.731 (-0.269)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

## Hypothesis Answer

| Comparison | MRR@10 Δ | nDCG@10 Δ | Hard regressions |
|------------|----------|-----------|-----------------|
| ctx+tags vs baseline | -0.055 | -0.033 | 1 |
| ctx-only vs baseline | -0.067 | -0.048 | 1 |
| ctx-only vs ctx+tags | -0.012 | -0.015 | — |

**HYPOTHESIS REJECTED**: ctx-only does not recover quality vs ctx+tags.
The tags field in the prompt is not degrading context. Regression source is
likely the combined prompt wording itself, JSON format constraint, or LLM variance.

## Notes

- `BENCH_COMBINED_CONTEXT_ONLY=1` is a benchmark-only flag in `src/indexer/phases/combined.js`.
  Do not use it in production. Not documented as stable config.
- ctx-only variant stores tags=[] — tag-based retrieval (qdrant_find_by_tag) not usable for those chunks.
- Production default (baseline separate path) unchanged.

*Generated: 2026-05-26*