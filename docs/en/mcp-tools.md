# MCP Tools

The MCP server is the reader side of semidex. It lets an AI agent query indexed collections without reading whole files.

## Registering in Claude Code

Linux / macOS:

```bash
claude mcp add --scope user semidex -- node /absolute/path/to/semidex/src/mcp/server.js
```

Windows:

```bash
claude mcp add --scope user semidex -- node C:\absolute\path\to\semidex\src\mcp\server.js
```

After registering, reconnect the MCP server in Claude Code and run `/mcp`.

## Recommended Agent Workflow

For unknown collection structure:

```text
qdrant_collection_info
  -> qdrant_list_directories(collection, depth=1)                               # map top-level areas
  -> qdrant_list_directories(collection, source_prefix="<area>/", depth=1|2)   # drill into a known area
  -> qdrant_list_files(collection, source_prefix="<area>/")                    # list files in that area
  -> qdrant_search(query, collection, top=3, window=1, window_format="compact")
  -> qdrant_get_chunk (if broader context is needed)
  -> qdrant_related / qdrant_backlinks
```

Always call `list_directories` at depth=1 first to orient, then drill with `source_prefix` before listing files. Do not guess `source_file` paths.

For tag discovery and breadth expansion:

```text
qdrant_search(...)                                                    # inspect tags in results first
  -> qdrant_list_tags(collection, contains="...", source_prefix="<known-area>/")
     # combine contains= with source_prefix= when the relevant area is already known
  -> qdrant_find_by_tag(collection, tags=[...])                       # breadth expansion
```

Unfiltered `qdrant_list_tags` can return hundreds of tags on large collections. Use `tag_prefix` or `contains` to narrow by tag name. When the relevant directory is already known from `list_directories`, add `source_prefix` to scope tag counts to that area. Tags are most useful for breadth expansion after an initial search, not as the first step. This workflow was live-tested on a large collection and eliminated blind prefix guessing.

Search results return the matched chunk plus `source_file` and `chunk_index`.

### `qdrant_search` Window Modes

The tool defaults to `window=0` (backward-compatible, shortest output). When `window > 0`, the optional `window_format` argument controls context verbosity:
- `"full"` (default if format omitted): Returns the complete `text` of neighbor chunks. Only use when full neighboring text is needed.
- `"compact"`: Returns a truncated `text_snippet` (up to 150 chars).

**Recommended Agent Pattern:** `qdrant_search(window=1, window_format="compact", top=3)`
For tasks where the agent must implement, explain, or decide based on the context, this pattern provides necessary neighboring setup/continuation without bloating the context budget.
Use `top=5` for ambiguous, negative, or scope-sensitive queries where the answer may not be at rank 1.

- **Deduplication**: In windowed search, the matched chunk (`is_match: true`) is always preserved in its own window. Duplicate neighbor chunks across results are safely omitted.

If implementation requires even broader context, follow up with `qdrant_get_chunk(..., window=1 or 2)`.

### Retrieval Safety

Before answering from retrieved evidence, verify that the evidence matches the query's scope:

- **Environment:** staging vs prod — do not answer a staging query from prod evidence.
- **Model/provider:** OpenAI/GPT-4 vs local Gemma/Ollama/BGE-M3.
- **System:** PostgreSQL vs Qdrant; Prometheus/Grafana vs telemetry endpoints.
- **Feature:** ColBERT vs BGE-M3 sparse.

If retrieved evidence refers to a different scope than the query, state the mismatch explicitly and decline to answer.

Do not use absolute RRF score as a confidence threshold. All RRF scores in a result set fall in a narrow range (~0.016–0.033); ranking within the set is meaningful, but the absolute value is not.

Raw/unstructured corpus chunks may contain distractor values, stale config, or commented-out examples adjacent to correct values. Use `is_match: true` to identify the retrieved chunk; read it critically before forming an answer.

## Tool Reference

| Tool | Arguments | Description |
|------|-----------|-------------|
| `qdrant_search` | `query`, `collection`, `top?`, `tags?[]`, `source_file?`, `window?`, `window_format?` | Hybrid search with optional tag/source filters and context window |
| `qdrant_collection_info` | none | Lists collections with point counts, provider metadata, descriptions |
| `qdrant_get_chunk` | `collection`, `source_file`, `chunk_index`, `window?` | Retrieves one chunk and optional neighbors. Heading shows explicit `chunk_index` and display position. |
| `qdrant_related` | `collection`, `source_file` | Shows outgoing file-level semantic links |
| `qdrant_backlinks` | `collection`, `source_file` | Shows incoming file-level links |
| `qdrant_find_by_tag` | `collection`, `tag?`, `tags?[]`, `match?`, `limit?` | Lists chunks matching tag(s), grouped by file and sorted by density |
| `qdrant_list_directories` | `collection`, `source_prefix?`, `depth?`, `limit?` | Lists directory prefixes with file and chunk counts. Use to explore structure before listing files. |
| `qdrant_list_files` | `collection`, `source_prefix?`, `tags?[]`, `tag_match?`, `limit?` | Lists unique source files with chunk counts, first section, and optional tag filtering |
| `qdrant_list_tags` | `collection`, `source_prefix?`, `tag_prefix?`, `contains?`, `min_count?`, `limit?` | Lists tags with chunk and file counts. Use `tag_prefix` or `contains` to narrow results on large collections. |

### Navigation parameter semantics

- `source_prefix` — filters by `source_file` path prefix.
- `tag_prefix` — filters tag names by prefix. Not a `source_file` filter.
- `contains` — filters tag names by substring. Can combine with `tag_prefix`.
- `qdrant_list_tags` without filters can return hundreds of broad tags on large collections — prefer `tag_prefix` or `contains` to narrow first.
- Do not guess `source_file` when `qdrant_list_directories` / `qdrant_list_files` can resolve it.
- Tags are best used for breadth expansion after an initial `qdrant_search`, not always as a first step.

**Truncation:** When output reads `Found N … showing M` and M < N, the list is truncated. Do not treat it as complete — narrow with `source_prefix`, `tag_prefix`, or `contains` and re-call.

### When to use `qdrant_related` and `qdrant_backlinks`

- **`qdrant_search`** — find chunks relevant to a topic. Use this first.
- **`qdrant_related(collection, source_file)`** — once you have a specific file, find documents semantically linked *from* it. Use to traverse outgoing connections: "what does this file point to?"
- **`qdrant_backlinks(collection, source_file)`** — find documents that link *to* a given file. Use to understand dependencies: "what references or depends on this file?"

These are graph traversal tools, not discovery tools. They require a known `source_file` as a starting point and should not substitute for `qdrant_search` on an unknown topic.

## Search Mode

`qdrant_search` always uses **hybrid dense+sparse RRF** — both dense semantic
and sparse lexical vectors are queried and fused by Reciprocal Rank Fusion. This
is the only available mode today.

A `search_mode` opt-in parameter is planned (Stage 2) but not yet implemented:

| Value | Behavior | When to use |
|-------|----------|-------------|
| `"hybrid"` (default) | Dense + sparse RRF fusion | Everything: technical, config, exact-token, multilingual queries |
| `"dense_mmr"` (planned) | Dense-only Qdrant MMR, no sparse | Exploratory queries needing source diversity; not for exact recall |

**Do not use `dense_mmr` for technical or config queries.** Dense-only retrieval
skips the sparse leg entirely — env var names, function names, field names, and
other exact identifiers are not reliably matched without lexical weighting.
Benchmark results show `dense_mmr` reduces duplicate source rate but trades off
Recall@1 (−4.8pp for ONNX at all tested diversity values).

## Search Filters

`qdrant_search` supports:

- `tags` filter: OR across requested tags
- `source_file` filter: restricts search to one file
- combined tag + file filtering

**`source_file` filter decision rules:**
- If the user names a file, source, document type, or clear context ("in the config", "in the incident log"), apply `source_file` when the matching file is known.
- If no scope is given, do not invent a filter. If retrieved evidence contains multiple valid contexts (e.g., a configured timeout in one file and an observed timeout in another), surface both and ask for clarification.

Required Qdrant payload indexes:

- `source_file` (keyword)
- `tags` (keyword)
- `chunk_index` (integer)

`npm run index` creates these for new collections. `npm run sync` ensures them for existing collections.
