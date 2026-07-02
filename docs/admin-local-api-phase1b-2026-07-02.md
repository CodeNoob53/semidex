# Admin UI Foundation — Phase 1B: Local API read/navigation endpoints (2026-07-02)

Extends the Phase 1A Local API (`docs/admin-local-api-phase1a-2026-07-02.md`)
with the read/navigation surface needed before any UI work: source documents,
chunk windows, and the skeleton navigation tree. Still no UI, no search
endpoint, no destructive endpoints — every handler depends on the
`StorageAdapter` contract only.

## Endpoints implemented

| Method & path | Adapter call | Success | Not-found handling |
|---|---|---|---|
| `GET /api/collections/:name/documents?prefix=&limit=` | `listSourceDocuments(name, { prefix, limit })` | `{ collection, documents }` | `404` if collection missing |
| `GET /api/collections/:name/chunks?sourceFile=&chunkIndex=&window=` | `getChunk(name, sourceFile, chunkIndex, { window })` | `{ collection, sourceFile, chunkIndex, window, chunks }` | `404` if collection missing; empty `chunks: []` with `200` if the adapter finds nothing (no invented not-found semantics — matches the task spec) |
| `GET /api/collections/:name/skeleton` | `getSkeletonRoot(name)` | `{ collection, skeleton }` | `404` if collection missing; `skeleton: null` with `200` if the collection has no skeleton layer |
| `GET /api/collections/:name/skeleton/node?nodeId=\|nodePath=` | `getSkeletonNode(name, { nodeId, nodePath })` | `{ collection, node }` | `404` if collection missing or node not found |
| `GET /api/collections/:name/skeleton/children?nodeId=\|nodePath=&limit=` | `getSkeletonChildren(name, { nodeId, nodePath, limit })` | `{ collection, children }` | `404` if collection missing; empty array if the parent doesn't exist (adapter doesn't distinguish "missing parent" from "parent with 0 children" cheaply — kept as-is per the task spec) |
| `GET /api/collections/:name/node?nodeId=\|nodePath=` | `getStructuralNode(name, { nodeId, nodePath })` | `{ collection, node }` | `404` if collection missing or node not found |

Every route first calls `adapter.getCollection(name)` as the existence
check, matching the pattern already established by
`POST /api/collections/:name/sync-schema` in Phase 1A.

## Validation rules

New shared helpers in `src/admin/api/query-params.js` (kept local to
`src/admin/`, not promoted to core — these are HTTP-input-shaping concerns,
not domain logic):

- **`parseIntParam(query, name, { defaultValue, min, max, belowMin, aboveMax })`**
  — parses an optional integer, rejecting non-integer/float input outright
  (`400`). Out-of-range handling is independently configurable per bound
  (`'clamp'` or `'reject'`, default `'clamp'` for both) because different
  endpoints in this slice intentionally treat the two bounds differently:
  - **`limit` (documents, skeleton/children)**: `< 1` → **reject** (400) —
    a non-positive limit is almost certainly a client bug, and silently
    coercing it to 1 would hide that. `> 1000` (documents) / `> 500`
    (children) → **clamp** — a large-but-honest "give me everything"
    request shouldn't hard-fail when a cheap, safe upper bound exists.
  - **`window` (chunks)**: both `< 0` and `> 5` → **reject**. A silently
    clamped window could confuse a caller comparing the window size it
    requested against the one it got back, so this endpoint rejects on both
    sides rather than mixing policies.
- **`requireIntParam(query, name, opts)`** — like `parseIntParam` but with
  no `defaultValue`; a missing/empty param throws `400 "... is required"`.
  Used for `chunkIndex` (required, `>= 0`, reject-below, no upper bound —
  chunk indices are per-file with no meaningful cap to clamp to).
- **`requireExactlyOne(query, names)`** — used for the `nodeId`/`nodePath`
  pairs on all three node-identifying endpoints (skeleton node, skeleton
  children, structural node). Throws `400` for zero or two-of-two present;
  an empty-string param counts as absent (`?nodeId=&nodePath=p1` resolves to
  `nodePath`).
- **`requireStringParam(query, name)`** — used for `sourceFile` on the
  chunks endpoint.

Concrete bounds per endpoint:

| Param | Endpoint | Required | Default | Bounds | Below-min | Above-max |
|---|---|---|---|---|---|---|
| `limit` | documents | no | 100 | `[1, 1000]` | reject | clamp |
| `sourceFile` | chunks | yes | — | non-empty string | — | — |
| `chunkIndex` | chunks | yes | — | `>= 0` | reject | (no max) |
| `window` | chunks | no | 0 | `[0, 5]` | reject | reject |
| `nodeId` / `nodePath` | skeleton/node, skeleton/children, node | exactly one | — | non-empty string | — | — |
| `limit` | skeleton/children | no | 50 | `[1, 500]` | reject | clamp |

## What was intentionally not implemented

Per the task's non-goals: UI, search endpoint, indexing jobs, collection
create/delete, aliases/snapshots, CORS, auth, and any direct Qdrant access
from `src/admin/`. No design doc change was needed — this slice fills in
endpoints the design doc already lists in §7 (`documents`, `chunks`,
`skeleton`, `skeleton/node`, `skeleton/children`, `node`) without altering
their shapes or semantics; it's an implementation of already-planned scope,
not a redesign.

## How to run locally

```bash
npm run admin
# [admin] Semidex Local API listening on http://127.0.0.1:8642

curl "http://127.0.0.1:8642/api/collections/my-collection/documents?prefix=docs/&limit=20"
curl "http://127.0.0.1:8642/api/collections/my-collection/chunks?sourceFile=docs/readme.md&chunkIndex=3&window=1"
curl "http://127.0.0.1:8642/api/collections/my-collection/skeleton"
curl "http://127.0.0.1:8642/api/collections/my-collection/skeleton/node?nodePath=docs%2Freadme.md"
curl "http://127.0.0.1:8642/api/collections/my-collection/skeleton/children?nodePath=docs%2Freadme.md&limit=10"
curl "http://127.0.0.1:8642/api/collections/my-collection/node?nodePath=docs%2Freadme.md%23Setup%2Ftable-1"
```

## Test results

```
npm test
  ℹ tests 283
  ℹ suites 73
  ℹ pass 283
  ℹ fail 0

npm run smoke
  Smoke tests: 1293 passed, 0 failed

node --check src/admin/server.js   OK
node --check src/admin/router.js   OK

git diff --check                   clean
```

New/changed test files (56 new tests: 22 + 34):
- `tests/unit/admin/query-params.test.js` (22 tests) — `parseIntParam`
  (missing/empty → default, valid parse, non-integer/float rejection,
  clamp-by-default on both bounds, explicit `belowMin`/`aboveMax: 'reject'`,
  negative values within range), `requireIntParam` (missing/empty →
  required-error, valid parse, bound rules inherited), `requireExactlyOne`
  (single-present both ways, neither-present, both-present,
  empty-string-counts-as-absent), `requireStringParam`
  (present/missing/empty).
- `tests/unit/admin/server.test.js` (34 new tests added to the existing
  Phase 1A file, all end-to-end over a real `node:http` server with a stub
  adapter): documents (found, 404, prefix forwarding, default limit,
  reject-below-min, clamp-above-max), chunks (returns list, requires
  `sourceFile`, requires `chunkIndex`, rejects non-integer/negative
  `chunkIndex`, default `window`, rejects negative/over-max `window`,
  `200` with empty `chunks: []` for a not-found-by-adapter case), skeleton
  root (found, `null`-when-absent, 404-when-collection-missing), skeleton
  node (`nodeId` and `nodePath` both work, neither/both rejected, 404 on
  adapter `null`), skeleton children (`nodeId`/`nodePath` both work,
  default limit, invalid-limit rejection, array shape), structural node
  (`nodeId`/`nodePath` both work, neither/both rejected, 404 on adapter
  `null`). The existing layering test (recursive scan of every file under
  `src/admin/` for a forbidden Qdrant import) automatically covers the five
  new files in `src/admin/api/` with no test-file changes required.

No live Qdrant required anywhere — all new tests drive a stub adapter
through a real HTTP server on an OS-assigned loopback port.

## Open risks / next logical step

- **`skeleton/children`'s "missing parent" vs. "parent with zero children"
  ambiguity is inherited from the adapter, not resolved here.** Both cases
  currently return `200 { children: [] }`. Distinguishing them cleanly would
  need `getSkeletonNode` called first to confirm the parent exists (an extra
  round trip this endpoint currently avoids) — worth revisiting if the UI
  needs to show "no such node" vs. "empty folder" differently.
- **`documents`/`skeleton/children` clamp silently above their max**, so a
  client requesting `limit=999999` gets `1000`/`500` back with no signal in
  the response body that clamping happened. If the UI ever needs to show
  "showing 1000 of N", the response would need a `requestedLimit` or
  `clamped: true` field — not needed yet since no UI consumes this.
- **No pagination beyond `limit`** (no cursor/offset) on `documents` or
  `skeleton/children` — matches what the underlying adapter methods
  currently support (design doc Phase 0 didn't add cursoring either); a
  collection with thousands of source files would need this before the UI's
  collection-detail screen becomes usable at scale.
- **Next logical step**: `POST /api/search` (design doc §7) is the last
  read-path endpoint before a minimal UI becomes buildable end-to-end for
  the "does retrieval work?" MVP question — it needs query embedding wired
  through `core/embeddings.js` above the adapter boundary (embedding is
  provider logic per the design doc, not storage logic), which is a
  larger, separate slice.
