# Indexing Robustness Audit — 2026-05-12

Audit of incremental indexing behavior in semidex. Runtime code unchanged — read-only analysis.

---

## 1. Current Behavior

### 1.1 Changed/unchanged file detection

`src/indexer/index.js → indexFile()`

For each file being indexed the pipeline:

1. Computes SHA-256 `fileHash` via streaming read.
2. Calls `getStoredMeta(collection, sourceFile)` — scrolls Qdrant for one point matching `source_file`, returns `file_hash`, `dense_provider`, `dense_model`, `sparse_provider`, `embedding_schema_version`, `vector_size`.
3. Compares all six discriminators. If all match → logs `✓ unchanged, skipping` and returns early.
4. If any discriminator changed → calls `deleteBySourceFile()` to purge old points, then re-indexes.

**Result: skip-unchanged works correctly per file, and covers all provider/schema changes.**

### 1.2 Deleted files

**No stale cleanup exists.** The indexer only processes files it finds via `collectFiles(targetPath)`. If a previously indexed file is deleted from disk, its Qdrant points remain indefinitely. The graph file (`graph.<collection>.json`) retains its entry too.

`deleteBySourceFile()` exists and is used during reindex, but is never called for files absent from the current scan.

### 1.3 Renamed files

Rename = delete old path + create new path on disk. The indexer sees:
- Old path: absent from `collectFiles()` → not processed → Qdrant points survive with old `source_file`.
- New path: not in Qdrant → `getStoredMeta()` returns null → full index run.

**Result: a rename produces a duplicate: old `source_file` persists in Qdrant, new `source_file` is freshly indexed. Graph entry for old path also persists.**

### 1.4 Config / graph drift

`config.json` drift:
- `npm run sync` removes config entries for collections that no longer exist in Qdrant — this is safe.
- No mechanism removes a collection's config entry if the collection is deleted directly in Qdrant outside of sync.

`graph.<collection>.json` drift:
- `removeFile(graph, sourceFile)` is called correctly during reindex (content-changed case).
- `removeFile()` is NOT called for deleted or renamed files — stale graph nodes accumulate.
- `qdrant_related` and `qdrant_backlinks` read from the graph file, so stale nodes produce phantom links in MCP tool output.

---

## 2. Existing Safeguards

| Safeguard | Status |
|-----------|--------|
| Per-file SHA-256 skip | ✓ Works |
| Six-field provider/schema discriminator | ✓ Works |
| `deleteBySourceFile` before reindex | ✓ Works |
| `removeFile(graph)` before reindex | ✓ Works |
| `npm run sync` prunes dead config entries | ✓ Works |
| Stale points for deleted files | ✗ Missing |
| Stale graph nodes for deleted/renamed files | ✗ Missing |
| Rename detection | ✗ Missing |
| `collectFiles` result vs Qdrant state diffing | ✗ Missing |

---

## 3. Gaps / Risks

### Gap 1 — Stale Qdrant points after delete (High practical impact)
A deleted file's points remain searchable indefinitely. For documentation collections this means the agent can retrieve and cite content that no longer exists in the source. No retrieval-time signal distinguishes live from orphaned chunks.

### Gap 2 — Stale graph nodes after delete/rename (Medium)
`qdrant_related` and `qdrant_backlinks` return phantom links. An agent following a related-file link may get "No results found" from a subsequent search or retrieve an unrelated file if the name was reused.

### Gap 3 — Rename silently doubles content (Medium)
Post-rename, two `source_file` values cover the same logical document. The old name persists in Qdrant; search results can contain both. The agent has no way to detect this from chunk payloads alone.

### Gap 4 — No CLI flag for cleanup-only pass (Low)
There is no `COLLECTION=x npm run index --prune` or equivalent. Cleanup requires either a full reindex run (which only touches files on disk) or manual Qdrant UI intervention.

### Gap 5 — chunks_out/ can accumulate stale .md files (Low cosmetic)
`saveChunksMd()` deletes old chunks for a file being reindexed, but nothing prunes chunks for deleted source files. Not a retrieval issue — `chunks_out/` is human review only.

---

## 4. Minimal Implementation Plan

### Stage 1 — Stale source cleanup after indexing run

**Goal:** After `main()` finishes indexing the target path, detect and delete Qdrant points whose `source_file` no longer exists on disk.

**Scope:** folder-mode indexing runs only. Single-file indexing is out of scope (no meaningful "scan" to diff against).

**Approach:**
1. After the indexing loop, collect the set of `sourceFile` strings that were just processed (`processedSourceFiles`).
2. Scroll Qdrant for all distinct `source_file` values in the collection (using `scroll` with payload projection).
3. For each `source_file` in Qdrant not in `processedSourceFiles`, call `deleteBySourceFile()` and `removeFile(graph, sourceFile)`.
4. Log each pruned file.

**Files likely to change:**
- `src/indexer/index.js` — `main()`: add post-loop prune step; add helper to collect distinct source files from Qdrant.
- `src/core/qdrant.js` — possibly add `listSourceFiles(collection)` that scrolls with pagination to handle large collections (current `scroll()` has a hard `limit` param).

**Opt-in flag (recommended):** Guard behind `PRUNE_STALE=1` env var for the first iteration. Makes it non-breaking for existing usage.

**Non-goal for Stage 1:** rename detection, cross-run state tracking.

---

### Stage 2 — Rename behavior documentation and detection hint

**Goal:** Document the current rename behavior explicitly, and add a detectable signal so users/scripts can discover orphans.

**Approach:**
1. Add a note to `docs/en/operations.md` explaining the rename gap and the manual workaround (re-run index with `PRUNE_STALE=1` after renames).
2. Optionally: in the post-loop prune output, note if a pruned `source_file` base name matches a newly indexed file (heuristic rename hint — not automated cleanup, just informational).

**Files likely to change:**
- `docs/en/operations.md` — rename/delete behavior section.
- `src/indexer/index.js` — prune output formatting (Stage 1 prerequisite).

---

### Stage 3 — Focused smoke / unit tests

**Goal:** Cover stale cleanup in `npm run smoke` without requiring live Qdrant.

**Tests to add (unit, no Qdrant):**

| Test | What it covers |
|------|---------------|
| `pruneSourceFiles: keeps files present in current scan` | processedSet ∩ qdrantSet = no deletion |
| `pruneSourceFiles: removes files absent from current scan` | stale entry → deleteBySourceFile called |
| `pruneSourceFiles: empty collection → no-op` | edge case: first run |
| `pruneSourceFiles: empty scan → no pruning in single-file mode` | guard for non-folder runs |
| `removeFile(graph): stale node removed, backlinks cleaned` | already partly exercised via reindex path |

**Implementation note:** The prune logic should be extracted as a pure function (`pruneStaleSourceFiles(currentSet, qdrantSet)`) to allow unit testing without Qdrant mocks. The actual Qdrant calls stay in `main()`.

**Live smoke addition (optional, Stage 3b):**
- Add a case to `smoke:source-filter-live` or a new `smoke:stale-prune-live` that indexes a fixture, deletes one file, re-runs with `PRUNE_STALE=1`, and asserts the deleted file's `source_file` is absent from Qdrant scroll results.

---

## 5. Functions Likely to Change

| File | Function | Change |
|------|----------|--------|
| `src/indexer/index.js` | `main()` | Add post-loop prune step (Stage 1) |
| `src/indexer/index.js` | new `pruneStaleSourceFiles()` | Pure helper; computes delete set (Stage 1) |
| `src/core/qdrant.js` | new `listSourceFiles(collection)` | Paginated scroll returning distinct `source_file` values (Stage 1) |
| `src/core/graph.js` | `removeFile()` | No change needed — already correct |
| `src/smoke.js` | section 9 | Add unit tests for prune logic (Stage 3) |
| `docs/en/operations.md` | rename/delete section | Add behavior note (Stage 2) |

---

## 6. Risks / Non-goals

**Risks:**
- `PRUNE_STALE=1` on a partial target path (e.g., indexing one subdirectory of a larger collection) would incorrectly prune files from other subdirectories. The prune step must only run when `targetPath` is the full collection root, or the user must explicitly scope it. Recommend documenting this clearly in the flag's help text.
- `listSourceFiles()` on very large collections (10k+ points) requires paginated scrolling — current `scroll()` takes a `limit` arg with no continuation token. Qdrant supports `offset`/`next_page_offset` for pagination; this needs to be added.

**Non-goals:**
- Automatic rename detection (requires content fingerprinting or external rename tracking — out of scope).
- Cross-collection stale cleanup.
- Incremental graph diffing beyond what `removeFile()` already provides.
- `chunks_out/` pruning (human review artifact, not retrieval-critical).
