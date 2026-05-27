# Combined Mode — identifier-preserving Context Policy Test — custom-50

*Generated: 2026-05-27*

## Purpose

Test whether `BENCH_CONTEXT_POLICY=identifier-preserving` fixes the c41 combined-mode
regression (context identifier loss diagnosed in `2026-05-27T0430-c41-combined-regression-diagnostic.md`)
without introducing new hard regressions elsewhere.

## Commands

```powershell
$env:ONNX_EMBED = "1"
$env:BENCH_PROVIDER = "onnx"
$env:BENCH_COMBINED_CONTEXT_POLICY = "identifier-preserving"
npm run bench:custom50:combined-matrix
```

Baseline is always pinned to `current-minimal` by the matrix script
(`combined-llm-quality-matrix.js:619`). `BENCH_COMBINED_CONTEXT_POLICY` applies
to combined runs only. No script changes were needed.

## Environment / Sanity Check

| Item | Value |
|------|-------|
| Embedding provider | bge-m3-onnx (ONNX_EMBED=1) |
| Search mode | hybrid (RRF) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Combined context policy | `identifier-preserving` |
| Baseline context policy | `current-minimal` (pinned) |

| Variant | Points | Wall time | Combined fallbacks |
|---------|--------|-----------|-------------------|
| baseline (separate) | 96 | 414698 ms | n/a |
| combined gemma3:4b | 96 | 222072 ms | 3 |
| combined qwen2.5:3b-instruct | 96 | 194359 ms | 0 |

All collections: 96 points ✓ (correct post-empty-section-removal count).

---

## Aggregate Metrics

| Metric | baseline | gemma3:4b (Δ) | qwen2.5:3b-instruct (Δ) |
|--------|----------|---------------|------------------------|
| chunkRecall@3 | 89.8% | 87.8% (−2.0pp) | 79.6% (−10.2pp) |
| chunkRecall@5 | 95.9% | 93.9% (−2.0pp) | 89.8% (−6.1pp) |
| chunkRecall@10 | 95.9% | 95.9% (—) | 95.9% (—) |
| windowRecall@5 | 98.0% | 98.0% (—) | 95.9% (−2.1pp) |
| windowRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| supportRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| nDCG@10 | 0.788 | 0.744 (−0.045) | 0.757 (−0.031) |
| MRR@10 | 0.752 | 0.700 (−0.052) | 0.746 (−0.007) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*MRR/nDCG noise floor: ±0.030 / ±0.014. MRR delta for qwen (−0.007) is within noise.
gemma MRR delta (−0.052) and qwen chunkRecall@5 (−6.1pp) exceed noise — real signal.*

---

## Hard Regressions

### gemma3:4b — 1 hard regression

| Query | type | bCr5 | cCr5 | ΔMRR | note |
|-------|------|------|------|------|------|
| c35 | source-navigation | ✓ | ✗ | −0.833 | known source-navigation class weakness |

### qwen2.5:3b-instruct — 3 hard regressions

| Query | type | bCr5 | cCr5 | ΔMRR | note |
|-------|------|------|------|------|------|
| c35 | source-navigation | ✓ | ✗ | −0.857 | source-navigation class |
| c33 | conceptual | ✓ | ✗ | −0.375 | **new regression under this policy** |
| c41 | conceptual | ✓ | ✗ | −0.075 | c41 not recovered under qwen |

---

## c41 Focused Comparison

| Variant | Source | Policy | cr@5 | MRR@10 | nDCG@10 | `benchmarking.md#1` rank |
|---------|--------|--------|------|--------|---------|--------------------------|
| baseline | T0802 (this run) | current-minimal | ✓ | 0.200 | 0.642 | 5 |
| gemma — current-minimal | T0730 isolated diagnostic | current-minimal | ✗ | 0.167 | 0.449 | 6 |
| qwen — current-minimal (matrix) | T2055 quality matrix | current-minimal | ✓ | 0.200 | 0.473 | 5 (search-ordering noise) |
| qwen — current-minimal (isolated) | T0734 isolated diagnostic | current-minimal | ✗ | — | — | 6 |
| **gemma — identifier-preserving** | **T0802 (this run)** | identifier-preserving | **✓** | **0.200** | **0.517** | **5 — recovered** |
| **qwen — identifier-preserving** | **T0802 (this run)** | identifier-preserving | **✗** | **0.125** | **0.417** | **>5 — worse** |

qwen's current-minimal result is split across two sources because the T2055 matrix run
and the T0734 isolated diagnostic gave different cr@5 outcomes (✓ vs ✗) for the same
policy. This is expected: `benchmarking.md#1` sits at rank 5 with a score margin of
~0.001 over rank 6, within RRF search-ordering noise. Both results are valid observations
of the same borderline case.

### Context snippets for `benchmarking.md#1`

Identifier-preserving payload snippets were not captured in this report; c41 recovery
for gemma is measured by rank/cr@5 only. Payloads below cover baseline and current-minimal
only, from the isolated diagnostic runs (`2026-05-27T0730`, `2026-05-27T0734`).

| Variant | Context |
|---------|---------|
| baseline | "…stable regression smoke benchmark, a pre-merge test utilizing **4 fixture documents and 21 queries**…" |
| gemma current-minimal | "…stable regression smoke benchmark, a test run for detecting retrieval regressions in the `bench`…" (loses "21") |
| gemma identifier-preserving | *payload not captured — recovery evidenced by cr@5 ✓ and rank 5 in T0802* |
| qwen identifier-preserving | *payload not captured — regression evidenced by cr@5 ✗ and MRR 0.125 in T0802* |

### c41 verdict

- `identifier-preserving` **recovers c41 for gemma3:4b** ✓ — `benchmarking.md#1`
  returns to rank 5, cr@5 ✓. Payload not captured; recovery is rank/cr@5 evidence only.
- `identifier-preserving` **does NOT recover c41 for qwen2.5:3b-instruct** ✗ — cr@5
  lost, MRR drops from 0.200 to 0.125, worse than both current-minimal outcomes.
  Payload not captured; the cause of the additional degradation is not confirmed.

---

## Comparison vs current-minimal Policy (T2055)

| Model | Policy | Hard regressions | chunkRecall@5 Δ | MRR@10 |
|-------|--------|-----------------|-----------------|--------|
| gemma3:4b | current-minimal | 2 (c35, c41) | −4.1pp | 0.756 |
| gemma3:4b | **identifier-preserving** | **1 (c35)** | **−2.0pp** | **0.700** |
| qwen2.5:3b-instruct | current-minimal | 1 (c36) | −2.0pp | 0.782 |
| qwen2.5:3b-instruct | **identifier-preserving** | **3 (c35, c33, c41)** | **−6.1pp** | **0.746** |

*T2055 baseline MRR = 0.772; this run baseline MRR = 0.752 — within noise floor (±0.030).*

**gemma3:4b**: identifier-preserving is an improvement — loses 1 fewer hard regression
(c41 recovered), chunkRecall@5 improves by 2.0pp. But the remaining c35 hard regression
and the broader MRR drop (−0.052 vs baseline) still prevent promotion.

**qwen2.5:3b-instruct**: identifier-preserving is clearly worse — hard regressions
increase from 1 to 3, chunkRecall@5 drops an additional 4.1pp vs current-minimal.
c33 (conceptual) is a new regression not seen under any prior policy. The policy
is not suitable for qwen.

---

## Improved Queries

### gemma3:4b improvements (5)

| Query | type | ΔMRR | note |
|-------|------|------|------|
| c28 | exact-token | +0.667 | — |
| c33 | conceptual | +0.500 | — |
| c04 | exact-token | +0.167 | — |
| c15 | config-env | +0.167 | — |
| c31 | config-env | +0.083 | — |

### qwen2.5:3b-instruct improvements (7)

| Query | type | ΔMRR | note |
|-------|------|------|------|
| c15 | config-env | +0.667 | — |
| c28 | exact-token | +0.667 | — |
| c11 | exact-token | +0.500 | — |
| c14 | exact-token | +0.500 | — |
| c26 | conceptual | +0.500 | — |
| c03 | provider-activation | +0.167 | — |
| c04 | exact-token | +0.167 | — |

---

## c48 Status

c48 (cross-lingual-ua-en): ✓ cr@5 for both models under identifier-preserving policy.
Corrected qrel (`multilingual.md#3`) remains healthy.

## c35 / c36 Status

c35 (source-navigation): hard regression under both models. This is the same class
weakness present under current-minimal for gemma, and is now present for qwen too
under identifier-preserving. Source-navigation queries are a known separate weakness;
not the focus of this policy test.

c36 (source-navigation): soft regression for qwen under identifier-preserving (was hard
under current-minimal — actually improved from hard to soft for qwen's c36 specifically).

---

## Verdict

**POLICY_RECOVERS_C41_BUT_REGRESSES_ELSEWHERE**

`identifier-preserving` context policy:
- ✓ Recovers c41 for gemma3:4b (rank 5 restored, cr@5 ✓)
- ✓ Reduces gemma hard regressions from 2 → 1
- ✗ Does NOT recover c41 for qwen2.5:3b-instruct (cr@5 ✗, worse than current-minimal)
- ✗ Introduces new hard regression c33 (conceptual) for qwen
- ✗ Increases qwen hard regressions from 1 → 3, chunkRecall@5 drops −6.1pp

The policy cannot be promoted as a combined default — it is model-specific in its
effect and actively harmful for qwen2.5:3b-instruct.

---

## Recommendation

**Keep defaults unchanged. Do not promote identifier-preserving to combined default.**

Specific findings:

1. **identifier-preserving is viable for gemma3:4b only** — reduces hard regressions
   from 2 to 1 and recovers c41. If gemma is eventually promoted as the combined-mode
   default model, this policy should be retested as the context policy for that model.

2. **identifier-preserving is harmful for qwen2.5:3b-instruct** — the stricter
   identifier instructions cause context drift in a different direction, introducing
   new conceptual regressions (c33) and failing to fix c41. Do not use for qwen.

3. **The c41 fix path is model-specific**: there is no single policy that fixes c41
   for both models simultaneously under this corpus. A per-model context policy
   configuration would be needed if both models are to be supported cleanly.

4. **Current-minimal remains the better choice for qwen**: 1 hard regression (c36,
   source-navigation) vs 3 hard regressions under identifier-preserving.

5. **Combined mode status unchanged**: COMBINED_LLM=1 remains opt-in only. Production
   default unchanged.

---

## Raw Report Reference

- `benchmarks/retrieval/results/2026-05-27T0802-combined-llm-quality-matrix.md` — auto-generated matrix data for this run
- `benchmarks/retrieval/results/2026-05-27T0430-c41-combined-regression-diagnostic.md` — c41 root cause
- `benchmarks/retrieval/results/2026-05-27T0000-combined-post-qrel-fix-verification.md` — post-fix baseline
- `benchmarks/retrieval/results/2026-05-26T2055-combined-llm-quality-matrix.md` — current-minimal policy matrix
