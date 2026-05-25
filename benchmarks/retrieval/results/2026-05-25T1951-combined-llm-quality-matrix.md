# COMBINED_LLM=1 Quality Matrix — custom-50 — 2026-05-25

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
| baseline (separate) | OK | 101 | 212510 ms | n/a | 7 |
| combined gemma3:4b | OK | 101 | 168886 ms | 0 | n/a |
| combined qwen2.5:3b-instruct | OK | 101 | 221093 ms | 1 | n/a |

## Aggregate Metrics

| Metric | baseline | gemma3:4b | qwen2.5:3b-instruct |
|--------|----------|---|---|
| chunkRecall@3 | 91.8% | 87.8% (-0.041) | 85.7% (-0.061) |
| chunkRecall@5 | 95.9% | 93.9% (-0.020) | 93.9% (-0.020) |
| chunkRecall@10 | 95.9% | 95.9% (—) | 95.9% (—) |
| windowRecall@5 | 98.0% | 98.0% (—) | 95.9% (-0.020) |
| windowRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| supportRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| nDCG@10 | 0.774 | 0.763 (-0.011) | 0.767 (-0.006) |
| MRR@10 | 0.754 | 0.743 (-0.011) | 0.743 (-0.011) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Delta vs shared baseline in parentheses.*

## Per-Query Diff: combined gemma3:4b vs baseline

6 regressed (1 hard / 5 soft), 5 improved, 38 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c05 | conceptual | 1.000 | 0.250 | -0.750 | 0.787 | 0.339 | -0.448 | ✓ | ✓ | **regressed** |
| c25 | conceptual | 1.000 | 0.250 | -0.750 | 1.000 | 0.676 | -0.324 | ✓ | ✓ | **regressed** |
| c12 | exact-token | 1.000 | 0.500 | -0.500 | 0.894 | 0.497 | -0.397 | ✓ | ✓ | **regressed** |
| c35 | source-navigation | 1.000 | 0.500 | -0.500 | 0.932 | 0.603 | -0.329 | ✓ | ✓ | **regressed** |
| c15 | config-env | 0.500 | 0.333 | -0.167 | 0.834 | 0.606 | -0.228 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.167 | -0.033 | 0.473 | 0.618 | +0.145 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.213 | 0.213 | — | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.594 | 0.609 | +0.015 | ✓ | ✓ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.642 | 0.627 | -0.015 | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.907 | -0.025 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.787 | -0.112 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c36 | source-navigation | 0.500 | 0.500 | — | 0.624 | 0.693 | +0.069 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.500 | 0.500 | — | 0.665 | 0.665 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.594 | +0.098 | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.506 | 0.495 | -0.011 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 0.947 | 0.914 | -0.033 | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.787 | 0.907 | +0.120 | ✓ | ✓ | — |
| c37 | source-navigation | 0.333 | 0.500 | +0.167 | 0.506 | 0.497 | -0.009 | ✓ | ✓ | improved |
| c07 | troubleshooting | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c08 | exact-token | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c26 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c32 | config-env | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |

## Regression Detail: gemma3:4b

### c05 (conceptual) — soft

- MRR: 1.000 → 0.250 (-0.750)
- nDCG@10: 0.787 → 0.339 (-0.448)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c12 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.894 → 0.497 (-0.397)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c15 (config-env) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.834 → 0.606 (-0.228)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 2 → 0

### c25 (conceptual) — soft

- MRR: 1.000 → 0.250 (-0.750)
- nDCG@10: 1.000 → 0.676 (-0.324)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c35 (source-navigation) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.932 → 0.603 (-0.329)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.167 (-0.033)
- nDCG@10: 0.473 → 0.618 (+0.145)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 2

## Per-Query Diff: combined qwen2.5:3b-instruct vs baseline

6 regressed (1 hard / 5 soft), 3 improved, 40 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c05 | conceptual | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c28 | exact-token | 1.000 | 0.500 | -0.500 | 0.956 | 0.834 | -0.122 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 0.500 | 0.125 | -0.375 | 0.624 | 0.193 | -0.431 | ✓ | ✗ | **regressed** |
| c15 | config-env | 0.500 | 0.250 | -0.250 | 0.834 | 0.676 | -0.158 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 0.500 | 0.333 | -0.167 | 0.665 | 0.731 | +0.066 | ✓ | ✓ | **regressed** |
| c31 | config-env | 0.333 | 0.250 | -0.083 | 0.606 | 0.552 | -0.055 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.918 | -0.038 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.213 | 0.213 | — | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.594 | 0.609 | +0.015 | ✓ | ✓ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.642 | 0.642 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.894 | 0.900 | +0.006 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.907 | -0.025 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.894 | -0.106 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.787 | -0.112 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.787 | -0.169 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c26 | conceptual | 0.500 | 0.500 | — | 0.834 | 0.834 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 1.000 | 1.000 | — | 0.932 | 0.932 | — | ✓ | ✓ | — |
| c37 | source-navigation | 0.333 | 0.333 | — | 0.506 | 0.524 | +0.018 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c41 | conceptual | 0.200 | 0.200 | — | 0.473 | 0.425 | -0.049 | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.506 | 0.500 | -0.006 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 0.947 | 0.958 | +0.012 | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.787 | 0.907 | +0.120 | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c08 | exact-token | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c11 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |

## Regression Detail: qwen2.5:3b-instruct

### c05 (conceptual) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.787 → 0.394 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c15 (config-env) — soft

- MRR: 0.500 → 0.250 (-0.250)
- nDCG@10: 0.834 → 0.676 (-0.158)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 2 → 2

### c28 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.956 → 0.834 (-0.122)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c31 (config-env) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.606 → 0.552 (-0.055)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c36 (source-navigation) — hard

- MRR: 0.500 → 0.125 (-0.375)
- nDCG@10: 0.624 → 0.193 (-0.431)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c39 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.665 → 0.731 (+0.066)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 2

## Cross-Model Absolute Comparison (combined variants)

| Metric | gemma3:4b | qwen2.5:3b-instruct |
|--------|---|---|
| MRR@10 | 0.743 | 0.743 |
| nDCG@10 | 0.763 | 0.767 |
| chunkRecall@5 | 93.9% | 93.9% |
| chunkRecall@10 | 95.9% | 95.9% |
| windowRecall@10 | 98.0% | 98.0% |
| negativePass | 100.0% | 100.0% |

| indexing time | 168886 ms | 221093 ms |
| combined fallbacks | 0 | 1 |
| hard regressions | 1 | 1 |
| soft regressions | 5 | 5 |
| improvements | 5 | 3 |

## Verdict

### gemma3:4b

**COMBINED_DEFER_HARD_REGRESSIONS**

gemma3:4b: 1 hard regression(s) (c41). MRR@10 Δ -0.011. Within tolerance but needs investigation.

### qwen2.5:3b-instruct

**COMBINED_DEFER_HARD_REGRESSIONS**

qwen2.5:3b-instruct: 1 hard regression(s) (c36). MRR@10 Δ -0.011. Within tolerance but needs investigation.

### Notes

- Parser stability confirmed separately — see `benchmarks/retrieval/results/2026-05-22T0239-combined-parser-stability.md`.
- Retrieval quality above is the primary decision signal for opt-in recommendation.
- COMBINED_LLM=1 remains opt-in. Production default unchanged.
- Before default promotion: run on a broader fixture corpus; verify cross-lingual and config-env query types.

*Generated: 2026-05-25*