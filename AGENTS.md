# Agent Instructions

semidex is a local-first RAG memory system for AI agents. It has two runtime
entry points:

- **Indexer** - writes documents into Qdrant.
- **MCP server** - reads indexed knowledge for agents.

They share the same core provider, config, graph, chunking, and Qdrant helpers.

## Core Commands

```bash
COLLECTION=my-docs npm run index <file|folder>  # index documents
npm run mcp                                      # start MCP server (stdio)
npm run sync                                     # sync config.json + Qdrant indexes
npm run smoke                                    # offline smoke tests
npm run bench:retrieval                          # live retrieval benchmark
npm run bench:retrieval:compare                  # side-by-side provider comparison
npm run bench:retrieval:rerank                   # 4-variant rerank matrix
```

Do not run `npm run index` without `COLLECTION` set. The indexer will exit with
a usage error.

## Source of Truth

For indexed knowledge, **Qdrant is the source of truth**. Use the MCP tools
instead of reading generated files from `chunks_out/`.

`chunks_out/` is only a human review artifact for Obsidian-compatible quality
control. It can be stale, incomplete, or generated from an older indexing pass.

For repository implementation work, it is fine to read and edit source files and
docs directly.

## Documentation Layout

Detailed documentation lives in `docs/`:

- `docs/README.md` - language entry point
- `docs/en/README.md` - English documentation index
- `docs/ua/README.md` - Ukrainian README

English deep-dive files:

| File | Covers |
|------|--------|
| `docs/en/architecture.md` | Indexer pipeline, phases, local models, graph |
| `docs/en/retrieval.md` | Hybrid search, RRF, providers, reranking |
| `docs/en/obsidian.md` | `chunks_out/` review console |
| `docs/en/mcp-tools.md` | MCP tool reference and agent workflow |
| `docs/en/configuration.md` | All env vars grouped by concern |
| `docs/en/benchmarking.md` | Smoke tests, metrics, regression workflow |
| `docs/en/project-structure.md` | Source tree, runtime entry points, generated files |
| `docs/en/operations.md` | Usage, limitations, troubleshooting |

Prefer English docs for implementation details unless the user explicitly asks
for Ukrainian text or wording.

## Recommended MCP Workflow

Start every knowledge-base investigation with:

```text
qdrant_collection_info
```

Use it to see available collections, point counts, descriptions, and provider
metadata. Then follow this workflow:

```text
qdrant_search
  -> qdrant_get_chunk(window=1 or 2)
  -> qdrant_related / qdrant_backlinks
  -> qdrant_find_by_tag when narrowing by topic
```

Search returns the matched chunk text plus `source_file` and `chunk_index`. If
the result will be used for an implementation decision, always retrieve
surrounding context with `qdrant_get_chunk(..., window=1)` or `window=2`.

## MCP Tools

| Goal | Tool |
|------|------|
| List collections and provider metadata | `qdrant_collection_info()` |
| Find chunks by topic | `qdrant_search(query, collection)` |
| Search inside one file | `qdrant_search(query, collection, source_file=...)` |
| Filter by tags | `qdrant_search(query, collection, tags=[...])` |
| Read a chunk with neighbors | `qdrant_get_chunk(collection, source_file, chunk_index, window=1)` |
| Find chunks with a tag | `qdrant_find_by_tag(collection, tag)` |
| See outgoing semantic links | `qdrant_related(collection, source_file)` |
| See incoming semantic links | `qdrant_backlinks(collection, source_file)` |

Tag filters are OR across tags. Combining `tags` with `source_file` narrows to
chunks in that file matching any requested tag.

## Search Tactics For Agents

- Use both natural-language and exact-token queries when needed. Example:
  search for `how provider mismatch is handled`, then search for
  `denseProvider sparseProvider embedding_schema_version`.
- For config, CLI, or code questions, include exact identifiers:
  `ONNX_EMBED`, `RRF_K`, `HYBRID_PREFETCH_LIMIT`, `source_file`, function names,
  env vars, or section titles.
- If a result is relevant but too narrow, call `qdrant_get_chunk` with a window
  before acting on it. Use the `source_file` and `chunk_index` shown in the
  search result.
- If the task involves dependencies between documents, follow `qdrant_related`
  and `qdrant_backlinks`; search only gives local chunk relevance.
- If multiple collections exist, do not assume the first collection is correct.
  Use collection descriptions and source files to choose.
- For ambiguous tasks, gather at least two supporting hits or one hit plus its
  surrounding chunks before making a claim.
- Prefer `source_file` filters once a likely file is known. This reduces noise
  and makes follow-up chunk reads deterministic.
- For "why did search return this?" questions, inspect provider metadata,
  section, tags, and exact token overlap before changing ranking logic.

## Retrieval Model

`qdrant_search` uses hybrid retrieval by default:

- **Dense vector** - semantic similarity for meaning and paraphrases.
- **Sparse vector** - lexical matching for exact terms and technical tokens.
- **RRF fusion** - combines dense and sparse rankings without mixing raw scores.

Old collections without sparse vectors still work through dense-only fallback.
Run `npm run sync` to backfill config and ensure required indexes.

Optional reranking is controlled by `RERANK_ENABLED=1`. It is off by default.
Use benchmark results before enabling it for a collection or workflow.

## Provider Awareness

Indexing and search must use matching provider metadata. semidex stores provider
config in both `config.json` and Qdrant payload.

Valid provider combinations:

| Dense provider | Sparse provider | Notes |
|----------------|-----------------|-------|
| `ollama` | `hashed-tf` | Default, light setup |
| `bge-m3-onnx` | `bge-m3-onnx` | Multilingual dense + neural sparse, `ONNX_EMBED=1` |

Mixed combinations are rejected at runtime.

Changing `denseProvider`, `denseModel`, `sparseProvider`,
`embeddingSchemaVersion`, or `vectorSize` requires reindexing. Do not treat wrong
search results as ranking bugs until provider metadata has been checked.

## `config.json`

`config.json` is generated by `npm run sync` and git-ignored. Current schema:

```json
{
  "collections": {
    "my-docs": {
      "denseProvider": "ollama",
      "denseModel": "bge-m3",
      "sparseProvider": "hashed-tf",
      "embeddingSchemaVersion": 2,
      "vectorSize": 1024,
      "description": "Project architecture documentation"
    }
  }
}
```

Safe manual edits:

- `description`
- provider/model fields only when you intend to force a full reindex

Do not hand-edit `vectorSize` to make errors disappear. It must match the actual
Qdrant vector schema.

## Qdrant Payload Schema

Every indexed point has payload similar to:

```json
{
  "text": "raw chunk text",
  "context": "1-2 sentence LLM summary of what this chunk is about",
  "section": "heading this chunk belongs to",
  "source_file": "relative/path/to/file.md",
  "tags": ["tag-one", "tag-two"],
  "links": ["other/file.md"],
  "backlinks": ["file/that/links/here.md"],
  "chunk_index": 0,
  "total_chunks": 12,
  "file_hash": "sha256...",
  "dense_provider": "ollama",
  "dense_model": "bge-m3",
  "sparse_provider": "hashed-tf",
  "embedding_schema_version": 2,
  "vector_size": 1024
}
```

`source_file` is relative to `SOURCE_ROOT` when set, otherwise to the indexed
folder. Use `source_file + chunk_index` as the stable way to retrieve context.

## Graph Files

Semantic links are stored per collection in `graph.<collection>.json`.

The graph stores file-level links/backlinks only. It does not store chunk text.
To read linked content, use `qdrant_search` or `qdrant_get_chunk` after resolving
the linked `source_file`.

`qdrant_related` and `qdrant_backlinks` read graph files, while search reads
Qdrant.

## Required Qdrant Payload Indexes

These payload indexes are required for filters:

| Field | Type |
|-------|------|
| `source_file` | keyword |
| `tags` | keyword |

New collections create them automatically. For existing or remote collections,
run:

```bash
npm run sync
```

## What Not To Do

- Do not use `chunks_out/` as live retrieval truth.
- Do not answer questions about indexed documents by reading generated review
  files when MCP tools are available.
- Do not assume dense-only behavior; hybrid dense + sparse retrieval is the
  current default.
- Do not mix embedding providers for the same collection.
- Do not manually change `vectorSize` or schema fields to avoid reindexing.
- Do not commit generated `config.json`, `graph.<collection>.json`, model cache,
  or `chunks_out/` output unless explicitly requested.
