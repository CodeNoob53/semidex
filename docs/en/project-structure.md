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
  admin/
    server.js        - operator UI and application HTTP/SSE server; mounts
                       the versioned Ask route via registerAskRoutesV1()
  sync.js            - syncs config.json and Qdrant payload indexes
  smoke.js           - offline smoke tests (thin wrapper over src/smoke/)
  doctor.js          - read-only environment health check (npm run doctor)
  backfill-tags.js   - generate/regenerate payload tags without reindexing
  bootstrap-docs.js  - index semidex's own docs into `semidex-docs`
```

The indexer is the writer side. The MCP server exposes retrieval primitives to
external agents. The admin/application server operates collections and hosts
the versioned `POST /api/v1/ask` runtime for application clients (contract
owned by `src/core/ask-api/v1/`, outside `src/admin/` — see Core Modules
below). All three use shared modules under `src/shared/core/` and
`src/core/`; external integrations should target `src/core/ask-api/v1/`
directly rather than importing admin UI modules.

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

`src/shared/core/` holds top-level modules the real import graph confirms
are reachable from BOTH Full and Lite composition roots — physically
relocated there from `src/core/` in Phase 8B Step 7A (a pure `git mv` +
import-path-update step, no behavior change). `src/core/` still holds
every subdirectory (`ask/`, `ask-api/`, `assembly/`, `embedding-profile/`,
`generation/`, `http/`, `qdrant/`, `retrieval/`, `settings/`, `storage/`
— out of scope for that step) plus the handful of top-level files that
are genuinely `local`-classified (real local-runtime implementation, not
a shared contract) or a transitional lazy-shim seam.

```text
src/shared/core/
  config.js            - config.json helpers, provider resolution, valid provider combos
  env.js               - env var parsing helpers and provider-combo validation
  env-bootstrap.js      - env snapshot/dotenv-load helpers (OS env vs .env provenance)
  embeddings.js        - unified embedding layer for indexing and search
  onnx-embed-capability.js - OnnxEmbedCapability contract (loadOnnx/loadOnnxBatch/shutdown)
  onnx-paths.js        - ONNX model cache path resolution (path constants only, not local-only)
  qdrant.js            - stable facade over the Qdrant adapter (re-exports src/core/qdrant/)
  sparse.js            - zero-dependency hashed sparse TF fallback
  rerank-capability.js - RerankCapability contract (rerankResults/ceRerank), zero backend imports
  token-count.js       - BGE-M3 tokenizer / heuristic token counting
  bge-tokenizer.js      - the real BGE-M3 tokenizer load path (via @huggingface/tokenizers)
  node-id.js           - deterministic skeleton/structural node IDs
  point-id.js          - deterministic Qdrant point IDs
  entity-reference.js   - structural entity-reference placeholder format/matcher
  doctor-checks.js     - health checks shared by doctor and MCP error sanitising
  bench-telemetry.js    - opt-in benchmark instrumentation (SEMIDEX_BENCH_TELEMETRY)
  app-data-dir.js       - neutral, edition-agnostic per-user app-data directory resolver

src/core/
  onnx-embed-lazy.js   - lazy seam to the real ONNX embedding implementation (local/)
  ollama-lazy.js        - lazy seam to the real Ollama client implementation (local/)
  rerank.js            - optional deterministic reranker (real local-runtime implementation)
  ce-rerank.js         - optional cross-encoder reranker (RERANK_CE_ENABLED=1)
  rerank-provider.js    - the RerankCapability factory (imports rerank.js/ce-rerank.js)
  qdrant/
    client.js          - lazy @qdrant/js-client-rest client, cache reset, error helpers
    store.js           - all network operations: upsert, search, scroll, indexes, skeleton lookups
    payload.js         - pure payload helpers (isSemidexPayload) and field constants
    schema.js          - canonical vector schema + required payload indexes (single source of truth)
    index.js           - adapter public surface
  ask/                 - retrieval evidence, grounded prompt, citations, coordinator
                         (transport-neutral — no HTTP/SSE concerns)
  ask-api/v1/          - the versioned, application-facing public Ask
                         contract (constants, request validation, event
                         projection, route registration); the only module
                         that knows the public wire shape
  generation/          - provider-neutral generation contract, the Ollama
                         implementation, and the runtime seam (the Gemini
                         implementation itself lives under src/cloud/, see below)
  http/                - generic node:http JSON/SSE primitives shared by
                         every HTTP route (admin API and ask-api/v1 alike)
```

These modules are shared by indexing, MCP tools, sync, and benchmarks. Provider
metadata is resolved here, so changes in this layer can affect both indexing and
query-time retrieval.

The real local-runtime implementations these two lazy seams reach —
`onnx-embed.js`/`onnx-runtime.js`/`onnx-probe-runner.js`/
`onnx-provider-probe.js`/`length-bucket.js` (ONNX embedding) and
`ollama.js`/`ollama-models.js` (Ollama) — live under `src/local/core/`,
the same physically-separated tree `tag-onnx.js` moved into (see the
Indexer Pipeline section below). `onnx-embed.js` exports an
instance-scoped capability factory, `createOnnxEmbeddingCapability()` —
its session/tokenizer/in-flight-load/provider-fallback state lives in
each factory call's own closure, never at module scope, so two
independently-composed callers in one process (e.g. Full and Lite
constructed sequentially) never share or contaminate each other's ONNX
runtime. `ollama.js` itself is a stateless REST client (no session to
own); Ollama's own instance-scoped injection lives one layer up, in the
five indexer-phase modules that consume it (Step 3's design — each takes
its Ollama capability as a real parameter resolved once per `run.js`
call, with no module-scope binding of its own). Semidex Lite's
cloud-only package never ships `src/local/`.

## Cloud Providers

```text
src/cloud/
  embedding/
    qdrant-cloud-catalog.js   - checkEmbedInputFits/fitContextToBudget (real per-model
                                tokenizer), buildCloudQueryInputs, resolveEmbeddingBudget
    qdrant-cloud-models.js    - pure catalog data (dense/sparse model lists, zero dependencies)
    qdrant-cloud-tokenizer.js - per-model @huggingface/tokenizers loader (tokenizer.json only,
                                never model weights or an inference runtime)
  generation/
    gemini-provider.js  - createGeminiProvider(), the Gemini GenerationProvider (@google/genai SDK)
    gemini-models.js    - discoverGeminiModels(), Gemini model discovery/listing
  admin/
    qdrant-cloud-api.js    - POST /api/system/qdrant-cloud-probe route wiring
    qdrant-cloud-system.js - Tier 1 (checkQdrantReachable)/Tier 2 (probeQdrantCloudInference)
                             probe logic and 4-status classification
```

Unlike `src/local/` (Full-only, excluded from Semidex Lite), `src/cloud/`
ships in BOTH editions — Semidex Lite is cloud-only by design (Qdrant
Cloud Inference + Gemini), so every file here is reachable from, and
required by, both Full and Lite composition roots. No `*-lazy.js` shim
exists for any of these seven files: every consumer (`shared/core/embeddings.js`,
`core/retrieval/search.js`, `core/embedding-profile/{resolve,availability}.js`,
`shared/core/token-count.js`, `shared/core/config.js`, `core/settings/definitions.js`,
`core/generation/registry.js`, `shared/indexer/run.js`,
`admin/register-neutral-routes.js`, `admin/api/generation-models.js`,
`admin/ui-src/global-settings-view.js`) imports the real file directly,
at its `src/cloud/` path, in both editions identically. `qdrant-cloud-models.js`
is pure, zero-dependency data — the Admin Settings UI (browser bundle)
imports it directly, alongside every server-side consumer.

## Indexer Pipeline

`src/shared/indexer/` holds the edition-neutral indexing pipeline —
physically relocated there from `src/indexer/` in Phase 8B Step 7B (a
pure `git mv` + import-path-update step, no behavior change): every file
the real import graph confirms is Full- and Lite-reachable, capability-
injected, and never loads ONNX/Ollama/Transformers directly. `src/indexer/`
still holds the two edition-specific composition roots (Full builds real
capabilities; Lite builds typed-unavailable stubs), the backward-
compatible CLI launcher alias, and the one remaining lazy-shim pair for
the local ONNX tag-generation worker.

```text
src/shared/indexer/
  index-runtime.js     - shared CLI runtime (bootstrap env, settings, run()) both index-full.js/index-lite.js call
  batch.js             - batching helpers
  files.js             - file discovery and format routing
  preflight.js         - fail-fast environment checks before indexing
  profiler.js          - phase timing (INDEX_PROFILE=1)
  semaphore.js / serial-queue.js - concurrency primitives
  skeleton-payload.js  - skeleton nav point payload assembly
  skeleton-warnings.js - skeleton parse warning collection
  run.js               - pipeline orchestration (stageA-D, main())
  phases/
    chunk.js           - structure-aware parsing and chunking (legacy path)
    skeleton.js        - Markdown AST parsing into a skeleton tree
    skeleton-chunk.js  - skeleton-first chunking with structural carryover
    skeleton-index.js  - skeleton nav node generation
    skeleton-summary.js - deterministic/LLM nav summaries (SKELETON_SUMMARY)
    node-policy.js     - structural node emission policy
    empty-section.js   - empty-section placeholder handling
    entity-split.js    - token-aware splitting of oversized structural entities
    context.js         - LLM context summaries and boundary merging
    combined.js        - combined context+tags LLM path (COMBINED_LLM=1)
    tag.js             - optional batched semantic tag generation (Ollama)
    tag-provider.js    - pure TAG_PROVIDER=onnx predicate, no fork()/worker dependency
    tag-onnx-capability.js - TagOnnxCapability contract (zero backend imports)
    token-budget-split.js - neutral, format-agnostic oversized-unit splitting

src/indexer/
  index.js             - backward-compatible CLI launcher alias (delegates to index-full.js)
  index-full.js         - Full composition root: builds real *-lazy.js-backed capabilities
  index-lite.js         - Lite composition root: builds typed-unavailable capability stubs
  phases/
    tag-onnx-lazy.js    - lazy seam to the real ONNX tag implementation (local/)
    tag-onnx-lazy.lite.js - Lite package-build staging replacement (dead code today, never staged)
```

The real ONNX tag-generation implementation
(`src/local/indexer/phases/tag-onnx.js`, experimental,
`TAG_PROVIDER=onnx`, plus its persistent worker,
`src/local/indexer/workers/tag-onnx-worker.js`) lives under `src/local/` —
Semidex's physically-separated tree for local-only runtime code (Ollama,
ONNX embedding, ONNX tagging) that Semidex Lite's cloud-only package never
ships. `tag-onnx-lazy.js` above is the one dynamic-import seam shared code
reaches it through.

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
