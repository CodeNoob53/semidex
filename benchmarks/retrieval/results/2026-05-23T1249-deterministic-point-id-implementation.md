# Deterministic Point ID Implementation

*Generated: 2026-05-23T1249*

## Summary

Qdrant point IDs in semidex are now derived deterministically from the logical
chunk identity rather than from `randomUUID()`. Reindexing the same file now
overwrites the existing Qdrant point rather than inserting a new one. This
prevents future duplicate accumulation.

This change **prevents new duplicates** from being created. It does **not**
repair existing duplicate points left by prior randomUUID indexing runs. Repair
of existing duplicates is a separate task.

## What Changed

### `src/core/point-id.js` (new)

Pure helper that computes a stable UUID v5 point ID from:

| Input | Role |
|-------|------|
| `collection` | prevents cross-collection ID collisions |
| `sourceFile` | relative path, forward-slash normalised |
| `chunkIndex` | zero-based position within the file |
| `embeddingSchemaVersion` | schema bump → fresh IDs → clean reindex |

Intentionally **excluded** from the ID:

| Excluded field | Reason |
|----------------|--------|
| `file_hash` | content changes should overwrite in place, not orphan the old point |
| `tags` | LLM-derived; must not affect physical identity |
| `context` | LLM-derived; must not affect physical identity |
| provider / model name | provider changes use `deleteBySourceFile`; including them would create parallel points across provider migrations |

### `src/indexer/index.js`

- `randomUUID()` call removed from point construction.
- Each point ID is now produced by `makePointId({ collection, sourceFile, chunkIndex, embeddingSchemaVersion })`.
- After a successful upsert, `deleteTrailingChunks(collection, sourceFile, newTotalChunks)` runs to remove any points whose `chunk_index >= newTotalChunks`. This handles the shrinking-file case: deterministic IDs overwrite chunks 0..N-1 but cannot implicitly remove old chunks N..old_N-1.

### `src/core/qdrant.js`

New export `deleteTrailingChunks(collection, sourceFile, fromChunkIndex)`:
deletes points matching `source_file == sourceFile AND chunk_index >= fromChunkIndex`.
Uses a Qdrant `range` filter — no scroll required. Safe: scoped to one source_file,
no other points are affected.

## Why file_hash is Excluded from the ID

Including `file_hash` would make content changes produce a new ID, leaving the
old point as a same-source orphan. `PRUNE_STALE=1` cannot remove same-source
orphans because the `source_file` still exists on disk — it only removes points
for source_files that no longer exist. Same-source cleanup requires explicit
`deleteBySourceFile` or `deleteTrailingChunks`, not PRUNE_STALE. Excluding
`file_hash` avoids this complexity: a content change simply overwrites the
existing point at the same ID.

## Upsert Idempotency After This Change

| Scenario | Behaviour |
|----------|-----------|
| Reindex unchanged file (same hash, same schema) | Indexer skips (`✓ unchanged`) — no Qdrant call |
| Reindex changed file, same chunk count | `deleteBySourceFile` → upsert N points at stable IDs → `deleteTrailingChunks` is a no-op |
| Reindex changed file, fewer chunks | `deleteBySourceFile` wipes all old points → upsert M points at stable IDs → `deleteTrailingChunks` is a safety no-op (old chunks already gone) |
| Reindex changed file, more chunks | `deleteBySourceFile` → upsert N points → `deleteTrailingChunks` is a no-op (no trailing orphans) |
| Provider/schema change | `deleteBySourceFile` runs (existing path) → upsert at new stable IDs |
| Second run of same indexing job (interrupted + restarted) | Deterministic IDs → Qdrant overwrites in place → no duplicates |

`deleteTrailingChunks` runs only when a file actually goes through the indexing
path (i.e. hash or provider changed). If the file is unchanged, the indexer
returns `✓ unchanged, skipping` and neither `deleteBySourceFile` nor
`deleteTrailingChunks` run — trailing orphans from a prior interrupted run are
not cleaned in that case. The guard covers the scenario where a file is reindexed
with fewer chunks than before: after `deleteBySourceFile` wipes all old points,
`deleteTrailingChunks` is a safety no-op, but if for any reason `deleteBySourceFile`
was not reached (e.g. a partial failure after upsert), `deleteTrailingChunks`
removes the leftover high-index points. Files that are skipped as unchanged are
not checked for trailing orphans.

## Existing Duplicates

Collections indexed before this change contain randomUUID points. Those
duplicates are not affected by this change — the new deterministic IDs differ
from the old random IDs, so a reindex of a previously-duplicate file will
**add** a new deterministic point alongside the old UUID points until a
`deleteBySourceFile` is triggered (either by a content/provider change, or by
an explicit repair pass). Repair of existing duplicates is tracked separately.

## Tests

Section `32-deterministic-point-id` added to the offline smoke suite.
All assertions run without Qdrant.

| Test | Result |
|------|--------|
| same inputs → same ID | ✓ |
| result is a UUID string | ✓ |
| version nibble is 5 | ✓ |
| variant bits are set | ✓ |
| different chunkIndex → different ID | ✓ |
| different sourceFile → different ID | ✓ |
| different collection → different ID | ✓ |
| different embeddingSchemaVersion → different ID | ✓ |
| file_hash excluded — does not affect ID | ✓ |
| tags excluded — does not affect ID | ✓ |
| context excluded — does not affect ID | ✓ |
| backslash path == forward-slash path (Windows normalisation) | ✓ |

*No private paths, chunk text, or collection data.*
