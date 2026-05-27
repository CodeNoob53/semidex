# COMBINED_LLM=1 Hard Regression Diagnostic — 2026-05-27

## Diagnostic Scope

Target queries:
- `c41`

Compares exact top-10 results and expected chunk payloads between
baseline (context+tags) and combined (COMBINED_LLM=1) to identify the root cause.

## Indexing

| Setting | Value |
|---------|-------|
| Baseline context policy | `current-minimal` (pinned) |
| Combined context policy | `current-minimal` |

| Run | Wall time | Combined fallbacks | Tag batch fallbacks |
|-----|-----------|-------------------|---------------------|
| Baseline | 416992 ms | n/a | 9 |
| Combined | 200002 ms | 0 | n/a |

## Query `c41` — conceptual — *hard regression reproduced*

**Query:** яка різниця між 21-query regression і custom-50 quality benchmark

**Note:** two benchmark tiers comparison, UA paraphrase

**qrels:**
- `benchmarking.md#1` — relevance 3
- `benchmarking.md#2` — relevance 2

**Rank summary:**

| chunkId | baseline rank | combined rank | baseline in top-5 | combined in top-5 |
|---------|--------------|---------------|-------------------|-------------------|
| `benchmarking.md#1` | 5 | 6 | ✓ | ✗ |

**Baseline top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0328 | benchmarking.md#19 | — | Collection Isolation | This section details the collection isolation strategy employed during benchmark… | benchmark-tier, qdrant-isolation, index-creation, bench-retrieval-collection |
| 2 | 0.0328 | multilingual.md#6 | — | Benchmark Coverage | This section details the custom-50 benchmark, which is designed to evaluate quer… | benchmark-evaluation, custom-50, query-types, language-support |
| 3 | 0.0325 | benchmarking.md#2 | 2 | 50-query quality benchmark (`b… | This section details the setup for a 50-query quality benchmark in version 3, ut… | evaluation-harness, graded-relevance, v3-schema, chunk-recall |
| 4 | 0.0313 | benchmarking.md#12 | — | Quality 50q benchmark | This chunk describes the execution of a custom benchmark using the npm command `… | npm, -benchmark, -custom-benchmark, -performance |
| 5 | 0.0306 | benchmarking.md#1 | **3** | 21-query regression benchmark … | This section details the stable regression smoke benchmark, a pre-merge test uti… | stable-regression, smoke-benchmark, v1-schema, v2-schema |
| 6 | 0.0299 | benchmarking.md#14 | — | Skip reindex (reuse existing c… | This chunk describes a specific npm command, `BENCH_SKIP_INDEX=1 npm run bench:c… | benchmarking, npm, custom-benchmarking, skip-reindex |
| 7 | 0.0299 | benchmarking.md#13 | — | Force ONNX provider | This section describes a custom benchmarking run using the ONNX provider, specif… | onnx-provider, benchmarking, custom-benchmark, bench-custom50 |
| 8 | 0.0294 | benchmarking.md#7 | — | Chunk-level (v3 only) | This chunk defines key evaluation metrics used in the benchmarking process, spec… | score-exact, metric-recall, chunk-support, ndcg-relevance |
| 9 | 0.0292 | benchmarking.md#15 | — | Dense MMR instead of hybrid RR… | This section details experimental configurations for benchmarking search methods… | bench_search_mode, dense-mmr, npm-run, bench:custom50 |
| 10 | 0.0291 | project-structure.md#1 | — | Source Tree | This section details the source tree organization, specifically focusing on the … | architecture, system, design, components |

**Combined top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0331 | benchmarking.md#19 | — | Collection Isolation | This section details the collection isolation strategy used during benchmarking,… | benchmarking, qdrant, collection-isolation, regression |
| 2 | 0.0331 | benchmarking.md#2 | 2 | 50-query quality benchmark (`b… | This section details the setup for a 50-query benchmark using a custom schema an… | benchmark, retrieval, qdrant, evaluation |
| 3 | 0.0323 | multilingual.md#6 | — | Benchmark Coverage | This section describes the queries used within the custom-50 benchmark, categori… | benchmark, custom-50, query-testing, language-coverage |
| 4 | 0.0308 | benchmarking.md#14 | — | Skip reindex (reuse existing c… | This chunk describes a command used during a benchmark, specifically running a c… | benchmarking, benchmark, skip-reindex, custom50 |
| 5 | 0.0308 | benchmarking.md#12 | — | Quality 50q benchmark | This chunk describes the execution of a custom benchmark using the `npm run benc… | benchmark, npm, benchmarking, quality-50q |
| 6 | 0.0301 | benchmarking.md#1 | **3** | 21-query regression benchmark … | This chunk describes the stable regression smoke benchmark, a test run for detec… | regression-benchmark, smoke-test, retrieval, query-testing |
| 7 | 0.0297 | benchmarking.md#15 | — | Dense MMR instead of hybrid RR… | This chunk details a specific benchmarking command—`BENCH_SEARCH_MODE=dense-mmr … | benchmarking, dense-mmr, search-algorithm, performance-testing |
| 8 | 0.0292 | project-structure.md#8 | — | Entry Points | This section details the entry points for running the application, listing comma… | entry-points, npm-scripts, command-line, qdrant |
| 9 | 0.0286 | benchmarking.md#11 | — | Stable 21q regression benchmar… | This chunk describes the execution of the `npm run bench:retrieval` command, lik… | benchmark, regression-testing, npm, stable-21q |
| 10 | 0.0282 | benchmarking.md#0 | — | Benchmarking | This section describes the semidex benchmarking harness, which evaluates search … | benchmarking, semidex, retrieval, benchmark |

### Expected Chunk Payload Comparison

**Expected chunk: `benchmarking.md#1`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 21-query regression benchmark (`benchmarks/retrieval/`) | 21-query regression benchmark (`benchmarks/retrieval/`) |
| context | This section details the stable regression smoke benchmark, a pre-merge test utilizing 4 fixture documents and 21 querie… | This chunk describes the stable regression smoke benchmark, a test run for detecting retrieval regressions in the `bench… |
| tags | stable-regression, smoke-benchmark, v1-schema, v2-schema, merge-detection | regression-benchmark, smoke-test, retrieval, query-testing, bench-retrieval |
| text snippet | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … |
| text length (chars) | 192 | 192 |

**Expected chunk: `benchmarking.md#2`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… |
| context | This section details the setup for a 50-query quality benchmark in version 3, utilizing a diverse collection of fixture … | This section details the setup for a 50-query benchmark using a custom schema and graded relevance metrics. It describes… |
| tags | evaluation-harness, graded-relevance, v3-schema, chunk-recall, ndcg-metrics | benchmark, retrieval, qdrant, evaluation, recall, ndcg |
| text snippet | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… |
| text length (chars) | 262 | 262 |

### Cause Classification


- combined context wording drift — exact query tokens absent (no stemming): 21
- combined tags lost useful query-matching terms: stable-regression, smoke-benchmark
- combined tags added noisy off-topic terms: smoke-test, retrieval, bench-retrieval

## Overall Recommendation

**Reproduced regressions:** `c41`

**Primary cause: combined tag quality** — combined mode produced tags that lost
query-relevant terms or introduced off-topic terms, reducing BM25/sparse recall.

**Recommendation:** tag normalization tweak — add explicit tag instructions to the
combined prompt to prefer exact technical tokens over paraphrased terms.

**COMBINED_LLM=1 status:** remains opt-in with caution. Do not promote to default
until root cause is resolved or accepted as a known tradeoff.

*Generated: 2026-05-27*