# COMBINED_LLM=1 — custom-50 Retrieval Quality — 2026-05-18

## Environment

| Item | Value |
|------|-------|
| Node.js | v25.2.1 |
| CONTEXT_MODEL | gemma3:4b-it-qat |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | cpu (default) |
| Corpus | custom-50 fixture docs (10 files) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Search mode | hybrid (RRF) |
| Top-K | 10 |

## Indexing

| Run | Exit | Points | Wall time | Phase context (mean/file) | Phase tag (mean/file) | Combined fallbacks | Tag batch fallbacks |
|-----|------|--------|-----------|--------------------------|----------------------|-------------------|---------------------|
| Baseline | OK | 100 | 120008 ms | 54 ms | 8625 ms | n/a | 0 |
| Combined | OK | 100 | 118730 ms | 56 ms (merge) | 8648 ms | 0 | n/a |

*Combined path records context=0 ms (merge only) and all LLM time under tag.*

## Aggregate Metrics

| Metric | Baseline | Combined | Delta |
|--------|----------|----------|-------|
| chunkRecall@3 | 81.6% | 79.6% | -0.020 |
| chunkRecall@5 | 85.7% | 83.7% | -0.020 |
| chunkRecall@10 | 89.8% | 89.8% | — |
| windowRecall@5 | 98.0% | 98.0% | — |
| windowRecall@10 | 98.0% | 98.0% | — |
| supportRecall@10 | 95.9% | 95.9% | — |
| nDCG@10 | 0.723 | 0.710 | -0.014 |
| MRR@10 | 0.693 | 0.672 | -0.021 |
| negativePass | 100.0% | 100.0% | — |

## Per-Query Diff (positive queries only)

6 regressed (1 hard / 5 soft), 5 improved, 38 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5 (chunk no longer in top-5). Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c36 | source-navigation | 1.000 | 0.250 | -0.750 | 0.613 | 0.264 | -0.349 | ✓ | ✓ | **regressed** |
| c11 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c20 | config-env | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c45 | config-env | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c04 | exact-token | 0.333 | 0.000 | -0.333 | 0.539 | 0.169 | -0.370 | ✓ | ✗ | **regressed** |
| c39 | exact-token | 0.500 | 0.333 | -0.167 | 0.642 | 0.606 | -0.036 | ✓ | ✓ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.900 | 0.932 | +0.033 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.337 | 0.169 | -0.169 | ✗ | ✗ | — |
| c03 | provider-activation | 0.500 | 0.500 | — | 0.642 | 0.627 | -0.015 | ✓ | ✓ | — |
| c05 | conceptual | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.932 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.885 | 0.787 | -0.098 | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c15 | config-env | 0.500 | 0.500 | — | 0.665 | 0.665 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.918 | 0.918 | — | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 0.932 | -0.068 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 0.956 | 1.000 | +0.044 | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c32 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 0.932 | 1.000 | +0.068 | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 0.000 | 0.000 | — | 0.337 | 0.337 | — | ✗ | ✗ | — |
| c37 | source-navigation | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c41 | conceptual | 0.143 | 0.143 | — | 0.431 | 0.431 | — | ✗ | ✗ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.932 | 0.907 | -0.025 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.524 | 0.524 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.143 | — | 0.431 | 0.475 | +0.044 | ✗ | ✗ | — |
| c49 | config-env | 0.500 | 0.500 | — | 0.617 | 0.617 | — | ✓ | ✓ | — |
| c31 | config-env | 0.250 | 0.333 | +0.083 | 0.552 | 0.731 | +0.179 | ✓ | ✓ | improved |
| c38 | exact-token | 0.000 | 0.143 | +0.143 | 0.337 | 0.600 | +0.262 | ✗ | ✗ | improved |
| c06 | exact-token | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c08 | exact-token | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c21 | conceptual | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |

## Regression Detail

Queries where combined MRR@10 < baseline MRR@10 by more than 0.001.
Hard = lost chunkRecall@5 (structural miss). Soft = rank-order shift within hit set (LLM variance).

### c04 (exact-token) — hard

- MRR: 0.333 → 0.000 (-0.333)
- nDCG@10: 0.539 → 0.169 (-0.370)
- chunkRecall@5: ✓ → ✗
- top-1 relevance: 0 → 0

### c11 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c20 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c36 (source-navigation) — soft

- MRR: 1.000 → 0.250 (-0.750)
- nDCG@10: 0.613 → 0.264 (-0.349)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c39 (exact-token) — soft

- MRR: 0.500 → 0.333 (-0.167)
- nDCG@10: 0.642 → 0.606 (-0.036)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 0 → 0

### c45 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

## Verdict

**proceed opt-in with caution** — minor hard regressions detected but aggregate metrics within tolerance.

Hard regressions (lost chunkRecall@5): c04. Review regression detail above.
Recommend re-running on larger corpus before any default promotion.

**Before making COMBINED_LLM=1 the default:**
1. Run on full 15-file benchmark corpus.
2. Verify no regressions on cross-lingual and config-env query types.
3. Address short-chunk context drift if COMBINED_MIN_CHARS threshold needs tuning.

*Generated: 2026-05-18 — collections: bench-c50-baseline-1779101071570, bench-c50-combined-1779101071570*