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
| baseline separate | OK | 101 | 180881 ms | n/a | 10 |
| combined ctx+tags | OK | 101 | 149067 ms | 0 | n/a |
| combined ctx-only | OK | 101 | 136936 ms | 1 | n/a |

## Aggregate Metrics

| Metric | baseline | ctx+tags (Δ) | ctx-only (Δ) |
|--------|----------|-------------|-------------|
| chunkRecall@3 | 89.8% | 87.8% (-0.020) | 85.7% (-0.041) |
| chunkRecall@5 | 93.9% | 91.8% (-0.020) | 93.9% (—) |
| chunkRecall@10 | 95.9% | 95.9% (—) | 95.9% (—) |
| windowRecall@5 | 98.0% | 95.9% (-0.020) | 98.0% (—) |
| windowRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| supportRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| nDCG@10 | 0.765 | 0.759 (-0.006) | 0.735 (-0.029) |
| MRR@10 | 0.731 | 0.736 (+0.005) | 0.680 (-0.051) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Δ = combined variant − baseline.*

## Per-Query Diff: combined ctx+tags vs baseline

5 regressed (2 hard / 3 soft), 4 improved, 40 unchanged

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c35 | source-navigation | 1.000 | 0.500 | -0.500 | 0.787 | 0.642 | -0.145 | ✓ | ✓ | **regressed** |
| c49 | config-env | 1.000 | 0.500 | -0.500 | 0.900 | 0.609 | -0.291 | ✓ | ✓ | **regressed** |
| c37 | source-navigation | 0.500 | 0.333 | -0.167 | 0.617 | 0.394 | -0.223 | ✓ | ✓ | **regressed** |
| c31 | config-env | 0.333 | 0.167 | -0.167 | 0.606 | 0.493 | -0.113 | ✓ | ✗ | **regressed** |
| c41 | conceptual | 0.250 | 0.125 | -0.125 | 0.552 | 0.461 | -0.091 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.337 | 0.120 | -0.217 | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.598 | 0.603 | +0.005 | ✓ | ✓ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.642 | 0.642 | — | ✓ | ✓ | — |
| c05 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.894 | 0.932 | +0.039 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.894 | -0.106 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 0.333 | 0.333 | — | 0.731 | 0.731 | — | ✓ | ✓ | — |
| c26 | conceptual | 0.500 | 0.500 | — | 0.834 | 0.834 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.609 | 0.497 | -0.112 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c36 | source-navigation | 1.000 | 1.000 | — | 0.877 | 0.920 | +0.043 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.894 | 0.918 | +0.024 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.506 | 0.495 | -0.011 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.200 | +0.057 | 0.475 | 0.473 | -0.002 | ✗ | ✓ | improved |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c33 | conceptual | 0.500 | 1.000 | +0.500 | 0.665 | 0.956 | +0.291 | ✓ | ✓ | improved |
| c15 | config-env | 0.333 | 1.000 | +0.667 | 0.731 | 1.000 | +0.269 | ✓ | ✓ | improved |

## Regression Detail: combined ctx+tags

### c31 (config-env) — hard

- MRR: 0.333 → 0.167 (-0.167)
- nDCG@10: 0.606 → 0.493 (-0.113)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c35 (source-navigation) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.642 (-0.145)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c37 (source-navigation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.617 → 0.394 (-0.223)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c41 (conceptual) — hard

- MRR: 0.250 → 0.125 (-0.125)
- nDCG@10: 0.552 → 0.461 (-0.091)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c49 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.900 → 0.609 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

## Per-Query Diff: combined ctx-only vs baseline

8 regressed (0 hard / 8 soft), 1 improved, 40 unchanged

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c36 | source-navigation | 1.000 | 0.200 | -0.800 | 0.877 | 0.442 | -0.436 | ✓ | ✓ | **regressed** |
| c05 | conceptual | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c08 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c35 | source-navigation | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c37 | source-navigation | 0.500 | 0.333 | -0.167 | 0.617 | 0.491 | -0.126 | ✓ | ✓ | **regressed** |
| c31 | config-env | 0.333 | 0.200 | -0.133 | 0.606 | 0.642 | +0.035 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.250 | 0.200 | -0.050 | 0.552 | 0.517 | -0.034 | ✓ | ✓ | **regressed** |
| c48 | cross-lingual-ua-en | 0.143 | 0.125 | -0.018 | 0.475 | 0.461 | -0.014 | ✗ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.337 | 0.213 | -0.125 | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.598 | 0.598 | — | ✓ | ✓ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.642 | 0.665 | +0.023 | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c15 | config-env | 0.333 | 0.333 | — | 0.731 | 0.606 | -0.125 | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.894 | 0.932 | +0.039 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.900 | -0.100 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c26 | conceptual | 0.500 | 0.500 | — | 0.834 | 0.834 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.609 | 0.598 | -0.011 | ✓ | ✓ | — |
| c33 | conceptual | 0.500 | 0.500 | — | 0.665 | 0.834 | +0.169 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.894 | 0.956 | +0.062 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.506 | 0.491 | -0.015 | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.900 | 0.889 | -0.011 | ✓ | ✓ | — |
| c25 | conceptual | 0.333 | 0.500 | +0.167 | 0.731 | 0.834 | +0.103 | ✓ | ✓ | improved |

## Regression Detail: combined ctx-only

### c05 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c08 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c31 (config-env) — soft

- MRR: 0.333 → 0.200 (-0.133)
- nDCG@10: 0.606 → 0.642 (+0.035)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 2

### c35 (source-navigation) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c36 (source-navigation) — soft

- MRR: 1.000 → 0.200 (-0.800)
- nDCG@10: 0.877 → 0.442 (-0.436)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c37 (source-navigation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.617 → 0.491 (-0.126)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c41 (conceptual) — soft

- MRR: 0.250 → 0.200 (-0.050)
- nDCG@10: 0.552 → 0.517 (-0.034)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c48 (cross-lingual-ua-en) — soft

- MRR: 0.143 → 0.125 (-0.018)
- nDCG@10: 0.475 → 0.461 (-0.014)
- chunkRecall@5: ✗ → ✗
- top-1 relevance: 0 → 0

## Hypothesis Answer

| Comparison | MRR@10 Δ | nDCG@10 Δ | Hard regressions |
|------------|----------|-----------|-----------------|
| ctx+tags vs baseline | +0.005 | -0.006 | 2 |
| ctx-only vs baseline | -0.051 | -0.029 | 0 |
| ctx-only vs ctx+tags | -0.056 | -0.024 | ctx-only has 2 fewer |

**HYPOTHESIS REJECTED**: ctx-only does not recover quality vs ctx+tags.
The tags field in the prompt is not degrading context. Regression source is
likely the combined prompt wording itself, JSON format constraint, or LLM variance.

## Notes

- `BENCH_COMBINED_CONTEXT_ONLY=1` is a benchmark-only flag in `src/indexer/phases/combined.js`.
  Do not use it in production. Not documented as stable config.
- ctx-only variant stores tags=[] — tag-based retrieval (qdrant_find_by_tag) not usable for those chunks.
- Production default (baseline separate path) unchanged.

*Generated: 2026-05-22*