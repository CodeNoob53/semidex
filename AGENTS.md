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

```text
qdrant_search(window=1, window_format="compact", top=3)
  -> qdrant_get_chunk (if broader context is needed)
  -> qdrant_related / qdrant_backlinks
  -> qdrant_find_by_tag when narrowing by topic
```

Search returns the matched chunk text plus `source_file` and `chunk_index`. The programmatic default is `window=0` (no neighbors), but for AI agents, the following patterns are recommended:

- **Simple lookup / fact-checking:**
  `qdrant_search(query, collection)`
- **Implementation, explanation, or decision tasks:**
  `qdrant_search(query, collection, top=3, window=1, window_format="compact")`
  This is the recommended agent pattern. It provides the setup and continuation around the matched chunk without bloating the context window, which often eliminates the need for follow-up chunk retrieval.
- **Deep context diving:**
  If you need the full section after finding a hit, use `qdrant_get_chunk(collection, source_file, chunk_index, window=1)` (or `window=2`).

## MCP Tools

| Goal | Tool |
|------|------|
| List collections and provider metadata | `qdrant_collection_info()` |
| Find chunks by topic | `qdrant_search(query, collection)` |
| Find actionable context | `qdrant_search(query, collection, top=3, window=1, window_format="compact")` |
| Search inside one file | `qdrant_search(query, collection, source_file=...)` |
| Filter by tags | `qdrant_search(query, collection, tags=[...])` |
| Read a chunk with neighbors | `qdrant_get_chunk(collection, source_file, chunk_index, window=1)` |
| Find chunks with a tag | `qdrant_find_by_tag(collection, tag)` |
| See outgoing semantic links | `qdrant_related(collection, source_file)` |
| See incoming semantic links | `qdrant_backlinks(collection, source_file)` |

Tag filters are OR across tags. Combining `tags` with `source_file` narrows to
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
  tokenHit@5 on custom-raw exact-token queries). If using `ollama + hashed-tf`
  and literal recall matters on raw-log or config-dump corpora, switch to
  `ONNX_EMBED=1` for that collection.
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
| `ollama` | `hashed-tf` | default (no env) | Light fallback — requires Ollama running; `hashed-tf` has no corpus statistics |

Mixed combinations are rejected at runtime.

Changing `denseProvider`, `denseModel`, `sparseProvider`,
`embeddingSchemaVersion`, or `vectorSize` requires reindexing. Do not treat wrong
search results as ranking bugs until provider metadata has been checked.

`ONNX_EXECUTION_PROVIDER` selects the ONNX Runtime hardware backend (`cpu` / `dml` / `cuda`). It is **performance-only** — it does not change embedding model or provider metadata and should not require reindexing; minor numeric differences between execution providers are possible. Default is `cpu`. Use `dml` on Windows for GPU acceleration without extra packages. `cuda` falls back to CPU automatically if not supported by the current runtime.

## `config.json`

`config.json` is generated by `npm run sync` and git-ignored. Current schema:

```json
{
  "collections": {
    "my-docs": {
      "denseProvider": "ollama",
      "denseModel": "bge-m3",
      "sparseProvider": "hashed-tf",
      "embeddingSchemaVersion": 2,
      "vectorSize": 1024,
      "description": "Project architecture documentation"
    }
  }
}
```

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

### Light fallback

```bash
COLLECTION=my-docs npm run index ./docs
```

Use only when ONNX is unavailable or the user explicitly wants minimal setup.
Requires Ollama running with `bge-m3` pulled.

### Full-root cleanup after deletes/renames

```bash
PRUNE_STALE=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
```

Only safe when the target is the full source root. Removes Qdrant points for files
no longer on disk. Never run against a single file or a subdirectory subset.

### PDF / book indexing

```bash
ONNX_EMBED=1 MAX_CHUNK_TOKENS=800 COLLECTION=my-book npm run index ./book.pdf
```

PDFs are converted to Markdown by `@opendocsg/pdf2md` (not pandoc — pandoc cannot read PDFs). The Markdown output is then chunked through the same heading-aware `parseMarkdown` path used for `.md` files. Most PDFs with embedded text will have headings recovered as `section` values. Scanned or image-only PDFs may produce weak structure; in that case sections default to `""`. `MAX_CHUNK_TOKENS=800` is a good starting point for dense prose.

### Troubleshooting quick reference

| Symptom | Action |
|---------|--------|
| Unclear environment failures | Run `npm run doctor` first — it checks Qdrant, Ollama, schema, models, and local files in one read-only pass |
| `[preflight] Ollama unreachable` | Indexer now fails fast before chunking. Start Ollama (`ollama serve`); on Windows try `OLLAMA_URL=http://127.0.0.1:11434` if localhost is proxied |
| `[preflight] Required Ollama model(s) not pulled` | Run the `ollama pull <model>` command shown in the error, then retry |
| Qdrant connection refused | Start Qdrant; verify `QDRANT_URL`; run `npm run sync` |
| `Invalid provider combination` | Use default or `ONNX_EMBED=1` — do not mix providers |
| `Not existing vector name: dense` | Run `npm run sync` — if it reports `LEGACY SCHEMA`, drop that collection and reindex (see operations.md); collections without a named `dense` vector are marked `linkDisabled` and skipped by link-building |
| Stale results after delete/rename | Run full-root `PRUNE_STALE=1 ... npm run index ./root` |
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
