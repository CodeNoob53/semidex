# Structural Chunk Retrieval vs `qdrant_get_node` Necessity

**Date:** 2026-06-26
**Collection:** `fullstack-python-web`
**Source:** `<private-fullstack-python-source>` (91 files, skeleton-chunked)
**Smoke:** 1268 passed, 0 failed
**Verdict:** STRUCTURAL_SEARCH_SUFFICIENT_FOR_EXACT_TABLE_AND_CODE_QUERIES / NODE_RESOLVER_DISPLAY_ONLY

---

## Hypothesis Under Test

> In skeleton MVP, table/code/checklist are indexed as normal retrieval content chunks;
> therefore `qdrant_search` should return them directly when the query targets their contents;
> `qdrant_get_node` should not be part of the default answer path.

**Result: confirmed.**

---

## Collection Structural Inventory

| Node type | Count | Has vectors |
|-----------|-------|-------------|
| `code_block` | 200 | ✓ yes |
| `table` | 5 | ✓ yes |
| `paragraph` | ~1800 | ✓ yes |
| `checklist` | 0 | — |
| `image` | 0 | — |

All structural chunks are embedded with `${chunk.context}\n\n${chunk.text}` (see
`src/indexer/index.js` line 306). The `context` field carries the prose label for the
structural node (e.g., "Section — table — description of what the table shows"), so
the vector represents the semantic meaning of the structure, not just its raw syntax.

---

## Table Queries (5 cases)

Queries built from `context + text` of each table chunk (exact tokens). Results (automated rerun 2026-06-26, 5/5 rank 1):

| ID | ci | Source file | Query pattern | Rank |
|----|-----|-------------|--------------|------|
| T1 | 7 | table-file-A | context + column names (id, name, description, done) | rank 1 |
| T2 | 23 | table-file-B | context + notes table row values | rank 1 |
| T3 | 24 | table-file-B | context + records table (done, note_id) | rank 1 |
| T4 | 25 | table-file-B | context + tags table (category names + id) | rank 1 |
| T5 | 27 | table-file-B | context + junction table (two FK columns) | rank 1 |

**Tables: 5/5 rank 1. Classification: `search_sufficient` for all.**

Note: table-file-A and table-file-B are two distinct files from `<private-fullstack-python-source>`;
T2–T5 are four separate tables within the same file (Alembic migration topic).

---

## Code Block Queries (8 cases)

Queries built from `context + text` of each code_block chunk (first 100 chars of code text). Results (automated rerun 2026-06-26, 8/8 rank 1):

| ID | ci | Source file | Query pattern | Rank |
|----|-----|-------------|--------------|------|
| C1 | 17 | code-file-A | context + email confirmation mock body | rank 1 |
| C2 | 36 | code-file-B | context + FastAPI imports (framework router) | rank 1 |
| C3 | 3  | code-file-C | context + os.environ / dotenv load pattern | rank 1 |
| C4 | 2  | code-file-D | context + sqlite3 + contextmanager imports | rank 1 |
| C5 | 15 | code-file-E | context + docstring format (Sphinx style) | rank 1 |
| C6 | 3  | code-file-F | context + networking model historical body | rank 1 |
| C7 | 19 | code-file-G | context + patch.object mock decorator | rank 1 |
| C8 | 7  | code-file-H | context + Python runtime implementation body | rank 1 |

**Code blocks: 8/8 rank 1. Classification: `search_sufficient` for all.**

Note: general/natural-language queries about the same topics (e.g., "Python testing
patterns") may not retrieve specific structural chunks — that is expected behavior, not a
retrieval failure. Structural chunks are reachable when the query contains exact tokens
from the chunk.

---

## Placeholder Workflow

No prose chunks in this collection contained inline structural node placeholders
(`[table node: ...]`, `[code_block node: ...]`). The skeleton chunker does not currently
insert such references into surrounding prose. The placeholder resolution workflow
(`qdrant_get_node` triggered by inline reference) is not exercisable on this collection.

---

## Summary

| Case | Count | `search_sufficient` | `node_needed_for_evidence` | `node_needed_for_raw_display` | `node_not_needed` |
|------|-------|-------------------|--------------------------|-----------------------------|--------------------|
| Tables | 5 | 5 | 0 | 0 | 0 |
| Code blocks | 8 | 8 | 0 | 0 | 0 |
| **Total** | **13** | **13** | **0** | **0** | **0** |

---

## Recommended Agent Workflow

`qdrant_search` is the correct default path for structural chunk retrieval.
Structural chunks (table, code_block) are reachable through normal hybrid search
when the query contains exact tokens from the chunk content or its context label.

`qdrant_get_node` serves two narrower use cases:

1. **Raw/original display:** When the agent or user needs the original table or code
   block rendered as-is, not as a retrieved evidence snippet. `get_node` returns
   bounded raw content with `raw_chars` / `truncated` metadata.

2. **Placeholder or path-based resolution:** When skeleton navigation or another tool
   has surfaced a `node_path`, `get_node` resolves it directly without a search query.

`qdrant_get_node` is **not** a substitute for `qdrant_search` and should not be in the
default answer path. It requires a known `node_id` or `node_path`.

Updated agent decision rule:

```text
Structural content (table, code_block) in query scope:
  -> qdrant_search with exact tokens from the structure (rank 1-2 expected)
  -> qdrant_get_node only if:
       (a) raw display of full original content is needed, OR
       (b) node_path is already known from skeleton navigation
```

---

## Known Limitations

- Only one collection tested (`fullstack-python-web`).
- No `checklist` or `image` nodes available for testing.
- Code block retrieval for vague/natural-language queries (not exact-token) was not
  systematically measured — hub-chunk effects may exist for broad queries. This is
  a separate concern from structural chunk reachability.
- Placeholder resolution workflow untested — skeleton chunker does not emit inline
  node references in current implementation.
