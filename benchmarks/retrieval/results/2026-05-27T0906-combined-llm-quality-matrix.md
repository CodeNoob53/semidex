# COMBINED_LLM=1 Quality Matrix — custom-50 — 2026-05-27

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
| Combined context policy | current-minimal |

## Indexing

| Variant | Exit | Points | Wall time | Combined fallbacks | Tag batch fallbacks |
|---------|------|--------|-----------|-------------------|---------------------|
| baseline (separate) | OK | 96 | 197401 ms | n/a | 6 |
| combined gemma3:4b | OK | 96 | 170297 ms | 0 | n/a |
| combined qwen2.5:3b-instruct | OK | 96 | 191736 ms | 0 | n/a |

## Aggregate Metrics

| Metric | baseline | gemma3:4b | qwen2.5:3b-instruct |
|--------|----------|---|---|
| chunkRecall@3 | 91.8% | 91.8% (—) | 87.8% (-0.041) |
| chunkRecall@5 | 95.9% | 93.9% (-0.020) | 93.9% (-0.020) |
| chunkRecall@10 | 95.9% | 95.9% (—) | 95.9% (—) |
| windowRecall@5 | 98.0% | 98.0% (—) | 95.9% (-0.020) |
| windowRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| supportRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| nDCG@10 | 0.778 | 0.770 (-0.007) | 0.763 (-0.014) |
| MRR@10 | 0.760 | 0.718 (-0.042) | 0.752 (-0.008) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Delta vs shared baseline in parentheses.*

## Per-Query Diff: combined gemma3:4b vs baseline

8 regressed (1 hard / 7 soft), 4 improved, 37 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c08 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c21 | conceptual | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c25 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c28 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c49 | config-env | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c15 | config-env | 0.500 | 0.333 | -0.167 | 0.665 | 0.731 | +0.066 | ✓ | ✓ | **regressed** |
| c47 | exact-token | 0.500 | 0.333 | -0.167 | 0.609 | 0.491 | -0.118 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.100 | -0.100 | 0.642 | 0.565 | -0.077 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.145 | 0.213 | +0.068 | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.497 | 0.603 | +0.106 | ✓ | ✓ | — |
| c05 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 1.000 | +0.068 | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.885 | 0.787 | -0.098 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.900 | 0.907 | +0.008 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.932 | -0.068 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.900 | 0.932 | +0.033 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.907 | 0.787 | -0.120 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c26 | conceptual | 0.500 | 0.500 | — | 0.834 | 0.834 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.598 | +0.102 | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c36 | source-navigation | 0.500 | 0.500 | — | 0.580 | 0.693 | +0.113 | ✓ | ✓ | — |
| c37 | source-navigation | 0.333 | 0.333 | — | 0.506 | 0.500 | -0.006 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c09 | config-env | 0.200 | 0.250 | +0.050 | 0.305 | 0.339 | +0.034 | ✓ | ✓ | improved |
| c04 | exact-token | 0.333 | 0.500 | +0.167 | 0.539 | 0.627 | +0.088 | ✓ | ✓ | improved |
| c39 | exact-token | 0.333 | 0.500 | +0.167 | 0.606 | 0.834 | +0.228 | ✓ | ✓ | improved |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |

## Regression Detail: gemma3:4b

### c08 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c15 (config-env) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.665 → 0.731 (+0.066)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 2

### c21 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c25 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c28 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c41 (conceptual) — hard

- MRR: 0.200 → 0.100 (-0.100)
- nDCG@10: 0.642 → 0.565 (-0.077)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 2 → 2

### c47 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.609 → 0.491 (-0.118)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c49 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

## Per-Query Diff: combined qwen2.5:3b-instruct vs baseline

5 regressed (1 hard / 4 soft), 5 improved, 39 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c35 | source-navigation | 1.000 | 0.143 | -0.857 | 0.932 | 0.369 | -0.564 | ✓ | ✗ | **regressed** |
| c28 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 0.500 | 0.200 | -0.300 | 0.580 | 0.237 | -0.343 | ✓ | ✓ | **regressed** |
| c03 | provider-activation | 0.500 | 0.333 | -0.167 | 0.497 | 0.495 | -0.002 | ✓ | ✓ | **regressed** |
| c47 | exact-token | 0.500 | 0.333 | -0.167 | 0.609 | 0.495 | -0.114 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.145 | 0.169 | +0.023 | ✗ | ✗ | — |
| c04 | exact-token | 0.333 | 0.333 | — | 0.539 | 0.524 | -0.015 | ✓ | ✓ | — |
| c05 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.907 | -0.025 | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.885 | 0.787 | -0.098 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.900 | 0.918 | +0.018 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.900 | 0.885 | -0.015 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.907 | 0.918 | +0.010 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c26 | conceptual | 0.500 | 0.500 | — | 0.834 | 0.834 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c37 | source-navigation | 0.333 | 0.333 | — | 0.506 | 0.500 | -0.006 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c09 | config-env | 0.200 | 0.250 | +0.050 | 0.305 | 0.339 | +0.034 | ✓ | ✓ | improved |
| c41 | conceptual | 0.200 | 0.250 | +0.050 | 0.642 | 0.459 | -0.183 | ✓ | ✓ | improved |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c11 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c15 | config-env | 0.500 | 1.000 | +0.500 | 0.665 | 1.000 | +0.335 | ✓ | ✓ | improved |

## Regression Detail: qwen2.5:3b-instruct

### c03 (provider-activation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.497 → 0.495 (-0.002)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c28 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c35 (source-navigation) — hard

- MRR: 1.000 → 0.143 (-0.857)
- nDCG@10: 0.932 → 0.369 (-0.564)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 3 → 0

### c36 (source-navigation) — soft

- MRR: 0.500 → 0.200 (-0.300)
- nDCG@10: 0.580 → 0.237 (-0.343)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c47 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.609 → 0.495 (-0.114)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

## Cross-Model Absolute Comparison (combined variants)

| Metric | gemma3:4b | qwen2.5:3b-instruct |
|--------|---|---|
| MRR@10 | 0.718 | 0.752 |
| nDCG@10 | 0.770 | 0.763 |
| chunkRecall@5 | 93.9% | 93.9% |
| chunkRecall@10 | 95.9% | 95.9% |
| windowRecall@10 | 98.0% | 98.0% |
| negativePass | 100.0% | 100.0% |

| indexing time | 170297 ms | 191736 ms |
| combined fallbacks | 0 | 0 |
| hard regressions | 1 | 1 |
| soft regressions | 7 | 4 |
| improvements | 4 | 5 |

## Verdict

### gemma3:4b

**COMBINED_DEFER_HARD_REGRESSIONS**

gemma3:4b: 1 hard regression(s). MRR@10 Δ -0.042. Not recommended for opt-in.

### qwen2.5:3b-instruct

**COMBINED_DEFER_HARD_REGRESSIONS**

qwen2.5:3b-instruct: 1 hard regression(s) (c35). MRR@10 Δ -0.008. Within tolerance but needs investigation.

### Notes

- Parser stability confirmed separately — see `benchmarks/retrieval/results/2026-05-22T0239-combined-parser-stability.md`.
- Retrieval quality above is the primary decision signal for opt-in recommendation.
- COMBINED_LLM=1 remains opt-in. Production default unchanged.
- Before default promotion: run on a broader fixture corpus; verify cross-lingual and config-env query types.

*Generated: 2026-05-27*