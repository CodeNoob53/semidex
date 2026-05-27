# Combined Mode Post-Qrel-Fix Verification — custom-50

*Generated: 2026-05-27*

## Purpose

Canonical post-fix quality assessment for COMBINED_LLM=1 after:
1. Empty-section chunk removal (24→21 chunks in `benchmarking.md`, etc.) — see `2026-05-26T1200-empty-section-removal.md`
2. Correction of stale qrels in `benchmarking.md`, `project-structure.md`, `multilingual.md` — see `2026-05-26T1300-custom50-post-empty-section-removal.md`

All combined-mode reports dated before 2026-05-26T1200 are **archival only** — they used stale qrels and cannot be compared directly to results in this report.

## Runs Included

```powershell
$env:ONNX_EMBED = "1"; $env:BENCH_PROVIDER = "onnx"
npm run bench:custom50:combined-matrix
npm run bench:custom50:context-only-ablation
```

| Report | Type | Description |
|--------|------|-------------|
| `2026-05-26T2055-combined-llm-quality-matrix.md` | Quality matrix | baseline vs gemma3:4b vs qwen2.5:3b-instruct; shared baseline eliminates reindex variance |
| `2026-05-26T2115-combined-context-only-ablation.md` | Ablation | ctx+tags vs ctx-only vs baseline; tests whether dual-task prompt degrades context |

## Environment

| Item | Value |
|------|-------|
| Embedding provider | bge-m3-onnx (ONNX_EMBED=1) |
| Search mode | hybrid (RRF) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Expected points per collection | 96 (post-empty-section-removal) |

All three matrix collections and all three ablation collections confirmed at 96 points.

## Quality Matrix Results

Context policy: `current-minimal` for all matrix runs (baseline pinned, combined also `current-minimal`).

### Aggregate

| Metric | baseline | gemma3:4b (Δ) | qwen2.5:3b-instruct (Δ) |
|--------|----------|---------------|------------------------|
| chunkRecall@3 | 91.8% | 87.8% (−4.1pp) | 87.8% (−4.1pp) |
| chunkRecall@5 | 95.9% | 91.8% (−4.1pp) | 93.9% (−2.0pp) |
| chunkRecall@10 | 95.9% | 98.0% (+2.1pp) | 95.9% (—) |
| windowRecall@5 | 98.0% | 95.9% (−2.1pp) | 98.0% (—) |
| windowRecall@10 | 98.0% | 100.0% (+2.1pp) | 98.0% (—) |
| supportRecall@10 | 98.0% | 100.0% (+2.1pp) | 98.0% (—) |
| nDCG@10 | 0.777 | 0.774 (−0.003) | 0.790 (+0.013) |
| MRR@10 | 0.772 | 0.756 (−0.016) | 0.782 (+0.010) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*MRR/nDCG noise floor: ±0.030 / ±0.014 with identical index (see `2026-05-26T1430-custom50-variance-source-check.md`). Both MRR deltas are within noise. Classification based on chunkRecall@5 loss only.*

### Hard Regressions (chunkRecall@5 lost)

| Model | Query | type | bCr5 | cCr5 | ΔMRR |
|-------|-------|------|------|------|------|
| gemma3:4b | c35 | source-navigation | ✓ | ✗ | −0.357 |
| gemma3:4b | c41 | conceptual | ✓ | ✗ | −0.083 |
| qwen2.5:3b-instruct | c36 | source-navigation | ✓ | ✗ | −0.875 |

### Notable Per-Query Outcomes

| Query | type | gemma3:4b | qwen2.5:3b-instruct | Note |
|-------|------|-----------|---------------------|------|
| c41 | conceptual (UA) | **hard** ✗ cr@5 | soft ✓ cr@5 | 21q vs custom-50 distinction |
| c48 | cross-lingual-ua-en | ✓ cr@5 | ✓ cr@5 | corrected qrel (`multilingual.md#3`) confirmed working |
| c35 | source-navigation | **hard** ✗ cr@5 | improved ✓ | qdrant.js location |
| c36 | source-navigation | soft ✓ cr@5 | **hard** ✗ cr@5 | chunk.js location |

c48 ✓ for both models confirms the corrected qrel (`multilingual.md#3`, Query Language vs Document Language) is correct and retrieval finds it.

## Context-Only Ablation Results

Tests hypothesis: does the dual-task prompt (context+tags together) degrade context quality vs a context-only combined call?

| Comparison | MRR@10 Δ | nDCG@10 Δ | Hard regressions | chunkRecall@5 Δ |
|------------|----------|-----------|-----------------|-----------------|
| ctx+tags vs baseline | −0.055 | −0.033 | 1 (c41) | −2.0pp |
| ctx-only vs baseline | −0.067 | −0.048 | 1 (c41) | −2.0pp |
| ctx-only vs ctx+tags | −0.012 | −0.015 | 0 | — |

**HYPOTHESIS REJECTED**: ctx-only does not recover quality vs ctx+tags. The MRR/nDCG gap between ctx-only and ctx+tags (−0.012 / −0.015) is within the ±0.030/±0.014 noise floor — indistinguishable from search-ordering noise. The tags field in the combined prompt is not degrading context generation. Regression source is the combined prompt format/wording itself, JSON constraint, or LLM variance.

**Implication**: the dual-task prompt is not the problem. There is no benefit to splitting context and tags into separate combined calls.

### c41 in Ablation

c41 is a hard regression in both ctx+tags and ctx-only vs baseline. This is consistent with the matrix result (gemma3:4b hard, qwen2.5 soft). c41 regresses under all combined variants regardless of whether tags are requested — further confirming the cause is the combined prompt format, not tag generation interference.

## Verdict

### gemma3:4b

**DEFER_HARD_REGRESSIONS**

2 hard regressions (c35: source-navigation, c41: conceptual). MRR@10 Δ −0.016 is within noise floor but chunkRecall@5 drops −4.1pp. Not safe to enable as default. The source-navigation class is an existing weakness (2 queries, inherently low MRR in baseline); c41 is a confirmed gemma3-specific regression under combined mode.

### qwen2.5:3b-instruct

**DEFER_HARD_REGRESSIONS**

1 hard regression (c36: source-navigation, cr@5 ✗). MRR@10 Δ +0.010 is within noise floor but the c36 regression is real. qwen2.5 is otherwise stronger than gemma3 at this corpus (+8 improvements vs +5, better on source-navigation c35 and c37). Should be reconsidered after investigation of c36.

### Combined Mode Status

COMBINED_LLM=1 remains **opt-in only**. Production default unchanged (separate context + tags path).

Criteria for revisiting:
- Investigate c41 regression pattern (conceptual, multilingual query, benchmarking-fixture-specific)
- Investigate c36 hard regression under qwen2.5 (source-navigation)
- Retest on broader fixture corpus before any default-promotion decision

## Prior Reports (Archival)

All combined-mode reports dated before 2026-05-26T1200 used stale qrels and are not directly comparable to results in this report. This includes all `2026-05-25T*` combined-mode runs and any earlier runs. The c48 and c41 results in those reports referenced wrong chunk indexes; the apparent c48 hard regression in pre-fix reports was a qrel error, not a retrieval failure.
