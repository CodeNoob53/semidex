# Admin Local API — Phase 1D live smoke: POST /api/search (2026-07-02)

Live verification of the real `POST /api/search` path against a running
Qdrant instance and an existing indexed collection, before starting Phase 2
UI work. No UI built, no production code changed — a real bug was searched
for and not found; the one anomaly encountered was a test-tooling artifact
(see below), not a code defect.

## Collection used

`semidex-docs` does not exist in the configured Qdrant instance. An existing
skeleton-enabled collection (`<existing-skeleton-collection>`: existing
indexed collection with named dense+sparse vectors and a skeleton navigation
layer) was used as the substitute. The search query below was a
domain-specific query adapted to that collection's actual content, since the
task's literal "QDRANT_URL" example string doesn't appear in it.

## Setup

```bash
ADMIN_PORT=8642 npm run admin
# [admin] Semidex Local API listening on http://127.0.0.1:8642
curl -s http://127.0.0.1:8642/api/health
# {"ok":true,"storage":{"backend":"qdrant","ok":true,"detail":"Qdrant reachable"}}
```

## Main search request

```bash
curl -s -X POST http://127.0.0.1:8642/api/search \
  -H "Content-Type: application/json" \
  -d '{"collection":"<existing-skeleton-collection>","query":"<domain-specific query>","top":3,"window":1,"windowFormat":"compact"}'
```

**Response summary:** HTTP 200, `searchMode: "hybrid"`, 3 results, all from
the same source area, directly relevant to the query. Result node types:
`table`, `code_block` (skeleton-first structural chunks, not plain prose).
Each result carries `sourceFile`, `chunkIndex`, `totalChunks`, `section`,
`text`, `context`, `tags`, `nodeType`, `nodeId`, `nodePath`, `score`,
`isMatch`, `windowChunks` — all camelCase domain fields, zero Qdrant
snake_case leakage at the top level. `windowChunks` present on every result
(window=1), compact-format window entries use `textSnippet` (truncated)
with no `text` field.

## Pass/fail table

| # | Check | Result |
|---|---|---|
| 1 | HTTP 200 | ✅ PASS |
| 2 | `searchMode === "hybrid"` | ✅ PASS |
| 3 | `results` non-empty | ✅ PASS (3 results) |
| 4 | Results use domain fields (`sourceFile`, `chunkIndex`, `section`, `text`/`context`, `score`) | ✅ PASS |
| 5 | No raw Qdrant snake_case at top level of a result | ✅ PASS (verified programmatically: zero keys containing `_`) |
| 6 | `windowChunks` present when `window=1` | ✅ PASS |
| 7 | Compact window chunks use `textSnippet`, not full `text` | ✅ PASS |
| 8 | No skeleton/nav points returned as search results | ✅ PASS (`nodeType` values seen: `table`, `code_block` only — no `skeleton_nav`, `collection`, or `directory`) |
| 9 | Missing `query` → `400 bad_request` | ✅ PASS |
| 10 | Unknown collection → `404 not_found` | ✅ PASS |
| 11 | Invalid `windowFormat` → `400 bad_request` | ✅ PASS |
| 12 | `sourceFile`-filtered search returns only matching file | ✅ PASS (see note below) |

## Issue found (tooling, not product code)

The `sourceFile`-filtered search initially returned **0 results** when
driven via `curl -d '{"sourceFile":"<source-file.md>", ...}'` in this Git
Bash shell. Root-caused before concluding it was a product bug:

- Called `adapter.searchHybrid()` directly (bypassing HTTP) with the exact
  same filter object the route builds → **5 results**, correct file only.
- Called `translateSearchFilter()` directly → produced the expected
  `{ must: [{ key: "source_file", ... }], must_not: [...] }` shape.
- Re-ran the *same* HTTP request using Node's `fetch()` instead of `curl`
  (eliminating the shell as a variable) → **5 results**, correct file only,
  `Buffer.byteLength` of the outgoing JSON body matched the expected UTF-8
  size.

Conclusion: the non-ASCII filename passed through `curl -d '...'` in this
Git Bash/Windows terminal was mangled before curl ever sent it (a
shell/terminal encoding artifact, not an HTTP, JSON, or adapter-layer
issue). The `POST /api/search` code path, `parseSearchRequest`,
`translateSearchFilter`, and `adapter.searchHybrid` all handled the UTF-8
`sourceFile` value correctly when the encoding was not corrupted upstream by
the shell. No production code was changed as a result — there was nothing
to fix in `src/admin/` or `src/core/`.

## Filtered search request (used to close check #12)

```js
// Node fetch, not curl — avoids the shell encoding artifact above.
fetch('http://127.0.0.1:8642/api/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    collection: '<existing-skeleton-collection>',
    query: '<domain-specific query>',
    top: 5,
    sourceFile: '<source-file.md>',
  }),
});
```

Result: HTTP 200, 5 results, every result's `sourceFile` equal to the
requested filter value — no cross-file leakage.

## Test results

```
npm test
  ℹ tests 299
  ℹ suites 77
  ℹ pass 299
  ℹ fail 0

npm run smoke
  Smoke tests: 1293 passed, 0 failed

git diff --check
  (clean — no code changes were made in this task)
```

## Open notes for Phase 2

- `semidex-docs` should be indexed (`npm run bootstrap:docs`) before it's
  relied on as the canonical demo/UI collection — it doesn't exist in this
  Qdrant instance yet. Not done here since indexing a new collection is a
  write operation outside this task's verification scope.
- Filtered-search testing from a Windows Git Bash shell with non-ASCII
  request bodies should go through a script (`node -e` via a temp file, or a
  proper HTTP client) rather than inline `curl -d '...'` — the shell can
  silently corrupt the payload encoding, producing a misleading
  empty-result false alarm exactly like the one investigated above.

## Verdict

**ADMIN_SEARCH_LIVE_SMOKE_ACCEPT**

All 12 checks pass against a real Qdrant-backed collection through the real
HTTP server. No production code changes were required.
