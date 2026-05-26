# COMBINED_LLM=1 Hard Regression Diagnostic — 2026-05-25

## Diagnostic Scope

Target queries:
- `c41`

Compares exact top-10 results and expected chunk payloads between
baseline (context+tags) and combined (COMBINED_LLM=1) to identify the root cause.

## Indexing

| Setting | Value |
|---------|-------|
| Baseline context policy | `current-minimal` (pinned) |
| Combined context policy | `identifier-preserving` |

| Run | Wall time | Combined fallbacks | Tag batch fallbacks |
|-----|-----------|-------------------|---------------------|
| Baseline | 507392 ms | n/a | 5 |
| Combined | 305126 ms | 6 | n/a |

## Query `c41` — conceptual — *hard regression reproduced*

**Query:** яка різниця між 21-query regression і custom-50 quality benchmark

**Note:** two benchmark tiers comparison, UA paraphrase

**qrels:**
- `benchmarking.md#2` — relevance 3
- `benchmarking.md#3` — relevance 2

**Rank summary:**

| chunkId | baseline rank | combined rank | baseline in top-5 | combined in top-5 |
|---------|--------------|---------------|-------------------|-------------------|
| `benchmarking.md#2` | 4 | 8 | ✓ | ✗ |

**Baseline top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0331 | benchmarking.md#22 | — | Collection Isolation | This section details the collection isolation strategy used for benchmarking, cr… | benchmark-tier, qdrant-collection, bench-retrieval, index |
| 2 | 0.0328 | multilingual.md#7 | — | Benchmark Coverage | This section details the custom-50 benchmark, which utilizes Ukrainian, English,… | benchmark-custom-50, query-language, ukrainian-queries, english-queries |
| 3 | 0.0317 | benchmarking.md#3 | 2 | 50-query quality benchmark (`b… | This section details the evaluation harness for the 50-query benchmark, utilizin… | evaluation-harness, graded-relevance, chunk-recall, ndcg-metrics |
| 4 | 0.0308 | benchmarking.md#2 | **3** | 21-query regression benchmark … | This chunk describes the "stable regression smoke benchmark," a test suite using… | stable-regression, smoke-benchmark, v1-schema, v2-schema |
| 5 | 0.0305 | benchmarking.md#17 | — | Skip reindex (reuse existing c… | This chunk describes a specific npm command used to run a custom benchmark (`BEN… | bench_skip, index, custom50, benchmark |
| 6 | 0.0305 | benchmarking.md#15 | — | Quality 50q benchmark | This chunk describes running a custom 50q benchmark using the npm script `bench:… | npm-run-bench, bench, custom50, benchmark |
| 7 | 0.0293 | project-structure.md#1 | — | Source Tree | This section details the source tree's directory structure for the semidex proje… | qdrant-rest-client, search-upsert, scroll-api, benchmark-runner |
| 8 | 0.0290 | project-structure.md#9 | — | Entry Points | This section details the project's command entry points, outlining the correspon… | command-run, module-index, npm-scripts, qdrant-indexing |
| 9 | 0.0286 | benchmarking.md#10 | — | Chunk-level (v3 only) | This chunk defines several evaluation metrics used for assessing the quality of … | metric-definition, score-support, chunk-recall, mrr-rank |
| 10 | 0.0284 | benchmarking.md#14 | — | Stable 21q regression benchmar… | This chunk details the execution of the `npm run bench:retrieval` command, likel… | query-latency-ms, retrieval-bench, performance-metrics |

**Combined top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0333 | benchmarking.md#22 | — | Collection Isolation | This section details the collection isolation strategy employed during benchmark… | benchmarking, qdrant-collection, benchmark-isolation, bench-retrieval |
| 2 | 0.0325 | multilingual.md#7 | — | Benchmark Coverage | This section details the test cases used for the custom-50 benchmark, which spec… | benchmark-coverage, custom-50, qdrant-hybrid-search, ukrainian-language |
| 3 | 0.0323 | benchmarking.md#15 | — | Quality 50q benchmark | This chunk describes the execution of a custom benchmark using the npm command `… | benchmark, npm, benchmarking, custom-benchmark |
| 4 | 0.0308 | benchmarking.md#18 | — | Dense MMR instead of hybrid RR… | This section describes a specific benchmark configuration, `BENCH_SEARCH_MODE=de… | benchmark, dense-mmr, mmr, search-mode |
| 5 | 0.0306 | benchmarking.md#3 | 2 | 50-query quality benchmark (`b… | This chunk describes a benchmark setup for evaluating the v3 schema, using a gra… | benchmark, retrieval, qdrant, evaluation |
| 6 | 0.0303 | benchmarking.md#17 | — | Skip reindex (reuse existing c… | This section describes a command for running custom benchmarks, specifically uti… | benchmarking, benchmark, custom-benchmarks, skip-reindex |
| 7 | 0.0301 | project-structure.md#1 | — | Source Tree | This section describes the source tree structure within the `semidex` project, s… | semidex, source-tree, indexer, chunk-js |
| 8 | 0.0301 | benchmarking.md#2 | **3** | 21-query regression benchmark … | This chunk describes the stable regression smoke benchmark, a test run used to i… | regression-benchmark, smoke-test, qdrant, retrieval |
| 9 | 0.0294 | benchmarking.md#16 | — | Force ONNX provider | This section details custom benchmarking configurations, specifically using the … | onnx-provider, benchmarking, custom-benchmarking, onnx |
| 10 | 0.0284 | benchmarking.md#14 | — | Stable 21q regression benchmar… | This chunk describes the execution of the `npm run bench:retrieval` command, lik… | regression-benchmark, npm, bench-retrieval, stable-21q |

### Expected Chunk Payload Comparison

**Expected chunk: `benchmarking.md#2`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 21-query regression benchmark (`benchmarks/retrieval/`) | 21-query regression benchmark (`benchmarks/retrieval/`) |
| context | This chunk describes the "stable regression smoke benchmark," a test suite using 4 fixture documents and 21 queries to d… | This chunk describes the stable regression smoke benchmark, a test run used to identify retrieval regressions in the `be… |
| tags | stable-regression, smoke-benchmark, v1-schema, v2-schema, merge-detection | regression-benchmark, smoke-test, qdrant, retrieval, fixtures, v1, v2 |
| text snippet | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … |
| text length (chars) | 192 | 192 |

**Expected chunk: `benchmarking.md#3`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… |
| context | This section details the evaluation harness for the 50-query benchmark, utilizing a collection of 8-10 fixture documents… | This chunk describes a benchmark setup for evaluating the v3 schema, using a graded relevance system and specific metric… |
| tags | evaluation-harness, graded-relevance, chunk-recall, ndcg-metrics, custom-queries | benchmark, retrieval, qdrant, evaluation, v3-schema, recall, ndcg |
| text snippet | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… |
| text length (chars) | 262 | 262 |

### Cause Classification

> **⚠ STALE — auto-classification below is incorrect. Do not use for decision-making.**
>
> The script's cause classifier attributed the regression to tag vocabulary drift and
> recommended a tag prompt tweak. This is wrong. Tags are stored in payload only and
> are **not** part of the embedding input (`index.js:153-155` embeds `context + "\n\n" + text`).
> Tag quality cannot directly affect retrieval scores. The ctx-only ablation
> (`2026-05-25T2004-combined-context-only-ablation.md`) already established this.
>
> **Canonical analysis:** `benchmarks/retrieval/results/2026-05-26T0009-combined-identifier-policy-c41.md`
> — correct root cause, verdict, and recommendations.

- combined context wording drift — exact query tokens absent (no stemming): query
- combined tags lost useful query-matching terms: stable-regression, smoke-benchmark
- combined tags added noisy off-topic terms: smoke-test, qdrant, retrieval, fixtures, v1, v2

## Overall Recommendation

> **⚠ STALE — recommendation below is based on the incorrect tag-quality cause above.**
> See `benchmarks/retrieval/results/2026-05-26T0009-combined-identifier-policy-c41.md` for
> the current recommendation.

**Reproduced regressions:** `c41`

**Primary cause: combined tag quality** — combined mode produced tags that lost
query-relevant terms or introduced off-topic terms, reducing BM25/sparse recall.

**Recommendation:** tag normalization tweak — add explicit tag instructions to the
combined prompt to prefer exact technical tokens over paraphrased terms.

**COMBINED_LLM=1 status:** remains opt-in with caution. Do not promote to default
until root cause is resolved or accepted as a known tradeoff.

*Generated: 2026-05-25*