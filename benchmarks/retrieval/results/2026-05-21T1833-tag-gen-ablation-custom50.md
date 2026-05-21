# TAG_GEN=0 Ablation — custom-50 Retrieval Quality + Latency — 2026-05-21

## Purpose

Verify that disabling tag generation (`TAG_GEN=0`) does not degrade hybrid RRF
retrieval quality, and measure the indexing latency difference (tag phase cost).

Tags are payload-only metadata — not embedded into dense/sparse vectors.
Default hybrid RRF search is tag-agnostic. This benchmark confirms that empirically.

## Environment

| Item | Value |
|------|-------|
| Node.js | v25.2.1 |
| CONTEXT_MODEL | gemma3:4b |
| TAG_MODEL | gemma3:4b |
| ONNX_EMBED | 1 |
| ONNX_EXECUTION_PROVIDER | cpu (default) |
| Corpus | custom-50 fixture docs (10 files) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Search mode | hybrid (RRF) |
| Top-K | 10 |

## Indexing

| Run | TAG_GEN | Exit | Points | Wall time | Phase context (mean/file) | Phase tag (mean/file) | Tag batch fallbacks |
|-----|---------|------|--------|-----------|--------------------------|----------------------|---------------------|
| Baseline | 1 (default) | OK | 101 | 195271 ms | 5931 ms | 5754 ms | 11 |
| TAG_GEN=0 | 0 (disabled) | OK | 101 | 127549 ms | 5318 ms | 0 ms | n/a |

Wall-time saving (TAG_GEN=0 vs baseline): 67722 ms (34.7% total), tag phase: 5754 ms (100.0%)

## TAG_GEN=0 Payload Audit

Scroll sample of TAG_GEN=0 collection to confirm `tags: []` is stored correctly.

| Field | Count (sample 20 of 101 points) |
|-------|------|
| tags: [] (empty, correct) | 20 |
| tags: [...] (non-empty, unexpected) | 0 |
| tags field missing | 0 |

All 20 sampled points have `tags: []` — TAG_GEN=0 payload storage confirmed correct.

## Aggregate Metrics

| Metric | Baseline (TAG_GEN=1) | TAG_GEN=0 | Delta |
|--------|---------------------|-----------|-------|
| chunkRecall@3 | 87.8% | 89.8% | +0.020 |
| chunkRecall@5 | 93.9% | 91.8% | -0.020 |
| chunkRecall@10 | 95.9% | 95.9% | — |
| windowRecall@5 | 98.0% | 98.0% | — |
| windowRecall@10 | 98.0% | 98.0% | — |
| supportRecall@10 | 98.0% | 98.0% | — |
| nDCG@10 | 0.761 | 0.769 | +0.008 |
| MRR@10 | 0.748 | 0.736 | -0.013 |
| negativePass | 100.0% | 100.0% | — |

## Per-Query Diff (positive queries only)

4 regressed (1 hard / 3 soft), 4 improved, 41 unchanged (by MRR@10 Δ > 0.001)

*Hard regression = lost chunkRecall@5. Soft = rank-order shift within hit set.*

| ID | type | base MRR | off MRR | ΔMRR | base nDCG | off nDCG | ΔnDCG | bCr5 | oCr5 | change |
|----|------|----------|---------|------|-----------|----------|-------|------|------|--------|
| c03 | provider-activation | 1.000 | 0.500 | -0.500 | 0.885 | 0.598 | -0.286 | ✓ | ✓ | **regressed** |
| c05 | conceptual | 1.000 | 0.500 | -0.500 | 0.787 | 0.497 | -0.291 | ✓ | ✓ | **regressed** |
| c26 | conceptual | 1.000 | 0.500 | -0.500 | 1.000 | 0.834 | -0.166 | ✓ | ✓ | **regressed** |
| c41 | conceptual | 0.200 | 0.167 | -0.033 | 0.450 | 0.618 | +0.168 | ✓ | ✗ | **regressed** |
| c01 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.932 | -0.023 | ✓ | ✓ | — |
| c02 | conceptual | 0.000 | 0.000 | — | 0.213 | 0.213 | — | ✗ | ✗ | — |
| c04 | exact-token | 0.333 | 0.333 | — | 0.539 | 0.514 | -0.025 | ✓ | ✓ | — |
| c06 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c07 | troubleshooting | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c08 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c09 | config-env | 0.250 | 0.250 | — | 0.339 | 0.339 | — | ✓ | ✓ | — |
| c10 | troubleshooting | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c11 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c12 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c13 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c14 | exact-token | 0.500 | 0.500 | — | 0.631 | 0.631 | — | ✓ | ✓ | — |
| c16 | troubleshooting | 1.000 | 1.000 | — | 0.918 | 0.900 | -0.018 | ✓ | ✓ | — |
| c17 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c18 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c19 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c20 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c21 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.894 | +0.106 | ✓ | ✓ | — |
| c22 | exact-token | 1.000 | 1.000 | — | 0.932 | 1.000 | +0.068 | ✓ | ✓ | — |
| c23 | conceptual | 1.000 | 1.000 | — | 0.787 | 0.907 | +0.120 | ✓ | ✓ | — |
| c24 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c25 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c27 | exact-token | 1.000 | 1.000 | — | 0.956 | 0.956 | — | ✓ | ✓ | — |
| c28 | exact-token | 1.000 | 1.000 | — | 1.000 | 0.932 | -0.068 | ✓ | ✓ | — |
| c29 | conceptual | 0.000 | 0.000 | — | 0.000 | 0.000 | — | ✗ | ✗ | — |
| c30 | exact-token | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c31 | config-env | 0.333 | 0.333 | — | 0.606 | 0.606 | — | ✓ | ✓ | — |
| c33 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c34 | conceptual | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c35 | source-navigation | 0.500 | 0.500 | — | 0.497 | 0.642 | +0.145 | ✓ | ✓ | — |
| c36 | source-navigation | 0.500 | 0.500 | — | 0.591 | 0.693 | +0.102 | ✓ | ✓ | — |
| c38 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c39 | exact-token | 0.500 | 0.500 | — | 0.642 | 0.665 | +0.023 | ✓ | ✓ | — |
| c40 | exact-token | 1.000 | 1.000 | — | 0.787 | 0.787 | — | ✓ | ✓ | — |
| c42 | exact-token | 1.000 | 1.000 | — | 0.907 | 0.932 | +0.025 | ✓ | ✓ | — |
| c43 | config-env | 1.000 | 1.000 | — | 1.000 | 0.956 | -0.044 | ✓ | ✓ | — |
| c44 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c45 | config-env | 0.500 | 0.500 | — | 0.497 | 0.497 | — | ✓ | ✓ | — |
| c46 | config-env | 1.000 | 1.000 | — | 1.000 | 1.000 | — | ✓ | ✓ | — |
| c48 | cross-lingual-ua-en | 0.143 | 0.143 | — | 0.475 | 0.475 | — | ✗ | ✗ | — |
| c49 | config-env | 1.000 | 1.000 | — | 0.900 | 0.900 | — | ✓ | ✓ | — |
| c37 | source-navigation | 0.250 | 0.333 | +0.083 | 0.459 | 0.500 | +0.041 | ✓ | ✓ | improved |
| c15 | config-env | 0.333 | 0.500 | +0.167 | 0.731 | 0.834 | +0.103 | ✓ | ✓ | improved |
| c47 | exact-token | 0.333 | 0.500 | +0.167 | 0.495 | 0.609 | +0.114 | ✓ | ✓ | improved |
| c32 | config-env | 0.500 | 1.000 | +0.500 | 0.497 | 0.787 | +0.291 | ✓ | ✓ | improved |

## Verdict

**latency confirmed, quality inconclusive (by design).**

**Latency:** TAG_GEN=0 saves 34.7% indexing wall-time (195s → 127s). Tag phase cost: 5754 ms/file
mean (100% eliminated). With 11 batch parse fallbacks in baseline, actual savings on larger
corpora with irregular models will be higher.

**Payload:** TAG_GEN=0 correctly stores `tags: []` on all sampled points. `shouldGenerateTags()`
implementation confirmed working.

**Quality:** Result is inconclusive — not because TAG_GEN=0 harms retrieval, but because this
benchmark cannot isolate the variable. Both runs regenerate context independently via LLM. Context
is prepended to the embedding text (`context\n\nchunk_text`), so two independent context runs
produce slightly different embeddings. The observed 1 hard regression (c41, MRR 0.200→0.167 but
nDCG +0.168) and symmetric pattern (4 regressions / 4 improvements) are consistent with LLM
variance, not a TAG_GEN effect.

Tags are not referenced in `src/core/embeddings.js` and are never prepended to embedding text.
They cannot affect hybrid RRF retrieval unless explicitly passed as a filter. The quality claim
("TAG_GEN=0 has no retrieval impact") is correct by code inspection — this benchmark does not
add empirical evidence for or against it.

*Generated: 2026-05-21 — collections: bench-c50-tag-on-1779388046966, bench-c50-tag-off-1779388046966*