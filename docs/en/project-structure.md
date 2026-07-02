# Project Structure

This document explains where the main semidex components live and which files
are generated at runtime.

## Runtime Entry Points

```text
src/
  indexer/
    index.js         - CLI entry point for indexing files and folders
  mcp/
    server.js        - MCP stdio server used by AI clients
  sync.js            - syncs config.json and Qdrant payload indexes
  smoke.js           - offline smoke tests (thin wrapper over src/smoke/)
  doctor.js          - read-only environment health check (npm run doctor)
  backfill-tags.js   - generate/regenerate payload tags without reindexing
  bootstrap-docs.js  - index semidex's own docs into `semidex-docs`
```

The indexer is the writer side. The MCP server is the reader side. Both use the
shared modules under `src/core/`.

## Tests

```text
tests/
  helpers/setup.js - hermetic env defaults for unit tests
  unit/            - node:test unit tests (core/, indexer/, mcp/)
```

Run with `npm test`. See [testing.md](testing.md) for conventions and the
smoke→unit migration plan. The legacy offline smoke suite lives in
`src/smoke/` until migration completes.

## Core Modules

```text
src/core/
  config.js            - config.json helpers, provider resolution, valid provider combos
  env.js               - env var parsing helpers and provider-combo validation
  embeddings.js        - unified embedding layer for indexing and search
  onnx-embed.js        - BGE-M3 ONNX tokenizer/session/vector extraction
  onnx-paths.js        - ONNX model cache path resolution
  onnx-provider-probe.js - execution-provider (cpu/dml/cuda) probing
  ollama.js            - Ollama REST client for embeddings and LLM generation
  qdrant.js            - Qdrant REST helpers: upsert, search, scroll, indexes, skeleton lookups
  sparse.js            - zero-dependency hashed sparse TF fallback
  rerank.js            - optional deterministic reranker
  ce-rerank.js         - optional cross-encoder reranker (RERANK_CE_ENABLED=1)
  token-count.js       - BGE-M3 tokenizer / heuristic token counting
  length-bucket.js     - length bucketing for DML batch inference
  node-id.js           - deterministic skeleton/structural node IDs
  point-id.js          - deterministic Qdrant point IDs
  doctor-checks.js     - health checks shared by doctor and MCP error sanitising
```

These modules are shared by indexing, MCP tools, sync, and benchmarks. Provider
metadata is resolved here, so changes in this layer can affect both indexing and
query-time retrieval.

## Indexer Pipeline

```text
src/indexer/
  index.js             - pipeline orchestration
  batch.js             - batching helpers
  files.js             - file discovery and format routing
  preflight.js         - fail-fast environment checks before indexing
  profiler.js          - phase timing (INDEX_PROFILE=1)
  semaphore.js / serial-queue.js - concurrency primitives
  skeleton-payload.js  - skeleton nav point payload assembly
  skeleton-warnings.js - skeleton parse warning collection
  phases/
    chunk.js           - structure-aware parsing and chunking (legacy path)
    skeleton.js        - Markdown AST parsing into a skeleton tree
    skeleton-chunk.js  - skeleton-first chunking with structural carryover
    skeleton-index.js  - skeleton nav node generation
    skeleton-summary.js - deterministic/LLM nav summaries (SKELETON_SUMMARY)
    node-policy.js     - structural node emission policy
    empty-section.js   - empty-section placeholder handling
    context.js         - LLM context summaries and boundary merging
    combined.js        - combined context+tags LLM path (COMBINED_LLM=1)
    tag.js             - optional batched semantic tag generation (Ollama)
    tag-onnx.js        - experimental ONNX tag provider (TAG_PROVIDER=onnx)
  workers/
    tag-onnx-worker.js - persistent ONNX CPU tag worker thread
```

Indexing writes Qdrant points with dense and sparse vectors plus payload fields
such as `text`, `context`, `section`, `tags`, `source_file`, `chunk_index`, and
provider metadata.

## MCP Tools

```text
src/mcp/
  server.js
  tools/
    search.js              - hybrid dense+sparse search, optional reranking
    collections.js         - collection list with provider metadata
    getChunk.js            - retrieve one chunk and surrounding window
    findByTag.js           - tag-based lookup grouped by file
    listFiles.js           - unique source files with chunk counts
    listTags.js            - tag inventory with counts and filters
    listDirectories.js     - directory prefixes with file/chunk counts
    getSkeleton.js         - collection skeleton root and children
    getSkeletonNode.js     - one skeleton nav node by id/path
    getSkeletonChildren.js - immediate skeleton children
    getNode.js             - full original structural node content
    filters.js             - shared nav-point exclusion filter helpers
```

AI agents should use these tools to inspect indexed knowledge. `qdrant_search`
returns matched chunk text plus `source_file` and `chunk_index`; use those values
with `qdrant_get_chunk` when surrounding context is needed.

## Documentation

```text
docs/
  README.md
  en/
    README.md
    architecture.md
    retrieval.md
    mcp-tools.md
    configuration.md
    chunking-quality.md
    benchmarking.md
    benchmark-dataset-plan.md
    ce-rerank-design.md
    roadmap.md
    operations.md
    project-structure.md
  ua/
    README.md
    translation-backlog.md
  adr/         - architecture decision records
  design/      - design specs (skeleton-first chunking, pipeline redesign, ...)
  collections/ - collection-specific audits and notes
```

Documentation is grouped by language. English currently has the detailed
component-level docs; Ukrainian currently has the main README.

## Benchmarks

```text
benchmarks/
  retrieval/
    run.js               - 21-query regression benchmark (v1/v2 schema)
    compare.js           - default provider vs ONNX side-by-side
    rerank-matrix.js     - 4-variant rerank matrix (ollama/onnx × ±rerank)
    mmr-matrix.js        - hybrid RRF vs dense MMR diversity evaluation
    queries.json         - 21 queries, v2 schema (stable regression set)
    fixtures/docs/       - 4 shared fixture docs (providers, qdrant, chunking, sync)
    results/             - saved baselines and comparison summaries
    custom-50/
      run-v3.js          - 50-query quality benchmark (v3 schema, graded qrels)
      queries.json       - 50 queries with relevantChunks and graded relevance
      fixtures/docs/     - 6 additional fixture docs (mcp, obsidian, structure, etc.)
      README.md          - custom-50 benchmark docs
    custom-large/
      run.js             - 46-query large-document stress benchmark (v4 schema, anchor-based qrels)
      queries.json       - 46 queries using expectedAnchors resolved at runtime
      fixtures/docs/     - 5 large fixture docs with BENCH_ANCHOR markers
      README.md          - custom-large benchmark docs
    custom-150/          - 150-query validation set (bench:custom150)
    custom-raw/          - raw/unstructured corpus benchmark (bench:custom-raw)
  onnx-*.js              - ONNX provider/worker/tag benchmarks (bench:onnx-*)
```

The retrieval directory also contains diagnostics and live smoke scripts
(`smoke-live*.js`, `duplicate-point-*.js`, combined/tag diagnostics); see
`package.json` scripts for the full command list.

Three benchmark tiers:

- **Regression** (`run.js`, collection `bench-retrieval`): file-level recall, fast,
  run before merges.
- **Quality** (`custom-50/run-v3.js`, collection `bench-retrieval-custom-50`):
  chunk-level graded recall (`chunkRecall@3/5`, `nDCG@K`, `MRR@10`), deeper
  evaluation for provider or schema changes.
- **Stress** (`custom-large/run.js`, collection `bench-retrieval-custom-large`):
  anchor-based qrels on large structured documents; also reports chunking
  guardrails (anchor coverage, oversized chunks, sectionless rate).

## Runtime And Generated Files

```text
config.json   - generated by npm run sync, git-ignored
models/       - ONNX model cache, git-ignored
.tmp/         - temporary files, git-ignored
.env          - local environment, git-ignored
```

These are operational artifacts, not source files. Do not commit them unless a
task explicitly asks for a generated fixture or example.

Tracked examples:

```text
.env.example
config.example.json
```

## Source Of Truth

For indexed knowledge, Qdrant is the live source of truth. Use MCP tools to
inspect indexed data — do not rely on locally generated files as the authoritative
retrieval source.
