# Combined Identifier Policy — c41 Regression Test

*Generated: 2026-05-26T0009*

## Purpose

Test whether the `identifier-preserving` combined context policy (`BENCH_CONTEXT_POLICY=identifier-preserving`)
recovers the c41 hard regression identified in `2026-05-25T2335-c41-regression-diagnostic.md`.

The prior diagnostic established: combined mode produces a context for `benchmarking.md#2` that
drops numeric/structural details ("4 fixture documents", "21 queries") present in the baseline context.
These details anchor the short chunk's embedding to the 21q-vs-custom50 distinction the query asks about.

## Policy Tested

| Setting | Baseline | Combined |
|---------|----------|----------|
| `BENCH_CONTEXT_POLICY` | `current-minimal` (pinned) | `identifier-preserving` |
| `COMBINED_LLM` | `0` | `1` |
| Model | gemma3:4b | gemma3:4b |

`identifier-preserving` adds these rules to the combined prompt:
- Preserve exact identifiers verbatim: env vars, function names, file paths, CLI flags, error strings, config keys, model names, IDs, **numbers**.
- Do not paraphrase technical terms.
- Help retrieve this exact chunk — write context a user would search for.
- Do not summarize the whole document. Do not invent scope.

## Commands Used

```powershell
$env:BENCH_COMBINED_CONTEXT_POLICY = "identifier-preserving"
$env:QUERY_IDS = "c41"
$env:ONNX_EMBED = "1"
npm run bench:custom50:diag
```

Baseline always pinned to `current-minimal` (`combined-hard-regression-diagnostic.js`).

## Indexing

| Run | Wall time | Combined fallbacks | Tag batch fallbacks |
|-----|-----------|-------------------|---------------------|
| Baseline | 507392 ms | n/a | 5 |
| Combined (identifier-preserving) | 305126 ms | 6 | n/a |

## c41 Rank Result

| chunkId | Baseline rank | Combined rank | Baseline top-5 | Combined top-5 |
|---------|--------------|---------------|----------------|----------------|
| `benchmarking.md#2` (rel=3) | **4** | **8** | ✓ | ✗ |
| `benchmarking.md#3` (rel=2) | 3 | 5 | ✓ | ✓ |

**Regression not recovered.** Same result as `current-minimal` (T2034: baseline rank 4, combined rank 8).

## Context Comparison for `benchmarking.md#2`

| | Context |
|---|---|
| **Baseline (current-minimal)** | "…a test suite using **4 fixture documents and 21 queries** to detect retrieval regressions…" |
| **Combined (identifier-preserving)** | "…a test run used to identify retrieval regressions in the `bench-retrieval` collection…" |

The `identifier-preserving` policy preserved the collection name `bench-retrieval` (a technical
identifier), but still dropped "4 fixture documents" and "21 queries". The numeric/count details
that distinguish this chunk from other benchmarking-adjacent chunks are not identifiers in the
prompt's sense — they are quantities in a descriptive sentence. The prompt instructs the model to
preserve "IDs, numbers" but the model did not treat these counts as preservable numbers.

For reference, `current-minimal` combined context from T2034 dropped the same details:
"…a test run performed before merges to identify retrieval regressions…"

Neither policy produces a context that retains "21 queries" or "4 fixture documents".

## Root Cause Refinement

The failure is not about identifier preservation policy framing. The root cause is deeper:

**The chunk text is 192 chars.** The model is asked for 1-2 sentences of context. For a 3-sentence
chunk that describes a benchmark tier, the model consistently paraphrases the chunk rather than
quoting or closely paraphrasing its specific details. The "stable regression smoke benchmark" label
is preserved verbatim in both policies, but the distinguishing numeric details ("21 queries") are
dropped across all tested policies.

This pattern will likely persist across any prompt policy that asks for a short 1-2 sentence summary.
The model does not have enough output budget to include all salient details of a 3-sentence input chunk.

The structural cause: `benchmarking.md#2` is a 3-sentence chunk where the numeric detail "21 queries"
is the key retrieval anchor for the c41 query, but that detail competes with "stable regression smoke
benchmark" and "v1/v2 schema" for the limited context budget. Different models and runs
will include or drop it stochastically.

## Verdict

**`POLICY_DOES_NOT_RECOVER_C41`**

The `identifier-preserving` policy does not recover c41. Baseline rank 4, combined rank 8 — identical
to the `current-minimal` result. The regression root cause (numeric details dropped from the combined
context for a short chunk) is not addressed by the identifier-preserving framing alone.

## What Was Learned

1. **The regression is not prompt-policy-sensitive at this level of prompt engineering.** Neither
   `current-minimal` nor `identifier-preserving` reliably preserves "21 queries" in the context for
   `benchmarking.md#2`. The model paraphrases rather than quotes short technical content.

2. **`benchmarking.md#2` is a marginal-baseline query.** Even without combined mode, the rel=3 chunk
   sits at rank 4-5. This makes c41 fragile regardless of context policy — any perturbation is enough
   to push it outside top-5.

3. **The c41 hard regression is model-specific.** qwen2.5 did not reproduce it in T1951. This suggests
   the sensitivity is in gemma3:4b's context generation, not in the policy or retrieval infrastructure.

## Recommendations

1. **Keep `identifier-preserving` as benchmark-only.** It did not help c41 and has unknown effects
   on other queries. Do not promote to opt-in without a full custom-50 matrix run.

2. **Accept c41 as a known gemma3 fragility.** The regression is real but narrow (rank 4→8 on a
   baseline-rank-4 query). It does not occur with qwen2.5. Document it as a known model-specific
   limitation of combined mode with gemma3:4b.

3. **Investigate qrel expansion for `benchmarking.md#0`.** Adding rel=1 for the intro chunk does not
   fix chunkRecall@5, but makes nDCG a fairer signal and reduces the "hard regression" classification
   severity for a query whose baseline is already fragile.

4. **Consider a verbatim-quote context policy variant** for short chunks: when chunk text is under
   ~250 chars, include the full text verbatim in the context prefix rather than asking the model to
   summarize. This would guarantee "21 queries" and "4 fixture documents" are present in the embedding
   input. This is a new prompt policy variant not yet implemented or tested.

5. **Do not block combined-mode opt-in on c41.** MRR delta for gemma3 is −0.011, within the tolerance
   band. The hard regression label is threshold-driven (rank 4 vs rank 5). If the matrix aggregate
   remains acceptable, c41 alone should not block promotion.

## Evidence Files

| File | Role |
|------|------|
| `benchmarks/retrieval/custom-50/queries.json` | c41 definition |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | Target fixture |
| `src/indexer/phases/combined.js` | `buildPromptIdentifierPreserving()` definition |
| `src/indexer/index.js:153-155` | Embedding input: context + text only |
| `benchmarks/retrieval/results/2026-05-25T2335-c41-regression-diagnostic.md` | Prior root-cause analysis |
| `benchmarks/retrieval/results/2026-05-25T2034-combined-llm-hard-regressions.md` | current-minimal diag (rank 4→8) |
| `benchmarks/retrieval/results/2026-05-25T2109-combined-llm-hard-regressions.md` | identifier-preserving diag (rank 4→8) |
