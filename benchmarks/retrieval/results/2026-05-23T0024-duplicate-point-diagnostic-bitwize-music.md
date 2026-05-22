# Duplicate Point Diagnostic — `bitwize-music`

*Generated: 2026-05-23T0024*

## Summary

| Metric | Value |
|--------|-------|
| Total points scanned | 14152 |
| Unique source files | 653 |
| Duplicate groups (source_file#chunk_index) | 857 |
| Duplicate points total | 1814 |
| Clean (unique) groups | 12338 |

## Classification Summary

| Class | Duplicate group count |
|-------|-----------------------|
| different-tags-and-context          | 834 |
| different-context                   | 22 |
| different-tags                      | 1 |

**Classification key:**

- **exact-duplicate** — all payload fields identical; only point ID differs
- **different-tags** — same file_hash + context, but tags differ between copies
- **different-context** — same file_hash + tags, but context text differs
- **different-tags-and-context** — both tags and context differ; likely two separate indexing runs with different LLM output
- **different-file-hash** — source content changed between indexing runs
- **different-provider-or-schema** — different embedding provider or schema version; stale points from a provider switch
- **partial-difference** — some fields differ but none of the above categories match exactly

## Named Example: social-media-best-practices.md#46

| Field | Values |
|-------|--------|
| Key | `reference/promotion/social-media-best-practices.md#46` |
| Count | 2 |
| Point IDs | 31cb1465-911b-4c63-a165-2fce0938efa3, 3a7fb1fd-91de-41b8-9063-9fdb0f288187 |
| Classification | different-tags-and-context |
| Tag set hash (per point) | pt1: 81cf1b824e4d / pt2: 2daecd59d245 |
| Tag count (per point) | pt1: 5 / pt2: 5 |
| Context hash (per point) | pt1: d5101f33f1c8 / pt2: 4b0730500bfd |

This is the case that triggered the diagnostic.

## Top 20 Duplicate Groups by Count

| source_file | chunk_index | count | class | point IDs (truncated) |
|-------------|-------------|-------|-------|-----------------------|
| `reference/release/metadata-by-platform.md` | 17 | 3 | different-tags-and-context | 02283799…, 16ece437…, c600e146… |
| `reference/streaming-mastering-specs.md` | 13 | 3 | different-tags-and-context | 03938ea3…, 1d0a780f…, 3d8d04dd… |
| `reference/sheet-music/troubleshooting.md` | 23 | 3 | different-tags-and-context | 03a54277…, d70bdb85…, e71cfc0c… |
| `reference/sheet-music/troubleshooting.md` | 24 | 3 | different-tags-and-context | 03c53c7a…, 985fd6cc…, f59a4495… |
| `reference/release/distributor-guide.md` | 8 | 3 | different-tags-and-context | 04179cf2…, 5cb00e7c…, 9df89521… |
| `reference/sheet-music/troubleshooting.md` | 17 | 3 | different-tags-and-context | 05c3ddf6…, aa2d8f8a…, c4d50ebf… |
| `reference/streaming-mastering-specs.md` | 4 | 3 | different-tags-and-context | 066c1c07…, 23e8ca53…, fce710cd… |
| `reference/streaming-mastering-specs.md` | 6 | 3 | different-tags-and-context | 06a482f3…, 59131c8c…, 90d39c0c… |
| `reference/streaming-mastering-specs.md` | 3 | 3 | different-tags-and-context | 07038a3d…, 4bc6dfc0…, 56e53227… |
| `reference/release/metadata-by-platform.md` | 14 | 3 | different-tags-and-context | 077aa9f5…, 2d9ce29c…, 65ff6113… |
| `reference/release/metadata-by-platform.md` | 12 | 3 | different-tags-and-context | 097715cc…, 153d605b…, c406184b… |
| `reference/release/distributor-guide.md` | 14 | 3 | different-tags-and-context | 09811142…, 139b3b46…, b71d10a8… |
| `reference/release/metadata-by-platform.md` | 13 | 3 | different-tags-and-context | 0ab15928…, 762fbd79…, 7ea452e8… |
| `reference/release/distributor-guide.md` | 4 | 3 | different-tags-and-context | 0bc0d1b4…, 3107a0ab…, 72c18e54… |
| `reference/sheet-music/troubleshooting.md` | 13 | 3 | different-tags-and-context | 0d4ae5c4…, 71c3ce07…, d0cee90b… |
| `reference/sheet-music/troubleshooting.md` | 2 | 3 | different-tags-and-context | 0da765f5…, 4aef3033…, f0315c38… |
| `reference/release/metadata-by-platform.md` | 4 | 3 | different-tags-and-context | 0e2b828a…, 1f96b3d8…, 69af42fd… |
| `reference/streaming-mastering-specs.md` | 1 | 3 | different-tags-and-context | 104be001…, 89223a94…, 8b85a2ad… |
| `reference/sheet-music/troubleshooting.md` | 22 | 3 | different-tags-and-context | 10868d45…, 7fdccacf…, e749efdb… |
| `reference/release/metadata-by-platform.md` | 2 | 3 | different-tags-and-context | 10f19398…, 226b2da0…, 989c8372… |

## Likely Cause

Duplicate points with the same `source_file + chunk_index` but different point
IDs arise when:

1. **randomUUID point IDs**: semidex generates a new UUID on every indexing run
   rather than deriving a stable ID from `source_file + chunk_index`. Without a
   stable ID, Qdrant cannot overwrite the existing point — it always inserts a new
   one.

2. **Missing pre-upsert cleanup**: the indexer does not call
   `deleteBySourceFile` before upserting if the file hash is unchanged
   (`✓ unchanged, skipping`). If a prior run left stale points and then the
   indexer was run again after a hash change (or a forced reindex), the old UUIDs
   remain.

3. **Partial reindex after provider/schema change**: if a source was reindexed
   with a new provider (e.g. ollama → bge-m3-onnx) without a full
   `deleteBySourceFile` first, both the old and new provider points coexist.

The presence of **different-tags** and **different-tags-and-context** duplicates
indicates repeated indexing runs (historical, sequential, or concurrent) where
the LLM produced different tag/context output each time, but the underlying
content (file_hash) was unchanged. Because point IDs are random, each run
inserted new points rather than overwriting existing ones.

## Does `PRUNE_STALE=1` Fix This?

**No.** `PRUNE_STALE=1` compares the set of `source_file` values currently on
disk against the set stored in Qdrant, and deletes any Qdrant source_file that no
longer exists on disk. It does **not** detect or remove intra-source duplicates —
i.e. two points sharing the same `source_file + chunk_index`. Both duplicates
would show the same `source_file` and would both survive the stale check.

## Recommended Safe Repair Options

### Option A — Targeted deleteBySourceFile + reindex (preferred)

For each `source_file` that has at least one duplicate group:

1. Call `deleteBySourceFile(collection, sourceFile)` to wipe all existing points
   for that file.
2. Re-run the indexer for that single file; a clean set of points is written.

This is safe, reversible (just reindex again if something goes wrong), and scoped
to affected files only.

**Caveat:** requires listing all affected source files first (script can produce
that list). Avoid running while another indexer job is in progress.

### Option B — Full collection wipe + reindex

Delete the collection entirely and reindex from scratch. Safe but slow for a
14,000+ point collection.

### Option C — Stable deterministic point IDs (long-term fix)

Change the indexer to derive point IDs from
`hash(source_file + chunk_index + schema_version)` instead of `randomUUID()`.
Qdrant upserts are idempotent when the ID is stable, so reindexing the same
content never produces duplicates. This is the root-cause fix.

---

*Report generated by `benchmarks/retrieval/duplicate-point-diagnostic.js`.*
*No chunk text, no private absolute paths.*
