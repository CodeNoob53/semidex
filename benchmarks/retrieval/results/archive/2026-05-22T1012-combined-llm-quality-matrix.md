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
| baseline (separate) | OK | 101 | 196009 ms | n/a | 3 |
| combined gemma3:4b | OK | 101 | 160816 ms | 0 | n/a |
| combined qwen2.5:3b-instruct | OK | 101 | 203030 ms | 0 | n/a |

## Aggregate Metrics

| Metric | baseline | gemma3:4b | qwen2.5:3b-instruct |
|--------|----------|---|---|
| chunkRecall@3 | 87.8% | 87.8% (—) | 85.7% (-0.020) |
| chunkRecall@5 | 93.9% | 93.9% (—) | 91.8% (-0.020) |
| chunkRecall@10 | 98.0% | 98.0% (—) | 95.9% (-0.020) |
| windowRecall@5 | 98.0% | 98.0% (—) | 98.0% (—) |
| windowRecall@10 | 100.0% | 100.0% (—) | 98.0% (-0.020) |
| supportRecall@10 | 100.0% | 100.0% (—) | 98.0% (-0.020) |
| nDCG@10 | 0.776 | 0.743 (-0.033) | 0.763 (-0.013) |
| MRR@10 | 0.741 | 0.697 (-0.044) | 0.732 (-0.009) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Delta vs shared baseline in parentheses.*

## Per-Query Diff: combined gemma3:4b vs baseline

8 regressed (1 hard / 7 soft), 3 improved, 38 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c05 | conceptual | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c07 | troubleshooting | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c12 | exact-token | 1.000 | 0.500 | -0.500 | 0.885 | 0.497 | -0.388 | ✓ | ✓ | **regressed** |
| c26 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 1.000 | 0.500 | -0.500 | 1.000 | 0.693 | -0.307 | ✓ | ✓ | **regressed** |
| c49 | config-env | 1.000 | 0.500 | -0.500 | 0.907 | 0.617 | -0.291 | ✓ | ✓ | **regressed** |
| c47 | exact-token | 0.500 | 0.333 | -0.167 | 0.609 | 0.506 | -0.103 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.143 | -0.057 | 0.642 | 0.431 | -0.211 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.131 | 0.337 | +0.207 | ✗ | ✗ | — |
| c03 | provider-activation | 0.333 | 0.333 | — | 0.495 | 0.495 | — | ✓ | ✓ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.594 | 0.642 | +0.048 | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.900 | 0.885 | -0.015 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.885 | -0.115 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 0.500 | 0.500 | — | 0.834 | 0.834 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c29 | conceptual | 0.125 | 0.125 | — | 0.248 | 0.248 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.594 | 0.497 | -0.098 | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 0.500 | 0.500 | — | 0.642 | 0.497 | -0.145 | ✓ | ✓ | — |
| c37 | source-navigation | 0.250 | 0.250 | — | 0.459 | 0.339 | -0.120 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.333 | 0.333 | — | 0.606 | 0.731 | +0.125 | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.200 | +0.057 | 0.475 | 0.517 | +0.042 | ✗ | ✓ | improved |
| c08 | exact-token | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c15 | config-env | 0.333 | 1.000 | +0.667 | 0.606 | 1.000 | +0.394 | ✓ | ✓ | improved |

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

### c12 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.885 → 0.497 (-0.388)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c26 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c36 (source-navigation) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.693 (-0.307)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.143 (-0.057)
- nDCG@10: 0.642 → 0.431 (-0.211)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 2 → 0

### c47 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.609 → 0.506 (-0.103)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c49 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.907 → 0.617 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

## Per-Query Diff: combined qwen2.5:3b-instruct vs baseline

8 regressed (1 hard / 7 soft), 7 improved, 34 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c36 | source-navigation | 1.000 | 0.200 | -0.800 | 1.000 | 0.414 | -0.586 | ✓ | ✓ | **regressed** |
| c07 | troubleshooting | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c26 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c33 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c47 | exact-token | 0.500 | 0.333 | -0.167 | 0.609 | 0.500 | -0.109 | ✓ | ✓ | **regressed** |
| c29 | conceptual | 0.125 | 0.000 | -0.125 | 0.248 | 0.000 | -0.248 | ✗ | ✗ | **regressed** |
| c31 | config-env | 0.333 | 0.250 | -0.083 | 0.606 | 0.552 | -0.055 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.167 | -0.033 | 0.642 | 0.449 | -0.193 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.131 | 0.213 | +0.082 | ✗ | ✗ | — |
| c03 | provider-activation | 0.333 | 0.333 | — | 0.495 | 0.495 | — | ✓ | ✓ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.594 | 0.627 | +0.033 | ✓ | ✓ | — |
| c05 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c08 | exact-token | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 0.900 | -0.100 | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.885 | 0.894 | +0.009 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.900 | 0.894 | -0.006 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.885 | -0.115 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.885 | +0.098 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 0.500 | 0.500 | — | 0.642 | 0.665 | +0.023 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.907 | 0.900 | -0.008 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.167 | +0.024 | 0.475 | 0.493 | +0.018 | ✗ | ✗ | improved |
| c37 | source-navigation | 0.250 | 0.333 | +0.083 | 0.459 | 0.495 | +0.036 | ✓ | ✓ | improved |
| c15 | config-env | 0.333 | 0.500 | +0.167 | 0.606 | 0.665 | +0.059 | ✓ | ✓ | improved |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c11 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c25 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c32 | config-env | 0.500 | 1.000 | +0.500 | 0.594 | 0.787 | +0.193 | ✓ | ✓ | improved |

## Regression Detail: qwen2.5:3b-instruct

### c07 (troubleshooting) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c26 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c29 (conceptual) — soft

- MRR: 0.125 → 0.000 (-0.125)
- nDCG@10: 0.248 → 0.000 (-0.248)
- chunkRecall@5: ✗ → ✗
- top-1 relevance: 0 → 0

### c31 (config-env) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.606 → 0.552 (-0.055)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c33 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c36 (source-navigation) — soft

- MRR: 1.000 → 0.200 (-0.800)
- nDCG@10: 1.000 → 0.414 (-0.586)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.167 (-0.033)
- nDCG@10: 0.642 → 0.449 (-0.193)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 2 → 0

### c47 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.609 → 0.500 (-0.109)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

## Cross-Model Absolute Comparison (combined variants)

| Metric | gemma3:4b | qwen2.5:3b-instruct |
|--------|---|---|
| MRR@10 | 0.697 | 0.732 |
| nDCG@10 | 0.743 | 0.763 |
| chunkRecall@5 | 93.9% | 91.8% |
| chunkRecall@10 | 98.0% | 95.9% |
| windowRecall@10 | 100.0% | 98.0% |
| negativePass | 100.0% | 100.0% |

| indexing time | 160816 ms | 203030 ms |
| combined fallbacks | 0 | 0 |
| hard regressions | 1 | 1 |
| soft regressions | 7 | 7 |
| improvements | 3 | 7 |

## Verdict

### gemma3:4b

**COMBINED_DEFER_HARD_REGRESSIONS**

gemma3:4b: 1 hard regression(s). MRR@10 Δ -0.044. Not recommended for opt-in.

### qwen2.5:3b-instruct

**COMBINED_DEFER_HARD_REGRESSIONS**

qwen2.5:3b-instruct: 1 hard regression(s) (c41). MRR@10 Δ -0.009. Within tolerance but needs investigation.

### Notes

- Parser stability confirmed separately — see `benchmarks/retrieval/results/2026-05-22T0239-combined-parser-stability.md`.
- Retrieval quality above is the primary decision signal for opt-in recommendation.
- COMBINED_LLM=1 remains opt-in. Production default unchanged.
- Before default promotion: run on a broader fixture corpus; verify cross-lingual and config-env query types.

*Generated: 2026-05-22*