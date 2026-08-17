# Semidex

![Semidex](assets/avif/banner_logo.avif)

[![CI](https://github.com/CodeNoob53/semidex/actions/workflows/smoke.yml/badge.svg)](https://github.com/CodeNoob53/semidex/actions/workflows/smoke.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.16-339933?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)](LICENSE)
[![npm downloads: semidex-lite](https://img.shields.io/npm/dw/semidex-lite?label=semidex-lite%20downloads&logo=npm)](https://www.npmjs.com/package/semidex-lite)
[![MCP](https://img.shields.io/badge/MCP-compatible-5c4ee5)](https://modelcontextprotocol.io/)
[![Qdrant](https://img.shields.io/badge/vector%20store-Qdrant-dc244c)](https://qdrant.tech/)

Semidex is an open retrieval and grounded-answering system that turns document
collections into searchable, navigable knowledge bases for people,
applications, and AI agents. It provides the complete path from document
ingestion and structure-aware chunking to dense+sparse embeddings, hybrid
retrieval, source evidence, streamed answers, and agent access.

Semidex is designed for personal research, education, internal knowledge,
developer tools, and assistants embedded in websites, bots, or other products.
The project is an experimental MVP under active development; its current Admin
UI is primarily an administration and debugging surface, not a finished user
application.

## What Semidex provides

- **A complete ingestion pipeline:** document parsing, deterministic identity,
  incremental indexing, token-aware chunking, embeddings, and Qdrant storage.
- **Structure-aware Markdown:** sections, tables, code blocks, and checklists
  remain connected to canonical source content through
  [skeleton-first chunking](docs/design/skeleton-first-chunking.md).
- **Multilingual hybrid retrieval:** dense semantic and sparse lexical signals
  are fused in Qdrant; see [retrieval](docs/en/retrieval.md) and the
  [benchmark methodology](docs/en/benchmarking.md).
- **Inspectable evidence:** agents can navigate collection skeletons and fetch
  bounded section or file context instead of treating documents as anonymous
  fragments.
- **Two integration boundaries:** a versioned
  [Ask API](docs/design/ask-application-runtime.md) for applications and a
  read-only [MCP server](docs/en/mcp-tools.md) for independent AI agents.
- **Local and cloud composition:** providers are selected by deployment rather
  than embedded into retrieval contracts; see
  [architecture](docs/en/architecture.md).

## Project lines

| Project | Purpose | Status |
|---|---|---|
| **Semidex Lite** | A cloud-oriented npm package for adding document ingestion, Qdrant Cloud retrieval, and grounded Ask to another application's backend without local model infrastructure. | Published MVP. Read the [Semidex Lite README](packages/lite/README.md) or view the [npm package](https://www.npmjs.com/package/semidex-lite). |
| **Semidex Codebase** | A planned code-aware edition for repository ingestion, symbol and reference metadata, exact symbol lookup, dependency/call-graph navigation, and Git-aware incremental indexing. | Product development has not started. The shared Semidex foundation already contains structural chunking, deterministic identity, retrieval, and navigation capabilities that this edition can reuse. |

This repository currently contains the shared Semidex foundation and the
local-first reference application from which the editions are composed. Full
Semidex does not yet have a supported npm package; run it from source while its
installation, UI, and remaining critical functionality are being hardened.

## Quick start

### Semidex Lite

For a cloud-oriented application integration:

```bash
npm install semidex-lite
npx semidex-lite --help
```

Lite requires a Qdrant Cloud cluster and a supported cloud generation
provider. Its package README documents environment variables, indexing, Ask
API v1/v2, caller-owned conversation history, and deployment boundaries:
[packages/lite/README.md](packages/lite/README.md).

### Full Semidex from source

Prerequisites: Node.js 20.16+, Qdrant Cloud or a local Qdrant server, and Git.
Local generation through Ollama and local BGE-M3 embeddings are configured
separately.

```powershell
git clone https://github.com/CodeNoob53/semidex.git
Set-Location semidex
npm install
Copy-Item .env.example .env
npm run admin:build
npm run admin
```

Open [http://127.0.0.1:8642](http://127.0.0.1:8642). Before indexing, configure
Qdrant and the embedding/generation providers you intend to use.

The complete setup guide covers local and cloud Qdrant, model downloads,
Ollama, Windows DirectML/CUDA, indexing, verification, and troubleshooting:
**[Installation guide](docs/en/installation.md)**.

## Core commands

| Command | Purpose |
|---|---|
| `npm run admin:build` | Build the Admin UI. |
| `npm run admin` | Start the Admin API and UI at `127.0.0.1:8642`. |
| `COLLECTION=my-docs npm run index -- ./docs` | Index a file or directory. Always set `COLLECTION`. |
| `npm run mcp` | Start the read-only MCP server over stdio. |
| `npm run sync` | Synchronize collection metadata and Qdrant payload indexes. |
| `npm run doctor` | Run read-only environment diagnostics. |
| `npm test` | Run the bounded unit suite. |
| `npm run smoke` | Run offline smoke tests. |

PowerShell indexing example:

```powershell
$env:COLLECTION = 'my-docs'
$env:ONNX_EMBED = '1'
npm run index -- .\docs
```

Do not mix embedding providers inside one collection. Provider, vector schema,
or indexing-schema changes require a compatible reindex.

## How it works

```text
documents
  -> parse and preserve source structure
  -> token-aware retrieval chunks + navigation nodes
  -> optional summaries and tags
  -> dense + sparse embeddings
  -> Qdrant vectors, payloads, and collection profile
  -> hybrid retrieval and bounded evidence
       -> Ask API: grounded streamed answers
       -> MCP: search, navigation, and source inspection tools
```

Markdown currently has the strongest structural support. PDF, office/Pandoc,
and plain-text ingestion remain format-dependent; OCR and image understanding
are planned rather than implemented. See
[chunking quality](docs/en/chunking-quality.md) and
[project status](docs/en/roadmap.md#current-snapshot).

## Documentation

| Document | Scope |
|---|---|
| [Installation](docs/en/installation.md) | Full source setup, Lite entry point, providers, and verification |
| [Architecture](docs/en/architecture.md) | Runtime composition, indexing, storage, and provider boundaries |
| [Project structure](docs/en/project-structure.md) | Shared, local, cloud, and edition-owned modules |
| [Retrieval](docs/en/retrieval.md) | Dense/sparse search, RRF, reranking, and evidence |
| [MCP tools](docs/en/mcp-tools.md) | Agent integration and tool reference |
| [Configuration](docs/en/configuration.md) | Settings, models, formats, Qdrant, and hardware |
| [Operations](docs/en/operations.md) | Usage, maintenance, and troubleshooting |
| [Testing](docs/en/testing.md) | Test boundaries and commands |
| [Roadmap](docs/en/roadmap.md) | Current state, priorities, and future product tracks |

Documentation entry points: [English](docs/en/README.md) and
[Ukrainian](docs/ua/README.md).

## Status and scope

Semidex has working indexing, Qdrant storage, hybrid retrieval, structural
navigation, MCP tools, Ask APIs, Full/Lite composition boundaries, and
external retrieval benchmarks. It is not yet a production-ready hosted
assistant platform. Authentication for public API exposure, multi-tenancy,
finished end-user UX, uniform structural parsing across all formats, OCR, and
image understanding remain outside the shipped MVP.

Claims about retrieval quality are tied to the recorded benchmark datasets and
profiles; Semidex does not claim general superiority over other RAG systems.
See the [roadmap](docs/en/roadmap.md) for the current snapshot and exit gates.

## License and acknowledgements

Semidex is available under the [MIT License](LICENSE).

The project is developed with disclosed AI assistance from Claude and OpenAI
Codex. Product direction, architectural decisions, review, testing, and final
responsibility remain with the author.
