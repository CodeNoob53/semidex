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
| Baseline | 887 ms | n/a | 0 |
| Combined | 227752 ms | 0 | n/a |

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
| 1 | 0.0333 | benchmarking.md#19 | — | Collection Isolation | Chunk 20 describes how benchmarks are isolated by creating separate Qdrant colle… | benchmarking-tier, qdrant-collections |
| 2 | 0.0328 | multilingual.md#6 | — | Benchmark Coverage | Chunk 7 describes the custom-50 benchmark including different language-specific … | multilingual-benchmark, benchmark-covers-multiple-languages |
| 3 | 0.0320 | benchmarking.md#2 | 2 | 50-query quality benchmark (`b… | This chunk describes a quality benchmark setup with 8-10 fixture docs and 50 que… | evaluation-harness, relevance-assessment |
| 4 | 0.0303 | benchmarking.md#13 | — | Force ONNX provider | This chunk sets an environment variable `BENCH_PROVIDER` to `onnx`, indicating t… |  |
| 5 | 0.0302 | benchmarking.md#12 | — | Quality 50q benchmark | npm run bench:custom50 is mentioned here as a command that might be used during … | benchmarking-js, node-js, npm-run, bench-custom50 |
| 6 | 0.0295 | benchmarking.md#1 | **3** | 21-query regression benchmark … | This chunk describes the details of a regression smoke benchmark for document re… | query-benchmark, retrieval-benchmark, regression-testing |
| 7 | 0.0294 | project-structure.md#2 | — | Source Tree | Chunk 3 describes the 'run-v3.js' file and its purpose in running a quality benc… | project-structure, tool-development, benchmarking |
| 8 | 0.0291 | project-structure.md#1 | — | Source Tree | Chunk 2 describes the structure of the 'src/core' directory, which includes file… | node-js, qdrant-client, mcp-server |
| 9 | 0.0290 | config-env.md#10 | — | Benchmark Variables | This chunk describes the default settings and options available for a benchmark … | benchmark-variables, search-depth, env-defaults |
| 10 | 0.0290 | project-structure.md#8 | — | Entry Points | This chunk lists the entry points and their corresponding modules in the project… | project-structure, node-js |

### Expected Chunk Payload Comparison

**Expected chunk: `benchmarking.md#1`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 21-query regression benchmark (`benchmarks/retrieval/`) | 21-query regression benchmark (`benchmarks/retrieval/`) |
| context | This section details the stable regression smoke benchmark, a pre-merge test utilizing 4 fixture documents and 21 querie… | This chunk describes the details of a regression smoke benchmark for document retrieval, specifying its purpose and stru… |
| tags | stable-regression, smoke-benchmark, v1-schema, v2-schema, merge-detection | query-benchmark, retrieval-benchmark, regression-testing |
| text snippet | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … |
| text length (chars) | 192 | 192 |

**Expected chunk: `benchmarking.md#2`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… |
| context | This section details the setup for a 50-query quality benchmark in version 3, utilizing a diverse collection of fixture … | This chunk describes a quality benchmark setup with 8-10 fixture docs and 50 queries in v3 schema. |
| tags | evaluation-harness, graded-relevance, v3-schema, chunk-recall, ndcg-metrics | evaluation-harness, relevance-assessment |
| text snippet | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… |
| text length (chars) | 262 | 262 |

### Cause Classification


- combined context wording drift — exact query tokens absent (no stemming): 21, query
- combined tags lost useful query-matching terms: stable-regression, smoke-benchmark

## Overall Recommendation

**Reproduced regressions:** `c41`

**Primary cause: combined tag quality** — combined mode produced tags that lost
query-relevant terms or introduced off-topic terms, reducing BM25/sparse recall.

**Recommendation:** tag normalization tweak — add explicit tag instructions to the
combined prompt to prefer exact technical tokens over paraphrased terms.

**COMBINED_LLM=1 status:** remains opt-in with caution. Do not promote to default
until root cause is resolved or accepted as a known tradeoff.

*Generated: 2026-05-27*