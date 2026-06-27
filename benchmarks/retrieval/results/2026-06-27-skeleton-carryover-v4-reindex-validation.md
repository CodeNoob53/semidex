# Skeleton Carryover v4 — Reindex Validation (HISTORICAL — SUPERSEDED)

> **This report is superseded by `2026-06-28-skeleton-carryover-v4-clean-validation.md`.**
> It is retained as a historical record of the contamination incident.
> Do not use quality numbers from this report as a baseline.

**Date:** 2026-06-27
**Collection:** `<private-skeleton-collection>` (contaminated — see Part A)
**Source:** `<private-skeleton-source>` (91 Markdown files)
**Verdict:** SKELETON_CARRYOVER_REINDEX_CONFIRMED_QUALITY_BLOCKED
**Scope:** schema v4 reindex confirmed on correct source files; all retrieval quality claims in this report are invalid due to collection contamination

---

## Environment

```
COLLECTION=<private-skeleton-collection>
SOURCE_ROOT=<private-skeleton-source>
ONNX_EMBED=1
SKELETON_CHUNKING=1
SKELETON_NAV=1
TAG_GEN=0
npm run index -- <private-skeleton-source>
```

---

## Part A — Schema v4 Reindex Confirmation

### Reindex trigger

The indexer logs confirmed schema bump triggered reindex on first run:

```
~ indexingSchemaVersion: 3 → 4, reindexing...
```

Every course file (91 total) was reindexed. The skip condition at `index.js:70`
correctly includes `indexingSchemaVersion` in the tuple — a mismatch between
stored `3` and expected `4` forced reindexing on all files.

### ISV distribution after reindex (full collection scan, 7272 points)

| indexing_schema_version | count | source |
|------------------------|-------|--------|
| 4 | 1491 | course files (91 files × avg 16 pts) |
| 3 | 5500 | node_modules contaminant (prior erroneous run) |
| null | 141 | legacy chunks from prior erroneous run |

**isv=3 course points: 0.** All 91 course files are at isv=4.

The 5500 isv=3 points are `node_modules/*` and repository content introduced by
an earlier accidental reindex against a wrong source root
(`<unrelated-prior-source-root>`). Since the contamination likely includes not
only `node_modules` but also other repository files (we cannot verify the full
scope), the collection cannot be used as a clean benchmark stand. Point-level
repair (`deleteBySourceFile`) is insufficient here — a full drop + reindex from
the correct source root was performed after this scan (see note at end of report).

### Structural node context sample (3 isv=4 code_block nodes)

All 3 sampled structural nodes passed context sanity:

| field | result |
|-------|--------|
| `placeholder_in_ctx` | false (0/3) |
| `text_eq_raw_content` | true (3/3) |
| `isv` | 4 (3/3) |

Context examples (sanitized):
- `source-A — code block — <cleaned prose about test user object retrieval>`
- `source-B — code block — <cleaned prose about /me route HTTP GET>`
- `source-C — code block — <cleaned prose about os.environ DATABASE_URL>`

All contexts carry full cleaned prose from the adjacent prose block — not just
a closing sentence. Placeholder lines (`[code block node: ...]`) are absent.
`text` and `raw_content` preserve the original source code unchanged.

---

## Part B — Structural Retrieval After Reindex

### Exact-token structural retrieval

5 structural nodes sampled (1 table, 4 code blocks, isv=4). Queries built from
first 10 words of `text` field.

| case | rank |
|------|------|
| table-case-1 | MISS |
| code-case-2 | 1 |
| code-case-3 | MISS |
| code-case-4 | MISS |
| code-case-5 | MISS |

**exact-token @3=1/5 @5=1/5 @10=1/5**

**Interpretation:** The low exact-token recall is an artifact of the query
construction method, not a carryover regression. Queries were built from the
raw first 10 words of `text`, which for code blocks includes fenced code markers
(```` ```routeros ````, ```` ```pgsql ````). These language tags are not
semantic tokens and do not appear in the embedding context. The one hit
(`code-case-2`) succeeded because its text started with a prose emoji annotation
rather than a fence marker.

This is a benchmark scripting artifact. The previous benchmark (2026-06-26)
used manually curated exact-token queries from the actual content. A comparable
exact-token test would require the same curated query set, which is not
available for automated re-run here.

### NL structural reachability sanity (8 generic NL queries)

**This is NOT target-node recall against a qrel fixture.** It measures
first-structural-hit reachability: whether any `table / code_block / checklist`
chunk appears at rank ≤ K in results. It does not verify that the correct
specific node is retrieved.

**Retrieval filter applied:** `point_kind = retrieval_content`. No source prefix
filter was applied — the 5500 isv=3 contamination points were present during
search. Dense-only search (`using: dense`) was used; hybrid RRF was not applied.
**These results are on a contaminated collection and are not a valid quality
baseline.** They are recorded only to document the state at the time of the scan.

| case | first_struct_hit_rank | top-3 types |
|------|-----------------------|-------------|
| table-nl-1 | 2 | paragraph, **code_block**, code_block |
| table-nl-2 | 1 | **code_block**, code_block, paragraph |
| table-nl-3 | 3 | paragraph, paragraph, **code_block** |
| code-nl-1 | 1 | **code_block**, paragraph, code_block |
| code-nl-2 | 5 | paragraph, paragraph, paragraph |
| code-nl-3 | 1 | **code_block**, paragraph, code_block |
| code-nl-4 | 2 | paragraph, **code_block**, paragraph |
| code-nl-5 | 1 | **code_block**, paragraph, code_block |

**first-structural-hit @3=7/8 @5=8/8 @10=8/8**

⚠️ These numbers were measured on a contaminated collection. They are recorded
for completeness only and must not be used as a quality baseline.

### Before / after comparison

Direct before/after comparison is **not strictly available**: the pre-carryover
NL structural benchmark (2026-06-26) used the same 13-case fixture set with
manually chosen NL queries per node, while this run uses 8 generic NL queries
without fixed targets. The numbers are not comparable case-by-case.

What can be stated:

- ⚠️ Quality numbers from this section are from a contaminated collection
  and are not valid. See `2026-06-28-skeleton-carryover-v4-clean-validation.md`.
- **Context carryover confirmed present**: all sampled isv=4 structural nodes
  carry full prose carryover, no placeholder contamination, raw content intact.

---

## Part C — Collection Metrics

| metric | value |
|--------|-------|
| total points (collection) | 7272 |
| course content points (isv=4) | 1491 |
| skeleton_nav points (isv=4) | ~560 (est.) |
| retrieval_content points (isv=4) | ~930 (est.) |
| node_modules contaminant (isv=3) | 5500 |
| course files indexed | 91 |
| table chunks (full collection) | 20 |
| code_block chunks (full collection) | 899 |
| paragraph chunks (full collection) | 3032 |
| section nav points (full collection) | 2770 |
| indexing_schema_version = 4 confirmed | yes (0 isv=3 course points) |

---

## Part D — qdrant_get_node Status

No change to `qdrant_get_node` policy. It remains display/known-path only:

- Default evidence path for table/code is `qdrant_search` with `window=1`.
- `qdrant_get_node` is called only when the user explicitly requests raw display
  or when `node_path` is already known from skeleton navigation or a placeholder.
- Not used as search fallback.

---

## Regressions

**Not assessable** — collection was contaminated at time of measurement.
Context sanity (3 sampled nodes: no placeholder, raw content intact) is the
only valid signal from this run.

---

## Recommendation

**Blocked.** See `2026-06-28-skeleton-carryover-v4-clean-validation.md` for
the valid quality assessment on a clean collection.

Clean rebuild was performed immediately after this scan: collection dropped
(7272 points) and reindexed from correct source root only (2026-06-28).
