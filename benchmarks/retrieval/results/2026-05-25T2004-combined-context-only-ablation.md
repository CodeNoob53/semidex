# Combined Context-Only Ablation — custom-50 — 2026-05-25

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
| baseline separate | OK | 101 | 382079 ms | n/a | 9 |
| combined ctx+tags | OK | 101 | 199421 ms | 0 | n/a |
| combined ctx-only | OK | 101 | 175822 ms | 0 | n/a |

## Aggregate Metrics

| Metric | baseline | ctx+tags (Δ) | ctx-only (Δ) |
|--------|----------|-------------|-------------|
| chunkRecall@3 | 91.8% | 85.7% (-0.061) | 87.8% (-0.041) |
| chunkRecall@5 | 95.9% | 91.8% (-0.041) | 91.8% (-0.041) |
| chunkRecall@10 | 98.0% | 95.9% (-0.020) | 93.9% (-0.041) |
| windowRecall@5 | 98.0% | 95.9% (-0.020) | 98.0% (—) |
| windowRecall@10 | 100.0% | 98.0% (-0.020) | 98.0% (-0.020) |
| supportRecall@10 | 100.0% | 98.0% (-0.020) | 98.0% (-0.020) |
| nDCG@10 | 0.800 | 0.750 (-0.050) | 0.728 (-0.072) |
| MRR@10 | 0.794 | 0.709 (-0.084) | 0.689 (-0.104) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*Δ = combined variant − baseline.*

## Per-Query Diff: combined ctx+tags vs baseline

11 regressed (2 hard / 9 soft), 0 improved, 38 unchanged

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c05 | conceptual | 1.000 | 0.250 | -0.750 | 0.787 | 0.339 | -0.448 | ✓ | ✓ | **regressed** |
| c15 | config-env | 1.000 | 0.333 | -0.667 | 1.000 | 0.606 | -0.394 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 1.000 | 0.333 | -0.667 | 0.920 | 0.511 | -0.409 | ✓ | ✓ | **regressed** |
| c21 | conceptual | 1.000 | 0.500 | -0.500 | 0.900 | 0.497 | -0.403 | ✓ | ✓ | **regressed** |
| c25 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c28 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c04 | exact-token | 0.500 | 0.333 | -0.167 | 0.642 | 0.514 | -0.128 | ✓ | ✓ | **regressed** |
| c37 | source-navigation | 0.333 | 0.167 | -0.167 | 0.514 | 0.382 | -0.132 | ✓ | ✗ | **regressed** |
| c29 | conceptual | 0.100 | 0.000 | -0.100 | 0.228 | 0.000 | -0.228 | ✗ | ✗ | **regressed** |
| c31 | config-env | 0.333 | 0.250 | -0.083 | 0.606 | 0.552 | -0.055 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.167 | -0.033 | 0.517 | 0.449 | -0.068 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.169 | 0.337 | +0.169 | ✗ | ✗ | — |
| c03 | provider-activation | 0.333 | 0.333 | — | 0.495 | 0.394 | -0.102 | ✓ | ✓ | — |
| c06 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 1.000 | +0.068 | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.885 | 0.787 | -0.098 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.918 | 0.907 | -0.010 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.787 | -0.112 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 0.500 | 0.500 | — | 0.665 | 0.665 | — | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.500 | 0.500 | — | 0.665 | 0.665 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.918 | 0.956 | +0.038 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.594 | +0.098 | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.500 | 0.506 | +0.006 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 0.952 | 0.958 | +0.007 | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.900 | 0.907 | +0.008 | ✓ | ✓ | — |

## Regression Detail: combined ctx+tags

### c04 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.642 → 0.514 (-0.128)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c05 (conceptual) — soft

- MRR: 1.000 → 0.250 (-0.750)
- nDCG@10: 0.787 → 0.339 (-0.448)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c15 (config-env) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 1.000 → 0.606 (-0.394)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c21 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.900 → 0.497 (-0.403)
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

### c29 (conceptual) — soft

- MRR: 0.100 → 0.000 (-0.100)
- nDCG@10: 0.228 → 0.000 (-0.228)
- chunkRecall@5: ✗ → ✗
- top-1 relevance: 0 → 0

### c31 (config-env) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.606 → 0.552 (-0.055)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c36 (source-navigation) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.920 → 0.511 (-0.409)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c37 (source-navigation) — hard

- MRR: 0.333 → 0.167 (-0.167)
- nDCG@10: 0.514 → 0.382 (-0.132)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.167 (-0.033)
- nDCG@10: 0.517 → 0.449 (-0.068)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

## Per-Query Diff: combined ctx-only vs baseline

12 regressed (2 hard / 10 soft), 1 improved, 36 unchanged

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c33 | conceptual | 1.000 | 0.000 | -1.000 | 0.956 | 0.213 | -0.743 | ✓ | ✗ | **regressed** |
| c05 | conceptual | 1.000 | 0.333 | -0.667 | 0.787 | 0.394 | -0.394 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 1.000 | 0.333 | -0.667 | 0.920 | 0.544 | -0.376 | ✓ | ✓ | **regressed** |
| c06 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c08 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c25 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c26 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c38 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 0.500 | 0.333 | -0.167 | 0.665 | 0.606 | -0.059 | ✓ | ✓ | **regressed** |
| c37 | source-navigation | 0.333 | 0.200 | -0.133 | 0.514 | 0.305 | -0.209 | ✓ | ✓ | **regressed** |
| c29 | conceptual | 0.100 | 0.000 | -0.100 | 0.228 | 0.000 | -0.228 | ✗ | ✗ | **regressed** |
| c41 | conceptual | 0.200 | 0.167 | -0.033 | 0.517 | 0.449 | -0.068 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.169 | 0.213 | +0.044 | ✗ | ✗ | — |
| c04 | exact-token | 0.500 | 0.500 | — | 0.642 | 0.642 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 1.000 | +0.068 | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.885 | 0.885 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c15 | config-env | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.918 | 0.918 | — | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.787 | -0.213 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.787 | -0.112 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.787 | -0.112 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.598 | +0.102 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 0.500 | 0.500 | — | 0.665 | 0.627 | -0.038 | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.918 | 1.000 | +0.082 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.500 | 0.394 | -0.106 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 1.000 | 1.000 | — | 0.952 | 0.967 | +0.015 | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.900 | 0.900 | — | ✓ | ✓ | — |
| c03 | provider-activation | 0.333 | 0.500 | +0.167 | 0.495 | 0.598 | +0.103 | ✓ | ✓ | improved |

## Regression Detail: combined ctx-only

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

### c08 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c25 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c26 (conceptual) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c29 (conceptual) — soft

- MRR: 0.100 → 0.000 (-0.100)
- nDCG@10: 0.228 → 0.000 (-0.228)
- chunkRecall@5: ✗ → ✗
- top-1 relevance: 0 → 0

### c33 (conceptual) — hard

- MRR: 1.000 → 0.000 (-1.000)
- nDCG@10: 0.956 → 0.213 (-0.743)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 3 → 0

### c36 (source-navigation) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.920 → 0.544 (-0.376)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c37 (source-navigation) — soft

- MRR: 0.333 → 0.200 (-0.133)
- nDCG@10: 0.514 → 0.305 (-0.209)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c38 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c39 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.665 → 0.606 (-0.059)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c41 (conceptual) — hard

- MRR: 0.200 → 0.167 (-0.033)
- nDCG@10: 0.517 → 0.449 (-0.068)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

## Hypothesis Answer

| Comparison | MRR@10 Δ | nDCG@10 Δ | Hard regressions |
|------------|----------|-----------|-----------------|
| ctx+tags vs baseline | -0.084 | -0.050 | 2 |
| ctx-only vs baseline | -0.104 | -0.072 | 2 |
| ctx-only vs ctx+tags | -0.020 | -0.022 | — |

**HYPOTHESIS REJECTED**: ctx-only does not recover quality vs ctx+tags.
The tags field in the prompt is not degrading context. Regression source is
likely the combined prompt wording itself, JSON format constraint, or LLM variance.

## Notes

- `BENCH_COMBINED_CONTEXT_ONLY=1` is a benchmark-only flag in `src/indexer/phases/combined.js`.
  Do not use it in production. Not documented as stable config.
- ctx-only variant stores tags=[] — tag-based retrieval (qdrant_find_by_tag) not usable for those chunks.
- Production default (baseline separate path) unchanged.

*Generated: 2026-05-25*