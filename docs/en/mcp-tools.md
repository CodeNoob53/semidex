# MCP Tools

The MCP server is the reader side of semidex. It lets an AI agent query indexed collections without reading whole files.

## Registering in Claude Code

Verified end-to-end support currently targets Windows 10/11. The Linux and
macOS registration command is provided for experimental / unverified setups.

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
  -> qdrant_get_skeleton(collection)                                            # skeleton map, if available
  -> qdrant_get_skeleton_children(collection, node_path="<area node>")          # drill into a skeleton area
  -> qdrant_list_directories(collection, depth=1)                               # fallback when no skeleton exists
  -> qdrant_list_files(collection, source_prefix="<area>/")                    # exact source_file paths
  -> qdrant_search(query, collection, top=3, window=1, window_format="compact")
  -> qdrant_get_chunk (if broader context is needed)
```

Use skeleton tools as the collection map when available. Skeleton nodes are
navigation summaries for collection, directory, file, and section structure;
they are not retrieval evidence. Use `qdrant_search` and `qdrant_get_chunk` for
facts you will cite in an answer. If no skeleton exists, call
`list_directories` at depth=1 first to orient, then drill with `source_prefix`
before listing files. Do not guess `source_file` paths.

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

**Structured-data trigger:** If a compact snippet shows a table header, checklist, YAML/JSON block, or any structure that appears cut mid-row or mid-item, call `qdrant_get_chunk(collection, source_file, chunk_index)` directly. Compact snippets are capped at 150 characters and will always truncate multi-row tables. Do not summarize structured content from a truncated snippet — retrieve the full chunk first.

**Structural node placeholders:** Search results and skeleton nodes may surface placeholders like `[table node: ...]` or `[code_block node: ...]`. Resolve these with `qdrant_get_node(collection, node_path="<path from placeholder>")`. The tool returns a bounded preview (default 2000 chars) and metadata. If the node path resolves to a nav node, the tool returns `reason: "nav_node_not_content"` — use `qdrant_get_skeleton_node` instead.

### Source-Navigation Queries

Queries that ask *where* something lives in the codebase — file paths, function
symbols, env var names, npm commands — are **source-navigation queries**. Examples:

- "Where is `hybridSearch` defined?"
- "What does `src/core/qdrant.js` export?"
- "Entry point for `npm run bench:custom50`"

For these queries, `qdrant_search` usually returns the correct chunk in top-10,
but exact file/symbol chunks may not always land in the top 3-5. If
source-navigation results look unexpectedly low-ranked:

- Increase `top` to 10 and scan the full list.
- Use exact identifiers in the query (`source_file`, function name, env var, or
  command).
- Use `qdrant_list_files` or `qdrant_list_directories` if you need to enumerate
  files by path rather than retrieve by semantic query.

### Skeleton Navigation

Skeleton-enabled collections include a separate navigation layer:

- `retrieval_content` points are searched by `qdrant_search`.
- `skeleton_nav` points are hidden from search and exposed only through
  skeleton tools.

Use skeleton navigation when the task requires understanding the shape of a
large collection, choosing an area before search, or drilling from collection
to directory, file, and section summaries. Do not use skeleton summaries as the
final evidence for factual answers; they are a map, not the source text.

Typical flow:

```text
qdrant_get_skeleton(collection)
  -> qdrant_get_skeleton_children(collection, node_path="<directory node_path>")
  -> qdrant_get_skeleton_node(collection, node_path="<file or section node_path>")
  -> qdrant_search(query, collection, source_file="<file from skeleton>", top=3, window=1, window_format="compact")
```

If `qdrant_get_skeleton` reports that no skeleton exists, use
`qdrant_list_directories` and `qdrant_list_files` instead.

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
| `qdrant_get_skeleton` | `collection` | Returns the collection skeleton root and immediate children. Use as the map for skeleton-enabled collections. |
| `qdrant_get_skeleton_node` | `collection`, exactly one of `node_id` or `node_path` | Returns one skeleton navigation node with summary, parent, children, source file, and heading path. |
| `qdrant_get_skeleton_children` | `collection`, exactly one of `node_id` or `node_path`, `limit?` | Resolves immediate child skeleton nodes with truncation metadata. |
| `qdrant_get_node` | `collection`, exactly one of `node_id` or `node_path`, `preview_chars?` | Resolves a structural content node (table, code_block, checklist, image, paragraph…) by ID or path. Returns metadata and a bounded content preview (default 2000 chars, max 8000). Does not return nav nodes — use `qdrant_get_skeleton_node` for those. |
| `qdrant_find_by_tag` | `collection`, `tag?`, `tags?[]`, `match?`, `limit?` | Lists chunks matching tag(s), grouped by file and sorted by density |
| `qdrant_list_directories` | `collection`, `source_prefix?`, `depth?`, `limit?` | Lists directory prefixes with file and chunk counts. Use to explore structure before listing files. |
| `qdrant_list_files` | `collection`, `source_prefix?`, `tags?[]`, `tag_match?`, `limit?` | Lists unique source files with chunk counts, first section, and optional tag filtering |
| `qdrant_list_tags` | `collection`, `source_prefix?`, `tag_prefix?`, `contains?`, `min_count?`, `limit?` | Lists tags with chunk and file counts. Use `tag_prefix` or `contains` to narrow results on large collections. |

### Navigation parameter semantics

- `source_prefix` — filters by `source_file` path prefix.
- `tag_prefix` — filters tag names by prefix. Not a `source_file` filter.
- `contains` — filters tag names by substring. Can combine with `tag_prefix`.
- `qdrant_list_tags` without filters can return hundreds of broad tags on large collections — prefer `tag_prefix` or `contains` to narrow first.
- `qdrant_list_tags(source_prefix=...)` is most useful after `qdrant_list_directories` has identified the right prefix. Without a prior directory step, unscoped `list_tags` on a large collection risks returning an unmanageable flat list.
- Do not guess `source_file` when `qdrant_list_directories` / `qdrant_list_files` can resolve it.
- Tags are best used for breadth expansion after an initial `qdrant_search`, not always as a first step.

**Truncation:** When output reads `Found N … showing M` and M < N, the list is truncated. Do not treat it as complete — narrow with `source_prefix`, `tag_prefix`, or `contains` and re-call.


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
- `point_kind` (keyword)
- `node_type` (keyword)
- `node_id` (keyword)
- `node_path` (keyword)

`npm run index` creates these for new collections. `npm run sync` ensures them for existing collections.
