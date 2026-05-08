# Indexer

Automated pipeline for indexing document collections into a vector database, enabling AI assistants to navigate large knowledge bases without reading entire files.

## The Problem

Large documentation sets (100–150+ pages) don't fit in an LLM context window. Feeding entire files wastes tokens and degrades response quality. Without structure, an AI assistant has no way to find *the specific paragraph* relevant to a task — it either reads everything or guesses.

## The Solution

Indexer processes your documents into semantically structured chunks stored in [Qdrant](https://qdrant.tech/). An AI with MCP access to the database can retrieve only the relevant chunks for a given task — getting precise, context-aware answers without touching the rest of the collection.

## Use Cases

**AI-assisted project execution**
Load a 150-page technical specification. Ask an AI to implement section 3.2. It queries the database for only the relevant architecture decisions, data models, and constraints — and produces code that matches *your* project, not a generic tutorial.

**Knowledge base navigation**
Index your Obsidian vault or documentation folder. The AI discovers connections between documents through semantic links and backlinks — similar to Obsidian's graph view, but queryable.

**Multi-document cross-referencing**
The linker phase searches across all collections. If a chunk references a concept documented elsewhere, a bidirectional link is created automatically — so the AI knows where to look next.

**Incremental re-indexing**
Re-run on a folder after editing files. Only changed files are reprocessed (SHA-256 hash check). Unchanged files are skipped in milliseconds.

## Pipeline

```
File(s)
  │
  ▼
[1] Chunk          — structure-first split (headings → sections),
                     fallback to sentence splitting with LLM boundary check
  │
  ▼
[2] Contextualize  — LLM writes 1-2 sentence summary per chunk,
                     stored alongside the text for richer embeddings
  │
  ▼
[3] Tag            — LLM generates 3-7 semantic tags per chunk,
                     batched (N chunks per LLM call) for speed
  │
  ▼
[4] Embed + Upsert — embed(context + text) → vector,
                     stored in Qdrant with full metadata payload
  │
  ▼
[5] Link           — semantic search across all collections,
                     bidirectional links + backlinks written to Qdrant + graph.<collection>.json
  │
  ▼
chunks_out/        — Markdown files written after linking, so Obsidian review
                     shows both tags and all semantic links per chunk
```

## Features

- **Structure-aware chunking** — respects headings, avoids mid-sentence splits; body text styled as heading (Word/pandoc artefact) is detected and kept as content
- **Contextual embeddings** — `context + text` embedded together, not raw text alone
- **Batch LLM calls** — tagging and contextualizing run in parallel batches; robust parser handles all known gemma3 output formats with graceful per-chunk fallback
- **Hash-based skip** — unchanged files are never reprocessed; changed files are deleted from Qdrant and reindexed cleanly
- **Bidirectional graph** — links and backlinks between documents maintained in both Qdrant payload and `graph.<collection>.json`; stale edges removed on reindex
- **Stable document identity** — `source_file` stored as a path relative to a configurable `SOURCE_ROOT`; validated against escaping the root on all platforms including different Windows drives
- **Obsidian-compatible output** — `chunks_out/` written after linking so review files include semantic links; stale chunk files from previous runs are cleaned up automatically
- **Folder indexing** — point at a directory, all `.md`, `.txt`, `.docx` files are processed recursively, hidden entries skipped
- **Cross-collection linking** — linker searches a configurable collection allowlist; incompatible collections are skipped with a warning rather than crashing
- **MCP retrieval layer** — 6 tools expose the indexed knowledge to any MCP-compatible AI client

## Supported Formats

| Format | Method |
|--------|--------|
| `.md` | Native parser |
| `.txt` | Native parser |
| `.docx` | pandoc (must be installed) |

> **Note:** pandoc is a system dependency. On Linux/macOS: `apt install pandoc` / `brew install pandoc`. On Windows: [pandoc.org/installing](https://pandoc.org/installing.html).

## Requirements

- Node.js 18+
- [Ollama](https://ollama.com) running locally
- Qdrant instance (local or [Qdrant Cloud](https://cloud.qdrant.io) free tier)
- pandoc (for `.docx` support)

## Embedding Model Guide

Both indexer and MCP server use the same model — the collection must be indexed and queried with the same model. Set per-collection in `config.json` after running `npm run sync`.

| Model | Size | Best for |
|-------|------|----------|
| `bge-m3` | 1.2 GB | Ukrainian / multilingual text, technical docs |
| `snowflake-arctic-embed2` | 1.2 GB | English-only collections |

Both produce 1024-dimensional vectors.

```bash
ollama pull bge-m3
ollama pull snowflake-arctic-embed2  # optional alternative
```

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
# fill in QDRANT_URL, QDRANT_KEY, and model preferences
```

### 2. Sync collections

```bash
npm run sync
```

Generates/updates `config.json` from your actual Qdrant collections and ensures required payload indexes exist on all of them. Safe to re-run at any time.

### 3. Edit config.json (optional)

After sync, set the correct `embedModel` per collection and add a description:

```json
{
  "collections": {
    "my-docs": {
      "embedModel": "bge-m3",
      "vectorSize": 1024,
      "description": "Project architecture documentation"
    }
  }
}
```

> `config.json` is auto-generated and git-ignored. See `config.example.json` for the expected structure.

### 4. Register MCP server in Claude Code

```bash
claude mcp add --scope user qdrant-indexer -- node /absolute/path/to/indexer/src/mcp/server.js
```

`--scope user` makes the server available across all projects. Restart VS Code after registering.

## Usage

### Indexing

```bash
# index a single file
COLLECTION=my-docs npm run index path/to/document.md

# index an entire folder
COLLECTION=my-docs npm run index path/to/docs/

# re-run — changed files reindexed, unchanged skipped
COLLECTION=my-docs npm run index path/to/docs/

# pin source paths relative to vault root for stable IDs across runs
SOURCE_ROOT=/path/to/vault COLLECTION=my-docs npm run index /path/to/vault/docs/
```

Output:
```
Found 31 file(s) to process

→ node_js/prisma-express.md
  [1/5] chunking...        18 chunks
  [2/5] contextualizing... 17 chunks after merge
  [3/5] tagging...
  [4/5] embedding + upserting... 17 points
  [5/5] linking...
  ✓ done

→ node_js/express-fundamentals.md
  ✓ unchanged, skipping

Done. 31 file(s): 30 indexed, 1 skipped.
```

### MCP Server

```bash
npm run mcp
```

The server runs over stdio and is managed by Claude Code. Once registered, the tools are available in any conversation.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run index` | Index files: `COLLECTION=x npm run index <path>` |
| `npm run mcp` | Start MCP server |
| `npm run sync` | Sync config.json + ensure payload indexes on all collections |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_URL` | — | Qdrant instance URL |
| `QDRANT_KEY` | — | Qdrant API key |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `COLLECTION` | — | Target collection (passed per run, not in `.env`) |
| `EMBED_MODEL` | `bge-m3` | Default embedding model |
| `CONTEXT_MODEL` | `gemma3:4b` | Model for chunk contextualization |
| `TAG_MODEL` | `gemma3:4b` | Model for tag generation |
| `VECTOR_SIZE` | `1024` | Must match embedding model output |
| `MAX_CHUNK_TOKENS` | `400` | Max tokens per chunk |
| `MIN_CHUNK_TOKENS` | `30` | Minimum tokens — smaller chunks are dropped |
| `OVERLAP_SENTENCES` | `2` | Sentence overlap between adjacent chunks |
| `LLM_BATCH_SIZE` | `3` | Chunks per LLM call (tagging + context) |
| `LINK_TOP` | `5` | Top-N semantic neighbors to link |
| `LINK_MIN_SCORE` | `0.75` | Minimum cosine similarity to create a link |
| `CHUNKS_OUT_DIR` | `./chunks_out` | Output directory for Obsidian-compatible `.md` files |
| `SOURCE_ROOT` | *(target path)* | Absolute path used as root for `source_file` IDs. Set once per vault so IDs remain stable regardless of which subfolder you index. Files outside this root cause an explicit error. |
| `LINK_COLLECTIONS` | *(all collections)* | Comma-separated allowlist of Qdrant collections to search during linking. Recommended when your Qdrant instance has collections with different embedding models or vector sizes. |

## Required Qdrant Payload Indexes

The following keyword indexes must exist on every collection for filters and hash-based skip to work correctly:

| Field | Type | Used by |
|-------|------|---------|
| `source_file` | keyword | hash check, reindex, delete, `qdrant_search` filter |
| `tags` | keyword | `qdrant_search` tag filter, `qdrant_find_by_tag` |

`npm run index` creates these automatically for new collections. For existing collections run `npm run sync` — idempotent, safe to re-run.

## MCP Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `qdrant_search` | `query`, `collection`, `top?`, `tags?[]`, `source_file?` | Semantic search; tag filter uses OR, combined with source_file via AND |
| `qdrant_collection_info` | — | List all collections with point counts, embed model, description |
| `qdrant_get_chunk` | `collection`, `source_file`, `chunk_index`, `window?` | Retrieve a specific chunk with optional surrounding context window |
| `qdrant_related` | `collection`, `source_file` | Outgoing semantic links for a file (from graph) |
| `qdrant_backlinks` | `collection`, `source_file` | Incoming links for a file (from graph) |
| `qdrant_find_by_tag` | `collection`, `tag`, `limit?` | All chunks matching a tag, grouped by file |

## Project Structure

```
src/
  core/
    qdrant.js     — Qdrant REST client (upsert, search, scroll, filter, index)
    ollama.js     — Ollama REST client (embed + generate)
    graph.js      — per-collection graph.<collection>.json with full edge cleanup
    config.js     — config.json helpers + getEmbedModel(collection)
  indexer/
    index.js      — CLI entry point
    batch.js      — parallel batch runner
    phases/
      chunk.js    — structure-aware parser, pandoc for .docx
      context.js  — LLM contextualization + boundary merging
      tag.js      — batch tag generation with multi-format JSON parser
      link.js     — semantic linking across collections
  mcp/
    server.js     — MCP entry point
    tools/
      search.js, collections.js, getChunk.js, related.js, backlinks.js, findByTag.js
  sync.js         — sync config.json + ensure required indexes on all collections
config.json           — auto-generated by npm run sync, git-ignored
config.example.json   — template for config.json structure
graph.<collection>.json — generated semantic graph, git-ignored
graph.example.json    — template for graph file structure
```

## Known Limitations

**`chunks_out/` cleanup** uses filename pattern matching (`base__chunk*.md`). If you manually create a directory with a name matching that pattern, `rmSync` will fail. This only affects hand-crafted edge cases in the output folder and does not impact indexing or Qdrant.
