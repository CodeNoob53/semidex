# semidex

![semidex](assets/avif/banner_logo.avif)

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)
![npm](https://img.shields.io/badge/npm-2.0.0-blue?logo=npm&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)
![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-black?logo=ollama&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-vector%20DB-red?logo=qdrant&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)

**semidex is an experimental local-first RAG memory system for AI agents**

It turns your documents, notes, specs, and code knowledge into a searchable memory layer that an AI assistant can query through MCP. Instead of pasting huge files into chat or hoping the model remembers your project, semidex stores your knowledge in Qdrant, splits it into useful chunks, enriches it with summaries, tags, and semantic links, then retrieves only the pieces that matter for the current task.

In simple terms: semidex helps an AI find the right paragraph, section, command, config option, or related document before it answers or edits code.

## Contents

- [Problems semidex solves](#problems-semidex-solves)
- [Quick Start](#quick-start)
- [Documentation](#documentation)
- [How It Fits Together](#how-it-fits-together)
- [Recommended Modes](#recommended-modes)
- [Core Commands](#core-commands)
- [Supported Formats](#supported-formats)
- [Roadmap](#roadmap)
- [Project Status](#project-status)
- [Acknowledgements](#acknowledgements)

## Problems semidex solves

| Problem | How semidex addresses it |
|---------|--------------------------|
| Context windows are too small | Indexes large document sets and retrieves only relevant chunks |
| AI agents guess when context is missing | MCP tools give the agent precise, on-demand access to project knowledge |
| Semantic search misses exact terms | Sparse lexical vectors catch `ONNX_EMBED`, `embedding_schema_version`, env vars, function names |
| Keyword search misses meaning | Dense vectors match paraphrases, related concepts, and mixed-language queries |
| Chunks lose context | Every chunk stores an LLM-generated summary in the context of the full document |
| Related docs are hard to discover | Semantic links and backlinks create a navigable knowledge graph |
| Re-indexing is expensive | SHA-256 hash checks skip unchanged files |
| Provider mismatch breaks search quality | Provider metadata is stored per collection; mismatches force reindexing |
| Private docs should stay local | Ollama, ONNX, and Qdrant can run locally; document text does not need external APIs |

## Quick Start

### 1. Install

```bash
npm install
cp .env.example .env
# set QDRANT_URL and QDRANT_KEY
```

### 2. Start Qdrant

Use Qdrant Cloud, or run locally:

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

### 3. Pull local models

Default mode uses Ollama for embeddings plus context/tag generation:

```bash
ollama pull bge-m3
ollama pull gemma3:4b
```

For the higher-quality multilingual embedding path, set `ONNX_EMBED=1` in `.env`. The BGE-M3 ONNX model downloads once on first use.

### 4. Sync and index

```bash
npm run sync
COLLECTION=my-docs npm run index ./docs/
```

### 5. Register MCP in Claude Code

Linux / macOS:

```bash
claude mcp add --scope user semidex -- node /absolute/path/to/semidex/src/mcp/server.js
```

Windows:

```bash
claude mcp add --scope user semidex -- node C:\absolute\path\to\semidex\src\mcp\server.js
```

Reconnect the MCP server in Claude Code and run `/mcp`. The server appears as `qdrant` with 6 tools.

<table><tr>
<td><img src="assets/avif/mcp_connected.avif" alt="MCP connected"/></td>
<td><img src="assets/avif/mcp_status.avif" alt="MCP tools status"/></td>
</tr></table>

## Documentation

The README is intentionally short. Detailed documentation lives in `docs/` and is grouped by language.

| Language | Entry point |
|----------|-------------|
| English | [docs/en/README.md](docs/en/README.md) |
| Українська | [docs/ua/README.md](docs/ua/README.md) |

English deep dives:

| Document | What it covers |
|----------|----------------|
| [docs/en/architecture.md](docs/en/architecture.md) | Indexer pipeline, local models, graph building, source of truth |
| [docs/en/retrieval.md](docs/en/retrieval.md) | Dense + sparse vectors, RRF, providers, reranking |
| [docs/en/obsidian.md](docs/en/obsidian.md) | Obsidian-compatible `chunks_out/` review console |
| [docs/en/mcp-tools.md](docs/en/mcp-tools.md) | MCP tool reference and agent workflow |
| [docs/en/configuration.md](docs/en/configuration.md) | Environment variables, provider modes, formats, Qdrant indexes |
| [docs/en/chunking-quality.md](docs/en/chunking-quality.md) | Chunking guarantees, failure modes, quality metrics, large-doc benchmark plan |
| [docs/en/benchmarking.md](docs/en/benchmarking.md) | Smoke tests, retrieval benchmark, metrics, regression workflow |
| [docs/en/roadmap.md](docs/en/roadmap.md) | Product direction, near-term priorities, and non-goals |
| [docs/en/project-structure.md](docs/en/project-structure.md) | Source tree, runtime entry points, generated files |
| [docs/en/operations.md](docs/en/operations.md) | Usage examples, limitations, troubleshooting |

## How It Fits Together

```text
Documents
  -> structure-aware chunking
  -> LLM context summaries and tags
  -> dense + sparse embeddings
  -> Qdrant named vectors + payload metadata
  -> semantic graph links/backlinks
  -> MCP tools for AI agents

Side output:
  -> chunks_out/ Markdown notes for Obsidian review and quality control
```

At query time, semidex embeds the search query with the same provider used during indexing, runs hybrid search in Qdrant, fuses dense and sparse results with RRF, optionally reranks locally, and returns the best chunks to the AI client.

## Recommended Modes

| Mode | Config | Best for |
|------|--------|----------|
| Default / light | `DENSE_PROVIDER=ollama`, `SPARSE_PROVIDER=hashed-tf` | Fast setup, low memory, Ollama-based embeddings |
| Quality / multilingual | `ONNX_EMBED=1` | Ukrainian, mixed-language, exact technical terms, best retrieval quality |
| Rerank | `RERANK_ENABLED=1` | Experimental opt-in for larger or ambiguous corpora; benchmark first |

Mixed provider combinations, such as `ollama` dense + `bge-m3-onnx` sparse, are rejected at runtime.

## Core Commands

| Command | Description |
|---------|-------------|
| `COLLECTION=my-docs npm run index ./docs` | Index a file or folder |
| `npm run mcp` | Start the MCP server over stdio |
| `npm run sync` | Sync `config.json` and Qdrant payload indexes |
| `npm run smoke` | Fast offline smoke tests — runs in CI on every push/PR |
| `npm run smoke:retrieval-live` | Optional live retrieval smoke suite (requires Qdrant, not in CI) |
| `npm run bench:retrieval` | 21-query regression benchmark (file-level) |
| `npm run bench:custom50` | 50-query quality benchmark (chunk-level, graded) |
| `npm run bench:retrieval:compare` | Compare default provider vs ONNX |
| `npm run bench:retrieval:rerank` | Rerank matrix benchmark |
| `npm run bench:retrieval:mmr` | MMR diversity matrix benchmark |

## Supported Formats

| Format | Method |
|--------|--------|
| `.md` | Native parser with headings, frontmatter, wikilinks |
| `.txt` | Native parser |
| `.pdf` | `pdf-parse` |
| `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, `.htm` | `pandoc` conversion to Markdown |

Pandoc is required only for `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, and `.htm`.

## Roadmap

semidex is not trying to become a broad AI memory platform. The current roadmap
focuses on strengthening the existing agent-grade RAG index:

- retrieval-grade chunking for large technical documents
- benchmark-driven tuning before changing defaults
- better diagnostics and local observability
- agent wake-up workflows for MCP clients
- future incremental codebase memory that refreshes only changed project files
- careful experiments with MMR, full-text filtering, and future ColBERT reranking

Chunking quality is treated as a first-class retrieval concern — see
[docs/en/chunking-quality.md](docs/en/chunking-quality.md) for the design
document and large-document stress benchmark plan.

See [docs/en/roadmap.md](docs/en/roadmap.md) for the full roadmap, priorities,
and explicit non-goals.

## Project Status

Implemented:

- Local-first indexing pipeline
- Structure-aware chunking
- LLM context summaries and tags
- Dense + sparse hybrid retrieval
- Qdrant RRF fusion
- BGE-M3 ONNX multilingual provider
- MCP reader tools
- Semantic graph links/backlinks
- Obsidian-readable review output
- Optional deterministic reranker
- Retrieval regression benchmark

Not implemented yet:

- ColBERT / late-interaction retrieval
- Full external dataset evaluation
- True BM25/SPLADE fallback for Node-only sparse retrieval
- Incremental project/codebase sync for changed, deleted, and renamed files

## Acknowledgements

Built with AI assistance throughout development:

- **[OpenAI Codex](https://openai.com/blog/openai-codex)** - code review
- **[Claude](https://claude.ai) (Anthropic)** - code generation, documentation

Pipeline design, core mechanics, concept, and testing - by the author.
