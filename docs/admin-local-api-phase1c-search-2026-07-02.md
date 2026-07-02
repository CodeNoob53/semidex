# Admin Local API — Phase 1C Search Endpoint Report (2026-07-02)

Implements `POST /api/search`, the last read-path endpoint before the minimal
Admin UI (design doc `docs/design/admin-ui-and-storage-adapter.md` §7).

## Endpoint contract

`POST /api/search` — JSON body:

| Field | Required | Type / range | Default |
|---|---|---|---|
| `collection` | yes | non-empty string | — |
| `query` | yes | non-empty string | — |
| `top` | no | integer 1–20 | `3` |
| `window` | no | integer 0–5 | `0` |
| `windowFormat` | no | `"compact"` \| `"full"` | `"compact"` when `window > 0`; normalised to `null` when `window = 0` |
| `sourceFile` | no | non-empty string | — |
| `tags` | no | non-empty array of non-empty strings | — |

### Request example

```json
{
  "collection": "my-docs",
  "query": "how to configure QDRANT_URL",
  "top": 3,
  "window": 1,
  "windowFormat": "compact",
  "sourceFile": "docs/en/configuration.md",
  "tags": ["configuration"]
}
```

### Response example

```json
{
  "collection": "my-docs",
  "query": "how to configure QDRANT_URL",
  "searchMode": "hybrid",
  "top": 3,
  "window": 1,
  "windowFormat": "compact",
  "results": [
    {
      "sourceFile": "docs/en/configuration.md",
      "chunkIndex": 4, "totalChunks": 10, "section": "Qdrant",
      "text": "...", "context": "...", "tags": ["configuration"],
      "nodeType": null, "nodeId": null, "nodePath": null,
      "score": 0.0323, "isMatch": true,
      "windowChunks": [
        { "sourceFile": "docs/en/configuration.md", "chunkIndex": 3,
          "section": "Qdrant", "isMatch": false, "textSnippet": "…(≤150 chars)..." },
        { "sourceFile": "docs/en/configuration.md", "chunkIndex": 4,
          "section": "Qdrant", "isMatch": true,  "textSnippet": "…" }
      ]
    }
  ]
}
```

Errors use the existing envelope `{ "error": { "code", "message" } }`:
invalid JSON / missing `collection` / missing `query` / bad
`top`/`window`/`windowFormat`/`tags` → `400 bad_request`; unknown collection
→ `404 not_found`; embedding failure → `500 embedding_failed` (provider
message passed through); unsupported backend → `501 not_implemented`.

## Layering

```text
handler (src/admin/api/search.js)
  1. validate body (local helpers; reject, never guess)
  2. searchMode from adapter.capabilities()
  3. adapter.getCollection() existence check → 404
  4. embedQuery(collection, query)          ← ABOVE the adapter boundary
  5. adapter.searchHybrid(collection, { dense, sparse, limit: top,
       filter: { sourceFile?, tags?, excludeNav: true } })
  6. window > 0 → expandWindows() via adapter.getChunk() (domain shapes)
```

- Embedding stays provider logic: the default `embedQuery` is
  `core/embeddings.js#embedForSearch` (already exactly
  `(collection, query) → { dense, sparse }`, embedding with the collection's
  configured provider). **No new core wrapper module was needed** — adding
  `src/core/retrieval/query.js` around a one-call function would have been
  indirection without content.
- `embedQuery` is dependency-injected: `createApp({ adapter, embedQuery })`
  → `registerSearchRoutes(router, adapter, { embedQuery })`. Unit tests stub
  it and never load ONNX/Ollama.
- **No MCP tool imports** and no Qdrant store/client/SDK imports under
  `src/admin/` (enforced by the existing layering test, which scans every
  file under `src/admin/` including the new one).

## Window expansion (Option A)

Implemented, not deferred. The MCP `assembleWindowChunks` helper was **not**
imported (it works on raw Qdrant payloads and lives in an MCP tool module);
the same semantics are reimplemented in ~40 lines on domain `Chunk` objects
via `adapter.getChunk()`:

- matched chunk always preserved in its own window (`isMatch: true`);
- duplicate non-match neighbors across results emitted once;
- `compact` → `textSnippet` capped at 150 chars + `"..."`, no `text` field;
- `full` → untruncated `text`, no snippet;
- hits without an integer `chunkIndex` get `windowChunks: []` rather than a
  failed lookup.

## Search mode behavior

`searchMode = 'hybrid'` iff `caps.hybridSearch && caps.sparseVectors`.
Otherwise the endpoint returns **`501 not_implemented`** with an explicit
message. Rationale (the "smaller safe implementation" branch of the task):
the StorageAdapter contract has no `searchDense` yet; adding it silently for
a fallback nobody can exercise today (the only adapter is Qdrant, which is
hybrid-capable) would grow the interface without a consumer. When a
dense-only backend appears, `searchDense` is added to the contract +
validator + stub adapter deliberately (design doc §14 checklist rule).

## Intentionally deferred

- `searchDense` adapter method / dense-only mode (see above).
- Reranker integration (`RERANK_*` paths remain MCP-only for now).
- Rate limiting, auth, CORS — out of scope per design doc §10.
- Pagination of results (top ≤ 20 is the cap).

## Tests run

| Check | Result |
|---|---|
| `npm test` (299 tests, incl. 16 new in `tests/unit/admin/search.test.js`) | 299/299 pass |
| `npm run smoke` | 1293/1293 pass |
| `node --check src/admin/server.js` / `src/admin/api/search.js` | pass |
| `git diff --check` (touched files) | clean |
| Layering scan: no Qdrant/MCP imports under `src/admin/` | pass |

New test coverage: invalid JSON, missing collection/query, invalid
top/window/windowFormat/tags, 404 collection, adapter contract (vectors,
`limit = top`, filter `{ sourceFile, tags, excludeNav: true }`, default
top = 3), `searchMode` in response, compact/full window expansion,
cross-result neighbor dedup, 501 on non-hybrid capabilities, 500 on
embedding failure.

## Open risks / next step

- Window expansion issues one `adapter.getChunk()` call per hit
  (sequential). At `top ≤ 20`, `window ≤ 5` this is bounded and fine for a
  local admin tool; parallelizing is a micro-optimization if UI latency ever
  warrants it.
- The compact snippet width (150) mirrors the MCP constant by value, not by
  shared import — deliberate (no MCP coupling), but if the MCP constant ever
  changes, the two surfaces drift by design.
- Live verification against a real Qdrant + real embeddings has not been run
  in this task (unit tests are stub-based per spec); the first manual
  `POST /api/search` against `semidex-docs` is the natural smoke check
  before building the UI.
- **Next step:** Phase 2 — minimal Admin UI (static shell, health →
  collections → indexing → search playground per design doc §8), for which
  this endpoint was the last missing read path. Indexing jobs (Phase 1D per
  the design doc's job model, §9) can proceed in parallel.
