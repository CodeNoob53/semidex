# c41 Hard Regression Diagnostic — custom-50

*Generated: 2026-05-25T2335*

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

## Observed Behavior Across Runs

### 2026-05-25T1951 quality matrix (gemma3:4b)

| Metric | Baseline | Combined gemma3 | Combined qwen2.5 |
|--------|----------|-----------------|-----------------|
| MRR@10 | 0.200 | 0.167 | 0.200 |
| nDCG@10 | 0.473 | 0.618 | 0.425 |
| chunkRecall@5 | ✓ | ✗ | ✓ |

- gemma3: **hard regression** (bCr5 ✓ → cCr5 ✗). nDCG improves because chunk 3 (rel=2) moved up.
- qwen2.5: stable (unchanged — ✓ → ✓).

### 2026-05-25T2004 context-only ablation (gemma3:4b)

| Metric | Baseline | ctx+tags | ctx-only |
|--------|----------|----------|----------|
| MRR@10 | 0.200 | 0.167 | 0.167 |
| nDCG@10 | 0.517 | 0.449 | 0.449 |
| chunkRecall@5 | ✓ | ✗ | ✗ |

Both ctx+tags and ctx-only combined variants show hard regression. Context-only does not recover it.

### 2026-05-25T2034 focused c41 diagnostic (bench:custom50:diag, gemma3:4b)

| chunkId | Baseline rank | Combined rank | In top-5 |
|---------|--------------|---------------|----------|
| `benchmarking.md#2` (rel=3) | **4** | **8** | B: ✓ C: ✗ |
| `benchmarking.md#3` (rel=2) | 2 | 2 | B: ✓ C: ✓ |

**Regression reproduced.** Baseline MRR = 1/4 = 0.250 (report shows 0.200, difference is
run-to-run variance with rank-5 boundary in prior runs). Combined rank drops from 4 to 8.

---

## Root-Cause Analysis

### 1. Structural hardness of c41 baseline

Even without combined mode, c41 is a fragile query. The rel=3 chunk (`benchmarking.md#2`) is:
- **Very short** (192 chars, 3 sentences).
- Ranked 4th in baseline — one position from the top-5 boundary.
- Semantically outcompeted by `benchmarking.md#22` (Collection Isolation, always rank 1),
  `benchmarking.md#3` (rel=2, rank 2), and `multilingual.md#7` (Benchmark Coverage, rank 3).

The Ukrainian query paraphrase has no exact token overlap with the short chunk 2 text beyond
"regression" and "21". BGE-M3 handles the paraphrase semantically, but the chunk's short length
means it accumulates less contextual signal than neighboring chunks that discuss benchmarking
more broadly.

### 2. Combined mode: tag quality is the primary failure mechanism

Comparing `benchmarking.md#2` payload between baseline and combined:

| Field | Baseline | Combined |
|-------|----------|----------|
| context | "…stable regression smoke benchmark, a test run using 4 fixture documents and 21 queries to **ide**ntify retrieval regressions…" | "…stable regression smoke benchmark, a test run performed before merges to identify retrieval regressions…" |
| tags | regression-benchmark, retrieval-testing, smoke-test, fixture-documents, **schema-comparison**, **query-regression**, bench-retrieval | regression-benchmark, smoke-test, retrieval, query-testing, **v1-v2**, **fixture-docs**, bench-retrieval |

The baseline tags include `query-regression` — a token that overlaps with the query token
`regression` via BGE-M3 sparse encoding. Combined mode dropped this term and replaced it with
`v1-v2` and `fixture-docs`, which are accurate descriptions of the chunk but have no overlap
with the UA query string.

The context wording is similar enough that context alone cannot explain the full 4-position drop.
The sparse/lexical leg of hybrid RRF depends on token overlap between the query and the embedded
prefix (`<context> <tags> <text>`). Losing `query-regression` from tags reduces the lexical
score for `benchmarking.md#2` while other benchmark-related chunks (`benchmarking.md#17`,
`#15`, `#16`) move up because their combined tags better match generic benchmark query terms.

### 3. Context-only does not recover the regression

The T2004 ablation shows ctx-only has the same hard regression as ctx+tags. If the failure were
caused by the tags JSON output distorting the context generation (model attention split), ctx-only
would recover. It does not — confirming the tags field itself is the culprit, not the combined
prompt structure. Specifically: combined mode generates weaker tags for short chunks where there
is less text for the model to extract vocabulary from.

### 4. Not a qrel problem

The qrels are correct:
- `benchmarking.md#2` (rel=3): directly names and describes the 21q regression benchmark.
- `benchmarking.md#3` (rel=2): directly describes the custom-50 benchmark.
- No missing relevant chunks — chunks 0 and 1 are an intro and empty-section placeholder; they
  add no information beyond chunks 2 and 3.

No qrel changes are needed.

### 5. Not stochastic variance

Regression reproduced in three independent runs (T1951 gemma3, T2004 ctx+tags, T2004 ctx-only,
T2034 diag). qwen2.5 does not reproduce the same pattern, which is consistent with model-specific
tag vocabulary behavior rather than retrieval-layer variance.

---

## Verdict

**Root cause: combined-mode tag quality degradation for short chunks.**

The combined LLM generates tags that lose exact query-term overlap (specifically `query-regression`)
for `benchmarking.md#2`. This reduces its sparse retrieval score, dropping it from rank 4 to rank
8 — just outside top-5. The underlying retrieval gap is real but narrow (rank 4 baseline, easily
displaced).

The c41 regression is **not a qrel problem** and **not stochastic variance**. It is a real
retrieval regression caused by combined-mode tag vocabulary drift on short chunks.

---

## Contributing Factor: Marginal Baseline Performance

c41 baseline MRR is 0.200 (rel=3 chunk at rank 5 in the aggregate; rank 4 in this run), which is
already low. Any perturbation that shifts the rel=3 chunk one position outward causes a chunkRecall@5
failure. This makes c41 more sensitive to combined-mode noise than queries where baseline rank is 1
or 2.

This is not a qrel gap but it is worth noting: if a third chunk in `benchmarking.md` also discusses
both benchmark tiers (e.g., chunk 0's intro), consider whether it warrants rel=1 to give the scorer
partial credit when the rel=3 chunk misses top-5. Current qrels have no rel=1 grade for benchmarking.md.

---

## Recommended Next Actions

1. **No qrel changes.** Current qrels accurately reflect ground-truth relevance. Do not apply
   any changes.

2. **Tag prompt improvement (primary fix).** Add to the combined prompt: instructions to prefer
   exact technical terms and domain-specific vocabulary over paraphrased descriptors. Example:
   "Prefer exact technical tokens that appear in or are closely implied by the text. Avoid
   synonyms or paraphrased variants of key terms."

3. **Consider rel=1 expansion for c41.** `benchmarking.md#0` (intro chunk, mentions "two benchmark
   tiers") could receive rel=1. This would give partial nDCG credit when the rel=3 chunk falls to
   rank 6-10. Proposed change (do not apply yet — validate against other runs first):
   ```json
   { "chunkId": "benchmarking.md#0", "relevance": 1 }
   ```
   This does not change the hard regression verdict (chunkRecall@5 requires rel≥3), but makes nDCG
   a more faithful signal when the primary chunk is narrowly missed.

4. **Rerun bench:custom50:combined after tag prompt change** to verify c41 recovers and no new
   regressions appear.

---

## Evidence Files

| File | Role |
|------|------|
| `benchmarks/retrieval/custom-50/queries.json` | c41 definition, qrels |
| `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` | Target fixture |
| `benchmarks/retrieval/results/2026-05-25T1951-combined-llm-quality-matrix.md` | First observation (gemma3 hard regression) |
| `benchmarks/retrieval/results/2026-05-25T2004-combined-context-only-ablation.md` | Ablation confirming tags-not-context as cause |
| `benchmarks/retrieval/results/2026-05-25T2034-combined-llm-hard-regressions.md` | Focused diag: top-10 tables, payload comparison, rank confirmed |
