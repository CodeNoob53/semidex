# Agent Instructions

semidex is a local-first RAG memory system for AI agents. It has two runtime
entry points:

- **Indexer** - writes documents into Qdrant.
- **MCP server** - reads indexed knowledge for agents.

They share the same core provider, config, graph, chunking, and Qdrant helpers.

## Core Commands

```bash
COLLECTION=my-docs npm run index <file|folder>  # index documents
npm run mcp                                      # start MCP server (stdio)
npm run sync                                     # sync config.json + Qdrant indexes
npm run doctor                                   # read-only environment health check
npm run smoke                                    # offline smoke tests (no Qdrant)
npm run smoke:retrieval-live                     # optional live smoke suite (requires Qdrant)
npm run bench:retrieval                          # live retrieval benchmark
npm run bench:retrieval:compare                  # side-by-side provider comparison
npm run bench:retrieval:rerank                   # 4-variant rerank matrix
npm run bench:retrieval:mmr                      # RRF vs dense MMR diversity matrix
```

Do not run `npm run index` without `COLLECTION` set. The indexer will exit with
a usage error.

## Source of Truth

For indexed knowledge, **Qdrant is the source of truth**. Use the MCP tools
instead of reading generated files from `chunks_out/`.

`chunks_out/` is only a human review artifact for Obsidian-compatible quality
control. It can be stale, incomplete, or generated from an older indexing pass.

For repository implementation work, it is fine to read and edit source files and
docs directly.

## Documentation Layout

Detailed documentation lives in `docs/`:

- `docs/README.md` - language entry point
- `docs/en/README.md` - English documentation index
- `docs/ua/README.md` - Ukrainian README

English deep-dive files:

| File | Covers |
|------|--------|
| `docs/en/architecture.md` | Indexer pipeline, phases, local models, graph |
| `docs/en/retrieval.md` | Hybrid search, RRF, providers, reranking |
| `docs/en/obsidian.md` | `chunks_out/` review console |
| `docs/en/mcp-tools.md` | MCP tool reference and agent workflow |
| `docs/en/configuration.md` | All env vars grouped by concern |
| `docs/en/benchmarking.md` | Smoke tests, metrics, regression workflow |
| `docs/en/project-structure.md` | Source tree, runtime entry points, generated files |
| `docs/en/operations.md` | Usage, limitations, troubleshooting |

Prefer English docs for implementation details unless the user explicitly asks
for Ukrainian text or wording.

## Recommended MCP Workflow

Start every knowledge-base investigation with:

```text
qdrant_collection_info
```

Use it to see available collections, point counts, descriptions, and provider
metadata. Then follow this workflow:

For unknown collection structure:

```text
qdrant_collection_info
  -> qdrant_list_directories(collection, depth=1)                               # map top-level areas
  -> qdrant_list_directories(collection, source_prefix="<area>/", depth=1|2)   # drill into a known area
  -> qdrant_list_files(collection, source_prefix="<area>/")                    # list files in that area
  -> qdrant_search(query, collection, top=3, window=1, window_format="compact")
```

Always call `list_directories` at depth=1 first to orient, then drill with `source_prefix` before listing files. Do not guess `source_file` paths.

For tag discovery and breadth expansion:

```text
qdrant_search(...)                                                    # inspect tags in results first
  -> qdrant_list_tags(collection, contains="...", source_prefix="<known-area>/")
     # narrow by substring; add source_prefix when the relevant area is already known
  -> qdrant_find_by_tag(collection, tags=[...])                       # breadth expansion
```

On large collections, do not start with unscoped `qdrant_list_tags` — it can return hundreds of tags with no grouping signal. Always run `qdrant_list_directories(depth=1)` first, drill into the relevant area with `source_prefix`, then call `qdrant_list_tags(collection, contains=..., source_prefix=...)` scoped to that area. Tags are most useful for breadth expansion after an initial search, not as the first step. This workflow was live-tested on a large collection and eliminated blind prefix guessing.

Search returns the matched chunk text plus `source_file` and `chunk_index`. The programmatic default is `window=0` (no neighbors), but for AI agents, the following patterns are recommended:

- **Simple lookup / fact-checking:**
  `qdrant_search(query, collection)`
- **Implementation, explanation, or decision tasks:**
  `qdrant_search(query, collection, top=3, window=1, window_format="compact")`
  This is the recommended agent pattern. It provides the setup and continuation around the matched chunk without bloating the context window, which often eliminates the need for follow-up chunk retrieval.
- **Structured data in compact output:**
  If a compact snippet shows a table header, checklist, YAML/JSON block, or any structure that appears cut mid-row or mid-item, call `qdrant_get_chunk(collection, source_file, chunk_index)` directly. Compact snippets are capped at 150 chars and always truncate multi-row tables. Do not summarize structured content from a truncated snippet.
- **Deep context diving:**
  If you need the full section after finding a hit, use `qdrant_get_chunk(collection, source_file, chunk_index, window=1)` (or `window=2`).

## MCP Tools

| Goal | Tool |
|------|------|
| List collections and provider metadata | `qdrant_collection_info()` |
| Explore folder structure | `qdrant_list_directories(collection, source_prefix?, depth?)` |
| List files in a folder | `qdrant_list_files(collection, source_prefix?, tags?, tag_match?)` |
| List tags with counts | `qdrant_list_tags(collection, source_prefix?, tag_prefix?, contains?, min_count?)` |
| Find chunks by topic | `qdrant_search(query, collection)` |
| Find actionable context | `qdrant_search(query, collection, top=3, window=1, window_format="compact")` |
| Search inside one file | `qdrant_search(query, collection, source_file=...)` |
| Filter by tags | `qdrant_search(query, collection, tags=[...])` |
| Read a chunk with neighbors | `qdrant_get_chunk(collection, source_file, chunk_index, window=1)` |
| Find chunks with a tag | `qdrant_find_by_tag(collection, tag)` |
| Find chunks matching multiple tags | `qdrant_find_by_tag(collection, tags=[...], match="any"\|"all")` |
| See outgoing semantic links | `qdrant_related(collection, source_file)` |
| See incoming semantic links | `qdrant_backlinks(collection, source_file)` |

Navigation parameter semantics:

- `source_prefix` — filters by `source_file` path prefix (forward-slash normalized).
- `tag_prefix` — filters tag names by prefix. Use to narrow `qdrant_list_tags` results on large collections.
- `contains` — filters tag names by substring. Can combine with `tag_prefix`.
- `qdrant_list_tags` without any filter can be noisy on large collections — prefer `tag_prefix` or `contains`.
- Do not guess `source_file` when `qdrant_list_directories` / `qdrant_list_files` can resolve it.
- Tags are best used as breadth expansion after search, not always as the first step.

**Truncation rule:** When a tool output says `Found N … showing M` where M < N, the list is truncated — do not treat it as complete. Narrow the query: add or tighten `source_prefix`, `tag_prefix`, or `contains`, then re-call.

**When to use `qdrant_related` and `qdrant_backlinks`:**

- `qdrant_search` — find chunks relevant to a topic or query. Use this first.
- `qdrant_related(collection, source_file)` — once you have a high-confidence file of interest, find other documents semantically linked *from* it. Best applied to hub/reference/skill files or files with many chunks (>20 is a useful heuristic for `reference/` and `skills/` directories). Use when you need to traverse outgoing connections: "what does this file point to?" If results are noisy, fall back to `qdrant_search` with a narrower query or `source_file` filter.
- `qdrant_backlinks(collection, source_file)` — find documents that link *to* a given file. Use when you need to understand dependencies or callers: "what depends on or references this file?"

Do not substitute `related`/`backlinks` for search on an unknown topic. They are graph traversal tools, not ranked topical search — they only work once you have a specific `source_file` to start from.

**Related-link noise:** On large or mixed-domain collections, `qdrant_related` can return off-topic files alongside relevant ones. Triage by section summary, source family, tags, and whether the file supports the current task — do not assume every returned file is relevant.

Tag filters on `qdrant_search` are OR across tags. Combining `tags` with `source_file` narrows to
chunks in that file matching any requested tag.

## Agent Retrieval Safety Rules

Use `qdrant_search(..., window=1, window_format="compact", top=3)` as the recommended agent search pattern when enough context is needed to answer safely. Use `top=5` for ambiguous, negative, or scope-sensitive queries.

Do not treat absolute RRF score values as confidence. Typical hybrid RRF scores
fall in **0.016–0.033** — this is the normal range for Qdrant hybrid search, not
an indication of weak retrieval. A result at `0.017` can still be the correct and
only relevant chunk. Compare rank order, `source_file`, section, exact-token
overlap, and the `context` field instead of using a score threshold. For details
see `docs/en/retrieval.md` § Interpreting Scores.

Before answering, verify scope:
- environment: staging vs prod
- model/provider: OpenAI/GPT-4 vs local Gemma/Ollama/BGE-M3
- database/system: PostgreSQL vs Qdrant
- feature: ColBERT vs BGE-M3 sparse
- storage vs endpoint/config references

If the query asks about one scope but retrieved evidence clearly refers to another, state the mismatch and do not answer as if the evidence matched.

Raw/unstructured chunks may contain distractors, stale values, commented-out values, or explicit false examples. Prefer values that are current, non-distractor, and directly tied to the query.

## Search Tactics For Agents

- Use both natural-language and exact-token queries when needed. Example:
  search for `how provider mismatch is handled`, then search for
  `denseProvider sparseProvider embedding_schema_version`.
- For config, CLI, or code questions, include exact identifiers:
  `ONNX_EMBED`, `RRF_K`, `HYBRID_PREFETCH_LIMIT`, `source_file`, function names,
  env vars, or section titles.
- If a result is relevant but too narrow, call `qdrant_get_chunk` with a window
  before acting on it. Use the `source_file` and `chunk_index` shown in the
  search result.
- If the task involves dependencies between documents, follow `qdrant_related`
  and `qdrant_backlinks`; search only gives local chunk relevance.
- If multiple collections exist, do not assume the first collection is correct.
  Use collection descriptions and source files to choose.
- For ambiguous tasks, gather at least two supporting hits or one hit plus its
  surrounding chunks before making a claim.
- Prefer `source_file` filters once a likely file is known. This reduces noise
  and makes follow-up chunk reads deterministic. Do not invent a `source_file`
  filter when no scope is given — if retrieved evidence contains multiple valid
  contexts, surface both and ask for clarification.
- For "why did search return this?" questions, inspect provider metadata,
  section, tags, and exact token overlap before changing ranking logic.
- `qdrant_search` always uses hybrid dense+sparse RRF — this is the only
  available MCP mode. Do not ask for `search_mode="dense_mmr"` or
  `search_mode="literal"` — neither is implemented. Dense MMR exists as a
  benchmark-only mode (`npm run bench:retrieval:mmr`); literal/full-text
  payload search is deferred. Both decisions are documented in
  `benchmarks/retrieval/results/`.
- For exact-token queries — error strings, env vars, function names, config
  keys, log line fragments — use verbatim terms in the `query` field. BGE-M3
  sparse encodes them as lexical units and retrieves them reliably (100%
  tokenHit@5 on custom-raw exact-token queries). `ollama + hashed-tf` is a
  fallback only — for literal recall on raw-log or config-dump corpora, use
  `ONNX_EMBED=1`.
- PDF chunks from digitally-created files typically carry real `section` values
  recovered by `@opendocsg/pdf2md`. Scanned or image-only PDFs fall back to
  plain-text extraction and will have `section: ""`. When `section` is empty,
  navigate via `source_file + chunk_index`; otherwise section filters work.

## Retrieval Model

`qdrant_search` uses hybrid retrieval by default:

- **Dense vector** - semantic similarity for meaning and paraphrases.
- **Sparse vector** - lexical matching for exact terms and technical tokens.
- **RRF fusion** - combines dense and sparse rankings without mixing raw scores.

Old collections without sparse vectors still work through dense-only fallback.
Run `npm run sync` to backfill config and ensure required indexes.

Optional reranking is controlled by `RERANK_ENABLED=1`. It is off by default.
Use benchmark results before enabling it for a collection or workflow.

## Provider Awareness

Indexing and search must use matching provider metadata. semidex stores provider
config in both `config.json` and Qdrant payload.

Valid provider combinations:

| Dense provider | Sparse provider | Mode | Notes |
|----------------|-----------------|------|-------|
| `bge-m3-onnx` | `bge-m3-onnx` | `ONNX_EMBED=1` | **Recommended** — better retrieval quality, multilingual, neural sparse |
| `ollama` | `hashed-tf` | default (no env) | **Fallback only** — requires Ollama running with `bge-m3` pulled; `hashed-tf` has no corpus statistics; use only when ONNX is unavailable |

Mixed combinations are rejected at runtime.

Changing `denseProvider`, `denseModel`, `sparseProvider`,
`embeddingSchemaVersion`, or `vectorSize` requires reindexing. Do not treat wrong
search results as ranking bugs until provider metadata has been checked.

`ONNX_EXECUTION_PROVIDER` selects the ONNX Runtime hardware backend. It is **performance-only** — it does not change embedding model or provider metadata and should not require reindexing; minor numeric differences between execution providers are possible.

| Platform | Recommended provider | Notes |
|----------|----------------------|-------|
| Any OS | `cpu` (default) | Safe, no extra setup |
| Windows | `dml` | Preferred GPU path — bundled in `onnxruntime-node`; covers NVIDIA, AMD, Intel |
| Linux x64 + NVIDIA | `cuda` | Advanced/experimental opt-in; requires CUDA 12.x + cuDNN 9 installed separately |
| Windows + NVIDIA CUDA | — | Not supported via prebuilt npm; Windows GPU → use `dml` |

**CUDA silent fallback:** When `ONNX_EXECUTION_PROVIDER=cuda` is set and CUDA is unavailable, semidex warns and retries with CPU. This means a bad CUDA setup runs silently on CPU — check stderr for `retrying with cpu` to verify. Do not treat absence of an error as proof CUDA loaded.

## `config.json`

`config.json` is generated by `npm run sync` and git-ignored. Current schema:

```json
{
  "collections": {
    "my-docs": {
      "denseProvider": "bge-m3-onnx",
      "denseModel": "aapot/bge-m3-onnx",
      "sparseProvider": "bge-m3-onnx",
      "embeddingSchemaVersion": 2,
      "vectorSize": 1024,
      "description": "Project architecture documentation"
    }
  }
}
```

The `ollama` / `hashed-tf` combination is a fallback for environments where ONNX is unavailable. New collections should use `bge-m3-onnx` by default.

Safe manual edits:

- `description`
- provider/model fields only when you intend to force a full reindex

Do not hand-edit `vectorSize` to make errors disappear. It must match the actual
Qdrant vector schema.

`linkDisabled: true` is written automatically by `npm run sync` for collections that are schema-incompatible (flat schema or no named `dense` vector) or whose sampled payload does not contain semidex discriminator fields. Do not remove it manually — drop the collection and reindex to clear it legitimately.

## Qdrant Payload Schema

Every indexed point has payload similar to:

```json
{
  "text": "raw chunk text",
  "context": "1-2 sentence LLM summary of what this chunk is about",
  "section": "heading this chunk belongs to",
  "source_file": "relative/path/to/file.md",
  "tags": ["tag-one", "tag-two"],
  "links": ["other/file.md"],
  "backlinks": ["file/that/links/here.md"],
  "chunk_index": 0,
  "total_chunks": 12,
  "file_hash": "sha256...",
  "dense_provider": "ollama",
  "dense_model": "bge-m3",
  "sparse_provider": "hashed-tf",
  "embedding_schema_version": 2,
  "vector_size": 1024
}
```

`source_file` is relative to `SOURCE_ROOT` when set, otherwise to the indexed
folder. Use `source_file + chunk_index` as the stable way to retrieve context.

## Graph Files

Semantic links are stored per collection in `graph.<collection>.json`.

The graph stores file-level links/backlinks only. It does not store chunk text.
To read linked content, use `qdrant_search` or `qdrant_get_chunk` after resolving
the linked `source_file`.

`qdrant_related` and `qdrant_backlinks` read graph files, while search reads
Qdrant.

## Required Qdrant Payload Indexes

These payload indexes are required for filters:

| Field | Type |
|-------|------|
| `source_file` | keyword |
| `tags` | keyword |
| `chunk_index` | integer |

New collections create them automatically. For existing or remote collections,
run:

```bash
npm run sync
```

## Indexing Guide for Agents

When asked to index documents, choose the mode based on the goal:

### Recommended: ONNX (production quality)

```bash
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

Use for any serious indexing task — books, multilingual docs, benchmark collections.
Downloads the ONNX model (~2.3 GB) once into `./models/`.

### Light fallback (ollama + hashed-tf)

```bash
COLLECTION=my-docs npm run index ./docs
```

Use only when ONNX is unavailable or the user explicitly wants minimal setup.
Requires Ollama running with `bge-m3` pulled. This is the code default when `ONNX_EMBED` is unset, but not recommended for serious indexing — retrieval quality is lower than ONNX.

### Ollama startup for agents

Indexing uses Ollama for context/tag generation even when `ONNX_EMBED=1` is used
for embeddings. Before any destructive apply/repair job, verify Ollama before
deleting Qdrant points.

On Windows PowerShell:

```powershell
ollama --version
try { (Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 5).StatusCode } catch { "unreachable" }
```

If unreachable and `ollama --version` works, start the API server as a hidden
background helper and re-check:

```powershell
Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 5
ollama list
```

Required indexing models depend on env:

- default context/tag model: `gemma3:4b`
- Ollama embedding fallback model: `bge-m3`

If a required model is missing, run `ollama pull <model>` and retry. Do not use
`ollama run <model>` for repair/indexing; it opens an interactive model session
instead of starting the API server. If `localhost` is unreliable on Windows, set
`OLLAMA_URL=http://127.0.0.1:11434` before running the indexer or repair script.

The duplicate-point repair script (`benchmarks/retrieval/duplicate-point-repair.js`)
runs this preflight automatically in apply mode and aborts before touching any
Qdrant data if Ollama is unreachable. The default safe mode (reindex-first) never
leaves a file absent: it reindexes first, verifies `>0` points exist, then deletes
only orphan old-ID duplicates. A failure stops the repair with the file intact.

### Full-root cleanup after deletes/renames

```bash
PRUNE_STALE=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

Only safe when the target is the full source root. Removes Qdrant points for files
no longer on disk. Never run against a single file or a subdirectory subset.
`PRUNE_STALE=1` handles deleted/renamed files only — it does not detect or remove
same-source duplicate points (where `source_file` still exists on disk).

### Combined LLM mode (opt-in, faster indexing)

```bash
COMBINED_LLM=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

Merges context and tag generation into a single Ollama call per chunk. Uses `CONTEXT_MODEL` for both; `TAG_MODEL` is ignored. Falls back to separate context and tag prompts per chunk on parse failure, still using `CONTEXT_MODEL` for both — `TAG_MODEL` is never used. Indexing never aborts due to combined-mode errors. See `docs/en/configuration.md — COMBINED_LLM` for details.

### Skip tag generation (large automated runs)

```bash
TAG_GEN=0 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

Use when `qdrant_find_by_tag` and tag-filtered search are not needed. Tags are payload-only metadata and do not affect default hybrid retrieval — skipping them saves ~25–50% of the Ollama LLM call budget (tag batch calls + per-chunk fallback when batch parse fails). Chunks are stored with `tags: []`.

### PDF / book indexing

```bash
ONNX_EMBED=1 MAX_CHUNK_TOKENS=800 COLLECTION=my-book npm run index ./book.pdf
```

PDFs are converted to Markdown by `@opendocsg/pdf2md` (not pandoc — pandoc cannot read PDFs). The Markdown output is then chunked through the same heading-aware `parseMarkdown` path used for `.md` files. Most PDFs with embedded text will have headings recovered as `section` values. Scanned or image-only PDFs may produce weak structure; in that case sections default to `""`. `MAX_CHUNK_TOKENS=800` is a good starting point for dense prose.

### Troubleshooting quick reference

| Symptom | Action |
|---------|--------|
| Unclear environment failures | Run `npm run doctor` first — it checks Qdrant, Ollama, schema, models, COMBINED_LLM config, and local files in one read-only pass |
| `[combined] parse failed` in indexer output | Normal fallback — combined mode fell back to separate context+tag for that chunk; not an error |
| `COMBINED_LLM=1 … TAG_MODEL is ignored` doctor WARN | Expected when TAG_MODEL ≠ CONTEXT_MODEL and COMBINED_LLM=1; set TAG_MODEL to match CONTEXT_MODEL or leave unset to silence it |
| `[preflight] Ollama unreachable` | Indexer now fails fast before chunking. Use the Ollama startup steps above; on Windows prefer `Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden`, then verify `ollama list` |
| `[preflight] Required Ollama model(s) not pulled` | Run the `ollama pull <model>` command shown in the error, then retry |
| Qdrant connection refused | Start Qdrant; verify `QDRANT_URL`; run `npm run sync` |
| `Invalid provider combination` | Use default or `ONNX_EMBED=1` — do not mix providers |
| `Not existing vector name: dense` | Run `npm run sync` — if it reports `LEGACY SCHEMA`, drop that collection and reindex (see operations.md); collections without a named `dense` vector are marked `linkDisabled` and skipped by link-building |
| Stale results after delete/rename | Run full-root `PRUNE_STALE=1 ... npm run index ./root` |
| Duplicate chunks in search results | Caused by prior randomUUID indexing runs; new runs are idempotent. Repair existing duplicates with a separate targeted reindex per affected source file (see `docs/en/operations.md`) |
| Unexpected full reindex after env change | Expected — provider/schema change forces reindex; let it complete |
| `pandoc: Unknown input format pdf` | Not a bug — pandoc cannot read PDFs; `.pdf` is handled by `@opendocsg/pdf2md` |
| All PDF chunks have empty section | Likely a scanned/image-only PDF — `pdf2md` found no heading structure; navigate via `source_file` + `chunk_index` |
| First ONNX run very slow | Model downloading (~2.3 GB); wait; cache used on next run |

## What Not To Do

- Do not use `chunks_out/` as live retrieval truth.
- Do not answer questions about indexed documents by reading generated review
  files when MCP tools are available.
- Do not assume dense-only behavior; hybrid dense + sparse retrieval is the
  current default.
- Do not mix embedding providers for the same collection.
- Do not manually change `vectorSize` or schema fields to avoid reindexing.
- Do not commit generated `config.json`, `graph.<collection>.json`, model cache,
  or `chunks_out/` output unless explicitly requested.
