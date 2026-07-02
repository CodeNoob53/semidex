# Storage Adapter — Phase 0 report (2026-07-02)

Implements Phase 0 of `docs/design/admin-ui-and-storage-adapter.md` §13: the
storage adapter boundary, with no UI, no Local API, no server. Current
runtime behavior (indexer, MCP tools, sync) is unchanged — nothing was
rewired onto the adapter, per the design doc's explicit Phase-0 scope note.

## What was implemented

**`src/core/storage/capabilities.js`**
- `DEFAULT_CAPABILITIES` — frozen, all-`false` defaults exactly as specified.
- `mergeCapabilities(overrides)` — returns a fresh object; unknown keys are
  **ignored**, not rejected (documented in code and tests). Rationale: a
  StorageAdapter written against a capability set newer than the installed
  semidex version shouldn't crash callers on older builds.

**`src/core/storage/adapter.js`**
- `REQUIRED_ADAPTER_METHODS` — the 15-method Phase-0 interface from design
  doc §5.
- `validateStorageAdapter(adapter)` — checks required methods exist and are
  callable, and that `capabilities()` returns a plain object. Shallow by
  design — a shape check, not a type system. No Qdrant import.
- JSDoc `@typedef StorageAdapter` documents the full contract inline.

**`src/core/storage/qdrant-adapter.js`**
- `createQdrantStorageAdapter()` implements all 15 required methods —
  **no method throws "not implemented"**; every one has a minimal truthful
  implementation backed by existing `src/core/qdrant/store.js` calls.
- Domain mapping (`toChunk`, `toSourceDocument`, `toSkeletonNode`,
  `toStructuralNodeChunk`) converts Qdrant's snake_case payload shapes to the
  camelCase domain shapes from design doc §4. Exported as pure functions so
  tests assert on mapping without a live Qdrant instance.
- `translateSearchFilter({ sourceFile?, tags?, excludeNav? })` is the single
  place a semidex-level filter becomes a Qdrant filter object — the only
  Qdrant filter DSL construction site reachable from adapter inputs.
- `listCollections()` joins `store.listCollections()` with `config.json`
  provider metadata (`resolveConfigProvider`, same fallback chain as
  `mcp/tools/collections.js`'s `qdrant_collection_info`), returning
  `{ name, pointCount, vectorSchema, provider, description }` per design doc
  §6 ("store.listCollections() + config.js provider metadata, same join
  mcp/tools/collections.js does today"). Deliberately does **not** scroll a
  sample point per collection — that's `getCollection()`'s job — so the list
  view stays cheap for N collections.
- `getCollection(name)` composes `getCollectionInfo` + a 1-point sample
  scroll + `isSemidexPayload` + `classifyVectorSchema` + a skeleton-root
  check, matching the mapping table in design doc §6. Its `provider` comes
  from the sample point's payload (what's actually stored), not
  `config.json` — intentionally different from `listCollections()`, which
  answers "what does config.json say" cheaply; `getCollection()` answers
  "what do the indexed points actually carry."

**`src/core/qdrant/store.js`**
- Added `deleteCollection(name)` — one `client.deleteCollection()` SDK call
  through the existing `qdrantCall` error-normalization wrapper, matching
  every other store.js function's style. Exported through
  `src/core/qdrant/index.js` and the `src/core/qdrant.js` facade.

**`src/core/qdrant/ensure-schema.js`** (new)
- `ensureCollectionSchema(name, { collectionInfo?, deps? })` — the
  per-collection payload-index + sparse-vector repair loop extracted from
  `src/sync.js`. Uses `REQUIRED_PAYLOAD_INDEXES` from `schema.js` as its only
  source of truth for which indexes to create (no duplicated list).
  Returns `{ repaired: string[], warnings: string[] }`.
  - `options.collectionInfo` lets a caller that already fetched
    `getCollectionInfo()` (sync.js does, for its own config.json bookkeeping)
    avoid a redundant network round-trip.
  - `options.deps` injects the four store functions it calls
    (`getCollectionInfo`, `createPayloadIndex`, `addSparseVectorSupport`,
    `hasSparseVectors`), which is what makes it unit-testable offline without
    a Qdrant instance or module-mocking (Node's `node:test` `mock.module` is
    experimental-flag-gated in this Node version — DI was the simpler,
    stable choice).

**`src/sync.js`**
- Now imports `ensureCollectionSchema` and `classifyVectorSchema` instead of
  hand-rolling flat/named vector classification and the index/sparse-vector
  repair loop inline. Passes its already-fetched `getCollectionInfo()` result
  in to avoid a duplicate network call. The LEGACY/FOREIGN SCHEMA warning
  lines sync.js already prints (with the delete/reindex remediation steps)
  are kept as-is above the `ensureCollectionSchema` call; the function's own
  copies of those two warnings are filtered out of its `warnings` array
  before printing, to avoid double-printing the same message. All other
  actions (index creation console lines, sparse-vector-repair warning) are
  now driven by `ensureCollectionSchema`'s return value.

## What was deliberately not implemented

- Admin UI, Local API, job runner — out of scope for Phase 0 per the task.
- Qdrant aliases/snapshots — `store.js` has no alias/snapshot methods yet, so
  the adapter's `capabilities()` correctly reports `aliases: false,
  snapshots: false` (Phase 3 work).
- `upsertPoints` / `deleteBySourceFile` / `scrollAllPoints` on the adapter
  interface — the design doc explicitly excludes write primitives from the
  StorageAdapter surface (indexing stays a child-process concern until
  Phase 4).
- No adapter method fakes data or silently degrades; every Phase-0 method is
  a real, minimal, truthful implementation.

## Changed public exports

- `src/core/qdrant/store.js`: **added** `deleteCollection(name)`.
- `src/core/qdrant/index.js` / `src/core/qdrant.js`: now also re-export
  `ensureCollectionSchema` (from the new `ensure-schema.js`) and
  `deleteCollection` (transitively, via `store.js`).
- New modules, no prior exports changed: `src/core/storage/capabilities.js`,
  `src/core/storage/adapter.js`, `src/core/storage/qdrant-adapter.js`,
  `src/core/qdrant/ensure-schema.js`.
- `src/sync.js` has no exports (CLI script); its console output is
  equivalent in content, not byte-identical (see below).

## Sync behavior equivalence

Same actions, same order, same collection/index mutations:
1. Flat/foreign schema detection and warning (unchanged, still computed in
   sync.js from the same `getCollectionInfo()` call, now via
   `classifyVectorSchema` instead of inline `typeof` checks).
2. config.json add/backfill logic — untouched.
3. Payload index creation for all `REQUIRED_PAYLOAD_INDEXES` fields — now
   driven by `ensureCollectionSchema`, same fields, same order (object
   iteration order is preserved since it's the same underlying constant).
4. Sparse vector support attempt + sparse-points-present check — same calls,
   same fallback semantics (catch → not a failure).

The LEGACY/FOREIGN SCHEMA warnings are printed by sync.js itself (unchanged
wording, unchanged remediation steps) and `ensureCollectionSchema`'s own
copies of those two are filtered out of its `warnings` array before printing,
to avoid double-printing the same message.

For the sparse-vector-missing warning, sync.js intercepts
`ensureCollectionSchema`'s generic one-line warning (which has no notion of
`npm run index`) and re-prints its own original three-line CLI message in
its place, remediation command included:
`COLLECTION=${name} npm run index <path>` is **preserved**, not dropped —
see `src/sync.js` lines 92-101. `ensureCollectionSchema` itself stays generic
(no CLI-specific phrasing) so the storage adapter / a future Local API can
reuse it without CLI wording leaking into API responses. Net effect: console
output is byte-identical to before this change for every line that existed
before; no mutation, ordering, or detection logic changed.

## Test results

```
npm test
  ℹ tests 193
  ℹ suites 49
  ℹ pass 193
  ℹ fail 0

npm run smoke
  Smoke tests: 1293 passed, 0 failed

node --check src/core/storage/capabilities.js    OK
node --check src/core/storage/adapter.js         OK
node --check src/core/storage/qdrant-adapter.js  OK
node --check src/core/qdrant/store.js            OK
node --check src/sync.js                         OK
node --check src/core/qdrant/ensure-schema.js    OK

git diff --check                                 clean
```

New/changed test files (53 new tests total, plus the pre-existing suite):
- `tests/unit/core/storage/capabilities.test.js` — defaults immutability,
  merge behavior, unknown-key handling, no shared references.
- `tests/unit/core/storage/adapter.test.js` — validator success/failure paths
  (missing method, non-function method, bad `capabilities()` return shape).
- `tests/unit/core/storage/qdrant-adapter.test.js` — adapter shape via
  `validateStorageAdapter`, capability values match design doc §6 exactly,
  `translateSearchFilter` output shape (including that semidex-level keys
  never leak into the translated filter), domain-mapping fixtures proving
  camelCase-only output for `toChunk`/`toSourceDocument`/`toSkeletonNode`/
  `toStructuralNodeChunk`, a static layering check that no file under
  `src/core/storage/` imports from `src/mcp/`, `resolveConfigProvider`'s
  config/env fallback chain, and a source-level assertion that
  `listCollections()` actually performs the `provider`/`description` join
  (not just that the method exists).
- `tests/unit/core/ensure-schema.test.js` — named vs flat schema branches,
  index creation completeness/no-duplication, sparse-vector repair and
  already-present handling, warning generation, `collectionInfo` short
  circuit.
- `tests/unit/core/qdrant-adapter.test.js` (existing file) — extended the
  facade re-export list with `deleteCollection` and `ensureCollectionSchema`.
- `tests/unit/mcp/nav-filter.test.js` (existing file) — unchanged; still
  exercises `withNavExcluded`/`isNavPoint` through the
  `mcp/tools/filters.js` re-export shim, which now forwards to
  `src/core/qdrant/nav-filter.js`.

No live-Qdrant tests were added — `npm test` stays fully offline, matching
the existing `qdrant-lazy.test.js` / `qdrant-adapter.test.js` pattern
(deps injection and pure-function extraction instead of module mocking).

## Remaining risks

- **Network-backed adapter methods are shape-tested only, not behavior-tested
  against a live Qdrant.** `listCollections`, `getCollection`,
  `listSourceDocuments`, `getChunk`, `searchHybrid`, and the skeleton methods
  all call `store.js` functions that require `QDRANT_URL`; Phase 0 verifies
  they're present, callable, and that their *mapping* functions are correct,
  but not that the live call sequence behaves as expected end-to-end. This
  matches the design doc's Phase-0 exit gate (unit tests + fixtures, no live
  Qdrant) — a live-smoke tier for the adapter is a natural Phase 1 addition
  once the Local API exists to exercise it.
- **`getCollection`'s sample-point scroll is unfiltered** (`store.scroll(name,
  null, 1, true)`), so on a collection where the first point happens to be a
  `skeleton_nav` point, the returned `provider`/`versions` fields come from
  whichever point Qdrant returns first — nav or content — rather than
  deterministically from a content chunk. Nav payloads do carry
  `dense_provider`/`embedding_schema_version`/etc. (`buildNavPointPayload`
  spreads `ctx.embedMeta` in to satisfy the `isSemidexPayload` contract on
  nav points too), so this isn't a `null`-vs-data problem — the values should
  agree with a content point's in a healthy collection. But relying on that
  agreement rather than asking for it explicitly is fragile: a
  content-preferring sample fetch (skip points where `point_kind ===
  'skeleton_nav'`) would be a small, low-risk Phase 1 improvement.
- **`ensureCollectionSchema`'s DI (`options.deps`) is a Phase-0-pragmatic
  choice**, not a documented project-wide testing convention yet. If more
  store-backed functions need offline unit tests, worth deciding as a team
  whether DI-per-function or a shared mock-store helper is the long-term
  pattern (noted, not blocking).
