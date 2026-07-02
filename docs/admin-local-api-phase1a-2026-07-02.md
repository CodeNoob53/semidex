# Admin UI Foundation — Phase 1A: Local API read layer (2026-07-02)

Implements a narrow first slice of `docs/design/admin-ui-and-storage-adapter.md`
§7/§13 Phase 1: a `node:http`, zero-dependency, localhost-only Local API that
speaks the `StorageAdapter` contract exclusively. No dashboard UI, no
indexing jobs, no search endpoint — those remain later Phase 1 work.

## Endpoints implemented

All under `http://127.0.0.1:8642/api` by default (port via `ADMIN_PORT`,
host via `ADMIN_HOST`).

| Method & path | Behavior |
|---|---|
| `GET /api/health` | `{ ok, storage: { backend, ok, detail } }`. Always HTTP 200; `ok: false` reflects an unreachable backend without failing the request itself. |
| `GET /api/capabilities` | `{ backend, capabilities }` from `adapter.capabilities()`. |
| `GET /api/collections` | `{ collections: [...] }` from `adapter.listCollections()`. |
| `GET /api/collections/:name` | `{ collection: {...} }` from `adapter.getCollection(name)`; `404` (`{ error: { message, code: "not_found" } }`) when the adapter returns `null`. `:name` is URL-decoded by the router before reaching the handler — no filesystem-path semantics apply to it, it's an opaque string key. |
| `POST /api/collections/:name/sync-schema` | Calls `adapter.getCollection(name)` first as an existence check (cheapest one the adapter exposes), `404` if missing; otherwise runs `adapter.ensureCollectionSchema(name)` and returns `{ collection, repaired, warnings }`. |

Error envelope for every non-2xx response: `{ error: { message, code } }`,
matching design doc §7. Unknown routes and known-path-wrong-method both
return `404` with `code: "not_found"` — a single consistent "not found"
status rather than splitting 404 vs 405, per the task's explicit
"choose one and keep consistent" instruction.

## What was intentionally not implemented

Per the task's non-goals, none of the following exist yet:
- Dashboard UI (`src/admin/ui/`).
- Indexing job endpoints (`/api/jobs/*`) — job registry, SSE logs, cancel.
- `POST /api/search` — needs `core/embeddings.js` query embedding wired to
  the retrieval service, out of scope for a read/admin-only slice.
- `DELETE /api/collections/:name` — explicitly excluded ("Do not implement
  destructive delete yet"); `adapter.deleteCollection()` exists from Phase 0
  but has no route.
- `POST /api/collections` (create) — not in this task's endpoint list.
- `/api/collections/:name/documents`, `/chunks`, `/skeleton*`, `/node` — the
  adapter methods (`listSourceDocuments`, `getChunk`, `getSkeletonRoot`,
  etc.) exist from Phase 0 but have no routes yet; this slice covers health,
  capabilities, collection listing/detail, and schema sync only.
- Aliases/snapshots, CORS, authentication, non-loopback binding by default.

### Deliberate scope note vs. the design doc

The design doc's `GET /api/health` (§7) returns a full `HealthReport` built
from `doctor-checks.js` (Qdrant + Ollama + ONNX + env + per-collection
status). This task's spec asks for a narrower `{ ok, storage }` shape
covering only the storage adapter's `ping()`. Implemented exactly as the
task specifies — `doctor-checks.js` reuse for the full `HealthReport` is a
natural next increment of `/api/health`, not a redesign, since the storage
sub-object this endpoint returns is a strict subset of the design doc's
shape (same field names, same meaning). Likewise, the design doc's
`POST /api/sync` operates across all collections; this slice's
`POST /api/collections/:name/sync-schema` is scoped to one collection
(matching the task spec verbatim). No change to the design doc was made —
both gaps are additive, not contradictory, so the design doc still describes
the intended end state accurately.

## How to run locally

```bash
npm run admin
# [admin] Semidex Local API listening on http://127.0.0.1:8642

# in another shell:
curl http://127.0.0.1:8642/api/health
curl http://127.0.0.1:8642/api/capabilities
curl http://127.0.0.1:8642/api/collections
curl http://127.0.0.1:8642/api/collections/my-collection
curl -X POST http://127.0.0.1:8642/api/collections/my-collection/sync-schema
```

Requires the same `.env` / `QDRANT_URL` as any other semidex command — the
server constructs a real `createQdrantStorageAdapter()` via
`createStorageAdapter()` by default. `ADMIN_PORT=9000 npm run admin` and
`ADMIN_HOST=localhost npm run admin` override the bind; setting
`ADMIN_HOST` to anything non-loopback throws immediately unless
`ADMIN_ALLOW_REMOTE=1` is also set (refuses to start, not a runtime warning
— fail fast on a misconfiguration that would expose the API on the network).

## Architecture notes

- **`src/core/storage/factory.js`** — `createStorageAdapter({ backend })`,
  keyed lookup table (`{ qdrant: createQdrantStorageAdapter }`), defaults to
  `process.env.SEMIDEX_STORAGE_BACKEND ?? 'qdrant'`. Unknown backend throws
  with the list of known backends in the message. Not wired into the
  indexer or MCP tools (task explicitly says not to yet — Phase 4 per the
  design doc).
- **`src/admin/http.js`** — `sendJson`, `sendError`, `HttpError` (+
  `badRequest`/`notFound` constructors), `readJsonBody` (size-capped, not
  currently used by any handler since none of Phase 1A's routes take a
  body, but ready for `POST /api/collections` later).
- **`src/admin/router.js`** — segment-based method+path matcher with
  `:param` extraction and URL-decoding, `URLSearchParams` query parsing,
  and centralized error-to-response translation (`HttpError` → its
  status/code; anything else → `500 internal_error`).
- **`src/admin/api/health.js`**, **`src/admin/api/collections.js`** — route
  registration functions taking `(router, adapter)`; every handler calls
  only `StorageAdapter` methods (`ping`, `capabilities`, `name`,
  `listCollections`, `getCollection`, `ensureCollectionSchema`). No file
  under `src/admin/` imports `src/core/qdrant/store.js`,
  `src/core/qdrant/client.js`, or `@qdrant/js-client-rest` — enforced by a
  static-scan test (see below), not just by convention.
- **`src/admin/server.js`** — `createApp({ adapter })` builds the
  `node:http` server and wires routes (adapter is injectable for tests);
  `resolveHostConfig`/`resolvePortConfig` are pure functions over an env
  object (testable without touching `process.env`); the `isMainModule`
  check (`import.meta.url` vs `pathToFileURL(process.argv[1])`) means
  `createApp`/`resolveHostConfig`/`resolvePortConfig` can be imported by
  tests without starting a listener as a side effect.

## Test results

```
npm test
  ℹ tests 227
  ℹ suites 62
  ℹ pass 227
  ℹ fail 0

npm run smoke
  Smoke tests: 1293 passed, 0 failed

node --check src/admin/server.js   OK

git diff --check                   clean
```

New test files (34 new tests total: 9 + 20 + 5):
- `tests/unit/admin/router.test.js` (9 tests) — GET dispatch, `:param`
  extraction + URL-decoding, query-string parsing, segment-count mismatch,
  unknown-route 404, known-path-wrong-method 404 (same code path as
  unknown-route, verifying the "keep consistent" requirement),
  `HttpError` → response translation, unexpected-error → 500, async
  handler rejection handling.
- `tests/unit/admin/server.test.js` (20 tests) — end-to-end over a real
  `node:http` server on an OS-assigned loopback port, using a stub
  adapter: health (ok/degraded), capabilities, collection list, collection
  detail (found/not-found/URL-decoded name), sync-schema
  (success/missing-collection — asserting `ensureCollectionSchema` is
  **not** called when the existence check fails), unknown route, known
  path with unsupported method, `resolveHostConfig`/`resolvePortConfig`
  edge cases (default host/port, loopback variants, non-loopback
  rejection, `ADMIN_ALLOW_REMOTE=1` override, invalid/out-of-range port),
  and a static layering test scanning every file under `src/admin/` for a
  forbidden import (`core/qdrant/store.js`, `core/qdrant/client.js`,
  `@qdrant/js-client-rest`) — fails loudly if a future edit reaches past
  the adapter boundary.
- `tests/unit/core/storage/factory.test.js` (5 tests) — default backend,
  explicit backend option, `SEMIDEX_STORAGE_BACKEND` env fallback, unknown
  backend error message, and that the constructed adapter passes
  `validateStorageAdapter`.

No live Qdrant required anywhere — the server tests use a stub adapter, and
`resolveHostConfig`/`resolvePortConfig` are pure env-object functions.

## Open risks / next steps

- **`GET /api/health` is a strict subset of the design doc's
  `HealthReport`.** Wiring `doctor-checks.js` in (Ollama/ONNX/env checks,
  per-collection status) is the natural next increment — noted above, not
  a blocker for this slice.
- **No request logging/access log.** Fine for a local dev tool used via
  curl/browser devtools; would want at least a request-id + status-code
  line before this becomes a longer-running background process.
- **`readJsonBody` is unused by any current route.** Kept because
  `POST /api/collections` (create, with a `{ name, vectorSize? }` body) is
  an explicit near-term addition per the design doc's endpoint table; if it
  turns out to sit unused for a while, delete it rather than let it rot.
- **No automated test starts the process via `npm run admin` / a child
  process** — `createApp()` is exercised directly in-process instead. This
  is deliberate (faster, no port-collision flakiness in CI) but means the
  `isMainModule` startup branch (`server.listen(...)` with the real
  `console.log` line) is untested. Low risk: it's four lines with no
  branching logic beyond what `resolveHostConfig`/`resolvePortConfig`
  already cover individually.
- **`sync-schema`'s existence check costs one extra `getCollection()` call**
  (which itself does a `getCollectionInfo` + sample-point scroll +
  skeleton-root check) before running `ensureCollectionSchema`. Acceptable
  for an admin action a human triggers occasionally; would reconsider if
  this endpoint were called in a hot loop.
