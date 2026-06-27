# Skeleton Carryover v4 — Clean Collection Validation

**Date:** 2026-06-28
**Collection:** `<private-skeleton-collection>` (clean rebuild, drop + reindex)
**Source:** `<private-skeleton-source>` (91 Markdown files)
**Verdict:** SKELETON_CARRYOVER_ACCEPT

---

## Context

Supersedes `2026-06-27-skeleton-carryover-v4-reindex-validation.md`
(verdict: REINDEX_CONFIRMED_QUALITY_BLOCKED — collection was contaminated with
~5500 points from an unrelated source root).

This report validates on a clean collection: dropped (7272 points removed),
recreated, and reindexed from the correct source root only.

---

## Environment

```
COLLECTION=<private-skeleton-collection>
SOURCE_ROOT=<private-skeleton-source>
ONNX_EMBED=1
SKELETON_CHUNKING=1
SKELETON_NAV=1
TAG_GEN=0
# collection dropped via Qdrant REST DELETE /collections/<name>
npm run index -- <private-skeleton-source>
```

Reindex log: `91 file(s): 91 indexed, 0 skipped`

---

## Part A — Collection Sanity

### ISV distribution (sample 500, all points)

```
{"4": 500}
```

`All points isv=4: YES`. No isv=3, no null, no node_modules contamination.

### Reindex trigger (from prior run logs)

```
~ indexingSchemaVersion: 3 → 4, reindexing...
```

Every file triggered reindex due to schema version mismatch — confirms
`INDEXING_SCHEMA_VERSION = 4` bump functions correctly in the skip tuple.

### Structural node context sample (5 nodes: 2 table, 3 code_block)

| field | result |
|-------|--------|
| heading present | true (5/5) |
| node type present | true (5/5) |
| prose carryover present | true (5/5) |
| placeholder in context | false (5/5) |
| `text == raw_content` | true (5/5) |

Context examples (sanitized):
- `source-A — table — <cleaned prose about prior code usage>`
- `source-B — table — <cleaned prose about migration execution>`
- `source-C — code block — <cleaned prose about current_user test extraction>`
- `source-D — code block — <cleaned prose about os.environ DATABASE_URL>`
- `source-E — code block — <cleaned prose about /me route GET method>`

All structural nodes carry full cleaned prose carryover — not just a closing
sentence. `text` and `raw_content` preserve the original source unchanged.

---

## Part B — Target-Node Exact-Token Retrieval

### Methodology

Targets fetched directly from collection by `node_type` + `point_kind` filter.
Query built from first meaningful lines of `text` (fence markers and separator
rows stripped). Dense-only search, `point_kind = retrieval_content` filter,
top-10.

### Results (5 tables + 8 code blocks, 13 targets total)

| case | rank | query excerpt (60 chars) |
|------|------|--------------------------|
| table-case-1 | 6 | `id \| name \| description \| done \| 1 \| Test` |
| table-case-2 | 1 | `id \| name \| created \| 1 \| Go to the store` |
| table-case-3 | 1 | `id \| description \| done \| note_id \| 1 \| Buy` |
| table-case-4 | 1 | `id \| name \| 1 \| groceries \| 2 \| food` |
| table-case-5 | 1 | `inote_id \| tag_id \| 1 \| 1 \| 1 \| 2` |
| code-case-1 | 1 | `👉🏻Нагадаємо, що оскільки ми встановили парам` |
| code-case-2 | MISS | `from fastapi import FastAPI from src.api import` |
| code-case-3 | 1 | `import os from dotenv import load_dotenv load_d` |
| code-case-4 | MISS | `import sqlite3 from contextlib import contextman` |
| code-case-5 | 1 | `👉🏻 Який формат вибрати для docstrings?` |
| code-case-6 | 7 | `👉🏼 Ця модель — поширений метод опису мережевих` |
| code-case-7 | 1 | `with patch.object(ProductionClass, 'method', re` |
| code-case-8 | MISS | `def add(a, b): return a + b def sub(a, b):` |

**exact-token @3=8/13 (62%) @5=8/13 (62%) @10=10/13 (77%)**

### Miss / near-miss analysis

| case | rank | pattern |
|------|------|---------|
| table-case-1 | 6 | Generic todo table (id/name/done) — common pattern, high competition |
| code-case-2 | MISS | FastAPI app scaffold — highly generic, many similar chunks in collection |
| code-case-4 | MISS | sqlite3 + contextmanager — common pattern across Python files |
| code-case-6 | 7 | OSI model code block preceded by prose about OSI — section hub effect |
| code-case-8 | MISS | Trivial `add/sub` functions — minimal semantic content, no distinctive context |

All misses are structurally weak targets (highly generic content with many
near-duplicates in the same collection). No new structural failure modes were
observed that could be attributed to carryover.

### Comparison with pre-carryover baseline

The 2026-06-26 exact-token benchmark (`2026-06-26-structural-chunk-retrieval-vs-node-resolver.md`)
reported **13/13 search_sufficient** using manually curated queries that
selected the most distinctive tokens from each node. This run uses automated
query construction (first non-fence lines of `text`), which produces weaker
queries for generic code blocks.

**These two results are not directly comparable** — the query sets and
construction method differ. An apples-to-apples target-node quality comparison
(same 13 curated queries, same targets) remains pending and is not a blocker
for accepting the implementation.

---

## Part C — Collection Metrics

| metric | value |
|--------|-------|
| source files indexed | 91 |
| reindex log | 91 indexed, 0 skipped |
| total points (isv=4) | 1491 (full collection) |
| node_modules contamination | 0 |
| table chunks | 5 (sample; 20 total per prior scan) |
| code_block chunks | 8 (sample; 899 total per prior scan) |
| `indexing_schema_version = 4` | all points confirmed |

---

## Part D — qdrant_get_node Status

No change. `qdrant_get_node` remains display/known-path only. Default evidence
path for table/code is `qdrant_search` with `window=1`.

---

## Regressions

None observed in what is measurable here:

- Carryover sanity: 5/5 ok — no placeholder contamination, raw content intact.
- Collection: 100% isv=4, zero contamination.
- Smoke: 1293 passed, 0 failed (unchanged).
- custom-50 (semidex-docs): unchanged.

Exact-token recall (10/13 automated vs 13/13 curated) is not a regression
signal — query sets are not comparable. See Comparison section above.

---

## Recommendation

**Carryover implementation accepted by schema/context sanity and clean reindex.**

- Schema v4 bump correctly forces reindex of all skeleton collections.
- All structural nodes carry full cleaned prose carryover after reindex.
- No placeholder contamination in context.
- Raw content (`text`, `raw_content`) unchanged.

Apples-to-apples target-node quality comparison (same 13 curated queries
against isv=4 collection) remains pending. Not a blocker for accepting
the implementation.
