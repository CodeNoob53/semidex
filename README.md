# semidex

![semidex](assets/avif/banner_logo.avif)

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)
![npm](https://img.shields.io/badge/npm-2.0.0-blue?logo=npm&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)
![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-black?logo=ollama&logoColor=white)
![ONNX Runtime](https://img.shields.io/badge/ONNX%20Runtime-local%20embeddings-blue?logo=onnx&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-vector%20DB-red?logo=qdrant&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)

**semidex is an experimental local-first retrieval layer for AI agents**

It turns your documents, notes, specs, and code knowledge into an indexed
collection that an AI assistant can query through MCP. Instead of pasting huge
files into chat, semidex stores your knowledge in Qdrant, splits it into chunks,
enriches them with summaries, tags, and semantic links, then returns relevant
pieces for the current task.

In simple terms: semidex helps an AI look up paragraphs, sections, commands,
config options, and related documents before it answers or edits code.

## Evaluation status

semidex is a working experimental retrieval MVP, not a production-ready
assistant platform. Its current benchmark suites are regression tools for
development: they help compare semidex changes against earlier semidex behavior.
They are not an independent quality evaluation and do not establish superiority
over other RAG systems.

The next validation milestone is to build a representative demo, run selected
external datasets, and compare the relevant workflows against direct
alternatives before making competitive quality claims.

## Contents

- [Evaluation status](#evaluation-status)
- [Problems semidex solves](#problems-semidex-solves)
- [Quick Start](#quick-start)
- [Platform Support](#platform-support)
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
| AI agents guess when context is missing | MCP tools give the agent on-demand access to indexed project knowledge |
| Semantic search misses exact terms | Sparse lexical vectors help retrieve `ONNX_EMBED`, `embedding_schema_version`, env vars, and function names |
| Keyword search misses meaning | Dense vectors help retrieve paraphrases, related concepts, and mixed-language queries |
| Chunks lose context when isolated | Before embedding, a local LLM generates a summary of what each chunk means in its document — the vector is computed from summary + text combined, which can improve natural-language retrieval of short fragments |
| Related docs are hard to discover | Semantic links and backlinks provide an additional file-level navigation path |
| Re-indexing is expensive | SHA-256 hash checks skip unchanged files |
| Provider mismatch breaks search quality | Provider metadata is stored per collection; mismatches force reindexing |
| Private docs should stay local | Ollama, ONNX, and Qdrant can run locally; document text does not need external APIs |

## Quick Start

### 1. Install

```bash
npm install
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.
The example env file targets local Qdrant by default. For Qdrant Cloud, replace
`QDRANT_URL` and `QDRANT_KEY` with the values from your cluster dashboard.

### 2. Start Qdrant

Use Qdrant Cloud, or run locally:

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

### 3. Pull local models

Context and tag generation use Ollama in every indexing mode:

```bash
ollama pull gemma3:4b
```

For the recommended multilingual embedding path, set `ONNX_EMBED=1`. The BGE-M3
ONNX model downloads once on first use. Pull `bge-m3` in Ollama only when you
intend to use the lighter `ollama + hashed-tf` fallback:

```bash
ollama pull bge-m3
```

### 4. Create a collection and index documents

```bash
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs/
```

No separate create command is required. If `my-docs` does not exist, the indexer
creates the Qdrant collection automatically with named `dense` and `sparse`
vectors, required payload indexes, and a matching `config.json` entry. Re-running
the same command updates changed files and skips unchanged files.

Run `npm run sync` after upgrading semidex or when adopting an existing remote
collection. It is safe to re-run, but it is not required to create a new
collection.

### 5. Register MCP in Claude Code

Linux / macOS:

```bash
claude mcp add --scope user semidex -- node /absolute/path/to/semidex/src/mcp/server.js
```

Windows:

```bash
claude mcp add --scope user semidex -- node C:\absolute\path\to\semidex\src\mcp\server.js
```

Reconnect the MCP server in Claude Code and run `/mcp`. The server appears as `qdrant` with 9 tools.

<table><tr>
<td><img src="assets/avif/mcp_connected.avif" alt="MCP connected"/></td>
<td><img src="assets/avif/mcp_status.avif" alt="MCP tools status"/></td>
</tr></table>

## Platform Support

Verified support currently targets **Windows 10/11**. The tested local setup is
Node.js with ONNX Runtime on CPU or DirectML (`ONNX_EXECUTION_PROVIDER=dml`) and
Ollama using the available GPU backend.

Linux and macOS are **experimental / unverified**. The Node.js entry points and
CPU path are intended to remain portable, and Ollama may use platform GPU
backends such as CUDA or Metal, but semidex does not claim end-to-end support for
those systems until they are tested on physical hardware.

See [docs/en/configuration.md](docs/en/configuration.md#platform-support) for the
detailed support matrix.

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
  -> heading-aware, tokenizer-aware chunking
  -> LLM context summaries and tags
  -> dense + sparse embeddings
  -> Qdrant named vectors + payload metadata
  -> semantic graph links/backlinks
  -> MCP tools for AI agents

Side output:
  -> chunks_out/ Markdown notes for Obsidian review and quality control
```

At query time, semidex embeds the search query with the same provider used during indexing, runs hybrid search in Qdrant, fuses dense and sparse results with RRF, optionally reranks locally, and returns the highest-ranked chunks to the AI client.

Each indexed chunk becomes a single Qdrant point:

```
Qdrant point
├── id: "550e8400-..."                           ← UUID
├── vectors:
│   ├── dense:  [0.023, -0.14, 0.87, ...]       ← 1024 floats (context + text)
│   └── sparse: {indices: [42, 1337, ...], values: [0.8, 0.3, ...]}
└── payload:
    ├── text:         "super(name, salary)..."   ← raw chunk text
    ├── context:      "calls the superclass..."  ← LLM summary
    ├── section:      "4.10. Subclass constructor"
    ├── source_file:  "docs/guide.md"
    ├── tags:         ["inheritance", "class"]
    ├── links:        ["other_file.md"]
    ├── backlinks:    []
    ├── chunk_index:  99
    ├── total_chunks: 285
    ├── file_hash:    "abc123..."
    └── dense_provider / dense_model / sparse_provider / ...
```

Vectors are used for search and ranking only. The payload is what gets returned to the agent. The dense vector is computed from `context + text` combined — so even a sparse code snippet like `super(name, salary)` is findable by natural language queries, because its LLM-generated context summary ("calls the superclass constructor") is baked into the vector.

## Recommended Modes

| Mode | Config | Best for |
|------|--------|----------|
| Default / light | `DENSE_PROVIDER=ollama`, `SPARSE_PROVIDER=hashed-tf` | Fast setup, low memory, Ollama-based embeddings |
| Quality / multilingual | `ONNX_EMBED=1` | Ukrainian, mixed-language, exact technical terms; strongest currently evaluated semidex mode |
| Rerank | `RERANK_ENABLED=1` | Experimental opt-in for larger or ambiguous corpora; benchmark first |

Mixed provider combinations, such as `ollama` dense + `bge-m3-onnx` sparse, are rejected at runtime.

## Core Commands

| Command | Description |
|---------|-------------|
| `COLLECTION=my-docs npm run index ./docs` | Index a file or folder |
| `PRUNE_STALE=1 COLLECTION=my-docs npm run index ./docs` | Index and remove Qdrant points for files no longer on disk |
| `npm run mcp` | Start the MCP server over stdio |
| `npm run sync` | Sync `config.json` and Qdrant payload indexes |
| `npm run smoke` | Fast offline smoke tests — runs in CI on every push/PR |
| `npm run smoke:retrieval-live` | Optional live retrieval smoke suite (requires Qdrant, not in CI) |
| `npm run bench:retrieval` | 21-query regression benchmark (file-level) |
| `npm run bench:custom50` | 50-query quality benchmark (chunk-level, graded) |
| `npm run bench:retrieval:compare` | Compare default provider vs ONNX |
| `npm run bench:retrieval:rerank` | Rerank matrix benchmark |
| `npm run bench:retrieval:mmr` | MMR diversity matrix benchmark |

`PRUNE_STALE=1` compares the files found on disk against all `source_file` values stored in Qdrant and deletes any points whose source file is no longer present. Run only against the full directory root used for indexing. When `SOURCE_ROOT` is set, subset directory targets are rejected with a warning.

## Supported Formats

Markdown is the primary input format and currently provides the best structural
fidelity. Other formats are supported on a best-effort basis: semidex converts
them into text or Markdown first, so the resulting headings, tables, and layout
depend on the source document and the available third-party parser.

| Format | Method | Current support level |
|--------|--------|-----------------------|
| `.md` | Native parser with headings, frontmatter, wikilinks | Primary format |
| `.txt` | Native parser | Plain text only; no heading structure |
| `.pdf` | `@opendocsg/pdf2md` → Markdown | Partial; quality depends on the PDF text layer and recovered structure |
| `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, `.htm` | `pandoc` conversion to Markdown | Partial; quality depends on pandoc conversion |

Pandoc is required only for `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, and `.htm`.

## Roadmap

The current roadmap first strengthens the experimental retrieval MVP through a
shared structural foundation:

- skeleton-first chunking for tables, code, images, and document structure
- hierarchical skeleton navigation for agents
- cross-domain validation, external datasets, and direct workflow comparisons
- benchmark-driven tuning before changing defaults

After that foundation is validated, separate product tracks may add Assistant
Runtime, Codebase Memory, richer ingestion, and opt-in Agent Memory. Retrieval
experiments such as MMR or ColBERT remain conditional research, not mandatory
milestones.

Chunking quality is treated as a first-class retrieval concern — see
[docs/en/chunking-quality.md](docs/en/chunking-quality.md) for the design
document and large-document stress benchmark plan.

See [docs/en/roadmap.md](docs/en/roadmap.md) for the full roadmap, priorities,
and explicit non-goals.

## Project Status

Implemented:

- Local-first indexing pipeline
- Heading-aware, tokenizer-aware chunking with section-boundary preservation
- LLM context summaries and optional tags
- Dense + sparse hybrid retrieval
- Qdrant RRF fusion
- BGE-M3 ONNX multilingual provider
- 9 read-only MCP tools
- File-level semantic graph links/backlinks
- SHA-256 skip for unchanged files
- Deterministic point IDs for idempotent reindexing
- Opt-in stale-file cleanup via `PRUNE_STALE=1` (when run against the full source root)
- Obsidian-readable review output
- Optional deterministic reranker
- Retrieval regression benchmark suites

Changed files are detected automatically by SHA-256 hash and reindexed on the next
`npm run index` run. `PRUNE_STALE=1` removes Qdrant points for files that have been
deleted or renamed, and cleans up old paths after a rename.

Not implemented yet:

- Skeleton-first structural-node chunking
- Runtime integration for ColBERT / late-interaction retrieval
- Full external dataset evaluation
- True BM25/SPLADE fallback for Node-only sparse retrieval
- Git-aware project/codebase sync and same-hash rename/move reuse

## Acknowledgements

Built with AI assistance throughout development:

- **[OpenAI Codex](https://openai.com/blog/openai-codex)** - code review
- **[Claude](https://claude.ai) (Anthropic)** - code generation, documentation

Pipeline design, core mechanics, concept, and testing - by the author.
