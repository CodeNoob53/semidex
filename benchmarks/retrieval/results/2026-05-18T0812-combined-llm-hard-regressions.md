# COMBINED_LLM=1 Hard Regression Diagnostic — 2026-05-18

## Context

Source report: `benchmarks/retrieval/results/2026-05-17T2333-combined-llm-custom50-quality.md`

Hard regressions (lost chunkRecall@5) identified in custom-50 run:
- `c04`
- `c41`

This report compares the exact top-10 results and expected chunk payloads between
baseline (context+tags) and combined (COMBINED_LLM=1) to identify the root cause.

## Indexing

| Run | Wall time | Combined fallbacks | Tag batch fallbacks |
|-----|-----------|-------------------|---------------------|
| Baseline | 289864 ms | n/a | 8 |
| Combined | 163873 ms | 0 | n/a |

## Query `c04` — exact-token — *hard regression reproduced*

**Query:** embedding_schema_version reindex discriminator payload field

**Note:** exact technical token in reindex triggers section

**qrels:**
- `providers.md#5` — relevance 3
- `providers.md#4` — relevance 2

**Rank summary:**

| chunkId | baseline rank | combined rank | baseline in top-5 | combined in top-5 |
|---------|--------------|---------------|-------------------|-------------------|
| `providers.md#5` | 5 | absent | ✓ | ✗ |

**Baseline top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0331 | project-structure.md#5 | — | src/core/embeddings.js | This section details the `embeddings.js` file within the `src/core` directory, s… | embeddings, qdrant, indexing, search |
| 2 | 0.0328 | qdrant.md#6 | — | getStoredMeta | This section details the `getStoredMeta` function, which retrieves metadata asso… | data-retrieval, metadata-extraction, file-hash, embedding-schema |
| 3 | 0.0310 | config-env.md#11 | — | config.json | This section details the `config.json` file, which manages collection configurat… | config-ignored, git-ignore, file-management |
| 4 | 0.0308 | providers.md#4 | 2 | Provider validation | This section describes the runtime validation process within the `src/core/embed… | resolve-env-providers, env-time, embeddings, validation |
| 5 | 0.0307 | providers.md#5 | **3** | Reindex triggers | This section details a critical configuration change: altering `sparseProvider`,… | reindex, npm-run-index, discriminators, file-hash |
| 6 | 0.0294 | providers.md#0 | — | Embedding Providers | This section details the configuration options for embedding providers within th… | semidex, embedding-providers, configuration, provider-re-indexing |
| 7 | 0.0294 | sync.md#2 | — | Backfill logic | This section details the backfill logic used to populate missing provider fields… | backfill-logic, provider-configuration, dense-provider, sparse-provider |
| 8 | 0.0294 | chunking.md#4 | — | Why overlap must not cross sec… | This chunk explains the issue of semantic contamination that arises when overlap… | semantic-context, markdown-heading, section-overlap, query-section |
| 9 | 0.0293 | benchmarking.md#23 | — | BENCH_SKIP_INDEX | This section describes the `BENCH_SKIP_INDEX=1` flag, which prevents re-indexing… | bencher-skip-index, index-reindex, matrix-scripts, mmr-matrix |
| 10 | 0.0278 | qdrant.md#5 | — | Payload Indexes | This section details the creation of two payload indexes – `source_file` and `ta… | qdrant, payload-index, keyword-index, filtering |

**Combined top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0331 | project-structure.md#5 | — | src/core/embeddings.js | This section details the `embeddings.js` file within the `src/core` directory, s… | embeddings-js, qdrant, schema-version, embed-for-index |
| 2 | 0.0320 | qdrant.md#6 | — | getStoredMeta | This chunk describes the `getStoredMeta` function which retrieves metadata for a… | qdrant, getstoredmeta, collection, sourcefile |
| 3 | 0.0313 | providers.md#4 | 2 | Provider validation | This chunk describes the provider validation process, specifically within the `s… | provider-validation, qdrant-payloads, embeddings-js, resolve-env-providers |
| 4 | 0.0306 | chunking.md#4 | — | Why overlap must not cross sec… | This chunk discusses the problem of overlap between sections in a document and h… | overlap-problem, embedding-contamination, semidex, markdown-headings |
| 5 | 0.0303 | obsidian.md#4 | — | Frontmatter Fields | This chunk describes the payload fields associated with each chunk of the obsidi… | payload, source-file, chunk-index, dense-provider |
| 6 | 0.0302 | config-env.md#11 | — | config.json | This chunk describes the `config.json` file and how it's managed during indexing… | config-json, npm-run-sync, npm-run-index, qdrant |
| 7 | 0.0289 | benchmarking.md#4 | — | Query Schema Versions | This section is an empty placeholder, marking the beginning of the "Query Schema… | benchmarking, query-schema, versioning, placeholder |
| 8 | 0.0286 | sync.md#2 | — | Backfill logic | This chunk describes the logic used during backfill operations for config entrie… | config-json, env-vars, backfill, bge-m3-onnx |
| 9 | 0.0281 | benchmarking.md#23 | — | BENCH_SKIP_INDEX | This chunk describes the `BENCH_SKIP_INDEX` flag, which prevents re-indexing and… | benchmark-skip-index, matrix-scripts, env-vars, collection-reuse |
| 10 | 0.0280 | providers.md#0 | — | Embedding Providers | This chunk describes how Semidex handles embedding provider configurations, spec… | semidex, embedding-provider, config-json, reindex |

### Expected Chunk Payload Comparison

**Expected chunk: `providers.md#5`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | Reindex triggers | Reindex triggers |
| context | This section details a critical configuration change: altering `sparseProvider`, `denseProvider`, `denseModel`, or `embe… | This section describes triggers for reindexing collections within a project. Specifically, modifying certain configurati… |
| tags | reindex, npm-run-index, discriminators, file-hash, dense-provider, embedding-schema-version | reindex, npm-run-index, config-json, file-hash, dense-provider, dense-model, embedding-schema-version |
| text snippet | Changing `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion` in config.json… | Changing `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion` in config.json… |
| text length (chars) | 333 | 333 |

**Expected chunk: `providers.md#4`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | Provider validation | Provider validation |
| context | This section describes the runtime validation process within the `src/core/embeddings.js` file, specifically the `_embed… | This chunk describes the provider validation process, specifically within the `src/core/embeddings.js` file. It focuses … |
| tags | resolve-env-providers, env-time, embeddings, validation, provider-combination | provider-validation, qdrant-payloads, embeddings-js, resolve-env-providers, reindex-detection |
| text snippet | Both `resolveEnvProviders()` (env-time) and `_embed()` in `src/core/embeddings.js` (runtime) validat… | Both `resolveEnvProviders()` (env-time) and `_embed()` in `src/core/embeddings.js` (runtime) validat… |
| text length (chars) | 307 | 307 |

### Cause Classification


- combined context changed semantic focus (no direct term loss detected)
- combined tags added noisy off-topic terms: config-json, dense-model
- expected chunk present in baseline top-10 but absent from combined top-10

## Query `c41` — conceptual — *hard regression NOT reproduced — likely variance*

**Query:** яка різниця між 21-query regression і custom-50 quality benchmark

**Note:** two benchmark tiers comparison, UA paraphrase

**qrels:**
- `benchmarking.md#2` — relevance 3
- `benchmarking.md#3` — relevance 2

**Rank summary:**

| chunkId | baseline rank | combined rank | baseline in top-5 | combined in top-5 |
|---------|--------------|---------------|-------------------|-------------------|
| `benchmarking.md#2` | 8 | 7 | ✗ | ✗ |

> **Note:** hard regression did not reproduce in this run — baseline itself missed top-5
> (rank 8), so there is no combined-only regression to attribute. This is an unstable/weak
> query case where the expected chunk sits near the top-5 boundary and rank fluctuates with
> LLM output variance. Payload comparison and cause classification are shown for reference
> only; do not use to draw conclusions about combined-mode regression cause.

**Baseline top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0331 | benchmarking.md#22 | — | Collection Isolation | This section details the collection isolation strategy used during benchmarking,… | benchmark, tier, qdrant-collection, bench-retrieval |
| 2 | 0.0318 | benchmarking.md#3 | 2 | 50-query quality benchmark (`b… | This section details the implementation of a 50-query quality benchmark in v3, u… | benchmark, evaluation-harness, retrieval-system, chunk-recall |
| 3 | 0.0313 | multilingual.md#7 | — | Benchmark Coverage | This section details the custom-50 benchmark, which incorporates Ukrainian, Engl… | ukrainian-queries, english-queries, mixed-queries, onnx_embed |
| 4 | 0.0310 | project-structure.md#1 | — | Source Tree | This section details the source tree's directory structure, specifically focusin… | evaluation-set, 50-query, qrels, fixture-docs |
| 5 | 0.0308 | benchmarking.md#15 | — | Quality 50q benchmark | This section details custom benchmarking procedures, specifically the "Quality 5… | benchmarking, npm, benchmark, custom-benchmark |
| 6 | 0.0307 | benchmarking.md#17 | — | Skip reindex (reuse existing c… | This section details custom benchmarking commands, specifically the `BENCH_SKIP_… | benchmarking, npm, benchmarking-commands, skip-reindex |
| 7 | 0.0299 | benchmarking.md#18 | — | Dense MMR instead of hybrid RR… | This chunk describes a specific benchmark configuration, `BENCH_SEARCH_MODE=dens… | bench-search-mode, dense-mmr, npm-run |
| 8 | 0.0299 | benchmarking.md#2 | **3** | 21-query regression benchmark … | This section details the "stable regression smoke benchmark," a pre-merge test u… | benchmark, queries, schema, merges |
| 9 | 0.0290 | benchmarking.md#16 | — | Force ONNX provider | This chunk describes a command to run a custom benchmark using the ONNX provider… | onnx-provider, benchmarking, benchmark, onnx-npm |
| 10 | 0.0289 | project-structure.md#9 | — | Entry Points | This section details the available command-line entry points for the project, ou… | command-line-entry-points, npm-scripts, indexing, synchronization |

**Combined top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0328 | benchmarking.md#3 | 2 | 50-query quality benchmark (`b… | This chunk describes the setup for a 50-query quality benchmark, focusing on the… | benchmark, retrieval, custom-50, v3-schema |
| 2 | 0.0323 | multilingual.md#7 | — | Benchmark Coverage | This chunk describes the different query types used in the custom-50 benchmark, … | benchmark-coverage, custom-50, sparse-provider, embedding |
| 3 | 0.0323 | benchmarking.md#22 | — | Collection Isolation | This section details the collection isolation strategy used during benchmarking.… | qdrant, benchmarking, collection-isolation, bench-retrieval |
| 4 | 0.0308 | benchmarking.md#15 | — | Quality 50q benchmark | This section details custom benchmarking runs, specifically referencing the `npm… | benchmarking, npm, benchmark, quality-benchmarking |
| 5 | 0.0308 | project-structure.md#1 | — | Source Tree | This section details the source tree structure, specifically focusing on the dir… | semidex, indexer, config-js, embeddings-js |
| 6 | 0.0301 | benchmarking.md#17 | — | Skip reindex (reuse existing c… | This chunk describes a specific command used during benchmarking – running `npm … | benchmarking, npm, benchmark, skip-reindex |
| 7 | 0.0294 | benchmarking.md#2 | **3** | 21-query regression benchmark … | This chunk describes the stable regression smoke benchmark, a test run used to i… | regression-benchmark, smoke-test, retrieval-testing, bench-retrieval |
| 8 | 0.0288 | benchmarking.md#12 | — | Latency | This section details latency metrics collected during benchmarking. Specifically… | query-latency, p50, p95, avglatency |
| 9 | 0.0285 | project-structure.md#9 | — | Entry Points | This section lists the available npm commands and their corresponding modules an… | npm-run-index, src-indexer-index-js, qdrant, npm-run-sync |
| 10 | 0.0284 | benchmarking.md#0 | — | Benchmarking | This chunk describes a benchmark harness used in semidex to evaluate search qual… | semidex, benchmark-harness, fixture-documents, search-quality |

### Expected Chunk Payload Comparison

**Expected chunk: `benchmarking.md#2`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 21-query regression benchmark (`benchmarks/retrieval/`) | 21-query regression benchmark (`benchmarks/retrieval/`) |
| context | This section details the "stable regression smoke benchmark," a pre-merge test utilizing 4 fixture documents and 21 quer… | This chunk describes the stable regression smoke benchmark, a test run used to identify retrieval regressions within the… |
| tags | benchmark, queries, schema, merges, retrieval-regressions | regression-benchmark, smoke-test, retrieval-testing, bench-retrieval, v1-schema, v2-schema, query-regression |
| text snippet | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … |
| text length (chars) | 192 | 192 |

**Expected chunk: `benchmarking.md#3`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… |
| context | This section details the implementation of a 50-query quality benchmark in v3, utilizing a diverse set of fixture docume… | This chunk describes the setup for a 50-query quality benchmark, focusing on the v3 schema and relevance grading. It det… |
| tags | benchmark, evaluation-harness, retrieval-system, chunk-recall, n-dcg, graded-relevance, fixture-documents | benchmark, retrieval, custom-50, v3-schema, graded-relevance, recall, ndcg |
| text snippet | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… |
| text length (chars) | 262 | 262 |

### Cause Classification

*Not reproduced — classification is indicative only.*

- combined context wording drift — exact query tokens absent (no stemming): 21
- combined tags lost useful query-matching terms: benchmark
- combined tags added noisy off-topic terms: smoke-test, retrieval-testing, bench-retrieval, v1-schema, v2-schema

## Overall Recommendation

**Not reproduced in this run:** `c41` — regression did not appear; likely LLM output variance. Rerun `bench:custom50:combined` 2-3 times to check consistency.

**Reproduced regressions:** `c04`

**Primary cause: combined tag quality** — combined mode produced tags that lost
query-relevant terms or introduced off-topic terms, reducing BM25/sparse recall.

**Recommendation:** tag normalization tweak — add explicit tag instructions to the
combined prompt to prefer exact technical tokens over paraphrased terms.

**COMBINED_LLM=1 status:** remains opt-in with caution. Do not promote to default
until root cause is resolved or accepted as a known tradeoff.

*Generated: 2026-05-18*