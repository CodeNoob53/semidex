# Phase 5 — Automated Semidex Lite settings-policy completeness

Implementation report for Phase 5 of
[`full-lite-shared-architecture-audit-2026-08-01.md`](full-lite-shared-architecture-audit-2026-08-01.md)
(§9.2/§11's "Phase 5 — Split settings definitions physically OR add the
automated allow-list-completeness test from §9.2"). Per §9.2's own
recommendation, the test path was chosen — `core/settings/definitions.js`
was NOT physically split. The registry remains a single, shared, flat
`DEFINITIONS` object; only `core/settings/lite-policy.js` changed, from a
hand-maintained 19-key allow-list to an exhaustive, tested classification
of all 67 real keys.

Architectural guard only — no runtime behavior, API response shape, UI
content, settings persistence, environment precedence, hard pin, provider
selection, or package staging changed.

## 1. What changed

| Artifact | Before Phase 5 | After Phase 5 |
|---|---|---|
| `core/settings/lite-policy.js` | `LITE_SETTINGS_KEYS` — a hand-maintained array of 19 key names, no explicit statement about the other 47 (now 48) keys | `LITE_SETTINGS_POLICY` — an exhaustive object with one entry per `DEFINITIONS` key (67 total), each `{ status: 'exposed' }` or `{ status: 'excluded', reason }`. `LITE_SETTINGS_KEYS` is now `Object.freeze(Object.entries(LITE_SETTINGS_POLICY).filter(exposed).map(key))` — mechanically derived, not hand-maintained. `LITE_SETTINGS_KEY_SET`/`isLiteSettingsKey()` unchanged (built from the derived `LITE_SETTINGS_KEYS`, same as before). |
| `core/settings/service.lite.js` | Reads `LITE_SETTINGS_KEY_SET` | Unchanged — reads the same export, same shape, same values |
| New: `tests/unit/core/settings-lite-policy-completeness.test.js` | did not exist | 9 tests proving exhaustiveness/consistency against the real `DEFINITIONS` object |

`definitions.js` itself was not touched.

## 2. Classification rationale

All 48 excluded keys (67 total − 19 exposed) fall into 4 of the 5 reason
categories the task specified (`full_only` is declared for future use but
has no member today — no current `DEFINITIONS` key is Full-Semidex-only in
a way distinct from the other four reasons):

| Reason | Count | Examples |
|---|---|---|
| `local_runtime` | 11 | `ONNX_EXECUTION_PROVIDER`, `ONNXRUNTIME_NODE_PATH`, `OLLAMA_URL`, `GENERATION_DEVICE`, `RERANK_CE_DEVICE`, `RERANK_CE_CACHE_DIR`, `RERANK_CE_WARMUP`, `TAG_ONNX_THREADS`, `TAG_ONNX_ALLOW_DOWNLOAD`, `ONNX_BATCH_SIZE`, `ONNX_CUDA_STRICT` |
| `local_model` | 6 | `TAG_MODEL`, `TAG_ONNX_MODEL`, `CONTEXT_MODEL`, `EMBED_MODEL`, `DENSE_MODEL`, `RERANK_CE_MODEL` |
| `unsupported_backend` | 7 | `TAG_PROVIDER`, `TAG_GEN`, `RERANK_CE_ENABLED`, `RERANK_CE_INPUT`, `RERANK_CE_TOP_N`, `RERANK_CE_TIMEOUT_MS`, `RERANK_CE_BATCH_SIZE` |
| `advanced_tuning` | 24 | chunking tuning (`MAX_CHUNK_TOKENS`, `MIN_CHUNK_TOKENS`, `CHUNK_OVERLAP_TOKENS`, `OVERLAP_SENTENCES`, `LLM_BATCH_SIZE`, `SKELETON_SUMMARY`, `SKELETON_CARRYOVER_CHARS`, `SUMMARY_LANG`, `COMBINED_LLM`), rerank boost/penalty knobs (11 keys), `TOKEN_COUNT`, `QDRANT_CLOUD_TOKENIZER`, `QDRANT_CLOUD_DENSE_CONTEXT_WINDOW` |

The 19 exposed keys are unchanged from before Phase 5: `QDRANT_URL`,
`QDRANT_KEY`, `QDRANT_CLOUD_DENSE_MODEL`, `QDRANT_SPARSE_MODEL`,
`EMBEDDING_BACKEND`, `DENSE_PROVIDER`, `SPARSE_PROVIDER`, `VECTOR_SIZE`,
`SEMIDEX_GENERATION_BACKEND`, `ASK_MODEL`, `ASK_NUM_CTX`, `GEMINI_API_KEY`,
`CONTEXT_MODE`, `SEMIDEX_STORAGE_BACKEND`, `ADMIN_HOST`, `ADMIN_PORT`,
`ADMIN_ALLOW_REMOTE`, `HYBRID_PREFETCH_LIMIT`, `RRF_K`.

Verified programmatically before writing any code: the classification's
excluded set was diffed against `DEFINITIONS`-keys-minus-old-`LITE_SETTINGS_KEYS`
and found to match exactly (48/48, no gaps, no extras), and the derived
`LITE_SETTINGS_KEYS` was diffed against the original hand-maintained
19-key array and found to be an exact set match.

## 3. Test coverage

`tests/unit/core/settings-lite-policy-completeness.test.js` (9 tests),
all comparing real exported data structures (`Object.keys()`, `Set`
membership, array equality) — never source-regex inspection:

1. Every `DEFINITIONS` key appears in `LITE_SETTINGS_POLICY` exactly once (no missing, no duplicates).
2. The policy contains no stale keys absent from `DEFINITIONS`.
3. Every policy entry resolves to exactly one of `exposed`/`excluded`.
4. `LITE_SETTINGS_KEYS` exactly equals the keys classified `exposed`.
5. No key appears in both the exposed and excluded key lists.
6. Every excluded key carries a non-empty reason from `LITE_EXCLUSION_REASONS`.
7. The 9 task-specified critical cloud settings remain exposed (`QDRANT_URL`, `QDRANT_KEY`, `QDRANT_CLOUD_DENSE_MODEL`, `QDRANT_SPARSE_MODEL`, `SEMIDEX_GENERATION_BACKEND`, `ASK_MODEL`, `GEMINI_API_KEY`, `HYBRID_PREFETCH_LIMIT`, `RRF_K`).
8. The 5 task-specified representative local-only settings remain excluded (`ONNX_EXECUTION_PROVIDER`, `ONNXRUNTIME_NODE_PATH`, `OLLAMA_URL`, `RERANK_CE_MODEL`, `TAG_PROVIDER`).
9. Sanity check: the real `DEFINITIONS` import is non-trivial (>50 keys), confirming the test loaded real data, not an empty/stubbed module.
10. **(added after code review)** `LITE_SETTINGS_KEYS` preserves its exact original declaration order (`QDRANT_URL, QDRANT_KEY, ...` — a full 19-element array pin, not a set check).
11. **(added after code review)** `LITE_SETTINGS_POLICY` and every individual entry within it are frozen (4 tests: outer freeze, per-entry freeze, a mutation attempt on a `status` field throws, a mutation attempt on a `reason` field throws, and the derived exports stay consistent afterward).

Verified test 1 genuinely catches a regression: temporarily deleted the
`ADMIN_ALLOW_REMOTE: exposed()` line from `lite-policy.js`, confirmed it
failed with `DEFINITIONS key(s) with no LITE_SETTINGS_POLICY entry: ["ADMIN_ALLOW_REMOTE"]`,
then restored the line (confirmed via `git diff` that the restored file
matches the intended additive-only diff).

### Code review findings and fixes (two rounds)

**Round 1** found two real gaps, both fixed:

- **Order drift, mislabeled "byte-identical."** The first version derived
  `LITE_SETTINGS_KEYS` by filtering `Object.entries(LITE_SETTINGS_POLICY)`
  in policy-declaration order (which at the time followed `DEFINITIONS`'
  category grouping: chunking, tagging, generation, embeddings, retrieval,
  storage, system). The original hand-maintained array started
  `['QDRANT_URL', 'QDRANT_KEY', ...]`; the naive derivation started
  `['SEMIDEX_GENERATION_BACKEND', 'ASK_MODEL', ...]` — the same SET, a
  genuinely different ARRAY. No existing consumer assertion cared (all
  used `Array.includes()`/`Set` membership), so nothing caught it, but
  this report and the audit doc both claimed "byte-identical," which was
  false for order.
- **Shallow freeze.** `Object.freeze(LITE_SETTINGS_POLICY)` only prevents
  reassigning/adding/removing the OUTER object's own top-level keys; each
  `{ status, reason }` entry was a separate, distinct object and was not
  itself frozen — `LITE_SETTINGS_POLICY.QDRANT_URL.status` could be
  reassigned at runtime, which would silently diverge from
  `LITE_SETTINGS_KEYS`/`LITE_SETTINGS_KEY_SET` (both computed once, at
  module-load time, from the pre-mutation values) — a real split-brain
  risk between the policy and its own already-derived exports. Fixed by
  having the `exposed()`/`excluded()` helper functions return
  `Object.freeze()`d entries — this fix was correct as first implemented
  and was not revisited in round 2. Verified: temporarily reverted
  `exposed()`/`excluded()` to return unfrozen objects, confirmed all 4
  immutability tests failed, restored.

**Round 1's order fix, as first implemented, was itself flagged in round
2**: it introduced a second, separately-declared `LITE_EXPOSED_KEY_ORDER`
constant in `lite-policy.js` that pinned the exact original array, deriving
`LITE_SETTINGS_KEYS` from THAT constant instead of from
`LITE_SETTINGS_POLICY`'s own iteration order. This technically fixed the
order bug but reintroduced exactly the two-sources-of-truth problem this
whole phase exists to eliminate — `LITE_SETTINGS_POLICY.<key>.status` and
`LITE_EXPOSED_KEY_ORDER`'s membership could again silently disagree with
each other, with only a test (not the derivation itself) catching it after
the fact. **Final fix**: reordered `LITE_SETTINGS_POLICY`'s own
declaration — every `exposed()` entry now comes first, in the pinned
original order, followed by the `excluded()` entries (grouped by category
for readability, order not significant there) — and reverted
`LITE_SETTINGS_KEYS` to a real, single-source-of-truth derivation:
`Object.freeze(Object.entries(LITE_SETTINGS_POLICY).filter(([, e]) => e.status === 'exposed').map(([k]) => k))`.
`LITE_EXPOSED_KEY_ORDER` was removed entirely. The exact-order regression
test (item 10 above) is unchanged in what it asserts, and still passes —
verified by temporarily swapping two adjacent `exposed()` entries in the
policy declaration and confirming the test failed, then restoring.

## 4. Behavioral preservation evidence

- `LITE_SETTINGS_KEYS`'s value is byte-identical to its pre-Phase-5
  hand-maintained value, in the same order — confirmed programmatically
  (both a sorted-array set-equality check and, after the order-drift fix
  above, an exact unsorted array-equality check pinned as a test).
- `core/settings/service.lite.js` was not modified at all — it imports
  `LITE_SETTINGS_KEY_SET`, whose construction (`new Set(LITE_SETTINGS_KEYS)`)
  and resulting membership are unchanged.
- `tests/unit/core/settings-service-lite.test.js` (existing, unmodified)
  passes unchanged — it exercises `createLiteSettingsService()` end-to-end
  against a real `SettingsService` instance and a temp `settings.json`.
- `tests/unit/admin/lite-app.test.js` (existing, unmodified) — the
  `HYBRID_PREFETCH_LIMIT`/`RRF_K` regression test this doc's own §9.1
  references — passes unchanged.
- `tests/unit/core/settings/definitions.test.js` (existing, unmodified)
  passes unchanged — `definitions.js` itself was never touched.
- `packages/lite/build.mjs`: 118 files staged (unchanged count —
  `lite-policy.js` was already staged before this phase), closure
  validated clean.
- `tests/unit/lite/clean-install-acceptance.test.js` (real packed
  tarball): 6/6 pass.

## 5. Test/build results

Run sequentially (`--test-concurrency=1`), per the task's own requirement:

| Check | Result |
|---|---|
| `tests/unit/core/settings-service-lite.test.js` + `settings-lite-policy-completeness.test.js` + `settings/definitions.test.js` (required combo) | 60/60 pass |
| Broader `tests/unit/core/settings*.test.js` + `tests/unit/core/settings/**/*.test.js` | 129/129 pass |
| `npm test` (full suite) | 2639/2639 pass (2624 pre-Phase-5 baseline + 15 in `settings-lite-policy-completeness.test.js`: 9 from the initial version + 6 added in response to code review — order-pin + immutability) |
| `npm run smoke` | 1316/1316 pass (matches baseline) |
| `node packages/lite/build.mjs` | 118 files staged, closure validated clean |
| `node --check` on `lite-policy.js` and the new test file | both pass |
| `git diff --check` | clean (only expected LF/CRLF warnings) |
| `tests/unit/lite/clean-install-acceptance.test.js` (real packed tarball) | 6/6 pass |

## 6. Known limitations

- `QDRANT_CLOUD_TOKENIZER` and `QDRANT_CLOUD_DENSE_CONTEXT_WINDOW` are
  cloud-native, read-only display rows (derived entirely from the selected
  `QDRANT_CLOUD_DENSE_MODEL`) with no local-runtime or local-model
  coupling at all — a reasonable case FOR future Lite exposure. They are
  classified `excluded` (reason `advanced_tuning`) in this phase purely to
  match the real, tested, pre-Phase-5 `LITE_SETTINGS_KEYS` contents
  exactly, since this phase is an architectural guard, not a scope
  expansion. Expanding Lite's Settings API to include them is a real,
  additive, low-risk candidate for a future task, not a defect of this
  phase.
- The `reason` field on excluded entries is documentation/test metadata
  only — `service.lite.js` never reads it, and no UI currently surfaces
  it. A future task could use it to auto-generate a "why is this hidden in
  Lite" tooltip, but that is out of this phase's scope.
- `full_only` (one of the 5 required reason categories) has zero members
  today — every currently-excluded key fits one of the other four reasons
  more precisely. The category is declared and available for a future key
  that is genuinely Full-Semidex-only in a way distinct from local-runtime/
  local-model/unsupported-backend/advanced-tuning.
- Phase 6 (Admin UI `entries/{full,lite}.js` + `partials/{shared,full,lite}/`
  restructure, §8.2 of the audit) remains fully separate, unstarted work.

## 7. Recommendation for Phase 6

Phases 3, 4, and 5 are now all complete. Phase 6 (Admin UI entry-point and
partials restructuring) is the next item in the audit's own §11 ordering
and was explicitly out of scope for this phase — it touches build output
shape (Vite entries), not source organization, and should be scoped and
verified as its own task per the audit's own risk assessment for that
phase (moderate risk — the first phase to change bundle structure).

Not all Full/Lite architecture work is complete. Phase 6 remains separate
and unstarted.
