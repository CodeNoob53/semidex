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
| Combined context policy | identifier-preserving |

## Indexing

| Variant | Exit | Points | Wall time | Combined fallbacks | Tag batch fallbacks |
|---------|------|--------|-----------|-------------------|---------------------|
| baseline (separate) | OK | 96 | 414698 ms | n/a | 7 |
| combined gemma3:4b | OK | 96 | 222072 ms | 3 | n/a |
| combined qwen2.5:3b-instruct | OK | 96 | 194359 ms | 0 | n/a |

## Aggregate Metrics

| Metric | baseline | gemma3:4b | qwen2.5:3b-instruct |
|--------|----------|---|---|
| chunkRecall@3 | 89.8% | 87.8% (-0.020) | 79.6% (-0.102) |
| chunkRecall@5 | 95.9% | 93.9% (-0.020) | 89.8% (-0.061) |
| chunkRecall@10 | 95.9% | 95.9% (—) | 95.9% (—) |
| windowRecall@5 | 98.0% | 98.0% (—) | 95.9% (-0.020) |
| windowRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| supportRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| nDCG@10 | 0.788 | 0.744 (-0.045) | 0.757 (-0.031) |
| MRR@10 | 0.752 | 0.700 (-0.052) | 0.746 (-0.007) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Delta vs shared baseline in parentheses.*

## Per-Query Diff: combined gemma3:4b vs baseline

7 regressed (1 hard / 6 soft), 5 improved, 37 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c35 | source-navigation | 1.000 | 0.167 | -0.833 | 0.885 | 0.393 | -0.492 | ✓ | ✗ | **regressed** |
| c12 | exact-token | 1.000 | 0.200 | -0.800 | 0.787 | 0.305 | -0.483 | ✓ | ✓ | **regressed** |
| c05 | conceptual | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 1.000 | 0.333 | -0.667 | 1.000 | 0.606 | -0.394 | ✓ | ✓ | **regressed** |
| c07 | troubleshooting | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c08 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c47 | exact-token | 0.500 | 0.333 | -0.167 | 0.603 | 0.506 | -0.097 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.169 | 0.169 | — | ✗ | ✗ | — |
| c03 | provider-activation | 0.333 | 0.333 | — | 0.394 | 0.506 | +0.112 | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.900 | 0.932 | +0.033 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.894 | 0.787 | -0.106 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.889 | 0.787 | -0.102 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c26 | conceptual | 0.500 | 0.500 | — | 0.834 | 0.834 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.598 | 0.497 | -0.102 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c36 | source-navigation | 0.500 | 0.500 | — | 0.693 | 0.651 | -0.043 | ✓ | ✓ | — |
| c37 | source-navigation | 0.333 | 0.333 | — | 0.506 | 0.495 | -0.011 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c41 | conceptual | 0.200 | 0.200 | — | 0.642 | 0.517 | -0.125 | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.250 | 0.333 | +0.083 | 0.552 | 0.606 | +0.055 | ✓ | ✓ | improved |
| c04 | exact-token | 0.333 | 0.500 | +0.167 | 0.514 | 0.617 | +0.103 | ✓ | ✓ | improved |
| c15 | config-env | 0.333 | 0.500 | +0.167 | 0.731 | 0.834 | +0.103 | ✓ | ✓ | improved |
| c33 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c28 | exact-token | 0.333 | 1.000 | +0.667 | 0.731 | 1.000 | +0.269 | ✓ | ✓ | improved |

## Regression Detail: gemma3:4b

### c05 (conceptual) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.787 → 0.394 (-0.394)
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

### c12 (exact-token) — soft

- MRR: 1.000 → 0.200 (-0.800)
- nDCG@10: 0.787 → 0.305 (-0.483)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c35 (source-navigation) — hard

- MRR: 1.000 → 0.167 (-0.833)
- nDCG@10: 0.885 → 0.393 (-0.492)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 3 → 0

### c39 (exact-token) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 1.000 → 0.606 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c47 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.603 → 0.506 (-0.097)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

## Per-Query Diff: combined qwen2.5:3b-instruct vs baseline

8 regressed (3 hard / 5 soft), 7 improved, 34 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c35 | source-navigation | 1.000 | 0.143 | -0.857 | 0.885 | 0.393 | -0.492 | ✓ | ✗ | **regressed** |
| c12 | exact-token | 1.000 | 0.200 | -0.800 | 0.787 | 0.406 | -0.381 | ✓ | ✓ | **regressed** |
| c07 | troubleshooting | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.665 | -0.335 | ✓ | ✓ | **regressed** |
| c33 | conceptual | 0.500 | 0.125 | -0.375 | 0.834 | 0.586 | -0.248 | ✓ | ✗ | **regressed** |
| c36 | source-navigation | 0.500 | 0.200 | -0.300 | 0.693 | 0.237 | -0.456 | ✓ | ✓ | **regressed** |
| c37 | source-navigation | 0.333 | 0.250 | -0.083 | 0.506 | 0.459 | -0.047 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.125 | -0.075 | 0.642 | 0.417 | -0.225 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.932 | 0.918 | -0.015 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.169 | 0.145 | -0.023 | ✗ | ✗ | — |
| c05 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.900 | 0.907 | +0.008 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.894 | 0.787 | -0.106 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.885 | -0.071 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.889 | 0.787 | -0.102 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.250 | 0.250 | — | 0.552 | 0.552 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.598 | 0.598 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.500 | 0.500 | — | 0.603 | 0.598 | -0.005 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c03 | provider-activation | 0.333 | 0.500 | +0.167 | 0.394 | 0.497 | +0.103 | ✓ | ✓ | improved |
| c04 | exact-token | 0.333 | 0.500 | +0.167 | 0.514 | 0.642 | +0.128 | ✓ | ✓ | improved |
| c11 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c14 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c26 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c15 | config-env | 0.333 | 1.000 | +0.667 | 0.731 | 0.932 | +0.202 | ✓ | ✓ | improved |
| c28 | exact-token | 0.333 | 1.000 | +0.667 | 0.731 | 1.000 | +0.269 | ✓ | ✓ | improved |

## Regression Detail: qwen2.5:3b-instruct

### c07 (troubleshooting) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c12 (exact-token) — soft

- MRR: 1.000 → 0.200 (-0.800)
- nDCG@10: 0.787 → 0.406 (-0.381)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c33 (conceptual) — hard

- MRR: 0.500 → 0.125 (-0.375)
- nDCG@10: 0.834 → 0.586 (-0.248)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 2 → 2

### c35 (source-navigation) — hard

- MRR: 1.000 → 0.143 (-0.857)
- nDCG@10: 0.885 → 0.393 (-0.492)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 3 → 0

### c36 (source-navigation) — soft

- MRR: 0.500 → 0.200 (-0.300)
- nDCG@10: 0.693 → 0.237 (-0.456)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c37 (source-navigation) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.506 → 0.459 (-0.047)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c39 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.665 (-0.335)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.125 (-0.075)
- nDCG@10: 0.642 → 0.417 (-0.225)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 2 → 0

## Cross-Model Absolute Comparison (combined variants)

| Metric | gemma3:4b | qwen2.5:3b-instruct |
|--------|---|---|
| MRR@10 | 0.700 | 0.746 |
| nDCG@10 | 0.744 | 0.757 |
| chunkRecall@5 | 93.9% | 89.8% |
| chunkRecall@10 | 95.9% | 95.9% |
| windowRecall@10 | 98.0% | 98.0% |
| negativePass | 100.0% | 100.0% |

| indexing time | 222072 ms | 194359 ms |
| combined fallbacks | 3 | 0 |
| hard regressions | 1 | 3 |
| soft regressions | 6 | 5 |
| improvements | 5 | 7 |

## Verdict

### gemma3:4b

**COMBINED_DEFER_HARD_REGRESSIONS**

gemma3:4b: 1 hard regression(s). MRR@10 Δ -0.052. Not recommended for opt-in.

### qwen2.5:3b-instruct

**COMBINED_DEFER_HARD_REGRESSIONS**

qwen2.5:3b-instruct: 3 hard regression(s). MRR@10 Δ -0.007. Not recommended for opt-in.

### Notes

- Parser stability confirmed separately — see `benchmarks/retrieval/results/2026-05-22T0239-combined-parser-stability.md`.
- Retrieval quality above is the primary decision signal for opt-in recommendation.
- COMBINED_LLM=1 remains opt-in. Production default unchanged.
- Before default promotion: run on a broader fixture corpus; verify cross-lingual and config-env query types.

*Generated: 2026-05-27*