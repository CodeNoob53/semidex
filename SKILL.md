---
name: semidex
description: "Use when working with semidex: indexing documents, configuring retrieval, debugging search results, checking env vars, or understanding architecture. Prefer live semidex MCP search over loading static docs into context."
argument-hint: "question or task"
allowed-tools: mcp__qdrant__qdrant_search, mcp__qdrant__qdrant_collection_info, mcp__qdrant__qdrant_get_chunk, mcp__qdrant__qdrant_find_by_tag, mcp__qdrant__qdrant_list_files, mcp__qdrant__qdrant_list_tags, mcp__qdrant__qdrant_list_directories, mcp__qdrant__qdrant_get_skeleton, mcp__qdrant__qdrant_get_skeleton_node, mcp__qdrant__qdrant_get_skeleton_children, mcp__qdrant__qdrant_get_node, mcp__qdrant__qdrant_get_content
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
      "args": ["C:\\absolute\\path\\to\\semidex\\src\\mcp\\server.js"],
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
collection's configured provider. A generic `qdrant-mcp` plugin may hardcode the
wrong embedding provider and return wrong results for `bge-m3-onnx` collections.

## Search Workflow

Start with collection metadata:

```text
qdrant_collection_info()
  -> qdrant_get_skeleton(collection) if available
  -> qdrant_get_skeleton_children(collection, node_path="<area node>")
  -> qdrant_list_directories(collection, depth=1) if no skeleton exists
  -> qdrant_list_files(collection, source_prefix="<area>/") when exact source_file paths are needed
  -> qdrant_search(query, collection, top=3, window=1, window_format="compact")
```

Sanity check before relying on results: confirm the expected collection exists and
`qdrant_collection_info()` shows semidex provider metadata. If it shows only
generic Qdrant collection names without provider fields, you may be connected to a
generic Qdrant MCP server instead of semidex MCP — stop and warn.

For tag discovery and breadth expansion:

```text
qdrant_list_tags(collection, contains="...", source_prefix="<known-area>/")
  -> qdrant_find_by_tag(collection, tags=[...])
```

Use skeleton tools as the collection map when available. Skeleton summaries help
orientation and drill-down; do not cite them as answer evidence. Verify claims
with `qdrant_search` or `qdrant_get_chunk`. If no skeleton exists, call
`list_directories` at depth=1 first, then drill with `source_prefix`. Do not
guess `source_file` paths. Tags are best used for breadth expansion after
search, not as a first step.

For most work, search with compact neighbors:

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
function names, config keys, CLI flags, model names.

## MCP Tools

| Goal | Tool |
|------|------|
| List collections and provider metadata | `qdrant_collection_info()` |
| Open the collection skeleton map | `qdrant_get_skeleton(collection)` |
| Read one skeleton node | `qdrant_get_skeleton_node(collection, node_id? XOR node_path?)` |
| Drill into skeleton children | `qdrant_get_skeleton_children(collection, node_id? XOR node_path?, limit?)` |
| Explore folder structure | `qdrant_list_directories(collection, source_prefix?, depth?)` |
| List files in a folder | `qdrant_list_files(collection, source_prefix?, tags?, tag_match?)` |
| List available tags | `qdrant_list_tags(collection, source_prefix?, tag_prefix?, contains?, min_count?)` |
| Search semantically and lexically | `qdrant_search(query, collection, top=3, window=1, window_format="compact")` |
| Search inside one file | `qdrant_search(query, collection, source_file=..., top=3, window=1, window_format="compact")` |
| Filter by tags | `qdrant_search(query, collection, tags=[...], top=5)` |
| Read a chunk and neighbors | `qdrant_get_chunk(collection, source_file, chunk_index, window=1)` |
| Find chunks by tag(s) | `qdrant_find_by_tag(collection, tags=[...], match="any"\|"all")` |
| Get full original table or code block | `qdrant_get_node(collection, node_id? XOR node_path?, preview_chars?)` |
| Bounded coherent context around a search hit | `qdrant_get_content(collection, anchor_node_id, scope="section"\|"file", max_tokens?, cursor?, format?)` |

- `qdrant_search` always uses hybrid dense+sparse RRF.
- If a compact snippet shows a table, checklist, or YAML/JSON block cut mid-row, call `qdrant_get_chunk` directly — compact snippets are capped at 150 chars.
- **Structural content (table, code_block):** `qdrant_search` is the default retrieval path — structural chunks are embedded and return at rank 1–2 for exact-token queries. Call `qdrant_get_node` only when the user needs the full original rendered content, or when a `node_path` is already known (from skeleton navigation or a placeholder). Do not use `qdrant_get_node` as a fallback when search returns poor results.
- **Truncation:** `Found N … showing M` means the list is truncated. Narrow with `source_prefix`, `tag_prefix`, or `contains` and re-call.
- **Bounded coherent context around a hit:**
  ```text
  qdrant_search(...)
    -> if more coherent context is needed and node_id is available:
       qdrant_get_content(collection, anchor_node_id=<hit's node_id>, scope="section", max_tokens=<bounded>)
    -> use scope="file" only when section context is insufficient
  ```
  `qdrant_get_content` assembles bounded contextual evidence (prose continuous, tables/code/checklists at their original position, authoritative raw content) — not a full-document dump; paginate with `cursor_before`/`cursor_after`. `qdrant_get_node` is for one full original entity, mainly for explicit user display. Skeleton summaries stay navigation-only, never a valid anchor. Legacy collections without skeleton node identity cannot use `qdrant_get_content` — reindex with `SKELETON_CHUNKING=1` first.

## Retrieval Safety Rules

- Do not treat absolute RRF scores as confidence. Scores around `0.016–0.033` are normal. Compare rank, source file, section, context, and exact-token overlap.
- Verify scope before answering: collection, provider, environment, feature, storage system.
- If evidence is from the wrong scope, say so and do not answer as if it matched.
- Raw chunks can include stale values, false examples, or distractors. Prefer current, non-distractor evidence.

## Indexing

```bash
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs
SKELETON_CHUNKING=1 SKELETON_NAV=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs  # with skeleton nav
PRUNE_STALE=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs  # full-root stale cleanup only
npm run sync          # after upgrading or adopting a remote collection
npm run doctor        # environment health check
```

- Always set `COLLECTION`. Use `ONNX_EMBED=1` for serious indexing.
- Use `SKELETON_CHUNKING=1` for Markdown collections to enable skeleton navigation. Nav nodes are generated by default with it; `SKELETON_NAV=0` is the kill-switch. `SKELETON_NAV=1` alone (without `SKELETON_CHUNKING=1`) does not generate nav nodes.
- Do not mix providers in one collection. Provider/schema changes require reindexing.
- Use `PRUNE_STALE=1` only against the full source root, never a subset.

## Troubleshooting

- Run `npm run doctor` first.
- Qdrant unreachable → check `QDRANT_URL`; run `npm run sync`.
- Ollama unreachable → start `ollama serve`; pull missing models.
- `Not existing vector name: dense` → run `npm run sync`; if legacy schema, drop and reindex.
- Search looks wrong → check `qdrant_collection_info()` provider metadata before changing ranking logic.

If these instructions are insufficient, read the relevant file under `docs/`.
