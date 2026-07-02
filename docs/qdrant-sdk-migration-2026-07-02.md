# Qdrant SDK Migration Report — 2026-07-02

Migration of the semidex Qdrant layer from a hand-written REST wrapper to the
official `@qdrant/js-client-rest` SDK (v1.18.0), restructured as a clean
adapter — the foundation layer for semidex lite.

## Summary

- Dependency added: `@qdrant/js-client-rest@^1.18.0` (REST, not gRPC).
- The Qdrant layer now lives in `src/core/qdrant/` as a small adapter:
  - `client.js` — lazy SDK client creation, env handling, cache +
    `resetQdrantClientCache()` for tests, error normalisation;
  - `store.js` — all network operations (nothing outside the adapter calls
    the SDK directly);
  - `payload.js` — pure payload helpers (`isSemidexPayload`, field constants);
    no dotenv, no SDK import, importable with zero configuration;
  - `schema.js` — canonical vector schema + `REQUIRED_PAYLOAD_INDEXES`,
    now the **single source of truth** (previously the index list was
    duplicated between `createCollection` and `sync.js`);
  - `index.js` — adapter public surface.
- `src/core/qdrant.js` is a stable facade (`export * from './qdrant/index.js'`),
  so **all existing imports keep working unchanged**. All 27 public exports
  preserved with identical names, signatures, and return shapes, plus
  `getQdrantClient()` and `resetQdrantClientCache()`.
- No import-time side effects: no env validation, no client construction, no
  network probes at import. Even `RRF_K` / `HYBRID_PREFETCH_LIMIT` are now
  read per call instead of at module load.
- `QDRANT_URL`/`QDRANT_KEY` are read lazily at the first network call and
  re-read when env changes (client cache keyed by url+apiKey).
- CI (`.github/workflows/smoke.yml`) runs `npm test` + `npm run smoke` with no
  Qdrant and no dummy `QDRANT_URL` (none was ever added, none needed now).

## REST call → SDK method mapping

| Old hand-written call | SDK replacement |
|---|---|
| `GET /collections` | `client.getCollections()` |
| `GET /collections/{name}` | `client.getCollection(name)` |
| `PUT /collections/{name}` (create) | `client.createCollection(name, {...})` |
| `PATCH /collections/{name}` (sparse add) | `client.updateCollection(name, { sparse_vectors })` |
| `PUT /collections/{name}/index` | `client.createPayloadIndex(name, { field_name, field_schema })` |
| `PUT /collections/{name}/points` | `client.upsert(name, { points, wait: false })` |
| `POST /points/payload` | `client.setPayload(name, { payload, points, wait: false })` |
| `POST /points/search` | `client.search(name, { vector, limit, filter, with_payload })` |
| `POST /points/query` (hybrid RRF) | `client.query(name, { prefetch, query: { rrf: { k } }, ... })` |
| `POST /points/query` (MMR) | `client.query(name, { query: { nearest, mmr }, using: 'dense', ... })` |
| `POST /points/scroll` | `client.scroll(name, { filter, limit, with_payload, with_vector, offset })` |
| `POST /points/delete` | `client.delete(name, { filter })` |

Unchanged on purpose: `src/doctor.js` still uses its own raw `fetch` — it is a
read-only diagnostic that deliberately probes Qdrant at HTTP level and stayed
out of scope.

## Behavior differences (all deliberate, none silent)

1. **Timeouts.** Old wrapper: 30 s reads / 60 s writes via `AbortSignal`.
   The SDK supports one timeout per client instance, so the module caches two
   clients — read (30 s) and write (60 s). Effective behavior unchanged.
   On timeout the SDK throws `QdrantClientTimeoutError` instead of the raw
   `TimeoutError`; messages are still wrapped in the old `Qdrant <op> failed:`
   prefixes, so troubleshooting docs remain valid.
2. **`wait` on writes.** SDK defaults `wait: true` for upsert/setPayload; the
   old wrapper used Qdrant's REST default (`false`). We pass `wait: false`
   explicitly to preserve current indexing throughput characteristics.
3. **Port semantics preserved.** `new QdrantClient({url})` defaults to port
   6333 when the URL has no explicit port, which would break https URLs that
   previously worked via fetch's protocol default (443). We compute the port
   from the URL (explicit port, else protocol default) and pass it explicitly.
   Documented in configuration.md.
4. **`checkCompatibility: false`.** The SDK's version handshake fires a network
   request at client construction and `console.warn`s when Qdrant is
   unreachable — unacceptable for offline imports/tests. Disabled; version
   diagnostics remain doctor's job.
5. **`with_vector` fix.** The old `hasSparseVectors`/`scrollAllPoints` sent a
   `with_vectors` body field, which is not part of the Qdrant scroll API
   (correct name: `with_vector`) and was silently ignored. The SDK uses the
   correct parameter. `hasSparseVectors` now also reads both `point.vector`
   (current REST shape) and legacy `point.vectors`. This makes the sparse
   check strictly more correct; behavior on error is unchanged
   (returns `false`, never throws).
6. **Error text.** Prefixes are preserved (`Qdrant search failed (col): ...`,
   `Create index failed: ...` etc.). The detail after the prefix now comes
   from the SDK's `ApiError` (message + JSON of Qdrant's error body) instead
   of raw response text. The `Wrong sparse vector name` dense-only fallback in
   `hybridSearch` still works — detection is substring-based over the
   flattened error text.
7. **RRF `k` passthrough.** `query: { rrf: { k: RRF_K } }` (configurable-k RRF)
   is passed through the SDK's `query()` verbatim. The SDK does not validate
   bodies at runtime, so this works, but it is ahead of the SDK's typings.

## Tests run

| Check | Result |
|---|---|
| `npm test` (unit, incl. `qdrant-lazy.test.js` + `qdrant-adapter.test.js`) | 135/135 pass |
| `npm run smoke` with `.env` present | 1293 pass, 0 fail |
| `npm run smoke` with `QDRANT_URL`/`QDRANT_KEY` unset and no `.env` in cwd | 1293 pass, 0 fail |
| Old vs new `qdrant.js` smoke equivalence (same sandbox, same run conditions) | identical: 1293/1293 |
| `node --check` on all entry points (indexer, mcp server, sync, doctor) | pass |
| Import `src/mcp/tools/search.js` without `QDRANT_URL` | no throw |
| `git diff --check` on migrated files | clean |

New tests (`tests/unit/core/qdrant-lazy.test.js`): import without env; pure
`isSemidexPayload` without env; missing-env error on network call and on
`getQdrantClient()`; client caching (same env → same instance, read ≠ write
instance, url/key change → rebuild). No live Qdrant tests were added; live
verification remains behind the existing `smoke:*-live` commands.

## semidex lite readiness

This adapter is the foundation semidex lite builds on. What it enables:

- **Native collection management.** Collection create/update/index operations
  are SDK calls against `schema.js` constants — semidex lite can manage
  collections without any custom HTTP code.
- **Aliases and snapshots.** `client.getQdrantClient()` exposes the full SDK
  surface (`createAlias`, `createSnapshot`, …). Track E (safe reindex via
  aliases, snapshots before destructive operations) is now a store.js feature
  addition, not an HTTP-layer project.
- **Richer query APIs.** New Qdrant Query API capabilities land in the SDK;
  adopting them means editing one function in `store.js`, with the RRF/MMR
  patterns already established.
- **Local/cloud switching.** URL/key are read lazily and the client handles
  ports/TLS/keys uniformly — the same code path serves local Docker Qdrant
  and Qdrant Cloud, which simplifies a public demo deployment.
- **Centralized policy.** MCP tools, indexer, sync, and benchmarks all go
  through the adapter, so lite-specific decisions (e.g. reduced payload sets,
  stricter timeouts) are one-file changes.
- **Less custom transport code.** ~90 lines of hand-written fetch/URL/header
  logic deleted; error normalisation is one small helper over SDK errors.

Not implemented here (by design): aliases, snapshots, global search, lite
product mode, query redesign. The point of this task is that each of those is
now an isolated, small next step.

## Recommended follow-up (not in this task)

- One manual live run against a real Qdrant (`npm run smoke:retrieval-live`)
  to confirm hybrid RRF and scroll behavior end-to-end on real data.
- Track E items (aliases, snapshots, health checks) can now be implemented
  directly on `getQdrantClient()`.
