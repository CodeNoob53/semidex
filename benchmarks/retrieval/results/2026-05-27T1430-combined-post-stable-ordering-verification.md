# Combined Mode — Post-Stable-Ordering Verification — custom-50

*Generated: 2026-05-27*

## Purpose

Verify that combined-mode regression verdicts from `2026-05-27T0000-combined-post-qrel-fix-verification.md`
and `2026-05-27T0802-combined-llm-quality-matrix.md` were not artefacts of
search-ordering noise. The stable ordering fix (`2026-05-27T1200-custom50-stable-ordering.md`)
was applied before this run, eliminating RRF tie-break variance from MRR/nDCG.

## Command

```powershell
$env:ONNX_EMBED = "1"
$env:BENCH_PROVIDER = "onnx"
npm run bench:custom50:combined-matrix
```

Raw matrix output: `benchmarks/retrieval/results/2026-05-27T0906-combined-llm-quality-matrix.md`

## Environment

| Item | Value |
|------|-------|
| Embedding provider | bge-m3-onnx (ONNX_EMBED=1) |
| Search mode | hybrid (RRF) |
| Queries | 50 (v3 schema, graded chunk-level qrels) |
| Combined context policy | `current-minimal` (baseline pinned, combined also `current-minimal`) |
| Stable ordering | applied (sort-results.js — score desc, source_file asc, chunk_index asc, id asc) |
| Points per collection | 96 ✓ |
| Combined fallbacks | 0 (gemma), 0 (qwen) |

---

## Aggregate Metrics

| Metric | baseline | gemma3:4b (Δ) | qwen2.5:3b-instruct (Δ) |
|--------|----------|---------------|------------------------|
| chunkRecall@3 | 91.8% | 91.8% (—) | 87.8% (−4.1pp) |
| chunkRecall@5 | 95.9% | 93.9% (−2.0pp) | 93.9% (−2.0pp) |
| chunkRecall@10 | 95.9% | 95.9% (—) | 95.9% (—) |
| windowRecall@5 | 98.0% | 98.0% (—) | 95.9% (−2.1pp) |
| windowRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| supportRecall@10 | 98.0% | 98.0% (—) | 98.0% (—) |
| nDCG@10 | 0.778 | 0.770 (−0.007) | 0.763 (−0.014) |
| MRR@10 | 0.760 | 0.718 (−0.042) | 0.752 (−0.008) |
| negativePass | 100.0% | 100.0% (—) | 100.0% (—) |

*MRR/nDCG noise floor with stable ordering: ±0.000 same-index / ±0.030 across
reindexes. This run used a fresh reindex; MRR/nDCG deltas are therefore
subject to reindex variance, not search-ordering noise. Hard regression count
(binary chunkRecall@5) is the primary classification signal.*

---

## Hard Regressions

### gemma3:4b — 1 hard regression

| Query | type | bCr5 | cCr5 | ΔMRR | note |
|-------|------|------|------|------|------|
| c41 | conceptual | ✓ | ✗ | −0.100 | context identifier loss, rank-5 cliff (see T0430 diagnostic) |

### qwen2.5:3b-instruct — 1 hard regression

| Query | type | bCr5 | cCr5 | ΔMRR | note |
|-------|------|------|------|------|------|
| c35 | source-navigation | ✓ | ✗ | −0.857 | source-navigation class weakness |

---

## c41 Status

| Variant | cr@5 | MRR@10 | note |
|---------|------|--------|------|
| baseline | ✓ | 0.200 | rank 5 |
| gemma3:4b combined | ✗ | 0.100 | hard regression — consistent with T0000 and T0802 |
| qwen2.5:3b-instruct combined | ✓ | 0.250 | soft positive — MRR improvement vs baseline |

c41 under gemma3:4b is a **confirmed, stable hard regression** — present in T0000 (matrix),
T0802 (identifier-preserving run baseline), T0430 (isolated diagnostic), and this run.
Not search-ordering noise.

c41 under qwen is ✓ cr@5 in this run (consistent with T2055 matrix; the T0734 isolated
diagnostic showed ✗ due to RRF search-ordering noise at the rank-5 cliff — that noise
source is now eliminated by stable ordering).

---

## Comparison vs Prior Reports

### Hard regression counts

| Model | T0000 (post-qrel-fix) | T0802 (identifier-preserving baseline) | **This run (post-stable-ordering)** |
|-------|-----------------------|----------------------------------------|-------------------------------------|
| gemma3:4b | 2 (c35, c41) | 2 (c35, c41) | **1 (c41)** |
| qwen2.5:3b-instruct | 1 (c36) | 1 (c36) | **1 (c35)** |

Source-navigation remains a borderline cliff class. In this run gemma has no hard
source-navigation regression (c35 ✓, c36 ✓, c37 ✓); qwen has one (c35 ✗). In T0000
gemma had two (c35, c41) and qwen had one (c36). The specific query that tips over
the cr@5 boundary varies by reindex — the relevant chunks sit at rank 5 with a score
margin of ~0.001, making the hard/soft classification reindex-sensitive. The consistent
signal across runs is that **source-navigation is a cliff-edge class weakness**, not
that any particular query is reliably hard.

### Were prior regression verdicts noise?

| Regression | T0000 verdict | Post-stable-ordering | Was it noise? |
|------------|--------------|----------------------|---------------|
| gemma c41 | hard ✗ | hard ✗ | **No — confirmed real** |
| gemma c35 | hard ✗ | soft ✓ (this reindex) | Borderline cliff — real class weakness, query-level identity is reindex-sensitive |
| qwen c36 | hard ✗ | soft ✓ (this reindex) | Same: borderline cliff |
| qwen c35 | soft ✓ | hard ✗ (this reindex) | Same cliff, different reindex outcome |

**Conclusion**: the verdicts from prior reports were not primarily search-ordering noise.
The exact hard regression count varies by reindex, but every run still has at least
one hard regression or class weakness per model, so the DEFER decisions in T0000 and
ADR 0004 remain unchanged.

### MRR/nDCG comparison

| Model | T0000 baseline MRR | T0000 combined MRR | This run baseline MRR | This run combined MRR |
|-------|-------------------|--------------------|----------------------|-----------------------|
| gemma3:4b | 0.772 | 0.756 (Δ −0.016) | 0.760 | 0.718 (Δ −0.042) |
| qwen2.5:3b-instruct | 0.772 | 0.782 (Δ +0.010) | 0.760 | 0.752 (Δ −0.008) |

MRR variation across runs is within the ±0.030 reindex noise floor. Both runs
show gemma combined MRR below baseline and qwen combined MRR within noise of baseline.
The pattern is consistent; no MRR finding reverses.

---

## Verdict

**COMBINED_LLM remains opt-in only. No change to decision.**

Prior regression verdicts were real, not search-ordering noise:

- **c41 (gemma3:4b combined)** — confirmed hard regression across 4 independent
  runs (T0000 matrix, T0430 isolated diagnostic, T0802 identifier-preserving
  baseline, this run). Root cause: context identifier loss in combined embedding
  input (see `2026-05-27T0430-c41-combined-regression-diagnostic.md`). Not noise.

- **Source-navigation class weakness** — confirmed as a real cliff-edge class
  weakness. In this run only qwen has a hard source-navigation regression (c35);
  gemma's source-navigation queries all passed. The identity of the hard query
  shifts per reindex due to ~0.001 score margins, but the class is consistently
  near the cr@5 boundary across all combined-mode runs.

- **Stable ordering eliminated MRR/nDCG search-ordering noise.** The remaining
  MRR/nDCG variance across runs is reindex variance (different LLM context
  → different embedding → different scores), which cannot be eliminated at the
  benchmark layer.

**`current-minimal` remains the correct default combined context policy.**
The identifier-preserving policy test (T0900) already showed it is model-specific
and harmful for qwen; that conclusion stands.

---

## ADR / README Update Required?

**No.** The verdict is unchanged. ADR 0004 (2026-05-27 post-qrel-fix update
section) and `benchmarks/retrieval/results/README.md` already reflect the correct
state. No edits needed.

---

## Raw Evidence

- `benchmarks/retrieval/results/2026-05-27T0906-combined-llm-quality-matrix.md` — raw matrix for this run
- `benchmarks/retrieval/results/2026-05-27T1200-custom50-stable-ordering.md` — stable ordering fix record
- `benchmarks/retrieval/results/2026-05-27T0000-combined-post-qrel-fix-verification.md` — prior canonical baseline
- `benchmarks/retrieval/results/2026-05-27T0430-c41-combined-regression-diagnostic.md` — c41 root cause
