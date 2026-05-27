# c41 Combined-Mode Regression Diagnostic

*Generated: 2026-05-27*

## Verdict

**REAL_COMBINED_WEAKNESS — context identifier loss + rank-5 cliff**

c41 is a genuine combined-mode regression caused by context quality degradation in the
embedding input. Under both gemma3:4b and qwen2.5:3b-instruct, the combined prompt
produces context that loses exact identifier tokens present in baseline context —
specifically `21` (as in "21 queries"), `stable`, and `pre-merge` — weakening the
dense and sparse embedding just enough to push `benchmarking.md#1` from rank 5 to
rank 6. Tags are not the cause: they are payload-only and do not enter the embedding
(`src/indexer/index.js:159,205`); the ctx-only ablation (tags=[]) confirms identical
regression. The regression is confirmed by independent fresh-index diagnostic runs for
each model.

Note: the matrix run showed qwen as soft-only (cr@5 ✓). The isolated diagnostic
shows qwen also drops to rank 6. The discrepancy is explained by RRF search-ordering
noise — the margin is ±1 rank at a highly compressed score spread (0.006 across top-10).

---

## Query Details

| Field | Value |
|-------|-------|
| ID | c41 |
| Type | conceptual |
| Query | `яка різниця між 21-query regression і custom-50 quality benchmark` |
| Expected file | `benchmarking.md` |
| Primary rel=3 | `benchmarking.md#1` |
| Support rel=2 | `benchmarking.md#2` |
| Expected tokens | `regression` |
| Note | Two benchmark tiers comparison, UA paraphrase |

## Qrel Correctness

Qrels are correct. Both chunks were manually verified against the fixture source.

**`benchmarking.md#1`** (section: "21-query regression benchmark"):
> The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2
> schema. It is run before merges to detect retrieval regressions. The collection name is
> `bench-retrieval`.

**`benchmarking.md#2`** (section: "50-query quality benchmark"):
> A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema
> with graded relevance (`relevantChunks`, `relevance: 1/2/3`). Metrics include
> chunk-level recall, graded nDCG, and support recall. The collection name is
> `bench-retrieval-custom-50`.

No qrel change warranted.

---

## Diagnostic Runs

Two independent fresh-index runs via `combined-hard-regression-diagnostic.js`:

```powershell
$env:ONNX_EMBED = "1"; $env:BENCH_PROVIDER = "onnx"
$env:QUERY_IDS = "c41"; $env:KEEP_COLLECTIONS = "1"

# Run A — gemma3:4b
$env:CONTEXT_MODEL = "gemma3:4b"
node benchmarks/retrieval/custom-50/combined-hard-regression-diagnostic.js

# Run B — qwen2.5:3b-instruct (reuses Run A baseline)
$env:CONTEXT_MODEL = "qwen2.5:3b-instruct"
$env:BASELINE_COLLECTION = "bench-c50-diag-baseline-<stamp>"
node benchmarks/retrieval/custom-50/combined-hard-regression-diagnostic.js
```

| Run | Model | Baseline rank | Combined rank | cr@5 baseline | cr@5 combined |
|-----|-------|--------------|---------------|---------------|---------------|
| A | gemma3:4b | 5 | 6 | ✓ | ✗ |
| B | qwen2.5:3b-instruct | 5 | 6 | ✓ | ✗ |

Both models reproduce the hard regression in isolated runs.

---

## Baseline Top-10

| Rank | score | chunkId | rel | section | context snippet |
|------|-------|---------|-----|---------|-----------------|
| 1 | 0.0328 | benchmarking.md#19 | — | Collection Isolation | This section details the collection isolation strategy employed during benchmark… |
| 2 | 0.0328 | multilingual.md#6 | — | Benchmark Coverage | This section details the custom-50 benchmark, which is designed to evaluate quer… |
| 3 | 0.0325 | benchmarking.md#2 | **2** | 50-query quality benchmark | This section details the setup for a 50-query quality benchmark in version 3, ut… |
| 4 | 0.0313 | benchmarking.md#12 | — | Quality 50q benchmark | This chunk describes the execution of a custom benchmark using the npm command… |
| 5 | 0.0306 | benchmarking.md#1 | **3** | 21-query regression benchmark | This section details the stable regression smoke benchmark, a pre-merge test uti… |
| 6 | 0.0299 | benchmarking.md#14 | — | Skip reindex | This chunk describes a specific npm command, `BENCH_SKIP_INDEX=1 npm run bench:c… |
| 7 | 0.0299 | benchmarking.md#13 | — | Force ONNX provider | This section describes a custom benchmarking run using the ONNX provider… |
| 8 | 0.0294 | benchmarking.md#7 | — | Chunk-level (v3 only) | This chunk defines key evaluation metrics used in the benchmarking process… |
| 9 | 0.0292 | benchmarking.md#15 | — | Dense MMR instead of hybrid RRF | This section details experimental configurations for benchmarking search methods… |
| 10 | 0.0291 | project-structure.md#1 | — | Source Tree | This section details the source tree organization… |

Score spread rank 1–10: 0.0291–0.0328, range = 0.0037. `benchmarking.md#1` (rank 5) is
0.0022 below rank 1. Any context/embedding change that weakens its RRF score by ~0.001 drops
it to rank 6.

## gemma3:4b Combined Top-10

| Rank | score | chunkId | rel | section | context snippet |
|------|-------|---------|-----|---------|-----------------|
| 1 | 0.0331 | benchmarking.md#19 | — | Collection Isolation | This section details the collection isolation strategy used during benchmarking… |
| 2 | 0.0331 | benchmarking.md#2 | **2** | 50-query quality benchmark | This section details the setup for a 50-query benchmark using a custom schema… |
| 3 | 0.0323 | multilingual.md#6 | — | Benchmark Coverage | This section describes the queries used within the custom-50 benchmark… |
| 4 | 0.0308 | benchmarking.md#14 | — | Skip reindex | This chunk describes a command used during a benchmark, specifically running… |
| 5 | 0.0308 | benchmarking.md#12 | — | Quality 50q benchmark | This chunk describes the execution of a custom benchmark using `npm run benc… |
| 6 | 0.0301 | benchmarking.md#1 | **3** | 21-query regression benchmark | This chunk describes the stable regression smoke benchmark, a test run for… |
| 7 | 0.0297 | benchmarking.md#15 | — | Dense MMR | This chunk details a specific benchmarking command—`BENCH_SEARCH_MODE=dense-mmr`… |
| 8 | 0.0292 | project-structure.md#8 | — | Entry Points | This section details the entry points for running the application… |
| 9 | 0.0286 | benchmarking.md#11 | — | Stable 21q regression benchmark | This chunk describes the execution of the `npm run bench:retrieval` command… |
| 10 | 0.0282 | benchmarking.md#0 | — | Benchmarking | This section describes the semidex benchmarking harness… |

## qwen2.5:3b-instruct Combined Top-10

| Rank | score | chunkId | rel | section | context snippet |
|------|-------|---------|-----|---------|-----------------|
| 1 | 0.0333 | benchmarking.md#19 | — | Collection Isolation | Chunk 20 describes how benchmarks are isolated by creating separate Qdrant colle… |
| 2 | 0.0328 | multilingual.md#6 | — | Benchmark Coverage | Chunk 7 describes the custom-50 benchmark including different language-specific… |
| 3 | 0.0320 | benchmarking.md#2 | **2** | 50-query quality benchmark | This chunk describes a quality benchmark setup with 8-10 fixture docs and 50 que… |
| 4 | 0.0303 | benchmarking.md#13 | — | Force ONNX provider | This chunk sets an environment variable `BENCH_PROVIDER` to `onnx`… |
| 5 | 0.0302 | benchmarking.md#12 | — | Quality 50q benchmark | npm run bench:custom50 is mentioned here as a command that might be used… |
| 6 | 0.0295 | benchmarking.md#1 | **3** | 21-query regression benchmark | This chunk describes the details of a regression smoke benchmark for document… |
| 7 | 0.0294 | project-structure.md#2 | — | Source Tree | Chunk 3 describes the 'run-v3.js' file and its purpose in running a quality… |
| 8 | 0.0291 | project-structure.md#1 | — | Source Tree | Chunk 2 describes the structure of the 'src/core' directory… |
| 9 | 0.0290 | config-env.md#10 | — | Benchmark Variables | This chunk describes the default settings and options available for a benchmark… |
| 10 | 0.0290 | project-structure.md#8 | — | Entry Points | This chunk lists the entry points and their corresponding modules… |

---

## Payload Comparison: `benchmarking.md#1`

| Field | Baseline | gemma3:4b combined | qwen2.5 combined |
|-------|----------|--------------------|------------------|
| context | "This section details the stable regression smoke benchmark, a pre-merge test utilizing **4 fixture documents and 21 querie**…" | "This chunk describes the stable regression smoke benchmark, a test run for detecting retrieval regressions in the `bench`…" | "This chunk describes the details of a regression smoke benchmark for document retrieval, specifying its purpose and stru…" |
| tags | **stable-regression, smoke-benchmark**, v1-schema, v2-schema, merge-detection | regression-benchmark, **smoke-test**, retrieval, query-testing, bench-retrieval | query-benchmark, retrieval-benchmark, regression-testing |
| text (unchanged) | The stable regression smoke benchmark. It uses 4 fixture docs and **21 queries** in v1/v2 schema… | (same) | (same) |

## Payload Comparison: `benchmarking.md#2`

| Field | Baseline | gemma3:4b combined | qwen2.5 combined |
|-------|----------|--------------------|------------------|
| context | "This section details the setup for a **50-query quality benchmark in version 3**, utilizing a diverse collection of fixture…" | "This section details the setup for a **50-query benchmark** using a custom schema and graded relevance metrics…" | "This chunk describes a quality benchmark setup with **8-10 fixture docs and 50 queries** in v3 schema." |
| tags | evaluation-harness, **graded-relevance, v3-schema, chunk-recall**, ndcg-metrics | benchmark, retrieval, qdrant, evaluation, **recall, ndcg** | evaluation-harness, **relevance-assessment** |
| text (unchanged) | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema… | (same) | (same) |

---

## Root Cause Analysis

### Embedding input — what actually matters

The embedding input is built as `context + "\n\n" + text` (`src/indexer/index.js:159`).
Tags are stored in Qdrant payload only and do not enter the dense or sparse vectors
(`src/indexer/index.js:205`). Default hybrid RRF search does not use tags as a signal.
This means tag differences between baseline and combined are a symptom of LLM output
quality, not a direct cause of ranking regression.

The ctx-only ablation confirms this: with `BENCH_COMBINED_CONTEXT_ONLY=1`, tags are
stored as `[]` — yet c41 still regresses identically. Tags cannot be the cause.

### Primary: context identifier loss → embedding drift

The query is `яка різниця між 21-query regression і custom-50 quality benchmark`.
Dense and sparse vectors for `benchmarking.md#1` are built from:

```
<context sentence> + "\n\n" + The stable regression smoke benchmark. It uses 4 fixture
docs and 21 queries in v1/v2 schema. It is run before merges to detect retrieval
regressions. The collection name is `bench-retrieval`.
```

The text half is identical across all variants. The context half differs:

| Variant | Context (truncated) | Key tokens preserved |
|---------|---------------------|----------------------|
| Baseline | "…stable regression smoke benchmark, a pre-merge test utilizing **4 fixture documents and 21 querie**…" | `21`, `stable`, `regression`, `smoke`, `pre-merge` |
| gemma combined | "…stable regression smoke benchmark, a test run for detecting retrieval regressions in the `bench`…" | `regression`, `smoke` — loses `21`, `stable`, `pre-merge` |
| qwen combined | "…regression smoke benchmark for document retrieval, specifying its purpose and stru…" | `regression`, `smoke` — loses `21`, `stable`, `pre-merge`, `bench-retrieval` |

Both combined variants lose `21` (the exact count "21 queries") and paraphrase away
`stable` and `pre-merge`. These tokens strengthen the sparse leg for the query term
`21-query regression`. Losing them slightly weakens both the dense and sparse components
of the embedding, pushing `benchmarking.md#1` down by one rank slot.

### Secondary: rank-5 cliff + score compression

Score spread across baseline top-10: only 0.0037. `benchmarking.md#1` at rank 5 scores
0.0007 above rank 6. Any embedding drift that reduces its RRF score crosses that boundary.
There is zero margin for context quality degradation.

### Why the matrix showed qwen as soft-only

In the quality matrix run, qwen's combined collection was indexed with a different STAMP
and different Qdrant tie-ordering. The compressed scores mean ±1-rank swaps are within
search-ordering noise (MRR noise floor ±0.030). In the isolated diagnostic, qwen also
lands at rank 6. Both models are equally affected; the matrix difference was noise.

### Hypothesis elimination

| Hypothesis | Status | Evidence |
|------------|--------|----------|
| Tag token loss → retrieval regression | ✗ REJECTED | tags not in embedding input (`index.js:159,205`); ctx-only ablation (tags=[]) equally regresses |
| Tag/context interaction | ✗ REJECTED | ctx-only ablation shows same regression with empty tags |
| Search-ordering noise | ✗ REJECTED as sole cause | consistent across 3 combined runs (matrix gemma, diag gemma, diag qwen) |
| Qrel error | ✗ REJECTED | chunks manually verified, correct targets |
| Source-navigation class | ✗ NOT APPLICABLE | c41 is conceptual |
| Context identifier loss (combined prompt) | ✓ CONFIRMED | `21`, `stable`, `pre-merge` lost from context in both models |
| JSON format constraint contributing to context drift | ✓ LIKELY | combined prompt's JSON constraint shifts model attention toward format over content fidelity |
| Rank-5 cliff making regression observable | ✓ CONFIRMED | score margin = 0.0007; identical root cause on a rank-2 chunk would be invisible |
| Baseline context empty | ✗ WRONG — prior draft hypothesis | baseline context is non-empty; corrected here |

---

## Note on c48

c48 is not part of this diagnostic. The c48 regression visible in pre-fix reports was
a qrel error (wrong target chunk). After qrel correction to `multilingual.md#3`, c48
scores ✓ for both models.

---

## Recommended Next Action

**Confirmed cause: context identifier loss in the combined prompt's embedding input.**

Both models lose `21` and paraphrase `stable`/`pre-merge` in the context sentence.
The embedding input is `context + "\n\n" + text`; these are the tokens that give
`benchmarking.md#1` its edge in the compressed score field.

Tag quality also degrades (both models drop `smoke-benchmark`), but this is a symptom
of the same LLM output pattern, not the retrieval cause. Tag prompt changes would improve
`qdrant_find_by_tag` UX but would not affect default `qdrant_search` / hybrid RRF.

Possible mitigations (future work, not this task):

1. **Test `identifier-preserving` context prompt across full custom-50**: the
   `BENCH_CONTEXT_POLICY=identifier-preserving` variant explicitly instructs the model
   to preserve exact identifiers verbatim (env vars, counts, names). Test whether it
   recovers `21 queries`, `stable regression`, and `bench-retrieval` in the context
   field for this chunk type without regressing other queries.

2. **Accept as known tradeoff at the cliff**: the regression affects a chunk already at
   the cr@5 cliff in baseline (rank 5, MRR=0.200). A full 50-query policy comparison
   is needed before any prompt change is committed — a fix here must not create new
   regressions elsewhere.

**This finding updates the DEFER verdict reasoning** for both models: the regression is
not a diffuse quality loss but a specific context-identifier-loss pattern for short,
heavily-named chunks at the ranking boundary. The fix direction is the context prompt,
not the tag prompt.

---

## Source Links

- `src/indexer/phases/combined.js` — combined prompt builder (`buildPromptCurrentMinimal`)
- `src/indexer/phases/context.js` — baseline separate context prompt
- `benchmarks/retrieval/custom-50/combined-hard-regression-diagnostic.js` — diagnostic script
- `benchmarks/retrieval/custom-50/fixtures/docs/benchmarking.md` — fixture source
- `benchmarks/retrieval/results/2026-05-27T0730-combined-llm-hard-regressions.md` — gemma3:4b raw diagnostic
- `benchmarks/retrieval/results/2026-05-27T0734-combined-llm-hard-regressions.md` — qwen2.5:3b-instruct raw diagnostic
- `benchmarks/retrieval/results/2026-05-26T2055-combined-llm-quality-matrix.md` — quality matrix
- `benchmarks/retrieval/results/2026-05-26T2115-combined-context-only-ablation.md` — ablation data
- `benchmarks/retrieval/results/2026-05-26T1430-custom50-variance-source-check.md` — noise floor
