# COMBINED_LLM=1 Quality Matrix — custom-50 — 2026-05-22

## Purpose

Compare retrieval quality for baseline (separate context+tags) against
COMBINED_LLM=1 with each tested model. A shared baseline eliminates
run-to-run variance from confounding per-model comparisons.

## Environment

| Item | Value |
|------|-------|
| Node.js | v25.2.1 |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | cpu |
| Corpus | custom-50 fixture docs (10 files) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Search mode | hybrid (RRF) |
| Top-K | 10 |
| Combined models tested | gemma3:4b, qwen2.5:3b-instruct |

## Indexing

| Variant | Exit | Points | Wall time | Combined fallbacks | Tag batch fallbacks |
|---------|------|--------|-----------|-------------------|---------------------|
| baseline (separate) | OK | 101 | 178646 ms | n/a | 6 |
| combined gemma3:4b | OK | 101 | 149955 ms | 0 | n/a |
| combined qwen2.5:3b-instruct | OK | 101 | 163815 ms | 0 | n/a |

## Aggregate Metrics

| Metric | baseline | gemma3:4b | qwen2.5:3b-instruct |
|--------|----------|---|---|
| chunkRecall@3 | 89.8% | 87.8% (-0.020) | 81.6% (-0.082) |
| chunkRecall@5 | 93.9% | 91.8% (-0.020) | 89.8% (-0.041) |
| chunkRecall@10 | 95.9% | 95.9% (—) | 95.9% (—) |
| windowRecall@5 | 98.0% | 98.0% (—) | 93.9% (-0.041) |
| windowRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| supportRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| nDCG@10 | 0.771 | 0.737 (-0.034) | 0.739 (-0.032) |
| MRR@10 | 0.750 | 0.700 (-0.050) | 0.725 (-0.025) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Delta vs shared baseline in parentheses.*

## Per-Query Diff: combined gemma3:4b vs baseline

9 regressed (1 hard / 8 soft), 2 improved, 38 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c05 | conceptual | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c25 | conceptual | 1.000 | 0.333 | -0.667 | 1.000 | 0.731 | -0.269 | ✓ | ✓ | **regressed** |
| c08 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c20 | config-env | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c37 | source-navigation | 0.500 | 0.333 | -0.167 | 0.603 | 0.394 | -0.209 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 0.500 | 0.333 | -0.167 | 0.665 | 0.606 | -0.059 | ✓ | ✓ | **regressed** |
| c47 | exact-token | 0.500 | 0.333 | -0.167 | 0.598 | 0.491 | -0.107 | ✓ | ✓ | **regressed** |
| c31 | config-env | 0.333 | 0.250 | -0.083 | 0.606 | 0.552 | -0.055 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.143 | -0.057 | 0.642 | 0.600 | -0.042 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.145 | 0.213 | +0.068 | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.497 | 0.598 | +0.102 | ✓ | ✓ | — |
| c04 | exact-token | 0.333 | 0.333 | — | 0.506 | 0.606 | +0.100 | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.885 | 0.787 | -0.098 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c15 | config-env | 0.500 | 0.500 | — | 0.834 | 0.665 | -0.169 | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.907 | 0.894 | -0.014 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.787 | -0.112 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.665 | +0.169 | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 0.500 | 0.500 | — | 0.598 | 0.603 | +0.005 | ✓ | ✓ | — |
| c36 | source-navigation | 0.500 | 0.500 | — | 0.651 | 0.580 | -0.071 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.918 | -0.038 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.900 | 0.900 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.167 | +0.024 | 0.475 | 0.493 | +0.018 | ✗ | ✗ | improved |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |

## Regression Detail: gemma3:4b

### c05 (conceptual) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.787 → 0.394 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c08 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c20 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c25 (conceptual) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 1.000 → 0.731 (-0.269)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c31 (config-env) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.606 → 0.552 (-0.055)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

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

- MRR: 0.200 → 0.143 (-0.057)
- nDCG@10: 0.642 → 0.600 (-0.042)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 2 → 2

### c47 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.598 → 0.491 (-0.107)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

## Per-Query Diff: combined qwen2.5:3b-instruct vs baseline

10 regressed (2 hard / 8 soft), 5 improved, 34 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c08 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c20 | config-env | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c26 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 0.500 | 0.143 | -0.357 | 0.651 | 0.389 | -0.262 | ✓ | ✗ | **regressed** |
| c37 | source-navigation | 0.500 | 0.167 | -0.333 | 0.603 | 0.426 | -0.177 | ✓ | ✗ | **regressed** |
| c35 | source-navigation | 0.500 | 0.200 | -0.300 | 0.598 | 0.305 | -0.294 | ✓ | ✓ | **regressed** |
| c03 | provider-activation | 0.500 | 0.250 | -0.250 | 0.497 | 0.339 | -0.158 | ✓ | ✓ | **regressed** |
| c06 | exact-token | 0.500 | 0.333 | -0.167 | 0.631 | 0.500 | -0.131 | ✓ | ✓ | **regressed** |
| c07 | troubleshooting | 0.500 | 0.333 | -0.167 | 0.631 | 0.500 | -0.131 | ✓ | ✓ | **regressed** |
| c47 | exact-token | 0.500 | 0.333 | -0.167 | 0.598 | 0.500 | -0.098 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.145 | 0.145 | — | ✗ | ✗ | — |
| c04 | exact-token | 0.333 | 0.333 | — | 0.506 | 0.514 | +0.008 | ✓ | ✓ | — |
| c05 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 0.918 | -0.082 | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.885 | 0.894 | +0.009 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.907 | 0.932 | +0.025 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.894 | -0.106 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.932 | 0.885 | -0.048 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.787 | -0.112 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.500 | 0.500 | — | 0.665 | 0.642 | -0.023 | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c41 | conceptual | 0.200 | 0.200 | — | 0.642 | 0.305 | -0.337 | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.900 | 0.900 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.167 | +0.024 | 0.475 | 0.449 | -0.026 | ✗ | ✗ | improved |
| c11 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c14 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c15 | config-env | 0.500 | 1.000 | +0.500 | 0.834 | 0.956 | +0.122 | ✓ | ✓ | improved |
| c32 | config-env | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |

## Regression Detail: qwen2.5:3b-instruct

### c03 (provider-activation) — soft

- MRR: 0.500 → 0.250 (-0.250)
- nDCG@10: 0.497 → 0.339 (-0.158)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c06 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.631 → 0.500 (-0.131)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c07 (troubleshooting) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.631 → 0.500 (-0.131)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c08 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c20 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c26 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c35 (source-navigation) — soft

- MRR: 0.500 → 0.200 (-0.300)
- nDCG@10: 0.598 → 0.305 (-0.294)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c36 (source-navigation) — hard

- MRR: 0.500 → 0.143 (-0.357)
- nDCG@10: 0.651 → 0.389 (-0.262)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c37 (source-navigation) — hard

- MRR: 0.500 → 0.167 (-0.333)
- nDCG@10: 0.603 → 0.426 (-0.177)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c47 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.598 → 0.500 (-0.098)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

## Cross-Model Absolute Comparison (combined variants)

| Metric | gemma3:4b | qwen2.5:3b-instruct |
|--------|---|---|
| MRR@10 | 0.700 | 0.725 |
| nDCG@10 | 0.737 | 0.739 |
| chunkRecall@5 | 91.8% | 89.8% |
| chunkRecall@10 | 95.9% | 95.9% |
| windowRecall@10 | 98.0% | 98.0% |
| negativePass | 100.0% | 100.0% |

| indexing time | 149955 ms | 163815 ms |
| combined fallbacks | 0 | 0 |
| hard regressions | 1 | 2 |
| soft regressions | 8 | 8 |
| improvements | 2 | 5 |

## Verdict

### gemma3:4b

**COMBINED_DEFER_HARD_REGRESSIONS**

gemma3:4b: 1 hard regression(s). MRR@10 Δ -0.050. Not recommended for opt-in.

### qwen2.5:3b-instruct

**COMBINED_DEFER_HARD_REGRESSIONS**

qwen2.5:3b-instruct: 2 hard regression(s) (c36, c37). MRR@10 Δ -0.025. Within tolerance but needs investigation.

### Notes

- Parser stability confirmed separately — see `benchmarks/retrieval/results/2026-05-22T0239-combined-parser-stability.md`.
- Retrieval quality above is the primary decision signal for opt-in recommendation.
- COMBINED_LLM=1 remains opt-in. Production default unchanged.
- Before default promotion: run on a broader fixture corpus; verify cross-lingual and config-env query types.

*Generated: 2026-05-22*