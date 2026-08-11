# semidex-lite

> [!IMPORTANT]
> **Package status: early MVP.** The previous README was a generated
> placeholder and did not describe the complete purpose, functionality, or
> limitations of `semidex-lite`. The package was initially published for
> personal use, npm distribution testing, and validation of Semidex's cloud
> profile. Its current feature set is limited, APIs and behavior may change,
> and production-ready stability is not guaranteed. Use it cautiously, do not
> rely on it for critical systems, and evaluate it against your own data and
> requirements.

**semidex-lite is the cloud edition of
[semidex](https://github.com/CodeNoob53/semidex), a flexible RAG system for
building knowledge bases from your own documents.** It indexes documents,
finds relevant passages through hybrid search, and generates grounded answers
with source references. semidex-lite uses Qdrant Cloud for storage and
embedding inference, Gemini for answer generation, and provides an HTTP Ask
API, an indexing CLI, and a compact admin dashboard.

## What to use semidex-lite for

The package can serve as a cloud RAG core for applications that need to search
their own documents and answer questions from them. Example uses include:

- a documentation or support assistant for a website;
- a Telegram bot or an assistant for another communication channel;
- search and Ask for an internal team or organization knowledge base;
- an educational or research assistant working with private materials;
- a retrieval component in a larger agent system or specialized product.

`semidex-lite` handles indexing, relevant-evidence retrieval, and the basic Ask
cycle. An application built around it can provide its own interface,
authentication, chat history, memory, context compression, additional tools,
and business rules. Integrate through the HTTP Ask API behind your own backend;
the current admin server is not intended to be exposed directly to the public
Internet.

The Ask system prompt in this MVP is internal and cannot be changed through the
public API or settings. An outer application can manage context before and
after an Ask call, but changing Gemini's internal instructions currently
requires modifying or forking the package source. A configurable system prompt
may be introduced later, but it is not part of the current public contract.

## How semidex-lite differs from full semidex

| | semidex | semidex-lite |
|---|---|---|
| Storage | Qdrant (local or Cloud) | Qdrant Cloud only |
| Embeddings | Ollama, local ONNX (BGE-M3), or Qdrant Cloud Inference | Qdrant Cloud Inference only |
| Answer generation | Ollama or Gemini | Gemini only |
| Chunk context for non-Markdown files | LLM-generated (Ollama) | Deterministic heading/section text with no LLM calls |
| Tag generation and combined LLM pass | Supported through Ollama or local ONNX | Not available |
| CUDA/DirectML hardware probes | Supported | Not available |
| Package size and install footprint | Includes `onnxruntime-node` and `@huggingface/transformers` | Includes neither, making installation smaller and faster |

Everything else, including hybrid dense+sparse retrieval, deterministic
reranking, skeleton-first Markdown chunking, PDF/Pandoc support, the Ask API,
collection browsing, and dashboard search, works in the same way.

> [!NOTE]
> Full `semidex` is currently available as source code in the
> [GitHub repository](https://github.com/CodeNoob53/semidex), but is not yet
> published as a separate ready-to-use npm package. That package is planned
> after broader testing, installation stabilization, and implementation of
> critical functionality. Until then, install `semidex-lite` from npm and run
> the full edition directly from its repository.

## Installation

### Install in a project (recommended)

```bash
npm install semidex-lite
```

This adds the package to the current project's dependencies and records its
version in `package.json` and the lockfile. It is the recommended option for
applications, containers, servers, and reproducible deployments because each
project uses its own defined `semidex-lite` version.

Run the locally installed CLI through `npx`, for example
`npx semidex-lite doctor`. All commands and their purposes are listed in the
[CLI](#cli) section.

### Install globally (optional)

```bash
npm install -g semidex-lite
```

A global installation adds `semidex-lite` to the system `PATH`, allowing it to
run from any directory without `npx`. This is convenient for personal use on
one computer, educational or research experiments, and manual work with your
own collections. A global version is not pinned per project, so local
installation is preferable for integrations and deployments.

> [!NOTE]
> The current `semidex-lite` package **does not include an MCP server**. It
> provides the HTTP Ask API for integration with websites, bots, and other
> applications. The MCP server is currently available only in full
> [semidex](https://github.com/CodeNoob53/semidex).

semidex-lite never writes into its own installation directory, so it works
with read-only `node_modules/`. All state, including configuration, settings,
and tokenizer cache, is stored in a per-OS application data directory. See
[`SEMIDEX_HOME`](#semidex_home).

## Configuration

Copy `.env.example` to `.env` in the directory from which you will run
`semidex-lite`, then configure:

- `QDRANT_URL`, `QDRANT_KEY` for your Qdrant Cloud cluster;
- `GEMINI_API_KEY` for Ask and generation. It is optional at startup:
  `serve`, `doctor`, and `index` work without it, but Ask requests fail until
  the key is configured.

See `.env.example` for all optional settings, including
`QDRANT_CLOUD_DENSE_MODEL`, `ASK_MODEL`, `ADMIN_HOST`/`ADMIN_PORT`, and
`SEMIDEX_HOME`.

Credentials are currently configured outside the dashboard. Add them to a
local `.env` file or operating-system environment variables before starting
`semidex-lite`. OS environment variables take precedence over `.env` values.
The dashboard reports whether credentials are configured, but the current
version cannot add, reveal, or replace `QDRANT_URL`, `QDRANT_KEY`, or
`GEMINI_API_KEY`.

Example for the current PowerShell session:

```powershell
$env:QDRANT_URL='https://your-cluster.cloud.qdrant.io'
$env:QDRANT_KEY='your-qdrant-api-key'
$env:GEMINI_API_KEY='your-gemini-api-key'
npx semidex-lite serve
```

Values set this way apply only to that PowerShell process and programs started
from it. For project-local configuration, prefer a `.env` file excluded from
version control. Never commit API keys.

At startup, semidex-lite unconditionally pins its cloud configuration,
including `DENSE_PROVIDER`, `SPARSE_PROVIDER`,
`SEMIDEX_GENERATION_BACKEND`, `CONTEXT_MODE`, and local-runtime toggles. A
stray local-provider variable left in a full-semidex `.env` cannot re-enable
local code. The Settings API and indexing-job API also reject attempts to
change these values at runtime.

## CLI

The examples below use the recommended project-local dependency through `npx`.
This ensures that the project runs the `semidex-lite` version pinned in its own
`package.json` and lockfile instead of an arbitrary system-wide version. If you
deliberately installed the package with `npm install -g semidex-lite`, you may
omit `npx` and run the same commands as `semidex-lite ...`.

```bash
npx semidex-lite --help                       # list cloud commands
npx semidex-lite doctor [--probe-inference]   # read-only health check
npx semidex-lite serve                        # start the admin API and dashboard
npx semidex-lite index <path>                 # index a file or folder
```

### `doctor`

Read-only by default. It checks the Node.js version, `.env` presence, Qdrant
Cloud and Gemini credential presence, and Qdrant Cloud reachability through a
cheap request. It does not create, modify, or delete anything.

The `--probe-inference` option performs a real embedding round-trip through a
**disposable** Qdrant Cloud collection. The collection is created and deleted
within the same command. This verifies that Cloud Inference works with the
selected dense model. The command displays a warning before proceeding.

### `serve`

Starts the admin API and dashboard at `ADMIN_HOST:ADMIN_PORT`, defaulting to
`127.0.0.1:8642`. If `QDRANT_URL`, `QDRANT_KEY`, or `GEMINI_API_KEY` is missing
or unavailable, the server starts in a degraded state: the dashboard reports
what is not configured rather than refusing to start. Only dependent
operations, such as search, indexing, or Ask, remain unavailable until the
configuration is corrected.

### `index`

```bash
COLLECTION=my-docs npx semidex-lite index ./docs
COLLECTION=my-docs npx semidex-lite index ./docs --prune-stale
```

In PowerShell, set the collection variable separately:

```powershell
$env:COLLECTION='my-docs'
npx semidex-lite index ./docs
```

Indexes a file or folder into the selected Qdrant Cloud collection. It supports
Markdown, plain text, PDF, and formats that Pandoc can convert. The
`--prune-stale` option deletes points for files that no longer exist under the
specified path. Use it only when indexing the complete source root, never a
subset.

There are no `--onnx-embed`, `--llm-summaries`, or `--tag-gen` options. These
are local features and are not part of this package.

## Ask: answers grounded in your knowledge base

Ask lets you question one indexed collection and receive an answer generated
by Gemini from passages found in that collection. The model does not receive
the whole collection: semidex-lite first retrieves a bounded set of relevant
sources and only then sends them to Gemini with the question.

### Use Ask in the dashboard

1. Configure `QDRANT_URL`, `QDRANT_KEY`, and `GEMINI_API_KEY`.
2. Index a file or folder through `semidex-lite index`.
3. Start the server with `npx semidex-lite serve`.
4. Open `http://127.0.0.1:8642`, select the collection, and switch to Ask.
5. Ask a question. The interface displays the generated answer and the sources
   supplied to the model.

### How an answer is produced

```text
User question
  -> embed the query with the model assigned to the collection
  -> hybrid dense+sparse search in Qdrant Cloud
  -> select and number relevant passages
  -> assemble a bounded evidence context
  -> send system rules + evidence + question to Gemini
  -> stream an answer with [1], [2], ... citations
```

The collection profile determines the embedding model used for the query. This
matters because retrieval must not use a different model or vector dimension
from the one used to index that collection.

Ask sends two separate inputs to Gemini:

- a **system prompt** containing behavioral rules;
- a **user prompt** containing numbered retrieved passages and the question.

The system prompt is sent through Gemini's native `systemInstruction`. It
requires the model to answer only from supplied sources, cite factual claims,
respond in the language of the question, ignore instructions embedded in
indexed documents, and refuse to answer when the evidence is insufficient.
This reduces hallucination and prompt-injection risk, but cannot eliminate it:
you should still assess generated output against the cited sources.

In the current version, the system prompt is an internal part of the Ask
runtime. It cannot be changed through the dashboard, `.env`, or an Ask API
request. Safe custom instructions may be added later together with validation
and constraints, but are not currently part of the public contract.

### Call Ask through the HTTP API

Ask is available at the versioned `POST /api/v1/ask` endpoint. After starting
`serve` locally:

```powershell
curl.exe -N -X POST "http://127.0.0.1:8642/api/v1/ask" `
  -H "Content-Type: application/json" `
  -d '{"collection":"my-docs","question":"What are the main requirements described in the documentation?"}'
```

Required request fields:

- `collection`: the name of one collection;
- `question`: a non-empty question.

The optional `scope.sourceFile` field limits retrieval to one known file:

```json
{
  "collection": "my-docs",
  "question": "What is the return policy?",
  "scope": {
    "sourceFile": "policies/returns.md"
  }
}
```

The response is streamed as Server-Sent Events (SSE):

- `sources`: passages selected as evidence;
- `answer_delta`: incremental answer text;
- `done`: the final answer, citations, model, token usage, and timing;
- `error`: a structured error.

Ask API v1 is stateless: every request is independent, and `sessionId`, chat
history, and long-term memory are not yet supported. The endpoint also has no
public authentication or abuse protection. Do not expose the admin server port
directly to the Internet. For an external integration, place your own
authenticated backend or reverse proxy with appropriate controls in front of
it.

## `SEMIDEX_HOME`

Application data, including `config.json`, `settings.json`, and the tokenizer
cache, is stored outside the installed package in the standard directory for
each OS:

- Windows: `%LOCALAPPDATA%\semidex-lite`
- macOS: `~/Library/Application Support/semidex-lite`
- Linux: `$XDG_DATA_HOME/semidex-lite`, or `~/.local/share/semidex-lite` when
  the variable is unset.

Override the location with the `SEMIDEX_HOME` environment variable. This
directory belongs exclusively to Lite and is never shared with full semidex.

## Limitations

- No local embedding or generation providers such as Ollama or local ONNX;
  only Qdrant Cloud Inference and Gemini are supported.
- No tag generation, combined context+tags LLM pass, or CUDA/DirectML probes.
- Advanced chunking and retrieval settings from full semidex are not shown in
  the Settings UI. The dense model and supported non-secret settings are
  configurable, but Qdrant and Gemini credentials must currently be supplied
  through OS environment variables or a local `.env` file.
- The Settings API exposes a smaller allow-list than full semidex. Attempts to
  write unsupported settings return `not_available_in_lite`.

For capabilities outside these limits, use full
[semidex](https://github.com/CodeNoob53/semidex).

## License

MIT
