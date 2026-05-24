---
name: semidex
description: "Use when working with semidex: indexing documents, configuring retrieval, debugging search results, checking env vars, or understanding architecture. Prefer live semidex MCP search over loading static docs into context."
allowed-tools: mcp__qdrant__qdrant_search, mcp__qdrant__qdrant_collection_info, mcp__qdrant__qdrant_get_chunk, mcp__qdrant__qdrant_find_by_tag, mcp__qdrant__qdrant_related, mcp__qdrant__qdrant_backlinks, mcp__qdrant__qdrant_list_files, mcp__qdrant__qdrant_list_tags, mcp__qdrant__qdrant_list_directories
---

semidex is a local-first RAG indexer and MCP server backed by Qdrant.
Its own docs are indexed in `semidex-docs`. Search that collection first when
you need current semidex behavior, parameters, or troubleshooting guidance.

## MCP Setup

Use the semidex MCP server, not a generic Qdrant MCP plugin.

Example `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "qdrant": {
      "command": "node",
      "args": ["C:\\Users\\Aorus\\Documents\\Projects\\semidex\\src\\mcp\\server.js"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_KEY": "optional-if-required"
      }
    }
  }
}
```

For Qdrant Cloud, set `QDRANT_URL` to the HTTPS cluster URL and provide
`QDRANT_KEY`. Do not paste API keys into reports or chat summaries.

The semidex MCP server reads semidex config and embeds queries with the
collection's configured provider. Generic `qdrant-mcp` tools may hardcode the
wrong embedding provider and can return wrong results for `bge-m3-onnx`
collections.

## Search Workflow

Start with collection metadata:

```text
qdrant_collection_info()
  -> qdrant_list_directories(collection)                    # explore folder structure
  -> qdrant_list_files(collection, source_prefix="...")     # list files in a known folder
  -> qdrant_search first, inspect tags in results
  -> qdrant_list_tags(collection, tag_prefix=... or contains=...)  # discover valid tags; filter on large collections
  -> qdrant_find_by_tag for breadth expansion
```

Sanity check the MCP wiring before relying on search results:
- Confirm the expected collection exists, usually `semidex-docs`.
- For `semidex-docs`, expect semidex metadata such as `semidexManaged: true`,
  provider fields, point count, and a useful description.
- Legacy or foreign collections may not have `semidexManaged`, but semidex-owned
  collections should expose provider/management metadata.
- If `qdrant_collection_info()` returns only generic Qdrant collection names
  without semidex provider or management metadata, stop and warn that Claude may
  be connected to a generic Qdrant MCP server instead of semidex MCP.

Then search with compact neighbors for most work:

```text
qdrant_search(
  query="$ARGUMENTS",
  collection="semidex-docs",
  top=3,
  window=1,
  window_format="compact"
)
```

Use `top=5` for ambiguous, negative, or scope-sensitive queries. For exact
identifiers, include the exact string in the query: env vars, error messages,
function names, config keys, CLI flags, model names, file paths, and log
fragments.

## MCP Tools And Parameters

| Goal | Tool |
|------|------|
| List collections and provider metadata | `qdrant_collection_info()` |
| Explore folder structure | `qdrant_list_directories(collection, source_prefix?, depth?)` |
| List files in a folder | `qdrant_list_files(collection, source_prefix?, tags?, tag_match?)` |
| List available tags | `qdrant_list_tags(collection, source_prefix?, tag_prefix?, contains?, min_count?)` |
| Search semantically and lexically | `qdrant_search(query, collection, top=3, window=1, window_format="compact")` |
| Search inside one file | `qdrant_search(query, collection, source_file="docs/en/retrieval.md", top=3, window=1, window_format="compact")` |
| Filter by tags | `qdrant_search(query, collection, tags=["providers"], top=5)` |
| Read a chunk and neighbors | `qdrant_get_chunk(collection, source_file, chunk_index, window=1)` |
| Find chunks by tag(s) | `qdrant_find_by_tag(collection, tags=[...], match="any"\|"all")` |
| Follow outgoing semantic links | `qdrant_related(collection, source_file)` |
| Find incoming semantic links | `qdrant_backlinks(collection, source_file)` |

Notes:
- `qdrant_search` always uses hybrid dense+sparse RRF.
- `window_format="compact"` returns snippets for neighbor chunks.
- Use `qdrant_get_chunk(..., window=1)` when full neighbor text is needed.
- `tags` on `qdrant_search` are OR filters. Combine with `source_file` only when the file scope is known.
- `source_prefix` filters by `source_file` path prefix. `tag_prefix` and `contains` filter tag names — they are not `source_file` filters.
- `qdrant_list_tags` without filters can be noisy on large collections — use `tag_prefix` or `contains` to narrow.
- Do not guess `source_file` when `qdrant_list_directories` / `qdrant_list_files` can resolve it.
- Tags are best used for breadth expansion after `qdrant_search`, not always as a first step.

## Retrieval Safety Rules

- Do not treat absolute RRF scores as confidence. Scores around `0.016-0.033`
  are normal for hybrid RRF. Compare rank, source file, section, context,
  exact-token overlap, and neighbor chunks.
- Verify scope before answering: collection, provider, environment, feature,
  storage system, and source document.
- If evidence is from the wrong scope, say so and do not answer as if it matched.
- Raw chunks can include stale values, false examples, comments, or distractors.
  Prefer current, non-distractor evidence tied to the query.
- Do not use `chunks_out/` as retrieval truth. It is a human review artifact and
  can be stale.

## Provider Rules

Recommended provider mode:

```bash
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

Provider combinations:

| Dense provider | Sparse provider | Use |
|----------------|-----------------|-----|
| `bge-m3-onnx` | `bge-m3-onnx` | Recommended quality path |
| `ollama` | `hashed-tf` | Fallback when ONNX is unavailable |

Do not mix providers in one collection. Changing provider, model, schema
version, or vector size requires reindexing.

Hardware env vars:

```bash
ONNX_EXECUTION_PROVIDER=cpu   # default, portable
ONNX_EXECUTION_PROVIDER=dml   # Windows GPU path: NVIDIA/AMD/Intel via DirectML
ONNX_EXECUTION_PROVIDER=cuda  # Linux NVIDIA experimental; requires CUDA/cuDNN
ONNX_CUDA_STRICT=1            # fail instead of silent CPU fallback for CUDA
ONNX_BATCH_SIZE=4             # opt-in DML batching tuning
```

Windows CUDA is not supported by the prebuilt npm path; use `dml` on Windows.

## Indexing Commands

Core commands:

```bash
npm run doctor
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
PRUNE_STALE=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
npm run sync
npm run smoke
```

Rules:
- Always set `COLLECTION` before running `npm run index`.
- Use `PRUNE_STALE=1` only on the full source root, never on a single file or
  subset directory.
- `.semidexignore` can exclude top-level entry names during directory indexing.
- PDF files are converted through `@opendocsg/pdf2md`; scanned/image PDFs may
  have empty sections.

## Combined Context And Tags

Combined LLM mode is opt-in:

```bash
COMBINED_LLM=1 CONTEXT_MODEL=qwen2.5:3b-instruct ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

Rules:
- When `COMBINED_LLM=1`, semidex uses `CONTEXT_MODEL` for both context and tags.
- If `TAG_MODEL` is set differently, treat it as ignored in combined mode.
- Tags are payload/filter metadata; do not assume they are embedded into the
  retrieval prefix.

Benchmark-only prompt policy:

```bash
BENCH_CONTEXT_POLICY=current-minimal
BENCH_CONTEXT_POLICY=identifier-preserving
BENCH_CONTEXT_POLICY=section-window-aware
npm run bench:custom50:context-policy
```

Do not use `BENCH_CONTEXT_POLICY` as production configuration. Current benchmark
finding: `identifier-preserving` is promising but needs repeat runs;
`section-window-aware` is deferred because of recall risk.

## Troubleshooting

- Run `npm run doctor` first for unclear environment failures.
- If Qdrant returns `403`, rotate or update `QDRANT_KEY`.
- If Ollama is unreachable, start `ollama serve`.
- If required Ollama models are missing, run the `ollama pull <model>` command
  shown by preflight/doctor.
- If Qdrant says `Not existing vector name: dense`, run `npm run sync`; legacy
  flat-schema collections may need reindexing.
- If search looks wrong, check `qdrant_collection_info()` provider metadata
  before changing ranking logic.
