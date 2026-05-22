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
| baseline separate | OK | 101 | 217560 ms | n/a | 8 |
| combined ctx+tags | OK | 101 | 179189 ms | 0 | n/a |
| combined ctx-only | OK | 101 | 157007 ms | 1 | n/a |

## Aggregate Metrics

| Metric | baseline | ctx+tags (Δ) | ctx-only (Δ) |
|--------|----------|-------------|-------------|
| chunkRecall@3 | 89.8% | 87.8% (-0.020) | 85.7% (-0.041) |
| chunkRecall@5 | 93.9% | 93.9% (—) | 93.9% (—) |
| chunkRecall@10 | 95.9% | 95.9% (—) | 95.9% (—) |
| windowRecall@5 | 95.9% | 98.0% (+0.020) | 98.0% (+0.020) |
| windowRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| supportRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| nDCG@10 | 0.763 | 0.740 (-0.023) | 0.754 (-0.009) |
| MRR@10 | 0.743 | 0.711 (-0.032) | 0.727 (-0.017) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Δ = combined variant − baseline.*

## Per-Query Diff: combined ctx+tags vs baseline

8 regressed (1 hard / 7 soft), 6 improved, 35 unchanged

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c05 | conceptual | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c15 | config-env | 1.000 | 0.333 | -0.667 | 1.000 | 0.606 | -0.394 | ✓ | ✓ | **regressed** |
| c08 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c12 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.594 | -0.193 | ✓ | ✓ | **regressed** |
| c35 | source-navigation | 1.000 | 0.500 | -0.500 | 0.932 | 0.642 | -0.291 | ✓ | ✓ | **regressed** |
| c38 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c03 | provider-activation | 0.500 | 0.250 | -0.250 | 0.497 | 0.441 | -0.056 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.143 | -0.057 | 0.450 | 0.431 | -0.019 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.120 | 0.213 | +0.093 | ✗ | ✗ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.617 | 0.617 | — | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.918 | 0.907 | -0.010 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.918 | 0.956 | +0.038 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c32 | config-env | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c37 | source-navigation | 0.500 | 0.500 | — | 0.598 | 0.603 | +0.005 | ✓ | ✓ | — |
| c39 | exact-token | 0.500 | 0.500 | — | 0.642 | 0.665 | +0.023 | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.900 | 0.907 | +0.008 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.200 | +0.057 | 0.475 | 0.473 | -0.002 | ✗ | ✓ | improved |
| c36 | source-navigation | 0.333 | 0.500 | +0.167 | 0.511 | 0.605 | +0.094 | ✓ | ✓ | improved |
| c47 | exact-token | 0.333 | 0.500 | +0.167 | 0.506 | 0.603 | +0.097 | ✓ | ✓ | improved |
| c25 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c26 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c33 | conceptual | 0.333 | 1.000 | +0.667 | 0.731 | 1.000 | +0.269 | ✓ | ✓ | improved |

## Regression Detail: combined ctx+tags

### c03 (provider-activation) — soft

- MRR: 0.500 → 0.250 (-0.250)
- nDCG@10: 0.497 → 0.441 (-0.056)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

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

### c12 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.594 (-0.193)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c15 (config-env) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 1.000 → 0.606 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c35 (source-navigation) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.932 → 0.642 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c38 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.143 (-0.057)
- nDCG@10: 0.450 → 0.431 (-0.019)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

## Per-Query Diff: combined ctx-only vs baseline

8 regressed (1 hard / 7 soft), 5 improved, 36 unchanged

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c15 | config-env | 1.000 | 0.333 | -0.667 | 1.000 | 0.606 | -0.394 | ✓ | ✓ | **regressed** |
| c32 | config-env | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c35 | source-navigation | 1.000 | 0.500 | -0.500 | 0.932 | 0.642 | -0.291 | ✓ | ✓ | **regressed** |
| c49 | config-env | 1.000 | 0.500 | -0.500 | 0.900 | 0.603 | -0.297 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 0.500 | 0.333 | -0.167 | 0.642 | 0.606 | -0.036 | ✓ | ✓ | **regressed** |
| c31 | config-env | 0.333 | 0.250 | -0.083 | 0.606 | 0.676 | +0.070 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 0.333 | 0.250 | -0.083 | 0.511 | 0.482 | -0.028 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.167 | -0.033 | 0.450 | 0.449 | — | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.120 | 0.213 | +0.093 | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.617 | 0.642 | +0.025 | ✓ | ✓ | — |
| c05 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.885 | +0.098 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.918 | 0.900 | -0.018 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.918 | 0.956 | +0.038 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c37 | source-navigation | 0.500 | 0.500 | — | 0.598 | 0.497 | -0.102 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.506 | 0.495 | -0.011 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.200 | +0.057 | 0.475 | 0.517 | +0.042 | ✗ | ✓ | improved |
| c33 | conceptual | 0.333 | 0.500 | +0.167 | 0.731 | 0.834 | +0.103 | ✓ | ✓ | improved |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c25 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |
| c26 | conceptual | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |

## Regression Detail: combined ctx-only

### c15 (config-env) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 1.000 → 0.606 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c31 (config-env) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.606 → 0.676 (+0.070)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 2

### c32 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c35 (source-navigation) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.932 → 0.642 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c36 (source-navigation) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.511 → 0.482 (-0.028)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c39 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.642 → 0.606 (-0.036)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.167 (-0.033)
- nDCG@10: 0.450 → 0.449 (—)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c49 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.900 → 0.603 (-0.297)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

## Hypothesis Answer

| Comparison | MRR@10 Δ | nDCG@10 Δ | Hard regressions |
|------------|----------|-----------|-----------------|
| ctx+tags vs baseline | -0.032 | -0.023 | 1 |
| ctx-only vs baseline | -0.017 | -0.009 | 1 |
| ctx-only vs ctx+tags | +0.016 | +0.014 | — |

**HYPOTHESIS SUPPORTED**: ctx-only recovers quality vs ctx+tags (MRR@10 Δ > +0.01).
The dual-task prompt (context + tags in one call) is likely degrading context quality.
Combined mode with context-only prompt is worth investigating as a production path.

## Notes

- `BENCH_COMBINED_CONTEXT_ONLY=1` is a benchmark-only flag in `src/indexer/phases/combined.js`.
  Do not use it in production. Not documented as stable config.
- ctx-only variant stores tags=[] — tag-based retrieval (qdrant_find_by_tag) not usable for those chunks.
- Production default (baseline separate path) unchanged.

*Generated: 2026-05-22*