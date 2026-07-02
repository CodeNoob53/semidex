# Semidex Admin UI + Storage Adapter Foundation

> Status: design document, 2026-07-02. Nothing here is implemented yet.
> Scope: design + phased plan only. The next task can implement Phase 0/1
> directly from this document.

## 0. Framing

This is a **Semidex Admin UI**, not a Qdrant dashboard. The user manages
semidex concepts — collections, documents, indexing jobs, search, skeleton
maps, health. Qdrant is the first storage backend behind an adapter; its
specific features (snapshots, aliases) appear only as capability-gated panels.

The layering is strict:

```text
Semidex Admin UI (static, browser)
  -> Semidex Local API (HTTP, localhost)
    -> domain services (health, collections, jobs, retrieval)
      -> StorageAdapter interface
        -> QdrantStorageAdapter  (wraps src/core/qdrant/)
        -> future adapters
```

Two rules make the boundary real:

1. The UI never imports the Qdrant SDK, never sees Qdrant filter DSL, never
   builds Qdrant REST bodies. It speaks Local API JSON only.
2. The Local API never hardcodes backend behavior. Anything backend-specific
   flows through `StorageAdapter` + `StoreCapabilities`.

## 1. MVP product scope

The MVP answers four user questions without CLI knowledge:

1. **"Is my setup healthy?"** — health overview: Qdrant / Ollama / ONNX cache
   reachability, provider metadata per collection, common misconfiguration
   warnings (legacy schema, provider mismatch, missing models). Reuses
   existing `doctor-checks.js` logic — the checks already exist; the UI is a
   renderer for them.
2. **"What is indexed?"** — collections list and detail: point count, vector
   schema, provider metadata, schema/chunking/indexing versions, source file
   list, tag summary. Create collection (safe name only), delete behind an
   explicit typed confirmation, run sync.
3. **"Index this folder."** — pick path + collection + options
   (`ONNX_EMBED`, `SKELETON_CHUNKING`, `SKELETON_NAV`, `PRUNE_STALE`,
   `TAG_GEN`), watch live logs, get a final summary (files indexed/skipped,
   points written, errors, schema changes detected).
4. **"Does retrieval work?"** — search playground: query a collection, see
   ranked chunks (default `window=1`) with source file / section /
   chunk_index, open the skeleton map when the collection has nav nodes,
   open a raw structural node from a result or skeleton leaf.

## 2. Explicitly out of scope (MVP)

- Qdrant snapshots and aliases (Phase 3, capability-gated panels).
- Global/multi-collection search.
- Agent memory, assistant runtime, any answer generation.
- Non-Qdrant backends (the *interface* ships in Phase 0; no second
  implementation before Phase 4).
- Auth/multi-user/remote access — local, single user, localhost only.
- Editing documents or payloads from the UI.
- Collection migration/copy UX.
- Mobile layout, theming, i18n.
- Benchmark runners in the UI.
- Reranker configuration UI (env-only remains fine for an experimental flag).

## 3. Proposed folder/file structure

Zero new dependencies. Server: `node:http`. UI: static vanilla HTML/JS/CSS
served by the same server, no build step (matches the project's
minimal-dependency philosophy and keeps Windows-first support trivial).

```text
src/core/storage/
  adapter.js            - StorageAdapter interface contract (JSDoc typedef +
                          runtime shape validator for adapter implementations)
  capabilities.js       - StoreCapabilities definition + defaults
  qdrant-adapter.js     - QdrantStorageAdapter: implements the interface by
                          delegating to src/core/qdrant/ (store.js, schema.js)
src/admin/
  server.js             - HTTP entry point (npm run admin), binds 127.0.0.1
  router.js             - tiny method+path router (no framework)
  api/
    health.js           - GET /api/health, /api/capabilities
    collections.js      - collections CRUD + sync
    jobs.js             - indexing job start/list/status/logs (SSE)
    search.js           - search, chunk read
    skeleton.js         - skeleton root/node/children, structural node read
  jobs/
    registry.js         - in-memory job table
    indexing-job.js     - child-process wrapper around src/indexer/index.js
  ui/                   - static files served at /
    index.html
    app.js              - hash-router + fetch client + views
    app.css
docs/design/admin-ui-and-storage-adapter.md   - this document
```

Boundary note for Phase 0: the indexer, MCP tools, and sync **keep calling
`src/core/qdrant/` directly** — rewiring them through the adapter is not
required for the Admin UI and would bloat the phase. The adapter is the
mandatory path for the Local API from day one; migrating the other callers is
a later, mechanical step (see Phase 4).

## 4. Semidex domain model (adapter-agnostic)

These are the only shapes the Local API and UI know.

```js
// Collection
{
  name: string,
  pointCount: number,
  vectorSchema: { dense: { size, distance }, sparse: boolean },
  provider: { denseProvider, denseModel, sparseProvider },
  versions: { embeddingSchema, chunkingSchema, indexingSchema, tokenCountMode },
  description: string|null,
  semidexManaged: boolean,        // isSemidexPayload() sample check
  hasSkeleton: boolean,
  warnings: string[],             // e.g. "legacy flat vector schema"
}

// SourceDocument (aggregated from points)
{ sourceFile: string, chunkCount: number, firstSection: string|null, tags: string[] }

// Chunk (retrieval unit)
{
  sourceFile, chunkIndex, totalChunks, section,
  text, context, tags: string[],
  nodeType: string|null, nodeId: string|null, nodePath: string|null,
  score: number|null,             // present in search results
  isMatch: boolean|null,          // present in windowed results
}

// SkeletonNode
{
  nodeType: 'collection'|'directory'|'file'|'section',
  nodeId, nodePath, parentId,
  summary, headingPath, sourceFile,
  childCount: number, children: string[],   // node_paths
  inventory: object|null, keyTopics: string[]|null,
}

// IndexingJob
{
  id: string,                     // monotonic or uuid
  state: 'pending'|'running'|'succeeded'|'failed'|'cancelled',
  collection: string, path: string,
  options: { onnxEmbed, skeletonChunking, skeletonNav, pruneStale, tagGen },
  startedAt, finishedAt: string|null,
  summary: { filesIndexed, filesSkipped, pointsWritten, errors: [], warnings: [] } | null,
  exitCode: number|null,
}

// HealthReport
{
  qdrant:  { status: 'PASS'|'WARN'|'FAIL'|'SKIP', detail },
  ollama:  { status, detail, models: string[] },
  onnx:    { status, detail },     // model cache presence, execution provider
  env:     { status, detail },     // .env presence, required vars
  collections: [{ name, status, detail }],   // per-collection schema checks
}
```

`HealthReport` statuses reuse `STATUS` and check functions from
`src/core/doctor-checks.js` — the Admin UI must not fork health logic.

## 5. StorageAdapter interface draft

Semidex-level vocabulary only. No Qdrant filter DSL crosses this line —
filters are expressed as a small semidex query object and translated inside
the adapter.

```js
/**
 * @typedef {Object} StorageAdapter
 *
 * // identity & capabilities
 * name(): string                          // 'qdrant'
 * capabilities(): StoreCapabilities
 * ping(): Promise<{ ok: boolean, detail: string }>
 *
 * // collections
 * listCollections(): Promise<CollectionSummary[]>
 * getCollection(name): Promise<Collection|null>
 * createCollection(name, { vectorSize }): Promise<void>   // full semidex schema + indexes
 * deleteCollection(name): Promise<void>
 * ensureCollectionSchema(name): Promise<{ repaired: string[], warnings: string[] }> // sync
 *
 * // documents & chunks
 * listSourceDocuments(name, { prefix?, limit? }): Promise<SourceDocument[]>
 * getChunk(name, sourceFile, chunkIndex, { window? }): Promise<Chunk[]>
 *
 * // retrieval (query embedding happens ABOVE the adapter, in the retrieval
 * // service, because embedding is provider logic, not storage logic)
 * searchHybrid(name, { dense, sparse, limit, filter? }): Promise<Chunk[]>
 *   // filter: { sourceFile?, tags?, excludeNav?: true }  — semidex-level
 *
 * // skeleton navigation
 * getSkeletonRoot(name): Promise<SkeletonNode|null>
 * getSkeletonNode(name, { nodeId?, nodePath? }): Promise<SkeletonNode|null>
 * getSkeletonChildren(name, { nodeId?, nodePath?, limit? }): Promise<SkeletonNode[]>
 * getStructuralNode(name, { nodeId?, nodePath? }): Promise<Chunk|null>
 */
```

```js
// capabilities.js
export const DEFAULT_CAPABILITIES = {
  namedVectors:     false,
  sparseVectors:    false,
  hybridSearch:     false,
  payloadIndexes:   false,
  aliases:          false,
  snapshots:        false,
  collectionExists: false,
};
```

Deliberate omissions from the interface: `upsertPoints`, `deleteBySourceFile`,
`scrollAllPoints` — indexing writes stay inside the indexer process (spawned
by the job runner), so the Admin API surface never needs raw write primitives.
If Phase 4 migrates the indexer onto the adapter, write methods are added
then, with the indexer as the driving consumer.

## 6. QdrantStorageAdapter mapping

Thin translation layer over the existing SDK adapter — no new transport code.

| StorageAdapter method | Existing implementation used |
|---|---|
| `capabilities()` | static: all `true` except `aliases`/`snapshots` (`false` until Phase 3 lands them in `src/core/qdrant/store.js`) |
| `ping()` | `store.listCollections()` in try/catch |
| `listCollections()` | `store.listCollections()` + `config.js` provider metadata (same join `mcp/tools/collections.js` does today) |
| `getCollection(name)` | `store.getCollectionInfo()` + `store.getStoredMeta()` sample + `payload.isSemidexPayload()` + `doctor-checks.classifyVectorSchema()` |
| `createCollection` | `store.createCollection()` (already applies `schema.REQUIRED_PAYLOAD_INDEXES`) |
| `deleteCollection` | **missing in store.js today** — Phase 1 adds `store.deleteCollection()` via `client.deleteCollection()` (one SDK call; benchmarks currently hand-roll this) |
| `ensureCollectionSchema` | extract the per-collection loop from `src/sync.js` into a reusable function; sync.js and the adapter both call it (sync.js stays the CLI) |
| `listSourceDocuments` | `store.scrollAllPoints()` + `mcp/tools/listFiles.aggregateFiles()` |
| `getChunk` | `store.fetchWindowChunks()` |
| `searchHybrid` | `store.hybridSearch()`; semidex filter translated to Qdrant filter + `mcp/tools/filters.withNavExcluded()` |
| `getSkeletonRoot/Node/Children` | `store.getCollectionSkeletonNode()` / `getSkeletonNodeById/ByPath()` / `getSkeletonChildren()` |
| `getStructuralNode` | `store.getContentNodeById/ByPath()` |

Field mapping (snake_case payload → domain camelCase) lives in one place in
`qdrant-adapter.js`, so the API/UI never see payload internals.

## 7. Local API endpoint draft

All endpoints under `http://127.0.0.1:<port>/api` (default port 8642,
configurable via `ADMIN_PORT`). JSON in/out; errors as
`{ error: { message, code } }` with correct HTTP status.

| Method & path | Purpose |
|---|---|
| `GET  /api/health` | full `HealthReport` (doctor-checks based) |
| `GET  /api/capabilities` | active adapter name + `StoreCapabilities` |
| `GET  /api/collections` | `CollectionSummary[]` |
| `GET  /api/collections/:name` | full `Collection` detail |
| `GET  /api/collections/:name/documents?prefix=&limit=` | `SourceDocument[]` |
| `POST /api/collections` | `{ name, vectorSize? }` — create with full semidex schema |
| `DELETE /api/collections/:name` | body `{ confirm: "<name>" }` required; 400 otherwise |
| `POST /api/sync` | run schema ensure across collections; returns per-collection results |
| `POST /api/jobs/index` | `{ path, collection, options }` → `{ jobId }` |
| `GET  /api/jobs` | job list (newest first) |
| `GET  /api/jobs/:id` | `IndexingJob` |
| `GET  /api/jobs/:id/logs` | **SSE stream**: `log` events (stdout/stderr lines), final `done` event with summary |
| `POST /api/jobs/:id/cancel` | kill the child process (see §9) |
| `POST /api/search` | `{ collection, query, top?, window?, sourceFile?, tags? }` → `Chunk[]`. The retrieval service embeds the query via `core/embeddings.js` with the collection's provider, then picks the search mode from adapter capabilities: `hybridSearch && sparseVectors` → hybrid; otherwise dense-only (or whatever the adapter reports as supported). The response includes `searchMode` so the UI can show a degraded-mode badge. The API never assumes the Qdrant/BGE-M3 schema |
| `GET  /api/collections/:name/chunks?sourceFile=&chunkIndex=&window=` | window read |
| `GET  /api/collections/:name/skeleton` | skeleton root |
| `GET  /api/collections/:name/skeleton/node?nodeId=\|nodePath=` | one nav node |
| `GET  /api/collections/:name/skeleton/children?nodeId=\|nodePath=&limit=` | children |
| `GET  /api/collections/:name/node?nodeId=\|nodePath=` | structural content node |

Static UI served at `/` from `src/admin/ui/`. No other routes.

## 8. UI screens/components draft

Single-page vanilla JS, hash routing (`#/collections/...`). Capability gating
is one helper: `if (!caps.snapshots) hide(panel)`.

| Screen | Content |
|---|---|
| **Dashboard home** (`#/`) | health cards (Qdrant/Ollama/ONNX/env), collection count + total points, last indexing jobs, misconfiguration warnings |
| **Collections** (`#/collections`) | table: name, points, provider, schema status badge; "New collection", "Run sync" |
| **Collection detail** (`#/collections/:name`) | metadata panel (schema, provider, versions, warnings), documents list with prefix filter, buttons: index into this collection, open search playground, delete (typed confirmation modal: user must re-type the collection name) |
| **Indexing** (`#/index`) | form: path input, collection select/create, option toggles with one-line explanations mirroring docs (e.g. "SKELETON_CHUNKING — tables/code as structural nodes"), live log pane (SSE), final summary card |
| **Search playground** (`#/search`) | collection select, query input, top/window controls (defaults 5 / 1), result cards: score rank, source_file § section, chunk_index/total, context, text, tag chips, "open window", "open structural node" when node_path present |
| **Skeleton viewer** (`#/collections/:name/skeleton`) | tree drill-down (collection → directory → file → section) using summaries; leaf actions: "search in this file" (prefills playground), "open raw node" |
| **Settings/health** (`#/health`) | full doctor-style report with PASS/WARN/FAIL rows and remediation hints (reuse doctor's guidance strings); read-only env display with `QDRANT_KEY` redacted via `doctor-checks.redactKey` |

## 9. Indexing job model

- **Start:** `POST /api/jobs/index` validates the path exists and the
  collection name is non-empty, then spawns
  `node src/indexer/index.js <path>` with
  `env = { ...process.env, COLLECTION, ONNX_EMBED?, SKELETON_CHUNKING?, SKELETON_NAV?, PRUNE_STALE?, TAG_GEN? }`.
  Options are represented as a typed object in the API
  (`{ onnxEmbed: true }`), translated to env strings only at spawn time —
  the UI never composes env vars.
- **Why child process, not in-process import:** the indexer is a CLI with
  process-level state (profiler, concurrency pools, exit codes). A child
  process gives us isolation, natural log capture, cancellation, and zero
  refactoring of the indexer. In-process indexing is a later optimization,
  not a Phase 1 requirement.
- **Concurrency:** one running job per collection (registry rejects
  overlapping jobs on the same collection — matches the existing "do not run
  two indexers on one collection" operational rule); global default cap 1,
  configurable later.
- **Progress/logs:** stdout/stderr lines are buffered in a bounded ring
  (last ~2000 lines) and streamed over SSE. The indexer's existing console
  output IS the progress format for MVP — no indexer changes. A structured
  `--json-progress` flag is a candidate improvement, listed under risks, not
  a dependency of this design.
- **Summary:** parsed from the tail of the log (files indexed/skipped counts
  the indexer already prints) plus exit code. If parsing fails, the summary
  falls back to `{ exitCode }` and the raw log — never block on parsing.
- **Errors:** non-zero exit → `state: 'failed'`, last stderr lines surfaced
  in the UI card; preflight failures (Ollama unreachable, model missing) are
  therefore visible verbatim, which is exactly what doctor/preflight already
  prints.
- **Cancel:** MVP includes best-effort cancel (`child.kill()`; on Windows
  `taskkill /pid /t` fallback). Safe because the indexer commits per-file and
  deterministic point IDs make re-runs idempotent — a cancelled job leaves a
  resumable, not corrupted, collection. Documented in the UI as "safe to
  re-run".
- **Persistence:** in-memory registry only (MVP). Jobs vanish on server
  restart; the collection state itself is always recoverable from Qdrant.
- **Backend scope of indexing:** spawning the current CLI means Phase 1–3
  indexing works only for the current Qdrant-backed semidex path. A
  non-Qdrant adapter can list/search collections only after its own indexing
  path exists; indexing remains Qdrant/current-CLI until Phase 4. The
  StorageAdapter does **not** yet cover the full collection lifecycle — this
  is deliberate and must not be read as "any adapter is fully supported".

## 10. Security / local-only assumptions

- Server binds `127.0.0.1` only; refuses `0.0.0.0` unless
  `ADMIN_ALLOW_LAN=1` is set explicitly (documented as unsafe).
- No auth in MVP **because** of the localhost bind; if LAN exposure is ever
  enabled, a bearer token env (`ADMIN_TOKEN`) becomes mandatory — noted as a
  hard precondition, not implemented now.
- Local filesystem paths are user-controlled input by design (the user is
  indexing their own machine), but the API still normalizes paths and
  rejects obviously malformed input; it never echoes secrets.
- `QDRANT_KEY` is never returned by any endpoint; health/env views use the
  existing redaction helpers.
- Destructive actions: `DELETE /api/collections/:name` requires
  `{ confirm: "<name>" }`; the UI implements type-to-confirm. Sync and
  indexing are non-destructive by design (sync repairs, never drops;
  `PRUNE_STALE` stays a per-job opt-in with the full-root guard the indexer
  already enforces).
- CORS: same-origin only (UI is served by the same server); no CORS headers
  emitted.

## 11. How this supports semidex lite

- The **StorageAdapter interface is the semidex lite storage contract**: lite
  reuses it as-is; only the wiring (which adapter, which defaults) differs.
- The **Local API is the seed of the lite API**: health, collections, index,
  search are the same verbs a lite deployment needs; lite adds an
  answer/grounding endpoint on top rather than redesigning.
- The **UI becomes the lite/demo front end**: the search playground and
  skeleton viewer are the demo, once branding and a read-only mode are added.
- **Capability gating** is how lite stays portable: a lite install on a
  backend without sparse vectors degrades visibly (hybrid → dense) instead of
  breaking.
- The job runner's env-object → process-env translation is the first step
  away from "semidex is configured by memorizing env vars", which is the
  core lite usability goal.

## 12. Risks / tradeoffs

| Risk | Assessment / mitigation |
|---|---|
| Adapter interface ossifies too early | Interface is drafted from *actual current consumers* (MCP tools, sync, doctor), not speculation; Phase 4 explicitly budgets one breaking revision before a second backend lands |
| Log-parsing summaries are brittle | Fallback is always exit code + raw log; structured `--json-progress` in the indexer is the tracked improvement |
| Zero-dep HTTP server grows hair (routing, SSE, static files) | Scope is 17 endpoints + static dir; if it outgrows ~500 lines, adopting a micro-framework is a contained, later decision — the API contract doesn't change |
| UI without a framework becomes spaghetti | Hash-router + view-per-screen modules; the UI is deliberately CRUD-simple; a framework rewrite is cheap later because all state lives behind the API |
| "Qdrant dashboard" creep | Hard rule: any PR adding a Qdrant-specific UI element must gate it on a capability flag; review checklist item in the design |
| Two code paths read collections (MCP tools vs adapter) | Accepted for Phase 0–2 (documented above); Phase 4 unifies consumers onto the adapter |
| Windows process kill semantics | `child.kill()` first, `taskkill /t` fallback; cancellation is documented as best-effort |
| In-memory jobs lost on restart | Acceptable: collection state is recoverable; persistent job history is a later nicety |

## 13. Phased implementation plan

**Phase 0 — adapter boundary (no UI, no server)**
1. `src/core/storage/capabilities.js` + `adapter.js` (contract + validator).
2. `src/core/storage/qdrant-adapter.js` implementing §6, including the
   snake_case→domain mapping.
3. Extract sync's per-collection ensure loop into a reusable function
   (`ensureCollectionSchema`), re-used by `src/sync.js` (behavior unchanged).
4. Add `store.deleteCollection()` (one SDK call) with tests.
5. Unit tests: adapter shape validation, capability defaults, domain mapping
   fixtures (no live Qdrant).
   Exit gate: `npm test` + `npm run smoke` green; sync performs the same
   collection/index mutations with the same behavior — output may differ only
   in harmless formatting, and any such difference is documented.

**Phase 1 — Local API**
1. `src/admin/server.js` + router + health/collections/sync endpoints.
2. Job registry + indexing job runner + SSE logs + cancel.
3. Search endpoint (embeddings via existing `core/embeddings.js`).
4. Skeleton + node endpoints.
5. `npm run admin` script; unit tests for router, job registry, and API
   handlers with a stub adapter (proves the UI/API need no Qdrant).
   Exit gate: full API usable via curl against a live local Qdrant.

**Phase 2 — minimal UI**
1. Static shell, hash router, fetch client.
2. Screens in order of user value: health → collections → indexing (with SSE
   log pane) → search playground → skeleton viewer.
3. Type-to-confirm delete modal; capability gating helper.
   Exit gate: the four §1 workflows completable end-to-end by mouse only.

**Phase 3 — Qdrant capability panels**
1. Implement snapshots + aliases in `src/core/qdrant/store.js` (SDK calls),
   flip capability flags in the adapter.
2. Snapshot panel (create/list before destructive ops), alias panel (safe
   reindex flow), both rendered only when `caps.snapshots` / `caps.aliases`.
   Exit gate: deleting/reindexing a collection through the UI offers a
   snapshot first; UI on a hypothetical adapter without these caps shows no
   trace of the panels.

**Phase 4 — future backend support**
1. Migrate MCP tools / indexer reads onto the StorageAdapter (mechanical).
2. Build a second adapter as proof: an **in-memory adapter for tests** first
   (cheap, validates the interface), then evaluate one real backend against
   the parity checklist in the roadmap (Track: storage adapters).
3. One permitted breaking revision of the interface based on lessons.
   Exit gate: test-suite runs the API against the in-memory adapter; roadmap
   claim "backend-agnostic" becomes evidence-backed instead of aspirational.

## 14. Review checklist (apply to every Admin UI / adapter PR)

- [ ] No UI code imports from `src/core/qdrant/` (or any backend SDK).
- [ ] No Qdrant filter DSL, payload field names, or REST body shapes in
      Local API request/response contracts — semidex domain shapes only.
- [ ] Every Qdrant-only feature (snapshots, aliases, sparse-specific views)
      is gated on `StoreCapabilities`, never on `adapter.name() === 'qdrant'`.
- [ ] Search paths check capabilities and degrade explicitly (`searchMode`
      surfaced), never assume hybrid/sparse support.
- [ ] Destructive endpoints keep their explicit confirmation contract.
- [ ] New adapter methods are added to the interface contract + validator +
      in-memory test adapter in the same PR.
