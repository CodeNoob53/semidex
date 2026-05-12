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

```text
qdrant_collection_info
  -> qdrant_search(window=1, window_format="compact", top=3)
  -> qdrant_get_chunk (if broader context is needed)
  -> qdrant_related / qdrant_backlinks
  -> qdrant_find_by_tag when narrowing by topic
```

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
| `qdrant_get_chunk` | `collection`, `source_file`, `chunk_index`, `window?` | Retrieves one chunk and optional neighbors |
| `qdrant_related` | `collection`, `source_file` | Shows outgoing file-level semantic links |
| `qdrant_backlinks` | `collection`, `source_file` | Shows incoming file-level links |
| `qdrant_find_by_tag` | `collection`, `tag`, `limit?` | Lists chunks matching a tag, grouped by file |

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
