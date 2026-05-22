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
| baseline (separate) | OK | 101 | 220947 ms | n/a | 8 |
| combined gemma3:4b | OK | 101 | 182197 ms | 0 | n/a |
| combined qwen2.5:3b-instruct | OK | 101 | 163755 ms | 0 | n/a |

## Aggregate Metrics

| Metric | baseline | gemma3:4b | qwen2.5:3b-instruct |
|--------|----------|---|---|
| chunkRecall@3 | 89.8% | 85.7% (-0.041) | 81.6% (-0.082) |
| chunkRecall@5 | 95.9% | 89.8% (-0.061) | 91.8% (-0.041) |
| chunkRecall@10 | 95.9% | 95.9% (—) | 91.8% (-0.041) |
| windowRecall@5 | 95.9% | 95.9% (—) | 98.0% (+0.020) |
| windowRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| supportRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| nDCG@10 | 0.769 | 0.761 (-0.007) | 0.722 (-0.046) |
| MRR@10 | 0.741 | 0.744 (+0.003) | 0.707 (-0.034) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Delta vs shared baseline in parentheses.*

## Per-Query Diff: combined gemma3:4b vs baseline

7 regressed (3 hard / 4 soft), 5 improved, 37 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c36 | source-navigation | 1.000 | 0.167 | -0.833 | 0.818 | 0.423 | -0.395 | ✓ | ✗ | **regressed** |
| c05 | conceptual | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c26 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c03 | provider-activation | 0.500 | 0.333 | -0.167 | 0.598 | 0.394 | -0.205 | ✓ | ✓ | **regressed** |
| c31 | config-env | 0.333 | 0.250 | -0.083 | 0.606 | 0.552 | -0.055 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.143 | -0.057 | 0.517 | 0.475 | -0.042 | ✓ | ✗ | **regressed** |
| c48 | cross-lingual-ua-en | 0.200 | 0.143 | -0.057 | 0.473 | 0.475 | +0.002 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.932 | 1.000 | +0.068 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.120 | 0.169 | +0.049 | ✗ | ✗ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.627 | 0.627 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 0.889 | -0.111 | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.889 | 0.787 | -0.102 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c15 | config-env | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.907 | 0.907 | — | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.894 | -0.106 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.907 | 0.787 | -0.120 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 0.500 | 0.500 | — | 0.834 | 0.834 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 1.000 | 1.000 | — | 0.932 | 0.894 | -0.039 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.500 | 0.500 | — | 0.665 | 0.665 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.932 | 1.000 | +0.068 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.491 | 0.491 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.900 | 0.900 | — | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c08 | exact-token | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c28 | exact-token | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c33 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c37 | source-navigation | 0.500 | 1.000 | +0.500 | 0.603 | 0.889 | +0.286 | ✓ | ✓ | improved |

## Regression Detail: gemma3:4b

### c03 (provider-activation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.598 → 0.394 (-0.205)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c05 (conceptual) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.787 → 0.394 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c26 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c31 (config-env) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.606 → 0.552 (-0.055)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c36 (source-navigation) — hard

- MRR: 1.000 → 0.167 (-0.833)
- nDCG@10: 0.818 → 0.423 (-0.395)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 3 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.143 (-0.057)
- nDCG@10: 0.517 → 0.475 (-0.042)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c48 (cross-lingual-ua-en) — hard

- MRR: 0.200 → 0.143 (-0.057)
- nDCG@10: 0.473 → 0.475 (+0.002)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

## Per-Query Diff: combined qwen2.5:3b-instruct vs baseline

10 regressed (2 hard / 8 soft), 4 improved, 35 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c36 | source-navigation | 1.000 | 0.200 | -0.800 | 0.818 | 0.414 | -0.403 | ✓ | ✓ | **regressed** |
| c15 | config-env | 1.000 | 0.250 | -0.750 | 1.000 | 0.676 | -0.324 | ✓ | ✓ | **regressed** |
| c20 | config-env | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c33 | conceptual | 0.500 | 0.000 | -0.500 | 0.834 | 0.169 | -0.665 | ✓ | ✗ | **regressed** |
| c39 | exact-token | 0.500 | 0.250 | -0.250 | 0.665 | 0.508 | -0.158 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.000 | -0.200 | 0.517 | 0.169 | -0.349 | ✓ | ✗ | **regressed** |
| c03 | provider-activation | 0.500 | 0.333 | -0.167 | 0.598 | 0.491 | -0.107 | ✓ | ✓ | **regressed** |
| c04 | exact-token | 0.500 | 0.333 | -0.167 | 0.627 | 0.539 | -0.088 | ✓ | ✓ | **regressed** |
| c07 | troubleshooting | 0.500 | 0.333 | -0.167 | 0.631 | 0.500 | -0.131 | ✓ | ✓ | **regressed** |
| c11 | exact-token | 0.500 | 0.333 | -0.167 | 0.631 | 0.500 | -0.131 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.120 | 0.145 | +0.025 | ✗ | ✗ | — |
| c05 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 0.932 | -0.068 | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.889 | 0.787 | -0.102 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.907 | 0.907 | — | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.885 | -0.115 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.907 | 0.787 | -0.120 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.885 | -0.115 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 1.000 | 1.000 | — | 0.932 | 0.787 | -0.145 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.932 | 0.932 | — | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.491 | 0.506 | +0.015 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.200 | 0.200 | — | 0.473 | 0.517 | +0.044 | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.900 | 0.907 | +0.008 | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c25 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c28 | exact-token | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c37 | source-navigation | 0.500 | 1.000 | +0.500 | 0.603 | 0.907 | +0.304 | ✓ | ✓ | improved |

## Regression Detail: qwen2.5:3b-instruct

### c03 (provider-activation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.598 → 0.491 (-0.107)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c04 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.627 → 0.539 (-0.088)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c07 (troubleshooting) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.631 → 0.500 (-0.131)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c11 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.631 → 0.500 (-0.131)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c15 (config-env) — soft

- MRR: 1.000 → 0.250 (-0.750)
- nDCG@10: 1.000 → 0.676 (-0.324)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c20 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c33 (conceptual) — hard

- MRR: 0.500 → 0.000 (-0.500)
- nDCG@10: 0.834 → 0.169 (-0.665)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 2 → 0

### c36 (source-navigation) — soft

- MRR: 1.000 → 0.200 (-0.800)
- nDCG@10: 0.818 → 0.414 (-0.403)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c39 (exact-token) — soft

- MRR: 0.500 → 0.250 (-0.250)
- nDCG@10: 0.665 → 0.508 (-0.158)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.000 (-0.200)
- nDCG@10: 0.517 → 0.169 (-0.349)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

## Cross-Model Absolute Comparison (combined variants)

| Metric | gemma3:4b | qwen2.5:3b-instruct |
|--------|---|---|
| MRR@10 | 0.744 | 0.707 |
| nDCG@10 | 0.761 | 0.722 |
| chunkRecall@5 | 89.8% | 91.8% |
| chunkRecall@10 | 95.9% | 91.8% |
| windowRecall@10 | 98.0% | 98.0% |
| negativePass | 100.0% | 100.0% |

| indexing time | 182197 ms | 163755 ms |
| combined fallbacks | 0 | 0 |
| hard regressions | 3 | 2 |
| soft regressions | 4 | 8 |
| improvements | 5 | 4 |

## Verdict

### gemma3:4b

**COMBINED_DEFER_HARD_REGRESSIONS**

gemma3:4b: 3 hard regression(s). MRR@10 Δ +0.003. Not recommended for opt-in.

### qwen2.5:3b-instruct

**COMBINED_DEFER_HARD_REGRESSIONS**

qwen2.5:3b-instruct: 2 hard regression(s). MRR@10 Δ -0.034. Not recommended for opt-in.

### Notes

- Parser stability confirmed separately — see `benchmarks/retrieval/results/2026-05-22T0239-combined-parser-stability.md`.
- Retrieval quality above is the primary decision signal for opt-in recommendation.
- COMBINED_LLM=1 remains opt-in. Production default unchanged.
- Before default promotion: run on a broader fixture corpus; verify cross-lingual and config-env query types.

*Generated: 2026-05-22*