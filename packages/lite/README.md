# semidex-lite

A cloud-only distribution of [semidex](https://github.com/CodeNoob53/semidex): Qdrant Cloud for storage and embedding inference, Gemini for answer generation, an HTTP Ask API, an indexing CLI, and a small admin dashboard. Built for cheap servers and containers — **semidex-lite never downloads or initializes a local model runtime** (no ONNX Runtime, no CUDA/DirectML, no Ollama).

## What's different from full semidex

| | semidex | semidex-lite |
|---|---|---|
| Storage | Qdrant (local or Cloud) | Qdrant Cloud only |
| Embeddings | Ollama, local ONNX (BGE-M3), or Qdrant Cloud Inference | Qdrant Cloud Inference only |
| Answer generation | Ollama or Gemini | Gemini only |
| Chunk context (non-Markdown files) | LLM-generated (Ollama) | Deterministic (heading/section text, zero LLM calls) |
| Tag generation, combined LLM pass | Supported (Ollama or local ONNX) | Not available |
| CUDA/DirectML hardware probes | Supported | Not available |
| Package size / install footprint | Includes `onnxruntime-node` + `@huggingface/transformers` | Neither — install is much smaller and faster |

Everything else — hybrid dense+sparse retrieval, deterministic reranking, skeleton-first Markdown chunking, PDF/Pandoc support, the Ask API, the admin dashboard's collection browser and search — works the same way.

## Install

```bash
npm install -g semidex-lite
```

semidex-lite never writes into its own install directory (works from a read-only `node_modules/`). All state (config, settings, tokenizer cache) lives under a per-OS application data directory — see `SEMIDEX_HOME` below.

## Configuration

Copy `.env.example` to `.env` in the directory you'll run `semidex-lite` from, and fill in:

- `QDRANT_URL`, `QDRANT_KEY` — your Qdrant Cloud cluster.
- `GEMINI_API_KEY` — for Ask/generation (optional at startup; `serve`/`doctor`/`index` all work without it, but Ask requests fail until it's set).

See `.env.example` for the full list of optional settings (`QDRANT_CLOUD_DENSE_MODEL`, `ASK_MODEL`, `ADMIN_HOST`/`ADMIN_PORT`, `SEMIDEX_HOME`).

Credentials are currently configured outside the dashboard. Set them either
in that local `.env` file or as operating-system environment variables before
starting `semidex-lite`. OS environment variables take precedence over values
from `.env`. The dashboard reports whether credentials are configured, but it
cannot add, reveal, or replace `QDRANT_URL`, `QDRANT_KEY`, or `GEMINI_API_KEY`
in the current release.

Example for the current PowerShell session:

```powershell
$env:QDRANT_URL='https://your-cluster.cloud.qdrant.io'
$env:QDRANT_KEY='your-qdrant-api-key'
$env:GEMINI_API_KEY='your-gemini-api-key'
npx semidex-lite serve
```

Values set this way apply only to that PowerShell process and programs started
from it. For project-local configuration, prefer a `.env` file that is excluded
from version control. Never commit API keys.

semidex-lite pins its cloud-only configuration (`DENSE_PROVIDER`, `SPARSE_PROVIDER`, `SEMIDEX_GENERATION_BACKEND`, `CONTEXT_MODE`, and the local-runtime toggles) unconditionally at startup — a stray local-provider environment variable left over from a full-semidex `.env` cannot re-enable a local code path. The Settings API and indexing-job API separately reject any attempt to change these at runtime.

## CLI

```bash
semidex-lite --help                       # cloud-only command list
semidex-lite doctor [--probe-inference]   # read-only environment health check
semidex-lite serve                        # start the admin API + dashboard
semidex-lite index <path>                 # index a file or folder
```

### `doctor`

Read-only by default: checks Node version, `.env` presence, Qdrant Cloud/Gemini credential presence, and a cheap Qdrant Cloud reachability probe. Never creates, mutates, or deletes anything.

`--probe-inference` runs a real embedding round-trip against a **disposable** Qdrant Cloud collection (created and deleted within the same command) to verify Cloud Inference actually works for your configured dense model. Prints a warning before doing so.

### `serve`

Starts the admin API and dashboard on `ADMIN_HOST:ADMIN_PORT` (default `127.0.0.1:8642`). Starts in a degraded state if `QDRANT_URL`/`QDRANT_KEY`/`GEMINI_API_KEY` are missing or unreachable — the dashboard reports what's unconfigured rather than refusing to start; only the dependent operations (search, index, Ask) fail until the missing configuration is provided.

### `index`

```bash
COLLECTION=my-docs semidex-lite index ./docs
COLLECTION=my-docs semidex-lite index ./docs --prune-stale
```

Indexes a file or folder into the named Qdrant Cloud collection. Supports Markdown, plain text, PDF, and any format Pandoc can convert. `--prune-stale` removes points for files no longer present under the given path — use it only when indexing the complete source root, not a subset.

No `--onnx-embed`/`--llm-summaries`/`--tag-gen` flags exist — those are local-only features this package does not include.

## `SEMIDEX_HOME`

Application data (`config.json`, `settings.json`, tokenizer cache) lives outside the installed package, at a per-OS default:

- Windows: `%LOCALAPPDATA%\semidex-lite`
- macOS: `~/Library/Application Support/semidex-lite`
- Linux: `$XDG_DATA_HOME/semidex-lite` (falls back to `~/.local/share/semidex-lite`)

Override with the `SEMIDEX_HOME` environment variable. This location is Lite-specific and never shares state with a full-semidex install.

## Limitations

- No local embedding/generation providers (Ollama, local ONNX) — Qdrant Cloud Inference and Gemini only.
- No tag generation, no combined context+tags LLM pass, no CUDA/DirectML probes.
- Advanced chunking/retrieval-tuning settings available in full semidex's Settings UI are not exposed here. The dense model and supported non-secret options are configurable; Qdrant and Gemini credentials currently require OS environment variables or a local `.env` file.
- The Settings API exposes a smaller allow-list of keys than full semidex; writing an unsupported key returns `not_available_in_lite`.

For anything beyond this scope, use full [semidex](https://github.com/CodeNoob53/semidex) instead.

## License

MIT
