# COMBINED_LLM=1 Quality Matrix — custom-50 — 2026-05-26

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
| baseline (separate) | OK | 96 | 207704 ms | n/a | 6 |
| combined gemma3:4b | OK | 96 | 168062 ms | 0 | n/a |
| combined qwen2.5:3b-instruct | OK | 96 | 210164 ms | 0 | n/a |

## Aggregate Metrics

| Metric | baseline | gemma3:4b | qwen2.5:3b-instruct |
|--------|----------|---|---|
| chunkRecall@3 | 91.8% | 87.8% (-0.041) | 87.8% (-0.041) |
| chunkRecall@5 | 95.9% | 91.8% (-0.041) | 93.9% (-0.020) |
| chunkRecall@10 | 95.9% | 98.0% (+0.020) | 95.9% (—) |
| windowRecall@5 | 98.0% | 95.9% (-0.020) | 98.0% (—) |
| windowRecall@10 | 98.0% | 100.0% (+0.020) | 98.0% (—) |
| supportRecall@10 | 98.0% | 100.0% (+0.020) | 98.0% (—) |
| nDCG@10 | 0.777 | 0.774 (-0.003) | 0.790 (+0.013) |
| MRR@10 | 0.772 | 0.756 (-0.016) | 0.782 (+0.010) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Delta vs shared baseline in parentheses.*

## Per-Query Diff: combined gemma3:4b vs baseline

6 regressed (2 hard / 4 soft), 5 improved, 38 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c05 | conceptual | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 1.000 | 0.500 | -0.500 | 0.613 | 0.693 | +0.080 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.665 | -0.335 | ✓ | ✓ | **regressed** |
| c35 | source-navigation | 0.500 | 0.143 | -0.357 | 0.642 | 0.262 | -0.380 | ✓ | ✗ | **regressed** |
| c31 | config-env | 0.333 | 0.200 | -0.133 | 0.606 | 0.517 | -0.089 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.250 | 0.167 | -0.083 | 0.508 | 0.449 | -0.059 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.213 | 0.337 | +0.125 | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.598 | 0.603 | +0.005 | ✓ | ✓ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.627 | 0.627 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.918 | 1.000 | +0.082 | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c15 | config-env | 0.333 | 0.333 | — | 0.731 | 0.606 | -0.125 | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.787 | -0.145 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.918 | -0.082 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c37 | source-navigation | 0.500 | 0.500 | — | 0.617 | 0.603 | -0.014 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.900 | 1.000 | +0.100 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.111 | +0.111 | 0.000 | 0.237 | +0.237 | ✗ | ✗ | improved |
| c25 | conceptual | 0.333 | 0.500 | +0.167 | 0.606 | 0.834 | +0.228 | ✓ | ✓ | improved |
| c47 | exact-token | 0.333 | 0.500 | +0.167 | 0.506 | 0.594 | +0.088 | ✓ | ✓ | improved |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c32 | config-env | 0.500 | 1.000 | +0.500 | 0.497 | 0.894 | +0.397 | ✓ | ✓ | improved |

## Regression Detail: gemma3:4b

### c05 (conceptual) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.787 → 0.394 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c31 (config-env) — soft

- MRR: 0.333 → 0.200 (-0.133)
- nDCG@10: 0.606 → 0.517 (-0.089)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c35 (source-navigation) — hard

- MRR: 0.500 → 0.143 (-0.357)
- nDCG@10: 0.642 → 0.262 (-0.380)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c36 (source-navigation) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.613 → 0.693 (+0.080)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c39 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.665 (-0.335)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c41 (conceptual) — hard

- MRR: 0.250 → 0.167 (-0.083)
- nDCG@10: 0.508 → 0.449 (-0.059)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

## Per-Query Diff: combined qwen2.5:3b-instruct vs baseline

8 regressed (1 hard / 7 soft), 8 improved, 33 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c36 | source-navigation | 1.000 | 0.125 | -0.875 | 0.613 | 0.371 | -0.242 | ✓ | ✗ | **regressed** |
| c05 | conceptual | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c12 | exact-token | 1.000 | 0.333 | -0.667 | 0.787 | 0.491 | -0.296 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 1.000 | 0.333 | -0.667 | 1.000 | 0.606 | -0.394 | ✓ | ✓ | **regressed** |
| c26 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c28 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c31 | config-env | 0.333 | 0.250 | -0.083 | 0.606 | 0.552 | -0.055 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.250 | 0.200 | -0.050 | 0.508 | 0.473 | -0.034 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.213 | 0.145 | -0.068 | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.598 | 0.497 | -0.102 | ✓ | ✓ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.627 | 0.642 | +0.015 | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.918 | 0.932 | +0.015 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.918 | -0.015 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.889 | +0.102 | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.900 | 1.000 | +0.100 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c14 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c32 | config-env | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c35 | source-navigation | 0.500 | 1.000 | +0.500 | 0.642 | 0.956 | +0.314 | ✓ | ✓ | improved |
| c37 | source-navigation | 0.500 | 1.000 | +0.500 | 0.617 | 0.918 | +0.301 | ✓ | ✓ | improved |
| c15 | config-env | 0.333 | 1.000 | +0.667 | 0.731 | 0.956 | +0.225 | ✓ | ✓ | improved |
| c25 | conceptual | 0.333 | 1.000 | +0.667 | 0.606 | 1.000 | +0.394 | ✓ | ✓ | improved |
| c47 | exact-token | 0.333 | 1.000 | +0.667 | 0.506 | 0.894 | +0.388 | ✓ | ✓ | improved |

## Regression Detail: qwen2.5:3b-instruct

### c05 (conceptual) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.787 → 0.394 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c12 (exact-token) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.787 → 0.491 (-0.296)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c26 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c28 (exact-token) — soft

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

- MRR: 1.000 → 0.125 (-0.875)
- nDCG@10: 0.613 → 0.371 (-0.242)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 3 → 0

### c39 (exact-token) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 1.000 → 0.606 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c41 (conceptual) — soft

- MRR: 0.250 → 0.200 (-0.050)
- nDCG@10: 0.508 → 0.473 (-0.034)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

## Cross-Model Absolute Comparison (combined variants)

| Metric | gemma3:4b | qwen2.5:3b-instruct |
|--------|---|---|
| MRR@10 | 0.756 | 0.782 |
| nDCG@10 | 0.774 | 0.790 |
| chunkRecall@5 | 91.8% | 93.9% |
| chunkRecall@10 | 98.0% | 95.9% |
| windowRecall@10 | 100.0% | 98.0% |
| negativePass | 100.0% | 100.0% |

| indexing time | 168062 ms | 210164 ms |
| combined fallbacks | 0 | 0 |
| hard regressions | 2 | 1 |
| soft regressions | 4 | 7 |
| improvements | 5 | 8 |

## Verdict

### gemma3:4b

**COMBINED_DEFER_HARD_REGRESSIONS**

gemma3:4b: 2 hard regression(s) (c35, c41). MRR@10 Δ -0.016. Within tolerance but needs investigation.

### qwen2.5:3b-instruct

**COMBINED_DEFER_HARD_REGRESSIONS**

qwen2.5:3b-instruct: 1 hard regression(s) (c36). MRR@10 Δ +0.010. Within tolerance but needs investigation.

### Notes

- Parser stability confirmed separately — see `benchmarks/retrieval/results/2026-05-22T0239-combined-parser-stability.md`.
- Retrieval quality above is the primary decision signal for opt-in recommendation.
- COMBINED_LLM=1 remains opt-in. Production default unchanged.
- Before default promotion: run on a broader fixture corpus; verify cross-lingual and config-env query types.

*Generated: 2026-05-26*