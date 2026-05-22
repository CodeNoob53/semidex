# COMBINED_LLM=1 — custom-50 Retrieval Quality — 2026-05-18

## Environment

| Item | Value |
|------|-------|
| Node.js | v25.2.1 |
| CONTEXT_MODEL | qwen2.5:3b-instruct |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | cpu (default) |
| Corpus | custom-50 fixture docs (10 files) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Search mode | hybrid (RRF) |
| Top-K | 10 |

## Indexing

| Run | Exit | Points | Wall time | Phase context (mean/file) | Phase tag (mean/file) | Combined fallbacks | Tag batch fallbacks |
|-----|------|--------|-----------|--------------------------|----------------------|-------------------|---------------------|
| Baseline | OK | 101 | 163169 ms | 39 ms | 13272 ms | n/a | 0 |
| Combined | OK | 101 | 154908 ms | 37 ms (merge) | 12493 ms | 0 | n/a |

*Combined path records context=0 ms (merge only) and all LLM time under tag.*

## Aggregate Metrics

| Metric | Baseline | Combined | Delta |
|--------|----------|----------|-------|
| chunkRecall@3 | 87.8% | 85.7% | -0.020 |
| chunkRecall@5 | 89.8% | 89.8% | — |
| chunkRecall@10 | 93.9% | 93.9% | — |
| windowRecall@5 | 98.0% | 98.0% | — |
| windowRecall@10 | 98.0% | 98.0% | — |
| supportRecall@10 | 98.0% | 98.0% | — |
| nDCG@10 | 0.751 | 0.740 | -0.011 |
| MRR@10 | 0.724 | 0.693 | -0.031 |
| negativePass | 100.0% | 100.0% | — |

## Per-Query Diff (positive queries only)

8 regressed (0 hard / 8 soft), 5 improved, 36 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5 (chunk no longer in top-5). Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c33 | conceptual | 1.000 | 0.333 | -0.667 | 0.932 | 0.731 | -0.202 | ✓ | ✓ | **regressed** |
| c11 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c12 | exact-token | 1.000 | 0.500 | -0.500 | 0.787 | 0.603 | -0.184 | ✓ | ✓ | **regressed** |
| c35 | source-navigation | 1.000 | 0.500 | -0.500 | 0.956 | 0.665 | -0.291 | ✓ | ✓ | **regressed** |
| c43 | config-env | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c15 | config-env | 0.500 | 0.333 | -0.167 | 0.665 | 0.606 | -0.059 | ✓ | ✓ | **regressed** |
| c36 | source-navigation | 0.500 | 0.333 | -0.167 | 0.624 | 0.544 | -0.080 | ✓ | ✓ | **regressed** |
| c28 | exact-token | 0.333 | 0.250 | -0.083 | 0.731 | 0.676 | -0.055 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.900 | 0.907 | +0.008 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.213 | 0.213 | — | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.642 | 0.617 | -0.025 | ✓ | ✓ | — |
| c04 | exact-token | 0.000 | 0.000 | — | 0.131 | 0.145 | +0.015 | ✗ | ✗ | — |
| c05 | conceptual | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c06 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.889 | 0.900 | +0.011 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.894 | +0.106 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.907 | 1.000 | +0.093 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.900 | 0.787 | -0.112 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.918 | -0.082 | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.731 | 0.606 | -0.125 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.500 | 0.500 | — | 0.642 | 0.642 | — | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.514 | 0.514 | — | ✓ | ✓ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.907 | 0.900 | -0.008 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.125 | 0.143 | +0.018 | 0.417 | 0.475 | +0.058 | ✗ | ✗ | improved |
| c41 | conceptual | 0.111 | 0.143 | +0.032 | 0.406 | 0.431 | +0.025 | ✗ | ✗ | improved |
| c13 | exact-token | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c32 | config-env | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c37 | source-navigation | 0.500 | 1.000 | +0.500 | 0.627 | 0.932 | +0.305 | ✓ | ✓ | improved |

## Regression Detail

Queries where combined MRR@10 < baseline MRR@10 by more than 0.001.
Hard = lost chunkRecall@5 (structural miss). Soft = rank-order shift within hit set (LLM variance).

### c11 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c12 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.603 (-0.184)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c15 (config-env) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.665 → 0.606 (-0.059)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c28 (exact-token) — soft

- MRR: 0.333 → 0.250 (-0.083)
- nDCG@10: 0.731 → 0.676 (-0.055)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 2 → 2

### c33 (conceptual) — soft

- MRR: 1.000 → 0.333 (-0.667)
- nDCG@10: 0.932 → 0.731 (-0.202)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

### c35 (source-navigation) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.956 → 0.665 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c36 (source-navigation) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.624 → 0.544 (-0.080)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c43 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.834 (-0.166)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 2

## Verdict

**defer** — 0 hard regression(s) detected. MRR@10 delta: -0.031.

Hard regressions (lost chunkRecall@5): .
Investigate context/tag quality on failed cases before promoting COMBINED_LLM=1 as opt-in default.

**Before making COMBINED_LLM=1 the default:**
1. Run on full 15-file benchmark corpus.
2. Verify no regressions on cross-lingual and config-env query types.
3. Address short-chunk context drift if COMBINED_MIN_CHARS threshold needs tuning.

*Generated: 2026-05-18 — collections: bench-c50-baseline-1779098710853, bench-c50-combined-1779098710853*