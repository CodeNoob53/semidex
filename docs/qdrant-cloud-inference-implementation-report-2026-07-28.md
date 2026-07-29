# Qdrant Cloud Inference backend for Semidex Lite — implementation report

**Date:** 2026-07-28
**Verdict: ACCEPT**

This implements the first complete `execution: "qdrant-cloud"` vertical
slice: server-side dense and sparse embedding during indexing, server-side
query embedding, native Qdrant hybrid retrieval with top-level RRF,
embedding-model selection in Admin Settings, profile/schema compatibility
checks, and a live acceptance run against a disposable Qdrant Cloud
collection — the foundation of "Semidex Lite," a zero-local-model-download
deployment mode.

## Changed / new files

### New — core

- `src/core/embedding-profile/qdrant-cloud-models.js` — pure-data model
  catalog (zero dependencies: no fs/fetch/tokenizer), safe to bundle into
  the browser. `QDRANT_CLOUD_DENSE_MODELS`/`QDRANT_CLOUD_SPARSE_MODELS`,
  `findDenseModel`/`findSparseModel`/`isDenseModelSupported`,
  `isCatalogCompatibleWithChunking()` (coarse, settings-time check).
- `src/core/embedding-profile/qdrant-cloud-catalog.js` — server-only
  helpers that need the tokenizer: `checkEmbedInputFits()` (real,
  embed-time, tokenizer-backed check), `estimateEmbedInputFitsForUi()`
  (advisory heuristic, UI-only), `buildCloudQueryInputs()` (pure
  query-descriptor builder). Re-exports everything from
  `qdrant-cloud-models.js` for a single server-side import path.
- `src/core/embedding-profile/qdrant-cloud-tokenizer.js` — per-model
  tokenizer loader, mirrors `bge-tokenizer.js`'s exact shape
  (`@huggingface/tokenizers`, never `@huggingface/transformers`).
  Downloads/caches only `tokenizer.json`/`tokenizer_config.json`, never
  model weights.

### New — admin

- `src/admin/system/qdrant-cloud.js` — thin wrapper over
  `StorageAdapter.checkCloudInferenceReachable()`/`probeInference()`.
  Never imports the Qdrant SDK/client/store directly (enforced by
  `tests/unit/admin/server.test.js`'s layering test).
- `src/admin/api/qdrant-cloud.js` — `POST /api/system/qdrant-cloud-probe`
  route, wired into `src/admin/server.js`.

### New — live acceptance

- `benchmarks/spikes/qdrant-cloud-inference-accept.mjs` — live acceptance
  script (see below).

### Modified — core

- `src/core/embedding-profile/resolve.js` — `resolveNewCollectionProfile()`
  gains a `qdrant-cloud` branch, building the profile from the catalog
  (dimensions/distance/modifier), never probing anything live.
- `src/core/embedding-profile/availability.js` — new `LANE_STATUS` values
  (`CLOUD_UNREACHABLE`, `INFERENCE_UNVERIFIED`,
  `INFERENCE_DISABLED_OR_MODEL_UNAVAILABLE`); `resolveLaneAvailability()`
  gains a `qdrant-cloud` branch (Tier 1: catalog check + injected
  `checkQdrantReachable`, ceiling `INFERENCE_UNVERIFIED`, never
  `AVAILABLE`).
- `src/core/embeddings.js` — `embedForIndex()`/`embedForIndexBatch()` gain
  a top-level cloud branch (`embedForIndexCloud()`) that never reaches
  `_embed`/`loadOnnx`/`ollamaEmbed`; new `EmbeddingInputTooLongError`; new
  `setLocalEmbedOverrideForTest()` DI seam for behavioral proof.
  `embedForSearch()` is deliberately **unchanged** — it stays client-only;
  cloud query descriptors are built by `buildCloudQueryInputs()` instead.
- `src/core/retrieval/search.js` — `runHybridSearch()` branches on
  execution mode itself: CLIENT calls the injected `embedQuery` +
  `adapter.searchHybridVectors()`; QDRANT_CLOUD calls
  `buildCloudQueryInputs()` + `adapter.searchHybridInference()`.
- `src/core/storage/adapter.js` / `qdrant-adapter.js` — `searchHybrid`
  renamed to `searchHybridVectors`; new `searchHybridInference`,
  `checkCloudInferenceReachable`, `probeInference` (provider-neutral;
  returns `{status: 'unsupported'}` for a non-cloud profile).
  `buildQdrantVectorSchemaFromProfile()` needed **zero** changes — already
  execution-agnostic.
- `src/core/qdrant/store.js` — new `hybridSearchCloud()`,
  `checkQdrantReachable()`, `probeInference()` (the only place raw Qdrant
  Cloud Inference requests are built).
- `src/core/env.js` — `VALID_PROVIDER_COMBOS` gains
  `'qdrant-cloud:qdrant-cloud'`.
- `src/core/config.js` — `resolveEnvProviders()` gains a `qdrant-cloud`
  branch (dimensions from the catalog, no live probe).
- `src/core/settings/definitions.js` — `EMBEDDING_BACKEND` gains
  `'qdrant-cloud'`; new `QDRANT_CLOUD_DENSE_MODEL` (catalog-backed enum,
  MiniLM excluded from options entirely), `QDRANT_SPARSE_MODEL`
  (read-only); `VECTOR_SIZE` gains a `catalogDerived` data source;
  `DENSE_PROVIDER`/`SPARSE_PROVIDER` allow `qdrant-cloud`.
- `src/core/settings/service.js` — `EMBEDDING_BACKEND_EXPANSION` gains a
  `qdrant-cloud` entry; `buildStoredEntry()` forwards `catalogDerived` as a
  JSON-safe `{key, equals, modelKey}` triple (never the `lookup` function,
  which cannot survive serialization).
- `src/indexer/run.js` — stageC's vector-shape validation becomes
  execution-aware (object-shape check for cloud, array-shape for client);
  `main()`'s new-collection branch gains a catalog-derived `VECTOR_SIZE`
  path for `qdrant-cloud`.
- `src/mcp/tools/search.js` — `handle()` now routes through
  `runHybridSearch()` (the same shared path as Admin Search/Ask) instead
  of calling `embedForSearch`/`hybridSearch` directly, requesting its own
  rerank candidate pool via a larger `top`; new `chunkToLegacyPoint()`
  adapts `runHybridSearch`'s `Chunk` shape for `rerankResults()`/
  `ceRerank()`, which still expect raw Qdrant point shape.

### Modified — admin UI

- `src/admin/ui-src/global-settings-view.js` — `fieldRow()` gains a
  `catalogDerived` branch; new `qdrantCloudProbePanel()`/
  `wireQdrantCloudProbePanel()`/`runQdrantCloudProbe()` ("Test Cloud
  Inference" button, mirrors the existing ONNX probe panel exactly);
  `QDRANT_CLOUD_DENSE_MODEL`'s compatibility warning wired into the
  existing `markInvalid()`/save-bar mechanism.
- `src/admin/ui-src/partials/templates/global-settings.html` — new
  `tpl-gs-qdrant-cloud-probe-panel` template.

## API contract (confirmed against installed `@qdrant/js-client-rest`
1.18.0 types and live cluster behavior)

**Indexing** — a point's `vector` field for a cloud lane:
```js
vector: {
  dense:  { text: "...", model: "intfloat/multilingual-e5-small" },
  sparse: { text: "...", model: "qdrant/bm25" },  // no modifier/options — schema-only
}
```

**Retrieval** — one native Query API call:
```js
client.query(collection, {
  prefetch: [
    { query: { text, model: denseModel }, using: 'dense', limit },
    { query: { text, model: sparseModel }, using: 'sparse', limit },
  ],
  query: { rrf: { k } },
  limit,
  with_payload: true,
});
```
RRF fusion is always server-side — never computed in JavaScript anywhere
in this implementation.

## Test counts (all run individually with
`node --test --test-concurrency=1`, zero failures)

| File | Tests |
|---|---:|
| `tests/unit/core/embedding-profile/qdrant-cloud-catalog.test.js` (new) | 17 |
| `tests/unit/core/storage/qdrant-adapter.test.js` (extended) | 119 |
| `tests/unit/core/embeddings.test.js` (extended) | 17 |
| `tests/unit/core/qdrant-store-hybrid-search-cloud.test.js` (new) | 7 |
| `tests/unit/core/qdrant-store-probe-inference.test.js` (new) | 9 |
| `tests/unit/core/retrieval/search.test.js` (extended) | 17 |
| `tests/unit/mcp/search-embedding-profile.test.js` (extended) | 6 |
| `tests/unit/mcp/searchAnchors.test.js` (extended) | 10 |
| `tests/unit/core/embedding-profile/availability.test.js` (extended) | 39 |
| `tests/unit/admin/system/qdrant-cloud.test.js` (new) | 7 |
| `tests/unit/admin/api/qdrant-cloud.test.js` (new) | 8 |
| `tests/unit/admin/ui-global-settings-qdrant-cloud-panel.test.js` (new) | 15 |
| `tests/unit/core/embedding-profile/resolve.test.js` (extended) | 16 |
| `tests/unit/core/settings/definitions.test.js` (extended) | 33 |
| `tests/unit/core/settings/service.test.js` (extended) | 63 |
| `tests/unit/core/storage/adapter.test.js` (extended) | 10 |
| `tests/unit/core/embedding-profile/shared-resolution-path.test.js` (extended) | 3 |
| `tests/unit/indexer/embedding-profile-wiring.test.js` (extended, stale-regex fix) | 12 |

Plus a dozen other pre-existing files with mechanical `searchHybrid` →
`searchHybridVectors` mock renames (`tests/unit/admin/*.test.js`,
`tests/unit/core/ask/*.test.js`) — no behavioral change, all still pass.

**Full suite:** `npm test` — 2270 tests, 0 failures (current, after all
review-round fixes below — see the "Post-implementation review fixes"
section for what changed since the original per-file counts in the table
above were recorded).
**Smoke:** `npm run smoke` — 1310 passed, 0 failed.
**Build:** `npm run admin:build` — succeeds (226 modules, 283 KB bundle).
**`git diff --check`:** clean (only benign CRLF-normalization warnings).

## Live acceptance result: **ACCEPT**

Run: `node benchmarks/spikes/qdrant-cloud-inference-accept.mjs` against a
real Qdrant Cloud cluster (credentials from `.env`). All 11 steps passed:

1. Reachability/auth check before any collection was created.
2. Collection created via `resolveNewCollectionProfile()` +
   `adapter.createCollection()` — the real production path.
3. 4 of 5 fixture documents (English, Ukrainian, English, English) indexed
   through the real `embedForIndex()` path.
4. The 5th document (deliberately built with a realistic deep
   heading-path context, 558 real E5 tokens) was **rejected** by
   `checkEmbedInputFits()` with `code: EMBEDDING_INPUT_TOO_LONG` — proving
   the P1 fix (real tokenizer, not heuristic) works end to end against a
   real profile and a real cluster, not just mocked unit tests.
5. Points upserted with the full `{dense, sparse}` vector set in one call.
6. Both named vectors (`dense`, `sparse`) confirmed present via a raw
   scroll with `with_vector: true`.
7. A Ukrainian query (`"хмарний висновок для embedding векторів"`) run
   through the real `runHybridSearch()` path returned 3 hits,
   `searchMode: hybrid`.
8. Hits mapped to the standard `Chunk` shape (`toChunk()` output).
9. A throw-if-called sentinel installed on the local-embed DI seam never
   fired across indexing or search — confirming Cloud Inference was used,
   never local ONNX/Ollama.
10. `resolveExistingCollectionProfile()` round-tripped the canonical
    profile correctly afterward (dense model, sparse model, execution all
    matched what was written).
11. The Tier 2 `adapter.probeInference()` capability (the same one the
    Admin UI's "Test Cloud Inference" button calls) confirmed
    `inference_available` for the real model.

The disposable collection (`semidex-cloud-inference-accept-4c691b32`) was
deleted in a `finally` block; independently re-verified via
`listCollections()` afterward that zero stray disposable collections
remain on the cluster. No existing user collection was touched at any
point. Full step-by-step JSON report:
`benchmarks/results/2026-07-28-qdrant-cloud-inference-live-acceptance.json`
(redacted — no credential, raw cluster URL, or account-identifying data).

## Known limitations

- **No retry policy** in the SDK for Cloud Inference requests (confirmed
  by the prior research doc) — a transient inference failure surfaces as
  a normal error, not automatically retried.
- **No model-discovery API** — the catalog
  (`qdrant-cloud-models.js`) is hand-maintained and must be updated
  manually if Qdrant adds/renames supported models.
- **MiniLM is registered but disabled** — present in the catalog for
  documentation/error-message purposes, never offered as a selectable
  option, never usable for indexing.
- **This implementation was verified against only the ONE Qdrant Cloud
  account/cluster/region available during this task** (EU region,
  confirmed 2026-07-21 and re-confirmed live on 2026-07-28). Any
  cost/availability/region fact stated in the documentation is scoped to
  that account and date — never generalized into a platform-wide
  guarantee.
- **Not a retrieval-quality-equivalence claim.** `qdrant-cloud`'s E5-small
  (384d) is a smaller, different model than the local default BGE-M3
  (1024d). No benchmark comparing the two was run — explicitly out of
  scope per the task's own non-goals.
- **`qdrant-cluster` execution remains unimplemented** — a profile
  declaring it still reports `unsupported_backend`, exactly as before this
  task.

## Post-implementation review fixes (2026-07-28, same day)

A follow-up review of the shipped implementation found four real gaps,
none caught by the original test suite or the live acceptance run (which
indexed only short documents). All four are fixed, with regression tests
added; the live acceptance script's own fixture size happened to sit right
at the fix boundary and would have silently missed the P1 bug without this
review.

- **[P1] Typical-sized chunks could hard-fail indexing.** The real embed
  input is `context+text`, not `text` alone
  (`src/indexer/run.js:416-421`), but the cloud path's context-window
  check only ever rejected — it never reserved budget for `context`. A
  512-token chunk body plus a normal heading-path/skeleton-summary context
  (the common case at default settings) would exceed E5's 512-token window
  and abort indexing for that chunk, not just pathological oversized
  input. **Fix:** new `fitContextToBudget()`
  (`qdrant-cloud-catalog.js`) trims `context` — never the chunk body — via
  a real-tokenizer binary search when the full assembly doesn't fit, and
  `embedForIndexCloud()` retries once with the trimmed context before
  failing. A chunk whose body alone still doesn't fit (even with context
  emptied) still throws `EmbeddingInputTooLongError` — trimming can never
  rescue that case, and the body is never shortened. 7 new tests in
  `qdrant-cloud-catalog.test.js`, all using the real E5 tokenizer. Fixing
  this also surfaced and corrected a real contract bug: `run.js` passes
  the full pre-joined `context+text` string as `embedForIndexCloud`'s
  `text` parameter (matching every other caller's convention), but an
  earlier version of the fix assumed `text` was the chunk body alone —
  caught immediately by the new tests before it could ship.
- **[P2] A schema-valid profile could declare mismatched dense/sparse
  execution** (e.g. `dense: client` + `sparse: qdrant-cloud`), which every
  downstream runtime path (`runHybridSearch`, `buildCloudQueryInputs`)
  assumes can't happen, branching only on `dense.execution`.
  `resolveNewCollectionProfile()` itself can never construct this (gated
  by `assertProviderCombo`), but stored/legacy collection metadata could
  be hand-edited or corrupted into this shape and would previously pass
  shape validation as `'valid'`. **Fix:** `validateEmbeddingProfile()`
  (`schema.js`) now rejects any profile where `dense.execution !==
  sparse.execution`, closing the gap at the one shape-validation choke
  point every read/write path already goes through. 4 new tests in
  `schema.test.js`.
- **[P2] No token-limit check on the query side.** Indexing was checked
  exactly, but `buildCloudQueryInputs()` built query descriptors with no
  tokenizer gate at all — an over-long Ask/API query could be silently
  truncated by Qdrant itself. **Fix:** `runHybridSearch()`'s cloud branch
  now runs `checkEmbedInputFits()` against the query text before building
  any descriptor, returning a typed `embedding_failed` error (no retry —
  a query has no separate context to trim, and truncating user intent
  silently is exactly what this task forbids). 2 new tests in
  `search.test.js`.
- **[P2] The tokenizer cache could be corrupted permanently.** Any
  non-empty file at the cache path was treated as valid forever;  a
  process killed mid-download (or a network drop) could leave a truncated
  but non-empty file that would never be re-fetched. **Fix:**
  `downloadFile()` now writes to a temp file and atomically renames onto
  the final path only after a fully verified download — a reader can never
  observe a partial file at the real cache path. A cached file that still
  fails to parse (`readJsonOrEvict()`) is evicted and re-downloaded once
  before failing for real. Fixing this also surfaced a genuine dangling-
  file-handle bug on Windows (a write stream left open on a thrown
  read/write error caused an async ENOENT after the temp file's unlink
  raced the OS's own handle release) — fixed by awaiting the stream's
  `close` event before unlinking. 9 new tests in
  `qdrant-cloud-tokenizer.test.js`.

Regression tests were added for each of the four fixes above, in
`qdrant-cloud-catalog.test.js`, `schema.test.js`, `search.test.js`, and the
new `qdrant-cloud-tokenizer.test.js` (the per-fix counts above reflect what
each fix added at the time; these files have since grown further with
unrelated, later work in this same collection of sessions, so their
CURRENT total test counts no longer equal those per-fix additions — the
full-suite numbers below are the only ones re-verified as of this
revision). Full suite re-verified: `npm test` — 2270 tests, 0 failures;
`npm run smoke` — 1310 passed, 0 failed; `git diff --check` clean.

## Verdict

**ACCEPT.** The `qdrant-cloud` execution mode is fully implemented across
indexing, retrieval, availability, and Admin Settings, verified by 408
tests across the 18 new/extended files listed above (all passing
individually and in the full 2270-test suite) and a live 11-step
acceptance run against a real Qdrant Cloud cluster with a clean ACCEPT
verdict. No commits were made, per the task's explicit instruction.
