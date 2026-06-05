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
  +- [3] Tag            - optional payload tags (TAG_GEN=1 or backfill)
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
- **Deterministic Point IDs**: Every point ID is derived from `uuidv5(collection + source_file + chunk_index + embeddingSchemaVersion)`. This makes every upsert idempotent — reindexing the same logical chunk overwrites the existing point rather than inserting a new one, preventing duplicate accumulation across repeated indexing runs. `file_hash`, tags, context, and model names are intentionally excluded from the ID formula so that content changes overwrite in place without orphaning the old point. After each file is indexed, any trailing points whose `chunk_index` exceeds the new chunk count are deleted to handle files that shrank between indexing runs.

## Phase 1 - Chunk

The parser tries to preserve document structure:

- Markdown headings and sections are respected.
- Body text styled as a heading by Word/pandoc artifacts is kept as content.
- Oversized sections fall back to sentence splitting.
- Sentence overlap is applied after merge/split boundary decisions and is reset
  at section boundaries, so overlap does not leak content from one heading into
  another or duplicate inside merged chunks.
- Very short `.txt` files are preserved instead of being dropped.

### Format-specific behavior

Markdown is the primary input format and has the strongest structural fidelity.
Other formats are best-effort ingestion paths: they rely on text extraction or
third-party conversion before entering the Markdown-oriented chunking pipeline.

| Format | Parser | Section headings | Notes |
|--------|--------|-----------------|-------|
| `.md` | Native | Preserved | Wikilinks, frontmatter, heading hierarchy |
| `.txt` | Native (sentence-based) | None | Plain sentence splitting with overlap |
| `.pdf` | `@opendocsg/pdf2md` → Markdown | Recovered from PDF text layer | See below |
| `.docx`, `.odt`, `.epub`, `.html`, `.htm`, `.rtf` | pandoc → Markdown | Preserved if pandoc can extract them | pandoc converts to Markdown first |

**PDF ingestion:** `@opendocsg/pdf2md` converts PDF to Markdown, then the same `parseMarkdown` path used for `.md` files processes the output. Headings (H1–H6) found in the Markdown become `section` values on chunks. PDFs with a proper text layer (digitally created) typically yield good section coverage. Scanned or image-only PDFs produce weak or no structure; chunks from those files will have `section: ""`. Pandoc does not support PDF as an input format.

Important environment variables:

- `MAX_CHUNK_TOKENS`
- `MIN_CHUNK_TOKENS`
- `OVERLAP_SENTENCES`

## Phase 2 - Contextualize

A chunk extracted from a document is often meaningless without its surroundings —
a code snippet, a rule, or a number that makes sense on the page but loses its
meaning when isolated. The vector computed from such a fragment is just as
meaningless, and no amount of search tuning can recover what was never encoded.

The fix: before embedding, the local LLM reads the chunk and writes a 1-2 sentence
summary of what it means in the document. That summary is prepended to the raw text
before the embedding is computed, so the vector represents the chunk's meaning, not
just its surface tokens. The summary is also stored separately in the `context`
payload field and returned to the agent alongside the raw text.

Example:

```text
It must not exceed 512 bytes.
```

Without context, this is ambiguous. With contextualization it becomes:

```text
The session token in the auth module must not exceed 512 bytes.
```

This approach was developed independently as part of semidex's core design.
Anthropic published a similar technique under the name "Contextual Retrieval" in
September 2024, reporting a ~49% reduction in retrieval failures — which validates
the direction without being the source of it.

## Phase 3 - Tag

Tags are optional payload metadata. They are disabled by default because they do
not affect normal hybrid retrieval: dense/sparse vectors are built from
`context + text`, not from tags.

Enable tags during indexing with `TAG_GEN=1`, or generate them later with:

```bash
COLLECTION=my-docs npm run backfill:tags
```

Tags are useful when a workflow depends on `qdrant_list_tags`,
`qdrant_find_by_tag`, tag-filtered `qdrant_search`, or manual collection audits.

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

## What Is Stored vs What the Agent Sees

`chunks_out/` Markdown files are a **human review artifact only** — they are never
read by the retrieval pipeline or sent to an AI agent. They are written to disk so
you can open them in Obsidian and inspect chunk boundaries, context summaries, tags,
and links visually.

What actually lives in Qdrant for each point:

| Field | Stored in | Used for |
|-------|-----------|----------|
| `dense` vector | named vector | semantic similarity search |
| `sparse` vector | named vector | lexical keyword search |
| `text` | payload | returned to agent as the raw chunk text |
| `context` | payload | returned to agent as the LLM summary of this chunk |
| `section`, `source_file`, `tags` | payload | filtering, reranking, agent display |
| `links`, `backlinks` | payload | graph traversal via `qdrant_related` / `qdrant_backlinks` |
| `chunk_index`, `total_chunks` | payload | context window expansion |
| `file_hash`, provider metadata | payload | skip-unchanged detection, reindex guard |

### Why context + text are embedded together

At index time, the embedding input is:

```
context + "\n\n" + text
```

The LLM-generated `context` is a 1-2 sentence summary of what the chunk means in
the larger document. Embedding it together with the raw `text` means the vector
represents the chunk's **meaning**, not just its surface words.

This matters for sparse or ambiguous chunks. A code snippet like:

```js
super(name, salary)
```

has almost no searchable words on its own. Its context summary — "calls the
superclass constructor in a Manager subclass" — makes the dense vector findable
by natural language queries like "how to call a parent class constructor".

At query time, the search query is embedded with the same provider and matched
against these combined vectors. The agent receives both `context` and `text` as
separate payload fields, so it can read the summary and the raw content together.

### Source of Truth

Qdrant is the live retrieval source of truth. `chunks_out/` is a generated review artifact for humans.

Use MCP tools to inspect indexed data. Use `chunks_out/` to visually inspect chunk boundaries, context summaries, tags, and links.

## Local Models

semidex is designed for local/private knowledge bases:

| Model/runtime | Role |
|---------------|------|
| `gemma3:4b` through Ollama | Context summaries; optional tags when `TAG_GEN=1` and no separate `TAG_MODEL` is set |
| `bge-m3` through Ollama | Default dense embeddings |
| `aapot/bge-m3-onnx` through ONNX Runtime | Dense + neural sparse multilingual embeddings |

No document text needs to leave your machine when using local Qdrant/Ollama/ONNX.
