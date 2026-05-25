# c41 Hard Regression Diagnostic — custom-50

*Generated: 2026-05-25T2335, corrected: 2026-05-25*

## Query

```
яка різниця між 21-query regression і custom-50 quality benchmark
```

**Type:** conceptual — Ukrainian paraphrase asking for the difference between the two benchmark tiers.

**Note:** `expectedTokens: ["regression"]`

---

## Current Qrels

| chunkId | relevance | Section heading | Text length |
|---------|-----------|-----------------|-------------|
| `benchmarking.md#2` | **3** (exact answer) | `21-query regression benchmark (benchmarks/retrieval/)` | 192 chars |
| `benchmarking.md#3` | 2 (supporting) | `50-query quality benchmark (benchmarks/retrieval/custom-50/)` | 262 chars |

Both are verified correct. Chunk 2 describes the 21q regression tier; chunk 3 describes the
50q quality tier. Together they directly answer the question. The rel=3 assignment on chunk 2
is appropriate — it names the 21q regression benchmark and gives its key properties. Chunk 3 is
correctly rel=2 (supporting context for the other half of the comparison).

---

## Embedding Architecture Note

Tags are stored as Qdrant payload only. The embedding input is `context + "\n\n" + text`
(`src/indexer/index.js:155`). Tags do not enter the dense or sparse vectors and therefore
cannot affect retrieval ranking. Any analysis implicating tags as a retrieval mechanism is wrong.

---

## Observed Behavior Across Runs

### 2026-05-25T1951 quality matrix (gemma3:4b)

| Metric | Baseline | Combined gemma3 | Combined qwen2.5 |
|--------|----------|-----------------|-----------------|
| MRR@10 | 0.200 | 0.167 | 0.200 |
| nDCG@10 | 0.473 | 0.618 | 0.425 |
| chunkRecall@5 | ✓ | ✗ | ✓ |

- gemma3: **hard regression** (bCr5 ✓ → cCr5 ✗). nDCG increases because `benchmarking.md#3`
  (rel=2) rises to rank 2 in both variants — but the rel=3 chunk falls out of top-5.
- qwen2.5: stable (✓ → ✓). Regression is model-specific.

### 2026-05-25T2004 context-only ablation (gemma3:4b)

| Metric | Baseline | ctx+tags | ctx-only |
|--------|----------|----------|----------|
| MRR@10 | 0.200 | 0.167 | 0.167 |
| nDCG@10 | 0.517 | 0.449 | 0.449 |
| chunkRecall@5 | ✓ | ✗ | ✗ |

ctx+tags and ctx-only both show the same hard regression with identical MRR and nDCG deltas.
ctx-only uses `tags: []` (`src/indexer/phases/combined.js:205`), so the tags field is definitively
ruled out — the only remaining difference between baseline and both combined variants is the
**context text** itself.

### 2026-05-25T2034 focused c41 diagnostic (bench:custom50:diag, gemma3:4b)

| chunkId | Baseline rank | Combined rank | In top-5 |
|---------|--------------|---------------|----------|
| `benchmarking.md#2` (rel=3) | **4** | **8** | B: ✓ C: ✗ |
| `benchmarking.md#3` (rel=2) | 2 | 2 | B: ✓ C: ✓ |

**Regression reproduced.** Baseline MRR = 1/4 = 0.250 in this run (prior runs showed rank 5,
giving MRR 0.200 — run-to-run variance at the top-5 boundary). Combined drops from rank 4 to 8.

---

## Root-Cause Analysis

### 1. Structural hardness of c41 baseline

The rel=3 chunk (`benchmarking.md#2`) is:
- **Very short** (192 chars, 3 sentences).
- Ranked 4th or 5th in baseline — at or one position inside the top-5 boundary.
- Semantically outcompeted by `benchmarking.md#22` (Collection Isolation, rank 1),
  `benchmarking.md#3` (rel=2, rank 2), and `multilingual.md#7` (Benchmark Coverage, rank 3).

The Ukrainian query paraphrase has limited token overlap with the raw chunk text. BGE-M3 bridges
the language gap semantically, but the chunk's brevity means its embedding accumulates less
signal than longer benchmark-adjacent chunks. Any perturbation to the context prefix shifts
this already-marginal chunk out of top-5.

### 2. Combined mode: context wording is the failure mechanism

The embedding input is `context + "\n\n" + text` (tags excluded). The context diff for
`benchmarking.md#2` between baseline and combined (from T2034 payload comparison):

| | Context |
|---|---|
| **Baseline** | "…stable regression smoke benchmark, a test run using **4 fixture documents and 21 queries** to identify retrieval regressions…" |
| **Combined** | "…stable regression smoke benchmark, a test run performed before merges to identify retrieval regressions…" |

The combined context drops two specific details: "4 fixture documents" and "21 queries". Both
are concrete descriptors from the chunk text that anchor the semantic embedding of this short
chunk to the "21-query regression" concept. Without them, the combined context is a generic
benchmark description that overlaps more with other benchmark-related chunks than with the
specific 21q-vs-custom50 distinction the query asks about.

This context wording difference is what shifts `benchmarking.md#2` from rank 4 to rank 8.

### 3. ctx-only ablation confirms context as the mechanism

The T2004 ablation uses `BENCH_COMBINED_CONTEXT_ONLY=1`, which requests `{"context":"..."}` only
from the combined LLM — no tags field in the prompt at all (`combined.js:78-89`). Tags are stored
as `[]`. Yet c41 still regresses identically to ctx+tags (same MRR 0.167, same nDCG 0.449, same
chunkRecall@5 ✗).

This means: removing the tags request from the prompt does not recover the regression. The
combined LLM generates weaker context for this chunk even when freed from the dual-output
constraint. The regression is in context quality, not in tag-field contamination of the context.

The combined prompt wording (`buildPromptCurrentMinimal`) differs from the separate context
prompt (`addContext`) — different instruction framing is likely causing the model to produce a
higher-level summary that loses specific numeric/structural details from the short chunk text.

### 4. Not a qrel problem

The qrels are correct:
- `benchmarking.md#2` (rel=3): directly names the 21q regression benchmark tier.
- `benchmarking.md#3` (rel=2): directly describes the custom-50 quality tier.
- No missing relevant chunks. Chunks 0 and 1 are intro and empty-section placeholder; chunk 0
  mentions "two benchmark tiers" but does not describe either, so rel=1 would be marginal.

No qrel changes are needed.

### 5. Not stochastic variance

Regression reproduced in four independent runs across two experiments (T1951 gemma3, T2004
ctx+tags, T2004 ctx-only, T2034 diag). qwen2.5 does not reproduce it — consistent with
model-specific context generation behavior rather than retrieval-layer noise.

---

## Verdict

**Root cause: combined-mode context quality degradation for short chunks.**

The combined LLM prompt produces a context for `benchmarking.md#2` that drops specific
numeric details ("4 fixture docs", "21 queries") present in the baseline context. These details
anchor the embedding of this 192-char chunk to the 21q regression concept. Without them,
the chunk's combined embedding is closer to generic benchmarking content, displacing it from
rank 4 to rank 8 — out of top-5.

Tags play no role in retrieval scoring (they are payload only, not embedded). The ctx-only
ablation confirms context is the sole mechanism.

The regression is **real, reproducible, and model-specific** (gemma3:4b only). It is **not**
a qrel problem and **not** stochastic variance.

---

## Contributing Factor: Marginal Baseline Position

c41 baseline MRR is 0.200 (rank 5 in aggregate runs; rank 4 in the T2034 diag run). A single
rank shift is enough to cross the chunkRecall@5 boundary. This makes c41 particularly sensitive
to context wording changes even when the semantic direction is broadly correct.

---

## Recommended Next Actions

1. **No qrel changes.** Current qrels accurately reflect ground-truth relevance.

2. **Context prompt improvement (primary fix).** The combined prompt (`buildPromptCurrentMinimal`
   in `src/indexer/phases/combined.js`) should be updated to preserve specific details from the
   chunk text rather than producing high-level summaries. The `identifier-preserving` policy
   variant already addresses this for identifiers — consider extending it to numeric and structural
   details. Alternatively, benchmark the `identifier-preserving` policy on custom-50 and check
   whether it recovers c41 without introducing new regressions.

3. **Consider rel=1 for `benchmarking.md#0`.** The intro chunk mentions "two benchmark tiers"
   and could receive rel=1 to provide partial nDCG credit when the rel=3 chunk narrowly misses
   top-5. Proposed change (do not apply without validation):
   ```json
   { "chunkId": "benchmarking.md#0", "relevance": 1 }
   ```
   This does not resolve the hard regression (chunkRecall@5 requires rel≥3) but makes nDCG a
   more faithful signal for this query.

4. **Run bench:custom50 with `identifier-preserving` context policy** and compare c41 behavior
   against current `current-minimal`. If c41 recovers, evaluate aggregate impact across all 50
   queries before promoting.

---

## Evidence Files

| File | Role |
|------|------|
| `benchmarks/retrieval/custom-50/queries.json` | c41 definition, qrels |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | Target fixture |
| `src/indexer/index.js:153-155` | Embedding input construction (context + text, no tags) |
| `src/indexer/phases/combined.js:71-89` | ctx-only mode: tags=[], same context prompt |
| `benchmarks/retrieval/results/2026-05-25T1951-combined-llm-quality-matrix.md` | First observation (gemma3 hard regression) |
| `benchmarks/retrieval/results/2026-05-25T2004-combined-context-only-ablation.md` | Ablation isolating context as the failure mechanism |
| `benchmarks/retrieval/results/2026-05-25T2034-combined-llm-hard-regressions.md` | Focused diag: top-10 tables, payload comparison, rank confirmed |
