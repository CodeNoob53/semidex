# Duplicate Point Diagnostic — `bitwize-music`

*Generated: 2026-05-23T0024*
*This file has been sanitised: raw source_file paths, point IDs, and named*
*examples replaced with aggregate counts and hashed identifiers.*

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

## Example Duplicate Group

| Field | Values |
|-------|--------|
| File hash | `e4abe08ed4368f7b` |
| chunk_index | 46 |
| Count | 2 |
| Classification | different-tags-and-context |
| Tag set hash (per point) | pt1: 81cf1b824e4d / pt2: 2daecd59d245 |
| Tag count (per point) | pt1: 5 / pt2: 5 |
| Context hash (per point) | pt1: d5101f33f1c8 / pt2: 4b0730500bfd |

This group triggered the initial investigation.

## Top 20 Duplicate Groups by Count (file hashes, no raw paths)

| file hash | chunk_index | count | class |
|-----------|-------------|-------|-------|
| `14e0516bdbe20a83` | 17 | 3 | different-tags-and-context |
| `95f53306f8ed875b` | 13 | 3 | different-tags-and-context |
| `dd32864029f449db` | 23 | 3 | different-tags-and-context |
| `dd32864029f449db` | 24 | 3 | different-tags-and-context |
| `4d604f4b06f21402` |  8 | 3 | different-tags-and-context |
| `dd32864029f449db` | 17 | 3 | different-tags-and-context |
| `95f53306f8ed875b` |  4 | 3 | different-tags-and-context |
| `95f53306f8ed875b` |  6 | 3 | different-tags-and-context |
| `95f53306f8ed875b` |  3 | 3 | different-tags-and-context |
| `14e0516bdbe20a83` | 14 | 3 | different-tags-and-context |
| `14e0516bdbe20a83` | 12 | 3 | different-tags-and-context |
| `4d604f4b06f21402` | 14 | 3 | different-tags-and-context |
| `14e0516bdbe20a83` | 13 | 3 | different-tags-and-context |
| `4d604f4b06f21402` |  4 | 3 | different-tags-and-context |
| `dd32864029f449db` | 13 | 3 | different-tags-and-context |
| `dd32864029f449db` |  2 | 3 | different-tags-and-context |
| `14e0516bdbe20a83` |  4 | 3 | different-tags-and-context |
| `95f53306f8ed875b` |  1 | 3 | different-tags-and-context |
| `dd32864029f449db` | 22 | 3 | different-tags-and-context |
| `14e0516bdbe20a83` |  2 | 3 | different-tags-and-context |

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
*Sanitised: raw source_file paths and point IDs replaced with SHA-1 hashes.*
