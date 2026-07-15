# Agent Instructions

semidex is a local-first retrieval system for AI agents. It has two runtime
entry points:

- **Indexer** - writes documents into Qdrant.
- **MCP server** - reads indexed knowledge for agents.

## Core Commands

```bash
COLLECTION=my-docs npm run index <file|folder>  # index documents
npm run mcp                                      # start MCP server (stdio)
npm run sync                                     # sync config.json + Qdrant indexes
npm run backfill:tags                            # generate missing tags for an indexed collection
npm run doctor                                   # read-only environment health check
npm run smoke                                    # offline smoke tests (no Qdrant)
```

Do not run `npm run index` without `COLLECTION` set.

## Source of Truth

Use MCP tools for indexed-knowledge questions. Read repository files directly only for implementation work.

## Recommended MCP Workflow

Start every investigation with:

```text
qdrant_collection_info
  -> qdrant_get_skeleton(collection) if available
  -> qdrant_get_skeleton_children(collection, node_path="<area node>")
  -> qdrant_list_directories(collection, depth=1) if no skeleton exists
  -> qdrant_list_files(collection, source_prefix="<area>/") when you need exact source_file paths
  -> qdrant_search(query, collection, top=3, window=1, window_format="compact")
```

Use skeleton tools as the project map when the collection has `skeleton_nav`
nodes. The skeleton is for orientation and drill-down only; it is not evidence
for factual answers. Use `qdrant_search` / `qdrant_get_chunk` for answer
evidence. If no skeleton exists, fall back to `qdrant_list_directories` at
depth=1, then drill with `source_prefix` before listing files. Do not guess
`source_file` paths.

For tag discovery and breadth expansion:

```text
qdrant_search(...)
  -> qdrant_list_tags(collection, contains="...", source_prefix="<known-area>/")
  -> qdrant_find_by_tag(collection, tags=[...])
```

Tags exist only when the collection was indexed with `TAG_GEN=1` or processed with `npm run backfill:tags`. On large collections, always scope `qdrant_list_tags` with `source_prefix` and `contains` to avoid an unmanageable flat list.

Search patterns by task:

- **Simple lookup:** `qdrant_search(query, collection)`
- **Implementation or explanation:** `qdrant_search(query, collection, top=3, window=1, window_format="compact")`
- **Structured data in compact output:** If a compact snippet shows a table, checklist, or YAML/JSON block cut mid-row, call `qdrant_get_chunk` directly — compact snippets are capped at 150 chars.
- **Deep context:** `qdrant_get_chunk(collection, source_file, chunk_index, window=1)`
- **Coherent section/file context around a hit, bounded:**
  ```text
  qdrant_search(...)
    -> if more coherent context is needed and node_id is available:
       qdrant_get_content(collection, anchor_node_id=<hit's node_id>, scope="section", max_tokens=<bounded>)
    -> use scope="file" only when section context is insufficient
  ```
  `qdrant_get_content` assembles bounded contextual evidence (prose
  continuous, tables/code/checklists at their original position with
  authoritative raw content) — it is not a full-document dump; paginate
  with `cursor_before`/`cursor_after`. `qdrant_get_node` remains for
  retrieving one full original entity by ID/path, mainly for explicit user
  display. Skeleton summaries remain navigation-only evidence, never a
  valid `anchor_node_id`. Legacy collections without skeleton node identity
  cannot use `qdrant_get_content` — reindex with `SKELETON_CHUNKING=1` first.

MCP tools reference:

| Goal | Tool |
|------|------|
| List collections and provider metadata | `qdrant_collection_info()` |
| Open the collection skeleton map | `qdrant_get_skeleton(collection)` |
| Read one skeleton node | `qdrant_get_skeleton_node(collection, node_id? XOR node_path?)` |
| Drill into skeleton children | `qdrant_get_skeleton_children(collection, node_id? XOR node_path?, limit?)` |
| Get full original table or code block (display / known path) | `qdrant_get_node(collection, node_id? XOR node_path?, preview_chars?)` |
| Explore folder structure | `qdrant_list_directories(collection, source_prefix?, depth?)` |
| List files in a folder | `qdrant_list_files(collection, source_prefix?, tags?, tag_match?)` |
| List tags with counts | `qdrant_list_tags(collection, source_prefix?, tag_prefix?, contains?, min_count?)` |
| Find chunks by topic | `qdrant_search(query, collection)` |
| Search inside one file | `qdrant_search(query, collection, source_file=...)` |
| Filter by tags | `qdrant_search(query, collection, tags=[...])` |
| Read a chunk with neighbors | `qdrant_get_chunk(collection, source_file, chunk_index, window=1)` |
| Find chunks with a tag | `qdrant_find_by_tag(collection, tag)` |
| Find chunks matching multiple tags | `qdrant_find_by_tag(collection, tags=[...], match="any"\|"all")` |
| Bounded coherent context around a search hit | `qdrant_get_content(collection, anchor_node_id, scope="section"\|"file", max_tokens?, cursor?, format?)` |

**Truncation rule:** When a tool output says `Found N … showing M` where M < N, the list is truncated — narrow the query with `source_prefix`, `tag_prefix`, or `contains` and re-call.

## Agent Retrieval Safety Rules

Use `qdrant_search(..., window=1, window_format="compact", top=3)` as the recommended agent search pattern. Use `top=5` for ambiguous, negative, or scope-sensitive queries.

- Do not treat absolute RRF score values as confidence. Typical scores fall in **0.016–0.033**. Compare rank order, `source_file`, section, exact-token overlap, and the `context` field.
- Verify scope before answering: environment, model/provider, database/system, feature.
- If retrieved evidence refers to a different scope, state the mismatch and do not answer as if it matched.
- Raw chunks may contain distractors, stale values, or explicit false examples. Prefer current, non-distractor evidence tied to the query.

## Search Tactics For Agents

- Use both natural-language and exact-token queries when needed.
- For config, CLI, or code questions, include exact identifiers: env vars, function names, config keys, log line fragments.
- If a result is relevant but too narrow, call `qdrant_get_chunk` with a window before acting on it.
- If multiple documents are likely related, use `qdrant_search` with a scoped `source_file` filter to gather evidence across them.
- If multiple collections exist, use collection descriptions and source files to choose the right one.
- Use skeleton tools to understand collection/file/section structure before search on large or unfamiliar collections.
- Do not cite skeleton summaries as final evidence; they are navigation summaries. Verify with retrieval chunks.
- For ambiguous tasks, gather at least two supporting hits or one hit plus its surrounding chunks before making a claim.
- Prefer `source_file` filters once a likely file is known. Do not invent a `source_file` filter when no scope is given.

## Indexing Guide for Agents

```bash
# Recommended (quality / multilingual)
ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs

# With skeleton nav (Markdown collections — enables drill-down via skeleton tools)
SKELETON_CHUNKING=1 SKELETON_NAV=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs

# Prune stale files after deletes/renames (full root only)
PRUNE_STALE=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs

# Generate tags during indexing
TAG_GEN=1 ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs

# Backfill tags on an already-indexed collection
COLLECTION=my-docs npm run backfill:tags
```

- Always set `COLLECTION`. The indexer exits with a usage error if it is unset.
- Use `ONNX_EMBED=1` for serious indexing — it uses `bge-m3-onnx` for both dense and sparse vectors.
- Use `SKELETON_CHUNKING=1` for Markdown collections to enable skeleton navigation tools (`qdrant_get_skeleton` etc.). Nav nodes are generated by default with it; set `SKELETON_NAV=0` to disable. `SKELETON_NAV=1` alone (without `SKELETON_CHUNKING=1`) does not generate nav nodes.
- Do not mix providers in one collection. Changing provider, model, or schema version requires reindexing.
- Run `npm run sync` after upgrading semidex or when adopting an existing remote collection.
- Use `PRUNE_STALE=1` only against the full source root, never a subset.
- Provider/schema/chunking changes trigger automatic reindex detection — let them complete.

For details, read `docs/en/configuration.md` or `docs/en/architecture.md`.

## What Not To Do

- Do not use MCP tools to index documents; they are read-only.
- Do not mix embedding providers for the same collection.
- Do not manually change `vectorSize` or schema fields to avoid reindexing.
- Do not commit generated `config.json` or model cache unless explicitly requested.

## Troubleshooting

- Run `npm run doctor` first for unclear environment failures.
- Qdrant unreachable → check `QDRANT_URL`; run `npm run sync`.
- Ollama unreachable → start `ollama serve`; run `ollama pull <model>` if models are missing.
- `Not existing vector name: dense` → run `npm run sync`; if it reports a legacy schema, drop and reindex.
- Tokenizer unavailable → model cache issue; check `./models/` and network access.
- Stale results after delete/rename → run full-root `PRUNE_STALE=1 ... npm run index ./root`.
- Search looks wrong → check `qdrant_collection_info()` provider metadata before changing ranking logic.

If these instructions are insufficient, read the relevant file under `docs/`.
