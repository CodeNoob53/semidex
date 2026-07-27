# Live Acceptance: Mandatory Skeleton Migration + Global Settings

**Date:** 2026-07-27
**Scope:** Live runtime validation of unconditional skeleton-first Markdown
indexing and the Global Settings surface, against a real Qdrant Cloud
cluster and the real Admin server/API. Unit, smoke, and build checks had
already passed before this run; this exercise validates actual runtime
behavior that those suites cannot observe directly.

## Environment (anonymized)

- Qdrant: real managed cloud cluster, reached via `QDRANT_URL`/`QDRANT_KEY`
  from the project's `.env` — neither value is reproduced anywhere in this
  report. Live `qdrant_collection_info()` calls throughout this session
  consistently showed **13 pre-existing production collections** (the
  authoritative, actually-queried count used for every before/after
  comparison in this report). `npm run doctor`'s own local `config.json`
  registry separately reported "68 collections" at session start — that
  number reflects `config.json`'s own bookkeeping (which can include
  stale/orphaned entries for collections no longer present in Qdrant) and
  was not used for any collection-count comparison in this report; the
  discrepancy is noted here only for accuracy, not because either number
  changed during this session.
- Ollama: local instance, initially not running; started for this session
  (`ollama serve`) to exercise the non-Markdown/legacy-chunker preflight
  and live Ollama model discovery. ~13 real local models available.
- Gemini: `GEMINI_API_KEY` present in `.env`; the real key was never
  printed, logged, or included in any request/response captured here.
- Admin server: real build (`npm run admin:build`) + real process
  (`npm run admin`, port 8642), driven via `curl` against the live HTTP
  API. **No browser automation tool (Playwright/Puppeteer/etc.) was
  available in this environment** — confirmed with the user before
  starting. All Settings checks in Part F are real API/runtime checks
  against the live server; nothing about visual rendering, layout, or
  in-browser interaction is claimed. Visual/browser acceptance is marked
  `MANUAL_UI_PENDING` per the task's explicit instruction not to substitute
  regex/CSS inspection for real browser verification.
- Node: v25.2.1. No production code was modified during this run — the one
  file changed was a fixture (see Part A finding below), which is deleted
  as part of cleanup.

## Owned temporary collections (all deleted at end of run)

- `semidex-live-accept-20260727011804-partA`
- `semidex-live-accept-20260727011804-partB` (original Part B run, invalidated by the P1 finding below — deleted before the correction)
- `semidex-live-accept-20260727021300-partB2` (corrected Part B re-run)
- `semidex-live-accept-20260727011804-partD-empty`
- `semidex-live-accept-20260727011804-partE-txt`

No existing user/production collection was created, modified, or deleted
at any point. Confirmed by snapshotting `qdrant_collection_info()`
before/after every destructive step in Parts C and D and diffing point
counts for all 13 pre-existing collections — all identical throughout,
including after the Part B correction.

---

## Part A — New Markdown collection

**Fixture:** `.tmp/live-acceptance/markdown-root/` — `README.md` +
`guides/getting-started/install.md` + `guides/advanced/tuning.md` (2
nested directories, 3 files, H1–H3, prose, 1 table, 1 code block, 1
checklist per file where applicable).

**Command:**
```
Remove-Item Env:SKELETON_CHUNKING, Env:SKELETON_NAV, Env:SKELETON_CONTEXT -ErrorAction SilentlyContinue
COLLECTION=semidex-live-accept-...-partA ONNX_EMBED=1 npm run index .tmp/live-acceptance/markdown-root
```
No retired env var was set at any point in this session.

### Finding and fix (fixture, not product)

The first indexing pass showed the `guides/advanced/tuning.md` code block
never became its own `code_block` retrieval point — its content was
silently folded into the preceding paragraph's raw text as a single-line
inline-code span, losing the fenced/multi-line formatting. Investigated
against actual stored Qdrant payloads (`qdrant.scroll` dump, not MCP
rendering) before concluding anything:

- `src/indexer/phases/skeleton.js` correctly emits every fenced code block
  as a `code_block` AST node — confirmed by reading the parser.
- `src/indexer/phases/node-policy.js`'s `isTinyCodeBlock()` implements a
  **documented, deliberate** threshold (`lines >= 2 && tokens >= 12`, or
  `tokens >= 16` for one-liners) that merges anything smaller into the
  surrounding prose stream (`merge_with_parent`), with a code comment
  explaining the corpus measurement behind the numbers.
- The fixture's original 4-line Python function was only **8
  whitespace-split tokens** — below the 12-token floor — so it was
  correctly classified as "tiny" and merged. This is the fixture being too
  small, not a chunker defect.

**Fix applied:** expanded the fixture's code block to 10 real lines / 29
tokens (still a small, realistic snippet) so it legitimately clears the
threshold and exercises the `code_block`-as-own-point path the task
requires. **No production code was changed.** Re-indexed after the fixture
fix (deleted and recreated the temp collection for a clean run).

### Verified (post-fix), against real stored Qdrant payloads and MCP tools

| Check | Result |
|---|---|
| Chunks use current skeleton metadata | 42/42 points: `chunking_model: "skeleton-v1"`, `indexing_schema_version: 4` |
| File/section/directory/collection nav points exist | 25 nav points: 1 collection, 3 directory, 3 file, 18 section |
| Content points have valid node identity | 17/17 `retrieval_content` points have non-null `node_id`; 0 missing |
| Table retains authoritative raw content | `qdrant_get_node` on the table node: `raw_available: true`, full markdown table preserved verbatim |
| Code block retains authoritative raw content | Same, post-fix: full fenced ` ```python ` block preserved, multi-line, `node_type: "code_block"` |
| Checklist retains authoritative raw content | `- [x]`/`- [ ]` checkbox state preserved verbatim |
| Collection root lists correct children | `qdrant_get_skeleton` → 1 file (README.md) + 1 directory (guides) at root; `guides` → 2 subdirectories, matching disk layout exactly |
| No retired env flag required | Confirmed — all three unset for the entire indexing run; skeleton chunking, nav generation, and deterministic context all fired unconditionally |
| `qdrant_get_skeleton` | Returns correct collection root and children |
| `qdrant_get_skeleton_children` | Correctly resolves directory → subdirectory → file → section chains |
| `qdrant_search` | Hybrid search returns real hits with correct `node_id`/`node_path`/`node_type` on the primary hit |
| `qdrant_get_content` (bounded assembly) | Reconstructs continuous prose with the table inline at its real position, token-bounded (135 tokens returned for a 1000-token budget request), no placeholders in output |

**Point count: 42 total (17 `retrieval_content` + 25 `skeleton_nav`).**

---

## Part B — Automatic migration from legacy metadata

**Correction (P1 review finding):** the first pass of this part was
methodologically invalid and has been fully re-run. The original seed
script wrote a deliberately-stale synthetic `file_hash` into the simulated
legacy point. `stageA`'s skip-tuple check
([run.js:129](../src/indexer/run.js#L129)) short-circuits on
`storedHash === fileHash` as its first condition, before ever reaching the
`chunkingModel`/`indexingSchemaVersion` comparison — so a stale hash alone
already guaranteed a reindex, and the run never actually proved the thing
Part B requires: that an **unchanged file** with **only** stale chunking
metadata migrates through the `chunkingModel`/`indexingSchemaVersion`
check specifically. Collection `semidex-live-accept-...-partB` from the
original run was already deleted during that pass's own cleanup; this
correction used a fresh collection
(`semidex-live-accept-20260727021300-partB2`), deleted at the end of this
correction's own cleanup.

**How the legacy state was constructed** (corrected methodology —
production code was never modified to recreate the old chunker):

1. Indexed `.tmp/live-acceptance/legacy-migration-root/notes.md` normally
   into `semidex-live-accept-20260727021300-partB2` (real skeleton-v1 run:
   2 content + 4 nav points, 6 total, hash-noted below).
2. Independently computed sha256 of the real fixture file on disk
   (`b868f04e8ff26cb0ca1fa04b5faab07ec7a3236a1871a6fb684a3ad545f566db`) and
   confirmed it matched the `file_hash` the indexer had just stored —
   before trusting that value for anything.
3. Ran a corrected one-off script (`seed-legacy-state.mjs`, deleted with
   the rest of the fixtures at cleanup) that:
   - Fetched the 2 real skeleton-v1 content points (real vectors, real
     text, real `file_hash`, real provider/schema metadata) via the Qdrant
     client directly.
   - Deleted **all 6** existing points (both nav and content) — a real
     legacy-indexed collection never had `skeleton_nav` points.
   - Re-inserted 2 points using the project's own real `makePointId()`
     (`src/core/point-id.js`, imported directly — not reimplemented, to
     avoid any risk of a wrong UUID namespace producing a false-positive
     "points were replaced" result) — the **legacy ID scheme**
     (`collection+sourceFile+chunkIndex+embeddingSchemaVersion`), distinct
     from the skeleton scheme's node-keyed IDs
     (`makeSkeletonPointId`/`collection+nodeId+embeddingSchemaVersion`).
   - Payload copied **every** discriminator field `getStoredMeta()` reads
     **verbatim** from the real just-indexed points — `file_hash`
     (the real, verified-matching hash, not a synthetic stale value this
     time), `dense_provider`, `dense_model`, `sparse_provider`,
     `embedding_schema_version`, `vector_size`, `chunking_schema_version`,
     `token_count_mode`, `source_file`, `chunk_index`, `text` — and
     **deliberately omitted only** `chunking_model`, `indexing_schema_version`,
     `point_kind`, `node_id`, `node_path`, `node_type`: exactly the fields
     whose absence is the documented legacy marker
     (`skeleton-payload.js`'s own contract), and nothing else.
4. Before running the real indexer, independently re-verified (via a
   separate script that imports the real `getEmbeddingConfig()`,
   `resolveTokenCountMode()`, `CHUNKING_SCHEMA_VERSION`, and
   `expectedChunkingMeta()` used by `stageA` itself, not a
   reimplementation) that **every** discriminator the skip tuple checks
   matched current config exactly, and only `chunkingModel`/
   `indexingSchemaVersion` differed:

   | Discriminator | Stored (seeded) | Current (real) | Match |
   |---|---|---|---|
   | `file_hash` | `b868f04e…` | `b868f04e…` (independently computed sha256 of the real file) | ✅ |
   | `dense_provider` | `bge-m3-onnx` | `bge-m3-onnx` | ✅ |
   | `dense_model` | `aapot/bge-m3-onnx` | `aapot/bge-m3-onnx` | ✅ |
   | `sparse_provider` | `bge-m3-onnx` | `bge-m3-onnx` | ✅ |
   | `embedding_schema_version` | `2` | `2` | ✅ |
   | `chunking_schema_version` | `4` | `4` | ✅ |
   | `token_count_mode` | `bge-m3` | `bge-m3` | ✅ |
   | `chunking_model` | *(absent)* | `skeleton-v1` (expected) | ❌ — the one deliberate mismatch |
   | `indexing_schema_version` | *(absent)* | `4` (expected) | ❌ — the one deliberate mismatch |

**Before state (verified via direct Qdrant scroll):** 2 points, byte-real
`file_hash` matching the real file on disk, every other discriminator
matching current config, 0 with any `point_kind`/`node_type`/
`chunking_model`/`indexing_schema_version` field at all.

**Ran normal indexing** (`COLLECTION=semidex-live-accept-20260727021300-partB2
ONNX_EMBED=1 npm run index .tmp/live-acceptance/legacy-migration-root`):

```
  ~ chunkingModel: legacy → skeleton-v1, indexingSchemaVersion: null → 4, reindexing...
        upserted 2 points
        upserted 4 nav point(s) (skeleton_nav)
```

With content genuinely unchanged (real matching hash) and every other
discriminator matching, this reindex trigger is now proven to be caused
**exclusively** by the `chunkingModel`/`indexingSchemaVersion` mismatch —
the requirement Part B actually needed to demonstrate.

| Check | Result |
|---|---|
| Unchanged file not incorrectly skipped, migrates via legacy → skeleton-v1 specifically | Confirmed — console shows the exact reason: `chunkingModel: legacy → skeleton-v1, indexingSchemaVersion: null → 4`, with real-matching `file_hash` and all other discriminators ruled out as the cause |
| Provider/schema validation remains valid | `dense_provider`/`dense_model`/`sparse_provider`/`embedding_schema_version` all matched the real running config throughout — no provider mismatch introduced by the test |
| Old content points replaced, not duplicated | Point IDs before: `17d6507b…`/`8af3e36a…` (legacy scheme). Point IDs after: `24418b7d…`/`75c7b9a2…` (skeleton scheme) — fully different UUIDs, and total `retrieval_content` count stayed at 2 (not 4) |
| Resulting content uses current skeleton metadata | All 7 post-migration points: `chunking_model: "skeleton-v1"`, `indexing_schema_version: 4` |
| Skeleton navigation generated | 5 nav points (1 collection, 1 file, 3 section) — none existed before |
| Second unchanged run skips normally | `✓ unchanged, skipping` on a second identical run; point count held at 7 (no duplication from the skip pass either) |

**Point count: 2 (legacy) → 7 (skeleton-v1: 2 content + 5 nav) → 7 (stable across a no-op second run).**

---

## Part C — Partial PRUNE_STALE

Used the Part A collection (post-fix state: 42 points, 3 files, 3
directories). Removed `guides/advanced/tuning.md` from disk, ran:

```
COLLECTION=...-partA ONNX_EMBED=1 PRUNE_STALE=1 npm run index .tmp/live-acceptance/markdown-root
```

Console: both remaining files reported `✓ unchanged, skipping`; then
`PRUNE_STALE: pruning 1 stale source file(s)... - removed:
guides/advanced/tuning.md`; then `Collection nav node updated (2 file
summaries, 2 directory summaries)`.

Verified against real stored payloads (not console text alone):

| Check | Result |
|---|---|
| Removed content points gone | 0 points reference `guides/advanced/tuning.md` (direct scroll-by-source_file, confirmed empty) |
| Removed file/section nav points gone | `code_block` and one `checklist` `node_type` entirely absent from the post-prune point-type histogram (both were unique to the pruned file) |
| Remaining files intact | `install.md` and `README.md` content/nav point counts unchanged from Part A's post-fix baseline |
| Directory children rebuilt correctly | `qdrant_get_skeleton_children` on `guides` now returns only `getting-started` (1 child, was 2); direct scroll for all `node_type: "directory"` points confirms exactly 2 remain (`guides`, `guides/getting-started`) — no orphan `guides/advanced` |
| Collection children/summary no longer reference deleted file | `qdrant_get_skeleton` root: `"summary": "...— 2 files"` (was 3), root children list only `README.md` + `guides` |
| No unrelated collection touched | All 13 pre-existing collections' point counts identical to the pre-Part-C snapshot |

**Point count: 42 → 27** (11 `retrieval_content` + 16 `skeleton_nav`).

---

## Part D — Full prune to an empty root

Own fixture root (`.tmp/live-acceptance/prune-empty-root/`), own temp
collection (`...-partD-empty`). Indexed one file first (6 points: 2
content + 4 nav), then deleted it from disk entirely and ran:

```
COLLECTION=...-partD-empty ONNX_EMBED=1 PRUNE_STALE=1 npm run index .tmp/live-acceptance/prune-empty-root
```

Console:
```
No supported files found on disk — continuing to stale check.
PRUNE_STALE: pruning 1 stale source file(s)... - removed: seed.md
No skeleton file nav nodes in this collection — skipping collection nav rollup, removing any stale directory/collection nav points.
Done. 0 file(s): 0 indexed, 0 skipped.
```

This is the live regression case for the recently fixed
`collectionNavRollupNeeded(indexed=0, prunedCount>0)` gate.

| Check | Result |
|---|---|
| All stale content points removed | Direct scroll: 0 points total in the collection |
| File/section nav points removed | 0 |
| Stale directory nav points removed | 0 |
| Stale collection nav point removed | 0 — no leftover collection-level node |
| No synthetic "0 files" collection root | Confirmed — the collection has zero points of any kind, not a fabricated empty-inventory node |
| Command exits cleanly | Exit code 0; re-ran a second time against the same empty root → `PRUNE_STALE: no stale source files found`, still exit code 0 (idempotent) |

**Point count: 6 → 0.**

---

## Part E — Non-Markdown-only collection

Fixture: two `.txt` files (`notes.txt`, `second.txt`), own temp collection
(`...-partE-txt`). First attempt failed on an Ollama preflight
(`ensureOllamaPreflight`) — this is the honest, documented non-Markdown
boundary: `.txt` never reaches the skeleton path
(`chunkMeta.chunkingModel` is `null` for non-`.md` extensions), so the
legacy chunker's LLM-based context generation preflight is unconditional
regardless of `TAG_GEN`/`SKELETON_SUMMARY` settings — unlike `.md`, which
skips the preflight entirely via deterministic structural context. Started
`ollama serve` locally to proceed (see Environment section); this is not a
product defect, and no code was changed to work around it.

Indexed successfully once Ollama was reachable. Console:
```
No skeleton file nav nodes in this collection — skipping collection nav rollup, removing any stale directory/collection nav points.
Done. 2 file(s): 2 indexed, 0 skipped.
```

| Check | Result |
|---|---|
| Content still searchable | `qdrant_search` returns real hybrid-search hits from both files with LLM-generated context, real scores |
| No misleading skeleton nav generated | 0 nav points of any kind (`skeleton_nav`) in the collection; both points are legacy-shaped (no `point_kind`/`node_type`/`chunking_model`) |
| No empty collection root created | `qdrant_get_skeleton` on this collection: "No skeleton found... collection may not have been indexed with skeleton support" — an honest error, not a fabricated 0-entry root |
| Admin/MCP surfaces fall back cleanly | `qdrant_get_skeleton` → clean explanatory message, no crash. `qdrant_list_directories` → falls back to a flat root listing ("(root) — 2 files, 2 chunks"). `qdrant_list_files` → works normally. Search hits for legacy points correctly omit the `Node:` line entirely (no fabricated node identity), which also means `qdrant_get_content` (which requires a real `anchor_node_id`) is correctly unreachable for this collection through the normal flow — matching its own documented "legacy collections... cannot use this tool" contract |

No synthetic skeleton semantics were invented for `.txt` at any point —
this is the deliberately-scoped current boundary (Markdown-only skeleton,
confirmed correct behavior, not a gap needing a fix).

**Point count: 0 → 2 (both legacy-shaped, 0 nav).**

---

## Part F — Global Settings runtime acceptance

Built (`npm run admin:build`, 225 modules, clean) and started
(`npm run admin`, port 8642) the real Admin server; drove the real HTTP
API with `curl`. **No browser automation tool was available in this
environment** (confirmed with the user before starting) — every check
below is a real API/runtime check against the live server, not a DOM/CSS
inspection standing in for visual verification. Visual/browser
acceptance (page rendering, section-scroll behavior, viewport overflow,
inert-control detection at 1440×900/1024×768/768×900) is explicitly
**not claimed** and is marked `MANUAL_UI_PENDING`.

| Check | Result |
|---|---|
| `GET /api/settings` opens correctly | 200 OK, 62 settings across 7 categories (`status`, `storage`, `ai`, `embeddings`, `indexing`, `retrieval`, `system`) |
| Ollama model selectors use live discovery | `GET /api/ollama-models?capability=generation` / `?capability=embedding` return ~13 real local models (`bge-m3:latest`, `gemma3:4b`, `qwen3:4b`, etc.), not a hardcoded list |
| Model options change with backend selection | `GET /api/generation/models?backend=ollama` vs `?backend=gemini` return genuinely different, real model lists (real Ollama tags vs. real `gemini-2.5-flash`/`gemini-2.5-pro`/etc. fetched live from the Gemini API with the real key) |
| Gemini status is truthful | `GET /api/generation/status`: `"backend":"gemini","ready":true` — configured AND reachable, using the real present key. `GEMINI_API_KEY` itself never appears in any response body — only `"configured":true,"source":"dotenv"` |
| No key exposed anywhere | Every response inspected (`/api/settings`, `/api/generation/status`, `/api/generation/models`) — confirmed no raw key value in any payload, log, or this report |
| ONNX execution provider shows supported values | `ONNX_EXECUTION_PROVIDER` options: `cpu`/`dml`/`cuda`, current `cpu` |
| "Test configuration" invokes the real probe | `POST /api/system/onnx-probe` → `{"ok":true,"requestedProvider":"cpu","effectiveProvider":"cpu","fellBackToCpu":false,"runtimeSource":"npm","runtimeVersion":"1.24.3","message":"CPU session created successfully"}` — real isolated-process probe, reports actual effective provider and fallback state, not just the configured value |
| Locked/env-sourced values visibly locked | `LLM_BATCH_SIZE` (dotenv-sourced) correctly rejected a PATCH: `"Setting \"LLM_BATCH_SIZE\" is currently overridden by dotenv and cannot be written."` (`setting_overridden`, HTTP-level error, not a silent no-op) |
| Writable settings: stage → save → reload → restore | Used `HYBRID_PREFETCH_LIMIT` (harmless, `next_search`, default 2) as the one reversible test setting. PATCH → 3, saved (`configuredValue: 3`, `activeValue: 3`, `hasLocalOverride: true`). Reloaded via a fresh `GET` → value persisted (3), proving refresh doesn't silently lose a save. Restored via `PATCH {"HYBRID_PREFETCH_LIMIT": null}` → back to `configuredValue: 2, hasLocalOverride: false, configuredSource: "default"` |
| Restart-required state appears only when appropriate | `HYBRID_PREFETCH_LIMIT` (`appliesAt: "next_search"`) correctly showed `pendingRestart: false` throughout — restart flag is not fired for a setting that doesn't need one |
| Validation errors are visible and prevent invalid saves | `PATCH {"HYBRID_PREFETCH_LIMIT": 9999}` → `400 invalid_value`, `"HYBRID_PREFETCH_LIMIT must be an integer between 1 and 100."`; confirmed the rejected value did **not** persist (re-read showed 3, the last valid value, not 9999) |
| Refresh/reload does not silently lose saved values | Covered by the stage/save/reload/restore check above |
| Storage/health truthful | `GET /api/health` → `{"ok":true,"storage":{"backend":"qdrant","ok":true,"detail":"Qdrant reachable"}}` — real, live Qdrant connectivity, not a cached/stale flag |

**Per-section save isolation and full visual/browser checks (1440×900,
1024×768, 768×900 — horizontal overflow, clipped controls, overlapping
content, inert controls, unreachable Save/Cancel) were NOT performed with
a real browser** — no Playwright/Puppeteer or equivalent was available in
this environment. Per the task's own instruction, this is reported
honestly as `MANUAL_UI_PENDING` rather than substituted with a
regex/CSS-based approximation.

The client-side per-category staging model (`pendingByCategory`/
`invalidByCategory` Maps keyed by category, independent Save/Cancel bars
per category) was already verified at the source/unit-test level in the
prior session that rebuilt this Settings surface — this live-acceptance
pass adds real end-to-end proof of the underlying API contract those Maps
depend on (stage → PATCH → persist → reload), but does not re-verify the
DOM-level isolation itself, since that requires the browser this
environment doesn't have.

---

## Bugs found and fixes made

**None in production code.** Two issues surfaced during this exercise,
both in the acceptance methodology itself, not in `skeleton.js`,
`skeleton-chunk.js`, `node-policy.js`, or `run.js`:

1. **Part A fixture too small** — the code block in the original fixture
   was 8 tokens, below the existing, deliberate, documented
   `node-policy.js` `isTinyCodeBlock` threshold (`lines >= 2 && tokens >=
   12`). Fixed by enlarging the fixture's code block (10 lines / 29
   tokens); no product code changed.
2. **Part B seed used a synthetic stale `file_hash` (P1, caught in
   review)** — this made the skip-tuple's `storedHash === fileHash` check
   fail on its own, so the reindex the test observed was never actually
   caused by the `chunkingModel`/`indexingSchemaVersion` mismatch it was
   supposed to isolate. **Fully re-run** with the real, independently
   sha256-verified current file hash and every other discriminator field
   copied verbatim from a real skeleton-v1 baseline — see the corrected
   Part B section above for the full before/after discriminator table and
   re-verified results. No product code changed; this was purely a test
   fixture correction.

No regression test was added for either finding — both are acceptance
methodology corrections, not product defects. The existing
`isTinyCodeBlock` behavior is already covered by its own design-comment
rationale and, transitively, by Part A's post-fix verification; the
`chunkingModel`/`indexingSchemaVersion` skip-tuple behavior is already
covered by `tests/unit/indexer/skeleton-first-invariant.test.js`, and is now
additionally proven correct live, with the actual discriminator isolation
the review correctly demanded.

## Cleanup confirmation

- All 5 owned temp collections deleted (including the invalidated original
  `...-partB` and its `...-partB2` replacement); `qdrant_collection_info()`
  shows exactly the original 13 collections, all point counts unchanged.
- `config.json` restored byte-for-byte from a pre-test backup (`diff`
  confirmed identical) after both the original session and the Part B
  correction — leftover per-collection config entries created by indexing
  the temp collections, and the one `HYBRID_PREFETCH_LIMIT` override
  created/cleared during the Part F save test, are all gone.
- `.env` confirmed byte-for-byte identical to its pre-test backup (`diff`
  confirmed identical) — never touched during this run or its correction.
- `.tmp/live-acceptance/` (all fixtures, inspection scripts, and backups)
  fully removed, including the scripts created for the Part B correction.
- Admin server process stopped.
- No API key, full Qdrant URL, credential, private path, cluster ID, or
  environment dump appears anywhere in this report.

## Remaining limitations

- **Visual/browser acceptance for Global Settings is `MANUAL_UI_PENDING`**
  — no browser automation tool was available in this environment. Section
  navigation scroll behavior, inert-control detection, and the three
  required viewport checks (1440×900, 1024×768, 768×900: horizontal
  overflow, clipped labels, overlapping content, unreachable Save/Cancel)
  still need a real browser pass before full UI acceptance can be claimed.
- Per-category client-side staging isolation (one category's pending edits
  never leaking into another's Save/Cancel) was not re-verified live in
  this session; it was verified at the unit-test/source level in the prior
  session that built this Settings surface, but a live DOM-level
  confirmation is part of the same `MANUAL_UI_PENDING` gap above.
- The `.txt` (non-Markdown) preflight requiring Ollama regardless of
  `TAG_GEN`/`SKELETON_SUMMARY` settings is confirmed intentional/correct
  per current source, but was only exercised for the "Ollama reachable"
  path in this session (Ollama was started specifically to unblock Part
  E). The "Ollama unreachable, `.txt` legacy path fails loudly" case is
  implicitly covered (it's exactly what happened on the first Part E
  attempt, before Ollama was started) but was not re-tested with Ollama
  stopped again afterward.
- ~~Gemini's "missing/unavailable" status path was not directly exercised
  live in this session~~ — **superseded**: a dedicated follow-up session
  (see "Gemini live generation acceptance" below) exercised both the
  "configured and reachable, real generated tokens" path and a controlled
  "model unavailable" failure path end-to-end against the real Gemini API.

## Gemini live generation acceptance (2026-07-27, follow-up session)

**Scope:** proves Gemini performs a real end-to-end generation request
through the existing `GenerationProvider` → Ask coordinator → retrieval
pipeline → `POST /api/ask`, using real generated tokens (not just a
readiness/model-discovery check). No browser/visual testing in this part.
No provider-architecture changes were made or needed.

### Part A — Live configuration

Started the real Admin server and inspected the live API (not source or
cached state):

| Check | Result |
|---|---|
| Active generation backend | `GET /api/generation/status` → `"backend": "gemini"` |
| Active Ask model | `"model": "gemini-flash-latest"` |
| Provider readiness | `"ready": true, "reason": null"` |
| Selected model present in live discovery | `GET /api/generation/models?backend=gemini` returned 57 real model names fetched live from the Gemini API with the real key; `gemini-flash-latest` confirmed present |
| No key exposed | `GET /api/settings`'s `GEMINI_API_KEY` entry: `"secret": true, "writable": false, "configured": true` — no key value in the payload; `geminiApiKey.configured: true` in `/api/generation/status` likewise carries no value |

Backend was already `gemini` (`configuredSource: "config_json"`, i.e. a
previously-saved setting, not an env-locked value) — no settings switch
was needed for this part, so there was nothing to restore from Part A
itself.

### Part B — Evidence selection

Selected `linux-basics` (1329 points, real Ukrainian-language Linux course
content) via `GET /api/collections`. Ran the real search first, via the
actual Admin API (`POST /api/search`, not just MCP), with a short factual
question:

- **Question:** "What command lists files in a directory?"
- **Result (rank 2 of 3):**
  - **Source file:** `Тема 3. Робота з терміналом базові команди (ls, cd, cp, mv, cat, man)/2. Навігація_та_Огляд_cd,_ls_(та_pwd).md`
  - **Node type:** `paragraph` (real prose, not a skeleton summary)
  - **Section:** "Навігація та Огляд: cd, ls (та pwd)"
  - **Excerpt (non-sensitive):** states that `ls` "показує, що знаходиться
    всередині директорії" (shows what's inside the directory) — directly
    answers the question.

Confirmed answerable-from-evidence before proceeding to Ask.

### Part C — Real Gemini Ask request

Called the real `POST /api/ask` (`{"collection":"linux-basics","question":"What command lists files in a directory?","top":3}`) and parsed the raw SSE stream (a small throwaway script parsed `event:`/`data:` frames; it recorded event *names* and metadata only — never full token text — and was deleted at cleanup).

**Recorded run:**

| Check | Result |
|---|---|
| Event order | `sources` → `token`, `token` → `done` |
| Exactly one `sources`, first | ✅ |
| Source count | 3, matching Part B's search |
| Token events | 2, 81 total characters |
| Exactly one terminal event | ✅ (`done`, no `error`) |
| No `error` event | ✅ |
| `done.provider` | `"gemini"` |
| `done.model` | `"gemini-flash-latest"` |
| Answer excerpt (redacted, short) | `"The \`ls\` command is..."` (first ~20 chars only — full text not recorded, per the task's instruction not to include unnecessary generated content) |
| Evidence grounding | `done.citations: [2]` — the answer cites rank-2, the exact `ls` evidence chunk selected in Part B; `invalidCitations: []` |
| Secrets in events/logs | None — confirmed no key substring in any captured event |

**One transient failure, investigated and ruled non-reproducible:** the
very first Ask attempt (immediately after the freshly-started Admin
process's first outbound request of any kind) failed with `error` event
`{"code":"generation_failed","message":"Generation failed: Gemini
generateContentStream failed: fetch failed"}`. Before treating this as a
defect:

- Confirmed the Admin server stayed alive and `ready: true` immediately after.
- Tested raw network reachability to `generativelanguage.googleapis.com`
  directly (`403`, i.e. reachable, not a DNS/network outage).
- Called `@google/genai`'s `generateContentStream()` directly in isolation
  with the real key — succeeded immediately.
- Retried the identical `POST /api/ask` request **4 more times** — all 4
  succeeded cleanly with real tokens, correct event sequence, and correct
  `provider`/`model` metadata (one of these 4 is the "Recorded run" above).

This is consistent with a one-off cold-start TLS/connection blip on the
process's first-ever outbound HTTPS call, not a reproducible code defect.
Per the task's explicit scope ("fix only defects reproduced by the live
acceptance run"), no production code was changed — the failure, when it
did occur, already surfaced through the documented `error` SSE event with
a redacted message, exactly as designed. The initial batch therefore
completed with **4/5 successful Ask attempts**; the isolated SDK call also
succeeded. A later valid Ask after the controlled-failure restore succeeded
as well, bringing the full session to **5/6 successful valid-config Ask
attempts**.

### Part D — Controlled failure path

Without touching or exposing the real API key, used the existing Settings
API to set `ASK_MODEL` to a deliberately nonexistent model name
(`gemini-this-model-does-not-exist-xyz`). `ASK_MODEL` is `appliesAt:
"next_restart"`, so this required restarting the Admin process (a real,
supported "isolated Admin process" seam, not a code change) for the bad
value to take effect.

| Check | Result |
|---|---|
| Failure uses the documented contract | `GET /api/generation/status` → `"ready": false, "reason": "Model \"gemini-this-model-does-not-exist-xyz\" is not available to this Gemini API key: {...404 NOT_FOUND...}"`. `POST /api/ask` → HTTP **503**, `{"error":{"code":"dependency_unavailable",...}}`, plain JSON, no SSE stream started — matches `ask.js`'s documented "provider not ready → plain JSON 503, no stream" contract exactly |
| Admin server stays alive | Confirmed via `GET /api/health` → 200, immediately after the 503 |
| No key exposed | Confirmed zero occurrences of the real key substring in the captured error response |
| Authenticated URLs / raw provider responses redacted | The only raw provider text surfaced was Gemini's own `404 NOT_FOUND` JSON body (no auth material in it — Gemini doesn't echo the key back); no request URL (which would carry no key either, since `@google/genai` sends it as a header, not a query param) appeared anywhere |
| Subsequent valid request succeeds | Restored `ASK_MODEL` to `gemini-flash-latest` via the same Settings API, restarted the Admin process again, confirmed `ready: true`, then ran the same Ask request — succeeded cleanly with real tokens and correct `provider`/`model` metadata |

### Part E — State restoration and cleanup

| Check | Result |
|---|---|
| Temporary settings restored | `ASK_MODEL` back to `gemini-flash-latest` (its value before this session started) |
| `.env` unchanged | `diff` against a pre-session backup: identical |
| `config.json` unchanged | `diff` against a pre-session backup: identical (the `ASK_MODEL` round-trip through the broken value and back left no net diff, since the restored value matches what was there before) |
| No collection point-count change | `linux-basics` still exactly 1329 points; all 13 pre-existing collections' counts unchanged |
| No collection created/deleted | Confirmed via `qdrant_collection_info()` before/after |
| Admin process stopped | Confirmed via `GET /api/health` timing out after `taskkill` |
| No leftover temp scripts/logs with response bodies | The session's own `.tmp/live-acceptance-gemini/` directory (SSE-parsing script, server logs, config backups) was fully removed; server logs were grepped for key material before deletion (none found) |

### Defects found

**None in production code.** The single transient `fetch failed` in Part
C was investigated (isolated SDK test, raw network reachability check,
4 retries) and characterized as non-reproducible cold-start network
flakiness, not a code defect — see Part C above for the full
investigation. No fix was made; no regression test was added, per the
task's explicit "fix only defects reproduced by the live acceptance run"
constraint (this one wasn't).

### Test results (sequential, since no code was changed)

- `npm test` → **1815/1815 pass**
- `npm run smoke` → **1298/1298 pass**
- `npm run admin:build` → clean build (225 modules)
- `git diff --check` → exit 0, no working-tree changes at all (no
  production code was touched by this follow-up session)

### Gemini verdict

**`GEMINI_LIVE_ACCEPT_WITH_LIMITATIONS`**

Real Gemini generation through the existing provider/coordinator/API
stack is fully proven: real generated tokens (not just readiness/model
discovery), correct SSE event sequence and count, evidence-grounded
answer with a valid citation back to the exact search-verified source
chunk, correct `provider`/`model` metadata, a controlled failure path
that matches the documented HTTP/SSE error contract with no secret
exposure, and confirmed recovery afterward. All temporary state
(`ASK_MODEL`, Admin process) was restored; `.env`/`config.json` are
byte-identical to their pre-session state; no collection was touched.
The limitation is one non-reproducible `fetch failed` on the first live Ask
attempt after a fresh Admin start. It was reported safely and did not crash
the server, but it prevents claiming a flawless live run.

**This does not change the overall `SKELETON_ACCEPT_UI_MANUAL_PENDING`
verdict below** — visual/browser acceptance of Global Settings remains a
separate, still-pending task or user action; this session neither
attempted nor claims it.

## Verdict

**`SKELETON_ACCEPT_UI_MANUAL_PENDING`**

Skeleton-first mandatory Markdown indexing (Parts A–E) is fully verified
against real Qdrant with no shortcuts: real corpus, real nested
directories, real table/code_block/checklist authoritative content, real
partial and full-empty PRUNE_STALE side effects checked at the raw payload
level (not just console text), and a real non-Markdown fallback boundary
confirmed honest and uncrashing. Part B's legacy-metadata migration was
re-run after a review finding (P1) showed the original seed's synthetic
stale `file_hash` had made the reindex trigger untrustworthy — the
corrected run copies every discriminator field verbatim from a real
skeleton-v1 baseline except `chunkingModel`/`indexingSchemaVersion`
themselves (independently cross-checked against `getEmbeddingConfig()`/
`resolveTokenCountMode()`/`CHUNKING_SCHEMA_VERSION`/`expectedChunkingMeta()`
before the real indexer ran), so the observed reindex is now proven to be
caused exclusively by the legacy chunking-model marker, matching what Part
B is actually required to demonstrate. Global Settings runtime/API
behavior (Part F) is fully verified live against the real Admin server and
real external providers (Ollama, Gemini, ONNX probe) with no secrets
exposed. The only remaining gap is the browser-only visual/viewport
acceptance, which this environment has no tooling to perform and which the
task explicitly forbids approximating — hence `UI_MANUAL_PENDING` rather
than a full `ACCEPT`, and explicitly not `BLOCKED` since no real product
defect survived this run (both findings raised in review were acceptance
methodology corrections, not product bugs).
