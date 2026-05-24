# Duplicate Point Repair Plan

*Generated: 2026-05-23T0215*
*Scope: semidex Qdrant collections with randomUUID point IDs*

---

## 1. Executive Summary

### What problem exists

A diagnostic on `bitwize-music` found **857 duplicate groups** across 14,152
total points. Each duplicate group contains two or more Qdrant points that share
the same `source_file + chunk_index` — the logical identity of a chunk — but
carry different point IDs and often different LLM-generated tags and context
strings. The collection holds **1,814 duplicate points** that should not exist.

### Why it affects retrieval

When a query matches a duplicated chunk, Qdrant may return multiple results for
the same logical chunk — consuming result slots that could have been filled by
distinct content. In a top-K=10 retrieval, 2–3 duplicate hits can silently push
lower-scoring but genuinely different chunks out of the result window. Because
the duplicates carry different tags and context strings, tag-based filtering and
context-augmented prompts receive inconsistent signal from the same underlying
source. The effect is subtle and does not surface as an error, making it easy to
miss without a diagnostic.

### Why PRUNE_STALE is insufficient

`PRUNE_STALE=1` compares the set of `source_file` values present on disk against
those in Qdrant, then deletes any Qdrant source_file that no longer exists on
disk. It does **not** inspect point count per `source_file`. Both duplicate
points carry the same `source_file` value and both resolve to a live file on
disk, so both survive the stale check. PRUNE_STALE eliminates orphaned files; it
cannot detect or remove intra-source duplicates.

---

## 2. Root Cause Analysis

### randomUUID point IDs cause non-idempotent upsert

semidex assigns each point a `randomUUID()` at index time. Qdrant's upsert
operation is keyed on point ID: if the ID already exists, the existing point is
overwritten; if it does not, a new point is inserted. Because each indexing run
generates a fresh UUID, Qdrant always sees a new ID and always inserts — it
never overwrites the prior run's points. The result is additive accumulation:
*n* indexing runs of the same file produce *n* sets of points for that file.

### Repeated indexing creates parallel points

The indexer skips a file when its `file_hash` is unchanged (`✓ unchanged,
skipping`). This is correct and efficient. However, if a file was indexed before
the current cleanup logic was in place, or if indexing was interrupted and
restarted, or if historical runs predated deterministic overwrite behavior, the
prior run's points remain in Qdrant because no delete was issued before the new
upsert. The hash-skip path does not clean up prior points; it simply does not
add new ones. Note: the current indexer already calls `deleteBySourceFile` when a
content or provider change is detected — so normal hash-change reindexes today do
not accumulate duplicates. The duplicates in `bitwize-music` predate or bypassed
that cleanup path.

### Changed LLM tags/context make duplicates visible

The dominant duplicate class in `bitwize-music` is `different-tags-and-context`
(~87% of duplicate groups). Two points share the same `file_hash` but carry
different LLM-generated tags and context strings — evidence that two full
indexing runs completed for the same file, each with independent LLM calls that
produced different output. Both sets of tags/context are live in the collection
and both will surface in tag-filtered queries.

### source_file + chunk_index is the logical identity; point ID is not

The logical identity of a chunk is its position in a specific source file:
`(source_file, chunk_index)`. This is how the rest of the system reasons about
chunks — it is the key used by `deleteBySourceFile`, the scroll grouping in the
diagnostic, and the link/backlink payload. The Qdrant point ID is today a random
surrogate that does not encode this identity, creating a persistent gap between
logical and physical identity.

---

## 3. Immediate Safe Repair Options

### Option A — Targeted deleteBySourceFile + reindex affected files

**Procedure:** For each `source_file` that has at least one duplicate group,
call `deleteBySourceFile(collection, sourceFile)` to wipe all points for that
file, then re-run the indexer for that file. The indexer produces a single clean
set of points per chunk.

| Dimension | Assessment |
|-----------|------------|
| Safety | High. Scoped to affected files only; other files untouched. Reversible — reindex again if something goes wrong. |
| Cost | Low–Medium. 31 affected files in `bitwize-music`. Each file requires one delete + one embed pass. Embedding cost depends on file length and provider. |
| Risk | Requires original source files on disk and LLM access for tag generation. If `TAG_GEN=0`, tags are not regenerated; if `TAG_GEN=1`, tags will differ from any prior run (LLM non-determinism). |
| Preserves vectors | No — new embeddings are generated. |
| Preserves tags/context | No — regenerated by the indexer (unless tag gen is disabled). |
| Requires source files on disk | **Yes.** |
| When to use | Source files are available; LLM tag non-determinism is acceptable; want minimal blast radius. **Default recommendation for `bitwize-music`.** |

### Option B — Full collection rebuild

**Procedure:** Delete the collection entirely and reindex all source files from
scratch.

| Dimension | Assessment |
|-----------|------------|
| Safety | High for final state; destructive in process — all points are gone until reindex completes. |
| Cost | High. Full embed pass over all 14,000+ points. |
| Risk | Collection is unavailable during rebuild. If reindex is interrupted, collection may be partially populated. Mitigate by rebuilding into a shadow collection and swapping. |
| Preserves vectors | No. |
| Preserves tags/context | No. |
| Requires source files on disk | Yes. |
| When to use | Doing a provider or schema migration anyway; or duplicate contamination is widespread enough that targeted repair is not worth it. |

### Option C — Collection-level duplicate cleanup without re-embedding

**Procedure:** For each duplicate group, identify the canonical point (e.g.
most recently indexed, or highest payload completeness), delete the others via
point ID. No new embeddings are generated; the surviving point retains its
existing vectors, tags, and context.

| Dimension | Assessment |
|-----------|------------|
| Safety | Medium. Does not require source files or LLM. But "canonical" selection is heuristic — no ground truth for which copy is correct. |
| Cost | Very low. Delete-only operations; no embedding. |
| Risk | If two copies have different tags/context and both are partially correct, one set of tags is lost. The surviving point may carry stale or lower-quality context from an earlier run. |
| Preserves vectors | Yes (surviving point). |
| Preserves tags/context | Partially — one copy's tags/context are kept, others discarded. |
| Requires source files on disk | No. |
| When to use | Source files are unavailable, or re-embedding is too expensive, and duplicate pruning alone is the goal. Acceptable as a stopgap before a proper reindex. |

### Option D — Leave as-is until deterministic IDs are implemented

**Procedure:** Do nothing now. Implement deterministic point IDs (Section 5),
then run a full or targeted reindex under the new scheme. Duplicates are
eliminated automatically because a stable ID causes Qdrant to overwrite rather
than insert.

| Dimension | Assessment |
|-----------|------------|
| Safety | High (no action taken). |
| Cost | Zero now; full reindex cost deferred to deterministic-ID implementation. |
| Risk | Duplicates continue to affect retrieval quality until the reindex. Duration depends on implementation timeline. |
| Preserves vectors | Yes (no change). |
| Preserves tags/context | Yes (no change). |
| Requires source files on disk | No (now); yes (at migration time). |
| When to use | Deterministic IDs are already planned and the implementation timeline is short. Acceptable if retrieval quality degradation is tolerable in the interim. |

---

## 4. Recommended Immediate Path

**Recommendation: Option A — Targeted deleteBySourceFile + reindex.**

Rationale:

- 31 affected source files out of 653 total (~5%) is a small, bounded scope.
- The dominant duplicate class (`different-tags-and-context`) indicates the
  collection has been fully indexed multiple times; a targeted reindex will
  produce a clean, consistent state.
- deleteBySourceFile is already implemented and tested in the indexer.
- The operation is reversible: if a file reindexes incorrectly, run it again.
- Option C (keep one copy) risks preserving lower-quality context from an older
  run with no way to verify which copy is better.
- Option D defers the problem; 857 duplicate groups is enough noise to warrant
  fixing before the next benchmark run.

**Preconditions before running:**

1. Run the diagnostic script to export the current affected-files list.
2. Confirm all 31 affected source files exist on disk.
3. Ensure no other indexer job is running against the same collection.
4. Decide: `TAG_GEN=0` (preserve tag-generation cost, accept blank tags on
   repaired points) or `TAG_GEN=1` (regenerate tags, accept LLM non-determinism
   and cost).
5. Test with `--dry-run` first (once that flag is implemented per Section 7).

---

## 5. Long-Term Fix Design

### Deterministic point IDs

The root fix is to derive each point's Qdrant ID from its logical identity
rather than from `randomUUID()`. A stable ID makes every upsert idempotent:
reindexing the same content with the same parameters produces the same ID, so
Qdrant overwrites the existing point rather than inserting a new one.

### ID formula candidates

**Formula 1 — schema-stable ID:**

```
id = uuidv5(namespace, collection + ":" + source_file + ":" + chunk_index + ":" + embedding_schema_version)
```

- Stable across content changes (file_hash changes do not change the ID).
- A content change triggers an overwrite (same ID, new payload + vectors).
- Rename/move of `source_file` changes the ID → old point is orphaned until
  PRUNE_STALE removes it; new point is inserted at new ID. This is correct
  behavior provided PRUNE_STALE runs after the rename.
- Schema version bump → all IDs change → full reindex effectively required.
  This is intentional: schema changes mean old vectors are incompatible.

**Formula 2 — content-locked ID:**

```
id = uuidv5(namespace, source_file + ":" + chunk_index + ":" + file_hash + ":" + dense_provider + ":" + dense_model)
```

- ID changes whenever file content or provider changes.
- A content change inserts a new point and leaves the old one orphaned. PRUNE_STALE
  cannot clean this up: the `source_file` still exists on disk, so the old point
  survives the stale check. A dedicated same-source cleanup step is required —
  either a `deleteBySourceFile` before reindex, or a `deleteChunksWithOldHash`
  pass after upsert.
- Provides stronger audit trail — each content version has a distinct ID.
- Requires same-source cleanup logic beyond what PRUNE_STALE provides.

**Recommended formula: Formula 1 (schema-stable).**

Simpler PRUNE_STALE interaction: the source_file→point-ID mapping is stable as
long as chunk boundaries and schema version are unchanged. Content changes
overwrite in place. This matches user expectations: reindexing a changed file
updates it; reindexing an unchanged file is a true no-op at the Qdrant level.

### Tradeoff: stable IDs across content changes vs forcing new IDs

| Approach | Content-change behavior | Rename behavior | PRUNE_STALE interaction |
|----------|------------------------|-----------------|------------------------|
| Formula 1 (schema-stable) | Overwrite in place | Old ID orphaned, new ID inserted | Simple: orphaned source_file cleaned by PRUNE_STALE |
| Formula 2 (content-locked) | New ID inserted, old orphaned | Old ID orphaned, new ID inserted | PRUNE_STALE insufficient — source_file still live; requires same-source cleanup |
| randomUUID (current) | New ID inserted, old orphaned | Old ID orphaned, new ID inserted | Same as Formula 2, no cleanup mechanism |

### How upsert should behave after content changes

With Formula 1:

1. `file_hash` changes → indexer re-chunks and re-embeds the file.
2. New chunks are upserted with the same IDs (derived from `source_file +
   chunk_index + schema_version`).
3. If the new version has fewer chunks than the old version, trailing chunk IDs
   (e.g. old `chunk_index=47` no longer exists) become orphans. PRUNE_STALE
   cannot detect these because the `source_file` still exists on disk.
4. **Required additional mechanism:** after reindexing a file, delete any
   surviving points for that `source_file` whose `chunk_index >= new_total_chunks`.
   This is a bounded delete and safe to implement in the indexer as a post-upsert
   cleanup step.

### How links/backlinks should address deterministic IDs

The link-building pass stores `source_file` and `chunk_index` in point payloads
to resolve backlinks. With deterministic IDs, the ID itself encodes
`source_file + chunk_index`, so link resolution can use the point ID directly
rather than scrolling for a matching payload. This enables:

- Faster link lookup (point fetch by ID instead of filter scroll).
- Safer link invalidation: if a source file is deleted, all derived IDs are
  known without a collection scan.

The `updateLinkPayload` function should be updated to accept deterministic IDs
so it can upsert link data directly rather than searching by payload fields.

### Same-hash move/rename fast path

The roadmap includes a fast path for rename/move where `file_hash` is unchanged.
With deterministic IDs (Formula 1), rename changes `source_file` → changes ID.
The fast path must therefore:

1. Compute the new ID set for the new `source_file` path.
2. Fetch each old point (by old ID) and upsert at the new ID with the same vectors/payload.
3. Delete the old IDs.

This is a copy-rename-delete at the Qdrant level. Alternatively, update only the
`source_file` field in the payload and accept that the point ID no longer encodes
the current source_file. This is simpler but re-introduces ID/identity drift.
**Recommendation:** do the full copy-rename-delete to keep IDs accurate.

---

## 6. Migration Strategy

### Problem

Existing collections contain randomUUID points. Introducing deterministic IDs
means the new IDs for the same logical chunks do not match the existing point
IDs. A reindex will insert new points alongside old UUID points, not replace them
— worsening duplicates until old points are purged.

### Recommended migration path

**Phase 1 — Implement deterministic ID generation (no collection changes)**

- Add `deterministicPointId(collection, sourceFile, chunkIndex, schemaVersion)`
  helper to `src/core/qdrant.js` or a new `src/core/ids.js`.
- Keep `randomUUID()` as the active path behind a flag (`DETERMINISTIC_IDS=1`).
- Write unit tests for the ID helper (see Section 8).
- Deploy to staging; run diagnostic — no change in Qdrant yet.

**Phase 2 — Per-collection migration command**

Run a one-time migration per collection:

1. Scroll all points, compute the deterministic ID for each point's
   `(source_file, chunk_index, schema_version)` payload.
2. For each group sharing a logical identity, keep the most recently indexed
   point (by `indexed_at` timestamp if present, else arbitrary), re-upsert it
   at its deterministic ID, delete all other points in the group (including the
   old UUID point).
3. This is equivalent to Option C (cleanup without re-embedding) but with the
   added step of re-inserting at the stable ID.
4. After migration, all points have deterministic IDs → future reindexes are
   idempotent.

**Phase 3 — Enable DETERMINISTIC_IDS by default**

After all active collections are migrated:

- Remove the flag; deterministic IDs become the only path.
- Update PRUNE_STALE to use deterministic ID computation where possible.

### Mixed UUID + deterministic points

**Do not run the indexer with DETERMINISTIC_IDS=1 against a collection that
still has UUID points without first running the migration command.** A partial
reindex would produce deterministic IDs for reindexed files but leave UUID IDs
for untouched files, creating a mixed-ID collection. The migration command must
be run as an atomic step, not incrementally alongside normal indexing.

### Avoiding incorrect data deletion

- The migration command must operate only on groups where
  `(source_file, chunk_index)` is shared by more than one point ID.
- Single-point groups (no duplicates) are re-upserted at their deterministic ID
  without any deletion of other points (there are none).
- The command must refuse to run unless the current duplicate count can be
  verified before and after.
- A `--dry-run` flag must print what would be deleted/re-upserted without
  touching Qdrant.

---

## 7. Proposed Tools / Commands

These are design specifications. Do not implement yet.

### `npm run diag:duplicates`

```
npm run diag:duplicates -- --collection <name> [--scroll-limit <n>]
```

- Scrolls all points in the named collection.
- Groups by `(source_file, chunk_index)`.
- Classifies each duplicate group.
- Writes a privacy-safe report to `benchmarks/retrieval/results/` (no source_file
  names in default output; `--verbose` flag enables them for local use).
- Prints summary to stdout.
- **Does not modify Qdrant.**

Backed by `benchmarks/retrieval/duplicate-point-diagnostic.js` (already
implemented). The npm script is a thin wrapper.

### `npm run repair:duplicates`

```
npm run repair:duplicates -- --collection <name> [--dry-run] [--confirm <name>]
```

- Requires `--collection`.
- Default mode is `--dry-run`: prints what would be deleted/re-upserted, exits
  without touching Qdrant.
- Destructive mode requires `--confirm <collection-name>` where the value must
  exactly match `--collection`. Refuses to run without it.
- For each duplicate group: selects the canonical point, re-upserts at the
  deterministic ID (Phase 2 migration), deletes all other points in the group.
- Prints before/after duplicate counts.
- Writes an audit log to `.tmp/repair-<collection>-<timestamp>.json` (not
  committed).

### `npm run repair:source`

```
npm run repair:source -- --collection <name> --source-file <relative-path> [--dry-run]
```

- Implements Option A (targeted deleteBySourceFile + reindex) for a single file.
- Requires `--collection` and `--source-file`.
- Default mode is `--dry-run`.
- Destructive mode: calls `deleteBySourceFile`, then runs the indexer for the
  named file.
- Requires the source file to exist on disk; refuses if not found.
- Prints point count before and after for the affected source_file.

### Shared behavioral requirements

- All commands print `DRY RUN — no changes made` in dry-run mode.
- All destructive commands log the exact Qdrant point IDs deleted to `.tmp/`.
- No command runs against multiple collections simultaneously.
- No command accepts wildcards in `--source-file`.
- All commands exit non-zero on Qdrant errors.

---

## 8. Acceptance Criteria for Implementation

### Deterministic ID helper

- [ ] Unit test: same inputs → same ID across multiple calls.
- [ ] Unit test: changing `chunk_index` changes the ID.
- [ ] Unit test: changing `source_file` changes the ID.
- [ ] Unit test: changing `schema_version` changes the ID.
- [ ] Unit test: IDs are valid UUIDs (v5 format).
- [ ] Unit test: ID does not encode private content (verify it is a hash, not a
      reversible encoding).

### Diagnostic command

- [ ] Dry-run only; no Qdrant writes under any invocation.
- [ ] Report contains no chunk text, no raw tags, no private absolute paths.
- [ ] Exits non-zero if collection does not exist.
- [ ] Produces consistent output across runs on the same collection state.

### Repair commands

- [ ] `repair:duplicates` without `--confirm` exits non-zero and prints an error.
- [ ] `repair:duplicates` with wrong `--confirm` value exits non-zero.
- [ ] `repair:source` without `--source-file` exits non-zero.
- [ ] `repair:source` with a non-existent source file exits non-zero.
- [ ] Both commands in dry-run mode make zero Qdrant API calls that write data.
- [ ] After `repair:duplicates --confirm <name>` runs on a fixture collection,
      re-running `diag:duplicates` reports zero duplicate groups.
- [ ] After `repair:source` for a known-duplicate file, that file's group count
      drops to zero in the diagnostic.

### Fixture / integration test

- [ ] A small synthetic Qdrant collection (in test setup) is seeded with known
      duplicate groups.
- [ ] `diag:duplicates` reports the expected count.
- [ ] `repair:duplicates` reduces the count to zero.
- [ ] The surviving points have deterministic IDs matching the formula.
- [ ] No non-duplicate points were modified.

---

## 9. Open Questions

**Q1: Should point ID include file_hash?**

Including `file_hash` in the ID formula (Formula 2) means content changes
produce new IDs, making old points same-source orphans that PRUNE_STALE cannot
clean up because the `source_file` still exists. That requires same-source
cleanup logic. Not including it (Formula 1) means content changes overwrite in
place, which is simpler. Recommendation: exclude `file_hash` from the ID; use it
only for skip-logic.

**Q2: Should source_file rename preserve point IDs?**

With Formula 1, rename changes the ID. Preserving point IDs across rename
requires a copy-rename-delete operation or storing a stable internal key
separate from `source_file`. If rename is frequent, a stable internal key
(e.g. inode-derived or user-assigned) may be worth the complexity. For now,
rename = new ID + PRUNE_STALE cleanup of old ID is the simpler path.

**Q3: Should tags/context be regenerated on repair or preserved?**

Option A regenerates both (LLM re-runs). Option C preserves the surviving
copy's tags/context. Regeneration is more consistent but costs LLM calls and
introduces non-determinism. If `TAG_GEN=0` is acceptable, regeneration is free
(tags left blank or skipped). Recommendation: for Option A, use `TAG_GEN=1`
only if tag quality matters for the collection; otherwise `TAG_GEN=0` reduces
cost and non-determinism.

**Q4: Should public reports hide source_file by default?**

Yes. The diagnostic script should default to omitting source_file names from
the written report; a `--verbose` flag enables them for local use. This makes
the report safe to commit even when the corpus is private. The current script
includes source_file names and should not be committed with report output.

**Q5: Chunk count changes after content update**

If a file is updated and produces fewer chunks, the trailing chunk IDs become
orphans that PRUNE_STALE cannot detect (source_file still exists). A post-upsert
cleanup step — `deleteChunksAbove(collection, sourceFile, newTotalChunks)` — is
needed. When should this run: always after reindex, or only when total_chunks
decreases? Running always is safer; the delete is a no-op if count is unchanged.

---

*Report generated for semidex duplicate-point repair planning.*
*No private paths, tags, chunk text, or collection-specific source file names.*
