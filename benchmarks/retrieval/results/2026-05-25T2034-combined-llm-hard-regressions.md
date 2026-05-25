# COMBINED_LLM=1 Hard Regression Diagnostic — 2026-05-25

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
| Baseline | 165278 ms | n/a | 8 |
| Combined | 138076 ms | 0 | n/a |

## Query `c04` — exact-token — *hard regression NOT reproduced — likely variance*

**Query:** embedding_schema_version reindex discriminator payload field

**Note:** exact technical token in reindex triggers section

**qrels:**
- `providers.md#5` — relevance 3
- `providers.md#4` — relevance 2

**Rank summary:**

| chunkId | baseline rank | combined rank | baseline in top-5 | combined in top-5 |
|---------|--------------|---------------|-------------------|-------------------|
| `providers.md#5` | 5 | 5 | ✓ | ✓ |

> **Note:** hard regression did not reproduce in this run — both baseline and combined
> retrieved the expected chunk within top-5. Payload comparison and cause classification
> are shown for reference only; do not use to draw conclusions about regression cause.

**Baseline top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0331 | project-structure.md#5 | — | src/core/embeddings.js | This section details the `embeddings.js` file within the `src/core` directory, s… | embedding-function, schema-version, qdrant-payloads, reindex-discriminator |
| 2 | 0.0320 | qdrant.md#6 | — | getStoredMeta | This section details the `getStoredMeta` function, which retrieves metadata asso… | meta-retrieval, scroll-data, discriminator-fields, hash-provider |
| 3 | 0.0320 | providers.md#4 | 2 | Provider validation | This section details provider validation processes, specifically examining the `… | resolve-env-providers, env-time, embeddings, validation |
| 4 | 0.0310 | config-env.md#11 | — | config.json | This section describes the `config.json` file, which is managed by scripts to sy… | config-git-ignore, git-ignored, file-status, configuration-management |
| 5 | 0.0308 | providers.md#5 | **3** | Reindex triggers | This section details the impact of modifying configuration settings like `sparse… | reindex, npm-run-index, discriminators, file-hash |
| 6 | 0.0293 | project-structure.md#1 | — | Source Tree | This section details the source tree's directory structure, specifically focusin… | semidex/src/core, config.js, embeddings.js, onnx-embed.js |
| 7 | 0.0292 | sync.md#2 | — | Backfill logic | This section details the backfill logic for missing provider fields in configura… | config, sync, provider, schema |
| 8 | 0.0291 | obsidian.md#4 | — | Frontmatter Fields | This chunk details the frontmatter fields associated with each text chunk, inclu… | file-identifier, chunk-index, markdown-heading, total-chunks |
| 9 | 0.0284 | chunking.md#4 | — | Why overlap must not cross sec… | This chunk explains the issue of overlap between sections in a document, specifi… | overlap_sentences, semantic_context, markdown_heading, embedding_issue |
| 10 | 0.0284 | benchmarking.md#4 | — | Query Schema Versions | Empty section placeholder for "Query Schema Versions". |  |

**Combined top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0333 | project-structure.md#5 | — | src/core/embeddings.js | This section describes the `embedForIndex` and `embedForSearch` functions within… | embeddings, qdrant, schema-version, indexing |
| 2 | 0.0320 | qdrant.md#6 | — | getStoredMeta | This section describes the getStoredMeta function in Qdrant, which retrieves met… | qdrant, stored-meta, metadata, vector-search |
| 3 | 0.0315 | providers.md#4 | 2 | Provider validation | This chunk describes the provider validation process within the codebase, specif… | provider-validation, embeddings, qdrant, metadata |
| 4 | 0.0306 | config-env.md#11 | — | config.json | This section describes the `config.json` file, which contains settings for colle… | config-json, qdrant, reindex, collections |
| 5 | 0.0301 | providers.md#5 | **3** | Reindex triggers | This section describes the reindexing behavior triggered by changes to provider … | reindex, config-json, provider-settings, index-trigger |
| 6 | 0.0294 | chunking.md#4 | — | Why overlap must not cross sec… | This chunk describes the issue of overlap between sections in a document, partic… | overlap, embedding, markdown, section-boundaries |
| 7 | 0.0291 | project-structure.md#1 | — | Source Tree | This section details the source tree's structure, specifically focusing on the '… | source-tree, indexer, chunking, embeddings |
| 8 | 0.0290 | obsidian.md#4 | — | Frontmatter Fields | This section details the frontmatter fields associated with each chunk of text, … | frontmatter, metadata, chunk-metadata, source-file |
| 9 | 0.0288 | sync.md#2 | — | Backfill logic | This section describes the backfill logic used when a config entry is missing pr… | backfill, provider-inference, config-sync, embedding-schema |
| 10 | 0.0287 | providers.md#0 | — | Embedding Providers | This section details the configuration options for embedding providers within th… | semidex, embedding-providers, config-json, re-indexing |

### Expected Chunk Payload Comparison

**Expected chunk: `providers.md#5`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | Reindex triggers | Reindex triggers |
| context | This section details the impact of modifying configuration settings like `sparseProvider` or `denseModel` in `config.jso… | This section describes the reindexing behavior triggered by changes to provider settings within the configuration file. … |
| tags | reindex, npm-run-index, discriminators, file-hash, dense-provider | reindex, config-json, provider-settings, index-trigger, file-hash, dense-provider, embedding-schema |
| text snippet | Changing `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion` in config.json… | Changing `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion` in config.json… |
| text length (chars) | 333 | 333 |

**Expected chunk: `providers.md#4`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | Provider validation | Provider validation |
| context | This section details provider validation processes, specifically examining the `resolveEnvProviders()` and `_embed()` fu… | This chunk describes the provider validation process within the codebase, specifically focusing on runtime validation us… |
| tags | resolve-env-providers, env-time, embeddings, validation, provider-combination | provider-validation, embeddings, qdrant, metadata, reindex, runtime, env |
| text snippet | Both `resolveEnvProviders()` (env-time) and `_embed()` in `src/core/embeddings.js` (runtime) validat… | Both `resolveEnvProviders()` (env-time) and `_embed()` in `src/core/embeddings.js` (runtime) validat… |
| text length (chars) | 307 | 307 |

### Cause Classification

*Not reproduced — classification is indicative only.*

- combined context changed semantic focus (no direct term loss detected)
- combined tags added noisy off-topic terms: config-json, provider-settings, index-trigger, embedding-schema

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
| 1 | 0.0331 | benchmarking.md#22 | — | Collection Isolation | This section details the isolation of benchmark collections within the Qdrant da… | qdrant, benchmarking, collection-isolation, regression-testing |
| 2 | 0.0325 | benchmarking.md#3 | 2 | 50-query quality benchmark (`b… | This section details the v3 schema of the 50-query quality benchmark, utilizing … | benchmark, retrieval-benchmarks, n-dcg, chunk-recall |
| 3 | 0.0313 | multilingual.md#7 | — | Benchmark Coverage | This section details the custom-50 benchmark, which incorporates Ukrainian, Engl… | benchmark-evaluation, query-language-diversity, sparse-provider, onnx-embedding |
| 4 | 0.0308 | benchmarking.md#2 | **3** | 21-query regression benchmark … | This chunk describes the "stable regression smoke benchmark," a test run using 4… | regression-benchmark, retrieval-testing, smoke-test, fixture-documents |
| 5 | 0.0306 | benchmarking.md#15 | — | Quality 50q benchmark | This chunk describes the execution of a custom benchmark run named "bench:custom… | npm, benchmark, custom-benchmark, performance-testing |
| 6 | 0.0306 | project-structure.md#1 | — | Source Tree | This section details the source tree's directory structure, specifically focusin… | semidex/src/core, config.js, embeddings.js, onnx-embed.js |
| 7 | 0.0290 | benchmarking.md#18 | — | Dense MMR instead of hybrid RR… | This section describes the execution of a custom benchmark using a dense MMR sea… | bench_search_mode, dense_mmr, npm_run |
| 8 | 0.0287 | project-structure.md#2 | — | Source Tree | This section details the source tree, outlining the organization of files relate… | benchmark, harness, evaluation, queries |
| 9 | 0.0286 | project-structure.md#9 | — | Entry Points | This section details the available command-line entry points for the project, ou… | max_tokens, min_tokens, overlap, environment |
| 10 | 0.0286 | benchmarking.md#14 | — | Stable 21q regression benchmar… | This chunk describes the execution of the `npm run bench:retrieval` command, lik… | benchmark, regression-testing, retrieval-performance, npm |

**Combined top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0325 | benchmarking.md#22 | — | Collection Isolation | This section details the collection isolation strategy employed during benchmark… | benchmarking, qdrant, collection-isolation, regression |
| 2 | 0.0320 | benchmarking.md#3 | 2 | 50-query quality benchmark (`b… | This section details the benchmark setup for a v3 schema using a custom dataset,… | benchmark, retrieval, custom-50, query-quality |
| 3 | 0.0318 | multilingual.md#7 | — | Benchmark Coverage | This section details the query types included in the custom-50 benchmark, catego… | benchmark, custom-50, query-testing, ukrainian |
| 4 | 0.0310 | benchmarking.md#17 | — | Skip reindex (reuse existing c… | This chunk describes a specific npm command used for custom benchmarking, specif… | benchmarking, npm, command-line, custom-benchmark |
| 5 | 0.0308 | benchmarking.md#15 | — | Quality 50q benchmark | This chunk describes the execution of a custom benchmark, specifically the `benc… | npm, -script, -benchmark, -performance |
| 6 | 0.0299 | benchmarking.md#16 | — | Force ONNX provider | This chunk describes a command used to benchmark the ONNX provider, specifically… | onnx-provider, benchmarking, benchmark, npm |
| 7 | 0.0297 | project-structure.md#1 | — | Source Tree | This section details the source tree's structure, specifically focusing on the '… | source-tree, indexer, chunking, embeddings |
| 8 | 0.0294 | benchmarking.md#2 | **3** | 21-query regression benchmark … | This chunk details the stable regression smoke benchmark, a test run performed b… | regression-benchmark, smoke-test, retrieval, query-testing |
| 9 | 0.0294 | project-structure.md#9 | — | Entry Points | This section details the entry points for running the application, listing comma… | entry-points, command-line, npm-scripts, qdrant |
| 10 | 0.0292 | benchmarking.md#18 | — | Dense MMR instead of hybrid RR… | This section details benchmark configurations, specifically the `BENCH_SEARCH_MO… | benchmark, dense-mmr, search-benchmark, npm-run |

### Expected Chunk Payload Comparison

**Expected chunk: `benchmarking.md#2`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 21-query regression benchmark (`benchmarks/retrieval/`) | 21-query regression benchmark (`benchmarks/retrieval/`) |
| context | This chunk describes the "stable regression smoke benchmark," a test run using 4 fixture documents and 21 queries to ide… | This chunk details the stable regression smoke benchmark, a test run performed before merges to identify retrieval regre… |
| tags | regression-benchmark, retrieval-testing, smoke-test, fixture-documents, schema-comparison, bench-retrieval, query-regression | regression-benchmark, smoke-test, retrieval, query-testing, v1-v2, fixture-docs, bench-retrieval |
| text snippet | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … |
| text length (chars) | 192 | 192 |

**Expected chunk: `benchmarking.md#3`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… |
| context | This section details the v3 schema of the 50-query quality benchmark, utilizing a richer evaluation harness with graded … | This section details the benchmark setup for a v3 schema using a custom dataset, specifically focused on evaluating retr… |
| tags | benchmark, retrieval-benchmarks, n-dcg, chunk-recall, graded-relevance, collection-name, evaluation-harness | benchmark, retrieval, custom-50, query-quality, recall, ndcg, graded-relevance |
| text snippet | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… |
| text length (chars) | 262 | 262 |

### Cause Classification


- combined context wording drift — exact query tokens absent (no stemming): 21
- combined tags lost useful query-matching terms: query-regression
- combined tags added noisy off-topic terms: retrieval, v1-v2, fixture-docs

## Overall Recommendation

**Not reproduced in this run:** `c04` — regression did not appear; likely LLM output variance. Rerun `bench:custom50:combined` 2-3 times to check consistency.

**Reproduced regressions:** `c41`

**Primary cause: combined tag quality** — combined mode produced tags that lost
query-relevant terms or introduced off-topic terms, reducing BM25/sparse recall.

**Recommendation:** tag normalization tweak — add explicit tag instructions to the
combined prompt to prefer exact technical tokens over paraphrased terms.

**COMBINED_LLM=1 status:** remains opt-in with caution. Do not promote to default
until root cause is resolved or accepted as a known tradeoff.

*Generated: 2026-05-25*