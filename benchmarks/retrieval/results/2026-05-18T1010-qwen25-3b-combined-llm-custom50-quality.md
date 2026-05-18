# qwen2.5:3b-instruct vs gemma3:4b — COMBINED_LLM=1 custom-50 Comparison — 2026-05-18

## Purpose

Evaluate whether `qwen2.5:3b-instruct` (1.84 GB) can replace `gemma3:4b` (3.18 GB) for
`COMBINED_LLM=1`. Even quality parity would be a win due to smaller model size and faster load.

## Run Inventory

| Report | Model | Date | Notes |
|--------|-------|------|-------|
| [2026-05-17T2333](2026-05-17T2333-combined-llm-custom50-quality.md) | gemma3:4b | 2026-05-17 | Clean pre-tweak baseline — reference |
| [2026-05-18T0804](2026-05-18T0804-combined-llm-custom50-quality.md) | gemma3:4b | 2026-05-18 | Post prompt-tweak (tweak reverted — not used here) |
| [2026-05-18T1004](2026-05-18T1004-combined-llm-custom50-quality.md) | gemma3:4b | 2026-05-18 | **Invalid qwen2.5 run** — `$env:CONTEXT_MODEL` PowerShell syntax failed in bash; model defaulted to gemma3:4b. Discard. |
| [2026-05-18T1010](2026-05-18T1010-combined-llm-custom50-quality.md) | qwen2.5:3b-instruct | 2026-05-18 | **Valid qwen2.5 run** — bash inline env `CONTEXT_MODEL=qwen2.5:3b-instruct` |

Reference for gemma3:4b: **T2333** (pre-tweak, clean). qwen2.5 data: **T1010**.

## Model Comparison

| Property | gemma3:4b | qwen2.5:3b-instruct |
|----------|-----------|---------------------|
| Size on disk | 3.18 GB | 1.84 GB |
| Size ratio | 1.0× | **0.58×** (-42%) |
| Family | gemma3 | qwen2 |
| Quantization | Q4_K_M | Q4_K_M |
| Parameters | 4.3B | 3.1B |

## Indexing Performance

| Run | Model | Baseline wall time | Combined wall time | Combined fallbacks | Tag batch fallbacks |
|-----|-------|-------------------|-------------------|-------------------|---------------------|
| T2333 | gemma3:4b | 432840 ms | 156713 ms | 1 | 13 |
| T1010 | qwen2.5:3b-instruct | 163169 ms | 154908 ms | **0** | 0 |

Notes:
- T2333 gemma3 baseline was unusually slow (432 s) — likely cold model load on first run of the session.
- T1010 baseline (163 s) is consistent with warm model; qwen2.5 combined (155 s) nearly identical.
- **qwen2.5 produced 0 fallbacks** vs gemma3:4b's 1 combined fallback and 13 tag batch fallbacks.
- Baseline tag batch fallbacks = 0 for qwen2.5 vs 13 for gemma3 — qwen2.5 parse reliability is higher.

## Aggregate Retrieval Metrics

| Metric | gemma3:4b baseline | gemma3:4b combined | Δ(gemma3) | qwen2.5 baseline | qwen2.5 combined | Δ(qwen2.5) |
|--------|-------------------|--------------------|-----------|-----------------|-----------------|------------|
| chunkRecall@3 | 87.8% | 87.8% | — | 87.8% | 85.7% | -0.020 |
| chunkRecall@5 | 93.9% | 89.8% | **-0.041** | 89.8% | 89.8% | **—** |
| chunkRecall@10 | 98.0% | 95.9% | -0.020 | 93.9% | 93.9% | **—** |
| windowRecall@10 | 100.0% | 98.0% | -0.020 | 98.0% | 98.0% | — |
| nDCG@10 | 0.760 | 0.751 | -0.009 | 0.751 | 0.740 | -0.011 |
| MRR@10 | 0.728 | 0.718 | -0.010 | 0.724 | 0.693 | -0.031 |
| negativePass | 100.0% | 100.0% | — | 100.0% | 100.0% | — |
| Hard regressions | — | 2 | — | — | **0** | — |
| Soft regressions | — | 6 | — | — | 8 | — |
| Improvements | — | 3 | — | — | 5 | — |
| Combined fallbacks | — | 1 | — | — | **0** | — |

## Key Observations

### Hard regressions

**gemma3:4b combined: 2 hard** (c04, c41 — lost chunkRecall@5).
**qwen2.5:3b combined: 0 hard within this run** — all 8 regressions are soft (rank-order shifts within hit set; chunk still retrieved, just not top-1).

Important caveat: the 0-hard-regression count is within-run only (combined vs its own baseline).
c04 and c41 were **already missed by the qwen2.5 baseline** (both ✗ in baseline), so they never
appear as combined regressions — this is not evidence that qwen2.5 solved those hard cases. It
means those queries are weak/unstable regardless of the LLM model used for tagging. A second
independent run is needed to confirm 0 hard regressions is structurally stable.

### Absolute combined comparison

**gemma3:4b combined vs qwen2.5:3b combined (absolute, not deltas):**

| Metric | gemma3 combined | qwen2.5 combined | Gap |
|--------|----------------|-----------------|-----|
| MRR@10 | **0.718** | 0.693 | -0.025 (qwen2.5 lower) |
| nDCG@10 | **0.751** | 0.740 | -0.011 |
| chunkRecall@5 | 89.8% | 89.8% | **tie** |
| chunkRecall@10 | **95.9%** | 93.9% | -2.0 pp (qwen2.5 lower) |
| windowRecall@10 | **98.0%** | 98.0% | tie |

qwen2.5 combined trails gemma3 combined on MRR (-0.025) and chunkRecall@10 (-2.0 pp). chunkRecall@5
is identical. The MRR gap reflects soft rank shifts (chunks retrieved but not top-1), not structural
recall failures — but it is a real difference, not just baseline variance.

### MRR delta interpretation

qwen2.5 shows MRR Δ=-0.031 vs its own baseline, while gemma3:4b Δ=-0.010. However:
- The qwen2.5 *baseline* in this run had lower MRR (0.724) than the gemma3 reference baseline (0.728)
  — run-to-run variance in the indexer (tag model, ordering, Qdrant state).
- chunkRecall@5 is **identical** for qwen2.5 baseline vs combined (89.8%) — no structural recall loss
  from COMBINED_LLM=1 within this run.
- gemma3 combined *lost* chunkRecall@5 vs its own baseline (-0.041). qwen2.5 did not.

The within-run delta favours qwen2.5, but the absolute combined numbers favour gemma3. Both
signals matter; a second run would clarify which effect is stable.

### Regression pattern differences

| Query | gemma3 combined | qwen2.5 combined | Notes |
|-------|----------------|-----------------|-------|
| c04 | hard ✗ | no regression (c04 already ✗ in qwen2.5 baseline) | weak query, unstable for both |
| c41 | hard ✗ | soft improvement (+0.032) | qwen2.5 slightly better |
| c11, c12 | soft | soft | both regress on exact-token; top-1 relevance drops 3→0 |
| c13 | soft (gemma3) | **improved** (+0.500) | qwen2.5 gets this right |
| c37 | soft (gemma3) | **improved** (+0.500) | qwen2.5 gets this right |
| c43 | no change (gemma3) | soft (-0.500) | qwen2.5 regresses here |
| c33 | no change (gemma3) | soft (-0.667) | qwen2.5 regresses here (large MRR shift, chunk still retrieved) |

The regression sets are different but similar in severity. Neither model dominates the other on
soft regressions — it is LLM variance across different tag/context phrasings.

### Fallback reliability

qwen2.5:3b-instruct produced **0 combined fallbacks and 0 tag batch fallbacks** (baseline also 0).
gemma3:4b produced 1 combined fallback and 13 tag batch fallbacks in the reference run.

Fewer fallbacks = fewer chunks relying on bare-text context only, which is the primary cause of
soft regressions. qwen2.5's higher JSON parse reliability on the current-minimal prompt
(confirmed in policy matrix: 100% usable on all 5 fixtures) translates directly to fewer fallbacks
in production indexing.

## Summary Scorecard

| Criterion | gemma3:4b | qwen2.5:3b-instruct | Winner |
|-----------|-----------|---------------------|--------|
| Model size | 3.18 GB | 1.84 GB | **qwen2.5** (-42%) |
| Combined fallbacks | 1 | 0 | **qwen2.5** |
| Tag batch fallbacks (baseline) | 13 | 0 | **qwen2.5** |
| Hard regressions | 2 | 0 | **qwen2.5** |
| Soft regressions | 6 | 8 | gemma3 (marginal) |
| Improvements | 3 | 5 | **qwen2.5** |
| chunkRecall@5 delta | -0.041 | 0.000 | **qwen2.5** |
| MRR@10 delta | -0.010 | -0.031 | gemma3 (nominal) |
| nDCG@10 delta | -0.009 | -0.011 | gemma3 (≈ tie) |
| negativePass | 100% | 100% | tie |

## Verdict

**qwen2.5:3b-instruct: EXPERIMENTAL candidate; needs second run and absolute-quality confirmation before recommended.**

### Quality: mixed picture

qwen2.5 combined shows **0 hard regressions within this run**, but c04 and c41 were already missed
by the qwen2.5 baseline — those are not solved cases, just absent from the regression count. Absolute
combined quality trails gemma3: MRR@10 0.693 vs 0.718, chunkRecall@10 93.9% vs 95.9%. chunkRecall@5
is tied at 89.8%. A second run is needed to confirm whether 0 hard regressions is a stable property
or a one-run result.

The MRR gap (-0.031 vs -0.010 within-run deltas) reflects soft rank shifts in 8 queries. The
relevant chunks are retrieved; they are not always ranked first.

### Speed: not meaningfully different; advantage is size and reliability

Combined wall time is nearly identical (155 s qwen2.5 vs 157 s gemma3 in the T2333 warm reference).
qwen2.5 baseline was 163 s vs gemma3 T1004 warm-baseline 142 s — qwen2.5 is not observably faster.
The T2333 gemma3 baseline (432 s) was a cold-model outlier and cannot be used for comparison.

Do not claim speed as a qwen2.5 advantage. The real advantages are **model size** (42% smaller,
meaningful for local deployment) and **fallback reliability** (0 combined + 0 tag fallbacks vs
1 + 13 for gemma3), which reduces the frequency of bare-text fallback chunks.

### Size: clear advantage

1.84 GB vs 3.18 GB — 42% smaller. For users who pull models locally, this is a significant
download and RAM difference. On a machine where Ollama fits 4B models comfortably but not 7B+,
qwen2.5:3b leaves more headroom.

### Should it become recommended CONTEXT_MODEL for COMBINED_LLM=1?

**No — EXPERIMENTAL status. Needs second independent run confirming 0 hard regressions, and
absolute combined quality (MRR, chunkRecall@10) must be re-evaluated against gemma3 from that run.**

gemma3:4b shows 2 hard regressions consistently across T2333 and T0804. qwen2.5 showed 0 in T1010,
but c04/c41 were already baseline misses — the comparison is not apples-to-apples. A second run
with a fresh Qdrant stamp will test whether qwen2.5 produces hard regressions on queries that its
baseline *does* retrieve correctly.

**Recommended next step:** Re-run `bench:custom50:combined` with qwen2.5:3b-instruct once more.
If hard regressions remain 0 and absolute combined MRR/chunkRecall@10 are within noise of gemma3,
promote to recommended. If hard regressions appear or absolute quality gap widens, keep experimental.

### Rejected cases (for reference)

From policy matrix: `qwen3:4b` and `qwen3:1.7b` fail the current JSON path (think-tag wrapping).
`phi4-mini` is unstable (20-40% usable rate). qwen2.5:3b-instruct is the only sub-4B model that
passes all policy matrix gates with 100% usable rate.

---

*Generated: 2026-05-18T1010 — qwen2.5 run: bench-c50-baseline/combined-1779098710853*
*Mis-run T1004 (gemma3:4b due to env propagation failure) excluded from analysis.*
