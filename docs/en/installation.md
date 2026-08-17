# Installation

This guide covers the published Semidex Lite package and the local-first
Semidex application in this repository. Semidex is an experimental MVP; use a
separate test collection and avoid exposing the Admin or Ask APIs directly to
the public Internet without your own authentication and authorization layer.

## Choose an edition

Use **Semidex Lite** when your application can use Qdrant Cloud Inference and a
cloud generation provider. Use **Full Semidex from source** when you need the
local-first runtime, MCP server, local embeddings, or local generation.

Semidex Codebase is a planned product line and does not yet have an installer.

## Semidex Lite

Install Lite inside the application that will own its configuration and API
integration:

```bash
npm install semidex-lite
npx semidex-lite --help
npx semidex-lite doctor
```

A global installation is optional and intended for direct CLI use:

```bash
npm install --global semidex-lite
semidex-lite --help
```

Lite requires Qdrant Cloud credentials and a supported generation-provider
key. Follow the package-specific guide for its environment variables, model
selection, indexing commands, Ask API contracts, and caller-owned conversation
state: [Semidex Lite README](../../packages/lite/README.md).

## Full Semidex from source

### Requirements

- Git.
- Node.js 20.16 or newer and npm.
- Qdrant Cloud or a local Qdrant server.
- Internet access for dependency installation and the first local model
  download.
- Ollama only for Ollama-backed generation, summaries, tags, or embeddings.
- Pandoc only for `.docx`, `.odt`, `.rtf`, `.epub`, and HTML conversion.

Windows 10/11 is the currently verified end-to-end platform. Linux and macOS
remain experimental.

### Clone and install

```powershell
git clone https://github.com/CodeNoob53/semidex.git
Set-Location semidex
npm install
Copy-Item .env.example .env
```

For POSIX shells, replace the final command with:

```bash
cp .env.example .env
```

Settings resolve in this order:

```text
OS environment > .env > settings.json > built-in default
```

API keys should remain in the OS environment or `.env`; the Admin UI does not
persist secrets to `settings.json`.

### Configure Qdrant

Set `QDRANT_URL` and, for authenticated deployments, `QDRANT_KEY` in `.env`.
Use the values from the Qdrant Cloud cluster dashboard, or start a local
Qdrant container:

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

The default local endpoint is `http://127.0.0.1:6333`.

### Choose embeddings

The recommended local multilingual path is BGE-M3 through ONNX Runtime:

```dotenv
ONNX_EMBED=1
```

The model weights are not part of `npm install`. On the first embedding job,
Semidex downloads approximately 2.3 GB of BGE-M3 ONNX files from Hugging Face
and stores them in the model cache. Interrupted downloads can resume; later
runs reuse the cache.

CPU and DirectML use the standard npm runtime. Windows CUDA requires the
managed or custom CUDA-enabled ONNX Runtime described in the dedicated
[Windows CUDA guide](windows-cuda-onnxruntime-install.md). Selecting `cuda`
does not prove that CUDA loaded; verify the effective provider with the Admin
probe or `npm run doctor`.

### Configure generation when needed

Skeleton-first Markdown indexing can use deterministic context and does not
require an LLM. Install Ollama only if you want local Ask generation,
LLM-generated summaries, tags, or an Ollama embedding fallback:

```bash
ollama serve
ollama pull gemma3:4b
```

For Gemini generation, set:

```dotenv
GEMINI_API_KEY=your-key
SEMIDEX_GENERATION_BACKEND=gemini
```

Provider and model details are maintained in
[configuration.md](configuration.md).

### Build and start the Admin application

```bash
npm run admin:build
npm run admin
```

Open [http://127.0.0.1:8642](http://127.0.0.1:8642). The current interface is
an early administration and diagnostics surface. Rebuild after changing UI
sources.

For UI development, run the API and Vite server separately:

```bash
# terminal 1
npm run admin

# terminal 2
npm run admin:dev
```

### Index a collection

Always set `COLLECTION`. Recommended PowerShell example:

```powershell
$env:COLLECTION = 'my-docs'
$env:ONNX_EMBED = '1'
npm run index -- .\docs
```

POSIX equivalent:

```bash
COLLECTION=my-docs ONNX_EMBED=1 npm run index -- ./docs
```

Markdown automatically uses skeleton-first structural chunking. Tags and LLM
summaries are optional. Do not mix embedding providers or incompatible vector
schemas in one collection.

### Connect an MCP client

Windows example for Claude Code:

```powershell
claude mcp add --scope user semidex -- node C:\absolute\path\to\semidex\src\mcp\server.js
```

Linux/macOS example:

```bash
claude mcp add --scope user semidex -- node /absolute/path/to/semidex/src/mcp/server.js
```

The MCP surface is read-only: it searches and navigates indexed knowledge but
does not index or delete documents.

### Verify the installation

```bash
npm run doctor
npm run smoke
```

Run unit tests when changing the source:

```bash
npm test
```

## Troubleshooting

- **Qdrant is unreachable:** verify `QDRANT_URL`/`QDRANT_KEY`, then run
  `npm run doctor` and `npm run sync`.
- **First indexing run is slow:** the ONNX model may still be downloading or
  initializing.
- **Ollama is unavailable:** start `ollama serve` and verify that the selected
  model was pulled.
- **Tokenizer/model cache failure:** check available disk space and the model
  cache; avoid deleting a valid cache unless you intend to download it again.
- **CUDA setting falls back to CPU:** follow the Windows CUDA guide and test
  the effective provider rather than relying on the configured value.
- **Stale points after files were deleted:** use `PRUNE_STALE=1` only while
  indexing the complete source root, never a subset.

For operating procedures and additional failure modes, see
[operations.md](operations.md).
