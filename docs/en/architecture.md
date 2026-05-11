# Architecture

semidex has two runtime entry points:

- **Indexer** - writes documents into Qdrant.
- **MCP server** - reads indexed knowledge for AI agents.

Both share the same core provider, config, graph, and Qdrant helpers.

## Pipeline

```text
Documents (md, pdf, docx, epub, txt, ...)
  |
  +- [1] Chunk          - structure-aware: headings -> sentences -> boundary check
  +- [2] Contextualize  - LLM writes a 1-2 sentence summary per chunk
  +- [3] Tag            - LLM generates semantic tags per chunk
  +- [4] Embed + Upsert - dense vector + sparse vector -> Qdrant point
  +- [5] Link           - semantic graph: top-N neighbors, bidirectional
       |
       v
  Qdrant collection
  (dense, sparse, text, section, tags, context, source_file, graph edges)
       |
       +-> chunks_out/ Markdown review files for Obsidian
       |
       v
  MCP tools
       |
       v
  AI agent retrieves precise context
```

## Qdrant Data Model

semidex uses Qdrant as its primary retrieval index and storage backend.

- **Collection**: Represents a single semidex knowledge base.
- **Point**: Represents exactly one indexed chunk from a document.
- **Named Vectors**: Each point stores two distinct vectors:
  - `dense`: Captures semantic meaning for paraphrase and conceptual search.
  - `sparse`: Captures exact lexical tokens for keyword matching.
- **Payload Schema**: In addition to vectors, Qdrant stores a JSON payload for each point (containing the raw `text`, LLM `context`, `section`, `source_file`, `tags`, graph `links`, `backlinks`, `chunk_index`, `total_chunks`, `file_hash`, and provider metadata). This payload is crucial because it provides all the text and metadata the MCP server needs to answer queries without reading files from disk.
- **Payload Indexes**: To efficiently filter searches by specific attributes, Qdrant relies on payload indexes. semidex requires indexes on `source_file` (keyword), `tags` (keyword), and `chunk_index` (integer) to support accurate context windows and agent MCP tools.
- **Reindexing**: Changing the embedding providers (`denseProvider`, `sparseProvider`), embedding models (`denseModel`), embedding schema version, or `vectorSize` fundamentally alters the vector schema. Because query vectors must perfectly match stored point vectors, any such change requires a full collection reindex. Conversely, changes to a `file_hash` trigger an automatic reindex of only the affected file.

## Phase 1 - Chunk

The parser tries to preserve document structure:

- Markdown headings and sections are respected.
- Body text styled as a heading by Word/pandoc artifacts is kept as content.
- Oversized sections fall back to sentence splitting.
- Sentence overlap is reset at section boundaries, so overlap does not leak content from one heading into another.
- Very short `.txt` files are preserved instead of being dropped.

Important environment variables:

- `MAX_CHUNK_TOKENS`
- `MIN_CHUNK_TOKENS`
- `OVERLAP_SENTENCES`

## Phase 2 - Contextualize

The local LLM writes a short context summary for every chunk. This is stored in the `context` payload field and embedded together with the raw text.

Example problem it solves:

```text
It must not exceed 512 bytes.
```

Without context, this is ambiguous. With contextualization it can become:

```text
The session token in the auth module must not exceed 512 bytes.
```

## Phase 3 - Tag

The same local LLM generates semantic tags for each chunk. Tags are batched for speed and are later usable through `qdrant_search` filters or `qdrant_find_by_tag`.

## Phase 4 - Embed + Upsert

For each chunk, semidex embeds:

```text
context + "\n\n" + text
```

Each Qdrant point stores:

- `dense` named vector
- `sparse` named vector
- raw `text`
- `context`
- `section`
- `source_file`
- `tags`
- `links`
- `backlinks`
- `chunk_index`
- `total_chunks`
- `file_hash`
- provider metadata

## Phase 5 - Link

The linker searches for semantically similar chunks and creates file-level links/backlinks:

- links are stored in Qdrant payload
- the file-level graph is stored in `graph.<collection>.json`
- stale edges are removed when a file is reindexed

The graph powers:

- `qdrant_related`
- `qdrant_backlinks`
- reranker backlink boost
- Obsidian review frontmatter

## Source of Truth

Qdrant is the live retrieval source of truth. `chunks_out/` is a generated review artifact for humans.

Use MCP tools to inspect indexed data. Use `chunks_out/` to visually inspect chunk boundaries, context summaries, tags, and links.

## Local Models

semidex is designed for local/private knowledge bases:

| Model/runtime | Role |
|---------------|------|
| `gemma3:4b` through Ollama | Context summaries and tags |
| `bge-m3` through Ollama | Default dense embeddings |
| `aapot/bge-m3-onnx` through ONNX Runtime | Dense + neural sparse multilingual embeddings |

No document text needs to leave your machine when using local Qdrant/Ollama/ONNX.

