# semidex

![semidex](assets/avif/banner_logo.avif)

![Node.js](https://img.shields.io/badge/node-%3E%3D20.16-brightgreen?logo=node.js&logoColor=white)
![npm](https://img.shields.io/badge/version-2.0.0-blue?logo=npm&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)
![Ollama](https://img.shields.io/badge/Ollama-local%20generation-black?logo=ollama&logoColor=white)
![ONNX Runtime](https://img.shields.io/badge/ONNX%20Runtime-BGE--M3-blue?logo=onnx&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-vector%20DB-red?logo=qdrant&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)

**Local-first document retrieval and grounded-answer runtime for AI agents and
applications.**

semidex indexes documents into Qdrant, exposes retrieval tools through
[MCP](https://modelcontextprotocol.io), and provides an early Ask runtime for
websites, bots, internal tools, and custom applications. Instead of sending an
entire document library to a model, a client retrieves the relevant evidence
and can request bounded surrounding context when necessary.

The local stack can use BGE-M3 through ONNX Runtime for multilingual dense and
sparse embeddings, Ollama for local generation, and Qdrant for storage. Ask can
also use Gemini generation. External generation is optional; document indexing
and retrieval can run without sending source text to a cloud LLM.

> **Status:** semidex is a working experimental MVP, not a production-ready
> assistant platform. Current benchmarks are primarily internal regression
> suites; external retrieval evaluation and direct competitor comparisons are
> still required. The current Admin UI is an early debug/administration
> interface under active development, not the finished user dashboard. See
> [Project Status](#project-status) and the
> [roadmap](docs/en/roadmap.md).

## Contents

- [Why semidex](#why-semidex)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Models and Providers](#models-and-providers)
- [CLI and MCP](#cli-and-mcp)
- [How It Works](#how-it-works)
- [Optional Tags](#optional-tags)
- [Supported Formats](#supported-formats)
- [Platform Support](#platform-support)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Project Status](#project-status)

## Why semidex

| Problem | What semidex provides |
|---------|-----------------------|
| Large document collections do not fit into an agent context window | Hybrid retrieval returns a small set of relevant chunks |
| Tables and code lose meaning when flattened into prose | Optional skeleton-first chunking stores typed structural nodes and their authoritative raw content |
| Agents need orientation before searching an unfamiliar collection | File, directory, and skeleton navigation tools provide a drill-down map |
| Semantic search misses exact identifiers | Dense and sparse retrieval combine meaning with lexical evidence |
| Products repeatedly rebuild RAG orchestration | The Ask runtime is becoming a reusable retrieval, evidence, generation, citation, and refusal boundary |
| Private data should remain local | Qdrant, ONNX embeddings, Ollama generation, and the Admin UI can all run locally |
| Indexing should be repeatable | File hashes skip unchanged files and deterministic point IDs make updates idempotent |

## Requirements

- Node.js **20.16 or newer** and npm.
- Qdrant Cloud, or a local Qdrant server.
- Internet access on the first ONNX model download.
- Ollama only when using Ollama embeddings, LLM summaries, Ollama tags, or
  local Ask generation.
- Pandoc only for `.docx`, `.odt`, `.rtf`, `.epub`, and HTML conversion.

Windows 10/11 is the verified platform. Linux and macOS remain experimental and
unverified; see [Platform Support](#platform-support).

## Quick Start

### 1. Install semidex

```powershell
npm install
Copy-Item .env.example .env
```

POSIX shells can use `cp .env.example .env` instead. The template targets a
local Qdrant server. For Qdrant Cloud, replace `QDRANT_URL` and `QDRANT_KEY`
with the values from the cluster dashboard.

Settings resolve in this order:

```text
OS environment > .env > settings.json > built-in default
```

The Admin UI can persist non-secret settings to `settings.json`. API keys stay
environment-only and are never displayed or written there.

### 2. Start Qdrant

Use an existing Qdrant Cloud cluster, or run Qdrant locally:

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

### 3. Build and open the Admin UI

```bash
npm run admin:build
npm run admin
```

Open [http://127.0.0.1:8642](http://127.0.0.1:8642). The production server
serves the Vite build from `dist/admin-ui`; rebuild after changing UI sources.
The interface currently exposes working administration and diagnostic flows,
but its information architecture and user experience are still being rebuilt.
Treat it as an early debug/admin surface rather than a finished product UI.

Use **Create a collection** to:

1. Select a source folder with the folder picker.
2. Enter a collection name.
3. Select the embedding backend.
4. Enable skeleton-first chunking for Markdown collections when structural
   navigation and typed table/code/checklist nodes are needed.
5. Optionally enable LLM summaries or tags.

The indexer creates the Qdrant collection automatically. Re-running a job skips
unchanged files and replaces only changed file points.

For UI development, run the API and Vite as two processes:

```bash
# terminal 1
npm run admin

# terminal 2
npm run admin:dev
```

### 4. Configure only the models you use

The recommended local embedding backend is **BGE-M3 (ONNX)**. It does not need
Ollama. `npm install` installs the ONNX runtime and integration code, but not
the 2.3 GB model. semidex downloads `aapot/bge-m3-onnx` from Hugging Face when
the first embedding operation starts, stores it under `models/`, and reuses
that cache on later runs. An interrupted model download can be resumed. The
first ONNX indexing job therefore needs internet access and takes longer than
subsequent jobs.

Install and start Ollama only for Ollama-backed features:

```bash
ollama serve
ollama pull gemma3:4b
```

`gemma3:4b` is the current default for local Ask answers, indexing-time LLM
summaries, and Ollama tag generation. The Ollama embedding backend is separate
from the ONNX backend: semidex does not download Ollama models automatically.
Pull Ollama's `bge-m3` manually only when using the lighter Ollama embedding
fallback:

```bash
ollama pull bge-m3
```

For Gemini Ask generation, set the key in the OS environment or `.env`, then
select Gemini and an available model under **Settings > AI providers**:

```dotenv
GEMINI_API_KEY=your-key
SEMIDEX_GENERATION_BACKEND=gemini
```

The model selectors discover installed Ollama models from the running Ollama
server and available Gemini models from the configured Gemini API. semidex does
not pull Ollama models or start Ollama automatically. Gemini model discovery,
streaming generation, Ukrainian output, citations, and refusal behavior were
verified against a real Gemini account on 2026-07-20.

## Models and Providers

Embedding and answer generation are separate choices. Selecting Gemini for Ask
does not change how documents are embedded, and selecting ONNX embeddings does
not require a local generation model.

| Component | Current provider | Installation and behavior |
|-----------|------------------|---------------------------|
| Recommended embeddings | BGE-M3 via ONNX Runtime | Not included in `npm install`; semidex downloads about 2.3 GB from Hugging Face on the first embedding operation, resumes interrupted downloads, and caches the files in `models/` |
| Lightweight embedding fallback | Ollama `bge-m3` + hashed-TF sparse | Never downloaded by semidex; requires a running Ollama server and a manual `ollama pull bge-m3`; not equivalent to full BGE-M3 dense+sparse |
| Local Ask generation | Ollama, default `gemma3:4b` | Requires a running Ollama server and a manually pulled model |
| Cloud Ask generation | Gemini, default `gemini-flash-latest` | Live-verified; requires `GEMINI_API_KEY`; no local model download. Benchmarks must pin an exact model ID rather than the moving `latest` alias |
| Skeleton nav summaries | Ollama, opt-in with `SKELETON_SUMMARY=llm` | Deterministic summaries remain the default; unchanged files reuse existing nav data |
| Tags | Ollama by default; optional ONNX worker | Disabled by default; generate during indexing or backfill later |

Useful model rules:

- The first ONNX run can be slow while model files download and initialize.
- Do not delete `models/` unless you intentionally want to download cached
  models again.
- Do not mix embedding providers inside one Qdrant collection. A provider,
  vector-size, or indexing-schema change requires reindexing.
- LLM summaries and tags are optional. Skeleton-first Markdown indexing with
  deterministic structural context can run with ONNX and Qdrant only.
- Qdrant Cloud inference is planned for the Semidex Lite profile; it is not a
  current embedding backend and must be benchmarked against local BGE-M3 before
  becoming a recommended mode.

Detailed provider and hardware settings are documented in
[configuration.md](docs/en/configuration.md).

## CLI and MCP

### Index from the CLI

Recommended Markdown indexing on PowerShell:

```powershell
$env:COLLECTION = 'my-docs'
$env:ONNX_EMBED = '1'
npm run index -- .\docs
```

POSIX shell equivalent:

```bash
COLLECTION=my-docs ONNX_EMBED=1 npm run index -- ./docs
```

Markdown files always index through the skeleton (AST-based structural)
chunker, with navigation points and deterministic structural context
generated automatically — this is architecture, not configuration, and
cannot be turned off. Non-Markdown formats (PDF, Pandoc-converted formats,
plain text) still use the legacy heading-aware chunker.

### Connect an MCP client

Linux / macOS:

```bash
claude mcp add --scope user semidex -- node /absolute/path/to/semidex/src/mcp/server.js
```

Windows:

```powershell
claude mcp add --scope user semidex -- node C:\absolute\path\to\semidex\src\mcp\server.js
```

Reconnect MCP servers in the client and verify the `semidex` server. MCP tools
are read-only: they search, navigate, and assemble bounded evidence, but do not
index or delete documents.

<table><tr>
<td><img src="assets/avif/mcp_connected.avif" alt="MCP connected"/></td>
<td><img src="assets/avif/mcp_status.avif" alt="MCP tools status"/></td>
</tr></table>

### Core commands

| Command | Description |
|---------|-------------|
| `npm run admin:build` | Build the Admin UI into `dist/admin-ui` |
| `npm run admin` | Start the local Admin API and serve the built UI on port 8642 |
| `npm run admin:dev` | Start the Vite UI dev server; run `npm run admin` separately |
| `COLLECTION=my-docs npm run index -- ./docs` | Index a file or folder (POSIX syntax) |
| `PRUNE_STALE=1 COLLECTION=my-docs npm run index -- ./docs` | Remove points for files no longer under the full source root |
| `COLLECTION=my-docs npm run backfill:tags` | Generate missing tags without rebuilding vectors |
| `npm run mcp` | Start the MCP server over stdio |
| `npm run sync` | Sync local collection metadata and Qdrant payload indexes |
| `npm run doctor` | Run read-only environment diagnostics with redacted output |
| `npm test` | Run bounded unit tests |
| `npm run smoke` | Run the offline smoke suite |

Always set `COLLECTION` for CLI indexing. Use `PRUNE_STALE=1` only when the
target is the complete source root, never a subset.

## How It Works

```text
Documents
  -> parse and chunk
       -> legacy: heading-aware, tokenizer-aware prose chunks
       -> skeleton-first: typed prose/table/code/checklist nodes + nav tree
  -> context
       -> legacy: per-chunk Ollama context
       -> skeleton-first: deterministic structural context by default
  -> optional nav summaries and tags
  -> dense + sparse embeddings
  -> Qdrant named vectors and payload metadata
  -> hybrid retrieval with Qdrant RRF fusion
       -> MCP: an external agent controls navigation and evidence retrieval
       -> Ask: semidex retrieves evidence and streams a grounded answer
```

At query time semidex uses the embedding provider recorded for the collection,
runs dense and sparse prefetches in Qdrant, fuses their ranks with RRF, and can
apply the optional deterministic reranker. Absolute RRF scores are not
confidence values; rank order and source evidence matter.

A skeleton retrieval point can carry fields such as:

```text
id                         deterministic UUID
vectors.dense              1024-dimensional BGE-M3 vector
vectors.sparse             token indices and learned sparse weights
payload.text               searchable chunk text
payload.raw_content        authoritative original table/code/checklist content
payload.context            deterministic or generated retrieval context
payload.node_type          paragraph, table, code_block, checklist, ...
payload.node_id/parent_id   structural identity and relationship
payload.heading_path       complete heading ancestry
payload.source_file        stable source path
payload.chunk_index        position among retrieval chunks in the file
payload.provider/schema    compatibility metadata
```

Navigation summaries are a project map, not final factual evidence. Agents
should verify claims with retrieval chunks or bounded assembled content.

Details: [architecture.md](docs/en/architecture.md),
[retrieval.md](docs/en/retrieval.md), and
[chunking-quality.md](docs/en/chunking-quality.md).

## Optional Tags

Tags are disabled by default and remain payload metadata; they do not improve
the embedding vectors themselves. Enable them for tag browsing, tag filters,
or collection auditing.

PowerShell:

```powershell
$env:COLLECTION = 'my-docs'
$env:TAG_GEN = '1'
npm run index -- .\docs

# or backfill an existing collection later
$env:COLLECTION = 'my-docs'
npm run backfill:tags
```

When `TAG_MODEL` is unset, Ollama tag generation uses `CONTEXT_MODEL`. The
optional ONNX tag worker has separate model and resource requirements; see
[configuration.md](docs/en/configuration.md#tag_provider).

## Supported Formats

Markdown is the primary format and provides the best structural fidelity.
Other formats are converted to text or Markdown, so output quality depends on
the source document and the third-party parser.

| Format | Method | Support level |
|--------|--------|---------------|
| `.md` | Native Markdown parser and AST-based skeleton parser | Primary |
| `.txt` | Native text parser | Plain text; no Markdown structure |
| `.pdf` | `@opendocsg/pdf2md` to Markdown | Partial; depends on the PDF text layer |
| `.docx`, `.odt`, `.rtf`, `.epub`, `.html`, `.htm` | Pandoc to Markdown | Partial; depends on conversion quality |

OCR and image understanding are planned, not implemented. Pandoc is required
only for the formats in the final row.

## Platform Support

**Windows 10/11** is the verified end-to-end target. ONNX embeddings support
CPU and DirectML out of the box via the standard npm-installed
`onnxruntime-node` package. CUDA is also configurable, but requires a
compatible **custom** `onnxruntime-node` build (`ONNXRUNTIME_NODE_PATH`) —
the standard package has no CUDA execution provider compiled in, and CUDA
Toolkit/cuDNN are OS-level prerequisites semidex does not install or manage.
Selecting `cuda` configures the request only; it does not prove CUDA
actually loaded. Verify the effective provider with the Admin UI's
"Test CUDA configuration" probe or `npm run doctor`, never from the setting
alone. Ollama independently selects its available local hardware backend.

Linux and macOS are **experimental and unverified**. The Node.js and CPU paths
are intended to be portable, but semidex does not claim end-to-end support on
hardware that has not been tested. See the detailed matrix in
[configuration.md](docs/en/configuration.md#platform-support).

## Documentation

| Language | Entry point |
|----------|-------------|
| English | [docs/en/README.md](docs/en/README.md) |
| Ukrainian | [docs/ua/README.md](docs/ua/README.md) |

| Document | Covers |
|----------|--------|
| [architecture.md](docs/en/architecture.md) | Indexing pipeline, local models, storage, source of truth |
| [retrieval.md](docs/en/retrieval.md) | Dense and sparse vectors, RRF, providers, reranking |
| [mcp-tools.md](docs/en/mcp-tools.md) | MCP tool reference and agent workflow |
| [configuration.md](docs/en/configuration.md) | Settings precedence, providers, models, formats, Qdrant indexes |
| [chunking-quality.md](docs/en/chunking-quality.md) | Chunking guarantees, structural carryover, failure modes |
| [benchmarking.md](docs/en/benchmarking.md) | Regression benchmarks and validation workflow |
| [roadmap.md](docs/en/roadmap.md) | MVP sequence, future tracks, and non-goals |
| [operations.md](docs/en/operations.md) | Usage, limitations, and troubleshooting |
| [ask-application-runtime.md](docs/design/ask-application-runtime.md) | Ask runtime, demo boundary, and application integrations |

## Roadmap

Near-term work focuses on:

1. Hardening the Admin UI and Ask demo workflow.
2. Validating local BGE-M3 and future Qdrant Cloud inference on external
   retrieval datasets such as BEIR, MIRACL (which validates its own supported
   languages — MIRACL does not include Ukrainian), and MLDR. Ukrainian
   retrieval quality still requires a separate, dedicated Ukrainian dataset.
3. Completing the provider abstraction beyond Ollama and Gemini.
4. Promoting skeleton-first chunking only after benchmark and migration gates.
5. Adding OCR plus image understanding for image-bearing documents.

Future product tracks include Semidex Lite, Codebase Memory, Agent Memory,
website/bot integration kits, and broader storage backends. See
[roadmap.md](docs/en/roadmap.md) for scope and exit gates.

## Project Status

Implemented:

- Local-first indexer, Qdrant storage adapter, early debug/admin UI, and
  read-only MCP server
- Skeleton-first Markdown chunking (unconditional); legacy chunking remains
  for non-Markdown formats and benchmarks
- Typed table, code, and checklist retrieval nodes with authoritative raw data
- BGE-M3 ONNX dense+sparse embeddings and Ollama+hashed-TF fallback
- Hybrid Qdrant retrieval with RRF fusion and an optional reranker
- Skeleton navigation and bounded section/file evidence assembly
- Optional Ollama nav summaries and payload tags
- Provider-aware settings and model discovery
- Versioned, stateless Ask API (`POST /api/v1/ask`) with retrieval, bounded
  evidence, native provider system instructions, SSE streaming, citations,
  and refusal behavior
- Ollama Ask generation and a live-verified Gemini adapter
- Hash-based incremental indexing, deterministic IDs, and stale-file pruning
- Offline unit/smoke tests and internal retrieval regression suites

Not implemented or not yet validated:

- Authenticated/public-Internet-safe Ask API exposure, SDK/widget, Telegram
  adapter, sessions/conversation memory, and multi-tenant controls (the
  versioned `POST /api/v1/ask` contract itself is implemented — see
  [docs/ask-api-v1-contract-2026-07-28.md](docs/ask-api-v1-contract-2026-07-28.md) —
  but it is not yet authenticated or safe for direct public Internet
  exposure)
- Finished user-facing dashboard UX; the current Admin UI remains an early
  debug and administration surface
- Qdrant Cloud inference as a Semidex Lite embedding backend
- External dataset evaluation and direct workflow comparisons
- Skeleton-first chunking as the default for all suitable collections
- OCR, image description, and image-to-entity retrieval
- Full storage portability beyond the current Qdrant-first implementation
- Git-aware Codebase Memory sync and long-lived structural identity across
  source edits

semidex does not currently claim superiority over other RAG systems. Its value
must be demonstrated through external benchmarks and real application demos,
not inferred from internal regression results.

## License and Acknowledgements

Licensed under the [MIT License](LICENSE).

Built with AI assistance throughout development:

- [Claude](https://claude.ai) (Anthropic): code generation and documentation
- [OpenAI Codex](https://openai.com/codex/): code review and engineering support

Pipeline design, product direction, core mechanics, and testing by the author.
