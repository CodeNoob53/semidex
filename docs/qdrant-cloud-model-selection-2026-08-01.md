# Semidex Lite — selectable Qdrant Cloud Inference models

Implementation report. Date: 2026-08-01.

## 1. Confirmed catalog (live-probed, not from static docs)

Full evidence, exact error strings, and methodology:
[`docs/design/qdrant-cloud-inference-model-research-2026-08-01.md`](design/qdrant-cloud-inference-model-research-2026-08-01.md).

| Model ID | Lane | Dimensions | Context window | Tier | Live result |
|---|---|---|---|---|---|
| `intfloat/multilingual-e5-small` | dense | 384 | 512 tokens | free | ✅ works |
| `sentence-transformers/all-minilm-l6-v2` | dense | 384 | 256 tokens | free | ✅ works |
| `qdrant/bm25` | sparse | — | — | free | ✅ works |
| `mixedbread-ai/mxbai-embed-large-v1` | dense | 1024 | unconfirmed | dedicated | ❌ live 401 "not allowed in free tier" |
| `prithivida/Splade_PP_en_v1` | sparse | — | 128 (doc) / 24 (query) | dedicated | ❌ live 401 "not allowed in free tier" |
| `Qdrant/Splade_PP_en_v1` (alt casing) | — | — | — | — | ❌ live 400 "Unsupported model" — confirms this ID variant is invalid, distinct failure shape from the tier-gate case |

The two rejection shapes (401 tier-gate vs. 400 unsupported-model) are
reliably distinguishable at the API level; this became the basis for the
`classifyInferenceProbeError()` 4-status availability classifier (§5).

## 2. Models implemented vs. excluded

**Implemented, selectable now** (`status: 'supported'` in the catalog):
- Dense: `intfloat/multilingual-e5-small`, `sentence-transformers/all-minilm-l6-v2`.
- Sparse: `qdrant/bm25`.

MiniLM was previously marked `unsupported` solely because its 256-token
context window is smaller than the indexer's default chunk budget
(`MAX_CHUNK_TOKENS=512`). This objection was stale: profile-aware
token-budget chunking (`resolveEmbeddingBudget()`,
`checkEmbedInputFits()`) already makes per-chunk splitting decisions
using the *selected model's own* context window, not a global constant.
Flipped to `supported`.

**Added to the catalog as `status: 'planned'`, never selectable**:
`mixedbread-ai/mxbai-embed-large-v1` (dense) and
`prithivida/Splade_PP_en_v1` (sparse). Both are real, live-verified model
IDs, both are dedicated/paid-cluster-only (confirmed via live 401).
Semidex does not yet detect per-cluster tier, so these cannot be safely
offered as a working choice — they exist in the catalog (visible as
"planned" in tests/data) but every model-options filter in the codebase
already gates on `status === 'supported'`, so no separate UI filter was
needed to keep them out of the selector.

**Explicitly out of scope, not touched**: CLIP/image models, ColBERT/
multi-vector models, Cohere/Jina/OpenAI/OpenRouter-via-Qdrant. None of
these appear anywhere in the catalog.

## 3. Settings precedence

Audited in depth before making any change. The task's hypothesized bug
("a Semidex default is shown as a locked/disabled field") does **not**
reproduce in the current codebase. `global-settings-view.js`'s `disabled`
state is driven only by `configuredSource === 'os_env' || 'dotenv'`;
`default`/`config_json` sources are never disabled by that check. Fields
that are always read-only (e.g. `QDRANT_SPARSE_MODEL` today, since only
one sparse model is really supported) are read-only by explicit
`writable: false` in `definitions.js`, by design, not by a precedence-engine
bug. No fix was needed here — this is a documented "verified non-issue,"
not a workaround.

What *did* need building: a declarative way to hide a field entirely
based on another field's staged value (the inverse of the existing
`visibleWhen`). Added `hiddenWhen: { key, equals }` to the settings
registry's field-visibility engine (`isFieldVisible()` in
`global-settings-view.js`, payload passthrough in `service.js`'s
`buildStoredEntry()`). `TOKEN_COUNT` now declares
`hiddenWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' }` — it
never renders for a cloud profile, where it has no effect. Also
generalized the existing `catalogDerived` read-only-row mechanism (used
before only for `VECTOR_SIZE`'s `.dimensions` lookup) to accept an
arbitrary `property`, and used it to add two new read-only rows,
`QDRANT_CLOUD_TOKENIZER` and `QDRANT_CLOUD_DENSE_CONTEXT_WINDOW`, that
show the selected dense model's real tokenizer identity and context
window automatically.

## 4. Availability semantics

Two independent layers, as required:

- **Static compatibility** (`isCatalogCompatibleWithChunking()`,
  `qdrant-cloud-models.js`): synchronous, no network, settings-time. Can
  only rule out hopeless combinations (e.g. a model's context window
  smaller than the configured chunk budget) — logs a warning, never a
  hard block, since real enforcement happens per-chunk at embed time.
- **Live availability** (`probeModelAvailability()`,
  `admin/system/qdrant-cloud.js`): a disposable-collection round-trip via
  the existing `probeInference()` machinery, cleaned up in a `finally`.
  Never touches user collections. Results are classified into exactly 4
  statuses by `classifyInferenceProbeError()`:
  - `available` — probe succeeded.
  - `unavailable_for_cluster` — matches the live-observed tier-gate error
    shape (`/not allowed in \w+ tier/i`).
  - `unsupported_by_semidex` — matches the live-observed "Unsupported
    model" shape (`/unsupported model/i`).
  - `unverified` — anything else (network/auth failure, unrecognized
    error shape) — never guessed as one of the two specific statuses.

  A real finding during this work: `store.js`'s own
  `probeInference()`'s pre-existing error pattern
  (`/inference|model.*(not found|unavailable|unknown)/i`) does **not**
  match the tier-gate message, so that failure mode is *rethrown* as a
  bare `Error`, not returned as a typed result. `classifyInferenceProbeError()`
  accepts either shape (`{result}` or `{error}`) to handle this.

  The probe is never run on every render — it's wired behind the
  existing "Test connection" button flow (`runQdrantCloudProbe()`), which
  now also renders a 4-status badge (`available`/`unavailable_for_cluster`/
  `unsupported_by_semidex`/`unverified`/"Not yet tested").

Secrets handling: `QDRANT_KEY` redaction (via the pre-existing
`sanitiseErrorMessage`) is verified at all three layers — the adapter
wrapper, the classifier, and the API route — with dedicated tests at
each layer.

## 5. Profile-aware tokenizer behavior (the live bug fix)

**Before**: `resolveTokenCountMode(env)` read only `process.env.TOKEN_COUNT`
(default `'bge-m3'`), with zero awareness of the active embedding
profile. Any Qdrant Cloud collection — regardless of its actual dense
model — reported `token count mode: bge-m3` and, if a counter were ever
actually invoked from that mode, would load the BGE-M3 tokenizer, which
is wrong for a cloud profile.

**After**: `resolveTokenCountMode(env, profile)` takes an optional
profile. If `profile.embedding.dense.execution === EXECUTION.QDRANT_CLOUD`,
it returns `` `qdrant-cloud:${profile.embedding.dense.model}` `` — a
model-scoped identity string — unconditionally, never consulting
`TOKEN_COUNT` at all. `getTokenCounter()` routes any mode with that
prefix through `loadQdrantCloudTokenizer()`/`qdrantCloudTokenCount()`
(the same tokenizer machinery already correctly used by the per-chunk
embed-fit check), never the BGE-M3 loader. A cloud profile can now never
load the BGE-M3 tokenizer — this is directly asserted by a spy-based
test.

**Live confirmation** (see §7): the E5 collection's stored chunk payloads
show `token_count_mode: "qdrant-cloud:intfloat/multilingual-e5-small"`;
the MiniLM collection's show
`"qdrant-cloud:sentence-transformers/all-minilm-l6-v2"` — distinct,
correct, model-scoped values, confirmed directly against real Qdrant
Cloud payloads, not just unit tests.

Skip/reindex tuple: since the stored `tokenCountMode` now encodes the
exact model, changing a collection's dense model correctly forces a
reindex (the stored value no longer matches). No silent char/4 fallback
exists for a cloud profile — `loadQdrantCloudTokenizer()` throws on a
genuine failure, which propagates as a real error.

## 6. Collection-creation safety

Two plan revisions were needed before landing on a race-free design (see
conversation history for the full adversarial review). The final design
uses **direct-causality cleanup only** — a function may attempt cleanup
of a resource only when it just observed, via its own preceding `await`
succeeding, that it created that resource. No `listCollections()`
pre-check is used anywhere (that pattern has an inherent TOCTOU race: a
concurrent process could create a same-named collection in the gap
between check and create).

- `store.js`'s `createCollection()`: if the base
  `client.api().createCollection(...)` call itself throws (including a
  conflict), nothing is cleaned up — nothing lasting was created. If the
  base call succeeds but a subsequent `createPayloadIndex()` call in the
  required-indexes loop throws, the function deletes the collection it
  just created, in an inner try/catch that never itself throws (a
  secondary cleanup failure is logged, never masks the original error),
  then rethrows the original error.
- `run.js`'s new `createNewCollectionWithConfigCache()`: handles the one
  remaining gap — `createCollectionFn()` (now self-cleaning per above)
  resolving successfully, then `loadConfigFn()`/`saveConfigFn()` throwing.
  Same rule: cleanup is attempted, a secondary cleanup failure never
  masks the original error, the original error always propagates.
- Pre-creation validation added to `run.js`'s `main()`, before any Qdrant
  call: source path existence (a bad path now throws before any
  collection is touched), dense-model catalog-supported check, and the
  coarse `isCatalogCompatibleWithChunking()` warning.

## 7. Live acceptance results (real dev Qdrant Cloud cluster)

Two disposable collections, indexed, searched, asked, then deleted. No
pre-existing collection was touched.

**E5** (`intfloat/multilingual-e5-small` dense + `qdrant/bm25` sparse):
- Collection created, 4 chunks indexed, 384-dimensional dense vectors
  confirmed via `getCollection()`.
- Stored `token_count_mode` on every chunk:
  `qdrant-cloud:intfloat/multilingual-e5-small` — confirms the tokenizer
  bug fix live, not just in tests.
- Hybrid search for "fixture codeword" returned the correct chunk as the
  top hit.
- Ask ("What is the fixture codeword?") returned `"The fixture codeword
  is \"zephyrquartz42\" [1]."`, citation `[1]` valid, evidence count 4,
  ~4.3s elapsed.
- Collection deleted; confirmed absent from `getCollections()` afterward.

**MiniLM** (`sentence-transformers/all-minilm-l6-v2` dense +
`qdrant/bm25` sparse):
- The new coarse-compatibility warning correctly fired at index time
  (`"sentence-transformers/all-minilm-l6-v2"'s context window (256
  tokens) is smaller than the configured chunk budget
  (MAX_CHUNK_TOKENS=400)"`), and indexing proceeded regardless — matching
  the documented "warn, never hard-block" policy (real enforcement is
  per-chunk at embed time).
- Collection created, 4 chunks indexed, 384-dimensional dense vectors
  confirmed.
- Stored `token_count_mode` on every chunk:
  `qdrant-cloud:sentence-transformers/all-minilm-l6-v2` — distinct from
  the E5 run, confirming model-scoping is real, not a hardcoded string.
- Hybrid search and Ask both succeeded identically to the E5 run (same
  correct answer, same citation).
- Collection deleted; confirmed absent afterward.

Dedicated-tier models (mxbai, SPLADE) were not force-probed against the
free-tier dev cluster expecting success — their `unavailable_for_cluster`
classification was already proven live during the research phase (§1)
and is treated as the correct, expected outcome, not an implementation
gap.

Local `config.json` cache also had 3 stale entries left over from
earlier ad hoc research-phase probing (`semidex-cloud-inference-accept-*`,
collections already deleted from the live cluster) — removed during this
cleanup pass. This file is gitignored/untracked, so this was a local
housekeeping step only, not a repo change.

## 8. Test counts

- `npm test`: **2547 / 2547** passing, 600 suites.
- `npm run smoke`: **1316 / 1316** passing.
- New dedicated test files: `tests/unit/core/qdrant-store-create-collection-cleanup.test.js` (4 tests),
  `tests/unit/indexer/create-new-collection-with-config-cache.test.js` (7 tests).
- Substantially extended: `tests/unit/core/token-count.test.js`,
  `tests/unit/admin/system/qdrant-cloud.test.js`,
  `tests/unit/admin/api/qdrant-cloud.test.js`,
  `tests/unit/admin/ui-global-settings-qdrant-cloud-panel.test.js`,
  `tests/unit/core/embedding-profile/qdrant-cloud-catalog.test.js`,
  `tests/unit/core/retrieval/search.test.js`,
  `tests/unit/indexer/embedding-profile-wiring.test.js`.
- 6 pre-existing tests across the repo encoded the old "MiniLM is
  unsupported" assumption as their example of a catalog-disabled model;
  each was fixed to use `mixedbread-ai/mxbai-embed-large-v1` instead
  (still a genuine negative-test case, since it remains `planned`).

## 9. Build/packaging verification

- `npm run admin:build` and `npm run admin:build:lite`: both succeed.
- Lite closure validator (`node packages/lite/build.mjs`): 116 files
  staged, closure validated clean.
- Lite clean-install acceptance
  (`tests/unit/lite/clean-install-acceptance.test.js`): 6/6 passing —
  confirms `onnxruntime-node`/`@huggingface/transformers`/`acorn` are
  excluded from the shipped tarball, the package runs from a read-only
  install directory, and no relative import escapes the package root.
- `npm audit`: findings (hono, protobufjs, sharp, qs, body-parser,
  fast-uri) are pre-existing transitive dependencies; `package.json`/
  `package-lock.json` were not touched by this task, so no new
  vulnerability was introduced. Not remediated here (out of scope: no
  dependency changes were part of this task).
- `git diff --check`: clean (only expected LF/CRLF line-ending notices
  on Windows).

## 10. Open limitations

- No per-cluster tier auto-detection. `mxbai-embed-large-v1` and
  `Splade_PP_en_v1` are correctly cataloged and correctly excluded from
  selection, but a user on a dedicated cluster that *does* support them
  has no way to unlock them short of a future task adding tier detection.
- The sparse-model selector remains a read-only single-value field
  (`QDRANT_SPARSE_MODEL`, `writable: false`) because exactly one sparse
  model is genuinely supported today. Per the task's own instruction,
  this auto-upgrades to a real writable selector the moment a second
  `status: 'supported'` sparse entry exists (`fieldRow()`'s dispatch
  already branches on `writable` before `derivedWhen`) — no further code
  change would be needed for that transition itself, only flipping
  `writable: true` and adding a real second supported entry.
- Coarse chunking-compatibility check reads `MAX_CHUNK_TOKENS` directly
  from `process.env` in `run.js` rather than through a shared accessor —
  matches `chunk.js`'s own default (512/400 depending on configuration)
  but is duplicated rather than centralized; low risk since it's
  warning-only, not enforcement.
