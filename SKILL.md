---
name: semidex
description: Use when working with semidex — indexing documents, configuring retrieval, debugging search results, understanding architecture, or looking up env vars. Searches the live semidex-docs collection for up-to-date answers instead of loading static doc files into context.
argument-hint: "question or task"
allowed-tools: mcp__qdrant__qdrant_search, mcp__qdrant__qdrant_collection_info, mcp__qdrant__qdrant_get_chunk, mcp__qdrant__qdrant_find_by_tag, mcp__qdrant__qdrant_related, mcp__qdrant__qdrant_backlinks
---

semidex is a local-first RAG indexer + MCP server backed by Qdrant.
Its own documentation is indexed in the `semidex-docs` collection — search it instead of reading static files.

## MCP server setup

To use the search tools below you must connect the semidex MCP server first.

Add to your Claude Code MCP config (`claude mcp add` or `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "qdrant": {
      "command": "node",
      "args": ["/absolute/path/to/semidex/src/mcp/server.js"],
      "env": {
        "QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

Replace `/absolute/path/to/semidex` with the actual path to this repository.
Add `QDRANT_KEY` to `env` if your Qdrant instance requires an API key.
Qdrant must be running before starting the MCP server.

**Do not use generic `qdrant-mcp` plugins as a substitute.** They hardcode Ollama
for query embedding and will fail with 404 or return silently wrong results when
the collection uses `bge-m3-onnx`. The semidex MCP server reads `config.json` and
routes each query through the correct provider automatically.

## Search first

```
qdrant_search("$ARGUMENTS", collection="semidex-docs", top=3, window=1, window_format="compact")
```

For broad or ambiguous questions use `top=5`.
For exact identifiers (env vars, function names, error strings) include them verbatim in the query.

## MCP tools

| Goal | Tool |
|------|------|
| List collections + provider metadata | `qdrant_collection_info()` |
| Find relevant chunks | `qdrant_search(query, collection, top=3, window=1, window_format="compact")` |
| Read full chunk context | `qdrant_get_chunk(collection, source_file, chunk_index, window=1)` |
| Filter by topic tag | `qdrant_find_by_tag(collection, tag)` |
| Follow semantic links | `qdrant_related(collection, source_file)` |
| Find what links here | `qdrant_backlinks(collection, source_file)` |

## Safety rules (always apply)

- RRF scores 0.016–0.033 are normal. Do not treat low scores as retrieval failure — compare rank order and `source_file` instead.
- Before answering verify scope: provider (`ollama` vs `bge-m3-onnx`), environment, collection name.
- Do not use `chunks_out/` as retrieval truth — it is a stale review artifact.
- `qdrant_search` is always hybrid dense+sparse RRF. `search_mode="dense_mmr"` and `search_mode="literal"` are not implemented.
