# Combined LLM Prompt Alignment Verification — 2026-05-22 (run 2)

## Purpose

Verify whether the prompt alignment applied to `buildPromptCurrentMinimal`
("Given a text chunk from a file" + "Be concise.") changed retrieval quality
vs the pre-alignment baseline.

Two benchmarks compared before/after:

1. **Quality matrix** (`bench:custom50:combined-matrix`) — gemma3:4b and qwen2.5:3b-instruct vs shared baseline
2. **Context-only ablation** (`bench:custom50:context-only-ablation`) — gemma3:4b: baseline / ctx+tags / ctx-only

Pre-alignment reports: `2026-05-22T1012-combined-llm-quality-matrix.md`, `2026-05-22T1036-combined-context-only-ablation.md`
Post-alignment reports (this run): `2026-05-22T1143-combined-llm-quality-matrix.md`, `2026-05-22T1152-combined-context-only-ablation.md`

Note: a prior post-alignment run (T1117/T1126) also exists. Results across the three post-alignment runs show meaningful variance, indicating LLM stochasticity at this scale. Conclusions below reflect the average trend across all post-alignment runs.

---

## Quality Matrix: Before vs After Prompt Alignment

| Model | PRE MRR Δ | PRE hard regressions | POST MRR Δ (T1117) | POST hard (T1117) | POST MRR Δ (T1143) | POST hard (T1143) |
|---|---|---|---|---|---|---|
| gemma3:4b | −0.044 | 1 (c41) | +0.003 | 3 (c36,c41,c48) | −0.050 | 1 (c41) |
| qwen2.5:3b-instruct | −0.009 | 1 (c41) | −0.034 | 2 (c33,c41) | −0.025 | 2 (c36,c37) |

Note: c48 fails in the T1143 baseline too, so it is not counted as a hard regression there.

| Model | PRE chunkRecall@5 Δ | POST chunkRecall@5 Δ (T1143) | PRE nDCG@10 Δ | POST nDCG@10 Δ (T1143) |
|---|---|---|---|---|
| gemma3:4b | — | −0.020 | −0.033 | −0.034 |
| qwen2.5:3b-instruct | −0.020 | −0.041 | −0.013 | −0.032 |

### Quality matrix verdict

**DEFER_HARD_REGRESSIONS** — no improvement from prompt alignment.

- **gemma3:4b**: MRR delta oscillates between −0.050 and +0.003 across post-alignment runs (high variance). nDCG@10 consistently ~−0.034. Hard regressions present in all runs.
- **qwen2.5:3b-instruct**: MRR consistently negative (−0.025 to −0.034). Hard regressions in all post-alignment runs; different queries regress each run (c33/c41 vs c36/c37), suggesting LLM stochasticity rather than a fixed structural regression.
- **Baseline MRR** itself varies run-to-run (0.741–0.750) due to LLM-generated context — this is normal but limits precision of Δ comparisons.

---

## Context-Only Ablation: Before vs After Prompt Alignment

| Variant | PRE baseline MRR | PRE MRR Δ | PRE hard | POST baseline MRR (T1152) | POST MRR Δ (T1152) | POST hard (T1152) |
|---|---|---|---|---|---|---|
| ctx+tags | 0.723 | +0.010 | 1 | 0.731 | +0.005 | 2 |
| ctx-only | 0.723 | −0.027 | 0 | 0.731 | −0.051 | 0 |

| Variant | PRE ctx-only vs ctx+tags Δ | POST ctx-only vs ctx+tags Δ (T1126) | POST ctx-only vs ctx+tags Δ (T1152) |
|---|---|---|---|
| ctx-only vs ctx+tags | −0.037 | +0.016 | −0.056 |

### Ablation hypothesis across all runs

| Run | ctx-only vs ctx+tags Δ MRR | Verdict |
|---|---|---|
| Pre-alignment (T1036) | −0.037 | REJECTED |
| Post-alignment run 1 (T1126) | +0.016 | SUPPORTED |
| Post-alignment run 2 (T1152) | −0.056 | REJECTED |

The hypothesis verdict is **unstable across runs** — it flipped between T1126 and T1152. The ±0.05 swing between runs is consistent with LLM stochasticity in context generation rather than a reliable signal. The hypothesis cannot be confirmed or rejected with this level of variance.

### Ablation verdict

**INCONCLUSIVE** — high run-to-run variance prevents a stable conclusion about whether the tags field in the combined prompt degrades context quality. Both ctx+tags and ctx-only are within noise of each other and of baseline.

---

## Persistent Hard Regressions Across All Runs

| Query | Type | Present in how many post-alignment runs |
|---|---|---|
| c41 | conceptual | matrix: 2/2 runs; ablation ctx+tags: 1/2 runs |
| c36 | source-navigation | matrix: 1/2 runs (qwen T1143); ablation: mixed |
| c48 | cross-lingual-ua-en | matrix: gemma T1117 hard only; T1143 is not hard because baseline also missed |
| c37 | source-navigation | matrix: qwen T1143 only |
| c33 | conceptual | matrix: qwen T1117 only |

**c41 is the most persistent regression** — appears in both matrix runs for at least one model, and in one ablation ctx+tags run. The others appear in only one run and are likely stochastic.

---

## Overall Verdict

**DEFER_HARD_REGRESSIONS**

Prompt alignment ("Given a text chunk from a file" + "Be concise.") has not produced a measurable, stable improvement in combined LLM retrieval quality:

- Both models continue to regress vs baseline across all post-alignment runs.
- MRR and nDCG deltas are negative or near-zero for both models.
- Hard regressions appear in every run, though the specific queries vary (stochastic).
- The ctx-only hypothesis is unstable — not a reliable optimization direction at this model scale.
- c41 remains the only query with persistent hard regression signal worth investigating independently.

No opt-in is recommended. Further avenues to investigate:
1. **c41 root cause** — persistent across conditions; likely a chunk quality or qrel issue rather than prompt-dependent.
2. **Larger model** — 3-4B models show high stochasticity; a 7B+ model may produce more stable combined output.
3. **Prompt structure** — current format asks for JSON with two fields in one shot; structured outputs or few-shot examples might reduce variance.

---

## Notes

- All runs used `DENSE_PROVIDER=bge-m3-onnx`, `SPARSE_PROVIDER=bge-m3-onnx`, hybrid search.
- Benchmarks run sequentially to avoid Ollama overload.
- `BENCH_COMBINED_CONTEXT_ONLY=1` is benchmark-only. Production path unchanged.
- Baseline MRR variance (0.723–0.750 across runs) is attributable to LLM-generated context fields, not embedding or search changes.

*Generated: 2026-05-22*
