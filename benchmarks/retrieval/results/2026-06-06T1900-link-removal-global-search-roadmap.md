# Link Removal & Global Search Roadmap

**Date:** 2026-06-06
**Verdict:** `LINK_INDEXING_REMOVED_GLOBAL_SEARCH_DEFERRED`

## What Changed

### Production indexing path (`src/indexer/index.js`)

- Removed the indexing-time link phase after upsert. `stageD` now ends after
  `upsertPoints` and `deleteTrailingChunks`.
- Removed imports and calls for `buildLinks`, `loadGraph`, `saveGraph`,
  `removeFile`, and `updatePayload`.
- Removed `linkTargetCollections` resolution, graph loading/saving, and graph
  cleanup from the prune loop.
- Renamed pipeline queue wording from link-specific to commit-specific.
- New pipeline shape: chunk -> contextualize -> tag -> embed -> upsert.

### MCP server (`src/mcp/server.js`)

- Removed `qdrant_related` and `qdrant_backlinks` from the tool registry.
- Deleted `src/mcp/tools/related.js` and `src/mcp/tools/backlinks.js`.
- Deleted `src/core/graph.js` and `src/indexer/phases/link.js`.

### Reranker

- Removed graph loading from `src/core/rerank.js`.
- Removed `RERANK_BOOST_BACKLINK` and backlink-based scoring.

### Smoke tests

- Deleted link/graph-only smoke sections 10, 21, 22, and 25.
- Removed those imports and registrations from `src/smoke/index.js`.
- Smoke result: 674 passed, 0 failed.

### Agent and docs surface

- Removed `qdrant_related` and `qdrant_backlinks` from AGENTS, SKILL files,
  MCP documentation, Ukrainian README workflow, and tool tables.
- Removed `LINK_TOP`, `LINK_MIN_SCORE`, `LINK_COLLECTIONS`, and
  `RERANK_BOOST_BACKLINK` from active configuration documentation.
- Removed `graph.<collection>.json` from active project-structure docs and the
  tracked `graph.example.json` artifact.

## Planned Replacement

Cross-collection discovery should move to query-time scoped global search.
The agent or user will provide explicit collections, a collection prefix, or a
named scope. Results should be grouped by collection -> source_file -> chunks.

Planned API shape:

```js
qdrant_search_global({
  query,
  collections?: string[],
  collection_prefix?: string,
  scope?: string,
  top_per_collection?: number,
  final_top?: number,
  window?: number,
})
```

## Verification

- `npm run smoke`: 674 passed, 0 failed.
- `git diff --check`: clean; CRLF normalization warnings only on Windows.
