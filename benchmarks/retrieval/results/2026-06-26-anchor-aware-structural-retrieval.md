# Anchor-Aware Natural-Language Structural Retrieval Benchmark

**Date:** 2026-06-26
**Collection:** `fullstack-python-web`
**Source:** `<private-fullstack-python-source>` (91 files, skeleton-chunked)
**Data:** existing indexed collection, no reindex performed
**Embedding:** `bge-m3-onnx`, hybrid dense+sparse RRF, `top=10`
**Filter:** `point_kind = retrieval_content` (structural + prose, no skeleton nav nodes)
**Smoke:** existing pass (1268 assertions); no production code changed
**Verdict:** ANCHOR_AWARE_STRUCTURAL_RETRIEVAL_PARTIAL

---

## Context

Previous benchmark (`2026-06-26-natural-language-structural-retrieval.md`) measured
direct structural recall for NL queries:

| | direct@3 | direct@5 | direct@10 |
|-|----------|----------|-----------|
| Tables (5) | 1/5 | 2/5 | 3/5 |
| Code (8)   | 4/8 | 4/8 | 6/8 |

This benchmark extends the measurement by counting a query as **successful** if
`qdrant_search` returns either:
1. the target structural node directly (**direct hit**), OR
2. a prose chunk containing a `[code block node: <node_path>]` / `[table node: <node_path>]`
   placeholder referencing the exact target (**placeholder anchor hit**), OR
3. a prose chunk in the same file, same section, adjacent (±2 chunks) to the target
   that introduces or explains it (**adjacent anchor hit**)

---

## Anchor Inventory

Before running queries, placeholder chunks were enumerated by scanning all prose
chunks for `[code block node: ...]` / `[table node: ...]` references, then matching
against each target's `node_path`.

| Case | Placeholder anchors | Adjacent prose (±2 ci) |
|------|--------------------|-----------------------|
| table-case-1 | 1 | 2 |
| table-case-2 | 1 | 1 |
| table-case-3 | 0 | 2 |
| table-case-4 | 0 | 1 |
| table-case-5 | 1 | 2 |
| code-case-1  | 1 | 2 |
| code-case-2  | 1 | 3 |
| code-case-3  | 1 | 2 |
| code-case-4  | 4 | 3 |
| code-case-5  | 1 | 2 |
| code-case-6  | 1 | 3 |
| code-case-7  | 1 | 2 |
| code-case-8  | 1 | 2 |

Total: 316 prose chunks in the collection contain structural node placeholders.
The skeleton chunker emits placeholders in the form:
`[code block node: <node_path> — <first-line snippet>]`

---

## Per-Case Results

Same NL queries as the previous benchmark.

| Case | NL query | Direct rank | Placeholder rank | Adjacent rank | Best kind | Best rank |
|------|----------|-------------|-----------------|---------------|-----------|-----------|
| table-case-1 | "which table shows the result of creating a record in the database" | 1 | 8 | 8 | direct_hit | 1 |
| table-case-2 | "show the notes table with creation timestamps from the migration example" | 5 | MISS | MISS | direct_hit | 5 |
| table-case-3 | "which table tracks completion status of items linked to notes" | MISS | MISS | MISS | miss | — |
| table-case-4 | "table of tag categories used to label notes" | MISS | MISS | MISS | miss | — |
| table-case-5 | "which table represents the many-to-many relationship between notes and tags" | 6 | 7 | 7 | direct_hit | 6 |
| code-case-1  | "how to simulate email verification in tests" | MISS | MISS | MISS | miss | — |
| code-case-2  | "how to assemble a FastAPI application with multiple routers" | MISS | MISS | MISS | miss | — |
| code-case-3  | "how to read environment variables in Python using dotenv" | 10 | 8 | 8 | placeholder_anchor_hit | 8 |
| code-case-4  | "example of managing a SQLite database connection with context manager" | 1 | 4 | 4 | direct_hit | 1 |
| code-case-5  | "which docstring format is recommended for large Python projects" | 3 | 5 | 5 | direct_hit | 3 |
| code-case-6  | "description of the OSI networking model and its history" | 3 | 1 | 1 | placeholder_anchor_hit | 1 |
| code-case-7  | "how to replace a method during testing using mock patch" | 3 | 2 | 2 | placeholder_anchor_hit | 2 |
| code-case-8  | "how to view installed Python versions with uv" | 6 | 8 | 5 | adjacent_anchor_hit | 5 |

---

## Aggregate Metrics

### Tables (5 cases)

| Metric | @3 | @5 | @10 |
|--------|----|----|-----|
| Direct recall | 1/5 (20%) | 2/5 (40%) | 3/5 (60%) |
| Anchor-aware recall | 1/5 (20%) | 2/5 (40%) | 3/5 (60%) |

For tables, anchor-aware recall equals direct recall at all cutoffs.
The two table misses (table-case-3, table-case-4) have no placeholder anchors,
and their adjacent prose chunks do not appear in top 10 for the NL queries.

### Code blocks (8 cases)

| Metric | @3 | @5 | @10 |
|--------|----|----|-----|
| Direct recall | 4/8 (50%) | 4/8 (50%) | 6/8 (75%) |
| Anchor-aware recall | 4/8 (50%) | 5/8 (63%) | 6/8 (75%) |

Anchor-aware adds **1 case at @5** (code-case-8 via adjacent anchor at rank 5)
and maintains parity at @3 and @10.

### Combined (13 cases)

| Metric | @3 | @5 | @10 |
|--------|----|----|-----|
| Direct recall | 5/13 (38%) | 6/13 (46%) | 9/13 (69%) |
| Anchor-aware recall | 5/13 (38%) | 7/13 (54%) | 9/13 (69%) |

### Hit-kind breakdown (@10)

| Kind | Count |
|------|-------|
| direct_hit | 5 |
| placeholder_anchor_hit | 3 |
| adjacent_anchor_hit | 1 |
| miss | 4 |

---

## Notable Examples

### Placeholder anchor at rank 1 (code-case-6)

Query: `"description of the OSI networking model and its history"`

The direct structural chunk (a code block explaining the OSI model in a callout box)
ranks at 3. But a prose chunk that contains `[code block node: <target node_path>]`
appears at rank **1** — it introduces the code block by explaining what the OSI model
standard is and why it matters. The placeholder in that chunk points directly to the
target node.

**Classification:** `placeholder_anchor_hit` at rank 1 (better than direct at rank 3).
After finding this prose chunk, `qdrant_get_node` could resolve the placeholder to
retrieve the full original code block if needed.

### Placeholder anchor beats direct (code-case-7)

Query: `"how to replace a method during testing using mock patch"`

Direct code block at rank 3; placeholder anchor prose at rank **2**.
The prose chunk at rank 2 introduces `patch` and explains why you'd use it, then
references the target code block via placeholder.

### Adjacent anchor (code-case-8)

Query: `"how to view installed Python versions with uv"`

Target code block at rank 6. Adjacent prose (ci = target + 1) appears at rank 5.
This prose follows the code block in document order and references the same `uv`
Python version listing concept.

### Persistent misses (table-case-3, table-case-4, code-case-1, code-case-2)

All four misses share a common pattern: the NL query semantics match a **section**
broadly, but within that section a different structural chunk (code block or
paragraph) consistently outranks both the target node and its anchors.

- **table-case-3, table-case-4:** the Alembic migration file contains multiple
  tables (T2–T5) all with similar section contexts. T3/T4 have no placeholder
  anchors. The NL query matches section-level prose and code blocks from a different
  part of the codebase (`architecture` section, source-B) that semantically overlaps
  with "records linked to notes / tags".

- **code-case-1:** the target is a test-setup mock for email confirmation.
  The NL query "simulate email verification in tests" matches 6+ different
  code blocks in the same email-verification file. The placeholder for the target
  also fails to rank in top 10 because the prose that references it is outcompeted
  by other chunks in the same section.

- **code-case-2:** the target is the FastAPI app assembly file (auth section).
  NL query "assemble a FastAPI application with multiple routers" returns
  introduction paragraphs and a different architecture code block. The placeholder
  anchor also misses because the prose referencing it lives in the same auth section
  and is similarly outcompeted.

---

## Comparison with Previous Report

| | NL direct@3 | NL direct@5 | NL direct@10 | NL aware@3 | NL aware@5 | NL aware@10 |
|-|------------|------------|-------------|-----------|-----------|------------|
| Tables | 1/5 | 2/5 | 3/5 | 1/5 | 2/5 | 3/5 |
| Code   | 4/8 | 4/8 | 6/8 | 4/8 | 5/8 | 6/8 |
| Total  | 5/13 | 6/13 | 9/13 | 5/13 | 7/13 | 9/13 |

Anchor-awareness adds **+1 case at @5** (code adjacent anchor). At @3 and @10
the anchor types found do not improve over direct.

The anchoring mechanism **does work** when a placeholder is found (3 cases
gained as placeholder_anchor_hit). However, for the 4 persistent misses,
neither the direct structural chunk nor any placeholder/adjacent prose appears
in top 10 — the anchor mechanism provides no lift for these cases.

---

## Implications

### On `qdrant_get_node`

When a search result **contains a placeholder** (`[code block node: ...]`), the agent
can call `qdrant_get_node(collection, node_path="<extracted path>")` to render the
full original code block or table. This is a **valid and correct** use of the tool —
the node is known, not guessed.

`qdrant_get_node` is **not** a remedy for the 4 persistent misses. Those queries
return no placeholder chunks in top 10, so there is no `node_path` to resolve.

### On agent workflow

Current rule is unchanged:

```text
Structural content (table, code_block) in query scope:
  -> qdrant_search with exact tokens from the structure (rank 1-2 expected)
  -> qdrant_get_node only if:
       (a) raw display of full original content is needed, OR
       (b) node_path is already known from skeleton navigation or a placeholder
```

One addendum is now evidence-backed:

```text
  If a search result prose chunk contains [code block node: <path>] or
  [table node: <path>], the agent may call qdrant_get_node(node_path=<path>)
  to retrieve the full original content of the referenced structural node.
  This is valid placeholder resolution, not a search fallback.
```

---

## Improvement Candidates

(Same as previous report, ranked by expected impact.)

1. **Richer structural node context** — short tables (2–5 rows) have minimal
   semantic content in their `context` field. Adding the introducing prose paragraph
   to the structural node's embedding would improve NL recall for T3/T4.

2. **Section-level search narrowing** — for the persistent misses, the NL query
   correctly identifies the section but the wrong chunk wins within it. Narrowing by
   `source_file` (after a skeleton-navigation step) would lift recall significantly.

3. **LLM-generated summary for structural nodes** — a `summary_kind: llm_short`
   summary embedded with the table/code_block node would substantially close the
   semantic gap for NL queries.

4. **Multi-phrasing qrel** — the 4 persistent misses may succeed with differently
   phrased NL queries. A wider qrel set would distinguish "inherently hard" from
   "query-phrasing sensitive" cases.

---

## Known Limitations

- One collection tested.
- One NL query per node (different phrasings may improve recall).
- NL queries are in English; collection text is in Ukrainian — cross-lingual
  semantic gap may penalize NL queries relative to Ukrainian exact-token queries.
- No `checklist` or `image` nodes in this collection.
- Adjacent anchor acceptance criterion (±2 ci, same file) may be too loose
  for files with many structural nodes clustered together.
