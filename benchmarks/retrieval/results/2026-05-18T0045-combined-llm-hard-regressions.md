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
| Baseline | 491108 ms | n/a | 11 |
| Combined | 154943 ms | 1 | n/a |

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
| 1 | 0.0328 | qdrant.md#6 | — | getStoredMeta | This section describes the `getStoredMeta` function, which retrieves metadata as… | qdrant, metadata, vector-database, embeddings |
| 2 | 0.0328 | project-structure.md#5 | — | src/core/embeddings.js | This section details the `embeddings.js` file within the `src/core` directory, s… | embeddings, qdrant, schema-versioning, vector-embeddings |
| 3 | 0.0315 | config-env.md#11 | — | config.json | This section describes the `config.json` file, which is automatically managed by… | config-gitignore, gitignore-file, git-repository, version-control |
| 4 | 0.0308 | providers.md#4 | 2 | Provider validation | This section details the provider validation process, specifically focusing on t… | resolve-env-providers, src-core, env-time, validation |
| 5 | 0.0306 | providers.md#5 | **3** | Reindex triggers | This section details a critical configuration change: modifying `sparseProvider`… | reindex, npm-run-index, discriminators, file-hash |
| 6 | 0.0298 | chunking.md#4 | — | Why overlap must not cross sec… | This chunk explains the problem of overlap between sections in semidex, specific… | semantic-context, markdown-heading, embedding-contamination, section-overlap |
| 7 | 0.0294 | benchmarking.md#4 | — | Query Schema Versions | This section is an empty placeholder within the "Query Schema Versions" subsecti… | benchmarking, query-schema, versions, placeholder |
| 8 | 0.0287 | benchmarking.md#23 | — | BENCH_SKIP_INDEX | This section describes the `BENCH_SKIP_INDEX=1` flag, which allows runners to by… | bench-skip-index, index, rerun, matrix |
| 9 | 0.0286 | sync.md#2 | — | Backfill logic | This section details the backfill logic for configuring providers and models, sp… | sync, new, collections, resolve |
| 10 | 0.0283 | project-structure.md#1 | — | Source Tree | This section details the source tree's directory structure, specifically focusin… | semidex/src/core, config.js, embeddings.js, onnx-embed.js |

**Combined top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0331 | project-structure.md#5 | — | src/core/embeddings.js | This chunk describes the `embedForIndex` and `embedForSearch` functions within t… | javascript, embeddings, qdrant, schema-version |
| 2 | 0.0320 | qdrant.md#6 | — | getStoredMeta | This chunk describes the getStoredMeta function in Qdrant, which retrieves metad… | qdrant, stored-meta, metadata, embedding |
| 3 | 0.0313 | providers.md#4 | 2 | Provider validation | This section discusses provider validation within the core embeddings module. It… | provider-validation, embeddings, qdrant, metadata |
| 4 | 0.0306 | config-env.md#11 | — | config.json | This section details the `config.json` file, which is automatically updated by t… | json-config, collection-settings, embeddings, reindex |
| 5 | 0.0303 | sync.md#2 | — | Backfill logic | This chunk details the backfill logic when a config entry lacks provider fields,… | config-sync, provider-inference, backfill-logic, bge-m3-onnx |
| 6 | 0.0300 | chunking.md#4 | — | Why overlap must not cross sec… | This chunk discusses the problem of overlap between chunks, specifically how it … | overlap, embedding, section-boundaries, semidex |
| 7 | 0.0290 | obsidian.md#4 | — | Frontmatter Fields | This chunk defines the metadata fields associated with each chunk generated from… | obsidian-metadata, chunk-metadata, dense-provider, sparse-provider |
| 8 | 0.0288 | benchmarking.md#23 | — | BENCH_SKIP_INDEX | This chunk describes the functionality of the `BENCH_SKIP_INDEX=1` flag, which a… | benchmarking, skip-index, runner, index |
| 9 | 0.0281 | benchmarking.md#4 | — | Query Schema Versions | This section is an empty placeholder within the "Query Schema Versions" subsecti… | benchmarking, schema-versioning, testing, placeholder |
| 10 | 0.0275 | providers.md#0 | — | Embedding Providers | This section discusses the embedding provider support within the Semidex system.… | semidex, embedding-providers, config-json, re-indexing |

### Expected Chunk Payload Comparison

**Expected chunk: `providers.md#5`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | Reindex triggers | Reindex triggers |
| context | This section details a critical configuration change: modifying `sparseProvider`, `denseProvider`, `denseModel`, or `emb… | This chunk describes the reindexing behavior of a collection when the `sparseProvider`, `denseProvider`, `denseModel`, o… |
| tags | reindex, npm-run-index, discriminators, file-hash, provider | reindex, collection, config-json |
| text snippet | Changing `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion` in config.json… | Changing `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion` in config.json… |
| text length (chars) | 333 | 333 |

**Expected chunk: `providers.md#4`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | Provider validation | Provider validation |
| context | This section details the provider validation process, specifically focusing on the `resolveEnvProviders()` and `_embed()… | This section discusses provider validation within the core embeddings module. It highlights the importance of verifying … |
| tags | resolve-env-providers, src-core, env-time, validation, embedding | provider-validation, embeddings, qdrant, metadata, reindex, resolveenvproviders, _embed |
| text snippet | Both `resolveEnvProviders()` (env-time) and `_embed()` in `src/core/embeddings.js` (runtime) validat… | Both `resolveEnvProviders()` (env-time) and `_embed()` in `src/core/embeddings.js` (runtime) validat… |
| text length (chars) | 307 | 307 |

### Cause Classification

- combined context wording drift — exact query tokens absent (no stemming): reindex
- combined tags added noisy off-topic terms: collection, config-json
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
| `benchmarking.md#2` | 5 | 5 | ✓ | ✓ |

> **Note:** hard regression did not reproduce in this run — both baseline and combined
> retrieved the expected chunk within top-5. Payload comparison and cause classification
> are shown for reference only; do not use to draw conclusions about regression cause.

**Baseline top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0331 | benchmarking.md#22 | — | Collection Isolation | This section details the collection isolation strategy used for benchmarking, sp… | collection, bench-retrieval, bench-retrieval-custom-50, isolation |
| 2 | 0.0317 | benchmarking.md#3 | 2 | 50-query quality benchmark (`b… | This section details the implementation of the 50-query quality benchmark, speci… | benchmark, retrieval-system, evaluation-harness, graded-relevance |
| 3 | 0.0315 | multilingual.md#7 | — | Benchmark Coverage | This section details the custom-50 benchmark, which focuses on evaluating the mo… | ukrainian-query, english-query, mixed-queries, cross-file |
| 4 | 0.0311 | benchmarking.md#15 | — | Quality 50q benchmark | This chunk describes the execution of a custom benchmark specifically targeting … | benchmark-custom-50q, npm, benchmarking, performance-testing |
| 5 | 0.0311 | benchmarking.md#2 | **3** | 21-query regression benchmark … | This section details the stable regression smoke benchmark, a pre-merge test uti… | bench-retrieval-collection, retrieval-regressions, merge-detection, schema-version |
| 6 | 0.0308 | project-structure.md#1 | — | Source Tree | This section details the source tree's directory structure, specifically focusin… | semidex/src/core, config.js, embeddings.js, onnx-embed.js |
| 7 | 0.0299 | benchmarking.md#17 | — | Skip reindex (reuse existing c… | This chunk details a specific npm command used in a benchmark test, namely `BENC… | npm, -benchmark, -skipp-reindex, -custom-benchmark |
| 8 | 0.0293 | benchmarking.md#18 | — | Dense MMR instead of hybrid RR… | This chunk describes a specific benchmarking command for evaluating a dense MMR … | benchmark, search, mode, dense |
| 9 | 0.0285 | project-structure.md#2 | — | Source Tree | This section details the source tree structure, outlining the organization of fi… | benchmark, harness, run-v3.js, queries.json |
| 10 | 0.0284 | project-structure.md#9 | — | Entry Points | This section details the available command entry points for the project, listing… | command-line-interface, entry-points, indexing, syncing |

**Combined top-10:**

| rank | score | chunkId | rel | section | context snippet | tags |
|------|-------|---------|-----|---------|-----------------|------|
| 1 | 0.0325 | benchmarking.md#22 | — | Collection Isolation | This section describes the collection isolation strategy used during benchmarkin… | benchmarking, qdrant, collection-isolation, regression |
| 2 | 0.0325 | multilingual.md#7 | — | Benchmark Coverage | This chunk details the different query types used in the custom-50 benchmark, ca… | benchmark-coverage, custom-50, query-types, ukrainian-language |
| 3 | 0.0321 | benchmarking.md#3 | 2 | 50-query quality benchmark (`b… | This chunk details the evaluation harness used in the custom-50 benchmark, focus… | benchmarking, evaluation-harness, qdrant-hybrid-search, v3-schema |
| 4 | 0.0308 | benchmarking.md#15 | — | Quality 50q benchmark | This chunk describes the execution of a custom benchmark script, specifically `n… | benchmark, npm, benchmarking, custom50 |
| 5 | 0.0301 | benchmarking.md#2 | **3** | 21-query regression benchmark … | This chunk describes the stable regression smoke benchmark, a test run before me… | benchmark, regression, smoke-test, query |
| 6 | 0.0299 | benchmarking.md#17 | — | Skip reindex (reuse existing c… | This chunk describes a specific npm command used for a custom benchmark run, spe… | npm, benchmarking, benchmark, custom-benchmark |
| 7 | 0.0298 | project-structure.md#1 | — | Source Tree | This section details the source tree's directory structure, specifically focusin… | source-tree, indexer, chunking, embeddings |
| 8 | 0.0290 | benchmarking.md#12 | — | Latency | This chunk presents latency metrics used to evaluate the performance of a query … | latency, performance, metrics, query-latency |
| 9 | 0.0287 | project-structure.md#9 | — | Entry Points | This section details the entry points for running the application, providing a t… | command-line, npm-scripts, index, sync |
| 10 | 0.0286 | benchmarking.md#14 | — | Stable 21q regression benchmar… | This chunk describes the execution of the `npm run bench:retrieval` command, lik… | benchmarking, npm, regression-test, retrieval-benchmark |

### Expected Chunk Payload Comparison

*Not reproduced — classification is indicative only.*

**Expected chunk: `benchmarking.md#2`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 21-query regression benchmark (`benchmarks/retrieval/`) | 21-query regression benchmark (`benchmarks/retrieval/`) |
| context | This section details the stable regression smoke benchmark, a pre-merge test utilizing 4 fixture documents and 21 querie… | This chunk describes the stable regression smoke benchmark, a test run before merges to identify retrieval regressions u… |
| tags | bench-retrieval-collection, retrieval-regressions, merge-detection, schema-version, query-testing | benchmark, regression, smoke-test, query, retrieval, v1-v2, bench-retrieval |
| text snippet | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … | The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries in v1/v2 schema. It is … |
| text length (chars) | 192 | 192 |

**Expected chunk: `benchmarking.md#3`**

| Field | Baseline | Combined |
|-------|----------|----------|
| section | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… | 50-query quality benchmark (`benchmarks/retrieval/custom-50/… |
| context | This section details the implementation of the 50-query quality benchmark, specifically focusing on version 3 schema uti… | This chunk details the evaluation harness used in the custom-50 benchmark, focusing on the v3 schema and graded relevanc… |
| tags | benchmark, retrieval-system, evaluation-harness, graded-relevance, ndcg, chunk-recall, collection-name | benchmarking, evaluation-harness, qdrant-hybrid-search, v3-schema, graded-relevance, recall, ndcg |
| text snippet | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… | A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevanc… |
| text length (chars) | 262 | 262 |

### Cause Classification

*Not reproduced — classification is indicative only.*

- combined context changed semantic focus (no direct term loss detected)
- combined tags lost useful query-matching terms: query-testing
- combined tags added noisy off-topic terms: smoke-test, retrieval, v1-v2, bench-retrieval

## Overall Recommendation

**Not reproduced in this run:** `c41` — regression did not appear; likely LLM output variance. Rerun `bench:custom50:combined` 2-3 times to check consistency.

**Reproduced regressions:** `c04`

**Primary cause: combined tag quality** — combined mode produced tags that lost
query-relevant terms or introduced off-topic terms, reducing BM25/sparse recall.
The combined context also shows wording drift around exact technical tokens (no stemming
in BM25 means `reindex` vs `reindexing` are distinct tokens), further weakening sparse recall.

**Recommendation:** tag normalization tweak — add explicit tag instructions to the
combined prompt to prefer exact technical tokens over paraphrased terms.

**COMBINED_LLM=1 status:** remains opt-in with caution. Do not promote to default
until root cause is resolved or accepted as a known tradeoff.

*Generated: 2026-05-18*
