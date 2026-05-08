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
                     bidirectional links + backlinks written to Qdrant + graph.json
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
- **Bidirectional graph** — links and backlinks between documents maintained consistently in both Qdrant payload and `graph.json`; stale edges removed on reindex
- **Stable document identity** — `source_file` stored as a path relative to a configurable `SOURCE_ROOT`, not an unstable basename; validated against escaping the root on all platforms including different Windows drives
- **Obsidian-compatible output** — `chunks_out/` written after the linking phase so review files include semantic links; stale chunk files from previous runs are cleaned up automatically
- **Folder indexing** — point at a directory, all `.md`, `.txt`, `.docx` files are processed recursively, hidden entries skipped
- **Cross-collection linking** — linker searches a configurable collection allowlist; incompatible collections (different vector size or model) are skipped with a warning rather than crashing the run

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
- Qdrant instance (local or cloud)
- pandoc (for `.docx` support)

**Ollama models required:**

```bash
ollama pull bge-m3        # embeddings
ollama pull gemma3:4b     # context + tagging
```

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your Qdrant URL, API key, and model preferences
```

## Usage

```bash
# index a single file
COLLECTION=my-docs node src/index.js path/to/document.md

# index an entire folder
COLLECTION=my-docs node src/index.js path/to/docs/

# re-run on the same folder — changed files reindexed, unchanged skipped
COLLECTION=my-docs node src/index.js path/to/docs/

# pin source paths relative to vault root so IDs stay stable across runs
SOURCE_ROOT=/path/to/vault COLLECTION=my-docs node src/index.js /path/to/vault/docs/
```

Output:
```
Found 31 file(s) to process

→ docs/architecture.md
  [1/4] chunking...        18 chunks
  [2/4] contextualizing... 17 chunks after merge
  [3/4] tagging...
  [4/4] embedding + upserting... 17 points
  [5/5] linking...
  ✓ done

→ docs/api-reference.md
  ✓ unchanged, skipping

Done. 31 file(s): 30 indexed, 1 skipped.
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_URL` | — | Qdrant instance URL |
| `QDRANT_KEY` | — | Qdrant API key |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `COLLECTION` | — | Target Qdrant collection name |
| `EMBED_MODEL` | `bge-m3` | Embedding model |
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

## Known Limitations

**`chunks_out/` cleanup** uses filename pattern matching (`base__chunk*.md`). If you manually create a directory with a name matching that pattern, `rmSync` will fail. This only affects hand-crafted edge cases in the output folder and does not impact indexing or Qdrant.

## Project Structure

```
src/
  index.js          — main pipeline, CLI entry point
  phases/
    chunk.js        — document parser and chunker
    context.js      — LLM contextualization + boundary merging
    tag.js          — batch tag generation with multi-format JSON parser
    link.js         — semantic linking across collections
  lib/
    ollama.js       — Ollama REST client (generate + embed)
    qdrant.js       — Qdrant REST client (upsert, search, filter, index)
    batch.js        — parallel batch runner
    graph.js        — graph.json read/write with full edge cleanup on reindex
```

## MCP Integration

The database is designed to be queried via an MCP-compatible Qdrant server. With MCP access configured, an AI assistant can call `qdrant_search` to retrieve relevant chunks by semantic similarity — enabling targeted, context-aware responses over arbitrarily large document collections.
