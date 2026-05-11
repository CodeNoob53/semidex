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
  -> qdrant_search(window=1)
  -> qdrant_get_chunk (if broader context is needed)
  -> qdrant_related / qdrant_backlinks
  -> qdrant_find_by_tag when narrowing by topic
```

Search results return the matched chunk plus `source_file` and `chunk_index`. Setting `window=1` in `qdrant_search` is highly recommended for agent workflows to immediately see neighboring chunks. If implementation requires even broader context, follow up with `qdrant_get_chunk(window>1)`. Keep `top` modest when using `window=1` as the output can become quite large.

## Tool Reference

| Tool | Arguments | Description |
|------|-----------|-------------|
| `qdrant_search` | `query`, `collection`, `top?`, `tags?[]`, `source_file?`, `window?` | Hybrid search with optional tag/source filters and context window |
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

Required Qdrant payload indexes:

- `source_file` (keyword)
- `tags` (keyword)
- `chunk_index` (integer)

`npm run index` creates these for new collections. `npm run sync` ensures them for existing collections.
