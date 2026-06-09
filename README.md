# semidex

![semidex](assets/avif/banner_logo.avif)

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)
![npm](https://img.shields.io/badge/version-2.0.0-blue?logo=npm&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)
![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-black?logo=ollama&logoColor=white)
![ONNX Runtime](https://img.shields.io/badge/ONNX%20Runtime-local%20embeddings-blue?logo=onnx&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-vector%20DB-red?logo=qdrant&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)

**Local-first retrieval layer for AI agents.**

semidex turns documents, notes, and specs into an indexed knowledge collection
that an AI assistant queries through [MCP](https://modelcontextprotocol.io).
Instead of pasting large files into chat, the agent searches a Qdrant index of
structured, context-enriched chunks and pulls in exactly the pieces it needs —
paragraphs, sections, commands, configuration options — before it answers or
edits code.

Everything can run on your machine: embeddings (BGE-M3 via ONNX Runtime),
context generation (Ollama), and storage (Qdrant). Document text never has to
leave your environment.

> **Status:** semidex is a working experimental retrieval MVP, not a
> production-ready assistant platform. Its benchmark suites are internal
> regression tools; they compare semidex against earlier semidex behavior and
> do not establish superiority over other RAG systems. See
> [Project Status](#project-status) and the [roadmap](docs/en/roadmap.md).

## Contents

- [Why semidex](#why-semidex)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Embedding Modes](#embedding-modes)
- [Core Commands](#core-commands)
- [Optional Tags](#optional-tags)
- [Supported Formats](#supported-formats)
- [Platform Support](#platform-support)
- [Documentation](#documentation)
- [Roadmap: MVP and Beyond](#roadmap-mvp-and-beyond)
- [Project Status](#project-status)
- [License and Acknowledgements](#license-and-acknowledgements)

## Why semidex

| Problem | How semidex addresses it |
|---------|--------------------------|
| Context windows are too small | Indexes large document sets; the agent retrieves only relevant chunks |
| Agents guess when context is missing | Seven read-only MCP tools give on-demand access to indexed project knowledge |
| Semantic search misses exact terms | Sparse lexical vectors retrieve identifiers like `ONNX_EMBED`, env vars, and function names |
| Keyword search misses meaning | Dense vectors retrieve paraphrases, related concepts, and mixed-language queries |
| Chunks lose meaning in isolation | A local LLM summarizes each chunk's role in its document; the vector is computed from summary + text combined |
| Source scope is unclear | Directory and file listing tools let agents narrow the search area before querying |
| Re-indexing is expensive | SHA-256 hash checks skip unchanged files; deterministic point IDs make reindexing idempotent |
| Provider drift breaks search | Provider metadata is stored per collection; mismatches trigger a controlled reindex |
| Private documents must stay private | Ollama, ONNX, and Qdrant all run locally; no external API is required |

## Quick Start

### 1. Install

```bash
npm install
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
```

The example env file targets local Qdrant. For Qdrant Cloud, set `QDRANT_URL`
and `QDRANT_KEY` from your cluster dashboard.

### 2. Start Qdrant

Use Qdrant Cloud, or run locally:

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

### 3. Pull local models

Context generation uses Ollama in every indexing mode:

```bash
ollama pull gemma3:4b
```

For the recommended multilingual embedding path (`ONNX_EMBED=1`), the BGE-M3
ONNX model (~2.3 GB) downloads automatically on first use. Pull `bge-m3` in
Ollama only if you intend to use the lighter `ollama + hashed-tf` fallback:

```bash
ollama pull bge-m3
```

### 4. Index documents

```bash
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs/
```

No separate "create collection" step is needed. If `my-docs` does not exist,
the indexer creates it with named `dense`/`sparse` vectors, the required
payload indexes, and a matching `config.json` entry. Re-running the command
updates changed files and skips unchanged ones.

Run `npm run sync` after upgrading semidex or when adopting an existing remote
collection. It is idempotent and safe to re-run.

### 5. Register the MCP server

Linux / macOS:

```bash
claude mcp add --scope user semidex -- node /absolute/path/to/semidex/src/mcp/server.js
```

Windows:

```bash
claude mcp add --scope user semidex -- node C:\absolute\path\to\semidex\src\mcp\server.js
```

Reconnect MCP servers in your client and run `/mcp`. The server exposes seven
read-only tools, all prefixed `qdrant_` (`qdrant_search`,
`qdrant_collection_info`, `qdrant_get_chunk`, `qdrant_find_by_tag`,
`qdrant_list_files`, `qdrant_list_tags`, `qdrant_list_directories`).

<table><tr>
<td><img src="assets/avif/mcp_connected.avif" alt="MCP connected"/></td>
<td><img src="assets/avif/mcp_status.avif" alt="MCP tools status"/></td>
</tr></table>

## How It Works

```text
Documents
  -> heading-aware, tokenizer-aware chunking
  -> LLM context summaries
  -> optional tags (TAG_GEN=1 or backfill:tags)
  -> dense + sparse embeddings
  -> Qdrant named vectors + payload metadata
  -> MCP tools for AI agents
```

At query time, semidex embeds the query with the same provider used during
indexing, runs hybrid search in Qdrant, fuses dense and sparse results with
RRF, optionally applies a local deterministic reranker, and returns the
highest-ranked chunks to the AI client.

Each indexed chunk is a single Qdrant point:

```text
Qdrant point
├── id: "550e8400-..."                           ← deterministic UUID
├── vectors:
│   ├── dense:  [0.023, -0.14, 0.87, ...]        ← 1024 floats (context + text)
│   └── sparse: {indices: [42, ...], values: [0.8, ...]}
└── payload:
    ├── text:         "super(name, salary)..."   ← raw chunk text (authoritative)
    ├── context:      "calls the superclass..."  ← LLM summary
    ├── section:      "4.10. Subclass constructor"
    ├── source_file:  "docs/guide.md"
    ├── tags:         []                          ← optional metadata
    ├── links:        ["other_file.md"]
    ├── chunk_index:  99
    ├── total_chunks: 285
    ├── file_hash:    "abc123..."
    └── dense_provider / dense_model / sparse_provider / schema versions ...
```

Vectors drive search and ranking; the payload is what the agent receives. The
dense vector is computed from `context + text` combined, so even a terse code
snippet like `super(name, salary)` is findable by a natural-language query —
its generated context ("calls the superclass constructor") is baked into the
vector.

Details: [docs/en/architecture.md](docs/en/architecture.md) and
[docs/en/retrieval.md](docs/en/retrieval.md).

## Embedding Modes

| Mode | Config | Best for |
|------|--------|----------|
| Quality / multilingual (recommended) | `ONNX_EMBED=1` | Ukrainian, mixed-language, and exact technical terms; the strongest evaluated mode |
| Default / light | `DENSE_PROVIDER=ollama`, `SPARSE_PROVIDER=hashed-tf` | Fast setup, low memory, Ollama-based embeddings |
| Rerank | `RERANK_ENABLED=1` | Experimental opt-in for larger or ambiguous corpora; benchmark before adopting |

Providers must not be mixed within a collection. Invalid combinations (for
example `ollama` dense with `bge-m3-onnx` sparse) are rejected at runtime, and
changing the provider of an existing collection triggers a controlled reindex.

## Core Commands

| Command | Description |
|---------|-------------|
| `COLLECTION=my-docs npm run index ./docs` | Index a file or folder |
| `PRUNE_STALE=1 COLLECTION=my-docs npm run index ./docs` | Index and remove points for files no longer on disk |
| `COLLECTION=my-docs npm run backfill:tags` | Generate missing tags for an indexed collection |
| `FORCE_TAGS=1 COLLECTION=my-docs npm run backfill:tags` | Regenerate all tags without reindexing vectors |
| `npm run mcp` | Start the MCP server (stdio) |
| `npm run sync` | Sync `config.json` and Qdrant payload indexes |
| `npm run doctor` | Read-only environment health check with redacted output |
| `npm run smoke` | Offline smoke tests — run in CI on every push/PR |
| `npm run smoke:retrieval-live` | Live retrieval smoke suite (requires Qdrant; not in CI) |
| `npm run bench:retrieval` | 21-query regression benchmark (file-level) |
| `npm run bench:custom50` | 50-query quality benchmark (chunk-level, graded) |
| `npm run bench:retrieval:compare` | Compare default provider vs ONNX |

`PRUNE_STALE=1` compares files on disk against all `source_file` values stored
in Qdrant and deletes points whose source file is gone. Run it only against
the full directory root used for indexing; subset targets are rejected with a
warning when `SOURCE_ROOT` is set.

## Optional Tags

Tags are disabled by default and are payload-only metadata: they do not affect
hybrid search quality, because vectors are built from `context + text`. Enable
them only for tag-driven workflows — `qdrant_list_tags`, `qdrant_find_by_tag`,
tag-filtered `qdrant_search`, or manual collection auditing.

```bash
# during indexing
TAG_GEN=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs

# or later, without reindexing vectors
COLLECTION=my-docs npm run backfill:tags
```

Tag generation uses `CONTEXT_MODEL` by default; set `TAG_MODEL` only when you
deliberately want a separate tagging model.

## Supported Formats

Markdown is the primary input format and provides the best structural
fidelity. Other formats are converted to text or Markdown first, so the
resulting structure depends on the source document and the third-party parser.

| Format | Method | Support level |
|--------|--------|---------------|
| `.md` | Native parser: headings, frontmatter, wikilinks | Primary |
| `.txt` | Native parser | Plain text; no heading structure |
| `.pdf` | `@opendocsg/pdf2md` → Markdown | Partial; depends on the PDF text layer |
| `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, `.htm` | `pandoc` → Markdown | Partial; depends on pandoc conversion |

Pandoc is required only for the formats in the last row.

## Platform Support

**Windows 10/11** is the verified end-to-end target: Node.js with ONNX Runtime
on CPU or DirectML (`ONNX_EXECUTION_PROVIDER=dml`), and Ollama on the
available GPU backend.

Linux and macOS are **experimental and unverified**. The Node.js entry points
and CPU path are intended to remain portable, but semidex does not claim
end-to-end support until those platforms are tested on physical hardware. See
[docs/en/configuration.md](docs/en/configuration.md#platform-support) for the
detailed matrix.

## Documentation

The README is intentionally short. Detailed documentation lives in `docs/`,
grouped by language.

| Language | Entry point |
|----------|-------------|
| English | [docs/en/README.md](docs/en/README.md) |
| Українська | [docs/ua/README.md](docs/ua/README.md) |

English deep dives:

| Document | Covers |
|----------|--------|
| [architecture.md](docs/en/architecture.md) | Indexer pipeline, local models, Qdrant storage, source of truth |
| [retrieval.md](docs/en/retrieval.md) | Dense + sparse vectors, RRF, providers, reranking |
| [mcp-tools.md](docs/en/mcp-tools.md) | MCP tool reference and agent workflow |
| [configuration.md](docs/en/configuration.md) | Environment variables, provider modes, formats, Qdrant indexes |
| [chunking-quality.md](docs/en/chunking-quality.md) | Chunking guarantees, failure modes, quality metrics |
| [benchmarking.md](docs/en/benchmarking.md) | Smoke tests, retrieval benchmarks, regression workflow |
| [roadmap.md](docs/en/roadmap.md) | MVP scope, future tracks, and explicit non-goals |
| [project-structure.md](docs/en/project-structure.md) | Source tree, runtime entry points, generated files |
| [operations.md](docs/en/operations.md) | Usage examples, limitations, troubleshooting |

## Roadmap: MVP and Beyond

The roadmap separates a focused MVP from clearly labeled future work.

**MVP** = the shipped retrieval baseline plus one structural upgrade:
**skeleton-first chunking** — parsing Markdown through an AST so that tables,
code blocks, and lists become typed, intact structural nodes instead of prose
fragments. It ships behind a feature flag and is benchmarked against the
current chunker before any default changes.

**Future (post-MVP)**, in dependency order: hierarchical skeleton navigation
for agents, cross-domain validation and external datasets, and then separate
product tracks — Assistant Runtime (HTTP answer API), Codebase Memory,
extended ingestion with OCR/vision, a local Control Panel, and opt-in Agent
Memory. Retrieval experiments such as MMR or ColBERT remain conditional
research with explicit triggers, not mandatory milestones.

See [docs/en/roadmap.md](docs/en/roadmap.md) for the full breakdown, exit
gates, and non-goals.

## Project Status

Implemented:

- Local-first indexing pipeline with staged, failure-safe commits
- Heading-aware, tokenizer-aware chunking with section-boundary preservation
- Real BGE-M3 token counting by default (`TOKEN_COUNT=heuristic` opt-out)
- LLM context summaries; optional payload tags
- Dense + sparse hybrid retrieval with Qdrant RRF fusion
- BGE-M3 ONNX multilingual provider; Ollama + hashed-TF fallback
- Seven read-only MCP tools
- SHA-256 skip for unchanged files; deterministic point IDs
- Opt-in stale-file cleanup (`PRUNE_STALE=1` against the full source root)
- Optional deterministic reranker (default off)
- Environment doctor, offline smoke tests (CI), retrieval regression suites

Not implemented yet:

- Skeleton-first structural-node chunking (current MVP work — see roadmap)
- Hierarchical skeleton navigation and grounded answer API
- External dataset evaluation and direct workflow comparisons
- ColBERT / late-interaction runtime integration
- True BM25/SPLADE fallback for Node-only sparse retrieval
- Git-aware codebase sync and same-hash rename/move fast path

## License and Acknowledgements

Licensed under the [MIT License](LICENSE).

Built with AI assistance throughout development:

- **[Claude](https://claude.ai) (Anthropic)** — code generation, documentation
- **[OpenAI Codex](https://openai.com/blog/openai-codex)** — code review

Pipeline design, core mechanics, concept, and testing — by the author.
