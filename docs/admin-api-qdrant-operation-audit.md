# Admin API vs Native Qdrant Operation Audit

Date: 2026-07-03

Status: audit note. No runtime changes.

## Purpose

This audit separates three things that were starting to blur in the admin UI:

- native Qdrant capabilities;
- semidex domain workflows built on top of Qdrant;
- accidental wrappers that add behavior neither Qdrant nor semidex really needs.

The immediate trigger was the delete-collection flow. Qdrant's native API deletes
a collection with:

```http
DELETE /collections/:collection_name
```

The Qdrant API reference documents `collection_name` as a path parameter and
`timeout` as an optional query parameter; it does not require a JSON
`confirm` body. The previous semidex admin endpoint added a typed-confirmation
body as a local safety wrapper. That behavior is semidex-specific, not native
Qdrant.

Reference: https://api.qdrant.tech/api-reference/collections/delete-collection

## Current Boundary

The current layering is mostly sound:

```text
src/admin/api/*
  -> StorageAdapter domain methods
    -> src/core/storage/qdrant-adapter.js
      -> src/core/qdrant/store.js
        -> @qdrant/js-client-rest
```

Important rule: `src/admin/*` should not import the Qdrant SDK, Qdrant store,
or raw Qdrant DSL directly. Admin routes should speak semidex domain shapes.

## Operation Classification

| Endpoint / method | Native Qdrant equivalent | Semidex-added behavior | UI should expose as | Notes |
|---|---|---|---|---|
| `GET /api/health` / `adapter.ping()` | indirect `getCollections()` reachability check | Converts storage reachability into `{ ok, storage }` | Status indicator | Semidex domain health, not Qdrant telemetry. |
| `GET /api/capabilities` / `adapter.capabilities()` | none directly | Reports semidex adapter capabilities | Internal UI capability gate | Good abstraction for future non-Qdrant backends. |
| `GET /api/collections` / `adapter.listCollections()` | `getCollections()` plus per-collection `getCollection()` | Adds provider metadata from config/env and domain `Collection` shape | Collections list | Native list plus semidex normalization. |
| `GET /api/collections/:name` / `adapter.getCollection()` | `getCollection()` plus sample `scroll()` | Adds vector schema classification, provider/version fields, semidex-managed detection, skeleton presence, warnings | Collection overview/settings | This is a semidex collection summary, not raw Qdrant collection info. |
| `POST /api/collections/:name/sync-schema` / `adapter.ensureCollectionSchema()` | `getCollection()`, `createPayloadIndex()`, `updateCollection()` for sparse vectors | Repairs semidex-required payload indexes and sparse-vector compatibility; returns repaired/warnings | "Repair collection compatibility" or "Repair search indexes" | This is not file sync and not Qdrant-native "sync". Rename in UI. |
| `DELETE /api/collections/:name` / `adapter.deleteCollection()` | `deleteCollection(name)` | Should only map to domain response and 404 existence check | Delete collection | No typed-confirm body should exist. UI modal is enough; API should stay close to native semantics. |
| `POST /api/jobs/index` | none | Spawns semidex indexer with selected options | Index/reindex collection | Semidex indexing workflow, not storage API. |
| `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel` | none | Job registry and process control | Indexing jobs | Semidex local runtime workflow. |
| `GET /api/collections/:name/documents` / `adapter.listSourceDocuments()` | `scroll()` over payload fields | Groups points by `source_file`, excludes nav points, maps tags/counts | Source tree/sidebar data | Derived semidex read model, not native Qdrant document API. |
| `GET /api/collections/:name/chunks` / `adapter.getChunk()` | `scroll()` with source file and chunk range filter | Returns chunk window in domain shape | File/section content view | Derived semidex chunk reader. |
| `POST /api/search` / `adapter.searchHybrid()` | Qdrant Query API with dense+sparse prefetch and RRF | Embeds query above adapter, builds semidex filter, excludes nav, expands windows | Search this collection | Semidex retrieval workflow using native Qdrant search primitives. |
| `GET /api/collections/:name/skeleton` | `scroll()` skeleton nav points | Finds collection-level nav node | Collection map root | Semidex skeleton read model. |
| `GET /api/collections/:name/skeleton/node` | `scroll()` by `node_id` or `node_path` | Maps nav node payload to domain shape | Sidebar node details | Semidex skeleton read model. |
| `GET /api/collections/:name/skeleton/children` | `scroll()` by child node paths | Restores child order from skeleton payload | Sidebar tree expansion | Semidex skeleton read model. |
| `GET /api/collections/:name/node` | `scroll()` content node by `node_id` or `node_path` | Returns full structural content node in chunk-like domain shape | Full table/code display when known | Semidex structural-node reader, not general search fallback. |
| `store.createCollection()` | `createCollection()` | Immediately creates required semidex payload indexes | Internal/indexer or future UI | Native create plus semidex schema bootstrap. |
| `store.createPayloadIndex()` | `createPayloadIndex()` | Thin wrapper | Internal repair/bootstrap | Native Qdrant operation. |
| `store.addSparseVectorSupport()` | `updateCollection({ sparse_vectors })` | Named `sparse` vector convention | Internal repair/bootstrap | Native Qdrant operation with semidex naming convention. |
| `store.upsertPoints()` | `upsert()` | Forces `wait: false` to preserve old REST behavior | Indexer only | Native write with compatibility choice. |
| `store.updatePayload()` | `setPayload()` | Point id wrapper | Backfill/internal | Native Qdrant operation. |
| `store.deleteBySourceFile()` | `delete(points filter)` | Semidex source-file filter | Indexer prune/update | Semidex deletion workflow over native point delete. |
| `store.deleteTrailingChunks()` | `delete(points filter)` | Semidex chunk-index cleanup after file shrink | Indexer cleanup | Semidex-specific. |
| `store.hybridSearch()` | Qdrant Query API with prefetch + RRF | Dense+sparse convention, fallback to dense if sparse vector name missing | Retrieval backend | Native search primitives plus semidex conventions. |
| `store.mmrSearch()` | Qdrant Query API MMR | Thin wrapper | Not admin default | Native-ish, capability should remain explicit if exposed. |
| `store.scrollAllPoints()` | repeated `scroll()` | Pagination helper | Internal aggregation | Native operation wrapper. |

## Findings

### 1. Typed delete confirmation was an accidental wrapper

The typed-confirmation body was not native Qdrant behavior. It was added in
the semidex admin API as a safety guard. For the local dashboard this is a poor
UX tradeoff, especially with long collection names.

Recommended final state:

- UI uses a normal destructive modal: Cancel / Delete.
- API `DELETE /api/collections/:name` does not require a request body.
- Server still checks collection existence first and returns a clean 404.
- Report/docs remove all "type-to-confirm" language.

### 2. `sync schema` is semidex compatibility repair, not user-facing sync

The endpoint repairs semidex-required collection structure: payload indexes,
named vectors/sparse-vector support checks, and compatibility warnings.

It does not:

- scan files;
- reindex content;
- sync local folders;
- update summaries/tags/chunks.

Recommended UI label:

- `Repair collection compatibility`
- or `Repair search indexes`

Suggested tooltip:

> Checks and repairs semidex metadata, vector names, and payload indexes for
> this collection. It does not reindex files or update document content.

### 3. StorageAdapter boundary is the right direction

The admin API generally depends on `StorageAdapter`, not Qdrant SDK/store
directly. This is important for Semidex Lite and future non-Qdrant backends.

Keep this rule strict:

- UI never sees Qdrant filter DSL.
- Admin routes never import `@qdrant/js-client-rest`.
- Qdrant-specific capabilities are exposed through `capabilities()`.

### 4. Some native Qdrant capabilities are intentionally not exposed yet

Current Qdrant adapter capabilities mark:

```js
aliases: false,
snapshots: false
```

Qdrant supports aliases and snapshots, but semidex has not designed the
domain workflow for them yet. That is acceptable. When added, expose them as
capability-gated semidex workflows, not raw Qdrant dashboard clones.

### 5. Search is a semidex retrieval workflow, not a raw Qdrant search UI

`POST /api/search` embeds the query using semidex provider logic, then calls
adapter hybrid search. It also expands windows and excludes skeleton nav
points. This is correct: the dashboard should show search evidence, not a raw
Qdrant query console.

### 6. Skeleton and document endpoints are semidex read models

Documents, chunks, skeleton nodes, skeleton children, and structural nodes are
all derived from semidex payload conventions over Qdrant points. They should be
presented as collection navigation/content, not as Qdrant point browsing.

### 7. Encoding hygiene issue in comments

Several files currently contain mojibake in comments, for example `вЂ”` and
`В§`. This is not a runtime bug, but it is documentation/code hygiene debt.
Clean it when the active UI branch stabilizes, especially in files that define
architecture boundaries:

- `src/admin/server.js`
- `src/admin/api/*.js`
- `src/core/storage/*.js`
- `src/core/qdrant/*.js`

## Recommendations

1. Finish removing typed-confirm delete from UI, API tests, and reports.
2. Rename `sync schema` in user-facing UI to a repair/compatibility action.
3. Keep `StorageAdapter` as the only admin storage boundary.
4. Add capability-gated Qdrant-native workflows later: aliases, snapshots,
   shard/cluster data only if they have semidex user value.
5. Avoid exposing raw Qdrant internals in the default dashboard.
6. Treat every new admin endpoint as one of:
   - native Qdrant operation with semidex normalization;
   - semidex maintenance workflow;
   - semidex indexing workflow;
   - semidex derived read model.
7. If an endpoint adds a guard or ritual that Qdrant does not have, document
   why. If there is no strong reason, do not add it.

## Quick Review Checklist For Future Admin Work

- Is this endpoint native Qdrant, semidex workflow, or derived read model?
- Does the route name make that clear?
- Does UI terminology match the actual operation?
- Is the behavior present in Qdrant API, or did we invent it?
- If invented, is it essential?
- Can a future non-Qdrant backend implement the StorageAdapter method without
  pretending to be Qdrant?
- Is the default UI showing user concepts instead of backend implementation?

