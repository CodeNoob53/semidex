# Project Structure

semidex is a local-first RAG memory system. The codebase is split into a core
library, an indexer pipeline, an MCP server, and a benchmark harness.

## Source Tree

```
semidex/
├── src/
│   ├── core/
│   │   ├── config.js          # config.json read/write, resolveEnvProviders()
│   │   ├── embeddings.js      # embedForIndex(), embedForSearch(), SCHEMA_VERSION
│   │   ├── onnx-embed.js      # BGE-M3 ONNX tokenizer and session
│   │   ├── qdrant.js          # Qdrant REST client (search, upsert, scroll, etc.)
│   │   ├── rerank.js          # BM25 local reranker, rerankResults()
│   │   └── smoke.js           # Connectivity smoke test for Qdrant + providers
│   ├── indexer/
│   │   ├── index.js           # CLI entry point: parse args, iterate files
│   │   └── phases/
│   │       ├── chunk.js       # chunkFile(), splitSentences(), parseMarkdown()
│   │       ├── context.js     # LLM chunk contextualization
│   │       ├── embed.js       # Batch embedding phase
│   │       └── tag.js         # LLM tag generation phase
│   ├── mcp/
│   │   ├── server.js          # MCP server entry point
│   │   └── tools/
│   │       ├── search.js      # qdrant_search, qdrant_get_chunk, qdrant_find_by_tag
│   │       ├── list.js        # qdrant_list_files, qdrant_list_directories
│   │       └── info.js        # qdrant_collection_info
│   └── sync.js                # Sync config.json with live Qdrant collections
├── benchmarks/
│   ├── retrieval/
│   │   ├── run.js             # 21-query regression benchmark (v1/v2 schema)
│   │   ├── compare.js         # Side-by-side ollama vs onnx
│   │   ├── rerank-matrix.js   # 4-variant rerank matrix
│   │   ├── mmr-matrix.js      # MMR diversity matrix
│   │   ├── queries.json       # Stable 21-query regression set
│   │   └── fixtures/docs/     # 4 fixture docs: providers, qdrant, chunking, sync
│   └── retrieval/custom-50/
│       ├── run-v3.js          # Quality benchmark runner (v3 schema, graded qrels)
│       ├── queries.json       # 50-query evaluation set
│       └── fixtures/docs/     # 8-10 fixture docs covering all semidex subsystems
├── docs/
│   ├── README.md              # Language selector (EN / UA)
│   └── en/
│       ├── README.md          # EN documentation entry point
│       ├── architecture.md    # Pipeline overview, data flow
│       ├── configuration.md   # All environment variables and config.json
│       ├── retrieval.md       # Hybrid search, RRF, MMR, reranking
│       ├── benchmarking.md    # Benchmark harness guide
│       ├── mcp-tools.md       # MCP server tool reference
│       ├── operations.md      # Day-to-day operations guide
│       └── project-structure.md # Full source tree reference
├── models/                    # ONNX model cache (git-ignored)
├── config.json                # Per-collection provider metadata (git-ignored)
├── .env                       # Environment variables (git-ignored)
├── package.json
└── AGENTS.md                  # AI agent instructions for semidex development
```

## Key Modules

### src/core/config.js

Reads and writes `config.json`. Exports `resolveEnvProviders()` which maps
environment variables (`ONNX_EMBED`, `DENSE_PROVIDER`, `SPARSE_PROVIDER`, `DENSE_MODEL`)
to canonical provider names. This is the single source of truth for provider resolution.

### src/core/embeddings.js

Exports `embedForIndex(collection, text)` and `embedForSearch(collection, text)`.
Both return `{ dense, sparse, meta }`. `SCHEMA_VERSION` is a constant incremented
when the embedding schema changes; it is stored in Qdrant payloads as
`embedding_schema_version` and used as a reindex discriminator.

### src/core/qdrant.js

All Qdrant REST calls go through this module. Key exports:
- `hybridSearch(collection, dense, sparse, limit, filter)` — RRF fusion query
- `mmrSearch(collection, dense, limit, filter, opts)` — dense MMR query
- `scroll(collection, filter, limit, withPayload)` — paginated point retrieval
- `getStoredMeta(collection, sourceFile)` — reads six reindex discriminator fields
- `createCollection(name, size)` — creates collection with dense + sparse vectors

### src/indexer/phases/chunk.js

Exports `chunkFile(filePath, text, sourceFile)`. Returns an array of chunk objects
with `text`, `section`, `chunkIndex`, `totalChunks`. Controlled by `MAX_CHUNK_TOKENS`,
`MIN_CHUNK_TOKENS`, and `OVERLAP_SENTENCES` env vars.

### src/mcp/server.js

Entry point for the MCP server. Tools are implemented in `src/mcp/tools/`:
`qdrant_search`, `qdrant_collection_info`, `qdrant_get_chunk`,
`qdrant_list_files`, `qdrant_list_directories`, `qdrant_find_by_tag`.
The server name registered in MCP clients is `qdrant` (legacy name), but the
project is called semidex.

## Entry Points

| Command | Module | Purpose |
|---------|--------|---------|
| `npm run index` | `src/indexer/index.js` | Index files into Qdrant |
| `npm run sync` | `src/sync.js` | Sync config.json with Qdrant |
| `npm run smoke` | `src/core/smoke.js` | Verify connectivity |
| `npm run mcp` | `src/mcp/server.js` | Start MCP server |
| `npm run bench:retrieval` | `benchmarks/retrieval/run.js` | Run 21q regression benchmark |
| `npm run bench:custom50` | `benchmarks/retrieval/custom-50/run-v3.js` | Run 50q quality benchmark |
