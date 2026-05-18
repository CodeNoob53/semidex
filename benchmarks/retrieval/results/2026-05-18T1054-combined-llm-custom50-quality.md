# COMBINED_LLM=1 — custom-50 Retrieval Quality — 2026-05-18

## Environment

| Item | Value |
|------|-------|
| Node.js | v25.2.1 |
| CONTEXT_MODEL | batiai/gemma4-e2b:q4 |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | cpu (default) |
| Corpus | custom-50 fixture docs (10 files) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Search mode | hybrid (RRF) |
| Top-K | 10 |

## Indexing

| Run | Exit | Points | Wall time | Phase context (mean/file) | Phase tag (mean/file) | Combined fallbacks | Tag batch fallbacks |
|-----|------|--------|-----------|--------------------------|----------------------|-------------------|---------------------|
| Baseline | OK | 100 | 141698 ms | 234 ms | 10958 ms | n/a | 0 |
| Combined | OK | 100 | 142842 ms | 298 ms (merge) | 10842 ms | 0 | n/a |

*Combined path records context=0 ms (merge only) and all LLM time under tag.*

## Aggregate Metrics

| Metric | Baseline | Combined | Delta |
|--------|----------|----------|-------|
| chunkRecall@3 | 79.6% | 79.6% | — |
| chunkRecall@5 | 83.7% | 83.7% | — |
| chunkRecall@10 | 87.8% | 87.8% | — |
| windowRecall@5 | 98.0% | 98.0% | — |
| windowRecall@10 | 98.0% | 98.0% | — |
| supportRecall@10 | 95.9% | 95.9% | — |
| nDCG@10 | 0.729 | 0.717 | -0.012 |
| MRR@10 | 0.702 | 0.683 | -0.019 |
| negativePass | 100.0% | 100.0% | — |

## Per-Query Diff (positive queries only)

7 regressed (0 hard / 7 soft), 6 improved, 36 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5 (chunk no longer in top-5). Soft = rank-order shift within hit set.*

| ID | type | base MRR | comb MRR | ΔMRR | base nDCG | comb nDCG | ΔnDCG | bCr5 | cCr5 | change |
|----|------|----------|----------|------|-----------|-----------|-------|------|------|--------|
| c01 | exact-token | 1.000 | 0.500 | -0.500 | 0.918 | 0.627 | -0.291 | ✓ | ✓ | **regressed** |
| c03 | provider-activation | 1.000 | 0.500 | -0.500 | 0.900 | 0.665 | -0.234 | ✓ | ✓ | **regressed** |
| c11 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c14 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c30 | exact-token | 1.000 | 0.500 | -0.500 | 1.000 | 0.631 | -0.369 | ✓ | ✓ | **regressed** |
| c39 | exact-token | 1.000 | 0.500 | -0.500 | 0.932 | 0.642 | -0.291 | ✓ | ✓ | **regressed** |
| c45 | config-env | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c02 | conceptual | 0.000 | 0.000 | — | 0.213 | 0.213 | — | ✗ | ✗ | — |
| c04 | exact-token | 0.000 | 0.000 | — | 0.169 | 0.169 | — | ✗ | ✗ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.885 | 0.885 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c15 | config-env | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.932 | 0.918 | -0.015 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 0.932 | 0.956 | +0.023 | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.889 | +0.102 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 0.907 | 1.000 | +0.093 | ✓ | ✓ | — |
| c26 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 0.000 | 0.000 | — | 0.337 | 0.337 | — | ✗ | ✗ | — |
| c36 | source-navigation | 0.333 | 0.333 | — | 0.307 | 0.307 | — | ✓ | ✓ | — |
| c37 | source-navigation | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c38 | exact-token | 0.000 | 0.000 | — | 0.337 | 0.337 | — | ✗ | ✗ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.889 | +0.102 | ✓ | ✓ | — |
| c41 | conceptual | 0.143 | 0.143 | — | 0.408 | 0.475 | +0.068 | ✗ | ✗ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.918 | 0.907 | -0.010 | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c47 | exact-token | 0.333 | 0.333 | — | 0.524 | 0.514 | -0.010 | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.143 | — | 0.431 | 0.431 | — | ✗ | ✗ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.907 | 0.918 | +0.010 | ✓ | ✓ | — |
| c31 | config-env | 0.200 | 0.250 | +0.050 | 0.642 | 0.552 | -0.090 | ✓ | ✓ | improved |
| c05 | conceptual | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c08 | exact-token | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |
| c20 | config-env | 0.500 | 1.000 | +0.500 | 0.631 | 1.000 | +0.369 | ✓ | ✓ | improved |
| c32 | config-env | 0.500 | 1.000 | +0.500 | 0.617 | 0.900 | +0.283 | ✓ | ✓ | improved |
| c43 | config-env | 0.500 | 1.000 | +0.500 | 0.834 | 1.000 | +0.166 | ✓ | ✓ | improved |

## Regression Detail

Queries where combined MRR@10 < baseline MRR@10 by more than 0.001.
Hard = lost chunkRecall@5 (structural miss). Soft = rank-order shift within hit set (LLM variance).

### c01 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.918 → 0.627 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c03 (provider-activation) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.900 → 0.665 (-0.234)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c11 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c14 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c30 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 1.000 → 0.631 (-0.369)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c39 (exact-token) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.932 → 0.642 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

### c45 (config-env) — soft

- MRR: 1.000 → 0.500 (-0.500)
- nDCG@10: 0.787 → 0.497 (-0.291)
- chunkRecall@5: ✓ → ✓
- top-1 relevance: 3 → 0

## Verdict

**proceed opt-in** — COMBINED_LLM=1 shows no hard quality regression on custom-50.

MRR@10 delta: -0.019. chunkRecall@5 delta: —. chunkRecall@10 delta: —. Combined parse fallbacks: 0.

7 soft regression(s) (rank-order shift within chunkRecall@5 hits, not retrieval misses): c01, c03, c11, c14, c30, c39, c45.
These reflect LLM context/tag phrasing variance affecting embedding score — not a structural retrieval failure.

COMBINED_LLM=1 remains opt-in. No default promotion needed at this time.

**Before making COMBINED_LLM=1 the default:**
1. Run on full 15-file benchmark corpus.
2. Verify no regressions on cross-lingual and config-env query types.
3. Address short-chunk context drift if COMBINED_MIN_CHARS threshold needs tuning.

*Generated: 2026-05-18 — collections: bench-c50-baseline-1779101340435, bench-c50-combined-1779101340435*